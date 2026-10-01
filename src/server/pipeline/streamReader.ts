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
 * - Stale detection: no data from FFmpeg for `staleMs` (or no first frame
 *   within `firstFrameTimeoutMs`) -> SIGKILL, reconnect with back-off (1 s
 *   doubling to 30 s, reset after `backoffResetMs` of healthy streaming).
 *   Event-loop lag is not mistaken for a dead stream (F11): staleness is
 *   measured on bytes actually read from the pipe, and a watchdog tick that
 *   fires more than staleMs/2 late re-arms once instead of judging, so the pipe
 *   data queued behind the stall is read first. A real stall (server frozen)
 *   still goes stale within ~staleMs + one tick.
 * - Every stale/failure -> reconnect and every recovery is logged once through
 *   `log` (F12): gate-agnostic text without URL, host or credentials,
 *   rate-limited to one line per `logIntervalMs` (suppressed lines counted).
 * - `stop()` hard-kills FFmpeg (SIGKILL) and stops reconnecting.
 * - The URL stays server-side: it is only passed to FFmpeg. Everything the
 *   reader reports (state, lastError) is redacted of `scheme://user:pass@`.
 *   Note: like the legacy grab, the URL is visible in FFmpeg's argv to
 *   same-host processes that can read /proc (FFmpeg cannot take it from env).
 */
import { EventEmitter } from "node:events";
import { spawn as nodeSpawn } from "node:child_process";

import type { Frame, FrameSource, Gate, SourceState, SourceStatus } from "./contracts";
import { assertGateId } from "./gateId";
import { MotionDetector, type MotionOptions, type MotionResult } from "./motion";
import { RingBuffer } from "./ringBuffer";
import { redactRtsp } from "../recording";

/** The part of a ChildProcess the reader uses (so tests can inject a fake). */
export interface ChildLike {
  readonly pid?: number;
  stdout: NodeJS.EventEmitter | null;
  stderr: NodeJS.EventEmitter | null;
  /** All pipes; [3] is the full-picture JPEG output when `snapshot` is on. */
  stdio?: ReadonlyArray<NodeJS.EventEmitter | null | undefined>;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: { stdio: ["ignore", "pipe", "pipe"] | ["ignore", "pipe", "pipe", "pipe"] },
) => ChildLike;

/** One full-picture JPEG from the snapshot output. */
export interface SnapshotFrame {
  jpeg: Buffer;
  /** Wall-clock time the JPEG came out of FFmpeg (ms since epoch). */
  capturedAtMs: number;
}

/**
 * Full-picture JPEGs from the SAME camera connection and decode (FFmpeg `split`):
 * the legacy door scan reads them instead of dialling the camera for every scan
 * (owner 2026-10-01). Independent of the gate area: always the whole picture.
 */
export interface SnapshotOptions {
  /** JPEGs per second. Default 4. */
  fps?: number;
  /** MJPEG qscale, 2 (best) .. 31. Default 3. */
  qscale?: number;
  /** Newest JPEGs kept in memory. Default 8. */
  keep?: number;
}

export type Roi = [number, number, number, number];

export interface StreamReaderOptions {
  /** Gate id (src/server/gates.ts); anything else makes the constructor throw. */
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
  /** Also emit full-picture JPEGs on a second output (see SnapshotOptions). Default off. */
  snapshot?: SnapshotOptions | null;
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
  /** Receives one line per stale/reconnect/recovery transition (no URL, host or credentials). Default: none. */
  log?: (line: string) => void;
  /** At most one `log` line per this many ms; the rest are counted into the next line. Default 10000 ms. */
  logIntervalMs?: number;
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
  logIntervalMs: number;
  ffmpegPath: string;
  frameBytes: number;
  snapshot: { fps: number; qscale: number; keep: number } | null;
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
  const gate: Gate = opts.gate;
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
      streamId: String(opts.streamId || gate),
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
      logIntervalMs: num(opts.logIntervalMs, 10_000, 0, 3_600_000),
      ffmpegPath: opts.ffmpegPath || "ffmpeg",
      frameBytes: roi[2] * roi[3] * 3,
      snapshot: opts.snapshot
        ? {
            fps: num(opts.snapshot.fps, 4, 0.1, 30),
            qscale: Math.round(num(opts.snapshot.qscale, 3, 2, 31)),
            keep: Math.floor(num(opts.snapshot.keep, 8, 1, 64)),
          }
        : null,
    },
  };
}

