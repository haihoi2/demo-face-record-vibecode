import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { gateAreaToPixels, normalizeGateArea } from "../src/server/pipeline/gateArea";

describe("gate area (server side)", () => {
  it("leaves the field unset for missing or malformed input", () => {
    assert.equal(normalizeGateArea(undefined), undefined);
    assert.equal(normalizeGateArea("0,0,1,1"), undefined);
    assert.equal(normalizeGateArea({ x: 0, y: 0, w: "a", h: 1 }), undefined);
  });

  it("treats null and the whole picture as 'no gate area'", () => {
    assert.equal(normalizeGateArea(null), null);
    assert.equal(normalizeGateArea({ x: 0, y: 0, w: 1, h: 1 }), null);
  });

  it("clamps into the picture, enforces a minimum side and rounds to 4 decimals", () => {
    assert.deepEqual(normalizeGateArea({ x: 0.123456, y: 0.2, w: 0.5, h: 0.5 }), { x: 0.1235, y: 0.2, w: 0.5, h: 0.5 });
    assert.deepEqual(normalizeGateArea({ x: 0.9, y: -1, w: 0.5, h: 0.01 }), { x: 0.5, y: 0, w: 0.5, h: 0.05 });
    assert.deepEqual(normalizeGateArea({ x: 0, y: 0, w: 5, h: 0.3 }), { x: 0, y: 0, w: 1, h: 0.3 });
  });

  it("converts to source pixels", () => {
    assert.deepEqual(gateAreaToPixels({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 3840, 2160), [960, 540, 1920, 1080]);
    assert.equal(gateAreaToPixels(null, 3840, 2160), null);
  });
});
