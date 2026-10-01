/**
 * N gates (plan docs/plans/2026-09-29-scale-and-accuracy.md, Part E and
 * section 11 "Contract"): the browser's ONE adapter between the server's gate
 * model and the screens.
 *
 * A gate is keyed by its stable slug id ("entry", "exit", "side-door"), never
 * by its direction: several gates can share a direction. The adapter reads
 * both server generations:
 *
 *  - new server: `config.gates[]` (GateConfig), watcher runtimes and events
 *    carrying `gateId`;
 *  - old server: only `entryGate`/`exitGate`, runtimes with `gate: ENTRY|EXIT`,
 *    events with only `type`. Those map to the legacy gates "entry"/"exit",
 *    exactly as the server's own migration does (gateIdForLegacyRow).
 *
 * The id rules mirror src/server/gates.ts (not imported: that module belongs
 * to the server bundle); tests/nGatesUi.test.ts pins the two together.
 *
 * Nothing here decides access or opens a door. Pure helpers only: no React,
 * no fetch, no browser globals.
 */
import type { CameraStreamsConfig, GateConfig, GateStreamConfig, ScanType } from "../types";

export type GateDirection = ScanType;

/** Stable gate id: lowercase slug, 2-32 chars, starts with a letter (server: GATE_ID_RE). */
export const GATE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const MAX_GATES = 16;
/** The gates every installation has; they can be disabled, never deleted. */
export const LEGACY_GATE_IDS = ["entry", "exit"] as const;
/** The single door of an existing installation. */
export const LEGACY_DOOR_ID = "main";

export const isGateId = (v: unknown): v is string => typeof v === "string" && GATE_ID_RE.test(v);
export const isLegacyGateId = (id: string): boolean => id === "entry" || id === "exit";

/** "ENTRY"/"EXIT" in any case, else null. */
export function directionOf(raw: unknown): GateDirection | null {
  const v = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return v === "ENTRY" ? "ENTRY" : v === "EXIT" ? "EXIT" : null;
}

/** Gate id an old server meant by a direction: ENTRY -> "entry", EXIT -> "exit". */
export function legacyGateIdOf(direction: unknown): string | null {
  const d = directionOf(direction);
  return d === "ENTRY" ? "entry" : d === "EXIT" ? "exit" : null;
}

/**
 * Any spelling a server may use for a gate: a slug id ("side-door"), or the
 * direction an older server sent ("ENTRY" -> "entry"). Null for anything else.
 */
export function gateIdFromAny(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (isGateId(t)) return t;
  return legacyGateIdOf(t);
}

/**
 * Gate id of a watcher runtime, a `gate_watch_state`/`gate_watch_result` SSE
 * payload or a pipeline-mode answer: `gateId` when the server sends one,
 * otherwise the direction of an older server (`gate: "EXIT"` -> "exit").
 */
export function runtimeGateId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (isGateId(r.gateId)) return r.gateId;
  return gateIdFromAny(r.gate);
}

/**
 * Gate id of an access event. Events written before gate ids existed carry
 * only the direction, and there were exactly two gates: ENTRY -> "entry",
 * EXIT -> "exit" (the server's gateIdForLegacyRow). History is never rewritten.
 */
export function eventGateId(log: { gateId?: unknown; type?: unknown; scanType?: unknown }): string {
  if (isGateId(log.gateId)) return log.gateId;
  return directionOf(log.type ?? log.scanType) === "EXIT" ? "exit" : "entry";
}

/** True when the server already speaks the N-gate model (sends `gates[]`). */
export function serverHasGates(config: Partial<CameraStreamsConfig> | null | undefined): boolean {
  return !!config && Array.isArray(config.gates) && config.gates.length > 0;
}

/**
 * The configured gates, in display order, for both server shapes. Invalid
 * entries (bad id, duplicate id, unknown direction) are skipped rather than
 * guessed. `gateType` is kept equal to the direction for older code paths.
 */
