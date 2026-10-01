import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { effectivePipelineMode, pipelineModeFromEnv } from "../src/server/pipeline/mode";

describe("pipeline rollout switch", () => {
  it("defaults every gate to legacy, including blanks and typos", () => {
    assert.equal(pipelineModeFromEnv("entry", {}), "legacy");
    assert.equal(pipelineModeFromEnv("exit", { PIPELINE_MODE_EXIT: "" }), "legacy");
    assert.equal(pipelineModeFromEnv("exit", { PIPELINE_MODE_EXIT: "livee" }), "legacy");
  });

  it("reads each gate separately, case-insensitively", () => {
    const env = { PIPELINE_MODE_ENTRY: "Shadow", PIPELINE_MODE_EXIT: "live" };
    assert.equal(pipelineModeFromEnv("entry", env), "shadow");
    assert.equal(pipelineModeFromEnv("exit", env), "live");
  });

  it("reads PIPELINE_MODE_<gateEnvSuffix(id)> for any gate id; the legacy names are unchanged", () => {
    const env = { PIPELINE_MODE_ENTRY: "shadow", PIPELINE_MODE_EXIT: "legacy", PIPELINE_MODE_SIDE_DOOR: "live", PIPELINE_MODE_LOBBY2: "shadow" };
    assert.equal(pipelineModeFromEnv("entry", env), "shadow");
    assert.equal(pipelineModeFromEnv("exit", env), "legacy");
    assert.equal(pipelineModeFromEnv("side-door", env), "live");
    assert.equal(pipelineModeFromEnv("lobby2", env), "shadow");
    assert.equal(pipelineModeFromEnv("garage", env), "legacy", "an unset gate is legacy");
  });

  it("refuses a value that is not a gate id (always legacy), never reading another gate's variable", () => {
    const env = { PIPELINE_MODE_ENTRY: "shadow", PIPELINE_MODE_EXIT: "shadow", PIPELINE_MODE_SIDE_DOOR: "shadow", PIPELINE_MODE_: "shadow" };
    // The old directions are not gate ids any more.
    assert.equal(pipelineModeFromEnv("ENTRY", env), "legacy");
    assert.equal(pipelineModeFromEnv("EXIT", env), "legacy");
    for (const bad of ["", "SIDE-DOOR", "side_door", "side door", "-side", "x", undefined as unknown as string]) {
      assert.equal(pipelineModeFromEnv(bad, env), "legacy", String(bad));
    }
  });

  it("runs legacy until a mode is implemented, and says it did", () => {
    assert.deepEqual(effectivePipelineMode("legacy"), { mode: "legacy", downgraded: false });
    assert.deepEqual(effectivePipelineMode("shadow"), { mode: "shadow", downgraded: false });
    assert.deepEqual(effectivePipelineMode("live"), { mode: "legacy", downgraded: true });
  });
});

describe("parsePipelineMode (config or request values)", () => {
  it("accepts the three modes in any case and rejects the rest", async () => {
    const { parsePipelineMode } = await import("../src/server/pipeline/mode");
    assert.equal(parsePipelineMode("shadow"), "shadow");
    assert.equal(parsePipelineMode(" LIVE "), "live");
    assert.equal(parsePipelineMode("legacy"), "legacy");
    for (const bad of ["", null, undefined, "on", "shadow;", 1, {}]) assert.equal(parsePipelineMode(bad), undefined, String(bad));
  });
});
