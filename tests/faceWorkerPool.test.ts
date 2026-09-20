/**
 * Unit tests for the multi-thread face worker pool (src/server/faceWorkerPool.ts).
 *
 * The pool is exercised with (a) the real worker MODULE (src/server/faceWorker.ts,
 * resolved by resolveFaceWorkerEntry()) for the happy path and (b) a stub
 * worker script injected through the `createWorker`
 * option that can be told to stall, crash, echo a foreign taskId or report a
 * TASK_ERROR. That keeps the production worker free of test-only branches
 * while still covering timeout, respawn, backpressure and re-init behaviour.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

import fs from "node:fs";
import path from "node:path";

import {
  FaceWorkerPoolManager,
  FaceWorkerPoolOptions,
  FaceTaskPayload,
  DEFAULT_FACE_TASK_TIMEOUT_MS,
  DEFAULT_FACE_TASK_QUEUE_MAX,
  resolveFaceWorkerEntry,
} from "../src/server/faceWorkerPool";
import { Employee } from "../src/types";

const EMPLOYEES: Employee[] = [
  {
    id: "EMP-0001",
    name: "Nguyễn Văn A",
    employeeCode: "NV-0001",
    department: "Phòng Kỹ Thuật",
    position: "Kỹ sư",
    photoUrl: "https://example.test/a.jpg",
    registeredAt: "2026-01-01T00:00:00.000Z",
    accessLevel: "ALL_ACCESS",
  },
  {
    id: "EMP-0002",
    name: "Trần Thị B",
    employeeCode: "NV-0002",
    department: "Phòng Kỹ Thuật",
    position: "Kỹ sư",
    photoUrl: "https://example.test/b.jpg",
    registeredAt: "2026-01-01T00:00:00.000Z",
    accessLevel: "ALL_ACCESS",
  },
];

const PROBE = "data:image/jpeg;base64," + "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo".repeat(40);

let taskCounter = 0;
function makePayload(overrides: Partial<FaceTaskPayload> = {}): FaceTaskPayload {
  taskCounter += 1;
  return {
    taskId: `t-${taskCounter}`,
    imageBase64: PROBE,
    employees: EMPLOYEES,
    ...overrides,
  };
}

/**
 * Stub worker. Behaviour is selected via payload.testEmployeeId:
 *   __SLOW__    busy-wait 3 s (only worker.terminate() can interrupt it)
 *   __CRASH__   exit the thread with code 7 without answering
 *   __FOREIGN__ post a result carrying a different taskId, then the real one
 *   __THROW__   post TASK_ERROR
 *   otherwise   answer immediately with recognized:false
 */
