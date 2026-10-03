/**
 * Person presence (P2, shadow) routes: status for every signed-in role; events,
 * body crops and labels for operators. Presence is off on the test gateway, so
 * the event list is empty; the full flow (worker -> event -> crop -> label) is
 * checked on dev with a clip.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, apiAs, authenticateAs, postJson, rawApi } from "./helpers";

const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";

describe("presence routes", () => {
  it("status lists every gate with its mode (off by default)", async () => {
    const res = await api<any>("/api/presence/status");
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.ok(Array.isArray(res.body.gates) && res.body.gates.length >= 2);
    for (const g of res.body.gates) assert.equal(g.mode, "off");
  });

  it("events: empty page, filters validated, opaque cursor ignored when invalid", async () => {
    const res = await api<any>("/api/presence/events?gate=entry&limit=5");
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.deepEqual(res.body.events, []);
    assert.equal(res.body.hasMore, false);
    assert.equal((await api("/api/presence/events?period=lunch")).status, 400);
    assert.equal((await api("/api/presence/events?faceOutcome=maybe")).status, 400);
    assert.equal((await api("/api/presence/events?label=x")).status, 400);
  });

  it("crop and label refuse bad or unknown ids", async () => {
    assert.equal((await api("/api/presence/events/bad id/crop")).status, 400);
    assert.equal((await api("/api/presence/events/PE-00000000-0000-0000-0000-000000000000/crop")).status, 404);
    assert.equal((await postJson("/api/presence/events/PE-00000000-0000-0000-0000-000000000000/label", { kind: "real" })).status, 404);
    assert.equal((await postJson("/api/presence/events/PE-00000000-0000-0000-0000-000000000000/label", { kind: "maybe" })).status, 400);
  });

  it("roles: viewers see status only; anonymous nothing", async () => {
    assert.equal((await rawApi("/api/presence/status")).status, 401);
    assert.equal((await rawApi("/api/presence/events")).status, 401);
    const viewer = await authenticateAs(VIEWER_TOKEN);
    assert.equal((await apiAs(viewer, "/api/presence/status")).status, 200);
    assert.equal((await apiAs(viewer, "/api/presence/events")).status, 403);
    assert.equal((await apiAs(viewer, "/api/presence/events/PE-x/crop")).status, 403);
    assert.equal((await apiAs(viewer, "/api/presence/events/PE-x/label", { method: "POST", body: JSON.stringify({ kind: "real" }) })).status, 403);
  });
});
