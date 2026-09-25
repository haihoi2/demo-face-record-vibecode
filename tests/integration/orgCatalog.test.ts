/**
 * Managed departments (phòng ban) and positions (chức vụ): who may edit them,
 * and how the catalog keeps the employee roster consistent.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, apiAs, authenticateAs, deleteEmployee, ensureFixtureCatalog, loginWithPassword, noFaceJpegDataUrl, postJson, uniqueTestCode } from "./helpers";

const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || "integration-operator-token";
const run = Date.now().toString(36);
const PASSWORD = "integration pass 1";
const cleanupEmployees: string[] = [];
const cleanupEntries: Array<[string, string]> = [];
const accounts: string[] = [];

async function addEntry(kind: string, name: string) {
  const res = await postJson<any>(`/api/org/${kind}`, { name });
  assert.equal(res.status, 201, res.text.slice(0, 200));
  cleanupEntries.push([kind, res.body.item.id]);
  return res.body.item;
}

async function addEmployee(department: string, position: string) {
  const res = await postJson<any>("/api/employees", {
    name: `ITEST Org ${run}`, employeeCode: uniqueTestCode(), department, position,
    photoUrl: noFaceJpegDataUrl(), accessLevel: "ALL_ACCESS",
  });
  if (res.status === 200 && res.body?.employee?.id) cleanupEmployees.push(res.body.employee.id);
  return res;
}

let accountSeq = 0;
async function sessionFor(role: string) {
  const bootstrap = await authenticateAs(OPERATOR_TOKEN);
  const username = `it-org-${role.slice(0, 4)}-${run}-${++accountSeq}`;
  const created = await apiAs<any>(bootstrap, "/api/users", {
    method: "POST", body: JSON.stringify({ username, role, password: PASSWORD }),
  });
  assert.equal(created.status, 201, created.text.slice(0, 200));
  accounts.push(created.body.user.id);
  const login = await loginWithPassword(username, PASSWORD);
  assert.equal(login.status, 200);
  return login.cookie;
}

describe("organisation catalog", () => {
  before(() => ensureFixtureCatalog());

  after(async () => {
    for (const id of cleanupEmployees) await deleteEmployee(id).catch(() => {});
    for (const [kind, id] of cleanupEntries) await api(`/api/org/${kind}/${id}`, { method: "DELETE" });
    const bootstrap = await authenticateAs(OPERATOR_TOKEN);
    for (const id of accounts) await apiAs(bootstrap, `/api/users/${id}`, { method: "DELETE" });
  });

  it("is seeded, and every signed-in role can read it", async () => {
    const viewer = await sessionFor("viewer");
    const res = await apiAs<any>(viewer, "/api/org");
    assert.equal(res.status, 200);
    assert.ok(res.body.departments.length > 0 && res.body.positions.length > 0);
    assert.ok(res.body.departments.every((d: any) => typeof d.employeeCount === "number"));
  });

  it("operator can add entries; viewer cannot", async () => {
    const viewer = await sessionFor("viewer");
    const denied = await apiAs(viewer, "/api/org/departments", { method: "POST", body: JSON.stringify({ name: `ITEST denied ${run}` }) });
    assert.equal(denied.status, 403);

    const operator = await sessionFor("operator");
    const made = await apiAs<any>(operator, "/api/org/positions", { method: "POST", body: JSON.stringify({ name: `ITEST Trưởng ca ${run}` }) });
    assert.equal(made.status, 201, made.text.slice(0, 200));
    cleanupEntries.push(["positions", made.body.item.id]);
  });

  it("refuses duplicates regardless of case and spacing", async () => {
    const entry = await addEntry("departments", `ITEST Phòng Dup ${run}`);
    const dup = await postJson(`/api/org/departments`, { name: `  itest   phòng DUP ${run} ` });
    assert.equal(dup.status, 409);
    assert.ok(entry.id);
  });

  it("new employees must use an active catalog entry, stored in its catalog spelling", async () => {
    const dept = await addEntry("departments", `ITEST Phòng Kho ${run}`);
    const pos = await addEntry("positions", `ITEST Thủ kho ${run}`);

    const unknown = await addEmployee(`Không Có Phòng Này ${run}`, pos.name);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, "UNKNOWN_DEPARTMENT");

    const loose = await addEmployee(dept.name.toUpperCase(), pos.name);
    assert.equal(loose.status, 200, loose.text.slice(0, 200));
    assert.equal(loose.body.employee.department, dept.name, "stored with the catalog's spelling");

    await api(`/api/org/departments/${dept.id}`, { method: "PUT", body: JSON.stringify({ active: false }) });
    const inactive = await addEmployee(dept.name, pos.name);
    assert.equal(inactive.status, 400, "a deactivated entry is not offered for new employees");
    await api(`/api/org/departments/${dept.id}`, { method: "PUT", body: JSON.stringify({ active: true }) });
  });

  it("renaming carries every employee with it", async () => {
    const dept = await addEntry("departments", `ITEST Phòng Cũ ${run}`);
    const created = await addEmployee(dept.name, "Fixture");
    assert.equal(created.status, 200, created.text.slice(0, 200));

    const renamed = await api<any>(`/api/org/departments/${dept.id}`, {
      method: "PUT", body: JSON.stringify({ name: `ITEST Phòng Mới ${run}` }),
    });
    assert.equal(renamed.status, 200, renamed.text.slice(0, 200));
    assert.equal(renamed.body.renamedEmployees, 1);

    const roster = await api<any[]>("/api/employees");
    const employee = roster.body.find((e: any) => e.id === created.body.employee.id);
    assert.equal(employee.department, `ITEST Phòng Mới ${run}`);
  });

  it("will not delete an entry in use, but deletes an unused one", async () => {
    const dept = await addEntry("departments", `ITEST Phòng Dùng ${run}`);
    const created = await addEmployee(dept.name, "Fixture");
    assert.equal(created.status, 200);

    const blocked = await api<any>(`/api/org/departments/${dept.id}`, { method: "DELETE" });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, "IN_USE");
    assert.equal(blocked.body.employeeCount, 1);

    const spare = await postJson<any>(`/api/org/positions`, { name: `ITEST Thừa ${run}` });
    assert.equal(spare.status, 201);
    const gone = await api(`/api/org/positions/${spare.body.item.id}`, { method: "DELETE" });
    assert.equal(gone.status, 200);
  });
});
