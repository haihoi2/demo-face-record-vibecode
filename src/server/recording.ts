/**
 * Playback of the NVR's own recording around an access event.
 *
 * The app stores only what it decided; the wider scene lives on the site's
 * Hikvision NVR, which records every gate camera continuously. An operator
 * reviewing an event gets ~15 s of that recording, fetched by the backend -
 * the NVR address and login never leave the server.
 *
 * Facts this module relies on (tested on the site's DS-9632NI-I8, 2026-09-26):
 *  - playback is `<base>/Streaming/tracks/<channel>?starttime=..&endtime=..`
 *    with times in UTC, `YYYYMMDDTHHMMSSZ`; a time in the future answers
 *    400 Bad Request;
 *  - delivery is about real time, and starts at the keyframe BEFORE the
 *    requested time (1-4 s early), so the window is padded;
 *  - the recording carries G.711 audio (not playable in MP4) and HEVC video
 *    (not playable in every browser): video only, re-encoded to H.264 720p.
 *
 * The live stream a gate is WATCHED from can differ from the channel it is
 * RECORDED on (the entry camera is read directly, and recorded by the NVR as
 * channel 2201), so the recording channel is configured per gate.
 */

export type RecordedGate = "ENTRY" | "EXIT";

export interface RecordingConfig {
  /** rtsp://login@host:port of the NVR, no path. Server-side only. */
  baseUrl: string;
  channels: Record<RecordedGate, string | null>;
}

const CHANNEL_RE = /^[0-9]{1,5}$/;

/**
 * Reads RECORDING_NVR_URL / RECORDING_ENTRY_CHANNEL / RECORDING_EXIT_CHANNEL.
 * Null (feature off) unless the NVR URL is a plain rtsp:// origin and at least
 * one gate has a numeric channel. Never throws; never echoes the URL.
 */
export function recordingConfigFromEnv(env: Record<string, string | undefined> = process.env): RecordingConfig | null {
  const raw = String(env.RECORDING_NVR_URL || "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "rtsp:" || !url.hostname) return null;
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) return null;
  const channel = (v: string | undefined) => {
    const c = String(v || "").trim();
    return CHANNEL_RE.test(c) ? c : null;
  };
  const channels = { ENTRY: channel(env.RECORDING_ENTRY_CHANNEL), EXIT: channel(env.RECORDING_EXIT_CHANNEL) };
  if (!channels.ENTRY && !channels.EXIT) return null;
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
  return { baseUrl: `rtsp://${auth}${url.hostname}${url.port ? `:${url.port}` : ""}`, channels };
}

/** NVR playback time: UTC, `YYYYMMDDTHHMMSSZ`. */
export function nvrTime(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export interface RecordingWindowOptions {
  beforeMs: number;
  afterMs: number;
  /** The NVR cannot serve the last moments yet: stop this far before now. */
  minLagMs: number;
  /** Shorter than this is not worth playing. */
  minLengthMs: number;
}

export const DEFAULT_RECORDING_WINDOW: RecordingWindowOptions = {
  beforeMs: 8_000,
  afterMs: 7_000,
  minLagMs: 3_000,
  minLengthMs: 4_000,
};

export type RecordingWindow =
  | { ok: true; startMs: number; endMs: number }
  | { ok: false; reason: "invalid-time" | "not-yet-recorded"; retryAfterSeconds?: number };

/**
 * The window to play around an event. The event time is when the access log
 * was written, a second or two after the frame was captured - the "before"
 * pad covers that, plus the keyframe the NVR starts from.
 */
export function recordingWindow(
  eventMs: number,
  nowMs: number,
  opts: RecordingWindowOptions = DEFAULT_RECORDING_WINDOW,
): RecordingWindow {
  if (!Number.isFinite(eventMs) || eventMs > nowMs + 60_000) return { ok: false, reason: "invalid-time" };
  const startMs = eventMs - opts.beforeMs;
  const endMs = Math.min(eventMs + opts.afterMs, nowMs - opts.minLagMs);
  if (endMs - startMs < opts.minLengthMs) {
    const readyAt = startMs + opts.minLengthMs + opts.minLagMs;
    return { ok: false, reason: "not-yet-recorded", retryAfterSeconds: Math.max(1, Math.ceil((readyAt - nowMs) / 1000)) };
  }
  return { ok: true, startMs, endMs };
}

/** Narrowing helper: the project compiles without `strict`, so `!w.ok` does not narrow. */
export function recordingWindowFailure(w: RecordingWindow): Extract<RecordingWindow, { ok: false }> | null {
  return w.ok ? null : (w as Extract<RecordingWindow, { ok: false }>);
}

export function playbackUrl(cfg: RecordingConfig, channel: string, startMs: number, endMs: number): string {
  return `${cfg.baseUrl}/Streaming/tracks/${channel}?starttime=${nvrTime(startMs)}&endtime=${nvrTime(endMs)}`;
}

/**
 * FFmpeg arguments: NVR playback in, fragmented MP4 (H.264 720p, no audio)
 * out on stdout, so the browser starts playing while the NVR is still sending.
 */
export function playbackFfmpegArgs(url: string, durationSeconds: number): string[] {
  return [
    "-hide_banner", "-loglevel", "error",
    "-rtsp_transport", "tcp",
    "-timeout", "10000000", // 10 s socket timeout, microseconds
    "-i", url,
    "-map", "0:v:0",
    "-t", String(Math.max(1, Math.round(durationSeconds))),
    "-vf", "scale=-2:720",
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
    "-profile:v", "main", "-pix_fmt", "yuv420p", "-crf", "26",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4", "pipe:1",
  ];
}

/** Strips credentials from anything FFmpeg or the NVR says before it is logged. */
export function redactRtsp(text: string): string {
  return String(text || "").replace(/rtsp:\/\/[^\s"'@/]*@/gi, "rtsp://<login>@");
}

/** What an FFmpeg failure means for the operator. */
export function playbackFailure(stderr: string): { status: number; code: string; error: string } {
  if (/400 Bad Request|404 Not Found|No such file|Invalid data found/i.test(stderr)) {
    return {
      status: 404,
      code: "RECORDING_NOT_FOUND",
      error: "Đầu ghi không có đoạn ghi cho thời điểm này (có thể đã bị ghi đè — đầu ghi lưu khoảng 8 ngày).",
    };
  }
  if (/401 Unauthorized|403 Forbidden/i.test(stderr)) {
    return { status: 502, code: "RECORDING_AUTH_FAILED", error: "Đầu ghi từ chối tài khoản xem lại. Kiểm tra cấu hình RECORDING_NVR_URL." };
  }
  return { status: 504, code: "RECORDING_UNAVAILABLE", error: "Không lấy được đoạn ghi từ đầu ghi (đầu ghi không phản hồi hoặc đang bận)." };
}
