/**
 * Shared, pure pieces of the off-thread face extraction (Taiga #507):
 * message shapes, error codes, the engine-configuration fingerprint and the
 * ORT thread split. Imported by both faceExtractPool.ts (host, main thread)
 * and faceExtractWorker.ts (worker thread); no worker or engine is started here.
 *
 * WHAT extractFaces() DEPENDS ON (and how the worker gets the same values)
 * -------------------------------------------------------------------------
 * extractFaces(rgb) takes NO per-call options and NO per-gate state. Door-scan
 * observeFrame() calls it on the full frame: no gate area, no ROI and no
 * detector inputShape (those belong to the separate real-time pipeline). Every
 * knob is process state inside faceEmbedding.ts, read from process.env:
 *
 *   read lazily per call     FACE_MODEL_DIR, FACE_DETECTOR_MODEL / FACE_DETECTOR_VARIANT,
 *                            FACE_RECOGNIZER_MODEL (=> model tag), FACE_DETECT_THRESHOLD,
 *                            FACE_NMS_IOU, FACE_DETECT_SIZE, FACE_DETECT_UPSCALE,
 *                            FACE_TTA_FLIP, FFMPEG_PATH, FACE_FFMPEG_TIMEOUT_MS
 *   read once at engine load FACE_ORT_THREADS, FACE_ORT_LOG_LEVEL (and the model files above)
 *   read once at MODULE load CLEAR_FACE_LIMITS: FACE_MIN_SIZE_PX, FACE_CLEAR_MAX_YAW,
 *                            FACE_CLEAR_MIN_ASPECT, FACE_CLEAR_MAX_ASPECT, FACE_CLEAR_MAX_ROLL_DEG
 *
 * The host therefore spawns each worker with an explicit env snapshot: the
 * current process.env, CLEAR_FACE_LIMITS rewritten from the main thread's
 * already-parsed values (so a worker started later cannot read a different
 * floor than the main thread fixed at boot), and FACE_ORT_THREADS replaced by
 * the per-worker share. The worker reports extractFingerprint() once its
 * engine is loaded; the host compares it with its own fingerprint at ready
 * time AND before every task. Any difference fails closed (config_mismatch)
 * and the workers are recycled with the current env. FACE_ORT_THREADS is
 * deliberately not part of the fingerprint (it is meant to differ).
 */

import { CLEAR_FACE_LIMITS, EMBEDDING_DIM, getFaceEngineInfo, type ExtractedFace } from "./faceEmbedding";

/** Why an off-thread extraction did not produce a result. The caller decides any fallback. */
export type FaceExtractErrorCode =
  /** FACE_EXTRACT_WORKERS=0: the pool is off; run on the main thread. */
  | "disabled"
  /** No worker has a loaded, compatible engine right now (starting, crashed, models missing). */
  | "not_ready"
  /** Every worker busy and the queue is full. */
  | "overloaded"
  /** The task exceeded its budget (queued or running); a running worker is replaced. */
  | "timeout"
  /** The worker thread died while running the task; it is replaced. */
  | "worker_crashed"
  /** The engine in the worker logged an error during the task (detector/recogniser failure). */
  | "engine_error"
  /** The bytes are not a decodable JPEG/PNG (main thread: loadImage() -> null -> no faces). */
  | "decode_failed"
  /** Empty, oversized or wrongly typed input; nothing was sent to a worker. */
  | "invalid_input"
  /** The worker's engine configuration / model tag differs from the main thread's. */
  | "config_mismatch"
  /** The worker returned a malformed result (bad embedding, wrong tag); the worker is replaced. */
  | "incompatible_result"
  /** The pool was shut down. */
  | "shutdown";

export class FaceExtractError extends Error {
  readonly code: FaceExtractErrorCode;
  constructor(code: FaceExtractErrorCode, message: string) {
    super(`[faceExtract:${code}] ${message}`);
    this.name = "FaceExtractError";
    this.code = code;
  }
}

export function isFaceExtractError(err: unknown): err is FaceExtractError {
  return err instanceof FaceExtractError;
}

/**
 * The engine settings that change what extractFaces() returns, as one stable
 * string. Main thread and worker must produce the same string or the worker is
 * not used. Never triggers an engine load (getFaceEngineInfo reads env only).
 */
export function extractFingerprint(): string {
  const info = getFaceEngineInfo();
  const fp = {
    modelDir: info.modelDir,
    detectorModel: info.detectorModel,
    recognizerModel: info.recognizerModel,
    modelTag: info.modelTag,
    embeddingDim: info.embeddingDim,
    detectorInputSize: info.detectorInputSize,
    detectThreshold: info.detectThreshold,
    nmsIou: info.nmsIou,
    detectUpscale: info.detectUpscale,
    ttaFlip: info.ttaFlip,
    minFacePx: CLEAR_FACE_LIMITS.minFacePx,
    maxYaw: CLEAR_FACE_LIMITS.maxYaw,
    minAspect: CLEAR_FACE_LIMITS.minAspect,
    maxAspect: CLEAR_FACE_LIMITS.maxAspect,
    maxRollDeg: CLEAR_FACE_LIMITS.maxRollDeg,
  };
  return JSON.stringify(fp);
}

