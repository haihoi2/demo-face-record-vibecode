/**
 * Person-presence detection (plan docs/plans/2026-10-02-person-presence-alerts.md,
 * phase P2; P1/P1b report docs/plans/2026-10-02-presence-p1-report.md).
 *
 * CONTRACT for the P2 wave. Owner decisions (2026-10-02/03): whole picture,
 * entry gate first, record at all times, message only outside working hours
 * (07:00-19:00 local = working), minimum time in view 3 s during working hours
 * and 1 s outside, body crops kept 7 days, no image in messages, models
 * YOLOX-Nano + RTMDet-tiny ("UNION-LOWRATE"). P2 is SHADOW: events are recorded
 * and shown, no message is ever sent. Nothing here can open a door.
 *
 * Data flow (one gate):
 *   stream reader (already open) --third output: whole picture scaled to
 *   PRESENCE_FRAME_WIDTH (960) px at PRESENCE_FPS (2)--> presence host (main
 *   thread, newest frame only, never queued) --> presence worker thread:
 *     YOLOX-Nano on every frame; RTMDet-tiny on every PRESENCE_RTMDET_EVERY-th
 *     frame (4), asynchronously so YOLOX never waits; boxes merged (NMS 0.5);
 *     static overlay mask (OSD clock, logo) applied; tracker links detections
 *     up to PRESENCE_LINK_GAP_MS (2000) apart; a track becomes an event once it
 *     has been in view for the minimum time of the current period.
 *   --> host --> server: PresenceEventDraft --> linking with face results at the
 *   same gate in the track's time window --> presence_events (+ body crop).
 */

/** Person box in SOURCE-picture pixels [x1, y1, x2, y2]. */
export type Box = [number, number, number, number];

export type PresenceModelId = "yolox-nano" | "rtmdet-tiny";

export interface PersonDetection {
  box: Box;
  score: number;
  model: PresenceModelId;
}

/** Model file + threshold; both models share one I/O shape after the detector wrapper: image in, person boxes out. */
export interface PresenceModelConfig {
  id: PresenceModelId;
  /** File name inside PRESENCE_MODEL_DIR (default /app/models/presence). */
  file: string;
  /** Input width in px (960; height follows the picture's aspect, padded to the model's stride). */
  inputWidth: number;
  /** Score threshold for a person box (YOLOX-Nano 0.55, RTMDet-tiny 0.30 from P1). */
  threshold: number;
  /** sha256 of the model file; the worker refuses a different file. */
  sha256: string;
}

/** Static regions to ignore (on-screen clock, logo), fractions of the picture [x, y, w, h]. */
export type MaskRect = [number, number, number, number];

export interface PresenceRules {
  /** "07:00-19:00" local (Asia/Ho_Chi_Minh): working hours; outside them is "after hours". */
  workingHours: { start: string; end: string; timeZone: string };
  /** Minimum time in view for an event: working hours 3000 ms, after hours 1000 ms. */
  minInViewMsWorking: number;
  minInViewMsAfterHours: number;
  /** Tracker: detections up to this far apart belong to one track. */
  linkGapMs: number;
}

/** What the worker reports once a track qualifies, then again when it ends (final = true). */
export interface PresenceEventDraft {
  gateId: string;
  /** Stable per gate and worker run, e.g. "P-<epochMs>-<n>". */
  trackId: string;
  startedAt: string;
  lastSeenAt: string;
  final: boolean;
  /** Time actually in view (ms), and frames with a detection. */
  inViewMs: number;
  framesSeen: number;
  /** Most people seen at once during the track (all tracks overlapping it). */
  peakPersons: number;
  /** Rule applied when the track qualified. */
  period: "working" | "after-hours";
  /** Best frame of the track: highest-score box, in source pixels, and when. */
  bestBox: Box;
  bestScore: number;
  bestFrameAt: string;
  models: PresenceModelId[];
}

export type FaceOutcome = "employee" | "stranger" | "none";

/** One row per qualified track (append-only facts; labels in their own table). */
export interface PresenceEventRecord {
  /** `PE-<uuid>`. */
  id: string;
  gateId: string;
  trackId: string;
  startedAt: string;
  endedAt?: string;
  inViewMs: number;
  framesSeen: number;
  peakPersons: number;
  period: "working" | "after-hours";
  /** Face engines' view of the same time window at this gate. */
  faceOutcome: FaceOutcome;
  linkedLogIds?: string[];
  linkedEmployeeIds?: string[];
  /** Whether the rules would message the security channel (after hours, no recognised employee). P2: never sent. */
  wouldAlert: boolean;
  alertSentAt?: string | null;
  bestBox: [number, number, number, number];
  bestScore: number;
  bestFrameAt: string;
  models: string[];
  /** JPEG body crop; only via the crop route, never in lists. Erased after PRESENCE_EVENT_RETENTION_DAYS (7). */
  hasCrop: boolean;
  createdAt: string;
}

export type PresenceLabelKind = "real" | "false-alarm" | "employee";

/*
 * Server API (INT):
 *   GET  /api/presence/status              viewer  -> { success, gates: [{ gateId, mode: "off"|"shadow", fps, lastFrameAgeMs,
 *                                                       worker: { state, restarts, models }, lastEventAt }] }
 *   GET  /api/presence/events?gate&period&faceOutcome&label&before&limit
 *                                          operator -> { success, events: PresenceEventRecord[] newest first, hasMore, nextCursor? }
 *                                                       (each with `label?: PresenceLabelKind`)
 *   GET  /api/presence/events/:id/crop     operator -> image/jpeg (biometric-image guard, like stranger faces)
 *   POST /api/presence/events/:id/label    operator, CSRF, { kind } -> { success, event }   (append-only label rows)
 * Env: PRESENCE_MODE_<GATE> = off | shadow (default off; P2 sets entry = shadow), PRESENCE_MODEL_DIR,
 *   PRESENCE_FPS (2), PRESENCE_FRAME_WIDTH (960), PRESENCE_RTMDET_EVERY (4), PRESENCE_WORKING_HOURS ("07:00-19:00"),
 *   PRESENCE_MIN_SECONDS_WORKING (3), PRESENCE_MIN_SECONDS_AFTER_HOURS (1), PRESENCE_EVENT_RETENTION_DAYS (7),
 *   PRESENCE_ORT_THREADS (1), PRESENCE_WORKER_NICE (19).
 * CPU budget: ~0.7 core per gate (P1b). The live camera streams must stay at their fps (check pipelineState).
 */