/** FFmpeg arguments for the long-running reader. Exported for tests and the measurement tool. */
export function buildStreamReaderArgs(
  url: string,
  c: Pick<ReaderConfig, "roi" | "fps" | "skipFrame" | "threads" | "lowDelay" | "socketTimeoutMs"> & {
    snapshot?: ReaderConfig["snapshot"];
  },
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
  args.push("-i", url);
  if (c.snapshot) {
    // One decode, two outputs: the gate-area frames below (pipe:1) and the
    // whole picture as JPEGs (pipe:3) for the door scan.
    args.push(
      "-filter_complex",
      `[0:v:0]split=2[roi][full];[roi]crop=${w}:${h}:${x}:${y},fps=${c.fps}[roiout];[full]fps=${c.snapshot.fps}[fullout]`,
      "-map", "[roiout]", "-an", "-sn", "-dn",
    );
  } else {
    args.push(
      "-map", "0:v:0", "-an", "-sn", "-dn",
      // Explicit crop (also for the full frame) pins the output size: a source
      // that is smaller than configured fails loudly instead of mis-slicing.
      "-vf", `crop=${w}:${h}:${x}:${y},fps=${c.fps}`,
    );
  }
  args.push(
    // rawvideo defaults to CFR output, which duplicates the first frame back to
    // t=0 (a burst of up to one GOP of stale copies after every connect) and
    // fills stalls with copies. Pass frames through as the fps filter made them.
    "-fps_mode", "passthrough",
    "-pix_fmt", "rgb24",
    "-f", "rawvideo",
    "pipe:1",
  );
  if (c.snapshot) {
    args.push(
      "-map", "[fullout]",
      "-fps_mode", "passthrough",
      "-c:v", "mjpeg", "-q:v", String(c.snapshot.qscale), "-pix_fmt", "yuvj420p",
      "-f", "image2pipe",
      "pipe:3",
    );
  }
  return args;
}

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
/** A JPEG larger than this is not a camera frame: the parser resynchronises. */
const SNAPSHOT_MAX_BYTES = 24 * 1024 * 1024;

/**
 * Splits an MJPEG byte stream (FFmpeg image2pipe) into whole JPEGs. FFmpeg's
 * MJPEG output carries no embedded thumbnails and byte-stuffs 0xFF in entropy
 * data, so the first EOI after an SOI ends the image. Exported for tests.
 */
export class JpegStreamSplitter {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Buffer[] = [];
    for (;;) {
      const start = this.buf.indexOf(JPEG_SOI);
      if (start < 0) {
        // Keep a trailing 0xFF: it may be the first half of the next SOI.
        this.buf = this.buf.length && this.buf[this.buf.length - 1] === 0xff ? this.buf.subarray(this.buf.length - 1) : Buffer.alloc(0);
        break;
      }
      const end = this.buf.indexOf(JPEG_EOI, start + 2);
      if (end < 0) {
        this.buf = start > 0 ? this.buf.subarray(start) : this.buf;
        if (this.buf.length > SNAPSHOT_MAX_BYTES) this.buf = Buffer.alloc(0);
        break;
      }
      out.push(Buffer.from(this.buf.subarray(start, end + 2)));
      this.buf = this.buf.subarray(end + 2);
    }
    return out;
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}

type Listener = (...args: any[]) => void;

/**
 * A reason fit for a log line: no URL, no address, no FFmpeg stderr verbatim
 * (it can name the host). Known FFmpeg failures are reduced to a keyword.
 */
export function hostFreeReason(reason: string, stderrLine = ""): string {
  const base = String(reason || "")
    .replace(/:\s.*$/s, "") // drop any ": <detail>" (stderr, error text)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "<url>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<host>")
    .slice(0, 120);
  const s = String(stderrLine || reason || "");
  const hints: Array<[RegExp, string]> = [
    [/\b401\b|unauthori[sz]ed/i, "401 unauthorized"],
    [/\b403\b|forbidden/i, "403 forbidden"],
    [/\b404\b|not found/i, "404 not found"],
    [/connection refused|ECONNREFUSED/i, "connection refused"],
    [/timed? ?out|ETIMEDOUT/i, "timeout"],
    [/resolve|ENOTFOUND|EAI_AGAIN/i, "name not resolved"],
    [/invalid data|could not find codec|decod/i, "invalid stream data"],
    [/end of file|EOF/i, "end of stream"],
    [/ENOENT/i, "ffmpeg missing"],
  ];
  const hint = hints.find(([re]) => re.test(s))?.[1];
  return hint && !base.includes(hint) ? `${base} (${hint})` : base;
}

