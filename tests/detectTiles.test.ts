/**
 * Tiled detection helpers (Taiga #523): tile plan, crop, seam merge, size rule,
 * env parsing and the worker fingerprint. Pure; no models, no engine load.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_TILES,
  DEFAULT_TILE_OVERLAP,
  MAX_DETECT_TILES,
  TILE_MIN_FRAME_FACTOR,
  autoTileDecision,
  boxShortSide,
  cropRgb,
  iouBox,
  mergeSingleAndTiles,
  mergeTileDetections,
  nmsFaces,
  parseDetectTiles,
  shouldTileFrame,
  tileCountFor,
  tilePlan,
} from "../src/server/detectTiles.ts";
import { CLEAR_FACE_LIMITS, clearFaceIssue, facePose, getFaceEngineInfo, type FaceBox, type RgbImage } from "../src/server/faceEmbedding.ts";
import { extractFingerprint, extractWorkerEnv } from "../src/server/faceExtractProtocol.ts";

/** A square face box at (x, y) with landmarks at fixed offsets inside it. */
function F(x: number, y: number, size: number, score: number, w = size): FaceBox {
  const k = (fx: number, fy: number): [number, number] => [x + w * fx, y + size * fy];
  return { box: [x, y, x + w, y + size], score, landmarks: [k(0.3, 0.4), k(0.7, 0.4), k(0.5, 0.6), k(0.35, 0.8), k(0.65, 0.8)] };
}

const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
};

test("parseDetectTiles: blank = 1 tile / 0.10 overlap; 2 and auto accepted; anything else falls back per value and is reported", () => {
  assert.deepEqual(parseDetectTiles({}), { tiles: 1, overlap: DEFAULT_TILE_OVERLAP, autoMinFacePx: 60 });
  assert.deepEqual(parseDetectTiles({ FACE_DETECT_TILES: " 2 ", FACE_DETECT_TILE_OVERLAP: "0.15" }), { tiles: 2, overlap: 0.15, autoMinFacePx: 60 });
  assert.deepEqual(parseDetectTiles({ FACE_DETECT_TILES: "1", FACE_DETECT_TILE_OVERLAP: "0" }), { tiles: 1, overlap: 0, autoMinFacePx: 60 });
  assert.deepEqual(parseDetectTiles({ FACE_DETECT_TILES: " Auto " }, 48), { tiles: AUTO_TILES, overlap: DEFAULT_TILE_OVERLAP, autoMinFacePx: 48 });
  assert.deepEqual(parseDetectTiles({ FACE_DETECT_TILES: "auto", FACE_DETECT_TILES_MIN_FACE_PX: "80" }), { tiles: "auto", overlap: DEFAULT_TILE_OVERLAP, autoMinFacePx: 80 });
  for (const bad of ["0", "3", "1.5", "two", "-1", "automatic", String(MAX_DETECT_TILES + 1)]) {
    const r = parseDetectTiles({ FACE_DETECT_TILES: bad });
    assert.equal(r.tiles, 1, `FACE_DETECT_TILES=${bad}`);
    assert.match(r.invalid ?? "", /FACE_DETECT_TILES: expected 1\.\.2 or auto, using 1/);
  }
  for (const bad of ["-1", "2001", "1.5", "x"]) {
    const r = parseDetectTiles({ FACE_DETECT_TILES: "auto", FACE_DETECT_TILES_MIN_FACE_PX: bad }, 60);
    assert.equal(r.tiles, "auto");
    assert.equal(r.autoMinFacePx, 60, `FACE_DETECT_TILES_MIN_FACE_PX=${bad}`);
    assert.match(r.invalid ?? "", /FACE_DETECT_TILES_MIN_FACE_PX: expected an integer in 0\.\.2000, using 60/);
  }
  assert.equal(tileCountFor(AUTO_TILES), 2);
  assert.equal(tileCountFor(1), 1);
  assert.equal(tileCountFor(2), 2);
  for (const bad of ["0.5", "1", "-0.1", "x"]) {
    const r = parseDetectTiles({ FACE_DETECT_TILES: "2", FACE_DETECT_TILE_OVERLAP: bad });
    assert.equal(r.tiles, 2);
    assert.equal(r.overlap, DEFAULT_TILE_OVERLAP, `FACE_DETECT_TILE_OVERLAP=${bad}`);
    assert.match(r.invalid ?? "", /FACE_DETECT_TILE_OVERLAP/);
  }
  const both = parseDetectTiles({ FACE_DETECT_TILES: "9", FACE_DETECT_TILE_OVERLAP: "2" });
  assert.match(both.invalid ?? "", /FACE_DETECT_TILES.*FACE_DETECT_TILE_OVERLAP/);
});

