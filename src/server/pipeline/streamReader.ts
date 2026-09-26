/**
 * StreamReader (step 1, STR): an always-open camera stream that exposes only
 * its newest frame. Replaces "reconnect per look" (spawn FFmpeg, connect RTSP,
 * wait for a keyframe, grab one JPEG) with ONE long-running FFmpeg per gate:
 *
 *   RTSP (tcp, no input buffering) -> decode -> crop to the gate area -> fps=N
 *     -> packed RGB24 on stdout -> fixed-size frames -> ring buffer (newest wins)
 *
 * Owner decision (plan section 9): the camera/NVR frame rate is NOT changed;
 * the rate is lowered here with FFmpeg's `fps` filter.
 *
 * Guarantees:
 * - Never throws (construction, start, stop, listeners that throw).
 * - Never queues: `latest()` is the newest frame; when several frames arrive in
 *   one read only the last is copied and emitted, the rest are skipped.
 * - Each frame's `rgb` is a fresh buffer: consumers may keep a frame (e.g. as a
 *   track's best frame) without it being overwritten.
 * - Stale detection: no frame for `staleMs` (or no first frame within
 *   `firstFrameTimeoutMs`) -> SIGKILL, reconnect with back-off (1 s doubling to
 *   30 s, reset after `backoffResetMs` of healthy streaming).
 * - `stop()` hard-kills FFmpeg (SIGKILL) and stops reconnecting.
 * - The URL stays server-side: it is only passed to FFmpeg. Everything the
 *   reader reports (state, lastError) is redacted of `scheme://user:pass@`.
 *   Note: like the legacy grab, the URL is visible in FFmpeg's argv to
 *   same-host processes that can read /proc (FFmpeg cannot take it from env).
 */
import { EventEmitter } from "node:events";
import { spawn as nodeSpawn } from "node:child_process";

import type { Frame, FrameSource, Gate, SourceState, SourceStatus } from "./contracts";
import { MotionDetector, type MotionOptions, type MotionResult } from "./motion";
import { RingBuffer } from "./ringBuffer";
import { redactRtsp } from "../recording";

