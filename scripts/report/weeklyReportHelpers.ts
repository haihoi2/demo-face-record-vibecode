/**
 * Pure aggregation and Markdown formatting for the weekly accuracy report
 * (Taiga #505). No I/O here: `weekly-accuracy.ts` reads PostgreSQL and hands
 * the rows in, `tests/weeklyReport.test.ts` feeds synthetic rows.
 *
 * Time: `access_logs.timestamp` / `capturedAt` are ISO UTC strings. Local time is
 * Asia/Ho_Chi_Minh, a fixed UTC+7 with no daylight saving, so a constant offset
 * is used on purpose (no Intl dependency, deterministic in tests).
 */

export const LOCAL_OFFSET_MINUTES = 7 * 60;
const DAY_MS = 86_400_000;

/** One access decision as read from `access_logs` (only the columns the report needs). */
export interface DecisionRow {
  id: string;
  timestamp: string;
  capturedAt: string | null;
  status: string;
  gateId: string | null;
  reason: string | null;
}

/** One row of `stranger_resolutions` (only what the report needs). */
export interface ResolutionRow {
  action: string;
  resolvedAt: string | null;
  logIds: unknown;
}

/** Window boundaries are local wall-clock minutes since midnight; weekdays only. */
export interface PeakWindow {
  label: string;
  gate: string;
  startMin: number;
  endMin: number;
}

export const PEAK_WINDOWS: PeakWindow[] = [
  { label: "07:30–08:30 vào", gate: "entry", startMin: 7 * 60 + 30, endMin: 8 * 60 + 30 },
  { label: "11:30–12:20 ra", gate: "exit", startMin: 11 * 60 + 30, endMin: 12 * 60 + 20 },
  { label: "12:30–13:30 vào", gate: "entry", startMin: 12 * 60 + 30, endMin: 13 * 60 + 30 },
  { label: "16:45–17:45 ra", gate: "exit", startMin: 16 * 60 + 45, endMin: 17 * 60 + 45 },
];

export const NEAR_THRESHOLD_MIN = 0.5;
export const NEAR_THRESHOLD_MAX = 0.55; // exclusive
export const MAX_GRANT_DELAY_SECONDS = 120;

export const GATE_LABELS: Record<string, string> = { entry: "Cổng vào", exit: "Cổng ra" };

