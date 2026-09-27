/**
 * One gate's real-time pipeline (plan: docs/plans/2026-09-26-realtime-pipeline.md),
 * split over two threads (F11, rc1 sign-off):
 *
 *   MAIN THREAD (this class, the "host")
 *     FrameSource (always-open stream, newest frame only)
 *       -> motion gate (skip still scenes, but look at least every keepAliveMs)
 *       -> newest frame to the worker WHEN IT IS IDLE (RGB buffer transferred;
 *          never queued; superseded frames are counted as dropped)
 *     decision context (gallery + thresholds + engine state) pushed on start
 *     and whenever it changes (compared every contextRefreshMs)
 *     results -> onResult (shadow: report; live: act - decided by the caller)
 *
 *   PIPELINE WORKER (pipelineWorker.ts -> pipelineCore.ts)
 *     SCRFD -> size/pose/quality -> tracker plan -> ArcFace where asked
 *     -> tracker/decider -> ONE outcome per person; tick housekeeping.
 *
 * ONNX inference blocks the thread it runs on for ~0.4-0.6 s per call; on the
 * main thread it starved the FFmpeg pipe reader and its stale watchdog and
 * slowed HTTP and the legacy watcher. Here the main thread only copies frames
 * off the pipe and runs the cheap motion check.
 *
 * Fail closed: no context from the server -> no frame is sent; the worker also
 * refuses to decide without a context or with its own engine not loaded / on a
 * different model tag. A crashed or hung worker is logged, restarted with
 * back-off and surfaced in stats (lastError, worker.restarts); its open tracks
 * are lost (no outcome is invented for them). Never throws out of callbacks.
 */
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

import type { Frame, FrameSource, Gate, SourceState } from "./contracts";
import type { DecisionContext, TrackDecisionResult } from "./trackDecision";
import type { PipelineWorkerLike } from "./pipelineCore";
import {
  contextFingerprint,
  errText,
  fromWireResult,
  type HostToWorker,
  type WorkerStats,
  type WorkerToHost,
} from "./pipelineProtocol";

export type { PipelineEngine, PipelineWorkerLike } from "./pipelineCore";
export { createInProcessWorker } from "./pipelineCore";

export type PipelineWorkerState = "starting" | "running" | "restarting" | "stopped";

export interface PipelineStats {
  /** Frames the worker ran detection on. */
  framesProcessed: number;
  framesSkippedStill: number;
  /** Frames superseded while the worker was busy (or down): never queued. */
  framesDroppedBusy: number;
  /** Frames not sent because there was no decision context (fail closed). */
  framesSkippedNoContext: number;
  detections: number;
  embeddings: number;
  decisions: number;
  employees: number;
  strangers: number;
  insufficient: number;
  /** decidedAt - first usable (>= size floor, clear) frame, of the last decision that had one. */
  lastDecisionLatencyMs?: number;
  /** Duration of the last detect/track/embed pass in the worker. */
  lastLoopMs?: number;
  loopErrors: number;
  lastError?: string;
  contextOk: boolean;
  contextReason?: string;
  worker: {
    state: PipelineWorkerState;
    restarts: number;
    engineReady: boolean;
    modelTag?: string;
    openTracks: number;
  };
}

export interface GatePipelineOptions {
  gate: Gate;
  source: FrameSource & { getState(): SourceState };
  /** Gallery + thresholds + engine state, rebuilt by the server; null while not usable. */
  context: () => DecisionContext | null;
  onResult: (result: TrackDecisionResult) => void;
  onError?: (message: string) => void;
  /** Worker factory; default: a real worker thread running pipelineWorker. Tests inject fakes. */
  createWorker?: () => PipelineWorkerLike;
  /** Ask the worker for a JPEG crop of each decision's best frame (live mode). Default false. */
  crops?: boolean;
  now?: () => number;
  /** Process at least one frame this often even without motion. Default 1000 ms. */
  keepAliveMs?: number;
  /** Track housekeeping in the worker (ends tracks when the stream goes quiet). Default 250 ms. */
  tickMs?: number;
  /** Rebuild the decision context this often; pushed to the worker only when changed. Default 5000 ms. */
  contextRefreshMs?: number;
  /** Worker stats period. Default 1000 ms. */
  statsMs?: number;
  /** A worker that has not answered a frame for this long is hung: restarted. Default 20000 ms. */
  frameTimeoutMs?: number;
  /** Worker restart back-off: first delay, doubling up to max. Defaults 1000 / 30000 ms. */
  restartBackoffInitialMs?: number;
  restartBackoffMaxMs?: number;
  /** A worker that ran this long resets the back-off. Default 60000 ms. */
  restartBackoffResetMs?: number;
  /** stop() waits this long for the worker's final outcomes before terminating it. Default 3000 ms. */
  stopTimeoutMs?: number;
}

