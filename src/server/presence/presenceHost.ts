/**
 * One gate's person-presence detector, HOST side (main thread). P2 = SHADOW:
 * it only reports PresenceEventDraft (+ an optional JPEG body crop) through
 * `onDraft`; it never sends a message and never touches a door.
 *
 *   frames (whole picture, ~960 px wide, ~2 fps; from the stream reader's third
 *   output via `source` or `offer()`)
 *     -> newest frame only, never queued (a frame arriving while YOLOX is busy
 *        replaces the waiting one; counted as dropped)
 *     -> YOLOX-Nano worker on every frame; RTMDet-tiny worker on every
 *        rtmdetEvery-th frame (4), in its OWN worker thread so YOLOX never waits
 *        (onnxruntime-node 1.30 blocks the calling thread per run)
 *     -> PresenceCore (cross-model NMS, tracker, 3 s / 1 s rules) on this thread
 *     -> onDraft(draft, crop): once when a track qualifies, once when it ends.
 *
 * Fail closed: frames are processed only while BOTH detector workers report
 * their model loaded (file present, sha256 equal to the configured value).
 * Otherwise nothing is processed, no draft is produced, and the reason is in
 * stats().lastError / workers[*].loadError. A crashed or hung worker is restarted
 * with back-off (stats: restarts); tracks are ended by the normal 2 s rule, no
 * outcome is invented. Never throws out of callbacks.
 */
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

import type { Box, MaskRect, PresenceEventDraft, PresenceModelConfig, PresenceModelId } from "./contracts";
import { assertGateId } from "../pipeline/gateId";
import { cropFaceFromRgb } from "../pipeline/faceCrop";
import { modelTag, type PresenceFrame } from "./detectors";
import { PresenceCore, type CoreUpdate } from "./presenceCore";
import type { PresenceWorkerLike } from "./presenceDetectorCore";
import { presenceMaskForGate, presenceSettingsFromEnv, type PresenceSettings } from "./presenceConfig";
import { errText, type DetectorStats, type DetectorToHost, type HostToDetector } from "./presenceProtocol";

export type { PresenceFrame } from "./detectors";
export type { PresenceWorkerLike } from "./presenceDetectorCore";
export { createInProcessDetectorWorker } from "./presenceDetectorCore";

/** Where frames come from: the newest frame and a "frame" event (a FrameSource-like object). */
export interface PresenceFrameSource {
  latest(): PresenceFrame | null;
  on(event: "frame", listener: (frame: PresenceFrame) => void): unknown;
  off?(event: "frame", listener: (frame: PresenceFrame) => void): unknown;
}

export type PresenceCropper = (frame: PresenceFrame, boxInFramePx: Box) => Promise<Buffer | null>;

export interface PresenceHostOptions {
  /** Gate id (src/server/gates.ts); invalid -> the constructor throws. */
  gateId: string;
  /** Optional pull/notify source; frames can also be pushed with offer(). */
  source?: PresenceFrameSource;
  /** Called for every draft (qualified, then final), in order, with the body crop (null without crops). */
  onDraft: (draft: PresenceEventDraft, crop: Buffer | null) => void;
  onError?: (message: string) => void;
  /** Default: presenceSettingsFromEnv() (invalid env values are reported through onError). */
  settings?: PresenceSettings;
  /** Static overlay mask; default presenceMaskForGate(gateId). */
  mask?: MaskRect[];
  /** JPEG body crop of the best frame. Default: ffmpeg crop (pipeline/faceCrop) of the frame kept for it. null = no crops. */
  cropper?: PresenceCropper | null;
  /** Worker factory; default a real worker thread running presenceWorker. Tests inject fakes. */
  createWorker?: (model: PresenceModelId) => PresenceWorkerLike;
  now?: () => number;
  /** Track housekeeping period. Default 250 ms. */
  tickMs?: number;
  /** Worker stats period. Default 1000 ms. */
  statsMs?: number;
  /** A worker not answering a frame for this long is restarted. Default 20000 ms. */
  frameTimeoutMs?: number;
  restartBackoffInitialMs?: number;
  restartBackoffMaxMs?: number;
  restartBackoffResetMs?: number;
  /** stop() waits this long for the workers. Default 3000 ms. */
  stopTimeoutMs?: number;
  /** Retry a failed model load this often. Default 30000 ms. */
  modelRetryMs?: number;
  /** Frames older than this when offered are ignored. Default 5000 ms. */
  maxFrameAgeMs?: number;
}

