/**
 * P1 presence-detector harness: runs candidate person detectors (ONNX) over the
 * 4 fps evaluation frames in onnxruntime-node and writes per-frame person boxes.
 * OFFLINE ONLY - not used by the gateway.
 *
 *   node --import tsx tools/presence-eval/run-models.ts \
 *     --work /work --models /models --model yolox-nano --input 640 --view full \
 *     [--threads 4] [--sets nvr,scripted] [--gates ENTRY,EXIT] [--clips id1,id2] [--limit N] [--warmup 5] \
 *     [--score-min 0.05] [--tag name] [--no-dets]
 *
 * --work   dir holding manifest.json and frames/<clipId>/NNNNN.jpg (extract_frames.py)
 * --models dir holding the ONNX files named in tools/presence-eval/models.json
 * --view   full = whole picture; gate = the live gate area (ENTRY strip; EXIT is the
 *          full picture, so gate == full there and EXIT clips are skipped)
 * --input  key of models.json "inputs" (e.g. 640, native)
 *
 * Output: <work>/runs/<model>__<view>__<input>__t<threads>[__tag]/
 *   dets.jsonl    {"c":clipId,"i":frameIndex,"d":[[x1,y1,x2,y2,score],...]} boxes normalised to
 *                 the full stored frame, every candidate with score >= --score-min after NMS
 *   summary.json  model, input geometry, threads, ms/frame (session.run only; mean/p50/p95)
 *                 plus pre/post-processing ms, model file size
 *
 * Frames are decoded and scaled by FFmpeg (as the production stream would deliver them), then
 * letterboxed top-left into the model input with the model's pad value.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";

type ModelInput = {
  key: string;
  /** fixed model input (static ONNX) */
  w?: number;
  h?: number;
  /** dynamic ONNX: content scaled to this width, height padded up to a multiple of stride */
  width?: number;
  stride?: number;
  file: string;
};
type ModelSpec = {
  id: string;
  family: string;
  layout: "nchw" | "nhwc";
  order: "rgb" | "bgr";
  mean: [number, number, number];
  std: [number, number, number];
  pad: number;
  /** IoU for class-agnostic NMS; null = model is NMS-free (DETR) */
  nms: number | null;
  inputs: ModelInput[];
};
type Clip = {
  id: string;
  set: string;
  gate: string;
  frames: number;
  storeWidth: number;
  storeHeight: number;
  gateArea: [number, number, number, number];
};

const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (def === undefined) throw new Error(`missing --${name}`);
  return def;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

export type Geometry = {
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  contentW: number;
  contentH: number;
  inW: number;
  inH: number;
  scale: number;
};

/** Where the (cropped) stored frame lands inside the model input. Pure; exported for tests. */
export function geometry(clip: Pick<Clip, "storeWidth" | "storeHeight" | "gateArea">, v: "full" | "gate", inp: ModelInput): Geometry {
  const W = clip.storeWidth;
  const H = clip.storeHeight;
  let cropX = 0;
  let cropY = 0;
  let cropW = W;
  let cropH = H;
  if (v === "gate") {
    const [gx, gy, gw, gh] = clip.gateArea;
    cropX = Math.round(gx * W);
    cropY = Math.round(gy * H);
    cropW = Math.min(W - cropX, Math.round(gw * W)) & ~1;
    cropH = Math.min(H - cropY, Math.round(gh * H)) & ~1;
  }
  let inW: number;
  let inH: number;
  let scale: number;
  if (inp.width) {
    const stride = inp.stride ?? 32;
    scale = inp.width / cropW;
    inW = Math.ceil(inp.width / stride) * stride;
    inH = Math.max(stride, Math.ceil((cropH * scale) / stride) * stride);
  } else {
    inW = inp.w!;
    inH = inp.h!;
    scale = Math.min(inW / cropW, inH / cropH);
  }
  const contentW = Math.min(inW, Math.max(2, Math.round((cropW * scale) / 2) * 2));
  const contentH = Math.min(inH, Math.max(2, Math.round((cropH * scale) / 2) * 2));
  return { cropX, cropY, cropW, cropH, contentW, contentH, inW, inH, scale: contentW / cropW };
}

