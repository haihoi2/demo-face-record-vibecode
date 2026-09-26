/**
 * Face crops (real-time pipeline step 3, plan docs/plans/2026-09-26-realtime-pipeline.md).
 *
 * Owner decision 2026-09-26: store a JPEG crop of every detected face >= 60 px
 * instead of the whole frame. The crop must stay good enough for quick-register
 * and stranger merge, which run `extractFaces()` on the stored image again and
 * need a clear face with quality >= FACE_ENROLL_MIN_QUALITY (0.25).
 *
 * Geometry (all in SOURCE pixels, nothing is ever upscaled):
 *   side = max(box w, box h) * margin, at least `minSizePx`, centred on the box,
 *   shifted to stay inside the picture and clamped to it when the picture itself
 *   is smaller. The crop is only ever DOWNscaled, and only when it is larger than
 *   `maxSizePx`, so faces keep every pixel the camera gave them - the reason
 *   crops beat downscaled 4K frames for enrolment.
 *
 * Encoding goes through the static ffmpeg binary the image already ships
 * (rawvideo or JPEG in -> crop/scale -> mjpeg out), bounded by a hard timeout
 * with SIGKILL. No native image dependency. Nothing here throws: bad input,
 * a bad box, a missing ffmpeg or a timeout all resolve to null.
 */

import { spawn } from "node:child_process";
import type { Frame } from "./contracts";

export type FaceBoxXYXY = readonly [number, number, number, number];

export interface FaceCropOptions {
  /** Crop side as a multiple of the face box's longer side. Default 2.5 (env FACE_CROP_MARGIN). */
  margin?: number;
  /** Minimum crop side in source pixels (more context, never upscaling). Default 288 (env FACE_CROP_MIN_PX). */
  minSizePx?: number;
  /** Larger crops are downscaled to this side. 0 disables. Default 384 (env FACE_CROP_MAX_PX). */
  maxSizePx?: number;
  /** ffmpeg mjpeg qscale, 2 (best) .. 31 (worst). Default 4 (env FACE_CROP_QSCALE). */
  qscale?: number;
  /** Hard ffmpeg timeout. Default 3000 ms (env FACE_CROP_TIMEOUT_MS). */
  timeoutMs?: number;
}

export interface ResolvedFaceCropOptions {
  margin: number;
  minSizePx: number;
  maxSizePx: number;
  qscale: number;
  timeoutMs: number;
}

/** Integer crop rectangle in source pixels plus the output size after the optional downscale. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
  outW: number;
  outH: number;
}

/**
 * Measured 2026-09-26 on 199 real gate faces (60-533 px, 4K entry + 1080p
 * exit; scripts/perf/crop-eval.ts): 2.5x / 288 px / 384 px max / q4 finds the
 * face again in 94% of crops and 88% stay enrolment grade, median 14 KB
 * (p90 25 KB, max 35 KB). Tighter crops lose the face more often (2x/224:
 * 90.5%, 1.5x/160: 86%); a larger maximum only adds bytes.
 */
export const FACE_CROP_DEFAULTS: Readonly<ResolvedFaceCropOptions> = Object.freeze({
  margin: 2.5,
  minSizePx: 288,
  maxSizePx: 384,
  qscale: 4,
  timeoutMs: 3000,
});

const LIMITS = {
  margin: [1, 6],
  minSizePx: [0, 4096],
  maxSizePx: [0, 8192],
  qscale: [2, 31],
  timeoutMs: [100, 60_000],
} as const;

