/**
 * Messages between a gate's pipeline HOST (main thread: stream reader, motion
 * gate, context, reporting) and its pipeline WORKER (worker thread: SCRFD,
 * alignment/quality/clear checks, tracker + decider, ArcFace, crops).
 *
 * Why a worker (F11, rc1 sign-off): onnxruntime-node inference blocks the
 * thread it runs on for ~0.4-0.6 s per call. On the main thread that starved
 * the FFmpeg pipe reader and its stale watchdog (reconnect storm, 0 decisions)
 * and slowed HTTP and the legacy watcher.
 *
 * Rules of the protocol:
 * - At most ONE frame is in flight per gate: the host sends the newest frame
 *   only when the worker has answered the previous one with `frame-done`.
 *   Nothing is queued; frames that arrive meanwhile are superseded (counted).
 * - The frame's RGB buffer is TRANSFERRED (zero-copy); the host never reads it
 *   again after sending.
 * - Fail closed: the worker decides only with a context pushed by the host
 *   (gallery for the running model tag, server-owned thresholds, engine
 *   readiness) AND its own engine loaded with the same model tag.
 * - Results never carry the frame's pixels back; a JPEG face crop is included
 *   only when the host asked for crops (`init.crops`, default off in shadow).
 */
import type { BestFrame, Frame, Gate, TrackOutcome } from "./contracts";
import type { DecisionContext, TrackDecisionResult } from "./trackDecision";

/** A Frame without its pixels (what travels back with a decision). */
export type FrameMeta = Omit<Frame, "rgb">;

export interface WireBestFrame {
  frame: FrameMeta;
  detection: BestFrame["detection"];
  quality: number;
  /** JPEG face crop, only when `init.crops` is on. */
  crop?: Uint8Array;
}

export type WireOutcome =
  | (Omit<Extract<TrackOutcome, { kind: "employee" }>, "best"> & { best: WireBestFrame })
  | (Omit<Extract<TrackOutcome, { kind: "stranger" }>, "best"> & { best: WireBestFrame })
  | Extract<TrackOutcome, { kind: "insufficient" }>;

export interface WireResult extends Omit<TrackDecisionResult, "outcome"> {
  outcome: WireOutcome;
}

/** Counters the worker keeps (the host adds its own frame/decision counters). */
export interface WorkerStats {
  detections: number;
  embeddings: number;
  errors: number;
  lastError?: string;
  engineReady: boolean;
  engineError?: string;
  modelTag?: string;
  contextOk: boolean;
  contextReason?: string;
  openTracks: number;
}

// ---- host -> worker ----------------------------------------------------------

export interface InitMessage {
  type: "init";
  gate: Gate;
  /** Attach a JPEG crop of the best frame to employee/stranger outcomes (live mode). */
  crops: boolean;
  /** Track housekeeping period inside the worker. */
  tickMs: number;
  /** Stats message period. */
  statsMs: number;
}

export interface ContextMessage {
  type: "context";
  version: number;
  /** null = no usable context (engine/gallery not ready): the worker must not decide. */
  context: DecisionContext | null;
}

export interface FrameMessage {
  type: "frame";
  frame: Frame;
}

export interface StopMessage {
  type: "stop";
}

export type HostToWorker = InitMessage | ContextMessage | FrameMessage | StopMessage;

// ---- worker -> host ----------------------------------------------------------

export interface FrameDoneMessage {
  type: "frame-done";
  seq: number;
  /** false when the worker could not look at it (no context / engine not ready). */
  processed: boolean;
  loopMs: number;
  detections: number;
  embeddings: number;
  error?: string;
}

export interface ResultsMessage {
  type: "results";
  results: WireResult[];
}

export interface StatsMessage {
  type: "stats";
  stats: WorkerStats;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export interface StoppedMessage {
  type: "stopped";
}

export type WorkerToHost = FrameDoneMessage | ResultsMessage | StatsMessage | ErrorMessage | StoppedMessage;

// ---- helpers -----------------------------------------------------------------

export function frameMeta(frame: Frame): FrameMeta {
  const { rgb: _rgb, ...meta } = frame;
  return { ...meta, roi: [...meta.roi] as Frame["roi"] };
}

/** Result for the wire: drops the best frame's pixels, optionally adds a crop. */
export function toWireResult(r: TrackDecisionResult, crop?: Uint8Array | null): WireResult {
  const { outcome, ...rest } = r;
  if (outcome.kind === "insufficient") return { ...rest, outcome: { ...outcome } };
  const best: WireBestFrame = {
    frame: frameMeta(outcome.best.frame),
    detection: outcome.best.detection,
    quality: outcome.best.quality,
    ...(crop && crop.length ? { crop } : {}),
  };
  return { ...rest, outcome: { ...outcome, best } as WireOutcome };
}

const EMPTY_RGB = new Uint8Array(0);

/**
 * Back to the TrackDecisionResult shape the server consumes. The best frame's
 * `rgb` is EMPTY on the host (pixels stay in the worker); use `best.crop`.
 */
export function fromWireResult(w: WireResult): TrackDecisionResult {
  const { outcome, ...rest } = w;
  if (outcome.kind === "insufficient") return { ...rest, outcome };
  const best: BestFrame = {
    frame: { ...outcome.best.frame, rgb: EMPTY_RGB },
    detection: outcome.best.detection,
    quality: outcome.best.quality,
    ...(outcome.best.crop && outcome.best.crop.length
      ? { crop: Buffer.from(outcome.best.crop.buffer, outcome.best.crop.byteOffset, outcome.best.crop.byteLength) }
      : {}),
  };
  return { ...rest, outcome: { ...outcome, best } as TrackOutcome };
}

/**
 * Cheap identity of a decision context, so the host only re-sends the gallery
 * when something changed (templates added/removed/replaced, thresholds, tags,
 * readiness). Hashes every template value: ~1 ms for a few hundred templates.
 */
export function contextFingerprint(ctx: DecisionContext | null): string {
  if (!ctx) return "none";
  let h = 0x811c9dc5 | 0;
  let templates = 0;
  const ids = Array.from(ctx.gallery.keys()).sort();
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
    for (const t of ctx.gallery.get(id) || []) {
      templates += 1;
      h = Math.imul(h ^ t.length, 0x01000193);
      for (let i = 0; i < t.length; i++) {
        // 1e6 resolution is far below any cosine that matters, and stable across clones.
        h = Math.imul(h ^ Math.round(Number(t[i]) * 1e6), 0x01000193);
      }
    }
  }
  return JSON.stringify([
    ctx.galleryModelTag,
    ctx.engineModelTag,
    ctx.engineReady,
    ctx.thresholds,
    ids.length,
    templates,
    h >>> 0,
  ]);
}

export const errText = (e: unknown) => String((e as any)?.message || e || "error").slice(0, 300);
