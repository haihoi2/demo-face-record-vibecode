import { Worker } from "node:worker_threads";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  Employee,
  DetectedFace,
  LocalBiometricModel,
  ThreadPoolTelemetry,
  WorkerThreadStatus,
} from "../types";

export interface FaceTaskPayload {
  taskId: string;
  imageBase64: string;
  employees: Employee[];
  scanType?: "ENTRY" | "EXIT";
  testEmployeeId?: string;
  modelArchitecture?: LocalBiometricModel;
  similarityThreshold?: number;
  livenessSensitivity?: "LOW" | "MEDIUM" | "HIGH";
}

export interface FaceTaskResult {
  taskId: string;
  workerId: number;
  threadLatencyMs: number;
  detectedFaces: DetectedFace[];
  bestMatch?: Employee;
  overallConfidence: number;
  overallLiveness: number;
  cosineSimilarity: number;
  modelName: string;
  recognized: boolean;
  engineUsed: string;
}

export interface FaceWorkerPoolOptions {
  /**
   * Per-task wall-clock budget. A task that has not produced a result within
   * this many ms is rejected and its worker thread is terminated + respawned
   * (a stuck worker cannot be trusted to serve the next frame).
   * Default: FACE_TASK_TIMEOUT_MS env, else 10 000 ms.
   */
  taskTimeoutMs?: number;
  /**
   * Maximum number of tasks waiting for a free worker. When every worker is
   * busy and the queue is full, dispatchFaceTask() rejects immediately so the
   * caller can shed load instead of buffering ~780 KB frames without bound.
   * Default: FACE_TASK_QUEUE_MAX env, else 32.
   */
  queueMax?: number;
  /** Delay before respawning a worker that exited on its own. Default 500 ms. */
  respawnDelayMs?: number;
  /**
   * Factory for the underlying worker thread. Production loads the real
   * module resolved by resolveFaceWorkerEntry(); tests inject slow / crashing
   * / misbehaving stubs here so the production worker needs no test-only
   * branches.
   */
  createWorker?: () => Worker;
}

/** ThreadPoolTelemetry plus the pool limits, so operators can see backpressure settings. */
export type FaceWorkerPoolTelemetry = ThreadPoolTelemetry & {
  queueMax: number;
  taskTimeoutMs: number;
};

export const DEFAULT_FACE_TASK_TIMEOUT_MS = 10_000;
export const DEFAULT_FACE_TASK_QUEUE_MAX = 32;
const DEFAULT_RESPAWN_DELAY_MS = 500;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve the entry file for the face worker thread.
 *
 * The worker body used to be an inline JavaScript string started with
 * `new Worker(script, { eval: true })`. An eval'd string can never
 * `require`/`import` project modules, so the ONNX face-embedding engine could
 * not run inside a worker at all. The body now lives in ./faceWorker.ts and is
 * loaded as a real module; this function finds the right copy of it for
 * whichever runtime we happen to be in.
 *
 * Candidates, in order:
 *   1. FACE_WORKER_PATH - explicit operator/test override. Strict: a missing
 *      file throws rather than silently running some *other* worker.
 *   2. Next to this module, when `__dirname` exists:
 *        - esbuild CJS bundle  -> __dirname is dist/, so dist/faceWorker.cjs
 *          (emitted by `npm run build:worker`);
 *        - tsx's CommonJS path -> __dirname is src/server/, so faceWorker.ts.
 *      `.cjs`/`.js` are tried before `.ts`; they never coexist in one directory.
 *   3. Relative to process.cwd(), for ESM under tsx (`tsx server.ts`,
 *      `node --import tsx --test`), where a module has no `__dirname` at all.
 *      The `.ts` source is tried before `dist/faceWorker.cjs` so a stale bundle
 *      can never shadow live sources during development.
 *
 * `new Worker(new URL('./faceWorker.js', import.meta.url))` is deliberately
 * NOT used: `import.meta` does not survive esbuild's CJS bundling (it is
 * replaced by an empty object), and no single expression is valid in both the
 * ESM source and the CJS bundle.
 *
 * Throwing here is safe: spawnWorker() catches it and the pool falls back to
 * its fail-closed path (recognized:false, no bestMatch).
 */
