/**
 * Multi-face tracker for the real-time gate pipeline (plan section 2, step 2).
 *
 * Several people can be in view at once. The tracker follows every face across
 * frames so that each person becomes ONE track, and it tells the caller which
 * faces are worth an ArcFace run (`plan()` -> `needsEmbedding`). Deciding who a
 * track is lives in trackDecision.ts; this module only answers "which face in
 * this frame is which person".
 *
 * Algorithm (ByteTrack association + OC-SORT style re-update, simplified for
 * a handful of faces at ~8 fps):
 *  - Motion: constant-velocity alpha-beta filter on box centre and size.
 *    Prediction over a gap is capped (`maxExtrapolateMs`) so a hidden face does
 *    not drift away. When a track is matched again after missing frames, its
 *    velocity is re-estimated from the last two OBSERVATIONS (OC-SORT's
 *    observation-centric re-update) instead of trusting the drifted state.
 *  - Association, two stages: high-score detections against every live track
 *    (IoU >= iouHigh), then low-score detections against the remaining
 *    confirmed/lost tracks (IoU >= iouLow). Low-score detections keep a track
 *    alive through detector flicker but never start or confirm one.
 *    Greedy by score, deterministic tie-breaks (track creation order, then
 *    detection index); with a few faces greedy equals Hungarian in practice.
 *  - Motion stage (third): a face walking past close to the camera moves about
 *    a box width per frame, so consecutive boxes do not overlap and IoU alone
 *    starts a new track on every frame. High-score detections still unmatched
 *    are paired with still unmatched, recently seen, undecided tracks by centre
 *    distance to the predicted position, inside a speed-bounded reach
 *    (`motionMaxSpeed` box widths per second for a track without a velocity
 *    estimate, `motionSlack` around the prediction otherwise) and a similar
 *    box size. Only an unambiguous mutual nearest pair is taken; anything else
 *    is left to the embedding (tie-break request, re-attach by embedding).
 *    A decided track (evidence closed) is never extended by motion alone, so
 *    another person cannot be absorbed into an outcome already given.
 *  - Ambiguity (people crossing/overlapping): a detection whose best two
 *    candidate tracks (or a track whose best two candidate detections) are
 *    within `ambiguityMargin` IoU is ambiguous. If the caller supplied an
 *    embedding, a pair whose cosine clears `sameCosine` (0.45, the site's
 *    same-person value STRANGER_SAME_PERSON_COSINE) wins the tie.
 *  - Identity guard: a pair whose embedding is clearly another person
 *    (cosine < `splitCosine`) is cut; the face may then re-attach to a lost
 *    track by embedding, or start a new track. An embedding between split and
 *    same cosine is kept out of the evidence ("conflict") - it never mixes two
 *    people into one decision.
 *  - Lifecycle: tentative -> confirmed after `confirmHits` hits; a tentative
 *    track that misses `tentativeMaxMissMs` is dropped silently (flicker, not a
 *    person); confirmed -> lost after `lostAfterMs` without a match; ended after
 *    `endAfterMs`. Lost tracks can still be matched (occlusion). A tentative
 *    track that has not been OFFERED a frame since its last hit (the loop was
 *    busy, e.g. embedding) has not missed anything: it is kept up to
 *    `tentativeGraceMs`, so a slow frame cannot kill every new track.
 *
 * Evidence rules: only `usable` faces (detector said clear, >= minFacePx on the
 * source picture, score >= minUsableScore) may carry an embedding into the
 * evidence. Unclear faces still keep their track alive.
 *
 * Embedding budget (`plan()`): a face is embedded only when its track is new,
 * the track still has fewer than `minEvidenceFrames` embeddings, the face is
 * clearly better (selection score >= best embedded * (1 + betterGain)), or it is
 * needed to resolve an ambiguous association. Never more than
 * `maxEmbeddingsPerTrack` per track, never more than `maxEmbeddingsPerFrame` per
 * frame, never for a track whose evidence has been closed (already decided).
 * Within a frame the order is: tie-breaks, then tracks still short of evidence
 * (fewest evidence frames first, so two people take turns), then clearly better
 * faces and refreshes, and last a face that would start a new track.
 *  - One embedding per frame by default: ArcFace runs in the same thread as
 *    the detector, so every embedding delays the next frame by its full cost.
 *  - "refresh": an undecided track keeps sampling, at most once per
 *    `refreshAfterMs`, faces about as good as its best one. The selection
 *    score saturates for large faces, so "clearly better" alone stops asking
 *    exactly when a walking person is closest.
 *  - "new": a face that would start a new track comes last, so it never takes
 *    the frame's embedding from an existing track. When it had to wait, the
 *    young track's first embedding is compared with established tracks nearby
 *    that lost their box: on a match the face goes back to that track and the
 *    young one ends as "merged" with no outcome, so a person who was already
 *    decided is not decided a second time under a new id.
 *  - A "conflict" embedding is not evidence and does not use the track's
 *    evidence budget; it has its own small bound (`maxConflictsPerTrack`).
 *  - "reseed": a conflicting face that is clearly better than everything the
 *    reference was built from replaces the reference (a first embedding taken
 *    from a small far face is a poor reference for the same person close up).
 *    The earlier, weaker evidence is dropped by the decision layer as well.
 *
 * Quality here is CAPTURE quality (size x sharpness, from faceQuality) weighted
 * by frontality for frame selection. It is not presentation-attack detection
 * and says nothing about liveness.
 *
 * Pure logic: no I/O, no models, no timers. Time comes from frame capture
 * timestamps and from an injectable clock for `tick()`. Embeddings are held
 * only while a track lives (a running mean for the identity guard) and are
 * dropped when the track ends; snapshots never expose them.
 */

import type { FaceDetection, Frame, Gate, TrackUpdate } from "./contracts";
import { assertGateId, trackIdPrefix } from "./gateId";
import { CLEAR_FACE_LIMITS, EMBEDDING_DIM, facePose, iou } from "../faceEmbedding";
import { STRANGER_SAME_PERSON_COSINE } from "../strangers";

