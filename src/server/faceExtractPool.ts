/**
 * Off-thread door-scan face extraction (Taiga #507).
 *
 * `extractFacesOffThread(image)` returns what `loadImage(image)` +
 * `extractFaces(rgb)` return on the main thread (frame size + ExtractedFace[]
 * with the same boxes, landmarks, quality/sharpness/edgeEnergy/featureNorm,
 * pose, clear/unclearReason and an L2-normalised Float32Array embedding),
 * computed in a small fixed pool of worker threads that each own an ONNX
 * engine. See faceExtractProtocol.ts for the engine state extractFaces() reads
 * and how each worker is kept in sync with the main thread (env snapshot +
 * configuration fingerprint checked at ready time and before every task).
 *
 * Settings (read once, when the pool is first used, i.e. after dotenv):
 *   FACE_EXTRACT_WORKERS       0-4, default 2. 0 = disabled: every call rejects
 *                              with code "disabled" and the caller runs the
 *                              main-thread path.
 *   FACE_EXTRACT_ORT_THREADS   intra-op threads per worker (1-16). Default
 *                              floor(FACE_ORT_THREADS / workers), at least 1, so
 *                              the pool's total stays at the main engine budget.
 *   FACE_EXTRACT_QUEUE_MAX     tasks waiting for a free worker, default 8.
 *   FACE_EXTRACT_TIMEOUT_MS    per-task budget, default 15000. Applies to the
 *                              wait in the queue and, separately, to the run;
 *                              a worker that overruns is terminated and replaced.
 *   FACE_EXTRACT_WORKER_PATH   explicit worker entry (strict: missing = error).
 *
 * Fail closed: every failure is a rejected promise with a FaceExtractError
 * code - never a silent empty result. A worker whose configuration or model
 * tag differs from the main thread's is never used. Results are validated
 * (512-D, finite, unit-length embeddings, matching model tag) before they are
 * returned. Frames and embeddings are never logged.
 *
 * Memory: each worker holds its own SCRFD + ArcFace sessions (~0.3-0.4 GB RSS
 * per worker with det_10g + w600k_r50).
 */

import { Worker } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { envNumber } from "./env";
import type { ExtractedFace } from "./faceEmbedding";
import {
  FaceExtractError,
  MAX_EXTRACT_IMAGE_BYTES,
  currentModelTag,
  extractFingerprint,
  extractWorkerEnv,
  splitOrtThreads,
  wireFaceIssue,
  type ExtractOk,
  type ExtractFailed,
  type FaceExtractErrorCode,
  type HostToWorker,
  type WorkerReady,
  type WorkerToHost,
} from "./faceExtractProtocol";

export { FaceExtractError, isFaceExtractError, type FaceExtractErrorCode } from "./faceExtractProtocol";

export interface OffThreadExtraction {
  width: number;
  height: number;
  faces: ExtractedFace[];
  /** Recogniser tag of the worker engine that produced the embeddings. */
  modelTag: string;
  /** Worker-side decode + detect + embed time. */
  workerMs: number;
  /** Host-side time from the call to the result (includes queue wait and messaging). */
  totalMs: number;
}

export interface ExtractCallOptions {
  /**
   * Allow the caller's Buffer to be DETACHED (transferred, zero-copy) when it
   * owns its whole ArrayBuffer. Default false: the frame is copied once, so a
   * caller that still needs the JPEG (observeFrame keeps it for the snapshot)
   * is unaffected.
   */
  transfer?: boolean;
}

