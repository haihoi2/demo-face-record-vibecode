/** Static-object rule for presence alerts (2026-10-28: an object on the boxes alerted all night). */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PresenceAlertBatcher, StaticSpotTracker, type PresenceAlertEvent } from "../src/server/presence/alerts";

const MIN = 60_000;
const OBJECT: [number, number, number, number] = [1583, 496, 1631, 559]; // the real false spot (48x63 px)
const ev = (id: string, t: number, box: [number, number, number, number], over: Partial<PresenceAlertEvent> = {}): PresenceAlertEvent => ({
  id, gateId: "entry", startedAt: new Date(Date.parse("2026-10-27T17:00:00Z") + t).toISOString(), inViewMs: 2000, peakPersons: 1,
  period: "after-hours", faceOutcome: "none", box, score: 0.32, ...over,
});
const jitter = (b: [number, number, number, number], k: number): [number, number, number, number] => [b[0] + (k % 3), b[1] - (k % 2), b[2] + (k % 2), b[3] + (k % 3)];

describe("static spots", () => {
  it("6 separate events on the same box within 30 min make the spot static", () => {
    const t = new StaticSpotTracker();
    const r = [0, 1, 2, 3, 4, 5].map((k) => t.hit("entry", jitter(OBJECT, k), k * 10_000));
    assert.deepEqual(r.map((x) => x.isStatic), [false, false, false, false, false, true]);
    assert.equal(r[5].becameStatic, true);
    assert.equal(t.hit("entry", OBJECT, 70_000).becameStatic, false, "already static");
  });
  it("a person walking through (different boxes) never makes a spot static", () => {
    const t = new StaticSpotTracker();
    for (let k = 0; k < 20; k++) assert.equal(t.hit("entry", [100 + k * 120, 300, 200 + k * 120, 600], k * 1000).isStatic, false);
  });
  it("a spot is forgotten after 30 minutes without a hit; gates are separate", () => {
    const t = new StaticSpotTracker();
    for (let k = 0; k < 6; k++) t.hit("entry", OBJECT, k * 1000);
    assert.equal(t.staticSpots("entry", 10_000).length, 1);
    assert.equal(t.staticSpots("exit", 10_000).length, 0);
    assert.equal(t.hit("entry", OBJECT, 5_000 + 31 * MIN).isStatic, false, "object moved away for 30 min -> alerts again");
  });
});

describe("alerts with the static rule (replay of a bad night: one event every 5 s on the object)", () => {
  it("messages drop from ~one per 5 minutes all night to the first few", () => {
    const run = (withRule: boolean) => {
      const spots: Array<[number, number, number, number]> = [];
      const b = new PresenceAlertBatcher({ windowMs: 5 * MIN, holdMs: 15_000, ...(withRule ? { staticSpots: new StaticSpotTracker(), onStaticSpot: (_g, box) => spots.push(box) } : {}) });
      let messages = 0;
      const night = 10 * 60 * MIN; // 21:00 -> 07:00
      for (let t = 0, k = 0; t < night; t += 5000, k++) {
        b.offer(ev(`PE-${k}`, t, jitter(OBJECT, k)), t);
        messages += b.due(t).length;
      }
      for (let t = night; t < night + 10 * MIN; t += 1000) messages += b.due(t).length;
      return { messages, spots, suppressed: b.backlog().suppressedStatic };
    };
    const before = run(false), after = run(true);
    assert.ok(before.messages >= 110, `without the rule: ${before.messages}`);
    assert.ok(after.messages <= 2, `with the rule: ${after.messages}`);
    assert.equal(after.spots.length, 1, "logged once");
    assert.ok(after.suppressed > 7000);
  });
  it("a real person arriving while the object is there is still alerted", () => {
    const b = new PresenceAlertBatcher({ windowMs: 5 * MIN, holdMs: 0, staticSpots: new StaticSpotTracker() });
    for (let k = 0; k < 10; k++) { b.offer(ev(`PE-o${k}`, k * 5000, OBJECT), k * 5000); b.due(k * 5000); }
    const t = 20 * MIN;
    b.offer(ev("PE-person", t, [2400, 700, 2520, 1000]), t);
    const ids = b.due(t).flatMap((m) => m.events.map((e) => e.id));
    // The person is alerted; of the object only the sightings before it counted as static can be in the same message.
    assert.ok(ids.includes("PE-person"), ids.join(","));
    assert.ok(ids.filter((id) => id.startsWith("PE-o")).every((id) => Number(id.slice(4)) < 5), ids.join(","));
  });
});

describe("a real person is never silenced", () => {
  it("high-score detections at the same spot keep alerting (night-shift worker, score ~0.67)", () => {
    const b = new PresenceAlertBatcher({ windowMs: 5 * MIN, holdMs: 0, staticSpots: new StaticSpotTracker() });
    const worker: [number, number, number, number] = [1893, 420, 2015, 934];
    let alerted = 0;
    for (let k = 0; k < 40; k++) {
      const t = k * 3 * MIN;
      b.offer(ev(`PE-w${k}`, t, worker, { score: 0.67 }), t);
      alerted += b.due(t).reduce((n, m) => n + m.events.length, 0);
    }
    // Let the last grouping window pass.
    for (let t = 40 * 3 * MIN; t <= 40 * 3 * MIN + 10 * MIN; t += 1000) alerted += b.due(t).reduce((n, m) => n + m.events.length, 0);
    assert.equal(alerted, 40);
    assert.equal(b.backlog().suppressedStatic, 0);
  });
});

describe("wiring", () => {
  it("the server passes the box and turns the rule on", () => {
    const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    assert.match(src, /staticSpots: new StaticSpotTracker\(\),/);
    assert.match(src, /box: \[\.\.\.record\.bestBox\]/);
    assert.match(src, /score: record\.bestScore/);
  });
});
