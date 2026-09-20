/**
 * Stranger-cluster endpoints: listing, roster search, and merge validation.
 *
 * A temporary employee is created for the search/merge checks and removed
 * again in `after`. Pre-existing employees are never deleted or modified.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  api,
  createTempEmployee,
  deleteEmployee,
  listEmployees,
  postJson,
  uniqueTestCode,
  type Employee,
} from "./helpers";

describe("GET /api/strangers/clusters", () => {
  it("returns a success envelope with a clusters array", async () => {
    const res = await api("/api/strangers/clusters");
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body?.success, true);
    assert.ok(Array.isArray(res.body.clusters));
    assert.equal(res.body.totalClusters, res.body.clusters.length);
    assert.equal(typeof res.body.totalUnregisteredLogs, "number");
    for (const cluster of res.body.clusters) {
      assert.equal(typeof cluster.clusterId, "string");
      assert.ok(Array.isArray(cluster.photos), `cluster ${cluster.clusterId} has no photos array`);
    }
  });
});

describe("strangers roster search and merge", () => {
  let fixture: Employee;
  let rosterBefore: string[];

  before(async () => {
    rosterBefore = (await listEmployees()).map((e) => e.id).sort();
    fixture = await createTempEmployee({ name: `Integration Search Fixture ${Date.now()}` });
  });

  after(async () => {
    if (fixture?.id) await deleteEmployee(fixture.id);
    const rosterAfter = (await listEmployees()).map((e) => e.id).sort();
    assert.deepEqual(rosterAfter, rosterBefore, "roster must be exactly as it was before the suite");
  });

  it("GET /api/employees is a bare array that contains the fixture", async () => {
    const employees = await listEmployees();
    assert.ok(employees.some((e) => e.id === fixture.id));
  });

  it("search-employees?q=<code> finds the fixture by employee code", async () => {
    const res = await api(`/api/strangers/search-employees?q=${encodeURIComponent(fixture.employeeCode.toLowerCase())}`);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body?.success, true);
    assert.equal(res.body.query, fixture.employeeCode.toLowerCase());
    assert.ok(Array.isArray(res.body.employees));
    assert.equal(res.body.total, res.body.employees.length);
    assert.ok(res.body.employees.some((e: Employee) => e.id === fixture.id), "fixture not found by code");
  });

  it("search-employees?q=<name fragment> finds the fixture by name", async () => {
    const res = await api(`/api/strangers/search-employees?q=${encodeURIComponent("integration search fixture")}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.employees.some((e: Employee) => e.id === fixture.id));
  });

  it("search-employees with an unmatched query returns an empty list", async () => {
    const res = await api(`/api/strangers/search-employees?q=${encodeURIComponent(uniqueTestCode("NOMATCH"))}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 0);
    assert.deepEqual(res.body.employees, []);
  });

  it("search-employees without q returns at most the default limit of 20", async () => {
    const res = await api("/api/strangers/search-employees");
    assert.equal(res.status, 200);
    assert.ok(res.body.employees.length <= 20);
    assert.ok(res.body.employees.length > 0);
  });

  it("search-employees honours limit=1", async () => {
    const res = await api("/api/strangers/search-employees?limit=1");
    assert.equal(res.status, 200);
    assert.equal(res.body.employees.length, 1);
  });

  it("POST /api/strangers/merge without an employee is a 400", async () => {
    const res = await postJson("/api/strangers/merge", { clusterLogIds: ["LOG-X"] });
    assert.equal(res.status, 400, res.text.slice(0, 300));
    assert.equal(res.body?.success, false);
  });

  it("POST /api/strangers/merge with an unknown employee is a 404", async () => {
    const res = await postJson("/api/strangers/merge", {
      employeeCode: uniqueTestCode("GHOST"),
      clusterLogIds: ["LOG-X"],
    });
    assert.equal(res.status, 404, res.text.slice(0, 300));
    assert.equal(res.body?.success, false);
  });

  it("POST /api/strangers/merge with an unknown employeeId is a 404", async () => {
    const res = await postJson("/api/strangers/merge", {
      employeeId: "EMP-DOES-NOT-EXIST",
      clusterLogIds: ["LOG-X"],
    });
    assert.equal(res.status, 404, res.text.slice(0, 300));
  });

  it("POST /api/strangers/merge with empty clusterLogIds is a 400", async () => {
    const res = await postJson("/api/strangers/merge", {
      employeeCode: fixture.employeeCode,
      clusterLogIds: [],
    });
    assert.equal(res.status, 400, res.text.slice(0, 300));
    assert.equal(res.body?.success, false);
  });

  it("POST /api/strangers/merge with missing clusterLogIds is a 400", async () => {
    const res = await postJson("/api/strangers/merge", { employeeId: fixture.id });
    assert.equal(res.status, 400, res.text.slice(0, 300));
  });

  it("POST /api/strangers/merge skips log ids that do not exist and updates nothing", async () => {
    const bogus = [`LOG-ITEST-${Date.now()}-a`, `LOG-ITEST-${Date.now()}-b`];
    const res = await postJson("/api/strangers/merge", {
      employeeCode: fixture.employeeCode,
      clusterLogIds: bogus,
    });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body?.success, true);
    assert.equal(res.body.employee?.id, fixture.id);
    assert.equal(res.body.updatedLogsCount, 0);
    assert.deepEqual(res.body.skippedLogIds, bogus);
    assert.equal(res.body.photoUpdated, false);
    assert.equal(res.body.clusterId, null);
    assert.equal(res.body.clusterResolved, false);
  });

  it("merge never touches the door lock", async () => {
    const lock = await api("/api/lock/status");
    assert.equal(lock.status, 200);
    assert.equal(lock.body?.state, "LOCKED");
  });
});
