#!/usr/bin/env -S npx tsx
/**
 * Detector-input geometry on a gate area (real-time pipeline, rc2 P1 / ENTRY task).
 *
 *   npx tsx scripts/perf/detect-input-eval.ts <clips.json> <clip.mp4> --roi x,y,w,h --out <report.json>
 *        [--cache <dir>] [--configs a,b,c] [--threads 1] [--max-frames N] [--embed-max N]
 *        [--every N --offset K] [--dump-calib <dir> [--calib-shapes auto,640x640]]
 *
 * --every/--offset split the samples (like dump-calib.ts / int8-eval.ts): dump
 * calibration tensors from one half, measure on the other.
 *
 * Cuts the gate area (ROI fractions, as the stream PUT API stores them) out of
 * frames of a replay clip at the moments the ground truth says a face is
 * usable (scripted: firstUsableS + 0.15 s and + 1.5 s per person; NVR: every
 * 1.5 s of each non-filler passage), then runs several ways of presenting that
 * strip to SCRFD and compares each against two FP32 references on the SAME
 * pixels:
 *   ref-fp32-1280    the 1280x1280 square letterbox the brief names
 *   ref-fp32-native  the strip at scale 1 (ceil32(W) x ceil32(H)) - the upper bound
 * Candidates: the legacy square 640 (what the pipeline did), aspect-preserving
 * `auto` (FP32, and INT8 if a dynamic export exists), and INT8 tiles.
 *
 * Per candidate: recall of reference faces >= FACE_MIN_SIZE_PX (IoU >= 0.5),
 * extra detections, box IoU, landmark error (per cent of the face size),
 * ArcFace drift (1 - cos of the FP32 embedding taken with the candidate's
 * landmarks vs the reference's), and detector time per frame (all runs of a
 * frame summed). Aggregates only; no pixels or embeddings are written except
 * the optional calibration dump (uint8 HWC tensors for quantize.py, biometric
 * derivatives: keep the dir 0700 and delete it afterwards).
 *
 * Clips are biometric data: run this only on /data/test-clips (0700) and keep
 * --cache in a 0700 scratch dir; delete it when done.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  CLEAR_FACE_LIMITS,
  alignFace,
  cosineSimilarity,
  detectFaces,
  embedFace,
  getFaceEngine,
  getFaceEngineInfo,
  iou,
  letterboxForDetector,
  resetFaceEngine,
  type FaceBox,
  type RgbImage,
} from "../../src/server/faceEmbedding";
import {
  deriveDetectShape,
  detectWithPlan,
  parseDetectInput,
  squareScale,
  type DetectInputPlan,
} from "../../src/server/pipeline/detectInput";

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
const opt = (name: string, d?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const [clipsJson, clipFile] = positional;
if (!clipsJson || !clipFile || !opt("roi") || !opt("out")) {
  console.error("usage: detect-input-eval.ts <clips.json> <clip.mp4> --roi x,y,w,h --out report.json [--cache dir] [--configs ...]");
  process.exit(2);
}
const ROI = String(opt("roi")).split(",").map(Number) as [number, number, number, number];
const OUT = String(opt("out"));
const CACHE = opt("cache");
const THREADS = opt("threads", "1")!;
const MAX_FRAMES = Number(opt("max-frames", "100000"));
const EVERY = Number(opt("every", "1"));
const OFFSET = Number(opt("offset", "0"));
const EMBED_MAX = Number(opt("embed-max", "400"));
const DUMP = opt("dump-calib");
const CALIB_SHAPES = String(opt("calib-shapes", "auto,640x640")).split(",");
const MIN_PX = CLEAR_FACE_LIMITS.minFacePx;
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

process.env.FACE_ORT_THREADS = THREADS;
process.env.FACE_ORT_LOG_LEVEL = process.env.FACE_ORT_LOG_LEVEL || "3";

// ---- frame sampling from the ground truth ---------------------------------------

interface Sample {
  t: number;
  passage: string;
  label: string;
  expectSize?: number;
}

function clipEntry(clips: any, file: string): any {
  const clip = clips.clips.find((c: any) => c.file === path.basename(file) || c.file === file);
  if (!clip) throw new Error(`clip ${path.basename(file)} not in ${clipsJson}`);
  return clip;
}

function samplesFor(clips: any, file: string): Sample[] {
  const clip = clipEntry(clips, file);
  const out: Sample[] = [];
  for (const p of clip.passages) {
    if ((p.tags || []).includes("filler")) continue;
    if (clip.source === "scripted") {
      for (const q of p.people || []) {
        if (typeof q.firstUsableS !== "number") continue;
        // The scripted face grows 40 -> 110 px over 3.5 s and is >= 60 px from firstUsableS on.
        out.push({ t: q.firstUsableS + 0.15, passage: p.id, label: q.label, expectSize: 63 });
        out.push({ t: q.firstUsableS + 1.5, passage: p.id, label: q.label, expectSize: 90 });
      }
    } else {
      for (let t = p.startS + 1; t < p.endS - 0.5; t += 1.5) out.push({ t, passage: p.id, label: "?" });
    }
  }
  return out.filter((_, i) => i % EVERY === OFFSET).slice(0, MAX_FRAMES);
}

/** The ROI of one frame as raw RGB, via ffmpeg (accurate seek, crop filter). */
function roiFrame(file: string, t: number, sw: number, sh: number): RgbImage | null {
  const x = Math.round(ROI[0] * sw) & ~1;
  const y = Math.round(ROI[1] * sh) & ~1;
  const w = Math.min(sw - x, Math.round(ROI[2] * sw) & ~1);
  const h = Math.min(sh - y, Math.round(ROI[3] * sh) & ~1);
  const r = spawnSync(
    FFMPEG,
    ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", `crop=${w}:${h}:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length < w * h * 3) return null;
  return { width: w, height: h, data: new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, w * h * 3) };
}