/** The part of a ChildProcess the reader uses (so tests can inject a fake). */
export interface ChildLike {
  readonly pid?: number;
  stdout: NodeJS.EventEmitter | null;
  stderr: NodeJS.EventEmitter | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnLike = (command: string, args: string[], options: { stdio: ["ignore", "pipe", "pipe"] }) => ChildLike;

export type Roi = [number, number, number, number];

export interface StreamReaderOptions {
  gate: Gate;
  /** Identity for logs/fusion (never a URL). */
  streamId: string;
  /** RTSP URL, may carry credentials; stays server-side. */
  url: string;
  /** Size of the decoded source picture (see `probeStreamSize`). */
  sourceWidth: number;
  sourceHeight: number;
  /** Gate area x, y, w, h in source pixels; default the full frame. Clamped and rounded to even. */
  roi?: Roi | null;
  /** Frames per second kept after decoding (FFmpeg `fps` filter). Default 8. */
  fps?: number;
  /** No frame for this long while streaming -> stale -> reconnect. Default 1000 ms. */
  staleMs?: number;
  /** Connect + first keyframe budget after each (re)start. Default 10000 ms (entry keyframe every ~4 s). */
  firstFrameTimeoutMs?: number;
  /** Reconnect back-off: first delay, doubling up to max. Defaults 1000 / 30000 ms. */
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** Streaming this long without trouble resets the back-off. Default 10000 ms. */
  backoffResetMs?: number;
  /** "state" heartbeat while running (status changes are emitted at once). Default 1000 ms. */
  stateIntervalMs?: number;
  /** Frames kept for the motion check. Default 3. */
  ringSize?: number;
  /** Motion gate settings, or false to disable (`motion()` then always says true). */
  motion?: MotionOptions | false;
  /** Decoder-side savings, measured in the STR handoff. */
  decoder?: {
    /** `-skip_frame` value (FFmpeg AVDiscard: "noref", "bidir", "nointra", "nokey"). Default none. */
    skipFrame?: "noref" | "bidir" | "nointra" | "nokey" | null;
    /** `-threads` for the decoder. Default FFmpeg's choice. */
    threads?: number | null;
    /** `-flags low_delay` (no frame-threading delay). Default true. */
    lowDelay?: boolean;
  };
  /** RTSP socket timeout (FFmpeg `-timeout`). Default 5000 ms. */
  socketTimeoutMs?: number;
  ffmpegPath?: string;
  spawn?: SpawnLike;
  now?: () => number;
}

interface ReaderConfig {
  gate: Gate;
  streamId: string;
  url: string;
  sourceWidth: number;
  sourceHeight: number;
  roi: Roi;
  fps: number;
  staleMs: number;
  firstFrameTimeoutMs: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
  backoffResetMs: number;
  stateIntervalMs: number;
  ringSize: number;
  motion: MotionOptions | false;
  skipFrame: string | null;
  threads: number | null;
  lowDelay: boolean;
  socketTimeoutMs: number;
  ffmpegPath: string;
  frameBytes: number;
}

const MAX_SOURCE_SIDE = 8192;
/** FFmpeg AVDiscard names; anything else would make every FFmpeg start fail. */
const SKIP_FRAME_VALUES: readonly string[] = ["noref", "bidir", "nointra", "nokey"];
const STDERR_TAIL_CHARS = 2000;
const FPS_WINDOW_MS = 3000;

/** Redacts `scheme://user:pass@` (rtsp and anything else) from text meant for logs/state. */
export function redactCredentials(text: unknown): string {
  return redactRtsp(String(text ?? "")).replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s"'@/]*@/gi, "$1://<login>@");
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function even(n: number): number {
  return Math.floor(n / 2) * 2;
}

/** Clamps a gate area into the source picture and rounds it to even pixels (YUV 4:2:0 crop is exact on even edges). */
export function normalizeRoi(roi: Roi | null | undefined, sourceWidth: number, sourceHeight: number): Roi {
  const full: Roi = [0, 0, even(sourceWidth), even(sourceHeight)];
  if (!Array.isArray(roi) || roi.length !== 4 || !roi.every((v) => Number.isFinite(Number(v)))) return full;
  const x = even(Math.min(Math.max(0, Number(roi[0])), sourceWidth - 2));
  const y = even(Math.min(Math.max(0, Number(roi[1])), sourceHeight - 2));
  const w = even(Math.min(Math.max(2, Number(roi[2])), sourceWidth - x));
  const h = even(Math.min(Math.max(2, Number(roi[3])), sourceHeight - y));
  if (w < 2 || h < 2) return full;
  return [x, y, w, h];
}

function buildConfig(opts: StreamReaderOptions): { config: ReaderConfig | null; error?: string } {
  const sw = Math.floor(Number(opts?.sourceWidth));
  const sh = Math.floor(Number(opts?.sourceHeight));
  const gate: Gate = opts?.gate === "EXIT" ? "EXIT" : "ENTRY";
  if (!Number.isFinite(sw) || !Number.isFinite(sh) || sw < 2 || sh < 2 || sw > MAX_SOURCE_SIDE || sh > MAX_SOURCE_SIDE) {
    return { config: null, error: "invalid source size (sourceWidth/sourceHeight)" };
  }
  if (typeof opts.url !== "string" || !opts.url.trim()) return { config: null, error: "missing stream URL" };
  const roi = normalizeRoi(opts.roi, sw, sh);
  const backoffInitialMs = num(opts.backoffInitialMs, 1000, 1, 600_000);
  const threads = opts.decoder?.threads;
  return {
    config: {
      gate,
      streamId: String(opts.streamId || gate.toLowerCase()),
      url: opts.url,
      sourceWidth: sw,
      sourceHeight: sh,
      roi,
      fps: num(opts.fps, 8, 0.1, 60),
      staleMs: num(opts.staleMs, 1000, 10, 600_000),
      firstFrameTimeoutMs: num(opts.firstFrameTimeoutMs, 10_000, 10, 600_000),
      backoffInitialMs,
      backoffMaxMs: num(opts.backoffMaxMs, 30_000, backoffInitialMs, 3_600_000),
      backoffResetMs: num(opts.backoffResetMs, 10_000, 0, 3_600_000),
      stateIntervalMs: num(opts.stateIntervalMs, 1000, 10, 3_600_000),
      ringSize: Math.floor(num(opts.ringSize, 3, 1, 64)),
      motion: opts.motion === false ? false : opts.motion || {},
      skipFrame: SKIP_FRAME_VALUES.includes(String(opts.decoder?.skipFrame)) ? String(opts.decoder?.skipFrame) : null,
      threads: threads != null && Number.isInteger(threads) && threads >= 0 && threads <= 64 ? threads : null,
      lowDelay: opts.decoder?.lowDelay !== false,
      socketTimeoutMs: num(opts.socketTimeoutMs, 5000, 100, 600_000),
      ffmpegPath: opts.ffmpegPath || "ffmpeg",
      frameBytes: roi[2] * roi[3] * 3,
    },
  };
}

/** FFmpeg arguments for the long-running reader. Exported for tests and the measurement tool. */
export function buildStreamReaderArgs(
  url: string,
  c: Pick<ReaderConfig, "roi" | "fps" | "skipFrame" | "threads" | "lowDelay" | "socketTimeoutMs">,
): string[] {
  const [x, y, w, h] = c.roi;
  const args = [
    "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error",
    "-rtsp_transport", "tcp",
    "-timeout", String(Math.round(c.socketTimeoutMs * 1000)), // microseconds
    "-fflags", "nobuffer",
    // Small probe: frames start sooner. Same values the legacy single-frame grab
    // was tuned with on this NVR.
    "-probesize", "65536",
    "-analyzeduration", "500000",
  ];
  // Decoder options must precede -i. low_delay also turns off frame threading,
  // whose pipeline would otherwise hold back one frame per decoder thread.
  if (c.lowDelay) args.push("-flags", "low_delay");
  if (c.skipFrame) args.push("-skip_frame", c.skipFrame);
  if (c.threads != null) args.push("-threads", String(c.threads));
  args.push(
    "-i", url,
    "-map", "0:v:0", "-an", "-sn", "-dn",
    // Explicit crop (also for the full frame) pins the output size: a source
    // that is smaller than configured fails loudly instead of mis-slicing.
    "-vf", `crop=${w}:${h}:${x}:${y},fps=${c.fps}`,
    // rawvideo defaults to CFR output, which duplicates the first frame back to
    // t=0 (a burst of up to one GOP of stale copies after every connect) and
    // fills stalls with copies. Pass frames through as the fps filter made them.
    "-fps_mode", "passthrough",
    "-pix_fmt", "rgb24",
    "-f", "rawvideo",
    "pipe:1",
  );
  return args;
}

type Listener = (...args: any[]) => void;

class StreamReader extends EventEmitter implements FrameSource {
  readonly gate: Gate;
  private readonly cfg: ReaderConfig | null;
  private readonly configError?: string;
  private readonly spawnFn: SpawnLike;
  private readonly now: () => number;
  private readonly ring: RingBuffer<Frame>;
  private readonly motionDetector: MotionDetector | null;
  private motionResults = new WeakMap<Frame, MotionResult>();

  private running = false;
  private generation = 0;
  private proc: ChildLike | null = null;
  private status: SourceStatus = "stopped";
  private sinceMs: number;
  private lastError?: string;
  private reconnects = 0;
  private attempt = 0;
  private stderrTail = "";

  private seq = 0;
  private current: Buffer | null = null;
  private filled = 0;
  private spawnedAtMs = 0;
  private streamingSinceMs: number | null = null;
  private lastFrameAtMs: number | null = null;
  private deliveries: number[] = [];

  private watchdog: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStateEmitMs = 0;

  constructor(opts: StreamReaderOptions) {
    super();
    const built = buildConfig(opts);
    this.cfg = built.config;
    this.configError = built.error;
    this.gate = opts?.gate === "EXIT" ? "EXIT" : "ENTRY";
    this.spawnFn = opts?.spawn || (nodeSpawn as unknown as SpawnLike);
    this.now = opts?.now || (() => Date.now());
    this.sinceMs = this.now();
    this.ring = new RingBuffer<Frame>(this.cfg?.ringSize ?? 3);
    this.motionDetector = this.cfg && this.cfg.motion !== false ? new MotionDetector(this.cfg.motion) : null;
  }

  /** Emits to each listener separately so one throwing listener cannot break the reader or the others. */
  override emit(event: string | symbol, ...args: any[]): boolean {
    const listeners = this.listeners(event) as Listener[];
    for (const listener of listeners) {
      try {
        listener.apply(this, args);
      } catch {
        // A consumer bug must not stop the camera stream.
      }
    }
    return listeners.length > 0;
  }

  start(): void {
    if (this.running) return;
    if (!this.cfg) {
      this.lastError = this.configError;
      this.setStatus("stopped", true);
      return;
    }
    this.running = true;
    this.attempt = 0;
    const tick = Math.max(10, Math.min(250, Math.floor(this.cfg.staleMs / 4)));
    this.watchdog = setInterval(() => this.onWatchdog(), tick);
    this.spawnProcess();
  }

  stop(): void {
    const wasRunning = this.running;
    this.running = false;
    this.generation += 1;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.watchdog = null;
    this.reconnectTimer = null;
    this.killProcess();
    this.resetStream();
    if (wasRunning || this.status !== "stopped") this.setStatus("stopped", true);
  }

  latest(): Frame | null {
    const frame = this.ring.newest();
    if (!frame || !this.cfg || this.status !== "streaming") return null;
    return this.now() - frame.capturedAtMs > this.cfg.staleMs ? null : frame;
  }

  motion(frame: Frame): boolean {
    if (!this.motionDetector) return true;
    return this.motionResults.get(frame)?.moving ?? true;
  }

  /** Current state without waiting for the next "state" event. */
  getState(): SourceState {
    const newest = this.ring.newest();
    const now = this.now();
    const state: SourceState = {
      gate: this.gate,
      status: this.status,
      fps: this.currentFps(now),
      newestFrameAgeMs: newest ? Math.max(0, now - newest.capturedAtMs) : null,
      reconnects: this.reconnects,
      since: new Date(this.sinceMs).toISOString(),
    };
    if (this.lastError) state.lastError = this.lastError;
    return state;
  }

  /** Process id of the running FFmpeg (for CPU measurement), if any. */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  private currentFps(now: number): number {
    const from = now - FPS_WINDOW_MS;
    while (this.deliveries.length && this.deliveries[0] < from) this.deliveries.shift();
    if (!this.deliveries.length || this.streamingSinceMs == null) return 0;
    const window = Math.min(FPS_WINDOW_MS, Math.max(1, now - this.streamingSinceMs));
    return Math.round((this.deliveries.length * 1000 * 10) / window) / 10;
  }

  private setStatus(status: SourceStatus, force = false): void {
    if (status === this.status && !force) return;
    if (status !== this.status) this.sinceMs = this.now();
    this.status = status;
    this.emitState();
  }

  private emitState(): void {
    this.lastStateEmitMs = this.now();
    this.emit("state", this.getState());
  }

  private resetStream(): void {
    this.seq = 0;
    this.current = null;
    this.filled = 0;
    this.streamingSinceMs = null;
    this.lastFrameAtMs = null;
    this.deliveries = [];
    this.ring.clear();
    this.motionResults = new WeakMap();
    this.motionDetector?.reset();
  }

  private killProcess(): void {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }

  private spawnProcess(): void {
    const cfg = this.cfg;
    if (!cfg || !this.running) return;
    this.generation += 1;
    const gen = this.generation;
    this.resetStream();
    this.stderrTail = "";
    this.spawnedAtMs = this.now();
    this.setStatus("starting");
    let proc: ChildLike;
    try {
      proc = this.spawnFn(cfg.ffmpegPath, buildStreamReaderArgs(cfg.url, cfg), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err: any) {
      this.fail(gen, `ffmpeg could not start: ${err?.message || err}`);
      return;
    }
    if (!proc) {
      this.fail(gen, "ffmpeg could not start");
      return;
    }
    this.proc = proc;
    const ignore = () => {};
    proc.stdout?.on("error", ignore);
    proc.stderr?.on("error", ignore);
    proc.stdout?.on("data", (chunk: Buffer) => {
      if (gen === this.generation) this.onData(chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (gen !== this.generation) return;
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS);
    });
    proc.on("error", (err: Error) => this.fail(gen, `ffmpeg error: ${err?.message || err}`));
    proc.on("exit", (code, signal) => {
      const detail = this.lastStderrLine();
      this.fail(gen, `ffmpeg exited (${signal || `code ${code}`})${detail ? `: ${detail}` : ""}`);
    });
  }

  private lastStderrLine(): string {
    const lines = this.stderrTail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1].slice(0, 300) : "";
  }

  /** Kill the current process (if it is still `gen`) and schedule a reconnect. */
  private fail(gen: number, reason: string, stale = false): void {
    if (gen !== this.generation || !this.running) return;
    this.generation += 1; // later events of this process are ignored
    this.killProcess();
    this.lastError = redactCredentials(reason);
    if (stale) this.setStatus("stale");
    this.resetStream();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const cfg = this.cfg;
    if (!cfg || !this.running) return;
    const delay = Math.min(cfg.backoffMaxMs, cfg.backoffInitialMs * 2 ** Math.min(this.attempt, 30));
    this.attempt += 1;
    this.setStatus("reconnecting", true);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      this.reconnects += 1;
      this.spawnProcess();
    }, delay);
  }

