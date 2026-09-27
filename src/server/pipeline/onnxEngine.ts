/**
 * The real SCRFD/ArcFace engine as the pipeline worker uses it. Same model
 * files, variant and thread settings as the main engine, because both read the
 * same environment (FACE_MODEL_DIR, FACE_DETECTOR_VARIANT / FACE_DETECTOR_MODEL,
 * FACE_RECOGNIZER_MODEL, FACE_ORT_THREADS, FACE_DETECT_*, FACE_MIN_SIZE_PX,
 * FACE_CLEAR_*): this module adds no settings of its own.
 *
 * Runs inside the pipeline worker thread only; each worker loads its own ONNX
 * sessions (~0.3-0.4 GB resident per worker with the FP32 recogniser).
 */
import {
  CLEAR_FACE_LIMITS,
  alignFace,
  clearFaceIssue,
  detectFaces,
  embedFace,
  facePose,
  faceQuality,
  getFaceEngine,
  getFaceEngineInfo,
  isFaceEngineReady,
} from "../faceEmbedding";
import type { PipelineEngine } from "./pipelineCore";

export const onnxPipelineEngine: PipelineEngine = {
  ready: () => isFaceEngineReady(),
  // Same tag as server.ts faceModelTag(): arcface_<recogniser file without .onnx>.
  modelTag: () => getFaceEngineInfo().modelTag,
  detect: (img) => detectFaces(img),
  align: (img, landmarks) => alignFace(img, landmarks),
  embed: (aligned) => embedFace(aligned),
  quality: (aligned, sizePx) => faceQuality(aligned, sizePx).quality,
  clearIssue: (landmarks, sizePx) => clearFaceIssue(facePose(landmarks), CLEAR_FACE_LIMITS, sizePx),
  error: () => getFaceEngineInfo().lastError,
};

/** Loads the engine; resolves true when it is ready. Never rejects. */
export async function loadOnnxPipelineEngine(): Promise<boolean> {
  try {
    return (await getFaceEngine()) !== null;
  } catch {
    return false;
  }
}
