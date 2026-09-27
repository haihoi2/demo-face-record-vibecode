/**
 * Detector input geometry for the real-time pipeline (PIPELINE_DETECT_INPUT).
 *
 * The problem (rc2 sign-off, P1): a gate area is a wide, short strip (entry:
 * 3408x456 of the 4K picture). Letterboxed into the detector's 640x640 square
 * it is scaled by 640/3408 = 0.19, so a 60 px face reaches SCRFD at ~11 px and
 * is not found. This module decides HOW the strip is presented to the detector;
 * the pixels, the size floor (60 px in SOURCE pixels) and the legacy engine's
 * defaults are untouched.
 *
 *   PIPELINE_DETECT_INPUT
 *     ""/"square"   legacy: FACE_DETECT_SIZE square letterbox (default, unchanged)
 *     "auto"        aspect-preserving shape within the 640x640 pixel budget
 *                   (e.g. 3408x456 -> 1824x224, scale 0.49 instead of 0.19)
 *     "auto:<n>"    same, pixel budget n x n (320..2560)
 *     "<W>x<H>"     fixed shape, multiples of 32 (needs a detector graph with
 *                   dynamic H/W, or one exported at exactly that shape)
 *     "tiles:<n>"   n overlapping tiles along the long axis, each letterboxed
 *                   into the square; works with the static INT8 export
 *     "tiles:<n>:<overlap%>"  same with an explicit overlap (0..50, default 20)
 *
 * Pure functions, deterministic, no I/O: the worker binds them to the engine
 * in onnxEngine.ts. Coordinates returned to the caller are always FRAME pixels
 * (= source pixels of the gate area), as detectFaces() returns them.
 */
import { iou, nms, type FaceBox, type RgbImage } from "../faceEmbedding";

export const DETECT_STRIDE = 32;
export const DEFAULT_DETECT_BUDGET_SIDE = 640;
export const DEFAULT_TILE_OVERLAP = 0.2;

export type DetectInputPlan =
  | { kind: "square" }
  | { kind: "auto"; budgetPx: number }
  | { kind: "fixed"; width: number; height: number }
  | { kind: "tiles"; count: number; overlap: number };

export interface DetectShape {
  width: number;
  height: number;
  /** frame -> detector scale the letterbox will apply (min over both axes, <= 1). */
  scale: number;
}

export interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ceilStride = (v: number) => Math.max(DETECT_STRIDE, Math.ceil(v / DETECT_STRIDE) * DETECT_STRIDE);
const floorStride = (v: number) => Math.floor(v / DETECT_STRIDE) * DETECT_STRIDE;

/**
 * Parses the setting. Blank means the legacy square. An unparseable value is an
 * ERROR (returned, not thrown): the worker then fails closed instead of quietly
 * running the geometry that lost every entry face.
 */
export function parseDetectInput(raw: string | undefined | null): { plan: DetectInputPlan; error?: string } {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "" || v === "square") return { plan: { kind: "square" } };
  if (v === "auto") return { plan: { kind: "auto", budgetPx: DEFAULT_DETECT_BUDGET_SIDE * DEFAULT_DETECT_BUDGET_SIDE } };
  let m = /^auto:(\d{3,4})$/.exec(v);
  if (m) {
    const side = Number(m[1]);
    if (side < 320 || side > 2560 || side % DETECT_STRIDE !== 0) return invalid(raw, "auto:<n> needs 320..2560, a multiple of 32");
    return { plan: { kind: "auto", budgetPx: side * side } };
  }
  m = /^(\d{2,4})x(\d{2,4})$/.exec(v);
  if (m) {
    const width = Number(m[1]);
    const height = Number(m[2]);
    const ok = (n: number) => n >= DETECT_STRIDE && n <= 4096 && n % DETECT_STRIDE === 0;
    if (!ok(width) || !ok(height)) return invalid(raw, "<W>x<H> needs multiples of 32 in 32..4096");
    return { plan: { kind: "fixed", width, height } };
  }
  m = /^tiles:(\d{1,2})(?::(\d{1,2}))?$/.exec(v);
  if (m) {
    const count = Number(m[1]);
    const overlap = m[2] === undefined ? DEFAULT_TILE_OVERLAP : Number(m[2]) / 100;
    if (count < 2 || count > 12) return invalid(raw, "tiles:<n> needs 2..12");
    if (overlap < 0 || overlap > 0.5) return invalid(raw, "tile overlap needs 0..50 (percent)");
    return { plan: { kind: "tiles", count, overlap } };
  }
  return invalid(raw, 'expected "", "square", "auto", "auto:<n>", "<W>x<H>" or "tiles:<n>[:<overlap%>]"');
}

