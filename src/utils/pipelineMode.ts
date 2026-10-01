/**
 * Per-gate switch of the real-time pipeline engine (legacy | shadow | live).
 *
 * The pipeline is a SEPARATE engine flow beside the legacy recognize workflow,
 * switched per gate; it is never one of the three `engineMode` values. This
 * module is pure: it reads the watcher payload defensively, builds the request
 * for `POST /api/camera-streams/:gate/pipeline-mode` and turns the server's
 * answer into one of three outcomes. It never treats an HTTP refusal as success
 * and never decides anything the server did not say.
 */

import {
  parsePipelineMode,
  pipelineModeLabel,
  readPipelineRuntime,
  type PipelineMode,
  type PipelineRuntimeView,
} from "./pipelineStatus";
import {
  LEGACY_GATE_IDS,
  directionOf,
  gateIdFromAny,
  isGateId,
  legacyGateLabel,
  orderedGateIds,
  runtimeGateId,
} from "./gates";
import type { GateConfig } from "../types";

/** A gate id (N-gate wave): "entry", "exit" or any configured slug. Never a direction. */
export type GateKey = string;
/** A gate's DIRECTION; several gates can share one, so it is never a key. */
export type GateType = "ENTRY" | "EXIT";
export type PipelineModeSource = "config" | "env";

/** The two gates every installation has; the card's rows otherwise come from the gate list. */
export const LEGACY_GATE_KEYS: readonly GateKey[] = LEGACY_GATE_IDS;
export const PIPELINE_MODES: readonly PipelineMode[] = ["legacy", "shadow", "live"];

/** `live` is not in this build: the server answers 409 PIPELINE_MODE_NOT_AVAILABLE. */
export const PIPELINE_MODE_UNAVAILABLE_TITLE = "chưa có trong bản này";

export function isPipelineModeSelectable(mode: PipelineMode): boolean {
  return mode !== "live";
}

/** Gate id from a slug or an older server's direction ("EXIT" -> "exit"); null otherwise. */
export function gateKeyOf(gate: unknown): GateKey | null {
  return gateIdFromAny(gate);
}

/** The gate's label from the server when known, else "Cổng vào"/"Cổng ra" for the legacy gates. */
export function gateLabel(key: GateKey, label?: string | null): string {
  const given = typeof label === "string" ? label.trim() : "";
  return given || legacyGateLabel(key) || `Cổng ${key}`;
}

/**
 * The card's rows (no fixed two-gate list any more): the configured gates in order,
 * then any gate the watcher list reports that the config did not.
 */
export function gateKeysForCard(gates: readonly GateConfig[], rows: Readonly<Record<string, unknown>>): GateKey[] {
  return orderedGateIds(gates, Object.keys(rows));
}

export function parsePipelineModeSource(raw: unknown): PipelineModeSource | null {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return v === "config" || v === "env" ? v : null;
}

/** "theo cấu hình" / "mặc định máy chủ"; an older server sends no source. */
export function pipelineModeSourceLabel(source: PipelineModeSource | null): string {
  if (source === "config") return "theo cấu hình";
  if (source === "env") return "mặc định máy chủ";
  return "máy chủ chưa báo nguồn";
}

/** Everything the engine card shows for one gate, read from one watcher object. */
export interface GatePipelineRow {
  /** Direction reported by the server (null when it sent none). */
  gate: GateType | null;
  /** Gate id: the row's key. */
  key: GateKey;
  /** Display label the server sent with the runtime (`gateLabel`), if any. */
  label: string | null;
  /** The gate's backend watcher switch; a disabled gate runs no pipeline. */
  enabled: boolean | null;
  view: PipelineRuntimeView;
  source: PipelineModeSource | null;
  /**
   * The value stored in the gate's config (what the admin switch shows as
   * selected): the requested mode when the build downgraded it, else the
   * effective mode. Null when the gate follows the server default.
   */
  configured: PipelineMode | null;
}

export function readGatePipelineRow(raw: unknown): GatePipelineRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = runtimeGateId(r);
  if (!key) return null;
  const view = readPipelineRuntime(r);
  const source = parsePipelineModeSource(r.pipelineModeSource);
  const configured = source === "config" ? view.requested ?? view.mode : null;
  return {
    gate: directionOf(r.gate),
    key,
    label: typeof r.gateLabel === "string" && r.gateLabel.trim() ? r.gateLabel.trim() : null,
    enabled: typeof r.enabled === "boolean" ? r.enabled : null,
    view,
    source,
    configured,
  };
}

/** Rows keyed by gate from a `GET /api/camera-streams/watch` body. */
export function readGatePipelineRows(payload: unknown): Record<GateKey, GatePipelineRow> {
  const out: Record<GateKey, GatePipelineRow> = {};
  const list = payload && typeof payload === "object" ? (payload as Record<string, unknown>).watchers : null;
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    const row = readGatePipelineRow(raw);
    if (row) out[row.key] = row;
  }
  return out;
}

/** The exact request the card sends; `mode: null` clears the per-gate override. */
export function buildPipelineModeRequest(key: GateKey, mode: PipelineMode | null): { url: string; init: RequestInit } {
  return {
    url: `/api/camera-streams/${encodeURIComponent(key)}/pipeline-mode`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    },
  };
}

export interface PipelineModeConfirmText {
  title: string;
  body: string;
  confirmLabel: string;
}