test("shouldTileFrame: only frames >= 4x the detector side tile; 1080p, uploads and crops never do; tiles=1 never does", () => {
  assert.equal(TILE_MIN_FRAME_FACTOR, 4);
  assert.equal(shouldTileFrame(3840, 2160, 640, 2), true);
  assert.equal(shouldTileFrame(2560, 1440, 640, 2), true);
  assert.equal(shouldTileFrame(2559, 1440, 640, 2), false);
  assert.equal(shouldTileFrame(1920, 1080, 640, 2), false);
  assert.equal(shouldTileFrame(1080, 1920, 640, 2), false);
  assert.equal(shouldTileFrame(640, 480, 640, 2), false);
  assert.equal(shouldTileFrame(112, 112, 640, 2), false);
  assert.equal(shouldTileFrame(3840, 2160, 640, 1), false);
  assert.equal(shouldTileFrame(3840, 2160, 640, AUTO_TILES), true, "auto follows the size rule of tiles=2");
  assert.equal(shouldTileFrame(1920, 1080, 640, AUTO_TILES), false, "1080p is never tiled, auto included");
  assert.equal(shouldTileFrame(3840, 2160, 1280, 2), false); // at 1280 the full frame is only 3x
  assert.equal(shouldTileFrame(3840, 2160, 0, 2), false);
});

test("tilePlan: 4K in two tiles = 2112 px wide at x=0 and x=1728 (384 px overlap), inside the frame, covering it exactly", () => {
  const t = tilePlan(3840, 2160, 2, 0.1);
  assert.deepEqual(t, [
    { x: 0, y: 0, w: 2112, h: 2160 },
    { x: 1728, y: 0, w: 2112, h: 2160 },
  ]);
  assert.equal(t[0].x + t[0].w - t[1].x, 384); // overlap = round(3840 * 0.1)
  assert.equal(t[1].x + t[1].w, 3840);
  // overlap bounds: 0 is allowed (tiles touch), 0.5 and up are refused, as are tiles outside 1..8
  const touching = tilePlan(1000, 500, 2, 0);
  assert.deepEqual(touching, [
    { x: 0, y: 0, w: 500, h: 500 },
    { x: 500, y: 0, w: 500, h: 500 },
  ]);
  assert.throws(() => tilePlan(1000, 500, 2, 0.5), /overlap/);
  assert.throws(() => tilePlan(1000, 500, 2, -0.1), /overlap/);
  assert.throws(() => tilePlan(1000, 500, 0), /tiles/);
  assert.throws(() => tilePlan(1000, 500, 9), /tiles/);
  assert.deepEqual(tilePlan(1920, 1080, 1, 0.3), [{ x: 0, y: 0, w: 1920, h: 1080 }]);
  // odd widths still cover the frame and never leave it
  for (const w of [1001, 1919, 3839]) {
    const r = tilePlan(w, 100, 2, 0.1);
    assert.equal(r[0].x, 0);
    assert.equal(r[1].x + r[1].w, w);
    assert.ok(r[0].x + r[0].w > r[1].x, "tiles overlap");
    for (const q of r) assert.ok(q.x >= 0 && q.x + q.w <= w);
  }
});

