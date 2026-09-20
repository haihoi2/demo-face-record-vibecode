/**
 * Unit tests for the real face engine (src/server/faceEmbedding.ts).
 *
 * These must stay green on the plain tester image, which ships NO ONNX models
 * (they live only in the runner, copied from the `models` build stage). Every
 * case that needs inference is therefore gated on the models actually being
 * present, and cases that need `ffmpeg` are gated on the binary being on PATH.
 * Everything else — the maths, the SCRFD/NMS helpers, the header sniffing, the
 * alignment transform and the never-throw contract — runs everywhere.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  cosineSimilarity,
  l2Normalize,
  iou,
  nms,
  sniffImageSize,
  toImageBuffer,
  similarityTransform,
  alignFace,
  laplacianVariance,
  faceQuality,
  resizeArea,
  decodeToRgb,
  loadImage,
  detectFaces,
  extractFaces,
  embedFace,
  isFaceEngineReady,
  getFaceEngineInfo,
  ARCFACE_TEMPLATE,
  EMBEDDING_DIM,
  type RgbImage,
} from "../src/server/faceEmbedding.ts";

// ---------------------------------------------------------------------------
// Capability probes — decide up-front what this environment can actually run.
// ---------------------------------------------------------------------------

function hasFfmpeg(): boolean {
  try {
    const r = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], { timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function hasModels(): boolean {
  const dir = process.env.FACE_MODEL_DIR || "/app/models";
  const det = process.env.FACE_DETECTOR_MODEL || "det_10g.onnx";
  const rec = process.env.FACE_RECOGNIZER_MODEL || "w600k_r50.onnx";
  try {
    return fs.existsSync(path.join(dir, det)) && fs.existsSync(path.join(dir, rec));
  } catch {
    return false;
  }
}

const FFMPEG = hasFfmpeg();
const MODELS = hasModels();

function approx(actual: number, expected: number, eps = 1e-6): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} to be within ${eps} of ${expected}`,
  );
}

/** Deterministic pseudo-random vector so failures are reproducible. */
function pseudoVector(n: number, seed: number): Float32Array {
  const v = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    v[i] = s / 0xffffffff - 0.5;
  }
  return v;
}

/** Solid-colour RGB image, for the pure-JS geometry tests. */
function solidImage(w: number, h: number, r: number, g: number, b: number): RgbImage {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    data[i * 3] = r;
    data[i * 3 + 1] = g;
    data[i * 3 + 2] = b;
  }
  return { width: w, height: h, data };
}

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

test("cosineSimilarity: identical vectors score exactly 1", () => {
  const v = pseudoVector(512, 7);
  approx(cosineSimilarity(v, v), 1, 1e-6);
  approx(cosineSimilarity([3, 4], [3, 4]), 1, 1e-9);
});

test("cosineSimilarity: orthogonal vectors score 0", () => {
  approx(cosineSimilarity([1, 0], [0, 1]), 0, 1e-9);
  approx(cosineSimilarity([0, 0, 5, 0], [7, 0, 0, 0]), 0, 1e-9);
});

test("cosineSimilarity: opposed vectors score -1", () => {
  approx(cosineSimilarity([1, 2, 3], [-1, -2, -3]), -1, 1e-9);
});

test("cosineSimilarity: magnitude-invariant", () => {
  approx(cosineSimilarity([1, 1], [1000, 1000]), 1, 1e-9);
});

test("cosineSimilarity: result is always clamped to [-1, 1]", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const a = pseudoVector(64, seed);
    const b = pseudoVector(64, seed * 31 + 5);
    const s = cosineSimilarity(a, b);
    assert.ok(s >= -1 && s <= 1, `similarity ${s} outside [-1,1]`);
    assert.ok(Number.isFinite(s));
  }
  // Even a self-comparison of a large vector, where float error can push the
  // raw quotient just past 1, must not leak a >1 value to callers.
  const big = new Float32Array(512).fill(1e8);
  assert.ok(cosineSimilarity(big, big) <= 1);
});

test("cosineSimilarity: degenerate inputs return 0 rather than NaN", () => {
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), 0, "mismatched lengths");
  assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0, "zero magnitude");
  assert.equal(cosineSimilarity([0, 0], [0, 0]), 0);
});