export type Box = [number, number, number, number];
export type TrackState = "tentative" | "confirmed" | "lost";
export type EmbeddingReason = "new" | "evidence" | "better" | "refresh" | "tiebreak";
/**
 * What happened to an embedding the caller supplied:
 *  none         no embedding given
 *  evidence     accepted as evidence for the track (TrackUpdate.embedding set)
 *  reseed       doubtful against the reference but clearly better than the faces it was built from:
 *               evidence, and the reference (and the decider's evidence) restart from this face
 *  conflict     doubtful against the track so far (between split and same cosine); not evidence,
 *               not charged to the evidence budget
 *  closed       the track is already decided; used for association only
 *  over-budget  the track already used its embedding budget; not evidence
 *  unusable     the face is not clear / too small; not evidence
 *  invalid      wrong model tag, wrong length, non-finite or zero vector
 */
export type EmbeddingStatus = "none" | "evidence" | "reseed" | "conflict" | "closed" | "over-budget" | "unusable" | "invalid";
export type DetectionRejectReason = "invalid-detection" | "below-floor" | "overload" | "track-limit";
/** "merged": a young track without evidence turned out, at its first embedding, to be an established track nearby. */
export type TrackEndReason = "timeout" | "reset" | "shutdown" | "merged";
export type FrameRejectReason = "invalid-frame" | "wrong-gate" | "stale-frame";

export interface TrackerConfig {
  /** Detections at or above this score take part in the first association stage. */
  highScore: number;
  /** Detections below this score are ignored entirely. */
  lowScore: number;
  /** Only detections at or above this score may start a track. */
  newTrackScore: number;
  /** Minimum detector score for a face to count as evidence. */
  minUsableScore: number;
  /** IoU gate of the first (high-score) stage. */
  iouHigh: number;
  /** IoU gate of the second (low-score) stage. */
  iouLow: number;
  /** Two candidates closer than this in IoU make an association ambiguous. */
  ambiguityMargin: number;
  confirmHits: number;
  tentativeMaxMissMs: number;
  /** A tentative track not offered any frame since its last hit is kept this long (>= tentativeMaxMissMs). */
  tentativeGraceMs: number;
  lostAfterMs: number;
  endAfterMs: number;
  maxExtrapolateMs: number;
  /** Alpha-beta gains (position, velocity). */
  alpha: number;
  beta: number;
  /** Same-person cosine used as the association tie-breaker. */
  sameCosine: number;
  /** Below this cosine the face is another person: the pair is cut. */
  splitCosine: number;
  /** Re-attach by embedding only within this many box widths of the track. */
  reidMaxCenterDist: number;
  /**
   * Motion stage: farthest a face may travel, in box widths per second, to still
   * join a track that has no velocity estimate yet. 0 turns the stage off.
   */
  motionMaxSpeed: number;
  /** Motion stage: allowed error around the predicted position, in box widths per second. */
  motionSlack: number;
  /** Motion stage: reach at zero elapsed time, in box widths. */
  motionBase: number;
  /** Motion stage: largest box-width ratio between track and detection. */
  motionMaxSizeRatio: number;
  maxEmbeddingsPerTrack: number;
  /** Embeddings that looked like another person ("conflict") a track may spend before it stops asking. */
  maxConflictsPerTrack: number;
  /** Embed the first N usable frames of a track regardless of quality gain. */
  minEvidenceFrames: number;
  /** An undecided track asks again after this long without an embedding (0 = never). */
  refreshAfterMs: number;
  /** ... for a face whose selection score is at least this share of the best embedded one. */
  refreshMinRatio: number;
  /** Relative selection-score gain that makes a face "clearly better" (0.1 = +10%). */
  betterGain: number;
  maxEmbeddingsPerFrame: number;
  maxDetectionsPerFrame: number;
  maxTracks: number;
  /** Shorter face side in SOURCE pixels (the 60 px rule). */
  minFacePx: number;
  embeddingDims: number;
}

export const DEFAULT_TRACKER_CONFIG: Readonly<TrackerConfig> = Object.freeze({
  highScore: 0.6,
  lowScore: 0.3,
  newTrackScore: 0.6,
  minUsableScore: 0.5,
  iouHigh: 0.3,
  iouLow: 0.5,
  ambiguityMargin: 0.15,
  confirmHits: 2,
  tentativeMaxMissMs: 500,
  tentativeGraceMs: 1200,
  lostAfterMs: 1000,
  endAfterMs: 2000,
  maxExtrapolateMs: 500,
  alpha: 0.7,
  beta: 0.3,
  sameCosine: STRANGER_SAME_PERSON_COSINE,
  splitCosine: 0.25,
  reidMaxCenterDist: 3,
  motionMaxSpeed: 8,
  motionSlack: 3,
  motionBase: 0.5,
  motionMaxSizeRatio: 1.6,
  maxEmbeddingsPerTrack: 8,
  maxConflictsPerTrack: 3,
  minEvidenceFrames: 2,
  betterGain: 0.1,
  refreshAfterMs: 500,
  refreshMinRatio: 0.8,
  maxEmbeddingsPerFrame: 1,
  maxDetectionsPerFrame: 24,
  maxTracks: 16,
  minFacePx: CLEAR_FACE_LIMITS.minFacePx,
  embeddingDims: EMBEDDING_DIM,
});

/** One face handed to the tracker. Embedding only when plan() asked for it. */
export interface TrackerInput {
  detection: FaceDetection;
  /** 0..1 capture quality from faceQuality(); a size x score proxy is used when missing. */
  quality?: number;
  embedding?: Float32Array;
  /** Model tag of the recogniser that produced `embedding`; must equal the tracker's. */
  embeddingModelTag?: string;
}

export interface EmbeddingRequest {
  /** Index into the inputs passed to plan(). */
  index: number;
  /** Track the face would join; null when it would start a new track. */
  trackId: string | null;
  reason: EmbeddingReason;
}

export interface TrackerPlan {
  /** Index-aligned with the inputs: run ArcFace for these faces only. */
  needsEmbedding: boolean[];
  requests: EmbeddingRequest[];
}

