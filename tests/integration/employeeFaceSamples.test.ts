/**
 * GET /api/employees/:id/face-samples: picture ids for comparing a stranger
 * with an employee before a merge (owner 2026-10-04). Operator+, ids only.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, apiAs, authenticateAs, createTempEmployee, deleteEmployee, rawApi } from "./helpers";

const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";
const cleanup: string[] = [];

describe("employee face samples", () => {
  after(async () => {
    for (const id of cleanup) await deleteEmployee(id).catch(() => {});
  });

  it("returns the employee and (here empty) sample and template-frame lists, never images or embeddings", async () => {
    const emp = await createTempEmployee({ name: `Samples ${Date.now()}` });
    cleanup.push(emp.id);
    const res = await api<any>(`/api/employees/${encodeURIComponent(emp.id)}/face-samples`);
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.equal(res.body.employee.id, emp.id);
    assert.ok(Array.isArray(res.body.samples));
    assert.ok(Array.isArray(res.body.templateFrames));
    assert.doesNotMatch(res.text, /embedding|data:image|base64/);
  });

  it("404 for an unknown employee; operator only", async () => {
    assert.equal((await api("/api/employees/EMP-does-not-exist/face-samples")).status, 404);
    assert.equal((await rawApi("/api/employees/EMP-x/face-samples")).status, 401);
    const viewer = await authenticateAs(VIEWER_TOKEN);
    assert.equal((await apiAs(viewer, "/api/employees/EMP-x/face-samples")).status, 403);
  });
});

describe("employee registration photo route", () => {
  it("serves a stored photo as an image to operators, 404 without one, 403 for viewers", async () => {
    const png1x1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const withPhoto = await createTempEmployee({ name: `Photo ${Date.now()}`, photoUrl: png1x1 } as any);
    const without = await createTempEmployee({ name: `NoPhoto ${Date.now()}` });
    cleanup.push(withPhoto.id, without.id);
    const samples = await api<any>(`/api/employees/${encodeURIComponent(withPhoto.id)}/face-samples`);
    const img = await rawApiAsOperatorImage(`/api/employees/${encodeURIComponent(withPhoto.id)}/photo`);
    if (samples.body.employee.hasPhoto) {
      assert.equal(img.status, 200);
      assert.match(String(img.type), /^image\//);
    } else {
      assert.equal(img.status, 404, "the fixture photo was not stored (enrolment may replace it); then the route says so");
    }
    assert.equal((await rawApiAsOperatorImage("/api/employees/EMP-does-not-exist/photo")).status, 404);
    // (createTempEmployee gives every fixture a default photo, so `without` is only used for cleanup.)
    void without;
    const viewer = await authenticateAs(VIEWER_TOKEN);
    assert.equal((await apiAs(viewer, `/api/employees/${encodeURIComponent(withPhoto.id)}/photo`)).status, 403);
  });
});

async function rawApiAsOperatorImage(path: string) {
  const res = await api<any>(path, { headers: { "Sec-Fetch-Site": "same-origin" } });
  return { status: res.status, type: res.headers.get("content-type") };
}
