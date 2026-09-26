#!/usr/bin/env -S npx tsx
/**
 * INT8 vs FP32 accuracy on real gate captures (real-time pipeline step 4).
 *
 *   npx tsx scripts/perf/int8-eval.ts <frames-dir> <out.json> [--every 2] [--offset 1]
 *
 * Uses frames NOT used for calibration (index % every === offset; dump-calib.ts
 * takes offset 0). Three engine configurations run over the same frames:
 *   A  fp32 detector + fp32 recogniser   (reference, what production runs)
 *   B  int8 detector + fp32 recogniser   (detector drift only)
 *   C  int8 detector + int8 recogniser   (full INT8)
 * and one isolated recogniser check:
 *   R  the SAME aligned 112x112 crops (from A) embedded by fp32 and int8.
 *
 * Reports aggregates only (no images/embeddings): detector recall and box IoU
 * of B vs A (all faces and faces >= FACE_MIN_SIZE_PX), extra detections,
 * clear-flag agreement; cosine drift (1 - cos) for R and for C vs A.
 */

import fs from "node:fs";
import path from "node:path";
import {
  loadImage,
  alignFace,
  embedFace,
  extractFaces,
  cosineSimilarity,
  iou,
  resetFaceEngine,
  getFaceEngine,
  getFaceEngineInfo,
  CLEAR_FACE_LIMITS,
  type RgbImage,
  type ExtractedFace,
} from "../../src/server/faceEmbedding";

const [dir, outPath] = process.argv.slice(2);
const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const every = arg("--every", 2);
const offset = arg("--offset", 1);
const MIN_PX = CLEAR_FACE_LIMITS.minFacePx;

const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};
const dist = (xs: number[]) => ({
  n: xs.length,
  median: +q(xs, 0.5).toFixed(4),
  p95: +q(xs, 0.95).toFixed(4),
  p99: +q(xs, 0.99).toFixed(4),
  max: +Math.max(...xs).toFixed(4),
});

/** The INT8 ArcFace candidate is not a selectable variant (it failed the bar); load it by file name. */
const REC_INT8_FILE = process.env.REC_INT8_FILE || "w600k_r50_int8_rejected.onnx";

async function useVariants(det: string, rec: string) {
  process.env.FACE_DETECTOR_VARIANT = det;
  if (rec === "int8") process.env.FACE_RECOGNIZER_MODEL = REC_INT8_FILE;
  else delete process.env.FACE_RECOGNIZER_MODEL;
  resetFaceEngine();
  if (!(await getFaceEngine())) throw new Error(`engine ${det}/${rec} unavailable: ${getFaceEngineInfo().lastError}`);
}

function matchFaces(ref: Array<{ box: number[] }>, other: Array<{ box: number[] }>) {
  // Greedy by IoU, one-to-one.
  const pairs: Array<{ i: number; j: number; iou: number }> = [];
  for (let i = 0; i < ref.length; i++) for (let j = 0; j < other.length; j++) {
    const o = iou(ref[i].box, other[j].box);
    if (o > 0) pairs.push({ i, j, iou: o });
  }
  pairs.sort((a, b) => b.iou - a.iou);
  const usedI = new Set<number>();
  const usedJ = new Set<number>();
  const out = new Map<number, { j: number; iou: number }>();
  for (const p of pairs) {
    if (usedI.has(p.i) || usedJ.has(p.j) || p.iou < 0.5) continue;
    usedI.add(p.i);
    usedJ.add(p.j);
    out.set(p.i, { j: p.j, iou: p.iou });
  }
  return out;
}

