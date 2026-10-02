/**
 * Blur reports: operator labels on stranger faces for re-tuning the blur
 * filter (src/server/blurReports.ts). A report never deletes or hides anything.
 * Contract and authorisation here; the full flow with a real face (report,
 * flag in the cluster list, withdraw, stored scores) runs on dev with a
 * detector-floor override, because this suite has no face that passes the
 * stranger storage floors.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, apiAs, authenticateAs, postJson, rawApi } from "./helpers";

const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";

describe("blur reports", () => {
  it("refuses whole-frame (legacy) ids and unknown faces without storing anything", async () => {
    const legacy = await postJson<any>("/api/strangers/faces/LOG-123-abc/blur-report", {});
    assert.equal(legacy.status, 400, legacy.text.slice(0, 200));
    const unknown = await postJson<any>("/api/strangers/faces/SF-00000000-0000-0000-0000-000000000000/blur-report", {});
    assert.equal(unknown.status, 404, unknown.text.slice(0, 200));
    const badNote = await postJson<any>("/api/strangers/faces/SF-00000000-0000-0000-0000-000000000000/blur-report", { note: { toString: "x" } });
    assert.equal(badNote.status, 400);
    const list = await api<any>("/api/strangers/blur-reports");
    assert.equal(list.status, 200, list.text.slice(0, 200));
    assert.ok(Array.isArray(list.body.reports) && Array.isArray(list.body.current));
    assert.ok(!list.body.reports.some((r: any) => r.faceId === "SF-00000000-0000-0000-0000-000000000000"));
  });

  it("reporting is operator+, the report list is admin only", async () => {
    assert.equal((await rawApi("/api/strangers/blur-reports")).status, 401);
    assert.equal((await rawApi("/api/strangers/faces/SF-x/blur-report", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
    const viewer = await authenticateAs(VIEWER_TOKEN);
    assert.equal((await apiAs(viewer, "/api/strangers/blur-reports")).status, 403);
    assert.equal((await apiAs(viewer, "/api/strangers/faces/SF-x/blur-report", { method: "POST", body: "{}" })).status, 403);
    assert.equal((await apiAs(viewer, "/api/strangers/faces/SF-x/blur-report", { method: "DELETE", body: "{}" })).status, 403);
  });

  it("rejects an invalid since", async () => {
    assert.equal((await api("/api/strangers/blur-reports?since=yesterday")).status, 400);
  });
});