  private onWatchdog(): void {
    const cfg = this.cfg;
    if (!cfg || !this.running) return;
    const now = this.now();
    if (this.status === "starting" && now - this.spawnedAtMs > cfg.firstFrameTimeoutMs) {
      this.fail(this.generation, `no frame within ${cfg.firstFrameTimeoutMs} ms of connecting`, true);
      return;
    }
    if (this.status === "streaming" && this.lastFrameAtMs != null && now - this.lastFrameAtMs > cfg.staleMs) {
      this.fail(this.generation, `no frame for ${now - this.lastFrameAtMs} ms`, true);
      return;
    }
    if (this.status === "streaming" && this.streamingSinceMs != null && now - this.streamingSinceMs >= cfg.backoffResetMs) {
      this.attempt = 0;
    }
    if (now - this.lastStateEmitMs >= cfg.stateIntervalMs) this.emitState();
  }

  /**
   * Slices stdout into fixed-size frames. A frame that is completed and then
   * superseded by another complete frame within the same chunk is skipped
   * without copying (newest wins); `seq` still counts it.
   */
  private onData(chunk: Buffer): void {
    const cfg = this.cfg;
    if (!cfg) return;
    const size = cfg.frameBytes;
    const len = chunk.length;
    let pos = 0;
    let newest: Buffer | null = null;
    while (pos < len) {
      const need = size - this.filled;
      const remaining = len - pos;
      if (remaining >= need + size) {
        pos += need; // this frame ends here and a whole newer one follows
        this.current = null;
        this.filled = 0;
        this.seq += 1;
        continue;
      }
      if (!this.current) this.current = Buffer.allocUnsafe(size);
      const n = Math.min(need, remaining);
      chunk.copy(this.current, this.filled, pos, pos + n);
      this.filled += n;
      pos += n;
      if (this.filled === size) {
        newest = this.current;
        this.current = null;
        this.filled = 0;
      }
    }
    if (newest) this.deliver(newest);
  }

