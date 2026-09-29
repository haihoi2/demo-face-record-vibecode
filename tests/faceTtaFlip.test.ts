/**
 * FACE_TTA_FLIP (src/server/faceEmbedding.ts, plan D2): horizontal-flip
 * test-time augmentation of the recogniser. Additive and OFF by default; these
 * tests pin (1) the switch semantics, (2) the pure helpers, (3) that the default
 * path feeds the model exactly the bytes it always did and returns exactly the
 * single-run embedding, and (4) the flip formula when the switch is on.
 *
 * Model-dependent cases self-skip on the plain tester image (no ONNX models);
 * run them with FACE_MODEL_DIR pointing at det_10g.onnx + w600k_r50.onnx.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  alignedToTensorData,
  embedFace,
  flipHorizontal,
  getFaceEngine,
  getFaceEngineInfo,
  l2Normalize,
  ttaFlipEnabled,
  EMBEDDING_DIM,
  type RgbImage,
} from "../src/server/faceEmbedding.ts";

function hasModels(): boolean {
  const dir = process.env.FACE_MODEL_DIR || "/app/models";
  const det = process.env.FACE_DETECTOR_MODEL || "det_10g.onnx";
  const rec = process.env.FACE_RECOGNIZER_MODEL || "w600k_r50.onnx";
  return fs.existsSync(path.join(dir, det)) && fs.existsSync(path.join(dir, rec));
}
const MODELS = hasModels();

/** Deterministic asymmetric 112x112 crop (a gradient plus pseudo-random texture). */
function crop(seed = 1): RgbImage {
  const w = 112, h = 112;
  const data = new Uint8Array(w * h * 3);
  let s = seed;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const x = i % w;
    data[i * 3] = (x * 2 + ((s >>> 8) & 31)) & 255;
    data[i * 3 + 1] = ((s >>> 12) & 255);
    data[i * 3 + 2] = (255 - x * 2 + ((s >>> 16) & 15)) & 255;
  }
  return { width: w, height: h, data };
}

function withEnv(value: string | undefined, fn: () => void | Promise<void>) {
  const prev = process.env.FACE_TTA_FLIP;
  if (value === undefined) delete process.env.FACE_TTA_FLIP;
  else process.env.FACE_TTA_FLIP = value;
  const restore = () => {
    if (prev === undefined) delete process.env.FACE_TTA_FLIP;
    else process.env.FACE_TTA_FLIP = prev;
  };
  try {
    const r = fn();
    if (r && typeof (r as Promise<void>).then === "function") return (r as Promise<void>).finally(restore);
    restore();
    return r;
  } catch (e) {
    restore();
    throw e;
  }
}

const sameBytes = (a: Float32Array, b: Float32Array) =>
  a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

// ---------------------------------------------------------------------------
// Switch semantics
// ---------------------------------------------------------------------------

