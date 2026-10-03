/**
 * Presence detection settings (P2): model files, thresholds, masks, rules and
 * the PRESENCE_* environment variables named in contracts.ts.
 *
 * The defaults are the P1/P1b operating point ("UNION-LOWRATE",
 * docs/plans/2026-10-02-presence-p1-report.md section 0):
 *   YOLOX-Nano  960 px wide, person score >= 0.55, every processed frame;
 *   RTMDet-tiny 960 px wide, person score >= 0.30, every 4th processed frame;
 *   boxes merged by NMS 0.5; OSD clock and logo masked; detections up to 2 s
 *   apart linked into one track; an event after 3 s in view (working hours,
 *   07:00-19:00 Asia/Ho_Chi_Minh) or 1 s (after hours).
 * The sha256 values pin the exact ONNX exports evaluated in P1 (report section 0,
 * "Weight files used"); a different file is refused (fail closed).
 */
import type { MaskRect, PresenceModelConfig, PresenceModelId, PresenceRules } from "./contracts";

export const PRESENCE_MODEL_DIR_DEFAULT = "/app/models/presence";
export const PRESENCE_TIME_ZONE = "Asia/Ho_Chi_Minh";

/** The two P1b models. `file` lives in PRESENCE_MODEL_DIR; `sha256` is the P1 export. */
export const DEFAULT_PRESENCE_MODELS: Readonly<Record<PresenceModelId, PresenceModelConfig>> = Object.freeze({
  "yolox-nano": Object.freeze({
    id: "yolox-nano",
    file: "yolox_nano_person.onnx",
    inputWidth: 960,
    threshold: 0.55,
    sha256: "d37c96c31da5f9e6158b72577bac0ed595201a202aba4133dded1313bf335ace",
  }) as PresenceModelConfig,
  "rtmdet-tiny": Object.freeze({
    id: "rtmdet-tiny",
    file: "rtmdet_tiny_person.onnx",
    inputWidth: 960,
    threshold: 0.3,
    sha256: "31aa4d63d4fb734205619e1927f7df239d12bc2208bca8ff2374cb2fc88b8c70",
  }) as PresenceModelConfig,
});

/**
 * Static overlays per gate (fractions [x, y, w, h] of the picture): the camera's
 * on-screen date/time and logo. A detection lying >= 50 % inside them is dropped
 * (P1: the OSD digits were taken for a person at 960 px). Unknown gates: no mask.
 */
export const DEFAULT_PRESENCE_MASKS: Readonly<Record<string, readonly MaskRect[]>> = Object.freeze({
  entry: Object.freeze([
    [0.0, 0.93, 0.35, 0.07],
    [0.0, 0.0, 0.14, 0.06],
  ] as MaskRect[]),
  exit: Object.freeze([
    [0.63, 0.0, 0.27, 0.04],
    [0.0, 0.84, 0.14, 0.05],
  ] as MaskRect[]),
});

export const DEFAULT_PRESENCE_RULES: Readonly<PresenceRules> = Object.freeze({
  workingHours: Object.freeze({ start: "07:00", end: "19:00", timeZone: PRESENCE_TIME_ZONE }),
  minInViewMsWorking: 3000,
  minInViewMsAfterHours: 1000,
  linkGapMs: 2000,
});

export interface PresenceSettings {
  modelDir: string;
  /** Frames per second the stream delivers to the presence host (PRESENCE_FPS). */
  fps: number;
  /** Width of the frames (PRESENCE_FRAME_WIDTH); the models' input width follows the model config. */
  frameWidth: number;
  /** RTMDet runs on every N-th processed frame (PRESENCE_RTMDET_EVERY). */
  rtmdetEvery: number;
  rules: PresenceRules;
  models: { primary: PresenceModelConfig; secondary: PresenceModelConfig };
  ortThreads: number;
  workerNice: number;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number, errors: string[]): number {
  const raw = String(env[name] ?? "").trim();
  if (raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${name} must be an integer ${min}-${max}, got ${JSON.stringify(raw.slice(0, 20))}; using ${def}`);
    return def;
  }
  return n;
}

function numEnv(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number, errors: string[]): number {
  const raw = String(env[name] ?? "").trim();
  if (raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    errors.push(`${name} must be a number ${min}-${max}, got ${JSON.stringify(raw.slice(0, 20))}; using ${def}`);
    return def;
  }
  return n;
}

/** "HH:MM-HH:MM" -> { start, end }, or null. */
export function parseWorkingHours(raw: string): { start: string; end: string } | null {
  const m = /^\s*([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)\s*$/.exec(String(raw ?? ""));
  if (!m) return null;
  const start = `${m[1]}:${m[2]}`;
  const end = `${m[3]}:${m[4]}`;
  return start === end ? null : { start, end };
}

/**
 * Settings from the environment (contracts.ts list). Invalid values fall back to
 * the default and are reported in `errors` (the host surfaces them as lastError).
 */
export function presenceSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): { settings: PresenceSettings; errors: string[] } {
  const errors: string[] = [];
  const dirRaw = String(env.PRESENCE_MODEL_DIR ?? "").trim();
  const frameWidth = intEnv(env, "PRESENCE_FRAME_WIDTH", 960, 320, 1920, errors);
  let hours: { start: string; end: string } = { ...DEFAULT_PRESENCE_RULES.workingHours };
  const hoursRaw = String(env.PRESENCE_WORKING_HOURS ?? "").trim();
  if (hoursRaw) {
    const parsed = parseWorkingHours(hoursRaw);
    if (parsed) hours = parsed;
    else errors.push(`PRESENCE_WORKING_HOURS must be HH:MM-HH:MM, got ${JSON.stringify(hoursRaw.slice(0, 20))}; using 07:00-19:00`);
  }
  const settings: PresenceSettings = {
    modelDir: dirRaw || PRESENCE_MODEL_DIR_DEFAULT,
    fps: numEnv(env, "PRESENCE_FPS", 2, 0.5, 8, errors),
    frameWidth,
    rtmdetEvery: intEnv(env, "PRESENCE_RTMDET_EVERY", 4, 1, 32, errors),
    rules: {
      workingHours: { start: hours.start, end: hours.end, timeZone: PRESENCE_TIME_ZONE },
      minInViewMsWorking: Math.round(numEnv(env, "PRESENCE_MIN_SECONDS_WORKING", 3, 0.5, 60, errors) * 1000),
      minInViewMsAfterHours: Math.round(numEnv(env, "PRESENCE_MIN_SECONDS_AFTER_HOURS", 1, 0.5, 60, errors) * 1000),
      linkGapMs: DEFAULT_PRESENCE_RULES.linkGapMs,
    },
    models: {
      primary: { ...DEFAULT_PRESENCE_MODELS["yolox-nano"], inputWidth: frameWidth },
      secondary: { ...DEFAULT_PRESENCE_MODELS["rtmdet-tiny"], inputWidth: frameWidth },
    },
    ortThreads: intEnv(env, "PRESENCE_ORT_THREADS", 1, 1, 8, errors),
    workerNice: intEnv(env, "PRESENCE_WORKER_NICE", 19, 0, 19, errors),
  };
  return { settings, errors };
}

/** Mask for a gate id: the configured default, or none. */
export function presenceMaskForGate(gateId: string): MaskRect[] {
  return (DEFAULT_PRESENCE_MASKS[gateId] || []).map((r) => [...r] as MaskRect);
}