export function resolveFaceWorkerEntry(): string {
  // Deliberately not memoised: it runs only when a thread is spawned (a
  // handful of times per pool epoch), and an operator changing
  // FACE_WORKER_PATH must take effect on the next respawn.
  const override = process.env.FACE_WORKER_PATH?.trim();
  if (override) {
    const resolved = path.resolve(override);
    if (!fs.existsSync(resolved)) {
      throw new Error(`FACE_WORKER_PATH points at a missing file: ${resolved}`);
    }
    return resolved;
  }

  const candidates: string[] = [];

  // `typeof` (not a bare reference) so this cannot throw in an ESM realm,
  // where `__dirname` is not declared at all.
  const moduleDir = typeof __dirname === "string" ? __dirname : null;
  if (moduleDir) {
    candidates.push(
      path.join(moduleDir, "faceWorker.cjs"),
      path.join(moduleDir, "faceWorker.js"),
      path.join(moduleDir, "faceWorker.ts")
    );
  }

  const cwd = process.cwd();
  candidates.push(path.join(cwd, "src", "server", "faceWorker.ts"), path.join(cwd, "dist", "faceWorker.cjs"));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    `Face worker entry not found. Tried: ${candidates.join(", ")}. ` +
      `Run \`npm run build:worker\` or set FACE_WORKER_PATH.`
  );
}

/** Default worker factory: a real module file, so it can import project code. */
function createDefaultFaceWorker(): Worker {
  return new Worker(resolveFaceWorkerEntry());
}

interface QueuedTask {
  payload: FaceTaskPayload;
  resolve: (res: FaceTaskResult) => void;
  reject: (err: any) => void;
  enqueuedAt: number;
}

interface InFlightTask {
  task: QueuedTask;
  timer: NodeJS.Timeout | null;
  startedAt: number;
}

interface InternalWorkerItem {
  id: number;
  worker: Worker | null;
  busy: boolean;
  tasksCompleted: number;
  lastLatencyMs: number;
  currentTaskId: string | null;
  startedAt: string;
  /** The single task this worker is executing (settled exactly once). */
  inFlight: InFlightTask | null;
  /**
   * True once the underlying thread has died or been terminated. A retired
   * item never receives new tasks; it is replaced by spawnWorker(id).
   */
  retired: boolean;
}

export class FaceWorkerPoolManager {
  private workers: InternalWorkerItem[] = [];
  private taskQueue: QueuedTask[] = [];
  private poolSize = 4;
  // Telemetry epoch: totalProcessed / latencySum are reset together with the
  // per-worker counters on every (re)initialisation, so averageLatencyMs and
  // totalProcessed always describe the *current* set of worker threads and
  // sum(workers[].tasksCompleted) === totalProcessed holds at all times.
  private totalProcessed = 0;
  private latencySum = 0;
  private sseBroadcastCallback?: (event: string, data: any) => void;
  private isInitialized = false;

  private readonly taskTimeoutMs: number;
  private readonly queueMax: number;
  private readonly respawnDelayMs: number;
  private readonly createWorker: () => Worker;
  /** Pending delayed respawns; cleared on re-init/shutdown so they cannot outlive the pool epoch. */
  private respawnTimers = new Set<NodeJS.Timeout>();

  constructor(defaultSize = 4, options: FaceWorkerPoolOptions = {}) {
    this.poolSize = Math.max(1, Math.min(8, defaultSize || os.cpus()?.length || 4));
    this.taskTimeoutMs =
      options.taskTimeoutMs ?? readPositiveIntEnv("FACE_TASK_TIMEOUT_MS", DEFAULT_FACE_TASK_TIMEOUT_MS);
    this.queueMax = options.queueMax ?? readPositiveIntEnv("FACE_TASK_QUEUE_MAX", DEFAULT_FACE_TASK_QUEUE_MAX);
    this.respawnDelayMs = options.respawnDelayMs ?? DEFAULT_RESPAWN_DELAY_MS;
    this.createWorker = options.createWorker ?? createDefaultFaceWorker;
  }

  public setBroadcastSSE(callback: (event: string, data: any) => void) {
    this.sseBroadcastCallback = callback;
  }

