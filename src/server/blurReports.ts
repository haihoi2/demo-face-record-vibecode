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
import { createHash, randomUUID } from "node:crypto";

/**
 * Sharpness ratings (plan docs/plans/2026-10-07-face-sharpness.md, S0) share
 * this append-only store: "Rõ" / "Mờ" / "Không phải mặt" from the labelling
 * page. They never change a face's blur-report state (the "Đã báo mờ" badge).
 */
export type FaceRatingKind = "rated-sharp" | "rated-blurry" | "rated-not-face";
export type BlurReportKind = "blur" | "blur-withdrawn" | FaceRatingKind;

export const FACE_RATINGS: Record<"sharp" | "blurry" | "not-face", FaceRatingKind> = {
  sharp: "rated-sharp",
  blurry: "rated-blurry",
  "not-face": "rated-not-face",
};
export const isBlurReportOnlyKind = (k: unknown): k is "blur" | "blur-withdrawn" => k === "blur" || k === "blur-withdrawn";
export const isFaceRatingKind = (k: unknown): k is FaceRatingKind => k === "rated-sharp" || k === "rated-blurry" || k === "rated-not-face";
export const isStoredFaceReportKind = (k: unknown): k is BlurReportKind => isBlurReportOnlyKind(k) || isFaceRatingKind(k);

/** Labelling target per person (owner 2026-10-07: ~300 faces). */
export const SHARPNESS_LABEL_TARGET = 300;

/**
 * The same order for every labeller (so two people rate overlapping faces):
 * by a hash of the face id, independent of capture time.
 */
export function sharpnessSampleOrder<T extends { id: string }>(faces: T[], seed = "sharpness-s0"): T[] {
  const key = (id: string) => createHash("sha256").update(`${seed}:${id}`).digest("hex");
  return faces.map((f) => ({ f, k: key(f.id) })).sort((a, b) => a.k.localeCompare(b.k)).map((x) => x.f);
}

/** Latest rating per (face, person); every older rating by the same person is replaced. */
export function latestRatings(rows: Array<{ faceId: string; kind: string; actor: string; at: string; id: string }>) {
  const latest = new Map<string, { faceId: string; actor: string; kind: FaceRatingKind; at: string }>();
  const sorted = rows.filter((r) => isFaceRatingKind(r.kind)).sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at)));
  for (const r of sorted) latest.set(`${r.faceId}\u0000${r.actor}`, { faceId: r.faceId, actor: r.actor, kind: r.kind as FaceRatingKind, at: r.at });
  return [...latest.values()];
}

/** Progress and agreement of the labelling round (admin summary). */
export function ratingSummary(rows: Array<{ faceId: string; kind: string; actor: string; at: string; id: string }>) {
  const latest = latestRatings(rows);
  const byRating: Record<FaceRatingKind, number> = { "rated-sharp": 0, "rated-blurry": 0, "rated-not-face": 0 };
  const byActor: Record<string, number> = {};
  const byFace = new Map<string, FaceRatingKind[]>();
  for (const r of latest) {
    byRating[r.kind] += 1;
    byActor[r.actor] = (byActor[r.actor] || 0) + 1;
    byFace.set(r.faceId, [...(byFace.get(r.faceId) || []), r.kind]);
  }
  const shared = [...byFace.values()].filter((k) => k.length >= 2);
  const agreed = shared.filter((k) => k.every((x) => x === k[0])).length;
  return {
    facesRated: byFace.size,
    ratings: latest.length,
    byRating: { sharp: byRating["rated-sharp"], blurry: byRating["rated-blurry"], notFace: byRating["rated-not-face"] },
    byActor,
    ratedByTwoOrMore: shared.length,
    agreementPct: shared.length ? Math.round((100 * agreed) / shared.length) : null,
    targetPerPerson: SHARPNESS_LABEL_TARGET,
  };
}

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
