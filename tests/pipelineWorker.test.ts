/**
 * The pipeline worker for real (F11):
 *  - the worker entry resolves under tsx (and PIPELINE_WORKER_PATH is strict);
 *  - a worker thread whose inference blocks ITS thread for 300 ms per frame
 *    leaves the main event loop responsive (the rc1 failure mode);
 *  - the production entry without model files fails closed and stops cleanly;
 *  - PipelineCore: no context / no engine -> no decision; crops only on request;
 *    results never carry pixels.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

import type { Frame, FrameSource, Gate, SourceState } from "../src/server/pipeline/contracts";
import { DEFAULT_FUSION_THRESHOLDS, FaceGallery } from "../src/server/faceFusion";
import type { DecisionContext, TrackDecisionResult } from "../src/server/pipeline/trackDecision";
import { GatePipeline, pipelineWorkerEnv, resolvePipelineWorkerEntry, type PipelineWorkerLike } from "../src/server/pipeline/gatePipeline";
import { PipelineCore, type PipelineEngine } from "../src/server/pipeline/pipelineCore";
import type { WorkerToHost } from "../src/server/pipeline/pipelineProtocol";
import type { FaceBox } from "../src/server/faceEmbedding";
import { lowerThreadPriority } from "../src/server/pipeline/pipelineWorker";
import { trackIdPrefix } from "../src/server/pipeline/gateId";

const TAG = "arcface_test";
const DIMS = 512;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

class FakeSource extends EventEmitter implements FrameSource {
  readonly gate: Gate = "exit";
  private newest: Frame | null = null;
  private seq = 0;
  start() {}
  stop() {}
  latest() { return this.newest; }
  motion() { return true; }
  getState(): SourceState {
    return { gate: "exit", status: "streaming", fps: 8, newestFrameAgeMs: 0, reconnects: 0, since: new Date(0).toISOString() };
  }
  push(bytes = 640 * 360 * 3): Frame {
    const f: Frame = {
      gate: "exit", streamId: "exit-test", seq: this.seq++, capturedAtMs: Date.now(), width: 640, height: 360,
      roi: [0, 0, 640, 360], sourceWidth: 640, sourceHeight: 360, rgb: new Uint8Array(bytes),
    };
    this.newest = f;
    this.emit("frame", f);
    return f;
  }
}

function unitVec(seed: number): number[] {
  let a = seed >>> 0;
  const v = Array.from({ length: DIMS }, () => {
    a = (Math.imul(a ^ (a >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
    return (a / 4294967296) - 0.5;
  });
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}
const ALICE = unitVec(11);
const ctx = (): DecisionContext => ({
  gallery: new Map([["ALICE", [ALICE]]]) as FaceGallery,
  galleryModelTag: TAG, engineModelTag: TAG, thresholds: { ...DEFAULT_FUSION_THRESHOLDS }, engineReady: true,
});

describe("pipeline worker entry", () => {
  it("PIPELINE_WORKER_NICE: default 10, 0 = unchanged, out of range is refused", () => {
    assert.equal(lowerThreadPriority("0"), null);
    assert.match(lowerThreadPriority("25") || "", /0-19/);
    assert.match(lowerThreadPriority("-5") || "", /0-19/);
  });

  it("resolves the .ts source under tsx", () => {
    const entry = resolvePipelineWorkerEntry();
    assert.match(entry.replace(/\\/g, "/"), /src\/server\/pipeline\/pipelineWorker\.ts$|pipelineWorker\.cjs$/);
  });

  it("workers inherit the FACE_* engine settings unless a PIPELINE_* override is valid", () => {
    assert.equal(pipelineWorkerEnv({ FACE_ORT_THREADS: "2" }).FACE_ORT_THREADS, "2");
    assert.equal(pipelineWorkerEnv({ FACE_ORT_THREADS: "2", PIPELINE_ORT_THREADS: "1" }).FACE_ORT_THREADS, "1");
    assert.equal(pipelineWorkerEnv({ FACE_ORT_THREADS: "2", PIPELINE_ORT_THREADS: "0" }).FACE_ORT_THREADS, "2");
    assert.equal(pipelineWorkerEnv({ PIPELINE_ORT_THREADS: "abc" }).FACE_ORT_THREADS, undefined);
    assert.equal(pipelineWorkerEnv({ FACE_DETECT_SIZE: "640", PIPELINE_DETECT_SIZE: "1280" }).FACE_DETECT_SIZE, "1280");
    assert.equal(pipelineWorkerEnv({ FACE_DETECT_SIZE: "640", PIPELINE_DETECT_SIZE: "1000" }).FACE_DETECT_SIZE, "640", "not a multiple of 32");
    assert.equal(pipelineWorkerEnv({ PIPELINE_DETECTOR_VARIANT: "INT8" }).FACE_DETECTOR_VARIANT, "int8");
    assert.equal(pipelineWorkerEnv({ PIPELINE_DETECTOR_VARIANT: "int8", PIPELINE_DETECT_SIZE: "1280" }).FACE_DETECT_SIZE, undefined, "INT8 input is fixed at 640");
    assert.equal(pipelineWorkerEnv({ FACE_DETECTOR_VARIANT: "int8", PIPELINE_DETECTOR_VARIANT: "fp32", PIPELINE_DETECT_SIZE: "1280" }).FACE_DETECT_SIZE, "1280");
    assert.equal(pipelineWorkerEnv({ FACE_DETECTOR_VARIANT: "fp32", PIPELINE_DETECTOR_VARIANT: "int4" }).FACE_DETECTOR_VARIANT, "fp32");
    const env = { FACE_ORT_THREADS: "4" };
    pipelineWorkerEnv({ ...env, PIPELINE_ORT_THREADS: "1" });
    assert.equal(env.FACE_ORT_THREADS, "4", "the main engine's setting is not touched");
  });

  it("PIPELINE_DETECTOR_MODEL selects a detector FILE for the workers only (no paths)", () => {
    assert.equal(pipelineWorkerEnv({ PIPELINE_DETECTOR_MODEL: "det_10g_int8_dyn.onnx" }).FACE_DETECTOR_MODEL, "det_10g_int8_dyn.onnx");
    assert.equal(pipelineWorkerEnv({ FACE_DETECTOR_MODEL: "det_10g.onnx", PIPELINE_DETECTOR_MODEL: "../x.onnx" }).FACE_DETECTOR_MODEL, "det_10g.onnx");
    assert.equal(pipelineWorkerEnv({ PIPELINE_DETECTOR_MODEL: "/models/det.onnx" }).FACE_DETECTOR_MODEL, undefined);
    assert.equal(pipelineWorkerEnv({ PIPELINE_DETECTOR_MODEL: "det.bin" }).FACE_DETECTOR_MODEL, undefined);
    assert.equal(pipelineWorkerEnv({ PIPELINE_DETECTOR_MODEL: ".hidden.onnx" }).FACE_DETECTOR_MODEL, undefined);
    // An explicit file lifts the "INT8 is fixed at 640" guard (the dims check in the worker covers it).
    assert.equal(pipelineWorkerEnv({ PIPELINE_DETECTOR_VARIANT: "int8", PIPELINE_DETECTOR_MODEL: "det_10g_int8_dyn.onnx", PIPELINE_DETECT_SIZE: "1280" }).FACE_DETECT_SIZE, "1280");
  });

  it("PIPELINE_DETECT_INPUT auto/<W>x<H> silence ORT's per-frame shape warnings unless FACE_ORT_LOG_LEVEL is set", () => {
    assert.equal(pipelineWorkerEnv({ PIPELINE_DETECT_INPUT: "auto" }).FACE_ORT_LOG_LEVEL, "3");
    assert.equal(pipelineWorkerEnv({ PIPELINE_DETECT_INPUT: "auto:960" }).FACE_ORT_LOG_LEVEL, "3");
    assert.equal(pipelineWorkerEnv({ PIPELINE_DETECT_INPUT: "1824x224" }).FACE_ORT_LOG_LEVEL, "3");
    assert.equal(pipelineWorkerEnv({ PIPELINE_DETECT_INPUT: "tiles:4" }).FACE_ORT_LOG_LEVEL, undefined);
    assert.equal(pipelineWorkerEnv({ PIPELINE_DETECT_INPUT: "" }).FACE_ORT_LOG_LEVEL, undefined);
    assert.equal(pipelineWorkerEnv({}).FACE_ORT_LOG_LEVEL, undefined);
    assert.equal(pipelineWorkerEnv({ PIPELINE_DETECT_INPUT: "auto", FACE_ORT_LOG_LEVEL: "1" }).FACE_ORT_LOG_LEVEL, "1");
    assert.equal(pipelineWorkerEnv({ PIPELINE_DETECT_INPUT: "auto" }).PIPELINE_DETECT_INPUT, "auto", "the worker reads the plan itself");
  });

  it("PIPELINE_WORKER_PATH is strict", () => {
    const prev = process.env.PIPELINE_WORKER_PATH;
    process.env.PIPELINE_WORKER_PATH = "/nonexistent/pipelineWorker.cjs";
    try {
      assert.throws(() => resolvePipelineWorkerEntry(), /missing file/);
    } finally {
      if (prev === undefined) delete process.env.PIPELINE_WORKER_PATH;
      else process.env.PIPELINE_WORKER_PATH = prev;
    }
  });
});

describe("pipeline worker thread", () => {
  it("keeps the main event loop responsive while inference blocks the worker (F11)", async () => {
    const fixture = path.resolve("tests/fixtures/blockingPipelineWorker.ts");
    const source = new FakeSource();
    const pipeline = new GatePipeline({
      gate: "exit",
      source,
      context: ctx,
      onResult: () => {},
      createWorker: () => new Worker(fixture, { workerData: { blockMs: 300 } }) as unknown as PipelineWorkerLike,
    });
    pipeline.start();
    // Main-thread timer lag while frames arrive at ~8 fps for ~2.4 s.
    let maxLag = 0;
    let last = Date.now();
    const probe = setInterval(() => {
      const now = Date.now();
      maxLag = Math.max(maxLag, now - last - 20);
      last = now;
    }, 20);
    for (let i = 0; i < 20; i++) {
      source.push();
      await sleep(120);
    }
    clearInterval(probe);
    const st = pipeline.stats();
    await pipeline.stop();
    assert.ok(st.framesProcessed >= 4 && st.framesProcessed <= 10, `processed ${st.framesProcessed} frames at 300 ms each`);
    assert.ok(st.framesDroppedBusy >= 8, `dropped ${st.framesDroppedBusy} while busy`);
    assert.ok(st.lastLoopMs !== undefined && st.lastLoopMs >= 290, `loop ${st.lastLoopMs} ms (worker-side)`);
    assert.ok(maxLag < 150, `main-thread timer lag ${maxLag} ms while the worker blocked 300 ms per frame`);
    assert.equal(st.worker.restarts, 0);
  });

  it("the production worker without model files fails closed and stops cleanly", async () => {
    const prev = process.env.FACE_MODEL_DIR;
    process.env.FACE_MODEL_DIR = "/nonexistent-models-for-test"; // the worker copies env at creation
    const source = new FakeSource();
    const results: TrackDecisionResult[] = [];
    const pipeline = new GatePipeline({ gate: "exit", source, context: ctx, onResult: (r) => results.push(r), statsMs: 100 });
    try {
      pipeline.start();
      await until(() => pipeline.stats().worker.state === "running" && /engine not ready/.test(pipeline.stats().contextReason || ""), 20_000, "worker stats");
      for (let i = 0; i < 3; i++) {
        source.push();
        await sleep(50);
      }
      const st = pipeline.stats();
      assert.equal(st.contextOk, false);
      assert.equal(st.framesProcessed, 0, "no frame is processed without the engine");
      if (fs.existsSync("/proc/thread-self")) {
        // The worker thread lowered its own priority (PIPELINE_WORKER_NICE default 10); this thread did not.
        const nices = fs.readdirSync("/proc/self/task").map((t) => {
          const stat = fs.readFileSync(`/proc/self/task/${t}/stat`, "utf8");
          return { tid: Number(t), nice: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[16]) };
        });
        assert.equal(nices.find((n) => n.tid === process.pid)?.nice, 0, "main thread untouched");
        assert.ok(nices.some((n) => n.nice === 10), `a thread at nice 10: ${JSON.stringify(nices)}`);
      }
      assert.equal(st.worker.engineReady, false);
      assert.equal(results.length, 0);
    } finally {
      const t0 = Date.now();
      await pipeline.stop();
      assert.ok(Date.now() - t0 < 5000, "stop() terminates the worker");
      if (prev === undefined) delete process.env.FACE_MODEL_DIR;
      else process.env.FACE_MODEL_DIR = prev;
    }
    assert.equal(pipeline.stats().worker.state, "stopped");
  });
});

// ---- PipelineCore in isolation --------------------------------------------------

class FakeEngine implements PipelineEngine {
  isReady = true;
  detectCalls = 0;
  constructor(private readonly who: (seq: number) => number[] | null) {}
  seqOf = new WeakMap<Uint8Array, number>();
  ready() { return this.isReady; }
  modelTag() { return TAG; }
  async detect(img: { data: Uint8Array }): Promise<FaceBox[]> {
    this.detectCalls += 1;
    const seq = this.seqOf.get(img.data) ?? -1;
    if (!this.who(seq)) return [];
    const x = 300 + seq * 4, y = 200, s = 100;
    return [{
      box: [x - s / 2, y - s / 2, x + s / 2, y + s / 2], score: 0.95,
      landmarks: [[x - 20, y - 10], [x + 20, y - 10], [x, y + 5], [x - 15, y + 25], [x + 15, y + 25]],
      ...({ __seq: seq } as object),
    }] as FaceBox[];
  }
  private lastSeq = -1;
  align(img: { data: Uint8Array }) { this.lastSeq = this.seqOf.get(img.data) ?? -1; return { width: 112, height: 112, data: new Uint8Array(1) }; }
  async embed() { const v = this.who(this.lastSeq); return v ? Float32Array.from(v) : null; }
  quality() { return 0.8; }
  clearIssue(_l: Array<[number, number]>, size: number) { return size >= 60 ? null : "small"; }
}

function coreSetup(opts: { crops?: boolean; who?: (seq: number) => number[] | null; gate?: Gate; init?: boolean } = {}) {
  const gate = "gate" in opts ? (opts.gate as Gate) : "exit";
  const msgs: WorkerToHost[] = [];
  const engine = new FakeEngine(opts.who ?? (() => ALICE));
  let cropCalls = 0;
  const core = new PipelineCore({
    engine,
    post: (m) => msgs.push(structuredClone(m)),
    cropper: async () => { cropCalls += 1; return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); },
  });
  const init = (g: Gate = gate) => core.handle({ type: "init", gate: g, crops: opts.crops === true, tickMs: 20, statsMs: 10_000 });
  if (opts.init !== false) init();
  let seq = 0;
  const frame = (): Frame => {
    const f: Frame = {
      gate, streamId: `${gate}-test`, seq: seq++, capturedAtMs: Date.now(), width: 640, height: 360,
      roi: [0, 0, 640, 360], sourceWidth: 640, sourceHeight: 360, rgb: new Uint8Array(640 * 360 * 3),
    };
    engine.seqOf.set(f.rgb, f.seq);
    return f;
  };
  const send = async (n: number) => {
    for (let i = 0; i < n; i++) {
      core.handle({ type: "frame", frame: frame() });
      await sleep(30);
    }
  };
  return { core, msgs, engine, send, init, cropCalls: () => cropCalls };
}
const resultsOf = (msgs: WorkerToHost[]) => msgs.flatMap((m) => (m.type === "results" ? m.results : []));

describe("PipelineCore", () => {
  it("answers every frame, but decides nothing without a context", async () => {
    const { core, msgs, engine, send } = coreSetup();
    await send(4);
    const done = msgs.filter((m) => m.type === "frame-done");
    assert.equal(done.length, 4);
    assert.ok(done.every((m) => m.type === "frame-done" && !m.processed));
    assert.equal(engine.detectCalls, 0);
    core.handle({ type: "stop" });
    await sleep(20);
    assert.equal(resultsOf(msgs).length, 0);
    assert.ok(msgs.some((m) => m.type === "stopped"));
  });

  it("decides nothing while its own engine is not loaded, then recovers when it is", async () => {
    const { core, msgs, engine, send } = coreSetup();
    engine.isReady = false;
    core.handle({ type: "context", version: 1, context: ctx() });
    await send(3);
    assert.equal(engine.detectCalls, 0);
    const stats = msgs.filter((m) => m.type === "stats").at(-1) as any;
    assert.match(stats.stats.contextReason, /face engine not ready/);
    engine.isReady = true;
    core.engineChanged();
    await send(6);
    assert.ok(engine.detectCalls >= 5);
    assert.equal(resultsOf(msgs).filter((r) => r.outcome.kind === "employee").length, 1);
    core.handle({ type: "stop" });
    await sleep(20);
  });

  it("results carry no pixels, and a crop only when crops are on", async () => {
    for (const crops of [false, true]) {
      const { core, msgs, send, cropCalls } = coreSetup({ crops });
      core.handle({ type: "context", version: 1, context: ctx() });
      await send(6);
      const [emp] = resultsOf(msgs).filter((r) => r.outcome.kind === "employee");
      assert.ok(emp, `employee decided (crops ${crops})`);
      const best = (emp.outcome as any).best;
      assert.equal("rgb" in best.frame, false, "no frame pixels on the wire");
      assert.equal(best.crop !== undefined, crops);
      assert.equal(cropCalls(), crops ? 1 : 0);
      core.handle({ type: "stop" });
      await sleep(20);
    }
  });

  it("stop() ends open tracks: a stranger is reported once, then `stopped`", async () => {
    const STRANGER = unitVec(99);
    const { core, msgs, send } = coreSetup({ who: () => STRANGER });
    core.handle({ type: "context", version: 1, context: ctx() });
    await send(5);
    assert.equal(resultsOf(msgs).length, 0);
    core.handle({ type: "stop" });
    await until(() => msgs.some((m) => m.type === "stopped"), 1000, "stopped");
    const r = resultsOf(msgs);
    assert.equal(r.length, 1);
    assert.equal(r[0].outcome.kind, "stranger");
    const iResults = msgs.findIndex((m) => m.type === "results");
    const iStopped = msgs.findIndex((m) => m.type === "stopped");
    assert.ok(iResults < iStopped, "outcomes before `stopped`");
    core.handle({ type: "frame", frame: { ...({} as Frame), seq: 1 } as Frame });
    await sleep(10);
    assert.equal(msgs.filter((m) => m.type === "frame-done").length, 5, "frames after stop are ignored");
  });
});

describe("pipelineWorkerEnv: PIPELINE_MIN_FACE_PX (pipeline-only face-size floor)", () => {
  it("sets the worker's floor only when given, leaving the door engine's untouched", () => {
    const base = { FACE_MIN_SIZE_PX: "60" } as NodeJS.ProcessEnv;
    assert.equal(pipelineWorkerEnv(base).FACE_MIN_SIZE_PX, "60");
    assert.equal(pipelineWorkerEnv({ ...base, PIPELINE_MIN_FACE_PX: "40" }).FACE_MIN_SIZE_PX, "40");
    assert.equal(base.FACE_MIN_SIZE_PX, "60");
  });
  it("ignores out-of-range or non-integer values", () => {
    for (const bad of ["10", "4000", "40.5", "abc", ""]) {
      assert.equal(pipelineWorkerEnv({ FACE_MIN_SIZE_PX: "60", PIPELINE_MIN_FACE_PX: bad } as NodeJS.ProcessEnv).FACE_MIN_SIZE_PX, "60", bad);
    }
  });
});

describe("PipelineCore: gate ids", () => {
  it("a third gate decides under its own id and derived track-id prefix", async () => {
    const { core, msgs, send } = coreSetup({ gate: "side-door" });
    core.handle({ type: "context", version: 1, context: ctx() });
    await send(6);
    core.handle({ type: "stop" });
    await sleep(30);
    const results = resultsOf(msgs);
    const emp = results.find((r) => r.outcome.kind === "employee");
    assert.ok(emp, JSON.stringify(results.map((r) => r.basis)));
    for (const r of results) {
      assert.equal(r.outcome.gate, "side-door");
      assert.ok(r.outcome.trackId.startsWith(`${trackIdPrefix("side-door")}-`), r.outcome.trackId);
    }
  });

  it("legacy gates keep the E-/X- track ids", async () => {
    for (const [gate, prefix] of [["entry", "E-"], ["exit", "X-"]] as const) {
      const { core, msgs, send } = coreSetup({ gate });
      core.handle({ type: "context", version: 1, context: ctx() });
      await send(6);
      core.handle({ type: "stop" });
      await sleep(30);
      const results = resultsOf(msgs);
      assert.ok(results.length >= 1, gate);
      for (const r of results) assert.ok(r.outcome.trackId.startsWith(prefix), `${gate}: ${r.outcome.trackId}`);
    }
  });

  it("refuses an init with an invalid gate id: never decides, answers frames unprocessed, says why", async () => {
    for (const bad of ["ENTRY", "EXIT", "", "Side-Door", undefined]) {
      const { core, msgs, engine, send } = coreSetup({ gate: bad as Gate });
      core.handle({ type: "context", version: 1, context: ctx() });
      await send(3);
      assert.equal(engine.detectCalls, 0, String(bad));
      const done = msgs.filter((m) => m.type === "frame-done");
      assert.equal(done.length, 3);
      assert.ok(done.every((m) => m.type === "frame-done" && !m.processed));
      assert.ok(msgs.some((m) => m.type === "error" && /init refused: invalid gate id/.test(m.message)), String(bad));
      assert.match(core.stats().contextReason || "", /init refused/);
      assert.equal(core.stats().contextOk, false);
      core.handle({ type: "stop" });
      await sleep(20);
      assert.equal(resultsOf(msgs).length, 0);
    }
  });

  it("a context that arrives before init is applied once the gate is known", async () => {
    const { core, msgs, engine, send, init } = coreSetup({ gate: "side-door", init: false });
    core.handle({ type: "context", version: 1, context: ctx() });
    await sleep(20);
    assert.equal(core.stats().contextOk, false, "no session without a gate");
    init();
    await send(6);
    assert.ok(engine.detectCalls >= 5);
    assert.equal(resultsOf(msgs).filter((r) => r.outcome.kind === "employee").length, 1);
    core.handle({ type: "stop" });
    await sleep(20);
  });
});
