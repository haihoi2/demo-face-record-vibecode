/**
 * Admin switch for a gate's real-time pipeline mode (the separate engine flow):
 * POST /api/camera-streams/:gate/pipeline-mode. Admin only; saved in the camera
 * config; `live` refused while this build downgrades it; null = server default.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, apiAs, authenticateAs, loginWithPassword } from "./helpers";

const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || "integration-operator-token";
const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";
const PASSWORD = "Pipeline-Mode-Test-2026!";
const accounts: string[] = [];

async function operatorSession(): Promise<string> {
  const bootstrap = await authenticateAs(OPERATOR_TOKEN);
  const username = `it-pm-op-${Date.now().toString(36)}`;
  const created = await apiAs<any>(bootstrap, "/api/users", { method: "POST", body: JSON.stringify({ username, role: "operator", password: PASSWORD }) });
  assert.equal(created.status, 201, created.text.slice(0, 200));
  accounts.push(created.body.user.id);
  const login = await loginWithPassword(username, PASSWORD);
  assert.equal(login.status, 200);
  return login.cookie;
}
const setMode = (gate: string, mode: unknown) => api<any>(`/api/camera-streams/${gate}/pipeline-mode`, { method: "POST", body: JSON.stringify({ mode }) });
const exitWatcher = async () => (await api<any>("/api/camera-streams/watch")).body.watchers.find((w: any) => w.gate === "EXIT");

describe("pipeline mode switch", () => {
  after(async () => {
    await setMode("exit", null);
    const bootstrap = await authenticateAs(OPERATOR_TOKEN);
    for (const id of accounts) await apiAs(bootstrap, `/api/users/${id}`, { method: "DELETE" });
  });

  it("starts on the server default", async () => {
    const w = await exitWatcher();
    assert.equal(w.pipelineMode, "legacy");
    assert.equal(w.pipelineModeSource, "env");
  });

  it("an admin sets shadow: saved, effective at once, visible in config and watch", async () => {
    const res = await setMode("exit", "shadow");
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body.gate, "EXIT");
    assert.equal(res.body.pipelineMode, "shadow");
    assert.equal(res.body.pipelineModeSource, "config");
    const w = await exitWatcher();
    assert.equal(w.pipelineMode, "shadow");
    assert.equal(w.pipelineModeSource, "config");
    const cfg = await api<any>("/api/camera-streams/config");
    assert.equal(cfg.status, 200);
    assert.equal(cfg.body.config?.exitGate?.pipelineMode ?? cfg.body.exitGate?.pipelineMode, "shadow");
    const entry = (await api<any>("/api/camera-streams/watch")).body.watchers.find((w: any) => w.gate === "ENTRY");
    assert.equal(entry.pipelineMode, "legacy", "the other gate is untouched");
  });

  it("refuses live while this build cannot run it, and refuses unknown modes", async () => {
    const live = await setMode("exit", "live");
    assert.equal(live.status, 409);
    assert.equal(live.body.code, "PIPELINE_MODE_NOT_AVAILABLE");
    assert.equal((await exitWatcher()).pipelineMode, "shadow", "a refused request changes nothing");
    const bad = await setMode("exit", "turbo");
    assert.equal(bad.status, 400);
    assert.equal((await setMode("side", "shadow")).status, 400);
  });

  it("null clears the override back to the server default", async () => {
    const res = await setMode("exit", null);
    assert.equal(res.status, 200);
    assert.equal(res.body.pipelineModeSource, "env");
    assert.equal(res.body.pipelineMode, "legacy");
  });

  it("viewer and operator cannot switch it", async () => {
    const viewer = await authenticateAs(VIEWER_TOKEN);
    const v = await apiAs(viewer, "/api/camera-streams/exit/pipeline-mode", { method: "POST", body: JSON.stringify({ mode: "shadow" }) });
    assert.equal(v.status, 403, v.text.slice(0, 200));
    const operator = await operatorSession();
    const o = await apiAs(operator, "/api/camera-streams/exit/pipeline-mode", { method: "POST", body: JSON.stringify({ mode: "shadow" }) });
    assert.equal(o.status, 403, o.text.slice(0, 200));
    assert.equal((await exitWatcher()).pipelineModeSource, "env");
  });
});
