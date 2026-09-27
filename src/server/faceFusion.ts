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

/**
 * Operating points of the REAL-TIME PIPELINE per recogniser tag, calibrated on
 * this site's own captures (scripts/perf/calib-eval.ts; numbers and pair-set
 * sizes in docs/agent-handoffs/2026-09-27-rt-calib.md). The legacy door engine
 * keeps DEFAULT_FUSION_THRESHOLDS; these apply to pipeline workers only, keyed
 * by the tag of the recogniser they run. A tag without an entry falls back to
 * the legacy defaults (reported as such), never to another model's numbers.
 */
export const PIPELINE_FUSION_THRESHOLDS_BY_TAG: Readonly<Record<string, Readonly<FusionThresholds>>> = {
  arcface_w600k_r50: DEFAULT_FUSION_THRESHOLDS,
  /**
   * INT8 r50 (w600k_r50_int8.onnx): reproduces r50's operating point at 0.55 / 0.45 on the
   * site pair set (TAR 49-52 % of genuine pairs, 0 strict false accepts, impostor p95 0.13,
   * margin to accept 0.43); its cosines sit ~0.01 above/below r50's, hence +0.01 / +0.03.
   */
  arcface_w600k_r50_int8: { acceptSingle: 0.56, minEvidence: 0.35, acceptFused: 0.48, minAgreeing: 2, minMargin: 0.08 },
  /**
   * MobileFaceNet (shadow only, see faceEmbedding.ts): genuine cosines run ~0.04 lower than
   * r50's (p50 0.514 vs 0.555), impostor p95 0.14; 0.51 / 0.45 reproduce r50's TAR at 0.55 /
   * 0.45 with 0 strict false accepts (margin 0.37). minEvidence scaled with the genuine p50.
   */
  arcface_w600k_mbf: { acceptSingle: 0.51, minEvidence: 0.32, acceptFused: 0.45, minAgreeing: 2, minMargin: 0.08 },
};

/** PIPELINE_* threshold overrides (pipeline workers only; the legacy FACE_* ones are untouched). */
const PIPELINE_THRESHOLD_ENVS: ReadonlyArray<{ env: string; key: keyof FusionThresholds; min: number; max: number; integer?: boolean }> = [
  { env: "PIPELINE_ACCEPT_SINGLE", key: "acceptSingle", min: 0.01, max: 0.999 },
  { env: "PIPELINE_ACCEPT_FUSED", key: "acceptFused", min: 0.01, max: 0.999 },
  { env: "PIPELINE_MIN_EVIDENCE", key: "minEvidence", min: 0.01, max: 0.999 },
  { env: "PIPELINE_MIN_MARGIN", key: "minMargin", min: 0, max: 0.999 },
  { env: "PIPELINE_MIN_AGREEING", key: "minAgreeing", min: 1, max: 32, integer: true },
];

export interface PipelineThresholdSelection {
  thresholds: FusionThresholds;
  /** "calibrated" when the tag has a calibrated entry, else "legacy-default". */
  source: "calibrated" | "legacy-default";
  /** PIPELINE_* variables applied. */
  overrides: string[];
  /** PIPELINE_* variables present but out of range / malformed (ignored). */
  ignored: string[];
}

/** Pure: fusion thresholds for a pipeline worker running the recogniser tagged `modelTag`. */
export function pipelineFusionThresholds(modelTag: string, env: NodeJS.ProcessEnv = process.env): PipelineThresholdSelection {
  const base = PIPELINE_FUSION_THRESHOLDS_BY_TAG[modelTag];
  const thresholds: FusionThresholds = { ...(base ?? DEFAULT_FUSION_THRESHOLDS) };
  const overrides: string[] = [];
  const ignored: string[] = [];
  for (const spec of PIPELINE_THRESHOLD_ENVS) {
    const raw = String(env[spec.env] ?? "").trim();
    if (raw === "") continue;
    const n = Number(raw);
    const ok = Number.isFinite(n) && n >= spec.min && n <= spec.max && (!spec.integer || Number.isInteger(n));
    if (!ok) {
      ignored.push(spec.env);
      continue;
    }
    (thresholds as any)[spec.key] = n;
    overrides.push(spec.env);
  }
  return { thresholds, source: base ? "calibrated" : "legacy-default", overrides, ignored };
}

