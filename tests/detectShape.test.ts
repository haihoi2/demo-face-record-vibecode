/**
 * The additive detector-input option of src/server/faceEmbedding.ts
 * (DetectOptions.inputShape) and the proof that the DEFAULT path is unchanged:
 *   - letterboxForDetector(img, size) is byte-identical to the previous square-only
 *     implementation (kept here as the reference) for every upscale mode;
 *   - resolveDetectShape() without options is the FACE_DETECT_SIZE square;
 *   - detector input dims are read from the session metadata and a shape the graph
 *     cannot take is refused without a throw;
 *   - with the real models (skipped on the plain tester image): detectFaces(img) ===
 *     detectFaces(img, {inputShape: 640x640}) exactly; the FP32 detector runs at
 *     1824x224; the static INT8 export returns [] at that shape (fail closed) and the
 *     pipeline engine refuses `auto` on it.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  detectFaces,
  detectorInputDimsOf,
  detectorShapeIssue,
  getFaceEngine,
  getFaceEngineInfo,
  letterboxForDetector,
  resetFaceEngine,
  resizeArea,
  resizeBilinear,
  resolveDetectShape,
  type RgbImage,
} from "../src/server/faceEmbedding.ts";

const VARS = ["FACE_DETECT_SIZE", "FACE_DETECT_UPSCALE", "FACE_DETECTOR_VARIANT", "FACE_DETECTOR_MODEL", "PIPELINE_DETECT_INPUT", "FACE_ORT_LOG_LEVEL", "FACE_ORT_THREADS"] as const;
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetFaceEngine();
});

function hasModels(): boolean {
  const dir = process.env.FACE_MODEL_DIR || "/app/models";
  try {
    return fs.existsSync(path.join(dir, "det_10g.onnx")) && fs.existsSync(path.join(dir, "w600k_r50.onnx"));
  } catch {
    return false;
  }
}
function hasInt8(): boolean {
  return hasModels() && fs.existsSync(path.join(process.env.FACE_MODEL_DIR || "/app/models", "det_10g_int8.onnx"));
}

/** Deterministic noise image with a few high-contrast blobs (so resizing is not trivial). */
function noiseImage(w: number, h: number, seed: number): RgbImage {
  const data = new Uint8Array(w * h * 3);
  let s = seed >>> 0;
  for (let i = 0; i < data.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    data[i] = s >>> 24;
  }
  for (let y = Math.floor(h / 4); y < Math.floor(h / 2); y++) for (let x = Math.floor(w / 3); x < Math.floor(w / 2); x++) {
    const o = (y * w + x) * 3;
    data[o] = 250; data[o + 1] = 240; data[o + 2] = 230;
  }
  return { width: w, height: h, data };
}

/** The pre-2026-09-27 square-only letterbox, verbatim, as the reference. */
function legacyLetterbox(img: RgbImage, size: number, mode: "none" | "area" | "bilinear") {
  const fit = Math.min(size / img.width, size / img.height);
  const scale = fit > 1 && mode === "none" ? 1 : fit;
  const newW = Math.max(1, Math.round(img.width * scale));
  const newH = Math.max(1, Math.round(img.height * scale));
  const resized =
    newW === img.width && newH === img.height ? img : scale > 1 && mode === "bilinear" ? resizeBilinear(img, newW, newH) : resizeArea(img, newW, newH);
  const plane = size * size;
  const data = new Float32Array(3 * plane);
  data.fill((0 - 127.5) / 128.0);
  for (let y = 0; y < newH; y++) for (let x = 0; x < newW; x++) {
    const s = (y * newW + x) * 3;
    const d = y * size + x;
    data[d] = (resized.data[s] - 127.5) / 128.0;
    data[plane + d] = (resized.data[s + 1] - 127.5) / 128.0;
    data[2 * plane + d] = (resized.data[s + 2] - 127.5) / 128.0;
  }
  return { tensorData: data, size, scale: newW / img.width };
}

