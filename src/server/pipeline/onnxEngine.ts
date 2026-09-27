/**
 * The real SCRFD/ArcFace engine as the pipeline worker uses it. Same model
 * files, variant and thread settings as the main engine, because both read the
 * same environment (FACE_MODEL_DIR, FACE_DETECTOR_VARIANT / FACE_DETECTOR_MODEL,
 * FACE_RECOGNIZER_MODEL, FACE_ORT_THREADS, FACE_DETECT_*, FACE_MIN_SIZE_PX,
 * FACE_CLEAR_*). The one pipeline-only setting is the detector INPUT GEOMETRY,
 * PIPELINE_DETECT_INPUT (detectInput.ts): how the gate area is presented to
 * SCRFD. It changes neither the pixels nor the 60 px source-pixel size floor,
 * and the legacy engine never sees it.
 *
 * Fail closed: an unparseable PIPELINE_DETECT_INPUT, or a plan the loaded
 * detector graph cannot run (e.g. `auto` on the static 640x640 INT8 export),
 * makes `ready()` false with the reason in `error()`; the worker then refuses
 * every frame and the host shows the reason in the pipeline stats.
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
import { describeDetectInput, detectPlanIssue, detectWithPlan, parseDetectInput, type DetectInputPlan } from "./detectInput";

const parsed = parseDetectInput(process.env.PIPELINE_DETECT_INPUT);
const plan: DetectInputPlan = parsed.plan;
let lastInput = "";
let lastIssue: string | null = null;

/** The engine is usable only when it loaded AND it can run the configured plan. */
function planIssue(): string | null {
  if (parsed.error) return parsed.error;
  const info = getFaceEngineInfo();
  if (!info.ready) return null; // load errors are reported by the engine itself
  return detectPlanIssue(plan, info.detectorInputDims, info.detectorInputSize, info.detectorModel);
}

export const onnxPipelineEngine: PipelineEngine = {
  ready: () => isFaceEngineReady() && planIssue() === null,
  // Same tag as server.ts faceModelTag(): arcface_<recogniser file without .onnx>.
  modelTag: () => getFaceEngineInfo().modelTag,
  detect: async (img) => {
    const info = getFaceEngineInfo();
    const r = await detectWithPlan(detectFaces, img, plan, { squareSize: info.detectorInputSize, nmsIou: info.nmsIou });
    if (r.info.input !== lastInput) {
      lastInput = r.info.input;
      console.log(`[pipeline worker] detector input ${r.info.plan}: ${img.width}x${img.height} frame -> ${r.info.input}, ${r.info.runs} run(s)/frame`);
    }
    return r.faces;
  },
  detectInput: () => (lastInput ? `${describeDetectInput(plan)} -> ${lastInput}` : describeDetectInput(plan)),
  align: (img, landmarks) => alignFace(img, landmarks),
  embed: (aligned) => embedFace(aligned),
  quality: (aligned, sizePx) => faceQuality(aligned, sizePx).quality,
  clearIssue: (landmarks, sizePx) => clearFaceIssue(facePose(landmarks), CLEAR_FACE_LIMITS, sizePx),
  error: () => {
    const issue = planIssue();
    if (issue !== lastIssue) {
      lastIssue = issue;
      if (issue) console.error(`[pipeline worker] FAIL-CLOSED detector input: ${issue}`);
    }
    return issue || getFaceEngineInfo().lastError;
  },
};

/** Loads the engine; resolves true when it is ready for the configured plan. Never rejects. */
export async function loadOnnxPipelineEngine(): Promise<boolean> {
  try {
    if ((await getFaceEngine()) === null) return false;
    return onnxPipelineEngine.ready();
  } catch {
    return false;
  }
}
