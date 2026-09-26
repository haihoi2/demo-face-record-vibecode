#!/usr/bin/env -S npx tsx
/**
 * Enrol-from-crop evaluation (real-time pipeline step 3).
 *
 *   npx tsx scripts/perf/crop-eval.ts <frames-dir> <out.json> [--limit N]
 *
 * For every JPEG in <frames-dir> (real gate captures; biometric data - keep the
 * directory 0700 and delete it afterwards): find the face the enrolment path
 * would pick on the full frame (clear, best quality), crop it at a grid of
 * margins x minimum sizes, run the enrolment path again on the crop and report
 * aggregates only: re-found %, enrol-grade % (the target is the face enrolment
 * picks AND quality >= 0.25), cosine to the full-frame embedding, crop KB.
 *
 * Nothing biometric is written: <out.json> holds per-frame numbers (sizes,
 * qualities, cosines) keyed by an index, no images and no embeddings.
 *
 * Env: FACE_MODEL_DIR, CROP_MARGINS (1.5,2,2.5), CROP_MIN_SIZES (160,224,288),
 * CROP_MAX_SIZES (0), CROP_QSCALES (4), FACE_ENROLL_MIN_QUALITY (0.25),
 * UPSCALE_MODES (area) - FACE_DETECT_UPSCALE values compared on the crops,
 * NEUTRALISE_GREEN (0) - 1 inpaints the thick green box stored snapshots carry
 * (server.ts annotateSnapshotWithBoxes draws it at 1.7x the face box, iw/120
 * thick, i.e. OUTSIDE the face) to approximate the raw frames the pipeline crops.
 */

import fs from "node:fs";
import path from "node:path";
import { extractFaces, loadImage, cosineSimilarity, iou, getFaceEngine, type ExtractedFace, type RgbImage } from "../../src/server/faceEmbedding";
import { computeFaceCropRect, cropFaceFromRgb, boxInCrop } from "../../src/server/pipeline/faceCrop";

const [dir, outPath] = process.argv.slice(2);
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
if (!dir || !outPath) {
  console.error("usage: crop-eval.ts <frames-dir> <out.json> [--limit N]");
  process.exit(2);
}
const list = (name: string, dflt: string) => (process.env[name] || dflt).split(",").map(Number).filter(Number.isFinite);
const MARGINS = list("CROP_MARGINS", "1.5,2,2.5");
const MIN_SIZES = list("CROP_MIN_SIZES", "160,224,288");
const MAX_SIZES = list("CROP_MAX_SIZES", "0");
const QSCALES = list("CROP_QSCALES", "4");
const ENROL_MIN_Q = Number(process.env.FACE_ENROLL_MIN_QUALITY || 0.25);
const UPSCALE_MODES = (process.env.UPSCALE_MODES || "area").split(",").map((m) => m.trim()).filter(Boolean);
const NEUTRALISE_GREEN = process.env.NEUTRALISE_GREEN === "1";
/** Crop-to-crop consistency is measured against this cell (the proposed default). */
const REF_KEY = process.env.CROP_REF_KEY || `m2/min224/max0/q4/up-${UPSCALE_MODES[0]}`;

/** Saturated annotation green after JPEG: high G, low R and B. */
function isBurnedGreen(d: Uint8Array, i: number): boolean {
  const r = d[i];
  const g = d[i + 1];
  const b = d[i + 2];
  return g >= 150 && r <= 110 && b <= 110 && g - Math.max(r, b) >= 90;
}

/**
 * Replace burned-in green pixels (mask grown by 2 px for JPEG ringing) with the
 * inverse-distance mean of the nearest unmasked pixel in each of the four
 * directions, <= 96 px away. Returns the number of green pixels found.
 */
