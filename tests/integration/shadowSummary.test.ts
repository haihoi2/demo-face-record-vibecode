/**
 * Shadow-engine accuracy routes (plan 2026-09-29 Part B): boundaries and shape
 * on a fresh gateway (no pipeline running, so the window is empty).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, apiAs, authenticateAs, rawApi } from "./helpers";

const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";

describe("shadow accuracy routes", () => {
  it("need a session; a viewer may read", async () => {
    assert.equal((await rawApi("/api/pipeline/shadow-summary")).status, 401);
    assert.equal((await rawApi("/api/pipeline/shadow-results")).status, 401);
    const viewer = await authenticateAs(VIEWER_TOKEN);
    const s = await apiAs<any>(viewer, "/api/pipeline/shadow-summary?hours=24");
    assert.equal(s.status, 200, s.text.slice(0, 200));
    assert.equal(s.body.success, true);
    assert.ok(Array.isArray(s.body.gates));
    assert.ok(!Number.isNaN(Date.parse(s.body.since)));
  });

  it("clamps the window and returns an empty page with no pipeline", async () => {
    const s = await api<any>("/api/pipeline/shadow-summary?hours=999999");
    assert.equal(s.status, 200);
    assert.equal(s.body.hours, 720);
    const r = await api<any>("/api/pipeline/shadow-results?limit=5");
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.deepEqual(r.body.results, []);
    assert.equal(r.body.hasMore, false);
    assert.equal(r.body.nextCursor, null);
  });

  it("rejects a malformed cursor and ignores unknown filters safely", async () => {
    assert.equal((await api("/api/pipeline/shadow-results?cursor=%00bad")).status, 400);
    const r = await api<any>("/api/pipeline/shadow-results?gate=drop%20table&agreement=nope");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results, []);
  });
});