/** Model tag of the main thread's configured recogniser (never triggers a load). */
export function currentModelTag(): string {
  return getFaceEngineInfo().modelTag;
}

/**
 * The env a worker is spawned with: a snapshot of `env`, the main thread's
 * parsed CLEAR_FACE_LIMITS written back verbatim, and FACE_ORT_THREADS set to
 * the worker's share. Pure apart from reading CLEAR_FACE_LIMITS.
 */
export function extractWorkerEnv(ortThreads: number, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    FACE_ORT_THREADS: String(ortThreads),
    FACE_MIN_SIZE_PX: String(CLEAR_FACE_LIMITS.minFacePx),
    FACE_CLEAR_MAX_YAW: String(CLEAR_FACE_LIMITS.maxYaw),
    FACE_CLEAR_MIN_ASPECT: String(CLEAR_FACE_LIMITS.minAspect),
    FACE_CLEAR_MAX_ASPECT: String(CLEAR_FACE_LIMITS.maxAspect),
    FACE_CLEAR_MAX_ROLL_DEG: String(CLEAR_FACE_LIMITS.maxRollDeg),
  };
}

/**
 * Intra-op threads per worker so the pool's total stays at about the main
 * engine's FACE_ORT_THREADS budget (shared host, do not oversubscribe):
 * floor(total / workers), at least 1. An explicit per-worker value wins.
 */
export function splitOrtThreads(totalThreads: number, workers: number, perWorkerOverride?: number | null): number {
  if (perWorkerOverride !== undefined && perWorkerOverride !== null && Number.isInteger(perWorkerOverride) && perWorkerOverride >= 1) {
    return Math.min(16, perWorkerOverride);
  }
  const total = Number.isInteger(totalThreads) && totalThreads >= 1 ? totalThreads : 4;
  const n = Number.isInteger(workers) && workers >= 1 ? workers : 1;
  return Math.max(1, Math.floor(total / n));
}

/**
 * True for a console.error line written by faceEmbedding.ts. Inside the worker
 * every such line during a task means the engine hit an error that
 * extractFaces() swallowed into "no faces" / a dropped face; the worker turns
 * it into engine_error instead (fail closed). faceEmbedding's log() prefixes
 * every line with "[faceEmbedding] ".
 */
export function isEngineErrorLine(first: unknown): boolean {
  return typeof first === "string" && first.startsWith("[faceEmbedding] ");
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** ExtractedFace as it crosses the thread boundary (the embedding buffer is transferred). */
export type WireFace = ExtractedFace;

export interface ExtractRequest {
  type: "extract";
  id: number;
  /** Encoded JPEG/PNG bytes (an ArrayBuffer the worker owns) or a data URL / base64 string. */
  image: ArrayBuffer | string;
}

export interface WorkerReady {
  type: "ready";
  fingerprint: string;
  modelTag: string;
  detectorModel: string;
  recognizerModel: string;
  ortThreads: number;
  loadTimeMs: number | null;
}

export interface WorkerFatal {
  type: "fatal";
  error: string;
}

export interface ExtractOk {
  type: "result";
  id: number;
  ok: true;
  width: number;
  height: number;
  modelTag: string;
  faces: WireFace[];
  /** Worker-side wall time for decode + detect + embed. */
  ms: number;
}

export interface ExtractFailed {
  type: "result";
  id: number;
  ok: false;
  code: Extract<FaceExtractErrorCode, "engine_error" | "decode_failed" | "invalid_input" | "not_ready">;
  error: string;
  ms: number;
}

export type HostToWorker = ExtractRequest;
export type WorkerToHost = WorkerReady | WorkerFatal | ExtractOk | ExtractFailed;

/** Max encoded frame accepted (a 4K JPEG is ~1.5-3 MB). */
export const MAX_EXTRACT_IMAGE_BYTES = 32 * 1024 * 1024;

/**
 * Structural check of one face from a worker. Returns null when valid, else
 * the reason. Never echoes values (no embedding contents in errors or logs).
 */
export function wireFaceIssue(f: unknown): string | null {
  if (!f || typeof f !== "object") return "face is not an object";
  const face = f as Partial<ExtractedFace>;
  const e = face.embedding;
  if (!(e instanceof Float32Array)) return "embedding is not a Float32Array";
  if (e.length !== EMBEDDING_DIM) return `embedding length ${e.length} != ${EMBEDDING_DIM}`;
  let sq = 0;
  for (let i = 0; i < e.length; i++) {
    const v = e[i];
    if (!Number.isFinite(v)) return "embedding has a non-finite value";
    sq += v * v;
  }
  if (Math.abs(Math.sqrt(sq) - 1) > 1e-3) return "embedding is not unit length";
  const box = face.box;
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) return "bad box";
  if (!Number.isFinite(face.score)) return "bad score";
  if (!Array.isArray(face.landmarks) || face.landmarks.length !== 5) return "bad landmarks";
  for (const k of ["quality", "sharpness", "edgeEnergy", "boxSize"] as const) {
    if (!Number.isFinite(face[k])) return `bad ${k}`;
  }
  if (typeof face.clear !== "boolean") return "bad clear flag";
  return null;
}
