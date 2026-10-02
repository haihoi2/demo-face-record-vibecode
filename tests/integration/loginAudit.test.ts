/**
 * Sign-in hardening and audit (owner 2026-10-02: "harden login, audit login
 * history for user"). GET /api/users/login-events (admin) lists every sign-in,
 * failure, lock, sign-out and password change, newest first. Large anonymous
 * request bodies are refused before they are parsed. The per-address rate
 * limit is unit-tested (tests/loginRateLimit.test.ts); this gateway runs with a
 * high limit so the suite's own sign-ins are not throttled.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { apiAs, authenticateAs, loginWithPassword, rawApi } from "./helpers";

const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || "integration-operator-token";
const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";
const PASSWORD = "audit pass 12345";
const RUN = Date.now().toString(36);

let admin = "";
let userId = "";
const username = `audit-${RUN}`;

const events = async (query = "") => {
  const res = await apiAs<any>(admin, `/api/users/login-events${query}`);
  assert.equal(res.status, 200, res.text.slice(0, 200));
  return res.body;
};

/** Audit rows are written in the background: wait (up to 3 s) until `ok(page)` holds. */
const eventsWhen = async (query: string, ok: (page: any) => boolean) => {
  let page = await events(query);
  for (let i = 0; i < 30 && !ok(page); i++) {
    await new Promise((r) => setTimeout(r, 100));
    page = await events(query);
  }
  return page;
};

describe("sign-in audit", () => {
  before(async () => {
    admin = await authenticateAs(OPERATOR_TOKEN);
    const created = await apiAs<any>(admin, "/api/users", {
      method: "POST",
      body: JSON.stringify({ username, role: "viewer", password: PASSWORD, displayName: "Audit Test" }),
    });
    assert.equal(created.status, 201, created.text.slice(0, 200));
    userId = created.body.user.id;
  });

  after(async () => {
    if (userId) await apiAs(admin, `/api/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
  });

  it("records failures, a success and a sign-out for the account, newest first, with address and browser", async () => {
    assert.equal((await loginWithPassword(username, "wrong password 1")).status, 401);
    const ok = await loginWithPassword(username, PASSWORD);
    assert.equal(ok.status, 200, ok.text.slice(0, 200));
    assert.equal((await apiAs(ok.cookie, "/api/operator/session", { method: "DELETE" })).status, 200);

    const page = await eventsWhen(`?userId=${encodeURIComponent(userId)}`, (p) => p.events[0]?.kind === "sign-out");
    const kinds = page.events.map((e: any) => `${e.kind}${e.reason ? `:${e.reason}` : ""}`);
    assert.deepEqual(kinds.slice(0, 3), ["sign-out", "sign-in", "sign-in-failed:bad-password"]);
    for (const e of page.events.slice(0, 3)) {
      assert.equal(e.username, username);
      assert.equal(e.method, "account");
      assert.ok(e.ip, "client address recorded");
      assert.match(e.id, /^LE-/);
    }
    assert.doesNotMatch(JSON.stringify(page), /wrong password|audit pass|csrf|cookie/i, "no secrets in the audit");
  });

  it("records unknown accounts without storing a password typed as a username, and bad setup tokens", async () => {
    await loginWithPassword(`nobody-${RUN}`, "x".repeat(12));
    await loginWithPassword("my secret Pa55word!", "x".repeat(12));
    await rawApi("/api/operator/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "not-the-token" }) });
    const page = await eventsWhen("?kind=sign-in-failed&limit=20", (p) => p.events.some((e: any) => e.reason === "bad-token"));
    const reasons = page.events.map((e: any) => `${e.reason}|${e.username ?? ""}|${e.method}`);
    assert.ok(reasons.includes(`unknown-user|nobody-${RUN}|account`), reasons.join(", "));
    assert.ok(reasons.includes("unknown-user|(không hợp lệ)|account"));
    assert.ok(reasons.includes("bad-token||token"));
    assert.doesNotMatch(JSON.stringify(page), /Pa55word|not-the-token/);
  });

  it("locks after repeated failures and records it", async () => {
    for (let i = 0; i < 5; i++) await loginWithPassword(username, `wrong password ${i}`);
    const refused = await loginWithPassword(username, PASSWORD);
    assert.equal(refused.status, 429);
    const page = await eventsWhen(`?userId=${encodeURIComponent(userId)}&kind=locked`, (p) => p.events.length >= 2);
    assert.ok(page.events.length >= 2, "the lock and the refused attempt");
    assert.ok(page.events.every((e: any) => e.reason === "account-locked"));
    // Unlock for the remaining tests.
    await apiAs(admin, `/api/users/${encodeURIComponent(userId)}`, { method: "PUT", body: JSON.stringify({ unlock: true }) });
  });

  it("pages with an opaque cursor and validates filters", async () => {
    const first = await events("?limit=2");
    assert.equal(first.events.length, 2);
    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor);
    const second = await events(`?limit=2&before=${encodeURIComponent(first.nextCursor)}`);
    assert.ok(second.events.length > 0);
    assert.ok(!second.events.some((e: any) => first.events.some((f: any) => f.id === e.id)), "no overlap");
    assert.ok(second.events[0].at <= first.events[1].at);
    assert.equal((await apiAs(admin, "/api/users/login-events?kind=bogus")).status, 400);
  });

  it("is admin only", async () => {
    assert.equal((await rawApi("/api/users/login-events")).status, 401);
    const viewer = await authenticateAs(VIEWER_TOKEN);
    assert.equal((await apiAs(viewer, "/api/users/login-events")).status, 403);
  });
});

describe("large anonymous bodies", () => {
  it("are refused before parsing; signed-in callers still get through to the route", async () => {
    const big = JSON.stringify({ pad: "x".repeat(200 * 1024) });
    const anon = await rawApi("/api/employees", { method: "POST", headers: { "Content-Type": "application/json" }, body: big });
    assert.equal(anon.status, 401);
    assert.equal(anon.body?.code, "AUTH_REQUIRED");
    const signedIn = await apiAs<any>(admin, "/api/employees", { method: "POST", body: big });
    assert.notEqual(signedIn.status, 401, "an authenticated large body reaches the route (which then validates it)");
    const small = await rawApi("/api/operator/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "x" }) });
    assert.equal(small.status, 401, "small sign-in bodies are unaffected");
  });
});