/** Source picture size: from the ground truth (the image has no ffprobe), else ffprobe. */
function probeSize(clips: any, file: string): { w: number; h: number } {
  const clip = clipEntry(clips, file);
  if (Number(clip.width) > 0 && Number(clip.height) > 0) return { w: Number(clip.width), h: Number(clip.height) };
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { timeout: 20_000 });
  const [w, h] = String(r.stdout || "").trim().split(",").map(Number);
  if (!w || !h) throw new Error(`no size for ${file} (clips.json has none and ffprobe failed)`);
  return { w, h };
}

function cachedFrame(file: string, s: Sample, sw: number, sh: number): RgbImage | null {
  const key = `${path.basename(file)}_${s.t.toFixed(3)}_${ROI.join("_")}.rgb`;
  const p = CACHE ? path.join(CACHE, key) : null;
  if (p && fs.existsSync(p)) {
    const buf = fs.readFileSync(p);
    const w = buf.readUInt32LE(0);
    const h = buf.readUInt32LE(4);
    return { width: w, height: h, data: new Uint8Array(buf.buffer, buf.byteOffset + 8, w * h * 3) };
  }
  const img = roiFrame(file, s.t, sw, sh);
  if (img && p) {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(img.width, 0);
    head.writeUInt32LE(img.height, 4);
    fs.writeFileSync(p, Buffer.concat([head, Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength)]), { mode: 0o600 });
  }
  return img;
}

// ---- configurations -------------------------------------------------------------

interface Config {
  name: string;
  variant?: "fp32" | "int8";
  model?: string;
  plan: DetectInputPlan;
  /** Detector square (FACE_DETECT_SIZE) for square/tiles plans. */
  square?: number;
}

function configs(frameW: number, frameH: number): Config[] {
  const native = { width: Math.ceil(frameW / 32) * 32, height: Math.ceil(frameH / 32) * 32 };
  const all: Config[] = [
    { name: "ref-fp32-1280", variant: "fp32", plan: { kind: "fixed", width: 1280, height: 1280 } },
    { name: "ref-fp32-native", variant: "fp32", plan: { kind: "fixed", ...native } },
    { name: "fp32-square640", variant: "fp32", plan: { kind: "square" }, square: 640 },
    { name: "int8-square640", variant: "int8", plan: { kind: "square" }, square: 640 },
    { name: "fp32-auto", variant: "fp32", plan: parseDetectInput("auto").plan },
    { name: "fp32-auto960", variant: "fp32", plan: parseDetectInput("auto:960").plan },
    { name: "int8-tiles3", variant: "int8", plan: parseDetectInput("tiles:3").plan, square: 640 },
    { name: "int8-tiles4", variant: "int8", plan: parseDetectInput("tiles:4").plan, square: 640 },
    { name: "int8-tiles6", variant: "int8", plan: parseDetectInput("tiles:6").plan, square: 640 },
    { name: "fp32-tiles4", variant: "fp32", plan: parseDetectInput("tiles:4").plan, square: 640 },
  ];
  const dyn = process.env.INT8_DYN_FILE || "det_10g_int8_dyn.onnx";
  if (fs.existsSync(path.join(process.env.FACE_MODEL_DIR || "/app/models", dyn))) {
    all.push({ name: "int8dyn-auto", model: dyn, plan: parseDetectInput("auto").plan });
    all.push({ name: "int8dyn-auto960", model: dyn, plan: parseDetectInput("auto:960").plan });
    all.push({ name: "int8dyn-square640", model: dyn, plan: { kind: "square" }, square: 640 });
  }
  const want = opt("configs");
  return want ? all.filter((c) => want.split(",").includes(c.name)) : all;
}

