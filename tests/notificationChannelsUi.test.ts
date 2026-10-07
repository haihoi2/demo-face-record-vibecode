/**
 * "Kênh thông báo" (P3b, docs/plans/2026-10-07-p3b-contract.md section 3): the
 * pure helpers in src/utils/notificationChannels.ts (parsing, validation,
 * request building, result reading, labels) and source checks that the
 * Webhook tab wires them as agreed (admin only, CSRF-aware fetch, masked URL
 * only, typed URL cleared after success, nothing stored or logged).
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BUILT_IN_CHANNEL_ID,
  BUILT_IN_NOTE,
  CHANNEL_USES,
  DEFAULT_ROUTES,
  USE_LABEL,
  buildCreateChannelRequest,
  buildDeleteChannelRequest,
  buildRoutesRequest,
  buildTestChannelRequest,
  buildToggleChannelRequest,
  buildUpdateChannelRequest,
  channelErrorText,
  channelOptionLabel,
  channelUseLabel,
  channelUses,
  isBuiltInChannel,
  maskedUrlText,
  parseChannel,
  parseChannelsResponse,
  parseRoutes,
  readChannelResult,
  readDeleteResult,
  readRoutesResult,
  readTestResult,
  routeOptions,
  validateChannelName,
  validateChannelUrl,
  type ChannelView,
} from "../src/utils/notificationChannels";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const builtIn = {
  id: "eton-default",
  name: "Eton (chung)",
  type: "eton-webhook",
  builtIn: true,
  enabled: true,
  urlMasked: "https://chat.example.vn/…/x7Qa",
  usedFor: ["stranger", "presence", "presenceHealth"],
};
const custom = {
  id: "CH-1111",
  name: "Bảo vệ ca đêm",
  type: "eton-webhook",
  builtIn: false,
  enabled: false,
  urlMasked: "https://hooks.example.vn/…/ab12",
  usedFor: [],
  updatedAt: "2026-10-07T01:00:00.000Z",
  updatedBy: "admin",
};
const LIST = { success: true, channels: [custom, builtIn], routes: { stranger: "eton-default", presence: "CH-1111", presenceHealth: "eton-default" } };

const view = (over: Partial<ChannelView> = {}): ChannelView => ({ ...parseChannel(custom)!, ...over });
const body = (init: RequestInit) => JSON.parse(String(init.body));

describe("channel list parsing", () => {
  it("reads channels and routes; built-in first", () => {
    const parsed = parseChannelsResponse(LIST)!;
    assert.deepEqual(parsed.channels.map((c) => c.id), ["eton-default", "CH-1111"]);
    assert.equal(parsed.channels[1].name, "Bảo vệ ca đêm");
    assert.equal(parsed.channels[1].enabled, false);
    assert.equal(parsed.channels[1].updatedBy, "admin");
    assert.deepEqual(parsed.routes, LIST.routes);
  });

  it("never keeps a url field, even if a reply carries one", () => {
    const c = parseChannel({ ...custom, url: "https://hooks.example.vn/secret-token" })!;
    assert.equal("url" in c, false);
    assert.doesNotMatch(JSON.stringify(c), /secret-token/);
  });

  it("drops malformed and repeated channels; null for a wrong shape", () => {
    const parsed = parseChannelsResponse({ success: true, channels: [custom, custom, null, "x", { name: "no id" }] })!;
    assert.deepEqual(parsed.channels.map((c) => c.id), ["CH-1111"]);
    assert.equal(parseChannelsResponse({ success: false, channels: [] }), null);
    assert.equal(parseChannelsResponse({ success: true }), null);
    assert.equal(parseChannelsResponse(null), null);
  });

  it("routes default to the built-in channel when missing or malformed", () => {
    assert.deepEqual(parseRoutes(undefined), DEFAULT_ROUTES);
    assert.deepEqual(parseRoutes({ stranger: "CH-1", presence: 5 }), { ...DEFAULT_ROUTES, stranger: "CH-1" });
    assert.deepEqual(parseChannelsResponse({ success: true, channels: [] })!.routes, DEFAULT_ROUTES);
  });

  it("keeps only known usedFor values; the eton-default id is always built-in", () => {
    const c = parseChannel({ ...custom, usedFor: ["presence", "bogus", "stranger"] })!;
    assert.deepEqual(c.usedFor, ["stranger", "presence"]);
    assert.equal(parseChannel({ ...builtIn, builtIn: false })!.builtIn, true);
    assert.equal(isBuiltInChannel(parseChannel(builtIn)!), true);
    assert.equal(isBuiltInChannel(view()), false);
  });
});

describe("labels and display", () => {
  it("has the agreed route labels and built-in note", () => {
    assert.deepEqual(CHANNEL_USES, ["stranger", "presence", "presenceHealth"]);
    assert.equal(USE_LABEL.stranger, "Người lạ");
    assert.equal(USE_LABEL.presence, "Có người ngoài giờ");
    assert.equal(USE_LABEL.presenceHealth, "Phát hiện người ngừng hoạt động");
    assert.equal(channelUseLabel("weird"), "weird");
    assert.equal(BUILT_IN_NOTE, "Eton (chung) - sửa URL ở phần Webhook phía trên");
    assert.equal(BUILT_IN_CHANNEL_ID, "eton-default");
  });

  it("shows only the masked URL", () => {
    assert.equal(maskedUrlText(view()), "https://hooks.example.vn/…/ab12");
    assert.equal(maskedUrlText(view({ urlMasked: "" })), "—");
  });

  it("chips follow the server's routes; usedFor only without routes", () => {
    const parsed = parseChannelsResponse(LIST)!;
    const [eton, night] = parsed.channels;
    assert.deepEqual(channelUses(eton, parsed.routes), ["stranger", "presenceHealth"]);
    assert.deepEqual(channelUses(night, parsed.routes), ["presence"]);
    assert.deepEqual(channelUses(eton, null), ["stranger", "presence", "presenceHealth"]);
  });

  it("route options mark disabled channels and keep an unknown routed id", () => {
    const parsed = parseChannelsResponse(LIST)!;
    assert.equal(channelOptionLabel(parsed.channels[1]), "Bảo vệ ca đêm (đang tắt)");
    const options = routeOptions(parsed.channels, "CH-gone");
    assert.deepEqual(options.map((o) => o.value), ["eton-default", "CH-1111", "CH-gone"]);
    assert.match(options[2].label, /không còn trong danh sách/);
    assert.equal(routeOptions(parsed.channels, "CH-1111").length, 2);
  });
});

describe("validation and requests", () => {
  it("name is 1-60 characters after trimming", () => {
    assert.ok(validateChannelName(""));
    assert.ok(validateChannelName("   "));
    assert.equal(validateChannelName("a"), undefined);
    assert.equal(validateChannelName("x".repeat(60)), undefined);
    assert.ok(validateChannelName("x".repeat(61)));
  });

  it("URL shape check only (the destination guard is the server's)", () => {
    assert.ok(validateChannelUrl(""));
    assert.ok(validateChannelUrl("not a url"));
    assert.ok(validateChannelUrl("ftp://example.vn/x"));
    assert.equal(validateChannelUrl("https://hooks.example.vn/abc"), undefined);
    // http is the server's decision (WEBHOOK_ALLOW_HTTP), not refused here.
    assert.equal(validateChannelUrl("http://hooks.example.vn/abc"), undefined);
  });

  it("create: POST with trimmed name/url and enabled; errors block the request", () => {
    const ok = buildCreateChannelRequest({ name: "  Ca đêm ", url: " https://hooks.example.vn/abc ", enabled: true });
    assert.equal(ok.ok, true);
    if (ok.ok !== true) return;
    assert.equal(ok.request.url, "/api/notification-channels");
    assert.equal(ok.request.init.method, "POST");
    assert.deepEqual(body(ok.request.init), { name: "Ca đêm", url: "https://hooks.example.vn/abc", enabled: true });
    const bad = buildCreateChannelRequest({ name: "", url: "nope", enabled: false });
    assert.equal(bad.ok, false);
    if (bad.ok === false) assert.deepEqual(Object.keys(bad.errors).sort(), ["name", "url"]);
  });

  it("update: PATCH with only changed fields; blank URL keeps the current one", () => {
    const current = view();
    const nothing = buildUpdateChannelRequest(current, { name: current.name, url: "", enabled: current.enabled });
    assert.deepEqual(nothing, { ok: true, request: null });
    const rename = buildUpdateChannelRequest(current, { name: "Mới", url: "  ", enabled: current.enabled });
    assert.equal(rename.ok, true);
    if (rename.ok === true && rename.request) {
      assert.equal(rename.request.url, "/api/notification-channels/CH-1111");
      assert.equal(rename.request.init.method, "PATCH");
      assert.deepEqual(body(rename.request.init), { name: "Mới" });
    }
    const all = buildUpdateChannelRequest(current, { name: "Mới", url: "https://h.example.vn/x", enabled: true });
    if (all.ok === true && all.request) assert.deepEqual(body(all.request.init), { name: "Mới", url: "https://h.example.vn/x", enabled: true });
    else assert.fail("expected a request");
    const badUrl = buildUpdateChannelRequest(current, { name: "Mới", url: "nope", enabled: false });
    assert.equal(badUrl.ok, false);
  });

  it("the built-in channel cannot be edited, toggled or deleted from here", () => {
    const eton = parseChannel(builtIn)!;
    const edit = buildUpdateChannelRequest(eton, { name: "x", url: "", enabled: false });
    assert.equal(edit.ok, false);
    if (edit.ok === false) assert.equal(edit.error, BUILT_IN_NOTE);
    assert.equal(buildToggleChannelRequest(eton, false), null);
    assert.equal(buildDeleteChannelRequest(eton), null);
  });

  it("toggle, delete, test and routes requests", () => {
    const t = buildToggleChannelRequest(view(), true)!;
    assert.equal(t.init.method, "PATCH");
    assert.deepEqual(body(t.init), { enabled: true });
    const d = buildDeleteChannelRequest(view({ id: "CH-a/b" }))!;
    assert.equal(d.init.method, "DELETE");
    assert.equal(d.url, "/api/notification-channels/CH-a%2Fb");
    const test = buildTestChannelRequest("eton-default");
    assert.equal(test.url, "/api/notification-channels/eton-default/test");
    assert.equal(test.init.method, "POST");
    assert.equal(buildRoutesRequest(DEFAULT_ROUTES, { ...DEFAULT_ROUTES }), null);
    const r = buildRoutesRequest(DEFAULT_ROUTES, { ...DEFAULT_ROUTES, presence: "CH-1111", stranger: "" })!;
    assert.equal(r.url, "/api/notification-routes");
    assert.equal(r.init.method, "PUT");
    assert.deepEqual(body(r.init), { presence: "CH-1111" });
  });
});

describe("results: success only on a confirmed 2xx", () => {
  const ok = (data: unknown, status = 200) => ({ ok: true, status, data });
  const refused = (status: number, data: unknown) => ({ ok: false, status, data, error: (data as any)?.error });

  it("create/update: channel from the reply; server text, field and code as-is on refusal", () => {
    const good = readChannelResult(ok({ success: true, channel: custom }));
    assert.equal(good.ok, true);
    const dest = readChannelResult(refused(400, { success: false, error: "Địa chỉ đích không được phép.", code: "DEST_PRIVATE", field: "url" }));
    assert.deepEqual(dest, { ok: false, status: 400, error: "Địa chỉ đích không được phép.", field: "url", code: "DEST_PRIVATE" });
    const malformed = readChannelResult(ok({ success: true, channel: { name: "no id" } }));
    assert.equal(malformed.ok, false);
    const notSuccess = readChannelResult(ok({ success: false, error: "Tối đa 20 kênh." }));
    assert.equal(notSuccess.ok, false);
    if (notSuccess.ok === false) assert.equal(notSuccess.error, "Tối đa 20 kênh.");
  });

  it("transport failure is never a success", () => {
    const res = { ok: false, status: 0, data: undefined, error: "Failed to fetch" };
    assert.equal(readChannelResult(res).ok, false);
    assert.equal(readDeleteResult(res).ok, false);
    assert.equal(readRoutesResult(res).ok, false);
    assert.equal(readTestResult(res).ok, false);
    assert.equal(channelErrorText(res), "Failed to fetch");
    assert.equal(channelErrorText({ status: 0 }), "Không kết nối được máy chủ");
    assert.equal(channelErrorText({ status: 502 }), "Yêu cầu thất bại (HTTP 502)");
  });

  it("delete: 409 CHANNEL_IN_USE shows the server's text", () => {
    const res = readDeleteResult(refused(409, { success: false, error: "Kênh đang được dùng.", code: "CHANNEL_IN_USE" }));
    assert.deepEqual(res, { ok: false, status: 409, error: "Kênh đang được dùng.", code: "CHANNEL_IN_USE" });
    assert.deepEqual(readDeleteResult(ok({ success: true })), { ok: true });
  });

  it("routes: the reply's routes are applied", () => {
    const res = readRoutesResult(ok({ success: true, routes: { stranger: "CH-1", presence: "eton-default", presenceHealth: "CH-1" } }));
    assert.deepEqual(res, { ok: true, routes: { stranger: "CH-1", presence: "eton-default", presenceHealth: "CH-1" } });
    const unknown = readRoutesResult(refused(400, { success: false, error: "Kênh không tồn tại.", code: "CHANNEL_UNKNOWN" }));
    assert.equal(unknown.ok, false);
  });

  it("test: 200 with success false is a failure with the chat server's reason", () => {
    assert.deepEqual(readTestResult(ok({ success: true, statusCode: 200 })), { ok: true, text: "Đã gửi tin thử (máy chủ chat trả HTTP 200)." });
    assert.deepEqual(readTestResult(ok({ success: false, statusCode: 403 })), { ok: false, text: "Gửi thử thất bại: máy chủ chat trả HTTP 403" });
    assert.deepEqual(readTestResult(ok({ success: false, error: "Hết thời gian chờ" })), { ok: false, text: "Gửi thử thất bại: Hết thời gian chờ" });
    assert.deepEqual(readTestResult(refused(404, { success: false, error: "Không tìm thấy kênh." })), {
      ok: false,
      text: "Gửi thử thất bại: Không tìm thấy kênh.",
    });
  });
});

describe("Webhook tab wiring", () => {
  const src = read("src/components/WebhookIntegration.tsx");
  const section = src.slice(src.indexOf("export const NotificationChannelsSection"));

  it("the channel section is rendered for admins only", () => {
    assert.match(src, /const isAdmin = hasRole\(session, "admin"\);/);
    assert.match(src, /\{isAdmin && <NotificationChannelsSection \/>\}/);
    assert.equal((src.match(/<NotificationChannelsSection/g) || []).length, 1);
  });

  it("talks to the server only through operatorJsonFetch (credentials, CSRF, sign-in)", () => {
    assert.ok(section.length > 1000);
    assert.doesNotMatch(section, /safeJsonFetch|fetch\(|apiFetch/);
    assert.match(section, /operatorJsonFetch<any>\(CHANNELS_URL\)/);
  });

  it("never shows, logs or stores a channel URL; the typed URL is cleared after success", () => {
    assert.doesNotMatch(section, /console\./);
    assert.doesNotMatch(section, /localStorage|sessionStorage|indexedDB|saveStored/);
    assert.doesNotMatch(section, /channel\.url\b|editing\.url\b|deleting\.url\b/);
    assert.doesNotMatch(section, /dangerouslySetInnerHTML|innerHTML/);
    assert.match(section, /maskedUrlText\(channel\)/);
    assert.match(section, /if \(outcome\.ok === true\) \{[\s\S]{0,300}setAddDraft\(EMPTY_DRAFT\)/);
    assert.match(section, /if \(outcome\.ok === true\) \{[\s\S]{0,200}setEditDraft\(EMPTY_DRAFT\)/);
    assert.match(section, /autoComplete="off"/);
  });

  it("built-in channel has no edit or delete and shows the agreed note", () => {
    assert.match(section, /\{builtIn && <p[^>]*>\{BUILT_IN_NOTE\}<\/p>\}/);
    assert.match(section, /\{!builtIn && \(\s*<>[\s\S]*?Sửa[\s\S]*?Xóa/);
  });

  it("has the agreed headings and an accessible delete confirmation", () => {
    assert.match(section, /Kênh thông báo/);
    assert.match(section, /Thêm kênh/);
    assert.match(section, /Gửi cảnh báo tới/);
    assert.match(section, /Gửi thử/);
    assert.match(section, /Dùng cho:/);
    assert.match(section, /id="channel-delete-dialog"\s+role="alertdialog"/);
    assert.match(section, /role="status" aria-live="polite"/);
  });
});
