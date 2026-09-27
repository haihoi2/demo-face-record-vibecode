/**
 * Pipeline recogniser selection (PIPELINE_RECOGNIZER_MODEL / _VARIANT) and its
 * template-tag consequences (src/server/faceEmbedding.ts, gatePipeline.ts,
 * faceFusion.ts). Structure rule: the legacy door engine and its
 * arcface_w600k_r50 templates are untouched; the pipeline workers may run a
 * cheaper recogniser under their own tag, and embeddings never cross tags.
 * Runs without models.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  FACE_DETECTOR_FILES,
  FACE_RECOGNIZER_FILE,
  PIPELINE_RECOGNIZER_FILES,
  PIPELINE_RECOGNIZER_VARIANTS,
  faceModelTagFor,
  getFaceEngineInfo,
  pipelineRecognizerVariantOf,
  resetFaceEngine,
  resolvePipelineRecognizer,
} from "../src/server/faceEmbedding.ts";
import { pipelineWorkerEnv } from "../src/server/pipeline/gatePipeline.ts";
import { GateTrackSession, type DecisionContext } from "../src/server/pipeline/trackDecision.ts";
import { DEFAULT_FUSION_THRESHOLDS, PIPELINE_FUSION_THRESHOLDS_BY_TAG, buildGallery, pipelineFusionThresholds } from "../src/server/faceFusion.ts";
import type { FaceTemplate } from "../src/types.ts";

const LEGACY_TAG = "arcface_w600k_r50";
const VARS = ["PIPELINE_RECOGNIZER_MODEL", "PIPELINE_RECOGNIZER_VARIANT", "FACE_RECOGNIZER_MODEL", "FACE_DETECTOR_VARIANT", "FACE_MODEL_DIR"] as const;
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetFaceEngine();
});

// ---------------------------------------------------------------- selection

test("default (no PIPELINE_RECOGNIZER_*): the worker inherits the legacy recogniser and tag, no warning", () => {
  const sel = resolvePipelineRecognizer({});
  assert.deepEqual(sel, { file: "w600k_r50.onnx", modelTag: LEGACY_TAG, variant: "r50", source: "default", warning: null });
  // A legacy explicit file is inherited as-is (that is today's behaviour for the worker).
  const custom = resolvePipelineRecognizer({ FACE_RECOGNIZER_MODEL: "my_r50_copy.onnx" });
  assert.equal(custom.file, "my_r50_copy.onnx");
  assert.equal(custom.modelTag, "arcface_my_r50_copy");
  assert.equal(custom.source, "default");
  assert.equal(custom.variant, "custom");
});

test("blank values are the default too", () => {
  for (const env of [{ PIPELINE_RECOGNIZER_VARIANT: "" }, { PIPELINE_RECOGNIZER_VARIANT: "   " }, { PIPELINE_RECOGNIZER_MODEL: "" }, { PIPELINE_RECOGNIZER_MODEL: " " }]) {
    const sel = resolvePipelineRecognizer(env);
    assert.equal(sel.source, "default", JSON.stringify(env));
    assert.equal(sel.file, FACE_RECOGNIZER_FILE);
    assert.equal(sel.warning, null);
  }
});

test("PIPELINE_RECOGNIZER_VARIANT=mbf selects w600k_mbf.onnx with its own tag", () => {
  for (const raw of ["mbf", " MBF ", "Mbf"]) {
    const sel = resolvePipelineRecognizer({ PIPELINE_RECOGNIZER_VARIANT: raw });
    assert.equal(sel.file, "w600k_mbf.onnx");
    assert.equal(sel.modelTag, "arcface_w600k_mbf");
    assert.equal(sel.variant, "mbf");
    assert.equal(sel.source, "PIPELINE_RECOGNIZER_VARIANT");
    assert.equal(sel.warning, null);
  }
  assert.notEqual(resolvePipelineRecognizer({ PIPELINE_RECOGNIZER_VARIANT: "mbf" }).modelTag, LEGACY_TAG, "a different model must never share the legacy tag");
  const r50 = resolvePipelineRecognizer({ PIPELINE_RECOGNIZER_VARIANT: "r50" });
  assert.equal(r50.file, "w600k_r50.onnx");
  assert.equal(r50.modelTag, LEGACY_TAG);
  assert.equal(r50.source, "PIPELINE_RECOGNIZER_VARIANT");
});

test("an unknown variant is ignored with a warning (never a silent pick)", () => {
  const sel = resolvePipelineRecognizer({ PIPELINE_RECOGNIZER_VARIANT: "r18" });
  assert.equal(sel.file, FACE_RECOGNIZER_FILE);
  assert.equal(sel.modelTag, LEGACY_TAG);
  assert.equal(sel.source, "default");
  assert.match(sel.warning ?? "", /PIPELINE_RECOGNIZER_VARIANT: unknown value "r18"/);
  assert.match(sel.warning ?? "", /known: r50, mbf/);
  // Over-long junk is truncated in the warning and still rejected.
  const long = resolvePipelineRecognizer({ PIPELINE_RECOGNIZER_VARIANT: "x".repeat(200) });
  assert.equal(long.source, "default");
  assert.ok((long.warning ?? "").length < 200);
});

test("PIPELINE_RECOGNIZER_MODEL selects an explicit file (own tag) and wins over the variant", () => {
  const sel = resolvePipelineRecognizer({ PIPELINE_RECOGNIZER_MODEL: "w600k_r50_q.onnx", PIPELINE_RECOGNIZER_VARIANT: "mbf" });
  assert.equal(sel.file, "w600k_r50_q.onnx");
  assert.equal(sel.modelTag, "arcface_w600k_r50_q");
  assert.equal(sel.variant, "custom");
  assert.equal(sel.source, "PIPELINE_RECOGNIZER_MODEL");
  assert.equal(sel.warning, null);
  // A known file name given explicitly is recognised as its variant.
  assert.equal(resolvePipelineRecognizer({ PIPELINE_RECOGNIZER_MODEL: "w600k_mbf.onnx" }).variant, "mbf");
});

test("unsafe explicit file names (paths, traversal, hidden, wrong suffix) are refused with a warning", () => {
  for (const bad of ["../w600k_mbf.onnx", "sub/w600k_mbf.onnx", "/models/w600k_mbf.onnx", ".hidden.onnx", "w600k_mbf.onnx.bak", "w600k_mbf", "a..b.onnx", "w600k mbf.onnx", "x".repeat(200) + ".onnx"]) {
    const sel = resolvePipelineRecognizer({ PIPELINE_RECOGNIZER_MODEL: bad });
    assert.equal(sel.file, FACE_RECOGNIZER_FILE, bad);
    assert.equal(sel.source, "default", bad);
    assert.match(sel.warning ?? "", /PIPELINE_RECOGNIZER_MODEL: not a plain \.onnx file name/, bad);
  }
});

test("variant table is consistent with the tag function", () => {
  assert.deepEqual([...PIPELINE_RECOGNIZER_VARIANTS], ["r50", "mbf"]);
  assert.equal(PIPELINE_RECOGNIZER_FILES.r50, FACE_RECOGNIZER_FILE);
  for (const v of PIPELINE_RECOGNIZER_VARIANTS) {
    assert.equal(pipelineRecognizerVariantOf(PIPELINE_RECOGNIZER_FILES[v]), v);
    assert.equal(faceModelTagFor(PIPELINE_RECOGNIZER_FILES[v]), `arcface_${PIPELINE_RECOGNIZER_FILES[v].replace(/\.onnx$/, "")}`);
  }
  assert.equal(pipelineRecognizerVariantOf("something_else.onnx"), "custom");
});

// ---------------------------------------------------------------- worker env

test("pipelineWorkerEnv: without PIPELINE_RECOGNIZER_* the worker env is exactly today's", () => {
  const env = { FACE_MODEL_DIR: "/models", FACE_ORT_THREADS: "2", FACE_RECOGNIZER_MODEL: "w600k_r50.onnx", PIPELINE_DETECTOR_VARIANT: "int8" };
  const out = pipelineWorkerEnv(env);
  assert.equal(out.FACE_RECOGNIZER_MODEL, "w600k_r50.onnx");
  assert.deepEqual(out, { ...env, FACE_DETECTOR_VARIANT: "int8" });
  assert.equal(pipelineWorkerEnv({}).FACE_RECOGNIZER_MODEL, undefined, "nothing is invented when nothing is set");
});

test("pipelineWorkerEnv: the variant/model maps onto FACE_RECOGNIZER_MODEL for the worker only", () => {
  assert.equal(pipelineWorkerEnv({ PIPELINE_RECOGNIZER_VARIANT: "mbf" }).FACE_RECOGNIZER_MODEL, "w600k_mbf.onnx");
  assert.equal(pipelineWorkerEnv({ FACE_RECOGNIZER_MODEL: "w600k_r50.onnx", PIPELINE_RECOGNIZER_VARIANT: "mbf" }).FACE_RECOGNIZER_MODEL, "w600k_mbf.onnx");
  assert.equal(pipelineWorkerEnv({ PIPELINE_RECOGNIZER_MODEL: "w600k_r50_q.onnx" }).FACE_RECOGNIZER_MODEL, "w600k_r50_q.onnx");
  assert.equal(pipelineWorkerEnv({ FACE_RECOGNIZER_MODEL: "w600k_r50.onnx", PIPELINE_RECOGNIZER_VARIANT: "nope" }).FACE_RECOGNIZER_MODEL, "w600k_r50.onnx", "invalid: the FACE_* value stays");
  assert.equal(pipelineWorkerEnv({ PIPELINE_RECOGNIZER_MODEL: "../x.onnx" }).FACE_RECOGNIZER_MODEL, undefined, "unsafe: nothing set");
  const env = { PIPELINE_RECOGNIZER_VARIANT: "mbf" };
  pipelineWorkerEnv(env);
  assert.deepEqual(env, { PIPELINE_RECOGNIZER_VARIANT: "mbf" }, "the caller's environment is not mutated");
});

// ---------------------------------------------------------------- legacy untouched

test("legacy engine: PIPELINE_RECOGNIZER_* in the main process changes neither its files nor its tag", () => {
  for (const k of VARS) delete process.env[k];
  process.env.PIPELINE_RECOGNIZER_VARIANT = "mbf";
  process.env.PIPELINE_RECOGNIZER_MODEL = "w600k_mbf.onnx";
  resetFaceEngine();
  const info = getFaceEngineInfo();
  assert.equal(info.recognizerModel, "w600k_r50.onnx");
  assert.equal(info.detectorModel, "det_10g.onnx");
  assert.equal(info.modelTag, LEGACY_TAG);
  assert.equal(info.recognizerVariant, "fp32");
  assert.equal(info.variantWarning, null);
  // The door engine's shipped files are the same constants as before this change.
  assert.equal(FACE_RECOGNIZER_FILE, "w600k_r50.onnx");
  assert.deepEqual(FACE_DETECTOR_FILES, { fp32: "det_10g.onnx", int8: "det_10g_int8.onnx" });
  assert.equal(faceModelTagFor(FACE_RECOGNIZER_FILE), LEGACY_TAG);
});

// ---------------------------------------------------------------- tags never mix

function template(employeeId: string, modelTag: string, id = `${employeeId}-${modelTag}`): FaceTemplate {
  const embedding = new Array(512).fill(0);
  embedding[0] = 1;
  return { id, employeeId, embedding, dims: 512, modelTag, source: "enrollment", quality: 0.9, capturedAt: "2026-09-27T00:00:00.000Z" };
}

test("buildGallery for the pipeline tag holds only that tag's templates", () => {
  const templates = [template("E1", LEGACY_TAG), template("E1", "arcface_w600k_mbf"), template("E2", LEGACY_TAG)];
  const mbf = buildGallery(templates, "arcface_w600k_mbf");
  assert.deepEqual([...mbf.keys()], ["E1"]);
  assert.equal(mbf.get("E1")!.length, 1);
  const r50 = buildGallery(templates, LEGACY_TAG);
  assert.deepEqual([...r50.keys()].sort(), ["E1", "E2"]);
});

test("a worker running mbf refuses a context built for the r50 tag (fail closed), and accepts its own", () => {
  const legacyContext: DecisionContext = {
    gallery: buildGallery([template("E1", LEGACY_TAG)], LEGACY_TAG),
    galleryModelTag: LEGACY_TAG,
    engineModelTag: LEGACY_TAG,
    thresholds: { ...DEFAULT_FUSION_THRESHOLDS },
    engineReady: true,
  };
  const mbfWorker = new GateTrackSession({ gate: "EXIT", modelTag: "arcface_w600k_mbf", context: legacyContext, clock: () => 0, idPrefix: "X" });
  const st = mbfWorker.contextStatus();
  assert.equal(st.ok, false);
  assert.ok(st.reason, "a reason is given");

  const mbfContext: DecisionContext = {
    gallery: buildGallery([template("E1", "arcface_w600k_mbf")], "arcface_w600k_mbf"),
    galleryModelTag: "arcface_w600k_mbf",
    engineModelTag: "arcface_w600k_mbf",
    thresholds: { ...DEFAULT_FUSION_THRESHOLDS },
    engineReady: true,
  };
  const ok = new GateTrackSession({ gate: "EXIT", modelTag: "arcface_w600k_mbf", context: mbfContext, clock: () => 0, idPrefix: "X" });
  assert.equal(ok.contextStatus().ok, true);

  // A context whose gallery tag and engine tag disagree is refused even by a matching worker.
  const mixed: DecisionContext = { ...mbfContext, galleryModelTag: LEGACY_TAG };
  assert.equal(new GateTrackSession({ gate: "EXIT", modelTag: "arcface_w600k_mbf", context: mixed, clock: () => 0, idPrefix: "X" }).contextStatus().ok, false);
});

// ---------------------------------------------------------------- thresholds per tag

test("pipelineFusionThresholds: the legacy tag keeps the legacy numbers; an unknown tag falls back and says so", () => {
  const r50 = pipelineFusionThresholds(LEGACY_TAG, {});
  assert.deepEqual(r50.thresholds, DEFAULT_FUSION_THRESHOLDS);
  assert.equal(r50.source, "calibrated");
  assert.deepEqual(r50.overrides, []);
  const unknown = pipelineFusionThresholds("arcface_w600k_r50_q", {});
  assert.deepEqual(unknown.thresholds, DEFAULT_FUSION_THRESHOLDS);
  assert.equal(unknown.source, "legacy-default");
  assert.deepEqual(PIPELINE_FUSION_THRESHOLDS_BY_TAG[LEGACY_TAG], DEFAULT_FUSION_THRESHOLDS);
});

test("pipelineFusionThresholds: PIPELINE_* overrides apply when in range, malformed ones are ignored and listed", () => {
  const sel = pipelineFusionThresholds(LEGACY_TAG, {
    PIPELINE_ACCEPT_SINGLE: "0.6",
    PIPELINE_ACCEPT_FUSED: "0.5",
    PIPELINE_MIN_MARGIN: "0",
    PIPELINE_MIN_AGREEING: "3",
    PIPELINE_MIN_EVIDENCE: "1.5",
    FACE_ACCEPT_SINGLE: "0.1",
  });
  assert.deepEqual(sel.thresholds, { acceptSingle: 0.6, acceptFused: 0.5, minEvidence: 0.35, minAgreeing: 3, minMargin: 0 });
  assert.deepEqual(sel.overrides, ["PIPELINE_ACCEPT_SINGLE", "PIPELINE_ACCEPT_FUSED", "PIPELINE_MIN_MARGIN", "PIPELINE_MIN_AGREEING"]);
  assert.deepEqual(sel.ignored, ["PIPELINE_MIN_EVIDENCE"]);
  const bad = pipelineFusionThresholds(LEGACY_TAG, { PIPELINE_MIN_AGREEING: "2.5", PIPELINE_ACCEPT_SINGLE: "abc", PIPELINE_ACCEPT_FUSED: "1" });
  assert.deepEqual(bad.thresholds, DEFAULT_FUSION_THRESHOLDS);
  assert.deepEqual(bad.ignored, ["PIPELINE_ACCEPT_SINGLE", "PIPELINE_ACCEPT_FUSED", "PIPELINE_MIN_AGREEING"]);
  assert.notEqual(DEFAULT_FUSION_THRESHOLDS.acceptSingle, 0.6, "the shared default object is never mutated");
});
