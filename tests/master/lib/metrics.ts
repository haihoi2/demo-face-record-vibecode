/**
 * Section-1 metrics of the real-time pipeline plan, computed from what a run
 * observed (access logs, watcher looks, CPU samples) against ground truth.
 *
 * Pure functions only, so the attribution rules are unit-tested
 * (tests/master/unit/metrics.test.ts) and identical for legacy and pipeline.
 *
 * Attribution inside one passage window [startMs, endMs) of one gate:
 *  - an employee is DECIDED at their first GRANTED log in the window; every
 *    GRANTED log of theirs counts toward their logs-per-person;
 *  - DENIED logs are assigned in time order to the passage's strangers
 *    (sorted by first usable moment), then to employees that were not granted
 *    (a false reject: decided, but wrongly); extra DENIED logs are duplicates;
 *  - a person with nothing assigned is MISSED;
 *  - a GRANTED log for anyone not expected GRANTED in the passage is a FALSE ACCEPT;
 *  - latency = decision log time - the person's first >= 60 px moment.
 * Logs cannot say which stranger they are about (no identity), so stranger
 * attribution is by order; with one stranger per passage it is exact.
 */

export type Gate = "ENTRY" | "EXIT";

export interface PersonAbs {
  label: string;
  /** Set for employees (resolved fixture or real employee id). */
  employeeId?: string;
  stranger: boolean;
  expected: "GRANTED" | "DENIED";
  /** Wall-clock ms of the first >= 60 px clear face; null if never usable. */
  firstUsableMs: number | null;
}

export interface PassageAbs {
  id: string;
  gate: Gate;
  startMs: number;
  endMs: number;
  people: PersonAbs[];
  tags?: string[];
}

export interface LogObs {
  id: string;
  gate: Gate;
  tsMs: number;
  status: "GRANTED" | "DENIED" | string;
  employeeId?: string | null;
}

export interface LookObs {
  gate: Gate;
  atMs: number;
  durationMs?: number;
  captureMs?: number;
  processingMs?: number;
  ok: boolean;
  faces?: number;
}

export interface CpuSample {
  tMs: number;
  /** CPU of the measured container in cores (docker stats % / 100). */
  cores: number;
}

export interface PersonOutcome {
  passageId: string;
  gate: Gate;
  label: string;
  kind: "employee" | "stranger";
  decided: boolean;
  outcome?: "GRANTED" | "DENIED";
  correct?: boolean;
  latencyMs?: number;
  logs: number;
}

export interface Distribution {
  n: number;
  p50: number | null;
  p95: number | null;
  mean: number | null;
  max: number | null;
}

export interface GateMetrics {
  passages: number;
  passagesWithPeople: number;
  persons: number;
  decided: number;
  missed: number;
  missedPct: number | null;
  latencyMs: Distribution;
  latencyEmployeeMs: Distribution;
  latencyStrangerMs: Distribution;
  /** Mean over passages with people of (logs in the passage / people in it). */
  logsPerPersonPerPassage: number | null;
  /** Share of person-passages that produced exactly one log (target 100%). */
  exactlyOneLogPct: number | null;
  duplicateLogs: number;
  falseAccepts: number;
  falseRejects: number;
  /** Logs in passages where nobody was present (phantom decisions). */
  logsInEmptyPassages: number;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

export function distribution(values: number[]): Distribution {
  if (values.length === 0) return { n: 0, p50: null, p95: null, mean: null, max: null };
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
    max: Math.max(...values),
  };
}

export interface PassageAttribution {
  persons: PersonOutcome[];
  falseAccepts: LogObs[];
  duplicates: number;
  logs: LogObs[];
}