/** Class-agnostic greedy NMS on [x1,y1,x2,y2,s]. Pure; exported for tests. */
export function nms(boxes: number[][], iouThr: number): number[][] {
  const sorted = [...boxes].sort((a, b) => b[4] - a[4]);
  const keep: number[][] = [];
  for (const b of sorted) {
    let ok = true;
    for (const k of keep) {
      const ix = Math.max(0, Math.min(b[2], k[2]) - Math.max(b[0], k[0]));
      const iy = Math.max(0, Math.min(b[3], k[3]) - Math.max(b[1], k[1]));
      const inter = ix * iy;
      const u = (b[2] - b[0]) * (b[3] - b[1]) + (k[2] - k[0]) * (k[3] - k[1]) - inter;
      if (u > 0 && inter / u > iouThr) {
        ok = false;
        break;
      }
    }
    if (ok) keep.push(b);
  }
  return keep;
}

function fillTensor(rgb: Buffer, g: Geometry, s: ModelSpec, out: Float32Array): void {
  const plane = g.inW * g.inH;
  const ch = s.order === "rgb" ? [0, 1, 2] : [2, 1, 0];
  const padN = [0, 1, 2].map((c) => (s.pad - s.mean[c]) / s.std[c]);
  if (s.layout === "nchw") {
    for (let c = 0; c < 3; c++) out.fill(padN[c], c * plane, (c + 1) * plane);
    for (let y = 0; y < g.contentH; y++) {
      for (let x = 0; x < g.contentW; x++) {
        const src = (y * g.contentW + x) * 3;
        const dst = y * g.inW + x;
        for (let c = 0; c < 3; c++) out[c * plane + dst] = (rgb[src + ch[c]] - s.mean[c]) / s.std[c];
      }
    }
  } else {
    for (let p = 0; p < plane; p++) for (let c = 0; c < 3; c++) out[p * 3 + c] = padN[c];
    for (let y = 0; y < g.contentH; y++) {
      for (let x = 0; x < g.contentW; x++) {
        const src = (y * g.contentW + x) * 3;
        const dst = (y * g.inW + x) * 3;
        for (let c = 0; c < 3; c++) out[dst + c] = (rgb[src + ch[c]] - s.mean[c]) / s.std[c];
      }
    }
  }
}

async function* readFrames(work: string, clip: Clip, g: Geometry): AsyncGenerator<Buffer> {
  const dir = path.join(work, "frames", clip.id);
  const vf = `crop=${g.cropW}:${g.cropH}:${g.cropX}:${g.cropY},scale=${g.contentW}:${g.contentH}:flags=area`;
  const ff = spawn("ffmpeg", ["-v", "error", "-framerate", "4", "-start_number", "0", "-i", path.join(dir, "%05d.jpg"),
    "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { stdio: ["ignore", "pipe", "inherit"] });
  const frameBytes = g.contentW * g.contentH * 3;
  let pending = Buffer.alloc(0);
  for await (const chunk of ff.stdout) {
    pending = pending.length ? Buffer.concat([pending, chunk as Buffer]) : (chunk as Buffer);
    while (pending.length >= frameBytes) {
      yield pending.subarray(0, frameBytes);
      pending = pending.subarray(frameBytes);
    }
  }
}

function stats(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) };
}

