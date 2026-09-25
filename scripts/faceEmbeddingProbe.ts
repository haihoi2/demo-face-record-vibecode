#!/usr/bin/env -S npx tsx
/**
 * Face engine probe — the go/no-go harness for real-world camera geometry.
 *
 *   npx tsx scripts/faceEmbeddingProbe.ts <image> [image...] [--dump <dir>]
 *
 * Prints, for every image:
 *   - how many faces the SCRFD detector found, each one's confidence, the box
 *     size in ORIGINAL pixels, the blur metric and the quality gate;
 * and then the full cosine-similarity matrix between the best face of each
 * image, so you can read same-person vs different-person separation directly.
 *
 * `--dump <dir>` additionally writes each aligned 112x112 crop as a PNG, so a
 * human can confirm the detector is landing on faces and not on hi-vis vests.
 *
 * Environment: FACE_MODEL_DIR (default /app/models), FACE_DETECT_THRESHOLD,
 * FACE_DETECT_SIZE, FFMPEG_PATH — see src/server/faceEmbedding.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  detectFaces,
  embedFace,
  alignFace,
  loadImage,
  faceQuality,
  facePose,
  clearFaceIssue,
  cosineSimilarity,
  getFaceEngineInfo,
  getFaceEngine,
  type RgbImage,
  type ExtractedFace,
} from "../src/server/faceEmbedding.ts";

interface Row {
  file: string;
  imageSize: string;
  faces: ExtractedFace[];
  /** ffmpeg decode to native-resolution RGB. */
  decodeMs: number;
  /** letterbox + SCRFD forward + post-processing. */
  detectMs: number;
  /** align + ArcFace forward, summed over the faces in the frame. */
  embedMs: number;
}

function pad(s: string, n: number, right = false): string {
  const str = String(s);
  if (str.length >= n) return str;
  return right ? str + " ".repeat(n - str.length) : " ".repeat(n - str.length) + str;
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => pad(c ?? "", widths[i], i === 0)).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(headers), sep, ...rows.map(line)].join("\n");
}

