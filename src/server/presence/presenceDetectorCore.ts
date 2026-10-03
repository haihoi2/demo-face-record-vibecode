/**
 * Worker side of one presence detector (see presenceProtocol.ts). Engine-agnostic:
 * presenceWorker.ts binds OnnxPersonDetector; tests bind a fake engine and run
 * this in-process through `createInProcessDetectorWorker`.
 *
 * - init: lowers the thread priority, creates the engine and loads the model
 *   (sha256-checked); a failed load is retried every `retryMs` (a model volume
 *   can appear late) and reported in stats.
 * - frame: answered exactly once with `result` (ok: false while the model is not
 *   ready, or when detection throws). Frames are processed one at a time.
 * - stop: timers cleared, `stopped` posted.
 * Never throws out of a handler.
 */
import fs from "node:fs";
import os from "node:os";

import type { PersonDetectorEngine } from "./detectors";
import {
  errText,
  type DetectorInitMessage,
  type DetectorStats,
  type DetectorToHost,
  type HostToDetector,
} from "./presenceProtocol";

/** Lowers THIS thread's priority (Linux setpriority on the thread id). Returns an error text or null. */
export function lowerPresenceThreadPriority(nice: number): string | null {
  if (!Number.isInteger(nice) || nice < 0 || nice > 19) return `nice must be 0-19, got ${String(nice).slice(0, 16)}`;
  if (nice === 0) return null;
  try {
    const tid = Number(fs.readlinkSync("/proc/thread-self").split("/").pop());
    if (!Number.isInteger(tid) || tid <= 0) return "no thread id";
    os.setPriority(tid, nice);
    return null;
  } catch (e) {
    return errText(e);
  }
}

export type DetectorEngineFactory = (init: DetectorInitMessage) => PersonDetectorEngine;

export interface DetectorCoreOptions {
  createEngine: DetectorEngineFactory;
  post: (msg: DetectorToHost) => void;
  /** Default: lowerPresenceThreadPriority. Tests pass a no-op. */
  setPriority?: (nice: number) => string | null;
}

export class PresenceDetectorCore {
  private init: DetectorInitMessage | null = null;
  private engine: PersonDetectorEngine | null = null;
  private stopped = false;
  private loading = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private niceError: string | null = null;
  private readonly s = { runs: 0, errors: 0, lastError: undefined as string | undefined, lastLoopMs: undefined as number | undefined };

  constructor(private readonly opts: DetectorCoreOptions) {}

  handle(msg: HostToDetector): void {
    try {
      switch (msg?.type) {
        case "init":
          this.onInit(msg);
          break;
        case "frame":
          this.chain = this.chain.then(() => this.onFrame(msg.seq, msg.frame)).catch(() => undefined);
          break;
        case "stop":
          this.onStop();
          break;
      }
    } catch (e) {
      this.fail(`handle ${String((msg as any)?.type)}: ${errText(e)}`);
    }
  }

  stats(): DetectorStats {
    const e = this.engine;
    const runMs = e?.lastRunMs?.();
    const loadError = e && !e.ready() ? e.error() || undefined : this.init ? undefined : "not initialised";
    return {
      model: this.init?.model.id ?? "yolox-nano",
      tag: e?.tag() ?? "",
      ready: Boolean(e?.ready()),
      ...(loadError ? { loadError } : {}),
      runs: this.s.runs,
      errors: this.s.errors,
      ...(this.s.lastError ? { lastError: this.s.lastError } : {}),
      ...(runMs !== undefined ? { lastRunMs: Math.round(runMs) } : {}),
      ...(this.s.lastLoopMs !== undefined ? { lastLoopMs: Math.round(this.s.lastLoopMs) } : {}),
      ...(this.niceError ? { niceError: this.niceError } : {}),
    };
  }

  private onInit(msg: DetectorInitMessage): void {
    if (this.init || this.stopped) return;
    this.init = msg;
    this.niceError = (this.opts.setPriority ?? lowerPresenceThreadPriority)(msg.nice);
    try {
      this.engine = this.opts.createEngine(msg);
    } catch (e) {
      this.fail(`engine: ${errText(e)}`);
      this.postStats();
      return;
    }
    void this.load();
    this.statsTimer = setInterval(() => this.postStats(), Math.max(50, msg.statsMs));
    (this.statsTimer as any).unref?.();
  }

  private async load(): Promise<void> {
    this.retryTimer = null;
    const engine = this.engine;
    if (!engine || this.stopped || this.loading) return;
    this.loading = true;
    let ok = false;
    try {
      ok = await engine.load();
    } catch (e) {
      this.fail(`load: ${errText(e)}`);
    }
    this.loading = false;
    if (this.stopped) return;
    if (!ok) {
      const why = engine.error() || "model load failed";
      this.post({ type: "error", message: `${this.init?.model.id}: ${why}` });
      this.retryTimer = setTimeout(() => void this.load(), Math.max(100, this.init?.retryMs ?? 30_000));
      (this.retryTimer as any).unref?.();
    }
    this.postStats();
  }

  private async onFrame(seq: number, frame: DetectorFrameLike): Promise<void> {
    const capturedAtMs = Number(frame?.capturedAtMs) || 0;
    const engine = this.engine;
    if (this.stopped) return;
    if (!engine || !engine.ready()) {
      this.post({ type: "result", seq, capturedAtMs, ok: false, detections: [], loopMs: 0, error: `model not ready: ${engine?.error() || "not initialised"}` });
      return;
    }
    const t0 = performance.now();
    try {
      const detections = await engine.detect(frame);
      const loopMs = performance.now() - t0;
      this.s.runs += 1;
      this.s.lastLoopMs = loopMs;
      this.post({ type: "result", seq, capturedAtMs, ok: true, detections, loopMs });
    } catch (e) {
      const error = this.fail(`detect: ${errText(e)}`);
      this.post({ type: "result", seq, capturedAtMs, ok: false, detections: [], loopMs: performance.now() - t0, error });
    }
  }

  private onStop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.retryTimer = null;
    this.statsTimer = null;
    this.chain = this.chain.then(() => this.post({ type: "stopped" }));
  }

  private postStats(): void {
    if (!this.stopped) this.post({ type: "stats", stats: this.stats() });
  }

  private post(msg: DetectorToHost): void {
    try {
      this.opts.post(msg);
    } catch {}
  }

  private fail(message: string): string {
    this.s.errors += 1;
    this.s.lastError = message.slice(0, 300);
    return this.s.lastError;
  }
}

type DetectorFrameLike = Parameters<PersonDetectorEngine["detect"]>[0];

// ---- in-process transport (tests and tools only) --------------------------------

/** What the host needs from a detector worker (node:worker_threads Worker fits). */
export interface PresenceWorkerLike {
  postMessage(msg: HostToDetector, transfer?: ReadonlyArray<ArrayBuffer>): void;
  on(event: "message", listener: (msg: DetectorToHost) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number> | void;
}

/**
 * A PresenceDetectorCore on the CURRENT thread behind the worker interface
 * (messages delivered asynchronously). For tests with a fake engine and for the
 * offline parity tool; production always uses a real worker thread.
 */
export function createInProcessDetectorWorker(createEngine: DetectorEngineFactory): PresenceWorkerLike & { core: PresenceDetectorCore } {
  const listeners = { message: [] as Array<(m: any) => void>, error: [] as Array<(e: Error) => void>, exit: [] as Array<(c: number) => void> };
  let terminated = false;
  const core = new PresenceDetectorCore({
    createEngine,
    setPriority: () => null,
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
