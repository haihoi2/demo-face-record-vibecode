/**
 * One gate's real-time pipeline (plan: docs/plans/2026-09-26-realtime-pipeline.md):
 *
 *   FrameSource (always-open stream, newest frame only)
 *     -> motion gate (skip still scenes, but look at least every keepAliveMs)
 *     -> SCRFD on the gate area -> size/pose/quality per face
 *     -> GateTrackSession.plan() -> ArcFace ONLY where the tracker asks
 *     -> GateTrackSession.process() / tick() -> ONE outcome per person
 *     -> onResult (shadow: report; live: act - decided by the caller)
 *
 * Pull-based: one frame is processed at a time and the loop always takes the
 * NEWEST frame when it is free, so a slow detector drops frames instead of
 * queueing them (a reader burst after reconnect is harmless). Never throws out
 * of the loop; errors are counted and reported through stats and onError.
 */
import type { Frame, FrameSource, Gate, SourceState } from "./contracts";
import type { FaceBox, RgbImage } from "../faceEmbedding";
import { GateTrackSession, type DecisionContext, type TrackDecisionResult } from "./trackDecision";
import type { TrackerInput } from "./tracker";

/** The engine operations the pipeline needs; server.ts binds them to faceEmbedding.ts. */
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
}

export interface PipelineStats {
  framesProcessed: number;
  framesSkippedStill: number;
  detections: number;
  embeddings: number;
  decisions: number;
  employees: number;
  strangers: number;
  insufficient: number;
  /** decidedAt - first usable (>= size floor, clear) frame, of the last decision that had one. */
  lastDecisionLatencyMs?: number;
  /** Duration of the last detect/track/embed pass. */
  lastLoopMs?: number;
  loopErrors: number;
  lastError?: string;
  contextOk: boolean;
  contextReason?: string;
}

export interface GatePipelineOptions {
  gate: Gate;
  source: FrameSource & { getState(): SourceState };
  engine: PipelineEngine;
  /** Gallery + thresholds + engine state, rebuilt by the server; null while not usable. */
  context: () => DecisionContext | null;
  onResult: (result: TrackDecisionResult) => void;
  onError?: (message: string) => void;
  now?: () => number;
  /** Process at least one frame this often even without motion. Default 1000 ms. */
  keepAliveMs?: number;
  /** Track housekeeping (ends tracks when the stream goes quiet). Default 250 ms. */
  tickMs?: number;
  /** Rebuild the decision context this often (gallery/threshold changes). Default 5000 ms. */
  contextRefreshMs?: number;
  /** Wait for a new frame at most this long before re-checking. Default 200 ms. */
  idleWaitMs?: number;
}

const errText = (e: unknown) => String((e as any)?.message || e || "error").slice(0, 300);

export class GatePipeline {
  readonly gate: Gate;
  private readonly opts: Required<Omit<GatePipelineOptions, "onError">> & Pick<GatePipelineOptions, "onError">;
  private session: GateTrackSession | null = null;
  private sessionTag = "";
  private running = false;
  private loopDone: Promise<void> | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private lastSeq = -1;
  private lastProcessedAt = 0;
  private lastContextAt = 0;
  private wake: (() => void) | null = null;
  private readonly frameListener = () => {
    const w = this.wake;
    this.wake = null;
    w?.();
  };
  private readonly s: PipelineStats = {
    framesProcessed: 0,
    framesSkippedStill: 0,
    detections: 0,
    embeddings: 0,
    decisions: 0,
    employees: 0,
    strangers: 0,
    insufficient: 0,
    loopErrors: 0,
    contextOk: false,
  };

  constructor(opts: GatePipelineOptions) {
    this.gate = opts.gate;
    this.opts = {
      keepAliveMs: 1000,
      tickMs: 250,
      contextRefreshMs: 5000,
      idleWaitMs: 200,
      now: Date.now,
      ...opts,
    } as GatePipeline["opts"];
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.opts.source.on("frame", this.frameListener);
    this.opts.source.start();
    this.tickTimer = setInterval(() => this.tick(), this.opts.tickMs);
    this.tickTimer.unref?.();
    this.loopDone = this.loop();
  }

