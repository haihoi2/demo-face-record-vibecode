/**
 * Worker side of a gate's real-time pipeline (see pipelineProtocol.ts):
 *
 *   frame (newest, one at a time) -> SCRFD on the gate area -> size/pose/quality
 *     -> GateTrackSession.plan() -> ArcFace ONLY where the tracker asks
 *     -> GateTrackSession.process() / tick() -> ONE outcome per person
 *     -> `results` to the host (no pixels; a JPEG crop only when asked)
 *
 * Engine-agnostic: the worker entry (pipelineWorker.ts) binds the real ONNX
 * engine; tests bind a fake one and run this in-process through
 * `createInProcessWorker`. Never throws out of a handler: errors are counted,
 * reported and the frame is answered with `frame-done` so the host never waits
 * for a frame that will not come back.
 */
import type { Frame, Gate } from "./contracts";
import type { FaceBox, RgbImage } from "../faceEmbedding";
import { GateTrackSession, type DecisionContext, type TrackDecisionResult } from "./trackDecision";
import type { TrackerInput } from "./tracker";
import {
  errText,
  toWireResult,
  type HostToWorker,
  type InitMessage,
  type WorkerStats,
  type WorkerToHost,
} from "./pipelineProtocol";

/** The engine operations the pipeline needs (bound to faceEmbedding.ts in the worker). */
export interface PipelineEngine {
  ready(): boolean;
  modelTag(): string;
  detect(img: RgbImage): Promise<FaceBox[]>;
  align(img: RgbImage, landmarks: Array<[number, number]>): RgbImage | null;
  embed(aligned: RgbImage): Promise<Float32Array | null>;
  /** 0..1 capture quality of an aligned face. */
  quality(aligned: RgbImage, boxSizePx: number): number;
  /** Null when the face is clear enough (size + pose), else the reason. */
  clearIssue(landmarks: Array<[number, number]>, boxSizePx: number): string | null;
  /** Last engine load error, if any (for stats). */
  error?(): string | null;
}

export type Cropper = (frame: Frame, box: [number, number, number, number]) => Promise<Uint8Array | null>;

export interface PipelineCoreOptions {
  engine: PipelineEngine;
  post: (msg: WorkerToHost, transfer?: ArrayBuffer[]) => void;
  now?: () => number;
  /** JPEG crop of the best frame (only called when init.crops is on). */
  cropper?: Cropper;
}

export class PipelineCore {
  private gate: Gate = "ENTRY";
  private crops = false;
  private tickMs = 250;
  private statsMs = 1000;
  private initialized = false;
  private stopped = false;
  private context: DecisionContext | null = null;
  private session: GateTrackSession | null = null;
  private sessionTag = "";
  private contextOk = false;
  private contextReason: string | undefined = "no decision context yet";
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  /** Serialises frame processing, ticks and stop so the session is never used re-entrantly. */
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly s = { detections: 0, embeddings: 0, errors: 0, lastError: undefined as string | undefined };

  constructor(private readonly opts: PipelineCoreOptions) {
    this.now = opts.now || Date.now;
  }

  handle(msg: HostToWorker): void {
    try {
      if (!msg || typeof msg !== "object") return;
      if (this.stopped && msg.type !== "stop") return;
      switch (msg.type) {
        case "init":
          this.init(msg);
          break;
        case "context":
          this.enqueue(() => {
            this.applyContext(msg.context);
            this.postStats();
          });
          break;
        case "frame":
          this.enqueue(() => this.onFrame(msg.frame));
          break;
        case "stop":
          this.enqueue(() => this.stop());
          break;
      }
    } catch (e) {
      this.fail(`handle: ${errText(e)}`);
    }
  }

  /** The engine finished (re)loading: re-apply the stored context. */
  engineChanged(): void {
    if (this.stopped) return;
    this.enqueue(() => {
      this.applyContext(this.context);
      this.postStats();
    });
  }

