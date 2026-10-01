/**
 * GatePipeline host <-> pipeline worker protocol (F11) with a scripted fake
 * worker: newest-only hand-off with the RGB buffer transferred, drops while
 * busy, context pushed on start and only when it changes, fail closed without
 * a context, crash/hang -> restart with back-off, stop() hands back the final
 * outcomes and terminates the worker.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import type { Frame, FrameSource, Gate, SourceState } from "../src/server/pipeline/contracts";
import { DEFAULT_FUSION_THRESHOLDS, FaceGallery } from "../src/server/faceFusion";
import type { DecisionContext, TrackDecisionResult } from "../src/server/pipeline/trackDecision";
import { GatePipeline, type GatePipelineOptions, type PipelineWorkerLike } from "../src/server/pipeline/gatePipeline";
import { contextFingerprint, type HostToWorker, type WireResult, type WorkerToHost } from "../src/server/pipeline/pipelineProtocol";

const TAG = "arcface_test";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000, what = "condition") {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

class FakeSource extends EventEmitter implements FrameSource {
  readonly gate: Gate = "entry";
  moving = true;
  stopped = 0;
  private newest: Frame | null = null;
  private seq = 0;
  start() {}
  stop() { this.stopped += 1; }
  latest() { return this.newest; }
  motion() { return this.moving; }
  getState(): SourceState {
    return { gate: "entry", status: "streaming", fps: 8, newestFrameAgeMs: 0, reconnects: 0, since: new Date(0).toISOString() };
  }
  push(): Frame {
    const f: Frame = {
      gate: "entry", streamId: "entry-test", seq: this.seq++, capturedAtMs: Date.now(), width: 4, height: 2,
      roi: [0, 0, 4, 2], sourceWidth: 4, sourceHeight: 2, rgb: new Uint8Array(24).fill(this.seq),
    };
    this.newest = f;
    this.emit("frame", f);
    return f;
  }
}

/** A worker that records what it is sent and answers only when told to. */
class FakeWorker extends EventEmitter implements PipelineWorkerLike {
  readonly sent: Array<{ msg: HostToWorker; transfer?: ReadonlyArray<ArrayBuffer> }> = [];
  terminated = 0;
  /** Reply to "stop" with results + stopped (like the real worker). */
  answerStop = true;
  stopResults: WireResult[] = [];
  postMessage(msg: HostToWorker, transfer?: ReadonlyArray<ArrayBuffer>) {
    this.sent.push({ msg, transfer });
    if (msg.type === "stop" && this.answerStop) {
      setImmediate(() => {
        if (this.stopResults.length) this.reply({ type: "results", results: this.stopResults });
        this.reply({ type: "stopped" });
      });
    }
  }
  terminate() {
    this.terminated += 1;
    return Promise.resolve(0);
  }
  reply(msg: WorkerToHost) {
    this.emit("message", msg);
  }
  frames() {
    return this.sent.filter((s) => s.msg.type === "frame") as Array<{ msg: Extract<HostToWorker, { type: "frame" }>; transfer?: ReadonlyArray<ArrayBuffer> }>;
  }
  of(type: HostToWorker["type"]) {
    return this.sent.filter((s) => s.msg.type === type).map((s) => s.msg);
  }
  done(seq: number, processed = true) {
    this.reply({ type: "frame-done", seq, processed, loopMs: 42, detections: 1, embeddings: 0 });
  }
}

const gallery = (n: number): FaceGallery => new Map(Array.from({ length: n }, (_, i) => [`E${i}`, [[1, 0, 0, i / 10]]]));
const ctxOf = (g: FaceGallery): DecisionContext => ({
  gallery: g, galleryModelTag: TAG, engineModelTag: TAG, thresholds: { ...DEFAULT_FUSION_THRESHOLDS }, engineReady: true,
});

function setup(over: Partial<GatePipelineOptions> = {}) {
  const source = new FakeSource();
  const workers: FakeWorker[] = [];
  const results: TrackDecisionResult[] = [];
  const errors: string[] = [];
  let ctx: DecisionContext | null = ctxOf(gallery(2));
  const pipeline = new GatePipeline({
    gate: "entry",
    source,
    context: () => ctx,
    onResult: (r) => results.push(r),
    onError: (m) => errors.push(m),
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    contextRefreshMs: 20,
    restartBackoffInitialMs: 30,
    restartBackoffMaxMs: 120,
    stopTimeoutMs: 200,
    ...over,
  });
  return { source, workers, results, errors, pipeline, setCtx: (c: DecisionContext | null) => { ctx = c; }, w: () => workers[workers.length - 1] };
}

