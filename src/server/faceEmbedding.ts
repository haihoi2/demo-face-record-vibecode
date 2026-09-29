/**
 * Real face detection + embedding engine (Phase 1).
 *
 * Replaces the placeholder string-hash "matcher" with genuine CV:
 *   - detection    SCRFD  (InsightFace buffalo_l `det_10g.onnx`, 640x640)
 *   - recognition  ArcFace r50 (`w600k_r50.onnx`, 112x112 -> 512-D)
 *
 * Design constraints deliberately honoured here:
 *   - No Express, no DB, no app state. Pure functions + one lazy engine.
 *   - No native image libraries (`sharp` / `canvas` / `tfjs`). JPEG/PNG decoding
 *     goes through the static `ffmpeg` binary that already ships in the image,
 *     piped stdin -> stdout, every spawn bounded by a timeout.
 *   - Sessions are created ONCE per process behind a module-level promise.
 *   - Nothing here throws on a bad frame: callers get `[]` (or `null`) and a log
 *     line, because this sits on the hot path of a live camera gateway.
 *
 * All model I/O follows InsightFace's own pre/post-processing so the numbers are
 * comparable with upstream:
 *   detector    RGB, (px - 127.5) / 128.0, NCHW, aspect-preserving letterbox
 *               padded bottom/right (NOT centred).
 *   recogniser  RGB, (px - 127.5) / 127.5, NCHW; raw output is NOT normalised,
 *               so `embedFace()` L2-normalises before returning.
 */

import { envNumber } from "./env";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { InferenceSession, Tensor } from "onnxruntime-node";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw 8-bit RGB image, row-major, 3 bytes per pixel. */
export interface RgbImage {
  width: number;
  height: number;
  /** length === width * height * 3 */
  data: Uint8Array;
}

/** Anything the engine can take as a picture. */
export type ImageInput = Buffer | Uint8Array | string | RgbImage;

export interface FaceBox {
  /** [x1, y1, x2, y2] in ORIGINAL image pixel coordinates. */
  box: [number, number, number, number];
  /** Detector confidence, 0..1. */
  score: number;
  /** 5 points: left eye, right eye, nose, left mouth, right mouth. */
  landmarks: Array<[number, number]>;
}

/** Height/width the loaded detector graph accepts; "dynamic" = any multiple of 32. */
export interface DetectorInputDims {
  height: number | "dynamic";
  width: number | "dynamic";
}

/**
 * Optional detector input shape (ADDITIVE, 2026-09-27). Without it the
 * detector runs exactly as before: a FACE_DETECT_SIZE square letterbox. The
 * real-time pipeline passes a shape that follows its gate area's aspect
 * (src/server/pipeline/detectInput.ts) so a wide strip is not shrunk ~5x into
 * a square. Both sides must be multiples of 32 (the coarsest SCRFD stride).
 * The legacy watcher / scan / recognize-face paths never pass this.
 */
export interface DetectOptions {
  inputShape?: { width: number; height: number };
}

export interface ExtractedFace extends FaceBox {
  /** 512-D, L2-normalised (‖v‖ === 1). */
  embedding: Float32Array;
  /** 0..1 capture-quality gate: blends sharpness and face size. */
  quality: number;
  /**
   * Edge energy of the central face area relative to its contrast (faceEdgeEnergy).
   * Heavy blur flattens it; used only by storage floors, never by decisions.
   */
  edgeEnergy: number;
  /** Variance of the Laplacian over the aligned 112x112 crop (higher = sharper). */
  sharpness: number;
  /** Shorter side of the detected box, in original-image pixels. */
  boxSize: number;
  /** Head pose estimated from the five landmarks; null when they are degenerate. */
  pose: FacePose | null;
  /** Whether the face is frontal enough to recognise or keep. See clearFaceIssue(). */
  clear: boolean;
  /** Why the face is not clear, when it is not. */
  unclearReason?: UnclearReason;
}

/**
 * Head pose from SCRFD's five landmarks (left eye, right eye, nose, left and
 * right mouth corner), after rotating the eye line level:
 *  - yaw:    nose offset from the eye midpoint, in eye-spacings. ~0 when the
 *            face points at the camera; grows as the head turns away.
 *  - aspect: eye-to-mouth height over eye spacing. ~1 for a frontal face;
 *            very large when the eyes collapse together (head turned or bowed).
 *  - rollDeg: tilt of the eye line.
 */
export interface FacePose {
  yaw: number;
  aspect: number;
  rollDeg: number;
}

export type UnclearReason = "small" | "landmarks" | "yaw" | "aspect" | "roll";

export interface FaceEngineInfo {
  ready: boolean;
  loading: boolean;
  modelDir: string;
  detectorModel: string;
  recognizerModel: string;
  /** fp32 | int8 | custom (an explicit FACE_DETECTOR_MODEL file). */
  detectorVariant: FaceModelVariant | "custom";
  /** fp32 | custom (an explicit FACE_RECOGNIZER_MODEL file). */
  recognizerVariant: FaceModelVariant | "custom";
  /** Template/embedding compatibility tag of the recogniser (faceModelTagFor). */
  modelTag: string;
  /** Set when a variant setting was unknown or unsupported and not applied as written. */
  variantWarning: string | null;
  /** How pictures smaller than the detector input are letterboxed (FACE_DETECT_UPSCALE). */
  detectUpscale: DetectUpscaleMode;
  /** Horizontal-flip test-time augmentation of the recogniser (FACE_TTA_FLIP=1); default off. */
  ttaFlip: boolean;
  detectorInputSize: number;
  /**
   * Spatial input dims of the LOADED detector graph: a number where the ONNX
   * graph fixes the axis (the static INT8 export is 640x640), "dynamic" where
   * it is symbolic (FP32 det_10g takes any multiple of 32 per axis). null before
   * the engine is loaded or when the runtime exposes no input metadata.
   */
  detectorInputDims: DetectorInputDims | null;
  embeddingDim: number;
  detectThreshold: number;
  nmsIou: number;
  /** Milliseconds spent in InferenceSession.create() for both models. */
  loadTimeMs: number | null;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Configuration (all env-overridable, all read lazily so tests can set them)
// ---------------------------------------------------------------------------

const DEFAULT_MODEL_DIR = "/app/models";

/**
 * Detector variants. `fp32` is InsightFace buffalo_l's det_10g as shipped;
 * `int8` is the ONNX Runtime static QDQ quantization made by
 * scripts/perf/quantize.py (U8S8 for the VNNI path, per-channel weights, MinMax
 * calibration on real gate captures, the 9 output heads kept FP32). On 130
 * held-out captures it finds 109/110 faces >= 60 px, box IoU median 0.98, and
 * moves embeddings (through its landmarks) by a median cosine of 0.011
 * (scripts/perf/int8-eval.ts), at about 1/3 of the FP32 latency.
 *
 * Selection: FACE_DETECTOR_VARIANT=fp32|int8 (blank/unknown = fp32); an
 * explicit FACE_DETECTOR_MODEL file name wins. A selected file that is missing
 * or corrupt fails the engine load (fail closed) - never a silent fallback.
 *
 * The RECOGNISER has no INT8 variant on purpose: the best ArcFace INT8 measured
 * (2026-09-26) drifted a median cosine of 0.021 from FP32 (p95 0.077), over the
 * 0.02 bar. FACE_MODEL_VARIANT / FACE_RECOGNIZER_VARIANT are therefore ignored
 * (and reported in variantWarning). Should an INT8 recogniser be loaded through
 * an explicit FACE_RECOGNIZER_MODEL, the template tag follows the file name
 * (faceModelTagFor), so its embeddings never silently mix with FP32 templates.
 */
export type FaceModelVariant = "fp32" | "int8";
export const FACE_MODEL_VARIANTS: readonly FaceModelVariant[] = ["fp32", "int8"];
export const FACE_DETECTOR_FILES: Readonly<Record<FaceModelVariant, string>> = {
  fp32: "det_10g.onnx",
  int8: "det_10g_int8.onnx",
};
export const FACE_RECOGNIZER_FILE = "w600k_r50.onnx";
/** Env names that would select an INT8 recogniser; recognised only to warn. */
const UNSUPPORTED_VARIANT_ENVS = ["FACE_MODEL_VARIANT", "FACE_RECOGNIZER_VARIANT"] as const;

/** Blank/undefined -> fp32; case- and whitespace-insensitive; anything else -> fp32 with `invalid` set. */
export function parseFaceModelVariant(raw: string | undefined | null): { variant: FaceModelVariant; invalid?: string } {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "") return { variant: "fp32" };
  if ((FACE_MODEL_VARIANTS as readonly string[]).includes(v)) return { variant: v as FaceModelVariant };
  return { variant: "fp32", invalid: String(raw).slice(0, 32) };
}