export type PresenceWorkerState = "starting" | "running" | "restarting" | "stopped";

export interface PresenceWorkerStats {
  state: PresenceWorkerState;
  restarts: number;
  ready: boolean;
  tag: string;
  loadError?: string;
  runs: number;
  lastRunMs?: number;
  lastLoopMs?: number;
}

export interface PresenceHostStats {
  gateId: string;
  running: boolean;
  /** Both models loaded and verified: frames are processed. */
  engineReady: boolean;
  /** Frames processed per second (YOLOX), last 10 s. */
  fps: number;
  framesReceived: number;
  framesProcessed: number;
  /** Superseded while YOLOX was busy (never queued). */
  framesDroppedBusy: number;
  /** Not processed because a model is not ready (fail closed). */
  framesSkippedNotReady: number;
  /** Ignored: too old, not newer than the last one, or malformed. */
  framesRejected: number;
  detections: Record<PresenceModelId, number>;
  rtmdetRuns: number;
  /** RTMDet slot skipped because its previous frame was still running. */
  rtmdetSkippedBusy: number;
  openTracks: number;
  tracks: number;
  qualified: number;
  finals: number;
  droppedUnqualified: number;
  lastFrameAt?: string;
  lastFrameAgeMs?: number;
  /** Time the last draft was produced; null before the first one. */
  lastEventAt: string | null;
  errors: number;
  lastError?: string;
  models: Array<Pick<PresenceModelConfig, "id" | "file" | "sha256" | "threshold" | "inputWidth"> & { tag: string }>;
  workers: Record<PresenceModelId, PresenceWorkerStats>;
  /** Summary in the shape GET /api/presence/status uses. */
  worker: { state: PresenceWorkerState; restarts: number; models: string[] };
}

type Resolved = Required<Omit<PresenceHostOptions, "source" | "onError" | "createWorker" | "cropper" | "mask" | "settings">> &
  Pick<PresenceHostOptions, "source" | "onError" | "createWorker"> & { cropper: PresenceCropper | null; mask: MaskRect[]; settings: PresenceSettings };

interface Slot {
  id: PresenceModelId;
  role: "primary" | "secondary";
  cfg: PresenceModelConfig;
  worker: PresenceWorkerLike | null;
  gen: number;
  state: PresenceWorkerState;
  startedAt: number;
  restartAttempt: number;
  restarts: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  inFlight: { seq: number; t: number; sentAt: number } | null;
  stats: DetectorStats | null;
  stopWaiter: (() => void) | null;
}

/**
 * Entry file of the presence worker (like resolvePipelineWorkerEntry):
 *   1. PRESENCE_WORKER_PATH (strict);
 *   2. next to this module when `__dirname` exists (esbuild CJS bundle -> dist/presenceWorker.cjs);
 *   3. cwd: src/server/presence/presenceWorker.ts (tsx), then dist/presenceWorker.cjs.
 */
