/**
 * Multi-observation face matching and decision fusion.
 *
 * One gate can be watched by several streams, and a scan can take several
 * frames from each. Every detected face becomes an OBSERVATION; each
 * observation is matched against the enrolled gallery; the decision is then
 * FUSED across observations so that agreement between views raises
 * confidence and a single weak or contradictory view cannot open the door.
 *
 * Pure functions only - no I/O, no models. Embeddings are expected to be
 * L2-normalised vectors of identical length and identical model tag; the
 * caller is responsible for never mixing tags.
 */

import {
  FaceObservation,
  FaceTemplate,
  FusionDecision,
  FusionThresholds,
  ObservationMatch,
} from "../types";

/** Enrolled embeddings grouped by employee. */
export type FaceGallery = Map<string, number[][]>;

/**
 * Starting operating points for ArcFace (w600k_r50) cosine on L2-normalised
 * embeddings. Typical same-person scores sit around 0.45-0.7, different people
 * below ~0.3. These MUST be recalibrated from measured data (Phase 4); they are
 * deliberately conservative for a door.
 */
export const DEFAULT_FUSION_THRESHOLDS: FusionThresholds = {
  acceptSingle: 0.55,
  minEvidence: 0.35,
  acceptFused: 0.45,
  minAgreeing: 2,
  minMargin: 0.08,
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function l2Normalize(v: ArrayLike<number>): number[] {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = n > 0 ? v[i] / n : 0;
  return out;
}

/** Cosine of two vectors. Returns 0 for mismatched/empty inputs; clamped to [-1, 1]. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return Math.max(-1, Math.min(1, dot / Math.sqrt(na * nb)));
}

/** Build a gallery from templates, skipping any whose dims or modelTag disagree with `expectedTag`. */
export function buildGallery(templates: FaceTemplate[], expectedTag?: string): FaceGallery {
  const gallery: FaceGallery = new Map();
  for (const t of templates) {
    if (!t?.embedding?.length) continue;
    if (expectedTag && t.modelTag !== expectedTag) continue;
    const list = gallery.get(t.employeeId) ?? [];
    list.push(t.embedding);
    gallery.set(t.employeeId, list);
  }
  return gallery;
}

/** Best cosine of one probe against one employee's templates (max over templates). */
export function scoreAgainstTemplates(probe: ArrayLike<number>, templates: number[][]): number {
  let best = -1;
  for (const t of templates) {
    const c = cosine(probe, t);
    if (c > best) best = c;
  }
  return best;
}

/** Match every observation against the gallery, recording best and runner-up identity. */
export function matchObservations(observations: FaceObservation[], gallery: FaceGallery): ObservationMatch[] {
  const out: ObservationMatch[] = [];
  for (const obs of observations) {
    let bestId: string | undefined, best = -1;
    let secondId: string | undefined, second = -1;
    for (const [employeeId, templates] of gallery) {
      const c = scoreAgainstTemplates(obs.embedding, templates);
      if (c > best) {
        second = best; secondId = bestId;
        best = c; bestId = employeeId;
      } else if (c > second) {
        second = c; secondId = employeeId;
      }
    }
    out.push({
      streamId: obs.streamId,
      frameIndex: obs.frameIndex,
      employeeId: bestId,
      cosine: best < 0 ? 0 : best,
      secondCosine: second < 0 ? 0 : second,
      secondEmployeeId: secondId,
      quality: clamp01(Number.isFinite(obs.quality) ? obs.quality : 0.5),
    });
  }
  return out;
}

interface CandidateAgg {
  employeeId: string;
  fusedCosine: number;
  bestCosine: number;
  observations: number;
  streams: number;
  weightSum: number;
  evidence: ObservationMatch[];
}

/**
 * Fuse per-observation matches into one decision.
 *
 * Accept when EITHER
 *  (a) single-strong: one observation clears `acceptSingle` and beats its own
 *      runner-up by `minMargin`; or
 *  (b) multi-agree: at least `minAgreeing` observations agree on the same
 *      identity, each ≥ `minEvidence`, their quality-weighted mean cosine is
 *      ≥ `acceptFused`, and the winner leads the next candidate by `minMargin`.
 * Otherwise reject, labelling why. Agreement across DISTINCT streams adds a
 * small confidence bonus; it never lowers a threshold.
 */
export function fuseDecision(
  matches: ObservationMatch[],
  thresholds: Partial<FusionThresholds> = {}
): FusionDecision {
  const th: FusionThresholds = { ...DEFAULT_FUSION_THRESHOLDS, ...thresholds };
  const base = (partial: Partial<FusionDecision>): FusionDecision => ({
    recognized: false,
    confidence: 0,
    fusedCosine: 0,
    bestCosine: 0,
    agreeingObservations: 0,
    agreeingStreams: 0,
    basis: "rejected-no-face",
    candidates: [],
    perObservation: matches,
    thresholds: th,
    ...partial,
  });

  if (matches.length === 0) return base({});

  // Aggregate evidence per identity.
  const agg = new Map<string, CandidateAgg>();
  for (const m of matches) {
    if (!m.employeeId || m.cosine < th.minEvidence) continue;
    const w = Math.max(0.05, m.quality);
    const a = agg.get(m.employeeId) ?? {
      employeeId: m.employeeId, fusedCosine: 0, bestCosine: 0, observations: 0, streams: 0, weightSum: 0, evidence: [],
    };
    a.fusedCosine += m.cosine * w;
    a.weightSum += w;
    a.bestCosine = Math.max(a.bestCosine, m.cosine);
    a.observations += 1;
    a.evidence.push(m);
    agg.set(m.employeeId, a);
  }
  const candidates = [...agg.values()].map((a) => ({
    ...a,
    fusedCosine: a.weightSum > 0 ? a.fusedCosine / a.weightSum : 0,
    streams: new Set(a.evidence.map((e) => e.streamId)).size,
  }));
  candidates.sort((x, y) => y.fusedCosine - x.fusedCosine || y.bestCosine - x.bestCosine);

  const summary = candidates.map((c) => ({
    employeeId: c.employeeId, fusedCosine: round(c.fusedCosine), bestCosine: round(c.bestCosine),
    observations: c.observations, streams: c.streams,
  }));

  if (candidates.length === 0) {
    const bestAny = Math.max(...matches.map((m) => m.cosine));
    return base({ basis: "rejected-weak", bestCosine: round(bestAny), confidence: round(clamp01(bestAny / th.minEvidence) * 0.3) });
  }

  const w = candidates[0];
  const r = candidates[1];
  const candidateMargin = r ? w.fusedCosine - r.fusedCosine : 1;

  const confidenceFor = (fused: number, streams: number) => {
    const core = clamp01((fused - th.minEvidence) / (1 - th.minEvidence));
    const bonus = 0.05 * (Math.min(streams, 3) - 1);
    return round(Math.min(0.99, core + Math.max(0, bonus)));
  };

  // (a) one strong, unambiguous view
  const strong = w.evidence.find((e) => e.cosine >= th.acceptSingle && e.cosine - e.secondCosine >= th.minMargin);
  if (strong && candidateMargin >= th.minMargin) {
    return base({
      recognized: true, employeeId: w.employeeId, basis: "single-strong",
      fusedCosine: round(w.fusedCosine), bestCosine: round(w.bestCosine),
      agreeingObservations: w.observations, agreeingStreams: w.streams,
      confidence: confidenceFor(Math.max(w.fusedCosine, strong.cosine), w.streams), candidates: summary,
    });
  }

  // (b) several views agree
  if (w.observations >= th.minAgreeing && w.fusedCosine >= th.acceptFused && candidateMargin >= th.minMargin) {
    return base({
      recognized: true, employeeId: w.employeeId, basis: "multi-agree",
      fusedCosine: round(w.fusedCosine), bestCosine: round(w.bestCosine),
      agreeingObservations: w.observations, agreeingStreams: w.streams,
      confidence: confidenceFor(w.fusedCosine, w.streams), candidates: summary,
    });
  }

  const ambiguous = candidateMargin < th.minMargin || (strong == null && w.evidence.some((e) => e.cosine >= th.acceptSingle));
  return base({
    recognized: false, employeeId: undefined,
    basis: ambiguous ? "rejected-ambiguous" : "rejected-weak",
    fusedCosine: round(w.fusedCosine), bestCosine: round(w.bestCosine),
    agreeingObservations: w.observations, agreeingStreams: w.streams,
    confidence: round(confidenceFor(w.fusedCosine, w.streams) * 0.5), candidates: summary,
  });
}

/** Convenience: match + fuse in one call. */
export function recognizeObservations(
  observations: FaceObservation[],
  gallery: FaceGallery,
  thresholds?: Partial<FusionThresholds>
): FusionDecision {
  return fuseDecision(matchObservations(observations, gallery), thresholds);
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