function invalid(raw: unknown, why: string): { plan: DetectInputPlan; error: string } {
  return { plan: { kind: "square" }, error: `PIPELINE_DETECT_INPUT=${JSON.stringify(String(raw ?? "")).slice(0, 40)}: ${why}` };
}

export function describeDetectInput(plan: DetectInputPlan): string {
  switch (plan.kind) {
    case "square":
      return "square";
    case "auto":
      return plan.budgetPx === DEFAULT_DETECT_BUDGET_SIDE * DEFAULT_DETECT_BUDGET_SIDE ? "auto" : `auto:${Math.round(Math.sqrt(plan.budgetPx))}`;
    case "fixed":
      return `${plan.width}x${plan.height}`;
    case "tiles":
      return `tiles:${plan.count}:${Math.round(plan.overlap * 100)}`;
  }
}

/**
 * The detector shape for a frame of `frameW` x `frameH`: both sides multiples
 * of 32, width x height <= budgetPx, never larger than the frame (no upscale),
 * chosen to MAXIMISE the letterbox scale min(W/frameW, H/frameH); then each
 * side is trimmed to the smallest multiple of 32 that still holds the scaled
 * picture (padding costs compute and finds nothing). Deterministic.
 *
 *   3408x456 (NVR entry area)   -> 1696x224, scale 0.491 (square 640: 0.188)
 *   2074x432 (scripted entry)   -> 1408x288, scale 0.667 (square 640: 0.309)
 *   1777x681 (exit area)        -> 1024x384, scale 0.564 (square 640: 0.360)
 *   640x360                     ->  640x384, scale 1 (fits the budget whole)
 */
export function deriveDetectShape(frameW: number, frameH: number, budgetPx = DEFAULT_DETECT_BUDGET_SIDE * DEFAULT_DETECT_BUDGET_SIDE): DetectShape {
  const fw = Math.max(1, Math.floor(frameW));
  const fh = Math.max(1, Math.floor(frameH));
  const budget = Math.max(DETECT_STRIDE * DETECT_STRIDE, Math.floor(budgetPx));
  const maxW = ceilStride(fw);
  const maxH = ceilStride(fh);
  let best: DetectShape | null = null;
  for (let h = DETECT_STRIDE; h <= maxH; h += DETECT_STRIDE) {
    const w = Math.min(maxW, floorStride(budget / h));
    if (w < DETECT_STRIDE) break;
    const scale = Math.min(1, w / fw, h / fh);
    if (!best || scale > best.scale + 1e-9) best = { width: w, height: h, scale };
  }
  if (!best) {
    // Unreachable in practice (budget >= 32x32 and h starts at 32); keeps the type honest.
    return { width: DETECT_STRIDE, height: DETECT_STRIDE, scale: Math.min(1, DETECT_STRIDE / fw, DETECT_STRIDE / fh) };
  }
  // Trim each side to the smallest stride multiple holding the scaled picture (never
  // grows, so the budget holds; the limiting side is unchanged, so the scale holds).
  const eps = 1e-6;
  const width = Math.min(best.width, ceilStride(fw * best.scale - eps));
  const height = Math.min(best.height, ceilStride(fh * best.scale - eps));
  return { width, height, scale: Math.min(1, width / fw, height / fh) };
}

/** The letterbox scale the legacy square path applies to this frame (for reports). */
export function squareScale(frameW: number, frameH: number, size: number): number {
  return Math.min(1, size / Math.max(1, frameW), size / Math.max(1, frameH));
}