export function attributePassage(p: PassageAbs, allLogs: LogObs[]): PassageAttribution {
  const logs = allLogs.filter((l) => l.gate === p.gate && l.tsMs >= p.startMs && l.tsMs < p.endMs).sort((a, b) => a.tsMs - b.tsMs);
  const persons: PersonOutcome[] = [];
  const expectedGranted = new Set(p.people.filter((x) => x.expected === "GRANTED" && x.employeeId).map((x) => x.employeeId as string));
  const falseAccepts = logs.filter((l) => l.status === "GRANTED" && !(l.employeeId && expectedGranted.has(l.employeeId)));

  const outcomeOf = new Map<PersonAbs, PersonOutcome>();
  for (const person of p.people) {
    const o: PersonOutcome = {
      passageId: p.id,
      gate: p.gate,
      label: person.label,
      kind: person.stranger ? "stranger" : "employee",
      decided: false,
      logs: 0,
    };
    if (!person.stranger && person.employeeId) {
      const mine = logs.filter((l) => l.status === "GRANTED" && l.employeeId === person.employeeId);
      if (mine.length > 0) {
        o.decided = true;
        o.outcome = "GRANTED";
        o.correct = person.expected === "GRANTED";
        o.logs = mine.length;
        if (person.firstUsableMs !== null) o.latencyMs = mine[0].tsMs - person.firstUsableMs;
      }
    }
    outcomeOf.set(person, o);
    persons.push(o);
  }

  const denied = logs.filter((l) => l.status !== "GRANTED");
  const strangers = p.people.filter((x) => x.stranger).sort((a, b) => (a.firstUsableMs ?? Infinity) - (b.firstUsableMs ?? Infinity));
  const ungrantedEmployees = p.people
    .filter((x) => !x.stranger && !outcomeOf.get(x)!.decided)
    .sort((a, b) => (a.firstUsableMs ?? Infinity) - (b.firstUsableMs ?? Infinity));
  const queue = [...strangers, ...ungrantedEmployees];
  let duplicates = 0;
  for (const log of denied) {
    const next = queue.shift();
    if (!next) {
      duplicates += 1;
      continue;
    }
    const o = outcomeOf.get(next)!;
    o.decided = true;
    o.outcome = "DENIED";
    o.correct = next.expected === "DENIED";
    o.logs = 1;
    if (next.firstUsableMs !== null) o.latencyMs = log.tsMs - next.firstUsableMs;
  }
  // Extra GRANTED logs of the same employee are duplicates too.
  for (const o of persons) if (o.outcome === "GRANTED" && o.logs > 1) duplicates += o.logs - 1;
  // Spread duplicate DENIED logs over the strangers for logs-per-person.
  const deniedDupes = Math.max(0, denied.length - (strangers.length + ungrantedEmployees.length));
  if (deniedDupes > 0) {
    const targets = persons.filter((o) => o.outcome === "DENIED");
    for (let i = 0; i < deniedDupes && targets.length > 0; i++) targets[i % targets.length].logs += 1;
  }
  return { persons, falseAccepts, duplicates, logs };
}

export function gateMetrics(passages: PassageAbs[], logs: LogObs[]): { metrics: GateMetrics; persons: PersonOutcome[] } {
  const persons: PersonOutcome[] = [];
  let falseAccepts = 0;
  let duplicates = 0;
  let logsInEmpty = 0;
  const perPassageRatio: number[] = [];
  for (const p of passages) {
    const a = attributePassage(p, logs);
    persons.push(...a.persons);
    falseAccepts += a.falseAccepts.length;
    duplicates += a.duplicates;
    if (p.people.length === 0) logsInEmpty += a.logs.length;
    else perPassageRatio.push(a.logs.length / p.people.length);
  }
  const decided = persons.filter((o) => o.decided);
  const lat = (kind?: "employee" | "stranger") =>
    decided.filter((o) => o.latencyMs !== undefined && (!kind || o.kind === kind)).map((o) => o.latencyMs as number);
  const falseRejects = persons.filter((o) => o.kind === "employee" && o.outcome === "DENIED").length;
  const withPeople = passages.filter((p) => p.people.length > 0).length;
  return {
    persons,
    metrics: {
      passages: passages.length,
      passagesWithPeople: withPeople,
      persons: persons.length,
      decided: decided.length,
      missed: persons.length - decided.length,
      missedPct: persons.length ? round1((100 * (persons.length - decided.length)) / persons.length) : null,
      latencyMs: distribution(lat()),
      latencyEmployeeMs: distribution(lat("employee")),
      latencyStrangerMs: distribution(lat("stranger")),
      logsPerPersonPerPassage: perPassageRatio.length ? round2(perPassageRatio.reduce((a, b) => a + b, 0) / perPassageRatio.length) : null,
      exactlyOneLogPct: persons.length ? round1((100 * persons.filter((o) => o.logs === 1).length) / persons.length) : null,
      duplicateLogs: duplicates,
      falseAccepts,
      falseRejects,
      logsInEmptyPassages: logsInEmpty,
    },
  };
}