function neutraliseGreen(img: RgbImage): number {
  const { width: w, height: h, data } = img;
  const mask = new Uint8Array(w * h);
  let n = 0;
  for (let p = 0; p < w * h; p++) {
    if (isBurnedGreen(data, p * 3)) {
      mask[p] = 1;
      n++;
    }
  }
  if (!n) return 0;
  for (let pass = 0; pass < 2; pass++) {
    const grown = mask.slice();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        if (!mask[p] && (mask[p - 1] || mask[p + 1] || mask[p - w] || mask[p + w])) grown[p] = 1;
      }
    }
    mask.set(grown);
  }
  const out = data.slice();
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!mask[p]) continue;
      let sr = 0, sg = 0, sb = 0, sw = 0;
      for (const [dx, dy] of dirs) {
        for (let k = 1; k <= 96; k++) {
          const xx = x + dx * k;
          const yy = y + dy * k;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) break;
          const t = yy * w + xx;
          if (mask[t]) continue;
          const wt = 1 / k;
          sr += data[t * 3] * wt;
          sg += data[t * 3 + 1] * wt;
          sb += data[t * 3 + 2] * wt;
          sw += wt;
          break;
        }
      }
      if (sw > 0) {
        out[p * 3] = sr / sw;
        out[p * 3 + 1] = sg / sw;
        out[p * 3 + 2] = sb / sw;
      }
    }
  }
  data.set(out);
  return n;
}

/** The face enrolTemplateFromImage() would keep: clear faces only, highest quality. */
function enrolPick(faces: ExtractedFace[]): ExtractedFace | null {
  const clear = faces.filter((f) => f.clear);
  if (!clear.length) return null;
  return clear.reduce((a, b) => (b.quality > a.quality ? b : a));
}

interface Cell {
  n: number;
  refound: number;
  enrolOk: number;
  pickedOther: number;
  qualityOk: number;
  cos: number[];
  /** Cosine to the crop embedding of the reference cell (REF_KEY), same frame. */
  cosRef: number[];
  kb: number[];
  ms: number[];
  qDelta: number[];
}
const cells = new Map<string, Cell>();
const cell = (k: string) => {
  let c = cells.get(k);
  if (!c) cells.set(k, (c = { n: 0, refound: 0, enrolOk: 0, pickedOther: 0, qualityOk: 0, cos: [], cosRef: [], kb: [], ms: [], qDelta: [] }));
  return c;
};
const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};

