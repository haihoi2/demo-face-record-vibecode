/** #580: the engine card's message switch, its auth rule, and the server wiring. */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { requiredRoleFor } from "../src/server/auth";
import {
  buildPipelineNotifyRequest,
  interpretPipelineNotifyResponse,
  pipelineNotifyConfirmText,
  readGatePipelineRow,
} from "../src/utils/pipelineMode";

const server = readFileSync("server.ts", "utf8");
const card = readFileSync("src/components/RealtimeEngineCard.tsx", "utf8");

describe("pipeline notify switch: client helpers", () => {
  it("sends exactly { enabled } to the gate's route", () => {
    const { url, init } = buildPipelineNotifyRequest("cong-phu-b", true);
    assert.equal(url, "/api/camera-streams/cong-phu-b/pipeline-notify");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), { enabled: true });
    assert.deepEqual(JSON.parse(String(buildPipelineNotifyRequest("exit", null).init.body)), { enabled: null });
  });

  it("reads the notify state from a watcher; an older server shows no switch", () => {
    const row = readGatePipelineRow({ gateId: "exit", gate: "EXIT", pipelineMode: "shadow", pipelineNotify: true, pipelineNotifySource: "env" });
    assert.equal(row?.notify, true);
    assert.equal(row?.notifySource, "env");
    const old = readGatePipelineRow({ gateId: "exit", gate: "EXIT", pipelineMode: "shadow" });
    assert.equal(old?.notify, null);
    assert.equal(old?.notifySource, null);
  });

  it("only a 2xx success is applied; refusals say nothing changed", () => {
    const ok = interpretPipelineNotifyResponse("exit", { ok: true, status: 200, data: { success: true, gateId: "exit", pipelineNotify: true, pipelineNotifySource: "config", pipelineRunning: true } });
    assert.equal(ok.kind, "applied");
    assert.match(ok.message, /bật \(theo cấu hình\)/);
    const idle = interpretPipelineNotifyResponse("exit", { ok: true, status: 200, data: { success: true, pipelineNotify: true, pipelineNotifySource: "config", pipelineRunning: false } });
    assert.match(idle.message, /chưa chạy/);
    for (const status of [400, 401, 403, 404, 500]) {
      const r = interpretPipelineNotifyResponse("exit", { ok: false, status, data: {} });
      assert.equal(r.kind, "refused");
      assert.match(r.message, /CHƯA đổi/);
    }
    assert.equal(interpretPipelineNotifyResponse("exit", { ok: false, status: 0, data: null }).kind, "unreachable");
  });

  it("each target has its own confirm text", () => {
    assert.match(pipelineNotifyConfirmText("exit", true).confirmLabel, /Bật/);
    assert.match(pipelineNotifyConfirmText("exit", false).confirmLabel, /Tắt/);
    assert.match(pipelineNotifyConfirmText("exit", null).body, /PIPELINE_NOTIFY_GATES/);
    assert.match(pipelineNotifyConfirmText("exit", true).body, /không mở cửa/);
  });

  it("the card shows the switch to admins only and confirms before sending", () => {
    assert.match(card, /renderNotifyControls\(row, key\)/);
    assert.match(card, /if \(!isAdmin\) \{\s*return \(\s*<p[^>]*rt-notify-/);
    assert.match(card, /onClick=\{\(\) => setNotifyConfirm\(\{ key, enabled: !on \}\)\}/);
  });
});

describe("pipeline notify switch: server", () => {
  it("is admin only, for every gate id", () => {
    for (const gate of ["entry", "exit", "cong-phu-b"]) {
      assert.equal(requiredRoleFor("POST", `/api/camera-streams/${gate}/pipeline-notify`), "admin");
    }
  });

  it("the config choice wins over PIPELINE_NOTIFY_GATES, and notify needs a running pipeline", () => {
    assert.match(server, /function pipelineNotifyFor\(gate: Gate\)[\s\S]{0,400}typeof configured === "boolean"\) return \{ on: configured, source: "config" \}[\s\S]{0,120}PIPELINE_NOTIFY\.gates\.has\(gate\), source: "env"/);
    assert.match(server, /function pipelineNotifyActive\(gate: Gate\): boolean \{\s*return pipelineNotifyFor\(gate\)\.on && Boolean\(gatePipelines\.get\(gate\)\?\.pipeline\);/);
    // Every other notify decision goes through pipelineNotifyActive.
    assert.equal((server.match(/PIPELINE_NOTIFY\.gates\.has/g) || []).length, 1);
  });

  it("the operator's config route keeps the admin's value", () => {
    assert.match(server, /pipelineNotify: _ignoredPipelineNotify,/);
    assert.match(server, /pipelineNotify: base\.pipelineNotify,/);
  });

  it("the route refuses anything but true, false or null and logs the actor", () => {
    const route = server.slice(server.indexOf('app.post(["/api/camera-streams/:gate/pipeline-notify"'));
    const body = route.slice(0, route.indexOf("\n});"));
    assert.match(body, /body\.enabled !== null && typeof body\.enabled !== "boolean"/);
    assert.match(body, /operatorActor\(req\)/);
    assert.doesNotMatch(body, /unlockDoor|sendEtonWebhook|syncPipelines/);
  });
});