export function gatesOf(config: Partial<CameraStreamsConfig> | null | undefined): GateConfig[] {
  if (!config || typeof config !== "object") return [];
  const out: GateConfig[] = [];
  const seen = new Set<string>();
  const push = (raw: GateStreamConfig & Partial<GateConfig>, id: string, direction: GateDirection) => {
    if (seen.has(id) || out.length >= MAX_GATES) return;
    seen.add(id);
    out.push({ ...raw, id, direction, gateType: direction });
  };
  if (serverHasGates(config)) {
    for (const item of config.gates as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const g = item as GateConfig;
      const direction = directionOf(g.direction ?? g.gateType);
      if (!isGateId(g.id) || !direction) continue;
      push(g, g.id, direction);
    }
    return out;
  }
  if (config.entryGate && typeof config.entryGate === "object") push(config.entryGate, "entry", "ENTRY");
  if (config.exitGate && typeof config.exitGate === "object") push(config.exitGate, "exit", "EXIT");
  return out;
}

/** A gate is on unless the server says `enabled: false` (same rule as enabledGates). */
export function isGateEnabled(gate: { enabled?: unknown }): boolean {
  return gate.enabled !== false;
}

export function enabledGates(gates: readonly GateConfig[]): GateConfig[] {
  return gates.filter(isGateEnabled);
}

/** Badge text for a switched-off gate. */
export const GATE_OFF_BADGE = "Đang tắt";

/** "Cổng vào" / "Cổng ra" for the two legacy gates, null for any other id. */
export function legacyGateLabel(id: string): string | null {
  return id === "entry" ? "Cổng vào" : id === "exit" ? "Cổng ra" : null;
}

/** Display name of a gate: its label, else its name (contract), else a legacy label, else the id. */
export function gateDisplayLabel(gate: { id: string; label?: string; name?: string }): string {
  const label = typeof gate.label === "string" ? gate.label.trim() : "";
  if (label) return label;
  const name = typeof gate.name === "string" ? gate.name.trim() : "";
  if (name) return name;
  return legacyGateLabel(gate.id) ?? gate.id;
}

export function gateLabelMap(gates: readonly GateConfig[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const g of gates) map[g.id] = gateDisplayLabel(g);
  return map;
}

/** Label for a gate id that may no longer be configured (a removed gate keeps its history). */
export function labelForGateId(id: string, labels: Readonly<Record<string, string>>): string {
  return labels[id] ?? legacyGateLabel(id) ?? `Cổng ${id}`;
}

export function directionLabel(direction: GateDirection | null | undefined): string {
  return direction === "EXIT" ? "Ra" : direction === "ENTRY" ? "Vào" : "—";
}

/** Only gates added later can be removed; "entry" and "exit" can only be disabled. */
export function canDeleteGate(id: string): boolean {
  return isGateId(id) && !isLegacyGateId(id);
}

/** The door a gate's grants open, falling back to the legacy single door (server: doorIdOf). */
export function gateDoorId(gate: { doorId?: unknown }): string {
  return isGateId(gate.doorId) ? gate.doorId : LEGACY_DOOR_ID;
}

/** Order of the rows a screen shows: configured gates first, then any extra ids the server reported. */
export function orderedGateIds(gates: readonly GateConfig[], extraIds: Iterable<string> = []): string[] {
  const out: string[] = gates.map((g) => g.id);
  for (const id of extraIds) if (isGateId(id) && !out.includes(id)) out.push(id);
  if (out.length === 0) out.push(...LEGACY_GATE_IDS);
  return out;
}

/**
 * Replace one gate inside a config, for both shapes, keeping the legacy views
 * `entryGate`/`exitGate` in step with gates "entry"/"exit".
 */
export function updateGateInConfig(
  config: CameraStreamsConfig,
  gateId: string,
  updater: (gate: GateConfig) => GateConfig,
): CameraStreamsConfig {
  const current = gatesOf(config).find((g) => g.id === gateId);
  if (!current) return config;
  const next = updater(current);
  let out: CameraStreamsConfig = { ...config };
  if (serverHasGates(config)) {
    out.gates = (config.gates || []).map((g) => (g && g.id === gateId ? next : g));
  }
  if (gateId === "entry") out = { ...out, entryGate: { ...next, gateType: "ENTRY" } };
  if (gateId === "exit") out = { ...out, exitGate: { ...next, gateType: "EXIT" } };
  return out;
}