/**
 * Identity stamped on templates and embeddings: `arcface_<recogniser file
 * without .onnx>`. Must stay byte-identical to server.ts faceModelTag() for
 * FP32 (`arcface_w600k_r50`) so existing templates remain usable.
 */
export function faceModelTagFor(recognizerFile: string): string {
  const base = String(recognizerFile || "unknown").replace(/\.onnx$/i, "");
  return `arcface_${base}`;
}

/**
 * Recogniser selection for the REAL-TIME PIPELINE workers only (structure rule,
 * plan section 8a): the legacy watcher/scan/door engine keeps
 * FACE_RECOGNIZER_MODEL / w600k_r50 and its templates untouched; the pipeline
 * may run a cheaper recogniser under its OWN template tag.
 *
 *   PIPELINE_RECOGNIZER_MODEL    explicit file name inside FACE_MODEL_DIR (wins)
 *   PIPELINE_RECOGNIZER_VARIANT  r50 | r50_int8 | mbf (blank = inherit the legacy recogniser)
 *
 * Both unset -> the worker inherits FACE_RECOGNIZER_MODEL exactly as before
 * (source "default"). The template tag ALWAYS follows the chosen file
 * (faceModelTagFor), so mbf embeddings are tagged arcface_w600k_mbf and can
 * never be scored against arcface_w600k_r50 templates: buildGallery drops
 * foreign tags and the worker refuses a context whose tag differs from its
 * engine's (fail closed). A selected file that is missing or corrupt fails the
 * worker's engine load; there is no fallback to another model. An unknown
 * variant or an unsafe file name is ignored with a warning (like
 * FACE_DETECTOR_VARIANT), so a typo cannot pick a model by accident.
 *
 * Calibrated 2026-09-27 on this site's captures (scripts/perf/calib-eval.ts,
 * docs/agent-handoffs/2026-09-27-rt-calib.md); the per-model operating points
 * live in faceFusion.ts PIPELINE_FUSION_THRESHOLDS_BY_TAG.
 */
export type PipelineRecognizerVariant = "r50" | "r50_int8" | "mbf";
export const PIPELINE_RECOGNIZER_VARIANTS: readonly PipelineRecognizerVariant[] = ["r50", "r50_int8", "mbf"];
export const PIPELINE_RECOGNIZER_FILES: Readonly<Record<PipelineRecognizerVariant, string>> = {
  /** The legacy FP32 ResNet-50 (buffalo_l), tag arcface_w600k_r50. */
  r50: FACE_RECOGNIZER_FILE,
  /**
   * Static INT8 (QDQ U8S8, per-channel, percentile 99.99 on 231 real gate crops, stem and
   * embedding head FP32; scripts/perf/quantize-rec.py), tag arcface_w600k_r50_int8. Drift vs
   * FP32 median 0.010 / p95 0.027 cosine, TAR@FAR=1e-3 within 1.4 points of FP32 on this site,
   * 4.3x faster (157 ms vs 679 ms per face at 1 thread). The cheapest model that met the bar.
   */
  r50_int8: "w600k_r50_int8.onnx",
  /**
   * InsightFace buffalo_s/sc MobileFaceNet (w600k_mbf.onnx, 13.6 MB), tag arcface_w600k_mbf.
   * 15x faster than r50 but 7-8 TAR points below it at FAR 0 and 1e-3 on this site: NOT good
   * enough as the sole decision model here; selectable for shadow measurement only.
   */
  mbf: "w600k_mbf.onnx",
};
/** A bare .onnx file name: no path separators, no traversal, nothing hidden. */
const SAFE_MODEL_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.onnx$/i;

export interface PipelineRecognizerSelection {
  /** File name inside FACE_MODEL_DIR the pipeline workers load. */
  file: string;
  /** Template/embedding tag of that file (faceModelTagFor). */
  modelTag: string;
  /** Known variant of the file, or "custom" for any other explicit file. */
  variant: PipelineRecognizerVariant | "custom";
  /** Which setting decided: none (inherit the legacy recogniser), the explicit file, or the variant. */
  source: "default" | "PIPELINE_RECOGNIZER_MODEL" | "PIPELINE_RECOGNIZER_VARIANT";
  /** Set when a PIPELINE_RECOGNIZER_* value was not applied as written. */
  warning: string | null;
}

/** Variant of a recogniser file name, "custom" when it is none of the known files. */
export function pipelineRecognizerVariantOf(file: string): PipelineRecognizerVariant | "custom" {
  for (const v of PIPELINE_RECOGNIZER_VARIANTS) if (PIPELINE_RECOGNIZER_FILES[v] === file) return v;
  return "custom";
}

/** Pure: decides the pipeline workers' recogniser from an environment (defaults to process.env). */
export function resolvePipelineRecognizer(env: NodeJS.ProcessEnv = process.env): PipelineRecognizerSelection {
  const legacyFile = String(env.FACE_RECOGNIZER_MODEL || "").trim() || FACE_RECOGNIZER_FILE;
  const done = (file: string, source: PipelineRecognizerSelection["source"], warning: string | null): PipelineRecognizerSelection => ({
    file,
    modelTag: faceModelTagFor(file),
    variant: pipelineRecognizerVariantOf(file),
    source,
    warning,
  });
  const explicit = String(env.PIPELINE_RECOGNIZER_MODEL ?? "").trim();
  if (explicit !== "") {
    if (SAFE_MODEL_FILE.test(explicit) && !explicit.includes("..")) return done(explicit, "PIPELINE_RECOGNIZER_MODEL", null);
    return done(legacyFile, "default", `PIPELINE_RECOGNIZER_MODEL: not a plain .onnx file name, using ${legacyFile}`);
  }
  const variant = String(env.PIPELINE_RECOGNIZER_VARIANT ?? "").trim().toLowerCase();
  if (variant === "") return done(legacyFile, "default", null);
  if ((PIPELINE_RECOGNIZER_VARIANTS as readonly string[]).includes(variant)) {
    return done(PIPELINE_RECOGNIZER_FILES[variant as PipelineRecognizerVariant], "PIPELINE_RECOGNIZER_VARIANT", null);
  }
  return done(
    legacyFile,
    "default",
    `PIPELINE_RECOGNIZER_VARIANT: unknown value "${variant.slice(0, 32)}" (known: ${PIPELINE_RECOGNIZER_VARIANTS.join(", ")}), using ${legacyFile}`,
  );
}

