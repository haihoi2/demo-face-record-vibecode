/**
 * Admin switch for a gate's pipeline chat messages (#580):
 * POST /api/camera-streams/:gate/pipeline-notify { enabled: true | false | null }.
 * Admin only; saved in the camera config; null = PIPELINE_NOTIFY_GATES; the
 * operator's config save can neither set nor drop it.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, apiAs, authenticateAs, loginWithPassword, postJson } from "./helpers";

const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || "integration-operator-token";
const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";
const PASSWORD = "Pipeline-Notify-Test-2026!";
const accounts: string[] = [];

async function operatorSession(): Promise<string> {
  const bootstrap = await authenticateAs(OPERATOR_TOKEN);
  const username = `it-pn-op-${Date.now().toString(36)}`;
  const created = await apiAs<any>(bootstrap, "/api/users", { method: "POST", body: JSON.stringify({ username, role: "operator", password: PASSWORD }) });
  assert.equal(created.status, 201, created.text.slice(0, 200));
  accounts.push(created.body.user.id);
  const login = await loginWithPassword(username, PASSWORD);
  assert.equal(login.status, 200);
  return login.cookie;
}
const setNotify = (gate: string, enabled: unknown) =>
  api<any>(`/api/camera-streams/${gate}/pipeline-notify`, { method: "POST", body: JSON.stringify({ enabled }) });
const watcher = async (id: string) => (await api<any>("/api/camera-streams/watch")).body.watchers.find((w: any) => w.gateId === id);
const config = async () => (await api<any>("/api/camera-streams/config")).body.config;
const exitGateOf = (cfg: any) => cfg.gates?.find((g: any) => g.id === "exit") ?? cfg.exitGate;

describe("pipeline notify switch (#580)", () => {
  after(async () => {
    await setNotify("exit", null);
    await setNotify("entry", null);
    const bootstrap = await authenticateAs(OPERATOR_TOKEN);
    for (const id of accounts) await apiAs(bootstrap, `/api/users/${id}`, { method: "DELETE" });
  });

  it("starts on the server default", async () => {
    const w = await watcher("exit");
    assert.equal(typeof w.pipelineNotify, "boolean");
    assert.equal(w.pipelineNotifySource, "env");
  });

  it("an admin switches it on: saved, effective at once, other gate untouched", async () => {
    const entryBefore = await watcher("entry");
    const res = await setNotify("exit", true);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body.gateId, "exit");
    assert.equal(res.body.pipelineNotify, true);
    assert.equal(res.body.pipelineNotifySource, "config");
    assert.equal(typeof res.body.pipelineRunning, "boolean");
    const w = await watcher("exit");
    assert.equal(w.pipelineNotify, true);
    assert.equal(w.pipelineNotifySource, "config");
    assert.equal(exitGateOf(await config()).pipelineNotify, true);
    const entry = await watcher("entry");
    assert.equal(entry.pipelineNotify, entryBefore.pipelineNotify);
    assert.equal(entry.pipelineNotifySource, "env");
  });

  it("false is stored as an explicit off", async () => {
    const res = await setNotify("exit", false);
    assert.equal(res.status, 200);
    assert.equal(res.body.pipelineNotify, false);
    assert.equal(res.body.pipelineNotifySource, "config");
  });

  it("the operator's config save neither sets nor drops it", async () => {
    const cfg = await config();
    const exit = exitGateOf(cfg);
    const saved = await postJson<any>("/api/camera-streams/config", { exitGate: { ...exit, streams: undefined, pipelineNotify: true } });
    assert.ok(saved.status < 300, saved.text.slice(0, 300));
    assert.equal((await watcher("exit")).pipelineNotify, false, "kept the admin's off");
    const { pipelineNotify: _drop, ...without } = exit;
    await postJson<any>("/api/camera-streams/config", { exitGate: { ...without, streams: undefined } });
    assert.equal((await watcher("exit")).pipelineNotifySource, "config", "not dropped by a save without the field");
  });

  it("refuses a missing or non-boolean value and an unknown gate", async () => {
    for (const body of [{}, { enabled: "yes" }, { enabled: 1 }]) {
      const r = await api<any>("/api/camera-streams/exit/pipeline-notify", { method: "POST", body: JSON.stringify(body) });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal((await setNotify("no-such-gate", true)).status, 400);
    assert.equal((await watcher("exit")).pipelineNotify, false, "a refused request changes nothing");
  });

  it("null goes back to the server default", async () => {
    const res = await setNotify("exit", null);
    assert.equal(res.status, 200);
    assert.equal(res.body.pipelineNotifySource, "env");
    assert.equal(exitGateOf(await config()).pipelineNotify, undefined);
  });

  it("viewer and operator cannot switch it", async () => {
    const viewer = await authenticateAs(VIEWER_TOKEN);
    const v = await apiAs(viewer, "/api/camera-streams/exit/pipeline-notify", { method: "POST", body: JSON.stringify({ enabled: true }) });
    assert.equal(v.status, 403, v.text.slice(0, 200));
    const operator = await operatorSession();
    const o = await apiAs(operator, "/api/camera-streams/exit/pipeline-notify", { method: "POST", body: JSON.stringify({ enabled: true }) });
    assert.equal(o.status, 403, o.text.slice(0, 200));
    assert.equal((await watcher("exit")).pipelineNotifySource, "env");
  });
});