type Resolved = Required<Omit<GatePipelineOptions, "onError" | "createWorker">> & Pick<GatePipelineOptions, "onError" | "createWorker">;

/**
 * Entry file of the pipeline worker, like faceWorkerPool#resolveFaceWorkerEntry:
 *   1. PIPELINE_WORKER_PATH (strict: a missing file throws);
 *   2. next to this module when `__dirname` exists (esbuild CJS bundle -> dist/pipelineWorker.cjs);
 *   3. relative to cwd for ESM under tsx: src/server/pipeline/pipelineWorker.ts, then dist/pipelineWorker.cjs.
 * The .ts source runs through the tsx loader the worker inherits via process.execArgv.
 */
export function resolvePipelineWorkerEntry(): string {
  const override = process.env.PIPELINE_WORKER_PATH?.trim();
  if (override) {
    const resolved = path.resolve(override);
    if (!fs.existsSync(resolved)) throw new Error(`PIPELINE_WORKER_PATH points at a missing file: ${resolved}`);
    return resolved;
  }
  const candidates: string[] = [];
  const moduleDir = typeof __dirname === "string" ? __dirname : null;
  if (moduleDir) {
    candidates.push(
      path.join(moduleDir, "pipelineWorker.cjs"),
      path.join(moduleDir, "pipelineWorker.js"),
      path.join(moduleDir, "pipelineWorker.ts"),
    );
  }
  const cwd = process.cwd();
  candidates.push(path.join(cwd, "src", "server", "pipeline", "pipelineWorker.ts"), path.join(cwd, "dist", "pipelineWorker.cjs"));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`Pipeline worker entry not found. Tried: ${candidates.join(", ")}. Run \`npm run build\` or set PIPELINE_WORKER_PATH.`);
}

/**
 * Worker environment: the main engine's settings (the worker reads the same
 * FACE_* variables), except that PIPELINE_ORT_THREADS, when set to 1-16,
 * replaces FACE_ORT_THREADS for the pipeline workers only. With 1 there is no
 * ONNX Runtime intra-op pool (no spinning threads), which matters when two
 * gate workers, the legacy engine and two FFmpeg decoders share a CPU quota.
 */
export function pipelineWorkerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const raw = String(env.PIPELINE_ORT_THREADS ?? "").trim();
  const n = Number(raw);
  if (raw === "" || !Number.isInteger(n) || n < 1 || n > 16) return { ...env };
  return { ...env, FACE_ORT_THREADS: String(n) };
}

function createDefaultWorker(gate: Gate): PipelineWorkerLike {
  return new Worker(resolvePipelineWorkerEntry(), { name: `pipeline-${gate.toLowerCase()}`, env: pipelineWorkerEnv() }) as unknown as PipelineWorkerLike;
}

/** The frame and the buffer to transfer: its own backing store, or a copy when that is shared/pooled. */
function transferable(frame: Frame): { frame: Frame; transfer: ArrayBuffer[] } {
  const rgb = frame.rgb;
  const buf = rgb.buffer;
  if (buf instanceof ArrayBuffer && rgb.byteOffset === 0 && rgb.byteLength === buf.byteLength) {
    return { frame, transfer: [buf] };
  }
  const copy = new Uint8Array(rgb.byteLength);
  copy.set(rgb);
  return { frame: { ...frame, rgb: copy }, transfer: [copy.buffer] };
}