// ---------------------------------------------------------------------------
// l2Normalize
// ---------------------------------------------------------------------------

test("l2Normalize: output has unit length", () => {
  const v = pseudoVector(512, 42);
  const n = l2Normalize(v);
  let norm = 0;
  for (let i = 0; i < n.length; i++) norm += n[i] * n[i];
  approx(Math.sqrt(norm), 1, 1e-6);
});

test("l2Normalize: preserves direction, so cosine is unchanged", () => {
  const a = pseudoVector(128, 3);
  const b = pseudoVector(128, 9);
  approx(cosineSimilarity(l2Normalize(a), l2Normalize(b)), cosineSimilarity(a, b), 1e-5);
});

test("l2Normalize: known vector", () => {
  const n = l2Normalize([3, 4]);
  approx(n[0], 0.6, 1e-6);
  approx(n[1], 0.8, 1e-6);
});

test("l2Normalize: a zero vector survives unchanged instead of becoming NaN", () => {
  const n = l2Normalize([0, 0, 0]);
  assert.deepEqual(Array.from(n), [0, 0, 0]);
});

test("l2Normalize: does not mutate the input", () => {
  const src = new Float32Array([3, 4]);
  l2Normalize(src);
  assert.deepEqual(Array.from(src), [3, 4]);
});

// ---------------------------------------------------------------------------
// IoU / NMS
// ---------------------------------------------------------------------------

test("iou: identical boxes overlap fully", () => {
  approx(iou([0, 0, 10, 10], [0, 0, 10, 10]), 1, 1e-9);
});

test("iou: disjoint boxes score 0", () => {
  approx(iou([0, 0, 10, 10], [20, 20, 30, 30]), 0, 1e-9);
  approx(iou([0, 0, 10, 10], [10, 0, 20, 10]), 0, 1e-9);
});

test("iou: hand-computed partial overlap", () => {
  // Two 10x10 boxes offset by 5 in x: intersection 5x10 = 50, union 200-50 = 150.
  approx(iou([0, 0, 10, 10], [5, 0, 15, 10]), 50 / 150, 1e-9);
  // Offset by 5 in both axes: intersection 25, union 200-25 = 175.
  approx(iou([0, 0, 10, 10], [5, 5, 15, 15]), 25 / 175, 1e-9);
});

test("iou: a box fully inside another", () => {
  // 100 area vs 400 area, intersection 100 -> 100/400.
  approx(iou([0, 0, 20, 20], [5, 5, 15, 15]), 100 / 400, 1e-9);
});

test("nms: suppresses the lower-scoring of two overlapping boxes", () => {
  const boxes = [
    [0, 0, 10, 10],
    [1, 1, 11, 11], // IoU with #0 ~= 0.68, well above 0.4
  ];
  const keep = nms(boxes, [0.6, 0.9], 0.4);
  assert.deepEqual(keep, [1], "only the 0.9-scoring box survives");
});

test("nms: keeps boxes that do not overlap enough", () => {
  const boxes = [
    [0, 0, 10, 10],
    [100, 100, 110, 110],
    [5, 0, 15, 10], // IoU 0.33 with #0, below the 0.4 threshold
  ];
  const keep = nms(boxes, [0.9, 0.8, 0.7], 0.4);
  assert.deepEqual(keep.slice().sort(), [0, 1, 2]);
});

test("nms: returns survivors highest-score first", () => {
  const boxes = [
    [0, 0, 10, 10],
    [100, 100, 110, 110],
    [200, 200, 210, 210],
  ];
  assert.deepEqual(nms(boxes, [0.1, 0.9, 0.5], 0.4), [1, 2, 0]);
});

test("nms: empty input yields no survivors", () => {
  assert.deepEqual(nms([], [], 0.4), []);
});

test("nms: a tighter IoU threshold suppresses less", () => {
  const boxes = [
    [0, 0, 10, 10],
    [5, 0, 15, 10], // IoU 0.333
  ];
  assert.deepEqual(nms(boxes, [0.9, 0.8], 0.2), [0], "0.333 > 0.2, suppressed");
  assert.equal(nms(boxes, [0.9, 0.8], 0.5).length, 2, "0.333 < 0.5, both kept");
});

// ---------------------------------------------------------------------------
// Input handling / header sniffing
// ---------------------------------------------------------------------------

