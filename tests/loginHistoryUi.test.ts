/**
 * Sign-in history UI (owner 2026-10-02: "audit login history for user"): the
 * pure helpers in src/utils/loginEvents.ts (labels, user-agent label, request
 * URL, response parsing, paging merge across kind streams, 24 h summary) and
 * source checks that the Users page wires them as agreed.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LOGIN_EVENT_KINDS as SERVER_KINDS } from "../src/server/loginEvents";
import { TAB_MIN_ROLE } from "../src/components/Navbar";
import {
  LOGIN_EVENT_KINDS,
  LOGIN_FAILURE_KINDS,
  LOGIN_KIND_FILTER_OPTIONS,
  LoginEventRecord,
  LoginEventStream,
  appendLoginEventsPage,
  buildLoginEventsUrl,
  compareLoginEventsNewestFirst,
  formatLoginTime,
  loginEventsErrorText,
  loginKindLabel,
  loginKindTone,
  loginMethodLabel,
  loginReasonLabel,
  mergeLoginEventStreams,
  parseLoginEventsPage,
  parseLoginKindFilter,
  streamToAdvance,
  streamsForFilter,
  summarizeLoginFailures,
  userAgentLabel,
} from "../src/utils/loginEvents";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const ev = (id: string, at: string, kind: LoginEventRecord["kind"] = "sign-in", extra: Partial<LoginEventRecord> = {}): LoginEventRecord => ({
  id,
  at,
  kind,
  method: "account",
  ...extra,
});

describe("contract mirror", () => {
  it("lists exactly the server's kinds, in the same order", () => {
    assert.deepEqual([...LOGIN_EVENT_KINDS], [...SERVER_KINDS]);
  });

  it("every kind has a label and a tone", () => {
    for (const k of LOGIN_EVENT_KINDS) {
      assert.notEqual(loginKindLabel(k), k, k);
      assert.ok(loginKindTone(k), k);
    }
  });
});

describe("labels", () => {
  it("colours success green, failures red/amber, session events neutral", () => {
    assert.equal(loginKindTone("sign-in"), "success");
    assert.equal(loginKindTone("sign-in-failed"), "danger");
    assert.equal(loginKindTone("locked"), "warning");
    assert.equal(loginKindTone("rate-limited"), "warning");
    assert.equal(loginKindTone("sign-out"), "neutral");
    assert.equal(loginKindTone("password-changed"), "neutral");
    assert.equal(loginKindTone("something-new"), "neutral");
  });

  it("shows an unknown kind as-is rather than hiding it", () => {
    assert.equal(loginKindLabel("something-new"), "something-new");
  });

  it("translates every failure reason as the owner wrote them", () => {
    assert.equal(loginReasonLabel("bad-password"), "Sai mật khẩu");
    assert.equal(loginReasonLabel("unknown-user"), "Không có tài khoản");
    assert.equal(loginReasonLabel("bad-token"), "Sai mã khởi tạo");
    assert.equal(loginReasonLabel("disabled"), "Tài khoản đã khóa bởi quản trị");
    assert.equal(loginReasonLabel("account-locked"), "Tạm khóa do sai nhiều lần");
    assert.equal(loginReasonLabel(undefined), "");
    assert.equal(loginReasonLabel("new-reason"), "new-reason");
  });

  it("names the method", () => {
    assert.equal(loginMethodLabel("account"), "Tài khoản");
    assert.equal(loginMethodLabel("token"), "Mã khởi tạo");
    assert.equal(loginMethodLabel(undefined), "—");
  });

  it("formats the time as vi-VN date with seconds", () => {
    const text = formatLoginTime("2026-10-02T01:02:03.000Z", "Asia/Ho_Chi_Minh");
    assert.match(text, /08:02:03/);
    assert.match(text, /02\/10\/2026/);
    assert.equal(formatLoginTime("not-a-date"), "not-a-date");
  });
});

describe("userAgentLabel", () => {
  const cases: Array<[string | undefined, string]> = [
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36", "Chrome · Windows"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1", "Safari · iPhone"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", "Safari · macOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0", "Edge · Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", "Firefox · Linux"],
    ["Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36", "Samsung Internet · Android"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36", "Chrome · Android"],
    ["Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1", "Chrome · iPad"],
    ["curl/8.5.0", "curl"],
    ["python-requests/2.32.3", "Python"],
    ["Go-http-client/1.1", "Go"],
    [undefined, "—"],
    ["", "—"],
  ];
  for (const [ua, label] of cases) {
    it(`${label} <- ${String(ua).slice(0, 50)}`, () => assert.equal(userAgentLabel(ua), label));
  }

  it("keeps an unrecognised string short", () => {
    const label = userAgentLabel(`${"x".repeat(150)} <script>alert(1)</script>`);
    assert.ok(label.length <= 24, label);
  });

  it("strips control characters", () => {
    assert.equal(userAgentLabel("\u0000\u0007curl/8.0"), "curl");
  });
});

describe("request URL", () => {
  it("encodes the filters and the cursor", () => {
    const url = buildLoginEventsUrl({ userId: "U 1&x", kind: "sign-in-failed", before: "LE-abc", limit: 50 });
    assert.ok(url.startsWith("/api/users/login-events?"));
    const q = new URLSearchParams(url.split("?")[1]);
    assert.equal(q.get("userId"), "U 1&x");
    assert.equal(q.get("kind"), "sign-in-failed");
    assert.equal(q.get("before"), "LE-abc");
    assert.equal(q.get("limit"), "50");
  });

  it("omits empty filters and clamps limit to 1..200", () => {
    const q = (limit?: number) => new URLSearchParams(buildLoginEventsUrl({ limit }).split("?")[1]);
    assert.equal(q().get("limit"), "50");
    assert.equal(q(0).get("limit"), "1");
    assert.equal(q(9999).get("limit"), "200");
    assert.equal(q(Number.NaN).get("limit"), "50");
    assert.equal(q().has("userId"), false);
    assert.equal(q().has("kind"), false);
    assert.equal(q().has("before"), false);
  });
});

describe("response parsing", () => {
  it("refuses anything that is not a success page", () => {
    assert.equal(parseLoginEventsPage(null), null);
    assert.equal(parseLoginEventsPage({ success: false, error: "x" }), null);
    assert.equal(parseLoginEventsPage({ success: true }), null);
  });

  it("keeps well-formed rows and drops malformed ones", () => {
    const page = parseLoginEventsPage({
      success: true,
      hasMore: true,
      nextCursor: "LE-2",
      events: [ev("LE-1", "2026-10-02T01:00:00Z"), { id: 5 }, null, { id: "LE-x", at: "t" }, ev("LE-2", "2026-10-02T00:00:00Z", "sign-in-failed", { reason: "bad-password", ip: "1.2.3.4" })],
    });
    assert.ok(page);
    assert.deepEqual(page.events.map((e) => e.id), ["LE-1", "LE-2"]);
    assert.equal(page.events[1].reason, "bad-password");
    assert.equal(page.hasMore, true);
    assert.equal(page.nextCursor, "LE-2");
  });

  it("falls back to the last row's id as the cursor", () => {
    const page = parseLoginEventsPage({ success: true, hasMore: true, events: [ev("LE-9", "2026-10-02T00:00:00Z")] });
    assert.equal(page?.nextCursor, "LE-9");
    assert.equal(page?.hasMore, true);
  });

  it("an empty page cannot have more", () => {
    assert.equal(parseLoginEventsPage({ success: true, hasMore: true, events: [] })?.hasMore, false);
  });
});

describe("error text", () => {
  it("shows the server's text as-is", () => {
    assert.equal(loginEventsErrorText({ status: 403, data: { success: false, error: "Chỉ quản trị viên" } }), "Chỉ quản trị viên");
  });
  it("tells a network failure apart from a refusal", () => {
    assert.equal(loginEventsErrorText({ status: 0, data: undefined, error: "Failed to fetch" }), "Failed to fetch");
    assert.equal(loginEventsErrorText({ status: 0, data: undefined }), "Không kết nối được máy chủ");
    assert.match(loginEventsErrorText({ status: 500, data: undefined }), /HTTP 500/);
  });
});

describe("paging", () => {
  it("orders like the server: at DESC, then id DESC", () => {
    const rows = [ev("LE-a", "2026-10-02T00:00:00Z"), ev("LE-c", "2026-10-02T01:00:00Z"), ev("LE-b", "2026-10-02T00:00:00Z")];
    assert.deepEqual(rows.sort(compareLoginEventsNewestFirst).map((e) => e.id), ["LE-c", "LE-b", "LE-a"]);
  });

  it("appends a page without duplicating ids", () => {
    const s: LoginEventStream = { events: [ev("LE-3", "2026-10-02T03:00:00Z"), ev("LE-2", "2026-10-02T02:00:00Z")], hasMore: true, nextCursor: "LE-2" };
    const next = appendLoginEventsPage(s, { events: [ev("LE-2", "2026-10-02T02:00:00Z"), ev("LE-1", "2026-10-02T01:00:00Z")], hasMore: false });
    assert.deepEqual(next.events.map((e) => e.id), ["LE-3", "LE-2", "LE-1"]);
    assert.equal(next.hasMore, false);
  });

  it("stops when a page brings nothing new (no endless Tải thêm)", () => {
    const s: LoginEventStream = { events: [ev("LE-1", "2026-10-02T01:00:00Z")], hasMore: true, nextCursor: "LE-1" };
    const next = appendLoginEventsPage(s, { events: [ev("LE-1", "2026-10-02T01:00:00Z")], hasMore: true, nextCursor: "LE-1" });
    assert.equal(next.hasMore, false);
  });

  it("a single stream shows everything it has loaded", () => {
    const s: LoginEventStream = { events: [ev("LE-2", "2026-10-02T02:00:00Z"), ev("LE-1", "2026-10-02T01:00:00Z")], hasMore: true, nextCursor: "LE-1" };
    const m = mergeLoginEventStreams([s]);
    assert.deepEqual(m.visible.map((e) => e.id), ["LE-2", "LE-1"]);
    assert.equal(m.hasMore, true);
    assert.equal(mergeLoginEventStreams([{ ...s, hasMore: false }]).hasMore, false);
  });

  it("merges kind streams without gaps: rows older than an unfinished stream wait", () => {
    const failed: LoginEventStream = {
      kind: "sign-in-failed",
      events: [ev("LE-f3", "2026-10-02T10:00:00Z", "sign-in-failed"), ev("LE-f2", "2026-10-02T09:00:00Z", "sign-in-failed")],
      hasMore: true,
      nextCursor: "LE-f2",
    };
    const locked: LoginEventStream = {
      kind: "locked",
      events: [ev("LE-l1", "2026-10-02T09:30:00Z", "locked"), ev("LE-l0", "2026-10-02T05:00:00Z", "locked")],
      hasMore: false,
    };
    const limited: LoginEventStream = { kind: "rate-limited", events: [], hasMore: false };
    const streams = [failed, locked, limited];
    const m = mergeLoginEventStreams(streams);
    // LE-l0 (05:00) is held back: failed may still have rows between 09:00 and 05:00.
    assert.deepEqual(m.visible.map((e) => e.id), ["LE-f3", "LE-l1", "LE-f2"]);
    assert.equal(m.hasMore, true);
    assert.equal(streamToAdvance(streams), 0);

    const advanced = appendLoginEventsPage(failed, { events: [ev("LE-f1", "2026-10-02T06:00:00Z", "sign-in-failed")], hasMore: false });
    const all = mergeLoginEventStreams([advanced, locked, limited]);
    assert.deepEqual(all.visible.map((e) => e.id), ["LE-f3", "LE-l1", "LE-f2", "LE-f1", "LE-l0"]);
    assert.equal(all.hasMore, false);
  });

  it("advances the stream whose oldest loaded row is newest (it blocks the most)", () => {
    const a: LoginEventStream = { events: [ev("LE-a", "2026-10-02T08:00:00Z")], hasMore: true, nextCursor: "LE-a" };
    const b: LoginEventStream = { events: [ev("LE-b", "2026-10-02T09:00:00Z")], hasMore: true, nextCursor: "LE-b" };
    const c: LoginEventStream = { events: [ev("LE-c", "2026-10-02T10:00:00Z")], hasMore: false };
    assert.equal(streamToAdvance([a, b, c]), 1);
    assert.equal(streamToAdvance([c]), -1);
    assert.equal(streamToAdvance([c, { events: [], hasMore: true }]), 1);
  });

  it("builds one stream per server query for each filter", () => {
    assert.deepEqual(streamsForFilter("all").map((s) => s.kind), [undefined]);
    assert.deepEqual(streamsForFilter("failures").map((s) => s.kind), [...LOGIN_FAILURE_KINDS]);
    assert.deepEqual(streamsForFilter("sign-out").map((s) => s.kind), ["sign-out"]);
    assert.equal(parseLoginKindFilter("failures"), "failures");
    assert.equal(parseLoginKindFilter("locked"), "locked");
    assert.equal(parseLoginKindFilter("<bogus>"), "all");
    assert.deepEqual(LOGIN_KIND_FILTER_OPTIONS.slice(0, 2).map((o) => o.value), ["all", "failures"]);
  });
});

describe("24 h failure summary", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  const rows = [
    ev("LE-5", "2026-10-02T11:00:00Z", "sign-in-failed", { ip: "203.0.113.1" }),
    ev("LE-4", "2026-10-02T10:00:00Z", "rate-limited", { ip: "203.0.113.1" }),
    ev("LE-3", "2026-10-02T09:00:00Z", "sign-in", { ip: "10.0.0.5" }),
    ev("LE-2", "2026-10-02T08:00:00Z", "locked", { ip: "198.51.100.7" }),
    ev("LE-1", "2026-09-30T08:00:00Z", "sign-in-failed", { ip: "192.0.2.9" }),
  ];

  it("counts failures in the window and the distinct addresses among them", () => {
    const s = summarizeLoginFailures(rows, true, now);
    assert.equal(s.failures, 3);
    assert.equal(s.distinctIps, 2);
    assert.equal(s.complete, true, "loaded rows reach past 24 h");
    assert.equal(s.loadedRows, 5);
  });

  it("says when it only covers part of the window", () => {
    const s = summarizeLoginFailures(rows.slice(0, 3), true, now);
    assert.equal(s.failures, 2);
    assert.equal(s.complete, false);
    assert.equal(summarizeLoginFailures(rows.slice(0, 3), false, now).complete, true);
  });
});

describe("Users page wiring", () => {
  const page = read("src/components/UsersPage.tsx");
  const panel = read("src/components/LoginHistory.tsx");

  it("stays admin-only", () => {
    assert.equal(TAB_MIN_ROLE.users, "admin");
  });

  it("has a per-account action and a page-level tab", () => {
    assert.match(page, /title="Lịch sử đăng nhập"/);
    assert.match(page, /<LoginHistoryDrawer account=\{historyFor\}/);
    assert.match(page, /Toàn bộ lịch sử đăng nhập/);
    assert.match(page, /<LoginHistoryPanel id="login-history-all" showSummary \/>/);
    assert.match(page, /role="tablist"/);
  });

  it("the drawer filters by the account id", () => {
    assert.match(panel, /<LoginHistoryPanel id=\{`login-history-\$\{account\.id\}`\} userId=\{account\.id\} \/>/);
  });

  it("goes through operatorJsonFetch and never injects HTML", () => {
    assert.match(panel, /operatorJsonFetch/);
    assert.doesNotMatch(panel, /dangerouslySetInnerHTML|innerHTML/);
    assert.doesNotMatch(page, /dangerouslySetInnerHTML|innerHTML/);
  });

  it("is an accessible dialog with Escape, a focus trap and a live region", () => {
    assert.match(panel, /role="dialog"/);
    assert.match(panel, /aria-modal="true"/);
    assert.match(panel, /e\.key === "Escape"/);
    assert.match(panel, /role="status" aria-live="polite"/);
    assert.match(panel, /Tải thêm/);
  });
});
