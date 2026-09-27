/**
 * acceptance: the section-1 targets of the plan, legacy vs pipeline on the
 * SAME clips. Inputs are metrics documents written by
 * tests/master/baseline/run-replay.sh (collect.ts analyze):
 *
 *   MT_METRICS_LEGACY=/results/<ts>-legacy/legacy.json \
 *   MT_METRICS_PIPELINE=/results/<ts>-pipeline/pipeline.json \
 *   [MT_RECOVERY_JSON=/results/recovery.json] \
 *   node --import tsx --test tests/master/acceptance/acceptance.test.ts
 *
 * The pipeline run is the same replay with PIPELINE_MODE_ENTRY/EXIT=live on an
 * isolated gateway (shadow writes no access logs, so it is scored from the
 * shadow comparison stream instead - see collect.ts). Skips when a document is
 * missing, so it can sit in the suite before W2.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { TARGETS, type GateMetrics } from "../lib/metrics.ts";

interface MetricsDoc {
  name: string;
  perGate: Record<string, GateMetrics>;
  overall: GateMetrics;
  cpu: Record<string, { meanCores: number | null; p95Cores: number | null }>;
}

function load(envName: string): MetricsDoc | null {
  const p = process.env[envName];
  if (!p || !existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

const legacy = load("MT_METRICS_LEGACY");
const pipeline = load("MT_METRICS_PIPELINE");
const skipPipeline = pipeline ? false : "set MT_METRICS_PIPELINE to a pipeline replay run (after W2)";
const skipBoth = legacy && pipeline ? false : "needs MT_METRICS_LEGACY and MT_METRICS_PIPELINE from the same clips";

describe("acceptance: legacy baseline sanity", () => {
  it("legacy never grants a stranger or impostor", { skip: legacy ? false : "set MT_METRICS_LEGACY" }, () => {
    assert.equal(legacy!.overall.falseAccepts, 0);
  });
});

describe("acceptance: section-1 targets for the pipeline", () => {
  it("first >= 60 px face -> decision: p50 <= 0.8 s and p95 <= 1.5 s, per gate", { skip: skipPipeline }, () => {
    for (const [gate, m] of Object.entries(pipeline!.perGate)) {
      assert.ok(m.latencyMs.n > 0, `${gate}: no decided person`);
      assert.ok((m.latencyMs.p50 as number) <= TARGETS.latencyP50Ms, `${gate}: p50 ${m.latencyMs.p50} ms`);
      assert.ok((m.latencyMs.p95 as number) <= TARGETS.latencyP95Ms, `${gate}: p95 ${m.latencyMs.p95} ms`);
    }
  });

  it("people missed per passage <= 5% overall", { skip: skipPipeline }, () => {
    assert.ok((pipeline!.overall.missedPct as number) <= TARGETS.missedPctMax, `missed ${pipeline!.overall.missedPct}%`);
  });

  it("missed is at most half of legacy on the same clips", { skip: skipBoth }, () => {
    const l = legacy!.overall.missedPct as number;
    const p = pipeline!.overall.missedPct as number;
    assert.ok(p <= l / 2 || p === 0, `pipeline missed ${p}% vs legacy ${l}%`);
  });

  it("exactly one log per person per passage", { skip: skipPipeline }, () => {
    assert.equal(pipeline!.overall.duplicateLogs, 0, "duplicate logs");
    assert.equal(pipeline!.overall.logsInEmptyPassages, 0, "phantom logs in empty scenes");
    const decidedPct = 100 - (pipeline!.overall.missedPct as number);
    assert.ok(Math.abs((pipeline!.overall.exactlyOneLogPct as number) - decidedPct) <= 0.2, "every decided person has exactly one log");
  });

  it("zero false accepts", { skip: skipPipeline }, () => {
    assert.equal(pipeline!.overall.falseAccepts, TARGETS.falseAccepts);
  });

  it("gateway CPU: busy <= 3.5 cores, idle <= 0.5 cores", { skip: skipPipeline }, () => {
    const busy = pipeline!.cpu.busy?.meanCores;
    const idle = pipeline!.cpu.idle?.meanCores;
    assert.ok(busy !== null && busy !== undefined && busy <= TARGETS.cpuBusyCoresMax, `busy ${busy} cores`);
    assert.ok(idle !== null && idle !== undefined && idle <= TARGETS.cpuIdleCoresMax, `idle ${idle} cores`);
  });

  it("recovery after a camera/NVR drop <= 10 s", { skip: process.env.MT_RECOVERY_JSON && existsSync(process.env.MT_RECOVERY_JSON) ? false : "set MT_RECOVERY_JSON (written by the contract suite)" }, () => {
    const r = JSON.parse(readFileSync(process.env.MT_RECOVERY_JSON!, "utf8"));
    assert.ok(r.recoveryMs <= TARGETS.recoveryMsMax, `recovery ${r.recoveryMs} ms`);
  });
});
