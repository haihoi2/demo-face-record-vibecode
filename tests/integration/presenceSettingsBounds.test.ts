/**
 * PUT /api/presence/settings/:gateId (P3b per-gate presence settings): admin
 * only, every field bounded, null clears a saved value, unknown fields and
 * gates refused, and the saved record names the actor.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, apiAs, authenticateAs, rawApi } from "./helpers";

const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";
const put = (gate: string, body: unknown) =>
  api<any>(`/api/presence/settings/${gate}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

const CLEAR_ALL = { mode: null, workingHours: null, minSecondsWorking: null, minSecondsAfterHours: null, alertWindowSeconds: null, alertHoldSeconds: null };

describe("presence gate settings: bounds", () => {
  after(async () => { await put("exit", CLEAR_ALL); });

  it("every numeric field is refused just outside its range, as a string, as infinity or as an object", async () => {
    const ranges: Array<[string, number, number]> = [
      ["minSecondsWorking", 0.5, 60],
      ["minSecondsAfterHours", 0.5, 60],
      ["alertWindowSeconds", 30, 3600],
      ["alertHoldSeconds", 0, 30],
    ];
    for (const [field, min, max] of ranges) {
      for (const bad of [min - 0.1, max + 1, -1, `${min}`, true, { v: min }, [min]]) {
        const res = await put("exit", { [field]: bad });
        assert.equal(res.status, 400, `${field}=${JSON.stringify(bad)}: ${res.status} ${res.text.slice(0, 100)}`);
        assert.equal(res.body.field, field);
      }
      assert.equal((await put("exit", `{"${field}": 1e400}`)).status, 400, `${field}=Infinity`);
      const okMin = await put("exit", { [field]: min });
      assert.equal(okMin.status, 200, `${field}=${min}: ${okMin.text.slice(0, 120)}`);
      assert.equal(okMin.body.gate.source[field], "saved");
      const okMax = await put("exit", { [field]: max });
      assert.equal(okMax.status, 200);
      assert.equal(okMax.body.gate[field], max);
    }
    for (const mode of ["loud", "LIVE", "", 1, null]) {
      const res = await put("exit", { mode });
      if (mode === null) assert.equal(res.status, 200, "null clears");
      else assert.equal(res.status, 400, `mode=${JSON.stringify(mode)}`);
    }
    for (const wh of ["7-19", "07:00-07:00", "25:00-26:00", "07:00", "0700-1900", 7, ""]) {
      assert.equal((await put("exit", { workingHours: wh })).status, 400, `workingHours=${JSON.stringify(wh)}`);
    }
    assert.equal((await put("exit", { workingHours: "22:00-06:00" })).status, 200, "an overnight window is valid");
  });

  it("unknown fields, empty and non-object bodies are 400; unknown or odd gate ids are 404; nothing is written", async () => {
    const before = (await api<any>("/api/presence/settings")).body.gates.find((g: any) => g.gateId === "exit");
    for (const body of [{ zone: 1 }, { alertWindowSeconds: 60, extra: true }, { __proto__: { mode: "live" } }, {}, [], "null", '"x"', "{bad"]) {
      const res = await put("exit", body);
      assert.equal(res.status, 400, `${JSON.stringify(body)}: ${res.status} ${res.text.slice(0, 100)}`);
    }
    for (const gate of ["no-such-gate", "..", "..%2Fentry", "%00", "ENTRY", "entry%20", "x".repeat(300)]) {
      const res = await put(gate, { alertWindowSeconds: 60 });
      assert.equal(res.status, 404, `${gate}: ${res.status}`);
    }
    const after = (await api<any>("/api/presence/settings")).body.gates.find((g: any) => g.gateId === "exit");
    assert.deepEqual(after, before, "no refused request changed anything");
  });

  it("a valid change is attributed to the actor and null returns the field to the .env value", async () => {
    const saved = await put("exit", { alertWindowSeconds: 600 });
    assert.equal(saved.status, 200, saved.text.slice(0, 200));
    assert.equal(saved.body.gate.alertWindowSeconds, 600);
    assert.equal(saved.body.gate.source.alertWindowSeconds, "saved");
    assert.equal(saved.body.gate.updatedBy, "itest-operator");
    assert.ok(Date.parse(saved.body.gate.updatedAt) > 0);
    const cleared = await put("exit", { alertWindowSeconds: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.gate.source.alertWindowSeconds, "env");
  });

  it("GET is operator+, PUT is admin: viewer 403 and anonymous 401 on both", async () => {
    assert.equal((await rawApi("/api/presence/settings")).status, 401);
    assert.equal((await rawApi("/api/presence/settings/exit", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
    const viewer = await authenticateAs(VIEWER_TOKEN);
    assert.equal((await apiAs(viewer, "/api/presence/settings")).status, 403);
    const res = await apiAs<any>(viewer, "/api/presence/settings/exit", { method: "PUT", body: JSON.stringify({ alertWindowSeconds: 60 }) });
    assert.equal(res.status, 403);
    assert.equal(res.body.requiredRole, "admin");
  });
});
