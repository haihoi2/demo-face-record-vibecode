/**
 * "Cài đặt cổng" on the "Hiện diện" tab (P3b, docs/plans/2026-10-07-p3b-contract.md
 * section 3): the pure helpers in src/utils/presenceSettings.ts (parsing,
 * contract ranges, minutes <-> seconds, changed-fields-only PUT body, reset to
 * .env as null, access by role, labels) and source checks that the panel wires
 * them as agreed.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { OperatorRole, OperatorSessionInfo } from "../src/utils/api";
import {
  LIVE_CONFIRM_TEXT,
  PRESENCE_SETTINGS_URL,
  SETTINGS_MODE_OPTIONS,
  buildDraftBody,
  canResetField,
  draftFromView,
  formatSecondsText,
  formatWindowText,
  isDraftDirty,
  needsLiveConfirm,
  parseDecimal,
  parseHoursRange,
  parsePresenceGateSettings,
  parsePresenceSettings,
  presenceGateSettingsPath,
  presenceModeRequest,
  presenceResetRequest,
  presenceSettingsAccess,
  presenceSettingsRequest,
  readPresenceSettingsResult,
  resetDraftField,
  settingsErrorText,
  settingsModeLabel,
  sourceLabel,
  validateDraft,
  type PresenceGateSettingsView,
} from "../src/utils/presenceSettings";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const as = (role: OperatorRole): OperatorSessionInfo => ({
  actor: role,
  username: role,
  displayName: role,
  role,
  roleLabel: role,
  authMethod: "account",
  expiresAt: "2099-01-01T00:00:00.000Z",
});

const RAW = {
  gateId: "entry",
  label: "Cổng vào",
  mode: "shadow",
  workingHours: "07:00-19:00",
  minSecondsWorking: 3,
  minSecondsAfterHours: 1,
  alertWindowSeconds: 300,
  alertHoldSeconds: 15,
  source: { mode: "env", workingHours: "saved", minSecondsWorking: "env", alertWindowSeconds: "saved", bogus: "x" },
  updatedAt: "2026-10-07T02:00:00.000Z",
  updatedBy: "admin",
};
const gate = (over: Partial<PresenceGateSettingsView> = {}): PresenceGateSettingsView => ({ ...parsePresenceGateSettings(RAW)!, ...over });
const body = (init: RequestInit) => JSON.parse(String(init.body));

describe("settings parsing", () => {
  it("reads every gate with its source map", () => {
    const gates = parsePresenceSettings({ success: true, gates: [RAW, { ...RAW, gateId: "exit", needsStream: true }] })!;
    assert.equal(gates.length, 2);
    assert.equal(gates[0].label, "Cổng vào");
    assert.equal(gates[0].alertWindowSeconds, 300);
    assert.deepEqual(gates[0].source, { mode: "env", workingHours: "saved", minSecondsWorking: "env", alertWindowSeconds: "saved" });
    assert.equal(gates[0].needsStream, undefined);
    assert.equal(gates[1].needsStream, true);
  });

  it("drops malformed and repeated gates; null for a wrong shape", () => {
    const gates = parsePresenceSettings({ success: true, gates: [RAW, RAW, null, { label: "no id" }] })!;
    assert.deepEqual(gates.map((g) => g.gateId), ["entry"]);
    assert.equal(parsePresenceSettings({ success: false, gates: [] }), null);
    assert.equal(parsePresenceSettings({ success: true }), null);
    assert.equal(parsePresenceSettings("<html>"), null);
  });

  it("a non-number value becomes NaN (shown as an em dash), never a default", () => {
    const g = parsePresenceGateSettings({ ...RAW, minSecondsWorking: "3" })!;
    assert.ok(Number.isNaN(g.minSecondsWorking));
    assert.equal(formatSecondsText(g.minSecondsWorking), "—");
  });
});

describe("labels and access", () => {
  it("mode options and confirmation text are the agreed ones", () => {
    assert.deepEqual(SETTINGS_MODE_OPTIONS.map((o) => [o.value, o.label]), [
      ["off", "Tắt"],
      ["shadow", "Chạy thử"],
      ["live", "Đang báo"],
    ]);
    assert.equal(LIVE_CONFIRM_TEXT, "Tin nhắn sẽ được gửi tới nhóm bảo vệ ngoài giờ làm");
    assert.equal(settingsModeLabel("future"), "future");
  });

  it("asks for confirmation only when switching to live", () => {
    assert.equal(needsLiveConfirm("shadow", "live"), true);
    assert.equal(needsLiveConfirm("off", "live"), true);
    assert.equal(needsLiveConfirm("live", "live"), false);
    assert.equal(needsLiveConfirm("live", "shadow"), false);
    assert.equal(needsLiveConfirm("shadow", "off"), false);
  });

  it("admin edits, operator reads, viewer and signed out see nothing", () => {
    assert.equal(presenceSettingsAccess(as("admin")), "edit");
    assert.equal(presenceSettingsAccess(as("operator")), "read");
    assert.equal(presenceSettingsAccess(as("viewer")), "hidden");
    assert.equal(presenceSettingsAccess(null), "hidden");
  });

  it("reset is offered only for saved fields", () => {
    const g = gate();
    assert.equal(canResetField(g, "workingHours"), true);
    assert.equal(canResetField(g, "alertWindowSeconds"), true);
    assert.equal(canResetField(g, "mode"), false);
    assert.equal(canResetField(g, "alertHoldSeconds"), false, "no source reported -> env");
    assert.equal(sourceLabel("saved"), "Đã lưu");
    assert.equal(sourceLabel(undefined), "Theo .env");
  });

  it("formats seconds and the alert window", () => {
    assert.equal(formatSecondsText(1.5), "1,5 giây");
    assert.equal(formatWindowText(300), "5 phút");
    assert.equal(formatWindowText(90), "1,5 phút (90 giây)");
  });
});

describe("draft, validation and PUT body", () => {
  it("draft shows the window in minutes and splits working hours", () => {
    assert.deepEqual(draftFromView(gate()), {
      hoursStart: "07:00",
      hoursEnd: "19:00",
      minSecondsWorking: "3",
      minSecondsAfterHours: "1",
      alertWindowMinutes: "5",
      alertHoldSeconds: "15",
    });
  });

  it("working hours mirror the server rule", () => {
    assert.deepEqual(parseHoursRange("22:00-06:00"), { start: "22:00", end: "06:00" });
    assert.equal(parseHoursRange("07:00-07:00"), null);
    assert.equal(parseHoursRange("7:00-19:00"), null);
    assert.equal(parseHoursRange("24:00-06:00"), null);
  });

  it("ranges follow the contract", () => {
    const base = draftFromView(gate());
    const errs = (over: Partial<typeof base>) => validateDraft({ ...base, ...over }).errors;
    assert.deepEqual(errs({}), {});
    assert.ok(errs({ minSecondsWorking: "0.4" }).minSecondsWorking);
    assert.equal(errs({ minSecondsWorking: "0,5" }).minSecondsWorking, undefined, "vi-VN comma accepted");
    assert.equal(errs({ minSecondsWorking: "60" }).minSecondsWorking, undefined);
    assert.ok(errs({ minSecondsAfterHours: "61" }).minSecondsAfterHours);
    assert.ok(errs({ minSecondsAfterHours: "" }).minSecondsAfterHours);
    assert.ok(errs({ alertWindowMinutes: "0.4" }).alertWindowSeconds, "24 s < 30 s");
    assert.equal(errs({ alertWindowMinutes: "0.5" }).alertWindowSeconds, undefined);
    assert.equal(errs({ alertWindowMinutes: "60" }).alertWindowSeconds, undefined);
    assert.ok(errs({ alertWindowMinutes: "61" }).alertWindowSeconds);
    assert.equal(errs({ alertHoldSeconds: "0" }).alertHoldSeconds, undefined);
    assert.ok(errs({ alertHoldSeconds: "31" }).alertHoldSeconds);
    assert.ok(errs({ alertHoldSeconds: "-1" }).alertHoldSeconds);
    assert.ok(errs({ hoursEnd: "07:00" }).workingHours);
    assert.ok(errs({ hoursStart: "" }).workingHours);
    assert.ok(Number.isNaN(parseDecimal("1e3")));
    assert.ok(Number.isNaN(parseDecimal("abc")));
  });

  it("sends only the changed fields, minutes as whole seconds", () => {
    const view = gate();
    const unchanged = buildDraftBody(view, draftFromView(view));
    assert.deepEqual(unchanged, { ok: true, body: {}, changed: false });
    assert.equal(isDraftDirty(view, draftFromView(view)), false);
    const edited = buildDraftBody(view, { ...draftFromView(view), alertWindowMinutes: "2,5", hoursStart: "08:00", minSecondsAfterHours: "1" });
    assert.deepEqual(edited, { ok: true, body: { workingHours: "08:00-19:00", alertWindowSeconds: 150 }, changed: true });
    const bad = buildDraftBody(view, { ...draftFromView(view), alertHoldSeconds: "99" });
    assert.equal(bad.ok, false);
    assert.equal(isDraftDirty(view, { ...draftFromView(view), alertHoldSeconds: "99" }), true);
    // Same number typed differently is not a change.
    assert.equal(isDraftDirty(view, { ...draftFromView(view), minSecondsWorking: "3.0" }), false);
  });

  it("reset takes the server's value for that field only", () => {
    const view = gate();
    const typed = { ...draftFromView(view), minSecondsWorking: "9", hoursStart: "08:00" };
    const fresh = gate({ workingHours: "06:00-18:00" });
    assert.deepEqual(resetDraftField(typed, fresh, "workingHours"), { ...typed, hoursStart: "06:00", hoursEnd: "18:00" });
    assert.deepEqual(resetDraftField(typed, gate({ alertWindowSeconds: 600 }), "alertWindowSeconds"), { ...typed, alertWindowMinutes: "10" });
  });

  it("requests: PUT to the gate, mode, and null to reset to .env", () => {
    assert.equal(PRESENCE_SETTINGS_URL, "/api/presence/settings");
    assert.equal(presenceGateSettingsPath("kho b"), "/api/presence/settings/kho%20b");
    const m = presenceModeRequest("entry", "live");
    assert.equal(m.url, "/api/presence/settings/entry");
    assert.equal(m.init.method, "PUT");
    assert.deepEqual(body(m.init), { mode: "live" });
    assert.deepEqual(body(presenceResetRequest("entry", "alertHoldSeconds").init), { alertHoldSeconds: null });
    assert.deepEqual(body(presenceResetRequest("entry", "mode").init), { mode: null });
    assert.deepEqual(body(presenceSettingsRequest("entry", { workingHours: "08:00-17:00", extra: 1 } as any).init), { workingHours: "08:00-17:00" });
    assert.throws(() => presenceSettingsRequest("entry", { mode: "panic" as any }));
  });
});

describe("save result: the card changes only on a confirmed 2xx", () => {
  it("success carries the server's gate", () => {
    const out = readPresenceSettingsResult("entry", { ok: true, status: 200, data: { success: true, gate: { ...RAW, mode: "live" } } });
    assert.equal(out.ok, true);
    if (out.ok === true) assert.equal(out.gate.mode, "live");
  });

  it("a reply for another gate, a refusal or a transport failure is not a success", () => {
    assert.equal(readPresenceSettingsResult("exit", { ok: true, status: 200, data: { success: true, gate: RAW } }).ok, false);
    const refused = readPresenceSettingsResult("entry", {
      ok: false,
      status: 400,
      data: { success: false, error: "Giờ làm không hợp lệ.", field: "workingHours" },
    });
    assert.deepEqual(refused, { ok: false, status: 400, error: "Giờ làm không hợp lệ.", field: "workingHours" });
    const forbidden = readPresenceSettingsResult("entry", { ok: false, status: 403, data: { success: false, error: "Cần quyền quản trị." } });
    assert.equal(forbidden.ok, false);
    if (forbidden.ok === false) assert.equal(forbidden.error, "Cần quyền quản trị.");
    const offline = readPresenceSettingsResult("entry", { ok: false, status: 0, error: "Failed to fetch" });
    assert.deepEqual(offline, { ok: false, status: 0, error: "Failed to fetch" });
    assert.equal(settingsErrorText({ status: 404 }), "Không tải được cài đặt cổng (HTTP 404)");
  });
});

describe("presence settings wiring", () => {
  const src = read("src/components/PresencePanel.tsx");
  const block = src.slice(src.indexOf("function usePresenceSettings"), src.indexOf("export const PresencePanel"));

  it("is hidden for viewers, read-only for operators, editable for admins", () => {
    assert.match(block, /const access = presenceSettingsAccess\(session\);/);
    assert.match(block, /if \(access === "hidden"\) return null;/);
    assert.match(block, /const canEdit = access === "edit";/);
    assert.match(block, /\{canEdit \? \(/);
    assert.match(src, /<PresenceSettingsBlock reloadKey=\{settingsReloadKey\} onChanged=\{\(\) => void status\.reload\(\)\} \/>/);
  });

  it("switching to Đang báo goes through a confirmation dialog", () => {
    assert.match(block, /if \(needsLiveConfirm\(view\.mode, mode\)\) \{\s*setConfirm\(\{ kind: "live" \}\);\s*return;/);
    assert.match(block, /role="alertdialog"/);
    assert.match(block, /LIVE_CONFIRM_TEXT/);
  });

  it("saves through operatorJsonFetch and applies only the server's reply", () => {
    assert.doesNotMatch(block, /safeJsonFetch|fetch\(|apiFetch/);
    assert.match(block, /operatorJsonFetch<any>\(request\.url, request\.init\)/);
    assert.match(block, /if \(outcome\.ok === true\) \{[\s\S]{0,200}onSaved\(outcome\.gate/);
    assert.match(block, /RESET_TO_ENV_TEXT/);
    assert.match(block, /NEEDS_STREAM_TEXT/);
    assert.match(block, /aria-live="polite"/);
  });
});
