/**
 * Is the gateway writing where the site expects it to?
 *
 * With DATABASE_URL set, PostgreSQL is the system of record. If it cannot be
 * reached at startup the gateway keeps working on its local SQLite/JSON store
 * so the gates stay up - but every record written meanwhile exists only on
 * this host and has to be copied back later. That used to happen silently
 * (33 access logs were found only in SQLite on 2026-09-25), so the state is
 * tracked here and surfaced by /api/health and the dashboard banner.
 *
 * A PostgreSQL connection error after a successful start counts too: writes
 * are fire-and-forget, so an outage mid-run loses them just as quietly.
 */

export type StorageMode = "postgresql" | "sqlite" | "json";

export interface StorageStatus {
  /** What the site is configured to use. */
  expected: "postgresql" | "local";
  /** Where writes are going now; "connecting" while the startup retries run. */
  active: StorageMode | "connecting";
  /** Writes are not reaching the store the site expects. */
  degraded: boolean;
  /** When the current degraded spell began (ISO), else null. */
  since: string | null;
  /** Operator-facing explanation; never contains hosts, URLs or credentials. */
  reason: string | null;
}

export interface StorageTrackerState {
  postgresConfigured: boolean;
  /** Startup connection attempts still running. */
  connecting: boolean;
  postgresActive: boolean;
  sqliteActive: boolean;
  /** When startup gave up on PostgreSQL and fell back (ms), else null. */
  fellBackAt: number | null;
  /** Last PostgreSQL connection-level failure after startup (ms), else null. */
  lastConnectionErrorAt: number | null;
  /** First failure of the current outage (ms), else null. */
  outageStartedAt: number | null;
  /** Last query that reached PostgreSQL successfully (ms), else null. */
  lastOkAt: number | null;
}

export const INITIAL_STORAGE_STATE: StorageTrackerState = {
  postgresConfigured: false,
  connecting: false,
  postgresActive: false,
  sqliteActive: false,
  fellBackAt: null,
  lastConnectionErrorAt: null,
  outageStartedAt: null,
  lastOkAt: null,
};

function inOutage(s: StorageTrackerState): boolean {
  return s.lastConnectionErrorAt != null && (s.lastOkAt == null || s.lastConnectionErrorAt > s.lastOkAt);
}

/** A PostgreSQL query failed because the server could not be reached. */
export function recordConnectionError(s: StorageTrackerState, nowMs: number): StorageTrackerState {
  return { ...s, lastConnectionErrorAt: nowMs, outageStartedAt: inOutage(s) ? s.outageStartedAt : nowMs };
}

/** A PostgreSQL query succeeded; an outage, if any, is over. */
export function recordQueryOk(s: StorageTrackerState, nowMs: number): StorageTrackerState {
  return { ...s, lastOkAt: nowMs, outageStartedAt: null };
}

const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "EPIPE",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000", "08001", "08003", "08004", "08006", // connection_exception family
]);

/**
 * True when PostgreSQL could not be reached, as opposed to it answering with an
 * SQL error (constraint, type, syntax) - those mean the server is up.
 */
export function isConnectionError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e && typeof e.code === "string" && CONNECTION_ERROR_CODES.has(e.code)) return true;
  const message = String(e?.message ?? err ?? "");
  return /connection terminated|timeout exceeded when trying to connect|connection timeout|terminating connection|server closed the connection|connect ECONNREFUSED/i.test(
    message,
  );
}

export function storageStatus(s: StorageTrackerState): StorageStatus {
  const local: StorageMode = s.sqliteActive ? "sqlite" : "json";
  if (!s.postgresConfigured) {
    return { expected: "local", active: local, degraded: false, since: null, reason: null };
  }
  if (s.connecting) {
    return { expected: "postgresql", active: "connecting", degraded: false, since: null, reason: null };
  }
  if (!s.postgresActive) {
    return {
      expected: "postgresql",
      active: local,
      degraded: true,
      since: s.fellBackAt != null ? new Date(s.fellBackAt).toISOString() : null,
      reason:
        "Không kết nối được PostgreSQL khi khởi động; dữ liệu mới đang lưu tạm trên máy chủ cổng và cần chép lại vào PostgreSQL.",
    };
  }
  if (inOutage(s)) {
    return {
      expected: "postgresql",
      active: "postgresql",
      degraded: true,
      since: new Date(s.outageStartedAt ?? s.lastConnectionErrorAt!).toISOString(),
      reason: "Mất kết nối PostgreSQL; bản ghi mới có thể chưa được lưu vào PostgreSQL.",
    };
  }
  return { expected: "postgresql", active: "postgresql", degraded: false, since: null, reason: null };
}
