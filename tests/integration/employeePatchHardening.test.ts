/**
 * PATCH /api/employees/:id (admin profile correction, 2026-10-07): the
 * browser-to-backend trust boundary. Session, CSRF, JSON content type and
 * origin checks; the field whitelist; size bounds; the actor-attributed audit
 * record; and that the photo never comes back.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, apiAs, authenticateAs, createTempEmployee, csrfTokenForCookie, deleteEmployee, rawApi, type Employee } from "./helpers";
import { rawRequest } from "./rawHttp";

const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || "integration-operator-token";
const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";
const png1x1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const patch = (id: string, body: unknown) =>
  api<any>(`/api/employees/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("PATCH /api/employees/:id: trust boundary", () => {
  let emp: Employee;
  before(async () => { emp = await createTempEmployee({ name: `Patch Boundary ${Date.now()}` }); });
  after(async () => { if (emp) await deleteEmployee(emp.id); });

  it("anonymous 401; viewer 403; the admin session alone is not enough without its CSRF token, JSON body and same/allowed origin", async () => {
    const path = `/api/employees/${emp.id}`;
    const body = JSON.stringify({ name: "x" });
    assert.equal((await rawApi(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body })).status, 401);
    const viewer = await authenticateAs(VIEWER_TOKEN);
    assert.equal((await apiAs(viewer, path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body })).status, 403);

    const admin = await authenticateAs(OPERATOR_TOKEN);
    const noCsrf = await rawApi<any>(path, { method: "PATCH", headers: { Cookie: admin, "Content-Type": "application/json" }, body });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.code, "CSRF_REQUIRED");
    const wrongCsrf = await rawApi<any>(path, { method: "PATCH", headers: { Cookie: admin, "Content-Type": "application/json", "X-CSRF-Token": "not-the-token" }, body });
    assert.equal(wrongCsrf.status, 403);
    assert.equal(wrongCsrf.body.code, "CSRF_REQUIRED");
    const notJson = await rawApi<any>(path, { method: "PATCH", headers: { Cookie: admin, "Content-Type": "text/plain", "X-CSRF-Token": csrfTokenForCookie(admin) }, body });
    assert.equal(notJson.status, 415);
    assert.equal(notJson.body.code, "JSON_REQUIRED");
    const foreign = await rawApi<any>(path, { method: "PATCH", headers: { Cookie: admin, "Content-Type": "application/json", "X-CSRF-Token": csrfTokenForCookie(admin), Origin: "https://evil.example" }, body });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.code, "ORIGIN_FORBIDDEN");
    // Nothing above changed the record.
    const listed = (await api<Employee[]>("/api/employees")).body.find((e) => e.id === emp.id);
    assert.equal(listed?.name, emp.name);
  });
});

describe("PATCH /api/employees/:id: payload validation", () => {
  let emp: Employee;
  before(async () => { emp = await createTempEmployee({ name: `Patch Payload ${Date.now()}` }); });
  after(async () => { if (emp) await deleteEmployee(emp.id); });

  it("only name, department, position, photo and photoFrom may be sent (400 naming the field)", async () => {
    for (const [field, value] of [["employeeCode", "NV-1"], ["accessLevel", "NONE"], ["id", "EMP-other"], ["registeredAt", "2020-01-01"], ["photoUrl", png1x1], ["__proto__", { polluted: true }], ["constructor", { x: 1 }], ["faceEmbedding", [0.1, 0.2]]] as const) {
      const res = await patch(emp.id, { [field as string]: value });
      assert.equal(res.status, 400, `${field}: ${res.status} ${res.text.slice(0, 120)}`);
      assert.equal(res.body.field, field, `${field} is named`);
    }
    assert.equal((await patch(emp.id, {})).status, 400, "no change is a 400");
    assert.equal((await patch(emp.id, [1, 2])).status, 400, "an array body is refused");
    assert.equal((await patch(emp.id, '"just a string"')).status, 400, "a JSON string body is refused");
    const malformed = await patch(emp.id, "{not json");
    assert.equal(malformed.status, 400, "malformed JSON is a 400, not a 500");
    assert.equal((await patch(emp.id, "null")).status, 400);
    assert.equal((await patch(emp.id, { name: 7 })).status, 400);
    assert.equal((await patch(emp.id, { department: "" })).status, 400);
    assert.equal((await patch(emp.id, { position: ["x"] })).status, 400);
  });

  it("enforces the size and format bounds: name 1-100, photo data URL <= 3,000,000 chars, one photo source", async () => {
    assert.equal((await patch(emp.id, { name: "N".repeat(101) })).status, 400);
    assert.equal((await patch(emp.id, { name: "   " })).status, 400);
    assert.equal((await patch(emp.id, { photo: "https://example.com/p.jpg" })).status, 400, "a remote URL is never fetched");
    assert.equal((await patch(emp.id, { photo: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" })).status, 400, "SVG is not a photo format");
    assert.equal((await patch(emp.id, { photo: "data:image/jpeg;base64,not base64!!" })).status, 400);
    const tooBig = await patch(emp.id, { photo: `data:image/jpeg;base64,${"A".repeat(3_000_001)}` });
    assert.equal(tooBig.status, 400, tooBig.text.slice(0, 120));
    assert.equal(tooBig.body.field, "photo");
    assert.equal((await patch(emp.id, { photo: png1x1, photoFrom: "face:SF-x" })).status, 400, "photo and photoFrom together");
    assert.equal((await patch(emp.id, { photoFrom: "SF-x" })).status, 400, "photoFrom must be face:SF-...");
    assert.equal((await patch(emp.id, { photoFrom: "face:SF-../../etc" })).status, 400);
    assert.equal((await patch(emp.id, { photoFrom: `face:SF-${"a".repeat(61)}` })).status, 400);
  });

  it("a body above the global parser limit is a 413, not a crash", async () => {
    const huge = await patch(emp.id, `{"name":"${"N".repeat(52 * 1024 * 1024)}"}`);
    assert.equal(huge.status, 413, huge.text.slice(0, 120));
    const still = await api<any>("/api/health");
    assert.equal(still.status, 200, "the gateway is still up");
  });

  it("unknown or malformed employee ids answer 404 and never 500", async () => {
    for (const id of ["EMP-does-not-exist", "../../etc/passwd", "%00", "EMP-" + "x".repeat(300), "'; DROP TABLE employees; --"]) {
      const res = await patch(id, { name: "x" });
      assert.equal(res.status, 404, `${id}: ${res.status}`);
    }
    const admin = await authenticateAs(OPERATOR_TOKEN);
    const headers = { Cookie: admin, "X-CSRF-Token": csrfTokenForCookie(admin), "Content-Type": "application/json" };
    for (const path of ["/api/employees/..", "/api/employees/%2e%2e", `/api/employees/../${emp.id}`]) {
      const res = await rawRequest("PATCH", path, headers, JSON.stringify({ name: "x" }));
      assert.ok(res.status === 404 || res.status === 400, `${path}: ${res.status} ${res.text.slice(0, 100)}`);
    }
    const listed = (await api<Employee[]>("/api/employees")).body.find((e) => e.id === emp.id);
    assert.notEqual(listed?.name, "x", "no dot-segment request reached the record");
  });
});

describe("PATCH /api/employees/:id: audit and photo confidentiality", () => {
  let emp: Employee;
  before(async () => { emp = await createTempEmployee({ name: `Patch Audit ${Date.now()}` }); });
  after(async () => { if (emp) await deleteEmployee(emp.id); });

  it("records who corrected what (actor + change, never the photo) and never returns the photo", async () => {
    const newName = `Audited ${emp.employeeCode}`;
    const fixed = await patch(emp.id, { name: newName, photo: png1x1 });
    assert.equal(fixed.status, 200, fixed.text.slice(0, 200));
    assert.doesNotMatch(fixed.text, /data:image|photoUrl|base64/);
    assert.equal(fixed.body.employee.hasPhoto, true);

    const notes = await api<any[]>("/api/notifications");
    assert.equal(notes.status, 200);
    const audit = notes.body.find((n) => typeof n.body === "string" && n.body.includes(emp.employeeCode) && n.title === "Đã sửa hồ sơ nhân viên");
    assert.ok(audit, "an audit notification for the correction exists");
    assert.match(audit.body, /^itest-operator sửa hồ sơ /, "the actor is named");
    assert.match(audit.body, /Họ tên: .+ → /);
    assert.match(audit.body, /Ảnh đăng ký/);
    assert.doesNotMatch(JSON.stringify(audit), /data:image|base64/);

    // The registration photo itself is operator+ only.
    const viewer = await authenticateAs(VIEWER_TOKEN);
    assert.equal((await apiAs(viewer, `/api/employees/${emp.id}/photo`)).status, 403);
    assert.equal((await rawApi(`/api/employees/${emp.id}/photo`)).status, 401);
  });
});
