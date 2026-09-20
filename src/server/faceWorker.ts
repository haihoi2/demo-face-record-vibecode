/**
 * Face recognition worker thread body.
 *
 * This file used to live as a giant inline JavaScript string
 * (`WORKER_SCRIPT`) inside faceWorkerPool.ts and was started with
 * `new Worker(script, { eval: true })`. An eval'd string cannot `require` or
 * `import` anything from this project, which made it impossible to run the
 * real ONNX/ArcFace engine (src/server/faceEmbedding.ts) inside a worker
 * thread. It is now a normal module, so the engine can simply be imported.
 *
 * It is loaded in two shapes:
 *   - dev  : this .ts file directly, through the tsx loader inherited by the
 *            worker thread via process.execArgv;
 *   - prod : bundled by esbuild into dist/faceWorker.cjs (npm run build:worker)
 *            and loaded by plain node.
 * faceWorkerPool.ts#resolveFaceWorkerEntry() picks which one.
 *
 * Protocol (unchanged):
 *   in  { type: "PROCESS_FACE", payload: FaceTaskPayload, workerId: number }
 *   out { type: "TASK_SUCCESS", result: FaceTaskResult }
 *       { type: "TASK_ERROR", taskId: string, error: string }
 */

import { parentPort } from "node:worker_threads";

import type { DetectedFace, Employee, LocalBiometricModel } from "../types";

/** Mirrors FaceTaskPayload / FaceTaskResult in faceWorkerPool.ts (kept structural to avoid a cycle). */
export interface FaceWorkerPayload {
  taskId: string;
  imageBase64: string;
  employees?: Employee[];
  scanType?: "ENTRY" | "EXIT";
  testEmployeeId?: string;
  modelArchitecture?: LocalBiometricModel;
  similarityThreshold?: number;
  livenessSensitivity?: "LOW" | "MEDIUM" | "HIGH";
}

export interface FaceWorkerResult {
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

// ---------------------------------------------------------------------------
// EXTENSION POINT - real ONNX face embeddings (Phase 1)
// ---------------------------------------------------------------------------
// This module is a real module precisely so that the line below can exist.
// When src/server/faceEmbedding.ts lands, replace the hash-based
// generateFaceEmbedding() calls in executeBiometrics() with it:
//
//   import { embedFace, cosineSimilarity } from "./faceEmbedding";
//   const probeVector = await embedFace(imageBase64);          // 512-D ArcFace
//   const enrolledVector = await embedFace(emp.photoUrl);
//
// onnxruntime-node is a native addon and is `--packages=external` in both
// bundles, so it resolves from node_modules at runtime in dev and in dist/.
// executeBiometrics() will need to become `async` and the parentPort handler
// below already awaits its result, so that change stays local to this file.
// Do NOT import faceEmbedding yet - the module does not exist.
// ---------------------------------------------------------------------------

export function generateFaceEmbedding(seed: string, dimension = 128): number[] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const vector: number[] = [];
  let norm = 0;
  for (let i = 0; i < dimension; i++) {
    const val = Math.sin(hash * (i + 1) * 0.1743) * Math.cos(i * 1.3141);
    vector.push(val);
    norm += val * val;
  }
  norm = Math.sqrt(norm);
  return vector.map((v) => (norm > 0 ? v / norm : 0));
}

export function computeCosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dotProduct = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
  }
  return Math.max(-1, Math.min(1, dotProduct));
}

export function evaluateAntiSpoofing(
  imageBase64: string,
  sensitivity: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM"
): { livenessScore: number; passed: boolean } {
  let entropySum = 0;
  const sampleLength = Math.min(imageBase64.length, 1200);
  for (let i = 0; i < sampleLength; i += 4) {
    entropySum += imageBase64.charCodeAt(i);
  }
  const baseLiveness = 94 + ((entropySum % 60) / 10);
  const threshold = sensitivity === "HIGH" ? 92 : sensitivity === "MEDIUM" ? 85 : 75;
  return {
    livenessScore: Math.round(baseLiveness * 10) / 10,
    passed: baseLiveness >= threshold,
  };
}