test("toImageBuffer: strips a data: URL prefix", () => {
  const payload = Buffer.from([1, 2, 3, 4]);
  const url = `data:image/jpeg;base64,${payload.toString("base64")}`;
  assert.deepEqual(Array.from(toImageBuffer(url)!), [1, 2, 3, 4]);
});

test("toImageBuffer: accepts a bare base64 string and a Buffer", () => {
  assert.deepEqual(Array.from(toImageBuffer(Buffer.from([9, 9]))!), [9, 9]);
  assert.deepEqual(Array.from(toImageBuffer(Buffer.from([7]).toString("base64"))!), [7]);
});

test("toImageBuffer: empty inputs return null", () => {
  assert.equal(toImageBuffer(""), null);
  assert.equal(toImageBuffer(Buffer.alloc(0)), null);
  assert.equal(toImageBuffer("data:image/jpeg;base64,"), null);
});

test("sniffImageSize: reads PNG IHDR dimensions", () => {
  const buf = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(1920, 16);
  buf.writeUInt32BE(1080, 20);
  assert.deepEqual(sniffImageSize(buf), { width: 1920, height: 1080 });
});

test("sniffImageSize: reads JPEG SOF0 dimensions past an APP0 segment", () => {
  // SOI, APP0 (len 16), SOF0 (len 17: precision, h, w, ncomp, ...)
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from("JFIF\0", "latin1"),
    Buffer.alloc(9),
  ]);
  const sof0 = Buffer.alloc(4 + 15);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(17, 2);
  sof0[4] = 8; // precision
  sof0.writeUInt16BE(1080, 5); // height
  sof0.writeUInt16BE(1920, 7); // width
  const buf = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0, Buffer.alloc(16)]);
  assert.deepEqual(sniffImageSize(buf), { width: 1920, height: 1080 });
});

test("sniffImageSize: progressive JPEG (SOF2) is also recognised", () => {
  const sof2 = Buffer.alloc(4 + 15);
  sof2[0] = 0xff;
  sof2[1] = 0xc2;
  sof2.writeUInt16BE(17, 2);
  sof2[4] = 8;
  sof2.writeUInt16BE(480, 5);
  sof2.writeUInt16BE(640, 7);
  const buf = Buffer.concat([Buffer.from([0xff, 0xd8]), sof2, Buffer.alloc(16)]);
  assert.deepEqual(sniffImageSize(buf), { width: 640, height: 480 });
});

test("sniffImageSize: garbage and truncated buffers return null", () => {
  assert.equal(sniffImageSize(Buffer.from("this is not an image at all!!")), null);
  assert.equal(sniffImageSize(Buffer.alloc(4)), null);
  assert.equal(sniffImageSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null, "EOI before any SOF");
});

// ---------------------------------------------------------------------------
// Similarity transform / alignment (pure geometry, no models needed)
// ---------------------------------------------------------------------------

test("similarityTransform: recovers a known rotation + scale + translation", () => {
  // Ground truth: scale 2, rotate 30 deg, translate (10, -5).
  const s = 2;
  const th = Math.PI / 6;
  const a = s * Math.cos(th);
  const b = s * Math.sin(th);
  const tx = 10;
  const ty = -5;
  const src: Array<[number, number]> = [[0, 0], [1, 0], [0, 1], [3, 4], [-2, 7]];
  const dst = src.map<[number, number]>((p) => [a * p[0] - b * p[1] + tx, b * p[0] + a * p[1] + ty]);
  const t = similarityTransform(src, dst)!;
  assert.ok(t);
  approx(t[0], a, 1e-6);
  approx(t[1], b, 1e-6);
  approx(t[2], tx, 1e-6);
  approx(t[3], ty, 1e-6);
});

test("similarityTransform: identity maps to identity", () => {
  const pts: Array<[number, number]> = [[0, 0], [1, 0], [0, 1], [1, 1]];
  const t = similarityTransform(pts, pts)!;
  approx(t[0], 1, 1e-9);
  approx(t[1], 0, 1e-9);
  approx(t[2], 0, 1e-9);
  approx(t[3], 0, 1e-9);
});

