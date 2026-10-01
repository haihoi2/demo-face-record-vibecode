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
 *    `endAfterMs`. Lost tracks can still be matched (occlusion).
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
export type EmbeddingReason = "new" | "evidence" | "better" | "tiebreak";
/**
 * What happened to an embedding the caller supplied:
 *  none         no embedding given
 *  evidence     accepted as evidence for the track (TrackUpdate.embedding set)
 *  conflict     looks like another person than the track so far; not evidence
 *  closed       the track is already decided; used for association only
 *  over-budget  the track already used its embedding budget; not evidence
 *  unusable     the face is not clear / too small; not evidence
 *  invalid      wrong model tag, wrong length, non-finite or zero vector
 */
export type EmbeddingStatus = "none" | "evidence" | "conflict" | "closed" | "over-budget" | "unusable" | "invalid";
export type DetectionRejectReason = "invalid-detection" | "below-floor" | "overload" | "track-limit";
export type TrackEndReason = "timeout" | "reset" | "shutdown";
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
  maxEmbeddingsPerTrack: number;
  /** Embed the first N usable frames of a track regardless of quality gain. */
  minEvidenceFrames: number;
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
  lostAfterMs: 1000,
  endAfterMs: 2000,
  maxExtrapolateMs: 500,
  alpha: 0.7,
  beta: 0.3,
  sameCosine: STRANGER_SAME_PERSON_COSINE,
  splitCosine: 0.25,
  reidMaxCenterDist: 3,
  maxEmbeddingsPerTrack: 5,
  minEvidenceFrames: 2,
  betterGain: 0.1,
  maxEmbeddingsPerFrame: 4,
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
  /** False for tentative tracks (detector flicker): no outcome is owed. */
  confirmed: boolean;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  endedAtMs: number;
  hits: number;
  usableFrames: number;
  embeddingsUsed: number;
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
    const assoc = this.associate(live, preds, dets, false);
    const byDet = new Map<number, number>();
    for (const [ti, di] of assoc.pairs) byDet.set(di, ti);

    const c = this.config;
    const hasRoomForNew = live.length < c.maxTracks || live.some((tr) => tr.state !== "tentative" && tr.ref);
    const candidates: Array<EmbeddingRequest & { prio: number; select: number }> = [];
    dets.forEach((d, di) => {
      if (!d.usable) return;
      const amb = assoc.ambiguous.get(di);
      if (amb && amb.size >= 2) {
        const cands = [...amb].map((ti) => live[ti]);
        if (cands.some((tr) => tr.ref) && cands.every((tr) => tr.embeddingsUsed < c.maxEmbeddingsPerTrack)) {
          const ti = byDet.get(di);
          candidates.push({ index: d.index, trackId: ti === undefined ? null : live[ti].id, reason: "tiebreak", prio: 0, select: d.select });
          return;
        }
      }
      const ti = byDet.get(di);
      if (ti === undefined) {
        if (d.score >= c.newTrackScore && hasRoomForNew) {
          candidates.push({ index: d.index, trackId: null, reason: "new", prio: 1, select: d.select });
        }
        return;
      }
      const tr = live[ti];
      if (tr.evidenceClosed || tr.embeddingsUsed >= c.maxEmbeddingsPerTrack) return;
      if (tr.evidenceFrames < c.minEvidenceFrames) {
        candidates.push({ index: d.index, trackId: tr.id, reason: "evidence", prio: 1, select: d.select });
      } else if (d.select >= tr.bestEvidenceSelect * (1 + c.betterGain) && d.select > 0) {
        candidates.push({ index: d.index, trackId: tr.id, reason: "better", prio: 2, select: d.select });
      }
    });
    candidates.sort((a, b) => a.prio - b.prio || b.select - a.select || a.index - b.index);
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
    const assoc = this.associate(live, preds, dets, true);

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
    const matchedT = new Set(pairs.map((p) => p[0]));
    const matchedD = new Set(pairs.map((p) => p[1]));

    // Re-attach by embedding: a usable face that lost its box overlap (occlusion, jump).
    dets.forEach((d, di) => {
      if (matchedD.has(di) || !d.embedding || !d.usable) return;
      let best = -1;
      let bestCos = c.sameCosine;
      live.forEach((tr, ti) => {
        if (matchedT.has(ti) || tr.state === "tentative" || !tr.ref) return;
        const p = preds[ti];
        const reach = c.reidMaxCenterDist * Math.max(p[2] - p[0], d.box[2] - d.box[0]);
        const dist = Math.hypot((p[0] + p[2]) / 2 - (d.box[0] + d.box[2]) / 2, (p[1] + p[3]) / 2 - (d.box[1] + d.box[3]) / 2);
        if (dist > reach) return;
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
    if (tr.state === "tentative") return since > this.config.tentativeMaxMissMs;
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

  private associate(tracks: Track[], preds: Box[], dets: Det[], useEmbeddings: boolean): Association {
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
    return { pairs, ambiguous };
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
        tr.embeddingsUsed += 1;
        const cos = tr.ref ? dot(d.embedding, tr.ref) : undefined;
        if (identityCosine === undefined && cos !== undefined) identityCosine = cos;
        if (tr.evidenceClosed) status = "closed";
        else if (cos !== undefined && cos < c.sameCosine) status = "conflict";
        else {
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
