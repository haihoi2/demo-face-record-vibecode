import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  grantDelaySeconds,
  isAmbiguousReason,
  isLocalWeekday,
  isNearThreshold,
  localDateKey,
  localDateRangeToUtc,
  localMinutesOfDay,
  normalizeLogIds,
  parseReasonCosine,
  quantile,
  renderReport,
  summarizePeriod,
  weekdayCount,
  type DecisionRow,
  type ResolutionRow,
} from "../scripts/report/weeklyReportHelpers";

const DENY_BEST = "Không khớp mẫu đã đăng ký (cosine tốt nhất 0.512) - Watcher tự động [Camera Cổng Vào]";
const DENY_AMBIG = "Từ chối: mơ hồ giữa nhiều danh tính (cosine 0.508) - Watcher tự động [Camera Cổng Vào]";

let seq = 0;
function row(partial: Partial<DecisionRow> & { timestamp: string }): DecisionRow {
  seq += 1;
  return {
    id: partial.id ?? `log-${seq}`,
    timestamp: partial.timestamp,
    capturedAt: partial.capturedAt === undefined ? partial.timestamp : partial.capturedAt,
    status: partial.status ?? "GRANTED",
    gateId: partial.gateId ?? "entry",
    reason: partial.reason ?? null,
  };
}

/** Local Asia/Ho_Chi_Minh wall clock -> ISO UTC. */
function local(date: string, hhmm: string, sec = 0): string {
  const ms = Date.parse(`${date}T${hhmm}:00Z`) - 7 * 3_600_000 + sec * 1000;
  return new Date(ms).toISOString();
}

describe("reason parsing", () => {
  it("reads the best cosine from both denial wordings", () => {
    assert.equal(parseReasonCosine(DENY_BEST), 0.512);
    assert.equal(parseReasonCosine(DENY_AMBIG), 0.508);
    assert.equal(parseReasonCosine("Không có khuôn mặt"), null);
    assert.equal(parseReasonCosine(null), null);
  });

  it("flags 'mơ hồ' and the 0.50–0.55 near-threshold band (upper bound exclusive)", () => {
    assert.equal(isAmbiguousReason(DENY_AMBIG), true);
    assert.equal(isAmbiguousReason(DENY_BEST), false);
    assert.equal(isNearThreshold(0.5), true);
    assert.equal(isNearThreshold(0.549), true);
    assert.equal(isNearThreshold(0.55), false);
    assert.equal(isNearThreshold(0.499), false);
    assert.equal(isNearThreshold(null), false);
  });
});

describe("local time helpers (UTC+7)", () => {
  it("maps UTC instants to the local calendar day and minute", () => {
    const t = Date.parse("2026-10-27T17:30:00Z"); // 00:30 on 28 Oct local
    assert.equal(localDateKey(t), "2026-10-28");
    assert.equal(localMinutesOfDay(t), 30);
  });

  it("knows weekdays in local time", () => {
    assert.equal(isLocalWeekday(Date.parse("2026-10-30T16:59:00Z")), true); // Fri 23:59 local
    assert.equal(isLocalWeekday(Date.parse("2026-10-30T17:00:00Z")), false); // Sat 00:00 local
  });

  it("turns inclusive local dates into a half-open UTC range", () => {
    const r = localDateRangeToUtc("2026-10-27", "2026-11-02");
    assert.equal(r.startIso, "2026-10-26T17:00:00.000Z");
    assert.equal(r.endIso, "2026-11-02T17:00:00.000Z");
    assert.equal(r.days, 7);
    assert.throws(() => localDateRangeToUtc("2026-11-02", "2026-10-27"));
    assert.throws(() => localDateRangeToUtc("27/10/2026", "2026-11-02"));
  });

  it("counts Mon–Fri dates in a period", () => {
    assert.equal(weekdayCount({ from: "2026-10-27", to: "2026-11-02" }), 5);
    assert.equal(weekdayCount({ from: "2026-10-13", to: "2026-10-26" }), 10);
  });
});

describe("grant delay and quantiles", () => {
  it("keeps delays inside 0..120s only", () => {
    assert.equal(grantDelaySeconds({ timestamp: "2026-10-27T01:00:05Z", capturedAt: "2026-10-27T01:00:00Z" }), 5);
    assert.equal(grantDelaySeconds({ timestamp: "2026-10-27T01:00:00Z", capturedAt: "2026-10-27T01:00:05Z" }), null);
    assert.equal(grantDelaySeconds({ timestamp: "2026-10-27T01:03:00Z", capturedAt: "2026-10-27T01:00:00Z" }), null);
    assert.equal(grantDelaySeconds({ timestamp: "2026-10-27T01:00:00Z", capturedAt: null }), null);
  });

  it("uses nearest-rank quantiles", () => {
    assert.equal(quantile([], 0.5), null);
    assert.equal(quantile([5, 1, 3], 0.5), 3);
    assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  });
});

describe("logIds normalisation", () => {
  it("accepts jsonb arrays, JSON text and CSV", () => {
    assert.deepEqual(normalizeLogIds(["a", "b"]), ["a", "b"]);
    assert.deepEqual(normalizeLogIds('["a","b"]'), ["a", "b"]);
    assert.deepEqual(normalizeLogIds("a, b"), ["a", "b"]);
    assert.deepEqual(normalizeLogIds(null), []);
    assert.deepEqual(normalizeLogIds("[not json"), []);
  });
});

