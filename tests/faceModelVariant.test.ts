/**
 * Model-variant selection and template compatibility (src/server/faceEmbedding.ts).
 *
 * Only the DETECTOR has an INT8 variant (it met the accuracy bar); the ArcFace
 * INT8 did not, so nothing selects it and the template tag stays the FP32 one.
 * An INT8 recogniser forced through an explicit file gets its own tag, and the
 * gallery drops foreign tags, so FP32 and INT8 embeddings never mix silently.
 * A selected variant that cannot load fails closed (no fallback).
 * Runs without models: model loads here point at temp dirs.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseFaceModelVariant,
  faceModelTagFor,
  getFaceEngineInfo,
  getFaceEngine,
  isFaceEngineReady,
  resetFaceEngine,
  extractFaces,
  FACE_DETECTOR_FILES,
  FACE_RECOGNIZER_FILE,
  detectUpscaleMode,
  DEFAULT_DETECT_UPSCALE,
  resizeBilinear,
} from "../src/server/faceEmbedding.ts";
import { buildGallery } from "../src/server/faceFusion.ts";
import type { FaceTemplate } from "../src/types.ts";

const VARS = [
  "FACE_MODEL_VARIANT",
  "FACE_DETECTOR_VARIANT",
  "FACE_RECOGNIZER_VARIANT",
  "FACE_DETECTOR_MODEL",
  "FACE_RECOGNIZER_MODEL",
  "FACE_MODEL_DIR",
  "FACE_DETECT_UPSCALE",
] as const;
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
function setEnv(vars: Partial<Record<(typeof VARS)[number], string>>) {
  for (const k of VARS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  resetFaceEngine();
}
afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetFaceEngine();
});

test("parseFaceModelVariant: blank/unknown mean fp32, case and spaces are ignored", () => {
  assert.deepEqual(parseFaceModelVariant(undefined), { variant: "fp32" });
  assert.deepEqual(parseFaceModelVariant(null), { variant: "fp32" });
  assert.deepEqual(parseFaceModelVariant(""), { variant: "fp32" });
  assert.deepEqual(parseFaceModelVariant("   "), { variant: "fp32" });
  assert.deepEqual(parseFaceModelVariant("fp32"), { variant: "fp32" });
  assert.deepEqual(parseFaceModelVariant("int8"), { variant: "int8" });
  assert.deepEqual(parseFaceModelVariant(" INT8 "), { variant: "int8" });
  assert.deepEqual(parseFaceModelVariant("int4"), { variant: "fp32", invalid: "int4" });
  assert.deepEqual(parseFaceModelVariant("openvino"), { variant: "fp32", invalid: "openvino" });
});

test("faceModelTagFor: FP32 tag is unchanged so existing templates stay usable", () => {
  // Byte-identical to server.ts faceModelTag() for the shipped model.
  assert.equal(faceModelTagFor("w600k_r50.onnx"), "arcface_w600k_r50");
  assert.equal(faceModelTagFor(FACE_RECOGNIZER_FILE), "arcface_w600k_r50");
  assert.equal(faceModelTagFor("w600k_r50_int8.onnx"), "arcface_w600k_r50_int8");
  assert.equal(faceModelTagFor(""), "arcface_unknown");
});

test("engine info: default is fp32 with the legacy tag and no warning", () => {
  setEnv({});
  const info = getFaceEngineInfo();
  assert.equal(info.detectorModel, "det_10g.onnx");
  assert.equal(info.recognizerModel, "w600k_r50.onnx");
  assert.equal(info.detectorVariant, "fp32");
  assert.equal(info.recognizerVariant, "fp32");
  assert.equal(info.modelTag, "arcface_w600k_r50");
  assert.equal(info.variantWarning, null);
});

test("engine info: FACE_DETECTOR_VARIANT=int8 swaps only the detector; the tag stays FP32", () => {
  setEnv({ FACE_DETECTOR_VARIANT: " Int8 " });
  const info = getFaceEngineInfo();
  assert.equal(info.detectorModel, FACE_DETECTOR_FILES.int8);
  assert.equal(info.detectorModel, "det_10g_int8.onnx");
  assert.equal(info.detectorVariant, "int8");
  assert.equal(info.recognizerModel, "w600k_r50.onnx");
  assert.equal(info.recognizerVariant, "fp32");
  assert.equal(info.modelTag, "arcface_w600k_r50", "detector variant does not change the embedding space");
  assert.equal(info.variantWarning, null);
});

test("engine info: an INT8 recogniser cannot be selected by variant, and the attempt is reported", () => {
  for (const vars of [{ FACE_MODEL_VARIANT: "int8" }, { FACE_RECOGNIZER_VARIANT: "int8" }]) {
    setEnv(vars);
    const info = getFaceEngineInfo();
    assert.equal(info.recognizerModel, "w600k_r50.onnx");
    assert.equal(info.modelTag, "arcface_w600k_r50");
    assert.equal(info.detectorModel, "det_10g.onnx", "FACE_MODEL_VARIANT is not an alias for the detector either");
    assert.match(info.variantWarning ?? "", /ignored, the recogniser runs fp32 only/);
  }
  setEnv({ FACE_MODEL_VARIANT: "fp32" });
  assert.equal(getFaceEngineInfo().variantWarning, null, "asking for fp32 is not worth a warning");
});

test("engine info: an unknown detector variant uses fp32 and says so", () => {
  setEnv({ FACE_DETECTOR_VARIANT: "fp16" });
  const info = getFaceEngineInfo();
  assert.equal(info.detectorModel, "det_10g.onnx");
  assert.match(info.variantWarning ?? "", /FACE_DETECTOR_VARIANT: unknown value, using fp32/);
});

test("engine info: explicit model files win and an INT8 recogniser file gets its own tag", () => {
  setEnv({ FACE_DETECTOR_VARIANT: "int8", FACE_DETECTOR_MODEL: "custom_det.onnx", FACE_RECOGNIZER_MODEL: "w600k_r50_int8.onnx" });
  const info = getFaceEngineInfo();
  assert.equal(info.detectorModel, "custom_det.onnx");
  assert.equal(info.detectorVariant, "custom");
  assert.equal(info.recognizerModel, "w600k_r50_int8.onnx");
  assert.equal(info.recognizerVariant, "custom");
  assert.equal(info.modelTag, "arcface_w600k_r50_int8");
});

test("model mismatch: a gallery for one tag never includes templates of another", () => {
  const tpl = (id: string, employeeId: string, modelTag: string): FaceTemplate =>
    ({ id, employeeId, embedding: [1, 0, 0], dims: 3, modelTag } as unknown as FaceTemplate);
  const fp32Tag = faceModelTagFor(FACE_RECOGNIZER_FILE);
  const int8Tag = faceModelTagFor("w600k_r50_int8.onnx");
  const templates = [tpl("a", "E1", fp32Tag), tpl("b", "E1", int8Tag), tpl("c", "E2", fp32Tag)];
  const int8 = buildGallery(templates, int8Tag);
  assert.deepEqual([...int8.keys()], ["E1"]);
  assert.equal(int8.get("E1")!.length, 1);
  const fp32 = buildGallery(templates, fp32Tag);
  assert.deepEqual([...fp32.keys()].sort(), ["E1", "E2"]);
  assert.equal(fp32.get("E1")!.length, 1);
});

test("fail closed: INT8 detector selected but missing -> no engine, no FP32 fallback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "facevariant-"));
  try {
    // The FP32 detector is present (as a placeholder) - it must NOT be picked up instead.
    fs.writeFileSync(path.join(dir, "det_10g.onnx"), "placeholder");
    fs.writeFileSync(path.join(dir, "w600k_r50.onnx"), "placeholder");
    setEnv({ FACE_MODEL_DIR: dir, FACE_DETECTOR_VARIANT: "int8" });
    assert.equal(await getFaceEngine(), null);
    assert.equal(isFaceEngineReady(), false);
    const info = getFaceEngineInfo();
    assert.equal(info.ready, false);
    assert.match(info.lastError ?? "", /model file missing: .*det_10g_int8\.onnx/);
    assert.equal(info.detectorModel, "det_10g_int8.onnx", "status keeps reporting the selected variant");
    assert.deepEqual(await extractFaces(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fail closed: a corrupted model file -> no engine, error recorded, no throw", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "facevariant-"));
  try {
    fs.writeFileSync(path.join(dir, "det_10g_int8.onnx"), Buffer.from("this is not an onnx protobuf"));
    fs.writeFileSync(path.join(dir, "w600k_r50.onnx"), Buffer.alloc(64, 0xff));
    setEnv({ FACE_MODEL_DIR: dir, FACE_DETECTOR_VARIANT: "int8" });
    assert.equal(await getFaceEngine(), null);
    assert.equal(isFaceEngineReady(), false);
    assert.ok((getFaceEngineInfo().lastError ?? "").length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Detector letterbox for pictures smaller than the input (stored face crops)
// ---------------------------------------------------------------------------

test("detectUpscaleMode: default and accepted values", () => {
  // Crops must not be blown up with blocky steps before detection (93% vs 84% re-found).
  const DEFAULT_UPSCALE = "none";
  assert.equal(DEFAULT_DETECT_UPSCALE, DEFAULT_UPSCALE);
  setEnv({});
  assert.equal(detectUpscaleMode(), DEFAULT_UPSCALE);
  assert.equal(getFaceEngineInfo().detectUpscale, DEFAULT_UPSCALE);
  for (const [raw, want] of [["none", "none"], [" Bilinear ", "bilinear"], ["AREA", "area"], ["", DEFAULT_UPSCALE], ["lanczos", DEFAULT_UPSCALE]] as const) {
    process.env.FACE_DETECT_UPSCALE = raw;
    assert.equal(detectUpscaleMode(), want, `FACE_DETECT_UPSCALE=${JSON.stringify(raw)}`);
  }
});

test("resizeBilinear: exact size, flat channels stay flat, gradients stay monotonic", () => {
  const w = 4;
  const h = 2;
  const src = { width: w, height: h, data: new Uint8Array(w * h * 3) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) src.data.set([x * 80, 50, 200], (y * w + x) * 3);
  const up = resizeBilinear(src, 10, 5);
  assert.equal(up.width, 10);
  assert.equal(up.height, 5);
  assert.equal(up.data.length, 10 * 5 * 3);
  let prev = -1;
  for (let x = 0; x < 10; x++) {
    const r = up.data[(2 * 10 + x) * 3];
    assert.ok(r >= prev, "red ramps up left to right without steps backwards");
    prev = r;
    assert.equal(up.data[(2 * 10 + x) * 3 + 1], 50);
    assert.equal(up.data[(2 * 10 + x) * 3 + 2], 200);
  }
  assert.equal(up.data[0], 0, "edge clamps to the first pixel");
  assert.equal(up.data[(2 * 10 + 9) * 3], 240, "edge clamps to the last pixel");
});