export class GatePipeline {
  readonly gate: Gate;
  private readonly opts: Resolved;
  private running = false;
  private worker: PipelineWorkerLike | null = null;
  /** Bumped per worker, so events of a replaced worker are ignored. */
  private workerGen = 0;
  private workerState: PipelineWorkerState = "stopped";
  private workerStartedAt = 0;
  private restartAttempt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private contextTimer: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private busySince = 0;
  /** A frame arrived while busy/down and waits as source.latest(). */
  private framePending = false;
  private lastOffered: Frame | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private context: DecisionContext | null = null;
  private contextKey = "";
  private contextVersion = 0;
  private workerStats: WorkerStats | null = null;
  private stopWaiter: (() => void) | null = null;
  private readonly frameListener = () => this.onSourceFrame();
  private listening = false;
  private readonly s = {
    framesProcessed: 0,
    framesSkippedStill: 0,
    framesDroppedBusy: 0,
    framesSkippedNoContext: 0,
    detections: 0,
    embeddings: 0,
    decisions: 0,
    employees: 0,
    strangers: 0,
    insufficient: 0,
    loopErrors: 0,
    restarts: 0,
    lastDecisionLatencyMs: undefined as number | undefined,
    lastLoopMs: undefined as number | undefined,
    lastError: undefined as string | undefined,
  };

  constructor(opts: GatePipelineOptions) {
    this.gate = opts.gate;
    this.opts = {
      keepAliveMs: 1000,
      tickMs: 250,
      contextRefreshMs: 5000,
      statsMs: 1000,
      frameTimeoutMs: 20_000,
      restartBackoffInitialMs: 1000,
      restartBackoffMaxMs: 30_000,
      restartBackoffResetMs: 60_000,
      stopTimeoutMs: 3000,
      crops: false,
      now: Date.now,
      ...opts,
    } as Resolved;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.refreshContext(true);
    this.spawnWorker();
    if (!this.listening) {
      this.opts.source.on("frame", this.frameListener);
      this.listening = true;
    }
    this.opts.source.start();
    this.contextTimer = setInterval(() => this.refreshContext(false), this.opts.contextRefreshMs);
    (this.contextTimer as any).unref?.();
    const wdMs = Math.max(20, Math.min(1000, Math.floor(this.opts.frameTimeoutMs / 4)));
    this.watchdog = setInterval(() => this.checkHung(), wdMs);
    (this.watchdog as any).unref?.();
  }

