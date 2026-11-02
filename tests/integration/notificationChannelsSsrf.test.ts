/**
 * P3b notification channels as an SSRF surface. Every spelling of an internal
 * destination is refused at save time with a DEST_* code and nothing is
 * stored; a destination the guard refuses at send time sends nothing; the
 * channel URL (a secret) is never echoed - not in the create/patch answer,
 * not in the list, not in the test-send answer, not in the webhook log.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { BASE_URL, api, apiAs, authenticateAs, csrfTokenForCookie, postJson, rawApi } from "./helpers";
import { rawRequest } from "./rawHttp";

const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || "integration-operator-token";
const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";
const SECRET = `ssrf${randomBytes(8).toString("hex")}`;
const DEST = /^DEST_[A-Z_]+$/;

const send = (path: string, method: string, body?: unknown) =>
  api<any>(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function channelCount(): Promise<number> {
  const list = await api<any>("/api/notification-channels");
  assert.equal(list.status, 200);
  return list.body.channels.length;
}

describe("notification channels: internal destinations are refused at save", () => {
  const INTERNAL: Array<[string, RegExp]> = [
    [`https://127.0.0.1/hooks/${SECRET}`, /^DEST_LOOPBACK$/],
    [`https://127.1/hooks/${SECRET}`, /^DEST_LOOPBACK$/],
    [`https://2130706433/hooks/${SECRET}`, /^DEST_LOOPBACK$/],
    [`https://0x7f000001/hooks/${SECRET}`, /^DEST_LOOPBACK$/],
    [`https://localhost/hooks/${SECRET}`, /^DEST_LOOPBACK$/],
    [`https://[::1]/hooks/${SECRET}`, /^DEST_LOOPBACK$/],
    [`https://[::ffff:127.0.0.1]/hooks/${SECRET}`, /^DEST_LOOPBACK$/],
    [`https://0.0.0.0/hooks/${SECRET}`, /^DEST_UNSPECIFIED$/],
    [`https://[::]/hooks/${SECRET}`, /^DEST_UNSPECIFIED$/],
    [`https://169.254.169.254/latest/${SECRET}`, /^DEST_(METADATA|LINK_LOCAL)$/],
    [`https://169.254.1.1/hooks/${SECRET}`, /^DEST_LINK_LOCAL$/],
    [`https://metadata.google.internal/hooks/${SECRET}`, /^DEST_METADATA$/],
    [`https://10.0.0.5/hooks/${SECRET}`, /^DEST_(PRIVATE_WEBHOOK|NOT_ALLOWED)$/],
    [`https://172.16.4.4/hooks/${SECRET}`, /^DEST_(PRIVATE_WEBHOOK|NOT_ALLOWED)$/],
    [`https://192.168.6.52:8080/hooks/${SECRET}`, /^DEST_(PRIVATE_WEBHOOK|NOT_ALLOWED)$/],
    [`https://100.64.0.1/hooks/${SECRET}`, /^DEST_(PRIVATE_WEBHOOK|NOT_ALLOWED)$/],
    [`http://example.com/hooks/${SECRET}`, /^DEST_SCHEME$/],
    [`ftp://example.com/hooks/${SECRET}`, /^DEST_SCHEME$/],
    [`file:///etc/passwd#${SECRET}`, /^DEST_(SCHEME|BAD_URL)$/],
    [`https://exa mple.com/${SECRET}`, /^DEST_BAD_URL$/],
  ];

  it("each spelling answers 400 with a DEST_ code, echoes no secret path and stores nothing", async () => {
    const before = await channelCount();
    for (const [url, code] of INTERNAL) {
      const res = await postJson<any>("/api/notification-channels", { name: "SSRF probe", url });
      assert.equal(res.status, 400, `${url}: ${res.status} ${res.text.slice(0, 160)}`);
      assert.match(String(res.body.code), code, url);
      assert.equal(res.body.field, "url");
      assert.doesNotMatch(res.text, new RegExp(SECRET), `${url}: the refusal echoed the secret path`);
    }
    assert.equal(await channelCount(), before, "a refused channel was stored");
  });

  it("the gateway's own host name (as the browser reaches it) is refused: DEST_SELF / loopback / private", async () => {
    const host = new URL(BASE_URL).hostname;
    const res = await postJson<any>("/api/notification-channels", { name: "self", url: `https://${host}/hooks/${SECRET}` });
    assert.equal(res.status, 400, res.text.slice(0, 200));
    assert.match(String(res.body.code), /^DEST_(SELF|LOOPBACK|PRIVATE_WEBHOOK|NOT_ALLOWED)$/);
    assert.doesNotMatch(res.text, new RegExp(SECRET));
  });

  it("input bounds: name 1-60, URL <= 2048, enabled boolean, no empty change", async () => {
    const ok = `https://channel-ssrf.invalid/hooks/${SECRET}`;
    assert.equal((await postJson("/api/notification-channels", { name: "x".repeat(61), url: ok })).status, 400);
    assert.equal((await postJson("/api/notification-channels", { name: "  ", url: ok })).status, 400);
    assert.equal((await postJson("/api/notification-channels", { name: ["a"], url: ok })).status, 400);
    assert.equal((await postJson("/api/notification-channels", { name: "x", url: `https://example.com/${"a".repeat(2049)}` })).status, 400);
    assert.equal((await postJson("/api/notification-channels", { name: "x", url: { href: ok } })).status, 400);
    assert.equal((await postJson("/api/notification-channels", { name: "x", url: ok, enabled: "yes" })).status, 400);
    assert.equal((await postJson("/api/notification-channels", "not json")).status, 400);
    for (const id of ["CH-not-a-uuid", "%00", "CH-" + "0".repeat(36) + "x"]) {
      assert.equal((await send(`/api/notification-channels/${id}`, "PATCH", { name: "x" })).status, 400, `PATCH ${id}`);
      assert.equal((await send(`/api/notification-channels/${id}`, "DELETE")).status, 400, `DELETE ${id}`);
      assert.equal((await send(`/api/notification-channels/${id}/test`, "POST", {})).status, 400, `test ${id}`);
    }
    // A literal dot segment as the id (sent byte-for-byte; fetch would resolve it away).
    const admin = await authenticateAs(OPERATOR_TOKEN);
    const headers = { Cookie: admin, "X-CSRF-Token": csrfTokenForCookie(admin), "Content-Type": "application/json" };
    for (const path of ["/api/notification-channels/..", "/api/notification-channels/%2e%2e", "/api/notification-channels/../eton-default"]) {
      const res = await rawRequest("PATCH", path, headers, JSON.stringify({ name: "x" }));
      assert.ok(res.status === 400 || res.status === 404, `PATCH ${path}: ${res.status} ${res.text.slice(0, 100)}`);
      const del = await rawRequest("DELETE", path, headers);
      assert.ok(del.status === 400 || del.status === 404, `DELETE ${path}: ${del.status}`);
    }
    assert.equal((await send("/api/notification-channels/CH-00000000-0000-0000-0000-000000000000/test", "POST", {})).status, 404);
    const unknownRoute = await send("/api/notification-routes", "PUT", { everything: "eton-default" });
    assert.equal(unknownRoute.status, 400);
    assert.equal(unknownRoute.body.code, "ROUTE_UNKNOWN");
    assert.equal((await send("/api/notification-routes", "PUT", {})).status, 400);
  });
});

describe("notification channels: a stored destination refused at send time, and URL confidentiality", () => {
  let id = "";
  before(async () => {
    const created = await postJson<any>("/api/notification-channels", { name: "Send-time probe", url: `https://itest-sec-channel.invalid/hooks/${SECRET}` });
    assert.equal(created.status, 200, created.text.slice(0, 300));
    assert.equal(created.body.warning?.code, "DEST_UNRESOLVED", "an unresolvable host is saved with a warning");
    id = created.body.channel.id;
    assert.doesNotMatch(created.text, new RegExp(SECRET));
  });
  after(async () => {
    if (id) {
      await send("/api/notification-routes", "PUT", { stranger: "eton-default", presence: "eton-default", presenceHealth: "eton-default" });
      await send(`/api/notification-channels/${id}`, "DELETE");
    }
  });

  it("the test send dials nothing, reports the DEST_ code, and neither the answer nor the webhook log carries the URL", async () => {
    const test = await postJson<any>(`/api/notification-channels/${id}/test`, {});
    assert.equal(test.status, 200, test.text.slice(0, 200));
    assert.equal(test.body.success, false);
    assert.match(String(test.body.error), /^DEST_UNRESOLVED: /);
    assert.doesNotMatch(test.text, new RegExp(SECRET));
    const logs = await api<any>("/api/webhook/logs");
    assert.equal(logs.status, 200);
    assert.doesNotMatch(logs.text, new RegExp(SECRET), "the webhook log carries the masked URL only");
    const entry = (Array.isArray(logs.body) ? logs.body : logs.body.logs || []).find((l: any) => l.code === "DEST_UNRESOLVED" && String(l.url || "").includes("itest-sec-channel.invalid"));
    assert.ok(entry, "the refused send is logged with its code");
    assert.equal(entry.success, false);
  });

  it("changing the URL to an internal destination is refused and leaves the stored URL untouched", async () => {
    const before = (await api<any>("/api/notification-channels")).body.channels.find((c: any) => c.id === id);
    for (const url of ["https://127.0.0.1/hooks/x", "https://169.254.169.254/x", "http://example.com/x", "https://10.9.8.7/x"]) {
      const res = await send(`/api/notification-channels/${id}`, "PATCH", { url });
      assert.equal(res.status, 400, `${url}: ${res.status}`);
      assert.match(String(res.body.code), DEST);
    }
    const after = (await api<any>("/api/notification-channels")).body.channels.find((c: any) => c.id === id);
    assert.equal(after.urlMasked, before.urlMasked);
    assert.equal(after.updatedAt, before.updatedAt, "nothing was written");
    assert.doesNotMatch(JSON.stringify(after), new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(after), /"url"/, "the view has urlMasked only");
  });

  it("routing to the channel is admin + CSRF; a viewer or a session without CSRF cannot redirect alerts", async () => {
    const viewer = await authenticateAs(VIEWER_TOKEN);
    assert.equal((await apiAs(viewer, "/api/notification-routes", { method: "PUT", body: JSON.stringify({ presence: id }) })).status, 403);
    const admin = await authenticateAs(OPERATOR_TOKEN);
    const noCsrf = await rawApi<any>("/api/notification-routes", { method: "PUT", headers: { Cookie: admin, "Content-Type": "application/json" }, body: JSON.stringify({ presence: id }) });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.code, "CSRF_REQUIRED");
    const foreign = await rawApi<any>("/api/notification-routes", { method: "PUT", headers: { Cookie: admin, "Content-Type": "application/json", "X-CSRF-Token": csrfTokenForCookie(admin), Origin: "https://evil.example" }, body: JSON.stringify({ presence: id }) });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.code, "ORIGIN_FORBIDDEN");
    const routes = (await api<any>("/api/notification-channels")).body.routes;
    assert.notEqual(routes.presence, id, "no refused request moved a route");
  });
});
