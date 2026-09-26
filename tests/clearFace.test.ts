/**
 * The clear-face gate: a face must be looking at the camera to be recognised,
 * kept as a stranger capture, or registered as a template. Landmark sets below
 * are real SCRFD outputs' shapes (left eye, right eye, nose, mouth L, mouth R).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CLEAR_FACE_LIMITS, clearFaceIssue, facePose } from "../src/server/faceEmbedding";

type L = Array<[number, number]>;
const FRONTAL: L = [[40, 50], [72, 50], [56, 66], [44, 84], [68, 84]];
const TURNED: L = [[40, 50], [52, 50], [70, 66], [48, 84], [62, 84]];   // nose far outside the eyes
const BOWED: L = [[50, 40], [54, 40], [52, 60], [50, 72], [54, 72]];     // eyes collapsed together, nose centred
const TILTED: L = [[40, 40], [70, 90], [48, 72], [30, 88], [52, 108]];   // eye line steep

describe("face pose from five landmarks", () => {
  it("reads a frontal face as centred, level and in proportion", () => {
    const pose = facePose(FRONTAL)!;
    assert.ok(Math.abs(pose.yaw) < 0.05, `yaw ${pose.yaw}`);
    assert.ok(Math.abs(pose.rollDeg) < 1, `roll ${pose.rollDeg}`);
    assert.ok(pose.aspect > 0.9 && pose.aspect < 1.2, `aspect ${pose.aspect}`);
    assert.equal(clearFaceIssue(pose), null);
  });

  it("rejects a head turned away, a bowed head and a steep tilt", () => {
    assert.equal(clearFaceIssue(facePose(TURNED)), "yaw");
    assert.equal(clearFaceIssue(facePose(BOWED)), "aspect");
    assert.equal(clearFaceIssue(facePose(TILTED)), "roll");
  });

  it("treats missing or degenerate landmarks as not clear", () => {
    assert.equal(clearFaceIssue(facePose([])), "landmarks");
    assert.equal(clearFaceIssue(facePose([[5, 5], [5, 5], [5, 5], [5, 5], [5, 5]])), "landmarks");
  });

  it("the capture that prompted this gate is rejected", () => {
    // Measured from the stored snapshot of LOG-1790318570328 (2026-09-25 13:42:39,
    // cổng vào): quality scored a perfect 1.00, yet the head was bowed and turned.
    const measured = { yaw: 7.507, aspect: 8.579, rollDeg: 46.4 };
    assert.notEqual(clearFaceIssue(measured), null);
  });

  it("uses the calibrated defaults", () => {
    assert.deepEqual(CLEAR_FACE_LIMITS, { minFacePx: 60, maxYaw: 1.5, minAspect: 0.3, maxAspect: 2.5, maxRollDeg: 45 });
  });
});

describe("minimum face size", () => {
  it("drops a face smaller than the floor, before looking at its pose", () => {
    assert.equal(clearFaceIssue(facePose(FRONTAL), CLEAR_FACE_LIMITS, 59), "small");
    assert.equal(clearFaceIssue(facePose(TURNED), CLEAR_FACE_LIMITS, 20), "small", "size is the first reason given");
    assert.equal(clearFaceIssue(null, CLEAR_FACE_LIMITS, 10), "small");
  });

  it("keeps a frontal face at or above the floor", () => {
    assert.equal(clearFaceIssue(facePose(FRONTAL), CLEAR_FACE_LIMITS, 60), null);
    assert.equal(clearFaceIssue(facePose(FRONTAL), CLEAR_FACE_LIMITS, 400), null);
  });

  it("still applies the pose checks to a big face", () => {
    assert.equal(clearFaceIssue(facePose(TURNED), CLEAR_FACE_LIMITS, 200), "yaw");
  });

  it("can be switched off, and is not applied when the size is unknown", () => {
    assert.equal(clearFaceIssue(facePose(FRONTAL), { ...CLEAR_FACE_LIMITS, minFacePx: 0 }, 5), null);
    assert.equal(clearFaceIssue(facePose(FRONTAL)), null);
  });
});