  /** Stops the source, ends open tracks (their outcomes are still reported), waits for the loop. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.frameListener();
    try {
      this.opts.source.stop();
    } catch {}
    await this.loopDone?.catch(() => undefined);
    if (this.session) this.emit(this.session.close(this.opts.now()));
    this.session = null;
  }

  stats(): PipelineStats {
    return { ...this.s };
  }

  sourceState(): SourceState {
    return this.opts.source.getState();
  }

  // ---------------------------------------------------------------------------

  private emit(results: TrackDecisionResult[]): void {
    for (const r of results) {
      this.s.decisions += 1;
      if (r.outcome.kind === "employee") this.s.employees += 1;
      else if (r.outcome.kind === "stranger") this.s.strangers += 1;
      else this.s.insufficient += 1;
      const firstUsable = r.shadow.firstUsableAtMs;
      if (r.outcome.kind !== "insufficient" && typeof firstUsable === "number") {
        this.s.lastDecisionLatencyMs = Math.max(0, r.shadow.decidedAtMs - firstUsable);
      }
      try {
        this.opts.onResult(r);
      } catch (e) {
        this.fail(`onResult: ${errText(e)}`);
      }
    }
  }

  private fail(message: string): void {
    this.s.loopErrors += 1;
    this.s.lastError = message;
    try {
      this.opts.onError?.(message);
    } catch {}
  }

  private tick(): void {
    if (!this.running || !this.session) return;
    try {
      this.emit(this.session.tick(this.opts.now()));
    } catch (e) {
      this.fail(`tick: ${errText(e)}`);
    }
  }

  /** Fresh context from the server; (re)creates the session when the model tag changes. */
  private refreshContext(force = false): boolean {
    const now = this.opts.now();
    if (!force && this.session && now - this.lastContextAt < this.opts.contextRefreshMs) return this.s.contextOk;
    this.lastContextAt = now;
    const ctx = this.opts.context();
    if (!ctx || !this.opts.engine.ready()) {
      this.s.contextOk = false;
      this.s.contextReason = !ctx ? "no decision context (engine or gallery not ready)" : "face engine not ready";
      return false;
    }
    const tag = this.opts.engine.modelTag();
    if (!this.session || this.sessionTag !== tag) {
      if (this.session) this.emit(this.session.close(now));
      this.session = new GateTrackSession({ gate: this.gate, modelTag: tag, context: ctx, clock: this.opts.now, idPrefix: this.gate === "ENTRY" ? "E" : "X" });
      this.sessionTag = tag;
      const st = this.session.contextStatus();
      this.s.contextOk = st.ok;
      this.s.contextReason = st.reason;
      return st.ok;
    }
    const st = this.session.setContext(ctx);
    this.s.contextOk = st.ok;
    this.s.contextReason = st.reason;
    return st.ok;
  }

  private waitForFrame(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, this.opts.idleWaitMs);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const frame = this.opts.source.latest();
      if (!frame || frame.seq === this.lastSeq) {
        await this.waitForFrame();
        continue;
      }
      this.lastSeq = frame.seq;
      const now = this.opts.now();
      const moving = this.opts.source.motion ? this.opts.source.motion(frame) : true;
      if (!moving && now - this.lastProcessedAt < this.opts.keepAliveMs) {
        this.s.framesSkippedStill += 1;
        continue;
      }
      if (!this.refreshContext()) {
        await this.waitForFrame();
        continue;
      }
      this.lastProcessedAt = now;
      const t0 = this.opts.now();
      try {
        await this.processFrame(frame);
      } catch (e) {
        this.fail(`frame ${frame.seq}: ${errText(e)}`);
      }
      this.s.lastLoopMs = this.opts.now() - t0;
      this.s.framesProcessed += 1;
      // Yield so HTTP handlers and the other gate get the event loop between frames.
      await new Promise((r) => setImmediate(r));
    }
  }

  private async processFrame(frame: Frame): Promise<void> {
    const session = this.session;
    if (!session) return;
    const engine = this.opts.engine;
    const img: RgbImage = { width: frame.width, height: frame.height, data: frame.rgb };
    const boxes = await engine.detect(img);
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
        this.s.embeddings += 1;
      }
    }
    // The session may have been replaced (model change) while embedding: drop the frame.
    if (this.session !== session || !this.running) return;
    this.emit(session.process(frame, inputs).results);
  }
}
