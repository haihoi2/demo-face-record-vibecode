/**
 * Gate area (ROI) of a camera stream: fractions of the picture, clamped inside
 * it, with a minimum size. The request body sent to the server is pinned here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FULL_GATE_AREA,
  MIN_GATE_AREA_SIDE,
  formatGateArea,
  gateAreaFromPercentInputs,
  gateAreaFromPoints,
  gateAreaRequestBody,
  gateAreaStyle,
  gateAreasEqual,
  gateAreaToPercentInputs,
  gateAreaToPixels,
  isFullFrame,
  normalizeGateArea,
  nudgeGateArea,
  pointerToNormalized,
  streamGateArea,
} from "../src/utils/gateArea";

describe("normalizeGateArea", () => {
  it("accepts an object or an [x, y, w, h] array", () => {
    assert.deepEqual(normalizeGateArea({ x: 0.1, y: 0.2, w: 0.5, h: 0.6 }), { x: 0.1, y: 0.2, w: 0.5, h: 0.6 });
    assert.deepEqual(normalizeGateArea([0.1, 0.2, 0.5, 0.6]), { x: 0.1, y: 0.2, w: 0.5, h: 0.6 });
  });

  it("keeps the area inside the picture by moving the corner, not shrinking the size", () => {
    assert.deepEqual(normalizeGateArea({ x: 0.8, y: 0.9, w: 0.5, h: 0.5 }), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    assert.deepEqual(normalizeGateArea({ x: -0.2, y: -1, w: 0.3, h: 0.3 }), { x: 0, y: 0, w: 0.3, h: 0.3 });
  });

  it("caps the size at the whole picture and enforces the minimum", () => {
    assert.deepEqual(normalizeGateArea({ x: 0, y: 0, w: 3, h: 2 }), FULL_GATE_AREA);
    const tiny = normalizeGateArea({ x: 0.5, y: 0.5, w: 0.001, h: 0.001 })!;
    assert.equal(tiny.w, MIN_GATE_AREA_SIDE);
    assert.equal(tiny.h, MIN_GATE_AREA_SIDE);
  });

  it("rejects malformed values instead of guessing", () => {
    for (const bad of [null, undefined, "roi", 5, {}, { x: 0, y: 0, w: 0, h: 0.5 }, { x: 0, y: 0, w: -1, h: 1 }, [0, 0, "a", 1], { x: NaN, y: 0, w: 1, h: 1 }]) {
      assert.equal(normalizeGateArea(bad), null, JSON.stringify(bad));
    }
  });

  it("rounds to 4 decimals", () => {
    assert.deepEqual(normalizeGateArea({ x: 0.123456, y: 0, w: 0.5, h: 0.5 }), { x: 0.1235, y: 0, w: 0.5, h: 0.5 });
  });
});

describe("drawing", () => {
  const rect = { left: 100, top: 50, width: 800, height: 450 };

  it("maps a pointer to fractions of the picture, clamped", () => {
    assert.deepEqual(pointerToNormalized(500, 275, rect), { x: 0.5, y: 0.5 });
    assert.deepEqual(pointerToNormalized(0, 1000, rect), { x: 0, y: 1 });
    assert.deepEqual(pointerToNormalized(10, 10, { left: 0, top: 0, width: 0, height: 0 }), { x: 0, y: 0 });
  });

  it("builds the same rectangle whichever way the drag goes", () => {
    const a = { x: 0.2, y: 0.3 };
    const b = { x: 0.6, y: 0.9 };
    assert.deepEqual(gateAreaFromPoints(a, b), { x: 0.2, y: 0.3, w: 0.4, h: 0.6 });
    assert.deepEqual(gateAreaFromPoints(b, a), gateAreaFromPoints(a, b));
  });

  it("turns a click (no drag) into the minimum area, still inside the picture", () => {
    const area = gateAreaFromPoints({ x: 1, y: 1 }, { x: 1, y: 1 });
    assert.deepEqual(area, { x: 1 - MIN_GATE_AREA_SIDE, y: 1 - MIN_GATE_AREA_SIDE, w: MIN_GATE_AREA_SIDE, h: MIN_GATE_AREA_SIDE });
  });
});

describe("keyboard editing", () => {
  const area = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };

  it("moves with arrows and stops at the edges", () => {
    assert.deepEqual(nudgeGateArea(area, "right", 0.01, false), { x: 0.11, y: 0.1, w: 0.5, h: 0.5 });
    assert.deepEqual(nudgeGateArea({ ...area, x: 0 }, "left", 0.01, false).x, 0);
    assert.deepEqual(nudgeGateArea({ ...area, x: 0.5 }, "right", 0.01, false).x, 0.5);
  });

  it("resizes with Shift and never grows past the picture", () => {
    assert.deepEqual(nudgeGateArea(area, "down", 0.01, true), { x: 0.1, y: 0.1, w: 0.5, h: 0.51 });
    assert.deepEqual(nudgeGateArea({ x: 0.5, y: 0, w: 0.5, h: 0.5 }, "right", 0.01, true), { x: 0.5, y: 0, w: 0.5, h: 0.5 });
    assert.equal(nudgeGateArea({ x: 0, y: 0, w: MIN_GATE_AREA_SIDE, h: 0.5 }, "left", 0.01, true).w, MIN_GATE_AREA_SIDE);
  });
});

describe("numeric inputs", () => {
  it("round-trips through percent strings", () => {
    const area = { x: 0.125, y: 0.1, w: 0.5, h: 0.6 };
    const inputs = gateAreaToPercentInputs(area);
    assert.deepEqual(inputs, { x: "12.5", y: "10", w: "50", h: "60" });
    assert.deepEqual(gateAreaFromPercentInputs(inputs), area);
  });

  it("accepts a decimal comma and rejects blanks", () => {
    assert.deepEqual(gateAreaFromPercentInputs({ x: "12,5", y: "0", w: "50", h: "50" }), { x: 0.125, y: 0, w: 0.5, h: 0.5 });
    assert.equal(gateAreaFromPercentInputs({ x: "", y: "0", w: "50", h: "50" }), null);
    assert.equal(gateAreaFromPercentInputs({ x: "abc", y: "0", w: "50", h: "50" }), null);
  });
});

describe("full frame, comparison and wording", () => {
  it("treats no area and the whole picture as the same thing", () => {
    assert.equal(isFullFrame(null), true);
    assert.equal(isFullFrame(FULL_GATE_AREA), true);
    assert.equal(isFullFrame({ x: 0, y: 0, w: 0.99, h: 1 }), false);
    assert.equal(gateAreasEqual(null, FULL_GATE_AREA), true);
    assert.equal(gateAreasEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }), true);
    assert.equal(gateAreasEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, null), false);
  });

  it("describes the area in Vietnamese", () => {
    assert.equal(formatGateArea(null), "Toàn khung hình");
    assert.equal(formatGateArea({ x: 0.125, y: 0.1, w: 0.5, h: 0.6 }), "từ trái 12.5%, từ trên 10% · rộng 50%, cao 60%");
  });

  it("positions the overlay in percent and converts to source pixels", () => {
    assert.deepEqual(gateAreaStyle({ x: 0.25, y: 0.1, w: 0.5, h: 0.8 }), { left: "25%", top: "10%", width: "50%", height: "80%" });
    assert.deepEqual(gateAreaToPixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 }, 3840, 2160), { x: 960, y: 1080, w: 1920, h: 1080 });
  });
});

describe("stream config contract", () => {
  it("reads the optional roi of a stream defensively", () => {
    assert.deepEqual(streamGateArea({ id: "s", roi: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } }), { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    assert.equal(streamGateArea({ id: "s" }), null, "server without roi support");
    assert.equal(streamGateArea({ id: "s", roi: { x: 0, y: 0, w: 1, h: 1 } }), null, "whole picture = no area");
    assert.equal(streamGateArea({ id: "s", roi: "garbage" }), null);
    assert.equal(streamGateArea(null), null);
  });

  it("sends { roi: {x,y,w,h} } to set and { roi: null } to clear", () => {
    assert.deepEqual(gateAreaRequestBody({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }), { roi: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } });
    assert.deepEqual(gateAreaRequestBody(null), { roi: null });
    assert.deepEqual(gateAreaRequestBody(FULL_GATE_AREA), { roi: null });
    assert.deepEqual(gateAreaRequestBody({ x: 0.9, y: 0, w: 0.5, h: 2 }), { roi: { x: 0.5, y: 0, w: 0.5, h: 1 } });
  });
});