const STUB_WORKER_SCRIPT = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (msg) => {
  if (msg.type !== 'PROCESS_FACE') return;
  const p = msg.payload;
  const reply = (taskId) => ({
    type: 'TASK_SUCCESS',
    result: {
      taskId,
      workerId: msg.workerId,
      threadLatencyMs: 1,
      detectedFaces: [],
      overallConfidence: 0,
      overallLiveness: 0,
      cosineSimilarity: 0,
      modelName: 'stub',
      recognized: false,
      engineUsed: 'stub #' + msg.workerId,
    },
  });
  if (p.testEmployeeId === '__SLOW__') {
    const until = Date.now() + 3000;
    while (Date.now() < until) {}
  } else if (p.testEmployeeId === '__CRASH__') {
    process.exit(7);
  } else if (p.testEmployeeId === '__FOREIGN__') {
    parentPort.postMessage(reply('foreign-' + p.taskId));
  } else if (p.testEmployeeId === '__THROW__') {
    parentPort.postMessage({ type: 'TASK_ERROR', taskId: p.taskId, error: 'boom' });
    return;
  }
  parentPort.postMessage(reply(p.taskId));
});
`;

const stubWorker = () => new Worker(STUB_WORKER_SCRIPT, { eval: true });

async function withPool<T>(
  size: number,
  options: FaceWorkerPoolOptions,
  fn: (pool: FaceWorkerPoolManager) => Promise<T>
): Promise<T> {
  const pool = new FaceWorkerPoolManager(size, options);
  try {
    return await fn(pool);
  } finally {
    await pool.shutdown();
  }
}

/** Silence the pool's own console output for the duration of a test. */
function quietConsole() {
  const log = mock.method(console, "log", () => {});
  const warn = mock.method(console, "warn", () => {});
  const error = mock.method(console, "error", () => {});
  return {
    warn,
    restore() {
      log.mock.restore();
      warn.mock.restore();
      error.mock.restore();
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("FaceWorkerPoolManager - configuration", () => {
  it("exposes queueMax and taskTimeoutMs in telemetry, honouring constructor options", () => {
    const pool = new FaceWorkerPoolManager(2, { queueMax: 3, taskTimeoutMs: 1234 });
    const t = pool.getPoolTelemetry();
    assert.equal(t.queueMax, 3);
    assert.equal(t.taskTimeoutMs, 1234);
    assert.equal(t.queueDepth, 0);
    assert.equal(t.workerThreadsCount, 0, "getPoolTelemetry must not spawn threads");
  });

  it("ships with sane defaults", () => {
    assert.equal(DEFAULT_FACE_TASK_TIMEOUT_MS, 10_000);
    assert.equal(DEFAULT_FACE_TASK_QUEUE_MAX, 32);
  });
});

describe("resolveFaceWorkerEntry", () => {
  it("resolves to an existing worker module file", () => {
    const entry = resolveFaceWorkerEntry();
    assert.ok(fs.existsSync(entry), `resolved entry must exist: ${entry}`);
    assert.match(path.basename(entry), /^faceWorker\.(ts|cjs|js)$/);
  });

  it("under a TS loader (no __dirname) prefers the .ts source over a built bundle", () => {
    // These tests run as ESM via `node --import tsx`, i.e. exactly the dev
    // runtime. A stale dist/faceWorker.cjs must not shadow live sources.
    assert.equal(typeof (globalThis as any).__dirname, "undefined");
    assert.equal(resolveFaceWorkerEntry(), path.join(process.cwd(), "src", "server", "faceWorker.ts"));
  });

  it("honours FACE_WORKER_PATH and rejects an override that does not exist", () => {
    const previous = process.env.FACE_WORKER_PATH;
    try {
      process.env.FACE_WORKER_PATH = path.join(process.cwd(), "src", "server", "faceWorker.ts");
      assert.equal(resolveFaceWorkerEntry(), path.join(process.cwd(), "src", "server", "faceWorker.ts"));

      process.env.FACE_WORKER_PATH = path.join(process.cwd(), "dist", "definitely-not-here.cjs");
      assert.throws(() => resolveFaceWorkerEntry(), /FACE_WORKER_PATH points at a missing file/);
    } finally {
      if (previous === undefined) delete process.env.FACE_WORKER_PATH;
      else process.env.FACE_WORKER_PATH = previous;
    }
  });
});

describe("FaceWorkerPoolManager - real worker module", () => {
  it("resolves a normal dispatch with a matching taskId and measured latency", async () => {
    const c = quietConsole();
    try {
      await withPool(2, {}, async (pool) => {
        const payload = makePayload({ testEmployeeId: "EMP-0002", modelArchitecture: "mediapipe-facemesh-dense" });
        const result = await pool.dispatchFaceTask(payload);

        assert.equal(result.taskId, payload.taskId);
        assert.ok(result.workerId === 1 || result.workerId === 2);
        assert.equal(result.recognized, true);
        assert.equal(result.bestMatch?.id, "EMP-0002");
        assert.equal(result.modelName, "MediaPipe FaceMesh (468 3D Multi-Thread)");
        // Previously 24 ms of fake "architecture latency" was added; a ~1 ms
        // task must now report (well) under that.
        assert.ok(result.threadLatencyMs >= 0 && result.threadLatencyMs < 24, `latency ${result.threadLatencyMs}`);

        const t = pool.getPoolTelemetry();
        assert.equal(t.totalProcessed, 1);
        assert.equal(t.workerThreadsCount, 2);
        assert.equal(t.activeWorkers, 0);
        assert.equal(
          t.workers.reduce((s, w) => s + w.tasksCompleted, 0),
          t.totalProcessed
        );
      });
    } finally {
      c.restore();
    }
  });

  it("runs concurrent dispatches across the pool and keeps every taskId paired", async () => {
    const c = quietConsole();
    try {
      await withPool(2, {}, async (pool) => {
        const payloads = Array.from({ length: 6 }, (_, i) =>
          makePayload({ testEmployeeId: i % 2 === 0 ? "EMP-0001" : "UNKNOWN" })
        );
        const results = await Promise.all(payloads.map((p) => pool.dispatchFaceTask(p)));
        results.forEach((r, i) => {
          assert.equal(r.taskId, payloads[i].taskId);
          assert.equal(r.recognized, i % 2 === 0);
        });
        assert.equal(pool.getPoolTelemetry().totalProcessed, 6);
        assert.equal(pool.getPoolTelemetry().queueDepth, 0);
      });
    } finally {
      c.restore();
    }
  });
});

describe("FaceWorkerPoolManager - backpressure", () => {
  it("rejects immediately once the queue is full and drains the queue afterwards", async () => {
    const c = quietConsole();
    try {
      await withPool(1, { createWorker: stubWorker, queueMax: 2, taskTimeoutMs: 150 }, async (pool) => {
        const slow = pool.dispatchFaceTask(makePayload({ testEmployeeId: "__SLOW__" }));
        const q1 = pool.dispatchFaceTask(makePayload());
        const q2 = pool.dispatchFaceTask(makePayload());

        const t = pool.getPoolTelemetry();
        assert.equal(t.activeWorkers, 1);
        assert.equal(t.queueDepth, 2);
        assert.equal(t.queueMax, 2);

        await assert.rejects(pool.dispatchFaceTask(makePayload()), /backpressure/);
        assert.equal(pool.getPoolTelemetry().queueDepth, 2, "rejected task must not be enqueued");

        // The stalled task times out, the worker is respawned and the queue drains.
        await assert.rejects(slow, /timed out/);
        const [r1, r2] = await Promise.all([q1, q2]);
        assert.equal(r1.recognized, false);
        assert.equal(r2.recognized, false);
        assert.equal(pool.getPoolTelemetry().queueDepth, 0);
      });
    } finally {
      c.restore();
    }
  });
});

describe("FaceWorkerPoolManager - per-task timeout", () => {
  it("rejects a stalled task and respawns the worker so the next task succeeds", async () => {
    const c = quietConsole();
    try {
      await withPool(1, { createWorker: stubWorker, taskTimeoutMs: 100 }, async (pool) => {
        const slowPayload = makePayload({ testEmployeeId: "__SLOW__" });
        const t0 = Date.now();
        await assert.rejects(pool.dispatchFaceTask(slowPayload), (err: Error) => {
          assert.match(err.message, /timed out after 100 ms/);
          assert.match(err.message, new RegExp(slowPayload.taskId));
          return true;
        });
        assert.ok(Date.now() - t0 < 2500, "must not wait for the 3 s busy-wait to finish");

        const afterTimeout = pool.getPoolTelemetry();
        assert.equal(afterTimeout.workerThreadsCount, 1);
        assert.equal(afterTimeout.activeWorkers, 0);
        assert.equal(afterTimeout.workers[0].status, "IDLE");
        assert.equal(afterTimeout.workers[0].currentTaskId, null);

        const ok = await pool.dispatchFaceTask(makePayload());
        assert.equal(ok.workerId, 1);
        assert.equal(pool.getPoolTelemetry().totalProcessed, 1, "timed-out task must not count as processed");
      });
    } finally {
      c.restore();
    }
  });
});

describe("FaceWorkerPoolManager - worker crash / error", () => {
  it("rejects the in-flight task when the thread exits and respawns it", async () => {
    const c = quietConsole();
    try {
      await withPool(1, { createWorker: stubWorker, respawnDelayMs: 20, taskTimeoutMs: 5000 }, async (pool) => {
        const crash = makePayload({ testEmployeeId: "__CRASH__" });
        await assert.rejects(pool.dispatchFaceTask(crash), /mã thoát 7/);

        // Dispatched before the respawn delay elapses: must be queued, then served.
        const next = await pool.dispatchFaceTask(makePayload());
        assert.equal(next.workerId, 1);
        assert.equal(pool.getPoolTelemetry().workerThreadsCount, 1);
      });
    } finally {
      c.restore();
    }
  });

  it("rejects a TASK_ERROR reply and keeps the worker usable", async () => {
    const c = quietConsole();
    try {
      await withPool(1, { createWorker: stubWorker }, async (pool) => {
        await assert.rejects(pool.dispatchFaceTask(makePayload({ testEmployeeId: "__THROW__" })), /boom/);
        const ok = await pool.dispatchFaceTask(makePayload());
        assert.equal(ok.recognized, false);
        assert.equal(pool.getPoolTelemetry().workers[0].status, "IDLE");
      });
    } finally {
      c.restore();
    }
  });
});

describe("FaceWorkerPoolManager - re-initialisation", () => {
  it("rejects in-flight and queued tasks on scaleWorkerPool and resets telemetry consistently", async () => {
    const c = quietConsole();
    try {
      await withPool(1, { createWorker: stubWorker, taskTimeoutMs: 5000 }, async (pool) => {
        // Populate the previous epoch's counters.
        await pool.dispatchFaceTask(makePayload());
        assert.equal(pool.getPoolTelemetry().totalProcessed, 1);

        const inFlight = pool.dispatchFaceTask(makePayload({ testEmployeeId: "__SLOW__" }));
        const queued1 = pool.dispatchFaceTask(makePayload());
        const queued2 = pool.dispatchFaceTask(makePayload());
        assert.equal(pool.getPoolTelemetry().queueDepth, 2);

        const telemetry = pool.scaleWorkerPool(2);
        assert.equal(telemetry.workerThreadsCount, 2);
        assert.equal(telemetry.queueDepth, 0);
        assert.equal(telemetry.totalProcessed, 0, "pool counters reset with the worker counters");
        assert.equal(telemetry.averageLatencyMs, 0);

        await assert.rejects(inFlight, /reinitialised/);
        await assert.rejects(queued1, /reinitialised/);
        await assert.rejects(queued2, /reinitialised/);

        const fresh = await pool.dispatchFaceTask(makePayload());
        assert.ok(fresh.workerId === 1 || fresh.workerId === 2);
        const t = pool.getPoolTelemetry();
        assert.equal(t.totalProcessed, 1);
        assert.equal(t.workers.reduce((s, w) => s + w.tasksCompleted, 0), 1);
      });
    } finally {
      c.restore();
    }
  });

  it("initWorkerPool re-arms the queue so previously queued work never stalls", async () => {
    const c = quietConsole();
    try {
      await withPool(1, { createWorker: stubWorker, taskTimeoutMs: 5000 }, async (pool) => {
        const inFlight = pool.dispatchFaceTask(makePayload({ testEmployeeId: "__SLOW__" }));
        pool.initWorkerPool(1);
        await assert.rejects(inFlight, /reinitialised/);
        // Same pool size: the new thread must pick up new work without an external nudge.
        const ok = await pool.dispatchFaceTask(makePayload());
        assert.equal(ok.workerId, 1);
      });
    } finally {
      c.restore();
    }
  });
});

describe("FaceWorkerPoolManager - message hygiene", () => {
  it("ignores results whose taskId does not match the worker's current task", async () => {
    const c = quietConsole();
    try {
      await withPool(1, { createWorker: stubWorker }, async (pool) => {
        const payload = makePayload({ testEmployeeId: "__FOREIGN__" });
        const result = await pool.dispatchFaceTask(payload);
        assert.equal(result.taskId, payload.taskId);

        // Let any straggling messages land.
        await sleep(30);
        const t = pool.getPoolTelemetry();
        assert.equal(t.totalProcessed, 1, "foreign result must not be counted");
        assert.equal(t.workers[0].tasksCompleted, 1);
        assert.equal(t.workers[0].status, "IDLE");

        const warned = c.warn.mock.calls.some((call) =>
          String(call.arguments[0]).includes(`foreign-${payload.taskId}`)
        );
        assert.ok(warned, "a warning naming the foreign taskId must be logged");
      });
    } finally {
      c.restore();
    }
  });
});

describe("FaceWorkerPoolManager - fail-closed fallback", () => {
  it("denies recognition when the resolved worker entry is unusable", async () => {
    // Exercises the *default* createWorker (real resolution + real `new Worker`),
    // not an injected throwing stub: a broken FACE_WORKER_PATH must deny, never
    // fabricate a match. This is the door-unlock regression guard for the
    // module-resolution rewrite.
    const c = quietConsole();
    const previous = process.env.FACE_WORKER_PATH;
    process.env.FACE_WORKER_PATH = path.join(process.cwd(), "dist", "definitely-not-here.cjs");
    try {
      await withPool(1, {}, async (pool) => {
        const result = await pool.dispatchFaceTask(makePayload({ testEmployeeId: "EMP-0001" }));
        assert.equal(result.recognized, false);
        assert.equal(result.bestMatch, undefined);
        assert.deepEqual(result.detectedFaces, []);
        assert.match(result.engineUsed, /unavailable/);
      });
    } finally {
      if (previous === undefined) delete process.env.FACE_WORKER_PATH;
      else process.env.FACE_WORKER_PATH = previous;
      c.restore();
    }
  });

  it("denies recognition when no worker thread can be started", async () => {
    const c = quietConsole();
    try {
      await withPool(
        1,
        {
          createWorker: () => {
            throw new Error("no threads here");
          },
        },
        async (pool) => {
          const result = await pool.dispatchFaceTask(makePayload({ testEmployeeId: "EMP-0001" }));
          assert.equal(result.recognized, false);
          assert.equal(result.bestMatch, undefined);
          assert.deepEqual(result.detectedFaces, []);
          assert.equal(result.overallConfidence, 0);
          assert.match(result.engineUsed, /unavailable/);
          assert.equal(pool.getPoolTelemetry().totalProcessed, 1);
        }
      );
    } finally {
      c.restore();
    }
  });
});
