/**
 * Off-thread face extraction pool (Taiga #507): queue, timeout, crash,
 * disabled, mismatch and validation behaviour with injected fake workers,
 * plus the real worker entry on a model-less directory (fails closed, never
 * hangs). Model-dependent equivalence lives in faceExtractEquivalence.test.ts.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FaceExtractPool,
  FaceExtractError,
  resolveFaceExtractWorkerEntry,
  type ExtractWorkerLike,
  type FaceExtractPoolOptions,
} from "../src/server/faceExtractPool.ts";
import {
  extractWorkerEnv,
  isEngineErrorLine,
  splitOrtThreads,
  wireFaceIssue,
  type HostToWorker,
  type WorkerToHost,
} from "../src/server/faceExtractProtocol.ts";
import { CLEAR_FACE_LIMITS, EMBEDDING_DIM } from "../src/server/faceEmbedding.ts";

const FP = "fp-1";
const TAG = "arcface_w600k_r50";

type Behaviour = (w: FakeWorker, msg: HostToWorker, transfer: readonly ArrayBuffer[]) => void;

class FakeWorker extends EventEmitter implements ExtractWorkerLike {
  terminated = false;
  received: HostToWorker[] = [];
  constructor(readonly id: number, readonly env: NodeJS.ProcessEnv, private behaviour: Behaviour) {
    super();
  }
  postMessage(msg: HostToWorker, transfer: readonly ArrayBuffer[] = []): void {
    // Like a real port: the message is cloned and the transfer list detached on the sender side.
    const cloned = structuredClone(msg, { transfer: [...transfer] });
    this.received.push(cloned);
    this.behaviour(this, cloned, transfer);
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(1);
  }
  send(msg: WorkerToHost): void {
    setImmediate(() => this.emit("message", msg));
  }
  ready(fingerprint = FP, modelTag = TAG): void {
    this.send({ type: "ready", fingerprint, modelTag, detectorModel: "det_10g.onnx", recognizerModel: "w600k_r50.onnx", ortThreads: 2, loadTimeMs: 1 });
  }
}

function unitEmbedding(seed = 1): Float32Array {
  const e = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < e.length; i++) e[i] = Math.sin(seed + i);
  let n = 0;
  for (const v of e) n += v * v;
  n = Math.sqrt(n);
  for (let i = 0; i < e.length; i++) e[i] /= n;
  return e;
}

function face(overrides: Record<string, unknown> = {}) {
  return {
    box: [10, 10, 110, 120] as [number, number, number, number],
    score: 0.9,
    landmarks: [[40, 50], [80, 50], [60, 70], [45, 95], [75, 95]] as Array<[number, number]>,
    embedding: unitEmbedding(),
    quality: 0.8,
    edgeEnergy: 0.3,
    featureNorm: 23.1,
    sharpness: 150,
    boxSize: 100,
    pose: { yaw: 0, aspect: 1, rollDeg: 0 },
    clear: true,
    ...overrides,
  };
}

const answer = (faces: unknown[] = [face()]): Behaviour => (w, msg) =>
  w.send({ type: "result", id: msg.id, ok: true, width: 640, height: 480, modelTag: TAG, faces: faces as never, ms: 5 });
const silent: Behaviour = () => {};

interface Harness {
  pool: FaceExtractPool;
  workers: FakeWorker[];
  setBehaviour(b: Behaviour): void;
}

/** A pool of fakes that become ready on spawn (unless `autoReady` is false). */
function harness(
  opts: Partial<FaceExtractPoolOptions> & { behaviour?: Behaviour; autoReady?: boolean; readyFingerprint?: string } = {},
): Harness {
  const workers: FakeWorker[] = [];
  let behaviour = opts.behaviour ?? answer();
  const pool = new FaceExtractPool({
    workers: 1,
    queueMax: 2,
    taskTimeoutMs: 2000,
    respawnMinMs: 10,
    respawnMaxMs: 40,
    fingerprint: () => FP,
    modelTag: () => TAG,
    ...opts,
    createWorker: (spec) => {
      const w = new FakeWorker(spec.id, spec.env, (wk, m, t) => behaviour(wk, m, t));
      workers.push(w);
      if (opts.autoReady !== false) w.ready(opts.readyFingerprint ?? FP);
      return w;
    },
  });
  return { pool, workers, setBehaviour: (b) => (behaviour = b) };
}