test("ttaFlipEnabled: off unless FACE_TTA_FLIP is exactly 1/true; default off", () => {
  assert.equal(ttaFlipEnabled({}), false);
  for (const v of ["", " ", "0", "false", "no", "off", "yes", "on", "flip", "2", "TRUE1"]) {
    assert.equal(ttaFlipEnabled({ FACE_TTA_FLIP: v }), false, `FACE_TTA_FLIP=${JSON.stringify(v)} must be off`);
  }
  for (const v of ["1", "true", "TRUE", " 1 ", "True"]) {
    assert.equal(ttaFlipEnabled({ FACE_TTA_FLIP: v }), true, `FACE_TTA_FLIP=${JSON.stringify(v)} must be on`);
  }
  withEnv(undefined, () => {
    assert.equal(ttaFlipEnabled(), false, "process.env default is off");
    assert.equal(getFaceEngineInfo().ttaFlip, false);
  });
  withEnv("1", () => {
    assert.equal(ttaFlipEnabled(), true);
    assert.equal(getFaceEngineInfo().ttaFlip, true, "status reports the switch without loading the engine");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("flipHorizontal: mirrors each row, keeps dimensions, is an involution and does not touch its input", () => {
  const img = crop(7);
  const before = Buffer.from(img.data);
  const f = flipHorizontal(img);
  assert.equal(f.width, 112);
  assert.equal(f.height, 112);
  assert.equal(f.data.length, img.data.length);
  assert.ok(Buffer.from(img.data).equals(before), "input untouched");
  for (const y of [0, 55, 111]) {
    for (const x of [0, 1, 56, 110, 111]) {
      const s = (y * 112 + x) * 3, d = (y * 112 + (111 - x)) * 3;
      assert.deepEqual([f.data[d], f.data[d + 1], f.data[d + 2]], [img.data[s], img.data[s + 1], img.data[s + 2]]);
    }
  }
  assert.ok(!Buffer.from(f.data).equals(before), "an asymmetric picture changes when mirrored");
  assert.ok(Buffer.from(flipHorizontal(f).data).equals(before), "flip(flip(x)) === x");
  const tiny = flipHorizontal({ width: 3, height: 1, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) });
  assert.deepEqual([...tiny.data], [7, 8, 9, 4, 5, 6, 1, 2, 3]);
});

test("alignedToTensorData: NCHW, (px - 127.5) / 127.5 - the bytes embedFace always fed the model", () => {
  const img = crop(3);
  const data = alignedToTensorData(img);
  assert.equal(data.length, 3 * 112 * 112);
  // Independent reference implementation of the pre-2026-09-29 inline loop.
  const plane = 112 * 112;
  const ref = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    ref[i] = (img.data[i * 3] - 127.5) / 127.5;
    ref[plane + i] = (img.data[i * 3 + 1] - 127.5) / 127.5;
    ref[2 * plane + i] = (img.data[i * 3 + 2] - 127.5) / 127.5;
  }
  assert.ok(sameBytes(data, ref), "tensor bytes identical to the reference loop");
  assert.ok(data.every((v) => v >= -1 && v <= 1));
});

// ---------------------------------------------------------------------------
// Model-dependent: the default path is byte-identical to a single run
// ---------------------------------------------------------------------------

test("embedFace default (FACE_TTA_FLIP unset): byte-identical to one recogniser run + l2Normalize", async (t) => {
  if (!MODELS) return t.skip(`no models in ${process.env.FACE_MODEL_DIR || "/app/models"}`);
  await withEnv(undefined, async () => {
    const engine = await getFaceEngine();
    assert.ok(engine, "engine loads");
    const img = crop(11);
    const viaEmbedFace = await embedFace(img);
    assert.ok(viaEmbedFace);
    const tensor = new engine!.ort.Tensor("float32", alignedToTensorData(img), [1, 3, 112, 112]);
    const out = await engine!.recognizer.run({ [engine!.recognizerInput]: tensor });
    const reference = l2Normalize(out[engine!.recognizerOutput].data as Float32Array);
    assert.equal(viaEmbedFace!.length, EMBEDDING_DIM);
    assert.ok(sameBytes(viaEmbedFace!, reference), "default embedFace output is the single-run embedding, byte for byte");
    const again = await embedFace(img);
    assert.ok(sameBytes(viaEmbedFace!, again!), "deterministic across calls");
    // Same model, same tag: the switch does not change what the engine reports itself to be.
    assert.equal(getFaceEngineInfo().modelTag, "arcface_w600k_r50");
  });
});

test("embedFace with FACE_TTA_FLIP=1: l2(embed(x) + embed(flip(x))), unit length, differs from the single run", async (t) => {
  if (!MODELS) return t.skip("no models present");
  const img = crop(11);
  let plain: Float32Array | null = null;
  await withEnv(undefined, async () => {
    plain = await embedFace(img);
  });
  await withEnv("1", async () => {
    const engine = await getFaceEngine();
    assert.ok(engine);
    const run = async (x: RgbImage) => {
      const tensor = new engine!.ort.Tensor("float32", alignedToTensorData(x), [1, 3, 112, 112]);
      const out = await engine!.recognizer.run({ [engine!.recognizerInput]: tensor });
      return l2Normalize(out[engine!.recognizerOutput].data as Float32Array);
    };
    const a = await run(img);
    const b = await run(flipHorizontal(img));
    const sum = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) sum[i] = a[i] + b[i];
    const reference = l2Normalize(sum);
    const flipped = await embedFace(img);
    assert.ok(flipped);
    assert.ok(sameBytes(flipped!, reference), "flip path follows the documented formula exactly");
    let norm = 0;
    for (const v of flipped!) norm += v * v;
    assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-4, "unit length");
    assert.ok(plain && !sameBytes(flipped!, plain), "the switch changes the embedding (so it must be calibrated before use)");
    assert.equal(getFaceEngineInfo().ttaFlip, true);
  });
  // Back to default: the single-run bytes again (no state leaks from the flip run).
  await withEnv(undefined, async () => {
    const back = await embedFace(img);
    assert.ok(plain && back && sameBytes(back, plain));
  });
});
