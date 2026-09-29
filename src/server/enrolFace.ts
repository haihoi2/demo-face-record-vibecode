/**
 * Which face in a stored stranger photo may become a template.
 *
 * A stored photo is the whole gate frame, and it can hold several people. The
 * stranger group was built from ONE of them: the face whose embedding is stored
 * on the access log. Enrolling "the best-quality clear face" of the frame could
 * take somebody else's face (a colleague walking beside the stranger) and give
 * that person the new employee's door access. So:
 *
 *  - with the log's own embedding (same model tag): only the detected face that
 *    matches it is a candidate, and none matching is a refusal;
 *  - without it (older logs), a photo with more than one face is refused, since
 *    there is no way to know which person the operator meant.
 */
import { cosine } from "./faceFusion";

/**
 * Minimum cosine between the log's stored embedding and a face re-detected in
 * the stored (re-encoded) photo. The same face in the same frame scores ~0.9+;
 * different people on this site score below ~0.35 (impostor range), and the
 * single-view accept threshold is 0.55.
 */
export const ENROL_SOURCE_MIN_COSINE = 0.6;

export type EnrolChoice<F> =
  | { faces: F[]; matchCosine?: number }
  | { rejected: "face-mismatch"; bestCosine: number }
  | { rejected: "multiple-faces"; detectedFaces: number };

export function chooseEnrolFaces<F extends { embedding: ArrayLike<number> }>(
  detected: F[],
  expected?: ArrayLike<number> | null,
  minCosine = ENROL_SOURCE_MIN_COSINE,
): EnrolChoice<F> {
  if (detected.length === 0) return { faces: [] };
  if (expected && expected.length > 0 && expected.length === detected[0].embedding.length) {
    let best = detected[0];
    let bestCos = cosine(expected, best.embedding);
    for (const f of detected.slice(1)) {
      const c = cosine(expected, f.embedding);
      if (c > bestCos) {
        best = f;
        bestCos = c;
      }
    }
    const rounded = Math.round(bestCos * 1000) / 1000;
    if (bestCos < minCosine) return { rejected: "face-mismatch", bestCosine: rounded };
    return { faces: [best], matchCosine: rounded };
  }
  if (detected.length > 1) return { rejected: "multiple-faces", detectedFaces: detected.length };
  return { faces: detected };
}