function clampOption(name: keyof typeof LIMITS, value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const [lo, hi] = LIMITS[name];
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Options in effect: explicit argument > environment > default. Out-of-range
 * values are clamped, junk falls back to the default. Read on every call so
 * tests (and an operator restart) can change them.
 */
export function resolveFaceCropOptions(opts: FaceCropOptions = {}): ResolvedFaceCropOptions {
  const env = process.env;
  const pick = (name: keyof typeof LIMITS, explicit: number | undefined, envName: string) =>
    clampOption(name, explicit ?? env[envName], FACE_CROP_DEFAULTS[name]);
  return {
    margin: pick("margin", opts.margin, "FACE_CROP_MARGIN"),
    minSizePx: Math.round(pick("minSizePx", opts.minSizePx, "FACE_CROP_MIN_PX")),
    maxSizePx: Math.round(pick("maxSizePx", opts.maxSizePx, "FACE_CROP_MAX_PX")),
    qscale: Math.round(pick("qscale", opts.qscale, "FACE_CROP_QSCALE")),
    timeoutMs: Math.round(pick("timeoutMs", opts.timeoutMs, "FACE_CROP_TIMEOUT_MS")),
  };
}

function even(n: number): number {
  return n >= 2 ? n - (n % 2) : n;
}

/**
 * Pure crop geometry. Returns null for a box that is not finite, has no area,
 * or lies entirely outside the picture. Width/height are kept even (chroma
 * subsampling) whenever the picture allows it.
 */
export function computeFaceCropRect(
  box: FaceBoxXYXY,
  imageWidth: number,
  imageHeight: number,
  opts: FaceCropOptions = {},
): CropRect | null {
  if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => Number.isFinite(v))) return null;
  if (!Number.isInteger(imageWidth) || !Number.isInteger(imageHeight) || imageWidth < 1 || imageHeight < 1) return null;
  const o = resolveFaceCropOptions(opts);
  const x1 = Math.max(0, Math.min(box[0], box[2]));
  const y1 = Math.max(0, Math.min(box[1], box[3]));
  const x2 = Math.min(imageWidth, Math.max(box[0], box[2]));
  const y2 = Math.min(imageHeight, Math.max(box[1], box[3]));
  const bw = x2 - x1;
  const bh = y2 - y1;
  if (!(bw > 0) || !(bh > 0)) return null;

  const side = Math.max(Math.max(bw, bh) * o.margin, o.minSizePx);
  let w = Math.min(imageWidth, Math.round(side));
  let h = Math.min(imageHeight, Math.round(side));
  if (w > 1 && w < imageWidth) w = even(w);
  if (h > 1 && h < imageHeight) h = even(h);
  w = Math.max(1, w);
  h = Math.max(1, h);
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const x = Math.max(0, Math.min(imageWidth - w, Math.round(cx - w / 2)));
  const y = Math.max(0, Math.min(imageHeight - h, Math.round(cy - h / 2)));

  let outW = w;
  let outH = h;
  const longest = Math.max(w, h);
  if (o.maxSizePx > 0 && longest > o.maxSizePx) {
    const s = o.maxSizePx / longest;
    outW = Math.max(2, even(Math.round(w * s)));
    outH = Math.max(2, even(Math.round(h * s)));
  }
  return { x, y, w, h, outW, outH };
}

/** Map a box from source coordinates into the coordinates of the crop produced for `rect`. */
export function boxInCrop(box: FaceBoxXYXY, rect: CropRect): [number, number, number, number] {
  const sx = rect.outW / rect.w;
  const sy = rect.outH / rect.h;
  return [(box[0] - rect.x) * sx, (box[1] - rect.y) * sy, (box[2] - rect.x) * sx, (box[3] - rect.y) * sy];
}

/** Copy an RGB24 sub-rectangle into a new tightly packed buffer. */
export function sliceRgb(rgb: Uint8Array, width: number, height: number, rect: CropRect): Uint8Array | null {
  if (rgb.length < width * height * 3) return null;
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > width || rect.y + rect.h > height) return null;
  const out = new Uint8Array(rect.w * rect.h * 3);
  const rowBytes = rect.w * 3;
  for (let row = 0; row < rect.h; row++) {
    const src = ((rect.y + row) * width + rect.x) * 3;
    out.set(rgb.subarray(src, src + rowBytes), row * rowBytes);
  }
  return out;
}

function log(msg: string): void {
  console.warn(`[faceCrop] ${msg}`);
}

