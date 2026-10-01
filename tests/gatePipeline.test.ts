/**
 * GatePipeline orchestration (src/server/pipeline/gatePipeline.ts) with a fake
 * stream and a fake engine: newest-frame processing, motion keep-alive,
 * embeddings only where the tracker asks, one outcome per person, fail closed.
 *
 * The engine runs behind the real host/worker protocol through the in-process
 * transport (createInProcessWorker): same messages, same pipelineCore, no
 * thread. Thread-specific behaviour is in pipelineHost.test.ts / pipelineWorker.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import type { Frame, FrameSource, Gate, SourceState } from "../src/server/pipeline/contracts";
import { DEFAULT_FUSION_THRESHOLDS, FaceGallery } from "../src/server/faceFusion";
import type { DecisionContext, TrackDecisionResult } from "../src/server/pipeline/trackDecision";
import { GatePipeline, PipelineEngine, createInProcessWorker, pipelineWorkerName } from "../src/server/pipeline/gatePipeline";
import { trackIdPrefix } from "../src/server/pipeline/gateId";
import type { FaceBox, RgbImage } from "../src/server/faceEmbedding";

const TAG = "arcface_test";
const DIMS = 512;

function unitVec(seed: number): Float32Array {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
  const v = Array.from({ length: DIMS }, r);
  const n = Math.hypot(...v);
  return Float32Array.from(v.map((x) => x / n));
}
/** Same identity as `base` with a little noise (cosine ~0.9+). */
function near(base: Float32Array, seed: number): Float32Array {
  const noise = unitVec(seed);
  const v = Array.from(base, (x, i) => x + 0.25 * noise[i]);
  const n = Math.hypot(...v);
  return Float32Array.from(v.map((x) => x / n));
}

const ALICE = unitVec(1);
const BOB = unitVec(2);
const GALLERY: FaceGallery = new Map([
  ["ALICE", [Array.from(ALICE)]],
  ["BOB", [Array.from(BOB)]],
]);
const ctx = (): DecisionContext => ({
  gallery: GALLERY, galleryModelTag: TAG, engineModelTag: TAG, thresholds: { ...DEFAULT_FUSION_THRESHOLDS }, engineReady: true,
});

/** A face the fake engine "detects" at a position, carrying an identity. */
interface Actor { x: number; y: number; size: number; who: (seed: number) => Float32Array }

class FakeSource extends EventEmitter implements FrameSource {
  constructor(readonly gate: Gate = "exit") {
    super();
  }
  started = 0;
  stopped = 0;
  moving = true;
  private newest: Frame | null = null;
  private seq = 0;
  readonly script = new Map<number, Actor[]>();
  /** Which frame a picture handed to the engine came from (the worker gets the frame's own rgb). */
  readonly seqOf = new WeakMap<Uint8Array, number>();
  start() { this.started += 1; }
  stop() { this.stopped += 1; }
  latest() { return this.newest; }
  motion() { return this.moving; }
  getState(): SourceState {
    return { gate: this.gate, status: "streaming", fps: 8, newestFrameAgeMs: 0, reconnects: 0, since: new Date(0).toISOString() };
  }
  push(actors: Actor[]): Frame {
    const f: Frame = {
      gate: this.gate, streamId: `${this.gate}-test`, seq: this.seq++, capturedAtMs: Date.now(), width: 1920, height: 1080,
      roi: [0, 0, 1920, 1080], sourceWidth: 1920, sourceHeight: 1080, rgb: new Uint8Array(3),
    };
    this.script.set(f.seq, actors);
    this.seqOf.set(f.rgb, f.seq);
    this.newest = f;
    this.emit("frame", f);
    return f;
  }
}

class FakeEngine implements PipelineEngine {
  isReady = true;
  detectCalls = 0;
  embedCalls = 0;
  detectDelayMs = 0;
  constructor(private readonly source: FakeSource) {}
  ready() { return this.isReady; }
  modelTag() { return TAG; }
  async detect(img: RgbImage): Promise<FaceBox[]> {
    this.detectCalls += 1;
    if (this.detectDelayMs) await new Promise((r) => setTimeout(r, this.detectDelayMs));
    const seq = this.source.seqOf.get(img.data) ?? -1;
    const actors = this.source.script.get(seq) || [];
    return actors.map((a, i) => ({
      box: [a.x - a.size / 2, a.y - a.size / 2, a.x + a.size / 2, a.y + a.size / 2],
      score: 0.9,
      landmarks: [[a.x - 0.2 * a.size, a.y - 0.1 * a.size], [a.x + 0.2 * a.size, a.y - 0.1 * a.size], [a.x, a.y + 0.05 * a.size],
        [a.x - 0.15 * a.size, a.y + 0.25 * a.size], [a.x + 0.15 * a.size, a.y + 0.25 * a.size]] as Array<[number, number]>,
      // carried through align -> embed so the fake knows who this is
      ...( { __who: a.who(seq * 10 + i) } as object),
    })) as FaceBox[];
  }
  private lastWho = new Map<string, Float32Array>();
  align(_img: RgbImage, landmarks: Array<[number, number]>): RgbImage | null {
    const key = `${Math.round(landmarks[2][0])}:${Math.round(landmarks[2][1])}`;
    return { width: 112, height: 112, data: new Uint8Array(1), ...( { __key: key } as object) } as RgbImage;
  }
  remember(boxes: FaceBox[]) {
    for (const b of boxes) this.lastWho.set(`${Math.round(b.landmarks[2][0])}:${Math.round(b.landmarks[2][1])}`, (b as any).__who);
  }
  async embed(aligned: RgbImage): Promise<Float32Array | null> {
    this.embedCalls += 1;
    return this.lastWho.get((aligned as any).__key) ?? null;
  }
  quality() { return 0.8; }
  clearIssue(_l: Array<[number, number]>, size: number) { return size >= 60 ? null : "small"; }
}