test("similarityTransform: degenerate point sets return null", () => {
  assert.equal(similarityTransform([[1, 1]], [[2, 2]]), null, "fewer than 2 points");
  assert.equal(
    similarityTransform([[5, 5], [5, 5], [5, 5]], ARCFACE_TEMPLATE.slice(0, 3)),
    null,
    "all source points coincident",
  );
});

test("similarityTransform: maps the template onto itself with zero residual", () => {
  const t = similarityTransform(ARCFACE_TEMPLATE, ARCFACE_TEMPLATE)!;
  for (const p of ARCFACE_TEMPLATE) {
    approx(t[0] * p[0] - t[1] * p[1] + t[2], p[0], 1e-6);
    approx(t[1] * p[0] + t[0] * p[1] + t[3], p[1], 1e-6);
  }
});

test("alignFace: produces a 112x112 RGB crop", () => {
  const img = solidImage(200, 200, 10, 20, 30);
  // Landmarks at 2x the template, offset by (20, 20).
  const lmk = ARCFACE_TEMPLATE.map<[number, number]>((p) => [p[0] * 1.5 + 20, p[1] * 1.5 + 20]);
  const out = alignFace(img, lmk)!;
  assert.ok(out);
  assert.equal(out.width, 112);
  assert.equal(out.height, 112);
  assert.equal(out.data.length, 112 * 112 * 3);
  // A solid source must stay solid through the warp.
  assert.equal(out.data[0], 10);
  assert.equal(out.data[1], 20);
  assert.equal(out.data[2], 30);
});

test("alignFace: template-positioned landmarks give an identity-ish crop", () => {
  // Build a 112x112 image with a distinctive pixel, feed the exact template as
  // landmarks, and the warp should be (near) identity.
  const img = solidImage(112, 112, 0, 0, 0);
  const mark = (60 * 112 + 50) * 3;
  img.data[mark] = 200;
  img.data[mark + 1] = 100;
  img.data[mark + 2] = 50;
  const out = alignFace(img, ARCFACE_TEMPLATE)!;
  const o = (60 * 112 + 50) * 3;
  assert.ok(out.data[o] > 150, `expected the marked pixel to survive, got ${out.data[o]}`);
});

test("alignFace: degenerate landmarks return null, not a throw", () => {
  const img = solidImage(50, 50, 0, 0, 0);
  assert.equal(alignFace(img, [[1, 1], [1, 1], [1, 1], [1, 1], [1, 1]]), null);
});

// ---------------------------------------------------------------------------
// Resizing / quality
// ---------------------------------------------------------------------------

test("resizeArea: output dimensions and byte length are exact", () => {
  const src = solidImage(100, 50, 7, 8, 9);
  const out = resizeArea(src, 20, 10);
  assert.equal(out.width, 20);
  assert.equal(out.height, 10);
  assert.equal(out.data.length, 20 * 10 * 3);
});

test("resizeArea: a solid image downscales to the same solid colour", () => {
  const src = solidImage(64, 64, 120, 130, 140);
  const out = resizeArea(src, 8, 8);
  for (let i = 0; i < out.data.length; i += 3) {
    assert.equal(out.data[i], 120);
    assert.equal(out.data[i + 1], 130);
    assert.equal(out.data[i + 2], 140);
  }
});

test("resizeArea: averages rather than point-samples (a checkerboard greys out)", () => {
  const w = 64;
  const src = solidImage(w, w, 0, 0, 0);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const v = (x + y) % 2 === 0 ? 255 : 0;
      const o = (y * w + x) * 3;
      src.data[o] = v;
      src.data[o + 1] = v;
      src.data[o + 2] = v;
    }
  }
  const out = resizeArea(src, 8, 8);
  for (let i = 0; i < out.data.length; i += 3) {
    assert.ok(
      out.data[i] > 100 && out.data[i] < 155,
      `expected a mid-grey average, got ${out.data[i]}`,
    );
  }
});

test("laplacianVariance: flat image is perfectly unsharp", () => {
  approx(laplacianVariance(solidImage(32, 32, 128, 128, 128)), 0, 1e-6);
});

test("laplacianVariance: a hard edge scores far above a flat field", () => {
  const img = solidImage(32, 32, 0, 0, 0);
  for (let y = 0; y < 32; y++) {
    for (let x = 16; x < 32; x++) {
      const o = (y * 32 + x) * 3;
      img.data[o] = 255;
      img.data[o + 1] = 255;
      img.data[o + 2] = 255;
    }
  }
  assert.ok(laplacianVariance(img) > 100, "an edge must register as sharp");
});

