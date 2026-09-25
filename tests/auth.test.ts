/**
 * Unit tests for accounts, passwords and the permission table
 * (src/server/auth.ts). The table is the single source of truth the API
 * boundary consults, so it is pinned here row by row.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalApiPath,
  hashPassword,
  lockRemainingMs,
  normalizeUsername,
  requiredRoleFor,
  roleAtLeast,
  validatePassword,
  validateUsername,
  verifyPassword,
  UserRole,
} from "../src/server/auth";

describe("passwords", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery");
    assert.match(stored, /^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
    assert.equal(await verifyPassword("correct horse battery", stored), true);
    assert.equal(await verifyPassword("correct horse batterY", stored), false);
    assert.equal(await verifyPassword("", stored), false);
  });

  it("salts every hash, so equal passwords never share a stored value", async () => {
    const [a, b] = await Promise.all([hashPassword("same password here"), hashPassword("same password here")]);
    assert.notEqual(a, b);
  });

  it("fails closed on malformed or foreign stored values", async () => {
    for (const bad of ["", "plain", "bcrypt$x$y", "scrypt$0$8$1$abc$def", "scrypt$16384$8$1$$"]) {
      assert.equal(await verifyPassword("anything", bad), false, bad);
    }
  });
});

describe("roles", () => {
  it("nests strictly: admin > operator > viewer", () => {
    const order: UserRole[] = ["viewer", "operator", "admin"];
    for (const [i, have] of order.entries()) {
      for (const [j, need] of order.entries()) {
        assert.equal(roleAtLeast(have, need), i >= j, `${have} vs ${need}`);
      }
    }
  });
});

describe("permission table", () => {
  // [method, path, least role] - the owner's specification, row by row.
  const rows: Array<[string, string, UserRole]> = [
    // viewer: view every log and history screen
    ["GET", "/api/logs", "viewer"],
    ["GET", "/api/logs/LOG-1/image", "viewer"],
    ["GET", "/api/access-logs", "viewer"],
    ["GET", "/api/strangers/clusters", "viewer"],
    ["GET", "/api/employees", "viewer"],
    ["GET", "/api/camera-streams/config", "viewer"],
    ["GET", "/api/events", "viewer"],
    ["GET", "/logs", "viewer"],
    ["POST", "/api/operator/password", "viewer"],

    // operator: add camera streams
    ["POST", "/api/camera-streams/exit/streams", "operator"],
    ["PUT", "/api/camera-streams/entry/streams/entry-101", "operator"],
    ["DELETE", "/api/camera-streams/exit/streams/exit-501", "operator"],
    ["POST", "/api/camera-streams/config", "operator"],
    ["POST", "/api/camera-streams/entry/watch", "operator"],
    ["POST", "/api/camera-streams/test-stream", "operator"],
    ["POST", "/api/camera-streams/scan-rtsp", "operator"],
    // operator: approve new members
    ["POST", "/api/employees", "operator"],
    ["POST", "/employees", "operator"],
    ["POST", "/api/employee", "operator"],
    ["POST", "/api/strangers/quick-register", "operator"],
    ["POST", "/api/strangers/merge", "operator"],
    ["POST", "/api/strangers/dismiss", "operator"],
    ["POST", "/api/strangers/restore", "operator"],
    // operator: register faces
    ["POST", "/api/employees/EMP-1/templates", "operator"],
    ["POST", "/api/employees/EMP-1/templates/capture", "operator"],
    ["DELETE", "/api/employees/EMP-1/templates/FT-1", "operator"],
    ["POST", "/api/recognize-face", "operator"],
    // operator: manage departments and positions
    ["GET", "/api/org", "viewer"],
    ["GET", "/api/org/departments", "viewer"],
    ["POST", "/api/org/departments", "operator"],
    ["PUT", "/api/org/positions/ORG-1", "operator"],
    ["DELETE", "/api/org/departments/ORG-1", "operator"],

    // admin only: the door, the integrations, the engine, accounts, destructive edits
    ["POST", "/api/lock/unlock", "admin"],
    ["POST", "/api/lock/lock", "admin"],
    ["POST", "/api/door-controller/config", "admin"],
    ["POST", "/api/door-config/test", "admin"],
    ["GET", "/api/door-controller/config", "admin"],
    ["GET", "/api/door-config", "admin"],
    ["POST", "/api/webhook/config", "admin"],
    ["GET", "/api/webhook/config", "admin"],
    ["GET", "/webhook/config", "admin"],
    ["POST", "/api/config/ai", "admin"],
    ["POST", "/config/ai", "admin"],
    ["DELETE", "/api/employees/EMP-1", "admin"],
    ["POST", "/api/employees/merge", "admin"],
    ["POST", "/api/logs/clear", "admin"],
    ["POST", "/logs/clear", "admin"],
    ["POST", "/api/camera-streams/threads/scale", "admin"],
    ["POST", "/api/camera-streams/benchmark", "admin"],
    ["GET", "/api/users", "admin"],
    ["POST", "/api/users", "admin"],
    ["PUT", "/api/users/USR-1", "admin"],
    ["DELETE", "/api/users/USR-1", "admin"],
    ["GET", "/api/system/ip-info", "admin"],
  ];

  for (const [method, path, role] of rows) {
    it(`${method} ${path} needs ${role}`, () => {
      assert.equal(requiredRoleFor(method, path), role);
    });
  }

  it("defaults an unlisted write to admin and an unlisted read to viewer (fail-closed)", () => {
    assert.equal(requiredRoleFor("POST", "/api/some-route-added-next-month"), "admin");
    assert.equal(requiredRoleFor("DELETE", "/api/anything/else"), "admin");
    assert.equal(requiredRoleFor("GET", "/api/some-route-added-next-month"), "viewer");
  });

  it("does not let a stream-shaped path on an unknown gate slip through as operator", () => {
    assert.equal(requiredRoleFor("POST", "/api/camera-streams/side-door/streams"), "admin");
  });

  it("canonicalises legacy spellings and trailing slashes", () => {
    assert.equal(canonicalApiPath("/employees/"), "/api/employees");
    assert.equal(canonicalApiPath("/api/employee/EMP-1"), "/api/employees/EMP-1");
    assert.equal(canonicalApiPath("/api/door-config/test/"), "/api/door-controller/test");
    assert.equal(canonicalApiPath("/api/door-config"), "/api/door-controller/config");
    assert.equal(canonicalApiPath("/api/door-config/logs"), "/api/door-controller/logs");
    assert.equal(canonicalApiPath("/api/access-logs?page=2"), "/api/logs");
  });
});

describe("validation and lockout", () => {
  it("accepts reasonable usernames and rejects the rest", () => {
    for (const ok of ["huy", "nam.vo", "phong-it", "op_01"]) assert.equal(validateUsername(ok), null, ok);
    for (const bad of ["", "ab", "Huy", "-dash", "has space", "a".repeat(33), "tên"]) {
      assert.notEqual(validateUsername(bad), null, bad);
    }
    assert.equal(normalizeUsername("  Nam.Vo "), "nam.vo");
  });

  it("requires passwords of 10-128 characters", () => {
    assert.notEqual(validatePassword("short"), null);
    assert.notEqual(validatePassword(12345678901), null);
    assert.notEqual(validatePassword("x".repeat(129)), null);
    assert.equal(validatePassword("ten chars!"), null);
  });

  it("reports a lock only while it is in the future", () => {
    const now = Date.parse("2026-09-25T10:00:00Z");
    assert.equal(lockRemainingMs(null, now), 0);
    assert.equal(lockRemainingMs("2026-09-25T09:59:00Z", now), 0);
    assert.equal(lockRemainingMs("2026-09-25T10:05:00Z", now), 5 * 60 * 1000);
    assert.equal(lockRemainingMs("not a date", now), 0);
  });
});