  public initWorkerPool(count?: number) {
    if (count) this.poolSize = Math.max(1, Math.min(8, count));

    // Re-initialising: nothing already accepted can survive the old threads,
    // so fail it loudly now instead of letting callers hang forever.
    if (this.isInitialized || this.workers.length > 0 || this.taskQueue.length > 0) {
      this.rejectAllPending(
        (taskId) =>
          `Face worker pool reinitialised (${this.poolSize} luồng) - task ${taskId} bị hủy, vui lòng gửi lại khung hình`
      );
    }

    // Terminate existing workers if re-initializing
    this.clearRespawnTimers();
    for (const w of this.workers) {
      this.terminateWorkerItem(w);
    }
    this.workers = [];
    this.totalProcessed = 0;
    this.latencySum = 0;

    console.log(`[WorkerPool] Khởi tạo cụm Multi-Thread Worker Pool với ${this.poolSize} luồng nhận diện khuôn mặt...`);

    for (let i = 1; i <= this.poolSize; i++) {
      this.spawnWorker(i);
    }

    this.isInitialized = true;
    // No-op on an empty queue; keeps the "idle worker + queued task never coexist" invariant.
    this.processNextInQueue();
  }

  /**
   * Reject every in-flight and queued task, terminate all threads and leave the
   * pool empty. The next dispatchFaceTask() re-initialises it lazily.
   */
  public async shutdown(): Promise<void> {
    this.rejectAllPending((taskId) => `Face worker pool shut down - task ${taskId} bị hủy`);
    this.clearRespawnTimers();
    const workers = this.workers;
    this.workers = [];
    this.isInitialized = false;
    await Promise.all(
      workers.map(async (w) => {
        w.retired = true;
        if (w.worker) {
          try {
            await w.worker.terminate();
          } catch {}
        }
      })
    );
  }

  private spawnWorker(id: number) {
    const item: InternalWorkerItem = {
      id,
      worker: null,
      busy: false,
      tasksCompleted: 0,
      lastLatencyMs: 0,
      currentTaskId: null,
      startedAt: new Date().toISOString(),
      inFlight: null,
      retired: false,
    };

    try {
      const worker = this.createWorker();

      worker.on("message", (msg: any) => this.handleWorkerMessage(item, msg));

      worker.on("error", (err) => {
        console.warn(`[WorkerPool] Lỗi trong Worker Thread #${id}:`, err?.message ?? err);
        item.retired = true;
        this.failInFlight(
          item,
          new Error(`Worker Thread #${id} gặp lỗi khi xử lý task ${item.currentTaskId ?? "?"}: ${err?.message ?? err}`)
        );
        this.processNextInQueue();
      });

      worker.on("exit", (code) => {
        // Ignore exits of threads we already replaced (timeout respawn, re-init, shutdown).
        if (!this.isCurrent(item)) return;
        item.retired = true;
        this.failInFlight(
          item,
          new Error(`Worker Thread #${id} dừng (mã thoát ${code}) khi đang xử lý task ${item.currentTaskId ?? "?"}`)
        );
        this.processNextInQueue();

        if (this.isInitialized) {
          console.warn(`[WorkerPool] Worker Thread #${id} dừng với mã thoát ${code}. Tự động khởi động lại luồng...`);
          // Not unref'd on purpose: queued tasks may be waiting for this respawn
          // and nothing else would keep the event loop alive for them.
          const timer = setTimeout(() => {
            this.respawnTimers.delete(timer);
            if (!this.isCurrent(item)) return;
            this.spawnWorker(id);
            this.processNextInQueue();
          }, this.respawnDelayMs);
          this.respawnTimers.add(timer);
        }
      });

      item.worker = worker;
    } catch (err: any) {
      console.warn(`[WorkerPool] Không thể khởi tạo native Worker Thread #${id} (${err?.message}). Kích hoạt async fallback.`);
      item.worker = null;
    }

    const existingIdx = this.workers.findIndex((w) => w.id === id);
    if (existingIdx !== -1) {
      this.workers[existingIdx] = item;
    } else {
      this.workers.push(item);
    }
  }

  private clearRespawnTimers() {
    for (const t of this.respawnTimers) clearTimeout(t);
    this.respawnTimers.clear();
  }

  private isCurrent(item: InternalWorkerItem): boolean {
    return this.workers.includes(item);
  }

  private terminateWorkerItem(item: InternalWorkerItem) {
    item.retired = true;
    if (item.worker) {
      try {
        item.worker.terminate().catch(() => {});
      } catch {}
    }
  }

