/**
 * Per-track decision for the real-time gate pipeline (plan section 2, step 2).
 *
 * The tracker turns faces into tracks (one per person per passage); this
 * module turns each track's evidence into exactly ONE TrackOutcome:
 *
 *  - employee     as soon as the EXISTING fusion rules pass (faceFusion.ts:
 *                 matchObservations + fuseDecision, thresholds supplied by the
 *                 server) on the track's best embedded frames, and the
 *                 quality-weighted mean embedding of those frames agrees with
 *                 the winner by at least the same margin. The mean check can
 *                 only refuse, never grant.
 *  - stranger     when a confirmed track ends without a match, with at least
 *                 `minStrangerFrames` embedded usable frames and a best frame of
 *                 at least `strangerMinBestQuality` capture quality.
 *  - insufficient every other confirmed track, including every track seen while
 *                 the decision context is invalid (fail closed).
 * Tentative tracks that end unconfirmed (detector flicker) owe no outcome.
 *
 * Fail closed: an outcome of kind "employee" requires a ready real engine, a
 * gallery built for the SAME model tag as the recogniser, the tracker's tag
 * equal to both, valid server-owned thresholds, and evidence embeddings of the
 * gallery's length. Anything else produces no grant and no stranger record.
 *
 * Retention: embeddings live only while a track is undecided; they are dropped
 * the moment an employee outcome is emitted or the track ends. The stranger
 * outcome carries the mean embedding (contract) - backend-side only.
 *
 * Capture quality (size x sharpness) weights evidence and picks the best frame.
 * It is NOT presentation-attack detection; no liveness claim is made here.
 *
 * Pure logic: no I/O, no timers; time from an injectable clock.
 */

import { envNumber } from "../env";
import type { FaceObservation, FusionDecision, FusionThresholds, ObservationMatch } from "../../types";
import { EMBEDDING_DIM } from "../faceEmbedding";
import { FaceGallery, fuseDecision, matchObservations } from "../faceFusion";
import type { BestFrame, Frame, FusionEvidence, Gate, ShadowResult, TrackOutcome } from "./contracts";
import {
  FaceTracker,
  TrackEnd,
  TrackedFace,
  TrackerConfig,
  TrackerInput,
  TrackerPlan,
  TrackerStep,
} from "./tracker";

export interface DecisionContext {
  /** Enrolled gallery, built with buildGallery(templates, galleryModelTag). */
  gallery: FaceGallery;
  /** Model tag the gallery was filtered to. */
  galleryModelTag: string;
  /** Model tag of the running recogniser that produces the probe embeddings. */
  engineModelTag: string;
  /** Server-owned thresholds (currentFusionThresholds()); all five required. */
  thresholds: FusionThresholds;
  /** True only when the real ONNX engine is loaded and selected. */
  engineReady: boolean;
}

export interface DecisionConfig {
  /** Best embedded frames kept per track (by capture quality). */
  keepBestFrames: number;
  minStrangerFrames: number;
  /** Mirrors FACE_STRANGER_MIN_QUALITY: a poorer best frame is "insufficient", not a stranger. */
  strangerMinBestQuality: number;
  /**
   * Mirrors FACE_STRANGER_MIN_DETECTOR_SCORE: a best frame the detector is less
   * sure of (bowed heads, hands over faces, heavy blur, non-faces) is
   * "insufficient", not a stranger.
   */
  strangerMinDetectorScore: number;
  /** Expected embedding length (gallery templates of another length are dropped). */
  embeddingDims: number;
}

export const DEFAULT_DECISION_CONFIG: Readonly<DecisionConfig> = Object.freeze({
  keepBestFrames: 5,
  minStrangerFrames: 2,
  strangerMinBestQuality: 0.25,
  strangerMinDetectorScore: envNumber("FACE_STRANGER_MIN_DETECTOR_SCORE", 0.8, { min: 0, max: 1 }),
  embeddingDims: EMBEDDING_DIM,
});