async function main() {
  const work = arg("work");
  const modelsDir = arg("models");
  const modelId = arg("model");
  const inputKey = arg("input");
  const view = arg("view", "full") as "full" | "gate";
  const threads = Number(arg("threads", "4"));
  const sets = arg("sets", "nvr,scripted").split(",");
  const clipFilter = arg("clips", "");
  const gates = arg("gates", "ENTRY,EXIT").split(",");
  const limit = Number(arg("limit", "0"));
  const warmup = Number(arg("warmup", "5"));
  const scoreMin = Number(arg("score-min", "0.05"));
  const tag = arg("tag", "");
  const writeDets = !flag("no-dets");

  const specs: ModelSpec[] = JSON.parse(fs.readFileSync(path.join(here, "models.json"), "utf8")).models;
  const spec = specs.find((m) => m.id === modelId);
  if (!spec) throw new Error(`unknown model ${modelId}`);
  const input = spec.inputs.find((i) => i.key === inputKey);
  if (!input) throw new Error(`model ${modelId} has no input ${inputKey}`);

  const manifest = JSON.parse(fs.readFileSync(path.join(work, "manifest.json"), "utf8"));
  let clips: Clip[] = manifest.clips.filter((c: Clip) => sets.includes(c.set));
  clips = clips.filter((c) => gates.includes(c.gate));
  if (clipFilter) clips = clips.filter((c) => clipFilter.split(",").includes(c.id));
  if (view === "gate") clips = clips.filter((c) => c.gate === "ENTRY");
  const file = path.join(modelsDir, input.file);
  const session = await ort.InferenceSession.create(file, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    executionMode: "sequential",
    logSeverityLevel: 3,
  });
  const inName = session.inputNames[0];
  const outName = session.outputNames[0];
  const runName = [modelId, view, inputKey, `t${threads}`, tag].filter(Boolean).join("__");
  const outDir = path.join(work, "runs", runName);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const detsOut = writeDets ? fs.createWriteStream(path.join(outDir, "dets.jsonl")) : null;
  const runMs: number[] = [];
  const preMs: number[] = [];
  const postMs: number[] = [];
  let shapes = "";
  let done = 0;
  outer: for (const clip of clips) {
    const g = geometry(clip, view, input);
    shapes = `${g.inW}x${g.inH} (content ${g.contentW}x${g.contentH})`;
    const data = new Float32Array(3 * g.inW * g.inH);
    const dims = spec.layout === "nchw" ? [1, 3, g.inH, g.inW] : [1, g.inH, g.inW, 3];
    let i = 0;
    for await (const rgb of readFrames(work, clip, g)) {
      const t0 = performance.now();
      fillTensor(rgb, g, spec, data);
      const t1 = performance.now();
      const res = await session.run({ [inName]: new ort.Tensor("float32", data, dims) });
      const t2 = performance.now();
      const o = res[outName];
      const od = o.data as Float32Array;
      const n = o.dims.length === 3 ? o.dims[1] : o.dims[0];
      const cand: number[][] = [];
      for (let k = 0; k < n; k++) {
        const sc = od[k * 5 + 4];
        if (sc < scoreMin) continue;
        cand.push([od[k * 5], od[k * 5 + 1], od[k * 5 + 2], od[k * 5 + 3], sc]);
      }
      const kept = spec.nms === null ? cand : nms(cand, spec.nms);
      const norm = kept.map((b) => {
        const fx = (v: number) => +Math.min(1, Math.max(0, (v / g.scale + g.cropX) / clip.storeWidth)).toFixed(4);
        const fy = (v: number) => +Math.min(1, Math.max(0, (v / g.scale + g.cropY) / clip.storeHeight)).toFixed(4);
        return [fx(b[0]), fy(b[1]), fx(b[2]), fy(b[3]), +b[4].toFixed(3)];
      });
      const t3 = performance.now();
      if (done >= warmup) {
        preMs.push(t1 - t0);
        runMs.push(t2 - t1);
        postMs.push(t3 - t2);
      }
      detsOut?.write(JSON.stringify({ c: clip.id, i, d: norm }) + "\n");
      i++;
      done++;
      if (limit && done >= limit + warmup) break outer;
    }
    if (i !== clip.frames) console.error(`warn ${clip.id}: read ${i}/${clip.frames} frames`);
  }
  await new Promise<void>((r) => (detsOut ? detsOut.end(r) : r()));
  const summary = {
    model: modelId,
    family: spec.family,
    file: input.file,
    fileBytes: fs.statSync(file).size,
    view,
    input: inputKey,
    shapes,
    threads,
    frames: done,
    ortVersion: (ort as unknown as { env: { versions?: { common?: string } } }).env.versions?.common ?? "unknown",
    runMs: stats(runMs),
    preMs: stats(preMs),
    postMs: stats(postMs),
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
