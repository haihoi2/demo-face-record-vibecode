/**
 * Camera adaptation (plan docs/plans/2026-09-29-scale-and-accuracy.md, Part C).
 *
 * CONTRACT for the accuracy wave. Calibration on this site: a template made on
 * one camera matches poorly on another (cross-camera TAR 11.6%), and
 * recognition rises with templates per person (1: 71%, 5: 86%, 10: 91%). The
 * owner chose (2026-09-29, decision 3) AUTOMATIC per-camera templates from
 * confident door-engine grants, audited and deletable by an operator, rather
 * than manual enrolment sessions.
 *
 * This module is the POLICY only (pure functions, unit-tested). The job that
 * reads recognised-face observations and writes templates lives in server.ts;
 * the persistence of observations and templates in db.ts.
 *
 * Security: adaptation can only ADD templates for an employee the door engine
 * already granted with a clear margin; it never creates employees, never
 * changes access levels, and its templates are marked source "adaptation" so
 * they can be listed and removed. A wrong grant would be reinforced - which
 * is why the margin and quality floors below are stricter than the grant
 * thresholds, and why identity-mismatch shadow results (Part B) are the
 * operator's review queue.
 */

export interface AdaptationPolicy {
  /** Fused cosine must exceed acceptSingle by this much (default 0.10). */
  minCosineAboveAcceptSingle: number;
  /** Margin to the runner-up identity (default 0.15). */
  minMargin: number;
  /** Capture quality of the face (default 0.35 = the "good" colour in the enrolment UI). */
  minQuality: number;
  /** Adaptation templates per employee per camera (default 5). */
  maxPerCamera: number;
  /** A new candidate must differ from every existing template of that camera by at least this (cosine below 1 - value); default 0.05. */
  minNovelty: number;
  /**
   * At most one template per access event per camera (default true): the
   * frames of one passage are near-identical, and five of them would fill the
   * cap with no new information (the calibration's k=2 dip). Diversity over
   * days is what raises recognition.
   */
  onePerEvent: boolean;
}

export const DEFAULT_ADAPTATION_POLICY: Readonly<AdaptationPolicy> = Object.freeze({
  minCosineAboveAcceptSingle: 0.10,
  minMargin: 0.15,
  minQuality: 0.35,
  maxPerCamera: 5,
  minNovelty: 0.05,
  onePerEvent: true,
});

/**
 * A recognised face seen by the door engine: stored by the per-face writer
 * when the frame produced a GRANTED event (stranger_faces row with employeeId,
 * matchCosine and matchMargin set - see StrangerFaceRecord).
 */
export interface RecognisedFaceObservation {
  faceId: string;
  logId: string;
  employeeId: string;
  streamId: string;
  gate: string;
  capturedAt: string;
  quality: number;
  matchCosine: number;
  matchMargin: number;
  embedding: ArrayLike<number>;
}

export interface ExistingTemplate {
  id: string;
  employeeId: string;
  streamId?: string;
  source: string;
  quality: number;
  embedding: ArrayLike<number>;
  /** The access event the template came from, for the one-per-event rule. */
  sourceLogId?: string;
}

export interface AdaptationPlanItem {
  observation: RecognisedFaceObservation;
  /** Template of the same camera to evict first (lowest quality adaptation template), when the camera is at its cap. */
  evictTemplateId?: string;
}

/**
 * Which observations become templates. Deterministic: newest and best first;
 * at most `maxPerCamera` adaptation templates per employee per camera; an
 * observation too similar to an existing template of that camera adds
 * nothing and is skipped; when a camera is full, a better observation
 * replaces the worst adaptation template (never a manual enrolment).
 */
export function planAdaptation(
  observations: RecognisedFaceObservation[],
  existing: ExistingTemplate[],
  acceptSingle: number,
  policy: AdaptationPolicy = DEFAULT_ADAPTATION_POLICY,
  cosine: (a: ArrayLike<number>, b: ArrayLike<number>) => number = defaultCosine,
): AdaptationPlanItem[] {
  const plan: AdaptationPlanItem[] = [];
  const byKey = new Map<string, ExistingTemplate[]>();
  for (const t of existing) {
    const key = `${t.employeeId}|${t.streamId || ""}`;
    (byKey.get(key) || byKey.set(key, []).get(key)!).push(t);
  }
  const eligible = observations
    .filter((o) =>
      o.streamId &&
      o.matchCosine >= acceptSingle + policy.minCosineAboveAcceptSingle &&
      o.matchMargin >= policy.minMargin &&
      o.quality >= policy.minQuality)
    .sort((a, b) => (b.quality - a.quality) || b.capturedAt.localeCompare(a.capturedAt));

  for (const o of eligible) {
    const key = `${o.employeeId}|${o.streamId}`;
    const cam = byKey.get(key) || [];
    if (policy.onePerEvent && cam.some((t) => t.sourceLogId && t.sourceLogId === o.logId)) continue;
    if (cam.some((t) => cosine(t.embedding, o.embedding) >= 1 - policy.minNovelty)) continue;
    const adaptive = cam.filter((t) => t.source === "adaptation");
    let evictTemplateId: string | undefined;
    if (adaptive.length >= policy.maxPerCamera) {
      const worst = adaptive.reduce((a, b) => (b.quality < a.quality ? b : a));
      if (worst.quality >= o.quality) continue;
      evictTemplateId = worst.id;
    }
    plan.push({ observation: o, evictTemplateId });
    const next = cam.filter((t) => t.id !== evictTemplateId);
    next.push({ id: `planned:${o.faceId}`, employeeId: o.employeeId, streamId: o.streamId, source: "adaptation", quality: o.quality, embedding: o.embedding, sourceLogId: o.logId });
    byKey.set(key, next);
  }
  return plan;
}

/** Per-camera coverage of an employee's templates, for the enrolment list ("missing on camera X"). */
export function templateCoverage(
  templates: Array<{ employeeId: string; streamId?: string; source: string }>,
  cameras: Array<{ streamId: string; gate: string }>,
): Map<string, Array<{ streamId: string; gate: string; count: number; adaptation: number }>> {
  const out = new Map<string, Array<{ streamId: string; gate: string; count: number; adaptation: number }>>();
  const employees = new Set(templates.map((t) => t.employeeId));
  for (const e of employees) {
    out.set(e, cameras.map((c) => {
      const mine = templates.filter((t) => t.employeeId === e && t.streamId === c.streamId);
      return { streamId: c.streamId, gate: c.gate, count: mine.length, adaptation: mine.filter((t) => t.source === "adaptation").length };
    }));
  }
  return out;
}

function defaultCosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
