/**
 * Real-time pipeline rollout switch, as seen from outside (plan section 2).
 *
 * Every build must report, per gate, which mode the watcher actually runs in
 * (`pipelineMode`), and say so when a requested mode was downgraded
 * (`pipelineModeRequested`). Shadow/live must never be reachable without the
 * operator role, and the watcher runtime is readable by viewers but carries no
 * stream address. Deeper behaviour (shadow never unlocks, crops only) lives in
 * tests/master/security, which needs the replay harness.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { api, authenticateAs, postJson, rawApi } from "./helpers";

const MODES = ["legacy", "shadow", "live"];

describe("pipeline rollout switch (PIPELINE_MODE_ENTRY / PIPELINE_MODE_EXIT)", () => {
  it("each gate reports its effective mode, and the requested one when downgraded", async () => {
    const r = await api("/api/camera-streams/watch");
    assert.equal(r.status, 200);
    const watchers = r.body.watchers as Array<Record<string, unknown>>;
    assert.deepEqual(watchers.map((w) => w.gate).sort(), ["ENTRY", "EXIT"]);
    for (const w of watchers) {
      assert.ok(MODES.includes(String(w.pipelineMode)), `${w.gate}: pipelineMode ${w.pipelineMode}`);
      if (w.pipelineModeRequested !== undefined) {
        assert.ok(MODES.includes(String(w.pipelineModeRequested)), `${w.gate}: requested ${w.pipelineModeRequested}`);
        assert.notEqual(w.pipelineModeRequested, w.pipelineMode, "requested is only reported when it differs");
      }
    }
  });

  it("the watcher runtime needs a session and carries no stream address", async () => {
    assert.equal((await rawApi("/api/camera-streams/watch")).status, 401);
    const viewer = await authenticateAs(process.env.VIEWER_TOKEN || "integration-viewer-token");
    const r = await rawApi("/api/camera-streams/watch", { headers: { Cookie: viewer } });
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /rtsp:\/\/|rtspUrl/i);
  });

  it("a viewer cannot switch a watcher on or off", async () => {
    const viewer = await authenticateAs(process.env.VIEWER_TOKEN || "integration-viewer-token");
    for (const gate of ["entry", "exit"]) {
      const r = await rawApi(`/api/camera-streams/${gate}/watch`, {
        method: "POST",
        headers: { Cookie: viewer, "Content-Type": "application/json", "X-CSRF-Token": "not-the-token" },
        body: JSON.stringify({ enabled: true }),
      });
      assert.ok(r.status === 401 || r.status === 403, `viewer POST ${gate}/watch -> ${r.status}`);
    }
  });

  it("the mode cannot be changed through the watch or camera config API", async () => {
    const before = await api("/api/camera-streams/watch");
    const modes = Object.fromEntries(before.body.watchers.map((w: any) => [w.gate, w.pipelineMode]));
    await postJson("/api/camera-streams/entry/watch", { pipelineMode: "live" });
    await postJson("/api/camera-streams/config", { entryGate: { pipelineMode: "live" }, exitGate: { pipelineMode: "live" } });
    const after = await api("/api/camera-streams/watch");
    for (const w of after.body.watchers) {
      assert.equal(w.pipelineMode, modes[w.gate], `${w.gate}: a request body changed the pipeline mode`);
    }
  });
});