/** ArcFace canonical 5-point template for a 112x112 crop. */
export const ARCFACE_TEMPLATE: ReadonlyArray<readonly [number, number]> = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

export const EMBEDDING_DIM = 512;
const ALIGNED_SIZE = 112;
/** SCRFD det_10g is an fmc=3 model: strides 8 / 16 / 32, 2 anchors per cell. */
const FEAT_STRIDES = [8, 16, 32] as const;
const NUM_ANCHORS = 2;

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function envNumberOrDefault(name: string, fallback: number): number {
  return envNumber(name, fallback);
}

function modelDir(): string {
  return env("FACE_MODEL_DIR", DEFAULT_MODEL_DIR);
}
function detectorModelName(): string {
  return env("FACE_DETECTOR_MODEL", FACE_DETECTOR_FILES[parseFaceModelVariant(process.env.FACE_DETECTOR_VARIANT).variant]);
}
function recognizerModelName(): string {
  return env("FACE_RECOGNIZER_MODEL", FACE_RECOGNIZER_FILE);
}
/** Variant of a loaded model file: fp32/int8 for the known files, "custom" for an explicit other file. */
function detectorVariantOf(file: string): FaceModelVariant | "custom" {
  for (const v of FACE_MODEL_VARIANTS) if (FACE_DETECTOR_FILES[v] === file) return v;
  return "custom";
}
function recognizerVariantOf(file: string): FaceModelVariant | "custom" {
  return file === FACE_RECOGNIZER_FILE ? "fp32" : "custom";
}
/** Operator-facing notes about variant settings that were not applied as written. */
function variantWarnings(): string[] {
  const out: string[] = [];
  const det = parseFaceModelVariant(process.env.FACE_DETECTOR_VARIANT);
  if (det.invalid !== undefined) out.push("FACE_DETECTOR_VARIANT: unknown value, using fp32");
  for (const name of UNSUPPORTED_VARIANT_ENVS) {
    const v = (process.env[name] || "").trim().toLowerCase();
    if (v && v !== "fp32") out.push(`${name}: ignored, the recogniser runs fp32 only (INT8 failed the drift bar)`);
  }
  return out;
}
function detectThreshold(): number {
  return envNumberOrDefault("FACE_DETECT_THRESHOLD", 0.5);
}
function nmsIouThreshold(): number {
  return envNumberOrDefault("FACE_NMS_IOU", 0.4);
}
function detectorInputSize(): number {
  return envNumberOrDefault("FACE_DETECT_SIZE", 640);
}
/**
 * ONNX Runtime session log severity (0 verbose .. 4 fatal). Default 2 = ORT's
 * own default (warnings). The pipeline worker sets 3 when it runs the FP32
 * detector at a non-640 shape: det_10g's output metadata is baked for 640x640,
 * so ORT would otherwise print nine "Expected shape ... does not match" warnings
 * per frame. Logging only; inference is unaffected.
 */
function ortLogSeverity(): number {
  return envNumber("FACE_ORT_LOG_LEVEL", 2, { min: 0, max: 4, integer: true });
}

/**
 * How the detector letterbox treats a picture SMALLER than its input size on
 * both axes (a stored 224-448 px face crop, a tiny upload). Larger pictures -
 * every camera frame, browser capture and stored full frame - are always
 * area-downscaled and are not affected.
 *   none      (default) keep native pixels, pad bottom/right, no upscale;
 *   area      legacy: stretch with resizeArea, which degenerates to a blocky
 *             nearest-neighbour enlargement;
 *   bilinear  stretch with bilinear interpolation (what InsightFace does).
 * Measured 2026-09-26 on 199 real gate faces cropped 2.5x/288 px
 * (scripts/perf/crop-eval.ts): the face is found again in 93% of crops with
 * `none`, 86% with `bilinear`, 84% with `area`. Set FACE_DETECT_UPSCALE=area
 * to restore the old behaviour.
 */
export type DetectUpscaleMode = "area" | "none" | "bilinear";
export const DEFAULT_DETECT_UPSCALE: DetectUpscaleMode = "none";
export function detectUpscaleMode(): DetectUpscaleMode {
  const v = (process.env.FACE_DETECT_UPSCALE || "").trim().toLowerCase();
  return v === "none" || v === "bilinear" || v === "area" ? v : DEFAULT_DETECT_UPSCALE;
}
/**
 * Horizontal-flip test-time augmentation for the recogniser (plan D2,
 * ADDITIVE 2026-09-29). Off unless FACE_TTA_FLIP is exactly "1" or "true"
 * (case/whitespace-insensitive); any other value is off, so a typo cannot
 * enable it. When on, embedFace() embeds the crop and its mirror image and
 * returns l2(embed(x) + embed(flip(x))) - two recogniser runs per face
 * (measured 2.0x the single-run latency on r50 and r50_int8; a batch of two
 * saves nothing on the CPU EP and the INT8 graph has a static batch of 1).
 * The embedding space and the template tag are unchanged (same model), but the
 * calibrated thresholds were measured WITHOUT flip: keep it off until
 * scripts/perf/calib-eval.ts --flip has been run on the site's crop set and
 * the operating point re-checked. Read per call so tests can toggle it.
 */