  stats(): WorkerStats {
    const e = this.opts.engine;
    let engineReady = false;
    let modelTag: string | undefined;
    try {
      engineReady = e.ready();
      modelTag = engineReady ? e.modelTag() : undefined;
    } catch {}
    const engineError = e.error?.() || undefined;
    return {
      detections: this.s.detections,
      embeddings: this.s.embeddings,
      errors: this.s.errors,
      ...(this.s.lastError ? { lastError: this.s.lastError } : {}),
      engineReady,
      ...(engineError ? { engineError: engineError.slice(0, 300) } : {}),
      ...(modelTag ? { modelTag } : {}),
      contextOk: this.contextOk,
      ...(this.contextReason ? { contextReason: this.contextReason } : {}),
      openTracks: this.session ? this.session.tracker.snapshot().length : 0,
    };
  }

  // ---------------------------------------------------------------------------

  private init(msg: InitMessage): void {
    if (this.initialized) return;
    this.initialized = true;
    this.gate = msg.gate === "EXIT" ? "EXIT" : "ENTRY";
    this.crops = msg.crops === true;
    this.tickMs = Math.max(10, Number(msg.tickMs) || 250);
    this.statsMs = Math.max(50, Number(msg.statsMs) || 1000);
    this.tickTimer = setInterval(() => this.enqueue(() => this.tick()), this.tickMs);
    this.statsTimer = setInterval(() => this.postStats(), this.statsMs);
    (this.tickTimer as any).unref?.();
    (this.statsTimer as any).unref?.();
  }

  private enqueue(job: () => Promise<void> | void): void {
    this.chain = this.chain.then(job).catch((e) => this.fail(errText(e)));
  }

  private post(msg: WorkerToHost, transfer?: ArrayBuffer[]): void {
    try {
      this.opts.post(msg, transfer);
    } catch (e) {
      // e.g. a result that cannot be cloned: report it instead of losing the worker
      this.s.errors += 1;
      this.s.lastError = `post ${msg.type}: ${errText(e)}`;
      try {
        this.opts.post({ type: "error", message: this.s.lastError });
      } catch {}
    }
  }

  private postStats(): void {
    if (!this.stopped) this.post({ type: "stats", stats: this.stats() });
  }

  private fail(message: string): void {
    this.s.errors += 1;
    this.s.lastError = message;
    this.post({ type: "error", message });
  }

  private applyContext(ctx: DecisionContext | null): void {
    this.context = ctx;
    const engine = this.opts.engine;
    if (!ctx) {
      this.contextOk = false;
      this.contextReason = "no decision context (engine or gallery not ready)";
      return;
    }
    if (!engine.ready()) {
      this.contextOk = false;
      this.contextReason = "pipeline worker: face engine not ready";
      return;
    }
    const tag = engine.modelTag();
    const now = this.now();
    if (!this.session || this.sessionTag !== tag) {
      if (this.session) this.emit(this.session.close(now));
      this.session = new GateTrackSession({
        gate: this.gate,
        modelTag: tag,
        context: ctx,
        clock: this.now,
        idPrefix: this.gate === "ENTRY" ? "E" : "X",
      });
      this.sessionTag = tag;
      const st = this.session.contextStatus();
      this.contextOk = st.ok;
      this.contextReason = st.reason;
      return;
    }
    const st = this.session.setContext(ctx);
    this.contextOk = st.ok;
    this.contextReason = st.reason;
  }

  private async emit(results: TrackDecisionResult[]): Promise<void> {
    if (!results.length) return;
    const wire = [];
    for (const r of results) {
      let crop: Uint8Array | null = null;
      if (this.crops && r.outcome.kind !== "insufficient" && this.opts.cropper) {
        try {
          const b = r.outcome.best;
          crop = await this.opts.cropper(b.frame, b.detection.box);
        } catch (e) {
          this.fail(`crop: ${errText(e)}`);
        }
      }
      wire.push(toWireResult(r, crop));
    }
    this.post({ type: "results", results: wire });
  }

  private async tick(): Promise<void> {
    if (!this.session || this.stopped) return;
    await this.emit(this.session.tick(this.now()));
  }

  private async onFrame(frame: Frame): Promise<void> {
    const t0 = this.now();
    const done = { detections: 0, embeddings: 0 };
    let processed = false;
    let error: string | undefined;
    try {
      const session = this.session;
      if (session && this.contextOk && this.opts.engine.ready()) {
        processed = true;
        await this.processFrame(session, frame, done);
      }
    } catch (e) {
      error = `frame ${frame?.seq}: ${errText(e)}`;
      this.s.errors += 1;
      this.s.lastError = error;
    }
    this.post({
      type: "frame-done",
      seq: Number(frame?.seq) || 0,
      processed,
      loopMs: this.now() - t0,
      detections: done.detections,
      embeddings: done.embeddings,
      ...(error ? { error } : {}),
    });
  }