/**
 * `count` tiles along the frame's long axis, each `overlap` (fraction of a
 * tile) shared with its neighbour; the other axis is taken whole. Tiles are
 * integer, inside the frame, cover it completely, and the last one ends at the
 * edge. count 1 is the whole frame.
 */
export function tileGeometry(frameW: number, frameH: number, count: number, overlap = DEFAULT_TILE_OVERLAP): Tile[] {
  const fw = Math.max(1, Math.floor(frameW));
  const fh = Math.max(1, Math.floor(frameH));
  const n = Math.max(1, Math.floor(count));
  const ov = Math.min(0.5, Math.max(0, overlap));
  if (n === 1) return [{ x: 0, y: 0, w: fw, h: fh }];
  const horizontal = fw >= fh;
  const length = horizontal ? fw : fh;
  const tileLen = Math.min(length, Math.ceil(length / (n - (n - 1) * ov)));
  const step = n > 1 ? (length - tileLen) / (n - 1) : 0;
  const tiles: Tile[] = [];
  for (let i = 0; i < n; i++) {
    const start = i === n - 1 ? length - tileLen : Math.round(i * step);
    tiles.push(horizontal ? { x: start, y: 0, w: tileLen, h: fh } : { x: 0, y: start, w: fw, h: tileLen });
  }
  return tiles;
}

/** Copies a tile out of an RGB frame (row-wise; the frame is left untouched). */
export function cropRgb(img: RgbImage, tile: Tile): RgbImage {
  const x0 = Math.max(0, Math.min(img.width, Math.floor(tile.x)));
  const y0 = Math.max(0, Math.min(img.height, Math.floor(tile.y)));
  const w = Math.max(0, Math.min(img.width - x0, Math.floor(tile.w)));
  const h = Math.max(0, Math.min(img.height - y0, Math.floor(tile.h)));
  if (x0 === 0 && y0 === 0 && w === img.width && h === img.height) return img;
  const out = new Uint8Array(w * h * 3);
  const rowBytes = w * 3;
  for (let y = 0; y < h; y++) {
    const s = ((y0 + y) * img.width + x0) * 3;
    out.set(img.data.subarray(s, s + rowBytes), y * rowBytes);
  }
  return { width: w, height: h, data: out };
}

/** Tile-local detections -> frame coordinates (box and landmarks shifted by the tile origin). */
export function mapFromTile(faces: ReadonlyArray<FaceBox>, tile: Tile): FaceBox[] {
  return faces.map((f) => ({
    box: [f.box[0] + tile.x, f.box[1] + tile.y, f.box[2] + tile.x, f.box[3] + tile.y] as [number, number, number, number],
    score: f.score,
    landmarks: f.landmarks.map((p) => [p[0] + tile.x, p[1] + tile.y] as [number, number]),
  }));
}

/**
 * Merges detections of overlapping tiles: the detector's NMS (IoU) first, then
 * a containment rule for the face that one tile saw whole and its neighbour
 * saw cut at the tile edge (small IoU, but the cut box lies almost entirely
 * inside the whole one). Output is ordered by score, highest first.
 */
export function mergeTileDetections(faces: ReadonlyArray<FaceBox>, iouThreshold: number, containThreshold = 0.6): FaceBox[] {
  if (faces.length <= 1) return faces.slice();
  const keep = nms(faces.map((f) => f.box), faces.map((f) => f.score), iouThreshold).map((i) => faces[i]);
  const out: FaceBox[] = [];
  for (const f of keep) {
    const area = boxArea(f.box);
    const swallowed = out.some((k) => {
      const inter = intersection(f.box, k.box);
      return area > 0 && inter / Math.min(area, boxArea(k.box)) > containThreshold;
    });
    if (!swallowed) out.push(f);
  }
  return out;
}

function boxArea(b: readonly number[]): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}
function intersection(a: readonly number[], b: readonly number[]): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

export type DetectFn = (img: RgbImage, options?: { inputShape?: { width: number; height: number } }) => Promise<FaceBox[]>;

