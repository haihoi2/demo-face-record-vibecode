/**
 * Named operator accounts and the three-role permission model, black-box
 * against a running gateway.
 *
 *   admin     everything
 *   operator  view history, manage camera streams, approve members, register faces
 *   viewer    view only
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { apiAs, authenticateAs, listEmployees, loginWithPassword, rawApi } from "./helpers";

const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || "integration-operator-token";
const PASSWORD = "integration pass 1";
const run = Date.now().toString(36);
const names = { admin: `it-adm-${run}`, operator: `it-op-${run}`, viewer: `it-view-${run}` };

let bootstrap = "";                                  // admin session from the environment token
const ids: Record<string, string> = {};

async function createUser(username: string, role: string, password = PASSWORD) {
  return apiAs<any>(bootstrap, "/api/users", {
    method: "POST",
    body: JSON.stringify({ username, displayName: `ITEST ${role}`, role, password }),
  });
}

async function signIn(username: string, password = PASSWORD): Promise<string> {
  const res = await loginWithPassword(username, password);
  assert.equal(res.status, 200, `login ${username}: ${res.text.slice(0, 200)}`);
  return res.cookie;
}

const updateUser = (id: string, patch: Record<string, unknown>) =>
  apiAs<any>(bootstrap, `/api/users/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(patch) });

describe("operator accounts", () => {
  before(async () => {
    bootstrap = await authenticateAs(OPERATOR_TOKEN);
    for (const [role, username] of Object.entries(names)) {
      const res = await createUser(username, role);
      assert.equal(res.status, 201, `create ${role}: ${res.text.slice(0, 200)}`);
      ids[role] = res.body.user.id;
    }
  });

  after(async () => {
    for (const id of Object.values(ids)) {
      await apiAs(bootstrap, `/api/users/${encodeURIComponent(id)}`, { method: "DELETE" });
    }
  });

  it("never returns a password hash from any account endpoint", async () => {
    const list = await apiAs<any>(bootstrap, "/api/users");
    assert.equal(list.status, 200);
    assert.ok(list.body.users.some((u: any) => u.username === names.operator));
    assert.doesNotMatch(list.text, /passwordHash|scrypt\$/);
    const login = await loginWithPassword(names.viewer, PASSWORD);
    assert.doesNotMatch(login.text, /passwordHash|scrypt\$/);
  });

  it("rejects duplicate usernames, weak passwords and unknown roles", async () => {
    assert.equal((await createUser(names.operator, "operator")).status, 409);
    assert.equal((await createUser(`it-weak-${run}`, "viewer", "short")).status, 400);
    assert.equal((await createUser(`it-role-${run}`, "superuser")).status, 400);
    assert.equal((await createUser("Bad Name", "viewer")).status, 400);
  });

  it("signs each role in with username and password", async () => {
    for (const [role, username] of Object.entries(names)) {
      const res = await loginWithPassword(username.toUpperCase(), PASSWORD); // usernames are case-insensitive
      assert.equal(res.status, 200, res.text.slice(0, 200));
      assert.equal(res.body.role, role);
      assert.equal(res.body.authMethod, "account");
      assert.equal(res.body.username, username);
    }
  });

  it("answers an unknown username exactly like a wrong password", async () => {
    const unknown = await loginWithPassword(`nobody-${run}`, PASSWORD);
    const wrong = await loginWithPassword(names.viewer, "definitely not it");
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.deepEqual(unknown.body, wrong.body);
  });

  describe("permissions", () => {
    it("viewer: reads history, changes nothing", async () => {
      const viewer = await signIn(names.viewer);
      assert.equal((await apiAs(viewer, "/api/logs?limit=5")).status, 200);
      assert.equal((await apiAs(viewer, "/api/strangers/clusters")).status, 200);
      for (const [method, path] of [
        ["POST", "/api/camera-streams/exit/streams"],
        ["POST", "/api/employees"],
        ["POST", "/api/strangers/dismiss"],
        ["POST", "/api/lock/unlock"],
      ]) {
        const res = await apiAs<any>(viewer, path, { method, body: "{}" });
        assert.equal(res.status, 403, `${method} ${path} -> ${res.status}`);
        assert.equal(res.body?.code, "ROLE_REQUIRED");
      }
      assert.equal((await apiAs(viewer, "/api/users")).status, 403);
    });

    it("operator: manages camera streams", async () => {
      const operator = await signIn(names.operator);
      const created = await apiAs<any>(operator, "/api/camera-streams/exit/streams", {
        method: "POST",
        body: JSON.stringify({
          label: `ITEST operator ${run}`, sourceType: "RTSP",
          rtspUrl: "rtsp://127.0.0.1:1/Streaming/Channels/4097", rtspTransport: "TCP", enabled: false, priority: 92,
        }),
      });
      assert.equal(created.status, 201, created.text.slice(0, 200));
      const removed = await apiAs(operator, `/api/camera-streams/exit/streams/${encodeURIComponent(created.body.stream.id)}`, { method: "DELETE" });
      assert.equal(removed.status, 200);
    });

    it("operator: is authorised to add members and register faces (fails validation, not permission)", async () => {
      const operator = await signIn(names.operator);
      const member = await apiAs(operator, "/api/employees", { method: "POST", body: JSON.stringify({}) });
      assert.equal(member.status, 400, "an empty employee must fail validation, proving the call was authorised");
      const [someone] = await listEmployees();
      if (someone) {
        const face = await apiAs(operator, `/api/employees/${encodeURIComponent(someone.id)}/templates`, {
          method: "POST", body: JSON.stringify({ image: "not an image" }),
        });
        assert.ok(![401, 403].includes(face.status), `face registration refused with ${face.status}`);
      }
    });

    it("operator: cannot open the door, change engine or door settings, or manage accounts", async () => {
      const operator = await signIn(names.operator);
      for (const [method, path] of [
        ["POST", "/api/lock/unlock"],
        ["POST", "/api/config/ai"],
        ["POST", "/config/ai"],
        ["POST", "/api/door-controller/config"],
        ["POST", "/api/logs/clear"],
        ["POST", "/api/employees/merge"],
        ["POST", "/api/users"],
      ]) {
        const res = await apiAs(operator, path, { method, body: "{}" });
        assert.equal(res.status, 403, `${method} ${path} -> ${res.status}`);
      }
      assert.equal((await apiAs(operator, "/api/users")).status, 403);
      assert.equal((await apiAs(operator, "/api/door-controller/config")).status, 403);
    });

    it("admin account: manages accounts", async () => {
      const admin = await signIn(names.admin);
      assert.equal((await apiAs(admin, "/api/users")).status, 200);
    });
  });

  describe("changes take effect on the next request", () => {
    it("disabling ends live sessions, and re-enabling does not revive them", async () => {
      const cookie = await signIn(names.viewer);
      assert.equal((await apiAs(cookie, "/api/logs?limit=1")).status, 200);
      assert.equal((await updateUser(ids.viewer, { disabled: true })).status, 200);
      assert.equal((await apiAs(cookie, "/api/logs?limit=1")).status, 401);
      assert.equal((await loginWithPassword(names.viewer, PASSWORD)).status, 401, "a disabled account cannot sign in");
      assert.equal((await updateUser(ids.viewer, { disabled: false })).status, 200);
      assert.equal((await apiAs(cookie, "/api/logs?limit=1")).status, 401, "the old cookie stays dead");
      assert.equal((await loginWithPassword(names.viewer, PASSWORD)).status, 200);
    });

    it("demoting an operator removes their write access immediately", async () => {
      const cookie = await signIn(names.operator);
      assert.equal((await updateUser(ids.operator, { role: "viewer" })).status, 200);
      const res = await apiAs(cookie, "/api/camera-streams/exit/streams", { method: "POST", body: "{}" });
      assert.equal(res.status, 403);
      assert.equal((await updateUser(ids.operator, { role: "operator" })).status, 200);
    });

    it("an admin password reset signs the account out everywhere", async () => {
      const cookie = await signIn(names.operator);
      const reset = await updateUser(ids.operator, { password: "a brand new pass" });
      assert.equal(reset.status, 200);
      assert.equal((await apiAs(cookie, "/api/logs?limit=1")).status, 401);
      assert.equal((await loginWithPassword(names.operator, PASSWORD)).status, 401);
      await signIn(names.operator, "a brand new pass");
      assert.equal((await updateUser(ids.operator, { password: PASSWORD })).status, 200);
    });

    it("changing your own password keeps this session and ends the others", async () => {
      const here = await signIn(names.viewer);
      const elsewhere = await signIn(names.viewer);
      const changed = await apiAs<any>(here, "/api/operator/password", {
        method: "POST", body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "viewer new pass 1" }),
      });
      assert.equal(changed.status, 200, changed.text.slice(0, 200));
      const refreshed = changed.headers.get("set-cookie")?.split(";", 1)[0] || "";
      assert.ok(refreshed, "the caller gets a re-issued session");
      assert.equal((await apiAs(elsewhere, "/api/logs?limit=1")).status, 401);
      assert.equal((await rawApi("/api/logs?limit=1", { headers: { Cookie: refreshed } })).status, 200);

      const wrongCurrent = await apiAs<any>(here, "/api/operator/password", {
        method: "POST", body: JSON.stringify({ currentPassword: "not the password", newPassword: "whatever else 1" }),
      });
      assert.ok([401, 403].includes(wrongCurrent.status));
      assert.equal((await updateUser(ids.viewer, { password: PASSWORD })).status, 200);
    });
  });

  describe("lockout", () => {
    it("locks after five wrong passwords, even for the right one, until an admin unlocks", async () => {
      for (let i = 0; i < 5; i++) {
        assert.equal((await loginWithPassword(names.admin, `wrong ${i} attempt`)).status, 401);
      }
      const locked = await loginWithPassword(names.admin, PASSWORD);
      assert.equal(locked.status, 429);
      assert.equal(locked.body.code, "ACCOUNT_LOCKED");
      assert.equal((await updateUser(ids.admin, { unlock: true })).status, 200);
      assert.equal((await loginWithPassword(names.admin, PASSWORD)).status, 200);
    });
  });

  describe("self-protection", () => {
    it("an admin cannot disable, demote or delete the account they are signed in with", async () => {
      const admin = await signIn(names.admin);
      const put = (patch: object) =>
        apiAs<any>(admin, `/api/users/${encodeURIComponent(ids.admin)}`, { method: "PUT", body: JSON.stringify(patch) });
      assert.equal((await put({ disabled: true })).status, 409);
      assert.equal((await put({ role: "viewer" })).status, 409);
      assert.equal((await apiAs(admin, `/api/users/${encodeURIComponent(ids.admin)}`, { method: "DELETE" })).status, 409);
    });
  });
});