export function ttaFlipEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(environment.FACE_TTA_FLIP ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function ffmpegPath(): string {
  return env("FFMPEG_PATH", "ffmpeg");
}
function ffmpegTimeoutMs(): number {
  return envNumberOrDefault("FACE_FFMPEG_TIMEOUT_MS", 10_000);
}

function log(level: "warn" | "error" | "info", msg: string, err?: unknown): void {
  const suffix = err instanceof Error ? ` :: ${err.message}` : err ? ` :: ${String(err)}` : "";
  const line = `[faceEmbedding] ${msg}${suffix}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// Pure maths helpers (unit-testable with no models present)
// ---------------------------------------------------------------------------

/**
 * Cosine similarity, clamped to [-1, 1]. Returns 0 for mismatched lengths or a
 * zero-magnitude vector rather than NaN — callers compare against thresholds and
 * a NaN would silently pass `>= t` checks in neither direction.
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
  if (!Number.isFinite(sim)) return 0;
  return Math.max(-1, Math.min(1, sim));
}

/** L2-normalise in place-safe fashion; a zero vector is returned unchanged. */
export function l2Normalize(v: Float32Array | number[]): Float32Array {
  const out = new Float32Array(v.length);
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0 || !Number.isFinite(norm)) {
    for (let i = 0; i < v.length; i++) out[i] = v[i];
    return out;
  }
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** Intersection-over-union of two [x1,y1,x2,y2] boxes. */
export function iou(a: readonly number[], b: readonly number[]): number {
  const ix1 = Math.max(a[0], b[0]);
  const iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]);
  const iy2 = Math.min(a[3], b[3]);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * Greedy non-maximum suppression. Returns the surviving indices of `boxes`,
 * highest score first.
 */
export function nms(
  boxes: ReadonlyArray<readonly number[]>,
  scores: ReadonlyArray<number>,
  iouThreshold: number,
): number[] {
  const order = scores.map((_, i) => i).sort((i, j) => scores[j] - scores[i]);
  const keep: number[] = [];
  const suppressed = new Uint8Array(boxes.length);
  for (const i of order) {
    if (suppressed[i]) continue;
    keep.push(i);
    for (const j of order) {
      if (j === i || suppressed[j]) continue;
      if (iou(boxes[i], boxes[j]) > iouThreshold) suppressed[j] = 1;
    }
  }
  return keep;
}

// ---------------------------------------------------------------------------
// Image plumbing: ffmpeg decode, dimension sniffing, resizing
// ---------------------------------------------------------------------------

function isRgbImage(x: unknown): x is RgbImage {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as RgbImage).width === "number" &&
    typeof (x as RgbImage).height === "number" &&
    !!(x as RgbImage).data
  );
}

/**
 * Normalise a `data:image/...;base64,...` URL (or a bare base64 string) into the
 * raw encoded bytes. Returns null when the string is obviously not an image.
 */
export function toImageBuffer(input: Buffer | Uint8Array | string): Buffer | null {
  if (Buffer.isBuffer(input)) return input.length > 0 ? input : null;
  if (input instanceof Uint8Array) return input.length > 0 ? Buffer.from(input) : null;
  if (typeof input !== "string" || input.length === 0) return null;
  const trimmed = input.trim();
  const comma = trimmed.startsWith("data:") ? trimmed.indexOf(",") : -1;
  const b64 = comma >= 0 ? trimmed.slice(comma + 1) : trimmed;
  if (b64.length === 0) return null;
  try {
    const buf = Buffer.from(b64, "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Read the intrinsic pixel dimensions straight out of the container header, so
 * a single ffmpeg pass can decode at native resolution. JPEG (SOFn) and PNG
 * (IHDR) cover every source this gateway sees (camera snapshots + browser
 * canvas exports). Returns null for anything else.
 */
export function sniffImageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  // PNG
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      let marker = buf[off + 1];
      while (marker === 0xff && off + 2 < buf.length) {
        off++;
        marker = buf[off + 1];
      }
      // Standalone markers carry no length payload.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      if (marker === 0xd9) return null; // EOI without an SOF
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) return null;
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const height = buf.readUInt16BE(off + 5);
        const width = buf.readUInt16BE(off + 7);
        if (width > 0 && height > 0) return { width, height };
        return null;
      }
      off += 2 + len;
    }
  }
  return null;
}

function runFfmpeg(args: string[], stdin: Buffer, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpegPath(), args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      log("error", "ffmpeg spawn failed", err);
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    const finish = (value: Buffer | null, why?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!value && why) log("warn", `ffmpeg decode failed (${why})`, stderr.trim().slice(0, 300));
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(null, `timeout after ${timeoutMs}ms`);
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < 4000) stderr += c.toString("utf8");
    });
    child.on("error", (err) => finish(null, `spawn error: ${err.message}`));
    child.on("close", (code) => {
      const out = Buffer.concat(chunks);
      if (code !== 0 && out.length === 0) finish(null, `exit code ${code}`);
      else finish(out);
    });
    child.stdin.on("error", () => {
      /* EPIPE when ffmpeg rejects the input before reading it all */
    });
    child.stdin.end(stdin);
  });
}

/**
 * Decode an encoded image (JPEG/PNG buffer, or a `data:` URL) to raw RGB24 at
 * exactly `width` x `height`, using the ffmpeg binary already present in the
 * image. Resolves to a Uint8Array of length width*height*3, or null on any
 * failure (never throws).
 */
export async function decodeToRgb(
  input: Buffer | Uint8Array | string,
  width: number,
  height: number,
): Promise<Uint8Array | null> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    log("warn", `decodeToRgb: invalid target size ${width}x${height}`);
    return null;
  }
  const buf = toImageBuffer(input);
  if (!buf) {
    log("warn", "decodeToRgb: empty or unparseable input");
    return null;
  }
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-f", "image2pipe",
    "-i", "pipe:0",
    "-vf", `scale=${width}:${height}`,
    "-pix_fmt", "rgb24",
    "-f", "rawvideo",
    "-frames:v", "1",
    "pipe:1",
  ];
  const out = await runFfmpeg(args, buf, ffmpegTimeoutMs());
  if (!out) return null;
  const expected = width * height * 3;
  if (out.length < expected) {
    log("warn", `decodeToRgb: short frame ${out.length}/${expected} bytes`);
    return null;
  }
  return new Uint8Array(out.buffer, out.byteOffset, expected);
}

/**
 * Decode to RGB at the image's own resolution. Used for the full pipeline: the
 * detector gets a letterboxed downscale of this, and `alignFace()` samples the
 * full-resolution pixels so small faces keep every pixel they have.
 */
export async function loadImage(input: ImageInput): Promise<RgbImage | null> {
  if (isRgbImage(input)) return input;
  const buf = toImageBuffer(input);
  if (!buf) return null;
  const size = sniffImageSize(buf);
  if (!size) {
    log("warn", "loadImage: unrecognised image header (expected JPEG or PNG)");
    return null;
  }
  const data = await decodeToRgb(buf, size.width, size.height);
  if (!data) return null;
  return { width: size.width, height: size.height, data };
}

/**
 * Area-average (box filter) resize. Used for the detector's downscale, where a
 * plain nearest/bilinear sample of a 3x reduction aliases small faces away.
 */
export function resizeArea(src: RgbImage, dstW: number, dstH: number): RgbImage {
  const out = new Uint8Array(dstW * dstH * 3);
  const xRatio = src.width / dstW;
  const yRatio = src.height / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = Math.min(src.height - 1, Math.floor(dy * yRatio));
    const sy1 = Math.max(sy0 + 1, Math.min(src.height, Math.ceil((dy + 1) * yRatio)));
    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = Math.min(src.width - 1, Math.floor(dx * xRatio));
      const sx1 = Math.max(sx0 + 1, Math.min(src.width, Math.ceil((dx + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = sy0; y < sy1; y++) {
        let idx = (y * src.width + sx0) * 3;
        for (let x = sx0; x < sx1; x++) {
          r += src.data[idx];
          g += src.data[idx + 1];
          b += src.data[idx + 2];
          idx += 3;
          n++;
        }
      }
      const o = (dy * dstW + dx) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  }
  return { width: dstW, height: dstH, data: out };
}

/**
 * Bilinear resize (pixel-centre aligned, edge-clamped), used to ENLARGE small
 * pictures for the detector without the blocky steps resizeArea produces there.
 */
export function resizeBilinear(src: RgbImage, dstW: number, dstH: number): RgbImage {
  const out = new Uint8Array(dstW * dstH * 3);
  const px = new Float32Array(3);
  const sx = src.width / dstW;
  const sy = src.height / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const y = (dy + 0.5) * sy - 0.5;
    for (let dx = 0; dx < dstW; dx++) {
      sampleBilinear(src, (dx + 0.5) * sx - 0.5, y, px);
      const o = (dy * dstW + dx) * 3;
      out[o] = Math.round(px[0]);
      out[o + 1] = Math.round(px[1]);
      out[o + 2] = Math.round(px[2]);
    }
  }
  return { width: dstW, height: dstH, data: out };
}

/** Mirror an RGB image left-to-right (pure; a new buffer, the input is untouched). */
export function flipHorizontal(img: RgbImage): RgbImage {
  const { width, height, data } = img;
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const s = (row + x) * 3;
      const d = (row + (width - 1 - x)) * 3;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
    }
  }
  return { width, height, data: out };
}

/** Bilinear RGB sample with edge clamping. Returns [r, g, b] as floats. */
function sampleBilinear(img: RgbImage, x: number, y: number, out: Float32Array): void {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const cx0 = Math.max(0, Math.min(img.width - 1, x0));
  const cy0 = Math.max(0, Math.min(img.height - 1, y0));
  const cx1 = Math.max(0, Math.min(img.width - 1, x0 + 1));
  const cy1 = Math.max(0, Math.min(img.height - 1, y0 + 1));
  const i00 = (cy0 * img.width + cx0) * 3;
  const i01 = (cy0 * img.width + cx1) * 3;
  const i10 = (cy1 * img.width + cx0) * 3;
  const i11 = (cy1 * img.width + cx1) * 3;
  const w00 = (1 - fx) * (1 - fy);
  const w01 = fx * (1 - fy);
  const w10 = (1 - fx) * fy;
  const w11 = fx * fy;
  for (let c = 0; c < 3; c++) {
    out[c] =
      img.data[i00 + c] * w00 +
      img.data[i01 + c] * w01 +
      img.data[i10 + c] * w10 +
      img.data[i11 + c] * w11;
  }
}

// ---------------------------------------------------------------------------
// Engine (lazy, once per process)
// ---------------------------------------------------------------------------

interface Engine {
  detector: InferenceSession;
  recognizer: InferenceSession;
  ort: typeof import("onnxruntime-node");
  detectorInput: string;
  recognizerInput: string;
  recognizerOutput: string;
  loadTimeMs: number;
  /** File names actually loaded, so status and the model tag describe the running sessions. */
  detectorFile: string;
  recognizerFile: string;
  /** Spatial dims the detector graph accepts (from the session's input metadata). */
  detectorInputDims: DetectorInputDims | null;
}

/**
 * Reads the detector's [N, C, H, W] input dims from the session metadata.
 * Symbolic ("?" / a name) or missing dims are "dynamic"; a runtime without
 * metadata gives null (unknown), never a throw.
 */
export function detectorInputDimsOf(meta: unknown): DetectorInputDims | null {
  try {
    const list = Array.isArray(meta) ? meta : null;
    const first = list && list.length ? (list[0] as { shape?: ReadonlyArray<number | string> }) : null;
    const shape = first && Array.isArray(first.shape) ? first.shape : null;
    if (!shape || shape.length !== 4) return null;
    const dim = (v: number | string): number | "dynamic" =>
      typeof v === "number" && Number.isInteger(v) && v > 0 ? v : "dynamic";
    return { height: dim(shape[2]), width: dim(shape[3]) };
  } catch {
    return null;
  }
}

/** Null when the detector accepts width x height, else why it does not. */
export function detectorShapeIssue(dims: DetectorInputDims | null, width: number, height: number): string | null {
  if (!dims) return null;
  const bad: string[] = [];
  if (dims.height !== "dynamic" && dims.height !== height) bad.push(`height ${height} (graph fixes ${dims.height})`);
  if (dims.width !== "dynamic" && dims.width !== width) bad.push(`width ${width} (graph fixes ${dims.width})`);
  return bad.length ? `detector input ${bad.join(", ")}` : null;
}

let enginePromise: Promise<Engine> | null = null;
let engineRef: Engine | null = null;
let engineLoading = false;
let engineError: string | null = null;

async function createEngine(): Promise<Engine> {
  const dir = modelDir();
  const detectorFile = detectorModelName();
  const recognizerFile = recognizerModelName();
  const detPath = path.join(dir, detectorFile);
  const recPath = path.join(dir, recognizerFile);
  for (const p of [detPath, recPath]) {
    if (!fs.existsSync(p)) throw new Error(`model file missing: ${p}`);
  }
  const ort = await import("onnxruntime-node");
  const opts: InferenceSession.SessionOptions = {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    // Keep the gateway responsive: the worker pool already provides parallelism
    // across frames, so per-session thread fan-out only fights for the same CPU.
    intraOpNumThreads: envNumberOrDefault("FACE_ORT_THREADS", 2),
    logSeverityLevel: ortLogSeverity() as 0 | 1 | 2 | 3 | 4,
  };
  const t0 = Date.now();
  const [detector, recognizer] = await Promise.all([
    ort.InferenceSession.create(detPath, opts),
    ort.InferenceSession.create(recPath, opts),
  ]);
  const loadTimeMs = Date.now() - t0;
  return {
    detector,
    recognizer,
    ort,
    detectorInput: detector.inputNames[0],
    recognizerInput: recognizer.inputNames[0],
    recognizerOutput: recognizer.outputNames[0],
    loadTimeMs,
    detectorFile,
    recognizerFile,
    detectorInputDims: detectorInputDimsOf((detector as { inputMetadata?: unknown }).inputMetadata),
  };
}

/**
 * Load (once) and return the engine, or null if the models are unavailable.
 * Every caller funnels through here; a failed load is remembered as `lastError`
 * and retried on the next call (a model volume can appear late).
 */
export async function getFaceEngine(): Promise<Engine | null> {
  if (engineRef) return engineRef;
  if (!enginePromise) {
    engineLoading = true;
    for (const w of variantWarnings()) log("warn", w);
    enginePromise = createEngine();
    enginePromise
      .then((e) => {
        engineRef = e;
        engineError = null;
        const dims = e.detectorInputDims ? `${e.detectorInputDims.width}x${e.detectorInputDims.height}` : "unknown";
        log("info", `engine ready in ${e.loadTimeMs}ms (${e.detectorFile} input ${dims}, ${e.recognizerFile}, tag=${faceModelTagFor(e.recognizerFile)})`);
      })
      .catch((err) => {
        engineError = err instanceof Error ? err.message : String(err);
        enginePromise = null; // allow a later retry
        log("error", "engine load failed", err);
      })
      .finally(() => {
        engineLoading = false;
      });
  }
  try {
    return await enginePromise;
  } catch {
    return null;
  }
}

/** True once both ONNX sessions are live in this process. */
export function isFaceEngineReady(): boolean {
  return engineRef !== null;
}

/** Snapshot for a status endpoint. Never throws, never triggers a load. */
export function getFaceEngineInfo(): FaceEngineInfo {
  const detectorModel = engineRef ? engineRef.detectorFile : detectorModelName();
  const recognizerModel = engineRef ? engineRef.recognizerFile : recognizerModelName();
  const warnings = variantWarnings();
  return {
    ready: engineRef !== null,
    loading: engineLoading,
    modelDir: modelDir(),
    detectorModel,
    recognizerModel,
    detectorVariant: detectorVariantOf(detectorModel),
    recognizerVariant: recognizerVariantOf(recognizerModel),
    modelTag: faceModelTagFor(recognizerModel),
    variantWarning: warnings.length ? warnings.join("; ") : null,
    detectUpscale: detectUpscaleMode(),
    ttaFlip: ttaFlipEnabled(),
    detectorInputSize: detectorInputSize(),
    detectorInputDims: engineRef ? engineRef.detectorInputDims : null,
    embeddingDim: EMBEDDING_DIM,
    detectThreshold: detectThreshold(),
    nmsIou: nmsIouThreshold(),
    loadTimeMs: engineRef ? engineRef.loadTimeMs : null,
    lastError: engineError,
  };
}

/** Test seam: forget the loaded sessions so env changes take effect. */
export function resetFaceEngine(): void {
  enginePromise = null;
  engineRef = null;
  engineLoading = false;
  engineError = null;
}

// ---------------------------------------------------------------------------
// Detection: SCRFD
// ---------------------------------------------------------------------------

interface Letterboxed {
  tensorData: Float32Array;
  width: number;
  height: number;
  /** original -> model scale factor; invert to map detections back. */
  scale: number;
}

/**
 * Aspect-preserving resize into a `width` x `height` canvas (a `size` square
 * on the legacy path), padded with zeros on the BOTTOM and RIGHT only — this is
 * what InsightFace's SCRFD wrapper does, so un-projecting is a single divide by
 * `scale` with no pad offset. Exported for tests and offline tools only.
 */
export function letterboxForDetector(img: RgbImage, width: number, height = width): Letterboxed {
  const mode = detectUpscaleMode();
  const fit = Math.min(width / img.width, height / img.height);
  const scale = fit > 1 && mode === "none" ? 1 : fit;
  const newW = Math.max(1, Math.round(img.width * scale));
  const newH = Math.max(1, Math.round(img.height * scale));
  const resized =
    newW === img.width && newH === img.height
      ? img
      : scale > 1 && mode === "bilinear"
        ? resizeBilinear(img, newW, newH)
        : resizeArea(img, newW, newH);
  // NCHW float32, (px - 127.5) / 128.0, zero-padded region stays at the value
  // that a black pixel maps to, exactly as a zeroed uint8 canvas would.
  const plane = width * height;
  const data = new Float32Array(3 * plane);
  const padValue = (0 - 127.5) / 128.0;
  data.fill(padValue);
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const s = (y * newW + x) * 3;
      const d = y * width + x;
      data[d] = (resized.data[s] - 127.5) / 128.0;
      data[plane + d] = (resized.data[s + 1] - 127.5) / 128.0;
      data[2 * plane + d] = (resized.data[s + 2] - 127.5) / 128.0;
    }
  }
  return { tensorData: data, width, height, scale: newW / img.width };
}

interface GroupedOutputs {
  scores: Float32Array[];
  bboxes: Float32Array[];
  kps: Float32Array[];
}

/**
 * SCRFD emits 9 tensors: {score, bbox, kps} x {stride 8, 16, 32}. Their NAMES
 * are opaque node ids ("448", "451", ...), so rather than trusting a fixed
 * order we group by last-dim (1 = score, 4 = bbox, 10 = kps) and then order each
 * group by anchor count descending, which is exactly stride 8 -> 16 -> 32.
 */
function groupDetectorOutputs(outputs: Record<string, Tensor>): GroupedOutputs | null {
  const byKind: Record<number, Array<{ rows: number; data: Float32Array }>> = { 1: [], 4: [], 10: [] };
  for (const key of Object.keys(outputs)) {
    const t = outputs[key];
    const dims = t.dims;
    const last = dims[dims.length - 1];
    if (last !== 1 && last !== 4 && last !== 10) continue;
    const total = (t.data as Float32Array).length;
    byKind[last].push({ rows: total / last, data: t.data as Float32Array });
  }
  if (byKind[1].length !== 3 || byKind[4].length !== 3 || byKind[10].length !== 3) {
    log("error", `unexpected detector outputs: ${Object.keys(outputs).length} tensors`);
    return null;
  }
  const sortDesc = (a: { rows: number }, b: { rows: number }) => b.rows - a.rows;
  byKind[1].sort(sortDesc);
  byKind[4].sort(sortDesc);
  byKind[10].sort(sortDesc);
  return {
    scores: byKind[1].map((x) => x.data),
    bboxes: byKind[4].map((x) => x.data),
    kps: byKind[10].map((x) => x.data),
  };
}

/**
 * Decode one FPN level. The anchor grid is row-major over y then x, each cell
 * repeated `NUM_ANCHORS` times (InsightFace stacks the anchors on axis=1 before
 * reshaping, so it is [c0,c0,c1,c1,...], NOT the whole grid twice). Regression
 * outputs are point-to-edge distances in stride units; multiply by the stride,
 * then subtract/add around the anchor centre. The grid is inputW/stride wide
 * and inputH/stride high (equal on the legacy square path).
 */
function decodeLevel(
  strideIndex: number,
  grouped: GroupedOutputs,
  inputW: number,
  inputH: number,
  threshold: number,
  invScale: number,
  outBoxes: Array<[number, number, number, number]>,
  outScores: number[],
  outKps: Array<Array<[number, number]>>,
): void {
  const stride = FEAT_STRIDES[strideIndex];
  const scores = grouped.scores[strideIndex];
  const bboxes = grouped.bboxes[strideIndex];
  const kps = grouped.kps[strideIndex];
  const gridH = Math.floor(inputH / stride);
  const gridW = Math.floor(inputW / stride);
  const expected = gridH * gridW * NUM_ANCHORS;
  if (scores.length !== expected) {
    log(
      "warn",
      `stride ${stride}: anchor count mismatch (got ${scores.length}, expected ${expected}) — check NUM_ANCHORS`,
    );
  }
  const n = Math.min(scores.length, Math.floor(bboxes.length / 4), Math.floor(kps.length / 10));
  for (let i = 0; i < n; i++) {
    const s = scores[i];
    if (s < threshold) continue;
    const cell = Math.floor(i / NUM_ANCHORS);
    const cx = (cell % gridW) * stride;
    const cy = Math.floor(cell / gridW) * stride;
    const b = i * 4;
    const x1 = cx - bboxes[b] * stride;
    const y1 = cy - bboxes[b + 1] * stride;
    const x2 = cx + bboxes[b + 2] * stride;
    const y2 = cy + bboxes[b + 3] * stride;
    const k = i * 10;
    const pts: Array<[number, number]> = [];
    for (let p = 0; p < 5; p++) {
      pts.push([
        (cx + kps[k + p * 2] * stride) * invScale,
        (cy + kps[k + p * 2 + 1] * stride) * invScale,
      ]);
    }
    outBoxes.push([x1 * invScale, y1 * invScale, x2 * invScale, y2 * invScale]);
    outScores.push(s);
    outKps.push(pts);
  }
}

/**
 * Detect faces. Coordinates come back in ORIGINAL image pixels.
 * Returns [] on any failure (missing models, undecodable frame, bad output shapes).
 * `options` is additive (see DetectOptions); without it the legacy square path runs.
 */
export async function detectFaces(input: ImageInput, options?: DetectOptions): Promise<FaceBox[]> {
  try {
    const engine = await getFaceEngine();
    if (!engine) return [];
    const img = await loadImage(input);
    if (!img) return [];
    return await detectOnRgb(engine, img, options);
  } catch (err) {
    log("error", "detectFaces failed", err);
    return [];
  }
}

/** Shapes already reported as incompatible with the loaded detector (one log line each). */
const shapeIssuesLogged = new Set<string>();

/** The detector input shape a call will use: the explicit one, else the FACE_DETECT_SIZE square. */
export function resolveDetectShape(options?: DetectOptions): { width: number; height: number } {
  const s = options?.inputShape;
  if (s && Number.isInteger(s.width) && Number.isInteger(s.height) && s.width > 0 && s.height > 0) {
    return { width: s.width, height: s.height };
  }
  const size = detectorInputSize();
  return { width: size, height: size };
}

async function detectOnRgb(engine: Engine, img: RgbImage, options?: DetectOptions): Promise<FaceBox[]> {
  const { width: inW, height: inH } = resolveDetectShape(options);
  // Fail closed on a graph that cannot take this shape: no run, no exception,
  // one log line per shape (the pipeline checks this before it starts as well).
  const issue = detectorShapeIssue(engine.detectorInputDims, inW, inH);
  if (issue) {
    const key = `${engine.detectorFile}:${inW}x${inH}`;
    if (!shapeIssuesLogged.has(key)) {
      shapeIssuesLogged.add(key);
      log("error", `detectFaces: ${issue}; ${engine.detectorFile} cannot run at ${inW}x${inH} (no faces returned)`);
    }
    return [];
  }
  const lb = letterboxForDetector(img, inW, inH);
  const tensor = new engine.ort.Tensor("float32", lb.tensorData, [1, 3, inH, inW]);
  const outputs = await engine.detector.run({ [engine.detectorInput]: tensor });
  const grouped = groupDetectorOutputs(outputs as unknown as Record<string, Tensor>);
  if (!grouped) return [];

  const threshold = detectThreshold();
  const invScale = 1 / lb.scale;
  const boxes: Array<[number, number, number, number]> = [];
  const scores: number[] = [];
  const kps: Array<Array<[number, number]>> = [];
  for (let i = 0; i < FEAT_STRIDES.length; i++) {
    decodeLevel(i, grouped, inW, inH, threshold, invScale, boxes, scores, kps);
  }
  if (boxes.length === 0) return [];
  const keep = nms(boxes, scores, nmsIouThreshold());
  return keep.map((i) => ({
    box: [
      Math.max(0, boxes[i][0]),
      Math.max(0, boxes[i][1]),
      Math.min(img.width, boxes[i][2]),
      Math.min(img.height, boxes[i][3]),
    ] as [number, number, number, number],
    score: scores[i],
    landmarks: kps[i],
  }));
}

// ---------------------------------------------------------------------------
// Alignment: least-squares similarity transform onto the ArcFace template
// ---------------------------------------------------------------------------

/**
 * Closed-form least-squares similarity transform (rotation + uniform scale +
 * translation, no reflection) mapping `src` onto `dst`. Equivalent to
 * skimage.transform.SimilarityTransform.estimate(), which is what InsightFace
 * uses for ArcFace alignment.
 *
 * Returns [a, b, tx, ty] for:  x' = a*x - b*y + tx ;  y' = b*x + a*y + ty
 */
export function similarityTransform(
  src: ReadonlyArray<readonly [number, number]>,
  dst: ReadonlyArray<readonly [number, number]>,
): [number, number, number, number] | null {
  const n = Math.min(src.length, dst.length);
  if (n < 2) return null;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i][0];
    sy += src[i][1];
    dx += dst[i][0];
    dy += dst[i][1];
  }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let num1 = 0, num2 = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const sxi = src[i][0] - sx;
    const syi = src[i][1] - sy;
    const dxi = dst[i][0] - dx;
    const dyi = dst[i][1] - dy;
    num1 += sxi * dxi + syi * dyi;
    num2 += sxi * dyi - syi * dxi;
    den += sxi * sxi + syi * syi;
  }
  if (den === 0) return null;
  const a = num1 / den;
  const b = num2 / den;
  if (!Number.isFinite(a) || !Number.isFinite(b) || (a === 0 && b === 0)) return null;
  return [a, b, dx - (a * sx - b * sy), dy - (b * sx + a * sy)];
}

/**
 * Produce the 112x112 ArcFace-aligned crop for one face, by inverting the
 * similarity transform that maps the detected landmarks onto ARCFACE_TEMPLATE
 * and bilinearly sampling the ORIGINAL full-resolution pixels.
 */
export function alignFace(
  img: RgbImage,
  landmarks: ReadonlyArray<readonly [number, number]>,
): RgbImage | null {
  const t = similarityTransform(landmarks, ARCFACE_TEMPLATE);
  if (!t) return null;
  const [a, b, tx, ty] = t;
  const det = a * a + b * b;
  if (det === 0) return null;
  // Inverse of [[a,-b],[b,a]] is (1/det) * [[a,b],[-b,a]].
  const ia = a / det;
  const ib = b / det;
  const out = new Uint8Array(ALIGNED_SIZE * ALIGNED_SIZE * 3);
  const px = new Float32Array(3);
  for (let y = 0; y < ALIGNED_SIZE; y++) {
    for (let x = 0; x < ALIGNED_SIZE; x++) {
      const ux = x - tx;
      const uy = y - ty;
      const srcX = ia * ux + ib * uy;
      const srcY = -ib * ux + ia * uy;
      sampleBilinear(img, srcX, srcY, px);
      const o = (y * ALIGNED_SIZE + x) * 3;
      out[o] = px[0];
      out[o + 1] = px[1];
      out[o + 2] = px[2];
    }
  }
  return { width: ALIGNED_SIZE, height: ALIGNED_SIZE, data: out };
}

// ---------------------------------------------------------------------------
// Recognition: ArcFace
// ---------------------------------------------------------------------------

/**
 * Embed a 112x112 aligned RGB crop. Output is L2-normalised here — the raw
 * w600k_r50 output has ‖v‖ ≈ 9-25 and is NOT unit length, so comparing raw
 * vectors with a dot product would be meaningless.
 * Returns null on failure.
 */
export async function embedFace(aligned: RgbImage): Promise<Float32Array | null> {
  try {
    const engine = await getFaceEngine();
    if (!engine) return null;
    if (aligned.width !== ALIGNED_SIZE || aligned.height !== ALIGNED_SIZE) {
      log("warn", `embedFace: expected ${ALIGNED_SIZE}x${ALIGNED_SIZE}, got ${aligned.width}x${aligned.height}`);
      return null;
    }
    const raw = await runRecognizer(engine, alignedToTensorData(aligned));
    if (!raw) return null;
    if (!ttaFlipEnabled()) return l2Normalize(raw);
    // FACE_TTA_FLIP: l2(embed(x) + embed(flip(x))), each view unit length first
    // so both weigh equally. Fails closed to null if the mirrored run fails.
    const rawFlipped = await runRecognizer(engine, alignedToTensorData(flipHorizontal(aligned)));
    if (!rawFlipped) return null;
    const a = l2Normalize(raw);
    const b = l2Normalize(rawFlipped);
    const sum = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) sum[i] = a[i] + b[i];
    return l2Normalize(sum);
  } catch (err) {
    log("error", "embedFace failed", err);
    return null;
  }
}

/**
 * The recogniser's input tensor data for a 112x112 aligned crop: NCHW RGB,
 * (px - 127.5) / 127.5. Pure; exported so tests can pin the exact bytes
 * embedFace() feeds the model.
 */
export function alignedToTensorData(aligned: RgbImage): Float32Array {
  const plane = ALIGNED_SIZE * ALIGNED_SIZE;
  const data = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const s = i * 3;
    data[i] = (aligned.data[s] - 127.5) / 127.5;
    data[plane + i] = (aligned.data[s + 1] - 127.5) / 127.5;
    data[2 * plane + i] = (aligned.data[s + 2] - 127.5) / 127.5;
  }
  return data;
}

/** One recogniser run; the raw (un-normalised) 512-D output, or null on a bad output shape. */
async function runRecognizer(engine: Engine, data: Float32Array): Promise<Float32Array | null> {
  const tensor = new engine.ort.Tensor("float32", data, [1, 3, ALIGNED_SIZE, ALIGNED_SIZE]);
  const out = await engine.recognizer.run({ [engine.recognizerInput]: tensor });
  const raw = out[engine.recognizerOutput].data as Float32Array;
  if (!raw || raw.length !== EMBEDDING_DIM) {
    log("error", `embedFace: unexpected embedding length ${raw ? raw.length : "null"}`);
    return null;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

/**
 * Variance of the Laplacian over the grayscale of a crop — the standard cheap
 * blur metric. Low values mean a smeared / out-of-focus / upscaled-from-nothing
 * capture that will embed poorly.
 */
export function laplacianVariance(img: RgbImage): number {
  const { width: w, height: h, data } = img;
  if (w < 3 || h < 3) return 0;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const s = i * 3;
    gray[i] = 0.299 * data[s] + 0.587 * data[s + 1] + 0.114 * data[s + 2];
  }
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * Blend sharpness and face size into a single 0..1 gate.
 * Reference points chosen from this site's geometry: a 40 px face is the floor
 * (the detector still fires but ArcFace degrades), 112 px is "as good as the
 * model can use"; Laplacian variance saturates around 120 for a crisp crop.
 */
export function facePose(landmarks: ReadonlyArray<readonly [number, number]>): FacePose | null {
  if (!landmarks || landmarks.length < 5) return null;
  const [eL, eR, nose, mL, mR] = landmarks;
  const roll = Math.atan2(eR[1] - eL[1], eR[0] - eL[0]);
  const c = Math.cos(-roll), sn = Math.sin(-roll);
  const rot = (p: readonly [number, number]) => [p[0] * c - p[1] * sn, p[0] * sn + p[1] * c];
  const [a, b, n, ml, mr] = [eL, eR, nose, mL, mR].map(rot);
  const eyeDist = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(eyeDist > 0)) return null;
  const eyeMidX = (a[0] + b[0]) / 2, eyeMidY = (a[1] + b[1]) / 2;
  const mouthMidY = (ml[1] + mr[1]) / 2;
  const pose = { yaw: (n[0] - eyeMidX) / eyeDist, aspect: (mouthMidY - eyeMidY) / eyeDist, rollDeg: (roll * 180) / Math.PI };
  return [pose.yaw, pose.aspect, pose.rollDeg].every(Number.isFinite) ? pose : null;
}

const envLimit = (name: string, fallback: number, min: number, max: number) => envNumber(name, fallback, { min, max });

/**
 * What counts as a clear, recognisable face. Calibrated on this site's own
 * captures (2026-09-25): 94% of frames the system recognised fall inside these
 * limits, while 23% of denied captures fall outside - heads turned down or away,
 * like a person reading a phone while walking past. Frame-level: the watcher
 * rescans every few seconds, so someone caught mid-turn is recognised a moment
 * later on a frontal frame.
 */
export const CLEAR_FACE_LIMITS = {
  /**
   * Shorter side of the face box, in source-frame pixels. 60 is the owner's
   * decision (2026-09-26): only faces close to the gate count. Measured cost on
   * 176 recognised captures: under 40 px recognition fails anyway (right
   * employee scored 0.35), but 40-60 px faces - the 4K entry camera's normal
   * range - still matched correctly 85% of the time, so ~23% of recent
   * entries were at a size this floor now refuses; those people are
   * recognised once they step closer. Lower it with FACE_MIN_SIZE_PX.
   */
  minFacePx: envLimit("FACE_MIN_SIZE_PX", 60, 0, 2000),
  maxYaw: envLimit("FACE_CLEAR_MAX_YAW", 1.5, 0.1, 10),
  minAspect: envLimit("FACE_CLEAR_MIN_ASPECT", 0.3, 0, 5),
  maxAspect: envLimit("FACE_CLEAR_MAX_ASPECT", 2.5, 0.5, 20),
  maxRollDeg: envLimit("FACE_CLEAR_MAX_ROLL_DEG", 45, 5, 180),
};

/** null when the face is clear enough to recognise or keep; otherwise the reason it is not. */
export function clearFaceIssue(
  pose: FacePose | null,
  limits = CLEAR_FACE_LIMITS,
  boxSize?: number,
): UnclearReason | null {
  // Size first: a face this small is too far from the gate, and its landmarks
  // (hence the pose checks below) are not reliable either.
  if (boxSize !== undefined && boxSize < limits.minFacePx) return "small";
  if (!pose) return "landmarks";
  if (Math.abs(pose.rollDeg) > limits.maxRollDeg) return "roll";
  if (Math.abs(pose.yaw) > limits.maxYaw) return "yaw";
  if (pose.aspect < limits.minAspect || pose.aspect > limits.maxAspect) return "aspect";
  return null;
}

/**
 * Mean squared central-difference gradient over the central 70% of an aligned
 * face, divided by that area's intensity variance. Hair, background and any
 * annotation box stay outside the window, and dividing by contrast keeps dark
 * and bright faces comparable. Heavily smeared faces fall low (calibrated on
 * the site's captures 2026-09-28: < 0.16 caught 6/19 visibly blurred faces
 * while dropping 2/45 clear ones - it only catches HEAVY blur).
 */
export function faceEdgeEnergy(aligned: RgbImage): number {
  const n = aligned.width;
  if (!n || aligned.height !== n || aligned.data.length < n * n * 3) return 0;
  const lo = Math.max(1, Math.round(n * 0.15)), hi = Math.min(n - 1, Math.round(n * 0.85));
  const lum = (i: number) => 0.299 * aligned.data[i * 3] + 0.587 * aligned.data[i * 3 + 1] + 0.114 * aligned.data[i * 3 + 2];
  let energy = 0, count = 0, mean = 0, m2 = 0;
  for (let y = lo; y < hi; y++) {
    for (let x = lo; x < hi; x++) {
      const p = lum(y * n + x);
      const dx = lum(y * n + x + 1) - lum(y * n + x - 1);
      const dy = lum((y + 1) * n + x) - lum((y - 1) * n + x);
      energy += dx * dx + dy * dy;
      count += 1;
      mean += p;
      m2 += p * p;
    }
  }
  if (!count) return 0;
  mean /= count;
  const variance = Math.max(1, m2 / count - mean * mean);
  return energy / count / variance;
}

export function faceQuality(aligned: RgbImage, boxSize: number): { quality: number; sharpness: number } {
  const sharpness = laplacianVariance(aligned);
  const sizeScore = Math.max(0, Math.min(1, (boxSize - 24) / (112 - 24)));
  const blurScore = Math.max(0, Math.min(1, sharpness / 120));
  return { quality: Math.sqrt(Math.max(0, sizeScore) * Math.max(0, blurScore)), sharpness };
}

// ---------------------------------------------------------------------------
// One-shot convenience
// ---------------------------------------------------------------------------

/**
 * Full pipeline: decode -> detect -> align -> embed -> score quality.
 * Faces that fail to align or embed are dropped, not thrown. Results are
 * ordered by detector score, highest first.
 */
export async function extractFaces(input: ImageInput): Promise<ExtractedFace[]> {
  try {
    const engine = await getFaceEngine();
    if (!engine) return [];
    const img = await loadImage(input);
    if (!img) return [];
    const faces = await detectOnRgb(engine, img);
    const out: ExtractedFace[] = [];
    for (const f of faces) {
      const aligned = alignFace(img, f.landmarks);
      if (!aligned) continue;
      const embedding = await embedFace(aligned);
      if (!embedding) continue;
      const boxSize = Math.min(f.box[2] - f.box[0], f.box[3] - f.box[1]);
      const { quality, sharpness } = faceQuality(aligned, boxSize);
      const edgeEnergy = faceEdgeEnergy(aligned);
      const pose = facePose(f.landmarks);
      const issue = clearFaceIssue(pose, CLEAR_FACE_LIMITS, boxSize);
      out.push({ ...f, embedding, quality, sharpness, edgeEnergy, boxSize, pose, clear: issue === null, ...(issue ? { unclearReason: issue } : {}) });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  } catch (err) {
    log("error", "extractFaces failed", err);
    return [];
  }
}
