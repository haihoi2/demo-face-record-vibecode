/**
 * Unit tests for multi-observation face matching and decision fusion
 * (src/server/faceFusion.ts). Pure vector maths - no models required.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FUSION_THRESHOLDS,
  buildGallery,
  cosine,
  fuseDecision,
  l2Normalize,
  matchObservations,
  recognizeObservations,
  scoreAgainstTemplates,
} from "../src/server/faceFusion";
import { FaceObservation, FaceTemplate } from "../src/types";

// --- synthetic, well-separated identities in a small space ----------------
// Two orthogonal "identities" plus a helper to make a noisy view of one.
const DIMS = 8;
function unit(axis: number): number[] {
  const v = new Array(DIMS).fill(0);
  v[axis] = 1;
  return v;
}
/** A view of `base` with cosine ≈ `target` against it (mixes in an orthogonal axis). */
function viewOf(base: number[], target: number, orthAxis: number): number[] {
  const orth = unit(orthAxis);
  const s = Math.sqrt(Math.max(0, 1 - target * target));
  return l2Normalize(base.map((b, i) => b * target + orth[i] * s));
}
const ALICE = unit(0);
const BOB = unit(1);

function template(employeeId: string, embedding: number[], modelTag = "arcface_w600k_r50"): FaceTemplate {
  return {
    id: `T-${employeeId}-${Math.random().toString(36).slice(2, 6)}`,
    employeeId,
    embedding,
    dims: embedding.length,
    modelTag,
    source: "enrollment",
    quality: 0.9,
    capturedAt: "2026-09-21T00:00:00.000Z",
  };
}
function obs(streamId: string, embedding: number[], quality = 0.9, frameIndex = 0): FaceObservation {
  return { streamId, frameIndex, embedding, quality, detectorScore: 0.9 };
}

const GALLERY = buildGallery([template("ALICE", ALICE), template("BOB", BOB)]);

describe("cosine / l2Normalize", () => {
  it("returns 1 for identical, 0 for orthogonal, and clamps", () => {
    assert.ok(Math.abs(cosine(ALICE, ALICE) - 1) < 1e-12);
    assert.equal(cosine(ALICE, BOB), 0);
    assert.equal(cosine([3, 4], [3, 4]), 1);
    assert.equal(cosine([1, 0], [-1, 0]), -1);
  });
  it("is 0 for mismatched or empty inputs", () => {
    assert.equal(cosine([1, 0], [1]), 0);
    assert.equal(cosine([], []), 0);
  });
  it("l2Normalize yields unit length and handles zero vectors", () => {
    const n = l2Normalize([3, 4]);
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-12);
    assert.deepEqual(l2Normalize([0, 0]), [0, 0]);
  });
});

describe("buildGallery / scoreAgainstTemplates", () => {
  it("groups templates by employee and takes the max over templates", () => {
    const g = buildGallery([template("ALICE", ALICE), template("ALICE", viewOf(ALICE, 0.6, 5))]);
    assert.equal(g.get("ALICE")?.length, 2);
    const probe = viewOf(ALICE, 0.6, 5); // identical to the second template
    assert.ok(scoreAgainstTemplates(probe, g.get("ALICE")!) > 0.999);
  });
  it("drops templates whose modelTag does not match the expected tag", () => {
    const g = buildGallery([template("ALICE", ALICE, "old_model"), template("BOB", BOB)], "arcface_w600k_r50");
    assert.equal(g.has("ALICE"), false);
    assert.equal(g.has("BOB"), true);
  });
});

describe("matchObservations", () => {
  it("records best and runner-up identities per observation", () => {
    const [m] = matchObservations([obs("s1", viewOf(ALICE, 0.8, 5))], GALLERY);
    assert.equal(m.employeeId, "ALICE");
    assert.ok(Math.abs(m.cosine - 0.8) < 1e-6);
    assert.equal(m.secondEmployeeId, "BOB");
    assert.equal(m.secondCosine, 0);
  });
  it("clamps quality into [0,1] and defaults non-finite quality", () => {
    const [a, b] = matchObservations([obs("s1", ALICE, 5), obs("s1", ALICE, NaN)], GALLERY);
    assert.equal(a.quality, 1);
    assert.equal(b.quality, 0.5);
  });
});