  private deliver(rgb: Buffer): void {
    const cfg = this.cfg!;
    const now = this.now();
    const frame: Frame = {
      gate: cfg.gate,
      streamId: cfg.streamId,
      seq: this.seq,
      capturedAtMs: now,
      width: cfg.roi[2],
      height: cfg.roi[3],
      roi: [...cfg.roi] as Roi,
      sourceWidth: cfg.sourceWidth,
      sourceHeight: cfg.sourceHeight,
      rgb: new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.length),
    };
    this.seq += 1;
    this.ring.push(frame);
    this.lastFrameAtMs = now;
    this.deliveries.push(now);
    if (this.motionDetector) this.motionResults.set(frame, this.motionDetector.update(frame));
    if (this.status !== "streaming") {
      this.streamingSinceMs = now;
      this.setStatus("streaming");
    }
    this.emit("frame", frame);
  }
}

/** Creates the reader; call `start()` to open the stream. Never throws. */
export function createStreamReader(opts: StreamReaderOptions): FrameSource & { getState(): SourceState; readonly pid?: number } {
  return new StreamReader(opts);
}

/**
 * Reads the source picture size once with FFmpeg (the runtime image ships no
 * ffprobe): opens the stream, reads the stream header, exits. Resolves null on
 * any failure; hard-killed after `timeoutMs`. Never rejects.
 */
