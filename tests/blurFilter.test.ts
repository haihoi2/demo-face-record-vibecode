/**
 * Blur filter (Taiga #511): a pure rule over the metrics already stored with a
 * face. The direction that matters for safety is "unknown -> not blurry":
 * hiding a stranger capture or refusing a template must never happen on a
 * missing or incompatible number.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  type BlurMetrics as BlurMetricsLike,
  BLUR_MODEL_TAG,
  DEFAULT_BLUR_POLICY,
  blurPolicyFromEnv,
  blurProbability,
  blurSharpness,
  isBlurry,
  proposedFloors,
} from "../src/server/blurFilter";

// Representative points from the 2026-11-02 evaluation: the sharp class median
// (featureNorm 25.0 at ~100 px) and a blurry face at the blurry class p10
// (featureNorm 21.0, 70 px). The blurry MEDIAN (23.0 at 90 px) sits right at
// the default threshold - the rule only catches ~45 % of the labels.
const SHARP = { edgeEnergy: 0.35, featureNorm: 25.0, sizePx: 100, modelTag: BLUR_MODEL_TAG };
const BLURRY = { edgeEnergy: 0.3, featureNorm: 21.0, sizePx: 70, modelTag: BLUR_MODEL_TAG };

describe("blurSharpness", () => {
  it("is monotonic: more feature strength or a bigger face means sharper; edgeEnergy carries no weight", () => {
    const base = blurSharpness(SHARP)!;
    assert.ok(blurSharpness({ ...SHARP, featureNorm: SHARP.featureNorm + 2 })! > base);
    assert.ok(blurSharpness({ ...SHARP, featureNorm: SHARP.featureNorm - 2 })! < base);
    assert.ok(blurSharpness({ ...SHARP, sizePx: SHARP.sizePx * 2 })! > base);
    // Measured AUC 0.55: edgeEnergy is noise for this question, so the default ignores it.
    assert.equal(DEFAULT_BLUR_POLICY.wEdge, 0);
    assert.equal(blurSharpness({ ...SHARP, edgeEnergy: SHARP.edgeEnergy + 0.3 }), base);
  });

  it("reproduces the fitted operating point: a small face needs a higher featureNorm", () => {
    // From the policy comment: cut-off 23.7 at 66 px, 21.8 at 150 px.
    assert.equal(isBlurry({ featureNorm: 23.5, sizePx: 66 }), true);
    assert.equal(isBlurry({ featureNorm: 23.9, sizePx: 66 }), false);
    assert.equal(isBlurry({ featureNorm: 21.6, sizePx: 150 }), true);
    assert.equal(isBlurry({ featureNorm: 22.0, sizePx: 150 }), false);
  });

  it("separates the representative sharp and blurry points", () => {
    assert.ok(blurSharpness(SHARP)! > DEFAULT_BLUR_POLICY.threshold, "sharp median above threshold");
    assert.ok(blurSharpness(BLURRY)! < DEFAULT_BLUR_POLICY.threshold, "blurry p10 below threshold");
    assert.equal(isBlurry(SHARP), false);
    assert.equal(isBlurry(BLURRY), true);
  });

  it("is deterministic for the same input", () => {
    assert.equal(blurSharpness(BLURRY), blurSharpness({ ...BLURRY }));
    assert.equal(blurProbability(BLURRY), blurProbability({ ...BLURRY }));
  });

  it("probability is in (0,1) and higher for the blurry face", () => {
    const pb = blurProbability(BLURRY)!, ps = blurProbability(SHARP)!;
    assert.ok(pb > 0 && pb < 1 && ps > 0 && ps < 1);
    assert.ok(pb > ps);
  });
});

describe("fail-safe: unknown is never blurry", () => {
  it("null/undefined metrics -> null score, not blurry", () => {
    assert.equal(blurSharpness(null), null);
    assert.equal(blurSharpness(undefined), null);
    assert.equal(isBlurry(null), false);
    assert.equal(isBlurry({}), false);
  });

  it("missing or non-finite featureNorm / sizePx -> not blurry", () => {
    assert.equal(isBlurry({ ...BLURRY, featureNorm: undefined }), false);
    assert.equal(isBlurry({ ...BLURRY, featureNorm: null }), false);
    assert.equal(isBlurry({ ...BLURRY, featureNorm: NaN }), false);
    assert.equal(isBlurry({ ...BLURRY, featureNorm: Infinity }), false);
    assert.equal(isBlurry({ ...BLURRY, featureNorm: 0 }), false);
    assert.equal(isBlurry({ ...BLURRY, sizePx: undefined }), false);
    assert.equal(isBlurry({ ...BLURRY, sizePx: NaN }), false);
  });

  it("a policy that weights edgeEnergy needs a finite, non-negative edgeEnergy", () => {
    const policy = { ...DEFAULT_BLUR_POLICY, wEdge: 5 }; // any non-zero weight; the sign is not under test
    assert.equal(isBlurry({ ...BLURRY, edgeEnergy: undefined }, policy), false);
    assert.equal(isBlurry({ ...BLURRY, edgeEnergy: null }, policy), false);
    assert.equal(isBlurry({ ...BLURRY, edgeEnergy: NaN }, policy), false);
    assert.equal(isBlurry({ ...BLURRY, edgeEnergy: -1 }, policy), false);
    assert.equal(isBlurry(BLURRY, policy), true);
    // The default does not weight it, so its absence is fine there.
    assert.equal(isBlurry({ ...BLURRY, edgeEnergy: undefined }), true);
  });

  it("corrupted input (wrong types, negative values) -> not blurry", () => {
    assert.equal(isBlurry({ featureNorm: "10" as unknown as number, sizePx: 70 }), false);
    assert.equal(isBlurry({ featureNorm: 10, sizePx: "70" as unknown as number }), false);
    assert.equal(isBlurry({ featureNorm: -5, sizePx: 70 }), false);
    assert.equal(isBlurry({ featureNorm: 10, sizePx: -70 }), false);
    assert.equal(isBlurry([] as unknown as BlurMetricsLike), false);
  });

  it("featureNorm from another recogniser is never compared (model mismatch -> null)", () => {
    assert.equal(blurSharpness({ ...BLURRY, modelTag: "arcface_w600k_mbf" }), null);
    assert.equal(isBlurry({ ...BLURRY, modelTag: "arcface_w600k_mbf_int8" }), false);
    // An explicit matching tag, or no tag at all (legacy rows), is accepted.
    assert.ok(blurSharpness({ ...BLURRY, modelTag: BLUR_MODEL_TAG }) !== null);
    assert.ok(blurSharpness({ ...BLURRY, modelTag: undefined }) !== null);
  });

  it("a policy that uses size needs a positive sizePx", () => {
    const policy = { ...DEFAULT_BLUR_POLICY, wLnSize: 0.5 };
    assert.equal(blurSharpness({ ...BLURRY, sizePx: undefined }, policy), null);
    assert.equal(blurSharpness({ ...BLURRY, sizePx: 0 }, policy), null);
    assert.ok(blurSharpness({ ...BLURRY, sizePx: 85 }, policy) !== null);
  });
});

describe("policy", () => {
  it("the default policy is tied to the r50 recogniser", () => {
    assert.equal(DEFAULT_BLUR_POLICY.featureNormModelTag, BLUR_MODEL_TAG);
    assert.equal(BLUR_MODEL_TAG, "arcface_w600k_r50");
  });

  it("threshold override via environment, invalid values ignored", () => {
    assert.equal(blurPolicyFromEnv({}).threshold, DEFAULT_BLUR_POLICY.threshold);
    assert.equal(blurPolicyFromEnv({ FACE_BLUR_THRESHOLD: "abc" }).threshold, DEFAULT_BLUR_POLICY.threshold);
    assert.equal(blurPolicyFromEnv({ FACE_BLUR_THRESHOLD: "" }).threshold, DEFAULT_BLUR_POLICY.threshold);
    const p = blurPolicyFromEnv({ FACE_BLUR_THRESHOLD: "-99" });
    assert.equal(p.threshold, -99);
    assert.equal(isBlurry(BLURRY, p), false, "a very low threshold hides nothing");
  });

  it("proposedFloors exposes the same rule for both call sites and copies the policy", () => {
    const f = proposedFloors();
    assert.equal(f.hideFromClusters(BLURRY), true);
    assert.equal(f.refuseAsTemplate(BLURRY), true);
    assert.equal(f.hideFromClusters(SHARP), false);
    assert.equal(f.refuseAsTemplate({}), false);
    assert.deepEqual(f.policy, DEFAULT_BLUR_POLICY);
    assert.notEqual(f.policy, DEFAULT_BLUR_POLICY);
  });
});
