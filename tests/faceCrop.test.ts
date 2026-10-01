/**
 * Unit tests for face crops (src/server/pipeline/faceCrop.ts, pipeline step 3).
 *
 * Geometry is pure and runs everywhere. Encoding cases need the ffmpeg binary
 * (the tester image ships it) and self-skip without it. No models needed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  computeFaceCropRect,
  resolveFaceCropOptions,
  boxInCrop,
  sliceRgb,
  cropFaceFromRgb,
  cropFaceFromImage,
  cropToDataUrl,
  encodedImageSize,
  FACE_CROP_DEFAULTS,
} from "../src/server/pipeline/faceCrop.ts";
import type { Frame } from "../src/server/pipeline/contracts.ts";
import { loadImage } from "../src/server/faceEmbedding.ts";

function hasFfmpeg(): boolean {
  try {
    return spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], { timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}
const FFMPEG = hasFfmpeg();

const CROP_ENV = ["FACE_CROP_MARGIN", "FACE_CROP_MIN_PX", "FACE_CROP_MAX_PX", "FACE_CROP_QSCALE", "FACE_CROP_TIMEOUT_MS"];
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
for (const k of CROP_ENV) delete process.env[k];

/** RGB picture split into four solid quadrants so crops can be checked for orientation. */
function quadrants(w: number, h: number): { width: number; height: number; rgb: Uint8Array } {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      const right = x >= w / 2;
      const bottom = y >= h / 2;
      // TL red, TR green, BL blue, BR white
      const c = !right && !bottom ? [255, 0, 0] : right && !bottom ? [0, 255, 0] : !right ? [0, 0, 255] : [255, 255, 255];
      rgb[o] = c[0];
      rgb[o + 1] = c[1];
      rgb[o + 2] = c[2];
    }
  }
  return { width: w, height: h, rgb };
}