async function main() {
  const engine = await getFaceEngine();
  if (!engine) throw new Error("face engine unavailable (FACE_MODEL_DIR?)");
  const files = fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort().slice(0, limit);
  const frames: Array<Record<string, unknown>> = [];
  const summary = {
    frames: files.length, decoded: 0, greenNeutralised: 0, noFace: 0, noClear: 0, used: 0, fullEnrolGrade: 0,
    byGate: {} as Record<string, number>, neutraliseGreen: NEUTRALISE_GREEN, upscaleModes: UPSCALE_MODES,
  };
  let idx = 0;
  for (const file of files) {
    idx++;
    const gate = file.split("_")[0];
    const img = await loadImage(fs.readFileSync(path.join(dir, file)));
    if (!img) continue;
    summary.decoded++;
    if (NEUTRALISE_GREEN && neutraliseGreen(img) > 0) summary.greenNeutralised++;
    delete process.env.FACE_DETECT_UPSCALE; // full frames are downscaled; mode is irrelevant there
    const faces = await extractFaces(img);
    if (!faces.length) {
      summary.noFace++;
      continue;
    }
    const target = enrolPick(faces);
    if (!target) {
      summary.noClear++;
      continue;
    }
    summary.used++;
    summary.byGate[gate] = (summary.byGate[gate] || 0) + 1;
    if (target.quality >= ENROL_MIN_Q) summary.fullEnrolGrade++;
    const rec: Record<string, unknown> = {
      i: idx, gate, w: img.width, h: img.height, faces: faces.length,
      boxSize: Math.round(target.boxSize), quality: +target.quality.toFixed(3), crops: {} as Record<string, unknown>,
    };
    const pic = { width: img.width, height: img.height, rgb: img.data };
    const cropEmb = new Map<string, Float32Array>();
    for (const margin of MARGINS) for (const minSizePx of MIN_SIZES) for (const maxSizePx of MAX_SIZES) for (const qscale of QSCALES) {
      const base = `m${margin}/min${minSizePx}/max${maxSizePx}/q${qscale}`;
      const opts = { margin, minSizePx, maxSizePx, qscale };
      const rect = computeFaceCropRect(target.box, img.width, img.height, opts);
      const t0 = performance.now();
      const jpeg = rect ? await cropFaceFromRgb(pic, target.box, opts) : null;
      const ms = performance.now() - t0;
      for (const mode of UPSCALE_MODES) {
        const key = `${base}/up-${mode}`;
        const c = cell(key);
        c.n++;
        if (!rect || !jpeg) continue;
        c.ms.push(ms);
        c.kb.push(jpeg.length / 1024);
        process.env.FACE_DETECT_UPSCALE = mode;
        const again = await extractFaces(jpeg);
        delete process.env.FACE_DETECT_UPSCALE;
        const expected = boxInCrop(target.box, rect);
        let match: ExtractedFace | null = null;
        let bestIou = 0;
        for (const f of again) {
          const o = iou(f.box, expected);
          if (o > bestIou) {
            bestIou = o;
            match = f;
          }
        }
        if (!match || bestIou < 0.5) {
          (rec.crops as Record<string, unknown>)[key] = { refound: false, facesInCrop: again.length, kb: +(jpeg.length / 1024).toFixed(1) };
          continue;
        }
        c.refound++;
        const cos = cosineSimilarity(match.embedding, target.embedding);
        c.cos.push(cos);
        cropEmb.set(key, match.embedding);
        c.qDelta.push(match.quality - target.quality);
        if (match.quality >= ENROL_MIN_Q) c.qualityOk++;
        const picked = enrolPick(again);
        if (picked && picked !== match) c.pickedOther++;
        if (picked === match && match.quality >= ENROL_MIN_Q) c.enrolOk++;
        (rec.crops as Record<string, unknown>)[key] = {
          refound: true, iou: +bestIou.toFixed(3), cos: +cos.toFixed(4), quality: +match.quality.toFixed(3), score: +match.score.toFixed(3),
          clear: match.clear, facesInCrop: again.length, kb: +(jpeg.length / 1024).toFixed(1), out: `${rect.outW}x${rect.outH}`,
        };
      }
    }
    const ref = cropEmb.get(REF_KEY);
    if (ref) for (const [key, emb] of cropEmb) if (key !== REF_KEY) cell(key).cosRef.push(cosineSimilarity(emb, ref));
    frames.push(rec);
    if (idx % 20 === 0) console.error(`.. ${idx}/${files.length}`);
  }
  const table = [...cells.entries()].map(([key, c]) => ({
    key,
    n: c.n,
    refoundPct: +((100 * c.refound) / c.n).toFixed(1),
    qualityOkPct: +((100 * c.qualityOk) / c.n).toFixed(1),
    enrolOkPct: +((100 * c.enrolOk) / c.n).toFixed(1),
    pickedOther: c.pickedOther,
    cosMedian: +q(c.cos, 0.5).toFixed(4),
    cosP10: +q(c.cos, 0.1).toFixed(4),
    cosMin: c.cos.length ? +Math.min(...c.cos).toFixed(4) : null,
    cosToRefCropMedian: c.cosRef.length ? +q(c.cosRef, 0.5).toFixed(4) : null,
    cosToRefCropP10: c.cosRef.length ? +q(c.cosRef, 0.1).toFixed(4) : null,
    qDeltaMedian: +q(c.qDelta, 0.5).toFixed(3),
    kbMedian: +q(c.kb, 0.5).toFixed(1),
    kbP90: +q(c.kb, 0.9).toFixed(1),
    kbMax: c.kb.length ? +Math.max(...c.kb).toFixed(1) : null,
    cropMsMedian: +q(c.ms, 0.5).toFixed(1),
  }));
  const boxSizes = frames.map((f) => f.boxSize as number);
  const out = {
    summary: { ...summary, targetBoxPx: { min: Math.min(...boxSizes), median: q(boxSizes, 0.5), max: Math.max(...boxSizes) } },
    table,
    frames,
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1), { mode: 0o600 });
  console.log(JSON.stringify(out.summary));
  console.table(table);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
