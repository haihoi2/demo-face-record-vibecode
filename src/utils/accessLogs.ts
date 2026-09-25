/**
 * Access history ("Nhật ký vào ra") as the server serves it: filtered and
 * paged over the whole history, with totals and the hourly chart computed for
 * the same filters. Nothing here counts or filters rows locally.
 */
import { apiFetch, operatorJsonFetch } from "./api";
import type { AccessLog } from "../types";

export interface AccessLogFilters {
  q: string;
  status: "ALL" | "GRANTED" | "DENIED";
  type: "ALL" | "ENTRY" | "EXIT";
  /** yyyy-mm-dd in the viewer's local calendar, inclusive; "" = open. */
  fromDate: string;
  /** yyyy-mm-dd, inclusive (the whole day); "" = open. */
  toDate: string;
}

export const EMPTY_LOG_FILTERS: AccessLogFilters = { q: "", status: "ALL", type: "ALL", fromDate: "", toDate: "" };

export interface AccessLogHourBucket {
  hour: number;
  grantedEntries: number;
  deniedEntries: number;
  totalEntries: number;
  exits: number;
  totalScans: number;
}

export interface AccessLogStats {
  total: number;
  granted: number;
  denied: number;
  entries: number;
  exits: number;
  byHour: AccessLogHourBucket[];
  grantedEntriesByDepartment: Array<{ name: string; count: number }>;
  timeZone: string;
}

/** Local calendar day -> the instant it starts, as ISO. */
const startOfLocalDay = (yyyyMmDd: string) => new Date(`${yyyyMmDd}T00:00:00`).toISOString();
const startOfNextLocalDay = (yyyyMmDd: string) => {
  const d = new Date(`${yyyyMmDd}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
};

/** Query-string parameters for the filters; an extra lower bound narrows `from` (never widens it). */
export function logFilterParams(f: AccessLogFilters, extraFrom?: string): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.status !== "ALL") p.set("status", f.status);
  if (f.type !== "ALL") p.set("type", f.type);
  let from = f.fromDate ? startOfLocalDay(f.fromDate) : "";
  if (extraFrom && (!from || extraFrom > from)) from = extraFrom;
  if (from) p.set("from", from);
  if (f.toDate) p.set("to", startOfNextLocalDay(f.toDate));
  return p;
}

export async function fetchLogPage(
  f: AccessLogFilters,
  cursor: string | null,
  limit: number,
): Promise<{ logs: AccessLog[]; total: number; hasMore: boolean; nextCursor: string | null }> {
  const p = logFilterParams(f);
  p.set("paging", "cursor");
  p.set("limit", String(limit));
  if (cursor) p.set("cursor", cursor);
  const res = await operatorJsonFetch<any>(`/api/logs?${p}`);
  if (!res.ok || !res.data?.success) throw new Error(res.data?.error || res.error || `Không tải được nhật ký (HTTP ${res.status})`);
  return { logs: res.data.logs, total: res.data.total, hasMore: res.data.hasMore, nextCursor: res.data.nextCursor };
}

export async function fetchLogStats(f: AccessLogFilters, extraFrom?: string): Promise<AccessLogStats> {
  const res = await operatorJsonFetch<any>(`/api/logs/stats?${logFilterParams(f, extraFrom)}`);
  if (!res.ok || !res.data?.success) throw new Error(res.data?.error || res.error || `Không tải được thống kê (HTTP ${res.status})`);
  return res.data as AccessLogStats;
}

/** Download the whole filtered history as CSV (server-built; images and face data never included). */
export async function downloadLogCsv(f: AccessLogFilters): Promise<void> {
  const res = await apiFetch(`/api/logs/export.csv?${logFilterParams(f)}`, { method: "GET" });
  if (!res.ok) {
    let message = `Xuất CSV thất bại (HTTP ${res.status})`;
    try {
      message = (await res.json())?.error || message;
    } catch {}
    throw new Error(message);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] || "nhat_ky_vao_ra.csv";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
