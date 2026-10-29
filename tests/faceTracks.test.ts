/**
 * Face tracks of one gate scan (src/server/faceTracks.ts) and why they exist:
 * two registered people side by side, fused as one decision, were refused as
 * ambiguous (Taiga #506). Pure maths - no models required.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { groupFaceTracks, TrackItem } from "../src/server/faceTracks";
import { buildGallery, l2Normalize, recognizeObservations } from "../src/server/faceFusion";
import { FaceObservation, FaceTemplate } from "../src/types";

const box = (x: number, y: number, w: number): TrackItem["box"] => [x, y, x + w, y + w];
const item = (streamId: string, frameIndex: number, b: TrackItem["box"]): TrackItem => ({ streamId, frameIndex, box: b });

describe("groupFaceTracks", () => {
  it("one face across frames is one track, even while walking", () => {
    const t = groupFaceTracks([item("s", 0, box(100, 100, 80)), item("s", 1, box(140, 110, 84)), item("s", 2, box(180, 118, 90))]);
    assert.deepEqual(t, [0, 0, 0]);
  });

  it("two people side by side stay two tracks, whatever the input order", () => {
    const a = (f: number) => item("s", f, box(100 + 10 * f, 100, 80));
    const b = (f: number) => item("s", f, box(260 + 10 * f, 104, 78));
    const t = groupFaceTracks([b(0), a(0), a(1), b(1), b(2), a(2)]);
    assert.equal(new Set(t).size, 2);
    assert.equal(t[1], t[2]);
    assert.equal(t[2], t[5]);
    assert.equal(t[0], t[3]);
    assert.equal(t[3], t[4]);
    assert.notEqual(t[0], t[1]);
  });

  it("a face never joins a track twice in one frame; tracks never cross streams", () => {
    const t = groupFaceTracks([item("s", 0, box(100, 100, 80)), item("s", 0, box(150, 100, 80)), item("other", 0, box(100, 100, 80))]);
    assert.equal(new Set(t).size, 3);
  });

  it("a very different size is a different face", () => {
    const t = groupFaceTracks([item("s", 0, box(100, 100, 40)), item("s", 1, box(100, 100, 120))]);
    assert.notEqual(t[0], t[1]);
  });

  it("is index-parallel and empty-safe", () => {
    assert.deepEqual(groupFaceTracks([]), []);
  });
});

// ---- the decision the tracks change -------------------------------------
const DIMS = 8;
const unit = (axis: number) => { const v = new Array(DIMS).fill(0); v[axis] = 1; return v; };
const viewOf = (base: number[], target: number, orthAxis: number) => {
  const orth = unit(orthAxis);
  const s = Math.sqrt(1 - target * target);
  return l2Normalize(base.map((b, i) => b * target + orth[i] * s));
};
const template = (employeeId: string, embedding: number[]): FaceTemplate => ({
  id: `T-${employeeId}`, employeeId, embedding, dims: DIMS, modelTag: "arcface_w600k_r50", source: "enrollment", quality: 0.9, capturedAt: "2026-10-29T00:00:00.000Z",
});
const obs = (embedding: number[], frameIndex: number): FaceObservation => ({ streamId: "s", frameIndex, embedding, quality: 0.9, detectorScore: 0.9 });
const GALLERY = buildGallery([template("ALICE", unit(0)), template("BOB", unit(1))]);

describe("two employees at the gate together", () => {
  const alice = [obs(viewOf(unit(0), 0.8, 5), 0), obs(viewOf(unit(0), 0.79, 6), 1)];
  const bob = [obs(viewOf(unit(1), 0.8, 5), 0), obs(viewOf(unit(1), 0.78, 6), 1)];

  it("fused as one decision, both are refused as ambiguous (the old behaviour)", () => {
    const pooled = recognizeObservations([...alice, ...bob], GALLERY);
    assert.equal(pooled.recognized, false);
    assert.equal(pooled.basis, "rejected-ambiguous");
  });

  it("decided per face track, each is recognised as themself", () => {
    const a = recognizeObservations(alice, GALLERY);
    const b = recognizeObservations(bob, GALLERY);
    assert.equal(a.recognized && a.employeeId, "ALICE");
    assert.equal(b.recognized && b.employeeId, "BOB");
  });
});