/** Best cosine quoted in a denial reason (`cosine tốt nhất 0.512` or `mơ hồ ... (cosine 0.508)`). */
export function parseReasonCosine(reason: string | null | undefined): number | null {
  if (!reason) return null;
  const m = /cosine(?:\s+tốt\s+nhất)?\s+(-?\d+(?:\.\d+)?)/iu.exec(reason);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

export function isAmbiguousReason(reason: string | null | undefined): boolean {
  return /mơ hồ/iu.test(reason || "");
}

export function isNearThreshold(cosine: number | null): boolean {
  return cosine !== null && cosine >= NEAR_THRESHOLD_MIN && cosine < NEAR_THRESHOLD_MAX;
}

/** ISO UTC string -> epoch ms, or null when unparseable. */
export function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Local calendar date (YYYY-MM-DD) of a UTC epoch. */
export function localDateKey(epochMs: number): string {
  return new Date(epochMs + LOCAL_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/** Local wall-clock minutes since midnight. */
export function localMinutesOfDay(epochMs: number): number {
  const d = new Date(epochMs + LOCAL_OFFSET_MINUTES * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Mon..Fri in local time. */
export function isLocalWeekday(epochMs: number): boolean {
  const dow = new Date(epochMs + LOCAL_OFFSET_MINUTES * 60_000).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/** Vietnamese weekday abbreviation for a local date key. */
export function weekdayLabel(dateKey: string): string {
  const dow = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return ["CN", "T2", "T3", "T4", "T5", "T6", "T7"][dow];
}

/** Local date key -> [startUtcIso, endUtcIsoExclusive) covering that whole local day range. */
export function localDateRangeToUtc(fromDate: string, toDate: string): { startIso: string; endIso: string; days: number } {
  assertDate(fromDate);
  assertDate(toDate);
  const start = Date.parse(`${fromDate}T00:00:00Z`) - LOCAL_OFFSET_MINUTES * 60_000;
  const end = Date.parse(`${toDate}T00:00:00Z`) + DAY_MS - LOCAL_OFFSET_MINUTES * 60_000;
  if (end <= start) throw new Error(`--to (${toDate}) must not be before --from (${fromDate})`);
  return { startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString(), days: Math.round((end - start) / DAY_MS) };
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`Expected a YYYY-MM-DD date, got "${value}"`);
  }
}

/** Grant delay = decision timestamp − capturedAt, in seconds, kept only within 0..MAX. */
export function grantDelaySeconds(row: Pick<DecisionRow, "timestamp" | "capturedAt">): number | null {
  const t = parseIso(row.timestamp);
  const c = parseIso(row.capturedAt);
  if (t === null || c === null) return null;
  const s = (t - c) / 1000;
  return s >= 0 && s <= MAX_GRANT_DELAY_SECONDS ? s : null;
}

/** Nearest-rank quantile over a non-empty list (returns null when empty). */
export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank];
}

export interface Bucket {
  decisions: number;
  granted: number;
  denied: number;
  ambiguous: number;
  nearThreshold: number;
  delays: number[];
}

export function emptyBucket(): Bucket {
  return { decisions: 0, granted: 0, denied: 0, ambiguous: 0, nearThreshold: 0, delays: [] };
}

export function addToBucket(b: Bucket, row: DecisionRow): void {
  b.decisions += 1;
  if (row.status === "GRANTED") {
    b.granted += 1;
    const d = grantDelaySeconds(row);
    if (d !== null) b.delays.push(d);
  } else if (row.status === "DENIED") {
    b.denied += 1;
    if (isAmbiguousReason(row.reason)) b.ambiguous += 1;
    if (isNearThreshold(parseReasonCosine(row.reason))) b.nearThreshold += 1;
  }
}

export interface GateSummary {
  gate: string;
  total: Bucket;
  peaks: { window: PeakWindow; bucket: Bucket }[];
  daily: Map<string, Bucket>;
}

export interface PeriodSummary {
  from: string;
  to: string;
  days: number;
  gates: GateSummary[];
  /** Denied decisions in the period whose log id appears in any stranger resolution. */
  deniedReviewed: number;
  deniedTotal: number;
  /** MERGE resolutions whose resolvedAt falls inside the period. */
  merges: number;
  mergesPerWeek: number;
}

/** Flatten `stranger_resolutions.logIds` (jsonb array, JSON text, or CSV) into a set of log ids. */
export function resolvedLogIdSet(resolutions: ResolutionRow[]): Set<string> {
  const ids = new Set<string>();
  for (const r of resolutions) for (const id of normalizeLogIds(r.logIds)) ids.add(id);
  return ids;
}

export function normalizeLogIds(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
      } catch {
        return [];
      }
    }
    return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export function summarizePeriod(
  rows: DecisionRow[],
  resolutions: ResolutionRow[],
  from: string,
  to: string,
  gateOrder: string[] = ["entry", "exit"],
): PeriodSummary {
  const range = localDateRangeToUtc(from, to);
  const startMs = Date.parse(range.startIso);
  const endMs = Date.parse(range.endIso);
  const byGate = new Map<string, GateSummary>();
  const gateFor = (gate: string): GateSummary => {
    let g = byGate.get(gate);
    if (!g) {
      g = { gate, total: emptyBucket(), peaks: PEAK_WINDOWS.filter((w) => w.gate === gate).map((w) => ({ window: w, bucket: emptyBucket() })), daily: new Map() };
      byGate.set(gate, g);
    }
    return g;
  };
  for (const gate of gateOrder) gateFor(gate);

  const resolved = resolvedLogIdSet(resolutions);
  let deniedReviewed = 0;
  let deniedTotal = 0;

  for (const row of rows) {
    const t = parseIso(row.timestamp);
    if (t === null || t < startMs || t >= endMs) continue;
    const g = gateFor(row.gateId || "unknown");
    addToBucket(g.total, row);
    const dayKey = localDateKey(t);
    let day = g.daily.get(dayKey);
    if (!day) {
      day = emptyBucket();
      g.daily.set(dayKey, day);
    }
    addToBucket(day, row);
    if (isLocalWeekday(t)) {
      const minute = localMinutesOfDay(t);
      for (const p of g.peaks) {
        if (minute >= p.window.startMin && minute < p.window.endMin) addToBucket(p.bucket, row);
      }
    }
    if (row.status === "DENIED") {
      deniedTotal += 1;
      if (resolved.has(row.id)) deniedReviewed += 1;
    }
  }

  let merges = 0;
  for (const r of resolutions) {
    if (r.action !== "MERGE") continue;
    const t = parseIso(r.resolvedAt);
    if (t !== null && t >= startMs && t < endMs) merges += 1;
  }

  const gates = [...gateOrder, ...[...byGate.keys()].filter((k) => !gateOrder.includes(k)).sort()].map((k) => byGate.get(k)!);
  return { from, to, days: range.days, gates, deniedReviewed, deniedTotal, merges, mergesPerWeek: (merges * 7) / range.days };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function pct(part: number, whole: number, digits = 1): string {
  if (whole <= 0) return "–";
  return `${((part / whole) * 100).toFixed(digits)}%`;
}

export function fmtNum(value: number | null, digits = 1): string {
  return value === null || !Number.isFinite(value) ? "–" : value.toFixed(digits);
}

export function fmtSeconds(value: number | null): string {
  return value === null ? "–" : `${value.toFixed(1)}s`;
}

function gateLabel(gate: string): string {
  return GATE_LABELS[gate] || gate;
}

function periodLabel(p: PeriodSummary): string {
  return `${p.from} → ${p.to} (${p.days} ngày)`;
}

/** Every metric row for a bucket, as [label, value]. Shared by summary and peak tables. */
export function bucketMetrics(b: Bucket, days: number): [string, string][] {
  return [
    ["Số lượt quyết định", String(b.decisions)],
    ["Lượt / ngày", fmtNum(days > 0 ? b.decisions / days : null)],
    ["Từ chối", `${b.denied} (${pct(b.denied, b.decisions)})`],
    ["Từ chối 'mơ hồ'", `${b.ambiguous} (${pct(b.ambiguous, b.decisions)} lượt; ${pct(b.ambiguous, b.denied)} số từ chối)`],
    ["Từ chối sát ngưỡng (cosine 0.50–0.55)", `${b.nearThreshold} (${pct(b.nearThreshold, b.decisions)} lượt; ${pct(b.nearThreshold, b.denied)} số từ chối)`],
    ["Độ trễ mở cửa – trung vị", fmtSeconds(quantile(b.delays, 0.5))],
    ["Độ trễ mở cửa – p90", fmtSeconds(quantile(b.delays, 0.9))],
  ];
}

function metricsTable(current: Bucket, currentDays: number, compare: Bucket | null, compareDays: number): string {
  const cur = bucketMetrics(current, currentDays);
  const cmp = compare ? bucketMetrics(compare, compareDays) : null;
  const lines = [cmp ? "| Chỉ số | Kỳ này | Kỳ so sánh |" : "| Chỉ số | Kỳ này |", cmp ? "|---|---:|---:|" : "|---|---:|"];
  cur.forEach(([label, value], i) => {
    lines.push(cmp ? `| ${label} | ${value} | ${cmp[i][1]} |` : `| ${label} | ${value} |`);
  });
  return lines.join("\n");
}

function dailyTable(g: GateSummary): string {
  const lines = ["| Ngày | Thứ | Lượt | Từ chối | Mơ hồ | Sát ngưỡng | Trễ trung vị | Trễ p90 |", "|---|---|---:|---:|---:|---:|---:|---:|"];
  for (const key of [...g.daily.keys()].sort()) {
    const b = g.daily.get(key)!;
    lines.push(
      `| ${key} | ${weekdayLabel(key)} | ${b.decisions} | ${b.denied} (${pct(b.denied, b.decisions)}) | ${b.ambiguous} | ${b.nearThreshold} | ${fmtSeconds(quantile(b.delays, 0.5))} | ${fmtSeconds(quantile(b.delays, 0.9))} |`,
    );
  }
  if (lines.length === 2) lines.push("| – | – | 0 | – | – | – | – | – |");
  return lines.join("\n");
}

export interface RenderOptions {
  generatedAt?: string;
  title?: string;
}

/** Markdown report (Vietnamese). Contains aggregates only: no log ids, no names. */
export function renderReport(current: PeriodSummary, compare: PeriodSummary | null, opts: RenderOptions = {}): string {
  const out: string[] = [];
  out.push(`# ${opts.title || "Báo cáo độ chính xác nhận diện theo tuần"}`);
  out.push("");
  out.push(`- Kỳ báo cáo: ${periodLabel(current)}`);
  if (compare) out.push(`- Kỳ so sánh: ${periodLabel(compare)}`);
  out.push("- Giờ địa phương: Asia/Ho_Chi_Minh (UTC+7). Khung giờ cao điểm chỉ tính ngày làm việc (T2–T6).");
  out.push(`- Độ trễ mở cửa = thời điểm quyết định − thời điểm chụp, chỉ tính 0–${MAX_GRANT_DELAY_SECONDS}s của lượt GRANTED.`);
  if (opts.generatedAt) out.push(`- Tạo lúc: ${opts.generatedAt}`);
  out.push("");

  const totalCur = sumBuckets(current.gates.map((g) => g.total));
  out.push("## Tổng quan");
  out.push("");
  out.push(metricsTable(totalCur, current.days, compare ? sumBuckets(compare.gates.map((g) => g.total)) : null, compare?.days ?? 0));
  out.push("");
  out.push("### Cụm Người Lạ");
  out.push("");
  out.push(compare ? "| Chỉ số | Kỳ này | Kỳ so sánh |" : "| Chỉ số | Kỳ này |");
  out.push(compare ? "|---|---:|---:|" : "|---|---:|");
  const reviewedCell = (p: PeriodSummary) => `${p.deniedReviewed} / ${p.deniedTotal} (${pct(p.deniedReviewed, p.deniedTotal)})`;
  const mergeCell = (p: PeriodSummary) => `${p.merges} (${fmtNum(p.mergesPerWeek)} / tuần)`;
  out.push(`| Lượt từ chối đã được xem lại trong Cụm Người Lạ | ${reviewedCell(current)} |${compare ? ` ${reviewedCell(compare)} |` : ""}`);
  out.push(`| Lượt gộp (MERGE) | ${mergeCell(current)} |${compare ? ` ${mergeCell(compare)} |` : ""}`);
  out.push("");

  for (const g of current.gates) {
    const cg = compare?.gates.find((x) => x.gate === g.gate) ?? null;
    out.push(`## ${gateLabel(g.gate)}`);
    out.push("");
    out.push(metricsTable(g.total, current.days, cg ? cg.total : null, compare?.days ?? 0));
    out.push("");
    if (g.peaks.length > 0) {
      out.push(`### Khung giờ cao điểm – ${gateLabel(g.gate)}`);
      out.push("");
      for (const p of g.peaks) {
        const cp = cg?.peaks.find((x) => x.window.label === p.window.label) ?? null;
        out.push(`#### ${p.window.label}`);
        out.push("");
        out.push(metricsTable(p.bucket, weekdayCount(current), cp ? cp.bucket : null, compare ? weekdayCount(compare) : 0));
        out.push("");
      }
    }
    out.push(`### Theo ngày – ${gateLabel(g.gate)}`);
    out.push("");
    out.push(dailyTable(g));
    out.push("");
  }
  return out.join("\n");
}

export function sumBuckets(buckets: Bucket[]): Bucket {
  const acc = emptyBucket();
  for (const b of buckets) {
    acc.decisions += b.decisions;
    acc.granted += b.granted;
    acc.denied += b.denied;
    acc.ambiguous += b.ambiguous;
    acc.nearThreshold += b.nearThreshold;
    acc.delays.push(...b.delays);
  }
  return acc;
}

/** Number of Mon..Fri local dates in the period (the denominator for peak "per day"). */
export function weekdayCount(p: Pick<PeriodSummary, "from" | "to">): number {
  const start = Date.parse(`${p.from}T00:00:00Z`);
  const end = Date.parse(`${p.to}T00:00:00Z`);
  let n = 0;
  for (let t = start; t <= end; t += DAY_MS) {
    const dow = new Date(t).getUTCDay();
    if (dow >= 1 && dow <= 5) n += 1;
  }
  return n;
}