test("letterboxForDetector: the square default is byte-identical to the previous implementation", () => {
  for (const mode of ["none", "area", "bilinear"] as const) {
    process.env.FACE_DETECT_UPSCALE = mode;
    for (const [w, h, size] of [[3408, 456, 640], [1000, 200, 640], [341, 97, 640], [200, 300, 160], [2074, 432, 320]] as const) {
      const img = noiseImage(w, h, w * 31 + h);
      const now = letterboxForDetector(img, size);
      const ref = legacyLetterbox(img, size, mode);
      assert.equal(now.width, size);
      assert.equal(now.height, size);
      assert.equal(now.scale, ref.scale, `${mode} ${w}x${h}@${size}: scale`);
      assert.equal(now.tensorData.length, ref.tensorData.length);
      assert.ok(Buffer.from(now.tensorData.buffer).equals(Buffer.from(ref.tensorData.buffer)), `${mode} ${w}x${h}@${size}: tensor bytes differ`);
    }
  }
});

test("letterboxForDetector: a non-square canvas keeps the aspect, pads bottom/right, scale = min fit", () => {
  process.env.FACE_DETECT_UPSCALE = "none";
  const img = noiseImage(3408, 456, 5);
  const pad = (0 - 127.5) / 128.0;
  // Width-limited: 1824/3408 = 0.535 < 256/456 = 0.561 -> 244 rows of picture, 12 rows of padding, no right padding.
  const lb = letterboxForDetector(img, 1824, 256);
  assert.deepEqual([lb.width, lb.height], [1824, 256]);
  assert.ok(Math.abs(lb.scale - 1824 / 3408) < 1e-3);
  assert.equal(lb.tensorData.length, 3 * 1824 * 256);
  const newH = Math.round(456 * lb.scale);
  assert.equal(newH, 244);
  for (let c = 0; c < 3; c++) for (let x = 0; x < 1824; x += 97) {
    assert.equal(lb.tensorData[c * 1824 * 256 + (newH + 3) * 1824 + x], pad, "rows below the picture are padding");
  }
  assert.ok(lb.tensorData.subarray(0, 1824 * newH).some((v) => v !== pad), "the picture is in the top rows");
  assert.notEqual(lb.tensorData[1823], pad, "the last column of row 0 is picture, not padding");
  // Height-limited: 224/456 = 0.491 < 1824/3408 -> 1674 columns of picture, the right 150 are padding.
  const lb2 = letterboxForDetector(img, 1824, 224);
  assert.ok(Math.abs(lb2.scale - Math.round(3408 * (224 / 456)) / 3408) < 1e-6);
  const newW = Math.round(3408 * (224 / 456));
  for (let y = 0; y < 224; y += 37) assert.equal(lb2.tensorData[y * 1824 + newW + 5], pad, "columns right of the picture are padding");
  assert.notEqual(lb2.tensorData[(223) * 1824 + 10], pad, "the last row is picture");
});

test("resolveDetectShape: no options = FACE_DETECT_SIZE square; an explicit shape wins; junk falls back", () => {
  delete process.env.FACE_DETECT_SIZE;
  assert.deepEqual(resolveDetectShape(), { width: 640, height: 640 });
  assert.deepEqual(resolveDetectShape(undefined), { width: 640, height: 640 });
  assert.deepEqual(resolveDetectShape({}), { width: 640, height: 640 });
  process.env.FACE_DETECT_SIZE = "1280";
  assert.deepEqual(resolveDetectShape(), { width: 1280, height: 1280 });
  assert.deepEqual(resolveDetectShape({ inputShape: { width: 1824, height: 224 } }), { width: 1824, height: 224 });
  assert.deepEqual(resolveDetectShape({ inputShape: { width: 0, height: 224 } }), { width: 1280, height: 1280 });
  assert.deepEqual(resolveDetectShape({ inputShape: { width: 1.5, height: 224 } as any }), { width: 1280, height: 1280 });
});

