/**
 * Shadow-result persistence and camera adaptation wiring (plan 2026-09-29, Parts B and C).
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyShadowAgreement, shadowResultRetentionDays, SHADOW_MATCH_WINDOW_MS } from "../src/server/shadowResults";

describe("classifyShadowAgreement", () => {
  it("names the four outcomes and 'none'", () => {
    assert.equal(classifyShadowAgreement({ outcome: "employee", employeeId: "E1" }, { status: "GRANTED", employeeId: "E1" }), "agree");
    assert.equal(classifyShadowAgreement({ outcome: "employee", employeeId: "E1" }, { status: "GRANTED", employeeId: "E2" }), "identity-mismatch");
    assert.equal(classifyShadowAgreement({ outcome: "employee", employeeId: "E1" }, { status: "DENIED" }), "shadow-only");
    assert.equal(classifyShadowAgreement({ outcome: "insufficient" }, { status: "GRANTED", employeeId: "E1" }), "legacy-only");
    assert.equal(classifyShadowAgreement({ outcome: "stranger" }, { status: "DENIED" }), "agree");
    assert.equal(classifyShadowAgreement({ outcome: "employee", employeeId: "E1" }, null), "none");
  });

  it("retention defaults to 30 days; blank unset; 0 disables", () => {
    assert.equal(shadowResultRetentionDays({}), 30);
    assert.equal(shadowResultRetentionDays({ SHADOW_RESULT_RETENTION_DAYS: "" }), 30);
    assert.equal(shadowResultRetentionDays({ SHADOW_RESULT_RETENTION_DAYS: "0" }), 0);
  });
});

describe("server wiring", () => {
  const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

  it("stores each shadow outcome after one match window, paired with the nearest door-engine event", () => {
    assert.ok(SHADOW_MATCH_WINDOW_MS >= 3000);
    assert.match(src, /setTimeout\(\(\) => \{\n\s*persistShadowResult\(gate, r\)[\s\S]*?\}, SHADOW_MATCH_WINDOW_MS\)\.unref\(\);/);
    assert.match(src, /agreement: classifyShadowAgreement\(\{ outcome: sh\.outcome, employeeId: sh\.employeeId \}, legacy\)/);
  });

  it("the pipeline decides with its calibrated per-model thresholds", () => {
    assert.match(src, /const selection = pipelineFusionThresholds\(tag\);[\s\S]*?thresholds: selection\.thresholds, engineReady: true/);
  });

  it("adaptation only adds templates for employees the door engine granted; never creates employees or touches access", () => {
    const job = src.slice(src.indexOf("async function runCameraAdaptation"), src.indexOf("function startAccuracyJobs"));
    assert.match(job, /db\.getRecognisedFaceObservations\(since, undefined, 2000\)/);
    assert.match(job, /source: "adaptation"/);
    assert.doesNotMatch(job, /employees\.(push|unshift)|accessLevel|unlockDoor/);
    assert.match(job, /if \(!employees\.some\(\(e\) => e\.id === o\.employeeId\)\) continue;/);
  });

  it("the manual template cap ignores adaptation templates", () => {
    assert.match(src, /getFaceTemplatesForEmployee\(employeeId\)\.filter\(\(t\) => t\.source !== "adaptation"\)/);
  });

  it("a group suggestion is only ever a suggestion (evidence floor, no grant path)", () => {
    const fn = src.slice(src.indexOf("function attachClusterSuggestions"), src.indexOf("The members a resolve request names"));
    assert.match(fn, /const floor = currentFusionThresholds\(\)\.minEvidence;/);
    assert.doesNotMatch(fn, /unlockDoor|GRANTED|saveAccessLog/);
  });

  it("recognised faces are stored only for employees actually granted in that frame", () => {
    assert.match(src, /\.filter\(\(f\) => grantable\.some\(\(e\) => e\.id === f\.employeeId\)\)/);
  });
});
