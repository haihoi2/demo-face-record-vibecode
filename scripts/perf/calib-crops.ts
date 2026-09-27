#!/usr/bin/env -S npx tsx
/**
 * Labelled, ArcFace-aligned face crops for recogniser calibration (real-time
 * pipeline, CALIB). Produces what scripts/perf/calib-eval.ts and
 * scripts/perf/quantize-rec.py consume.
 *
 *   npx tsx scripts/perf/calib-crops.ts <out-dir> [--logs <export-dir>] [--clips <clips-dir>] [--via-crop] [--append]
 *
 * --append continues an existing <out-dir>/index.json (numbering and counters), so
 * the sources can be added in separate runs.
 *
 * Inputs (biometric data - keep them in a 0700 directory and delete afterwards):
 *   --logs   <dir>/index.json + JPEGs exported read-only from access_logs
 *            ({file, logId, status, employeeId, gate, ts}). A GRANTED row with
 *            exactly one clear face >= FACE_MIN_SIZE_PX labels that face with
 *            its employeeId ("weak": the label came from the FP32 r50 decision
 *            itself). Rows with several clear faces are skipped (the employee
 *            is not identifiable). DENIED faces are stored unlabelled
 *            (identity null) as probable strangers.
 *   --clips  <dir>/passages.tsv (file, gate, passageId, startS, durS, nPeople,
 *            employeeIds) + <dir>/<passageId>/f_*.jpg sampled from the NVR
 *            clips (raw frames, no annotator box). A passage with exactly one
 *            person labels every single-face frame with that person: the
 *            employeeId, or "stranger:<passageId>" for a stranger (same person
 *            within the passage only). Mixed passages are skipped.
 *
 * Detection/alignment is exactly the pipeline's: FP32 SCRFD through
 * detectFaces() on the full picture (letterboxed to FACE_DETECT_SIZE),
 * alignFace() from the frame landmarks, clearFaceIssue() as the gate. Only
 * faces the pipeline would embed (clear, >= FACE_MIN_SIZE_PX) are kept.
 *
 * Output <out-dir>/:
 *   rec_<n>.u8     112x112x3 uint8 RGB, aligned from the full-frame landmarks
 *   crop_<n>.u8    (--via-crop) the same face re-detected on the pipeline's
 *                  stored JPEG crop (faceCrop defaults) and re-aligned from the
 *                  crop's landmarks: what a gallery derived from stored
 *                  photoSnapshot crops would embed. Missing when the face is
 *                  not found again on the crop (counted in index.json).
 *   index.json     one entry per face: labels + geometry/quality, no pixels
 *   calib/rec_*.u8 copies of the unlabelled DENIED crops with odd n (INT8
 *                  calibration set; calib-eval.ts excludes them from scoring)
 */

import fs from "node:fs";
import path from "node:path";
import {
  CLEAR_FACE_LIMITS,
  alignFace,
  clearFaceIssue,
  detectFaces,
  facePose,
  faceQuality,
  getFaceEngine,
  getFaceEngineInfo,
  iou,
  loadImage,
  type FaceBox,
  type RgbImage,
} from "../../src/server/faceEmbedding";
import { boxInCrop, computeFaceCropRect, cropFaceFromRgb } from "../../src/server/pipeline/faceCrop";

interface Entry {
  n: number;
  source: "log" | "clip";
  /** logId, or passageId/frame for clips: two crops of one group are the same capture. */
  groupId: string;
  /** Person the crop belongs to when known: EMP-xxx, "stranger:<passageId>", or null (DENIED/unknown). */
  identity: string | null;
  /** How the identity was obtained. */
  labelQuality: "weak" | "none";
  status: "GRANTED" | "DENIED" | "CLIP";
  gate: string;
  ts: string;
  boxSize: number;
  score: number;
  quality: number;
  sharpness: number;
  picture: { width: number; height: number };
  /** Faces >= min size in the picture (clear or not). */
  facesInPicture: number;
  viaCrop?: { found: boolean; iou?: number; boxSize?: number; quality?: number; clear?: boolean; cropBytes?: number };
}

