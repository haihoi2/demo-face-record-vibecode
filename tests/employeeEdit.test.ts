import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { describeEmployeeChanges, parseEmployeeEdit } from "../src/server/employeeEdit";
import { employeeEditError, employeeEditPatch, employeeEditRequest } from "../src/utils/employeeEdit";

const png = "data:image/png;base64,iVBORw0KGgo=";

describe("employee profile correction (server)", () => {
  it("accepts name, department, position and an uploaded photo only", () => {
    assert.deepEqual(parseEmployeeEdit({ name: "  Đặng  Thị Bảo Linh ", department: "OutBound" }), { ok: true, value: { name: "Đặng Thị Bảo Linh", department: "OutBound" } });
    assert.equal(parseEmployeeEdit({ employeeCode: "NV-1" }).ok, false, "the code is not edited here");
    assert.equal(parseEmployeeEdit({ accessLevel: "ALL_ACCESS" }).ok, false);
    assert.equal(parseEmployeeEdit({ name: "" }).ok, false);
    assert.equal(parseEmployeeEdit({ name: "x".repeat(101) }).ok, false);
    assert.equal(parseEmployeeEdit({ photo: "https://example.com/p.jpg" }).ok, false, "never a remote URL");
    assert.equal(parseEmployeeEdit({ photo: "/api/logs/LOG-1/image" }).ok, false);
    assert.equal(parseEmployeeEdit({ photo: png }).ok, true);
    assert.equal(parseEmployeeEdit({}).ok, false);
  });
  it("describes the change for the audit record, never the photo", () => {
    const before = { name: "Linh", department: "A", position: "P" };
    assert.deepEqual(describeEmployeeChanges(before, { ...before, name: "Bảo Linh", department: "B" }, true),
      ["Họ tên: Linh → Bảo Linh", "Bộ phận: A → B", "Ảnh đăng ký: ảnh mới"]);
    assert.deepEqual(describeEmployeeChanges(before, before, false), []);
  });
});

describe("employee profile correction (screen)", () => {
  const original = { name: "Linh", department: "A", position: "P" };
  it("sends only what changed", () => {
    assert.deepEqual(employeeEditPatch(original, { name: " Linh ", department: "A", position: "P", photo: "" }), {});
    assert.deepEqual(employeeEditPatch(original, { name: "Bảo Linh", department: "B", position: "P", photo: png }), { name: "Bảo Linh", department: "B", photo: png });
    const r = employeeEditRequest("EMP-1", { name: "x" });
    assert.equal(r.url, "/api/employees/EMP-1");
    assert.equal(r.init.method, "PATCH");
  });
  it("checks before sending", () => {
    assert.ok(employeeEditError({ name: " ", department: "A", position: "P", photo: "" }));
    assert.equal(employeeEditError({ name: "A", department: "A", position: "P", photo: "" }), null);
  });
});

describe("wiring", () => {
  it("admin only, CSRF, catalog-checked, audited; the button is admin-only", () => {
    const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const auth = readFileSync(new URL("../src/server/auth.ts", import.meta.url), "utf8");
    const ui = readFileSync(new URL("../src/components/EmployeeRegistration.tsx", import.meta.url), "utf8");
    assert.match(src, /app\.patch\(\["\/api\/employees\/:id", "\/api\/employees\/:id\/"\], requireOperatorRole\("admin"\), requireCsrf,/);
    assert.match(src, /resolveOrgName\("departments", edit\.department/);
    assert.match(src, /title: "Đã sửa hồ sơ nhân viên"/);
    assert.match(auth, /methods: \["PATCH"\], pattern: \/\^\\\/api\\\/employees\\\/\[\^\/\]\+\$\/, role: "admin"/);
    assert.match(ui, /\{isAdmin && \(\n\s+<button\n\s+type="button"\n\s+id=\{`btn-edit-employee-/);
  });
});
