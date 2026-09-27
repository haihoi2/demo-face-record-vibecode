import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { effectivePipelineMode, pipelineModeFromEnv } from "../src/server/pipeline/mode";

describe("pipeline rollout switch", () => {
  it("defaults every gate to legacy, including blanks and typos", () => {
    assert.equal(pipelineModeFromEnv("ENTRY", {}), "legacy");
    assert.equal(pipelineModeFromEnv("EXIT", { PIPELINE_MODE_EXIT: "" }), "legacy");
    assert.equal(pipelineModeFromEnv("EXIT", { PIPELINE_MODE_EXIT: "livee" }), "legacy");
  });

  it("reads each gate separately, case-insensitively", () => {
    const env = { PIPELINE_MODE_ENTRY: "Shadow", PIPELINE_MODE_EXIT: "live" };
    assert.equal(pipelineModeFromEnv("ENTRY", env), "shadow");
    assert.equal(pipelineModeFromEnv("EXIT", env), "live");
  });

  it("runs legacy until a mode is implemented, and says it did", () => {
    assert.deepEqual(effectivePipelineMode("legacy"), { mode: "legacy", downgraded: false });
    assert.deepEqual(effectivePipelineMode("shadow"), { mode: "shadow", downgraded: false });
    assert.deepEqual(effectivePipelineMode("live"), { mode: "legacy", downgraded: true });
  });
});