test("cropRgb: pixel-exact window; refuses a rect outside the image", () => {
  const img: RgbImage = { width: 4, height: 2, data: new Uint8Array(Array.from({ length: 24 }, (_, i) => i)) };
  const c = cropRgb(img, { x: 1, y: 0, w: 2, h: 2 });
  assert.deepEqual([c.width, c.height], [2, 2]);
  assert.deepEqual([...c.data], [3, 4, 5, 6, 7, 8, 15, 16, 17, 18, 19, 20]);
  assert.throws(() => cropRgb(img, { x: 3, y: 0, w: 2, h: 2 }), /outside/);
  assert.throws(() => cropRgb(img, { x: 0, y: 0, w: 0, h: 2 }), /outside/);
  assert.throws(() => cropRgb(img, { x: 0, y: 1, w: 2, h: 2 }), /outside/);
});

// Frame 1000x500 in two tiles of 600 px with a 200 px overlap: tile 0 = x 0..600, tile 1 = x 400..1000.
const RECTS = tilePlan(1000, 500, 2, 0.2);

test("merge: a face in the overlap seen whole by both tiles comes back once, mapped to frame pixels, the higher score winning", () => {
  assert.deepEqual(RECTS.map((r) => r.x), [0, 400]);
  const merged = mergeTileDetections([[F(450, 100, 80, 0.9), F(10, 10, 70, 0.6)], [F(52, 101, 80, 0.93), F(500, 300, 90, 0.8)]], RECTS, 0.4);
  assert.equal(merged.length, 3);
  const boxes = merged.map((f) => f.box.map(Math.round)).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(boxes, [[10, 10, 80, 80], [452, 101, 532, 181], [900, 300, 990, 390]]);
  const seam = merged.find((f) => Math.round(f.box[0]) === 452)!;
  assert.equal(seam.score, 0.93);
  assert.deepEqual(seam.landmarks[0].map(Math.round), [452 + 24, 101 + 32]);
  assert.deepEqual(merged.map((f) => f.score), [0.93, 0.8, 0.6], "highest score first, like the engine's NMS");
  assert.throws(() => mergeTileDetections([[]], RECTS), /tile results/);
});

test("merge (seam duplicate): the copy clipped at a tile's inner edge is dropped even when it scored higher and overlaps too little for NMS", () => {
  // The face spans x 560..680 in the frame (120 px, narrower than the 200 px overlap).
  // Tile 0 (0..600) sees only x 560..600 -> a 40 px sliver clipped at its right edge, scored 0.95.
  // Tile 1 (400..1000) sees it whole at tile x 160..280, scored 0.8.
  const sliver = F(560, 100, 120, 0.95, 40); // box 560..600, reaches tile 0's right edge
  const whole = F(160, 100, 120, 0.8);
  assert.ok(iouBox(sliver.box, [560, 100, 680, 220]) < 0.4, "plain NMS would keep both");
  const merged = mergeTileDetections([[sliver], [whole]], RECTS, 0.4);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].box, [560, 100, 680, 220]);
  assert.equal(merged[0].score, 0.8);
  // The same with the tiles swapped: a sliver at tile 1's LEFT edge loses to the whole face in tile 0.
  const sliver1 = F(0, 100, 120, 0.97, 30); // tile 1 x 0..30 = frame 400..430
  const whole0 = F(310, 100, 120, 0.7); // frame 310..430
  const m2 = mergeTileDetections([[whole0], [sliver1]], RECTS, 0.4);
  assert.equal(m2.length, 1);
  assert.deepEqual(m2[0].box, [310, 100, 430, 220]);
});