const args = process.argv.slice(2);
const outDir = args[0];
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i > 0 ? args[i + 1] : undefined;
};
const logsDir = opt("--logs");
const clipsDir = opt("--clips");
const viaCrop = args.includes("--via-crop");
const append = args.includes("--append");
if (!outDir || (!logsDir && !clipsDir)) {
  console.error("usage: calib-crops.ts <out-dir> [--logs <export-dir>] [--clips <clips-dir>] [--via-crop]");
  process.exit(2);
}

const MIN_PX = Number(process.env.FACE_MIN_SIZE_PX || 60);

function writeU8(file: string, img: RgbImage) {
  fs.writeFileSync(file, Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { mode: 0o600 });
}

interface Picked {
  face: FaceBox;
  boxSize: number;
  aligned: RgbImage;
  quality: number;
  sharpness: number;
}

/** Faces the pipeline would embed: >= MIN_PX and clear; plus the count of faces >= MIN_PX. */
function usableFaces(img: RgbImage, faces: FaceBox[]): { usable: Picked[]; sized: number } {
  const usable: Picked[] = [];
  let sized = 0;
  for (const f of faces) {
    const boxSize = Math.min(f.box[2] - f.box[0], f.box[3] - f.box[1]);
    if (boxSize < MIN_PX) continue;
    sized++;
    if (clearFaceIssue(facePose(f.landmarks), CLEAR_FACE_LIMITS, boxSize) !== null) continue;
    const aligned = alignFace(img, f.landmarks);
    if (!aligned) continue;
    const { quality, sharpness } = faceQuality(aligned, boxSize);
    usable.push({ face: f, boxSize, aligned, quality, sharpness });
  }
  return { usable, sized };
}

