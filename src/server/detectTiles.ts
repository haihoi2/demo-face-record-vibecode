/**
 * Tiled face detection for large door-scan frames (Taiga #523). Pure: no I/O,
 * no ONNX Runtime, no env. faceEmbedding.ts decides WHEN to tile (the
 * FACE_DETECT_TILES flag plus the size rule below) and runs the detector on
 * each tile; this module plans the tiles, cuts them and merges the results.
 *
 * Why: the 4K ENTRY frame (3840x2160) letterboxed into the 640 detector square
 * is shrunk 6x, so a 62-99 px face becomes ~10-16 px for SCRFD and 4 % of the
 * faces >= 60 px are missed (docs/plans/2026-11-03-engine-comparison.md 9.5).
 * Two horizontal tiles with 10 % overlap, each letterboxed to 640 on its own,
 * show the detector every face at ~1.9x the pixels: 99.0 % recall vs the 1280
 * reference, landmark error p50 1.7 % instead of 3.3 %, at about 2.2x the time
 * of the single pass.
 *
 * SIZE RULE (shouldTileFrame): a frame is tiled only when its longest side is
 * at least TILE_MIN_FRAME_FACTOR (4) x the detector input side. With the 640
 * input that is 2560 px: 4K frames tile, while 1080p exit frames, uploads,
 * enrolment pictures and crops keep the single pass they have today (a 1920 px
 * frame is only shrunk 3x and each of its tiles would be ~1056 px, close to a
 * plain 640 pass in gain but double the cost; the measurements of 9.5 were made
 * on 4K frames only).
 *
 * SEAM RULE (mergeTileDetections): detections are shifted back to frame pixels
 * and merged with the engine's own NMS (suppress IoU > threshold, highest
 * score first). Before NMS, a detection whose box reaches a tile's INNER edge
 * (the seam side; outer frame edges do not count) is treated as cut by the
 * seam and dropped when a detection from another tile covers more than half of
 * it and is either whole (not cut) or better scored. So a face narrower than
 * the overlap that straddles the seam is kept once, from the tile that sees it
 * whole, even when the clipped copy in the other tile scored higher and
 * overlaps it too little for plain NMS; a face wider than the overlap is kept
 * once from the better-scored tile with the box clipped at that tile's edge.
 */

import type { RgbImage } from "./faceEmbedding";

export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Detections as this module needs them; FaceBox satisfies it. */
export interface TileFace {
  box: readonly number[];
  score: number;
  landmarks: ReadonlyArray<readonly [number, number]>;
}

/** Tile only frames whose longest side is at least this many times the detector input side. */
export const TILE_MIN_FRAME_FACTOR = 4;

/** Highest FACE_DETECT_TILES value accepted (only 1 and 2 are measured; see the module header). */
export const MAX_DETECT_TILES = 2;

/** Default FACE_DETECT_TILE_OVERLAP: neighbouring tiles share 10 % of the frame width. */
export const DEFAULT_TILE_OVERLAP = 0.1;

/** How close (px) a box must come to a tile's inner edge to count as cut by the seam. */
const SEAM_EPS = 2;

export interface DetectTilesConfig {
  /** 1 = single pass (today's behaviour), 2 = left/right halves. */
  tiles: number;
  /** Fraction of the frame width shared by neighbouring tiles, [0, 0.5). */
  overlap: number;
  /** Set when a value was not accepted and the default was used instead (operator-facing). */
  invalid?: string;
}

/**
 * Parse FACE_DETECT_TILES / FACE_DETECT_TILE_OVERLAP from an env. Blank = the
 * defaults (1, 0.10). A value that is not an integer in 1..MAX_DETECT_TILES or an
 * overlap outside [0, 0.5) falls back to the default FOR THAT VALUE and is
 * reported in `invalid`, so a typo can never switch the door scan to an
 * unmeasured configuration silently.
 */
export function parseDetectTiles(env: NodeJS.ProcessEnv = process.env): DetectTilesConfig {
  const issues: string[] = [];
  let tiles = 1;
  const rawTiles = (env.FACE_DETECT_TILES ?? "").trim();
  if (rawTiles !== "") {
    const n = Number(rawTiles);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_DETECT_TILES) tiles = n;
    else issues.push(`FACE_DETECT_TILES: expected 1..${MAX_DETECT_TILES}, using 1`);
  }
  let overlap = DEFAULT_TILE_OVERLAP;
  const rawOverlap = (env.FACE_DETECT_TILE_OVERLAP ?? "").trim();
  if (rawOverlap !== "") {
    const f = Number(rawOverlap);
    if (Number.isFinite(f) && f >= 0 && f < 0.5) overlap = f;
    else issues.push(`FACE_DETECT_TILE_OVERLAP: expected a fraction in [0, 0.5), using ${DEFAULT_TILE_OVERLAP}`);
  }
  return issues.length ? { tiles, overlap, invalid: issues.join("; ") } : { tiles, overlap };
}

/** The size rule of the module header. `inputSide` is the detector square side (FACE_DETECT_SIZE). */
export function shouldTileFrame(width: number, height: number, inputSide: number, tiles: number): boolean {
  if (!(tiles > 1) || !(inputSide > 0)) return false;
  return Math.max(width, height) >= TILE_MIN_FRAME_FACTOR * inputSide;
}

/**
 * Horizontal tiling of a frame into `tiles` side-by-side windows whose
 * neighbours overlap by `overlapFrac` of the frame width (a face on the seam is
 * whole in at least one tile when it is narrower than the overlap). Each tile
 * is then letterboxed to the detector's square on its own, so a 3840x2160 frame
 * split in two gives 2112x2160 tiles at ~1:1 and the detector sees the faces
 * roughly twice as large as on the full frame at the same input size.
 */
