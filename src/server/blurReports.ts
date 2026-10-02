/**
 * Blur reports (owner 2026-10-02: "report blur to validate and optimize rather
 * than delete"; "stored or tagged for you to review and enhance the accuracy").
 *
 * CONTRACT. An operator tags a stored stranger face as "too blurred". Nothing
 * is deleted or hidden: the report is a LABEL, kept with the face's measured
 * scores at that moment, so the blur filter (FACE_STRANGER_MIN_FEATURE_NORM,
 * FACE_STRANGER_MIN_EDGE_ENERGY, quality) can be re-tuned from real examples.
 * Append-only: withdrawing a report appends a "blur-withdrawn" row; the current
 * state of a face is its newest row.
 *
 * No images and no embeddings here - only ids, scores, actor and time. The face
 * crop itself stays under stranger-face retention (FACE_STRANGER_FACE_RETENTION_DAYS);
 * a report outlives it as numbers only.
 *
 * API
 *   POST   /api/strangers/faces/:faceId/blur-report  (operator, CSRF) body { note? <=200 }
 *          -> 200 { success, faceId, blurReported: true, report }   404 unknown face, 400 legacy/invalid id
 *   DELETE /api/strangers/faces/:faceId/blur-report  (operator, CSRF)
 *          -> 200 { success, faceId, blurReported: false, report }
 *   GET    /api/strangers/blur-reports?since=<ISO>&limit=<1..1000> (admin)
 *          -> 200 { success, reports: BlurReportRecord[] newest first (every row, withdrawals included),
 *                   current: Array<{ faceId, blurReported, at }> (newest row per face) }
 *   GET    /api/strangers/clusters: per-face photos carry `blurReported: true` while reported.
 */
import { randomUUID } from "node:crypto";

export type BlurReportKind = "blur" | "blur-withdrawn";

export interface BlurReportRecord {
  /** `BR-<uuid>`. */
  id: string;
  faceId: string;
  /** Access event the face belongs to. */
  logId?: string;
  kind: BlurReportKind;
  /** Signed-in operator (username or principal id). */
  actor: string;
  /** ISO time of the report. */
  at: string;
  /** The face's scores when reported (from its stored record; null when unknown). */
  featureNorm?: number | null;
  edgeEnergy?: number | null;
  quality?: number | null;
  detectorScore?: number | null;
  sizePx?: number | null;
  gateId?: string | null;
  /** Free text, <= 200 chars, control characters removed. */
  note?: string;
}

export interface BlurReportStore {
  /** Append; replay by id is a no-op. */
  saveBlurReport(report: BlurReportRecord): Promise<boolean>;
  /** Rows newest first (at DESC, id DESC), optionally since an ISO time; limit 1..1000. */
  getBlurReports(opts: { sinceIso?: string; limit: number }): Promise<BlurReportRecord[]>;
  /** Face ids whose newest row is "blur", among `faceIds` (for the cluster view). */
  blurReportedFaceIds(faceIds: string[]): Promise<Set<string>>;
}

export const newBlurReportId = () => `BR-${randomUUID()}`;
