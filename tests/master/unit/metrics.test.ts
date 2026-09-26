import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { validateGroundTruth } from "../lib/groundTruth.ts";
import { attributePassage, cpuByPhase, distribution, gateMetrics, lookStats, metricsTable, percentile, type LogObs, type PassageAbs } from "../lib/metrics.ts";

const EMP = "EMP-A";
const base = (people: PassageAbs["people"], id = "p1"): PassageAbs => ({ id, gate: "EXIT", startMs: 0, endMs: 25_000, people });
const A = { label: "A", employeeId: EMP, stranger: false, expected: "GRANTED" as const, firstUsableMs: 5_000 };
const B = { label: "B", stranger: true, expected: "DENIED" as const, firstUsableMs: 5_500 };
const C = { label: "C", stranger: true, expected: "DENIED" as const, firstUsableMs: 6_000 };
const log = (tsMs: number, status: string, employeeId?: string, gate: "ENTRY" | "EXIT" = "EXIT"): LogObs => ({ id: `L${tsMs}`, gate, tsMs, status, employeeId });

describe("MT metrics: percentile / distribution", () => {
  it("uses nearest rank", () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([5], 95), 5);
    assert.equal(percentile([1, 2, 3, 4], 50), 2);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
    assert.deepEqual(distribution([]), { n: 0, p50: null, p95: null, mean: null, max: null });
    assert.equal(distribution([100, 300]).mean, 200);
  });
});

describe("MT metrics: passage attribution", () => {
  it("decides an employee on the first GRANTED log and measures latency from the first usable frame", () => {
    const a = attributePassage(base([A]), [log(7_200, "GRANTED", EMP)]);
    assert.equal(a.persons[0].decided, true);
    assert.equal(a.persons[0].latencyMs, 2_200);
    assert.equal(a.persons[0].correct, true);
    assert.equal(a.falseAccepts.length, 0);
  });

  it("counts a missed person when nothing is logged", () => {
    const { metrics } = gateMetrics([base([A, B])], []);
    assert.equal(metrics.missed, 2);
    assert.equal(metrics.missedPct, 100);
    assert.equal(metrics.latencyMs.n, 0);
  });

  it("assigns DENIED logs to strangers in order, then to ungranted employees as false rejects", () => {
    const a = attributePassage(base([A, B, C]), [log(6_000, "DENIED"), log(9_000, "DENIED"), log(12_000, "DENIED")]);
    const byLabel = Object.fromEntries(a.persons.map((p) => [p.label, p]));
    assert.equal(byLabel.B.latencyMs, 500);
    assert.equal(byLabel.C.latencyMs, 3_000);
    assert.equal(byLabel.A.outcome, "DENIED");
    assert.equal(byLabel.A.correct, false);
    const { metrics } = gateMetrics([base([A, B, C])], [log(6_000, "DENIED"), log(9_000, "DENIED"), log(12_000, "DENIED")]);
    assert.equal(metrics.falseRejects, 1);
    assert.equal(metrics.missed, 0);
  });

  it("flags a GRANTED log for someone not expected as a false accept (impostor or empty scene)", () => {
    const stranger = gateMetrics([base([B])], [log(6_000, "GRANTED", EMP)]);
    assert.equal(stranger.metrics.falseAccepts, 1);
    const empty = gateMetrics([base([], "e1")], [log(3_000, "GRANTED", "EMP-X"), log(4_000, "DENIED")]);
    assert.equal(empty.metrics.falseAccepts, 1);
    assert.equal(empty.metrics.logsInEmptyPassages, 2);
  });

  it("counts duplicates and logs per person per passage", () => {
    const logs = [log(6_000, "GRANTED", EMP), log(9_000, "GRANTED", EMP), log(7_000, "DENIED"), log(10_000, "DENIED")];
    const { metrics, persons } = gateMetrics([base([A, B])], logs);
    assert.equal(metrics.duplicateLogs, 2);
    assert.equal(metrics.logsPerPersonPerPassage, 2);
    assert.equal(metrics.exactlyOneLogPct, 0);
    assert.deepEqual(persons.map((p) => p.logs), [2, 2]);
  });

  it("ignores logs of the other gate and outside the window", () => {
    const { metrics } = gateMetrics([base([A])], [log(6_000, "GRANTED", EMP, "ENTRY"), log(26_000, "GRANTED", EMP)]);
    assert.equal(metrics.missed, 1);
    assert.equal(metrics.falseAccepts, 0);
  });

  it("scores the ideal pipeline as meeting every per-person target", () => {
    const passages = [base([A], "p1"), { ...base([B], "p2"), startMs: 25_000, endMs: 50_000 }];
    passages[1].people = [{ ...B, firstUsableMs: 30_500 }];
    const { metrics } = gateMetrics(passages, [log(5_600, "GRANTED", EMP), log(31_000, "DENIED")]);
    assert.equal(metrics.missedPct, 0);
    assert.equal(metrics.exactlyOneLogPct, 100);
    assert.equal(metrics.logsPerPersonPerPassage, 1);
    assert.ok((metrics.latencyMs.p95 as number) <= 1_500);
  });
});