const employeeWire = (trackId: string, crop?: Uint8Array): WireResult => ({
  outcome: {
    kind: "employee", gate: "entry", trackId, employeeId: "E1", decidedAtMs: 2000, fused: { basis: "multi-agree" },
    best: {
      frame: { gate: "entry", streamId: "entry-test", seq: 3, capturedAtMs: 1900, width: 4, height: 2, roi: [0, 0, 4, 2], sourceWidth: 4, sourceHeight: 2 },
      detection: { box: [0, 0, 2, 2], landmarks: [], score: 0.9, sizePx: 80, clear: true }, quality: 0.8,
      ...(crop ? { crop } : {}),
    },
  },
  shadow: { gate: "entry", outcome: "employee", trackId, employeeId: "E1", firstSeenAtMs: 1000, firstUsableAtMs: 1500, decidedAtMs: 2000, framesSeen: 5, framesUsed: 2 },
  basis: "multi-agree",
  fusionBasis: "multi-agree",
});

describe("GatePipeline host: frame hand-off", () => {
  it("starts the worker with init + context, then sends frames with the RGB buffer transferred", async () => {
    const { source, pipeline, w } = setup();
    pipeline.start();
    const worker = w();
    assert.deepEqual(worker.sent.map((s) => s.msg.type), ["init", "context"]);
    assert.equal((worker.sent[0].msg as any).crops, false, "crops are off unless asked for");
    const f = source.push();
    const [sent] = worker.frames();
    assert.equal(sent.msg.frame.seq, f.seq);
    assert.deepEqual(sent.transfer, [f.rgb.buffer], "the frame's own buffer is transferred, not copied");
    await pipeline.stop();
  });

  it("never queues: while the worker is busy only the newest frame waits, the rest are dropped", async () => {
    const { source, pipeline, w } = setup();
    pipeline.start();
    const worker = w();
    source.push(); // seq 0 -> sent, worker busy
    for (let i = 0; i < 5; i++) source.push(); // seq 1..5 arrive while busy
    assert.equal(worker.frames().length, 1, "nothing else is sent while busy");
    worker.done(0);
    assert.equal(worker.frames().length, 2);
    assert.equal(worker.frames()[1].msg.frame.seq, 5, "the newest frame is sent next");
    const st = pipeline.stats();
    assert.equal(st.framesDroppedBusy, 4);
    assert.equal(st.framesProcessed, 1);
    assert.equal(st.lastLoopMs, 42);
    worker.done(5);
    assert.equal(worker.frames().length, 2, "no resend of an already offered frame");
    await pipeline.stop();
  });

  it("copies a frame whose buffer is shared before transferring it", async () => {
    const { source, pipeline, w } = setup();
    pipeline.start();
    const shared = new Uint8Array(64);
    const f = source.push();
    // Replace the pending frame with one that views a slice of a bigger buffer.
    const worker = w();
    worker.done(0);
    const g = { ...f, seq: 99, rgb: shared.subarray(8, 32) };
    (source as any).newest = g;
    source.emit("frame", g);
    const last = worker.frames().at(-1)!;
    assert.equal(last.msg.frame.seq, 99);
    assert.notEqual(last.msg.frame.rgb.buffer, shared.buffer);
    assert.equal(last.transfer?.[0], last.msg.frame.rgb.buffer);
    assert.equal(last.msg.frame.rgb.byteLength, 24);
    await pipeline.stop();
  });

  it("skips still frames but sends one per keep-alive", async () => {
    const { source, pipeline, w } = setup({ keepAliveMs: 60 });
    pipeline.start();
    source.moving = false;
    const worker = w();
    source.push(); // first look always goes
    worker.done(0);
    source.push();
    source.push();
    assert.equal(worker.frames().length, 1);
    assert.equal(pipeline.stats().framesSkippedStill, 2);
    await sleep(70);
    source.push();
    assert.equal(worker.frames().length, 2, "keep-alive look");
    await pipeline.stop();
  });
});

