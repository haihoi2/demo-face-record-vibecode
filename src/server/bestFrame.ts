/**
 * Which observation's frame a scan stores when nobody was recognised (owner
 * 2026-10-01: "sharpest of several frames"). A walking person's motion blur
 * changes from frame to frame; the recogniser's feature strength (ArcFace L2
 * norm before normalisation) is the measure that tracks it - the pixel-based
 * quality score let motion-smeared faces through (2026-09-30 calibration).
 *
 * `useStrength` is false for recognisers whose strength scale is not
 * calibrated; then the highest quality wins, as before. Ties keep the earlier
 * observation. Returns -1 for an empty list. Storage choice only - never a
 * door decision.
 */
export function pickSharpestObservation(
  observations: ReadonlyArray<{ quality: number; featureNorm?: number }>,
  useStrength: boolean,
): number {
  let pick = -1;
  for (let i = 0; i < observations.length; i++) {
    if (pick < 0) {
      pick = i;
      continue;
    }
    const a = observations[i];
    const b = observations[pick];
    const strengthKnown = useStrength && typeof a.featureNorm === "number" && typeof b.featureNorm === "number";
    if (strengthKnown ? a.featureNorm! > b.featureNorm! : a.quality > b.quality) pick = i;
  }
  return pick;
}