export type FusionBasis = "single-strong" | "multi-agree" | "rejected-weak" | "rejected-ambiguous" | "rejected-no-face";
export type DecisionBasis =
  | FusionBasis
  | "stranger"
  | "insufficient-evidence"
  | "insufficient-quality"
  | "context-invalid"
  | "mean-disagrees";

/** One emitted outcome plus what the pipeline needs to log/compare it. */
export interface TrackDecisionResult {
  outcome: TrackOutcome;
  shadow: ShadowResult;
  /** Why: the fusion basis for employees, else the reason for stranger/insufficient. */
  basis: DecisionBasis;
  /**
   * Last verdict on the track's evidence (e.g. "rejected-ambiguous" for a
   * stranger). A fused accept refused by the track-mean check reads
   * "rejected-ambiguous" with `meanCheckRefused: true`.
   */
  fusionBasis?: FusionBasis;
  meanCheckRefused?: boolean;
}

export interface ContextStatus {
  ok: boolean;
  reason?: string;
  /** Gallery templates dropped for wrong length or non-finite values. */
  droppedTemplates: number;
  employees: number;
}

interface Evidence {
  embedding: Float32Array;
  /** Recogniser that produced it; only evidence of the context's tag is ever compared. */
  modelTag: string;
  quality: number;
  streamId: string;
  frameSeq: number;
  detectorScore: number;
  box: [number, number, number, number];
  /** Gallery match of this frame, valid for context version `matchVersion`. */
  match?: ObservationMatch;
  matchVersion?: number;
}

interface TrackState {
  trackId: string;
  firstSeenAtMs: number;
  firstUsableAtMs?: number;
  framesSeen: number;
  confirmed: boolean;
  evidence: Evidence[];
  best: BestFrame | null;
  dirty: boolean;
  lastBasis: DecisionBasis;
  lastFusionBasis?: FusionBasis;
  meanCheckRefused?: boolean;
}

