/**
 * "Thống Kê Kiểm Soát Hôm Nay" (2026-10-11): today's counts come from the
 * server (GET /api/logs/stats), from 00:00 site time, not from the few events
 * loaded in the browser. Vietnam has no DST: site time is UTC+07:00.
 */
export const SITE_UTC_OFFSET = "+07:00";

/** ISO instant of today's 00:00 in site time. */
export function todayStartIso(now: Date = new Date()): string {
  const local = new Date(now.getTime() + 7 * 3600_000);
  const day = local.toISOString().slice(0, 10);
  return new Date(`${day}T00:00:00${SITE_UTC_OFFSET}`).toISOString();
}

export function todayStatsUrls(now: Date = new Date()): { granted: string; denied: string } {
  const from = encodeURIComponent(todayStartIso(now));
  return {
    granted: `/api/logs/stats?from=${from}&status=GRANTED`,
    denied: `/api/logs/stats?from=${from}&status=DENIED`,
  };
}

export interface TodayStats { entries: number; exits: number; denied: number }

export function readTodayStats(granted: unknown, denied: unknown): TodayStats | null {
  const g = granted as Record<string, unknown> | null;
  const d = denied as Record<string, unknown> | null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const entries = n(g?.entries), exits = n(g?.exits), deniedTotal = n(d?.total);
  if (entries === null || exits === null || deniedTotal === null) return null;
  return { entries, exits, denied: deniedTotal };
}

/** Access events carry their direction in `type` (older client code read a non-existent `scanType`). */
export function isEntryEvent(log: { type?: string | null }): boolean {
  return log.type === "ENTRY";
}

export function logBlurReportRequest(logId: string, report: boolean): { url: string; init: RequestInit } {
  return {
    url: `/api/logs/${encodeURIComponent(logId)}/blur-report`,
    init: { method: report ? "POST" : "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" },
  };
}