/** Write a raw RGB image out as a PNG through ffmpeg (no image library needed). */
async function writePng(img: RgbImage, outPath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", `${img.width}x${img.height}`,
        "-i", "pipe:0",
        "-frames:v", "1", "-y", outPath,
      ],
      { stdio: ["pipe", "ignore", "inherit"] },
    );
    child.on("close", () => resolve());
    child.on("error", () => resolve());
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(img.data));
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const files: string[] = [];
  let dumpDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dump") {
      dumpDir = argv[++i] ?? null;
      continue;
    }
    files.push(argv[i]);
  }
  if (files.length === 0) {
    console.error("usage: npx tsx scripts/faceEmbeddingProbe.ts <image> [image...] [--dump <dir>]");
    process.exit(2);
  }
  if (dumpDir) fs.mkdirSync(dumpDir, { recursive: true });

  const info = getFaceEngineInfo();
  console.log(`model dir       : ${info.modelDir}`);
  console.log(`detector        : ${info.detectorModel} @ ${info.detectorInputSize}px, thr=${info.detectThreshold}, nms=${info.nmsIou}`);
  console.log(`recognizer      : ${info.recognizerModel} -> ${info.embeddingDim}-D`);

  const t0 = Date.now();
  const engine = await getFaceEngine();
  if (!engine) {
    console.error(`\nENGINE NOT AVAILABLE: ${getFaceEngineInfo().lastError}`);
    process.exit(1);
  }
  console.log(`session load    : ${Date.now() - t0} ms\n`);

  // Warm-up pass so the reported latencies are warm, not cold (the first ONNX
  // run in a process pays arena allocation + kernel JIT and is ~3x the steady
  // state — reporting that would flatter nobody).
  {
    const warm = await loadImage(fs.readFileSync(files[0]));
    if (warm) {
      const f = await detectFaces(warm);
      if (f[0]) {
        const a = alignFace(warm, f[0].landmarks);
        if (a) await embedFace(a);
      }
    }
  }

  const rows: Row[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.error(`skip (missing): ${file}`);
      continue;
    }
    const buf = fs.readFileSync(file);

    const t0 = Date.now();
    const img = await loadImage(buf);
    const decodeMs = Date.now() - t0;
    if (!img) {
      console.error(`skip (decode failed): ${file}`);
      continue;
    }

    const t1 = Date.now();
    const boxes = await detectFaces(img);
    const detectMs = Date.now() - t1;

    const t2 = Date.now();
    const faces: ExtractedFace[] = [];
    for (let i = 0; i < boxes.length; i++) {
      const aligned = alignFace(img, boxes[i].landmarks);
      if (!aligned) continue;
      const embedding = await embedFace(aligned);
      if (!embedding) continue;
      const boxSize = Math.min(boxes[i].box[2] - boxes[i].box[0], boxes[i].box[3] - boxes[i].box[1]);
      const { quality, sharpness } = faceQuality(aligned, boxSize);
      const pose = facePose(boxes[i].landmarks);
      const issue = clearFaceIssue(pose);
      faces.push({ ...boxes[i], embedding, quality, sharpness, boxSize, pose, clear: issue === null, ...(issue ? { unclearReason: issue } : {}) });
      if (dumpDir) {
        await writePng(
          aligned,
          path.join(dumpDir, `${path.basename(file, path.extname(file))}_face${i}.png`),
        );
      }
    }
    const embedMs = Date.now() - t2;

    rows.push({
      file: path.basename(file),
      imageSize: `${img.width}x${img.height}`,
      faces,
      decodeMs,
      detectMs,
      embedMs,
    });
  }

  // ---- detection table -----------------------------------------------------
  const detRows: string[][] = [];
  for (const r of rows) {
    const timing = [`${r.decodeMs}`, `${r.detectMs}`, `${r.embedMs}`];
    if (r.faces.length === 0) {
      detRows.push([r.file, r.imageSize, "0", "-", "-", "-", "-", "-", ...timing]);
      continue;
    }
    r.faces.forEach((f, i) => {
      const w = Math.round(f.box[2] - f.box[0]);
      const h = Math.round(f.box[3] - f.box[1]);
      detRows.push([
        i === 0 ? r.file : "",
        i === 0 ? r.imageSize : "",
        i === 0 ? String(r.faces.length) : "",
        `#${i}`,
        f.score.toFixed(3),
        `${w}x${h}`,
        f.sharpness.toFixed(1),
        f.quality.toFixed(3),
        ...(i === 0 ? timing : ["", "", ""]),
      ]);
    });
  }
  console.log("DETECTION");
  console.log(
    table(
      ["file", "image", "n", "face", "score", "box px", "sharp", "qual", "dec ms", "det ms", "emb ms"],
      detRows,
    ),
  );

  // ---- cosine matrix -------------------------------------------------------
  const labelled = rows
    .filter((r) => r.faces.length > 0)
    .map((r) => ({ label: r.file, emb: r.faces[0].embedding }));
  if (labelled.length >= 2) {
    console.log("\nCOSINE SIMILARITY (largest-score face per frame)");
    const headers = [""].concat(labelled.map((l) => l.label.replace(/\.[^.]+$/, "")));
    const matrix = labelled.map((a) => [
      a.label.replace(/\.[^.]+$/, ""),
      ...labelled.map((b) => cosineSimilarity(a.emb, b.emb).toFixed(3)),
    ]);
    console.log(table(headers, matrix));
  }

  // ---- all-faces matrix (useful when a frame holds >1 person) --------------
  const all: Array<{ label: string; emb: Float32Array }> = [];
  for (const r of rows) {
    r.faces.forEach((f, i) => {
      all.push({ label: `${r.file.replace(/\.[^.]+$/, "")}#${i}`, emb: f.embedding });
    });
  }
  if (all.length > labelled.length && all.length <= 24) {
    console.log("\nCOSINE SIMILARITY (every detected face)");
    const headers = [""].concat(all.map((l) => l.label));
    const matrix = all.map((a) => [a.label, ...all.map((b) => cosineSimilarity(a.emb, b.emb).toFixed(3))]);
    console.log(table(headers, matrix));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