describe("fuseDecision", () => {
  it("rejects with no observations", () => {
    const d = fuseDecision([]);
    assert.equal(d.recognized, false);
    assert.equal(d.basis, "rejected-no-face");
  });

  it("accepts on one strong, unambiguous view (single-strong)", () => {
    const d = recognizeObservations([obs("s1", viewOf(ALICE, 0.7, 5))], GALLERY);
    assert.equal(d.recognized, true);
    assert.equal(d.employeeId, "ALICE");
    assert.equal(d.basis, "single-strong");
    assert.equal(d.agreeingObservations, 1);
    assert.ok(d.confidence > 0.4);
  });

  it("rejects one weak view that is below acceptSingle even though above minEvidence", () => {
    const d = recognizeObservations([obs("s1", viewOf(ALICE, 0.47, 5))], GALLERY);
    assert.equal(d.recognized, false);
    assert.equal(d.basis, "rejected-weak");
    assert.equal(d.candidates[0].employeeId, "ALICE"); // evidence is reported, not acted on
  });

  it("accepts when two moderate views from two streams agree (multi-agree)", () => {
    const d = recognizeObservations(
      [obs("cam-501", viewOf(ALICE, 0.48, 5)), obs("cam-2401", viewOf(ALICE, 0.5, 6))],
      GALLERY
    );
    assert.equal(d.recognized, true);
    assert.equal(d.basis, "multi-agree");
    assert.equal(d.agreeingObservations, 2);
    assert.equal(d.agreeingStreams, 2);
  });

  it("two frames from the SAME stream also count as agreement, with a lower confidence than two streams", () => {
    const same = recognizeObservations(
      [obs("cam-501", viewOf(ALICE, 0.48, 5), 0.9, 0), obs("cam-501", viewOf(ALICE, 0.5, 6), 0.9, 1)],
      GALLERY
    );
    const two = recognizeObservations(
      [obs("cam-501", viewOf(ALICE, 0.48, 5)), obs("cam-2401", viewOf(ALICE, 0.5, 6))],
      GALLERY
    );
    assert.equal(same.recognized, true);
    assert.equal(same.agreeingStreams, 1);
    assert.ok(two.confidence > same.confidence);
  });

  it("does NOT accept two agreeing views whose fused cosine is below acceptFused", () => {
    const d = recognizeObservations(
      [obs("cam-501", viewOf(ALICE, 0.38, 5)), obs("cam-2401", viewOf(ALICE, 0.4, 6))],
      GALLERY
    );
    assert.equal(d.recognized, false);
    assert.equal(d.basis, "rejected-weak");
  });

  it("rejects as ambiguous when two streams see two different people at similar strength", () => {
    const d = recognizeObservations(
      [obs("cam-501", viewOf(ALICE, 0.5, 5)), obs("cam-2401", viewOf(BOB, 0.5, 6))],
      GALLERY
    );
    assert.equal(d.recognized, false);
    assert.equal(d.basis, "rejected-ambiguous");
    assert.equal(d.candidates.length, 2);
  });

  it("a strong view of one person is not overturned by a weak view of another", () => {
    const d = recognizeObservations(
      [obs("cam-501", viewOf(ALICE, 0.75, 5)), obs("cam-2401", viewOf(BOB, 0.36, 6))],
      GALLERY
    );
    assert.equal(d.recognized, true);
    assert.equal(d.employeeId, "ALICE");
  });

  it("an observation whose own runner-up is too close is not 'strong'", () => {
    // Probe sits between ALICE and BOB: cosine ~0.71 to each - high, but no margin.
    const between = l2Normalize(ALICE.map((a, i) => a + BOB[i]));
    const d = recognizeObservations([obs("s1", between)], GALLERY);
    assert.equal(d.recognized, false);
    assert.equal(d.basis, "rejected-ambiguous");
  });

  it("quality weighting lets a sharp view outweigh a blurry one in the fused score", () => {
    const sharpHigh = recognizeObservations(
      [obs("s1", viewOf(ALICE, 0.6, 5), 1.0), obs("s2", viewOf(ALICE, 0.36, 6), 0.05)],
      GALLERY
    );
    const blurHigh = recognizeObservations(
      [obs("s1", viewOf(ALICE, 0.6, 5), 0.05), obs("s2", viewOf(ALICE, 0.36, 6), 1.0)],
      GALLERY
    );
    assert.ok(sharpHigh.fusedCosine > blurHigh.fusedCosine);
  });

  it("respects caller-supplied thresholds", () => {
    const strict = recognizeObservations([obs("s1", viewOf(ALICE, 0.7, 5))], GALLERY, { acceptSingle: 0.9 });
    assert.equal(strict.recognized, false);
    const loose = recognizeObservations([obs("s1", viewOf(ALICE, 0.47, 5))], GALLERY, { acceptSingle: 0.45 });
    assert.equal(loose.recognized, true);
    assert.deepEqual(strict.thresholds, { ...DEFAULT_FUSION_THRESHOLDS, acceptSingle: 0.9 });
  });

  it("never recognises against an empty gallery", () => {
    const d = recognizeObservations([obs("s1", ALICE)], new Map());
    assert.equal(d.recognized, false);
    assert.equal(d.employeeId, undefined);
  });
});
