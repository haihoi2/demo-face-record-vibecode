/**
 * Presence tracker + rules (P2): linking up to 2 s, late RTMDet boxes,
 * qualification at 3 s (working hours) / 1 s (after hours, Asia/Ho_Chi_Minh),
 * period boundaries, peak persons, best frame, final drafts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PersonDetection, PresenceRules } from "../src/server/presence/contracts";
import { PresenceCore, localMinutes, periodAt } from "../src/server/presence/presenceCore";
import { PresenceTracker, associationCost } from "../src/server/presence/tracker";
import { DEFAULT_PRESENCE_RULES } from "../src/server/presence/presenceConfig";

const RULES: PresenceRules = { ...DEFAULT_PRESENCE_RULES, workingHours: { ...DEFAULT_PRESENCE_RULES.workingHours } };
/** Local (UTC+7) wall time -> epoch ms. */
const local = (h: number, m = 0, s = 0, ms = 0) => Date.UTC(2026, 9, 3, h - 7, m, s, ms);
const Y = (x: number, score = 0.7, y = 400, h = 200): PersonDetection => ({ box: [x, y, x + 80, y + h], score, model: "yolox-nano" });
const R = (x: number, score = 0.5, y = 400, h = 200): PersonDetection => ({ box: [x, y, x + 80, y + h], score, model: "rtmdet-tiny" });
const core = () => new PresenceCore({ gateId: "entry", rules: RULES, framePeriodMs: 500, runStartedAtMs: 1 });

describe("presence rules: period (07:00-19:00 Asia/Ho_Chi_Minh)", () => {
  it("local minutes follow UTC+7", () => {
    assert.equal(localMinutes(Date.UTC(2026, 9, 3, 0, 0), "Asia/Ho_Chi_Minh"), 7 * 60);
  });
  it("boundaries: 06:59:59 after hours, 07:00 working, 18:59:59 working, 19:00 after hours", () => {
    assert.equal(periodAt(local(6, 59, 59), RULES), "after-hours");
    assert.equal(periodAt(local(7, 0, 0), RULES), "working");
    assert.equal(periodAt(local(18, 59, 59), RULES), "working");
    assert.equal(periodAt(local(19, 0, 0), RULES), "after-hours");
    assert.equal(periodAt(local(23, 30), RULES), "after-hours");
    assert.equal(periodAt(local(3, 0), RULES), "after-hours");
  });
  it("a window across midnight works", () => {
    const night = { workingHours: { start: "22:00", end: "06:00", timeZone: "Asia/Ho_Chi_Minh" } };
    assert.equal(periodAt(local(23, 0), night), "working");
    assert.equal(periodAt(local(5, 59), night), "working");
    assert.equal(periodAt(local(6, 0), night), "after-hours");
  });
});

describe("presence tracker: association", () => {
  it("same box links; a small move links; a far jump does not; a 3x height change needs overlap", () => {
    assert.equal(associationCost([0, 0, 80, 200], [0, 0, 80, 200], 500), 0);
    assert.notEqual(associationCost([0, 0, 80, 200], [150, 0, 230, 200], 500), null); // 0.75 heights in 0.5 s (allowed 1.0)
    assert.equal(associationCost([0, 0, 80, 200], [400, 0, 480, 200], 500), null); // 2 heights in 0.5 s
    assert.notEqual(associationCost([0, 0, 80, 200], [400, 0, 480, 200], 2000), null); // 2 heights in 2 s (allowed 2.5)
    assert.equal(associationCost([0, 0, 80, 600], [500, 0, 580, 200], 500), null); // 3x height, no overlap
  });
  it("two people far apart are two tracks; one per track per frame", () => {
    const t = new PresenceTracker({ linkGapMs: 2000, idPrefix: "T" });
    const a = t.observe(0, [Y(100), Y(1500)]);
    assert.equal(a.touched.length, 2);
    const b = t.observe(500, [Y(110), Y(1510), Y(120)]);
    assert.equal(t.open().length, 3); // the third box near person 1 could not join a track that already has a box at t=500
    assert.deepEqual(b.assignments.slice(0, 2), a.assignments);
  });
  it("detections up to 2 s apart link; peak counts people seen in one frame", () => {
    const t = new PresenceTracker({ linkGapMs: 2000, idPrefix: "T" });
    t.observe(0, [Y(100), Y(1500)]);
    t.observe(2000, [Y(100)]);
    assert.equal(t.open().length, 2);
    const p1 = t.open().find((x) => x.recent[0].box[0] === 100)!;
    assert.equal(p1.frames.size, 2);
    assert.equal(p1.peak, 2);
    t.observe(4600, [Y(100)]); // 2.6 s after the last box: a new track
    assert.equal(t.open().length, 3);
  });
});