async function reDetectOnCrop(img: RgbImage, p: Picked): Promise<{ img: RgbImage | null; meta: Entry["viaCrop"] }> {
  const rect = computeFaceCropRect(p.face.box, img.width, img.height);
  const jpeg = rect ? await cropFaceFromRgb({ width: img.width, height: img.height, rgb: img.data }, p.face.box) : null;
  if (!rect || !jpeg) return { img: null, meta: { found: false } };
  const crop = await loadImage(jpeg);
  if (!crop) return { img: null, meta: { found: false, cropBytes: jpeg.length } };
  const want = boxInCrop(p.face.box, rect);
  const faces = await detectFaces(crop);
  let best: FaceBox | null = null;
  let bestIou = 0;
  for (const f of faces) {
    const v = iou(f.box, want);
    if (v > bestIou) {
      bestIou = v;
      best = f;
    }
  }
  if (!best || bestIou < 0.5) return { img: null, meta: { found: false, iou: bestIou, cropBytes: jpeg.length } };
  const boxSize = Math.min(best.box[2] - best.box[0], best.box[3] - best.box[1]);
  const clear = clearFaceIssue(facePose(best.landmarks), CLEAR_FACE_LIMITS, boxSize) === null;
  const aligned = alignFace(crop, best.landmarks);
  if (!aligned) return { img: null, meta: { found: false, iou: bestIou, cropBytes: jpeg.length } };
  const { quality } = faceQuality(aligned, boxSize);
  return { img: aligned, meta: { found: true, iou: bestIou, boxSize, quality, clear, cropBytes: jpeg.length } };
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(outDir, "calib"), { recursive: true, mode: 0o700 });
  if (!(await getFaceEngine())) {
    console.error("engine not ready:", getFaceEngineInfo().lastError);
    process.exit(1);
  }
  const info = getFaceEngineInfo();
  console.log(`engine ${info.detectorModel} + ${info.recognizerModel}, detect size ${info.detectorInputSize}, min face ${MIN_PX} px`);

  let entries: Entry[] = [];
  let skipped = { noFace: 0, multiClear: 0, notClear: 0, decode: 0, viaCropMissing: 0 };
  let n = 0;
  const indexFile = path.join(outDir, "index.json");
  if (append && fs.existsSync(indexFile)) {
    const prev = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    entries = prev.entries;
    skipped = { ...skipped, ...prev.skipped };
    n = entries.reduce((m, e) => Math.max(m, e.n + 1), 0);
    console.log(`appending to ${entries.length} existing crops (next n = ${n})`);
  }

  const store = async (img: RgbImage, p: Picked, base: Omit<Entry, "n" | "boxSize" | "score" | "quality" | "sharpness" | "picture" | "viaCrop">, sized: number) => {
    const e: Entry = {
      n,
      ...base,
      boxSize: Math.round(p.boxSize),
      score: Math.round(p.face.score * 1000) / 1000,
      quality: Math.round(p.quality * 1000) / 1000,
      sharpness: Math.round(p.sharpness),
      picture: { width: img.width, height: img.height },
      facesInPicture: sized,
    };
    writeU8(path.join(outDir, `rec_${n}.u8`), p.aligned);
    if (viaCrop) {
      const r = await reDetectOnCrop(img, p);
      e.viaCrop = r.meta;
      if (r.img) writeU8(path.join(outDir, `crop_${n}.u8`), r.img);
      else skipped.viaCropMissing++;
    }
    if (e.status === "DENIED" && n % 2 === 1) fs.copyFileSync(path.join(outDir, `rec_${n}.u8`), path.join(outDir, "calib", `rec_${n}.u8`));
    entries.push(e);
    n++;
  };

  if (logsDir) {
    const rows: Array<{ file: string; logId: string; status: string; employeeId: string | null; gate: string; ts: string }> = JSON.parse(
      fs.readFileSync(path.join(logsDir, "index.json"), "utf8"),
    );
    let done = 0;
    for (const row of rows) {
      const img = await loadImage(fs.readFileSync(path.join(logsDir, row.file)));
      if (!img) {
        skipped.decode++;
        continue;
      }
      const { usable, sized } = usableFaces(img, await detectFaces(img));
      if (sized === 0) skipped.noFace++;
      else if (usable.length === 0) skipped.notClear++;
      if (row.status === "GRANTED") {
        if (usable.length === 1) {
          await store(img, usable[0], { source: "log", groupId: row.logId, identity: row.employeeId, labelQuality: "weak", status: "GRANTED", gate: row.gate, ts: row.ts, facesInPicture: sized }, sized);
        } else if (usable.length > 1) skipped.multiClear++;
      } else {
        for (const p of usable) {
          await store(img, p, { source: "log", groupId: row.logId, identity: null, labelQuality: "none", status: "DENIED", gate: row.gate, ts: row.ts, facesInPicture: sized }, sized);
        }
      }
      if (++done % 50 === 0) console.log(`logs: ${done}/${rows.length} pictures, ${n} crops`);
    }
  }

  if (clipsDir) {
    const lines = fs.readFileSync(path.join(clipsDir, "passages.tsv"), "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const [file, gate, pid, , , nPeople, emps] = line.split("\t");
      const people = Number(nPeople);
      if (people !== 1) continue; // mixed passages: no per-face label
      const identity = emps ? emps.split(",")[0] : `stranger:${pid}`;
      const dir = path.join(clipsDir, pid);
      if (!fs.existsSync(dir)) continue;
      const frames = fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
      let kept = 0;
      for (const f of frames) {
        const img = await loadImage(fs.readFileSync(path.join(dir, f)));
        if (!img) {
          skipped.decode++;
          continue;
        }
        const { usable, sized } = usableFaces(img, await detectFaces(img));
        if (sized === 0) skipped.noFace++;
        else if (usable.length === 0) skipped.notClear++;
        if (usable.length !== 1) {
          if (usable.length > 1) skipped.multiClear++;
          continue;
        }
        await store(img, usable[0], { source: "clip", groupId: `${pid}/${f}`, identity, labelQuality: "weak", status: "CLIP", gate, ts: pid, facesInPicture: sized }, sized);
        kept++;
      }
      console.log(`clip ${pid} (${gate}, ${path.basename(file)}): ${frames.length} frames, ${kept} single-face crops -> ${identity.startsWith("stranger") ? "stranger" : identity}`);
    }
  }

  fs.writeFileSync(indexFile, JSON.stringify({ createdAt: new Date().toISOString(), minFacePx: MIN_PX, detectSize: info.detectorInputSize, skipped, entries }, null, 1), { mode: 0o600 });
  const byIdentity = new Map<string, number>();
  for (const e of entries) byIdentity.set(e.identity ?? "(none)", (byIdentity.get(e.identity ?? "(none)") ?? 0) + 1);
  console.log(`crops: ${entries.length}; skipped ${JSON.stringify(skipped)}`);
  console.log("per identity:", Object.fromEntries([...byIdentity.entries()].sort((a, b) => b[1] - a[1])));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