test("merge (seam loss): a face found by one tile only is kept, whole, in frame pixels", () => {
  const only1 = F(100, 200, 90, 0.72); // tile 1 only -> frame x 500..590
  const merged = mergeTileDetections([[], [only1]], RECTS, 0.4);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].box, [500, 200, 590, 290]);
  assert.deepEqual(merged[0].landmarks[2], [500 + 45, 200 + 54]);
  const only0 = F(420, 50, 60, 0.66); // tile 0 only, inside the overlap, not touching the edge
  assert.deepEqual(mergeTileDetections([[only0], []], RECTS, 0.4)[0].box, [420, 50, 480, 110]);
});

test("merge: a face wider than the overlap is cut in both tiles and kept once (the better score, clipped at that tile's edge)", () => {
  // Frame face x 300..700 (400 px). Tile 0 sees 300..600 (clipped right), tile 1 sees 400..700 (tile x 0..300, clipped left).
  const left = F(300, 50, 300, 0.81); // 300..600 in tile 0
  const right = F(0, 50, 300, 0.86); // 0..300 in tile 1 = frame 400..700
  const merged = mergeTileDetections([[left], [right]], RECTS, 0.4);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].score, 0.86);
  assert.deepEqual(merged[0].box, [400, 50, 700, 350]);
  // equal scores: deterministic, the first tile wins
  const tie = mergeTileDetections([[F(300, 50, 300, 0.8)], [F(0, 50, 300, 0.8)]], RECTS, 0.4);
  assert.equal(tie.length, 1);
  assert.deepEqual(tie[0].box, [300, 50, 600, 350]);
});

test("merge: outer frame edges are not seams, and a small whole face inside a cut face from the other tile survives", () => {
  // Face at the frame's left edge (tile 0, x=0) is whole, not "cut"; it must survive a big face from tile 1 covering it.
  const edgeFace = F(0, 10, 50, 0.6);
  const bigFrom1 = F(0, 0, 400, 0.99, 600); // tile 1 x 0..600 = frame 400..1000, clipped at tile 1's left edge (x=0)
  const merged = mergeTileDetections([[edgeFace], [bigFrom1]], RECTS, 0.4);
  assert.equal(merged.length, 2, "no overlap between them; both kept");
  // Small whole face (tile 1) sitting inside a big cut face (tile 0): the small one is not cut, the big one is
  // not covered > 50 % by the small one, so both are kept (nothing the engine's own NMS would not keep).
  const bigCut0 = F(350, 0, 250, 0.9); // frame 350..600, reaches tile 0's right edge
  const smallIn1 = F(60, 100, 40, 0.7); // frame 460..500, inside the big box
  const m2 = mergeTileDetections([[bigCut0], [smallIn1]], RECTS, 0.4);
  assert.equal(m2.length, 2);
});

test("nmsFaces: engine rule (suppress IoU > threshold), highest score first, ties by input order", () => {
  const kept = nmsFaces([F(0, 0, 100, 0.8), F(5, 5, 100, 0.95), F(500, 500, 60, 0.7)], 0.4);
  assert.deepEqual(kept.map((f) => f.score), [0.95, 0.7]);
  const tie = nmsFaces([F(0, 0, 100, 0.5), F(2, 2, 100, 0.5)], 0.4);
  assert.deepEqual(tie[0].box, [0, 0, 100, 100]);
  assert.equal(nmsFaces([], 0.4).length, 0);
});

test("single tile: mergeTileDetections with one rect is the plain NMS on the shifted faces", () => {
  const one = mergeTileDetections([[F(0, 0, 100, 0.8), F(5, 5, 100, 0.95)]], [{ x: 10, y: 20, w: 1000, h: 500 }], 0.4);
  assert.deepEqual(one.map((f) => f.box), [[15, 25, 115, 125]]);
});