  /** Stops the source; the worker ends open tracks (their outcomes are still reported), then exits. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.contextTimer) clearInterval(this.contextTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.contextTimer = null;
    this.watchdog = null;
    this.restartTimer = null;
    try {
      this.opts.source.stop();
    } catch {}
    const worker = this.worker;
    if (worker && this.workerState === "running") {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.opts.stopTimeoutMs);
        this.stopWaiter = () => {
          clearTimeout(timer);
          resolve();
        };
        if (!this.post({ type: "stop" })) this.stopWaiter();
      });
    }
    this.stopWaiter = null;
    this.workerGen += 1; // ignore anything the worker still says
    this.worker = null;
    this.workerState = "stopped";
    this.busy = false;
    if (worker) {
      try {
        await Promise.resolve(worker.terminate()).catch(() => undefined);
      } catch {}
    }
  }

  stats(): PipelineStats {
    const w = this.workerStats;
    let contextOk = false;
    let contextReason: string | undefined;
    if (!this.context) {
      contextReason = "no decision context (engine or gallery not ready)";
    } else if (this.workerState !== "running") {
      contextReason = `pipeline worker ${this.workerState}`;
    } else if (!w) {
      contextReason = "pipeline worker starting";
    } else if (w.contextOk) {
      contextOk = true;
    } else {
      contextReason = w.contextReason || (w.engineReady ? "context refused by the pipeline worker" : "pipeline worker: face engine not ready");
    }
    return {
      framesProcessed: this.s.framesProcessed,
      framesSkippedStill: this.s.framesSkippedStill,
      framesDroppedBusy: this.s.framesDroppedBusy,
      framesSkippedNoContext: this.s.framesSkippedNoContext,
      detections: this.s.detections,
      embeddings: this.s.embeddings,
      decisions: this.s.decisions,
      employees: this.s.employees,
      strangers: this.s.strangers,
      insufficient: this.s.insufficient,
      ...(this.s.lastDecisionLatencyMs !== undefined ? { lastDecisionLatencyMs: this.s.lastDecisionLatencyMs } : {}),
      ...(this.s.lastLoopMs !== undefined ? { lastLoopMs: this.s.lastLoopMs } : {}),
      loopErrors: this.s.loopErrors,
      ...(this.s.lastError ? { lastError: this.s.lastError } : {}),
      contextOk,
      ...(contextReason ? { contextReason } : {}),
      worker: {
        state: this.workerState,
        restarts: this.s.restarts,
        engineReady: Boolean(w?.engineReady),
        ...(w?.modelTag ? { modelTag: w.modelTag } : {}),
        openTracks: w?.openTracks ?? 0,
      },
    };
  }

  sourceState(): SourceState {
    return this.opts.source.getState();
  }

  // ---- worker lifecycle -------------------------------------------------------

  private spawnWorker(): void {
    if (!this.running) return;
    this.workerGen += 1;
    const gen = this.workerGen;
    this.workerStats = null;
    this.busy = false;
    this.workerState = "starting";
    let worker: PipelineWorkerLike;
    try {
      worker = this.opts.createWorker ? this.opts.createWorker() : createDefaultWorker(this.gate);
    } catch (e) {
      this.workerDown(gen, `pipeline worker could not start: ${errText(e)}`);
      return;
    }
    this.worker = worker;
    this.workerStartedAt = this.opts.now();
    worker.on("message", (msg: WorkerToHost) => {
      if (gen === this.workerGen) this.onWorkerMessage(msg);
    });
    worker.on("error", (err: Error) => {
      if (gen === this.workerGen) this.workerDown(gen, `pipeline worker crashed: ${errText(err)}`);
    });
    worker.on("exit", (code: number) => {
      if (gen === this.workerGen) this.workerDown(gen, `pipeline worker exited (code ${code})`);
    });
    this.workerState = "running";
    this.post({ type: "init", gate: this.gate, crops: this.opts.crops === true, tickMs: this.opts.tickMs, statsMs: this.opts.statsMs });
    this.contextVersion += 1;
    this.post({ type: "context", version: this.contextVersion, context: this.context });
    this.pump();
  }

  private workerDown(gen: number, reason: string): void {
    if (gen !== this.workerGen) return;
    this.workerGen += 1; // later events of this worker are ignored
    const worker = this.worker;
    this.worker = null;
    this.busy = false;
    this.workerStats = null;
    try {
      void Promise.resolve(worker?.terminate()).catch(() => undefined);
    } catch {}
    if (!this.running) {
      this.workerState = "stopped";
      this.stopWaiter?.();
      return;
    }
    this.s.restarts += 1;
    if (this.workerStartedAt && this.opts.now() - this.workerStartedAt >= this.opts.restartBackoffResetMs) this.restartAttempt = 0;
    const delay = Math.min(this.opts.restartBackoffMaxMs, this.opts.restartBackoffInitialMs * 2 ** Math.min(this.restartAttempt, 30));
    this.restartAttempt += 1;
    this.workerState = "restarting";
    this.fail(`${reason}; restart ${this.s.restarts} in ${Math.round(delay / 100) / 10} s`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnWorker();
    }, delay);
    (this.restartTimer as any).unref?.();
  }

  private checkHung(): void {
    if (!this.running || !this.busy) return;
    const waited = this.opts.now() - this.busySince;
    if (waited > this.opts.frameTimeoutMs) this.workerDown(this.workerGen, `pipeline worker did not answer a frame in ${waited} ms`);
  }

  private post(msg: HostToWorker, transfer?: ArrayBuffer[]): boolean {
    const worker = this.worker;
    if (!worker) return false;
    try {
      worker.postMessage(msg, transfer);
      return true;
    } catch (e) {
      this.fail(`post ${msg.type}: ${errText(e)}`);
      return false;
    }
  }

  private onWorkerMessage(msg: WorkerToHost): void {
    try {
      switch (msg?.type) {
        case "frame-done":
          this.busy = false;
          if (msg.processed) {
            this.s.framesProcessed += 1;
            this.s.lastLoopMs = msg.loopMs;
          }
          this.s.detections += Number(msg.detections) || 0;
          this.s.embeddings += Number(msg.embeddings) || 0;
          if (msg.error) this.fail(msg.error);
          this.pump();
          break;
        case "results":
          for (const w of msg.results || []) this.emit(fromWireResult(w));
          break;
        case "stats":
          this.workerStats = msg.stats;
          break;
        case "error":
          this.fail(String(msg.message || "worker error"));
          break;
        case "stopped":
          this.stopWaiter?.();
          break;
      }
    } catch (e) {
      this.fail(`worker message: ${errText(e)}`);
    }
  }

  // ---- context --------------------------------------------------------------

  /** Rebuilds the context from the server; pushes it to the worker only when it changed. */
  private refreshContext(force: boolean): void {
    let ctx: DecisionContext | null = null;
    try {
      ctx = this.opts.context();
    } catch (e) {
      this.fail(`context: ${errText(e)}`);
      ctx = null;
    }
    let key: string;
    try {
      key = contextFingerprint(ctx);
    } catch {
      key = `unhashable-${this.opts.now()}`;
    }
    this.context = ctx;
    if (!force && key === this.contextKey) return;
    this.contextKey = key;
    this.contextVersion += 1;
    this.post({ type: "context", version: this.contextVersion, context: ctx });
  }