describe("presence rules: qualification and drafts", () => {
  it("working hours: qualifies at 3.0 s in view (6 frames at 2 fps), not at 2.5 s", () => {
    const c = core();
    const t0 = local(10, 0);
    for (let i = 0; i < 5; i++) assert.equal(c.primary(t0 + i * 500, [Y(100)]).drafts.length, 0);
    const up = c.primary(t0 + 5 * 500, [Y(100)]);
    assert.equal(up.drafts.length, 1);
    const d = up.drafts[0];
    assert.equal(d.final, false);
    assert.equal(d.period, "working");
    assert.equal(d.inViewMs, 3000);
    assert.equal(d.framesSeen, 6);
    assert.equal(d.gateId, "entry");
    assert.match(d.trackId, /^P-1-\d+$/);
    assert.deepEqual(d.models, ["yolox-nano"]);
  });
  it("after hours: qualifies at 1.0 s (2 frames)", () => {
    const c = core();
    const t0 = local(22, 0);
    assert.equal(c.primary(t0, [Y(100)]).drafts.length, 0);
    const up = c.primary(t0 + 500, [Y(100)]);
    assert.equal(up.drafts.length, 1);
    assert.equal(up.drafts[0].period, "after-hours");
    assert.equal(up.drafts[0].inViewMs, 1000);
  });
  it("a track that starts at 18:59:59 qualifies under the after-hours rule once 19:00 has passed", () => {
    const c = core();
    const t0 = local(18, 59, 59);
    assert.equal(c.primary(t0, [Y(100)]).drafts.length, 0); // 18:59:59.0 working, 0.5 s
    const up = c.primary(t0 + 1000, [Y(100)]); // 19:00:00.0 after hours, 1.5 s in view
    assert.equal(up.drafts.length, 1);
    assert.equal(up.drafts[0].period, "after-hours");
  });
  it("before 07:00 the 1 s after-hours rule still applies", () => {
    const c = core();
    const t0 = local(6, 59, 59);
    const first = c.primary(t0, [Y(100)]);
    assert.equal(first.drafts.length, 0);
    const second = c.primary(t0 + 500, [Y(100)]); // 06:59:59.5 after hours: 1.0 s -> qualifies
    assert.equal(second.drafts[0]?.period, "after-hours");
  });
  it("ends after more than 2 s without a box: one final draft; unqualified tracks end silently", () => {
    const c = core();
    const t0 = local(22, 0);
    c.primary(t0, [Y(100), Y(1500)]);
    c.primary(t0 + 500, [Y(100)]); // person 1 qualifies (after hours, 1 s); person 2 seen once
    const early = c.tick(t0 + 2400); // person 2: 2.4 s since its box -> ends unqualified; person 1: 1.9 s
    assert.equal(early.drafts.length, 0);
    assert.equal(early.ended.length, 1);
    assert.equal(c.counters.droppedUnqualified, 1);
    const up = c.tick(t0 + 2600);
    assert.equal(up.drafts.length, 1);
    assert.equal(up.drafts[0].final, true);
    assert.equal(up.drafts[0].inViewMs, 1000);
    assert.equal(c.openTracks(), 0);
  });
  it("does not end a track while a frame that could extend it is still being processed", () => {
    const c = core();
    const t0 = local(22, 0);
    c.primary(t0, [Y(100)]);
    c.primary(t0 + 500, [Y(100)]);
    assert.equal(c.tick(t0 + 3000, [t0 + 2000]).ended.length, 0); // RTMDet of t0+2000 still running
    assert.equal(c.tick(t0 + 3000, [t0 + 2600]).ended.length, 1); // that frame is beyond the 2 s gap
  });
  it("a late RTMDet box links within 2 s and keeps the track alive (UNION-LOWRATE)", () => {
    const c = core();
    const t0 = local(10, 0);
    c.primary(t0, [Y(100)]);
    for (let i = 1; i <= 4; i++) c.primary(t0 + i * 500, []); // YOLOX loses the person
    const up = c.secondary(t0 + 2000, [R(110)]); // RTMDet of frame 4, answered late
    assert.equal(c.openTracks(), 1);
    assert.equal(up.drafts.length, 0); // 2.5 s in view, working hours: not yet
    const q = c.primary(t0 + 2500, [Y(115)]);
    assert.equal(q.drafts.length, 1);
    assert.equal(q.drafts[0].inViewMs, 3000);
    assert.equal(q.drafts[0].framesSeen, 3);
    assert.deepEqual(q.drafts[0].models, ["yolox-nano", "rtmdet-tiny"]);
  });
  it("cross-model NMS: an RTMDet box on a YOLOX box is the same detection; a higher score becomes the best box", () => {
    const c = core();
    const t0 = local(22, 0);
    c.primary(t0, [Y(100, 0.6)]);
    const low = c.secondary(t0, [R(102, 0.4)]); // suppressed by the YOLOX box
    assert.equal(low.bestChanged.length, 0);
    const high = c.secondary(t0, [R(104, 0.9)]); // higher: best box, model counted
    assert.equal(high.bestChanged.length, 1);
    assert.equal(c.openTracks(), 1);
    const q = c.primary(t0 + 500, [Y(110, 0.6)]);
    const d = q.drafts[0];
    assert.equal(d.bestScore, 0.9);
    assert.deepEqual(d.bestBox, [104, 400, 184, 600]);
    assert.equal(d.bestFrameAt, new Date(t0).toISOString());
    assert.deepEqual(d.models, ["yolox-nano", "rtmdet-tiny"]);
    assert.equal(d.framesSeen, 2);
    assert.equal(c.counters.secondaryMerged, 2);
  });
  it("peakPersons counts everyone seen together; endAll gives final drafts", () => {
    const c = core();
    const t0 = local(22, 0);
    c.primary(t0, [Y(100), Y(800), Y(1500)]);
    const up = c.primary(t0 + 500, [Y(100), Y(800)]);
    assert.equal(up.drafts.length, 2);
    assert.ok(up.drafts.every((d) => d.peakPersons === 3));
    const end = c.endAll();
    assert.equal(end.drafts.filter((d) => d.final).length, 2);
    assert.equal(end.ended.length, 3);
  });
  it("draft times are ISO and boxes are rounded to 0.1 px", () => {
    const c = core();
    const t0 = local(22, 0);
    c.primary(t0, [{ box: [100.123, 400.456, 180.789, 600.111], score: 0.71234, model: "yolox-nano" }]);
    const d = c.primary(t0 + 500, [Y(101)]).drafts[0];
    assert.equal(d.startedAt, new Date(t0).toISOString());
    assert.equal(d.lastSeenAt, new Date(t0 + 500).toISOString());
    assert.deepEqual(d.bestBox, [100.1, 400.5, 180.8, 600.1]);
    assert.equal(d.bestScore, 0.712);
  });
});