async function useConfig(c: Config): Promise<void> {
  delete process.env.FACE_DETECTOR_MODEL;
  delete process.env.FACE_DETECTOR_VARIANT;
  if (c.model) process.env.FACE_DETECTOR_MODEL = c.model;
  else process.env.FACE_DETECTOR_VARIANT = c.variant || "fp32";
  process.env.FACE_DETECT_SIZE = String(c.square || 640);
  resetFaceEngine();
  if (!(await getFaceEngine())) throw new Error(`engine for ${c.name} unavailable: ${getFaceEngineInfo().lastError}`);
}

// ---- metrics --------------------------------------------------------------------

const sizeOf = (f: FaceBox) => Math.min(f.box[2] - f.box[0], f.box[3] - f.box[1]);
const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};
const dist = (xs: number[], digits = 3) =>
  xs.length ? { n: xs.length, median: +q(xs, 0.5).toFixed(digits), p5: +q(xs, 0.05).toFixed(digits), p95: +q(xs, 0.95).toFixed(digits), max: +Math.max(...xs).toFixed(digits) } : { n: 0 };

function matchFaces(ref: FaceBox[], other: FaceBox[]): Map<number, { j: number; iou: number }> {
  const pairs: Array<{ i: number; j: number; iou: number }> = [];
  for (let i = 0; i < ref.length; i++) for (let j = 0; j < other.length; j++) {
    const o = iou(ref[i].box, other[j].box);
    if (o >= 0.5) pairs.push({ i, j, iou: o });
  }
  pairs.sort((a, b) => b.iou - a.iou);
  const usedI = new Set<number>();
  const usedJ = new Set<number>();
  const out = new Map<number, { j: number; iou: number }>();
  for (const p of pairs) {
    if (usedI.has(p.i) || usedJ.has(p.j)) continue;
    usedI.add(p.i);
    usedJ.add(p.j);
    out.set(p.i, { j: p.j, iou: p.iou });
  }
  return out;
}

function landmarkError(a: FaceBox, b: FaceBox): number {
  const size = Math.max(1, sizeOf(a));
  let s = 0;
  for (let k = 0; k < 5; k++) s += Math.hypot(a.landmarks[k][0] - b.landmarks[k][0], a.landmarks[k][1] - b.landmarks[k][1]);
  return (100 * s) / 5 / size;
}

interface Run {
  faces: FaceBox[];
  ms: number;
  input: string;
  runs: number;
  emb: Map<number, Float32Array>;
}

