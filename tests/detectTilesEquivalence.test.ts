/**
 * FACE_DETECT_TILES on the real engine (Taiga #523). Needs the ONNX models
 * (FACE_MODEL_DIR) and ffmpeg; self-skips on the plain tester image.
 *
 *  - FACE_DETECT_TILES=1 (default) is today's output exactly: extractFaces()
 *    boxes/landmarks/scores equal the untouched explicit-shape single pass
 *    detectFaces(img, { inputShape: 640x640 }) on every input.
 *  - FACE_DETECT_TILES=2 leaves small pictures on the single pass (identical
 *    output) and, on a frame >= 4x the detector side, finds the single pass's
 *    best face with IoU >= 0.9; both paths' ms per frame are reported.
 *  - FACE_DETECT_TILES=auto equals tiles=1 exactly when the single pass finds a
 *    clear face (the fixture, a near face), and on a far-only frame (the fixture
 *    downscaled into a corner of a 3840x2160 canvas; FAR_SCALE, default 0.45)
 *    it tiles and finds every tiles=2 face; ms per frame for 1 / 2 / auto on
 *    both frames are reported, with the singleOnly / tiled counters.
 *
 * The face frame comes from FACE_EXTRACT_FIXTURE (a JPEG path mounted
 * read-only; real frames are biometric data and are never committed). Without
 * it only the synthetic cases run.
 *
 *   docker run --rm --cpus 2.5 -v <models>:/models:ro -e FACE_MODEL_DIR=/models \
 *     -v <frame.jpg>:/fixture/frame.jpg:ro -e FACE_EXTRACT_FIXTURE=/fixture/frame.jpg \
 *     --entrypoint node <tester> --import tsx --test tests/detectTilesEquivalence.test.ts
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { iouBox, shouldTileFrame, tilePlan } from "../src/server/detectTiles.ts";
import { CLEAR_FACE_LIMITS, cosineSimilarity, detectFaces, extractFaces, getFaceEngine, getFaceEngineInfo, loadImage, resetAutoTileCounts, type ExtractedFace, type FaceBox, type RgbImage } from "../src/server/faceEmbedding.ts";

const MODEL_DIR = process.env.FACE_MODEL_DIR || "/app/models";
const MODELS =
  fs.existsSync(path.join(MODEL_DIR, process.env.FACE_DETECTOR_MODEL || "det_10g.onnx")) &&
  fs.existsSync(path.join(MODEL_DIR, process.env.FACE_RECOGNIZER_MODEL || "w600k_r50.onnx"));
const FFMPEG = (() => {
  try {
    return spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], { timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
})();
const FIXTURE = (() => {
  const p = process.env.FACE_EXTRACT_FIXTURE?.trim();
  return p && fs.existsSync(p) ? p : null;
})();
const SKIP = !MODELS ? `no models in ${MODEL_DIR}` : !FFMPEG ? "ffmpeg not on PATH" : null;

function setTiles(v: string | undefined): void {
  if (v === undefined) delete process.env.FACE_DETECT_TILES;
  else process.env.FACE_DETECT_TILES = v;
}

/** A synthetic frame: smooth gradient with a few bright blobs (no face expected). */
function synthetic(width: number, height: number): RgbImage {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      data[i] = (x * 255) / width;
      data[i + 1] = (y * 255) / height;
      data[i + 2] = ((x + y) * 7) & 255;
    }
  }
  return { width, height, data };
}

/**
 * `src` box-filter downscaled by `scale` and pasted at (ox, oy) on a flat grey
 * canvas: a far, small version of the fixture's face with no other face in the
 * frame. Pixel-deterministic.
 */
function farFrame(src: RgbImage, scale: number, canvasW: number, canvasH: number, ox = 0, oy = 0): RgbImage {
  const w = Math.floor(src.width * scale), h = Math.floor(src.height * scale);
  if (ox + w > canvasW || oy + h > canvasH) throw new Error("farFrame: scaled picture does not fit the canvas");
  const data = new Uint8Array(canvasW * canvasH * 3).fill(110);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y / scale), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) / scale));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x / scale), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) / scale));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1 && sy < src.height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < src.width; sx++) {
          const i = (sy * src.width + sx) * 3;
          r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; n++;
        }
      }
      const o = ((oy + y) * canvasW + ox + x) * 3;
      data[o] = r / n; data[o + 1] = g / n; data[o + 2] = b / n;
    }
  }
  return { width: canvasW, height: canvasH, data };
}