test("detectorInputDimsOf: numbers are static, symbols/missing are dynamic, no metadata is null", () => {
  assert.deepEqual(detectorInputDimsOf([{ name: "input.1", shape: [1, 3, 640, 640] }]), { height: 640, width: 640 });
  assert.deepEqual(detectorInputDimsOf([{ name: "input.1", shape: [1, 3, "?", "?"] }]), { height: "dynamic", width: "dynamic" });
  assert.deepEqual(detectorInputDimsOf([{ name: "input.1", shape: ["N", 3, "h", 640] }]), { height: "dynamic", width: 640 });
  assert.equal(detectorInputDimsOf([{ name: "input.1", shape: [] }]), null);
  assert.equal(detectorInputDimsOf([]), null);
  assert.equal(detectorInputDimsOf(undefined), null);
  assert.equal(detectorInputDimsOf({ nope: 1 }), null);
});

test("detectorShapeIssue: static dims refuse any other shape, dynamic dims accept all, unknown accepts", () => {
  const st = { height: 640, width: 640 } as const;
  assert.equal(detectorShapeIssue(st, 640, 640), null);
  assert.match(detectorShapeIssue(st, 1824, 224) || "", /height 224 \(graph fixes 640\), width 1824 \(graph fixes 640\)/);
  assert.equal(detectorShapeIssue({ height: "dynamic", width: "dynamic" }, 1824, 224), null);
  assert.equal(detectorShapeIssue(null, 1824, 224), null);
  assert.equal(getFaceEngineInfo().detectorInputDims, null, "null before a load");
});

// ---- real models (skipped on the plain tester image) ----------------------------

test("detectFaces: the default call equals an explicit 640x640 call exactly; 1824x224 runs on FP32", async (t) => {
  if (!hasModels()) return t.skip(`no models in ${process.env.FACE_MODEL_DIR || "/app/models"}`);
  delete process.env.FACE_DETECT_SIZE;
  process.env.FACE_DETECTOR_VARIANT = "fp32";
  process.env.FACE_ORT_THREADS = "1";
  process.env.FACE_ORT_LOG_LEVEL = "3";
  resetFaceEngine();
  assert.ok(await getFaceEngine(), getFaceEngineInfo().lastError || "engine");
  assert.deepEqual(getFaceEngineInfo().detectorInputDims, { height: "dynamic", width: "dynamic" });
  const img = noiseImage(1704, 228, 99);
  const a = await detectFaces(img);
  const b = await detectFaces(img, { inputShape: { width: 640, height: 640 } });
  assert.deepEqual(a, b, "default path == explicit 640x640");
  const wide = await detectFaces(img, { inputShape: { width: 1824, height: 224 } });
  assert.ok(Array.isArray(wide));
  for (const f of wide) {
    assert.ok(f.box[0] >= 0 && f.box[2] <= 1704 && f.box[1] >= 0 && f.box[3] <= 228, "boxes are in frame coordinates");
    assert.equal(f.landmarks.length, 5);
  }
});

test("detectFaces: the static INT8 export refuses a non-640 shape without throwing; the pipeline engine refuses `auto` on it", async (t) => {
  if (!hasInt8()) return t.skip("no det_10g_int8.onnx");
  process.env.FACE_DETECTOR_VARIANT = "int8";
  process.env.FACE_ORT_THREADS = "1";
  delete process.env.FACE_DETECT_SIZE;
  resetFaceEngine();
  assert.ok(await getFaceEngine(), getFaceEngineInfo().lastError || "engine");
  assert.deepEqual(getFaceEngineInfo().detectorInputDims, { height: 640, width: 640 });
  const img = noiseImage(1704, 228, 7);
  assert.deepEqual(await detectFaces(img, { inputShape: { width: 1824, height: 224 } }), []);
  assert.ok(Array.isArray(await detectFaces(img)), "640 square still runs");

  process.env.PIPELINE_DETECT_INPUT = "auto";
  const mod = await import(`../src/server/pipeline/onnxEngine.ts?int8-auto-${Date.now()}`);
  assert.equal(mod.onnxPipelineEngine.ready(), false, "auto on a static graph is not ready");
  assert.match(mod.onnxPipelineEngine.error?.() || "", /dynamic input dims/);
  assert.equal(await mod.loadOnnxPipelineEngine(), false);
});
