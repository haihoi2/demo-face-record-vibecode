/**
 * Contracts of the real-time gate pipeline (plan: docs/plans/2026-09-26-realtime-pipeline.md).
 *
 * Every W1 agent codes against these types. Changes after W0 go through the
 * integrator (INT) so parallel branches stay compatible. Nothing here has
 * behaviour; implementations live next to this file:
 *   streamReader.ts / ringBuffer.ts / motion.ts   (STR, step 1)
 *   tracker.ts / trackDecision.ts                 (TRK, step 2)
 *   faceCrop.ts                                   (PERF, step 3)
 */

/**
 * A configured gate's id (src/server/gates.ts: lowercase slug such as "entry",
 * "exit", "side-door"). N-gate wave: was "ENTRY" | "EXIT". Producers validate
 * it with isGateId and refuse anything else (src/server/pipeline/gateId.ts);
 * the gate's direction is not part of the pipeline and travels separately.
 */
export type Gate = string;

/** Per-gate rollout switch: legacy watcher, new pipeline observing only, or new pipeline acting. */
export type PipelineMode = "legacy" | "shadow" | "live";

/**
 * One decoded frame of the gate area. `rgb` is packed RGB24, `width * height * 3`
 * bytes, already cropped to `roi` of the source picture (full-resolution pixels).
 */
export interface Frame {
  gate: Gate;
  /** Stream identity for fusion/logging (not a URL; never contains credentials). */
  streamId: string;
  /** Monotonic per source, restarts at 0 on reconnect. */
  seq: number;
  /** Wall-clock time the frame arrived from FFmpeg (ms since epoch). */
  capturedAtMs: number;
  width: number;
  height: number;
  /** Where the frame sits in the full source picture: x, y, w, h in source pixels. */
  roi: [number, number, number, number];
  sourceWidth: number;
  sourceHeight: number;
  rgb: Uint8Array;
}

export type SourceStatus = "starting" | "streaming" | "stale" | "reconnecting" | "stopped";

export interface SourceState {
  gate: Gate;
  status: SourceStatus;
  /** Frames handed out per second over the last few seconds. */
  fps: number;
  /** Age of the newest frame when this state was produced. */
  newestFrameAgeMs: number | null;
  reconnects: number;
  lastError?: string;
  since: string;
}

/** An always-open camera stream exposing only its newest frame. */
export interface FrameSource {
  readonly gate: Gate;
  start(): void;
  stop(): void;
  /** Newest frame, or null before the first one / when stale. Never queues. */
  latest(): Frame | null;
  on(event: "frame", listener: (frame: Frame) => void): this;
  on(event: "state", listener: (state: SourceState) => void): this;
  /** True when the area of interest changed noticeably since the previous frame. */
  motion?(frame: Frame): boolean;
}

/** One detected face in a Frame, in FRAME pixel coordinates (not source). */
export interface FaceDetection {
  box: [number, number, number, number];
  landmarks: Array<[number, number]>;
  score: number;
  /** Shorter side of the box in source pixels (the 60 px rule). */
  sizePx: number;
  /** Passes size + pose (clearFaceIssue) - only clear faces may decide. */
  clear: boolean;
  unclearReason?: string;
}

/** What the tracker is fed for one face in one frame. */
export interface TrackUpdate {
  trackId: string;
  frame: Frame;
  detection: FaceDetection;
  /** Present when the tracker asked for an embedding of this face (best frames only). */
  embedding?: Float32Array;
  /** 0..1, from faceQuality. */
  quality: number;
}

export interface BestFrame {
  frame: Frame;
  detection: FaceDetection;
  quality: number;
  /** JPEG face crop (step 3), filled before persistence. */
  crop?: Buffer;
}

/** Evidence as the existing fusion reports it; kept opaque to the pipeline. */
export type FusionEvidence = Record<string, unknown>;

/** ONE outcome per person per passage. */
export type TrackOutcome =
  | { kind: "employee"; gate: Gate; trackId: string; employeeId: string; decidedAtMs: number; fused: FusionEvidence; best: BestFrame }
  | { kind: "stranger"; gate: Gate; trackId: string; decidedAtMs: number; embedding: Float32Array; best: BestFrame }
  | { kind: "insufficient"; gate: Gate; trackId: string; decidedAtMs: number };

/** Shadow-mode record: what the pipeline would have done, next to what legacy did. */
export interface ShadowResult {
  gate: Gate;
  outcome: TrackOutcome["kind"];
  trackId: string;
  employeeId?: string;
  firstSeenAtMs: number;
  /** First frame where the face was >= the size floor and clear. */
  firstUsableAtMs?: number;
  decidedAtMs: number;
  framesSeen: number;
  framesUsed: number;
}
