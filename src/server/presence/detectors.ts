/**
 * Person detectors for presence detection (P2): YOLOX-Nano and RTMDet-tiny in
 * onnxruntime-node, ported from the P1 evaluation harness
 * (tools/presence-eval/run-models.ts, models.json, score.py, combine.py) so the
 * production numbers match the P1/P1b report.
 *
 * Both ONNX files share one contract (tools/presence-eval/export_*.py): one
 * float32 NCHW image in, `[1, N, 5]` out = x1, y1, x2, y2 in INPUT pixels and the
 * person score; NMS is done here.
 *
 * Per frame (packed RGB24, any size; P2 frames are already 960 px wide):
 *   1. resize to the model input width when needed (keeps the aspect ratio);
 *   2. place top-left in an input of width W and height ceil(h / 32) * 32,
 *      padded with 114 (P1 `geometry()` / `fillTensor()`), BGR, per-model
 *      mean/std (YOLOX: raw 0-255; RTMDet: ImageNet mean/std in BGR order);
 *   3. decode, keep score >= threshold, class-agnostic NMS IoU 0.5;
 *   4. drop boxes lying >= 50 % inside the static overlay mask (OSD clock, logo);
 *   5. scale to SOURCE-picture pixels (frame -> source factor), clamped.
 * `mergeDetections` is the cross-model union (NMS 0.5) of P1b.
 *
 * Fail closed: the model file's sha256 must equal the configured value, else the
 * detector refuses to load (`ready() === false`, `error()` says why).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Box, MaskRect, PersonDetection, PresenceModelConfig, PresenceModelId } from "./contracts";

export const NMS_IOU = 0.5;
export const MASK_INSIDE_FRACTION = 0.5;
export const INPUT_STRIDE = 32;
export const PAD_VALUE = 114;

/** Per-model preprocessing (P1 tools/presence-eval/models.json). */
export interface ModelPreprocess {
  /** Channel order fed to the model. Both P2 models take BGR. */
  order: "bgr" | "rgb";
  /** Per INPUT channel (after reordering). */
  mean: [number, number, number];
  std: [number, number, number];
  pad: number;
}

export const MODEL_PREPROCESS: Readonly<Record<PresenceModelId, ModelPreprocess>> = Object.freeze({
  "yolox-nano": { order: "bgr", mean: [0, 0, 0], std: [1, 1, 1], pad: PAD_VALUE },
  "rtmdet-tiny": { order: "bgr", mean: [103.53, 116.28, 123.675], std: [57.375, 57.12, 58.395], pad: PAD_VALUE },
});

/** Packed RGB24 frame as the presence host receives it. */
export interface PresenceFrame {
  width: number;
  height: number;
  rgb: Uint8Array;
  capturedAtMs: number;
  /** Size of the full camera picture the frame was scaled from; default = the frame size. */
  sourceWidth?: number;
  sourceHeight?: number;
  seq?: number;
}

export interface InputGeometry {
  /** Content (the resized frame) size inside the input. */
  contentW: number;
  contentH: number;
  /** Model input size (content padded to the stride). */
  inW: number;
  inH: number;
  /** content px per frame px. */
  scale: number;
}

/** P1 `geometry()` for a dynamic-shape model scaled to `inputWidth`. Pure. */
export function inputGeometry(frameW: number, frameH: number, inputWidth: number, stride = INPUT_STRIDE): InputGeometry {
  if (!(frameW > 0 && frameH > 0 && inputWidth > 0)) throw new RangeError(`bad geometry ${frameW}x${frameH} -> ${inputWidth}`);
  const s = inputWidth / frameW;
  const inW = Math.ceil(inputWidth / stride) * stride;
  const inH = Math.max(stride, Math.ceil((frameH * s) / stride) * stride);
  const contentW = Math.min(inW, Math.max(2, Math.round((frameW * s) / 2) * 2));
  const contentH = Math.min(inH, Math.max(2, Math.round((frameH * s) / 2) * 2));
  return { contentW, contentH, inW, inH, scale: contentW / frameW };
}

