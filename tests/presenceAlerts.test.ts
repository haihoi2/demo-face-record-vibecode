/**
 * Presence alerts (P3a, owner 2026-10-05): after hours + no face, decided after
 * a short hold, first alert at once, then at most one grouped message per
 * window per gate; text and a login link only.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PresenceAlertBatcher,
  presenceAlertEligible,
  presenceAlertPayload,
  presenceHealthPayload,
  presenceHealthTransition,
  type PresenceAlertEvent,
} from "../src/server/presence/alerts";

const MIN = 60_000;
const ev = (id: string, over: Partial<PresenceAlertEvent> = {}): PresenceAlertEvent => ({
  id, gateId: "entry", startedAt: "2026-10-04T23:20:15.000Z", inViewMs: 4200, peakPersons: 1,
  period: "after-hours", faceOutcome: "none", ...over,
});

describe("who is alerted", () => {
  it("after hours with no face only", () => {
    assert.equal(presenceAlertEligible({ period: "after-hours", faceOutcome: "none" }), true);
    assert.equal(presenceAlertEligible({ period: "working", faceOutcome: "none" }), false, "working hours: recorded only");
    assert.equal(presenceAlertEligible({ period: "after-hours", faceOutcome: "employee" }), false, "a recognised employee");
    assert.equal(presenceAlertEligible({ period: "after-hours", faceOutcome: "stranger" }), false, "already a stranger alert");
  });

  it("an event is decided on its latest version after the hold", () => {
    const b = new PresenceAlertBatcher({ windowMs: 5 * MIN, holdMs: 3000 });
    b.offer(ev("PE-1"), 0);
    assert.deepEqual(b.due(2999), [], "still on hold");
    b.offer(ev("PE-1", { faceOutcome: "employee" }), 1500); // the door scan recognised the person
    assert.deepEqual(b.due(3000), [], "an employee after all: no alert");
    b.offer(ev("PE-1"), 4000);
    assert.deepEqual(b.due(10_000), [], "decided once; later updates change nothing");
  });
});

describe("grouping per gate", () => {
  it("first alert at once, then one grouped message per window", () => {
    const b = new PresenceAlertBatcher({ windowMs: 5 * MIN, holdMs: 0 });
    b.offer(ev("PE-1"), 0);
    const first = b.due(0);
    assert.equal(first.length, 1);
    assert.deepEqual(first[0].events.map((e) => e.id), ["PE-1"]);

    for (const [i, t] of [[2, 1 * MIN], [3, 2 * MIN], [4, 4 * MIN]] as const) b.offer(ev(`PE-${i}`, { startedAt: new Date(Date.parse("2026-10-04T23:20:15Z") + t).toISOString() }), t);
    assert.deepEqual(b.due(4 * MIN), [], "inside the window: held");
    const second = b.due(5 * MIN);
    assert.equal(second.length, 1);
    assert.deepEqual(second[0].events.map((e) => e.id), ["PE-2", "PE-3", "PE-4"]);
    assert.deepEqual(b.due(20 * MIN), [], "nothing new, nothing sent");

    b.offer(ev("PE-5"), 21 * MIN);
    assert.equal(b.due(21 * MIN).length, 1, "after a quiet window the next alert goes at once");
  });

  it("gates are independent", () => {
    const b = new PresenceAlertBatcher({ windowMs: 5 * MIN, holdMs: 0 });
    b.offer(ev("PE-a", { gateId: "entry" }), 0);
    b.offer(ev("PE-b", { gateId: "exit" }), 0);
    assert.deepEqual(b.due(0).map((m) => m.gateId).sort(), ["entry", "exit"]);
  });

  it("the two live mornings (93 events) become at most one message per 5 minutes", () => {
    const b = new PresenceAlertBatcher({ windowMs: 5 * MIN, holdMs: 3000 });
    let sent = 0;
    // 61 events spread over 06:19-07:00 (41 min): one every ~40 s.
    for (let i = 0; i < 61; i++) {
      const t = i * 40_000;
      b.offer(ev(`PE-m${i}`), t);
      sent += b.due(t).length;
    }
    for (let t = 61 * 40_000; t < 61 * 40_000 + 10 * MIN; t += 1000) sent += b.due(t).length;
    assert.ok(sent <= 10, `messages sent: ${sent}`);
    assert.equal(b.backlog().queued + b.backlog().pending, 0, "nothing left behind");
  });
});

describe("messages", () => {
  it("one event: gate, local time, duration, no image, login link", () => {
    const p = presenceAlertPayload({ gateId: "entry", events: [ev("PE-1")] }, "Cổng vào", "https://gw.example/#presence");
    assert.match(p.text, /Có người ngoài giờ tại Cổng vào - 06:20:15 05\/10/);
    assert.match(p.text, /\[Mở bảng Hiện diện\]\(https:\/\/gw\.example\/#presence\)/);
    assert.match(p.attachments[0].text, /Không thấy khuôn mặt · trong khung hình 4\.2s · 1 người/);
    assert.match(p.attachments[0].text, /không thay đổi trạng thái cửa/);
    assert.doesNotMatch(JSON.stringify(p), /data:image|base64|\/crop/);
  });

  it("a group: count, time range, one line per event (at most 10)", () => {
    const events = Array.from({ length: 12 }, (_, i) => ev(`PE-${i}`, { startedAt: new Date(Date.parse("2026-10-04T23:20:00Z") + i * 20_000).toISOString() }));
    const p = presenceAlertPayload({ gateId: "entry", events }, "Cổng vào", "");
    assert.match(p.text, /12 lượt có người ngoài giờ tại Cổng vào, 06:20:00-06:23:40 05\/10/);
    assert.equal(p.attachments[0].text.split("\n").filter((l) => l.includes("không thấy mặt")).length, 10);
    assert.match(p.attachments[0].text, /\+2 lượt khác/);
    assert.doesNotMatch(p.text, /Mở bảng/, "no link without a base URL");
  });
});

describe("offline notice", () => {
  const AFTER = 120_000;
  it("one notice when pictures stop, one when they return; a healthy start is silent", () => {
    let s = presenceHealthTransition("unknown", 500, AFTER);
    assert.deepEqual(s, { state: "online", notice: null });
    s = presenceHealthTransition(s.state, AFTER + 1, AFTER);
    assert.deepEqual(s, { state: "offline", notice: "offline" });
    s = presenceHealthTransition(s.state, null, AFTER);
    assert.deepEqual(s, { state: "offline", notice: null }, "no repeat");
    s = presenceHealthTransition(s.state, 800, AFTER);
    assert.deepEqual(s, { state: "online", notice: "online" });
  });
  it("a gate that never gets a picture after a restart is reported", () => {
    assert.deepEqual(presenceHealthTransition("unknown", null, AFTER), { state: "offline", notice: "offline" });
  });
  it("notice text", () => {
    assert.match(presenceHealthPayload("offline", "Cổng vào", "2026-10-04T23:20:15Z", "").text, /Cổng vào đang NGỪNG hoạt động \(06:20:15 05\/10\)/);
    assert.match(presenceHealthPayload("online", "Cổng vào", "2026-10-04T23:20:15Z", "").text, /đã hoạt động lại/);
  });
});

describe("wiring", () => {
  const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  it("only live gates message; shadow records only", () => {
    assert.match(src, /return raw === "shadow" \|\| raw === "live" \? raw : "off";/);
    assert.match(src, /if \(ok && presenceModeFor\(gate\) === "live"\) \{\n\s+presenceAlerts\.offer\(/);
  });
  it("alertSentAt survives later updates of the event", () => {
    assert.match(src, /alertSentAt: presenceAlertedAt\.get\(id\) \?\? null,/);
  });
  it("messages go through the destination guard, never follow redirects, and are logged", () => {
    const fn = src.slice(src.indexOf("async function sendPresenceWebhook"), src.indexOf("async function sendPresenceBatch"));
    assert.match(fn, /destinationRefusal\(webhookConfig\.url, NET_POLICY\.webhook\)/);
    assert.match(fn, /redirect: "manual"/);
    assert.match(fn, /db\.saveWebhookLog\(logEntry\)/);
    assert.doesNotMatch(fn, /crop|unlockDoor|lockDoor/);
  });
});