/** A face associated with a track in this frame (contract TrackUpdate + tracker detail). */
export interface TrackedFace extends TrackUpdate {
  detectionIndex: number;
  state: TrackState;
  /** Clear, >= minFacePx and >= minUsableScore: may count as evidence. */
  usable: boolean;
  /** quality x frontality, used to pick best frames. */
  selectScore: number;
  newTrack: boolean;
  embeddingStatus: EmbeddingStatus;
  /** Cosine against the track's evidence so far, when both existed. */
  identityCosine?: number;
}

export interface TrackEnd {
  trackId: string;
  gate: Gate;
  reason: TrackEndReason;
  /** Reason "merged" only: the established track that continues instead. No outcome is owed for this one. */
  mergedInto?: string;
  /** False for tentative tracks (detector flicker): no outcome is owed. */
  confirmed: boolean;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  endedAtMs: number;
  hits: number;
  usableFrames: number;
  /** Embeddings spent on the track's evidence budget (evidence + association checks after the decision). */
  embeddingsUsed: number;
  /** Embeddings that looked like another person and were kept out of the evidence. */
  conflicts: number;
  /** Embeddings accepted as evidence. */
  evidenceFrames: number;
}

export interface TrackerStep {
  gate: Gate;
  modelTag: string;
  frameSeq: number;
  atMs: number;
  accepted: boolean;
  reason?: FrameRejectReason;
  /** One entry per associated face, ordered by track creation. */
  updates: TrackedFace[];
  /** Tracks that became confirmed in this frame. */
  confirmed: string[];
  /** Tracks that ended before or while this frame was processed. */
  ended: TrackEnd[];
  rejected: Array<{ index: number; reason: DetectionRejectReason }>;
}

/**
 * Running totals of what the tracker did with its tracks and embeddings.
 * Diagnostics only (worker stats); never an input to a decision.
 */
export interface TrackCounters {
  /** Tracks ended, any reason. */
  ended: number;
  /** Ended without ever being confirmed (detector flicker, a face seen once). Merged tracks are not counted here. */
  unconfirmed: number;
  /** Young tracks folded into an established track of the same person (reason "merged"). */
  merged: number;
  /** Embeddings run for tracks that then ended unconfirmed: inference spent, no outcome. */
  embeddingsUnconfirmed: number;
  /** Embeddings kept out of the evidence because they did not look like the track's person. */
  conflicts: number;
  /** Times a clearly better face restarted a track's weak reference. */
  reseeds: number;
}

export function newTrackCounters(): TrackCounters {
  return { ended: 0, unconfirmed: 0, merged: 0, embeddingsUnconfirmed: 0, conflicts: 0, reseeds: 0 };
}

/** Add the ended tracks to the totals. */
export function countTrackEnds(c: TrackCounters, ends: readonly TrackEnd[]): void {
  for (const e of ends || []) {
    c.ended += 1;
    if (e.reason === "merged") c.merged += 1;
    else if (!e.confirmed) {
      c.unconfirmed += 1;
      // Conflicts are not charged to the budget, but each one was an embedding run.
      c.embeddingsUnconfirmed += e.embeddingsUsed + e.conflicts;
    }
  }
}

/** Add one tracker step (its embedding statuses and its ended tracks) to the totals. */
export function countTrackerStep(c: TrackCounters, step: TrackerStep): void {
  for (const u of step.updates || []) {
    if (u.embeddingStatus === "conflict") c.conflicts += 1;
    else if (u.embeddingStatus === "reseed") c.reseeds += 1;
  }
  countTrackEnds(c, step.ended);
}

export interface TrackSnapshot {
  trackId: string;
  state: TrackState;
  box: Box;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  firstUsableAtMs?: number;
  hits: number;
  usableFrames: number;
  embeddingsUsed: number;
  conflicts: number;
  evidenceFrames: number;
  evidenceClosed: boolean;
}

export interface TrackerOptions {
  gate: Gate;
  /** Model tag of the running recogniser (e.g. "arcface_w600k_r50"). Required. */
  modelTag: string;
  config?: Partial<TrackerConfig>;
  clock?: () => number;
  /** Prefix of track ids; defaults to `<trackIdPrefix(gate)>-<clock() base36>` so ids differ across restarts. */
  idPrefix?: string;
}

type Vec4 = [number, number, number, number];

interface Track {
  id: string;
  order: number;
  state: TrackState;
  /** Filter state (cx, cy, w, h) at time `t`, and its velocity per ms. */
  x: Vec4;
  v: Vec4;
  t: number;
  lastObs: Vec4;
  lastObsAt: number;
  missed: boolean;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  firstUsableAtMs?: number;
  hits: number;
  usableFrames: number;
  embeddingsUsed: number;
  conflicts: number;
  /** Capture time of the last frame whose embedding was used for this track (-Infinity: none yet). */
  lastEmbeddingAtMs: number;
  evidenceFrames: number;
  bestEvidenceSelect: number;
  refSum: Float64Array | null;
  ref: Float32Array | null;
  evidenceClosed: boolean;
}

interface Det {
  index: number;
  input: TrackerInput;
  detection: FaceDetection;
  box: Box;
  score: number;
  usable: boolean;
  quality: number;
  select: number;
  embedding: Float32Array | null;
  embeddingInvalid: boolean;
}

