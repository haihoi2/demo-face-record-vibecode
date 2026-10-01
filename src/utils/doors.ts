/**
 * Doors (N-gate wave, plan section 11; owner decision 4: each gate opens its
 * own door). Pure helpers for the door page:
 *
 *  - the door list from `GET /api/door-controller/config` (`doors[]` on a new
 *    server; an older server has one door, the top-level config, read as "main");
 *  - the save body for `POST /api/door-controller/config` (`doors[]` plus the
 *    top-level mirror of door "main" for older readers);
 *  - per-door lock state and lock commands
 *    (`GET /api/lock/state?doorId=`, `POST /api/lock/unlock|lock {doorId}`).
 *
 * Controller tokens never come back to the screen: whatever the server sends in
 * `apiToken` (masked or not) is dropped on read, and a token is sent only when
 * the admin typed a new one. The door command itself is always the server's.
 */
import type { DoorConfig, DoorControllerConfig, SmartLockState } from "../types";
import { GATE_ID_RE, LEGACY_DOOR_ID } from "./gates";

export { LEGACY_DOOR_ID };
/** Door ids follow the gate-id rule (server: DOOR_ID_RE = GATE_ID_RE). */
export const DOOR_ID_RE = GATE_ID_RE;
export const MAX_DOORS = 16;

export const isDoorId = (v: unknown): v is string => typeof v === "string" && DOOR_ID_RE.test(v);

/** A door as the page holds it: never with a token; `hasToken` says whether one is stored. */
export type DoorView = Omit<DoorConfig, "apiToken" | "doors"> & { apiToken: ""; hasToken: boolean };

export function doorDisplayLabel(door: { id: string; label?: string }): string {
  const label = typeof door.label === "string" ? door.label.trim() : "";
  if (label) return label;
  return door.id === LEGACY_DOOR_ID ? "Cửa chính" : door.id;
}

/** Whatever token field the server sent, as "is one stored?" only. */
function storedTokenFlag(raw: Record<string, unknown>): boolean {
  if (typeof raw.hasApiToken === "boolean") return raw.hasApiToken;
  if (typeof raw.apiTokenSet === "boolean") return raw.apiTokenSet;
  return typeof raw.apiToken === "string" && raw.apiToken.trim() !== "";
}

function toView(raw: Record<string, unknown>, id: string, label: string): DoorView {
  const { apiToken: _token, doors: _doors, hasApiToken: _h, apiTokenSet: _s, ...rest } = raw;
  return { ...(rest as unknown as DoorControllerConfig), id, label, apiToken: "", hasToken: storedTokenFlag(raw) };
}

/**
 * The doors of a door-controller config. `multiDoor` is true when the server
 * sends `doors[]` (it can store more than one door); an older server's single
 * top-level config is door "main".
 */
export function doorsOf(config: unknown): { doors: DoorView[]; multiDoor: boolean } {
  if (!config || typeof config !== "object") return { doors: [], multiDoor: false };
  const c = config as Record<string, unknown>;
  if (Array.isArray(c.doors) && c.doors.length > 0) {
    const doors: DoorView[] = [];
    const seen = new Set<string>();
    for (const item of c.doors) {
      if (!item || typeof item !== "object") continue;
      const d = item as Record<string, unknown>;
      if (!isDoorId(d.id) || seen.has(d.id) || doors.length >= MAX_DOORS) continue;
      seen.add(d.id);
      doors.push(toView(d, d.id, typeof d.label === "string" ? d.label : ""));
    }
    if (doors.length > 0) return { doors, multiDoor: true };
  }
  return { doors: [toView(c, LEGACY_DOOR_ID, "Cửa chính")], multiDoor: false };
}

/** A door-controller config with every token field removed (for anything that passes it on). */
export function withoutTokens(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object") return {};
  const { apiToken: _t, doors, ...rest } = config as Record<string, unknown>;
  return {
    ...rest,
    ...(Array.isArray(doors)
      ? {
          doors: doors.map((d) => {
            if (!d || typeof d !== "object") return d;
            const { apiToken: _dt, ...door } = d as Record<string, unknown>;
            return door;
          }),
        }
      : {}),
  };
}

export interface DoorDraft {
  id: string;
  label: string;
}

export function validateDoorDraft(draft: DoorDraft, existingIds: readonly string[]): string | null {
  const id = draft.id.trim();
  if (!isDoorId(id)) {
    return "Mã cửa gồm 2-32 ký tự: chữ thường không dấu, số hoặc dấu gạch ngang, bắt đầu bằng chữ cái.";
  }
  if (existingIds.includes(id)) return `Đã có cửa mã "${id}".`;
  if (existingIds.length >= MAX_DOORS) return `Đã đủ ${MAX_DOORS} cửa, không thêm được nữa.`;
  if (!draft.label.trim()) return "Nhập tên hiển thị của cửa.";
  return null;
}