class StreamReader extends EventEmitter implements FrameSource {
  readonly gate: Gate;
  private readonly cfg: ReaderConfig | null;
  private readonly configError?: string;
  private readonly spawnFn: SpawnLike;
  private readonly now: () => number;
  private readonly ring: RingBuffer<Frame>;
  private snapshotRing: SnapshotFrame[] = [];
  private readonly jpegSplitter = new JpegStreamSplitter();
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
  private watchdogTickMs = 250;
  private lastWatchdogAtMs = 0;
  /** A late watchdog tick waits for an I/O phase (setImmediate) before any stale verdict. */
  private ioCheckpointPending = false;
  private lastVerdictAtMs = 0;
  private lagSkips = 0;
  /** Time the last bytes came out of the FFmpeg pipe (frames complete or not). */
  private lastBytesAtMs: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStateEmitMs = 0;
  private readonly logFn: ((line: string) => void) | null;
  /** Rate limiters: failures and recoveries separately, so a recovery is not hidden by its own failure line. */
  private readonly logLimits = {
    trouble: { lastAtMs: Number.NEGATIVE_INFINITY, suppressed: 0 },
    recovery: { lastAtMs: Number.NEGATIVE_INFINITY, suppressed: 0 },
  };
  /** A failure was logged and the stream has not recovered since. */
  private troubleSinceMs: number | null = null;

  constructor(opts: StreamReaderOptions) {
    super();
    // Refused, never coerced: frames and states of this source carry this id.
    this.gate = assertGateId(opts?.gate, "stream reader gate");
    const built = buildConfig(opts);
    this.cfg = built.config;
    this.configError = built.error;
    this.spawnFn = opts?.spawn || (nodeSpawn as unknown as SpawnLike);
    this.now = opts?.now || (() => Date.now());
    this.sinceMs = this.now();
    this.ring = new RingBuffer<Frame>(this.cfg?.ringSize ?? 3);
    this.motionDetector = this.cfg && this.cfg.motion !== false ? new MotionDetector(this.cfg.motion) : null;
    this.logFn = typeof opts?.log === "function" ? opts.log : null;
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
    this.watchdogTickMs = tick;
    this.lastWatchdogAtMs = this.now();
    this.lastVerdictAtMs = this.lastWatchdogAtMs;
    this.ioCheckpointPending = false;
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
    this.troubleSinceMs = null;
    if (wasRunning || this.status !== "stopped") this.setStatus("stopped", true);
  }