function setup(over: Partial<ConstructorParameters<typeof GatePipeline>[0]> = {}, gate: Gate = "exit") {
  const source = new FakeSource(gate);
  const engine = new FakeEngine(source);
  const origDetect = engine.detect.bind(engine);
  engine.detect = async (img) => {
    const boxes = await origDetect(img);
    engine.remember(boxes);
    return boxes;
  };
  const results: TrackDecisionResult[] = [];
  const pipeline = new GatePipeline({
    gate, source, context: ctx, onResult: (r) => results.push(r),
    createWorker: () => createInProcessWorker(engine),
    tickMs: 50, keepAliveMs: 1000, ...over,
  });
  return { source, engine, pipeline, results };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function walk(source: FakeSource, frames: number, actors: (i: number) => Actor[], gapMs = 60) {
  for (let i = 0; i < frames; i++) {
    source.push(actors(i));
    await sleep(gapMs);
  }
}

describe("GatePipeline", () => {
  it("decides an employee once, early, and reports decision latency", async () => {
    const { source, engine, pipeline, results } = setup();
    pipeline.start();
    await walk(source, 10, (i) => [{ x: 900 + i * 5, y: 500, size: 90, who: (s) => near(ALICE, s) }]);
    const employees = results.filter((r) => r.outcome.kind === "employee");
    assert.equal(employees.length, 1, JSON.stringify(results.map((r) => r.basis)));
    assert.equal((employees[0].outcome as any).employeeId, "ALICE");
    const st = pipeline.stats();
    assert.equal(st.employees, 1);
    assert.ok(typeof st.lastDecisionLatencyMs === "number" && st.lastDecisionLatencyMs >= 0);
    assert.ok(engine.embedCalls <= 5, `embedded ${engine.embedCalls} times for one person`);
    await pipeline.stop();
    assert.equal(results.filter((r) => r.outcome.kind === "employee").length, 1, "no second outcome at stop");
    assert.equal(source.stopped, 1);
  });

  it("reports a stranger once, when the track ends (here: at stop)", async () => {
    const { source, pipeline, results } = setup();
    pipeline.start();
    const STRANGER = unitVec(99);
    await walk(source, 6, (i) => [{ x: 600 + i * 5, y: 400, size: 100, who: (s) => near(STRANGER, s) }]);
    assert.equal(results.length, 0, "a stranger is not decided while still in view");
    await pipeline.stop();
    const strangers = results.filter((r) => r.outcome.kind === "stranger");
    assert.equal(strangers.length, 1, JSON.stringify(results.map((r) => r.basis)));
  });

  it("two people at once get one outcome each", async () => {
    const { source, pipeline, results } = setup();
    pipeline.start();
    const STRANGER = unitVec(77);
    await walk(source, 8, (i) => [
      { x: 500 + i * 4, y: 500, size: 90, who: (s) => near(BOB, s) },
      { x: 1400 - i * 4, y: 520, size: 95, who: (s) => near(STRANGER, s) },
    ]);
    await pipeline.stop();
    const kinds = results.map((r) => r.outcome.kind).sort();
    assert.deepEqual(kinds, ["employee", "stranger"], JSON.stringify(results.map((r) => r.basis)));
  });

  it("faces under the size floor never decide", async () => {
    const { source, engine, pipeline, results } = setup();
    pipeline.start();
    await walk(source, 8, (i) => [{ x: 900 + i * 3, y: 500, size: 40, who: (s) => near(ALICE, s) }]);
    await pipeline.stop();
    assert.equal(results.filter((r) => r.outcome.kind !== "insufficient").length, 0);
    assert.equal(engine.embedCalls, 0, "no embeddings for unusable faces");
  });

  it("skips still frames but still looks once per keep-alive", async () => {
    const { source, engine, pipeline } = setup({ keepAliveMs: 400 });
    source.moving = false;
    pipeline.start();
    await walk(source, 12, () => [], 50); // ~600 ms of still frames
    await pipeline.stop();
    const st = pipeline.stats();
    assert.ok(st.framesSkippedStill >= 6, `skipped ${st.framesSkippedStill}`);
    assert.ok(engine.detectCalls >= 1 && engine.detectCalls <= 3, `detected ${engine.detectCalls} times`);
  });

  it("with a slow detector it processes the newest frame and drops the rest", async () => {
    const { source, engine, pipeline } = setup();
    engine.detectDelayMs = 150;
    pipeline.start();
    await walk(source, 12, () => [], 25); // 12 frames in ~300 ms
    await sleep(200);
    await pipeline.stop();
    assert.ok(engine.detectCalls < 6, `detected ${engine.detectCalls} of 12 frames`);
  });

  it("fails closed: no processing while the engine is not ready", async () => {
    const { source, engine, pipeline, results } = setup();
    engine.isReady = false;
    pipeline.start();
    await walk(source, 6, (i) => [{ x: 900 + i * 5, y: 500, size: 90, who: (s) => near(ALICE, s) }]);
    await pipeline.stop();
    assert.equal(engine.detectCalls, 0);
    assert.equal(results.length, 0);
    assert.equal(pipeline.stats().contextOk, false);
  });

  it("an exception in onResult is counted, not fatal", async () => {
    const { source, pipeline } = setup({ onResult: () => { throw new Error("boom"); } });
    pipeline.start();
    await walk(source, 10, (i) => [{ x: 900 + i * 5, y: 500, size: 90, who: (s) => near(ALICE, s) }]);
    await pipeline.stop();
    const st = pipeline.stats();
    assert.ok(st.loopErrors >= 1);
    assert.match(st.lastError || "", /boom/);
    assert.ok(st.framesProcessed >= 5, "kept processing after the error");
  });
});

describe("GatePipeline: N gates (gate ids)", () => {
  it("a third gate runs end to end: outcomes carry its id and its track-id prefix", async () => {
    const { source, pipeline, results } = setup({}, "side-door");
    assert.equal(pipeline.gate, "side-door");
    pipeline.start();
    const STRANGER = unitVec(55);
    await walk(source, 8, (i) => [
      { x: 500 + i * 4, y: 500, size: 90, who: (s) => near(ALICE, s) },
      { x: 1400 - i * 4, y: 520, size: 95, who: (s) => near(STRANGER, s) },
    ]);
    await pipeline.stop();
    assert.deepEqual(results.map((r) => r.outcome.kind).sort(), ["employee", "stranger"], JSON.stringify(results.map((r) => r.basis)));
    const prefix = trackIdPrefix("side-door");
    for (const r of results) {
      assert.equal(r.outcome.gate, "side-door");
      assert.equal(r.shadow.gate, "side-door");
      assert.ok(r.outcome.trackId.startsWith(`${prefix}-`), r.outcome.trackId);
    }
  });

  it("legacy gates keep their E-/X- track ids", async () => {
    for (const [gate, prefix] of [["entry", "E-"], ["exit", "X-"]] as const) {
      const { source, pipeline, results } = setup({}, gate);
      pipeline.start();
      await walk(source, 6, (i) => [{ x: 900 + i * 5, y: 500, size: 90, who: (s) => near(BOB, s) }]);
      await pipeline.stop();
      assert.ok(results.length >= 1, gate);
      for (const r of results) assert.ok(r.outcome.trackId.startsWith(prefix), `${gate}: ${r.outcome.trackId}`);
    }
  });

  it("names the worker thread after the gate id", () => {
    assert.equal(pipelineWorkerName("entry"), "pipeline-entry");
    assert.equal(pipelineWorkerName("exit"), "pipeline-exit");
    assert.equal(pipelineWorkerName("side-door"), "pipeline-side-door");
    assert.throws(() => pipelineWorkerName("ENTRY"), TypeError);
  });

  it("refuses an invalid gate id, and a source of another gate", () => {
    for (const bad of ["ENTRY", "EXIT", "", "Side", "side_door", undefined]) {
      const source = new FakeSource(bad as Gate);
      assert.throws(
        () => new GatePipeline({ gate: bad as Gate, source, context: ctx, onResult: () => {}, createWorker: () => createInProcessWorker(new FakeEngine(source)) }),
        TypeError,
        String(bad),
      );
    }
    const other = new FakeSource("exit");
    assert.throws(
      () => new GatePipeline({ gate: "side-door", source: other, context: ctx, onResult: () => {}, createWorker: () => createInProcessWorker(new FakeEngine(other)) }),
      /another gate/,
    );
  });
});
