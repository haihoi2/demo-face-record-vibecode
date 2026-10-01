/**
 * Gate on/off switch (owner request 2026-10-01): the helpers in
 * src/utils/gates.ts (request body, outcome text, confirmation text, what
 * "Lưu Cấu Hình" may send) and source checks that the camera page wires them
 * as agreed (admin-only switch, confirmation before off, "Đang tắt" badge).
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { GateConfig } from "../src/types";
import {
  GATE_OFF_BADGE,
  buildSetGateEnabledRequest,
  canDeleteGate,
  disableGateConfirmText,
  enabledGates,
  gateScalarsForSave,
  interpretGateMutation,
  isGateEnabled,
} from "../src/utils/gates";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// Gate on/off
// ---------------------------------------------------------------------------

describe("gate on/off helpers", () => {
  it("builds PUT /api/gates/:gateId with only { enabled }", () => {
    const off = buildSetGateEnabledRequest("side-door", false);
    assert.equal(off.url, "/api/gates/side-door");
    assert.equal(off.init.method, "PUT");
    assert.deepEqual(JSON.parse(String(off.init.body)), { enabled: false });
    const on = buildSetGateEnabledRequest("entry", true);
    assert.equal(on.url, "/api/gates/entry");
    assert.deepEqual(JSON.parse(String(on.init.body)), { enabled: true });
    assert.equal((on.init.headers as Record<string, string>)["Content-Type"], "application/json");
  });

  it("entry and exit can be switched off even though they cannot be deleted", () => {
    for (const id of ["entry", "exit"]) {
      assert.equal(canDeleteGate(id), false);
      assert.deepEqual(JSON.parse(String(buildSetGateEnabledRequest(id, false).init.body)), { enabled: false });
    }
  });

  it("a gate is on unless the server says enabled: false", () => {
    assert.equal(isGateEnabled({ enabled: true }), true);
    assert.equal(isGateEnabled({}), true);
    assert.equal(isGateEnabled({ enabled: false }), false);
    const gates = [
      { id: "entry", enabled: true },
      { id: "exit", enabled: false },
    ] as GateConfig[];
    assert.deepEqual(enabledGates(gates).map((g) => g.id), ["entry"]);
    assert.equal(GATE_OFF_BADGE, "Đang tắt");
  });

  it("the off confirmation says plainly that the gate stops scanning and its door will not open from recognition", () => {
    const t = disableGateConfirmText("Cổng phụ B", "cong-phu-b");
    assert.match(t.title, /Tắt Cổng phụ B \(cong-phu-b\)\?/);
    assert.match(t.body, /ngừng quét/);
    assert.match(t.body, /KHÔNG mở bằng nhận diện khuôn mặt/);
    assert.match(t.body, /cho đến khi bật lại/);
    assert.equal(t.confirmLabel, "Tắt cổng");
  });

  it("outcomes: applied only on 2xx success; server refusals verbatim; transport failure separate", () => {
    const applied = interpretGateMutation("disable", "Cổng vào", {
      ok: true,
      status: 200,
      data: { success: true, gate: {}, summary: {}, config: { gates: [] } },
    });
    assert.equal(applied.kind, "applied");
    assert.match(applied.message, /Cổng vào: đã tắt, cổng ngừng quét\./);

    const enabled = interpretGateMutation("enable", "Cổng ra", { ok: true, status: 200, data: { success: true } });
    assert.equal(enabled.kind, "applied");
    assert.equal(enabled.message, "Cổng ra: đã bật.");

    const bad = interpretGateMutation("disable", "Cổng vào", {
      ok: false,
      status: 400,
      data: { success: false, error: "enabled phải là true hoặc false" },
    });
    assert.equal(bad.kind, "refused");
    if (bad.kind === "refused") {
      assert.equal(bad.status, 400);
      assert.ok(bad.message.startsWith("enabled phải là true hoặc false"), "server text shown as-is");
      assert.match(bad.message, /Cổng vào CHƯA được tắt\./);
    }

    const forbidden = interpretGateMutation("enable", "Cổng ra", { ok: false, status: 403, data: { error: "Cần quyền admin" } });
    assert.equal(forbidden.kind, "refused");
    assert.match(forbidden.message, /^Cần quyền admin Cổng ra CHƯA được bật\.$/);

    const http500NoBody = interpretGateMutation("disable", "Cổng vào", { ok: false, status: 500, data: null, error: "boom" });
    assert.equal(http500NoBody.kind, "refused", "a 5xx is a refusal, never an offline success");

    const offline = interpretGateMutation("disable", "Cổng vào", { ok: false, status: 0, data: null, error: "Failed to fetch" });
    assert.equal(offline.kind, "unreachable");
    assert.match(offline.message, /Không kết nối được máy chủ\. Cổng vào CHƯA được tắt\./);

    // A 200 without success:true is not applied.
    assert.equal(interpretGateMutation("disable", "X", { ok: true, status: 200, data: {} }).kind, "refused");
  });

  it("Lưu Cấu Hình never sends streams, and on an N-gate server never sends enabled", () => {
    const gate = { id: "entry", name: "Cam", enabled: false, autoStart: true, streams: [{ id: "s1" }] } as unknown as GateConfig;
    const multi = gateScalarsForSave(gate, true) as Record<string, unknown>;
    assert.equal("streams" in multi, false);
    assert.equal("enabled" in multi, false, "the admin switch owns enabled");
    assert.equal(multi.name, "Cam");
    assert.equal(multi.autoStart, true);
    const legacy = gateScalarsForSave(gate, false) as Record<string, unknown>;
    assert.equal("streams" in legacy, false);
    assert.equal(legacy.enabled, false, "an older server still gets the page's own toggle");
  });
});

// ---------------------------------------------------------------------------
// Component wiring (source checks)
// ---------------------------------------------------------------------------

describe("gate switch wiring", () => {
  it("camera page: the switch is admin-only, confirms before off, and the tabs badge switched-off gates", () => {
    const src = read("src/components/CameraStreamConfigPage.tsx");
    const adminBlock = src.slice(src.indexOf("{/* Gate identity (admin)"), src.indexOf("{/* Gate Enable & Name */}"));
    assert.match(adminBlock, /^\{\/\* Gate identity \(admin\)[^\n]*\n\s*\{isAdmin && \(/);
    assert.match(adminBlock, /role="switch"/);
    assert.match(adminBlock, /aria-checked=\{isGateEnabled\(currentGateConfig\)\}/);
    assert.match(adminBlock, /onClick=\{\(\) => requestGateSwitch\(currentGateConfig\)\}/);
    assert.equal((src.match(/role="switch"/g) || []).length, 1, "no other gate switch outside the admin block");
    assert.match(src, /if \(isGateEnabled\(gate\)\) setDisableGateId\(gate\.id\);/, "turning off asks first");
    assert.match(src, /else void handleSetGateEnabled\(gate\.id, true\);/, "turning on is sent at once");
    assert.match(src, /disableGateConfirmText\(gateDisplayLabel\(target\), target\.id\)/);
    assert.match(src, /id="disable-gate-dialog"\s+role="alertdialog"/);
    assert.match(src, /buildSetGateEnabledRequest\(target\.id, enabled\)/);
    assert.match(src, /interpretGateMutation\(enabled \? "enable" : "disable"/);
    assert.match(src, /data-testid=\{`gate-off-badge-\$\{g\.id\}`\}/);
    assert.match(src, /gateScalarsForSave\(gate, multiGateServer\)/);
    // Operators and viewers see the state on an N-gate server, without a control.
    const stateStart = src.indexOf('data-testid="gate-enabled-state"');
    const legacyToggle = src.indexOf('<div className="flex items-center gap-4">', stateStart);
    assert.ok(stateStart > 0 && legacyToggle > stateStart);
    const stateBlock = src.slice(stateStart, legacyToggle);
    assert.match(stateBlock, /GATE_OFF_BADGE/);
    assert.doesNotMatch(stateBlock, /<button|onClick/);
    // The page's own toggle is left for an older server only.
    assert.match(src, /\{multiGate \? \(\s*\/\* N-gate server: on\/off is the admin switch above/);
  });
});