  private handleWorkerMessage(item: InternalWorkerItem, msg: any) {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "TASK_SUCCESS") {
      const taskId = msg.result?.taskId;
      if (!item.inFlight || item.inFlight.task.payload.taskId !== taskId) {
        console.warn(
          `[WorkerPool] Bỏ qua kết quả lạ từ Worker #${item.id}: taskId ${String(taskId)} không khớp task đang xử lý (${item.currentTaskId ?? "không có"})`
        );
        return;
      }
      this.handleTaskCompleted(item, msg.result);
    } else if (msg.type === "TASK_ERROR") {
      if (!item.inFlight || item.inFlight.task.payload.taskId !== msg.taskId) {
        console.warn(
          `[WorkerPool] Bỏ qua lỗi lạ từ Worker #${item.id}: taskId ${String(msg.taskId)} không khớp task đang xử lý (${item.currentTaskId ?? "không có"})`
        );
        return;
      }
      this.handleTaskError(item, msg.taskId, msg.error);
    }
  }

  /** Detach the in-flight task from a worker (clearing its timeout) and mark the worker idle. */
  private takeInFlight(item: InternalWorkerItem): InFlightTask | null {
    const inFlight = item.inFlight;
    if (inFlight?.timer) clearTimeout(inFlight.timer);
    item.inFlight = null;
    item.busy = false;
    item.currentTaskId = null;
    return inFlight;
  }

  private failInFlight(item: InternalWorkerItem, err: Error) {
    const inFlight = this.takeInFlight(item);
    if (inFlight) inFlight.task.reject(err);
  }

  private rejectAllPending(describe: (taskId: string) => string) {
    for (const w of this.workers) {
      const inFlight = this.takeInFlight(w);
      if (inFlight) inFlight.task.reject(new Error(describe(inFlight.task.payload.taskId)));
    }
    const queued = this.taskQueue;
    this.taskQueue = [];
    for (const t of queued) {
      t.reject(new Error(describe(t.payload.taskId)));
    }
  }

  private handleTaskCompleted(workerItem: InternalWorkerItem, result: FaceTaskResult) {
    const inFlight = this.takeInFlight(workerItem);

    workerItem.tasksCompleted += 1;
    workerItem.lastLatencyMs = result.threadLatencyMs;

    this.totalProcessed += 1;
    this.latencySum += result.threadLatencyMs;

    // Notify SSE listeners
    if (this.sseBroadcastCallback) {
      this.sseBroadcastCallback("worker_task_completed", {
        workerId: workerItem.id,
        taskId: result.taskId,
        latencyMs: result.threadLatencyMs,
        recognized: result.recognized,
        bestMatch: result.bestMatch?.name,
        telemetry: this.getPoolTelemetry(),
      });
    }

    inFlight?.task.resolve(result);
    this.processNextInQueue();
  }

  private handleTaskError(workerItem: InternalWorkerItem, taskId: string, error: string) {
    console.error(`[WorkerPool] Worker #${workerItem.id} trả về lỗi cho task ${taskId}:`, error);
    this.failInFlight(workerItem, new Error(error || "Lỗi Worker Thread"));
    this.processNextInQueue();
  }

  private handleTaskTimeout(workerItem: InternalWorkerItem, task: QueuedTask) {
    // Stale timer (task already settled, or worker already replaced) - nothing to do.
    if (!workerItem.inFlight || workerItem.inFlight.task !== task) return;

    console.error(
      `[WorkerPool] Task ${task.payload.taskId} vượt quá ${this.taskTimeoutMs} ms trên Worker #${workerItem.id}. Hủy task và khởi động lại luồng.`
    );
    this.failInFlight(
      workerItem,
      new Error(
        `Face task ${task.payload.taskId} timed out after ${this.taskTimeoutMs} ms on worker #${workerItem.id}; worker thread restarted`
      )
    );

    // A worker that stopped answering cannot be trusted with the next frame.
    if (workerItem.worker && this.isCurrent(workerItem)) {
      this.terminateWorkerItem(workerItem);
      this.spawnWorker(workerItem.id);
    }
    this.processNextInQueue();
  }

  private findIdleWorker(): InternalWorkerItem | undefined {
    return this.workers.find((w) => !w.busy && !w.retired);
  }

  private processNextInQueue() {
    while (this.taskQueue.length > 0) {
      const idleWorker = this.findIdleWorker();
      if (!idleWorker) return;

      const nextTask = this.taskQueue.shift();
      if (!nextTask) return;

      this.executeTaskOnWorker(idleWorker, nextTask);
    }
  }

  private executeTaskOnWorker(workerItem: InternalWorkerItem, task: QueuedTask) {
    workerItem.busy = true;
    workerItem.currentTaskId = task.payload.taskId;
    const timer =
      this.taskTimeoutMs > 0 ? setTimeout(() => this.handleTaskTimeout(workerItem, task), this.taskTimeoutMs) : null;
    workerItem.inFlight = { task, timer, startedAt: Date.now() };

    if (workerItem.worker) {
      // Execute on native Node.js Worker Thread; the permanent "message"
      // listener installed in spawnWorker settles the task by taskId.
      try {
        workerItem.worker.postMessage({
          type: "PROCESS_FACE",
          payload: task.payload,
          workerId: workerItem.id,
        });
      } catch (err: any) {
        this.failInFlight(workerItem, err instanceof Error ? err : new Error(String(err)));
        this.processNextInQueue();
      }
    } else {
      // No worker thread available. This path used to fabricate a match for
      // employees[0] at 97% confidence, which meant a failure to spawn threads
      // silently granted access to any face. A recognition engine that cannot
      // run must deny, never approve.
      setImmediate(() => {
        if (workerItem.inFlight?.task !== task) return; // cancelled meanwhile (re-init / shutdown)
        try {
          const t0 = Date.now();
          const result: FaceTaskResult = {
            taskId: task.payload.taskId,
            workerId: workerItem.id,
            threadLatencyMs: Math.max(1, Date.now() - t0),
            detectedFaces: [],
            bestMatch: undefined,
            overallConfidence: 0,
            overallLiveness: 0,
            cosineSimilarity: 0,
            modelName: "Unavailable (worker thread could not be started)",
            recognized: false,
            engineUsed: `Backend Multi-Thread Worker #${workerItem.id} (unavailable)`,
          };
          console.error(
            `[WorkerPool] Worker #${workerItem.id} không khả dụng - từ chối nhận diện task ${task.payload.taskId} (fail-closed).`
          );
          this.handleTaskCompleted(workerItem, result);
        } catch (err) {
          this.failInFlight(workerItem, err instanceof Error ? err : new Error(String(err)));
          this.processNextInQueue();
        }
      });
    }
  }

  public dispatchFaceTask(payload: FaceTaskPayload): Promise<FaceTaskResult> {
    if (!this.isInitialized || this.workers.length === 0) {
      this.initWorkerPool(this.poolSize);
    }

    return new Promise((resolve, reject) => {
      const task: QueuedTask = {
        payload,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      };

      const idleWorker = this.findIdleWorker();
      if (idleWorker) {
        this.executeTaskOnWorker(idleWorker, task);
        return;
      }

      if (this.taskQueue.length >= this.queueMax) {
        reject(
          new Error(
            `Face worker pool backpressure: queue full (${this.taskQueue.length}/${this.queueMax} tasks waiting) - task ${payload.taskId} rejected`
          )
        );
        return;
      }

      this.taskQueue.push(task);
    });
  }

  public scaleWorkerPool(newCount: number): FaceWorkerPoolTelemetry {
    const target = Math.max(1, Math.min(8, newCount));
    if (target === this.poolSize) return this.getPoolTelemetry();

    console.log(`[WorkerPool] Điều chỉnh số luồng Worker từ ${this.poolSize} -> ${target} threads`);
    this.initWorkerPool(target);
    return this.getPoolTelemetry();
  }

  public getPoolTelemetry(): FaceWorkerPoolTelemetry {
    const workersStatus: WorkerThreadStatus[] = this.workers.map((w) => ({
      id: w.id,
      status: w.busy ? "BUSY" : "IDLE",
      tasksCompleted: w.tasksCompleted,
      lastLatencyMs: w.lastLatencyMs,
      currentTaskId: w.currentTaskId,
      startedAt: w.startedAt,
    }));

    const activeWorkers = this.workers.filter((w) => w.busy).length;
    // Measured only: 0 until the first task of the current epoch completes.
    const avgLatency = this.totalProcessed > 0 ? Math.round((this.latencySum / this.totalProcessed) * 10) / 10 : 0;

    return {
      enabled: true,
      workerThreadsCount: this.workers.length,
      activeWorkers,
      queueDepth: this.taskQueue.length,
      queueMax: this.queueMax,
      taskTimeoutMs: this.taskTimeoutMs,
      totalProcessed: this.totalProcessed,
      averageLatencyMs: avgLatency,
      workers: workersStatus,
    };
  }
}

export const faceWorkerPool = new FaceWorkerPoolManager(4);
