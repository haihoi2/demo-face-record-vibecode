/**
 * Stranger storage floor for heads cut off by the picture edge (src/server/faceFrameEdge.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { faceCutByFrameEdge } from "../src/server/faceFrameEdge";

const FRAME: [number, number] = [3840, 2160];

describe("faceCutByFrameEdge", () => {
  it("flags the three cut heads measured on site (bottom edge 0, 9, 27 px)", () => {
    assert.equal(faceCutByFrameEdge([2043, 1802, 2424, 2160], FRAME, 0.1), true);
    assert.equal(faceCutByFrameEdge([1969, 1914, 2328, 2151], FRAME, 0.1), true);
    assert.equal(faceCutByFrameEdge([2420, 1794, 2688, 2133], FRAME, 0.1), true);
  });

  it("keeps the nearest complete face (50 px from the bottom, 458 px tall) and faces in the middle", () => {
    assert.equal(faceCutByFrameEdge([3421, 1652, 3735, 2110], FRAME, 0.1), false);
    assert.equal(faceCutByFrameEdge([1190, 984, 1289, 1116], FRAME, 0.1), false);
  });

  it("checks every edge, each against the face's own size on that axis", () => {
    assert.equal(faceCutByFrameEdge([5, 500, 205, 700], FRAME, 0.1), true, "left");
    assert.equal(faceCutByFrameEdge([500, 10, 700, 210], FRAME, 0.1), true, "top");
    assert.equal(faceCutByFrameEdge([3630, 500, 3830, 700], FRAME, 0.1), true, "right");
    assert.equal(faceCutByFrameEdge([25, 500, 225, 700], FRAME, 0.1), false, "20 px of a 200 px face is enough");
  });

  it("is off without a frame size, a box or a positive margin", () => {
    assert.equal(faceCutByFrameEdge(undefined, FRAME, 0.1), false);
    assert.equal(faceCutByFrameEdge([0, 0, 100, 100], undefined, 0.1), false);
    assert.equal(faceCutByFrameEdge([0, 0, 100, 100], FRAME, 0), false);
    assert.equal(faceCutByFrameEdge([10, 10, 10, 50], FRAME, 0.1), false, "degenerate box");
  });
});
