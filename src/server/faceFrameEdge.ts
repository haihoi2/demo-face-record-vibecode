/**
 * Heads cut off by the picture edge (owner 2026-10-01: "cut the head ... should
 * not be recorded as faces"). A face whose box reaches the edge of the frame is
 * only partly in the picture: the chin or forehead is missing, and the crop an
 * operator sees is half a face.
 *
 * Calibrated on the 15 stranger faces shown on 2026-10-01: the three cut heads
 * ended 0, 9 and 27 px from the bottom edge with boxes 358, 237 and 339 px
 * tall (all under 10% of their height); the nearest complete face ended 50 px
 * from the edge with a 458 px box (11%). Storage only - never a door decision.
 */
export function faceCutByFrameEdge(
  box: readonly [number, number, number, number] | undefined,
  frameSize: readonly [number, number] | undefined,
  minMarginFraction: number,
): boolean {
  if (!box || !frameSize || !(minMarginFraction > 0)) return false;
  const [x1, y1, x2, y2] = box;
  const [width, height] = frameSize;
  const w = x2 - x1;
  const h = y2 - y1;
  if (!(w > 0 && h > 0 && width > 0 && height > 0)) return false;
  const minX = minMarginFraction * w;
  const minY = minMarginFraction * h;
  return x1 < minX || width - x2 < minX || y1 < minY || height - y2 < minY;
}
