#!/usr/bin/env -S npx tsx
/**
 * Calibration tensors for static INT8 quantization (real-time pipeline step 4).
 *
 *   npx tsx scripts/perf/dump-calib.ts <frames-dir> <out-dir> [--every 2] [--offset 0]
 *
 * Writes, for every selected frame (index % every === offset), the exact
 * pixels the FP32 engine feeds its models, as raw uint8 RGB (HWC):
 *   det_<n>.u8   640x640x3  letterboxed detector input (padded bottom/right)
 *   rec_<n>_<k>.u8 112x112x3 ArcFace-aligned crop of each detected face
 * Normalisation is left to the quantizer (scripts/perf/quantize.py) so the
 * files stay small. These are biometric derivatives: keep <out-dir> 0700 and
 * delete it after quantization. Frames not selected are the held-out set that
 * scripts/perf/int8-eval.ts measures drift on.
 */

import fs from "node:fs";
import path from "node:path";
import { loadImage, resizeArea, alignFace, detectFaces } from "../../src/server/faceEmbedding";

const [dir, outDir] = process.argv.slice(2);
const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const every = arg("--every", 2);
const offset = arg("--offset", 0);
const SIZE = 640;

async function main() {
  if (!dir || !outDir) throw new Error("usage: dump-calib.ts <frames-dir> <out-dir> [--every 2] [--offset 0]");
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const files = fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort();
  let det = 0;
  let rec = 0;
  for (let n = 0; n < files.length; n++) {
    if (n % every !== offset) continue;
    const img = await loadImage(fs.readFileSync(path.join(dir, files[n])));
    if (!img) continue;
    const scale = Math.min(SIZE / img.width, SIZE / img.height);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const small = resizeArea(img, w, h);
    const canvas = new Uint8Array(SIZE * SIZE * 3);
    for (let y = 0; y < h; y++) canvas.set(small.data.subarray(y * w * 3, (y + 1) * w * 3), y * SIZE * 3);
    fs.writeFileSync(path.join(outDir, `det_${n}.u8`), canvas, { mode: 0o600 });
    det++;
    const faces = await detectFaces(img);
    let k = 0;
    for (const f of faces) {
      const aligned = alignFace(img, f.landmarks);
      if (!aligned) continue;
      fs.writeFileSync(path.join(outDir, `rec_${n}_${k++}.u8`), aligned.data, { mode: 0o600 });
      rec++;
    }
  }
  console.log(JSON.stringify({ frames: files.length, detInputs: det, recInputs: rec, every, offset }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
