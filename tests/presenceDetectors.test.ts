/**
 * Presence detectors (P2): the P1 pre/post-processing ported to production.
 * Expected values follow the P1 harness formulas (tools/presence-eval/run-models.ts
 * geometry()/fillTensor()/nms(), score.py drop_overlays(), combine.py nms());
 * no camera footage is used (biometric data stays out of the repository; the
 * real-model parity check is tools/presence-eval/parity.ts, run offline).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  MODEL_PREPROCESS,
  OnnxPersonDetector,
  applyMask,
  boxIou,
  decodeDetections,
  fillTensor,
  inputGeometry,
  mergeDetections,
  modelTag,
  nmsDetections,
  resizeRgb,
  sha256File,
} from "../src/server/presence/detectors";
import { DEFAULT_PRESENCE_MASKS, DEFAULT_PRESENCE_MODELS, parseWorkingHours, presenceSettingsFromEnv } from "../src/server/presence/presenceConfig";
import type { PersonDetection } from "../src/server/presence/contracts";

const close = (a: number, b: number, eps = 1e-5) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

describe("presence detectors: input geometry (P1 geometry())", () => {
  it("960x540 frame at 960 px: no resize, height padded to 544", () => {
    assert.deepEqual(inputGeometry(960, 540, 960), { contentW: 960, contentH: 540, inW: 960, inH: 544, scale: 1 });
  });
  it("1920x1080 frame at 960 px: content 960x540, scale 0.5 (the P1 harness case)", () => {
    assert.deepEqual(inputGeometry(1920, 1080, 960), { contentW: 960, contentH: 540, inW: 960, inH: 544, scale: 0.5 });
  });
  it("416 px input: 416x256 with content 416x234 (P1 'native')", () => {
    const g = inputGeometry(960, 540, 416);
    assert.equal(g.inW, 416);
    assert.equal(g.inH, 256);
    assert.equal(g.contentH, 234);
  });
  it("rejects nonsense sizes", () => {
    assert.throws(() => inputGeometry(0, 540, 960), RangeError);
  });
});

describe("presence detectors: tensor fill (P1 fillTensor(), NCHW, BGR)", () => {
  const g = { contentW: 2, contentH: 1, inW: 4, inH: 2, scale: 1 };
  const rgb = new Uint8Array([10, 20, 30, 200, 100, 50]); // two pixels
  const plane = g.inW * g.inH;
  it("YOLOX: raw 0-255 values in B, G, R planes; pad 114", () => {
    const t = fillTensor(rgb, g, MODEL_PREPROCESS["yolox-nano"]);
    assert.equal(t.length, 3 * plane);
    assert.deepEqual([t[0], t[plane], t[2 * plane]], [30, 20, 10]);
    assert.deepEqual([t[1], t[plane + 1], t[2 * plane + 1]], [50, 100, 200]);
    assert.equal(t[2], 114); // right of the content
    assert.equal(t[g.inW], 114); // row below the content
  });
  it("RTMDet: ImageNet mean/std in BGR order; pad normalised too", () => {
    const p = MODEL_PREPROCESS["rtmdet-tiny"];
    const t = fillTensor(rgb, g, p);
    close(t[0], (30 - 103.53) / 57.375);
    close(t[plane], (20 - 116.28) / 57.12);
    close(t[2 * plane], (10 - 123.675) / 58.395);
    close(t[3], (114 - 103.53) / 57.375);
    close(t[2 * plane + 5], (114 - 123.675) / 58.395);
  });
  it("reuses a caller buffer of the right size", () => {
    const buf = new Float32Array(3 * plane);
    assert.equal(fillTensor(rgb, g, MODEL_PREPROCESS["yolox-nano"], buf), buf);
  });
});

describe("presence detectors: resize", () => {
  it("returns the same buffer when no resize is needed", () => {
    const rgb = new Uint8Array(4 * 2 * 3);
    assert.equal(resizeRgb(rgb, 4, 2, 4, 2), rgb);
  });
  it("keeps a uniform picture uniform when downscaling 2x", () => {
    const rgb = new Uint8Array(8 * 4 * 3).fill(77);
    const out = resizeRgb(rgb, 8, 4, 4, 2);
    assert.equal(out.length, 4 * 2 * 3);
    assert.ok(out.every((v) => v === 77));
  });
});

describe("presence detectors: NMS, mask, merge", () => {
  const det = (box: [number, number, number, number], score: number, model: PersonDetection["model"] = "yolox-nano"): PersonDetection => ({ box, score, model });
  it("IoU of identical / disjoint / half-overlapping boxes", () => {
    assert.equal(boxIou([0, 0, 10, 10], [0, 0, 10, 10]), 1);
    assert.equal(boxIou([0, 0, 10, 10], [20, 20, 30, 30]), 0);
    close(boxIou([0, 0, 10, 10], [5, 0, 15, 10]), 50 / 150);
  });
  it("NMS keeps the higher score and suppresses IoU > 0.5 only", () => {
    const a = det([0, 0, 10, 10], 0.9);
    const b = det([1, 0, 11, 10], 0.6); // IoU 0.818 -> dropped
    const c = det([0, 0, 10, 10], 0.5);
    const d = det([30, 30, 40, 40], 0.4);
    assert.deepEqual(nmsDetections([b, c, a, d]), [a, d]);
    // IoU exactly 0.5 is kept (P1: suppress only when > thr)
    const e = det([0, 0, 10, 10], 0.8);
    const f = det([0, 0, 10, 5], 0.7); // IoU 0.5
    assert.equal(nmsDetections([e, f]).length, 2);
  });
  it("cross-model merge is one NMS over both models' boxes (P1b union)", () => {
    const y = det([100, 100, 140, 200], 0.6, "yolox-nano");
    const r = det([102, 100, 142, 202], 0.7, "rtmdet-tiny");
    const r2 = det([300, 100, 340, 200], 0.35, "rtmdet-tiny");
    const m = mergeDetections([y], [r, r2]);
    assert.deepEqual(m.map((x) => x.model), ["rtmdet-tiny", "rtmdet-tiny"]);
  });
  it("mask drops boxes >= 50 % inside the overlay, keeps the others", () => {
    const mask = DEFAULT_PRESENCE_MASKS.entry; // OSD clock bottom-left: [0, 0.93, 0.35, 0.07]
    const W = 1000;
    const H = 1000;
    const inOsd = det([50, 940, 80, 990], 0.9); // fully inside
    const half = det([100, 910, 140, 950], 0.9); // y 910-950: 20 of 40 inside -> 50 % -> dropped
    const less = det([100, 900, 140, 950], 0.9); // 20 of 50 inside -> 40 % -> kept
    const free = det([500, 400, 560, 600], 0.9);
    assert.deepEqual(applyMask([inOsd, half, less, free], mask, W, H), [less, free]);
  });
});

describe("presence detectors: decode to source pixels", () => {
  const g = inputGeometry(960, 540, 960);
  const frame = { width: 960, height: 540, sourceWidth: 3840, sourceHeight: 2160 };
  const out = new Float32Array([
    100, 100, 140, 220, 0.8, // person
    101, 101, 141, 221, 0.7, // duplicate -> NMS
    500, 100, 540, 220, 0.5, // below YOLOX threshold 0.55
    10, 510, 60, 539, 0.9, // OSD clock area (bottom-left) -> masked
    940, 500, 1000, 560, 0.9, // runs past the picture -> clamped
  ]);
  it("threshold, NMS, mask and frame -> source scaling (x4), clamped", () => {
    const dets = decodeDetections(out, 5, g, frame, DEFAULT_PRESENCE_MODELS["yolox-nano"], DEFAULT_PRESENCE_MASKS.entry);
    assert.equal(dets.length, 2);
    // highest score first: the clamped edge box (0.9), then the person (0.8)
    assert.deepEqual(dets[0].box, [3760, 2000, 3840, 2160]);
    assert.deepEqual(dets[1], { box: [400, 400, 560, 880], score: out[4], model: "yolox-nano" });
  });
  it("uses the RTMDet threshold (0.30) for RTMDet", () => {
    const dets = decodeDetections(out, 5, g, frame, DEFAULT_PRESENCE_MODELS["rtmdet-tiny"], []);
    assert.equal(dets.filter((d) => d.model === "rtmdet-tiny").length, 4); // 0.8, 0.5, 0.9 (OSD unmasked), 0.9
  });
  it("without a source size the boxes stay in frame pixels", () => {
    const dets = decodeDetections(out, 1, g, { width: 960, height: 540 }, DEFAULT_PRESENCE_MODELS["yolox-nano"], []);
    assert.deepEqual(dets[0].box, [100, 100, 140, 220]);
  });
  it("frames larger than the input: boxes divided by the content scale", () => {
    const g2 = inputGeometry(1920, 1080, 960);
    const dets = decodeDetections(new Float32Array([100, 100, 140, 220, 0.9]), 1, g2, { width: 1920, height: 1080 }, DEFAULT_PRESENCE_MODELS["yolox-nano"], []);
    assert.deepEqual(dets[0].box, [200, 200, 280, 440]);
  });
});

describe("presence detectors: model file verification (fail closed)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "presence-models-"));
  const file = "yolox_nano_person.onnx";
  fs.writeFileSync(path.join(tmp, file), "not an onnx model");
  const realSha = createHash("sha256").update("not an onnx model").digest("hex");
  const make = (over: Partial<typeof DEFAULT_PRESENCE_MODELS["yolox-nano"]>, dir = tmp) =>
    new OnnxPersonDetector({ model: { ...DEFAULT_PRESENCE_MODELS["yolox-nano"], ...over }, modelDir: dir, mask: [] });

  it("sha256File hashes the file", async () => {
    assert.equal(await sha256File(path.join(tmp, file)), realSha);
  });
  it("missing file -> not ready, reason given", async () => {
    const d = make({}, path.join(tmp, "nope"));
    assert.equal(await d.load(), false);
    assert.equal(d.ready(), false);
    assert.match(String(d.error()), /model file missing/);
  });
  it("sha256 mismatch -> refused", async () => {
    const d = make({});
    assert.equal(await d.load(), false);
    assert.match(String(d.error()), /sha256 mismatch/);
    await assert.rejects(() => d.detect({ width: 2, height: 2, rgb: new Uint8Array(12), capturedAtMs: 0 }), /not loaded/);
  });
  it("no configured sha256 / path in the file name -> refused", async () => {
    const a = make({ sha256: "" });
    assert.equal(await a.load(), false);
    assert.match(String(a.error()), /no valid sha256/);
    const b = make({ file: "../yolox_nano_person.onnx", sha256: realSha });
    assert.equal(await b.load(), false);
    assert.match(String(b.error()), /invalid model file name/);
  });
  it("matching sha256 but not a valid model -> the ONNX load error is kept, still not ready", async () => {
    const d = make({ sha256: realSha });
    assert.equal(await d.load(), false);
    assert.equal(d.ready(), false);
    assert.ok(d.error() && !/sha256/.test(String(d.error())));
  });
  it("model tag is id@sha prefix", () => {
    assert.equal(modelTag(DEFAULT_PRESENCE_MODELS["rtmdet-tiny"]), "rtmdet-tiny@31aa4d63d4fb");
  });

  const realDir = process.env.PRESENCE_TEST_MODEL_DIR;
  it("real models (PRESENCE_TEST_MODEL_DIR): load, and a blank frame gives no person", { skip: !realDir }, async () => {
    for (const id of ["yolox-nano", "rtmdet-tiny"] as const) {
      const d = new OnnxPersonDetector({ model: DEFAULT_PRESENCE_MODELS[id], modelDir: String(realDir), mask: [] });
      assert.equal(await d.load(), true, String(d.error()));
      const dets = await d.detect({ width: 960, height: 540, rgb: new Uint8Array(960 * 540 * 3).fill(128), capturedAtMs: 0 });
      assert.deepEqual(dets, []);
      assert.ok((d.lastRunMs() ?? 0) > 0);
    }
  });
});

describe("presence settings from the environment", () => {
  it("defaults are the P1b operating point", () => {
    const { settings, errors } = presenceSettingsFromEnv({});
    assert.deepEqual(errors, []);
    assert.equal(settings.modelDir, "/app/models/presence");
    assert.equal(settings.fps, 2);
    assert.equal(settings.rtmdetEvery, 4);
    assert.equal(settings.models.primary.threshold, 0.55);
    assert.equal(settings.models.secondary.threshold, 0.3);
    assert.equal(settings.rules.minInViewMsWorking, 3000);
    assert.equal(settings.rules.minInViewMsAfterHours, 1000);
    assert.equal(settings.rules.linkGapMs, 2000);
    assert.deepEqual(settings.rules.workingHours, { start: "07:00", end: "19:00", timeZone: "Asia/Ho_Chi_Minh" });
    assert.equal(settings.ortThreads, 1);
    assert.equal(settings.workerNice, 19);
  });
  it("valid overrides apply; invalid ones fall back and are reported", () => {
    const { settings, errors } = presenceSettingsFromEnv({
      PRESENCE_MODEL_DIR: "/m", PRESENCE_FPS: "3", PRESENCE_WORKING_HOURS: "08:30-17:00",
      PRESENCE_MIN_SECONDS_WORKING: "abc", PRESENCE_RTMDET_EVERY: "0",
    });
    assert.equal(settings.modelDir, "/m");
    assert.equal(settings.fps, 3);
    assert.deepEqual([settings.rules.workingHours.start, settings.rules.workingHours.end], ["08:30", "17:00"]);
    assert.equal(settings.rules.minInViewMsWorking, 3000);
    assert.equal(settings.rtmdetEvery, 4);
    assert.equal(errors.length, 2);
  });
  it("working hours parser", () => {
    assert.deepEqual(parseWorkingHours("07:00-19:00"), { start: "07:00", end: "19:00" });
    assert.equal(parseWorkingHours("7-19"), null);
    assert.equal(parseWorkingHours("07:00-07:00"), null);
  });
});