/** Run ffmpeg with `stdin`, collect stdout; null on failure, non-JPEG output or timeout (SIGKILL). */
function runFfmpeg(args: string[], stdin: Uint8Array, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: Buffer | null, why?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!value && why) log(`crop failed (${why})`);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, { stdio: ["pipe", "pipe", "ignore"] });
    } catch (err) {
      finish(null, `spawn: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const chunks: Buffer[] = [];
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(null, `timeout after ${timeoutMs}ms`);
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (err) => finish(null, `spawn: ${err.message}`));
    child.on("close", (code) => {
      const out = Buffer.concat(chunks);
      const isJpeg = out.length > 4 && out[0] === 0xff && out[1] === 0xd8;
      if (code !== 0 || !isJpeg) finish(null, `exit code ${code}, ${out.length} bytes`);
      else finish(out);
    });
    child.stdin?.on("error", () => {
      /* EPIPE when ffmpeg rejects the input early */
    });
    child.stdin?.end(stdin);
  });
}

function encoderArgs(rect: CropRect, o: ResolvedFaceCropOptions, cropFilter: string | null): string[] {
  const filters: string[] = [];
  if (cropFilter) filters.push(cropFilter);
  if (rect.outW !== rect.w || rect.outH !== rect.h) filters.push(`scale=${rect.outW}:${rect.outH}:flags=area`);
  filters.push("format=yuvj420p");
  return ["-vf", filters.join(","), "-frames:v", "1", "-q:v", String(o.qscale), "-f", "mjpeg", "pipe:1"];
}

/** Packed RGB24 picture: a pipeline Frame or anything with the same three fields. */
export interface RgbPicture {
  width: number;
  height: number;
  rgb: Uint8Array;
}

/**
 * JPEG crop around `box` (picture pixel coordinates, [x1, y1, x2, y2]) from a
 * raw RGB24 picture. For a pipeline `Frame`, the box is in FRAME coordinates
 * (the ROI), which is exactly what the detector returns. Only the crop's pixels
 * are piped to ffmpeg, not the whole frame.
 */
export async function cropFaceFromRgb(
  picture: RgbPicture | Frame,
  box: FaceBoxXYXY,
  opts: FaceCropOptions = {},
): Promise<Buffer | null> {
  try {
    if (!picture || !(picture.rgb instanceof Uint8Array)) return null;
    const rect = computeFaceCropRect(box, picture.width, picture.height, opts);
    if (!rect) return null;
    const pixels = sliceRgb(picture.rgb, picture.width, picture.height, rect);
    if (!pixels) return null;
    const o = resolveFaceCropOptions(opts);
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${rect.w}x${rect.h}`, "-i", "pipe:0",
      ...encoderArgs(rect, o, null),
    ];
    return await runFfmpeg(args, pixels, o.timeoutMs);
  } catch (err) {
    log(`cropFaceFromRgb: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function decodeImageInput(input: Buffer | Uint8Array | string): Buffer | null {
  if (Buffer.isBuffer(input)) return input.length ? input : null;
  if (input instanceof Uint8Array) return input.length ? Buffer.from(input) : null;
  if (typeof input !== "string") return null;
  const s = input.trim();
  const comma = s.startsWith("data:") ? s.indexOf(",") : -1;
  const b64 = comma >= 0 ? s.slice(comma + 1) : s;
  if (!b64) return null;
  const buf = Buffer.from(b64, "base64");
  return buf.length ? buf : null;
}

/** Width/height from a JPEG SOFn or PNG IHDR header; null for anything else. */
export function encodedImageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = buf[off + 1];
    if (marker === 0xff) {
      off++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = buf.readUInt16BE(off + 5);
      const width = buf.readUInt16BE(off + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    off += 2 + len;
  }
  return null;
}

/**
 * JPEG crop around `box` (source pixel coordinates) from an encoded JPEG/PNG,
 * given as bytes, base64 or a `data:image/...` URL. Used to back-fill crops
 * for events that only stored a frame.
 */
export async function cropFaceFromImage(
  input: Buffer | Uint8Array | string,
  box: FaceBoxXYXY,
  opts: FaceCropOptions = {},
): Promise<Buffer | null> {
  try {
    const buf = decodeImageInput(input);
    if (!buf) return null;
    const size = encodedImageSize(buf);
    if (!size) return null;
    const rect = computeFaceCropRect(box, size.width, size.height, opts);
    if (!rect) return null;
    const o = resolveFaceCropOptions(opts);
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", "image2pipe", "-i", "pipe:0",
      ...encoderArgs(rect, o, `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`),
    ];
    return await runFfmpeg(args, buf, o.timeoutMs);
  } catch (err) {
    log(`cropFaceFromImage: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** `data:image/jpeg;base64,...` for a crop, the format access logs store today. */
export function cropToDataUrl(jpeg: Buffer): string {
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}