export function resolvePresenceWorkerEntry(): string {
  const override = process.env.PRESENCE_WORKER_PATH?.trim();
  if (override) {
    const resolved = path.resolve(override);
    if (!fs.existsSync(resolved)) throw new Error(`PRESENCE_WORKER_PATH points at a missing file: ${resolved}`);
    return resolved;
  }
  const candidates: string[] = [];
  const moduleDir = typeof __dirname === "string" ? __dirname : null;
  if (moduleDir) candidates.push(path.join(moduleDir, "presenceWorker.cjs"), path.join(moduleDir, "presenceWorker.js"), path.join(moduleDir, "presenceWorker.ts"));
  const cwd = process.cwd();
  candidates.push(path.join(cwd, "src", "server", "presence", "presenceWorker.ts"), path.join(cwd, "dist", "presenceWorker.cjs"));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`Presence worker entry not found. Tried: ${candidates.join(", ")}. Run \`npm run build\` or set PRESENCE_WORKER_PATH.`);
}

/** Default JPEG body crop: square around the box (1.2x its longer side), at most 384 px. */
export const defaultPresenceCropper: PresenceCropper = (frame, box) =>
  cropFaceFromRgb({ width: frame.width, height: frame.height, rgb: frame.rgb }, box, { margin: 1.2, minSizePx: 64, maxSizePx: 384 });

const RING = 12;
const FPS_WINDOW_MS = 10_000;

export class PresenceHost {
  readonly gateId: string;
  private readonly opts: Resolved;
  private readonly slots: Record<PresenceModelId, Slot>;
  private readonly primaryId: PresenceModelId;
  private readonly secondaryId: PresenceModelId;
  private core: PresenceCore;
  private running = false;
  private pending: PresenceFrame | null = null;
  private lastAcceptedAt = -Infinity;
  private seq = 0;
  private secondaryCountdown = 0;
  /** Recent frames by capture time (original buffers; workers get copies). */
  private readonly ring = new Map<number, PresenceFrame>();
  /** Frame holding each open track's best box (for its crop). */
  private readonly bestFrames = new Map<string, PresenceFrame>();
  private emitChain: Promise<void> = Promise.resolve();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readonly processedAt: number[] = [];
  private readonly sourceListener = (f: PresenceFrame) => this.offer(f);
  private readonly s = {
    framesReceived: 0,
    framesProcessed: 0,
    framesDroppedBusy: 0,
    framesSkippedNotReady: 0,
    framesRejected: 0,
    detections: { "yolox-nano": 0, "rtmdet-tiny": 0 } as Record<PresenceModelId, number>,
    rtmdetRuns: 0,
    rtmdetSkippedBusy: 0,
    errors: 0,
    lastError: undefined as string | undefined,
    lastFrameAt: undefined as number | undefined,
    lastEventAt: undefined as number | undefined,
  };

  constructor(opts: PresenceHostOptions) {
    this.gateId = assertGateId(opts?.gateId, "presence gate");
    if (typeof opts.onDraft !== "function") throw new TypeError("presence host: onDraft is required");
    let settings = opts.settings;
    const envErrors: string[] = [];
    if (!settings) {
      const r = presenceSettingsFromEnv();
      settings = r.settings;
      envErrors.push(...r.errors);
    }
    this.opts = {
      now: Date.now,
      tickMs: 250,
      statsMs: 1000,
      frameTimeoutMs: 20_000,
      restartBackoffInitialMs: 1000,
      restartBackoffMaxMs: 30_000,
      restartBackoffResetMs: 60_000,
      stopTimeoutMs: 3000,
      modelRetryMs: 30_000,
      maxFrameAgeMs: 5000,
      ...opts,
      cropper: opts.cropper === undefined ? defaultPresenceCropper : opts.cropper,
      mask: (opts.mask ?? presenceMaskForGate(this.gateId)).map((r) => [...r] as MaskRect),
      settings,
    } as Resolved;
    const mk = (cfg: PresenceModelConfig, role: Slot["role"]): Slot => ({
      id: cfg.id, role, cfg, worker: null, gen: 0, state: "stopped", startedAt: 0, restartAttempt: 0, restarts: 0,
      restartTimer: null, inFlight: null, stats: null, stopWaiter: null,
    });
    const { primary, secondary } = settings.models;
    if (primary.id === secondary.id) throw new TypeError("presence host: primary and secondary models must differ");
    this.primaryId = primary.id;
    this.secondaryId = secondary.id;
    this.slots = { [primary.id]: mk(primary, "primary"), [secondary.id]: mk(secondary, "secondary") } as Record<PresenceModelId, Slot>;
    this.core = this.newCore();
    for (const e of envErrors) this.fail(e);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.core = this.newCore();
    this.secondaryCountdown = 0;
    for (const slot of Object.values(this.slots)) {
      slot.restartAttempt = 0;
      this.spawn(slot);
    }
    this.opts.source?.on("frame", this.sourceListener);
    this.tickTimer = setInterval(() => this.tick(), Math.max(20, this.opts.tickMs));
    (this.tickTimer as any).unref?.();
    const wdMs = Math.max(20, Math.min(1000, Math.floor(this.opts.frameTimeoutMs / 4)));
    this.watchdog = setInterval(() => this.checkHung(), wdMs);
    (this.watchdog as any).unref?.();
  }