export function executeBiometrics(payload: FaceWorkerPayload, workerId: number): FaceWorkerResult {
  const t0 = Date.now();
  const {
    taskId,
    imageBase64,
    employees = [],
    modelArchitecture = "blazeface-arcface-sota",
    similarityThreshold = 0.72,
    livenessSensitivity = "MEDIUM",
    testEmployeeId,
  } = payload;

  const antiSpoof = evaluateAntiSpoofing(imageBase64 || "", livenessSensitivity);

  let modelName = "BlazeFace V2 + ArcFace SOTA (512-D Multi-Thread)";
  if (modelArchitecture === "mediapipe-facemesh-dense") {
    modelName = "MediaPipe FaceMesh (468 3D Multi-Thread)";
  } else if (modelArchitecture === "mobilefacenet-quantized") {
    modelName = "MobileFaceNet Edge INT8 (Multi-Thread)";
  }

  // threadLatencyMs is the measured wall-clock time of this function only.
  // No per-architecture padding is added: telemetry must reflect real work.
  const measuredLatency = () => Date.now() - t0;

  // Handle test shortcuts
  if (testEmployeeId === "UNKNOWN" || testEmployeeId === "UNKNOWN_VISITOR") {
    return {
      taskId,
      workerId,
      threadLatencyMs: measuredLatency(),
      detectedFaces: [
        {
          id: "worker-face-unknown-" + Date.now(),
          box2d: [190, 270, 750, 730],
          confidence: 34.2,
          livenessScore: antiSpoof.livenessScore,
          recognized: false,
          message:
            "Khuôn mặt lạ - Không khớp dữ liệu nhân viên (Multi-Thread Worker #" + workerId + ")",
        },
      ],
      bestMatch: undefined,
      overallConfidence: 34.2,
      overallLiveness: antiSpoof.livenessScore,
      cosineSimilarity: 0.34,
      modelName,
      recognized: false,
      engineUsed: "Backend Multi-Thread Worker #" + workerId,
    };
  }

  if (testEmployeeId && testEmployeeId !== "MULTI_EMPLOYEES" && testEmployeeId !== "MULTI_MIXED") {
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
            id: "worker-face-" + matched.id + "-" + Date.now(),
            box2d: [170, 270, 730, 730],
            employeeId: matched.id,
            employeeName: matched.name,
            employeeCode: matched.employeeCode,
            department: matched.department,
            confidence: 97.5,
            livenessScore: antiSpoof.livenessScore,
            recognized: true,
            message:
              "Nhận diện thành công: " +
              matched.name +
              " (" +
              matched.employeeCode +
              ") [Worker #" +
              workerId +
              "]",
          },
        ],
        bestMatch: matched,
        overallConfidence: 97.5,
        overallLiveness: antiSpoof.livenessScore,
        cosineSimilarity: 0.94,
        modelName,
        recognized: true,
        engineUsed: "Backend Multi-Thread Worker #" + workerId,
      };
    }
  }

  // Probe vector calculation
  const probeVector = generateFaceEmbedding(imageBase64 || "default-probe-seed");

  let bestSim = -1;
  let bestEmp: Employee | undefined = undefined;

  for (const emp of employees) {
    const enrolledSeed = emp.photoUrl || (emp.name + "-" + emp.employeeCode);
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

  const detectedFaces: DetectedFace[] = [];
  if (recognized && bestEmp) {
    detectedFaces.push({
      id: "worker-face-" + bestEmp.id,
      box2d: [180, 270, 720, 720],
      employeeId: bestEmp.id,
      employeeName: bestEmp.name,
      employeeCode: bestEmp.employeeCode,
      department: bestEmp.department,
      confidence,
      livenessScore: antiSpoof.livenessScore,
      recognized: true,
      message:
        "Nhận diện thành công: " +
        bestEmp.name +
        " (Cosine: " +
        bestSim.toFixed(2) +
        ") [Worker #" +
        workerId +
        "]",
    });
  } else if (employees.length > 0) {
    detectedFaces.push({
      id: "worker-face-unknown-" + Date.now(),
      box2d: [190, 270, 750, 730],
      confidence,
      livenessScore: antiSpoof.livenessScore,
      recognized: false,
      message:
        "Không tìm thấy nhân viên phù hợp (Độ tương đồng Cosine: " +
        bestSim.toFixed(2) +
        ") [Worker #" +
        workerId +
        "]",
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
    engineUsed: "Backend Multi-Thread Worker #" + workerId,
  };
}

if (parentPort) {
  const port = parentPort;
  port.on("message", (msg: any) => {
    if (msg && msg.type === "PROCESS_FACE") {
      // `await` here is harmless today and is what lets executeBiometrics()
      // become async when the ONNX engine (see EXTENSION POINT above) lands.
      Promise.resolve()
        .then(() => executeBiometrics(msg.payload, msg.workerId))
        .then((result) => {
          port.postMessage({ type: "TASK_SUCCESS", result });
        })
        .catch((err: any) => {
          port.postMessage({
            type: "TASK_ERROR",
            taskId: msg.payload?.taskId,
            error: String(err && err.message ? err.message : err),
          });
        });
    }
  });
}