async function rejectsWith(p: Promise<unknown>, code: string): Promise<FaceExtractError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof FaceExtractError, `expected FaceExtractError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return err;
  }
  assert.fail(`expected rejection with ${code}, got a result`);
}

const JPEG = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

// ---------------------------------------------------------------------------

describe("faceExtractProtocol: pure helpers", () => {
  test("splitOrtThreads keeps the pool total at the main engine budget", () => {
    assert.equal(splitOrtThreads(4, 2), 2);
    assert.equal(splitOrtThreads(4, 3), 1);
    assert.equal(splitOrtThreads(4, 4), 1);
    assert.equal(splitOrtThreads(1, 2), 1, "never zero threads");
    assert.equal(splitOrtThreads(8, 2), 4);
    assert.equal(splitOrtThreads(4, 2, 3), 3, "explicit per-worker override wins");
    assert.equal(splitOrtThreads(NaN, 2), 2, "bad total -> default 4 split");
  });

  test("extractWorkerEnv pins the main thread's CLEAR_FACE_LIMITS and the thread share", () => {
    const env = extractWorkerEnv(2, { FACE_MIN_SIZE_PX: "9999", FACE_MODEL_DIR: "/models", FACE_ORT_THREADS: "4" });
    assert.equal(env.FACE_ORT_THREADS, "2");
    assert.equal(env.FACE_MODEL_DIR, "/models");
    assert.equal(env.FACE_MIN_SIZE_PX, String(CLEAR_FACE_LIMITS.minFacePx), "the worker gets the floor the main thread parsed, not a later env value");
    assert.equal(env.FACE_CLEAR_MAX_YAW, String(CLEAR_FACE_LIMITS.maxYaw));
    assert.equal(env.FACE_CLEAR_MAX_ROLL_DEG, String(CLEAR_FACE_LIMITS.maxRollDeg));
  });

  test("isEngineErrorLine matches faceEmbedding's own log prefix only", () => {
    assert.equal(isEngineErrorLine("[faceEmbedding] extractFaces failed :: boom"), true);
    assert.equal(isEngineErrorLine("[faceExtractPool] x"), false);
    assert.equal(isEngineErrorLine(undefined), false);
    // Pin the contract with faceEmbedding.ts: its logger must keep this prefix.
    const src = fs.readFileSync(path.join(process.cwd(), "src", "server", "faceEmbedding.ts"), "utf8");
    assert.ok(src.includes("const line = `[faceEmbedding] ${msg}${suffix}`;"), "faceEmbedding log() prefix changed; update isEngineErrorLine");
  });

  test("wireFaceIssue accepts a valid face and names (without values) what is wrong", () => {
    assert.equal(wireFaceIssue(face()), null);
    assert.match(wireFaceIssue(face({ embedding: new Float32Array(128) }))!, /length 128/);
    const nan = unitEmbedding();
    nan[3] = NaN;
    assert.match(wireFaceIssue(face({ embedding: nan }))!, /non-finite/);
    assert.match(wireFaceIssue(face({ embedding: new Float32Array(EMBEDDING_DIM).fill(1) }))!, /unit length/);
    assert.match(wireFaceIssue(face({ embedding: Array.from(unitEmbedding()) }))!, /Float32Array/);
    assert.match(wireFaceIssue(face({ box: [1, 2, 3] }))!, /box/);
    assert.match(wireFaceIssue(face({ clear: "yes" }))!, /clear/);
    assert.match(wireFaceIssue(null)!, /object/);
  });
});

describe("FaceExtractPool: disabled / not ready", () => {
  test("workers=0 is disabled: rejects with 'disabled', never spawns, whenReady false", async () => {
    let spawned = 0;
    const pool = new FaceExtractPool({ workers: 0, createWorker: () => { spawned++; throw new Error("no"); } });
    assert.equal(pool.enabled, false);
    await rejectsWith(pool.extract(JPEG()), "disabled");
    assert.equal(await pool.whenReady(10), false);
    assert.equal(spawned, 0);
    const t = pool.telemetry();
    assert.equal(t.enabled, false);
    assert.equal(t.ready, false);
    assert.equal(t.failedByCode.disabled, 1);
  });

  test("FACE_EXTRACT_WORKERS env: blank = default 2, 0 = disabled, out of range = default", () => {
    const prev = process.env.FACE_EXTRACT_WORKERS;
    try {
      process.env.FACE_EXTRACT_WORKERS = "";
      assert.equal(new FaceExtractPool().size, 2);
      process.env.FACE_EXTRACT_WORKERS = "0";
      assert.equal(new FaceExtractPool().enabled, false);
      process.env.FACE_EXTRACT_WORKERS = "99";
      assert.equal(new FaceExtractPool().size, 2);
    } finally {
      if (prev === undefined) delete process.env.FACE_EXTRACT_WORKERS;
      else process.env.FACE_EXTRACT_WORKERS = prev;
    }
  });

  test("before the engine is loaded a call is rejected 'not_ready' at once (no queueing behind model load)", async () => {
    const h = harness({ autoReady: false });
    await rejectsWith(h.pool.extract(JPEG()), "not_ready");
    h.workers[0].ready();
    assert.equal(await h.pool.whenReady(1000), true);
    const r = await h.pool.extract(JPEG());
    assert.equal(r.faces.length, 1);
    await h.pool.shutdown();
  });

  test("a worker reporting another configuration / model tag is never used (fail closed)", async () => {
    const h = harness({ readyFingerprint: "fp-other" });
    assert.equal(await h.pool.whenReady(80), false);
    await rejectsWith(h.pool.extract(JPEG()), "not_ready");
    assert.ok(h.workers[0].terminated, "mismatching worker terminated");
    assert.match(h.pool.telemetry().lastError ?? "", /configuration differs/);
    await h.pool.shutdown();

    const tagged: FakeWorker[] = [];
    const pool = new FaceExtractPool({
      workers: 1, respawnMinMs: 10, fingerprint: () => FP, modelTag: () => TAG,
      createWorker: (s) => { const w = new FakeWorker(s.id, s.env, answer()); tagged.push(w); w.ready(FP, "arcface_w600k_mbf"); return w; },
    });
    assert.equal(await pool.whenReady(80), false, "model tag mismatch alone is enough");
    await pool.shutdown();
  });

  test("main-thread configuration change after ready: call rejected 'config_mismatch', workers recycled with current env", async () => {
    let fp = FP;
    const h = harness({ fingerprint: () => fp, readyFingerprint: FP });
    assert.equal(await h.pool.whenReady(1000), true);
    fp = "fp-2";
    await rejectsWith(h.pool.extract(JPEG()), "config_mismatch");
    assert.ok(h.workers[0].terminated);
    await h.pool.shutdown();
  });

  test("engine load failure ('fatal') is reported, the worker is replaced with back-off", async () => {
    const workers: FakeWorker[] = [];
    const pool = new FaceExtractPool({
      workers: 1, respawnMinMs: 10, respawnMaxMs: 20, fingerprint: () => FP, modelTag: () => TAG,
      createWorker: (s) => {
        const w = new FakeWorker(s.id, s.env, silent);
        workers.push(w);
        w.send({ type: "fatal", error: "model file missing: /models/w600k_r50.onnx" });
        return w;
      },
    });
    assert.equal(await pool.whenReady(120), false);
    assert.ok(workers.length >= 2, `respawned (${workers.length} spawns)`);
    assert.match(pool.telemetry().lastError ?? "", /model file missing/);
    await rejectsWith(pool.extract(JPEG()), "not_ready");
    await pool.shutdown();
  });

  test("createWorker throwing (entry missing) is not_ready with the reason, never a hang", async () => {
    const pool = new FaceExtractPool({ workers: 1, respawnMinMs: 10, createWorker: () => { throw new Error("entry not found"); } });
    await rejectsWith(pool.extract(JPEG()), "not_ready");
    assert.match(pool.telemetry().lastError ?? "", /entry not found/);
    await pool.shutdown();
  });
});

describe("FaceExtractPool: results", () => {
  test("happy path: frame size, faces, Float32Array embedding, telemetry", async () => {
    const h = harness();
    await h.pool.whenReady(1000);
    const r = await h.pool.extract(JPEG());
    assert.equal(r.width, 640);
    assert.equal(r.height, 480);
    assert.equal(r.modelTag, TAG);
    assert.equal(r.faces.length, 1);
    assert.ok(r.faces[0].embedding instanceof Float32Array);
    assert.equal(r.faces[0].embedding.length, EMBEDDING_DIM);
    const t = h.pool.telemetry();
    assert.equal(t.completed, 1);
    assert.equal(t.failed, 0);
    assert.equal(t.avgWorkerMs, 5);
    assert.equal(t.modelTag, TAG);
    assert.equal(t.ready, true);
    assert.equal(h.workers[0].env.FACE_ORT_THREADS, String(h.pool.ortThreadsPerWorker));
    await h.pool.shutdown();
  });

  test("no face is a RESULT with faces: [] (not an error)", async () => {
    const h = harness({ behaviour: answer([]) });
    await h.pool.whenReady(1000);
    const r = await h.pool.extract(JPEG());
    assert.deepEqual(r.faces, []);
    await h.pool.shutdown();
  });

  test("multi-face results keep the worker's order and every face's fields", async () => {
    const faces = [face({ score: 0.95, embedding: unitEmbedding(1) }), face({ score: 0.7, clear: false, unclearReason: "yaw", embedding: unitEmbedding(2) })];
    const h = harness({ behaviour: answer(faces) });
    await h.pool.whenReady(1000);
    const r = await h.pool.extract(JPEG());
    assert.deepEqual(r.faces.map((f) => f.score), [0.95, 0.7]);
    assert.equal(r.faces[1].clear, false);
    assert.equal(r.faces[1].unclearReason, "yaw");
    await h.pool.shutdown();
  });

  test("low quality / unclear faces pass through unchanged (the pool does not filter)", async () => {
    const h = harness({ behaviour: answer([face({ quality: 0.05, sharpness: 3, boxSize: 30, clear: false, unclearReason: "small" })]) });
    await h.pool.whenReady(1000);
    const r = await h.pool.extract(JPEG());
    assert.equal(r.faces[0].quality, 0.05);
    assert.equal(r.faces[0].unclearReason, "small");
    await h.pool.shutdown();
  });

  test("the caller's Buffer is copied by default and detached only with transfer:true", async () => {
    let lastTransfer: readonly ArrayBuffer[] = [];
    const h = harness({ behaviour: (w, m, t) => { lastTransfer = t; answer()(w, m, t); } });
    await h.pool.whenReady(1000);
    const own = new Uint8Array(new ArrayBuffer(8));
    own.set(JPEG());
    await h.pool.extract(own);
    assert.equal(own.byteLength, 8, "default: caller keeps its bytes");
    assert.equal(lastTransfer.length, 1, "the copy is transferred, not cloned");
    await h.pool.extract(own, { transfer: true });
    assert.equal(own.byteLength, 0, "transfer:true detaches an exclusively-owned buffer");
    const pooled = Buffer.from([0xff, 0xd8, 1, 2]); // small Buffers share Node's pool
    await h.pool.extract(pooled, { transfer: true });
    assert.equal(pooled.length, 4, "a pooled Buffer is copied even with transfer:true");
    await h.pool.shutdown();
  });

  test("worker-reported decode / engine errors are rejections with their code, never []", async () => {
    let code: "decode_failed" | "engine_error" = "decode_failed";
    const h = harness({ behaviour: (w, m) => w.send({ type: "result", id: m.id, ok: false, code, error: "x", ms: 1 }) });
    await h.pool.whenReady(1000);
    await rejectsWith(h.pool.extract(JPEG()), "decode_failed");
    code = "engine_error";
    await rejectsWith(h.pool.extract(JPEG()), "engine_error");
    assert.equal(h.workers.length, 1, "a per-frame error does not recycle the worker");
    const t = h.pool.telemetry();
    assert.equal(t.failedByCode.decode_failed, 1);
    assert.equal(t.failedByCode.engine_error, 1);
    await h.pool.shutdown();
  });

  for (const [name, bad] of [
    ["wrong embedding length", [face({ embedding: new Float32Array(128) })]],
    ["NaN in the embedding", [face({ embedding: new Float32Array(EMBEDDING_DIM).fill(NaN) })]],
    ["embedding as a plain array", [face({ embedding: [1, 2, 3] })]],
    ["faces not an array", "nope"],
  ] as const) {
    test(`corrupted worker result (${name}) -> incompatible_result and the worker is replaced`, async () => {
      const h = harness({ behaviour: (w, m) => w.send({ type: "result", id: m.id, ok: true, width: 10, height: 10, modelTag: TAG, faces: bad as never, ms: 1 }) });
      await h.pool.whenReady(1000);
      await rejectsWith(h.pool.extract(JPEG()), "incompatible_result");
      assert.ok(h.workers[0].terminated);
      await h.pool.shutdown();
    });
  }

  test("a result stamped with another model tag is refused (never compare incompatible embeddings)", async () => {
    const h = harness({ behaviour: (w, m) => w.send({ type: "result", id: m.id, ok: true, width: 10, height: 10, modelTag: "arcface_w600k_mbf", faces: [face()], ms: 1 }) });
    await h.pool.whenReady(1000);
    const err = await rejectsWith(h.pool.extract(JPEG()), "incompatible_result");
    assert.match(err.message, /model tag/);
    await h.pool.shutdown();
  });

  test("corrupted / invalid input is rejected before reaching a worker", async () => {
    const h = harness();
    await h.pool.whenReady(1000);
    await rejectsWith(h.pool.extract(Buffer.alloc(0)), "invalid_input");
    await rejectsWith(h.pool.extract(""), "invalid_input");
    await rejectsWith(h.pool.extract(42 as unknown as Buffer), "invalid_input");
    await rejectsWith(h.pool.extract(Buffer.alloc(33 * 1024 * 1024)), "invalid_input");
    assert.equal(h.workers[0].received.length, 0);
    await h.pool.shutdown();
  });

  test("stale or unknown result ids are ignored", async () => {
    const h = harness({
      behaviour: (w, m) => {
        w.send({ type: "result", id: m.id + 1000, ok: true, width: 1, height: 1, modelTag: TAG, faces: [], ms: 1 });
        answer()(w, m, []);
      },
    });
    await h.pool.whenReady(1000);
    const r = await h.pool.extract(JPEG());
    assert.equal(r.width, 640);
    await h.pool.shutdown();
  });
});

describe("FaceExtractPool: overload, timeout, crash, shutdown", () => {
  test("bounded queue: busy worker + full queue -> 'overloaded' at once", async () => {
    const h = harness({ behaviour: silent, queueMax: 1, taskTimeoutMs: 5000 });
    await h.pool.whenReady(1000);
    const a = h.pool.extract(JPEG());
    const b = h.pool.extract(JPEG());
    await rejectsWith(h.pool.extract(JPEG()), "overloaded");
    const t = h.pool.telemetry();
    assert.equal(t.busy, 1);
    assert.equal(t.queued, 1);
    assert.equal(t.failedByCode.overloaded, 1);
    await h.pool.shutdown();
    await rejectsWith(a, "shutdown");
    await rejectsWith(b, "shutdown");
  });

  test("queued tasks run when the worker frees up, in order", async () => {
    const pending: HostToWorker[] = [];
    let wk: FakeWorker | null = null;
    const h = harness({ behaviour: (w, m) => { wk = w; pending.push(m); }, queueMax: 4 });
    await h.pool.whenReady(1000);
    const ps = [h.pool.extract(JPEG()), h.pool.extract(JPEG()), h.pool.extract(JPEG())];
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setImmediate(r));
      const m = pending.shift()!;
      wk!.send({ type: "result", id: m.id, ok: true, width: 100 + i, height: 1, modelTag: TAG, faces: [], ms: 1 });
      await new Promise((r) => setImmediate(r));
    }
    const rs = await Promise.all(ps);
    assert.deepEqual(rs.map((r) => r.width), [100, 101, 102]);
    await h.pool.shutdown();
  });

  test("per-task timeout: rejected 'timeout', the stuck worker is terminated and replaced", async () => {
    const h = harness({ behaviour: silent, taskTimeoutMs: 100 });
    await h.pool.whenReady(1000);
    const t0 = Date.now();
    await rejectsWith(h.pool.extract(JPEG()), "timeout");
    assert.ok(Date.now() - t0 < 1500);
    assert.ok(h.workers[0].terminated);
    h.setBehaviour(answer());
    assert.equal(await h.pool.whenReady(1000), true);
    assert.equal(h.workers.length, 2, "replacement spawned");
    const r = await h.pool.extract(JPEG());
    assert.equal(r.faces.length, 1, "the replacement serves the next frame");
    await h.pool.shutdown();
  });

  test("a queued task that waits longer than the budget is rejected 'timeout' (each run stays inside it)", async () => {
    // Each run answers after 100 ms (< 150 ms budget); the third frame waits ~200 ms in the queue.
    const h = harness({ behaviour: (w, m) => setTimeout(() => answer()(w, m, []), 100), taskTimeoutMs: 150, queueMax: 2 });
    await h.pool.whenReady(1000);
    const a = h.pool.extract(JPEG());
    const b = h.pool.extract(JPEG());
    const c = rejectsWith(h.pool.extract(JPEG()), "timeout");
    assert.equal((await a).faces.length, 1);
    assert.equal((await b).faces.length, 1);
    await c;
    assert.equal(h.workers.length, 1, "a queue timeout does not replace a healthy worker");
    await h.pool.shutdown();
  });

  test("worker crash mid-task: in-flight rejected 'worker_crashed', queued rejected 'not_ready', worker replaced", async () => {
    const h = harness({ behaviour: silent, queueMax: 2 });
    await h.pool.whenReady(1000);
    const a = h.pool.extract(JPEG());
    const b = h.pool.extract(JPEG());
    await new Promise((r) => setImmediate(r));
    h.workers[0].emit("exit", 1);
    await rejectsWith(a, "worker_crashed");
    await rejectsWith(b, "not_ready");
    h.setBehaviour(answer());
    assert.equal(await h.pool.whenReady(1000), true);
    assert.equal(h.workers.length, 2);
    assert.equal((await h.pool.extract(JPEG())).faces.length, 1);
    assert.ok(h.pool.telemetry().restarts >= 1);
    await h.pool.shutdown();
  });

  test("worker 'error' event is a crash too", async () => {
    const h = harness({ behaviour: silent });
    await h.pool.whenReady(1000);
    const a = h.pool.extract(JPEG());
    await new Promise((r) => setImmediate(r));
    h.workers[0].emit("error", new Error("native abort"));
    const err = await rejectsWith(a, "worker_crashed");
    assert.match(err.message, /native abort/);
    await h.pool.shutdown();
  });

  test("two workers serve two frames at once", async () => {
    const pending: Array<{ w: FakeWorker; m: HostToWorker }> = [];
    const h = harness({ workers: 2, behaviour: (w, m) => pending.push({ w, m }) });
    await h.pool.whenReady(1000);
    await new Promise((r) => setTimeout(r, 10));
    const a = h.pool.extract(JPEG());
    const b = h.pool.extract(JPEG());
    assert.equal(pending.length, 2);
    assert.notEqual(pending[0].w, pending[1].w);
    assert.equal(h.pool.telemetry().busy, 2);
    for (const p of pending) p.w.send({ type: "result", id: p.m.id, ok: true, width: 1, height: 1, modelTag: TAG, faces: [], ms: 1 });
    await Promise.all([a, b]);
    await h.pool.shutdown();
  });

  test("shutdown rejects later calls", async () => {
    const h = harness();
    await h.pool.whenReady(1000);
    await h.pool.shutdown();
    await rejectsWith(h.pool.extract(JPEG()), "shutdown");
    assert.ok(h.workers[0].terminated);
  });
});

describe("FaceExtractPool: real worker entry", () => {
  test("resolveFaceExtractWorkerEntry finds the .ts source under tsx; a bad override throws", () => {
    assert.equal(resolveFaceExtractWorkerEntry(), path.join(process.cwd(), "src", "server", "faceExtractWorker.ts"));
    const prev = process.env.FACE_EXTRACT_WORKER_PATH;
    try {
      process.env.FACE_EXTRACT_WORKER_PATH = "/nonexistent/faceExtractWorker.cjs";
      assert.throws(() => resolveFaceExtractWorkerEntry(), /missing file/);
    } finally {
      if (prev === undefined) delete process.env.FACE_EXTRACT_WORKER_PATH;
      else process.env.FACE_EXTRACT_WORKER_PATH = prev;
    }
  });

  test("real worker without models: never ready, reason reported, calls fail closed, no hang", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "no-models-"));
    const prev = process.env.FACE_MODEL_DIR;
    process.env.FACE_MODEL_DIR = empty;
    const pool = new FaceExtractPool({ workers: 1, respawnMinMs: 60_000, fingerprint: () => FP, modelTag: () => TAG });
    try {
      assert.equal(await pool.whenReady(8000), false);
      // The fatal message arrives once the worker tried to load.
      for (let i = 0; i < 80 && !/model file missing/.test(pool.telemetry().lastError ?? ""); i++) await new Promise((r) => setTimeout(r, 100));
      assert.match(pool.telemetry().lastError ?? "", /model file missing/);
      await rejectsWith(pool.extract(JPEG()), "not_ready");
    } finally {
      await pool.shutdown();
      if (prev === undefined) delete process.env.FACE_MODEL_DIR;
      else process.env.FACE_MODEL_DIR = prev;
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
