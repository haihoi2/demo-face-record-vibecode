/**
 * The gate area (ROI) of a camera stream, stored as fractions of the picture
 * so it survives resolution changes: { x, y, w, h } with 0 <= x, y;
 * 0.05 <= w, h <= 1; x + w <= 1; y + h <= 1; 4 decimals. `null` = whole
 * picture. Contract agreed with the UI's gate-area editor (feat/rt-ui).
 */
import type { Roi } from "./streamReader";

export interface GateArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_SIDE = 0.05;
const round4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * Normalises a stored/submitted value: undefined when absent or not an object
 * of numbers (field left unset), null for "whole picture" (explicit null, or an
 * area covering the whole frame), otherwise a clamped, rounded area.
 */
export function normalizeGateArea(raw: unknown): GateArea | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const nums = ["x", "y", "w", "h"].map((k) => Number(r[k]));
  if (!nums.every(Number.isFinite)) return undefined;
  let [x, y, w, h] = nums;
  w = Math.min(1, Math.max(MIN_SIDE, w));
  h = Math.min(1, Math.max(MIN_SIDE, h));
  x = Math.min(1 - w, Math.max(0, x));
  y = Math.min(1 - h, Math.max(0, y));
  const area = { x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
  if (area.x === 0 && area.y === 0 && area.w === 1 && area.h === 1) return null;
  return area;
}

/** Fractions -> source pixels [x, y, w, h] (the reader rounds to even and clamps). */
export function gateAreaToPixels(area: GateArea | null | undefined, sourceWidth: number, sourceHeight: number): Roi | null {
  if (!area) return null;
  return [
    Math.round(area.x * sourceWidth),
    Math.round(area.y * sourceHeight),
    Math.round(area.w * sourceWidth),
    Math.round(area.h * sourceHeight),
  ];
}