test("engine info and worker fingerprint carry the tile settings; an invalid value is reported, never applied", () => {
  withEnv({ FACE_DETECT_TILES: undefined, FACE_DETECT_TILE_OVERLAP: undefined }, () => {
    const base = extractFingerprint();
    const info = getFaceEngineInfo();
    assert.equal(info.detectTiles, 1);
    assert.equal(info.detectTileOverlap, DEFAULT_TILE_OVERLAP);
    assert.ok(!/FACE_DETECT_TILES/.test(info.variantWarning ?? ""));
    assert.match(base, /"detectTiles":1/);
    withEnv({ FACE_DETECT_TILES: "2" }, () => {
      assert.notEqual(extractFingerprint(), base, "tiles=2 is a different engine configuration (config_mismatch for a stale worker)");
      assert.equal(getFaceEngineInfo().detectTiles, 2);
      withEnv({ FACE_DETECT_TILE_OVERLAP: "0.2" }, () => {
        assert.match(extractFingerprint(), /"detectTiles":2,"detectTileOverlap":0.2/);
      });
    });
    withEnv({ FACE_DETECT_TILES: "1" }, () => {
      assert.equal(extractFingerprint(), base, "an explicit 1 is the default");
    });
    withEnv({ FACE_DETECT_TILES: "4" }, () => {
      const i = getFaceEngineInfo();
      assert.equal(i.detectTiles, 1);
      assert.match(i.variantWarning ?? "", /FACE_DETECT_TILES: expected 1\.\.2 or auto, using 1/);
      assert.equal(extractFingerprint(), base);
    });
    // the worker env snapshot is a spread of the host env: the values reach the worker as-is
    const wenv = extractWorkerEnv(2, { FACE_DETECT_TILES: "auto", FACE_DETECT_TILE_OVERLAP: "0.12", FACE_DETECT_TILES_MIN_FACE_PX: "70" });
    assert.equal(wenv.FACE_DETECT_TILES, "auto");
    assert.equal(wenv.FACE_DETECT_TILE_OVERLAP, "0.12");
    assert.equal(wenv.FACE_DETECT_TILES_MIN_FACE_PX, "70");
  });
});

test("auto mode in engine info and fingerprint: mode string and the min-face knob; counters only in auto; default knob = clear-face floor", () => {
  withEnv({ FACE_DETECT_TILES: undefined, FACE_DETECT_TILE_OVERLAP: undefined, FACE_DETECT_TILES_MIN_FACE_PX: undefined }, () => {
    const base = extractFingerprint();
    const one = getFaceEngineInfo();
    assert.equal(one.detectTilesAuto, null, "counters are not reported outside auto mode");
    assert.equal(one.detectTilesMinFacePx, CLEAR_FACE_LIMITS.minFacePx);
    assert.match(base, new RegExp(`"detectTilesMinFacePx":${CLEAR_FACE_LIMITS.minFacePx}`));
    withEnv({ FACE_DETECT_TILES: "auto" }, () => {
      const info = getFaceEngineInfo();
      assert.equal(info.detectTiles, "auto");
      assert.deepEqual(info.detectTilesAuto, { singleOnly: 0, tiled: 0 });
      assert.ok(!/FACE_DETECT_TILES/.test(info.variantWarning ?? ""), "auto is a valid value");
      const fp = extractFingerprint();
      assert.notEqual(fp, base, "auto is a different engine configuration (config_mismatch for a stale worker)");
      assert.match(fp, /"detectTiles":"auto"/);
      withEnv({ FACE_DETECT_TILES_MIN_FACE_PX: "90" }, () => {
        assert.equal(getFaceEngineInfo().detectTilesMinFacePx, 90);
        assert.match(extractFingerprint(), /"detectTilesMinFacePx":90/);
        assert.notEqual(extractFingerprint(), fp, "the knob is part of the fingerprint");
      });
      withEnv({ FACE_DETECT_TILES_MIN_FACE_PX: "5000" }, () => {
        const i = getFaceEngineInfo();
        assert.equal(i.detectTilesMinFacePx, CLEAR_FACE_LIMITS.minFacePx);
        assert.match(i.variantWarning ?? "", /FACE_DETECT_TILES_MIN_FACE_PX/);
        assert.equal(extractFingerprint(), fp, "an invalid knob is the default, never a third configuration");
      });
    });
    // the knob without auto is accepted and fingerprinted but changes nothing at tiles=1/2
    withEnv({ FACE_DETECT_TILES: "2", FACE_DETECT_TILES_MIN_FACE_PX: "80" }, () => {
      const i = getFaceEngineInfo();
      assert.equal(i.detectTiles, 2);
      assert.equal(i.detectTilesAuto, null);
      assert.equal(i.detectTilesMinFacePx, 80);
    });
  });
});

