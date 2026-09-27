/**
 * Detector input geometry of the real-time pipeline (src/server/pipeline/detectInput.ts):
 * setting parser, aspect-preserving shape derivation, tile geometry, tile-to-frame
 * mapping, merge of tile detections, plan execution with a fake detector, and the
 * fail-closed compatibility check against the loaded detector graph. Pure; no models.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TILE_OVERLAP,
  cropRgb,
  deriveDetectShape,
  describeDetectInput,
  detectPlanIssue,
  detectWithPlan,
  mapFromTile,
  mergeTileDetections,
  parseDetectInput,
  squareScale,
  tileGeometry,
  type DetectFn,
} from "../src/server/pipeline/detectInput";
import { PipelineCore, type PipelineEngine } from "../src/server/pipeline/pipelineCore";
import type { FaceBox, RgbImage } from "../src/server/faceEmbedding";

const face = (x1: number, y1: number, x2: number, y2: number, score = 0.9): FaceBox => ({
  box: [x1, y1, x2, y2],
  score,
  landmarks: [
    [x1 + (x2 - x1) * 0.3, y1 + (y2 - y1) * 0.35],
    [x1 + (x2 - x1) * 0.7, y1 + (y2 - y1) * 0.35],
    [x1 + (x2 - x1) * 0.5, y1 + (y2 - y1) * 0.55],
    [x1 + (x2 - x1) * 0.35, y1 + (y2 - y1) * 0.8],
    [x1 + (x2 - x1) * 0.65, y1 + (y2 - y1) * 0.8],
  ],
});

function patternImage(w: number, h: number): RgbImage {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 3;
    data[o] = x & 255;
    data[o + 1] = y & 255;
    data[o + 2] = (x * 7 + y * 13) & 255;
  }
  return { width: w, height: h, data };
}

describe("parseDetectInput", () => {
  it("blank and 'square' mean the legacy square letterbox", () => {
    assert.deepEqual(parseDetectInput(undefined), { plan: { kind: "square" } });
    assert.deepEqual(parseDetectInput(""), { plan: { kind: "square" } });
    assert.deepEqual(parseDetectInput("  Square "), { plan: { kind: "square" } });
  });
  it("auto, auto:<n>, <W>x<H> and tiles:<n>[:<overlap>]", () => {
    assert.deepEqual(parseDetectInput("auto"), { plan: { kind: "auto", budgetPx: 640 * 640 } });
    assert.deepEqual(parseDetectInput("AUTO:800"), { plan: { kind: "auto", budgetPx: 800 * 800 } });
    assert.deepEqual(parseDetectInput("1824x224"), { plan: { kind: "fixed", width: 1824, height: 224 } });
    assert.deepEqual(parseDetectInput("tiles:4"), { plan: { kind: "tiles", count: 4, overlap: DEFAULT_TILE_OVERLAP } });
    assert.deepEqual(parseDetectInput("tiles:3:30"), { plan: { kind: "tiles", count: 3, overlap: 0.3 } });
  });
  it("rejects what it cannot run, and says why (the worker fails closed on it)", () => {
    for (const [raw, why] of [
      ["1000x224", /multiples of 32/],
      ["1824x16", /multiples of 32/],
      ["auto:100", /320\.\.2560/],
      ["auto:700", /multiple of 32/],
      ["tiles:1", /2\.\.12/],
      ["tiles:13", /2\.\.12/],
      ["tiles:4:60", /0\.\.50/],
      ["wide", /expected/],
      ["1280", /expected/],
    ] as const) {
      const r = parseDetectInput(raw);
      assert.equal(r.plan.kind, "square", raw);
      assert.match(r.error || "", why, raw);
      assert.match(r.error || "", /PIPELINE_DETECT_INPUT=/);
    }
  });
  it("describes plans the way the setting is written", () => {
    assert.equal(describeDetectInput(parseDetectInput("auto").plan), "auto");
    assert.equal(describeDetectInput(parseDetectInput("auto:960").plan), "auto:960");
    assert.equal(describeDetectInput(parseDetectInput("1824x224").plan), "1824x224");
    assert.equal(describeDetectInput(parseDetectInput("tiles:4").plan), "tiles:4:20");
    assert.equal(describeDetectInput({ kind: "square" }), "square");
  });
});

describe("deriveDetectShape", () => {
  it("keeps the gate area's aspect inside the 640x640 pixel budget (site geometries)", () => {
    // NVR-measured entry strip: square 640 gives scale 0.188 (60 px -> 11 px).
    assert.deepEqual(deriveDetectShape(3408, 456), { width: 1696, height: 224, scale: Math.min(1696 / 3408, 224 / 456) });
    assert.ok(deriveDetectShape(3408, 456).scale > 0.49 && squareScale(3408, 456, 640) < 0.19);
    // Scripted entry area 2074x432.
    assert.deepEqual(deriveDetectShape(2074, 432), { width: 1408, height: 288, scale: Math.min(1408 / 2074, 288 / 432) });
    // Exit area 1777x681 also gains (0.36 -> 0.56).
    const exit = deriveDetectShape(1777, 681);
    assert.deepEqual([exit.width, exit.height], [1024, 384]);
    assert.ok(exit.scale > 0.56 && squareScale(1777, 681, 640) < 0.37);
  });
  it("sides are multiples of 32, the product stays within the budget, never upscales", () => {
    for (const [w, h, budgetSide] of [[3408, 456, 640], [2074, 432, 640], [1920, 1080, 640], [640, 360, 640], [100, 3000, 640], [3408, 456, 960], [5000, 5000, 320]] as const) {
      const s = deriveDetectShape(w, h, budgetSide * budgetSide);
      assert.equal(s.width % 32, 0);
      assert.equal(s.height % 32, 0);
      assert.ok(s.width * s.height <= budgetSide * budgetSide, `${w}x${h}: ${s.width}x${s.height} over budget`);
      assert.ok(s.scale <= 1 + 1e-9);
      assert.ok(Math.abs(s.scale - Math.min(1, s.width / w, s.height / h)) < 1e-9);
    }
  });
  it("a frame smaller than the budget is taken at scale 1 on the smallest fitting canvas", () => {
    assert.deepEqual(deriveDetectShape(640, 360), { width: 640, height: 384, scale: 1 });
    assert.deepEqual(deriveDetectShape(320, 320), { width: 320, height: 320, scale: 1 });
    assert.deepEqual(deriveDetectShape(100, 40), { width: 128, height: 64, scale: 1 });
  });
  it("trims padding: the picture fills each side to within one stride", () => {
    for (const [w, h] of [[3408, 456], [2074, 432], [1777, 681], [456, 3408]] as const) {
      const s = deriveDetectShape(w, h);
      assert.ok(s.width - w * s.scale < 32 + 1e-6, `${w}x${h}: ${s.width} vs ${w * s.scale}`);
      assert.ok(s.height - h * s.scale < 32 + 1e-6, `${w}x${h}: ${s.height} vs ${h * s.scale}`);
    }
  });
  it("maximises the letterbox scale over every 32-aligned candidate (brute force agrees)", () => {
    for (const [w, h] of [[3408, 456], [2074, 432], [1777, 681], [1280, 720], [456, 3408]] as const) {
      const got = deriveDetectShape(w, h);
      let best = 0;
      for (let H = 32; H <= 4096; H += 32) for (let W = 32; W <= 4096; W += 32) {
        if (W * H > 640 * 640) continue;
        best = Math.max(best, Math.min(1, W / w, H / h));
      }
      assert.ok(Math.abs(got.scale - best) < 1e-9, `${w}x${h}: ${got.scale} vs brute ${best}`);
    }
  });
  it("is deterministic and tolerant of odd inputs", () => {
    assert.deepEqual(deriveDetectShape(3408, 456), deriveDetectShape(3408, 456));
    assert.deepEqual(deriveDetectShape(0, 0), deriveDetectShape(1, 1));
    const tall = deriveDetectShape(456, 3408);
    assert.deepEqual([tall.width, tall.height], [224, 1696]);
  });
});

describe("tileGeometry", () => {
  it("covers the long axis with overlapping tiles that end at the edge", () => {
    const tiles = tileGeometry(3408, 456, 4, 0.2);
    assert.equal(tiles.length, 4);
    assert.equal(tiles[0].x, 0);
    assert.equal(tiles[3].x + tiles[3].w, 3408);
    for (const t of tiles) {
      assert.equal(t.y, 0);
      assert.equal(t.h, 456);
      assert.ok(Number.isInteger(t.x) && Number.isInteger(t.w));
      assert.ok(t.x >= 0 && t.x + t.w <= 3408);
    }
    for (let i = 1; i < tiles.length; i++) {
      const overlap = tiles[i - 1].x + tiles[i - 1].w - tiles[i].x;
      assert.ok(overlap >= Math.floor(tiles[i].w * 0.2) - 2, `overlap ${overlap} too small at ${i}`);
      assert.ok(tiles[i].x > tiles[i - 1].x);
    }
    // Each tile is ~ length / (n - (n-1)*overlap): 3408 / 3.4 = 1003.
    assert.ok(Math.abs(tiles[0].w - 1003) <= 1);
  });
  it("tiles the vertical axis of a tall frame, and count 1 is the whole frame", () => {
    const tiles = tileGeometry(456, 3408, 3);
    assert.equal(tiles.length, 3);
    for (const t of tiles) assert.deepEqual([t.x, t.w], [0, 456]);
    assert.equal(tiles[2].y + tiles[2].h, 3408);
    assert.deepEqual(tileGeometry(300, 200, 1), [{ x: 0, y: 0, w: 300, h: 200 }]);
  });
  it("zero overlap gives disjoint contiguous tiles; overlap is clamped to 50%", () => {
    const t0 = tileGeometry(1000, 100, 4, 0);
    assert.deepEqual(t0.map((t) => t.x), [0, 250, 500, 750]);
    const t9 = tileGeometry(1000, 100, 2, 0.9);
    assert.ok(t9[0].w <= Math.ceil(1000 / 1.5) + 1);
  });
});

describe("cropRgb / mapFromTile", () => {
  it("copies exactly the tile's pixels and returns the frame itself for a full tile", () => {
    const img = patternImage(50, 20);
    const tile = { x: 10, y: 5, w: 20, h: 8 };
    const c = cropRgb(img, tile);
    assert.equal(c.width, 20);
    assert.equal(c.height, 8);
    assert.equal(c.data.length, 20 * 8 * 3);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 20; x++) {
      const s = ((y + 5) * 50 + x + 10) * 3;
      const d = (y * 20 + x) * 3;
      assert.equal(c.data[d], img.data[s]);
      assert.equal(c.data[d + 1], img.data[s + 1]);
      assert.equal(c.data[d + 2], img.data[s + 2]);
    }
    assert.equal(cropRgb(img, { x: 0, y: 0, w: 50, h: 20 }), img);
    const clamped = cropRgb(img, { x: 45, y: 15, w: 20, h: 20 });
    assert.deepEqual([clamped.width, clamped.height], [5, 5]);
  });
  it("shifts boxes and landmarks by the tile origin only", () => {
    const [m] = mapFromTile([face(10, 20, 70, 90, 0.8)], { x: 1000, y: 30, w: 500, h: 400 });
    assert.deepEqual(m.box, [1010, 50, 1070, 120]);
    assert.equal(m.score, 0.8);
    assert.equal(m.landmarks.length, 5);
    assert.deepEqual(m.landmarks[0], [10 + 60 * 0.3 + 1000, 20 + 70 * 0.35 + 30]);
  });
});

describe("mergeTileDetections", () => {
  it("keeps one detection for a face seen whole by two overlapping tiles", () => {
    const a = face(1000, 100, 1080, 190, 0.92);
    const b = face(1002, 101, 1081, 191, 0.88);
    const merged = mergeTileDetections([b, a], 0.4);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].score, 0.92);
  });
  it("drops the cut-off box a tile edge produced, even at low IoU", () => {
    const whole = face(1000, 100, 1080, 190, 0.9);
    const cut = face(1060, 102, 1080, 188, 0.6); // right 20 px of the same face, seen by the next tile
    assert.ok(mergeTileDetections([whole, cut], 0.4).length === 1);
    // ... but two genuinely different faces side by side both survive.
    const other = face(1090, 100, 1170, 190, 0.7);
    const both = mergeTileDetections([whole, other], 0.4);
    assert.deepEqual(both.map((f) => f.score), [0.9, 0.7]);
  });
  it("orders by score and passes single detections through", () => {
    const one = [face(0, 0, 10, 10)];
    assert.deepEqual(mergeTileDetections(one, 0.4), one);
    assert.deepEqual(mergeTileDetections([], 0.4), []);
  });
});

describe("detectWithPlan", () => {
  const calls: Array<{ w: number; h: number; shape?: { width: number; height: number } }> = [];
  const fakeDetect: DetectFn = async (img, options) => {
    calls.push({ w: img.width, h: img.height, shape: options?.inputShape });
    // One face in the middle of whatever it was given, in that image's own coordinates.
    return [face(img.width / 2 - 30, img.height / 2 - 30, img.width / 2 + 30, img.height / 2 + 30, 0.9)];
  };
  const frame = patternImage(3408, 456);

  it("square passes no shape; auto/fixed pass the derived shape and keep frame coordinates", async () => {
    calls.length = 0;
    const sq = await detectWithPlan(fakeDetect, frame, { kind: "square" }, { squareSize: 640, nmsIou: 0.4 });
    assert.equal(calls[0].shape, undefined);
    assert.equal(sq.info.runs, 1);
    assert.match(sq.info.input, /^640x640 \(scale 0\.19\)/);

    calls.length = 0;
    const auto = await detectWithPlan(fakeDetect, frame, { kind: "auto", budgetPx: 640 * 640 }, { squareSize: 640, nmsIou: 0.4 });
    assert.deepEqual(calls[0].shape, { width: 1696, height: 224 });
    assert.deepEqual(auto.faces[0].box, [1704 - 30, 228 - 30, 1704 + 30, 228 + 30]);
    assert.equal(auto.info.input, "1696x224 (scale 0.49)");

    calls.length = 0;
    const fixed = await detectWithPlan(fakeDetect, frame, { kind: "fixed", width: 1600, height: 256 }, { squareSize: 640, nmsIou: 0.4 });
    assert.deepEqual(calls[0].shape, { width: 1600, height: 256 });
    assert.equal(fixed.info.plan, "1600x256");
  });

  it("tiles run the detector once per tile on the crop and merge duplicates back in frame coordinates", async () => {
    calls.length = 0;
    const r = await detectWithPlan(fakeDetect, frame, { kind: "tiles", count: 4, overlap: 0.2 }, { squareSize: 640, nmsIou: 0.4 });
    assert.equal(calls.length, 4);
    assert.equal(r.info.runs, 4);
    for (const c of calls) {
      assert.equal(c.shape, undefined, "tiles use the detector's own square");
      assert.equal(c.h, 456);
      assert.ok(c.w < 3408 && c.w > 900);
    }
    // The fake puts a face in the middle of every tile: four distinct faces, each inside the frame.
    assert.equal(r.faces.length, 4);
    const tiles = tileGeometry(3408, 456, 4, 0.2);
    for (let i = 0; i < 4; i++) {
      const cx = tiles[i].x + tiles[i].w / 2;
      assert.ok(r.faces.some((f) => Math.abs((f.box[0] + f.box[2]) / 2 - cx) < 1), `face of tile ${i} missing`);
    }
    assert.match(r.info.input, /^4 tiles of \d+x456 -> 640/);
  });

  it("a face on a tile seam is reported once", async () => {
    const tiles = tileGeometry(3408, 456, 4, 0.2);
    const seamX = tiles[1].x + 10; // inside tile 0's tail and tile 1's head
    const seamFace = face(seamX - 40, 200, seamX + 40, 280, 0.9);
    const det: DetectFn = async (img) => {
      // Return the seam face if it falls (even partly) inside this crop; clipped to the crop.
      const tile = tiles.find((t) => t.w === img.width) ? null : null;
      void tile;
      return [];
    };
    void det;
    // Simulate per-tile clipping explicitly: tile 0 sees the whole face, tile 1 a cut box.
    const perTile: FaceBox[][] = tiles.map((t) => {
      const x1 = Math.max(seamFace.box[0], t.x);
      const x2 = Math.min(seamFace.box[2], t.x + t.w);
      if (x2 - x1 < 8) return [];
      return [face(x1 - t.x, seamFace.box[1], x2 - t.x, seamFace.box[3], x2 - x1 >= 80 ? 0.9 : 0.55)];
    });
    let n = 0;
    const seq: DetectFn = async () => perTile[n++] || [];
    const r = await detectWithPlan(seq, frame, { kind: "tiles", count: 4, overlap: 0.2 }, { squareSize: 640, nmsIou: 0.4 });
    assert.equal(r.faces.length, 1);
    assert.deepEqual(r.faces[0].box, seamFace.box);
  });
});

describe("detectPlanIssue (fail closed on an incompatible detector graph)", () => {
  const staticInt8 = { width: 640, height: 640 } as const;
  const dynamicFp32 = { width: "dynamic", height: "dynamic" } as const;
  it("auto needs dynamic dims; tiles and square run on the static 640 export", () => {
    assert.match(detectPlanIssue({ kind: "auto", budgetPx: 640 * 640 }, staticInt8, 640, "det_10g_int8.onnx") || "", /dynamic input dims.*det_10g_int8\.onnx.*static 640x640/);
    assert.equal(detectPlanIssue({ kind: "auto", budgetPx: 640 * 640 }, dynamicFp32, 640, "det_10g.onnx"), null);
    assert.equal(detectPlanIssue({ kind: "tiles", count: 4, overlap: 0.2 }, staticInt8, 640, "det_10g_int8.onnx"), null);
    assert.equal(detectPlanIssue({ kind: "square" }, staticInt8, 640, "det_10g_int8.onnx"), null);
    assert.match(detectPlanIssue({ kind: "square" }, staticInt8, 1280, "det_10g_int8.onnx") || "", /static 640x640.*width 1280 and height 1280/);
  });
  it("fixed shapes must match a static graph exactly", () => {
    assert.equal(detectPlanIssue({ kind: "fixed", width: 640, height: 640 }, staticInt8, 640, "det_10g_int8.onnx"), null);
    assert.match(detectPlanIssue({ kind: "fixed", width: 1824, height: 224 }, staticInt8, 640, "det_10g_int8.onnx") || "", /width 1824 and height 224/);
    assert.equal(detectPlanIssue({ kind: "fixed", width: 1824, height: 224 }, dynamicFp32, 640, "det_10g.onnx"), null);
    assert.equal(detectPlanIssue({ kind: "fixed", width: 1824, height: 224 }, { width: 1824, height: 224 }, 640, "det_10g_int8_1824x224.onnx"), null);
  });
  it("unknown metadata (null) does not block: detectFaces still fails per frame, never throws", () => {
    assert.equal(detectPlanIssue({ kind: "auto", budgetPx: 640 * 640 }, null, 640, "x.onnx"), null);
  });
});

describe("PipelineCore stats", () => {
  it("carries the engine's detectInput description (and omits it when the engine has none)", () => {
    const base: PipelineEngine = {
      ready: () => true,
      modelTag: () => "arcface_test",
      detect: async () => [],
      align: () => null,
      embed: async () => null,
      quality: () => 0,
      clearIssue: () => null,
    };
    const without = new PipelineCore({ engine: base, post: () => {} });
    assert.equal(without.stats().detectInput, undefined);
    const withInput = new PipelineCore({ engine: { ...base, detectInput: () => "auto -> 1824x224 (scale 0.49)" }, post: () => {} });
    assert.equal(withInput.stats().detectInput, "auto -> 1824x224 (scale 0.49)");
    const throwing = new PipelineCore({ engine: { ...base, detectInput: () => { throw new Error("x"); } }, post: () => {} });
    assert.equal(throwing.stats().detectInput, undefined);
  });
});
