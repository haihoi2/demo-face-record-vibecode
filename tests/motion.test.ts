import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MotionDetector, grayThumbnail, motionScore, normalizeMotionOptions } from "../src/server/pipeline/motion";

function solid(width: number, height: number, value: number): Uint8Array {
  return new Uint8Array(width * height * 3).fill(value);
}

/** Copy of `rgb` with a filled rectangle. */
function withBox(rgb: Uint8Array, width: number, box: [number, number, number, number], value: number): Uint8Array {
  const out = new Uint8Array(rgb);
  const [x0, y0, w, h] = box;
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) out.fill(value, (y * width + x) * 3, (y * width + x) * 3 + 3);
  }
  return out;
}

describe("grayThumbnail", () => {
  it("downscales to the requested width and keeps the aspect ratio", () => {
    const t = grayThumbnail(solid(640, 360, 100), 640, 360, 64);
    assert.equal(t.width, 64);
    assert.equal(t.height, 36);
    assert.equal(t.data.length, 64 * 36);
    assert.ok(t.data.every((v) => v === 100));
  });

  it("uses BT.601 luma weights", () => {
    const rgb = new Uint8Array(4 * 4 * 3);
    for (let i = 0; i < rgb.length; i += 3) rgb[i + 1] = 255; // pure green
    const t = grayThumbnail(rgb, 4, 4, 2, 1);
    assert.ok(t.data.every((v) => v === 149), `got ${t.data[0]}`);
  });

  it("returns an empty thumbnail for a short or empty buffer", () => {
    assert.equal(grayThumbnail(new Uint8Array(10), 64, 64).data.length, 0);
    assert.equal(grayThumbnail(new Uint8Array(0), 0, 0).data.length, 0);
  });
});

describe("motionScore", () => {
  it("is 0 for identical pictures and ignores changes below pixelDelta", () => {
    const a = grayThumbnail(solid(320, 180, 100), 320, 180);
    const b = grayThumbnail(solid(320, 180, 108), 320, 180);
    assert.equal(motionScore(a, a), 0);
    assert.equal(motionScore(a, b, 12), 0);
    assert.equal(motionScore(a, b, 5), 1);
  });

  it("measures the changed fraction and treats incomparable sizes as full change", () => {
    const base = solid(320, 180, 50);
    const a = grayThumbnail(base, 320, 180, 64);
    const b = grayThumbnail(withBox(base, 320, [0, 0, 160, 180], 200), 320, 180, 64);
    assert.equal(motionScore(a, b), 0.5);
    const c = grayThumbnail(solid(160, 90, 50), 160, 90, 32);
    assert.equal(motionScore(a, c), 1);
  });
});

describe("MotionDetector", () => {
  const W = 320;
  const H = 180;
  const still = solid(W, H, 60);
  const person = withBox(still, W, [100, 40, 40, 100], 220); // ~7% of the area

  it("counts the first frame as moving (no reference, fail open)", () => {
    const d = new MotionDetector({ holdMs: 0 });
    assert.deepEqual(d.update({ rgb: still, width: W, height: H, capturedAtMs: 0 }), { score: 1, changed: true, moving: true });
  });

  it("is off for a still scene and on when something enters", () => {
    const d = new MotionDetector({ holdMs: 0 });
    d.update({ rgb: still, width: W, height: H, capturedAtMs: 0 });
    const s = d.update({ rgb: still, width: W, height: H, capturedAtMs: 125 });
    assert.equal(s.changed, false);
    assert.equal(s.moving, false);
    const m = d.update({ rgb: person, width: W, height: H, capturedAtMs: 250 });
    assert.equal(m.changed, true);
    assert.equal(m.moving, true);
    assert.ok(m.score > 0.03 && m.score < 0.15, `score ${m.score}`);
  });

  it("keeps reporting motion for holdMs after the last change", () => {
    const d = new MotionDetector({ holdMs: 1000 });
    d.update({ rgb: still, width: W, height: H, capturedAtMs: 0 });
    d.update({ rgb: person, width: W, height: H, capturedAtMs: 100 });
    const held = d.update({ rgb: person, width: W, height: H, capturedAtMs: 1100 });
    assert.equal(held.changed, false);
    assert.equal(held.moving, true);
    const expired = d.update({ rgb: person, width: W, height: H, capturedAtMs: 1101 });
    assert.equal(expired.moving, false);
  });

  it("respects the threshold", () => {
    const strict = new MotionDetector({ threshold: 0.2, holdMs: 0 });
    strict.update({ rgb: still, width: W, height: H, capturedAtMs: 0 });
    assert.equal(strict.update({ rgb: person, width: W, height: H, capturedAtMs: 1 }).changed, false);
  });

  it("reset() forgets the reference frame", () => {
    const d = new MotionDetector({ holdMs: 0 });
    d.update({ rgb: still, width: W, height: H, capturedAtMs: 0 });
    d.reset();
    assert.equal(d.update({ rgb: still, width: W, height: H, capturedAtMs: 1 }).moving, true);
  });

  it("normalizes nonsense options to defaults", () => {
    const o = normalizeMotionOptions({ thumbWidth: -1, pixelDelta: Number.NaN, threshold: 5, holdMs: -2 });
    assert.equal(o.thumbWidth, 64);
    assert.equal(o.pixelDelta, 12);
    assert.equal(o.threshold, 1);
    assert.equal(o.holdMs, 2000);
  });
});