/** A new door: the controller fields of `template`, switched off, no URL and no token. */
export function newDoorView(draft: DoorDraft, template: DoorControllerConfig): DoorView {
  const base = toView(template as unknown as Record<string, unknown>, draft.id.trim(), draft.label.trim());
  return { ...base, enabled: false, apiUrl: "", hasToken: false };
}

/** A door's fields for the request, with a token only when the admin typed one. */
function doorBody(door: DoorView, tokenDraft: string | undefined): Record<string, unknown> {
  const { hasToken: _has, apiToken: _empty, ...fields } = door;
  return { ...fields, ...(tokenDraft !== undefined ? { apiToken: tokenDraft.trim() } : {}) };
}

/**
 * Body for `POST /api/door-controller/config`. The top level mirrors door
 * "main" (what an older server and older readers use); `doors[]` is sent only
 * to a server that sent one. A door without `apiToken` keeps its stored token.
 */
export function buildDoorSavePayload(
  doors: readonly DoorView[],
  tokenDrafts: Readonly<Record<string, string | undefined>>,
  multiDoor: boolean,
): Record<string, unknown> {
  const main = doors.find((d) => d.id === LEGACY_DOOR_ID) ?? doors[0];
  const top = main ? doorBody(main, tokenDrafts[main.id]) : {};
  delete top.id;
  delete top.label;
  if (!multiDoor) return top;
  return { ...top, doors: doors.map((d) => doorBody(d, tokenDrafts[d.id])) };
}

/** `testConfig` for the door test: the edited fields, a token only when typed, and the door id. */
export function buildDoorTestConfig(door: DoorView, tokenDraft: string | undefined): Record<string, unknown> {
  const body = doorBody(door, tokenDraft);
  delete body.label;
  return body;
}

/** The value the cURL preview shows instead of any token. */
export const TOKEN_PLACEHOLDER = "<TOKEN>";

// ---------------------------------------------------------------------------
// Lock state and lock commands per door
// ---------------------------------------------------------------------------

export function buildLockStateUrl(doorId: string): string {
  return `/api/lock/state?doorId=${encodeURIComponent(doorId)}`;
}

/** Older servers have one lock, read here; only door "main" may use it. */
export const LEGACY_LOCK_STATUS_URL = "/api/lock/status";

export function buildLockCommandRequest(
  action: "unlock" | "lock",
  doorId: string,
  source: string,
): { url: string; init: RequestInit } {
  return {
    url: `/api/lock/${action}`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doorId, source }),
    },
  };
}

const LOCK_STATES = ["LOCKED", "UNLOCKED", "UNLOCKING", "LOCKING"] as const;

/** A lock state from either `{...SmartLockState}` or `{ success, lockState }`; null when it is neither. */
export function readLockState(raw: unknown, doorId: string): SmartLockState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const s = (r.lockState && typeof r.lockState === "object" ? r.lockState : r) as Record<string, unknown>;
  const state = typeof s.state === "string" && (LOCK_STATES as readonly string[]).includes(s.state) ? s.state : null;
  if (typeof s.isLocked !== "boolean" && !state) return null;
  const reportedDoor = isDoorId(s.doorId) ? s.doorId : LEGACY_DOOR_ID;
  if (reportedDoor !== doorId) return null;
  return {
    ...(s as unknown as SmartLockState),
    doorId: reportedDoor,
    state: (state ?? (s.isLocked ? "LOCKED" : "UNLOCKED")) as SmartLockState["state"],
    isLocked: typeof s.isLocked === "boolean" ? s.isLocked : state === "LOCKED",
  };
}

export type LockCommandOutcome =
  | { kind: "applied"; message: string; lockState: SmartLockState | null }
  | { kind: "refused"; status: number; message: string }
  | { kind: "unreachable"; message: string };

/** HTTP refusal and transport failure stay distinct; neither is ever shown as an opened door. */
export function interpretLockCommand(
  action: "unlock" | "lock",
  doorId: string,
  doorLabel: string,
  res: { ok: boolean; status: number; data: unknown; error?: string },
): LockCommandOutcome {
  const data = res.data && typeof res.data === "object" ? (res.data as Record<string, unknown>) : {};
  const verb = action === "unlock" ? "mở" : "khóa";
  if (res.status === 0) {
    return { kind: "unreachable", message: `Không kết nối được máy chủ: ${doorLabel} CHƯA được ${verb}.` };
  }
  if (res.ok && data.success === true) {
    const msg = typeof data.message === "string" && data.message.trim() ? data.message.trim() : `Đã gửi lệnh ${verb} cửa.`;
    return { kind: "applied", message: `${doorLabel}: ${msg}`, lockState: readLockState(data, doorId) };
  }
  const serverError = typeof data.error === "string" && data.error.trim() ? data.error.trim() : null;
  const message =
    res.status === 403
      ? serverError || "Lệnh mở/khóa cửa cần quyền Quản trị."
      : res.status === 401
        ? "Cần đăng nhập để điều khiển cửa."
        : serverError || res.error || `Máy chủ từ chối lệnh (HTTP ${res.status}).`;
  return { kind: "refused", status: res.status, message: `${message} ${doorLabel} CHƯA được ${verb}.` };
}