describe("GatePipeline host: decision context", () => {
  it("pushes the context on start and again only when it changes", async () => {
    const { pipeline, w, setCtx } = setup();
    pipeline.start();
    const worker = w();
    await sleep(80);
    assert.equal(worker.of("context").length, 1, "unchanged context is not re-sent");
    setCtx(ctxOf(gallery(3))); // an employee enrolled
    await until(() => worker.of("context").length === 2, 500, "context push");
    const pushed = worker.of("context")[1] as any;
    assert.equal(pushed.context.gallery.size, 3);
    setCtx({ ...ctxOf(gallery(3)), thresholds: { ...DEFAULT_FUSION_THRESHOLDS, acceptSingle: 0.6 } });
    await until(() => worker.of("context").length === 3, 500, "threshold change push");
    await pipeline.stop();
  });

  it("fails closed: without a context no frame is sent and stats say why", async () => {
    const { source, pipeline, w, setCtx } = setup();
    setCtx(null);
    pipeline.start();
    const worker = w();
    assert.equal((worker.of("context")[0] as any).context, null);
    source.push();
    source.push();
    assert.equal(worker.frames().length, 0);
    const st = pipeline.stats();
    assert.equal(st.contextOk, false);
    assert.match(st.contextReason || "", /no decision context/);
    assert.equal(st.framesSkippedNoContext, 2);
    await pipeline.stop();
  });

  it("reports the worker's own verdict on the context (e.g. its engine not loaded)", async () => {
    const { pipeline, w } = setup();
    pipeline.start();
    assert.equal(pipeline.stats().contextOk, false, "not ok before the worker has answered");
    w().reply({ type: "stats", stats: { detections: 0, embeddings: 0, errors: 0, engineReady: false, contextOk: false, contextReason: "pipeline worker: face engine not ready", openTracks: 0 } });
    assert.match(pipeline.stats().contextReason || "", /face engine not ready/);
    w().reply({ type: "stats", stats: { detections: 0, embeddings: 0, errors: 0, engineReady: true, modelTag: TAG, contextOk: true, openTracks: 1 } });
    const st = pipeline.stats();
    assert.equal(st.contextOk, true);
    assert.equal(st.worker.engineReady, true);
    assert.equal(st.worker.modelTag, TAG);
    await pipeline.stop();
  });

  it("the fingerprint notices a replaced template, not only a count change", () => {
    const a = ctxOf(new Map([["E1", [[0.1, 0.2, 0.3]]]]));
    const b = ctxOf(new Map([["E1", [[0.1, 0.2, 0.31]]]]));
    assert.notEqual(contextFingerprint(a), contextFingerprint(b));
    assert.equal(contextFingerprint(a), contextFingerprint(ctxOf(new Map([["E1", [[0.1, 0.2, 0.3]]]]))));
    assert.equal(contextFingerprint(null), "none");
  });
});

describe("GatePipeline host: results", () => {
  it("turns wire results back into TrackDecisionResult (no pixels; crop as Buffer) and counts them", async () => {
    const { pipeline, w, results } = setup();
    pipeline.start();
    w().reply({ type: "results", results: [employeeWire("E-1", new Uint8Array([0xff, 0xd8, 0xff])), { outcome: { kind: "insufficient", gate: "entry", trackId: "E-2", decidedAtMs: 3000 }, shadow: { gate: "entry", outcome: "insufficient", trackId: "E-2", firstSeenAtMs: 1, decidedAtMs: 3000, framesSeen: 2, framesUsed: 0 }, basis: "insufficient-evidence" }] });
    assert.equal(results.length, 2);
    const emp = results[0].outcome as any;
    assert.equal(emp.kind, "employee");
    assert.equal(emp.best.frame.rgb.length, 0, "pixels never come back to the main thread");
    assert.ok(Buffer.isBuffer(emp.best.crop));
    const st = pipeline.stats();
    assert.equal(st.decisions, 2);
    assert.equal(st.employees, 1);
    assert.equal(st.insufficient, 1);
    assert.equal(st.lastDecisionLatencyMs, 500);
    await pipeline.stop();
  });

  it("an exception in onResult is counted, not fatal", async () => {
    const { pipeline, w } = setup({ onResult: () => { throw new Error("boom"); } });
    pipeline.start();
    w().reply({ type: "results", results: [employeeWire("E-1")] });
    const st = pipeline.stats();
    assert.equal(st.loopErrors, 1);
    assert.match(st.lastError || "", /boom/);
    await pipeline.stop();
  });
});

