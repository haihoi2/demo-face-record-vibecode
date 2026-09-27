/**
 * Display rules for captured images. New access-log and stranger rows hold a
 * small, roughly square FACE CROP (~224-300 px); rows written before the
 * real-time pipeline keep the old wide camera FRAME (16:9). One thumbnail must
 * look right for both: a crop fills its square, a frame is shown whole
 * (letter-boxed) so the face is not cut off by a centre crop.
 */

export type ImageShape = "crop" | "frame" | "unknown";

export interface PixelSize {
  width: number;
  height: number;
}

/** Wider/taller than this (w/h or h/w) is a camera frame, not a face crop. */
export const FRAME_ASPECT_THRESHOLD = 1.45;
/** A face crop is small; anything with a longer side than this is a frame. */
export const MAX_CROP_SIDE_PX = 800;
/** Zoom steps offered in the enlarged view (1 = the image's natural size). */
export const ZOOM_SCALES = [1, 2, 3] as const;
/** Share of the viewport the enlarged image may use. */
const VIEWPORT_SHARE = 0.9;

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** Classifies a loaded image by its natural size. Never throws. */
export function classifyImageShape(width: unknown, height: unknown): ImageShape {
  if (!positive(width) || !positive(height)) return "unknown";
  const ratio = width / height;
  if (ratio >= FRAME_ASPECT_THRESHOLD || ratio <= 1 / FRAME_ASPECT_THRESHOLD) return "frame";
  if (Math.max(width, height) > MAX_CROP_SIDE_PX) return "frame";
  return "crop";
}

/**
 * Tailwind classes for an <img> inside a fixed-size thumbnail box. A crop may
 * fill the box; a frame (or an image not loaded yet) is shown whole on a dark
 * background so nothing - in particular the face - is cropped away.
 */
export function thumbFitClass(shape: ImageShape): string {
  return shape === "crop" ? "object-cover" : "object-contain bg-slate-900";
}

/**
 * Size of the enlarged image: the natural size times `scale`, shrunk (never
 * stretched) to fit the viewport. `capped` says the viewport limited it, so the
 * image is shown smaller than asked.
 */
export function zoomDisplaySize(
  natural: PixelSize,
  viewport: PixelSize,
  scale: number = 1
): PixelSize & { capped: boolean } {
  if (!positive(natural.width) || !positive(natural.height)) return { width: 0, height: 0, capped: false };
  const s = positive(scale) ? scale : 1;
  const wantW = natural.width * s;
  const wantH = natural.height * s;
  const maxW = positive(viewport.width) ? viewport.width * VIEWPORT_SHARE : wantW;
  const maxH = positive(viewport.height) ? viewport.height * VIEWPORT_SHARE : wantH;
  const fit = Math.min(1, maxW / wantW, maxH / wantH);
  return {
    width: Math.max(1, Math.round(wantW * fit)),
    height: Math.max(1, Math.round(wantH * fit)),
    capped: fit < 1,
  };
}

/** Zoom steps worth offering: only those that still fit on screen. Always has 1. */
export function usableZoomScales(natural: PixelSize, viewport: PixelSize): number[] {
  const out: number[] = [1];
  for (const s of ZOOM_SCALES) {
    if (s === 1) continue;
    if (!zoomDisplaySize(natural, viewport, s).capped) out.push(s);
  }
  return out;
}

/** "256 × 256 px", or an empty string for an image not loaded yet. */
export function formatPixelSize(size: Partial<PixelSize> | null | undefined): string {
  if (!size || !positive(size.width) || !positive(size.height)) return "";
  return `${Math.round(size.width)} × ${Math.round(size.height)} px`;
}

/** Caption for the enlarged view, in the operator's language. */
export function describeImageShape(shape: ImageShape): string {
  if (shape === "crop") return "Ảnh khuôn mặt đã chụp";
  if (shape === "frame") return "Khung hình cũ (bản ghi trước khi chuyển sang lưu ảnh khuôn mặt)";
  return "Ảnh đã chụp";
}