/** How one frame was presented to the detector (for stats/logs; no pixels). */
export interface DetectRunInfo {
  plan: string;
  /** e.g. "1824x224 (scale 0.49)" or "4 tiles of 1150x456 -> 640" */
  input: string;
  runs: number;
}

/**
 * Runs a plan on one frame with the given detector function. `square` and
 * `tiles` call the detector without a shape (its FACE_DETECT_SIZE square);
 * `auto`/`fixed` pass the shape. Returns frame-coordinate faces.
 */
export async function detectWithPlan(
  detect: DetectFn,
  img: RgbImage,
  plan: DetectInputPlan,
  opts: { squareSize: number; nmsIou: number },
): Promise<{ faces: FaceBox[]; info: DetectRunInfo }> {
  const name = describeDetectInput(plan);
  switch (plan.kind) {
    case "square": {
      const faces = await detect(img);
      return { faces, info: { plan: name, input: `${opts.squareSize}x${opts.squareSize} (scale ${squareScale(img.width, img.height, opts.squareSize).toFixed(2)})`, runs: 1 } };
    }
    case "auto": {
      const s = deriveDetectShape(img.width, img.height, plan.budgetPx);
      const faces = await detect(img, { inputShape: { width: s.width, height: s.height } });
      return { faces, info: { plan: name, input: `${s.width}x${s.height} (scale ${s.scale.toFixed(2)})`, runs: 1 } };
    }
    case "fixed": {
      const scale = Math.min(1, plan.width / img.width, plan.height / img.height);
      const faces = await detect(img, { inputShape: { width: plan.width, height: plan.height } });
      return { faces, info: { plan: name, input: `${plan.width}x${plan.height} (scale ${scale.toFixed(2)})`, runs: 1 } };
    }
    case "tiles": {
      const tiles = tileGeometry(img.width, img.height, plan.count, plan.overlap);
      const all: FaceBox[] = [];
      for (const t of tiles) {
        const found = await detect(cropRgb(img, t));
        all.push(...mapFromTile(found, t));
      }
      const t0 = tiles[0];
      const faces = mergeTileDetections(all, opts.nmsIou);
      return {
        faces,
        info: { plan: name, input: `${tiles.length} tiles of ${t0.w}x${t0.h} -> ${opts.squareSize} (scale ${squareScale(t0.w, t0.h, opts.squareSize).toFixed(2)})`, runs: tiles.length },
      };
    }
  }
}

/**
 * Whether a plan can run on the loaded detector graph. `auto` and `fixed` need
 * dynamic H/W (or, for `fixed`, a graph exported at exactly that shape);
 * `square` and `tiles` need the graph to take the FACE_DETECT_SIZE square.
 * Returns null when compatible, else the reason (the worker fails closed on it).
 */
export function detectPlanIssue(
  plan: DetectInputPlan,
  dims: { height: number | "dynamic"; width: number | "dynamic" } | null,
  squareSize: number,
  detectorFile: string,
): string | null {
  if (!dims) return null; // unknown runtime metadata: a wrong shape still fails per frame in detectFaces
  const fixed = (w: number, h: number) => {
    const bad: string[] = [];
    if (dims.width !== "dynamic" && dims.width !== w) bad.push(`width ${w}`);
    if (dims.height !== "dynamic" && dims.height !== h) bad.push(`height ${h}`);
    return bad.length ? `${detectorFile} has a static ${dims.width}x${dims.height} input; it cannot take ${bad.join(" and ")}` : null;
  };
  switch (plan.kind) {
    case "auto":
      return dims.width === "dynamic" && dims.height === "dynamic"
        ? null
        : `PIPELINE_DETECT_INPUT=auto needs a detector with dynamic input dims; ${detectorFile} is static ${dims.width}x${dims.height} (use tiles:<n>, a dynamic INT8 export, or the FP32 detector)`;
    case "fixed":
      return fixed(plan.width, plan.height);
    case "square":
    case "tiles":
      return fixed(squareSize, squareSize);
  }
}

/** Convenience: the IoU helper is re-exported so callers do not import faceEmbedding for it. */
export { iou };