/** Minimal Worker surface the pool uses; tests inject fakes through createWorker. */
export interface ExtractWorkerLike {
  postMessage(value: HostToWorker, transferList?: readonly ArrayBuffer[]): void;
  terminate(): Promise<number> | void;
  on(event: "message", listener: (msg: WorkerToHost) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
}

export interface FaceExtractPoolOptions {
  workers?: number;
  ortThreadsPerWorker?: number;
  queueMax?: number;
  taskTimeoutMs?: number;
  /** Respawn back-off after a crash / failed start: first delay, doubling up to max. */
  respawnMinMs?: number;
  respawnMaxMs?: number;
  /** Worker factory; default a real worker thread on resolveFaceExtractWorkerEntry(). */
  createWorker?: (spec: { id: number; env: NodeJS.ProcessEnv }) => ExtractWorkerLike;
  /** Main-thread configuration fingerprint; default extractFingerprint(). Test seam. */
  fingerprint?: () => string;
  /** Main-thread model tag; default currentModelTag(). Test seam. */
  modelTag?: () => string;
}

export interface FaceExtractPoolTelemetry {
  enabled: boolean;
  /** At least one worker has a loaded, compatible engine. */
  ready: boolean;
  workers: number;
  readyWorkers: number;
  busy: number;
  queued: number;
  queueMax: number;
  taskTimeoutMs: number;
  ortThreadsPerWorker: number;
  modelTag: string | null;
  completed: number;
  failed: number;
  failedByCode: Partial<Record<FaceExtractErrorCode, number>>;
  restarts: number;
  /** Mean worker-side ms over completed tasks (0 before the first). */
  avgWorkerMs: number;
  /** Mean host-side ms (queue + messaging + work) over completed tasks. */
  avgTotalMs: number;
  lastError: string | null;
}

type SlotState = "starting" | "ready" | "dead";

interface Task {
  id: number;
  image: ArrayBuffer | string;
  transfer: ArrayBuffer[];
  startedAt: number;
  resolve: (r: OffThreadExtraction) => void;
  reject: (e: FaceExtractError) => void;
  queueTimer: NodeJS.Timeout | null;
}

interface Slot {
  id: number;
  worker: ExtractWorkerLike | null;
  state: SlotState;
  inFlight: { task: Task; timer: NodeJS.Timeout } | null;
  info: WorkerReady | null;
  failures: number;
  respawnTimer: NodeJS.Timeout | null;
}

const DEFAULT_WORKERS = 2;
const MAX_WORKERS = 4;
const DEFAULT_QUEUE_MAX = 8;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Entry file of the extraction worker, like resolveFaceWorkerEntry():
 *   1. FACE_EXTRACT_WORKER_PATH (strict);
 *   2. next to this module when `__dirname` exists (esbuild CJS bundle -> dist/faceExtractWorker.cjs);
 *   3. cwd: src/server/faceExtractWorker.ts (tsx, inherited via execArgv), then dist/faceExtractWorker.cjs.
 */
export function resolveFaceExtractWorkerEntry(): string {
  const override = process.env.FACE_EXTRACT_WORKER_PATH?.trim();
  if (override) {
    const resolved = path.resolve(override);
    if (!fs.existsSync(resolved)) throw new Error(`FACE_EXTRACT_WORKER_PATH points at a missing file: ${resolved}`);
    return resolved;
  }
  const candidates: string[] = [];
  const moduleDir = typeof __dirname === "string" ? __dirname : null;
  if (moduleDir) {
    candidates.push(
      path.join(moduleDir, "faceExtractWorker.cjs"),
      path.join(moduleDir, "faceExtractWorker.js"),
      path.join(moduleDir, "faceExtractWorker.ts"),
    );
  }
  const cwd = process.cwd();
  candidates.push(path.join(cwd, "src", "server", "faceExtractWorker.ts"), path.join(cwd, "dist", "faceExtractWorker.cjs"));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`Face extract worker entry not found. Tried: ${candidates.join(", ")}. Run \`npm run build\` or set FACE_EXTRACT_WORKER_PATH.`);
}

function defaultCreateWorker(spec: { id: number; env: NodeJS.ProcessEnv }): ExtractWorkerLike {
  return new Worker(resolveFaceExtractWorkerEntry(), { name: `face-extract-${spec.id}`, env: spec.env }) as unknown as ExtractWorkerLike;
}

function shortError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

export class FaceExtractPool {
  readonly size: number;
  readonly ortThreadsPerWorker: number;
  readonly queueMax: number;
  readonly taskTimeoutMs: number;
  private readonly respawnMinMs: number;
  private readonly respawnMaxMs: number;
  private readonly createWorker: NonNullable<FaceExtractPoolOptions["createWorker"]>;
  private readonly fingerprint: () => string;
  private readonly modelTag: () => string;

  private slots: Slot[] = [];
  private queue: Task[] = [];
  private started = false;
  private closed = false;
  private nextTaskId = 1;
  private readyWaiters = new Set<() => void>();

