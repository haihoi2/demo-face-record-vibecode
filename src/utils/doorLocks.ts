/**
 * Lock state of every door, for the dashboard's lock panel (N-gate wave: each
 * gate opens its own door). Pure helpers only - no React, no fetch:
 *
 *  - read `GET /api/lock/states` (`{ success, doors: [...] }`, door "main" first);
 *  - fold the SSE events into that list: door "main" keeps `lock_state` /
 *    `lock_countdown` (older dashboards rely on them), every other door sends
 *    `door_lock_state` (the door's state with its `doorId`) and
 *    `door_lock_countdown` (`{ doorId, remainingSeconds }`);
 *  - the texts the panel shows.
 *
 * Every state here is the server's. Nothing opens a door or pretends one opened.
 */
import type { SmartLockState } from "../types";
import { LEGACY_DOOR_ID, MAX_DOORS, doorDisplayLabel, isDoorId, readLockState } from "./doors";

export const LOCK_STATES_URL = "/api/lock/states";
/** Poll period for `/api/lock/states`, used only while the event stream is down. */
export const DOOR_LOCK_POLL_MS = 5_000;
/** `source` of a manual command from the lock panel (server: string, at most 120 chars; it appends the actor). */
export const LOCK_PANEL_SOURCE = "Bảng Điều Khiển Khóa Thông Minh";

/** One door's lock as the panel holds it: the server state plus the door's id and display label. */
export interface DoorLockRow extends SmartLockState {
  doorId: string;
  label: string;
}

const nonNegative = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** A door's lock state from a server payload, or null when it is not one. `doorId` absent = door "main". */
function rowFrom(raw: unknown): (Omit<DoorLockRow, "label"> & { label: string | null }) | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const doorId = r.doorId === undefined || r.doorId === null ? LEGACY_DOOR_ID : isDoorId(r.doorId) ? r.doorId : null;
  if (!doorId) return null;
  const state = readLockState(r, doorId);
  if (!state) return null;
  return {
    ...state,
    doorId,
    remainingRelockSeconds: nonNegative(state.remainingRelockSeconds),
    autoRelockSeconds: nonNegative(state.autoRelockSeconds),
    lastActionAt: text(state.lastActionAt),
    lastActionBy: text(state.lastActionBy),
    label: text(r.label) || null,
  };
}

function withLabel(row: Omit<DoorLockRow, "label"> & { label: string | null }, previous?: string): DoorLockRow {
  const label = row.label || previous || text(row.doorName) || doorDisplayLabel({ id: row.doorId });
  return { ...row, label };
}

/** Door "main" first, the rest in the server's order. */
function mainFirst(rows: DoorLockRow[]): DoorLockRow[] {
  const i = rows.findIndex((r) => r.doorId === LEGACY_DOOR_ID);
  if (i <= 0) return rows;
  return [rows[i], ...rows.slice(0, i), ...rows.slice(i + 1)];
}

/**
 * The doors of a `GET /api/lock/states` answer. Malformed entries and repeated
 * door ids are skipped; null when the answer is not that shape at all.
 */
export function readLockStates(raw: unknown): DoorLockRow[] | null {
  if (!raw || typeof raw !== "object") return null;
  const doors = (raw as Record<string, unknown>).doors;
  if (!Array.isArray(doors)) return null;
  const out: DoorLockRow[] = [];
  const seen = new Set<string>();
  for (const item of doors) {
    if (out.length >= MAX_DOORS) break;
    const row = rowFrom(item);
    if (!row || seen.has(row.doorId)) continue;
    seen.add(row.doorId);
    out.push(withLabel(row));
  }
  return mainFirst(out);
}

export type LockStatesLoad =
  | { kind: "loaded"; rows: DoorLockRow[] }
  /** An older server without `/api/lock/states`: it has the single door "main" only. */
  | { kind: "unsupported" }
  | { kind: "refused"; status: number; message: string }
  | { kind: "unreachable"; message: string };

