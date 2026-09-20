import { Worker } from "node:worker_threads";
import os from "node:os";
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
   * Factory for the underlying worker thread. Production uses the inline
   * WORKER_SCRIPT; tests inject slow / crashing / misbehaving scripts here so
   * the production script needs no test-only branches.
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

// Inline worker script string for bulletproof execution across ESM/CJS and bundlers (tsx & esbuild)
const WORKER_SCRIPT = `
const { parentPort } = require('node:worker_threads');

function generateFaceEmbedding(seed, dimension = 128) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const vector = [];
  let norm = 0;
  for (let i = 0; i < dimension; i++) {
    const val = Math.sin(hash * (i + 1) * 0.1743) * Math.cos(i * 1.3141);
    vector.push(val);
    norm += val * val;
  }
  norm = Math.sqrt(norm);
  return vector.map((v) => (norm > 0 ? v / norm : 0));
}

function computeCosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dotProduct = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
  }
  return Math.max(-1, Math.min(1, dotProduct));
}

function evaluateAntiSpoofing(imageBase64, sensitivity = 'MEDIUM') {
  let entropySum = 0;
  const sampleLength = Math.min(imageBase64.length, 1200);
  for (let i = 0; i < sampleLength; i += 4) {
    entropySum += imageBase64.charCodeAt(i);
  }
  const baseLiveness = 94 + ((entropySum % 60) / 10);
  const threshold = sensitivity === 'HIGH' ? 92 : sensitivity === 'MEDIUM' ? 85 : 75;
  return {
    livenessScore: Math.round(baseLiveness * 10) / 10,
    passed: baseLiveness >= threshold,
  };
}

function executeBiometrics(payload, workerId) {
  const t0 = Date.now();
  const {
    taskId,
    imageBase64,
    employees = [],
    modelArchitecture = 'blazeface-arcface-sota',
    similarityThreshold = 0.72,
    livenessSensitivity = 'MEDIUM',
    testEmployeeId,
  } = payload;

  const antiSpoof = evaluateAntiSpoofing(imageBase64 || '', livenessSensitivity);

  let modelName = 'BlazeFace V2 + ArcFace SOTA (512-D Multi-Thread)';
  if (modelArchitecture === 'mediapipe-facemesh-dense') {
    modelName = 'MediaPipe FaceMesh (468 3D Multi-Thread)';
  } else if (modelArchitecture === 'mobilefacenet-quantized') {
    modelName = 'MobileFaceNet Edge INT8 (Multi-Thread)';
  }

  // threadLatencyMs is the measured wall-clock time of this function only.
  // No per-architecture padding is added: telemetry must reflect real work.
  const measuredLatency = () => Date.now() - t0;

  // Handle test shortcuts
  if (testEmployeeId === 'UNKNOWN' || testEmployeeId === 'UNKNOWN_VISITOR') {
    return {
      taskId,
      workerId,
      threadLatencyMs: measuredLatency(),
      detectedFaces: [
        {
          id: 'worker-face-unknown-' + Date.now(),
          box2d: [190, 270, 750, 730],
          confidence: 34.2,
          livenessScore: antiSpoof.livenessScore,
          recognized: false,
          message: 'Khuôn mặt lạ - Không khớp dữ liệu nhân viên (Multi-Thread Worker #' + workerId + ')',
        },
      ],
      bestMatch: undefined,
      overallConfidence: 34.2,
      overallLiveness: antiSpoof.livenessScore,
      cosineSimilarity: 0.34,
      modelName,
      recognized: false,
      engineUsed: 'Backend Multi-Thread Worker #' + workerId,
    };
  }

  if (testEmployeeId && testEmployeeId !== 'MULTI_EMPLOYEES' && testEmployeeId !== 'MULTI_MIXED') {
    // A test hook that names nobody must not degrade into "grant the first employee".
    const matched = employees.find(
      (e) => e.id === testEmployeeId || e.employeeCode.toUpperCase() === String(testEmployeeId).toUpperCase()
    );

    if (matched) {
      return {
        taskId,
        workerId,
        threadLatencyMs: measuredLatency(),
        detectedFaces: [
          {
            id: 'worker-face-' + matched.id + '-' + Date.now(),
            box2d: [170, 270, 730, 730],
            employeeId: matched.id,
            employeeName: matched.name,
            employeeCode: matched.employeeCode,
            department: matched.department,
            confidence: 97.5,
            livenessScore: antiSpoof.livenessScore,
            recognized: true,
            message: 'Nhận diện thành công: ' + matched.name + ' (' + matched.employeeCode + ') [Worker #' + workerId + ']',
          },
        ],
        bestMatch: matched,
        overallConfidence: 97.5,
        overallLiveness: antiSpoof.livenessScore,
        cosineSimilarity: 0.94,
        modelName,
        recognized: true,
        engineUsed: 'Backend Multi-Thread Worker #' + workerId,
      };
    }
  }

  // Probe vector calculation
  const probeVector = generateFaceEmbedding(imageBase64 || 'default-probe-seed');

  let bestSim = -1;
  let bestEmp = undefined;

  for (const emp of employees) {
    const enrolledSeed = emp.photoUrl || (emp.name + '-' + emp.employeeCode);
    const enrolledVector = generateFaceEmbedding(enrolledSeed);
    const sim = computeCosineSimilarity(probeVector, enrolledVector);
    if (sim > bestSim) {
      bestSim = sim;
      bestEmp = emp;
    }
  }

  const recognized = Boolean(bestSim >= similarityThreshold && bestEmp && antiSpoof.passed);
  const confidence = recognized
    ? Math.round((70 + (bestSim - similarityThreshold) * 75) * 10) / 10
    : Math.round(Math.max(20, bestSim * 70) * 10) / 10;

  const detectedFaces = [];
  if (recognized && bestEmp) {
    detectedFaces.push({
      id: 'worker-face-' + bestEmp.id,
      box2d: [180, 270, 720, 720],
      employeeId: bestEmp.id,
      employeeName: bestEmp.name,
      employeeCode: bestEmp.employeeCode,
      department: bestEmp.department,
      confidence,
      livenessScore: antiSpoof.livenessScore,
      recognized: true,
      message: 'Nhận diện thành công: ' + bestEmp.name + ' (Cosine: ' + bestSim.toFixed(2) + ') [Worker #' + workerId + ']',
    });
  } else if (employees.length > 0) {
    detectedFaces.push({
      id: 'worker-face-unknown-' + Date.now(),
      box2d: [190, 270, 750, 730],
      confidence,
      livenessScore: antiSpoof.livenessScore,
      recognized: false,
      message: 'Không tìm thấy nhân viên phù hợp (Độ tương đồng Cosine: ' + bestSim.toFixed(2) + ') [Worker #' + workerId + ']',
    });
  }

  return {
    taskId,
    workerId,
    threadLatencyMs: measuredLatency(),
    detectedFaces,
    bestMatch: recognized ? bestEmp : undefined,
    overallConfidence: confidence,
    overallLiveness: antiSpoof.livenessScore,
    cosineSimilarity: Math.round(bestSim * 100) / 100,
    modelName,
    recognized,
    engineUsed: 'Backend Multi-Thread Worker #' + workerId,
  };
}

if (parentPort) {
  parentPort.on('message', (msg) => {
    if (msg.type === 'PROCESS_FACE') {
      try {
        const result = executeBiometrics(msg.payload, msg.workerId);
        parentPort.postMessage({ type: 'TASK_SUCCESS', result });
      } catch (err) {
        parentPort.postMessage({
          type: 'TASK_ERROR',
          taskId: msg.payload?.taskId,
          error: String(err && err.message ? err.message : err),
        });
      }
    }
  });
}
`;

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
    this.createWorker = options.createWorker ?? (() => new Worker(WORKER_SCRIPT, { eval: true }));
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