// ---------------------------------------------------------------------------
// Adding, editing and removing gates (admin): POST /api/gates,
// PUT/DELETE /api/gates/:gateId. The UI renders what the server answers.
// ---------------------------------------------------------------------------

export interface GateDraft {
  id: string;
  label: string;
  direction: GateDirection | "";
  doorId: string;
}

/** A suggested id for a new gate from its Vietnamese label: "Cổng phụ B" -> "cong-phu-b". */
export function suggestGateId(label: string): string {
  let s = String(label || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s && !/^[a-z]/.test(s)) s = `cong-${s}`;
  s = s.slice(0, 32).replace(/-+$/g, "");
  return s.length >= 2 ? s : "";
}

/** First problem with a new gate, in Vietnamese, or null when it can be sent. */
export function validateGateDraft(draft: GateDraft, existingIds: readonly string[]): string | null {
  const id = draft.id.trim();
  if (!isGateId(id)) {
    return "Mã cổng gồm 2-32 ký tự: chữ thường không dấu, số hoặc dấu gạch ngang, bắt đầu bằng chữ cái.";
  }
  if (existingIds.includes(id)) return `Đã có cổng mã "${id}". Mỗi cổng cần một mã riêng.`;
  if (existingIds.length >= MAX_GATES) return `Đã đủ ${MAX_GATES} cổng, không thêm được nữa.`;
  if (!draft.label.trim()) return "Nhập tên hiển thị của cổng.";
  if (draft.direction !== "ENTRY" && draft.direction !== "EXIT") return "Chọn hướng của cổng: Vào hoặc Ra.";
  if (draft.doorId && !isGateId(draft.doorId)) return "Mã cửa không hợp lệ.";
  return null;
}

type JsonRequest = { url: string; init: RequestInit };

const jsonRequest = (url: string, method: string, body?: unknown): JsonRequest => ({
  url,
  init: {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  },
});

export function buildCreateGateRequest(draft: GateDraft): JsonRequest {
  return jsonRequest("/api/gates", "POST", {
    id: draft.id.trim(),
    label: draft.label.trim(),
    direction: draft.direction,
    ...(draft.doorId ? { doorId: draft.doorId } : {}),
  });
}

export interface GatePatch {
  label?: string;
  direction?: GateDirection;
  doorId?: string;
  enabled?: boolean;
}

export function buildUpdateGateRequest(gateId: string, patch: GatePatch): JsonRequest {
  return jsonRequest(`/api/gates/${encodeURIComponent(gateId)}`, "PUT", patch);
}

/** Switch a gate on or off (admin): `PUT /api/gates/:gateId { enabled }` and nothing else. */
export function buildSetGateEnabledRequest(gateId: string, enabled: boolean): JsonRequest {
  return buildUpdateGateRequest(gateId, { enabled });
}

/**
 * The gate fields "Lưu Cấu Hình" sends: never `streams` (the per-stream routes
 * own them). On an N-gate server `enabled` is left out too: switching a gate
 * on or off is the admin's `PUT /api/gates/:gateId`, and a page loaded before
 * that switch must not undo it with its stale copy. An older server has no
 * such route, so it still gets `enabled` from the page's own toggle.
 */
export function gateScalarsForSave<G extends GateStreamConfig>(gate: G, multiGate: boolean): Partial<G> {
  const { streams: _streams, ...rest } = gate;
  if (!multiGate) return rest as Partial<G>;
  const { enabled: _enabled, ...withoutEnabled } = rest;
  return withoutEnabled as Partial<G>;
}

export function buildDeleteGateRequest(gateId: string): JsonRequest {
  return jsonRequest(`/api/gates/${encodeURIComponent(gateId)}`, "DELETE");
}

