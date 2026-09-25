/** Fail-closed authorization matrix regressions. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  api,
  authenticateAs,
  csrfTokenForCookie,
  getLockState,
  noFaceJpegDataUrl,
  rawApi,
} from "./helpers";

const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || "integration-operator-token";
const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";
const DEVICE_INGEST_TOKEN = process.env.DEVICE_INGEST_TOKEN || "integration-device-token";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "integration-internal-token";

const sensitiveReadAliases = [
  "/api/lock/status", "/lock/status", "/api/status", "/status",
  "/api/employees", "/employees", "/api/employee",
  "/api/notifications", "/notifications",
  "/api/webhook/logs", "/webhook/logs",
  "/api/door-controller/logs", "/api/door-config/logs",
  "/api/camera-streams/config", "/api/camera-streams/threads",
  "/api/config/ai", "/api/ai-config",
  "/api/face-engine/status", "/api/face-engine",
];

const sensitiveMutations = [
  ...[
    "/api/lock/unlock", "/api/lock/lock",
    "/api/notifications/clear", "/notifications/clear",
    "/api/notifications/mark-read", "/notifications/mark-read",
    "/api/webhook/config", "/webhook/config",
    "/api/door-controller/config", "/api/door-config",
    "/api/camera-streams/config", "/api/camera-streams/threads/scale",
    "/api/config/ai", "/api/ai-config",
    "/api/employees", "/employees", "/api/employees/merge", "/employees/merge",
    "/api/strangers/quick-register", "/api/strangers/register",
    "/api/strangers/merge", "/api/strangers/assign",
  ].map((path) => ({ method: "POST", path })),
  { method: "PUT", path: "/api/camera-streams/entry/streams/unknown" },
  { method: "DELETE", path: "/api/camera-streams/entry/streams/unknown" },
  { method: "DELETE", path: "/api/employees/unknown" },
  { method: "DELETE", path: "/employees/unknown" },
];

describe("complete fail-closed authorization matrix", () => {
  it("protects every sampled sensitive read alias and permits viewer reads only from allowed origins", async () => {
    for (const path of sensitiveReadAliases) {
      const unauthenticated = await rawApi(path);
      assert.equal(unauthenticated.status, 401, `${path}: ${unauthenticated.text.slice(0, 160)}`);
    }

    const viewerCookie = await authenticateAs(VIEWER_TOKEN);
    for (const path of sensitiveReadAliases) {
      const disallowed = await rawApi(path, { headers: { Cookie: viewerCookie, Origin: "http://evil.test" } });
      assert.equal(disallowed.status, 403, `${path}: ${disallowed.text.slice(0, 160)}`);
      const allowed = await rawApi(path, { headers: { Cookie: viewerCookie, Origin: "http://allowed.test" } });
      assert.notEqual(allowed.status, 401, `${path}: viewer rejected`);
      assert.notEqual(allowed.status, 403, `${path}: allowed origin rejected`);
    }
  });

  it("protects every sampled mutation alias with operator role, allowed origin, JSON, and session CSRF", async () => {
    const viewerCookie = await authenticateAs(VIEWER_TOKEN);
    const operatorCookie = await authenticateAs(OPERATOR_TOKEN);
    const csrf = csrfTokenForCookie(operatorCookie);

    for (const { method, path } of sensitiveMutations) {
      const before = await getLockState();
      assert.equal((await rawApi(path, { method, headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401, `${method} ${path}`);
      assert.equal((await rawApi(path, { method, headers: { Cookie: viewerCookie, "Content-Type": "application/json" }, body: "{}" })).status, 403, `${method} ${path}`);
      const missingCsrf = await rawApi(path, { method, headers: { Cookie: operatorCookie, Origin: "http://allowed.test", "Content-Type": "application/json" }, body: "{}" });
      assert.equal(missingCsrf.status, 403, `${path}: ${missingCsrf.text.slice(0, 160)}`);
      assert.equal(missingCsrf.body?.code, "CSRF_REQUIRED", path);
      assert.equal((await rawApi(path, { method, headers: { Cookie: operatorCookie, Origin: "http://evil.test", "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: "{}" })).status, 403, path);
      assert.equal((await rawApi(path, { method, headers: { Cookie: operatorCookie, Origin: "http://allowed.test", "Content-Type": "text/plain", "X-CSRF-Token": csrf }, body: "{}" })).status, 415, path);
      const after = await getLockState();
      assert.equal(after.state, before.state, `${path} changed the door on a rejected request`);
      assert.equal(after.lastActionAt, before.lastActionAt, `${path} changed lock audit state`);
    }
  });

  it("recovers an authenticated operator session and uses stable CSRF errors", async () => {
    const operatorCookie = await authenticateAs(OPERATOR_TOKEN);
    const session = await rawApi<any>("/api/operator/session", { headers: { Cookie: operatorCookie, Origin: "http://allowed.test" } });
    assert.equal(session.status, 200, session.text);
    assert.equal(session.body.role, "operator");
    assert.ok(session.body.csrfToken);

    const rejected = await rawApi<any>("/api/lock/lock", {
      method: "POST",
      headers: { Cookie: operatorCookie, Origin: "http://allowed.test", "Content-Type": "application/json", "X-CSRF-Token": "stale" },
      body: JSON.stringify({ source: "stale csrf probe" }),
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.code, "CSRF_REQUIRED");
  });

  it("logs out with CSRF and clears the browser session cookie", async () => {
    const operatorCookie = await authenticateAs(OPERATOR_TOKEN);
    const logout = await rawApi("/api/operator/session", {
      method: "DELETE",
      headers: {
        Cookie: operatorCookie,
        Origin: "http://allowed.test",
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfTokenForCookie(operatorCookie),
      },
      body: "{}",
    });
    assert.equal(logout.status, 200, logout.text);
    assert.match(logout.headers.get("set-cookie") || "", /Max-Age=0/i);
  });

  it("requires the internal bearer token for db-info", async () => {
    assert.equal((await rawApi("/api/system/db-info")).status, 401);
    assert.equal((await rawApi("/api/system/db-info", { headers: { Authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await rawApi("/api/system/db-info", { headers: { Authorization: `Bearer ${INTERNAL_API_TOKEN}` } })).status, 200);
  });

  it("starts production with no demo employees, logs, notifications, or stranger seeds", async () => {
    const employees = await api<any>("/api/employees");
    const logs = await api<any>("/api/logs?limit=100");
    const notifications = await api<any>("/api/notifications");
    const strangers = await api<any>("/api/strangers/clusters?limit=50");
    assert.equal(employees.status, 200);
    assert.equal(employees.text.includes("EMP-001"), false);
    assert.equal(logs.text.includes("LOG-101"), false);
    assert.equal(notifications.text.includes("NOTIF-001"), false);
    assert.equal(strangers.body.demoSeedsEnabled, false);
    assert.equal(strangers.body.clusters.some((cluster: any) => String(cluster.clusterId).includes("visitor")), false);
  });

  it("accepts recognition only through device bearer without Origin or operator session plus CSRF", async () => {
    const payload = JSON.stringify({ imageBase64: noFaceJpegDataUrl(), scanType: "ENTRY", clientEmployees: [{ id: "FORGED" }] });
    for (const path of ["/api/recognize-face", "/api/recognize-face/", "/recognize-face", "/recognize-face/", "/api/face/recognize", "/api/recognize"] ) {
      assert.equal((await rawApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload })).status, 401, path);
      assert.equal((await rawApi(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEVICE_INGEST_TOKEN}`, Origin: "http://allowed.test" }, body: payload })).status, 403, path);
      const device = await rawApi(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEVICE_INGEST_TOKEN}` }, body: payload });
      assert.notEqual(device.status, 401, `${path}: device rejected`);
      assert.notEqual(device.status, 403, `${path}: device forbidden`);
    }

    const operatorCookie = await authenticateAs(OPERATOR_TOKEN);
    const operator = await rawApi("/api/recognize-face", {
      method: "POST",
      headers: { Cookie: operatorCookie, Origin: "http://allowed.test", "Content-Type": "application/json", "X-CSRF-Token": csrfTokenForCookie(operatorCookie) },
      body: payload,
    });
    assert.notEqual(operator.status, 401);
    assert.notEqual(operator.status, 403);

    const employees = await api<any>("/api/employees");
    assert.equal(employees.text.includes("FORGED"), false, "recognition mutated roster from clientEmployees");
  });
});

describe("legacy /config/ai alias", () => {
  it("rejects reads and writes of the recognition config without a session", async () => {
    for (const path of ["/config/ai", "/config/ai/"]) {
      const read = await rawApi(path);
      assert.equal(read.status, 401, `GET ${path} must require a session`);
    }
    // A write attempt must be refused before the handler runs. The body would
    // drop the accept threshold to near zero if it ever reached the handler.
    const write = await rawApi("/config/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localModel: { similarityThreshold: 0.01 } }),
    });
    assert.ok([401, 403].includes(write.status), `POST /config/ai returned ${write.status}`);
  });
});
