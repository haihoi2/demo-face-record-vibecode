/**
 * Watcher-panel wording for the real-time pipeline rollout and its health.
 *
 * The server owns every value here (`GET /api/camera-streams/watch` and the
 * `gate_watch_state` SSE event). A field the server does not send yet is simply
 * absent - these helpers read it defensively and never invent a state.
 *
 * Mirrors `SourceState` in src/server/pipeline/contracts.ts (not imported: that
 * file is backend code and must not end up in the browser bundle).
 */

export type PipelineMode = "legacy" | "shadow" | "live";
export type PipelineSourceStatus = "starting" | "streaming" | "stale" | "reconnecting" | "stopped";
export type Tone = "emerald" | "sky" | "amber" | "rose" | "slate";

export interface PipelineSourceState {
  status: PipelineSourceStatus;
  fps: number | null;
  newestFrameAgeMs: number | null;
  reconnects: number | null;
  lastError?: string;
  since?: string;
}

export interface PipelineStats {
  lastDecisionLatencyMs?: number;
  decisions?: number;
}

export interface PipelineRuntimeView {
  mode: PipelineMode | null;
  /** Configured on the server but not available in this build (legacy runs instead). */
  requested: PipelineMode | null;
  state: PipelineSourceState | null;
  stats: PipelineStats | null;
}

const MODES: readonly PipelineMode[] = ["legacy", "shadow", "live"];
const STATUSES: readonly PipelineSourceStatus[] = ["starting", "streaming", "stale", "reconnecting", "stopped"];

export function parsePipelineMode(raw: unknown): PipelineMode | null {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (MODES as readonly string[]).includes(v) ? (v as PipelineMode) : null;
}

/**
 * Defence in depth: the server must never put a credential-bearing URL in a
 * status message, but if one slips through it is masked before rendering.
 */
export function redactCredentialUrls(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1•••@");
}

const num = (raw: unknown): number | null => {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/** `pipelineState` from the watcher runtime, or null when absent/unusable. */
export function normalizePipelineState(raw: unknown): PipelineSourceState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const status = typeof r.status === "string" ? (r.status.toLowerCase() as PipelineSourceStatus) : null;
  if (!status || !STATUSES.includes(status)) return null;
  const age = num(r.newestFrameAgeMs);
  const fps = num(r.fps);
  const reconnects = num(r.reconnects);
  return {
    status,
    fps: fps !== null && fps >= 0 ? fps : null,
    newestFrameAgeMs: age !== null && age >= 0 ? age : null,
    reconnects: reconnects !== null && reconnects >= 0 ? Math.floor(reconnects) : null,
    ...(typeof r.lastError === "string" && r.lastError.trim() ? { lastError: redactCredentialUrls(r.lastError.trim()) } : {}),
    ...(typeof r.since === "string" ? { since: r.since } : {}),
  };
}

/** `pipelineStats` from the watcher runtime, or null when absent/empty. */
export function normalizePipelineStats(raw: unknown): PipelineStats | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const latency = num(r.lastDecisionLatencyMs);
  const decisions = num(r.decisions);
  const out: PipelineStats = {};
  if (latency !== null && latency >= 0) out.lastDecisionLatencyMs = latency;
  if (decisions !== null && decisions >= 0) out.decisions = Math.floor(decisions);
  return Object.keys(out).length > 0 ? out : null;
}

/** Everything the panel needs from one raw watcher runtime object. */
export function readPipelineRuntime(raw: unknown): PipelineRuntimeView {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const mode = parsePipelineMode(r.pipelineMode);
  const requested = parsePipelineMode(r.pipelineModeRequested);
  return {
    mode,
    requested: requested && requested !== mode ? requested : null,
    state: normalizePipelineState(r.pipelineState),
    stats: normalizePipelineStats(r.pipelineStats),
  };
}

/** Short label: "legacy", "chạy thử (shadow)", "đang áp dụng (live)". */
export function pipelineModeLabel(mode: PipelineMode): string {
  switch (mode) {
    case "shadow":
      return "chạy thử (shadow)";
    case "live":
      return "đang áp dụng (live)";
    default:
      return "legacy";
  }
}

/** One-line explanation shown next to the mode chip. */
export function pipelineModeHint(mode: PipelineMode): string {
  switch (mode) {
    case "shadow":
      return "Pipeline mới chạy song song để so sánh: không mở cửa, không ghi nhật ký. Watcher cũ vẫn quyết định.";
    case "live":
      return "Pipeline mới đang quyết định cho cổng này; watcher cũ đã tắt.";
    default:
      return "Watcher cũ quyết định: quét từng lượt, nghỉ giữa hai lượt.";
  }
}

export function pipelineModeTone(mode: PipelineMode): Tone {
  return mode === "live" ? "emerald" : mode === "shadow" ? "sky" : "slate";
}

/** "Đã cấu hình live nhưng bản này chưa có - đang chạy legacy." */
export function pipelineModeFallbackNote(view: PipelineRuntimeView): string | null {
  if (!view.requested) return null;
  const running = view.mode ? pipelineModeLabel(view.mode) : "legacy";
  return `Đã cấu hình ${pipelineModeLabel(view.requested)} nhưng máy chủ chưa có chế độ này - đang chạy ${running}.`;
}

export function sourceStatusLabel(status: PipelineSourceStatus): string {
  switch (status) {
    case "starting":
      return "Đang khởi động";
    case "streaming":
      return "Đang nhận hình";
    case "stale":
      return "Hình bị đứng";
    case "reconnecting":
      return "Đang kết nối lại";
    case "stopped":
      return "Đã dừng";
  }
}

export function sourceStatusTone(status: PipelineSourceStatus): Tone {
  switch (status) {
    case "streaming":
      return "emerald";
    case "starting":
      return "sky";
    case "stale":
    case "reconnecting":
      return "amber";
    case "stopped":
      return "slate";
  }
}

/** "8.0 khung/giây"; em dash when unknown. */
export function formatFps(fps: number | null | undefined): string {
  if (typeof fps !== "number" || !Number.isFinite(fps) || fps < 0) return "—";
  return `${fps >= 10 ? fps.toFixed(0) : fps.toFixed(1)} khung/giây`;
}

/** Milliseconds as "350 ms" / "1.2 giây" / "2 phút"; em dash when unknown. */
export function formatDurationMs(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} giây`;
  return `${Math.round(ms / 60_000)} phút`;
}

/** A newest frame older than this is worth flagging (the reader reconnects after ~1 s). */
export const STALE_FRAME_WARN_MS = 1500;

export function isFrameAgeWorrying(ms: number | null | undefined): boolean {
  return typeof ms === "number" && Number.isFinite(ms) && ms > STALE_FRAME_WARN_MS;
}
