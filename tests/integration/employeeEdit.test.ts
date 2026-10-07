/** Admin profile correction: PATCH /api/employees/:id (2026-10-07). */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { FIXTURE_DEPARTMENT, api, apiAs, authenticateAs, createTempEmployee, deleteEmployee, listEmployees } from "./helpers";

const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";
const png1x1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const patch = (id: string, body: unknown) =>
  api<any>(`/api/employees/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("employee profile correction", () => {
  const ids: string[] = [];
  after(async () => { for (const id of ids) await deleteEmployee(id); });

  it("admin only", async () => {
    const emp = await createTempEmployee({ name: `Edit ${Date.now()}` });
    ids.push(emp.id);
    const viewer = await authenticateAs(VIEWER_TOKEN);
    const res = await apiAs(viewer, `/api/employees/${emp.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    assert.equal(res.status, 403);
  });

  it("corrects name and department, refuses unknown values and fields, adds a photo without returning it", async () => {
    const emp = await createTempEmployee({ name: `Sai Ten ${Date.now()}` });
    ids.push(emp.id);
    assert.equal((await patch(emp.id, { department: "Không Có Phòng Này" })).status, 400);
    assert.equal((await patch(emp.id, { employeeCode: "NV-0000" })).status, 400);
    assert.equal((await patch(emp.id, { photo: "https://example.com/p.jpg" })).status, 400);
    assert.equal((await patch("EMP-does-not-exist", { name: "x" })).status, 404);

    const fixed = await patch(emp.id, { name: `Đúng Tên ${emp.employeeCode}`, department: FIXTURE_DEPARTMENT });
    assert.equal(fixed.status, 200, fixed.text.slice(0, 200));
    assert.equal(fixed.body.employee.name, `Đúng Tên ${emp.employeeCode}`);
    assert.ok(fixed.body.changes.some((c: string) => c.startsWith("Họ tên:")));
    assert.equal(fixed.body.employee.employeeCode, emp.employeeCode, "the code is unchanged");

    const withPhoto = await patch(emp.id, { photo: png1x1 });
    assert.equal(withPhoto.status, 200, withPhoto.text.slice(0, 200));
    assert.doesNotMatch(withPhoto.text, /data:image|photoUrl/);
    assert.equal(withPhoto.body.employee.hasPhoto, true);
    assert.ok("faceTemplateRejected" in withPhoto.body, "says whether a template was made");

    const listed = (await listEmployees()).find((e) => e.id === emp.id);
    assert.equal(listed?.name, `Đúng Tên ${emp.employeeCode}`);
  });
});