async function main() {
  if (!dir || !outPath) throw new Error("usage: int8-eval.ts <frames-dir> <out.json> [--every 2] [--offset 1]");
  const files = fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort().filter((_, n) => n % every === offset);
  // Decoded 4K frames are ~25 MB each: decode per pass instead of holding them all.
  async function* images(): AsyncGenerator<RgbImage> {
    for (const f of files) {
      const img = await loadImage(fs.readFileSync(path.join(dir, f)));
      if (img) yield img;
    }
  }

  // A: FP32 reference, plus the aligned crops for the isolated recogniser check.
  await useVariants("fp32", "fp32");
  const A: ExtractedFace[][] = [];
  const aligned: RgbImage[][] = [];
  const recFp32: Float32Array[][] = [];
  for await (const img of images()) {
    const faces = await extractFaces(img);
    A.push(faces);
    const crops: RgbImage[] = [];
    const embs: Float32Array[] = [];
    for (const f of faces) {
      const a = alignFace(img, f.landmarks);
      if (!a) continue;
      crops.push(a);
      embs.push(f.embedding);
    }
    aligned.push(crops);
    recFp32.push(embs);
  }

  // --rec-files a.onnx,b.onnx: recogniser-only comparison of candidate files
  // (same FP32-aligned crops), no detector passes.
  const recFilesArg = process.argv.indexOf("--rec-files");
  if (recFilesArg > 0) {
    const result: Record<string, unknown> = { frames: A.length };
    for (const file of process.argv[recFilesArg + 1].split(",")) {
      process.env.FACE_DETECTOR_VARIANT = "fp32";
      process.env.FACE_RECOGNIZER_MODEL = file;
      resetFaceEngine();
      if (!(await getFaceEngine())) throw new Error(`recogniser ${file} unavailable: ${getFaceEngineInfo().lastError}`);
      const drift: number[] = [];
      const ms: number[] = [];
      for (let k = 0; k < aligned.length; k++) {
        for (let m = 0; m < aligned[k].length; m++) {
          const t0 = performance.now();
          const e = await embedFace(aligned[k][m]);
          ms.push(performance.now() - t0);
          if (e) drift.push(1 - cosineSimilarity(e, recFp32[k][m]));
        }
      }
      result[file] = { drift: dist(drift), embedMsMedian: +q(ms, 0.5).toFixed(1) };
    }
    delete process.env.FACE_RECOGNIZER_MODEL;
    fs.writeFileSync(outPath, JSON.stringify(result, null, 1), { mode: 0o600 });
    console.log(JSON.stringify(result, null, 1));
    return;
  }

  await useVariants("int8", "fp32");
  const B: ExtractedFace[][] = [];
  for await (const img of images()) B.push(await extractFaces(img));

  await useVariants("int8", "int8");
  const C: ExtractedFace[][] = [];
  for await (const img of images()) C.push(await extractFaces(img));
  const recDrift: number[] = [];
  for (let k = 0; k < aligned.length; k++) {
    for (let m = 0; m < aligned[k].length; m++) {
      const e = await embedFace(aligned[k][m]);
      if (e) recDrift.push(1 - cosineSimilarity(e, recFp32[k][m]));
    }
  }
  const info = getFaceEngineInfo();

  // Detector drift, B vs A.
  const det = { refFaces: 0, refUsable: 0, found: 0, foundUsable: 0, extra: 0, extraUsable: 0, clearAgree: 0, clearCompared: 0 };
  const boxIou: number[] = [];
  const boxIouUsable: number[] = [];
  const scoreDelta: number[] = [];
  const e2eDrift: number[] = [];
  const e2eDriftUsable: number[] = [];
  const detOnlyDrift: number[] = [];
  for (let k = 0; k < A.length; k++) {
    const mB = matchFaces(A[k], B[k]);
    const mC = matchFaces(A[k], C[k]);
    det.extra += B[k].length - mB.size;
    det.extraUsable += B[k].filter((f, j) => f.boxSize >= MIN_PX && ![...mB.values()].some((v) => v.j === j)).length;
    for (let i = 0; i < A[k].length; i++) {
      const a = A[k][i];
      const usable = a.boxSize >= MIN_PX;
      det.refFaces++;
      if (usable) det.refUsable++;
      const b = mB.get(i);
      if (b) {
        det.found++;
        if (usable) det.foundUsable++;
        boxIou.push(b.iou);
        if (usable) boxIouUsable.push(b.iou);
        const bf = B[k][b.j];
        scoreDelta.push(Math.abs(bf.score - a.score));
        detOnlyDrift.push(1 - cosineSimilarity(bf.embedding, a.embedding));
        det.clearCompared++;
        if (bf.clear === a.clear) det.clearAgree++;
      }
      const c = mC.get(i);
      if (c) {
        const d = 1 - cosineSimilarity(C[k][c.j].embedding, a.embedding);
        e2eDrift.push(d);
        if (usable && a.clear) e2eDriftUsable.push(d);
      }
    }
  }
  const out = {
    frames: A.length,
    engine: { detector: info.detectorModel, recognizer: info.recognizerModel, modelTag: info.modelTag },
    detector: {
      ...det,
      recallPct: +((100 * det.found) / det.refFaces).toFixed(2),
      recallUsablePct: +((100 * det.foundUsable) / det.refUsable).toFixed(2),
      boxIou: { median: +q(boxIou, 0.5).toFixed(4), p5: +q(boxIou, 0.05).toFixed(4), min: +Math.min(...boxIou).toFixed(4) },
      boxIouUsable: { median: +q(boxIouUsable, 0.5).toFixed(4), p5: +q(boxIouUsable, 0.05).toFixed(4), min: +Math.min(...boxIouUsable).toFixed(4) },
      scoreAbsDelta: { median: +q(scoreDelta, 0.5).toFixed(4), max: +Math.max(...scoreDelta).toFixed(4) },
      clearAgreePct: +((100 * det.clearAgree) / det.clearCompared).toFixed(2),
    },
    /** 1 - cosine. */
    drift: {
      recogniserOnly_sameCrops: dist(recDrift),
      detectorOnly_int8det_fp32rec: dist(detOnlyDrift),
      full_int8_vs_fp32_allFaces: dist(e2eDrift),
      full_int8_vs_fp32_clearUsable: dist(e2eDriftUsable),
    },
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1), { mode: 0o600 });
  console.log(JSON.stringify(out, null, 1));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