describe("summarizePeriod", () => {
  const rows: DecisionRow[] = [
    // Tue 27 Oct, morning peak at the entry gate
    row({ id: "g1", timestamp: local("2026-10-27", "07:45", 4), capturedAt: local("2026-10-27", "07:45") }),
    row({ id: "g2", timestamp: local("2026-10-27", "07:50", 10), capturedAt: local("2026-10-27", "07:50") }),
    row({ id: "d1", timestamp: local("2026-10-27", "08:00"), status: "DENIED", reason: DENY_BEST }),
    row({ id: "d2", timestamp: local("2026-10-27", "08:10"), status: "DENIED", reason: DENY_AMBIG }),
    // Tue 27 Oct, outside any peak, entry
    row({ id: "d3", timestamp: local("2026-10-27", "10:00"), status: "DENIED", reason: "Không khớp mẫu đã đăng ký (cosine tốt nhất 0.410)" }),
    // Tue 27 Oct, exit at noon peak
    row({ id: "g3", timestamp: local("2026-10-27", "11:45", 2), capturedAt: local("2026-10-27", "11:45"), gateId: "exit" }),
    // Sat 31 Oct inside the morning window: weekend, must not count as a peak
    row({ id: "g4", timestamp: local("2026-10-31", "07:45", 60), capturedAt: local("2026-10-31", "07:45") }),
    // Outside the period
    row({ id: "x1", timestamp: local("2026-11-03", "07:45") }),
  ];
  const resolutions: ResolutionRow[] = [
    { action: "MERGE", resolvedAt: local("2026-10-28", "09:00"), logIds: ["d1", "zzz"] },
    { action: "DISMISS", resolvedAt: local("2026-10-28", "09:05"), logIds: '["d3"]' },
    { action: "MERGE", resolvedAt: local("2026-10-20", "09:00"), logIds: ["d2"] }, // before the period: not a merge of this week
  ];
  const s = summarizePeriod(rows, resolutions, "2026-10-27", "2026-11-02");

  it("aggregates per gate and ignores rows outside the period", () => {
    const entry = s.gates.find((g) => g.gate === "entry")!;
    const exit = s.gates.find((g) => g.gate === "exit")!;
    assert.equal(s.days, 7);
    assert.equal(entry.total.decisions, 6);
    assert.equal(entry.total.denied, 3);
    assert.equal(entry.total.ambiguous, 1);
    assert.equal(entry.total.nearThreshold, 2);
    assert.deepEqual([...entry.total.delays].sort((a, b) => a - b), [4, 10, 60]);
    assert.equal(exit.total.decisions, 1);
    assert.deepEqual(exit.total.delays, [2]);
  });

  it("counts peak windows on weekdays only, for the window's own gate", () => {
    const entry = s.gates.find((g) => g.gate === "entry")!;
    const morning = entry.peaks.find((p) => p.window.label.startsWith("07:30"))!;
    assert.equal(morning.bucket.decisions, 4);
    assert.equal(morning.bucket.denied, 2);
    assert.deepEqual(morning.bucket.delays.sort((a, b) => a - b), [4, 10]);
    const lunchIn = entry.peaks.find((p) => p.window.label.startsWith("12:30"))!;
    assert.equal(lunchIn.bucket.decisions, 0);
    const exit = s.gates.find((g) => g.gate === "exit")!;
    assert.equal(exit.peaks.find((p) => p.window.label.startsWith("11:30"))!.bucket.decisions, 1);
    assert.equal(exit.peaks.some((p) => p.window.gate !== "exit"), false);
  });

  it("builds the daily table per local date", () => {
    const entry = s.gates.find((g) => g.gate === "entry")!;
    assert.deepEqual([...entry.daily.keys()].sort(), ["2026-10-27", "2026-10-31"]);
    assert.equal(entry.daily.get("2026-10-27")!.decisions, 5);
  });

  it("links denied logs to stranger resolutions and counts merges inside the period", () => {
    assert.equal(s.deniedTotal, 3);
    assert.equal(s.deniedReviewed, 3); // d1 (jsonb), d2 (older merge still counts as reviewed), d3 (JSON text)
    assert.equal(s.merges, 1);
    assert.ok(Math.abs(s.mergesPerWeek - 1) < 1e-9);
  });

  it("renders Vietnamese Markdown with aggregates only (no ids)", () => {
    const cmp = summarizePeriod(rows, resolutions, "2026-10-13", "2026-10-26");
    const md = renderReport(s, cmp, { generatedAt: "2026-11-02T12:00:00.000Z" });
    assert.match(md, /^# Báo cáo độ chính xác nhận diện theo tuần/u);
    assert.match(md, /Kỳ so sánh: 2026-10-13 → 2026-10-26 \(14 ngày\)/u);
    assert.match(md, /## Cổng vào/u);
    assert.match(md, /#### 07:30–08:30 vào/u);
    assert.match(md, /\| 2026-10-27 \| T3 \| 5 \|/u);
    assert.match(md, /Lượt từ chối đã được xem lại trong Cụm Người Lạ \| 3 \/ 3 \(100\.0%\)/u);
    assert.match(md, /Lượt gộp \(MERGE\) \| 1 \(1\.0 \/ tuần\)/u);
    for (const id of ["g1", "d1", "d2", "d3", "zzz"]) assert.equal(md.includes(`| ${id}`), false);
    assert.equal(md.includes("log-"), false);
  });

  it("renders without a comparison period", () => {
    const md = renderReport(s, null);
    assert.equal(md.includes("Kỳ so sánh"), false);
    assert.match(md, /\| Chỉ số \| Kỳ này \|\n\|---\|---:\|/u);
  });
});
