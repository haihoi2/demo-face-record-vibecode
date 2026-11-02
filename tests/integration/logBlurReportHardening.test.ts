/**
 * POST/DELETE /api/logs/:id/blur-report and GET /api/logs/blur-state (quick
 * blur report from the live list, 2026-10-11): role and CSRF boundary,
 * malformed and unknown ids, duplicate reports, id-list bounds.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, apiAs, authenticateAs, csrfTokenForCookie, noFaceJpegDataUrl, postJson, rawApi, recognize } from "./helpers";

const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || "integration-operator-token";
const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";

describe("quick blur report: boundary", () => {
  it("anonymous 401, viewer 403 on report and withdraw; CSRF and JSON required", async () => {
    const path = "/api/logs/LOG-itest-blur/blur-report";
    for (const method of ["POST", "DELETE"]) {
      assert.equal((await rawApi(path, { method, headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401, method);
      const viewer = await authenticateAs(VIEWER_TOKEN);
      assert.equal((await apiAs(viewer, path, { method, headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403, method);
      const admin = await authenticateAs(OPERATOR_TOKEN);
      const noCsrf = await rawApi<any>(path, { method, headers: { Cookie: admin, "Content-Type": "application/json" }, body: "{}" });
      assert.equal(noCsrf.status, 403, method);
      assert.equal(noCsrf.body.code, "CSRF_REQUIRED");
      const text = await rawApi<any>(path, { method, headers: { Cookie: admin, "Content-Type": "text/plain", "X-CSRF-Token": csrfTokenForCookie(admin) }, body: "{}" });
      assert.equal(text.status, 415, method);
    }
  });

  it("malformed ids are 400; an unknown or face-less event is refused the same way twice (no 500, nothing stored)", async () => {
    for (const id of ["bad id", "..%2F..%2Fetc", "%00", "-starts-with-dash", "LOG-" + "x".repeat(130)]) {
      const res = await postJson<any>(`/api/logs/${id}/blur-report`, {});
      assert.equal(res.status, 400, `${id}: ${res.status}`);
    }
    const unknown1 = await postJson<any>("/api/logs/LOG-never-existed-itest/blur-report", {});
    const unknown2 = await postJson<any>("/api/logs/LOG-never-existed-itest/blur-report", {});
    for (const r of [unknown1, unknown2]) {
      assert.ok(r.status === 400 || r.status === 404, `unknown event: ${r.status}`);
      assert.equal(r.body.success, false);
    }
    assert.equal(unknown1.status, unknown2.status, "a duplicate report answers identically");

    const made = await recognize({ imageBase64: noFaceJpegDataUrl(64, 98001), scanType: "ENTRY" });
    assert.equal(made.status, 200, made.text.slice(0, 200));
    const logId = (made.body as any).log.id as string;
    const first = await postJson<any>(`/api/logs/${encodeURIComponent(logId)}/blur-report`, {});
    const second = await postJson<any>(`/api/logs/${encodeURIComponent(logId)}/blur-report`, {});
    assert.equal(first.status, 400);
    assert.equal(first.body.code, "NO_FACE_RECORDS", "a frame without a stored stranger face cannot be reported");
    assert.deepEqual(second.body, first.body, "the duplicate is idempotent");
    const withdrawn = await api<any>(`/api/logs/${encodeURIComponent(logId)}/blur-report`, { method: "DELETE" });
    assert.equal(withdrawn.status, 400);
    const state = await api<any>(`/api/logs/blur-state?ids=${encodeURIComponent(logId)}`);
    assert.equal(state.status, 200);
    assert.deepEqual(state.body.reported, []);
    const reports = await api<any>("/api/strangers/blur-reports");
    assert.equal(reports.status, 200);
    assert.doesNotMatch(reports.text, new RegExp(logId), "nothing was stored for the refused report");
  });

  it("blur-state drops malformed ids, caps the list at 50 and ignores an empty list", async () => {
    const many = Array.from({ length: 80 }, (_, i) => `LOG-itest-${i}`).join(",");
    const res = await api<any>(`/api/logs/blur-state?ids=${many}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.reported, []);
    assert.deepEqual(res.body.withFaces, []);
    const odd = await api<any>("/api/logs/blur-state?ids=..%2F,%00,bad%20id,");
    assert.equal(odd.status, 200);
    assert.deepEqual(odd.body.reported, []);
    const none = await api<any>("/api/logs/blur-state");
    assert.equal(none.status, 200);
    assert.deepEqual(none.body.withFaces, []);
  });
});