// ---------------------------------------------------------------------------
// ADAPTIVE MODE decision and merge precedence (stubbed detector results)
// ---------------------------------------------------------------------------

/** The engine's gate on a bare detection: the same call extractFaces() uses for `clear`. */
const isClear = (f: FaceBox) => clearFaceIssue(facePose(f.landmarks), CLEAR_FACE_LIMITS, boxShortSide(f.box)) === null;

/** A frontal face at (x, y): the F() landmarks are frontal, so clearness is decided by size alone. */
const frontal = (x: number, y: number, size: number, score = 0.9) => F(x, y, size, score);

/** A face whose nose sits far outside the eye line: fails the yaw limit whatever its size. */
function turned(x: number, y: number, size: number, score = 0.9): FaceBox {
  const f = frontal(x, y, size, score);
  const eyes = (f.landmarks[1][0] - f.landmarks[0][0]) * (CLEAR_FACE_LIMITS.maxYaw + 1);
  return { ...f, landmarks: [f.landmarks[0], f.landmarks[1], [f.landmarks[2][0] + eyes, f.landmarks[2][1]], f.landmarks[3], f.landmarks[4]] };
}

test("auto decision: a clear face at or above the knob -> no tiling; no face / unclear-only / small-only -> tile, with the reason", () => {
  const minPx = CLEAR_FACE_LIMITS.minFacePx; // 60 unless FACE_MIN_SIZE_PX is set
  assert.equal(isClear(frontal(100, 100, minPx)), true);
  assert.equal(isClear(frontal(100, 100, minPx - 1)), false, "below the clear-face floor is unclear (small)");
  assert.equal(isClear(turned(100, 100, 200)), false, "a turned head is unclear (yaw)");

  assert.deepEqual(autoTileDecision([frontal(100, 100, 120)], isClear, minPx), { tile: false, reason: "clear" });
  assert.deepEqual(autoTileDecision([frontal(100, 100, minPx)], isClear, minPx), { tile: false, reason: "clear" }, "exactly the knob counts");
  assert.deepEqual(autoTileDecision([turned(10, 10, 200), frontal(900, 100, 120)], isClear, minPx), { tile: false, reason: "clear" }, "one clear face is enough");
  assert.deepEqual(autoTileDecision([], isClear, minPx), { tile: true, reason: "no_face" });
  assert.deepEqual(autoTileDecision([turned(10, 10, 200), turned(500, 10, 150)], isClear, minPx), { tile: true, reason: "unclear" });
  assert.deepEqual(autoTileDecision([frontal(10, 10, minPx - 10)], isClear, minPx), { tile: true, reason: "unclear" }, "below the floor the gate says small = unclear");
  // the knob above the floor: a clear 70 px face is not usable at FACE_DETECT_TILES_MIN_FACE_PX=80
  assert.deepEqual(autoTileDecision([frontal(10, 10, 70)], isClear, 80), { tile: true, reason: "small" });
  assert.deepEqual(autoTileDecision([frontal(10, 10, 70), frontal(300, 10, 80)], isClear, 80), { tile: false, reason: "clear" });
  // the knob below the floor changes nothing: the gate's floor still rules
  assert.deepEqual(autoTileDecision([frontal(10, 10, minPx - 1)], isClear, 0), { tile: true, reason: "unclear" });
  // deterministic: same input, same answer, input not mutated
  const input = [turned(10, 10, 200)];
  const snapshot = JSON.stringify(input);
  assert.deepEqual(autoTileDecision(input, isClear, minPx), autoTileDecision(input, isClear, minPx));
  assert.equal(JSON.stringify(input), snapshot);
});