interface Association {
  pairs: Array<[number, number]>; // [track index, det index]
  ambiguous: Map<number, Set<number>>; // det index -> candidate track indexes
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function validateConfig(c: TrackerConfig): void {
  for (const [k, v] of Object.entries(c)) {
    if (!isNum(v) || v < 0) throw new RangeError(`tracker config ${k} must be a finite non-negative number`);
  }
  if (!(c.lowScore <= c.highScore && c.highScore <= 1)) throw new RangeError("tracker config: lowScore <= highScore <= 1");
  if (!(c.lostAfterMs <= c.endAfterMs)) throw new RangeError("tracker config: lostAfterMs <= endAfterMs");
  if (!(c.splitCosine <= c.sameCosine)) throw new RangeError("tracker config: splitCosine <= sameCosine");
  if (!(c.tentativeMaxMissMs <= c.tentativeGraceMs)) throw new RangeError("tracker config: tentativeMaxMissMs <= tentativeGraceMs");
  if (!(c.motionMaxSizeRatio >= 1)) throw new RangeError("tracker config: motionMaxSizeRatio >= 1");
  for (const k of ["confirmHits", "maxEmbeddingsPerTrack", "maxEmbeddingsPerFrame", "maxDetectionsPerFrame", "maxTracks", "embeddingDims", "minEvidenceFrames"] as const) {
    if (!Number.isInteger(c[k]) || c[k] < 1) throw new RangeError(`tracker config ${k} must be a positive integer`);
  }
}

const toVec = (b: Box): Vec4 => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, b[2] - b[0], b[3] - b[1]];
const toBox = (x: Vec4): Box => {
  const w = Math.max(1, x[2]);
  const h = Math.max(1, x[3]);
  return [x[0] - w / 2, x[1] - h / 2, x[0] + w / 2, x[1] + h / 2];
};

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** L2-normalised copy, or null when the vector is unusable. */
function normalizedCopy(v: ArrayLike<number>, dims: number): Float32Array | null {
  if (!v || v.length !== dims) return null;
  let n = 0;
  for (let i = 0; i < dims; i++) {
    const x = v[i];
    if (!isNum(x)) return null;
    n += x * x;
  }
  n = Math.sqrt(n);
  if (!(n > 1e-6)) return null;
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i++) out[i] = v[i] / n;
  return out;
}

/** Frontality factor 0.5..1 from the five landmarks (1 = facing the camera). */
function frontality(landmarks: FaceDetection["landmarks"]): number {
  try {
    const pose = Array.isArray(landmarks) && landmarks.length >= 5 ? facePose(landmarks) : null;
    if (!pose) return 1;
    return 1 - 0.5 * clamp01(Math.abs(pose.yaw) / Math.max(1e-6, CLEAR_FACE_LIMITS.maxYaw));
  } catch {
    return 1;
  }
}

export class FaceTracker {
  readonly gate: Gate;
  readonly modelTag: string;
  readonly config: Readonly<TrackerConfig>;
  private readonly clock: () => number;
  private readonly idPrefix: string;
  private tracks: Track[] = [];
  private nextOrder = 1;
  private lastFrameAtMs: number | null = null;
  private frameKey: string | null = null;

  constructor(opts: TrackerOptions) {
    assertGateId(opts?.gate, "tracker gate");
    if (typeof opts.modelTag !== "string" || opts.modelTag.trim() === "") throw new TypeError("tracker modelTag is required");
    const config = { ...DEFAULT_TRACKER_CONFIG, ...(opts.config || {}) };
    validateConfig(config);
    this.gate = opts.gate;
    this.modelTag = opts.modelTag;
    this.config = Object.freeze(config);
    this.clock = opts.clock ?? Date.now;
    this.idPrefix = opts.idPrefix ?? `${trackIdPrefix(opts.gate)}-${Math.max(0, Math.floor(this.clock())).toString(36)}`;
  }

  /** Live tracks, without any embedding data. */
  snapshot(): TrackSnapshot[] {
    return this.tracks.map((tr) => ({
      trackId: tr.id,
      state: tr.state,
      box: toBox(tr.x),
      firstSeenAtMs: tr.firstSeenAtMs,
      lastSeenAtMs: tr.lastSeenAtMs,
      firstUsableAtMs: tr.firstUsableAtMs,
      hits: tr.hits,
      usableFrames: tr.usableFrames,
      embeddingsUsed: tr.embeddingsUsed,
      conflicts: tr.conflicts,
      evidenceFrames: tr.evidenceFrames,
      evidenceClosed: tr.evidenceClosed,
    }));
  }

  /** Stop asking for embeddings for a decided track (it stays tracked to avoid a second outcome). */
  closeEvidence(trackId: string): void {
    const tr = this.tracks.find((t) => t.id === trackId);
    if (tr) {
      tr.evidenceClosed = true;
    }
  }

  /**
   * Dry run: which faces of this frame should be embedded before update().
   * Does not change any state; call update() with the same frame afterwards.
   */
  plan(frame: Frame, inputs: readonly TrackerInput[]): TrackerPlan {
    const list = Array.isArray(inputs) ? inputs : [];
    const needsEmbedding = list.map(() => false);
    if (this.frameProblem(frame)) return { needsEmbedding, requests: [] };
    const t = frame.capturedAtMs;
    const reset = this.frameKey !== null && this.frameKey !== frameKeyOf(frame);
    const live = reset ? [] : this.tracks.filter((tr) => !this.wouldEnd(tr, t));
    const { dets } = this.sanitize(list, false);
    const preds = live.map((tr) => toBox(this.predict(tr, t)));
    const assoc = this.associate(live, preds, dets, false, t);
    const byDet = new Map<number, number>();
    for (const [ti, di] of assoc.pairs) byDet.set(di, ti);

    const c = this.config;
    const hasRoomForNew = live.length < c.maxTracks || live.some((tr) => tr.state !== "tentative" && tr.ref);
    const candidates: Array<EmbeddingRequest & { prio: number; select: number; have: number }> = [];
    dets.forEach((d, di) => {
      if (!d.usable) return;
      const amb = assoc.ambiguous.get(di);
      if (amb && amb.size >= 2) {
        const cands = [...amb].map((ti) => live[ti]);
        if (cands.some((tr) => tr.ref) && cands.every((tr) => tr.embeddingsUsed < c.maxEmbeddingsPerTrack)) {
          const ti = byDet.get(di);
          candidates.push({ index: d.index, trackId: ti === undefined ? null : live[ti].id, reason: "tiebreak", prio: 0, select: d.select, have: 0 });
          return;
        }
      }
      const ti = byDet.get(di);
      if (ti === undefined) {
        // Last in the frame: never takes the embedding from an existing track.
        if (d.score >= c.newTrackScore && hasRoomForNew) {
          candidates.push({ index: d.index, trackId: null, reason: "new", prio: 3, select: d.select, have: 0 });
        }
        return;
      }
      const tr = live[ti];
      if (tr.evidenceClosed || tr.embeddingsUsed >= c.maxEmbeddingsPerTrack || tr.conflicts >= c.maxConflictsPerTrack) return;
      if (tr.evidenceFrames < c.minEvidenceFrames) {
        candidates.push({ index: d.index, trackId: tr.id, reason: "evidence", prio: 1, select: d.select, have: tr.evidenceFrames });
      } else if (d.select >= tr.bestEvidenceSelect * (1 + c.betterGain) && d.select > 0) {
        candidates.push({ index: d.index, trackId: tr.id, reason: "better", prio: 2, select: d.select, have: tr.evidenceFrames });
      } else if (
        c.refreshAfterMs > 0 && d.select > 0 && t - tr.lastEmbeddingAtMs >= c.refreshAfterMs &&
        d.select >= tr.bestEvidenceSelect * c.refreshMinRatio
      ) {
        candidates.push({ index: d.index, trackId: tr.id, reason: "refresh", prio: 2, select: d.select, have: tr.evidenceFrames });
      }
    });
    // Same priority: the track with the least evidence first, so people take turns under a small per-frame cap.
    candidates.sort((a, b) => a.prio - b.prio || a.have - b.have || b.select - a.select || a.index - b.index);
    const requests = candidates.slice(0, c.maxEmbeddingsPerFrame).map(({ index, trackId, reason }) => ({ index, trackId, reason }));
    requests.sort((a, b) => a.index - b.index);
    for (const r of requests) needsEmbedding[r.index] = true;
    return { needsEmbedding, requests };
  }

