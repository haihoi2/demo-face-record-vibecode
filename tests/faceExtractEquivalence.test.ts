/**
 * Off-thread extraction == main-thread loadImage + extractFaces (Taiga #507).
 *
 * Needs the ONNX models (FACE_MODEL_DIR with det_10g.onnx + w600k_r50.onnx)
 * and ffmpeg; self-skips on the plain tester image. The face picture comes from
 * FACE_EXTRACT_FIXTURE (a JPEG/PNG path, mounted read-only - real face pictures
 * are biometric data and are not committed), else the first .jpg/.png in
 * tests/fixtures. Without a face picture only the no-face / corrupted cases run.
 *
 *   docker run --rm --cpus 2.5 -v <models>:/models:ro -e FACE_MODEL_DIR=/models \
 *     -v <frame.jpg>:/fixture/frame.jpg:ro -e FACE_EXTRACT_FIXTURE=/fixture/frame.jpg \
 *     --entrypoint node <tester> --import tsx --test tests/faceExtractEquivalence.test.ts
 *
 * Diagnostics report per-frame latency and the worst event-loop stall on each
 * path; values only, never image bytes or embeddings.
 */

import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { cosineSimilarity, extractFaces, getFaceEngine, loadImage, type ExtractedFace } from "../src/server/faceEmbedding.ts";
import { FaceExtractPool, FaceExtractError } from "../src/server/faceExtractPool.ts";

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

function fixturePath(): string | null {
  const explicit = process.env.FACE_EXTRACT_FIXTURE?.trim();
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const dir = path.join(process.cwd(), "tests", "fixtures");
  try {
    const f = fs.readdirSync(dir).find((n) => /\.(jpe?g|png)$/i.test(n));
    return f ? path.join(dir, f) : null;
  } catch {
    return null;
  }
}
const FIXTURE = fixturePath();
const SKIP = !MODELS ? `no models in ${MODEL_DIR}` : !FFMPEG ? "ffmpeg not on PATH" : null;

function grayJpeg(): Buffer {
  const gen = spawnSync(
    process.env.FFMPEG_PATH || "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:size=640x480:duration=1", "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
    { maxBuffer: 16 * 1024 * 1024, timeout: 20000 },
  );
  assert.equal(gen.status, 0);
  return gen.stdout;
}

async function mainThread(image: Buffer): Promise<{ width: number; height: number; faces: ExtractedFace[] } | null> {
  const rgb = await loadImage(image);
  if (!rgb) return null;
  return { width: rgb.width, height: rgb.height, faces: await extractFaces(rgb) };
}