test("auto merge precedence: tile-only faces are added, single-pass boxes the tiles missed are kept, duplicates settle by score, seam slivers lose to the full frame", () => {
  const W = 3840, H = 2160;
  const rects = tilePlan(W, H, 2, 0.1); // [0..2112], [1728..3840]
  // single pass: an unclear far face at (3000, 500) 40 px that the tiles do not report, and a 100 px face at (500, 500) scored 0.7
  const far = frontal(3000, 500, 40, 0.55);
  const nearSingle = frontal(500, 500, 100, 0.7);
  // tile 0 sees the near face again, slightly shifted, scored 0.85 (tile coordinates == frame coordinates for tile 0)
  const nearTile = frontal(503, 498, 100, 0.85);
  // tile 1 finds a clear 70 px face at frame x 2500 the single pass missed (tile x = 2500 - 1728)
  const tileOnly = frontal(2500 - rects[1].x, 900, 70, 0.8);
  const merged = mergeSingleAndTiles([far, nearSingle], [[nearTile], [tileOnly]], rects, W, H, 0.4);
  assert.deepEqual(merged.map((f) => f.score), [0.85, 0.8, 0.55], "highest score first; the better-scored tile copy wins the duplicate");
  assert.deepEqual(merged[0].box, nearTile.box);
  assert.deepEqual(merged[1].box, [2500, 900, 2570, 970], "the tile-only face is mapped back to frame pixels");
  assert.deepEqual(merged[2], far, "the single pass's unclear box survives for the unclear / stranger counters");

  // a duplicate where the single pass scored higher keeps the single-pass box (tie-break irrelevant)
  const m2 = mergeSingleAndTiles([frontal(500, 500, 100, 0.9)], [[frontal(503, 498, 100, 0.85)], []], rects, W, H, 0.4);
  assert.equal(m2.length, 1);
  assert.deepEqual(m2[0].box, [500, 500, 600, 600]);
  // equal scores: the single pass is listed first and wins the tie
  const m3 = mergeSingleAndTiles([frontal(500, 500, 100, 0.9)], [[frontal(503, 498, 100, 0.9)], []], rects, W, H, 0.4);
  assert.deepEqual(m3.map((f) => f.box), [[500, 500, 600, 600]]);

  // seam: a sliver clipped at tile 0's right edge (frame 2080..2112, scored 0.95) covered by a whole single-pass
  // face (2080..2200, 0.6) is dropped although plain NMS would keep both; the full frame is never "cut"
  const sliver = F(2080, 100, 120, 0.95, 32); // reaches x = 2112 = tile 0's inner edge
  const whole = F(2080, 100, 120, 0.6);
  assert.ok(iouBox(sliver.box, whole.box) < 0.4);
  const m4 = mergeSingleAndTiles([whole], [[sliver], []], rects, W, H, 0.4);
  assert.deepEqual(m4, [whole]);
  // a single-pass box touching the frame edge is not a seam sliver and survives alongside a whole tile face elsewhere
  const edge = F(0, 100, 120, 0.5, 30);
  const m5 = mergeSingleAndTiles([edge], [[], [frontal(100, 100, 100, 0.9)]], rects, W, H, 0.4);
  assert.deepEqual(m5.map((f) => f.score), [0.9, 0.5]);

  // with nothing from the single pass the merge is exactly the tiles=2 merge
  const perTile = [[frontal(100, 100, 80, 0.8)], [frontal(200, 300, 90, 0.7)]];
  assert.deepEqual(mergeSingleAndTiles([], perTile, rects, W, H, 0.4), mergeTileDetections(perTile, rects, 0.4));
});
