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
