/**
 * Gate area (ROI) of one camera stream: the part of the picture the pipeline
 * decodes and searches for faces. Stored as fractions of the picture (0..1) so
 * it survives a change of stream resolution:
 *
 *   roi: { x, y, w, h }   // x/y = top-left corner, w/h = size, all 0..1
 *
 * No area (or the whole picture) means "use the full frame". The backend is the
 * authority: these helpers only shape and clamp what the operator draws.
 */

export interface GateArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

export const FULL_GATE_AREA: GateArea = { x: 0, y: 0, w: 1, h: 1 };
/** Smallest side of an area, as a fraction of the picture (5 %). */
export const MIN_GATE_AREA_SIDE = 0.05;
/** Stored precision: 4 decimals = 0.4 px on a 3840 px wide picture. */
const PRECISION = 10_000;

const round = (n: number) => Math.round(n * PRECISION) / PRECISION;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Accepts `{x,y,w,h}` or `[x,y,w,h]` (fractions), clamps it inside the picture
 * and enforces the minimum size. Returns null for anything unusable (missing,
 * non-numeric, zero or negative size), so a malformed server value never
 * becomes a silently different area.
 */
export function normalizeGateArea(raw: unknown): GateArea | null {
  let x: unknown, y: unknown, w: unknown, h: unknown;
  if (Array.isArray(raw)) {
    [x, y, w, h] = raw;
  } else if (raw && typeof raw === "object") {
    ({ x, y, w, h } = raw as Record<string, unknown>);
  } else {
    return null;
  }
  const nums = [x, y, w, h].map((v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v));
  if (!nums.every(finite)) return null;
  let [nx, ny, nw, nh] = nums as number[];
  if (nw <= 0 || nh <= 0) return null;

  nx = clamp01(nx);
  ny = clamp01(ny);
  nw = Math.min(1, Math.max(MIN_GATE_AREA_SIDE, nw));
  nh = Math.min(1, Math.max(MIN_GATE_AREA_SIDE, nh));
  // Keep the size, move the corner back inside the picture.
  if (nx + nw > 1) nx = 1 - nw;
  if (ny + nh > 1) ny = 1 - nh;
  return { x: round(nx), y: round(ny), w: round(nw), h: round(nh) };
}

/** Pointer position inside an element, as fractions clamped to 0..1. */
export function pointerToNormalized(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number }
): NormalizedPoint {
  if (!(rect.width > 0) || !(rect.height > 0)) return { x: 0, y: 0 };
  return {
    x: clamp01((clientX - rect.left) / rect.width),
    y: clamp01((clientY - rect.top) / rect.height),
  };
}

/** The rectangle spanned by two drag points (any direction), normalised. */
export function gateAreaFromPoints(a: NormalizedPoint, b: NormalizedPoint): GateArea {
  const x0 = clamp01(Math.min(a.x, b.x));
  const y0 = clamp01(Math.min(a.y, b.y));
  const x1 = clamp01(Math.max(a.x, b.x));
  const y1 = clamp01(Math.max(a.y, b.y));
  return normalizeGateArea({ x: x0, y: y0, w: x1 - x0 || MIN_GATE_AREA_SIDE, h: y1 - y0 || MIN_GATE_AREA_SIDE })!;
}

/** True when the area covers (practically) the whole picture. */
export function isFullFrame(area: GateArea | null | undefined): boolean {
  if (!area) return true;
  const eps = 0.001;
  return area.x <= eps && area.y <= eps && area.w >= 1 - eps && area.h >= 1 - eps;
}

export function gateAreasEqual(a: GateArea | null | undefined, b: GateArea | null | undefined): boolean {
  if (isFullFrame(a) && isFullFrame(b)) return true;
  if (!a || !b) return false;
  const eps = 0.0002;
  return (
    Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.w - b.w) < eps && Math.abs(a.h - b.h) < eps
  );
}

/**
 * Keyboard editing: arrows move the area by `step`; with `resize` they change
 * its width (left/right) and height (up/down) instead. Result stays inside.
 */
export function nudgeGateArea(
  area: GateArea,
  direction: "left" | "right" | "up" | "down",
  step: number,
  resize: boolean
): GateArea {
  const d = direction === "left" || direction === "up" ? -step : step;
  const horizontal = direction === "left" || direction === "right";
  if (resize) {
    const next = horizontal ? { ...area, w: area.w + d } : { ...area, h: area.h + d };
    // Growing past the edge: keep the corner and cap the size.
    next.w = Math.min(next.w, 1 - next.x);
    next.h = Math.min(next.h, 1 - next.y);
    return normalizeGateArea(next)!;
  }
  const moved = horizontal ? { ...area, x: Math.max(0, area.x + d) } : { ...area, y: Math.max(0, area.y + d) };
  return normalizeGateArea(moved)!;
}

/** The area in source pixels, for "≈ 1920 × 1080 px" hints. */
export function gateAreaToPixels(
  area: GateArea,
  width: number,
  height: number
): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.round(area.x * width),
    y: Math.round(area.y * height),
    w: Math.round(area.w * width),
    h: Math.round(area.h * height),
  };
}

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

/** "Toàn khung hình" or "từ trái 12.5%, từ trên 10% · rộng 50%, cao 60%". */
export function formatGateArea(area: GateArea | null | undefined): string {
  if (!area || isFullFrame(area)) return "Toàn khung hình";
  return `từ trái ${pct(area.x)}, từ trên ${pct(area.y)} · rộng ${pct(area.w)}, cao ${pct(area.h)}`;
}

/** Percent strings for absolutely positioning the area over the picture. */
export function gateAreaStyle(area: GateArea): { left: string; top: string; width: string; height: string } {
  return { left: pct(area.x), top: pct(area.y), width: pct(area.w), height: pct(area.h) };
}

/** Parses the numeric editor's percent inputs (0-100) into an area. */
export function gateAreaFromPercentInputs(values: {
  x: string | number;
  y: string | number;
  w: string | number;
  h: string | number;
}): GateArea | null {
  const toFraction = (v: string | number) => {
    const n = typeof v === "number" ? v : Number(String(v).replace(",", ".").trim());
    return String(v).trim() === "" || !Number.isFinite(n) ? NaN : n / 100;
  };
  return normalizeGateArea({
    x: toFraction(values.x),
    y: toFraction(values.y),
    w: toFraction(values.w),
    h: toFraction(values.h),
  });
}

/** The area as percent strings for the numeric inputs. */
export function gateAreaToPercentInputs(area: GateArea): { x: string; y: string; w: string; h: string } {
  const p = (n: number) => String(Math.round(n * 1000) / 10);
  return { x: p(area.x), y: p(area.y), w: p(area.w), h: p(area.h) };
}

/**
 * The saved area of a stream, read defensively from the config payload
 * (`roi` is optional; a server that does not know it simply omits it).
 */
export function streamGateArea(stream: unknown): GateArea | null {
  if (!stream || typeof stream !== "object") return null;
  const area = normalizeGateArea((stream as { roi?: unknown }).roi);
  return area && !isFullFrame(area) ? area : null;
}

/** Request body for PUT /api/camera-streams/:gate/streams/:id - null clears the area. */
export function gateAreaRequestBody(area: GateArea | null): { roi: GateArea | null } {
  const normalized = area ? normalizeGateArea(area) : null;
  return { roi: normalized && !isFullFrame(normalized) ? normalized : null };
}