interface ValidContext {
  gallery: FaceGallery;
  thresholds: FusionThresholds;
  modelTag: string;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Validate a decision context; the returned gallery holds only well-formed templates. */
export function validateDecisionContext(
  ctx: DecisionContext | null | undefined,
  embeddingDims: number = EMBEDDING_DIM,
): { status: ContextStatus; valid: ValidContext | null } {
  const fail = (reason: string, dropped = 0) => ({ status: { ok: false, reason, droppedTemplates: dropped, employees: 0 }, valid: null });
  if (!ctx || typeof ctx !== "object") return fail("no decision context");
  if (ctx.engineReady !== true) return fail("face engine not ready");
  const tagOk = (t: unknown) => typeof t === "string" && t.trim() !== "";
  if (!tagOk(ctx.galleryModelTag) || !tagOk(ctx.engineModelTag)) return fail("model tag missing");
  if (ctx.galleryModelTag !== ctx.engineModelTag) return fail("gallery model tag differs from the engine's");
  const th = ctx.thresholds;
  if (
    !th || ![th.acceptSingle, th.acceptFused, th.minEvidence].every((v) => isNum(v) && v > 0 && v < 1) ||
    !isNum(th.minMargin) || th.minMargin < 0 || th.minMargin >= 1 ||
    !Number.isInteger(th.minAgreeing) || th.minAgreeing < 1
  ) {
    return fail("fusion thresholds invalid");
  }
  if (!(ctx.gallery instanceof Map)) return fail("gallery missing");
  const gallery: FaceGallery = new Map();
  let dropped = 0;
  for (const [employeeId, templates] of ctx.gallery) {
    if (typeof employeeId !== "string" || employeeId === "" || !Array.isArray(templates)) {
      dropped += Array.isArray(templates) ? templates.length : 1;
      continue;
    }
    const good = templates.filter((t) => Array.isArray(t) && t.length === embeddingDims && t.every(isNum));
    dropped += templates.length - good.length;
    if (good.length > 0) gallery.set(employeeId, good);
  }
  const thresholds: FusionThresholds = {
    acceptSingle: th.acceptSingle, acceptFused: th.acceptFused, minEvidence: th.minEvidence,
    minMargin: th.minMargin, minAgreeing: th.minAgreeing,
  };
  return {
    status: { ok: true, droppedTemplates: dropped, employees: gallery.size },
    valid: { gallery, thresholds, modelTag: ctx.engineModelTag },
  };
}

function l2(v: Float64Array): Float32Array | null {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (!(n > 1e-9)) return null;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** Quality-weighted mean of L2-normalised embeddings (same weights as fuseDecision). */
export function qualityWeightedMean(items: ReadonlyArray<{ embedding: ArrayLike<number>; quality: number }>): Float32Array | null {
  if (items.length === 0) return null;
  const dims = items[0].embedding.length;
  const sum = new Float64Array(dims);
  for (const it of items) {
    if (it.embedding.length !== dims) return null;
    let n = 0;
    for (let i = 0; i < dims; i++) n += it.embedding[i] * it.embedding[i];
    n = Math.sqrt(n);
    if (!(n > 1e-9)) continue;
    const w = Math.max(0.05, isNum(it.quality) ? Math.min(1, Math.max(0, it.quality)) : 0.5);
    for (let i = 0; i < dims; i++) sum[i] += (w * it.embedding[i]) / n;
  }
  return l2(sum);
}

export interface TrackDeciderOptions {
  gate: Gate;
  context: DecisionContext;
  config?: Partial<DecisionConfig>;
  clock?: () => number;
}

/** Consumes tracker steps and emits exactly one outcome per confirmed track. */
export class TrackDecider {
  readonly gate: Gate;
  readonly config: Readonly<DecisionConfig>;
  private readonly clock: () => number;
  private ctx: ValidContext | null = null;
  private ctxVersion = 0;
  private ctxStatus: ContextStatus = { ok: false, reason: "no decision context", droppedTemplates: 0, employees: 0 };
  private tracks = new Map<string, TrackState>();
  /** Tracks that already produced their outcome (bounded; ids are unique per tracker). */
  private decided = new Set<string>();
  private decidedOrder: string[] = [];

  constructor(opts: TrackDeciderOptions) {
    const config = { ...DEFAULT_DECISION_CONFIG, ...(opts.config || {}) };
    if (!Number.isInteger(config.keepBestFrames) || config.keepBestFrames < 1) throw new RangeError("keepBestFrames must be a positive integer");
    if (!Number.isInteger(config.minStrangerFrames) || config.minStrangerFrames < 1) throw new RangeError("minStrangerFrames must be a positive integer");
    if (!Number.isInteger(config.embeddingDims) || config.embeddingDims < 1) throw new RangeError("embeddingDims must be a positive integer");
    if (!isNum(config.strangerMinBestQuality)) throw new RangeError("strangerMinBestQuality must be finite");
    if (!isNum(config.strangerMinDetectorScore)) throw new RangeError("strangerMinDetectorScore must be finite");
    this.gate = opts.gate;
    this.config = Object.freeze(config);
    this.clock = opts.clock ?? Date.now;
    this.setContext(opts.context);
  }

  /** Replace gallery/thresholds/engine state (e.g. after enrolment). Invalid -> fail closed. */
  setContext(context: DecisionContext): ContextStatus {
    const { status, valid } = validateDecisionContext(context, this.config.embeddingDims);
    this.ctx = valid;
    this.ctxStatus = status;
    this.ctxVersion += 1;
    for (const st of this.tracks.values()) st.dirty = true;
    return status;
  }

  contextStatus(): ContextStatus {
    return { ...this.ctxStatus };
  }

  /** Model tag evidence must carry to be compared, or null when fail-closed. */
  contextModelTag(): string | null {
    return this.ctx ? this.ctx.modelTag : null;
  }

  /** Undecided tracks held right now, counts only (no embeddings). */
  pending(): Array<{ trackId: string; evidenceFrames: number; framesSeen: number; confirmed: boolean }> {
    return [...this.tracks.values()].map((s) => ({
      trackId: s.trackId, evidenceFrames: s.evidence.length, framesSeen: s.framesSeen, confirmed: s.confirmed,
    }));
  }

  isDecided(trackId: string): boolean {
    return this.decided.has(trackId);
  }

  /** Feed one tracker step; returns the outcomes it produced (0..n, one per track at most). */
  ingest(step: TrackerStep): TrackDecisionResult[] {
    const out: TrackDecisionResult[] = [];
    if (!step || step.gate !== this.gate) return out;
    for (const end of step.ended || []) {
      const r = this.finish(end);
      if (r) out.push(r);
    }
    const confirmedNow = new Set(step.confirmed || []);
    for (const u of step.updates || []) {
      if (this.decided.has(u.trackId)) continue;
      const st = this.stateFor(u);
      st.framesSeen += 1;
      if (u.state === "confirmed" || u.state === "lost" || confirmedNow.has(u.trackId)) st.confirmed = true;
      if (u.usable && st.firstUsableAtMs === undefined) st.firstUsableAtMs = u.frame.capturedAtMs;
      if (u.usable && (!st.best || u.quality > st.best.quality)) {
        st.best = { frame: u.frame, detection: u.detection, quality: u.quality };
      }
      if (u.embedding && u.usable && this.addEvidence(st, u, step.modelTag)) st.dirty = true;
      if (confirmedNow.has(u.trackId)) st.dirty = true;
      if (st.confirmed && st.dirty) {
        const r = this.tryEmployee(st);
        if (r) out.push(r);
      }
    }
    return out;
  }

  /** Feed track ends that came from tick()/endAll() rather than update(). */
  ingestEnds(ends: readonly TrackEnd[]): TrackDecisionResult[] {
    const out: TrackDecisionResult[] = [];
    for (const end of ends || []) {
      if (end.gate !== this.gate) continue;
      const r = this.finish(end);
      if (r) out.push(r);
    }
    return out;
  }

  // -------------------------------------------------------------------------

  private stateFor(u: TrackedFace): TrackState {
    let st = this.tracks.get(u.trackId);
    if (!st) {
      st = {
        trackId: u.trackId, firstSeenAtMs: u.frame.capturedAtMs, framesSeen: 0, confirmed: false,
        evidence: [], best: null, dirty: false, lastBasis: "insufficient-evidence",
      };
      this.tracks.set(u.trackId, st);
    }
    return st;
  }

  private addEvidence(st: TrackState, u: TrackedFace, modelTag: string): boolean {
    const e = u.embedding!;
    if (typeof modelTag !== "string" || modelTag === "") return false;
    if (e.length !== this.config.embeddingDims) return false;
    for (let i = 0; i < e.length; i++) if (!Number.isFinite(e[i])) return false;
    const b = u.detection.box;
    st.evidence.push({
      embedding: e,
      modelTag,
      quality: u.quality,
      streamId: u.frame.streamId,
      frameSeq: u.frame.seq,
      detectorScore: u.detection.score,
      box: [b[0], b[1], b[2], b[3]],
    });
    // Keep the best frames by quality; earlier frame first on ties (deterministic).
    st.evidence.sort((a, b2) => b2.quality - a.quality || a.frameSeq - b2.frameSeq);
    if (st.evidence.length > this.config.keepBestFrames) st.evidence.length = this.config.keepBestFrames;
    return true;
  }

  /** Evidence comparable with the current gallery (same model tag); none when fail-closed. */
  private comparable(st: TrackState): Evidence[] {
    const ctx = this.ctx;
    return ctx ? st.evidence.filter((e) => e.modelTag === ctx.modelTag) : [];
  }

  private fuse(st: TrackState): { fusion: FusionDecision; mean: Float32Array | null; meanOk: boolean; meanMatch?: { employeeId?: string; cosine: number; secondCosine: number } } | null {
    const ctx = this.ctx;
    const evidence = this.comparable(st);
    if (!ctx || evidence.length === 0) return null;
    // Each frame is matched against the gallery once per context version.
    const matches = evidence.map((e) => {
      if (!e.match || e.matchVersion !== this.ctxVersion) {
        const obs: FaceObservation = {
          streamId: e.streamId,
          frameIndex: e.frameSeq,
          embedding: Array.from(e.embedding),
          quality: e.quality,
          detectorScore: e.detectorScore,
          box: e.box,
        };
        e.match = matchObservations([obs], ctx.gallery)[0];
        e.matchVersion = this.ctxVersion;
      }
      return e.match;
    });
    const fusion = fuseDecision(matches, ctx.thresholds);
    const mean = qualityWeightedMean(evidence);
    let meanOk = false;
    let meanMatch: { employeeId?: string; cosine: number; secondCosine: number } | undefined;
    if (mean && fusion.recognized) {
      const [m] = matchObservations([{ streamId: "track-mean", embedding: Array.from(mean), quality: 1, detectorScore: 1 }], ctx.gallery);
      meanMatch = { employeeId: m.employeeId, cosine: m.cosine, secondCosine: m.secondCosine };
      meanOk = m.employeeId === fusion.employeeId && m.cosine >= ctx.thresholds.minEvidence && m.cosine - m.secondCosine >= ctx.thresholds.minMargin;
    }
    return { fusion, mean, meanOk, meanMatch };
  }

  private tryEmployee(st: TrackState): TrackDecisionResult | null {
    st.dirty = false;
    if (!this.ctx) {
      st.lastBasis = "context-invalid";
      return null;
    }
    const r = this.fuse(st);
    if (!r) return null;
    st.lastBasis = r.fusion.basis as FusionBasis;
    st.lastFusionBasis = r.fusion.basis as FusionBasis;
    st.meanCheckRefused = false;
    if (!r.fusion.recognized || !r.fusion.employeeId) return null;
    if (!r.meanOk) {
      // fuseDecision's multi-agree compares winners only; the mean probe must
      // also beat its own runner-up (lookalike employees) and name the winner.
      st.lastBasis = "mean-disagrees";
      st.lastFusionBasis = "rejected-ambiguous";
      st.meanCheckRefused = true;
      return null;
    }
    if (!st.best) return null; // cannot happen with evidence (evidence is usable), kept for the type
    const decidedAtMs = this.clock();
    const f = r.fusion;
    const fused: FusionEvidence = {
      basis: f.basis,
      confidence: f.confidence,
      fusedCosine: f.fusedCosine,
      bestCosine: f.bestCosine,
      agreeingObservations: f.agreeingObservations,
      agreeingStreams: f.agreeingStreams,
      candidates: f.candidates,
      perObservation: f.perObservation,
      thresholds: f.thresholds,
      trackMean: r.meanMatch,
      framesUsed: this.comparable(st).length,
    };
    const outcome: TrackOutcome = {
      kind: "employee", gate: this.gate, trackId: st.trackId, employeeId: f.employeeId!, decidedAtMs, fused, best: st.best,
    };
    return this.emit(st, outcome, f.basis as FusionBasis, f.employeeId);
  }

  private finish(end: TrackEnd): TrackDecisionResult | null {
    const st = this.tracks.get(end.trackId);
    if (this.decided.has(end.trackId)) {
      this.tracks.delete(end.trackId);
      return null;
    }
    if (!end.confirmed || !st || !st.confirmed) {
      // Detector flicker / never confirmed: nothing to report, drop what was held.
      this.tracks.delete(end.trackId);
      return null;
    }
    // A late context change may still decide; the rules are the same.
    const emp = this.tryEmployee(st);
    if (emp) return emp;
    const decidedAtMs = this.clock();
    if (!this.ctx) {
      return this.emit(st, { kind: "insufficient", gate: this.gate, trackId: st.trackId, decidedAtMs }, "context-invalid");
    }
    const evidence = this.comparable(st);
    if (evidence.length < this.config.minStrangerFrames || !st.best) {
      return this.emit(st, { kind: "insufficient", gate: this.gate, trackId: st.trackId, decidedAtMs }, "insufficient-evidence");
    }
    if (st.best.quality < this.config.strangerMinBestQuality || st.best.detection.score < this.config.strangerMinDetectorScore) {
      return this.emit(st, { kind: "insufficient", gate: this.gate, trackId: st.trackId, decidedAtMs }, "insufficient-quality");
    }
    const mean = qualityWeightedMean(evidence);
    if (!mean) {
      return this.emit(st, { kind: "insufficient", gate: this.gate, trackId: st.trackId, decidedAtMs }, "insufficient-evidence");
    }
    return this.emit(st, { kind: "stranger", gate: this.gate, trackId: st.trackId, decidedAtMs, embedding: mean, best: st.best }, "stranger");
  }

  private emit(st: TrackState, outcome: TrackOutcome, basis: DecisionBasis, employeeId?: string): TrackDecisionResult {
    const shadow: ShadowResult = {
      gate: this.gate,
      outcome: outcome.kind,
      trackId: st.trackId,
      firstSeenAtMs: st.firstSeenAtMs,
      decidedAtMs: outcome.decidedAtMs,
      framesSeen: st.framesSeen,
      framesUsed: this.comparable(st).length,
    };
    if (employeeId) shadow.employeeId = employeeId;
    if (st.firstUsableAtMs !== undefined) shadow.firstUsableAtMs = st.firstUsableAtMs;
    // Exactly once, and nothing biometric kept after the decision.
    this.tracks.delete(st.trackId);
    st.evidence = [];
    this.decided.add(st.trackId);
    this.decidedOrder.push(st.trackId);
    if (this.decidedOrder.length > 4096) this.decided.delete(this.decidedOrder.shift()!);
    const result: TrackDecisionResult = { outcome, shadow, basis };
    if (st.lastFusionBasis) result.fusionBasis = st.lastFusionBasis;
    if (st.meanCheckRefused) result.meanCheckRefused = true;
    return result;
  }
}

export interface GateTrackSessionOptions {
  gate: Gate;
  /** Model tag of the running recogniser; must match the context's tags. */
  modelTag: string;
  context: DecisionContext;
  trackerConfig?: Partial<TrackerConfig>;
  decisionConfig?: Partial<DecisionConfig>;
  clock?: () => number;
  idPrefix?: string;
}

/**
 * Tracker + decider for one gate, wired the way the pipeline uses them:
 *   plan(frame, faces)  -> embed the faces marked needsEmbedding
 *   process(frame, faces with embeddings) -> outcomes
 *   tick() on a timer (ends tracks when the stream stalls), close() on stop.
 */
export class GateTrackSession {
  readonly tracker: FaceTracker;
  readonly decider: TrackDecider;

  constructor(opts: GateTrackSessionOptions) {
    this.tracker = new FaceTracker({ gate: opts.gate, modelTag: opts.modelTag, config: opts.trackerConfig, clock: opts.clock, idPrefix: opts.idPrefix });
    this.decider = new TrackDecider({ gate: opts.gate, context: opts.context, config: opts.decisionConfig, clock: opts.clock });
  }

  plan(frame: Frame, inputs: readonly TrackerInput[]): TrackerPlan {
    return this.tracker.plan(frame, inputs);
  }

  process(frame: Frame, inputs: readonly TrackerInput[]): { step: TrackerStep; results: TrackDecisionResult[] } {
    const step = this.tracker.update(frame, inputs);
    const results = this.decider.ingest(step);
    this.closeDecided(results);
    return { step, results };
  }

  tick(nowMs?: number): TrackDecisionResult[] {
    return this.decider.ingestEnds(this.tracker.tick(nowMs));
  }

  close(nowMs?: number): TrackDecisionResult[] {
    return this.decider.ingestEnds(this.tracker.endAll("shutdown", nowMs));
  }

  setContext(context: DecisionContext): ContextStatus {
    this.decider.setContext(context);
    return this.contextStatus();
  }

  /** Decider status, also failing when the tracker's model tag is not the gallery's. */
  contextStatus(): ContextStatus {
    const st = this.decider.contextStatus();
    if (st.ok && this.decider.contextModelTag() !== this.tracker.modelTag) {
      return { ...st, ok: false, reason: "tracker model tag differs from the gallery's" };
    }
    return st;
  }

  private closeDecided(results: TrackDecisionResult[]): void {
    for (const r of results) this.tracker.closeEvidence(r.outcome.trackId);
  }
}