/** HTTP refusal, transport failure and an older server stay distinct; none of them invents a state. */
export function interpretLockStatesResponse(res: {
  ok: boolean;
  status: number;
  data: unknown;
  error?: string;
}): LockStatesLoad {
  if (res.status === 0) return { kind: "unreachable", message: "Không kết nối được máy chủ: trạng thái các cửa chưa cập nhật." };
  if (res.status === 404) return { kind: "unsupported" };
  const data = res.data && typeof res.data === "object" ? (res.data as Record<string, unknown>) : {};
  if (res.ok && data.success !== false) {
    const rows = readLockStates(res.data);
    if (rows) return { kind: "loaded", rows };
    return { kind: "refused", status: res.status, message: "Máy chủ trả về trạng thái cửa không đọc được." };
  }
  const serverError = text(data.error);
  const message =
    res.status === 401
      ? "Cần đăng nhập để xem trạng thái các cửa."
      : serverError || res.error || `Máy chủ từ chối (HTTP ${res.status}).`;
  return { kind: "refused", status: res.status, message: `${message} Trạng thái các cửa chưa cập nhật.` };
}

/**
 * Where an event came from. "main": the legacy `lock_state` / `lock_countdown`,
 * which can only ever be door "main" (no `doorId`, or `doorId: "main"`).
 * "door": `door_lock_state` / `door_lock_countdown` or a command answer, which
 * must name a valid door - a payload without one is dropped, never read as "main".
 */
export type DoorLockEventSource = "main" | "door";

export type DoorLockEvent =
  /** A fresh `/api/lock/states` list replaces everything. */
  | { type: "snapshot"; rows: DoorLockRow[] }
  /** A door's full lock state. */
  | { type: "state"; source: DoorLockEventSource; payload: unknown }
  /** `{ remainingSeconds }` (+ `doorId` for "door" events). */
  | { type: "countdown"; source: DoorLockEventSource; payload: unknown };

/** The door an event is about, or null when the payload does not fit its source. */
function eventDoorId(source: DoorLockEventSource, payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).doorId;
  if (source === "main") return raw === undefined || raw === null || raw === LEGACY_DOOR_ID ? LEGACY_DOOR_ID : null;
  return isDoorId(raw) ? raw : null;
}

/**
 * The door list after one event. A state for a door not in the list is added
 * (a door configured after the list was loaded) - but only once a list exists,
 * so events alone never turn the single-door panel into a list. Malformed
 * payloads and countdowns for unknown doors leave the list as it was (same
 * array, so React skips the render).
 */
export function reduceDoorLocks(rows: DoorLockRow[], event: DoorLockEvent): DoorLockRow[] {
  switch (event.type) {
    case "snapshot":
      return mainFirst(event.rows.slice(0, MAX_DOORS));
    case "state": {
      if (rows.length === 0) return rows;
      if (!eventDoorId(event.source, event.payload)) return rows;
      const row = rowFrom(event.payload);
      if (!row) return rows;
      const i = rows.findIndex((r) => r.doorId === row.doorId);
      if (i < 0) {
        if (rows.length >= MAX_DOORS) return rows;
        return mainFirst([...rows, withLabel(row)]);
      }
      const next = rows.slice();
      next[i] = { ...rows[i], ...withLabel(row, rows[i].label) };
      return next;
    }
    case "countdown": {
      const doorId = eventDoorId(event.source, event.payload);
      if (!doorId) return rows;
      const seconds = (event.payload as Record<string, unknown>).remainingSeconds;
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return rows;
      const i = rows.findIndex((r) => r.doorId === doorId);
      if (i < 0 || rows[i].remainingRelockSeconds === seconds) return rows;
      const next = rows.slice();
      next[i] = { ...rows[i], remainingRelockSeconds: seconds };
      return next;
    }
    default:
      return rows;
  }
}

/** The panel lists doors only when there is more than one; a single door keeps today's panel. */
export function showDoorList(rows: readonly DoorLockRow[]): boolean {
  return rows.length > 1;
}

/** Vietnamese state text of a door's lock. */
export function lockStateText(row: Pick<SmartLockState, "state" | "isLocked">): string {
  switch (row.state) {
    case "UNLOCKING":
      return "Đang mở khóa…";
    case "LOCKING":
      return "Đang khóa…";
    case "UNLOCKED":
      return "Đang mở";
    case "LOCKED":
      return "Đã khóa";
    default:
      return row.isLocked ? "Đã khóa" : "Đang mở";
  }
}

/** Width of the auto-relock bar, 0-100. */
export function relockPercent(row: Pick<SmartLockState, "remainingRelockSeconds" | "autoRelockSeconds">): number {
  const total = row.autoRelockSeconds;
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, (row.remainingRelockSeconds / total) * 100));
}