describe("MT metrics: CPU and looks", () => {
  it("averages CPU samples per phase", () => {
    const cpu = cpuByPhase(
      [{ tMs: 0, cores: 0.1 }, { tMs: 1_000, cores: 0.3 }, { tMs: 5_000, cores: 1.5 }],
      [{ name: "idle", startMs: 0, endMs: 2_000 }, { name: "busy", startMs: 2_000, endMs: 9_000 }, { name: "none", startMs: 10_000, endMs: 11_000 }],
    );
    assert.equal(cpu.idle.meanCores, 0.2);
    assert.equal(cpu.busy.meanCores, 1.5);
    assert.equal(cpu.none.meanCores, null);
  });

  it("measures the look cadence per gate", () => {
    const s = lookStats(
      [{ gate: "EXIT", atMs: 0, ok: true, durationMs: 1_000 }, { gate: "EXIT", atMs: 4_500, ok: false }, { gate: "ENTRY", atMs: 1, ok: true }],
      "EXIT",
    );
    assert.equal(s.looks, 2);
    assert.equal(s.failed, 1);
    assert.equal(s.startToStartMs.p50, 4_500);
  });

  it("renders a markdown table without personal data", () => {
    const { metrics } = gateMetrics([base([A])], [log(6_000, "GRANTED", EMP)]);
    const table = metricsTable([{ name: "legacy", perGate: { EXIT: metrics } }]);
    assert.match(table, /\| legacy \| EXIT \| 1 \| 1\.00 s \/ 1\.00 s \|/);
    assert.doesNotMatch(table, /EMP-A/);
  });
});

describe("MT ground truth", () => {
  it("accepts the committed synthetic example", () => {
    const doc = JSON.parse(readFileSync(new URL("../clips.example.json", import.meta.url), "utf8"));
    assert.deepEqual(validateGroundTruth(doc), []);
  });

  it("rejects URLs, strangers expected GRANTED, overlapping passages and bad paths", () => {
    const doc = JSON.parse(readFileSync(new URL("../clips.example.json", import.meta.url), "utf8"));
    doc.clips[0].file = "../escape.mp4";
    doc.clips[0].note = "rtsp://user:pass@192.0.2.1/x";
    doc.clips[1].passages[0].people[1].expected = "GRANTED";
    doc.clips[1].passages[1].startS = 10;
    const errors = validateGroundTruth(doc).join("\n");
    assert.match(errors, /relative name/);
    assert.match(errors, /URLs or logins/);
    assert.match(errors, /stranger cannot be expected GRANTED/);
    assert.match(errors, /overlaps/);
  });
});

describe("MT collector: shadow decisions", () => {
  it("scores pipeline_shadow_result events like access logs and ignores insufficient tracks", async () => {
    const { shadowDecisions } = await import("../baseline/collect.ts");
    const logs = shadowDecisions([
      { event: "pipeline_shadow_result", receivedAtMs: 10, data: { gate: "EXIT", outcome: "employee", employeeId: EMP, trackId: "t1", decidedAtMs: 5_600 } },
      { event: "pipeline_shadow_result", receivedAtMs: 11, data: { gate: "EXIT", outcome: "stranger", trackId: "t2", decidedAtMs: 6_100 } },
      { event: "pipeline_shadow_result", receivedAtMs: 12, data: { gate: "EXIT", outcome: "insufficient", trackId: "t3", decidedAtMs: 7_000 } },
      { event: "gate_watch_result", receivedAtMs: 13, data: {} },
    ]);
    assert.deepEqual(logs.map((l) => [l.status, l.tsMs, l.employeeId]), [["GRANTED", 5_600, EMP], ["DENIED", 6_100, null]]);
    const { metrics } = gateMetrics([base([A, B])], logs);
    assert.equal(metrics.missed, 0);
    assert.equal(metrics.latencyMs.p95, 600);
  });
});

describe("MT scripted passages: schedule and keyframe phase", () => {
  it("a face is >= 60 px for exactly 3 s, starting 1 s after it appears", async () => {
    const { faceSizeAt, firstUsableTau, LAST_USABLE_TAU } = await import("../harness/scripted.ts");
    assert.equal(faceSizeAt(0.999) < 60, true);
    assert.equal(faceSizeAt(1.0), 60);
    assert.equal(faceSizeAt(3.99), 110);
    assert.equal(faceSizeAt(4.0), 0);
    assert.equal(LAST_USABLE_TAU - firstUsableTau(), 3);
  });

  it("the default offsets put an entry keyframe inside 3 of 4 lane-0 windows, like random arrivals", async () => {
    const { GATES, SLOT_TYPES, slotPeople } = await import("../harness/scripted.ts");
    const gopS = GATES.entry.gop / GATES.entry.fps;
    let covered = 0;
    for (const o of [0, 1, 2, 3]) {
      const [p] = slotPeople(SLOT_TYPES.A1, o);
      const k = Math.ceil(p.firstUsableS / gopS) * gopS; // first keyframe at or after the window opens
      if (k < p.lastUsableS) covered++;
    }
    assert.equal(covered, 3);
  });
});