async function main() {
  const clips = JSON.parse(fs.readFileSync(clipsJson, "utf8"));
  const samples = samplesFor(clips, clipFile);
  const { w: sw, h: sh } = probeSize(clips, clipFile);
  if (CACHE) fs.mkdirSync(CACHE, { recursive: true, mode: 0o700 });
  console.log(`[eval] ${samples.length} samples from ${path.basename(clipFile)} (${sw}x${sh}), roi ${ROI.join(",")}, threads ${THREADS}`);

  // Frames (decoded once, cached to disk when --cache is given).
  const frames: Array<{ s: Sample; img: RgbImage }> = [];
  const t0 = Date.now();
  for (const s of samples) {
    const img = cachedFrame(clipFile, s, sw, sh);
    if (img) frames.push({ s, img });
  }
  if (!frames.length) throw new Error("no frames decoded");
  const fw = frames[0].img.width;
  const fh = frames[0].img.height;
  console.log(`[eval] ${frames.length} frames of ${fw}x${fh} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  if (DUMP) {
    fs.mkdirSync(DUMP, { recursive: true, mode: 0o700 });
    process.env.FACE_DETECT_UPSCALE = process.env.FACE_DETECT_UPSCALE || "none";
    let n = 0;
    for (const { img } of frames) {
      for (const shapeName of CALIB_SHAPES) {
        const shape = shapeName === "auto" ? deriveDetectShape(img.width, img.height) : (() => { const [w, h] = shapeName.split("x").map(Number); return { width: w, height: h }; })();
        const lb = letterboxForDetector(img, shape.width, shape.height);
        // Back to uint8 HWC (what quantize.py expects): px = v * 128 + 127.5.
        const plane = shape.width * shape.height;
        const u8 = new Uint8Array(plane * 3);
        for (let i = 0; i < plane; i++) {
          u8[i * 3] = Math.round(lb.tensorData[i] * 128 + 127.5);
          u8[i * 3 + 1] = Math.round(lb.tensorData[plane + i] * 128 + 127.5);
          u8[i * 3 + 2] = Math.round(lb.tensorData[2 * plane + i] * 128 + 127.5);
        }
        fs.writeFileSync(path.join(DUMP, `det_${String(n).padStart(4, "0")}_${shape.width}x${shape.height}.u8`), u8, { mode: 0o600 });
      }
      n += 1;
    }
    console.log(`[eval] wrote ${n * CALIB_SHAPES.length} calibration tensors to ${DUMP} (shapes ${CALIB_SHAPES.join(", ")})`);
  }

  const cfgs = configs(fw, fh);
  const results = new Map<string, Run[]>();
  const meta = new Map<string, { input: string; scale: number; loadMs: number | null; detector: string }>();
  for (const c of cfgs) {
    await useConfig(c);
    const info = getFaceEngineInfo();
    const runs: Run[] = [];
    let embedded = 0;
    for (const { img } of frames) {
      const t1 = Date.now();
      const r = await detectWithPlan(detectFaces, img, c.plan, { squareSize: info.detectorInputSize, nmsIou: info.nmsIou });
      const ms = Date.now() - t1;
      const emb = new Map<number, Float32Array>();
      for (let i = 0; i < r.faces.length && embedded < EMBED_MAX; i++) {
        if (sizeOf(r.faces[i]) < MIN_PX) continue;
        const a = alignFace(img, r.faces[i].landmarks);
        const e = a ? await embedFace(a) : null;
        if (e) {
          emb.set(i, e);
          embedded += 1;
        }
      }
      runs.push({ faces: r.faces, ms, input: r.info.input, runs: r.info.runs, emb });
    }
    results.set(c.name, runs);
    const scale = c.plan.kind === "auto" ? deriveDetectShape(fw, fh, c.plan.budgetPx).scale : c.plan.kind === "fixed" ? Math.min(1, c.plan.width / fw, c.plan.height / fh) : c.plan.kind === "tiles" ? NaN : squareScale(fw, fh, c.square || 640);
    meta.set(c.name, { input: runs[0]?.input || "", scale: +scale.toFixed(3), loadMs: info.loadTimeMs, detector: info.detectorModel });
    const faces = runs.reduce((a, r) => a + r.faces.filter((f) => sizeOf(f) >= MIN_PX).length, 0);
    console.log(`[eval] ${c.name.padEnd(18)} ${runs[0]?.input.padEnd(34)} faces>=${MIN_PX}: ${String(faces).padStart(3)}  ms/frame p50 ${q(runs.map((r) => r.ms), 0.5)} p95 ${q(runs.map((r) => r.ms), 0.95)}`);
  }

  // Compare every candidate with both references.
  const report: any = {
    clip: path.basename(clipFile),
    roi: ROI,
    frame: { width: fw, height: fh, source: { width: sw, height: sh } },
    frames: frames.length,
    threads: Number(THREADS),
    minFacePx: MIN_PX,
    configs: {},
  };
  for (const ref of ["ref-fp32-1280", "ref-fp32-native"]) {
    if (!results.has(ref)) continue;
    const R = results.get(ref)!;
    const refFaces = R.reduce((a, r) => a + r.faces.filter((f) => sizeOf(f) >= MIN_PX).length, 0);
    report[ref] = { facesAtLeastMin: refFaces, faceSizes: dist(R.flatMap((r) => r.faces.filter((f) => sizeOf(f) >= MIN_PX).map(sizeOf)), 0) };
  }
  for (const c of cfgs) {
    const runs = results.get(c.name)!;
    const row: any = {
      ...meta.get(c.name),
      plan: c.plan,
      msPerFrame: dist(runs.map((r) => r.ms), 0),
      runsPerFrame: runs[0]?.runs ?? 1,
      detectionsAtLeastMin: runs.reduce((a, r) => a + r.faces.filter((f) => sizeOf(f) >= MIN_PX).length, 0),
      detectionsAll: runs.reduce((a, r) => a + r.faces.length, 0),
      vs: {},
    };
    for (const ref of ["ref-fp32-1280", "ref-fp32-native"]) {
      if (!results.has(ref) || ref === c.name) continue;
      const R = results.get(ref)!;
      let refN = 0;
      let hit = 0;
      let extra = 0;
      const ious: number[] = [];
      const lmk: number[] = [];
      const drift: number[] = [];
      const sizeMissed: number[] = [];
      const scoreDelta: number[] = [];
      for (let k = 0; k < runs.length; k++) {
        const refBig = R[k].faces.map((f, i) => ({ f, i })).filter((x) => sizeOf(x.f) >= MIN_PX);
        const m = matchFaces(R[k].faces, runs[k].faces);
        refN += refBig.length;
        for (const { f, i } of refBig) {
          const mm = m.get(i);
          if (!mm) {
            sizeMissed.push(sizeOf(f));
            continue;
          }
          hit += 1;
          ious.push(mm.iou);
          lmk.push(landmarkError(f, runs[k].faces[mm.j]));
          scoreDelta.push(Math.abs(f.score - runs[k].faces[mm.j].score));
          const ea = R[k].emb.get(i);
          const eb = runs[k].emb.get(mm.j);
          if (ea && eb) drift.push(1 - cosineSimilarity(ea, eb));
        }
        const matchedJ = new Set(Array.from(m.values()).map((v) => v.j));
        extra += runs[k].faces.filter((f, j) => sizeOf(f) >= MIN_PX && !matchedJ.has(j)).length;
      }
      row.vs[ref] = {
        refFaces: refN,
        found: hit,
        recall: refN ? +(hit / refN).toFixed(3) : null,
        extraAtLeastMin: extra,
        iou: dist(ious),
        landmarkErrPct: dist(lmk, 1),
        scoreDelta: dist(scoreDelta),
        embeddingDrift: dist(drift, 4),
        missedSizes: sizeMissed.sort((a, b) => a - b).map((v) => Math.round(v)),
      };
    }
    report.configs[c.name] = row;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1), { mode: 0o600 });

  // Markdown table (vs native reference; the 1280 one is in the JSON).
  const ref = results.has("ref-fp32-native") ? "ref-fp32-native" : "ref-fp32-1280";
  console.log(`\n| config | detector input | scale | recall vs ${ref} (>=${MIN_PX} px) | recall vs ref-fp32-1280 | extra | IoU p50 | lmk err % p50/p95 | emb drift p50/p95/max | ms/frame p50/p95 (${THREADS} thr) |`);
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const c of cfgs) {
    const r = report.configs[c.name];
    const v = r.vs[ref] || {};
    const v2 = r.vs["ref-fp32-1280"] || {};
    const pct = (x: any) => (x && x.recall !== null && x.recall !== undefined ? `${x.found}/${x.refFaces} (${(x.recall * 100).toFixed(0)}%)` : "-");
    const d = v.embeddingDrift || {};
    const l = v.landmarkErrPct || {};
    console.log(`| ${c.name} | ${r.input} | ${Number.isNaN(r.scale) ? "1.0 (tile)" : r.scale} | ${pct(v)} | ${pct(v2)} | ${v.extraAtLeastMin ?? "-"} | ${v.iou?.median ?? "-"} | ${l.median ?? "-"} / ${l.p95 ?? "-"} | ${d.median ?? "-"} / ${d.p95 ?? "-"} / ${d.max ?? "-"} | ${r.msPerFrame.median} / ${r.msPerFrame.p95} |`);
  }
  console.log(`\n[eval] report -> ${OUT}`);
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