export function probeStreamSize(
  url: string,
  opts: { spawn?: SpawnLike; ffmpegPath?: string; timeoutMs?: number } = {},
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = "";
    let proc: ChildLike | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc?.kill("SIGKILL");
      } catch {
        // gone
      }
      resolve(parseStreamSize(stderr));
    };
    const timer = setTimeout(finish, num(opts.timeoutMs, 10_000, 100, 120_000));
    try {
      proc = (opts.spawn || (nodeSpawn as unknown as SpawnLike))(
        opts.ffmpegPath || "ffmpeg",
        ["-hide_banner", "-nostdin", "-rtsp_transport", "tcp", "-timeout", "5000000", "-i", url],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      finish();
      return;
    }
    proc.stdout?.on("error", () => {});
    proc.stderr?.on("error", () => {});
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + String(chunk)).slice(-8000);
      if (parseStreamSize(stderr)) finish();
    });
    proc.on("error", finish);
    proc.on("exit", finish);
  });
}

/** Picks the first video stream's size out of FFmpeg's stream dump. */
export function parseStreamSize(stderr: string): { width: number; height: number } | null {
  // Lookahead: a size cut off at a chunk boundary ("3840x21|60") must not match.
  const m = /Stream #\d+:\d+[^\n]*: Video: [^\n]*?\b(\d{2,5})x(\d{2,5})(?=[\s,\[])/.exec(String(stderr || ""));
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width > 0 && height > 0 && width <= MAX_SOURCE_SIDE && height <= MAX_SOURCE_SIDE ? { width, height } : null;
}