export function tilePlan(width: number, height: number, tiles = 2, overlapFrac = DEFAULT_TILE_OVERLAP): TileRect[] {
  if (!Number.isInteger(tiles) || tiles < 1 || tiles > 8) throw new Error(`tilePlan: tiles must be 1..8, got ${tiles}`);
  if (!(overlapFrac >= 0 && overlapFrac < 0.5)) throw new Error(`tilePlan: overlap must be in [0, 0.5), got ${overlapFrac}`);
  if (tiles === 1) return [{ x: 0, y: 0, w: width, h: height }];
  const overlap = Math.round(width * overlapFrac);
  const w = Math.ceil((width + overlap * (tiles - 1)) / tiles);
  const out: TileRect[] = [];
  for (let i = 0; i < tiles; i++) {
    const x = i === tiles - 1 ? width - w : i * (w - overlap);
    out.push({ x: Math.max(0, x), y: 0, w: Math.min(w, width), h: height });
  }
  return out;
}

/** Pixel-exact window of an RGB HWC image. */
export function cropRgb(img: RgbImage, r: TileRect): RgbImage {
  if (r.x < 0 || r.y < 0 || r.w < 1 || r.h < 1 || r.x + r.w > img.width || r.y + r.h > img.height) throw new Error(`cropRgb: ${JSON.stringify(r)} outside ${img.width}x${img.height}`);
  const data = new Uint8Array(r.w * r.h * 3);
  for (let y = 0; y < r.h; y++) data.set(img.data.subarray(((r.y + y) * img.width + r.x) * 3, ((r.y + y) * img.width + r.x + r.w) * 3), y * r.w * 3);
  return { width: r.w, height: r.h, data };
}

export function iouBox(a: readonly number[], b: readonly number[]): number {
  const inter = interArea(a, b);
  const ua = boxArea(a) + boxArea(b) - inter;
  return ua > 0 ? inter / ua : 0;
}

function boxArea(a: readonly number[]): number {
  return Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
}

function interArea(a: readonly number[], b: readonly number[]): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

/** Greedy NMS by score (same rule as faceEmbedding.ts nms: suppress IoU > threshold), ties by input order. */
export function nmsFaces<F extends TileFace>(faces: F[], iouThreshold: number): F[] {
  const order = faces.map((_, i) => i).sort((i, j) => faces[j].score - faces[i].score || i - j);
  const keep: F[] = [];
  const suppressed = new Uint8Array(faces.length);
  for (const i of order) {
    if (suppressed[i]) continue;
    keep.push(faces[i]);
    for (const j of order) if (j !== i && !suppressed[j] && iouBox(faces[i].box, faces[j].box) > iouThreshold) suppressed[j] = 1;
  }
  return keep;
}

/** Shift one tile's detection into frame coordinates (box and landmarks). */
function shiftFace<F extends TileFace>(f: F, dx: number, dy: number): F {
  return {
    ...f,
    box: [f.box[0] + dx, f.box[1] + dy, f.box[2] + dx, f.box[3] + dy] as F["box"],
    landmarks: f.landmarks.map(([px, py]) => [px + dx, py + dy] as const) as F["landmarks"],
  };
}

/** True when a box (in tile coordinates) reaches an inner edge of its tile (see SEAM RULE). */
function cutBySeam(box: readonly number[], r: TileRect, frameW: number, frameH: number): boolean {
  if (r.x > 0 && box[0] <= SEAM_EPS) return true;
  if (r.x + r.w < frameW && box[2] >= r.w - SEAM_EPS) return true;
  if (r.y > 0 && box[1] <= SEAM_EPS) return true;
  if (r.y + r.h < frameH && box[3] >= r.h - SEAM_EPS) return true;
  return false;
}

/**
 * Detections of each tile (in tile coordinates) shifted back to frame
 * coordinates and merged (SEAM RULE, then the engine's NMS), highest score
 * first. The frame extent is the union of the tiles.
 */
export function mergeTileDetections<F extends TileFace>(perTile: F[][], rects: TileRect[], iouThreshold = 0.4): F[] {
  if (perTile.length !== rects.length) throw new Error(`mergeTileDetections: ${perTile.length} tile results for ${rects.length} tiles`);
  if (rects.length === 1) return nmsFaces(perTile[0].map((f) => shiftFace(f, rects[0].x, rects[0].y)), iouThreshold);
  const frameW = Math.max(...rects.map((r) => r.x + r.w));
  const frameH = Math.max(...rects.map((r) => r.y + r.h));
  const all: Array<{ face: F; tile: number; cut: boolean }> = [];
  perTile.forEach((faces, t) => {
    const r = rects[t];
    for (const f of faces) all.push({ face: shiftFace(f, r.x, r.y), tile: t, cut: cutBySeam(f.box, r, frameW, frameH) });
  });
  const survivors: F[] = [];
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    let dropped = false;
    if (c.cut) {
      const area = boxArea(c.face.box);
      for (let j = 0; j < all.length && !dropped; j++) {
        const o = all[j];
        if (o.tile === c.tile) continue;
        const cover = area > 0 ? interArea(c.face.box, o.face.box) / area : 0;
        if (cover <= 0.5) continue;
        if (!o.cut || o.face.score > c.face.score || (o.face.score === c.face.score && j < i)) dropped = true;
      }
    }
    if (!dropped) survivors.push(c.face);
  }
  return nmsFaces(survivors, iouThreshold);
}