/** Run fn while sampling the event loop every 5 ms; returns the worst gap beyond 5 ms. */
async function withLagProbe<T>(fn: () => Promise<T>): Promise<{ value: T; maxLagMs: number; ms: number }> {
  let last = performance.now();
  let maxLag = 0;
  const iv = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - last - 5);
    last = now;
  }, 5);
  const t0 = performance.now();
  try {
    const value = await fn();
    return { value, maxLagMs: Math.round(maxLag), ms: Math.round(performance.now() - t0) };
  } finally {
    clearInterval(iv);
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe("off-thread extraction equivalence (models)", { skip: SKIP ?? false }, () => {
  let pool: FaceExtractPool;
  after(async () => {
    await pool?.shutdown();
  });

  test("pool starts with a compatible engine", async () => {
    pool = new FaceExtractPool({ workers: Number(process.env.FACE_EXTRACT_WORKERS) || 2, taskTimeoutMs: 60_000 });
    assert.equal(await pool.whenReady(120_000), true, pool.telemetry().lastError ?? "not ready");
    assert.ok(await getFaceEngine(), "main-thread engine loads too");
    const t = pool.telemetry();
    assert.equal(t.modelTag, "arcface_w600k_r50");
  });

  test("no-face frame: [] on both paths (a result, not an error)", async () => {
    const jpeg = grayJpeg();
    const main = await mainThread(jpeg);
    const off = await pool.extract(jpeg);
    assert.deepEqual(main?.faces, []);
    assert.deepEqual(off.faces, []);
    assert.equal(off.width, 640);
    assert.equal(off.height, 480);
  });

  test("corrupted bytes: main thread decodes nothing, off-thread rejects 'decode_failed' (fail closed)", async () => {
    const garbage = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 1, 0, 1, 0]), Buffer.alloc(4000, 0x5a)]);
    assert.equal(await mainThread(garbage), null);
    await assert.rejects(pool.extract(garbage), (e: unknown) => e instanceof FaceExtractError && e.code === "decode_failed");
    const truncated = grayJpeg().subarray(0, 300);
    assert.equal(await mainThread(truncated), null);
    await assert.rejects(pool.extract(truncated), (e: unknown) => e instanceof FaceExtractError && e.code === "decode_failed");
  });

  test("fixture: same faces, boxes, fields and embeddings (cosine >= 0.9999); latency and event-loop stall", { skip: FIXTURE ? false : "no face fixture (set FACE_EXTRACT_FIXTURE)" }, async (t) => {
    const jpeg = fs.readFileSync(FIXTURE!);
    const main = await mainThread(jpeg);
    assert.ok(main, "fixture decodes");
    const off = await pool.extract(jpeg);
    assert.equal(off.width, main!.width);
    assert.equal(off.height, main!.height);
    assert.equal(off.faces.length, main!.faces.length, "same number of faces");
    assert.ok(main!.faces.length > 0, "fixture must contain a face");
    let minCosine = 1;
    for (let i = 0; i < main!.faces.length; i++) {
      const a = main!.faces[i];
      const b = off.faces[i];
      for (let k = 0; k < 4; k++) assert.ok(Math.abs(a.box[k] - b.box[k]) < 0.5, `face ${i} box[${k}] ${a.box[k]} vs ${b.box[k]}`);
      for (let p = 0; p < 5; p++) {
        assert.ok(Math.abs(a.landmarks[p][0] - b.landmarks[p][0]) < 0.5 && Math.abs(a.landmarks[p][1] - b.landmarks[p][1]) < 0.5, `face ${i} landmark ${p}`);
      }
      assert.ok(Math.abs(a.score - b.score) < 1e-3, `face ${i} score`);
      const cos = cosineSimilarity(a.embedding, b.embedding);
      assert.ok(cos >= 0.9999, `face ${i} embedding cosine ${cos}`);
      minCosine = Math.min(minCosine, cos);
      assert.ok(b.embedding instanceof Float32Array && b.embedding.length === 512);
      assert.equal(b.clear, a.clear, `face ${i} clear`);
      assert.equal(b.unclearReason, a.unclearReason, `face ${i} unclearReason`);
      for (const k of ["quality", "sharpness", "edgeEnergy", "boxSize"] as const) {
        const rel = Math.abs(a[k] - b[k]) / Math.max(1e-6, Math.abs(a[k]));
        assert.ok(rel < 0.01, `face ${i} ${k} ${a[k]} vs ${b[k]}`);
      }
      if (a.featureNorm !== undefined) assert.ok(Math.abs(a.featureNorm - (b.featureNorm ?? NaN)) < 0.05, `face ${i} featureNorm`);
    }
    for (let i = 1; i < off.faces.length; i++) assert.ok(off.faces[i - 1].score >= off.faces[i].score, "ordered by detector score");

    // Latency + event-loop stall, a few frames each (sequential, like observeFrame).
    const N = 4;
    const mainRuns: Array<{ ms: number; maxLagMs: number }> = [];
    const offRuns: Array<{ ms: number; maxLagMs: number; workerMs: number }> = [];
    for (let i = 0; i < N; i++) {
      const m = await withLagProbe(() => mainThread(jpeg));
      mainRuns.push({ ms: m.ms, maxLagMs: m.maxLagMs });
      const o = await withLagProbe(() => pool.extract(jpeg));
      offRuns.push({ ms: o.ms, maxLagMs: o.maxLagMs, workerMs: o.value.workerMs });
    }
    // Two frames at once (the extra best-of frames run together in server.ts).
    const par = await withLagProbe(() => Promise.all([pool.extract(jpeg), pool.extract(jpeg)]));
    const summary = {
      frame: `${main!.width}x${main!.height}`,
      faces: main!.faces.length,
      minCosine: Math.round(minCosine * 1e6) / 1e6,
      mainMedianMs: median(mainRuns.map((r) => r.ms)),
      mainWorstStallMs: Math.max(...mainRuns.map((r) => r.maxLagMs)),
      offMedianMs: median(offRuns.map((r) => r.ms)),
      offMedianWorkerMs: median(offRuns.map((r) => r.workerMs)),
      offWorstStallMs: Math.max(...offRuns.map((r) => r.maxLagMs)),
      twoFramesInParallelMs: par.ms,
      twoFramesWorstStallMs: par.maxLagMs,
      ortThreadsPerWorker: pool.telemetry().ortThreadsPerWorker,
      mainOrtThreads: process.env.FACE_ORT_THREADS || "4",
    };
    t.diagnostic(`latency ${JSON.stringify(summary)}`);
    console.log(`[faceExtractEquivalence] ${JSON.stringify(summary)}`);
    assert.ok(summary.offWorstStallMs < summary.mainWorstStallMs || summary.mainWorstStallMs < 50, "off-thread path does not stall the event loop like the main thread");
  });
});