  private completed = 0;
  private failed = 0;
  private failedByCode: Partial<Record<FaceExtractErrorCode, number>> = {};
  private restarts = 0;
  private workerMsSum = 0;
  private totalMsSum = 0;
  private lastError: string | null = null;

  constructor(options: FaceExtractPoolOptions = {}) {
    const workers = options.workers ?? envNumber("FACE_EXTRACT_WORKERS", DEFAULT_WORKERS, { min: 0, max: MAX_WORKERS, integer: true });
    this.size = Math.max(0, Math.min(MAX_WORKERS, Math.floor(workers)));
    const perWorker = options.ortThreadsPerWorker ?? envNumber("FACE_EXTRACT_ORT_THREADS", 0, { min: 1, max: 16, integer: true });
    this.ortThreadsPerWorker = splitOrtThreads(
      envNumber("FACE_ORT_THREADS", 4, { min: 1, max: 64, integer: true }),
      Math.max(1, this.size),
      perWorker || null,
    );
    this.queueMax = options.queueMax ?? envNumber("FACE_EXTRACT_QUEUE_MAX", DEFAULT_QUEUE_MAX, { min: 0, max: 256, integer: true });
    this.taskTimeoutMs = options.taskTimeoutMs ?? envNumber("FACE_EXTRACT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, { min: 100, max: 300_000, integer: true });
    this.respawnMinMs = options.respawnMinMs ?? 1000;
    this.respawnMaxMs = options.respawnMaxMs ?? 60_000;
    this.createWorker = options.createWorker ?? defaultCreateWorker;
    this.fingerprint = options.fingerprint ?? extractFingerprint;
    this.modelTag = options.modelTag ?? currentModelTag;
  }

  get enabled(): boolean {
    return this.size > 0;
  }

  /** Spawn the workers (idempotent). Called lazily by extract(); call it at boot to load models early. */
  start(): void {
    if (!this.enabled || this.started || this.closed) return;
    this.started = true;
    for (let i = 1; i <= this.size; i++) {
      const slot: Slot = { id: i, worker: null, state: "dead", inFlight: null, info: null, failures: 0, respawnTimer: null };
      this.slots.push(slot);
      this.spawn(slot);
    }
  }

  /** True when at least one worker has a loaded engine matching the main thread. */
  isReady(): boolean {
    return this.slots.some((s) => s.state === "ready");
  }

  /** Resolves true once a worker is ready, false on timeout, when disabled or shut down. */
  whenReady(timeoutMs = 60_000): Promise<boolean> {
    if (!this.enabled || this.closed) return Promise.resolve(false);
    this.start();
    if (this.isReady()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v: boolean) => {
        clearTimeout(timer);
        this.readyWaiters.delete(onReady);
        resolve(v);
      };
      const onReady = () => done(this.isReady());
      const timer = setTimeout(() => done(false), timeoutMs);
      this.readyWaiters.add(onReady);
    });
  }

  extract(image: Buffer | Uint8Array | string, options: ExtractCallOptions = {}): Promise<OffThreadExtraction> {
    if (this.closed) return this.rejectNow("shutdown", "pool is shut down");
    if (!this.enabled) return this.rejectNow("disabled", "FACE_EXTRACT_WORKERS=0");
    this.start();

    let payload: ArrayBuffer | string;
    let transfer: ArrayBuffer[] = [];
    if (typeof image === "string") {
      if (image.length === 0 || image.length > MAX_EXTRACT_IMAGE_BYTES * 1.4) return this.rejectNow("invalid_input", "empty or oversized image string");
      payload = image;
    } else if (image instanceof Uint8Array) {
      if (image.byteLength === 0 || image.byteLength > MAX_EXTRACT_IMAGE_BYTES) return this.rejectNow("invalid_input", `image is ${image.byteLength} bytes`);
      const exclusive = image.buffer instanceof ArrayBuffer && image.byteOffset === 0 && image.byteLength === image.buffer.byteLength;
      if (options.transfer && exclusive) {
        payload = image.buffer as ArrayBuffer;
      } else {
        payload = new ArrayBuffer(image.byteLength);
        new Uint8Array(payload).set(image);
      }
      transfer = [payload];
    } else {
      return this.rejectNow("invalid_input", "image must be a Buffer, Uint8Array or string");
    }

    // The main thread's configuration may have changed since the workers loaded.
    if (this.recycleIncompatible() && !this.isReady()) {
      return this.rejectNow("config_mismatch", "engine configuration changed; workers restarting with the current settings");
    }
    if (!this.isReady()) {
      return this.rejectNow("not_ready", this.lastError ? `no ready worker (${this.lastError})` : "no ready worker (starting)");
    }

    return new Promise<OffThreadExtraction>((resolve, reject) => {
      const task: Task = { id: this.nextTaskId++, image: payload, transfer, startedAt: performance.now(), resolve, reject, queueTimer: null };
      const idle = this.slots.find((s) => s.state === "ready" && !s.inFlight);
      if (idle) return this.run(idle, task);
      if (this.queue.length >= this.queueMax) {
        return this.settleError(task, new FaceExtractError("overloaded", `all ${this.size} workers busy and ${this.queue.length}/${this.queueMax} queued`));
      }
      task.queueTimer = setTimeout(() => {
        const i = this.queue.indexOf(task);
        if (i < 0) return;
        this.queue.splice(i, 1);
        this.settleError(task, new FaceExtractError("timeout", `waited ${this.taskTimeoutMs} ms for a worker`));
      }, this.taskTimeoutMs);
      this.queue.push(task);
    });
  }

  telemetry(): FaceExtractPoolTelemetry {
    const ready = this.slots.filter((s) => s.state === "ready");
    return {
      enabled: this.enabled,
      ready: ready.length > 0,
      workers: this.size,
      readyWorkers: ready.length,
      busy: this.slots.filter((s) => s.inFlight).length,
      queued: this.queue.length,
      queueMax: this.queueMax,
      taskTimeoutMs: this.taskTimeoutMs,
      ortThreadsPerWorker: this.ortThreadsPerWorker,
      modelTag: ready[0]?.info?.modelTag ?? null,
      completed: this.completed,
      failed: this.failed,
      failedByCode: { ...this.failedByCode },
      restarts: this.restarts,
      avgWorkerMs: this.completed ? Math.round((this.workerMsSum / this.completed) * 10) / 10 : 0,
      avgTotalMs: this.completed ? Math.round((this.totalMsSum / this.completed) * 10) / 10 : 0,
      lastError: this.lastError,
    };
  }

  /** Reject everything pending, terminate the workers; the pool cannot be restarted. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const err = () => new FaceExtractError("shutdown", "pool is shut down");
    for (const t of this.queue.splice(0)) this.settleError(t, err());
    const workers: ExtractWorkerLike[] = [];
    for (const s of this.slots) {
      if (s.respawnTimer) clearTimeout(s.respawnTimer);
      s.respawnTimer = null;
      const inFlight = this.takeInFlight(s);
      if (inFlight) this.settleError(inFlight, err());
      if (s.worker) workers.push(s.worker);
      s.worker = null;
      s.state = "dead";
    }
    for (const w of this.readyWaiters) w();
    await Promise.all(workers.map(async (w) => { try { await w.terminate(); } catch { /* gone */ } }));
  }

  // ---------------------------------------------------------------------------

  private rejectNow(code: FaceExtractErrorCode, message: string): Promise<never> {
    this.count(code);
    return Promise.reject(new FaceExtractError(code, message));
  }

  private count(code: FaceExtractErrorCode): void {
    this.failed += 1;
    this.failedByCode[code] = (this.failedByCode[code] ?? 0) + 1;
  }

  private settleError(task: Task, err: FaceExtractError): void {
    if (task.queueTimer) clearTimeout(task.queueTimer);
    task.queueTimer = null;
    this.count(err.code);
    task.reject(err);
  }

  private spawn(slot: Slot): void {
    if (this.closed) return;
    slot.respawnTimer = null;
    slot.state = "starting";
    slot.info = null;
    let worker: ExtractWorkerLike;
    try {
      worker = this.createWorker({ id: slot.id, env: extractWorkerEnv(this.ortThreadsPerWorker) });
    } catch (err) {
      this.lastError = `worker #${slot.id} could not start: ${shortError(err)}`;
      console.warn(`[faceExtractPool] ${this.lastError}`);
      slot.state = "dead";
      slot.worker = null;
      this.scheduleRespawn(slot);
      return;
    }
    slot.worker = worker;
    worker.on("message", (msg) => {
      if (slot.worker === worker) this.onMessage(slot, msg);
    });
    worker.on("error", (err) => {
      if (slot.worker === worker) this.onDeath(slot, `worker #${slot.id} error: ${shortError(err)}`);
    });
    worker.on("exit", (code) => {
      if (slot.worker === worker) this.onDeath(slot, `worker #${slot.id} exited (code ${code})`);
    });
  }

  private onMessage(slot: Slot, msg: WorkerToHost): void {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ready") {
      const expected = this.fingerprint();
      if (msg.fingerprint !== expected || msg.modelTag !== this.modelTag()) {
        this.retire(slot, `worker #${slot.id} engine configuration differs from the main thread (tag ${String(msg.modelTag).slice(0, 64)}); not used`, true);
        return;
      }
      slot.state = "ready";
      slot.info = msg;
      this.lastError = null;
      for (const w of [...this.readyWaiters]) w();
      this.drain();
      return;
    }
    if (msg.type === "fatal") {
      this.retire(slot, `worker #${slot.id} engine failed to load: ${String(msg.error).slice(0, 300)}`, true);
      return;
    }
    if (msg.type === "result") {
      if (!slot.inFlight || slot.inFlight.task.id !== msg.id) return; // stale / unknown: ignore
      const task = this.takeInFlight(slot)!;
      if (msg.ok === true) this.onResult(slot, task, msg as ExtractOk);
      else this.onFailedResult(slot, task, msg as ExtractFailed);
      this.drain();
    }
  }

  private onResult(slot: Slot, task: Task, msg: ExtractOk): void {
    const faces = Array.isArray(msg.faces) ? msg.faces : null;
    let issue: string | null = null;
    if (!faces) issue = "faces is not an array";
    else if (!Number.isInteger(msg.width) || !Number.isInteger(msg.height) || msg.width <= 0 || msg.height <= 0) issue = "bad frame size";
    else if (msg.modelTag !== this.modelTag() || msg.modelTag !== slot.info?.modelTag) issue = "model tag differs from the main thread";
    else for (const f of faces) if ((issue = wireFaceIssue(f))) break;
    if (issue) {
      this.settleError(task, new FaceExtractError("incompatible_result", `worker #${slot.id}: ${issue}`));
      this.retire(slot, `worker #${slot.id} returned an invalid result (${issue}); replaced`, false);
      return;
    }
    slot.failures = 0;
    const totalMs = performance.now() - task.startedAt;
    const workerMs = Number.isFinite(msg.ms) ? msg.ms : 0;
    this.completed += 1;
    this.workerMsSum += workerMs;
    this.totalMsSum += totalMs;
    task.resolve({ width: msg.width, height: msg.height, faces: faces!, modelTag: msg.modelTag, workerMs, totalMs: Math.round(totalMs) });
  }

  private onFailedResult(slot: Slot, task: Task, msg: ExtractFailed): void {
    const known: FaceExtractErrorCode[] = ["engine_error", "decode_failed", "invalid_input", "not_ready"];
    const code = known.includes(msg.code) ? msg.code : "engine_error";
    this.settleError(task, new FaceExtractError(code, `worker #${slot.id}: ${String(msg.error).slice(0, 300)}`));
    if (code === "not_ready") this.retire(slot, `worker #${slot.id} lost its engine`, true);
  }

  private onDeath(slot: Slot, why: string): void {
    const task = this.takeInFlight(slot);
    if (task) this.settleError(task, new FaceExtractError("worker_crashed", why));
    this.retire(slot, why, true);
  }

  /** Stop using a worker, terminate it and schedule its replacement. */
  private retire(slot: Slot, why: string, backoff: boolean): void {
    this.lastError = why;
    console.warn(`[faceExtractPool] ${why}`);
    const task = this.takeInFlight(slot);
    if (task) this.settleError(task, new FaceExtractError("worker_crashed", why));
    const w = slot.worker;
    slot.worker = null;
    slot.state = "dead";
    slot.info = null;
    if (w) {
      try {
        const p = w.terminate();
        if (p && typeof (p as Promise<number>).catch === "function") (p as Promise<number>).catch(() => {});
      } catch { /* gone */ }
    }
    if (backoff) slot.failures += 1;
    this.scheduleRespawn(slot);
    this.failQueueIfNoWorker();
  }

  private scheduleRespawn(slot: Slot): void {
    if (this.closed || slot.respawnTimer) return;
    const n = Math.max(0, slot.failures - 1);
    const delay = slot.failures === 0 ? 0 : Math.min(this.respawnMaxMs, this.respawnMinMs * 2 ** Math.min(n, 16));
    this.restarts += 1;
    slot.respawnTimer = setTimeout(() => this.spawn(slot), delay);
    slot.respawnTimer.unref?.();
  }

  /** Queued tasks cannot wait for a respawn + model load; reject them when nothing can serve them. */
  private failQueueIfNoWorker(): void {
    if (this.isReady() || this.queue.length === 0) return;
    for (const t of this.queue.splice(0)) {
      this.settleError(t, new FaceExtractError("not_ready", `no ready worker (${this.lastError ?? "restarting"})`));
    }
  }

  /** Retire ready workers whose configuration no longer matches the main thread. True if any was retired. */
  private recycleIncompatible(): boolean {
    if (!this.slots.some((s) => s.state === "ready")) return false;
    const expected = this.fingerprint();
    const tag = this.modelTag();
    let recycled = false;
    for (const s of this.slots) {
      if (s.state !== "ready" || !s.info) continue;
      if (s.info.fingerprint === expected && s.info.modelTag === tag) continue;
      recycled = true;
      const inFlight = this.takeInFlight(s);
      if (inFlight) this.settleError(inFlight, new FaceExtractError("config_mismatch", "engine configuration changed during the task"));
      this.retire(s, `worker #${s.id} configuration no longer matches the main thread; restarting with the current settings`, false);
    }
    return recycled;
  }

  private takeInFlight(slot: Slot): Task | null {
    const f = slot.inFlight;
    if (!f) return null;
    clearTimeout(f.timer);
    slot.inFlight = null;
    return f.task;
  }

  private run(slot: Slot, task: Task): void {
    if (task.queueTimer) clearTimeout(task.queueTimer);
    task.queueTimer = null;
    const timer = setTimeout(() => {
      if (slot.inFlight?.task !== task) return;
      this.takeInFlight(slot);
      this.settleError(task, new FaceExtractError("timeout", `worker #${slot.id} did not answer within ${this.taskTimeoutMs} ms; worker replaced`));
      this.retire(slot, `worker #${slot.id} timed out`, false);
      this.drain();
    }, this.taskTimeoutMs);
    slot.inFlight = { task, timer };
    try {
      slot.worker!.postMessage({ type: "extract", id: task.id, image: task.image }, task.transfer);
      task.image = ""; // drop the host's reference to the frame
    } catch (err) {
      this.takeInFlight(slot);
      this.settleError(task, new FaceExtractError("worker_crashed", `postMessage failed: ${shortError(err)}`));
      this.retire(slot, `worker #${slot.id} postMessage failed`, true);
    }
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const idle = this.slots.find((s) => s.state === "ready" && !s.inFlight);
      if (!idle) return;
      this.run(idle, this.queue.shift()!);
    }
  }
}

let shared: FaceExtractPool | null = null;

/** The process-wide pool, created on first use (after dotenv has run). */
export function getFaceExtractPool(): FaceExtractPool {
  if (!shared) shared = new FaceExtractPool();
  return shared;
}

/**
 * Off-thread `loadImage(image)` + `extractFaces(rgb)`. Rejects with a
 * FaceExtractError (see its `code`) on every failure; never resolves an empty
 * result for an error. "no face" is a resolved result with `faces: []`.
 */
export function extractFacesOffThread(image: Buffer | Uint8Array | string, options?: ExtractCallOptions): Promise<OffThreadExtraction> {
  return getFaceExtractPool().extract(image, options);
}

/** Health/telemetry snapshot of the shared pool (does not start it). */
export function faceExtractPoolTelemetry(): FaceExtractPoolTelemetry {
  return getFaceExtractPool().telemetry();
}

/** Test seam: shut down and forget the shared pool. */
export async function resetFaceExtractPool(): Promise<void> {
  const p = shared;
  shared = null;
  if (p) await p.shutdown();
}