/** Bilinear resize of packed RGB24 (only used when a frame is not already at the input width). */
export function resizeRgb(rgb: Uint8Array, w: number, h: number, outW: number, outH: number): Uint8Array {
  if (outW === w && outH === h) return rgb;
  const out = new Uint8Array(outW * outH * 3);
  const sx = w / outW;
  const sy = h / outH;
  for (let y = 0; y < outH; y++) {
    const fy = Math.max(0, Math.min(h - 1, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < outW; x++) {
      const fx = Math.max(0, Math.min(w - 1, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(w - 1, x0 + 1);
      const wx = fx - x0;
      const o = (y * outW + x) * 3;
      for (let c = 0; c < 3; c++) {
        const a = rgb[(y0 * w + x0) * 3 + c] * (1 - wx) + rgb[(y0 * w + x1) * 3 + c] * wx;
        const b = rgb[(y1 * w + x0) * 3 + c] * (1 - wx) + rgb[(y1 * w + x1) * 3 + c] * wx;
        out[o + c] = Math.round(a * (1 - wy) + b * wy);
      }
    }
  }
  return out;
}

/**
 * P1 `fillTensor()` (NCHW): content top-left, the rest filled with the
 * normalised pad value. `rgb` is the content (contentW x contentH, RGB24).
 */
export function fillTensor(rgb: Uint8Array, g: InputGeometry, p: ModelPreprocess, out?: Float32Array): Float32Array {
  const plane = g.inW * g.inH;
  const data = out && out.length === 3 * plane ? out : new Float32Array(3 * plane);
  const ch = p.order === "rgb" ? [0, 1, 2] : [2, 1, 0];
  for (let c = 0; c < 3; c++) data.fill((p.pad - p.mean[c]) / p.std[c], c * plane, (c + 1) * plane);
  for (let y = 0; y < g.contentH; y++) {
    for (let x = 0; x < g.contentW; x++) {
      const src = (y * g.contentW + x) * 3;
      const dst = y * g.inW + x;
      for (let c = 0; c < 3; c++) data[c * plane + dst] = (rgb[src + ch[c]] - p.mean[c]) / p.std[c];
    }
  }
  return data;
}

export function boxArea(b: readonly number[]): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

export function boxIntersection(a: readonly number[], b: readonly number[]): number {
  return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
}

export function boxIou(a: readonly number[], b: readonly number[]): number {
  const i = boxIntersection(a, b);
  const u = boxArea(a) + boxArea(b) - i;
  return u > 0 ? i / u : 0;
}

/** Greedy class-agnostic NMS: highest score first; a box overlapping a kept one by IoU > thr is dropped. */
export function nmsDetections<T extends { box: readonly number[]; score: number }>(dets: T[], iouThr = NMS_IOU): T[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const keep: T[] = [];
  for (const d of sorted) if (keep.every((k) => boxIou(d.box, k.box) <= iouThr)) keep.push(d);
  return keep;
}

/** Drops boxes lying >= MASK_INSIDE_FRACTION inside the mask rects (fractions of a W x H picture). */
export function applyMask<T extends { box: readonly number[] }>(dets: T[], mask: readonly MaskRect[], w: number, h: number): T[] {
  if (!mask.length) return dets;
  const rects = mask.map(([x, y, rw, rh]) => [x * w, y * h, (x + rw) * w, (y + rh) * h]);
  return dets.filter((d) => {
    const a = boxArea(d.box);
    if (a <= 0) return false;
    const inside = rects.reduce((s, r) => s + boxIntersection(d.box, r), 0);
    return inside < MASK_INSIDE_FRACTION * a;
  });
}

/**
 * Model output -> person detections in SOURCE pixels. `out` is the flat
 * `[1, N, 5]` data; `g` the input geometry used for this frame.
 */
export function decodeDetections(
  out: Float32Array,
  n: number,
  g: InputGeometry,
  frame: { width: number; height: number; sourceWidth?: number; sourceHeight?: number },
  cfg: { id: PresenceModelId; threshold: number },
  mask: readonly MaskRect[],
): PersonDetection[] {
  const cand: Array<{ box: Box; score: number }> = [];
  for (let k = 0; k < n; k++) {
    const score = out[k * 5 + 4];
    if (!(score >= cfg.threshold)) continue;
    cand.push({ box: [out[k * 5], out[k * 5 + 1], out[k * 5 + 2], out[k * 5 + 3]], score });
  }
  const sw = frame.sourceWidth && frame.sourceWidth > 0 ? frame.sourceWidth : frame.width;
  const sh = frame.sourceHeight && frame.sourceHeight > 0 ? frame.sourceHeight : frame.height;
  const fx = sw / frame.width / g.scale;
  const fy = sh / frame.height / g.scale;
  const clampX = (v: number) => Math.min(sw, Math.max(0, v));
  const clampY = (v: number) => Math.min(sh, Math.max(0, v));
  const scaled = nmsDetections(cand).map((d) => ({
    box: [clampX(d.box[0] * fx), clampY(d.box[1] * fy), clampX(d.box[2] * fx), clampY(d.box[3] * fy)] as Box,
    score: d.score,
    model: cfg.id,
  }));
  return applyMask(scaled, mask, sw, sh);
}

/** P1b union of the two models' boxes on one frame (NMS 0.5 across models). */
export function mergeDetections(a: PersonDetection[], b: PersonDetection[]): PersonDetection[] {
  return nmsDetections([...a, ...b]);
}

/** sha256 of a file, hex lowercase. */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("error", reject);
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

/** Short tag for stats/logs: `<id>@<first 12 hex of sha256>`. */
export function modelTag(cfg: PresenceModelConfig): string {
  return `${cfg.id}@${String(cfg.sha256 || "").slice(0, 12)}`;
}

/** What a detector worker needs: one model, loaded once, then detect(frame). */
export interface PersonDetectorEngine {
  load(): Promise<boolean>;
  ready(): boolean;
  error(): string | null;
  tag(): string;
  detect(frame: PresenceFrame): Promise<PersonDetection[]>;
  /** session.run time of the last detect, ms. */
  lastRunMs?(): number | undefined;
}

export interface OnnxDetectorOptions {
  model: PresenceModelConfig;
  modelDir: string;
  mask: readonly MaskRect[];
  ortThreads?: number;
}

/**
 * One ONNX session for one model. Loads only a file whose sha256 matches the
 * configuration; refuses file names with path separators.
 */
export class OnnxPersonDetector implements PersonDetectorEngine {
  private session: import("onnxruntime-node").InferenceSession | null = null;
  private ort: typeof import("onnxruntime-node") | null = null;
  private err: string | null = "not loaded";
  private runMs: number | undefined;
  private buffer: Float32Array | null = null;
  private readonly pre: ModelPreprocess;

  constructor(private readonly opts: OnnxDetectorOptions) {
    const pre = MODEL_PREPROCESS[opts.model.id];
    if (!pre) throw new TypeError(`unknown presence model ${JSON.stringify(opts.model.id)}`);
    this.pre = pre;
  }

  ready(): boolean {
    return this.session !== null;
  }

  error(): string | null {
    return this.err;
  }

  tag(): string {
    return modelTag(this.opts.model);
  }

  lastRunMs(): number | undefined {
    return this.runMs;
  }

  async load(): Promise<boolean> {
    const cfg = this.opts.model;
    try {
      if (!/^[A-Za-z0-9._-]+\.onnx$/.test(cfg.file) || cfg.file.startsWith(".")) throw new Error(`invalid model file name ${JSON.stringify(cfg.file)}`);
      const expected = String(cfg.sha256 || "").trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`no valid sha256 configured for ${cfg.id}`);
      const file = path.join(this.opts.modelDir, cfg.file);
      if (!fs.existsSync(file)) throw new Error(`model file missing: ${file}`);
      const actual = await sha256File(file);
      if (actual !== expected) throw new Error(`model sha256 mismatch for ${cfg.id}: ${file} is ${actual.slice(0, 12)}..., expected ${expected.slice(0, 12)}...`);
      this.ort = this.ort || (await import("onnxruntime-node"));
      const threads = Math.max(1, Math.min(8, Math.floor(this.opts.ortThreads ?? 1)));
      this.session = await this.ort.InferenceSession.create(file, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
        intraOpNumThreads: threads,
        interOpNumThreads: 1,
        executionMode: "sequential",
        logSeverityLevel: 3,
      });
      this.err = null;
      return true;
    } catch (e) {
      this.session = null;
      this.err = String((e as any)?.message || e).slice(0, 300);
      return false;
    }
  }

  async detect(frame: PresenceFrame): Promise<PersonDetection[]> {
    const session = this.session;
    const ort = this.ort;
    if (!session || !ort) throw new Error(`${this.opts.model.id} not loaded: ${this.err || "unknown"}`);
    if (!(frame.width > 0 && frame.height > 0) || frame.rgb.length !== frame.width * frame.height * 3) {
      throw new Error(`bad frame ${frame.width}x${frame.height} (${frame.rgb.length} bytes)`);
    }
    const g = inputGeometry(frame.width, frame.height, this.opts.model.inputWidth);
    const content = resizeRgb(frame.rgb, frame.width, frame.height, g.contentW, g.contentH);
    const need = 3 * g.inW * g.inH;
    if (!this.buffer || this.buffer.length !== need) this.buffer = new Float32Array(need);
    const data = fillTensor(content, g, this.pre, this.buffer);
    const t0 = performance.now();
    const res = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, g.inH, g.inW]) });
    this.runMs = performance.now() - t0;
    const o = res[session.outputNames[0]];
    const dims = o.dims;
    const n = dims.length === 3 ? Number(dims[1]) : Number(dims[0]);
    return decodeDetections(o.data as Float32Array, n, g, frame, this.opts.model, this.opts.mask);
  }
}
