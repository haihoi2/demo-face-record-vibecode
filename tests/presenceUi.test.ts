/**
 * "Hiện diện" tab (person presence, P2 SHADOW): the pure helpers in
 * src/utils/presence.ts (labels, badge logic, request URLs, response parsing,
 * label result, paging merge) and source checks that the panel is wired as
 * agreed (operator tab, protected crop, CSRF-aware label POST, plain text only).
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  FaceOutcome as ContractFaceOutcome,
  PresenceEventRecord,
  PresenceLabelKind as ContractLabelKind,
} from "../src/server/presence/contracts";
import { TAB_MIN_ROLE, canSeeTab } from "../src/components/Navbar";
import type { OperatorRole, OperatorSessionInfo } from "../src/utils/api";
import {
  DEFAULT_PRESENCE_FILTERS,
  LABEL_ACTIONS,
  PRESENCE_FACE_OUTCOMES,
  PRESENCE_LABEL_KINDS,
  PresenceEventView,
  PresenceEventsPage,
  PresenceFaceOutcome,
  PresenceLabelKind,
  SHADOW_NOTICE,
  allOff,
  anyShadow,
  appendPresencePage,
  buildPresenceEventsUrl,
  faceOutcomeLabel,
  formatAgo,
  formatInView,
  formatPeople,
  formatPresenceTime,
  labelKindLabel,
  noCropText,
  parsePresenceEvent,
  parsePresenceEventsPage,
  parsePresenceFilters,
  parsePresenceStatus,
  periodLabel,
  presenceCropPath,
  presenceErrorText,
  presenceGateOptions,
  presenceLabelRequest,
  presenceModeLabel,
  readPresenceLabelResult,
  replacePresenceEvent,
  showWouldAlert,
} from "../src/utils/presence";

// Compile-time mirror check: the browser types and the contract must stay assignable both ways.
const _recordToView: PresenceEventView = {} as PresenceEventRecord;
const _viewToRecord: PresenceEventRecord = {} as PresenceEventView;
const _labelToContract: ContractLabelKind = "real" as PresenceLabelKind;
const _labelFromContract: PresenceLabelKind = "real" as ContractLabelKind;
const _outcomeToContract: ContractFaceOutcome = "none" as PresenceFaceOutcome;
const _outcomeFromContract: PresenceFaceOutcome = "none" as ContractFaceOutcome;
void [_recordToView, _viewToRecord, _labelToContract, _labelFromContract, _outcomeToContract, _outcomeFromContract];

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const rawEvent = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  gateId: "entry",
  trackId: "P-1-1",
  startedAt: "2026-10-03T13:05:07.000Z",
  endedAt: "2026-10-03T13:05:12.000Z",
  inViewMs: 4200,
  framesSeen: 9,
  peakPersons: 2,
  period: "after-hours",
  faceOutcome: "none",
  wouldAlert: true,
  alertSentAt: null,
  bestBox: [10, 20, 110, 320],
  bestScore: 0.81,
  bestFrameAt: "2026-10-03T13:05:09.000Z",
  models: ["yolox-nano", "rtmdet-tiny"],
  hasCrop: true,
  createdAt: "2026-10-03T13:05:12.100Z",
  ...extra,
});

const view = (id: string, extra: Record<string, unknown> = {}): PresenceEventView => {
  const e = parsePresenceEvent(rawEvent(id, extra));
  assert.ok(e);
  return e;
};

const as = (role: OperatorRole): OperatorSessionInfo => ({
  actor: role, username: role, displayName: role, role, roleLabel: role, authMethod: "account", expiresAt: "",
});

describe("presence labels and badges", () => {
  it("uses the agreed Vietnamese copy", () => {
    assert.equal(periodLabel("working"), "Giờ làm");
    assert.equal(periodLabel("after-hours"), "Ngoài giờ");
    assert.equal(faceOutcomeLabel("employee"), "Nhân viên");
    assert.equal(faceOutcomeLabel("stranger"), "Người lạ");
    assert.equal(faceOutcomeLabel("none"), "Không thấy mặt");
    assert.equal(labelKindLabel(undefined), "Chưa gắn nhãn");
    assert.equal(labelKindLabel("false-alarm"), "Báo nhầm");
    assert.equal(SHADOW_NOTICE, "Chế độ chạy thử: chỉ ghi nhận, chưa gửi cảnh báo");
  });

  it("offers exactly the three contract label kinds, in order, with the agreed button text", () => {
    assert.deepEqual(LABEL_ACTIONS.map((a) => a.kind), ["real", "false-alarm", "employee"]);
    assert.deepEqual(LABEL_ACTIONS.map((a) => a.text), ["Đúng là người", "Báo nhầm", "Nhân viên"]);
    assert.deepEqual([...PRESENCE_LABEL_KINDS], ["real", "false-alarm", "employee"]);
    assert.deepEqual([...PRESENCE_FACE_OUTCOMES], ["employee", "stranger", "none"]);
  });

  it("shows unknown values from a newer server as-is instead of guessing", () => {
    assert.equal(periodLabel("weekend"), "weekend");
    assert.equal(faceOutcomeLabel("masked"), "masked");
    assert.equal(labelKindLabel("unsure"), "unsure");
  });

  it("shows 'Sẽ cảnh báo' only for a literal true", () => {
    assert.equal(showWouldAlert({ wouldAlert: true }), true);
    assert.equal(showWouldAlert({ wouldAlert: "true" }), false);
    assert.equal(showWouldAlert({ wouldAlert: 1 }), false);
    assert.equal(showWouldAlert({}), false);
    assert.equal(showWouldAlert(null), false);
  });

  it("describes only 'shadow' as shadow; an unknown mode is never called shadow", () => {
    assert.equal(presenceModeLabel("shadow"), "Chạy thử");
    assert.equal(presenceModeLabel("off"), "Đang tắt");
    assert.equal(presenceModeLabel("alert"), "alert");
    const g = (mode: string) => ({ gateId: "entry", mode, fps: null, lastFrameAgeMs: null, worker: { state: null, restarts: null, models: [] }, lastEventAt: null });
    assert.equal(anyShadow([g("off"), g("shadow")]), true);
    assert.equal(anyShadow([g("off"), g("alert")]), false);
    assert.equal(anyShadow([]), false);
    assert.equal(allOff([g("off"), g("off")]), true);
    assert.equal(allOff([g("off"), g("shadow")]), false);
    assert.equal(allOff([]), false);
  });
});

describe("presence formatting", () => {
  it("formats time in vi-VN to the second in the working-hours zone", () => {
    // 13:05:07Z = 20:05:07 in Asia/Ho_Chi_Minh (UTC+7).
    const s = formatPresenceTime("2026-10-03T13:05:07.000Z");
    assert.match(s, /20:05:07/);
    assert.match(s, /03\/10\/2026/);
    assert.equal(formatPresenceTime("not a date"), "not a date");
    assert.equal(formatPresenceTime(undefined), "—");
  });

  it("formats time in view and people count", () => {
    assert.equal(formatInView(2750), "2,8 giây");
    assert.equal(formatInView(1000), "1,0 giây");
    assert.equal(formatInView(45_000), "45 giây");
    assert.equal(formatInView(185_000), "3 phút 05 giây");
    assert.equal(formatInView(NaN), "—");
    assert.equal(formatInView(-1), "—");
    assert.equal(formatPeople(1), "1 người");
    assert.equal(formatPeople(NaN), "—");
  });

  it("formats 'ago' relative to a given now", () => {
    const now = Date.parse("2026-10-03T13:10:00.000Z");
    assert.equal(formatAgo("2026-10-03T13:09:48.000Z", now), "12 giây trước");
    assert.equal(formatAgo("2026-10-03T13:05:00.000Z", now), "5 phút trước");
    assert.equal(formatAgo("2026-10-03T10:00:00.000Z", now), "3 giờ trước");
    assert.equal(formatAgo(null, now), "Chưa có");
  });
});

describe("presence filters and URLs", () => {
  it("default filters ask for everything, newest page first", () => {
    assert.equal(buildPresenceEventsUrl(DEFAULT_PRESENCE_FILTERS), "/api/presence/events?limit=30");
  });

  it("sends every chosen filter and the cursor", () => {
    const url = buildPresenceEventsUrl({ gate: "entry", period: "after-hours", faceOutcome: "none", label: "false-alarm" }, "PE-abc");
    const q = new URL(url, "http://x").searchParams;
    assert.equal(new URL(url, "http://x").pathname, "/api/presence/events");
    assert.equal(q.get("gate"), "entry");
    assert.equal(q.get("period"), "after-hours");
    assert.equal(q.get("faceOutcome"), "none");
    assert.equal(q.get("label"), "false-alarm");
    assert.equal(q.get("before"), "PE-abc");
  });

  it("drops invalid filter values rather than sending them", () => {
    const url = buildPresenceEventsUrl({ gate: "../x?y=1", period: "night", faceOutcome: "ghost", label: "maybe" } as any);
    assert.equal(url, "/api/presence/events?limit=30");
    assert.deepEqual(parsePresenceFilters({ gate: "Entry", period: 1, faceOutcome: null, label: "real" }), {
      gate: "all",
      period: "all",
      faceOutcome: "all",
      label: "real",
    });
  });

  it("can ask for events without a label (server: label=none)", () => {
    assert.equal(buildPresenceEventsUrl({ ...DEFAULT_PRESENCE_FILTERS, label: "none" }), "/api/presence/events?label=none&limit=30");
    assert.equal(parsePresenceFilters({ label: "none" }).label, "none");
    assert.equal(parsePresenceFilters({ label: "None" }).label, "all");
  });

  it("clamps the page size", () => {
    assert.match(buildPresenceEventsUrl(DEFAULT_PRESENCE_FILTERS, undefined, 0), /limit=1$/);
    assert.match(buildPresenceEventsUrl(DEFAULT_PRESENCE_FILTERS, undefined, 5000), /limit=100$/);
    assert.match(buildPresenceEventsUrl(DEFAULT_PRESENCE_FILTERS, undefined, NaN), /limit=30$/);
  });

  it("encodes ids in the crop and label paths", () => {
    assert.equal(presenceCropPath("PE-1"), "/api/presence/events/PE-1/crop");
    assert.equal(presenceCropPath("a/../b"), "/api/presence/events/a%2F..%2Fb/crop");
  });

  it("builds a JSON POST with only { kind } and refuses an unknown kind", () => {
    const { url, init } = presenceLabelRequest("PE-1", "false-alarm");
    assert.equal(url, "/api/presence/events/PE-1/label");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), { kind: "false-alarm" });
    assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
    assert.throws(() => presenceLabelRequest("PE-1", "delete" as any));
  });
});

describe("presence response parsing", () => {
  it("keeps well-formed events and drops malformed rows", () => {
    const page = parsePresenceEventsPage({
      success: true,
      events: [rawEvent("PE-1", { label: "real" }), { id: 5 }, null, { id: "PE-x" }, rawEvent("PE-2", { label: "bogus" })],
      hasMore: true,
      nextCursor: "PE-2",
    });
    assert.ok(page);
    assert.deepEqual(page.events.map((e) => e.id), ["PE-1", "PE-2"]);
    assert.equal(page.events[0].label, "real");
    assert.equal(page.events[1].label, undefined);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextCursor, "PE-2");
  });

  it("does not page on without a cursor, and rejects non-success payloads", () => {
    const page = parsePresenceEventsPage({ success: true, events: [rawEvent("PE-1")], hasMore: true });
    assert.equal(page?.hasMore, false);
    assert.equal(parsePresenceEventsPage({ success: false, events: [] }), null);
    assert.equal(parsePresenceEventsPage({ success: true }), null);
    assert.equal(parsePresenceEventsPage("<html>"), null);
  });

  it("reads wouldAlert and hasCrop only as literal true", () => {
    const e = view("PE-1", { wouldAlert: "yes", hasCrop: 1 });
    assert.equal(e.wouldAlert, false);
    assert.equal(e.hasCrop, false);
  });

  it("parses the status gates and tolerates missing fields", () => {
    const gates = parsePresenceStatus({
      success: true,
      gates: [
        { gateId: "entry", mode: "shadow", fps: 2, lastFrameAgeMs: 350, worker: { state: "running", restarts: 1, models: ["yolox-nano", 7] }, lastEventAt: "2026-10-03T13:05:12.000Z" },
        { gateId: "exit" },
        { mode: "shadow" },
      ],
    });
    assert.ok(gates);
    assert.equal(gates.length, 2);
    assert.deepEqual(gates[0].worker, { state: "running", restarts: 1, models: ["yolox-nano"] });
    assert.deepEqual(gates[1], { gateId: "exit", mode: "", fps: null, lastFrameAgeMs: null, worker: { state: null, restarts: null, models: [] }, lastEventAt: null });
    assert.equal(parsePresenceStatus({ success: false, gates: [] }), null);
  });

  it("keeps the server's note, and a null worker (presence host not wired yet)", () => {
    const gates = parsePresenceStatus({
      success: true,
      gates: [{ gateId: "entry", mode: "shadow", fps: null, lastFrameAgeMs: null, worker: null, lastEventAt: null, note: "Cần luồng của engine thời gian thực" }],
    });
    assert.ok(gates);
    assert.equal(gates[0].note, "Cần luồng của engine thời gian thực");
    assert.deepEqual(gates[0].worker, { state: null, restarts: null, models: [] });
    assert.equal(anyShadow(gates), true);
  });

  it("says why there is no crop", () => {
    assert.equal(noCropText(view("PE-1", { hasCrop: false, cropPurgedAt: "2026-10-10T00:00:00.000Z" })), "Ảnh đã xóa sau 7 ngày");
    assert.equal(noCropText(view("PE-1", { hasCrop: false })), "Không có ảnh");
  });

  it("shows the server's error text as-is", () => {
    assert.equal(presenceErrorText({ status: 403, data: { error: "Cần quyền operator" } }), "Cần quyền operator");
    assert.equal(presenceErrorText({ status: 0, error: "Failed to fetch" }), "Failed to fetch");
    assert.equal(presenceErrorText({ status: 500 }), "Không tải được dữ liệu hiện diện (HTTP 500)");
  });
});

describe("label result: the row changes only on a confirmed 2xx", () => {
  it("accepts a 2xx success with the same event and uses the server's copy", () => {
    const out = readPresenceLabelResult("PE-1", "real", { ok: true, status: 200, data: { success: true, event: rawEvent("PE-1", { label: "real" }) } });
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.event.label, "real");
  });

  it("falls back to the requested kind when the server's event omits the label", () => {
    const out = readPresenceLabelResult("PE-1", "employee", { ok: true, status: 201, data: { success: true, event: rawEvent("PE-1") } });
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.event.label, "employee");
  });

  it("refuses a 2xx without success, or for another event", () => {
    assert.equal(readPresenceLabelResult("PE-1", "real", { ok: true, status: 200, data: { success: false } }).ok, false);
    assert.equal(readPresenceLabelResult("PE-1", "real", { ok: true, status: 200, data: { success: true } }).ok, false);
    const other = readPresenceLabelResult("PE-1", "real", { ok: true, status: 200, data: { success: true, event: rawEvent("PE-2") } });
    assert.deepEqual(other, { ok: false, status: 200, error: "Máy chủ trả lời không đúng sự kiện." });
  });

  it("keeps 4xx/5xx refusals with the server's text, and never turns a transport failure into success", () => {
    assert.deepEqual(readPresenceLabelResult("PE-1", "real", { ok: false, status: 403, data: { error: "Tài khoản xem không được gắn nhãn" } }), {
      ok: false,
      status: 403,
      error: "Tài khoản xem không được gắn nhãn",
    });
    assert.deepEqual(readPresenceLabelResult("PE-1", "real", { ok: false, status: 404, data: { success: true, event: rawEvent("PE-1"), error: "Không tìm thấy" } }), {
      ok: false,
      status: 404,
      error: "Không tìm thấy",
    });
    const offline = readPresenceLabelResult("PE-1", "real", { ok: false, status: 0, error: "Failed to fetch" });
    assert.deepEqual(offline, { ok: false, status: 0, error: "Failed to fetch" });
  });
});

describe("presence list state", () => {
  it("appends a page without duplicates and stops when a page brings nothing new", () => {
    const first: PresenceEventsPage = { events: [view("PE-3"), view("PE-2")], hasMore: true, nextCursor: "PE-2" };
    const next = appendPresencePage(first, { events: [view("PE-2"), view("PE-1")], hasMore: true, nextCursor: "PE-1" });
    assert.deepEqual(next.events.map((e) => e.id), ["PE-3", "PE-2", "PE-1"]);
    assert.equal(next.hasMore, true);
    assert.equal(next.nextCursor, "PE-1");
    const stuck = appendPresencePage(next, { events: [view("PE-1")], hasMore: true, nextCursor: "PE-1" });
    assert.equal(stuck.hasMore, false);
  });

  it("replaces one event by id and returns the same array for an unknown id", () => {
    const events = [view("PE-2"), view("PE-1")];
    const updated = replacePresenceEvent(events, view("PE-1", { label: "false-alarm" }));
    assert.notEqual(updated, events);
    assert.equal(updated[1].label, "false-alarm");
    assert.equal(updated[0], events[0]);
    assert.equal(replacePresenceEvent(events, view("PE-9")), events);
  });

  it("lists gate ids for the filter from status and events, valid ids only, no repeats", () => {
    const status = parsePresenceStatus({ success: true, gates: [{ gateId: "entry" }, { gateId: "BAD ID" }] }) ?? [];
    assert.deepEqual(presenceGateOptions(status, [view("PE-1", { gateId: "exit" }), view("PE-2")]), ["entry", "exit"]);
  });
});

describe("presence tab wiring", () => {
  it("is an operator tab: viewers and signed-out users do not see it", () => {
    assert.equal(TAB_MIN_ROLE.presence, "operator");
    assert.equal(canSeeTab(as("viewer"), "presence"), false);
    assert.equal(canSeeTab(null, "presence"), false);
    assert.equal(canSeeTab(as("operator"), "presence"), true);
    assert.equal(canSeeTab(as("admin"), "presence"), true);
  });

  it("has the menu entry with the agreed label and is rendered only behind canSeeTab", () => {
    const nav = read("src/components/Navbar.tsx");
    assert.match(nav, /\{ id: "presence", label: "Hiện diện",[^\n]*Icon: PersonStanding/);
    const app = read("src/App.tsx");
    assert.match(app, /activeTab === "presence" && canSeeTab\(operatorSession, "presence"\) && <PresencePanel \/>/);
  });

  it("panel loads the crop as a protected image and labels through operatorJsonFetch", () => {
    const src = read("src/components/PresencePanel.tsx");
    assert.match(src, /<ProtectedImage\s+src=\{presenceCropPath\(event\.id\)\}/);
    assert.match(src, /presenceLabelRequest\(event\.id, kind\)[\s\S]{0,80}operatorJsonFetch<any>\(url, init\)/);
    // The row is updated only from readPresenceLabelResult's confirmed outcome.
    assert.match(src, /if \(outcome\.ok === true\) \{\s*list\.applyEvent\(outcome\.event\)/);
  });

  it("panel renders server text as plain text, stores nothing and never touches doors", () => {
    const src = read("src/components/PresencePanel.tsx") + read("src/utils/presence.ts");
    assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/);
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB/);
    assert.doesNotMatch(src, /\/api\/lock|unlock|\/api\/doors?/i);
    assert.doesNotMatch(src, /<img\s[^>]*src=\{?["'`]?\/api\/presence/);
    assert.doesNotMatch(src, /new EventSource/);
  });
});
