#!/usr/bin/env -S npx tsx
/**
 * Face-engine latency benchmark in the app's own runtime (onnxruntime-node).
 *
 *   npx tsx scripts/perf/bench-engine.ts [--models /models] [--threads 1,2,4]
 *        [--iters 40] [--variants fp32,int8] [--frames <dir>]
 *
 * For each model variant and intra-op thread count, creates a session exactly
 * as src/server/faceEmbedding.ts does (CPU EP, graph optimisation "all") and
 * times `run()` on a fixed input: SCRFD det_10g at 1x3x640x640, ArcFace
 * w600k_r50 at 1x3x112x112. Reports median / p90 / min ms per call.
 *
 * With --frames it also times the JS-side stages the engine adds per frame
 * (ffmpeg JPEG decode, area-downscale letterbox to 640, one alignment).
 * Also probes whether an OpenVINO execution provider can be created.
 * Prints numbers only - no image data or embeddings.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import * as ort from "onnxruntime-node";
import { loadImage, resizeArea, alignFace, ARCFACE_TEMPLATE } from "../../src/server/faceEmbedding";

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : d;
};
const MODELS = arg("--models", process.env.FACE_MODEL_DIR || "/models");
const THREADS = arg("--threads", "1,2,4").split(",").map(Number);
const ITERS = Number(arg("--iters", "40"));
const VARIANTS = arg("--variants", "fp32,int8").split(",");
const FRAMES = arg("--frames", "");

/** The INT8 ArcFace is measured for reference only: it failed the drift bar and is not selectable. */
const REC_INT8_FILE = process.env.REC_INT8_FILE || "w600k_r50_int8_rejected.onnx";
const FILES: Record<string, { det: string; rec: string }> = {
  fp32: { det: "det_10g.onnx", rec: "w600k_r50.onnx" },
  int8: { det: "det_10g_int8.onnx", rec: REC_INT8_FILE },
};

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
  return { median: +at(0.5).toFixed(1), p90: +at(0.9).toFixed(1), min: +s[0].toFixed(1) };
}

function seeded(n: number, seed = 7): Float32Array {
  const out = new Float32Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x / 0x7fffffff) * 2 - 1;
  }
  return out;
}

async function timeModel(file: string, dims: number[], threads: number) {
  const session = await ort.InferenceSession.create(file, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    intraOpNumThreads: threads,
  });
  const n = dims.reduce((a, b) => a * b, 1);
  const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", seeded(n), dims) };
  for (let i = 0; i < 5; i++) await session.run(feeds);
  const times: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now();
    await session.run(feeds);
    times.push(performance.now() - t0);
  }
  await session.release();
  return stats(times);
}

async function main() {
  const rows: Array<Record<string, unknown>> = [];
  for (const variant of VARIANTS) {
    const f = FILES[variant];
    if (!f) continue;
    for (const [model, file, dims] of [
      ["SCRFD det_10g", f.det, [1, 3, 640, 640]],
      ["ArcFace w600k_r50", f.rec, [1, 3, 112, 112]],
    ] as const) {
      const full = path.join(MODELS, file);
      if (!fs.existsSync(full)) {
        rows.push({ variant, model, file, error: "missing" });
        continue;
      }
      for (const threads of THREADS) {
        const s = await timeModel(full, [...dims], threads);
        rows.push({ variant, model, threads, ...s, sizeMB: +(fs.statSync(full).size / 1e6).toFixed(1) });
      }
    }
  }
  // --files a.onnx,b.onnx: extra candidate files (det_* -> 640 input, others -> 112).
  const filesArg = process.argv.indexOf("--files");
  if (filesArg > 0) {
    for (const file of process.argv[filesArg + 1].split(",")) {
      const full = path.join(MODELS, file);
      if (!fs.existsSync(full)) {
        rows.push({ variant: "file", model: file, error: "missing" });
        continue;
      }
      const dims = file.startsWith("det_") ? [1, 3, 640, 640] : [1, 3, 112, 112];
      for (const threads of THREADS) {
        const s = await timeModel(full, dims, threads);
        rows.push({ variant: "file", model: file, threads, ...s, sizeMB: +(fs.statSync(full).size / 1e6).toFixed(1) });
      }
    }
  }
  console.table(rows);

  // OpenVINO EP: onnxruntime-node's prebuilt binaries ship CPU (+CUDA/TensorRT on linux x64) only.
  let openvino = "";
  try {
    const s = await ort.InferenceSession.create(path.join(MODELS, FILES.fp32.rec), {
      executionProviders: ["openvino" as unknown as "cpu"],
    });
    openvino = `session created (EP list accepted); inputs=${s.inputNames.length}`;
    await s.release();
  } catch (err) {
    openvino = `unavailable: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
  }
  console.log(`OpenVINO EP: ${openvino}`);
  const binDir = path.join(path.dirname(createRequire(import.meta.url).resolve("onnxruntime-node/package.json")), "bin/napi-v6", process.platform, process.arch);
  if (fs.existsSync(binDir)) console.log(`bundled native libs: ${fs.readdirSync(binDir).join(", ")}`);

  if (FRAMES) {
    const files = fs.readdirSync(FRAMES).filter((x) => /\.jpe?g$/i.test(x)).sort().slice(0, 30);
    const decode: Record<string, number[]> = {};
    const letterbox: Record<string, number[]> = {};
    const align: number[] = [];
    for (const file of files) {
      const buf = fs.readFileSync(path.join(FRAMES, file));
      const t0 = performance.now();
      const img = await loadImage(buf);
      const t1 = performance.now();
      if (!img) continue;
      const key = `${img.width}x${img.height}`;
      (decode[key] ||= []).push(t1 - t0);
      const scale = Math.min(640 / img.width, 640 / img.height);
      const t2 = performance.now();
      resizeArea(img, Math.round(img.width * scale), Math.round(img.height * scale));
      (letterbox[key] ||= []).push(performance.now() - t2);
      const cx = img.width / 2;
      const cy = img.height / 2;
      const pts = ARCFACE_TEMPLATE.map(([x, y]) => [cx + x, cy + y] as [number, number]);
      const t3 = performance.now();
      alignFace(img, pts);
      align.push(performance.now() - t3);
    }
    const out: Array<Record<string, unknown>> = [];
    for (const key of Object.keys(decode)) {
      out.push({ stage: "ffmpeg JPEG decode", size: key, ...stats(decode[key]) });
      out.push({ stage: "JS area letterbox to 640", size: key, ...stats(letterbox[key]) });
    }
    out.push({ stage: "JS align 112x112", size: "-", ...stats(align) });
    console.table(out);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
