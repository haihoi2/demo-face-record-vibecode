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

export interface ExtractedFace extends FaceBox {
  /** 512-D, L2-normalised (‖v‖ === 1). */
  embedding: Float32Array;
  /** 0..1 capture-quality gate: blends sharpness and face size. */
  quality: number;
  /** Variance of the Laplacian over the aligned 112x112 crop (higher = sharper). */
  sharpness: number;
  /** Shorter side of the detected box, in original-image pixels. */
  boxSize: number;
}

export interface FaceEngineInfo {
  ready: boolean;
  loading: boolean;
  modelDir: string;
  detectorModel: string;
  recognizerModel: string;
  detectorInputSize: number;
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
const DEFAULT_DETECTOR = "det_10g.onnx";
const DEFAULT_RECOGNIZER = "w600k_r50.onnx";

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

function envNumber(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function modelDir(): string {
  return env("FACE_MODEL_DIR", DEFAULT_MODEL_DIR);
}
function detectorModelName(): string {
  return env("FACE_DETECTOR_MODEL", DEFAULT_DETECTOR);
}
function recognizerModelName(): string {
  return env("FACE_RECOGNIZER_MODEL", DEFAULT_RECOGNIZER);
}
function detectThreshold(): number {
  return envNumber("FACE_DETECT_THRESHOLD", 0.5);
}
function nmsIouThreshold(): number {
  return envNumber("FACE_NMS_IOU", 0.4);
}
function detectorInputSize(): number {
  return envNumber("FACE_DETECT_SIZE", 640);
}
function ffmpegPath(): string {
  return env("FFMPEG_PATH", "ffmpeg");
}
function ffmpegTimeoutMs(): number {
  return envNumber("FACE_FFMPEG_TIMEOUT_MS", 10_000);
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
}

let enginePromise: Promise<Engine> | null = null;
let engineRef: Engine | null = null;
let engineLoading = false;
let engineError: string | null = null;

async function createEngine(): Promise<Engine> {
  const dir = modelDir();
  const detPath = path.join(dir, detectorModelName());
  const recPath = path.join(dir, recognizerModelName());
  for (const p of [detPath, recPath]) {
    if (!fs.existsSync(p)) throw new Error(`model file missing: ${p}`);
  }
  const ort = await import("onnxruntime-node");
  const opts: InferenceSession.SessionOptions = {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    // Keep the gateway responsive: the worker pool already provides parallelism
    // across frames, so per-session thread fan-out only fights for the same CPU.
    intraOpNumThreads: envNumber("FACE_ORT_THREADS", 2),
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
    enginePromise = createEngine();
    enginePromise
      .then((e) => {
        engineRef = e;
        engineError = null;
        log("info", `engine ready in ${e.loadTimeMs}ms (${detectorModelName()}, ${recognizerModelName()})`);
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
  return {
    ready: engineRef !== null,
    loading: engineLoading,
    modelDir: modelDir(),
    detectorModel: detectorModelName(),
    recognizerModel: recognizerModelName(),
    detectorInputSize: detectorInputSize(),
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
  size: number;
  /** original -> model scale factor; invert to map detections back. */
  scale: number;
}

/**
 * Aspect-preserving resize into a `size` x `size` canvas, padded with zeros on
 * the BOTTOM and RIGHT only — this is what InsightFace's SCRFD wrapper does, so
 * un-projecting is a single divide by `scale` with no pad offset.
 */
function letterboxForDetector(img: RgbImage, size: number): Letterboxed {
  const scale = Math.min(size / img.width, size / img.height);
  const newW = Math.max(1, Math.round(img.width * scale));
  const newH = Math.max(1, Math.round(img.height * scale));
  const resized = resizeArea(img, newW, newH);
  // NCHW float32, (px - 127.5) / 128.0, zero-padded region stays at the value
  // that a black pixel maps to, exactly as a zeroed uint8 canvas would.
  const plane = size * size;
  const data = new Float32Array(3 * plane);
  const padValue = (0 - 127.5) / 128.0;
  data.fill(padValue);
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const s = (y * newW + x) * 3;
      const d = y * size + x;
      data[d] = (resized.data[s] - 127.5) / 128.0;
      data[plane + d] = (resized.data[s + 1] - 127.5) / 128.0;
      data[2 * plane + d] = (resized.data[s + 2] - 127.5) / 128.0;
    }
  }
  return { tensorData: data, size, scale: newW / img.width };
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
 * then subtract/add around the anchor centre.
 */
function decodeLevel(
  strideIndex: number,
  grouped: GroupedOutputs,
  inputSize: number,
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
  const gridH = Math.floor(inputSize / stride);
  const gridW = Math.floor(inputSize / stride);
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
 */
export async function detectFaces(input: ImageInput): Promise<FaceBox[]> {
  try {
    const engine = await getFaceEngine();
    if (!engine) return [];
    const img = await loadImage(input);
    if (!img) return [];
    return await detectOnRgb(engine, img);
  } catch (err) {
    log("error", "detectFaces failed", err);
    return [];
  }
}

async function detectOnRgb(engine: Engine, img: RgbImage): Promise<FaceBox[]> {
  const size = detectorInputSize();
  const lb = letterboxForDetector(img, size);
  const tensor = new engine.ort.Tensor("float32", lb.tensorData, [1, 3, size, size]);
  const outputs = await engine.detector.run({ [engine.detectorInput]: tensor });
  const grouped = groupDetectorOutputs(outputs as unknown as Record<string, Tensor>);
  if (!grouped) return [];

  const threshold = detectThreshold();
  const invScale = 1 / lb.scale;
  const boxes: Array<[number, number, number, number]> = [];
  const scores: number[] = [];
  const kps: Array<Array<[number, number]>> = [];
  for (let i = 0; i < FEAT_STRIDES.length; i++) {
    decodeLevel(i, grouped, size, threshold, invScale, boxes, scores, kps);
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
    const plane = ALIGNED_SIZE * ALIGNED_SIZE;
    const data = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      const s = i * 3;
      data[i] = (aligned.data[s] - 127.5) / 127.5;
      data[plane + i] = (aligned.data[s + 1] - 127.5) / 127.5;
      data[2 * plane + i] = (aligned.data[s + 2] - 127.5) / 127.5;
    }
    const tensor = new engine.ort.Tensor("float32", data, [1, 3, ALIGNED_SIZE, ALIGNED_SIZE]);
    const out = await engine.recognizer.run({ [engine.recognizerInput]: tensor });
    const raw = out[engine.recognizerOutput].data as Float32Array;
    if (!raw || raw.length !== EMBEDDING_DIM) {
      log("error", `embedFace: unexpected embedding length ${raw ? raw.length : "null"}`);
      return null;
    }
    return l2Normalize(raw);
  } catch (err) {
    log("error", "embedFace failed", err);
    return null;
  }
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
      out.push({ ...f, embedding, quality, sharpness, boxSize });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  } catch (err) {
    log("error", "extractFaces failed", err);
    return [];
  }
}