/**
 * What the admin is told before the switch goes to the server. Shadow and the
 * way back to legacy are explicit (owner request); the two other targets get an
 * equally plain sentence so no click starts or stops a camera stream unannounced.
 */
export function pipelineModeConfirmText(
  key: GateKey,
  target: PipelineMode | null,
  label?: string | null,
): PipelineModeConfirmText {
  const gate = gateLabel(key, label);
  switch (target) {
    case "shadow":
      return {
        title: `Chuyển ${gate} sang chạy thử (shadow)?`,
        body:
          "Máy chủ sẽ chạy thêm một luồng camera luôn mở và một worker nhận diện riêng cho cổng này; " +
          "chỉ quan sát, không mở cửa, không ghi nhật ký. Watcher hiện tại vẫn quyết định như trước.",
        confirmLabel: "Chạy thử (shadow)",
      };
    case "legacy":
      return {
        title: `Chuyển ${gate} về legacy?`,
        body:
          "Máy chủ sẽ dừng luồng camera riêng và worker nhận diện của động cơ thời gian thực cho cổng này. " +
          "Watcher hiện tại tiếp tục quét như trước; việc mở cửa không thay đổi.",
        confirmLabel: "Về legacy",
      };
    case "live":
      return {
        title: `Áp dụng động cơ thời gian thực cho ${gate}?`,
        body:
          "Động cơ mới sẽ quyết định cho cổng này và watcher hiện tại tắt. " +
          `Bản này ${PIPELINE_MODE_UNAVAILABLE_TITLE}: máy chủ sẽ từ chối yêu cầu.`,
        confirmLabel: "Áp dụng (live)",
      };
    default:
      return {
        title: `Dùng mặc định máy chủ cho ${gate}?`,
        body:
          "Bỏ giá trị đã cấu hình; cổng này chạy theo mặc định của máy chủ (biến môi trường). " +
          "Nếu mặc định là chạy thử, máy chủ mở thêm luồng camera và worker riêng; nếu là legacy, luồng riêng dừng lại.",
        confirmLabel: "Dùng mặc định máy chủ",
      };
  }
}

export type PipelineModeOutcome =
  | {
      kind: "applied";
      /** Direction the server reported. */
      gate: GateType | null;
      /** Gate id the answer is about (the server's, else the one asked for). */
      gateId: GateKey;
      mode: PipelineMode | null;
      requested: PipelineMode | null;
      source: PipelineModeSource | null;
      /** The watcher runtime the server returned, for the row to render at once. */
      watcher: unknown;
      message: string;
    }
  | { kind: "refused"; status: number; code: string | null; message: string }
  | { kind: "unreachable"; message: string };

/**
 * One place that decides what a response means. Only a 2xx body with
 * `success: true` is "applied"; 4xx/5xx are refusals with the server's own
 * message where it has one (409 always); status 0 is a transport failure.
 */
export function interpretPipelineModeResponse(
  key: GateKey,
  res: { ok: boolean; status: number; data: unknown; error?: string },
  label?: string | null,
): PipelineModeOutcome {
  const gate = gateLabel(key, label);
  const data = res.data && typeof res.data === "object" ? (res.data as Record<string, unknown>) : {};
  const serverError = typeof data.error === "string" && data.error.trim() ? data.error.trim() : null;

  if (res.status === 0) {
    return { kind: "unreachable", message: `Không kết nối được máy chủ. Chế độ của ${gate} CHƯA đổi.` };
  }

  if (res.ok && data.success === true) {
    const mode = parsePipelineMode(data.pipelineMode);
    const requestedRaw = parsePipelineMode(data.pipelineModeRequested);
    const requested = requestedRaw && requestedRaw !== mode ? requestedRaw : null;
    const source = parsePipelineModeSource(data.pipelineModeSource);
    const running = mode ? pipelineModeLabel(mode) : "chế độ máy chủ chưa báo";
    const note = requested
      ? ` Đã cấu hình ${pipelineModeLabel(requested)} nhưng máy chủ chưa có chế độ này.`
      : "";
    return {
      kind: "applied",
      gate: directionOf(data.gate),
      // An older server answers with only the direction: trust the gate asked for.
      gateId: isGateId(data.gateId) ? data.gateId : key,
      mode,
      requested,
      source,
      watcher: data.watcher ?? null,
      message: `${gate}: đang chạy ${running} (${pipelineModeSourceLabel(source)}).${note}`,
    };
  }

  const code = typeof data.code === "string" && data.code ? data.code : null;
  let message: string;
  switch (res.status) {
    case 409:
      message = serverError || "Máy chủ chưa có chế độ này trong bản hiện tại.";
      break;
    case 403:
      message = serverError || "Tài khoản không có quyền đổi chế độ động cơ (cần Quản trị).";
      break;
    case 401:
      message = "Cần đăng nhập để đổi chế độ.";
      break;
    case 404:
      message = "Máy chủ chưa có API đổi chế độ động cơ thời gian thực (HTTP 404).";
      break;
    case 400:
      message = serverError || "Chế độ không hợp lệ.";
      break;
    default:
      message = serverError || res.error || `Máy chủ từ chối yêu cầu (HTTP ${res.status}).`;
  }
  return { kind: "refused", status: res.status, code, message: `${message} Chế độ của ${gate} CHƯA đổi.` };
}
