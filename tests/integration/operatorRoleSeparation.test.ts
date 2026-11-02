/**
 * Admin / operator / viewer separation on the routes added since 2026-10-07,
 * proven with REAL named accounts of each role (the environment token session
 * is an admin and cannot show that an operator is refused).
 *
 * Routes:
 *   PATCH  /api/employees/:id                                  admin
 *   PUT    /api/presence/settings/:gateId                      admin  (GET: operator)
 *   *      /api/notification-channels, /api/notification-routes admin
 *   GET    /api/strangers/sharpness/summary, /blur-reports     admin  (sample: operator)
 *   POST   /api/strangers/retire-non-faces                     admin
 *   POST   /api/strangers/clusters/:id/split|remove-photos     operator
 *   POST   /api/logs/:id/blur-report, GET /api/logs/blur-state operator
 *   DELETE /api/employees/:id/templates/:templateId            operator
 *   GET    /api/logs/:id/image, /recording, /api/face-engine/status  viewer
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { apiAs, rawApi } from "./helpers";
import { createRoleUser, type RoleUser } from "./roleFixtures";

const json = (method: string, body: unknown = {}) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const ADMIN_ONLY: Array<[string, string, unknown?]> = [
  ["PATCH", "/api/employees/EMP-itest-role", { name: "x" }],
  ["PUT", "/api/presence/settings/entry", { alertWindowSeconds: 60 }],
  ["GET", "/api/notification-channels"],
  ["POST", "/api/notification-channels", { name: "x", url: "https://example.invalid/hooks/x" }],
  ["PATCH", "/api/notification-channels/CH-00000000-0000-0000-0000-000000000000", { name: "x" }],
  ["DELETE", "/api/notification-channels/CH-00000000-0000-0000-0000-000000000000"],
  ["POST", "/api/notification-channels/eton-default/test", {}],
  ["PUT", "/api/notification-routes", { presence: "eton-default" }],
  ["GET", "/api/strangers/sharpness/summary"],
  ["GET", "/api/strangers/blur-reports"],
  ["POST", "/api/strangers/retire-non-faces", { logIds: ["LOG-x"] }],
  ["GET", "/api/users"],
  ["GET", "/api/system/ip-info"],
  ["POST", "/api/camera-streams/entry/pipeline-mode", { mode: "off" }],
];

const OPERATOR_ONLY: Array<[string, string, unknown?]> = [
  ["POST", "/api/strangers/clusters/cluster-itest/split", {}],
  ["POST", "/api/strangers/clusters/cluster-itest/remove-photos", {}],
  ["POST", "/api/logs/LOG-itest/blur-report", {}],
  ["DELETE", "/api/logs/LOG-itest/blur-report", {}],
  ["GET", "/api/logs/blur-state?ids=LOG-itest"],
  ["GET", "/api/strangers/sharpness/sample"],
  ["POST", "/api/strangers/faces/SF-itest/rating", { rating: "sharp" }],
  ["DELETE", "/api/employees/EMP-itest-role/templates/FT-itest", {}],
  ["GET", "/api/presence/settings"],
  ["GET", "/api/presence/events"],
];

const VIEWER_READS = ["/api/face-engine/status", "/api/logs/LOG-itest-role/image", "/api/logs/LOG-itest-role/recording", "/api/presence/status"];

describe("role separation with named accounts", () => {
  let operator: RoleUser;
  let viewer: RoleUser;
  before(async () => {
    operator = await createRoleUser("operator");
    viewer = await createRoleUser("viewer");
  });
  after(async () => {
    await operator?.dispose();
    await viewer?.dispose();
  });

  it("an operator account is refused on every admin route (403 ROLE_REQUIRED naming admin)", async () => {
    for (const [method, path, body] of ADMIN_ONLY) {
      const res = await apiAs<any>(operator.cookie, path, method === "GET" ? {} : json(method, body));
      assert.equal(res.status, 403, `${method} ${path}: ${res.status} ${res.text.slice(0, 120)}`);
      assert.equal(res.body?.code, "ROLE_REQUIRED", `${method} ${path}`);
      assert.equal(res.body?.requiredRole, "admin", `${method} ${path}`);
    }
  });

  it("a viewer account is refused on every operator route; the operator passes the role gate", async () => {
    for (const [method, path, body] of OPERATOR_ONLY) {
      const asViewer = await apiAs<any>(viewer.cookie, path, method === "GET" ? {} : json(method, body));
      assert.equal(asViewer.status, 403, `viewer ${method} ${path}: ${asViewer.status}`);
      assert.equal(asViewer.body?.code, "ROLE_REQUIRED", `viewer ${method} ${path}`);
      const asOperator = await apiAs<any>(operator.cookie, path, method === "GET" ? {} : json(method, body));
      assert.notEqual(asOperator.status, 403, `operator ${method} ${path} must pass the role gate (got ${asOperator.status})`);
      assert.notEqual(asOperator.status, 401, `operator ${method} ${path}`);
      assert.ok(asOperator.status < 500, `operator ${method} ${path} answered ${asOperator.status}: ${asOperator.text.slice(0, 120)}`);
    }
  });

  it("every one of these routes needs a session: anonymous is 401 before any validation", async () => {
    for (const [method, path, body] of [...ADMIN_ONLY, ...OPERATOR_ONLY]) {
      const res = await rawApi<any>(path, method === "GET" ? {} : json(method, body));
      assert.equal(res.status, 401, `${method} ${path}: ${res.status}`);
      assert.equal(res.body?.code, "AUTH_REQUIRED", `${method} ${path}`);
    }
    for (const path of VIEWER_READS) assert.equal((await rawApi(path)).status, 401, path);
  });

  it("viewer reads pass the role gate on the image, recording, engine-status and presence-status routes", async () => {
    for (const path of VIEWER_READS) {
      const res = await apiAs<any>(viewer.cookie, path);
      assert.ok(![401, 403].includes(res.status), `${path}: ${res.status}`);
      assert.ok(res.status < 500, `${path}: ${res.status}`);
    }
  });

  it(
    "GET /api/network/ip-info is as sensitive as its /api/system/ip-info alias (finding S-01)",
    { todo: "today the /api/network/ alias falls to the viewer default, dials api.ipify.org + ifconfig.me and returns the gateway's public egress IP" },
    async () => {
      const res = await apiAs<any>(viewer.cookie, "/api/network/ip-info");
      assert.equal(res.status, 403, `viewer got ${res.status}`);
    },
  );
});