// ---------------------------------------------------------------------------
// Gallery derivation for a second recogniser tag (pipeline flow)
// ---------------------------------------------------------------------------

/**
 * A picture of an employee that can be embedded again under another recogniser.
 * Embeddings are never converted between models: a gallery for a new tag is
 * built by re-embedding source pictures, and this planner only decides WHICH
 * pictures, deterministically, so the result can be audited and repeated.
 */
export interface GalleryDerivationSource {
  employeeId: string;
  /** Stable id of the picture: the access-log id of a stored crop, an enrolment photo id, or the template id whose snapshot it is. */
  sourceId: string;
  kind: "enrollment_photo" | "template_source" | "access_log_crop";
  /** ISO time the picture was taken (newer wins between equals). */
  capturedAt: string;
  /** 0-1 capture quality when known (template quality / access-log faceEmbeddingQuality). */
  quality?: number;
  /** Camera stream the picture came from, when known. */
  streamId?: string;
}

export interface GalleryDerivationOptions {
  /** Tag of the recogniser the gallery is for (faceModelTagFor of its file). */
  targetTag: string;
  /** Templates per employee under targetTag, existing ones included. Default 5 (the tracker's evidence budget). */
  capPerEmployee?: number;
  /** Sources below this quality are not embedded. Default 0.25 (enrolment grade). */
  minQuality?: number;
  /** Employees that should end up covered; those left without any template are reported. */
  employeeIds?: readonly string[];
}

export type GalleryDerivationSkip = "alreadyDerived" | "lowQuality" | "capReached" | "invalid";

export interface GalleryDerivationPlan {
  targetTag: string;
  /** Sources to embed under targetTag, in execution order (deterministic). */
  toEmbed: GalleryDerivationSource[];
  perEmployee: Record<string, { existing: number; planned: number; skipped: Partial<Record<GalleryDerivationSkip, number>> }>;
  /** Employees (from opts.employeeIds) that will have no template under targetTag after the plan runs. */
  uncovered: string[];
}

const KIND_RANK: Record<GalleryDerivationSource["kind"], number> = { enrollment_photo: 0, template_source: 1, access_log_crop: 2 };

/**
 * Plan the templates to create for `targetTag` from candidate pictures.
 *
 * Rules (all deterministic):
 *  - templates already under targetTag count toward the cap, and a source whose
 *    id equals an existing target-tag template's sourceLogId or id is skipped;
 *  - templates of OTHER tags are only consulted for their ids: no embedding is
 *    ever copied across tags;
 *  - candidates are ordered enrolment photo > template source > access-log
 *    crop, then quality (unknown = 0.5) desc, then capturedAt desc, then sourceId;
 *  - picks alternate across camera streams (round-robin over streamId in that
 *    order) because on this site same-person cosine across cameras overlaps the
 *    impostor range - every camera needs templates of its own.
 */
