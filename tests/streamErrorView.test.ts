/**
 * A recovered stream error is history, not a current fault (src/utils/pipelineStatus.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readPipelineRuntime, sourceErrorView, streamErrorTime } from "../src/utils/pipelineStatus";

describe("sourceErrorView", () => {
  const err = "ffmpeg exited (code 0): [hevc] Error constructing the frame RPS.";
  it("is current only while the stream is not streaming", () => {
    assert.equal(sourceErrorView({ status: "streaming", fps: 8, newestFrameAgeMs: 10, reconnects: 2, lastError: err })?.current, false);
    assert.equal(sourceErrorView({ status: "reconnecting", fps: 0, newestFrameAgeMs: null, reconnects: 2, lastError: err })?.current, true);
    assert.equal(sourceErrorView({ status: "streaming", fps: 8, newestFrameAgeMs: 10, reconnects: 0 }), null);
    assert.equal(sourceErrorView(null), null);
  });

  it("carries the error time from the server and formats it", () => {
    const at = "2026-10-02T00:58:14.000Z";
    assert.equal(sourceErrorView({ status: "streaming", fps: 8, newestFrameAgeMs: 1, reconnects: 1, lastError: err, lastErrorAt: at })?.at, at);
    assert.match(streamErrorTime(at), /^ lúc \d{2}:\d{2}:\d{2}/);
    assert.equal(streamErrorTime(undefined), "");
    assert.equal(streamErrorTime("nonsense"), "");
  });
});

void readPipelineRuntime;