  // ---- frames ---------------------------------------------------------------

  private onSourceFrame(): void {
    if (!this.running) return;
    if (this.busy || this.workerState !== "running") {
      // The frame already waiting (if any) is superseded by this one.
      if (this.framePending) this.s.framesDroppedBusy += 1;
      this.framePending = true;
      return;
    }
    this.pump();
  }

  /** Sends the newest frame if the worker is idle. Never queues. */
  private pump(): void {
    if (!this.running || this.busy || this.workerState !== "running" || !this.worker) return;
    const hadPending = this.framePending;
    this.framePending = false;
    let frame: Frame | null = null;
    try {
      frame = this.opts.source.latest();
    } catch {}
    if (!frame || frame === this.lastOffered) {
      // The waiting frame went stale before the worker was free.
      if (hadPending && !frame) this.s.framesDroppedBusy += 1;
      return;
    }
    this.lastOffered = frame;
    const now = this.opts.now();
    let moving = true;
    try {
      moving = this.opts.source.motion ? this.opts.source.motion(frame) : true;
    } catch {}
    if (!moving && now - this.lastSentAt < this.opts.keepAliveMs) {
      this.s.framesSkippedStill += 1;
      return;
    }
    if (!this.context) {
      this.s.framesSkippedNoContext += 1;
      return;
    }
    let msg: { frame: Frame; transfer: ArrayBuffer[] };
    try {
      msg = transferable(frame);
    } catch (e) {
      this.fail(`frame ${frame.seq}: ${errText(e)}`);
      return;
    }
    this.busy = true;
    this.busySince = now;
    this.lastSentAt = now;
    if (!this.post({ type: "frame", frame: msg.frame }, msg.transfer)) this.busy = false;
  }

  // ---- results --------------------------------------------------------------

  private emit(r: TrackDecisionResult): void {
    this.s.decisions += 1;
    if (r.outcome.kind === "employee") this.s.employees += 1;
    else if (r.outcome.kind === "stranger") this.s.strangers += 1;
    else this.s.insufficient += 1;
    const firstUsable = r.shadow?.firstUsableAtMs;
    if (r.outcome.kind !== "insufficient" && typeof firstUsable === "number") {
      this.s.lastDecisionLatencyMs = Math.max(0, r.shadow.decidedAtMs - firstUsable);
    }
    try {
      this.opts.onResult(r);
    } catch (e) {
      this.fail(`onResult: ${errText(e)}`);
    }
  }

  private fail(message: string): void {
    this.s.loopErrors += 1;
    this.s.lastError = message.slice(0, 300);
    try {
      this.opts.onError?.(this.s.lastError);
    } catch {}
  }
}