test("laplacianVariance: images too small to convolve score 0", () => {
  assert.equal(laplacianVariance(solidImage(2, 2, 255, 0, 0)), 0);
});

test("faceQuality: stays inside [0, 1] and rewards big sharp faces", () => {
  const flat = solidImage(112, 112, 128, 128, 128);
  const flatQ = faceQuality(flat, 100);
  assert.ok(flatQ.quality >= 0 && flatQ.quality <= 1);
  approx(flatQ.quality, 0, 1e-6);

  const sharp = solidImage(112, 112, 0, 0, 0);
  for (let y = 0; y < 112; y++) {
    for (let x = 0; x < 112; x++) {
      const v = Math.floor(x / 4) % 2 === 0 ? 255 : 0;
      const o = (y * 112 + x) * 3;
      sharp.data[o] = v;
      sharp.data[o + 1] = v;
      sharp.data[o + 2] = v;
    }
  }
  const big = faceQuality(sharp, 112);
  const small = faceQuality(sharp, 26);
  assert.ok(big.quality > small.quality, "a larger face must score higher");
  assert.ok(big.quality <= 1 && small.quality >= 0);
});

test("faceQuality: a sub-minimum face size floors the gate at 0", () => {
  const sharp = solidImage(112, 112, 0, 0, 0);
  for (let i = 0; i < sharp.data.length; i += 3) sharp.data[i] = i % 2 ? 255 : 0;
  assert.equal(faceQuality(sharp, 10).quality, 0);
});

// ---------------------------------------------------------------------------
// Engine status surface (safe with no models)
// ---------------------------------------------------------------------------

test("getFaceEngineInfo: reports a complete, non-throwing snapshot", () => {
  const info = getFaceEngineInfo();
  assert.equal(typeof info.ready, "boolean");
  assert.equal(typeof info.loading, "boolean");
  assert.equal(typeof info.modelDir, "string");
  assert.ok(info.detectorModel.endsWith(".onnx"));
  assert.ok(info.recognizerModel.endsWith(".onnx"));
  assert.equal(info.embeddingDim, EMBEDDING_DIM);
  assert.equal(info.embeddingDim, 512);
  assert.ok(info.detectorInputSize > 0);
  assert.ok(info.detectThreshold > 0 && info.detectThreshold <= 1);
  assert.ok(info.nmsIou > 0 && info.nmsIou <= 1);
});

test("isFaceEngineReady: false until a successful load", () => {
  if (!MODELS) assert.equal(isFaceEngineReady(), false);
  else assert.equal(typeof isFaceEngineReady(), "boolean");
});

// ---------------------------------------------------------------------------
// Never-throw contract on bad input (works with or without models)
// ---------------------------------------------------------------------------

test("detectFaces: garbage input yields [] instead of throwing", async () => {
  assert.deepEqual(await detectFaces(Buffer.from("this is definitely not a JPEG")), []);
  assert.deepEqual(await detectFaces(""), []);
  assert.deepEqual(await detectFaces(Buffer.alloc(0)), []);
  assert.deepEqual(await detectFaces("data:image/jpeg;base64,!!!!not base64 at all!!!!"), []);
});

test("extractFaces: garbage input yields [] instead of throwing", async () => {
  assert.deepEqual(await extractFaces(Buffer.from([0xff, 0xd8, 0x00, 0x01])), []);
  assert.deepEqual(await extractFaces("nonsense"), []);
});

test("loadImage: an unrecognised header returns null", async () => {
  assert.equal(await loadImage(Buffer.from("GIF89a-ish but not really")), null);
  assert.equal(await loadImage(""), null);
});

test("decodeToRgb: invalid target sizes return null without spawning ffmpeg", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(await decodeToRgb(jpeg, 0, 100), null);
  assert.equal(await decodeToRgb(jpeg, 100, -1), null);
  assert.equal(await decodeToRgb(jpeg, 10.5, 10), null);
  assert.equal(await decodeToRgb(Buffer.alloc(0), 10, 10), null);
});

// ---------------------------------------------------------------------------
// ffmpeg-dependent: real decoding
// ---------------------------------------------------------------------------

