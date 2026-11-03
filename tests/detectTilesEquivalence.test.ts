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
import { cosineSimilarity, detectFaces, extractFaces, getFaceEngine, getFaceEngineInfo, loadImage, type ExtractedFace, type FaceBox, type RgbImage } from "../src/server/faceEmbedding.ts";

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

const geometry = (f: FaceBox) => ({ box: f.box, score: f.score, landmarks: f.landmarks });
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
});