  /**
   * Full-picture JPEGs, oldest first, newer than `maxAgeMs` - only while the
   * stream is healthy. Empty when the snapshot output is off.
   */
  snapshots(maxAgeMs = 2000): SnapshotFrame[] {
    if (!this.cfg?.snapshot || this.status !== "streaming") return [];
    const now = this.now();
    return this.snapshotRing.filter((s) => now - s.capturedAtMs <= maxAgeMs);
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
    this.lastBytesAtMs = null;
    this.deliveries = [];
    this.ring.clear();
    this.snapshotRing = [];
    this.jpegSplitter.reset();
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
      proc = this.spawnFn(cfg.ffmpegPath, buildStreamReaderArgs(cfg.url, cfg), {
        stdio: cfg.snapshot ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      });
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
    const snapshotPipe = cfg.snapshot ? proc.stdio?.[3] : null;
    snapshotPipe?.on("error", ignore);
    snapshotPipe?.on("data", (chunk: Buffer) => {
      if (gen === this.generation) this.onSnapshotData(chunk);
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
    const from = this.status;
    if (stale) this.setStatus("stale");
    this.resetStream();
    const delay = this.scheduleReconnect();
    if (delay !== null) {
      const what = stale ? "stale" : from === "streaming" ? "lost" : "failed";
      this.logLine(
        `stream ${what} (${hostFreeReason(reason, this.lastStderrLine())}); reconnect ${this.attempt} in ${Math.round(delay / 100) / 10} s` +
          (this.lagSkips ? `; event-loop lag skips so far ${this.lagSkips}` : ""),
      );
      if (this.troubleSinceMs === null) this.troubleSinceMs = this.now();
    }
  }

  /** One line per transition, at most one per logIntervalMs (the rest are counted into the next one). */
  private logLine(text: string, kind: "trouble" | "recovery" = "trouble"): void {
    const cfg = this.cfg;
    if (!this.logFn || !cfg) return;
    const now = this.now();
    const limit = this.logLimits[kind];
    if (now - limit.lastAtMs < cfg.logIntervalMs) {
      limit.suppressed += 1;
      return;
    }
    limit.lastAtMs = now;
    const extra = limit.suppressed ? ` (+${limit.suppressed} similar lines suppressed)` : "";
    limit.suppressed = 0;
    try {
      this.logFn(redactCredentials(text) + extra);
    } catch {
      // a logger bug must not stop the stream
    }
  }

  private scheduleReconnect(): number | null {
    const cfg = this.cfg;
    if (!cfg || !this.running) return null;
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
    return delay;
  }

  private onWatchdog(): void {
    const cfg = this.cfg;
    if (!cfg || !this.running) return;
    const now = this.now();
    // A tick that fires much later than scheduled means the event loop was
    // blocked: the pipe data that arrived meanwhile has not been read yet.
    // Timers run before I/O, and a blocked caller's next synchronous step can
    // run right after this tick (a microtask) and push the NEXT tick into the
    // same timers phase - so "skip one tick" is not enough. Instead a late tick
    // sets an I/O checkpoint (setImmediate: runs after the poll phase that
    // reads the pipe) and no verdict is taken until it has passed. Under
    // continuous lag a verdict is still taken at least every 4 x staleMs.
    const lateBy = now - this.lastWatchdogAtMs - this.watchdogTickMs;
    this.lastWatchdogAtMs = now;
    if (this.ioCheckpointPending) {
      this.lagSkips += 1;
      return;
    }
    if (lateBy > cfg.staleMs / 2 && now - this.lastVerdictAtMs < 4 * cfg.staleMs) {
      this.lagSkips += 1;
      this.ioCheckpointPending = true;
      setImmediate(() => {
        this.ioCheckpointPending = false;
      });
      return;
    }
    this.lastVerdictAtMs = now;
    if (this.status === "starting" && now - this.spawnedAtMs > cfg.firstFrameTimeoutMs) {
      this.fail(this.generation, `no frame within ${cfg.firstFrameTimeoutMs} ms of connecting`, true);
      return;
    }
    const lastData = Math.max(this.lastFrameAtMs ?? Number.NEGATIVE_INFINITY, this.lastBytesAtMs ?? Number.NEGATIVE_INFINITY);
    if (this.status === "streaming" && Number.isFinite(lastData) && now - lastData > cfg.staleMs) {
      this.fail(this.generation, `no frame for ${now - lastData} ms`, true);
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
    this.lastBytesAtMs = this.now();
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

  private onSnapshotData(chunk: Buffer): void {
    const keep = this.cfg?.snapshot?.keep ?? 0;
    if (!keep) return;
    for (const jpeg of this.jpegSplitter.push(chunk)) {
      this.snapshotRing.push({ jpeg, capturedAtMs: this.now() });
      if (this.snapshotRing.length > keep) this.snapshotRing.splice(0, this.snapshotRing.length - keep);
    }
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
      if (this.troubleSinceMs !== null) {
        this.logLine(`stream back after ${Math.round((now - this.troubleSinceMs) / 100) / 10} s (${this.reconnects} reconnects so far)`, "recovery");
        this.troubleSinceMs = null;
      }
    }
    this.emit("frame", frame);
  }
}

/** Creates the reader; call `start()` to open the stream. Never throws. */
export function createStreamReader(
  opts: StreamReaderOptions,
): FrameSource & { getState(): SourceState; snapshots(maxAgeMs?: number): SnapshotFrame[]; readonly pid?: number } {
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