export function planGalleryDerivation(
  existing: readonly FaceTemplate[],
  sources: readonly GalleryDerivationSource[],
  opts: GalleryDerivationOptions,
): GalleryDerivationPlan {
  const cap = Number.isInteger(opts.capPerEmployee) && (opts.capPerEmployee as number) >= 0 ? (opts.capPerEmployee as number) : 5;
  const minQuality = typeof opts.minQuality === "number" && Number.isFinite(opts.minQuality) ? opts.minQuality : 0.25;
  const targetTag = String(opts.targetTag || "");
  const plan: GalleryDerivationPlan = { targetTag, toEmbed: [], perEmployee: {}, uncovered: [] };
  if (targetTag === "") return plan;

  const stats = (employeeId: string) =>
    (plan.perEmployee[employeeId] ??= { existing: 0, planned: 0, skipped: {} });
  const skip = (employeeId: string, why: GalleryDerivationSkip) => {
    const s = stats(employeeId).skipped;
    s[why] = (s[why] ?? 0) + 1;
  };

  const derived = new Set<string>();
  for (const t of existing) {
    if (!t || t.modelTag !== targetTag || !t.employeeId) continue;
    stats(t.employeeId).existing += 1;
    if (t.sourceLogId) derived.add(`${t.employeeId}|${t.sourceLogId}`);
    if (t.id) derived.add(`${t.employeeId}|${t.id}`);
  }

  const byEmployee = new Map<string, GalleryDerivationSource[]>();
  for (const s of sources) {
    if (!s || typeof s.employeeId !== "string" || s.employeeId === "" || typeof s.sourceId !== "string" || s.sourceId === "" || !(s.kind in KIND_RANK)) {
      if (s && typeof s.employeeId === "string" && s.employeeId !== "") skip(s.employeeId, "invalid");
      continue;
    }
    if (derived.has(`${s.employeeId}|${s.sourceId}`)) {
      skip(s.employeeId, "alreadyDerived");
      continue;
    }
    if (typeof s.quality === "number" && s.quality < minQuality) {
      skip(s.employeeId, "lowQuality");
      continue;
    }
    byEmployee.set(s.employeeId, [...(byEmployee.get(s.employeeId) ?? []), s]);
  }

  const q = (s: GalleryDerivationSource) => (typeof s.quality === "number" && Number.isFinite(s.quality) ? s.quality : 0.5);
  const order = (a: GalleryDerivationSource, b: GalleryDerivationSource) =>
    KIND_RANK[a.kind] - KIND_RANK[b.kind] || q(b) - q(a) || String(b.capturedAt).localeCompare(String(a.capturedAt)) || a.sourceId.localeCompare(b.sourceId);

  for (const employeeId of [...byEmployee.keys()].sort()) {
    const candidates = byEmployee.get(employeeId)!.sort(order);
    // De-duplicate identical source ids deterministically (first in order wins).
    const seen = new Set<string>();
    const unique = candidates.filter((s) => (seen.has(s.sourceId) ? false : (seen.add(s.sourceId), true)));
    const groups = new Map<string, GalleryDerivationSource[]>();
    for (const s of unique) {
      const key = s.streamId ?? "";
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    const queues = [...groups.keys()].sort().map((k) => groups.get(k)!);
    const st = stats(employeeId);
    let room = Math.max(0, cap - st.existing);
    let progressed = true;
    while (room > 0 && progressed) {
      progressed = false;
      for (const queue of queues) {
        if (room === 0) break;
        const next = queue.shift();
        if (!next) continue;
        plan.toEmbed.push(next);
        st.planned += 1;
        room -= 1;
        progressed = true;
      }
    }
    for (const queue of queues) for (const _ of queue) skip(employeeId, "capReached");
  }

  for (const id of opts.employeeIds ?? []) {
    const st = plan.perEmployee[id];
    if (!st || st.existing + st.planned === 0) plan.uncovered.push(id);
  }
  plan.uncovered.sort();
  return plan;
}

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
 *      ≥ `acceptFused`, the winner leads the next candidate by `minMargin`,
 *      AND - per observation - it leads that observation's own runner-up by
 *      `minMargin` on (quality-weighted) average. Only each observation's top
 *      identity is aggregated, so a lookalike who comes second in EVERY frame
 *      never becomes a candidate; without the per-observation check, several
 *      frames each preferring A over B by 0.04 were granted as A.
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

  // (b) several views agree - and not merely on the better of two lookalikes
  let marginSum = 0;
  let marginWeight = 0;
  for (const e of w.evidence) {
    const q = Math.max(0.05, e.quality);
    marginSum += (e.cosine - e.secondCosine) * q;
    marginWeight += q;
  }
  const observationMargin = marginWeight > 0 ? marginSum / marginWeight : 0;
  if (
    w.observations >= th.minAgreeing &&
    w.fusedCosine >= th.acceptFused &&
    candidateMargin >= th.minMargin &&
    observationMargin >= th.minMargin
  ) {
    return base({
      recognized: true, employeeId: w.employeeId, basis: "multi-agree",
      fusedCosine: round(w.fusedCosine), bestCosine: round(w.bestCosine),
      agreeingObservations: w.observations, agreeingStreams: w.streams,
      confidence: confidenceFor(w.fusedCosine, w.streams), candidates: summary,
    });
  }

  const ambiguous =
    candidateMargin < th.minMargin ||
    (w.observations >= th.minAgreeing && w.fusedCosine >= th.acceptFused && observationMargin < th.minMargin) ||
    (strong == null && w.evidence.some((e) => e.cosine >= th.acceptSingle));
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
