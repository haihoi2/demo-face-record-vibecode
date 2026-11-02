/**
 * DELETE /api/employees/:id/templates/:templateId - removing a biometric
 * template. Operator role, CSRF and JSON content type; a template id looked up
 * only within the named employee (a cross-employee id is 404); a replay of the
 * same delete is 404, never 500; nothing in the answer resembles an embedding.
 *
 * The test image has no face photo to enrol from, so template ids here are
 * fabricated; the ownership and replay logic runs the same way (the lookup is
 * scoped to the employee before any delete).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, apiAs, authenticateAs, createTempEmployee, csrfTokenForCookie, deleteEmployee, rawApi, type Employee } from "./helpers";
import { rawRequest } from "./rawHttp";
import { createRoleUser, type RoleUser } from "./roleFixtures";

const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || "integration-operator-token";
const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";

const del = (employeeId: string, templateId: string) =>
  api<any>(`/api/employees/${encodeURIComponent(employeeId)}/templates/${encodeURIComponent(templateId)}`, { method: "DELETE" });

describe("DELETE template: boundary", () => {
  let a: Employee;
  let b: Employee;
  let operator: RoleUser;
  before(async () => {
    a = await createTempEmployee({ name: `Template Owner A ${Date.now()}` });
    b = await createTempEmployee({ name: `Template Owner B ${Date.now()}` });
    operator = await createRoleUser("operator");
  });
  after(async () => {
    await operator?.dispose();
    if (a) await deleteEmployee(a.id);
    if (b) await deleteEmployee(b.id);
  });

  it("anonymous 401, viewer 403, operator passes; CSRF and application/json are required", async () => {
    const path = `/api/employees/${a.id}/templates/FT-itest`;
    assert.equal((await rawApi(path, { method: "DELETE" })).status, 401);
    const viewer = await authenticateAs(VIEWER_TOKEN);
    assert.equal((await apiAs(viewer, path, { method: "DELETE" })).status, 403);
    const asOperator = await apiAs<any>(operator.cookie, path, { method: "DELETE" });
    assert.equal(asOperator.status, 404, "the operator passes the role gate and reaches the lookup");

    const admin = await authenticateAs(OPERATOR_TOKEN);
    const noCsrf = await rawApi<any>(path, { method: "DELETE", headers: { Cookie: admin, "Content-Type": "application/json" } });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.code, "CSRF_REQUIRED");
    const text = await rawApi<any>(path, { method: "DELETE", headers: { Cookie: admin, "Content-Type": "text/plain", "X-CSRF-Token": csrfTokenForCookie(admin) } });
    assert.equal(text.status, 415);
    assert.equal(text.body.code, "JSON_REQUIRED");
    const noType = await rawApi<any>(path, { method: "DELETE", headers: { Cookie: admin, "X-CSRF-Token": csrfTokenForCookie(admin) } });
    assert.equal(noType.status, 415, "a DELETE without a content type is refused like any other protected mutation");
  });

  it("a template id is looked up only within the named employee: cross-employee and replayed deletes are 404", async () => {
    const listA = await api<any>(`/api/employees/${a.id}/templates`);
    assert.equal(listA.status, 200, listA.text.slice(0, 200));
    assert.ok(Array.isArray(listA.body.templates));
    // The id shape a real template of A would have, used against B.
    const foreign = await del(b.id, listA.body.templates[0]?.id || `FT-${a.id}`);
    assert.equal(foreign.status, 404, foreign.text.slice(0, 200));
    assert.equal(foreign.body.success, false);
    assert.doesNotMatch(foreign.text, /embedding|"vector"/i);
    const replay = await del(b.id, listA.body.templates[0]?.id || `FT-${a.id}`);
    assert.equal(replay.status, 404, "the second identical delete is 404, not 500");
    assert.equal((await del(a.id, "FT-never-existed")).status, 404);
    assert.equal((await del("EMP-never-existed", "FT-x")).status, 404);
  });

  it("malformed ids are 404, never 500, and the error names no embedding", async () => {
    for (const tid of ["../../etc/passwd", "%00", "FT-" + "x".repeat(300), "'; DROP TABLE face_templates; --", " "]) {
      const res = await del(a.id, tid);
      assert.equal(res.status, 404, `${JSON.stringify(tid)}: ${res.status} ${res.text.slice(0, 120)}`);
      assert.doesNotMatch(res.text, /embedding/i);
    }
    // A literal dot segment, sent byte-for-byte: fetch would resolve
    // `/templates/..` into DELETE /api/employees/:id and remove the employee
    // client-side; the gateway itself must treat it as an unknown template id.
    const admin = await authenticateAs(OPERATOR_TOKEN);
    const headers = { Cookie: admin, "X-CSRF-Token": csrfTokenForCookie(admin), "Content-Type": "application/json" };
    for (const path of [`/api/employees/${a.id}/templates/..`, `/api/employees/${a.id}/templates/%2e%2e`, `/api/employees/../templates/FT-x`, `/api/employees/${a.id}/templates/..%2f${b.id}`]) {
      const res = await rawRequest("DELETE", path, headers);
      assert.equal(res.status, 404, `${path}: ${res.status} ${res.text.slice(0, 120)}`);
    }
    for (const eid of ["%00", "EMP-" + "x".repeat(300)]) {
      assert.equal((await del(eid, "FT-x")).status, 404, eid);
    }
    assert.equal((await api(`/api/employees/${encodeURIComponent(a.id)}/templates`)).status, 200, "employee A still exists");
    assert.equal((await api(`/api/employees/${encodeURIComponent(b.id)}/templates`)).status, 200, "employee B still exists");
    assert.equal((await api("/api/health")).status, 200);
  });
});