/** What the admin is told before a gate is removed. History stays; the gate stops. */
export function deleteGateConfirmText(label: string, gateId: string): { title: string; body: string; confirmLabel: string } {
  return {
    title: `Xóa ${label} (${gateId})?`,
    body:
      "Cổng sẽ ngừng quét, các luồng camera của cổng bị gỡ khỏi cấu hình và không thêm được sự kiện mới cho cổng này. " +
      "Lịch sử vào ra của cổng vẫn được giữ nguyên và vẫn lọc được trong Nhật ký. Mã cổng không dùng lại cho cổng khác.",
    confirmLabel: "Xóa cổng",
  };
}

/** What the admin is told before a gate is switched off. Switching it back on needs no confirmation. */
export function disableGateConfirmText(label: string, gateId: string): { title: string; body: string; confirmLabel: string } {
  return {
    title: `Tắt ${label} (${gateId})?`,
    body:
      "Khi tắt, cổng ngừng quét camera và cửa của cổng sẽ KHÔNG mở bằng nhận diện khuôn mặt cho đến khi bật lại. " +
      "Quét thủ công tại cổng này cũng bị từ chối. Cấu hình camera và lịch sử vào ra của cổng vẫn được giữ nguyên.",
    confirmLabel: "Tắt cổng",
  };
}

export type GateAction = "create" | "update" | "delete" | "enable" | "disable";

export type GateMutationOutcome =
  | { kind: "applied"; message: string; config: CameraStreamsConfig | null }
  | { kind: "refused"; status: number; message: string }
  | { kind: "unreachable"; message: string };

const ACTION_DONE: Record<GateAction, string> = {
  create: "đã thêm",
  update: "đã cập nhật",
  delete: "đã xóa",
  enable: "đã bật",
  disable: "đã tắt, cổng ngừng quét",
};
const ACTION_NOT_DONE: Record<GateAction, string> = {
  create: "CHƯA được thêm",
  update: "CHƯA đổi",
  delete: "CHƯA bị xóa",
  enable: "CHƯA được bật",
  disable: "CHƯA được tắt",
};

/**
 * One place that decides what a gate mutation's answer means. Only 2xx with
 * `success: true` is applied; 4xx/5xx are refusals with the server's message;
 * status 0 is a transport failure. Nothing is ever applied locally instead.
 */
export function interpretGateMutation(
  action: GateAction,
  label: string,
  res: { ok: boolean; status: number; data: unknown; error?: string },
): GateMutationOutcome {
  const data = res.data && typeof res.data === "object" ? (res.data as Record<string, unknown>) : {};
  const serverError = typeof data.error === "string" && data.error.trim() ? data.error.trim() : null;
  const notDone = `${label} ${ACTION_NOT_DONE[action]}.`;
  if (res.status === 0) return { kind: "unreachable", message: `Không kết nối được máy chủ. ${notDone}` };
  if (res.ok && data.success === true) {
    const config = data.config && typeof data.config === "object" ? (data.config as CameraStreamsConfig) : null;
    return { kind: "applied", message: `${label}: ${ACTION_DONE[action]}.`, config };
  }
  let message: string;
  switch (res.status) {
    case 401:
      message = "Cần đăng nhập để quản lý cổng.";
      break;
    case 403:
      message = serverError || "Tài khoản không có quyền quản lý cổng (cần Quản trị).";
      break;
    case 404:
      message = serverError || "Máy chủ chưa hỗ trợ quản lý nhiều cổng (HTTP 404).";
      break;
    case 409:
      message = serverError || "Máy chủ từ chối vì xung đột (mã cổng đã có hoặc cổng đang được dùng).";
      break;
    case 400:
      message = serverError || "Dữ liệu cổng không hợp lệ.";
      break;
    default:
      message = serverError || res.error || `Máy chủ từ chối yêu cầu (HTTP ${res.status}).`;
  }
  return { kind: "refused", status: res.status, message: `${message} ${notDone}` };
}