  /** Feed one frame's faces (with the embeddings plan() asked for). */
  update(frame: Frame, inputs: readonly TrackerInput[]): TrackerStep {
    const step: TrackerStep = {
      gate: this.gate,
      modelTag: this.modelTag,
      frameSeq: isNum(frame?.seq) ? frame.seq : -1,
      atMs: isNum(frame?.capturedAtMs) ? frame.capturedAtMs : -1,
      accepted: false,
      updates: [],
      confirmed: [],
      ended: [],
      rejected: [],
    };
    const problem = this.frameProblem(frame);
    if (problem) {
      step.reason = problem;
      return step;
    }
    step.accepted = true;
    const t = frame.capturedAtMs;
    const key = frameKeyOf(frame);
    if (this.frameKey !== null && this.frameKey !== key) {
      // Another stream or gate area: boxes are no longer comparable.
      step.ended.push(...this.endAll("reset", t));
    }
    this.frameKey = key;
    this.lastFrameAtMs = t;
    step.ended.push(...this.expire(t));

    const { dets, rejected } = this.sanitize(Array.isArray(inputs) ? inputs : [], true);
    step.rejected.push(...rejected);
    const c = this.config;
    const live = this.tracks;
    const preds = live.map((tr) => toBox(this.predict(tr, t)));
    const assoc = this.associate(live, preds, dets, true, t);

    // Identity guard: cut pairs whose embedding is clearly another person.
    const identity = new Map<number, number>(); // det index -> cosine vs its track
    const pairs: Array<[number, number]> = [];
    for (const [ti, di] of assoc.pairs) {
      const tr = live[ti];
      const d = dets[di];
      if (d.embedding && tr.ref) {
        const cos = dot(d.embedding, tr.ref);
        if (cos < c.splitCosine) continue;
        identity.set(di, cos);
      }
      pairs.push([ti, di]);
    }
    // Merge by identity: the first embedding of a track that has no evidence yet. If it matches an
    // established track nearby that has no face in this frame, that track continues and the young one ends.
    const merged = new Map<number, number>(); // young track index -> established track index
    {
      const taken = new Set(pairs.map((p) => p[0]));
      for (const pair of pairs) {
        const young = live[pair[0]];
        const d = dets[pair[1]];
        if (young.ref || young.evidenceClosed || !d.embedding || !d.usable) continue;
        let best = -1;
        let bestCos = c.sameCosine;
        live.forEach((tr, ti) => {
          if (taken.has(ti) || !tr.ref || !this.reidInReach(tr, preds[ti], d)) return;
          const cos = dot(d.embedding!, tr.ref);
          if (cos >= bestCos && (best < 0 || cos > bestCos)) {
            best = ti;
            bestCos = cos;
          }
        });
        if (best < 0) continue;
        merged.set(pair[0], best);
        taken.add(best);
        pair[0] = best;
        identity.set(pair[1], bestCos);
      }
    }
    const matchedT = new Set(pairs.map((p) => p[0]));
    const matchedD = new Set(pairs.map((p) => p[1]));

    // Re-attach by embedding: a usable face that lost its box overlap (occlusion, jump).
    dets.forEach((d, di) => {
      if (matchedD.has(di) || !d.embedding || !d.usable) return;
      let best = -1;
      let bestCos = c.sameCosine;
      live.forEach((tr, ti) => {
        if (matchedT.has(ti) || !tr.ref || !this.reidInReach(tr, preds[ti], d)) return;
        const cos = dot(d.embedding!, tr.ref);
        if (cos >= bestCos && (best < 0 || cos > bestCos)) {
          best = ti;
          bestCos = cos;
        }
      });
      if (best >= 0) {
        pairs.push([best, di]);
        matchedT.add(best);
        matchedD.add(di);
        identity.set(di, bestCos);
      }
    });

    for (const [ti, di] of pairs) {
      const tr = live[ti];
      const d = dets[di];
      const wasTentative = tr.state === "tentative";
      this.observe(tr, d, t);
      if (wasTentative && tr.state === "confirmed") step.confirmed.push(tr.id);
      step.updates.push(this.face(frame, tr, d, false, identity.get(di)));
    }
    live.forEach((tr, ti) => {
      if (!matchedT.has(ti)) tr.missed = true;
    });
    if (merged.size > 0) {
      for (const [yi, oi] of merged) step.ended.push({ ...this.endRecord(live[yi], "merged", t), mergedInto: live[oi].id });
      this.tracks = live.filter((_, ti) => !merged.has(ti));
    }

    dets.forEach((d, di) => {
      if (matchedD.has(di) || d.score < c.newTrackScore) return;
      if (this.tracks.length >= c.maxTracks) {
        step.rejected.push({ index: d.index, reason: "track-limit" });
        return;
      }
      const tr = this.newTrack(d, t);
      if (tr.state === "confirmed") step.confirmed.push(tr.id);
      step.updates.push(this.face(frame, tr, d, true, undefined));
    });

    const order = new Map(this.tracks.map((tr) => [tr.id, tr.order]));
    step.updates.sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0));
    step.rejected.sort((a, b) => a.index - b.index);
    return step;
  }

  /** Advance time without a frame (stalled stream): expires tracks. */
  tick(nowMs: number = this.clock()): TrackEnd[] {
    if (!isNum(nowMs)) return [];
    return this.expire(nowMs);
  }

  /** End every track (shutdown, gate reconfigured). */
  endAll(reason: TrackEndReason = "shutdown", nowMs: number = this.clock()): TrackEnd[] {
    const ended = this.tracks.map((tr) => this.endRecord(tr, reason, nowMs));
    this.tracks = [];
    return ended;
  }

  // -------------------------------------------------------------------------

  private frameProblem(frame: Frame): FrameRejectReason | null {
    if (!frame || typeof frame !== "object" || !isNum(frame.capturedAtMs) || !isNum(frame.width) || !isNum(frame.height) || frame.width <= 0 || frame.height <= 0) {
      return "invalid-frame";
    }
    if (frame.gate !== this.gate) return "wrong-gate";
    if (this.lastFrameAtMs !== null && frame.capturedAtMs < this.lastFrameAtMs) return "stale-frame";
    return null;
  }

  private wouldEnd(tr: Track, t: number): boolean {
    const since = t - tr.lastSeenAtMs;
    if (tr.state === "tentative") {
      if (since <= this.config.tentativeMaxMissMs) return false;
      // Not offered a frame since its last hit (the loop was busy): nothing was missed yet.
      return tr.missed || since > this.config.tentativeGraceMs;
    }
    return since >= this.config.endAfterMs;
  }

  private expire(t: number): TrackEnd[] {
    const ended: TrackEnd[] = [];
    const keep: Track[] = [];
    for (const tr of this.tracks) {
      if (this.wouldEnd(tr, t)) {
        ended.push(this.endRecord(tr, "timeout", t));
        continue;
      }
      if (tr.state === "confirmed" && t - tr.lastSeenAtMs >= this.config.lostAfterMs) tr.state = "lost";
      keep.push(tr);
    }
    this.tracks = keep;
    return ended;
  }

  private endRecord(tr: Track, reason: TrackEndReason, t: number): TrackEnd {
    // Drop the identity vectors as soon as the track is over.
    tr.ref = null;
    tr.refSum = null;
    return {
      trackId: tr.id,
      gate: this.gate,
      reason,
      confirmed: tr.state !== "tentative",
      firstSeenAtMs: tr.firstSeenAtMs,
      lastSeenAtMs: tr.lastSeenAtMs,
      endedAtMs: t,
      hits: tr.hits,
      usableFrames: tr.usableFrames,
      embeddingsUsed: tr.embeddingsUsed,
      conflicts: tr.conflicts,
      evidenceFrames: tr.evidenceFrames,
    };
  }

  private sanitize(inputs: readonly TrackerInput[], withEmbeddings: boolean): { dets: Det[]; rejected: TrackerStep["rejected"] } {
    const c = this.config;
    const rejected: TrackerStep["rejected"] = [];
    const valid: Det[] = [];
    inputs.forEach((input, index) => {
      const det = input?.detection;
      const b = det?.box;
      if (
        !det || !Array.isArray(b) || b.length !== 4 || !b.every(isNum) || !(b[2] > b[0]) || !(b[3] > b[1]) ||
        !isNum(det.score) || det.score < 0 || det.score > 1 || !isNum(det.sizePx) || det.sizePx < 0
      ) {
        rejected.push({ index, reason: "invalid-detection" });
        return;
      }
      if (det.score < c.lowScore) {
        rejected.push({ index, reason: "below-floor" });
        return;
      }
      const box: Box = [b[0], b[1], b[2], b[3]];
      const usable = det.clear === true && det.sizePx >= c.minFacePx && det.score >= c.minUsableScore;
      const quality = isNum(input.quality) && input.quality >= 0 && input.quality <= 1
        ? input.quality
        : clamp01((det.sizePx - 24) / 88) * det.score;
      let embedding: Float32Array | null = null;
      let embeddingInvalid = false;
      if (withEmbeddings && input.embedding !== undefined) {
        embedding = input.embeddingModelTag === this.modelTag ? normalizedCopy(input.embedding, c.embeddingDims) : null;
        embeddingInvalid = embedding === null;
      }
      valid.push({
        index, input, detection: det, box, score: det.score, usable, quality,
        select: quality * frontality(det.landmarks), embedding, embeddingInvalid,
      });
    });
    let dets = valid;
    if (valid.length > c.maxDetectionsPerFrame) {
      const ranked = [...valid].sort((a, b) => b.score - a.score || a.index - b.index);
      const kept = new Set(ranked.slice(0, c.maxDetectionsPerFrame).map((d) => d.index));
      for (const d of ranked.slice(c.maxDetectionsPerFrame)) rejected.push({ index: d.index, reason: "overload" });
      dets = valid.filter((d) => kept.has(d.index));
    }
    return { dets, rejected };
  }

  private predict(tr: Track, t: number): Vec4 {
    const dt = Math.min(Math.max(0, t - tr.t), this.config.maxExtrapolateMs);
    return [tr.x[0] + tr.v[0] * dt, tr.x[1] + tr.v[1] * dt, tr.x[2] + tr.v[2] * dt, tr.x[3] + tr.v[3] * dt];
  }

  private associate(tracks: Track[], preds: Box[], dets: Det[], useEmbeddings: boolean, t: number): Association {
    const c = this.config;
    const pairs: Array<[number, number]> = [];
    const ambiguous = new Map<number, Set<number>>();
    const takenT = new Set<number>();
    const takenD = new Set<number>();

    const stage = (tIdx: number[], dIdx: number[], thr: number) => {
      const cands: Array<{ ti: number; di: number; iou: number; score: number }> = [];
      for (const ti of tIdx) {
        for (const di of dIdx) {
          const u = iou(preds[ti], dets[di].box);
          if (u >= thr) cands.push({ ti, di, iou: u, score: u });
        }
      }
      const mark = (di: number, ti: number) => {
        const s = ambiguous.get(di) ?? new Set<number>();
        s.add(ti);
        ambiguous.set(di, s);
      };
      const byDet = new Map<number, typeof cands>();
      const byTrack = new Map<number, typeof cands>();
      for (const x of cands) {
        (byDet.get(x.di) ?? byDet.set(x.di, []).get(x.di)!).push(x);
        (byTrack.get(x.ti) ?? byTrack.set(x.ti, []).get(x.ti)!).push(x);
      }
      for (const list of byDet.values()) {
        list.sort((a, b) => b.iou - a.iou || tracks[a.ti].order - tracks[b.ti].order);
        if (list.length >= 2 && list[0].iou - list[1].iou < c.ambiguityMargin) {
          for (const x of list) if (list[0].iou - x.iou < c.ambiguityMargin) mark(x.di, x.ti);
        }
      }
      for (const list of byTrack.values()) {
        list.sort((a, b) => b.iou - a.iou || a.di - b.di);
        if (list.length >= 2 && list[0].iou - list[1].iou < c.ambiguityMargin) {
          for (const x of list) {
            if (list[0].iou - x.iou >= c.ambiguityMargin) continue;
            // The detection is contested: every track that wanted it is a candidate.
            for (const y of byDet.get(x.di) ?? []) mark(x.di, y.ti);
            for (const z of list) if (list[0].iou - z.iou < c.ambiguityMargin) mark(x.di, z.ti);
          }
        }
      }
      if (useEmbeddings) {
        for (const x of cands) {
          const e = dets[x.di].embedding;
          const ref = tracks[x.ti].ref;
          if (e && ref && dot(e, ref) >= c.sameCosine) x.score += 1;
        }
      }
      cands.sort((a, b) => b.score - a.score || tracks[a.ti].order - tracks[b.ti].order || a.di - b.di);
      for (const x of cands) {
        if (takenT.has(x.ti) || takenD.has(x.di)) continue;
        takenT.add(x.ti);
        takenD.add(x.di);
        pairs.push([x.ti, x.di]);
      }
    };

    const all = tracks.map((_, i) => i);
    stage(all, dets.map((_, i) => i).filter((i) => dets[i].score >= c.highScore), c.iouHigh);
    stage(
      all.filter((i) => !takenT.has(i) && tracks[i].state !== "tentative"),
      dets.map((_, i) => i).filter((i) => dets[i].score < c.highScore),
      c.iouLow,
    );
    this.associateByMotion(tracks, preds, dets, t, takenT, takenD, pairs, ambiguous);
    return { pairs, ambiguous };
  }

  /**
   * Third stage (see the header): unmatched high-score detections against
   * unmatched, recently seen, undecided tracks by centre distance to the
   * predicted position. Takes only pairs that are each other's nearest
   * candidate by a clear margin; contested detections are marked ambiguous so
   * plan() asks for an embedding and update() can re-attach by identity.
   */
  private associateByMotion(
    tracks: Track[], preds: Box[], dets: Det[], t: number,
    takenT: Set<number>, takenD: Set<number>, pairs: Array<[number, number]>, ambiguous: Map<number, Set<number>>,
  ): void {
    const c = this.config;
    if (!(c.motionMaxSpeed > 0)) return;
    const cands: Array<{ ti: number; di: number; cost: number }> = [];
    tracks.forEach((tr, ti) => {
      if (takenT.has(ti) || tr.evidenceClosed) return;
      const since = t - tr.lastSeenAtMs;
      if (since < 0 || since >= c.lostAfterMs) return;
      const p = preds[ti];
      const pw = p[2] - p[0];
      // A velocity estimate exists from the second hit on; before that only the speed bound applies.
      const speed = tr.hits >= 2 ? c.motionSlack : c.motionMaxSpeed;
      const reach = c.motionBase + (speed * Math.min(since, c.maxExtrapolateMs)) / 1000;
      dets.forEach((d, di) => {
        if (takenD.has(di) || d.score < c.highScore) return;
        const dw = d.box[2] - d.box[0];
        if (Math.max(pw, dw) > c.motionMaxSizeRatio * Math.min(pw, dw)) return;
        const w = (pw + dw) / 2;
        const dist = Math.hypot((p[0] + p[2]) / 2 - (d.box[0] + d.box[2]) / 2, (p[1] + p[3]) / 2 - (d.box[1] + d.box[3]) / 2) / w;
        if (dist <= reach) cands.push({ ti, di, cost: dist });
      });
    });
    if (cands.length === 0) return;
    cands.sort((a, b) => a.cost - b.cost || tracks[a.ti].order - tracks[b.ti].order || a.di - b.di);
    // Clear margin over the runner-up, in box widths: half as far again plus a quarter width.
    const clear = (best: number, second: number | undefined) => second === undefined || second >= best * 1.5 + 0.25;
    for (const x of cands) {
      if (takenT.has(x.ti) || takenD.has(x.di)) continue;
      const forDet = cands.filter((y) => y.di === x.di && !takenT.has(y.ti));
      const forTrack = cands.filter((y) => y.ti === x.ti && !takenD.has(y.di));
      if (forDet[0] !== x || forTrack[0] !== x) continue;
      if (!clear(x.cost, forDet[1]?.cost)) {
        const s = ambiguous.get(x.di) ?? new Set<number>();
        for (const y of forDet) if (!clear(x.cost, y.cost) || y === x) s.add(y.ti);
        ambiguous.set(x.di, s);
        continue;
      }
      if (!clear(x.cost, forTrack[1]?.cost)) continue;
      takenT.add(x.ti);
      takenD.add(x.di);
      pairs.push([x.ti, x.di]);
    }
  }

  private observe(tr: Track, d: Det, t: number): void {
    const c = this.config;
    const z = toVec(d.box);
    const gap = t - tr.lastObsAt;
    if ((tr.hits === 1 || tr.missed) && gap > 0) {
      // Observation-centric re-update: velocity from the last two observations.
      tr.v = [(z[0] - tr.lastObs[0]) / gap, (z[1] - tr.lastObs[1]) / gap, (0.5 * (z[2] - tr.lastObs[2])) / gap, (0.5 * (z[3] - tr.lastObs[3])) / gap];
      tr.x = z;
    } else {
      const dt = t - tr.t;
      const p = this.predict(tr, t);
      const r: Vec4 = [z[0] - p[0], z[1] - p[1], z[2] - p[2], z[3] - p[3]];
      tr.x = [p[0] + c.alpha * r[0], p[1] + c.alpha * r[1], p[2] + c.alpha * r[2], p[3] + c.alpha * r[3]];
      if (dt > 0) tr.v = [tr.v[0] + (c.beta * r[0]) / dt, tr.v[1] + (c.beta * r[1]) / dt, tr.v[2] + (c.beta * r[2]) / dt, tr.v[3] + (c.beta * r[3]) / dt];
    }
    tr.t = t;
    tr.lastObs = z;
    tr.lastObsAt = t;
    tr.missed = false;
    tr.hits += 1;
    tr.lastSeenAtMs = t;
    if (tr.state === "lost") tr.state = "confirmed";
    if (tr.state === "tentative" && tr.hits >= c.confirmHits && d.score >= c.highScore) tr.state = "confirmed";
    if (d.usable) {
      tr.usableFrames += 1;
      if (tr.firstUsableAtMs === undefined) tr.firstUsableAtMs = t;
    }
  }

  private newTrack(d: Det, t: number): Track {
    const z = toVec(d.box);
    const order = this.nextOrder++;
    const tr: Track = {
      id: `${this.idPrefix}-${order}`,
      order,
      state: "tentative",
      x: z,
      v: [0, 0, 0, 0],
      t,
      lastObs: z,
      lastObsAt: t,
      missed: false,
      firstSeenAtMs: t,
      lastSeenAtMs: t,
      hits: 1,
      usableFrames: 0,
      embeddingsUsed: 0,
      conflicts: 0,
      lastEmbeddingAtMs: -Infinity,
      evidenceFrames: 0,
      bestEvidenceSelect: 0,
      refSum: null,
      ref: null,
      evidenceClosed: false,
    };
    if (this.config.confirmHits <= 1) tr.state = "confirmed";
    if (d.usable) {
      tr.usableFrames = 1;
      tr.firstUsableAtMs = t;
    }
    this.tracks.push(tr);
    return tr;
  }

  /** True when `d` may be re-attached to `tr` by embedding: an established track with evidence, close enough. */
  private reidInReach(tr: Track, p: Box, d: Det): boolean {
    if (tr.state === "tentative" || !tr.ref) return false;
    const reach = this.config.reidMaxCenterDist * Math.max(p[2] - p[0], d.box[2] - d.box[0]);
    const dist = Math.hypot((p[0] + p[2]) / 2 - (d.box[0] + d.box[2]) / 2, (p[1] + p[3]) / 2 - (d.box[1] + d.box[3]) / 2);
    return dist <= reach;
  }

  /** Decide what the supplied embedding (if any) means for the track, and build the update. */
  private face(frame: Frame, tr: Track, d: Det, isNew: boolean, identityCosine: number | undefined): TrackedFace {
    const c = this.config;
    let status: EmbeddingStatus = "none";
    let evidence: Float32Array | undefined;
    if (d.embeddingInvalid) status = "invalid";
    else if (d.embedding) {
      if (!d.usable) status = "unusable";
      else if (tr.embeddingsUsed >= c.maxEmbeddingsPerTrack) status = "over-budget";
      else {
        const cos = tr.ref ? dot(d.embedding, tr.ref) : undefined;
        if (identityCosine === undefined && cos !== undefined) identityCosine = cos;
        tr.lastEmbeddingAtMs = frame.capturedAtMs;
        if (tr.evidenceClosed) {
          tr.embeddingsUsed += 1;
          status = "closed";
        } else if (cos !== undefined && cos < c.sameCosine && d.select > 0 && d.select >= tr.bestEvidenceSelect * (1 + c.betterGain)) {
          // Doubtful against the reference, but clearly better than every face the reference was
          // built from: the reference is the weak side. Start over from this face. (A face that is
          // clearly another person never gets here: update() cuts it below splitCosine.)
          tr.embeddingsUsed += 1;
          status = "reseed";
          evidence = d.embedding;
          const w = Math.max(0.05, d.quality);
          const sum = new Float64Array(d.embedding.length);
          for (let i = 0; i < sum.length; i++) sum[i] = w * d.embedding[i];
          tr.refSum = sum;
          tr.ref = normalizedCopy(sum, sum.length);
          tr.evidenceFrames = 1;
          tr.bestEvidenceSelect = d.select;
          tr.conflicts = 0;
        } else if (cos !== undefined && cos < c.sameCosine) {
          // Not evidence, and not charged to the evidence budget: a doubtful frame must not
          // use up the embeddings the track still needs. Bounded by maxConflictsPerTrack in plan().
          tr.conflicts += 1;
          status = "conflict";
        } else {
          tr.embeddingsUsed += 1;
          status = "evidence";
          evidence = d.embedding;
          const w = Math.max(0.05, d.quality);
          const sum = tr.refSum ?? new Float64Array(d.embedding.length);
          for (let i = 0; i < sum.length; i++) sum[i] += w * d.embedding[i];
          tr.refSum = sum;
          tr.ref = normalizedCopy(sum, sum.length);
          tr.evidenceFrames += 1;
          tr.bestEvidenceSelect = Math.max(tr.bestEvidenceSelect, d.select);
        }
      }
    }
    const out: TrackedFace = {
      trackId: tr.id,
      frame,
      detection: d.detection,
      quality: d.quality,
      detectionIndex: d.index,
      state: tr.state,
      usable: d.usable,
      selectScore: d.select,
      newTrack: isNew,
      embeddingStatus: status,
    };
    if (evidence) out.embedding = evidence;
    if (identityCosine !== undefined) out.identityCosine = identityCosine;
    return out;
  }
}

function frameKeyOf(frame: Frame): string {
  const r = Array.isArray(frame.roi) ? frame.roi.join(",") : "";
  return `${frame.gate}|${frame.streamId}|${frame.width}x${frame.height}|${r}`;
}