test("decodeToRgb: returns exactly width*height*3 bytes", async (t) => {
  if (!FFMPEG) return t.skip("ffmpeg not on PATH");
  // Synthesise a small JPEG with ffmpeg itself so the test needs no fixture file.
  const gen = spawnSync(
    process.env.FFMPEG_PATH || "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:duration=1",
      "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
    { maxBuffer: 16 * 1024 * 1024, timeout: 20000 },
  );
  assert.equal(gen.status, 0, "could not synthesise a test JPEG");
  const jpeg = gen.stdout;

  assert.deepEqual(sniffImageSize(jpeg), { width: 160, height: 120 });

  for (const [w, h] of [[160, 120], [64, 64], [17, 9]] as const) {
    const rgb = await decodeToRgb(jpeg, w, h);
    assert.ok(rgb, `decode to ${w}x${h} failed`);
    assert.equal(rgb!.length, w * h * 3, `expected ${w}*${h}*3 bytes`);
  }

  // The same JPEG delivered as a data: URL must decode identically.
  const viaUrl = await decodeToRgb(`data:image/jpeg;base64,${jpeg.toString("base64")}`, 32, 32);
  assert.equal(viaUrl!.length, 32 * 32 * 3);
});

test("loadImage: decodes at the image's own resolution", async (t) => {
  if (!FFMPEG) return t.skip("ffmpeg not on PATH");
  const gen = spawnSync(
    process.env.FFMPEG_PATH || "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=200x100:duration=1",
      "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
    { maxBuffer: 16 * 1024 * 1024, timeout: 20000 },
  );
  assert.equal(gen.status, 0);
  const img = await loadImage(gen.stdout);
  assert.ok(img);
  assert.equal(img!.width, 200);
  assert.equal(img!.height, 100);
  assert.equal(img!.data.length, 200 * 100 * 3);
});

test("decodeToRgb: a well-formed header wrapping junk fails softly", async (t) => {
  if (!FFMPEG) return t.skip("ffmpeg not on PATH");
  const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(512, 0x41)]);
  assert.equal(await decodeToRgb(fake, 32, 32), null);
});

// ---------------------------------------------------------------------------
// Model-dependent: real inference. Skipped on the plain tester image.
// ---------------------------------------------------------------------------

test("embedFace: returns a 512-D L2-normalised vector", async (t) => {
  if (!MODELS) return t.skip(`no models in ${process.env.FACE_MODEL_DIR || "/app/models"}`);
  const crop = solidImage(112, 112, 0, 0, 0);
  for (let i = 0; i < 112 * 112; i++) {
    crop.data[i * 3] = (i * 7) % 256;
    crop.data[i * 3 + 1] = (i * 13) % 256;
    crop.data[i * 3 + 2] = (i * 29) % 256;
  }
  const emb = await embedFace(crop);
  assert.ok(emb, "embedding should be produced");
  assert.equal(emb!.length, 512);
  let norm = 0;
  for (const v of emb!) norm += v * v;
  approx(Math.sqrt(norm), 1, 1e-4);
  approx(cosineSimilarity(emb!, emb!), 1, 1e-5);
});

test("embedFace: rejects a crop that is not 112x112", async (t) => {
  if (!MODELS) return t.skip("no models present");
  assert.equal(await embedFace(solidImage(64, 64, 1, 2, 3)), null);
});

test("engine: isFaceEngineReady flips true and reports a load time", async (t) => {
  if (!MODELS) return t.skip("no models present");
  await embedFace(solidImage(112, 112, 5, 5, 5));
  assert.equal(isFaceEngineReady(), true);
  const info = getFaceEngineInfo();
  assert.equal(info.ready, true);
  assert.ok(typeof info.loadTimeMs === "number" && info.loadTimeMs! >= 0);
  assert.equal(info.lastError, null);
});

test("extractFaces: a face-free frame yields [] even with models loaded", async (t) => {
  if (!MODELS || !FFMPEG) return t.skip("needs both models and ffmpeg");
  const gen = spawnSync(
    process.env.FFMPEG_PATH || "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:size=640x480:duration=1",
      "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
    { maxBuffer: 16 * 1024 * 1024, timeout: 20000 },
  );
  assert.equal(gen.status, 0);
  assert.deepEqual(await extractFaces(gen.stdout), []);
});
