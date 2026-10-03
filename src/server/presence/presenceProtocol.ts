/**
 * Messages between the presence HOST (main thread, presenceHost.ts) and one
 * presence DETECTOR WORKER (worker thread, presenceWorker.ts). A gate runs two
 * detector workers, one ONNX session each (YOLOX-Nano, RTMDet-tiny): in
 * onnxruntime-node 1.30 `session.run` blocks the calling JS thread and two
 * sessions in one thread do not overlap (measured 2026-10-03), so the slow
 * RTMDet-tiny gets its own thread and YOLOX-Nano never waits for it.
 *
 * Rules: at most ONE frame in flight per worker (the host sends the next only
 * after `result`); the frame's RGB buffer is TRANSFERRED; results carry boxes
 * only (source pixels), never pixels. A worker whose model is missing or has
 * the wrong sha256 answers every frame `ok: false` with the reason (fail closed).
 */
import type { MaskRect, PersonDetection, PresenceModelConfig, PresenceModelId } from "./contracts";
import type { PresenceFrame } from "./detectors";

export interface DetectorInitMessage {
  type: "init";
  model: PresenceModelConfig;
  modelDir: string;
  mask: MaskRect[];
  ortThreads: number;
  /** Scheduling priority for this thread (0 = unchanged, 1-19 lower). */
  nice: number;
  statsMs: number;
  /** Retry a failed model load this often. */
  retryMs: number;
}

export interface DetectorFrameMessage {
  type: "frame";
  seq: number;
  frame: PresenceFrame;
}

export interface DetectorStopMessage {
  type: "stop";
}

export type HostToDetector = DetectorInitMessage | DetectorFrameMessage | DetectorStopMessage;

export interface DetectorStats {
  model: PresenceModelId;
  tag: string;
  ready: boolean;
  /** Why the model is not ready (missing file, sha256 mismatch, ...). */
  loadError?: string;
  runs: number;
  errors: number;
  lastError?: string;
  /** session.run of the last frame, ms. */
  lastRunMs?: number;
  /** Whole frame (resize + tensor + run + decode), ms. */
  lastLoopMs?: number;
  niceError?: string;
}

export interface DetectorResultMessage {
  type: "result";
  seq: number;
  capturedAtMs: number;
  /** false: not looked at (model not ready) or failed; `error` says why. */
  ok: boolean;
  detections: PersonDetection[];
  loopMs: number;
  error?: string;
}

export interface DetectorStatsMessage {
  type: "stats";
  stats: DetectorStats;
}

export interface DetectorErrorMessage {
  type: "error";
  message: string;
}

export interface DetectorStoppedMessage {
  type: "stopped";
}

export type DetectorToHost = DetectorResultMessage | DetectorStatsMessage | DetectorErrorMessage | DetectorStoppedMessage;

export const errText = (e: unknown) => String((e as any)?.message || e || "error").slice(0, 300);