export interface PhaseWindow {
  name: string;
  startMs: number;
  endMs: number;
}

export function cpuByPhase(samples: CpuSample[], phases: PhaseWindow[]): Record<string, { n: number; meanCores: number | null; p95Cores: number | null }> {
  const out: Record<string, { n: number; meanCores: number | null; p95Cores: number | null }> = {};
  for (const ph of phases) {
    const xs = samples.filter((s) => s.tMs >= ph.startMs && s.tMs < ph.endMs).map((s) => s.cores);
    out[ph.name] = {
      n: xs.length,
      meanCores: xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null,
      p95Cores: xs.length ? round2(percentile(xs, 95) as number) : null,
    };
  }
  return out;
}

export function lookStats(looks: LookObs[], gate: Gate) {
  const mine = looks.filter((l) => l.gate === gate).sort((a, b) => a.atMs - b.atMs);
  const gaps: number[] = [];
  for (let i = 1; i < mine.length; i++) gaps.push(mine[i].atMs - mine[i - 1].atMs);
  return {
    looks: mine.length,
    failed: mine.filter((l) => !l.ok).length,
    startToStartMs: distribution(gaps),
    durationMs: distribution(mine.filter((l) => l.durationMs !== undefined).map((l) => l.durationMs as number)),
    captureMs: distribution(mine.filter((l) => l.captureMs !== undefined).map((l) => l.captureMs as number)),
    processingMs: distribution(mine.filter((l) => l.processingMs !== undefined).map((l) => l.processingMs as number)),
  };
}

/** Section-1 targets of the plan, as checks over a metrics document. */
export const TARGETS = {
  latencyP50Ms: 800,
  latencyP95Ms: 1500,
  missedPctMax: 5,
  logsPerPersonExactly: 1,
  falseAccepts: 0,
  cpuBusyCoresMax: 3.5,
  cpuIdleCoresMax: 0.5,
  recoveryMsMax: 10_000,
} as const;

export function round1(n: number) {
  return Math.round(n * 10) / 10;
}
export function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/** Markdown table of the headline metrics for one or more runs (legacy, pipeline...). */
export function metricsTable(runs: Array<{ name: string; perGate: Record<string, GateMetrics>; cpu?: Record<string, { meanCores: number | null }> }>): string {
  const fmt = (v: number | null | undefined, unit = "") => (v === null || v === undefined ? "n/a" : `${v}${unit}`);
  const s = (ms: number | null | undefined) => (ms === null || ms === undefined ? "n/a" : `${(ms / 1000).toFixed(2)} s`);
  const rows = ["| Run | Gate | Persons | Latency p50 / p95 | Missed | Logs/person/passage | Exactly-1-log | False accepts | False rejects | Phantom logs |", "|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of runs) {
    for (const [gate, m] of Object.entries(r.perGate)) {
      rows.push(
        `| ${r.name} | ${gate} | ${m.persons} | ${s(m.latencyMs.p50)} / ${s(m.latencyMs.p95)} | ${fmt(m.missedPct, "%")} (${m.missed}) | ${fmt(m.logsPerPersonPerPassage)} | ${fmt(m.exactlyOneLogPct, "%")} | ${m.falseAccepts} | ${m.falseRejects} | ${m.logsInEmptyPassages} |`,
      );
    }
  }
  return rows.join("\n");
}
