/**
 * Cheap motion gate (step 1, STR): frame difference on a small grayscale
 * thumbnail of the gate area, so face detection can skip a still scene.
 *
 * The thumbnail is built by sampling a few points per cell (never touching
 * every source pixel), so a 4K gate area costs the same as a small one:
 * 64 x 36 cells x 9 samples = ~21k reads per frame.
 *
 * Failing open is deliberate: with no reference frame (first frame, after a
 * reconnect, size change) the scene counts as moving, and `holdMs` keeps a
 * scene "moving" for a while after the last change so a person who stops in
 * front of the gate is still looked at. A false "moving" only costs CPU; a
 * false "still" could miss a person.
 */

export interface GrayThumb {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface MotionOptions {
  /** Thumbnail width in cells (height follows the aspect ratio). Default 64. */
  thumbWidth?: number;
  /** Samples per cell side (n x n points averaged). Default 3. */
  samplesPerAxis?: number;
  /** A cell counts as changed when its gray level moves by more than this (0-255). Default 12. */
  pixelDelta?: number;
  /** Motion when at least this fraction of cells changed (0-1). Default 0.005 (0.5%). */
  threshold?: number;
  /** Keep reporting motion this long after the last change (ms). Default 2000. */
  holdMs?: number;
}

export interface MotionResult {
  /** Fraction of cells that changed versus the previous frame (0-1). */
  score: number;
  /** This frame differs noticeably from the previous one (or there was no previous one). */
  changed: boolean;
  /** `changed`, or a change happened within `holdMs` before this frame. */
  moving: boolean;
}

export const DEFAULT_MOTION_OPTIONS: Required<MotionOptions> = {
  thumbWidth: 64,
  samplesPerAxis: 3,
  pixelDelta: 12,
  threshold: 0.005,
  holdMs: 2000,
};

function positiveInt(value: unknown, fallback: number, max: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback;
}

function nonNegative(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function normalizeMotionOptions(opts: MotionOptions = {}): Required<MotionOptions> {
  const d = DEFAULT_MOTION_OPTIONS;
  return {
    thumbWidth: positiveInt(opts.thumbWidth, d.thumbWidth, 1024),
    samplesPerAxis: positiveInt(opts.samplesPerAxis, d.samplesPerAxis, 16),
    pixelDelta: Math.min(255, nonNegative(opts.pixelDelta, d.pixelDelta)),
    threshold: Math.min(1, nonNegative(opts.threshold, d.threshold)),
    holdMs: nonNegative(opts.holdMs, d.holdMs),
  };
}

/**
 * Grayscale thumbnail of a packed RGB24 picture: `targetWidth` cells across,
 * each the mean of `samplesPerAxis`^2 evenly spread samples (BT.601 luma).
 */
export function grayThumbnail(
  rgb: Uint8Array,
  width: number,
  height: number,
  targetWidth = DEFAULT_MOTION_OPTIONS.thumbWidth,
  samplesPerAxis = DEFAULT_MOTION_OPTIONS.samplesPerAxis,
): GrayThumb {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  if (w === 0 || h === 0 || rgb.length < w * h * 3) return { width: 0, height: 0, data: new Uint8Array(0) };
  const tw = Math.max(1, Math.min(w, Math.floor(targetWidth)));
  const cell = w / tw;
  const th = Math.max(1, Math.min(h, Math.round(h / cell)));
  const cellH = h / th;
  const s = Math.max(1, Math.floor(samplesPerAxis));
  const n = s * s;
  const data = new Uint8Array(tw * th);
  for (let cy = 0; cy < th; cy += 1) {
    for (let cx = 0; cx < tw; cx += 1) {
      let sum = 0;
      for (let sy = 0; sy < s; sy += 1) {
        const y = Math.min(h - 1, Math.floor((cy + (sy + 0.5) / s) * cellH));
        const row = y * w;
        for (let sx = 0; sx < s; sx += 1) {
          const x = Math.min(w - 1, Math.floor((cx + (sx + 0.5) / s) * cell));
          const i = (row + x) * 3;
          sum += (rgb[i] * 77 + rgb[i + 1] * 150 + rgb[i + 2] * 29) >> 8;
        }
      }
      data[cy * tw + cx] = Math.round(sum / n);
    }
  }
  return { width: tw, height: th, data };
}

/** Fraction (0-1) of cells whose gray level differs by more than `pixelDelta`. 1 when not comparable. */
export function motionScore(a: GrayThumb, b: GrayThumb, pixelDelta = DEFAULT_MOTION_OPTIONS.pixelDelta): number {
  if (a.width !== b.width || a.height !== b.height || a.data.length === 0) return 1;
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 1) {
    if (Math.abs(a.data[i] - b.data[i]) > pixelDelta) changed += 1;
  }
  return changed / a.data.length;
}

export interface MotionFrame {
  rgb: Uint8Array;
  width: number;
  height: number;
  capturedAtMs: number;
}

/** Compares each frame with the one fed before it. Feed frames in arrival order. */
export class MotionDetector {
  readonly options: Required<MotionOptions>;
  private previous: GrayThumb | null = null;
  private lastChangeAtMs = Number.NEGATIVE_INFINITY;

  constructor(opts: MotionOptions = {}) {
    this.options = normalizeMotionOptions(opts);
  }

  update(frame: MotionFrame): MotionResult {
    const o = this.options;
    const thumb = grayThumbnail(frame.rgb, frame.width, frame.height, o.thumbWidth, o.samplesPerAxis);
    const score = this.previous ? motionScore(thumb, this.previous, o.pixelDelta) : 1;
    this.previous = thumb;
    // `score > 0` keeps a zero threshold meaning "any changed cell", not "always".
    const changed = score > 0 && score >= o.threshold;
    if (changed) this.lastChangeAtMs = frame.capturedAtMs;
    const moving = changed || frame.capturedAtMs - this.lastChangeAtMs <= o.holdMs;
    return { score, changed, moving };
  }

  /** Forget the reference frame (e.g. after a reconnect): the next frame counts as moving. */
  reset(): void {
    this.previous = null;
    this.lastChangeAtMs = Number.NEGATIVE_INFINITY;
  }
}