  private async processFrame(session: GateTrackSession, frame: Frame, done: { detections: number; embeddings: number }): Promise<void> {
    const engine = this.opts.engine;
    const img: RgbImage = { width: frame.width, height: frame.height, data: frame.rgb };
    const boxes = await engine.detect(img);
    done.detections = boxes.length;
    this.s.detections += boxes.length;

    const aligned: Array<RgbImage | null> = [];
    const inputs: TrackerInput[] = boxes.map((b) => {
      // The frame is the gate area at native resolution: frame pixels = source pixels.
      const sizePx = Math.max(0, Math.min(b.box[2] - b.box[0], b.box[3] - b.box[1]));
      const a = engine.align(img, b.landmarks);
      aligned.push(a);
      const issue = engine.clearIssue(b.landmarks, sizePx);
      return {
        detection: {
          box: [b.box[0], b.box[1], b.box[2], b.box[3]],
          landmarks: b.landmarks.map((p) => [p[0], p[1]] as [number, number]),
          score: b.score,
          sizePx,
          clear: issue === null && a !== null,
          ...(issue ? { unclearReason: issue } : a === null ? { unclearReason: "align" } : {}),
        },
        quality: a ? engine.quality(a, sizePx) : 0,
      };
    });

    const plan = session.plan(frame, inputs);
    const tag = engine.modelTag();
    for (let i = 0; i < inputs.length; i++) {
      if (!plan.needsEmbedding[i] || !aligned[i]) continue;
      const emb = await engine.embed(aligned[i]!);
      if (emb) {
        inputs[i].embedding = emb;
        inputs[i].embeddingModelTag = tag;
        done.embeddings += 1;
        this.s.embeddings += 1;
      }
    }
    // The session may have been replaced (model change) while embedding: drop the frame.
    if (this.session !== session || this.stopped) return;
    await this.emit(session.process(frame, inputs).results);
  }

  private async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.tickTimer = null;
    this.statsTimer = null;
    if (this.session) {
      const session = this.session;
      this.session = null;
      try {
        await this.emit(session.close(this.now()));
      } catch (e) {
        this.fail(`close: ${errText(e)}`);
      }
    }
    this.post({ type: "stats", stats: this.stats() });
    this.post({ type: "stopped" });
  }
}

// ---- in-process transport (tests and tools only) -------------------------------

/** What the host needs from a worker thread (node:worker_threads Worker fits). */
export interface PipelineWorkerLike {
  postMessage(msg: HostToWorker, transfer?: ReadonlyArray<ArrayBuffer>): void;
  on(event: "message", listener: (msg: WorkerToHost) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number> | void;
}

/**
 * Runs a PipelineCore on the CURRENT thread behind the worker interface,
 * delivering messages asynchronously like a MessagePort. For unit tests with a
 * fake engine: production always uses a real worker thread (inference on the
 * main thread is exactly the F11 failure).
 */
export function createInProcessWorker(engine: PipelineEngine, opts: { now?: () => number; cropper?: Cropper } = {}): PipelineWorkerLike & { core: PipelineCore } {
  const listeners = { message: [] as Array<(m: any) => void>, error: [] as Array<(e: Error) => void>, exit: [] as Array<(c: number) => void> };
  let terminated = false;
  const core = new PipelineCore({
    engine,
    now: opts.now,
    cropper: opts.cropper,
    post: (msg) => {
      if (terminated) return;
      setImmediate(() => {
        if (terminated) return;
        for (const l of listeners.message.slice()) l(msg);
      });
    },
  });
  return {
    core,
    postMessage(msg) {
      if (terminated) return;
      setImmediate(() => {
        if (!terminated) core.handle(msg);
      });
    },
    on(event: "message" | "error" | "exit", listener: any) {
      (listeners as any)[event].push(listener);
      return this;
    },
    terminate() {
      if (terminated) return Promise.resolve(0);
      terminated = true;
      core.handle({ type: "stop" });
      setImmediate(() => {
        for (const l of listeners.exit.slice()) l(1);
      });
      return Promise.resolve(1);
    },
  };
}
