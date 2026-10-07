/**
 * P3b notification channels and routing (src/server/notificationChannels.ts),
 * and per-gate presence settings (src/server/presence/gateSettings.ts).
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BUILT_IN_CHANNEL_ID,
  DEFAULT_ROUTES,
  channelViews,
  maskWebhookUrl,
  parseChannelInput,
  parseRoutesPatch,
  readChannels,
  readRoutes,
  routeTarget,
  type NotificationChannel,
} from "../src/server/notificationChannels";
import {
  applyPresenceGatePatch,
  effectivePresenceGateSettings,
  parsePresenceGatePatch,
  presenceSettingsImpact,
  type PresenceGateValues,
} from "../src/server/presence/gateSettings";

const ID = "CH-0f6b8c1e-3a7d-4c2b-9e1f-1234567890ab";
const channel = (over: Partial<NotificationChannel> = {}): NotificationChannel => ({
  id: ID, name: "Bảo vệ", type: "eton-webhook", url: "https://chat.example.vn/hooks/abcdEFGH1234secret",
  enabled: true, createdAt: "2026-10-07T00:00:00Z", createdBy: "admin", updatedAt: "2026-10-07T00:00:00Z", updatedBy: "admin", ...over,
});
const builtIn = { url: "https://chat.eton.example/hooks/BUILTINsecretXYZ9", enabled: true };

describe("channel URLs are never shown", () => {
  it("masks to scheme, host and the last 4 characters", () => {
    assert.equal(maskWebhookUrl("https://chat.example.vn/hooks/abcdEFGH1234secret"), "https://chat.example.vn/…/cret");
    assert.equal(maskWebhookUrl("https://chat.example.vn/h"), "https://chat.example.vn/…");
    assert.equal(maskWebhookUrl("not a url"), "(URL không hợp lệ)");
    assert.equal(maskWebhookUrl(""), "");
  });
  it("views carry only the masked URL", () => {
    const views = channelViews([channel()], builtIn, DEFAULT_ROUTES);
    assert.equal(views[0].id, BUILT_IN_CHANNEL_ID);
    assert.equal(views[0].builtIn, true);
    assert.deepEqual(views[0].usedFor, ["stranger", "presence", "presenceHealth"]);
    assert.deepEqual(views[1].usedFor, []);
    assert.doesNotMatch(JSON.stringify(views), /secret|BUILTIN/);
  });
});

describe("reading stored documents", () => {
  it("drops malformed channels and falls back to the built-in route for unknown ids", () => {
    const stored = { channels: [channel(), { id: "x", name: "bad", url: "https://a" }, null, { ...channel(), id: "CH-not-a-uuid" }] };
    assert.deepEqual(readChannels(stored).map((c) => c.id), [ID]);
    assert.deepEqual(readChannels(undefined), []);
    const routes = readRoutes({ stranger: ID, presence: "CH-gone", presenceHealth: 7 }, new Set([ID]));
    assert.deepEqual(routes, { stranger: ID, presence: BUILT_IN_CHANNEL_ID, presenceHealth: BUILT_IN_CHANNEL_ID });
  });
});

describe("input validation", () => {
  it("create needs a name and a URL; update needs something", () => {
    assert.equal(parseChannelInput({ url: "https://x.vn/h" }, "create").ok, false);
    assert.equal(parseChannelInput({ name: "A" }, "create").ok, false);
    assert.equal(parseChannelInput({}, "update").ok, false);
    const ok = parseChannelInput({ name: "  Bảo   vệ ", url: " https://x.vn/h ", enabled: false }, "create");
    assert.deepEqual(ok, { ok: true, value: { name: "Bảo vệ", url: "https://x.vn/h", enabled: false } });
    assert.equal(parseChannelInput({ name: "x".repeat(61) }, "update").ok, false);
    assert.equal(parseChannelInput({ enabled: "yes" }, "update").ok, false);
    assert.equal(parseChannelInput({ url: 5 }, "update").ok, false);
  });
  it("routes: known alert types and channels only", () => {
    const known = new Set([ID]);
    assert.deepEqual(parseRoutesPatch({ presence: ID }, known), { ok: true, patch: { presence: ID } });
    assert.equal((parseRoutesPatch({ presence: "CH-gone" }, known) as any).code, "CHANNEL_UNKNOWN");
    assert.equal((parseRoutesPatch({ doors: ID }, known) as any).code, "ROUTE_UNKNOWN");
    assert.equal((parseRoutesPatch({}, known) as any).code, "ROUTE_EMPTY");
  });
});

describe("where an alert goes", () => {
  it("the routed channel, or nothing when it is off", () => {
    const routes = { ...DEFAULT_ROUTES, presence: ID };
    assert.equal(routeTarget("presence", routes, [channel()], builtIn)?.name, "Bảo vệ");
    assert.equal(routeTarget("stranger", routes, [channel()], builtIn)?.builtIn, true);
    assert.equal(routeTarget("presence", routes, [channel({ enabled: false })], builtIn), null);
    assert.equal(routeTarget("stranger", routes, [], { ...builtIn, enabled: false }), null);
  });
});

describe("per-gate presence settings", () => {
  const env: PresenceGateValues = {
    mode: "live", workingHours: "07:00-19:00", minSecondsWorking: 3, minSecondsAfterHours: 1, alertWindowSeconds: 300, alertHoldSeconds: 15,
  };
  it("saved values override .env field by field; invalid saved values are ignored", () => {
    const { values, source } = effectivePresenceGateSettings(env, { workingHours: "06:00-19:00", alertWindowSeconds: 9999 as any });
    assert.equal(values.workingHours, "06:00-19:00");
    assert.equal(source.workingHours, "saved");
    assert.equal(values.alertWindowSeconds, 300, "out of range -> .env");
    assert.equal(source.alertWindowSeconds, "env");
  });
  it("a change is validated; null clears a saved value", () => {
    assert.equal(parsePresenceGatePatch({ mode: "on" }).ok, false);
    assert.equal(parsePresenceGatePatch({ workingHours: "7-19" }).ok, false);
    assert.equal(parsePresenceGatePatch({ minSecondsAfterHours: 0.1 }).ok, false);
    assert.equal(parsePresenceGatePatch({ alertHoldSeconds: 31 }).ok, false);
    assert.equal(parsePresenceGatePatch({ zone: 1 }).ok, false);
    const p = parsePresenceGatePatch({ workingHours: "06:00 - 19:00", alertWindowSeconds: 600.4, mode: null });
    assert.ok(p.ok);
    if (!p.ok) return;
    assert.deepEqual(p.patch, { workingHours: "06:00-19:00", alertWindowSeconds: 600, mode: null });
    const saved = applyPresenceGatePatch({ mode: "shadow", minSecondsWorking: 5 }, p.patch, "admin", "2026-10-07T00:00:00Z");
    assert.deepEqual(saved, { minSecondsWorking: 5, workingHours: "06:00-19:00", alertWindowSeconds: 600, updatedAt: "2026-10-07T00:00:00Z", updatedBy: "admin" });
  });
  it("what a change restarts", () => {
    assert.deepEqual(presenceSettingsImpact(env, { ...env, mode: "shadow" }), { stream: false, detector: false }, "shadow <-> live: nothing");
    assert.deepEqual(presenceSettingsImpact(env, { ...env, mode: "off" }), { stream: true, detector: false });
    assert.deepEqual(presenceSettingsImpact(env, { ...env, workingHours: "06:00-19:00" }), { stream: false, detector: true });
    assert.deepEqual(presenceSettingsImpact(env, { ...env, alertWindowSeconds: 600 }), { stream: false, detector: false });
  });
});

describe("wiring", () => {
  const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const auth = readFileSync(new URL("../src/server/auth.ts", import.meta.url), "utf8");
  it("every alert type is sent to its routed channel", () => {
    assert.match(src, /const strangerTarget = currentRouteTarget\("stranger"\);/);
    assert.match(src, /fetch\(strangerTarget\.url, \{/);
    assert.match(src, /const target = currentRouteTarget\(route\);/);
    assert.match(src, /presenceHealthPayload\(t\.notice, gateLabelOf\(g\), new Date\(\)\.toISOString\(\), presencePanelLink\(\)\), "presenceHealth"\);/);
  });
  it("channels are admin-only; presence settings are read by operators and changed by admins", () => {
    assert.match(auth, /\\\/api\\\/notification-channels\$\/, role: "admin"/);
    assert.match(auth, /\\\/api\\\/presence\\\/settings\$\/, role: "operator"/);
    assert.match(src, /app\.post\("\/api\/notification-channels", requireOperatorRole\("admin"\), requireCsrf,/);
    assert.match(src, /app\.put\("\/api\/presence\/settings\/:gateId", requireOperatorRole\("admin"\), requireCsrf,/);
  });
  it("a new or changed channel URL passes the webhook destination guard", () => {
    assert.equal((src.match(/destinationSaveCheck\(parsed\.value\.url!?, NET_POLICY\.webhook, "url"\)/g) || []).length, 2);
  });
  it("presence on/off is part of the stream key, so switching restarts the stream", () => {
    assert.match(src, /PIPELINE_FPS, presenceOn\]\)/);
  });
});