  /** Stops the workers; open tracks end now (final drafts for qualified ones are still delivered). */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    try {
      this.opts.source?.off?.("frame", this.sourceListener);
    } catch {}
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.tickTimer = null;
    this.watchdog = null;
    this.pending = null;
    await Promise.all(Object.values(this.slots).map((slot) => this.stopSlot(slot)));
    this.handle(this.core.endAll());
    await this.emitChain;
    this.ring.clear();
    this.bestFrames.clear();
  }

  /**
   * Offers a frame (push), e.g. from the stream reader's "presence-frame" event
   * (add sourceWidth/sourceHeight so boxes come back in source pixels). The
   * newest frame wins; nothing is queued. Offering the frame already accepted
   * again (same capturedAtMs, e.g. when polling latestPresenceFrame()) is ignored.
   */
  offer(frame: PresenceFrame): void {
    if (!this.running) return;
    const now = this.opts.now();
    const t = Number(frame?.capturedAtMs);
    if (t === this.lastAcceptedAt) return;
    const ok =
      frame && frame.rgb instanceof Uint8Array && Number.isInteger(frame.width) && Number.isInteger(frame.height) &&
      frame.width > 0 && frame.height > 0 && frame.rgb.length === frame.width * frame.height * 3 && Number.isFinite(t);
    if (!ok || t <= this.lastAcceptedAt || now - t > this.opts.maxFrameAgeMs) {
      this.s.framesRejected += 1;
      return;
    }
    this.s.framesReceived += 1;
    this.lastAcceptedAt = t;
    this.s.lastFrameAt = t;
    if (this.pending) this.s.framesDroppedBusy += 1;
    this.pending = frame;
    this.pump();
  }

  stats(): PresenceHostStats {
    const now = this.opts.now();
    while (this.processedAt.length && now - this.processedAt[0] > FPS_WINDOW_MS) this.processedAt.shift();
    const span = Math.min(FPS_WINDOW_MS, this.processedAt.length ? now - this.processedAt[0] : 0);
    const fps = this.processedAt.length > 1 && span > 0 ? Math.round(((this.processedAt.length - 1) / span) * 10000) / 10 : 0;
    const workers = {} as Record<PresenceModelId, PresenceWorkerStats>;
    for (const slot of Object.values(this.slots)) {
      const st = slot.stats;
      workers[slot.id] = {
        state: slot.state,
        restarts: slot.restarts,
        ready: Boolean(st?.ready) && slot.state === "running",
        tag: st?.tag || modelTag(slot.cfg),
        ...(st?.loadError ? { loadError: st.loadError } : {}),
        runs: st?.runs ?? 0,
        ...(st?.lastRunMs !== undefined ? { lastRunMs: st.lastRunMs } : {}),
        ...(st?.lastLoopMs !== undefined ? { lastLoopMs: st.lastLoopMs } : {}),
      };
    }
    const states = Object.values(this.slots).map((s) => s.state);
    const summaryState: PresenceWorkerState = !this.running
      ? "stopped"
      : states.every((s) => s === "running")
        ? "running"
        : states.some((s) => s === "restarting")
          ? "restarting"
          : "starting";
    const c = this.core.counters;
    return {
      gateId: this.gateId,
      running: this.running,
      engineReady: this.engineReady(),
      fps,
      framesReceived: this.s.framesReceived,
      framesProcessed: this.s.framesProcessed,
      framesDroppedBusy: this.s.framesDroppedBusy,
      framesSkippedNotReady: this.s.framesSkippedNotReady,
      framesRejected: this.s.framesRejected,
      detections: { ...this.s.detections },
      rtmdetRuns: this.s.rtmdetRuns,
      rtmdetSkippedBusy: this.s.rtmdetSkippedBusy,
      openTracks: this.core.openTracks(),
      tracks: c.tracks,
      qualified: c.qualified,
      finals: c.finals,
      droppedUnqualified: c.droppedUnqualified,
      ...(this.s.lastFrameAt !== undefined ? { lastFrameAt: new Date(this.s.lastFrameAt).toISOString(), lastFrameAgeMs: Math.max(0, now - this.s.lastFrameAt) } : {}),
      lastEventAt: this.s.lastEventAt !== undefined ? new Date(this.s.lastEventAt).toISOString() : null,
      errors: this.s.errors,
      ...(this.s.lastError ? { lastError: this.s.lastError } : {}),
      models: Object.values(this.slots).map((s) => ({ id: s.cfg.id, file: s.cfg.file, sha256: s.cfg.sha256, threshold: s.cfg.threshold, inputWidth: s.cfg.inputWidth, tag: modelTag(s.cfg) })),
      workers,
      worker: {
        state: summaryState,
        restarts: Object.values(this.slots).reduce((n, s) => n + s.restarts, 0),
        models: Object.values(this.slots).map((s) => modelTag(s.cfg)),
      },
    };
  }

  // ---- internals ---------------------------------------------------------------

  private newCore(): PresenceCore {
    return new PresenceCore({
      gateId: this.gateId,
      rules: this.opts.settings.rules,
      framePeriodMs: 1000 / this.opts.settings.fps,
      runStartedAtMs: this.opts.now(),
    });
  }

  private engineReady(): boolean {
    return Object.values(this.slots).every((s) => s.state === "running" && s.stats?.ready === true);
  }

  private spawn(slot: Slot): void {
    if (!this.running) return;
    slot.gen += 1;
    const gen = slot.gen;
    slot.stats = null;
    slot.inFlight = null;
    slot.state = "starting";
    let worker: PresenceWorkerLike;
    try {
      worker = this.opts.createWorker
        ? this.opts.createWorker(slot.id)
        : (new Worker(resolvePresenceWorkerEntry(), { name: `presence-${this.gateId}-${slot.id}` }) as unknown as PresenceWorkerLike);
    } catch (e) {
      this.down(slot, gen, `presence worker ${slot.id} could not start: ${errText(e)}`);
      return;
    }
    slot.worker = worker;
    slot.startedAt = this.opts.now();
    worker.on("message", (msg: DetectorToHost) => {
      if (gen === slot.gen) this.onMessage(slot, msg);
    });
    worker.on("error", (err: Error) => {
      if (gen === slot.gen) this.down(slot, gen, `presence worker ${slot.id} crashed: ${errText(err)}`);
    });
    worker.on("exit", (code: number) => {
      if (gen === slot.gen) this.down(slot, gen, `presence worker ${slot.id} exited (code ${code})`);
    });
    slot.state = "running";
    const st = this.opts.settings;
    this.post(slot, {
      type: "init",
      model: { ...slot.cfg },
      modelDir: st.modelDir,
      mask: this.opts.mask.map((r) => [...r] as MaskRect),
      ortThreads: st.ortThreads,
      nice: st.workerNice,
      statsMs: this.opts.statsMs,
      retryMs: this.opts.modelRetryMs,
    });
  }

  private down(slot: Slot, gen: number, reason: string): void {
    if (gen !== slot.gen) return;
    slot.gen += 1;
    const worker = slot.worker;
    slot.worker = null;
    slot.inFlight = null;
    slot.stats = null;
    try {
      void Promise.resolve(worker?.terminate()).catch(() => undefined);
    } catch {}
    if (!this.running) {
      slot.state = "stopped";
      slot.stopWaiter?.();
      return;
    }
    slot.restarts += 1;
    if (slot.startedAt && this.opts.now() - slot.startedAt >= this.opts.restartBackoffResetMs) slot.restartAttempt = 0;
    const delay = Math.min(this.opts.restartBackoffMaxMs, this.opts.restartBackoffInitialMs * 2 ** Math.min(slot.restartAttempt, 30));
    slot.restartAttempt += 1;
    slot.state = "restarting";
    this.fail(`${reason}; restart ${slot.restarts} in ${Math.round(delay / 100) / 10} s`);
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null;
      this.spawn(slot);
    }, delay);
    (slot.restartTimer as any).unref?.();
  }

  private async stopSlot(slot: Slot): Promise<void> {
    if (slot.restartTimer) clearTimeout(slot.restartTimer);
    slot.restartTimer = null;
    const worker = slot.worker;
    if (worker && slot.state === "running") {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.opts.stopTimeoutMs);
        slot.stopWaiter = () => {
          clearTimeout(timer);
          resolve();
        };
        if (!this.post(slot, { type: "stop" })) slot.stopWaiter();
      });
    }
    slot.stopWaiter = null;
    slot.gen += 1;
    slot.worker = null;
    slot.state = "stopped";
    slot.inFlight = null;
    if (worker) {
      try {
        await Promise.resolve(worker.terminate()).catch(() => undefined);
      } catch {}
    }
  }

  private post(slot: Slot, msg: HostToDetector, transfer?: ArrayBuffer[]): boolean {
    const worker = slot.worker;
    if (!worker) return false;
    try {
      worker.postMessage(msg, transfer);
      return true;
    } catch (e) {
      this.fail(`post ${msg.type} to ${slot.id}: ${errText(e)}`);
      return false;
    }
  }

  private checkHung(): void {
    if (!this.running) return;
    const now = this.opts.now();
    for (const slot of Object.values(this.slots)) {
      if (slot.inFlight && now - slot.inFlight.sentAt > this.opts.frameTimeoutMs) {
        this.down(slot, slot.gen, `presence worker ${slot.id} did not answer a frame in ${now - slot.inFlight.sentAt} ms`);
      }
    }
  }

  /** Sends the newest frame to YOLOX when it is idle (and to RTMDet on its slot). Never queues. */
  private pump(): void {
    const frame = this.pending;
    if (!this.running || !frame) return;
    const primary = this.slots[this.primaryId];
    const secondary = this.slots[this.secondaryId];
    if (!this.engineReady()) {
      this.pending = null;
      this.s.framesSkippedNotReady += 1;
      return;
    }
    if (primary.inFlight) return; // waits as `pending`; superseded by a newer frame
    this.pending = null;
    const t = frame.capturedAtMs;
    this.ring.set(t, frame);
    while (this.ring.size > RING) this.ring.delete(this.ring.keys().next().value as number);
    this.seq += 1;
    if (this.send(primary, frame, this.seq)) {
      if (this.secondaryCountdown === 0) {
        if (!secondary.inFlight) {
          if (this.send(secondary, frame, this.seq)) {
            this.s.rtmdetRuns += 1;
            this.secondaryCountdown = this.opts.settings.rtmdetEvery;
          }
        } else {
          this.s.rtmdetSkippedBusy += 1;
        }
      }
      this.secondaryCountdown = Math.max(0, this.secondaryCountdown - 1);
    }
  }

  private send(slot: Slot, frame: PresenceFrame, seq: number): boolean {
    const copy = new Uint8Array(frame.rgb); // the original stays in the ring for the crop
    const msg: HostToDetector = {
      type: "frame",
      seq,
      frame: {
        width: frame.width,
        height: frame.height,
        rgb: copy,
        capturedAtMs: frame.capturedAtMs,
        ...(frame.sourceWidth ? { sourceWidth: frame.sourceWidth } : {}),
        ...(frame.sourceHeight ? { sourceHeight: frame.sourceHeight } : {}),
      },
    };
    slot.inFlight = { seq, t: frame.capturedAtMs, sentAt: this.opts.now() };
    if (!this.post(slot, msg, [copy.buffer])) {
      slot.inFlight = null;
      return false;
    }
    return true;
  }

  private onMessage(slot: Slot, msg: DetectorToHost): void {
    try {
      switch (msg?.type) {
        case "result": {
          if (!slot.inFlight || slot.inFlight.seq !== msg.seq) break; // stale answer
          const t = slot.inFlight.t;
          slot.inFlight = null;
          if (msg.ok) {
            const dets = (msg.detections || []).filter((d) => d && d.model === slot.id);
            this.s.detections[slot.id] += dets.length;
            if (slot.role === "primary") {
              this.s.framesProcessed += 1;
              this.processedAt.push(this.opts.now());
              this.handle(this.core.primary(t, dets));
            } else {
              this.handle(this.core.secondary(t, dets));
            }
          } else if (msg.error) {
            this.fail(`${slot.id}: ${msg.error}`);
          }
          if (slot.role === "primary") this.pump();
          break;
        }
        case "stats":
          slot.stats = msg.stats;
          break;
        case "error":
          this.fail(String(msg.message || "presence worker error"));
          break;
        case "stopped":
          slot.stopWaiter?.();
          break;
      }
    } catch (e) {
      this.fail(`presence worker message: ${errText(e)}`);
    }
  }

  private tick(): void {
    if (!this.running) return;
    const pendingTimes: number[] = [];
    for (const slot of Object.values(this.slots)) if (slot.inFlight) pendingTimes.push(slot.inFlight.t);
    if (this.pending) pendingTimes.push(this.pending.capturedAtMs);
    this.handle(this.core.tick(this.opts.now(), pendingTimes));
  }

  private handle(up: CoreUpdate): void {
    for (const b of up.bestChanged) {
      const f = this.ring.get(b.t);
      if (f) this.bestFrames.set(b.trackId, f);
    }
    for (const draft of up.drafts) {
      const frame = this.bestFrames.get(draft.trackId) ?? null;
      this.s.lastEventAt = this.opts.now();
      this.emitChain = this.emitChain.then(() => this.emit(draft, frame));
    }
    for (const id of up.ended) this.bestFrames.delete(id);
  }

  private async emit(draft: PresenceEventDraft, frame: PresenceFrame | null): Promise<void> {
    let crop: Buffer | null = null;
    if (frame && this.opts.cropper) {
      try {
        const sx = frame.width / (frame.sourceWidth || frame.width);
        const sy = frame.height / (frame.sourceHeight || frame.height);
        const b = draft.bestBox;
        crop = await this.opts.cropper(frame, [b[0] * sx, b[1] * sy, b[2] * sx, b[3] * sy]);
      } catch (e) {
        this.fail(`crop: ${errText(e)}`);
      }
    }
    try {
      this.opts.onDraft(draft, crop);
    } catch (e) {
      this.fail(`onDraft: ${errText(e)}`);
    }
  }

  private fail(message: string): void {
    this.s.errors += 1;
    this.s.lastError = message.slice(0, 300);
    try {
      this.opts.onError?.(this.s.lastError);
    } catch {}
  }
}
