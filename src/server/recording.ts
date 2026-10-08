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
 *    with times as `YYYYMMDDTHHMMSSZ`; a time in the future answers
 *    400 Bad Request;
 *  - despite the trailing "Z", the NVR reads those digits as ITS OWN local
 *    time (site NVR and cameras: GMT+07:00, NTP; verified 2026-10-03 and in
 *    helpdesk ticket #429, where UTC digits played footage 7 h early). The
 *    NVR's offset is RECORDING_NVR_UTC_OFFSET, default +07:00;
 *  - delivery is about real time, and starts at the keyframe BEFORE the
 *    requested time (1-4 s early), so the window is padded;
 *  - the recording carries G.711 audio (not playable in MP4) and HEVC video
 *    (not playable in every browser): video only, re-encoded to H.264 720p.
 *
 * The live stream a gate is WATCHED from can differ from the channel it is
 * RECORDED on (the entry camera is read directly, and recorded by the NVR as
 * channel 2201), so the recording channel is configured per gate.
 *
 * N-gate wave: the channel is per gate ID, from RECORDING_<SUFFIX>_CHANNEL
 * where SUFFIX = gateEnvSuffix(id) (src/server/gates.ts): gate "entry" reads
 * RECORDING_ENTRY_CHANNEL and "exit" RECORDING_EXIT_CHANNEL (the legacy names,
 * unchanged), gate "side-door" reads RECORDING_SIDE_DOOR_CHANNEL.
 */

import { gateEnvSuffix, isGateId } from "./gates";

export interface RecordingConfig {
  /** rtsp://login@host:port of the NVR, no path. Server-side only. */
  baseUrl: string;
  /** NVR channel per gate id; only gates with a valid (numeric) channel are present. */
  channels: Record<string, string>;
  /** The NVR's clock offset from UTC, in minutes (+420 = GMT+07:00). */
  utcOffsetMinutes: number;
}

/** The site NVR's time zone (GMT+07:00, no DST) when RECORDING_NVR_UTC_OFFSET is unset. */
export const DEFAULT_NVR_UTC_OFFSET_MINUTES = 7 * 60;
const UTC_OFFSET_RE = /^([+-])(\d{1,2})(?::?(\d{2}))?$/;

/**
 * "+07:00", "+0700", "+7", "-03:30" -> minutes; empty -> the default; anything
 * else (or beyond +-14:00) -> null.
 */
export function parseUtcOffset(raw: string | undefined): number | null {
  const v = String(raw || "").trim();
  if (!v) return DEFAULT_NVR_UTC_OFFSET_MINUTES;
  const m = UTC_OFFSET_RE.exec(v);
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3] || 0);
  if (Number(m[3] || 0) > 59 || minutes > 14 * 60) return null;
  return m[1] === "-" ? -minutes : minutes;
}

const CHANNEL_RE = /^[0-9]{1,5}$/;
/** RECORDING_<SUFFIX>_CHANNEL; the suffix is an upper-cased gate id with "-" as "_". */
const CHANNEL_ENV_RE = /^RECORDING_([A-Z][A-Z0-9_]{1,31})_CHANNEL$/;

/** The gate id an env suffix names (SIDE_DOOR -> side-door), or null when it is not a gate id. */
function gateIdFromEnvSuffix(suffix: string): string | null {
  const id = suffix.toLowerCase().replace(/_/g, "-");
  return isGateId(id) && gateEnvSuffix(id) === suffix ? id : null;
}

/**
 * Reads RECORDING_NVR_URL, every RECORDING_<GATE>_CHANNEL and
 * RECORDING_NVR_UTC_OFFSET. Null (feature off) unless the NVR URL is a plain
 * rtsp:// origin, at least one gate has a numeric channel, and the offset (when
 * set) is valid - a mistyped offset would play the wrong hour, so it plays
 * nothing. Never throws; never echoes the URL.
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
  const channels: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const m = CHANNEL_ENV_RE.exec(name);
    const gateId = m ? gateIdFromEnvSuffix(m[1]) : null;
    const c = String(value || "").trim();
    if (gateId && CHANNEL_RE.test(c)) channels[gateId] = c;
  }
  if (Object.keys(channels).length === 0) return null;
  const utcOffsetMinutes = parseUtcOffset(env.RECORDING_NVR_UTC_OFFSET);
  if (utcOffsetMinutes === null) return null;
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
  return { baseUrl: `rtsp://${auth}${url.hostname}${url.port ? `:${url.port}` : ""}`, channels, utcOffsetMinutes };
}

/** The NVR channel a gate is recorded on, or null when that gate has none. */
export function recordingChannelFor(cfg: RecordingConfig, gateId: string): string | null {
  return Object.prototype.hasOwnProperty.call(cfg.channels, gateId) ? cfg.channels[gateId] : null;
}

/**
 * NVR playback time: the NVR's local wall clock as `YYYYMMDDTHHMMSSZ` (the "Z"
 * is the format the NVR accepts, not a time zone - see the module comment).
 */
export function nvrTime(ms: number, utcOffsetMinutes: number): string {
  return new Date(ms + utcOffsetMinutes * 60_000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
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
  return `${cfg.baseUrl}/Streaming/tracks/${channel}?starttime=${nvrTime(startMs, cfg.utcOffsetMinutes)}&endtime=${nvrTime(endMs, cfg.utcOffsetMinutes)}`;
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
    // A keyframe every second: the fragmented MP4 is cut at keyframes, and with
    // x264's default (~250 frames, 17 s at 15 fps) the browser got the header at
    // once but no playable picture until the clip had finished converting -
    // 36 s for a 4K entry clip (2026-10-08). Now the first picture plays in ~3 s.
    "-force_key_frames", "expr:gte(t,n_forced*1)",
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
