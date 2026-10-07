/**
 * P3b: notification channels, alert routing and per-gate presence settings
 * (contract docs/plans/2026-10-07-p3b-contract.md). Uses a `.invalid` webhook
 * host: accepted by the guard at save time, never reachable, so nothing is sent.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { api, apiAs, authenticateAs, postJson, rawApi } from "./helpers";

const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";
const SECRET = `p3b${randomBytes(6).toString("hex")}`;
const SINK = `https://channel-sink.invalid/hooks-itest/${SECRET}`;

const send = (path: string, method: string, body?: unknown) =>
  api<any>(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("notification channels: access", () => {
  it("admin only; anonymous 401, viewer 403", async () => {
    assert.equal((await rawApi("/api/notification-channels")).status, 401);
    const viewer = await authenticateAs(VIEWER_TOKEN);
    assert.equal((await apiAs(viewer, "/api/notification-channels")).status, 403);
    assert.equal((await apiAs(viewer, "/api/notification-channels", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
    assert.equal((await apiAs(viewer, "/api/presence/settings")).status, 403);
  });
});

describe("notification channels: lifecycle", () => {
  let id = "";
  after(async () => {
    await send("/api/notification-routes", "PUT", { stranger: "eton-default", presence: "eton-default", presenceHealth: "eton-default" });
    if (id) await send(`/api/notification-channels/${id}`, "DELETE");
  });

  it("lists the built-in channel first and routes everything to it by default", async () => {
    const res = await api<any>("/api/notification-channels");
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.equal(res.body.channels[0].id, "eton-default");
    assert.equal(res.body.channels[0].builtIn, true);
    for (const r of ["stranger", "presence", "presenceHealth"]) assert.ok(res.body.routes[r]);
  });

  it("refuses bad input and URLs the webhook policy refuses", async () => {
    assert.equal((await postJson<any>("/api/notification-channels", { url: SINK })).status, 400, "no name");
    const http = await postJson<any>("/api/notification-channels", { name: "HTTP", url: "http://channel-sink.invalid/x" });
    assert.equal(http.status, 400);
    assert.equal(http.body.code, "DEST_SCHEME");
    const loop = await postJson<any>("/api/notification-channels", { name: "Loop", url: "https://127.0.0.1/x" });
    assert.equal(loop.status, 400);
    assert.match(String(loop.body.code), /^DEST_/);
  });

  it("creates, routes, refuses to delete while routed, and never returns the URL", async () => {
    const created = await postJson<any>("/api/notification-channels", { name: "Bảo vệ (itest)", url: SINK });
    assert.equal(created.status, 200, created.text.slice(0, 300));
    id = created.body.channel.id;
    assert.match(id, /^CH-[0-9a-f-]{36}$/);
    assert.doesNotMatch(created.text, new RegExp(SECRET));
    assert.match(created.body.channel.urlMasked, /^https:\/\/channel-sink\.invalid\/…\//);

    const list = await api<any>("/api/notification-channels");
    assert.doesNotMatch(list.text, new RegExp(SECRET), "the list never carries the URL");

    assert.equal((await send("/api/notification-routes", "PUT", { presence: "CH-00000000-0000-0000-0000-000000000000" })).status, 400);
    const routed = await send("/api/notification-routes", "PUT", { presence: id });
    assert.equal(routed.status, 200, routed.text.slice(0, 200));
    assert.equal(routed.body.routes.presence, id);
    const inUse = await send(`/api/notification-channels/${id}`, "DELETE");
    assert.equal(inUse.status, 409);
    assert.equal(inUse.body.code, "CHANNEL_IN_USE");

    const renamed = await send(`/api/notification-channels/${id}`, "PATCH", { name: "Bảo vệ ca đêm", enabled: false });
    assert.equal(renamed.status, 200, renamed.text.slice(0, 200));
    assert.equal(renamed.body.channel.enabled, false);
    assert.deepEqual(renamed.body.channel.usedFor, ["presence"]);

    const test = await postJson<any>(`/api/notification-channels/${id}/test`, {});
    assert.equal(test.status, 200);
    assert.equal(test.body.success, false, "an unreachable .invalid host fails, and says so");
    assert.ok(test.body.error);

    assert.equal((await send("/api/notification-routes", "PUT", { presence: "eton-default" })).status, 200);
    const deleted = await send(`/api/notification-channels/${id}`, "DELETE");
    assert.equal(deleted.status, 200, deleted.text.slice(0, 200));
    assert.equal((await send(`/api/notification-channels/${id}`, "DELETE")).status, 404);
    id = "";
  });

  it("the built-in channel is edited in the Webhook settings, not here", async () => {
    const patch = await send("/api/notification-channels/eton-default", "PATCH", { name: "x" });
    assert.equal(patch.status, 400);
    assert.equal(patch.body.code, "CHANNEL_BUILT_IN");
    assert.equal((await send("/api/notification-channels/eton-default", "DELETE")).status, 400);
    assert.equal((await send("/api/notification-channels/CH-00000000-0000-0000-0000-000000000000", "PATCH", { name: "x" })).status, 404);
  });
});

describe("per-gate presence settings", () => {
  after(async () => {
    await send("/api/presence/settings/entry", "PUT", { workingHours: null, alertWindowSeconds: null });
  });

  it("lists every gate with values and where they come from", async () => {
    const res = await api<any>("/api/presence/settings");
    assert.equal(res.status, 200, res.text.slice(0, 200));
    const entry = res.body.gates.find((g: any) => g.gateId === "entry");
    assert.ok(entry);
    assert.equal(entry.mode, "off");
    assert.equal(entry.source.workingHours, "env");
  });

  it("validates, saves over .env, and clears back to .env with null", async () => {
    assert.equal((await send("/api/presence/settings/entry", "PUT", { workingHours: "7-19" })).status, 400);
    assert.equal((await send("/api/presence/settings/entry", "PUT", { mode: "loud" })).status, 400);
    assert.equal((await send("/api/presence/settings/entry", "PUT", { zone: 1 })).status, 400);
    assert.equal((await send("/api/presence/settings/no-such-gate", "PUT", { alertWindowSeconds: 600 })).status, 404);

    const saved = await send("/api/presence/settings/entry", "PUT", { workingHours: "06:00-19:00", alertWindowSeconds: 600 });
    assert.equal(saved.status, 200, saved.text.slice(0, 200));
    assert.equal(saved.body.gate.workingHours, "06:00-19:00");
    assert.equal(saved.body.gate.alertWindowSeconds, 600);
    assert.equal(saved.body.gate.source.workingHours, "saved");
    assert.ok(saved.body.gate.updatedBy);

    const cleared = await send("/api/presence/settings/entry", "PUT", { workingHours: null });
    assert.equal(cleared.body.gate.workingHours, "07:00-19:00");
    assert.equal(cleared.body.gate.source.workingHours, "env");
    assert.equal(cleared.body.gate.alertWindowSeconds, 600, "other saved values stay");
  });
});
