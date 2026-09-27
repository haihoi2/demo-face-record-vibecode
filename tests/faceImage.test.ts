/**
 * Display rules for captured images: new rows hold ~224-300 px face crops, old
 * rows keep 16:9 camera frames. Thumbnails and the enlarged view must suit both.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyImageShape,
  describeImageShape,
  formatPixelSize,
  thumbFitClass,
  usableZoomScales,
  zoomDisplaySize,
} from "../src/utils/faceImage";

describe("image shape", () => {
  it("treats small, roughly square images as face crops", () => {
    assert.equal(classifyImageShape(224, 224), "crop");
    assert.equal(classifyImageShape(256, 300), "crop");
    assert.equal(classifyImageShape(300, 240), "crop");
  });

  it("treats wide or tall images as legacy camera frames", () => {
    assert.equal(classifyImageShape(1920, 1080), "frame");
    assert.equal(classifyImageShape(640, 360), "frame");
    assert.equal(classifyImageShape(1080, 1920), "frame");
  });

  it("treats a large near-square image as a frame, not a crop", () => {
    assert.equal(classifyImageShape(1280, 960), "frame");
  });

  it("never throws on missing or broken sizes", () => {
    for (const [w, h] of [[0, 0], [NaN, 100], [100, -1], [undefined, 5], ["300", "300"]] as const) {
      assert.equal(classifyImageShape(w, h), "unknown");
    }
  });

  it("fills the thumbnail with a crop but shows a frame whole", () => {
    assert.match(thumbFitClass("crop"), /object-cover/);
    assert.match(thumbFitClass("frame"), /object-contain/);
    assert.match(thumbFitClass("unknown"), /object-contain/);
  });

  it("describes each shape in Vietnamese", () => {
    assert.equal(describeImageShape("crop"), "Ảnh khuôn mặt đã chụp");
    assert.match(describeImageShape("frame"), /Khung hình cũ/);
  });
});

describe("enlarged view size", () => {
  const screen = { width: 1600, height: 900 };

  it("shows a face crop at its natural size by default", () => {
    assert.deepEqual(zoomDisplaySize({ width: 256, height: 256 }, screen), { width: 256, height: 256, capped: false });
  });

  it("scales a small crop up on request while it fits", () => {
    assert.deepEqual(zoomDisplaySize({ width: 256, height: 256 }, screen, 2), { width: 512, height: 512, capped: false });
  });

  it("shrinks (never stretches) a big frame to the screen and says so", () => {
    const out = zoomDisplaySize({ width: 3840, height: 2160 }, screen);
    assert.equal(out.capped, true);
    assert.ok(out.width <= 1600 * 0.9 && out.height <= 900 * 0.9);
    assert.ok(Math.abs(out.width / out.height - 16 / 9) < 0.01, "aspect ratio kept");
  });

  it("offers only the zoom steps that still fit", () => {
    assert.deepEqual(usableZoomScales({ width: 256, height: 256 }, screen), [1, 2, 3]);
    assert.deepEqual(usableZoomScales({ width: 300, height: 300 }, { width: 700, height: 700 }), [1, 2]);
    assert.deepEqual(usableZoomScales({ width: 1920, height: 1080 }, screen), [1]);
  });

  it("returns an empty size for an image that has not loaded", () => {
    assert.deepEqual(zoomDisplaySize({ width: 0, height: 0 }, screen), { width: 0, height: 0, capped: false });
  });

  it("formats pixel sizes, empty when unknown", () => {
    assert.equal(formatPixelSize({ width: 256, height: 240 }), "256 × 240 px");
    assert.equal(formatPixelSize(null), "");
    assert.equal(formatPixelSize({ width: 0, height: 10 }), "");
  });
});