const geometry = (f: FaceBox) => ({ box: f.box, score: f.score, landmarks: f.landmarks });
const usable = (f: ExtractedFace) => f.clear && f.boxSize >= getFaceEngineInfo().detectTilesMinFacePx;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** Max IoU of each face in `a` against any face in `b`. */
const matchIou = (a: ExtractedFace[], b: ExtractedFace[]) => a.map((x) => r3(Math.max(0, ...b.map((y) => iouBox(x.box, y.box)))));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function timed<T>(fn: () => Promise<T>, runs: number): Promise<{ value: T; medianMs: number }> {
  const ms: number[] = [];
  let value!: T;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    value = await fn();
    ms.push(performance.now() - t0);
  }
  return { value, medianMs: Math.round(median(ms)) };
}

describe("FACE_DETECT_TILES on the engine (models)", { skip: SKIP ?? false }, () => {
  const saved = process.env.FACE_DETECT_TILES;
  test.after(() => setTiles(saved));

  test("engine loads; default is 1 tile", async () => {
    setTiles(undefined);
    assert.ok(await getFaceEngine(), getFaceEngineInfo().lastError ?? "engine");
    assert.equal(getFaceEngineInfo().detectTiles, 1);
    assert.equal(getFaceEngineInfo().detectorInputSize, 640);
  });

  test("tiles=1 and an explicit single pass agree exactly on a 4K synthetic frame; tiles=2 runs the tiled path without error", async () => {
    const img = synthetic(2560, 1440); // >= 4 x 640: the tiled path is taken when tiles=2
    assert.equal(shouldTileFrame(img.width, img.height, 640, 2), true);
    setTiles("1");
    const single = await detectFaces(img, { inputShape: { width: 640, height: 640 } });
    assert.deepEqual(await detectFaces(img), single);
    assert.deepEqual((await extractFaces(img)).map(geometry), single.map(geometry));
    setTiles("2");
    const tiled = await detectFaces(img);
    assert.ok(Array.isArray(tiled));
    for (const f of tiled) assert.ok(f.box[0] >= 0 && f.box[2] <= img.width && f.box[1] >= 0 && f.box[3] <= img.height, "boxes inside the frame");
  });

  test("tiles=2 on a small picture (640x480) is the single pass, identical output", async () => {
    const img = synthetic(640, 480);
    setTiles("1");
    const one = await detectFaces(img);
    setTiles("2");
    assert.deepEqual(await detectFaces(img), one);
    assert.deepEqual(await extractFaces(img), await (async () => {
      setTiles("1");
      return extractFaces(img);
    })());
  });

  test("fixture: tiles=1 == today's single pass exactly; tiles=2 finds the same face (IoU >= 0.9); ms per frame for both", { skip: FIXTURE ? false : "no face fixture (set FACE_EXTRACT_FIXTURE)" }, async (t) => {
    const rgb = await loadImage(fs.readFileSync(FIXTURE!));
    assert.ok(rgb, "fixture decodes");
    const tiledFrame = shouldTileFrame(rgb!.width, rgb!.height, getFaceEngineInfo().detectorInputSize, 2);

    setTiles("1");
    const single = await detectFaces(rgb!, { inputShape: { width: 640, height: 640 } });
    const one = await timed(() => extractFaces(rgb!), 3);
    assert.deepEqual(one.value.map(geometry), single.map(geometry), "FACE_DETECT_TILES=1 is byte-identical to the explicit single pass");
    assert.ok(one.value.length > 0, "fixture must contain a face");

    setTiles("2");
    const two = await timed(() => extractFaces(rgb!), 3);
    const best = one.value[0];
    let bestIou = 0;
    let match: ExtractedFace | null = null;
    for (const f of two.value) {
      const o = iouBox(best.box, f.box);
      if (o > bestIou) {
        bestIou = o;
        match = f;
      }
    }
    const matched = one.value.map((a) => Math.max(0, ...two.value.map((b) => iouBox(a.box, b.box))));
    // Faces the tiled pass found that the single pass did not: size, score, position and whether they sit in
    // the seam overlap (a duplicate of a matched face would show up here with a high IoU to it).
    const rects = tilePlan(rgb!.width, rgb!.height, 2, getFaceEngineInfo().detectTileOverlap);
    const overlapX: [number, number] = [rects[1].x, rects[0].x + rects[0].w];
    const extras = two.value
      .filter((b) => !one.value.some((a) => iouBox(a.box, b.box) >= 0.5))
      .map((b) => {
        const cx = (b.box[0] + b.box[2]) / 2;
        return {
          score: Math.round(b.score * 1000) / 1000,
          boxPx: Math.round(b.boxSize),
          cx: Math.round(cx),
          cy: Math.round((b.box[1] + b.box[3]) / 2),
          inSeamOverlap: cx >= overlapX[0] && cx <= overlapX[1],
          clear: b.clear,
          maxIouToTiles1: Math.round(Math.max(0, ...one.value.map((a) => iouBox(a.box, b.box))) * 1000) / 1000,
          maxIouToOtherTiles2: Math.round(Math.max(0, ...two.value.filter((o) => o !== b).map((o) => iouBox(o.box, b.box))) * 1000) / 1000,
        };
      });
    const summary = {
      frame: `${rgb!.width}x${rgb!.height}`,
      tiledFrame,
      facesTiles1: one.value.length,
      facesTiles2: two.value.length,
      bestFaceIou: Math.round(bestIou * 1000) / 1000,
      bestFaceCosine: match ? Math.round(cosineSimilarity(best.embedding, match.embedding) * 1000) / 1000 : null,
      bestFaceScore: [Math.round(best.score * 1000) / 1000, match ? Math.round(match.score * 1000) / 1000 : null],
      bestFaceBoxPx: [Math.round(best.boxSize), match ? Math.round(match.boxSize) : null],
      allFacesIouVsTiles1: matched.map((v) => Math.round(v * 1000) / 1000),
      extraFacesTiles2: extras,
      msPerFrameTiles1: one.medianMs,
      msPerFrameTiles2: two.medianMs,
      ortThreads: process.env.FACE_ORT_THREADS || "4",
    };
    t.diagnostic(`tiles ${JSON.stringify(summary)}`);
    console.log(`[detectTilesEquivalence] ${JSON.stringify(summary)}`);
    if (tiledFrame) {
      assert.ok(bestIou >= 0.9, `tiles=2 finds the single pass's best face with IoU ${bestIou}`);
      assert.ok(match!.embedding.length === 512);
    } else {
      assert.deepEqual(two.value.map(geometry), single.map(geometry), "small fixture: tiles=2 stays on the single pass");
    }
  });

  // ---------------------------------------------------------------------------
  // FACE_DETECT_TILES=auto (ADAPTIVE MODE)
  // ---------------------------------------------------------------------------

  test("auto on a small picture (640x480) is the single pass, identical output, no counter moves", async () => {
    const img = synthetic(640, 480);
    setTiles("1");
    const one = await detectFaces(img);
    setTiles("auto");
    resetAutoTileCounts();
    assert.deepEqual(await detectFaces(img), one);
    assert.deepEqual(getFaceEngineInfo().detectTilesAuto, { singleOnly: 0, tiled: 0 }, "below the size rule the auto path is never entered");
  });

  test("auto on a 4K frame without a face tiles (no_face) and equals tiles=2 exactly; counter tiled=1", async () => {
    const img = synthetic(2560, 1440);
    setTiles("1");
    const single = await detectFaces(img);
    setTiles("2");
    const two = await detectFaces(img);
    setTiles("auto");
    resetAutoTileCounts();
    const auto = await detectFaces(img);
    assert.deepEqual(getFaceEngineInfo().detectTilesAuto, { singleOnly: 0, tiled: 1 });
    if (single.length === 0) assert.deepEqual(auto, two, "nothing from the single pass: the merge is the tiles=2 result");
    else for (const f of two) assert.ok(auto.some((a) => iouBox(a.box, f.box) >= 0.9), "every tiles=2 face is in the auto result");
  });

  test("fixture (near face): auto == tiles=1 byte for byte when the single pass finds a clear face; ms per frame 1 / 2 / auto", { skip: FIXTURE ? false : "no face fixture (set FACE_EXTRACT_FIXTURE)" }, async (t) => {
    const rgb = await loadImage(fs.readFileSync(FIXTURE!));
    assert.ok(rgb);
    assert.ok(shouldTileFrame(rgb!.width, rgb!.height, getFaceEngineInfo().detectorInputSize, "auto"), "the fixture must be a tileable (>= 2560 px) frame");
    setTiles("1");
    const one = await timed(() => extractFaces(rgb!), 3);
    assert.ok(one.value.some(usable), "the near fixture must contain a clear face at or above FACE_DETECT_TILES_MIN_FACE_PX");
    setTiles("2");
    const two = await timed(() => extractFaces(rgb!), 3);
    setTiles("auto");
    resetAutoTileCounts();
    const auto = await timed(() => extractFaces(rgb!), 3);
    assert.deepEqual(getFaceEngineInfo().detectTilesAuto, { singleOnly: 3, tiled: 0 }, "a clear near face never triggers the tile pass");
    assert.deepEqual(auto.value, one.value, "auto is byte-identical to tiles=1 (boxes, landmarks, scores, embeddings, flags)");
    const summary = {
      frame: `${rgb!.width}x${rgb!.height}`,
      faces: { tiles1: one.value.length, tiles2: two.value.length, auto: auto.value.length },
      bestFace: { boxPx: Math.round(one.value[0].boxSize), score: r3(one.value[0].score), clear: one.value[0].clear },
      minFacePx: getFaceEngineInfo().detectTilesMinFacePx,
      msPerFrame: { tiles1: one.medianMs, tiles2: two.medianMs, auto: auto.medianMs },
      ortThreads: process.env.FACE_ORT_THREADS || "4",
    };
    t.diagnostic(`auto-near ${JSON.stringify(summary)}`);
    console.log(`[detectTilesEquivalence] auto-near ${JSON.stringify(summary)}`);
  });

  test("far-only frame (fixture downscaled into a 4K corner): tiles=1 has nothing usable, auto tiles and finds every tiles=2 face; ms per frame 1 / 2 / auto", { skip: FIXTURE ? false : "no face fixture (set FACE_EXTRACT_FIXTURE)" }, async (t) => {
    const src = await loadImage(fs.readFileSync(FIXTURE!));
    assert.ok(src);
    const scale = Number(process.env.FAR_SCALE || "0.45");
    const far = farFrame(src!, scale, 3840, 2160);
    setTiles("1");
    const one = await timed(() => extractFaces(far), 3);
    assert.equal(one.value.some(usable), false, `the far frame must leave the single pass without a usable face (FAR_SCALE=${scale}; faces ${JSON.stringify(one.value.map((f) => [Math.round(f.boxSize), f.clear, f.unclearReason ?? null]))})`);
    setTiles("2");
    const two = await timed(() => extractFaces(far), 3);
    assert.ok(two.value.length > 0, `tiles=2 must find the far face (FAR_SCALE=${scale})`);
    setTiles("auto");
    resetAutoTileCounts();
    const auto = await timed(() => extractFaces(far), 3);
    assert.deepEqual(getFaceEngineInfo().detectTilesAuto, { singleOnly: 0, tiled: 3 }, "nothing usable in the single pass: every call tiles");
    const twoInAuto = matchIou(two.value, auto.value);
    for (const v of twoInAuto) assert.ok(v >= 0.9, `every tiles=2 face is in the auto result (IoU ${twoInAuto})`);
    if (one.value.length === 0) assert.deepEqual(auto.value.map(geometry), two.value.map(geometry), "an empty single pass: auto is exactly the tiles=2 merge");
    else for (const f of one.value) assert.ok(matchIou([f], auto.value)[0] >= 0.5 || auto.value.some((a) => a.score >= f.score), "a single-pass box is kept unless a better-scored duplicate replaced it");
    const summary = {
      frame: `${far.width}x${far.height}`,
      farScale: scale,
      faces: {
        tiles1: one.value.map((f) => ({ boxPx: Math.round(f.boxSize), score: r3(f.score), clear: f.clear, reason: f.unclearReason ?? null })),
        tiles2: two.value.map((f) => ({ boxPx: Math.round(f.boxSize), score: r3(f.score), clear: f.clear, reason: f.unclearReason ?? null })),
        auto: auto.value.map((f) => ({ boxPx: Math.round(f.boxSize), score: r3(f.score), clear: f.clear, reason: f.unclearReason ?? null })),
      },
      tiles2InAutoIou: twoInAuto,
      bestCosineTiles2VsAuto: two.value.length && auto.value.length ? r3(cosineSimilarity(two.value[0].embedding, auto.value[0].embedding)) : null,
      msPerFrame: { tiles1: one.medianMs, tiles2: two.medianMs, auto: auto.medianMs },
      ortThreads: process.env.FACE_ORT_THREADS || "4",
    };
    t.diagnostic(`auto-far ${JSON.stringify(summary)}`);
    console.log(`[detectTilesEquivalence] auto-far ${JSON.stringify(summary)}`);
  });
});