function jpegOf(size: string, source = "testsrc"): Buffer {
  const r = spawnSync(
    process.env.FFMPEG_PATH || "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `${source}=size=${size}:duration=1`,
      "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
    { maxBuffer: 64 * 1024 * 1024, timeout: 20000 },
  );
  assert.equal(r.status, 0, "could not synthesise a JPEG");
  return r.stdout;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

test("options: defaults are the measured recommendation", () => {
  assert.deepEqual(resolveFaceCropOptions(), { ...FACE_CROP_DEFAULTS });
  assert.deepEqual(
    { ...FACE_CROP_DEFAULTS },
    { margin: 2.5, minSizePx: 288, maxSizePx: 384, qscale: 4, timeoutMs: 3000 },
  );
});

test("geometry: default crop of a 60 px face (the recognition floor) and of a big face", () => {
  const small = computeFaceCropRect([1000, 500, 1060, 560], 3840, 2160)!;
  assert.deepEqual([small.w, small.h, small.outW, small.outH], [288, 288, 288, 288], "min size, native pixels");
  const big = computeFaceCropRect([1000, 500, 1300, 800], 3840, 2160)!;
  assert.deepEqual([big.w, big.h, big.outW, big.outH], [750, 750, 384, 384], "downscaled to the max side");
  const b = boxInCrop([1000, 500, 1300, 800], big);
  assert.ok(b[2] - b[0] > 150, "a downscaled face stays far above the 60 px floor");
});

test("options: explicit > env > default, junk falls back, out-of-range is clamped", () => {
  withEnv({ FACE_CROP_MARGIN: "3", FACE_CROP_MIN_PX: "320", FACE_CROP_QSCALE: "abc", FACE_CROP_TIMEOUT_MS: "5" }, () => {
    const o = resolveFaceCropOptions();
    assert.equal(o.margin, 3);
    assert.equal(o.minSizePx, 320);
    assert.equal(o.qscale, FACE_CROP_DEFAULTS.qscale, "junk falls back to the default");
    assert.equal(o.timeoutMs, 100, "clamped to the floor");
    assert.equal(resolveFaceCropOptions({ margin: 1.5 }).margin, 1.5, "explicit wins over env");
  });
  assert.equal(resolveFaceCropOptions({ margin: 99 }).margin, 6);
  assert.equal(resolveFaceCropOptions({ margin: 0.2 }).margin, 1, "a crop never cuts into the box");
  assert.equal(resolveFaceCropOptions({ qscale: 1 }).qscale, 2);
  assert.equal(resolveFaceCropOptions({ margin: Number.NaN }).margin, FACE_CROP_DEFAULTS.margin);
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

test("geometry: a 2x square centred on the face box", () => {
  // 150 px face in a 4K frame -> 300 px crop, centred, no downscale below the cap.
  const r = computeFaceCropRect([1000, 500, 1150, 650], 3840, 2160, { margin: 2, minSizePx: 224, maxSizePx: 0 })!;
  assert.deepEqual(r, { x: 925, y: 425, w: 300, h: 300, outW: 300, outH: 300 });
});

test("geometry: the longer box side drives the square", () => {
  const r = computeFaceCropRect([100, 100, 180, 220], 1920, 1080, { margin: 2, minSizePx: 0, maxSizePx: 0 })!;
  assert.equal(r.w, 240);
  assert.equal(r.h, 240);
});

test("geometry: small faces get more context up to minSizePx, never an upscale", () => {
  // 60 px face (the recognition floor) * 2 = 120 < 224 -> 224 source pixels.
  const r = computeFaceCropRect([500, 300, 560, 360], 1920, 1080, { margin: 2, minSizePx: 224, maxSizePx: 0 })!;
  assert.equal(r.w, 224);
  assert.equal(r.h, 224);
  assert.equal(r.outW, r.w, "output keeps source resolution");
  assert.equal(r.outH, r.h);
  assert.equal(r.x, 530 - 112);
  assert.equal(r.y, 330 - 112);
});

test("geometry: a face at the edge is shifted inside the picture, not cut", () => {
  const r = computeFaceCropRect([0, 0, 80, 80], 1920, 1080, { margin: 2, minSizePx: 224 })!;
  assert.deepEqual([r.x, r.y, r.w, r.h], [0, 0, 224, 224]);
  const br = computeFaceCropRect([1880, 1040, 1920, 1080], 1920, 1080, { margin: 2, minSizePx: 224 })!;
  assert.equal(br.x + br.w, 1920);
  assert.equal(br.y + br.h, 1080);
  // The face box is fully inside the crop.
  const inCrop = boxInCrop([1880, 1040, 1920, 1080], br);
  assert.ok(inCrop[0] >= 0 && inCrop[1] >= 0 && inCrop[2] <= br.outW && inCrop[3] <= br.outH);
});

test("geometry: a picture smaller than the crop clamps to the picture (non-square allowed)", () => {
  const r = computeFaceCropRect([10, 10, 90, 90], 160, 100, { margin: 2, minSizePx: 224 })!;
  assert.deepEqual([r.x, r.y, r.w, r.h], [0, 0, 160, 100]);
  assert.equal(r.outW, 160);
});

test("geometry: large crops are downscaled to maxSizePx, keeping the aspect", () => {
  const r = computeFaceCropRect([1000, 500, 1400, 900], 3840, 2160, { margin: 2, minSizePx: 224, maxSizePx: 448 })!;
  assert.equal(r.w, 800);
  assert.equal(r.outW, 448);
  assert.equal(r.outH, 448);
  // The face stays well above the 60 px recognition floor after the downscale.
  const b = boxInCrop([1000, 500, 1400, 900], r);
  assert.ok(b[2] - b[0] >= 200);
});

test("geometry: a box partly outside the picture is clipped first", () => {
  const r = computeFaceCropRect([-50, -50, 50, 50], 640, 480, { margin: 2, minSizePx: 0, maxSizePx: 0 })!;
  // Visible part is 50x50 -> 100 px square at the corner.
  assert.deepEqual([r.x, r.y, r.w, r.h], [0, 0, 100, 100]);
});

test("geometry: swapped corners are normalised", () => {
  const a = computeFaceCropRect([200, 200, 100, 100], 640, 480)!;
  const b = computeFaceCropRect([100, 100, 200, 200], 640, 480)!;
  assert.deepEqual(a, b);
});

test("geometry: invalid boxes and pictures return null", () => {
  assert.equal(computeFaceCropRect([0, 0, 0, 0], 640, 480), null, "zero area");
  assert.equal(computeFaceCropRect([700, 500, 800, 600], 640, 480), null, "entirely outside");
  assert.equal(computeFaceCropRect([Number.NaN, 0, 10, 10], 640, 480), null);
  assert.equal(computeFaceCropRect([0, 0, Infinity, 10], 640, 480), null);
  assert.equal(computeFaceCropRect([0, 0, 10] as unknown as [number, number, number, number], 640, 480), null);
  assert.equal(computeFaceCropRect([0, 0, 10, 10], 0, 480), null);
  assert.equal(computeFaceCropRect([0, 0, 10, 10], 640.5, 480), null);
});

test("geometry: rectangles are integral and even where the picture allows", () => {
  for (const box of [[101.3, 57.9, 173.2, 141.7], [3, 3, 64, 70], [900, 500, 1011, 633]] as const) {
    const r = computeFaceCropRect(box, 1920, 1080, { margin: 1.7, minSizePx: 0, maxSizePx: 0 })!;
    for (const v of [r.x, r.y, r.w, r.h]) assert.ok(Number.isInteger(v));
    assert.equal(r.w % 2, 0);
    assert.equal(r.h % 2, 0);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1920 && r.y + r.h <= 1080);
  }
});

test("geometry: deterministic for the same input", () => {
  const a = computeFaceCropRect([321, 123, 400, 222], 1920, 1080);
  const b = computeFaceCropRect([321, 123, 400, 222], 1920, 1080);
  assert.deepEqual(a, b);
});

test("sliceRgb: copies exactly the requested rows and columns", () => {
  const pic = quadrants(8, 8);
  const out = sliceRgb(pic.rgb, 8, 8, { x: 3, y: 3, w: 2, h: 2, outW: 2, outH: 2 })!;
  // TL red, TR green, BL blue, BR white.
  assert.deepEqual([...out], [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  assert.equal(sliceRgb(pic.rgb, 8, 8, { x: 7, y: 0, w: 2, h: 2, outW: 2, outH: 2 }), null, "out of bounds");
  assert.equal(sliceRgb(pic.rgb.subarray(0, 10), 8, 8, { x: 0, y: 0, w: 2, h: 2, outW: 2, outH: 2 }), null, "short buffer");
});

test("encodedImageSize: PNG, JPEG and garbage", () => {
  const png = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(320, 16);
  png.writeUInt32BE(240, 20);
  assert.deepEqual(encodedImageSize(png), { width: 320, height: 240 });
  assert.equal(encodedImageSize(Buffer.from("not an image at all, not at all")), null);
  assert.equal(encodedImageSize(Buffer.alloc(4)), null);
});

// ---------------------------------------------------------------------------
// Never-throw contract without ffmpeg work
// ---------------------------------------------------------------------------

test("cropFaceFromRgb: bad pictures and boxes resolve null", async () => {
  const pic = quadrants(64, 64);
  assert.equal(await cropFaceFromRgb(pic, [0, 0, 0, 0]), null);
  assert.equal(await cropFaceFromRgb(pic, [100, 100, 120, 120]), null);
  assert.equal(await cropFaceFromRgb({ width: 64, height: 64, rgb: new Uint8Array(10) }, [0, 0, 10, 10]), null, "short buffer");
  assert.equal(await cropFaceFromRgb(null as unknown as Frame, [0, 0, 10, 10]), null);
  assert.equal(await cropFaceFromRgb({ width: 64, height: 64, rgb: "x" } as unknown as Frame, [0, 0, 10, 10]), null);
});

test("cropFaceFromImage: corrupted and empty inputs resolve null", async () => {
  assert.equal(await cropFaceFromImage(Buffer.alloc(0), [0, 0, 10, 10]), null);
  assert.equal(await cropFaceFromImage("", [0, 0, 10, 10]), null);
  assert.equal(await cropFaceFromImage("data:image/jpeg;base64,", [0, 0, 10, 10]), null);
  assert.equal(await cropFaceFromImage(Buffer.from("definitely not a jpeg, just text"), [0, 0, 10, 10]), null);
  assert.equal(await cropFaceFromImage(123 as unknown as Buffer, [0, 0, 10, 10]), null);
});

test("crop: a missing ffmpeg binary resolves null", async () => {
  const saved = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = "/nonexistent/ffmpeg-for-test";
  try {
    assert.equal(await cropFaceFromRgb(quadrants(64, 64), [10, 10, 50, 50]), null);
  } finally {
    if (saved === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = saved;
  }
});

test("crop: a hung ffmpeg is killed at the timeout and resolves null", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "facecrop-"));
  const fake = path.join(dir, "ffmpeg");
  fs.writeFileSync(fake, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const saved = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = fake;
  try {
    const t0 = Date.now();
    const out = await cropFaceFromRgb(quadrants(64, 64), [10, 10, 50, 50], { timeoutMs: 300 });
    const took = Date.now() - t0;
    assert.equal(out, null);
    assert.ok(took < 5000, `timeout honoured (${took} ms)`);
  } finally {
    if (saved === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("crop: output that is not a JPEG is rejected", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "facecrop-"));
  const fake = path.join(dir, "ffmpeg");
  fs.writeFileSync(fake, "#!/bin/sh\ncat >/dev/null\necho not-a-jpeg\n", { mode: 0o755 });
  const saved = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = fake;
  try {
    assert.equal(await cropFaceFromRgb(quadrants(64, 64), [10, 10, 50, 50]), null);
  } finally {
    if (saved === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Real ffmpeg encoding
// ---------------------------------------------------------------------------

test("cropFaceFromRgb: JPEG of the expected size and the right pixels", async (t) => {
  if (!FFMPEG) return t.skip("ffmpeg not on PATH");
  const pic = quadrants(1280, 720);
  // Box centred on the quadrant corner: the crop must show all four colours in place.
  const box: [number, number, number, number] = [600, 320, 680, 400];
  const jpeg = await cropFaceFromRgb(pic, box, { margin: 2, minSizePx: 224, maxSizePx: 0 });
  assert.ok(jpeg, "crop produced");
  assert.equal(jpeg![0], 0xff);
  assert.equal(jpeg![1], 0xd8);
  assert.deepEqual(encodedImageSize(jpeg!), { width: 224, height: 224 });
  const back = await loadImage(jpeg!);
  assert.ok(back);
  const px = (x: number, y: number) => [...back!.data.subarray((y * 224 + x) * 3, (y * 224 + x) * 3 + 3)];
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 40);
  assert.ok(near(px(20, 20), [255, 0, 0]), `top-left red, got ${px(20, 20)}`);
  assert.ok(near(px(200, 20), [0, 255, 0]), `top-right green, got ${px(200, 20)}`);
  assert.ok(near(px(20, 200), [0, 0, 255]), `bottom-left blue, got ${px(20, 200)}`);
  assert.ok(near(px(200, 200), [255, 255, 255]), `bottom-right white, got ${px(200, 200)}`);
});

test("cropFaceFromRgb: works on a pipeline Frame (box in frame/ROI coordinates)", async (t) => {
  if (!FFMPEG) return t.skip("ffmpeg not on PATH");
  const pic = quadrants(640, 360);
  const frame: Frame = {
    gate: "exit", streamId: "exit-test", seq: 1, capturedAtMs: Date.now(),
    width: 640, height: 360, roi: [640, 360, 640, 360], sourceWidth: 1920, sourceHeight: 1080, rgb: pic.rgb,
  };
  const jpeg = await cropFaceFromRgb(frame, [300, 160, 400, 260]);
  assert.ok(jpeg);
  assert.deepEqual(encodedImageSize(jpeg!), { width: 288, height: 288 }, "defaults: 2.5 x 100 px < 288 px floor");
});

test("cropFaceFromRgb: downscale to maxSizePx and quality changes size", async (t) => {
  if (!FFMPEG) return t.skip("ffmpeg not on PATH");
  const pic = quadrants(1920, 1080);
  const big = await cropFaceFromRgb(pic, [700, 300, 1100, 700], { maxSizePx: 320 });
  assert.deepEqual(encodedImageSize(big!), { width: 320, height: 320 });
});

test("cropFaceFromImage: crops a JPEG, a base64 string and a data URL identically", async (t) => {
  if (!FFMPEG) return t.skip("ffmpeg not on PATH");
  const src = jpegOf("1280x720");
  const box: [number, number, number, number] = [500, 200, 620, 330];
  const opts = { margin: 2, minSizePx: 224, maxSizePx: 0 };
  const a = await cropFaceFromImage(src, box, opts);
  const b = await cropFaceFromImage(cropToDataUrl(src), box, opts);
  const c = await cropFaceFromImage(src.toString("base64"), box, opts);
  assert.ok(a && b && c);
  assert.deepEqual(encodedImageSize(a!), { width: 260, height: 260 });
  assert.ok(a!.equals(b!) && a!.equals(c!), "same bytes regardless of the input wrapping");
  assert.ok(cropToDataUrl(a!).startsWith("data:image/jpeg;base64,/9j/"));
});

test("cropFaceFromImage: a JPEG header wrapping junk resolves null", async (t) => {
  if (!FFMPEG) return t.skip("ffmpeg not on PATH");
  const src = jpegOf("320x240");
  const broken = Buffer.concat([src.subarray(0, 200), Buffer.alloc(400, 0x41)]);
  assert.equal(await cropFaceFromImage(broken, [100, 80, 160, 140]), null);
});

test("crop: concurrent crops all complete (no shared state between calls)", async (t) => {
  if (!FFMPEG) return t.skip("ffmpeg not on PATH");
  const pic = quadrants(640, 480);
  const boxes = Array.from({ length: 8 }, (_, i) => [40 * i, 30 * i, 40 * i + 80, 30 * i + 80] as [number, number, number, number]);
  const out = await Promise.all(boxes.map((b) => cropFaceFromRgb(pic, b)));
  assert.ok(out.every((j) => j && j[0] === 0xff && j[1] === 0xd8));
});