describe("GatePipeline host: worker failures", () => {
  it("a crashed worker is logged, restarted with back-off, and gets init + context again", async () => {
    const { source, pipeline, workers, errors } = setup();
    pipeline.start();
    source.push(); // in flight when it crashes
    workers[0].emit("error", new Error("segfault in ORT"));
    workers[0].emit("exit", 1); // ignored: already handled
    let st = pipeline.stats();
    assert.equal(st.worker.state, "restarting");
    assert.equal(st.worker.restarts, 1);
    assert.match(st.lastError || "", /crashed: segfault in ORT; restart 1 in 0\.0 s|crashed: segfault in ORT; restart 1 in/);
    assert.equal(errors.length, 1, "one line per crash");
    assert.equal(st.contextOk, false);
    source.push(); // arrives while down: not sent anywhere
    await until(() => workers.length === 2, 500, "restart");
    const w2 = workers[1];
    assert.deepEqual(w2.sent.slice(0, 2).map((s) => s.msg.type), ["init", "context"]);
    assert.equal(w2.frames().length, 1, "the newest frame goes to the new worker");
    assert.equal(workers[0].terminated, 1);
    // Late messages of the dead worker are ignored.
    workers[0].reply({ type: "results", results: [employeeWire("old")] });
    assert.equal(pipeline.stats().decisions, 0);
    st = pipeline.stats();
    assert.equal(st.worker.state, "running");
    await pipeline.stop();
  });

  it("back-off doubles on repeated failures and is capped", async () => {
    let attempts = 0;
    const times: number[] = [];
    const { pipeline } = setup({
      createWorker: () => {
        attempts += 1;
        times.push(Date.now());
        throw new Error("Pipeline worker entry not found");
      },
      restartBackoffInitialMs: 20,
      restartBackoffMaxMs: 80,
    });
    assert.doesNotThrow(() => pipeline.start());
    await until(() => attempts >= 5, 2000, "5 attempts");
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    assert.ok(gaps[0] >= 15 && gaps[1] >= 35 && gaps[2] >= 70, `gaps ${gaps}`);
    assert.ok(gaps[3] < 160, `capped: ${gaps}`);
    const st = pipeline.stats();
    assert.match(st.lastError || "", /could not start: Pipeline worker entry not found/);
    assert.ok(st.worker.restarts >= 4);
    await pipeline.stop();
  });

  it("a worker that does not answer a frame is treated as hung and replaced", async () => {
    const { source, pipeline, workers } = setup({ frameTimeoutMs: 60 });
    pipeline.start();
    source.push();
    await until(() => workers.length === 2, 1000, "hung worker replaced");
    assert.match(pipeline.stats().lastError || "", /did not answer a frame/);
    assert.equal(workers[0].terminated, 1);
    await pipeline.stop();
  });
});

describe("GatePipeline host: stop()", () => {
  it("asks the worker to close open tracks, reports their outcomes, then terminates it", async () => {
    const { source, pipeline, w, results } = setup();
    pipeline.start();
    const worker = w();
    worker.stopResults = [employeeWire("E-9")];
    await pipeline.stop();
    assert.equal(source.stopped, 1);
    assert.equal(worker.of("stop").length, 1);
    assert.equal(results.length, 1, "closing outcome reported");
    assert.equal(worker.terminated, 1);
    assert.equal(pipeline.stats().worker.state, "stopped");
    source.push();
    assert.equal(worker.frames().length, 0, "no frames after stop");
  });

  it("terminates a worker that never answers stop after the timeout", async () => {
    const { pipeline, w } = setup({ stopTimeoutMs: 50 });
    pipeline.start();
    w().answerStop = false;
    const t0 = Date.now();
    await pipeline.stop();
    assert.ok(Date.now() - t0 >= 45);
    assert.equal(w().terminated, 1);
  });

  it("stop during a restart back-off does not start a new worker", async () => {
    const { pipeline, workers } = setup({ restartBackoffInitialMs: 50 });
    pipeline.start();
    workers[0].emit("exit", 1);
    await pipeline.stop();
    await sleep(100);
    assert.equal(workers.length, 1);
  });
});

describe("GatePipeline host: gate ids", () => {
  it("sends its gate id in init and drops worker results of another gate", async () => {
    const { pipeline, w, results, errors } = setup();
    pipeline.start();
    const init = w().of("init");
    assert.equal(init.length, 1);
    assert.equal((init[0] as Extract<HostToWorker, { type: "init" }>).gate, "entry");
    const foreign = employeeWire("S0abc-1");
    (foreign.outcome as { gate: string }).gate = "side-door";
    w().reply({ type: "results", results: [foreign, employeeWire("E-1")] });
    assert.deepEqual(results.map((r) => r.outcome.trackId), ["E-1"], "only this gate's outcomes leave the pipeline");
    assert.ok(errors.some((e) => /another gate dropped/.test(e)), errors.join("; "));
    assert.equal(pipeline.stats().decisions, 1);
    await pipeline.stop();
  });
});
