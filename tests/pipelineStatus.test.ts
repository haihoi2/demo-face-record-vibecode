/**
 * Watcher panel: the pipeline rollout mode and its (optional) health, exactly
 * as the server reports them, with wording that never calls the watcher's
 * interval a period.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  formatDurationMs,
  formatFps,
  isFrameAgeWorrying,
  normalizePipelineState,
  normalizePipelineStats,
  parsePipelineMode,
  pipelineModeFallbackNote,
  pipelineModeHint,
  pipelineModeLabel,
  readPipelineRuntime,
  redactCredentialUrls,
  sourceStatusLabel,
} from "../src/utils/pipelineStatus";

describe("rollout mode", () => {
  it("labels each mode as agreed", () => {
    assert.equal(pipelineModeLabel("legacy"), "legacy");
    assert.equal(pipelineModeLabel("shadow"), "chạy thử (shadow)");
    assert.equal(pipelineModeLabel("live"), "đang áp dụng (live)");
  });

  it("parses only the three known modes", () => {
    assert.equal(parsePipelineMode("Shadow"), "shadow");
    assert.equal(parsePipelineMode("livee"), null);
    assert.equal(parsePipelineMode(undefined), null);
  });

  it("says shadow never unlocks or logs", () => {
    assert.match(pipelineModeHint("shadow"), /không mở cửa, không ghi nhật ký/);
  });

  it("reads mode and requested mode from the W0 runtime", () => {
    const view = readPipelineRuntime({ gate: "EXIT", pipelineMode: "legacy", pipelineModeRequested: "live" });
    assert.equal(view.mode, "legacy");
    assert.equal(view.requested, "live");
    assert.equal(view.state, null);
    assert.equal(view.stats, null);
    assert.equal(
      pipelineModeFallbackNote(view),
      "Đã cấu hình đang áp dụng (live) nhưng máy chủ chưa có chế độ này - đang chạy legacy."
    );
  });

  it("has no fallback note when the requested mode is the running one or absent", () => {
    assert.equal(readPipelineRuntime({ pipelineMode: "shadow", pipelineModeRequested: "shadow" }).requested, null);
    assert.equal(pipelineModeFallbackNote(readPipelineRuntime({ pipelineMode: "legacy" })), null);
  });

  it("copes with an older server that sends no pipeline fields at all", () => {
    assert.deepEqual(readPipelineRuntime({ gate: "ENTRY", enabled: true }), { mode: null, requested: null, state: null, stats: null });
    assert.deepEqual(readPipelineRuntime(null), { mode: null, requested: null, state: null, stats: null });
  });
});

describe("pipeline health (optional W2 fields)", () => {
  it("normalises a SourceState", () => {
    assert.deepEqual(
      normalizePipelineState({ gate: "EXIT", status: "streaming", fps: 8.1, newestFrameAgeMs: 120, reconnects: 2, since: "2026-09-26T10:00:00Z" }),
      { status: "streaming", fps: 8.1, newestFrameAgeMs: 120, reconnects: 2, since: "2026-09-26T10:00:00Z" }
    );
  });

  it("keeps null frame age and drops nonsense numbers", () => {
    const s = normalizePipelineState({ status: "starting", fps: -1, newestFrameAgeMs: null, reconnects: "x" })!;
    assert.equal(s.fps, null);
    assert.equal(s.newestFrameAgeMs, null);
    assert.equal(s.reconnects, null);
  });

  it("rejects an unknown status rather than showing a made-up state", () => {
    assert.equal(normalizePipelineState({ status: "great" }), null);
    assert.equal(normalizePipelineState("streaming"), null);
  });

  it("masks credentials in a source error, just in case", () => {
    const s = normalizePipelineState({ status: "reconnecting", lastError: "connect rtsp://admin:secret@192.168.60.1:554/x failed" })!;
    assert.equal(s.lastError, "connect rtsp://•••@192.168.60.1:554/x failed");
    assert.equal(redactCredentialUrls("no url here"), "no url here");
  });

  it("normalises stats and drops an empty object", () => {
    assert.deepEqual(normalizePipelineStats({ lastDecisionLatencyMs: 640, decisions: 12.7 }), { lastDecisionLatencyMs: 640, decisions: 12 });
    assert.equal(normalizePipelineStats({}), null);
    assert.equal(normalizePipelineStats({ lastDecisionLatencyMs: "fast" }), null);
  });

  it("labels source statuses in Vietnamese", () => {
    assert.equal(sourceStatusLabel("streaming"), "Đang nhận hình");
    assert.equal(sourceStatusLabel("stale"), "Hình bị đứng");
    assert.equal(sourceStatusLabel("reconnecting"), "Đang kết nối lại");
  });

  it("formats fps, durations and flags an old newest frame", () => {
    assert.equal(formatFps(8), "8.0 khung/giây");
    assert.equal(formatFps(15), "15 khung/giây");
    assert.equal(formatFps(null), "—");
    assert.equal(formatDurationMs(640), "640 ms");
    assert.equal(formatDurationMs(1234), "1.2 giây");
    assert.equal(formatDurationMs(undefined), "—");
    assert.equal(isFrameAgeWorrying(300), false);
    assert.equal(isFrameAgeWorrying(4000), true);
    assert.equal(isFrameAgeWorrying(null), false);
  });
});

describe("watcher wording", () => {
  it("never describes the gap between scans as a period or frequency", () => {
    // Owner rule: the interval is a GAP between scans.
    const banned = /chu kỳ|tần suất|(?:quét|lượt) mỗi\s*~?\s*[\d{]/i;
    for (const path of ["src/utils/pipelineStatus.ts", "src/components/CameraDashboard.tsx"]) {
      const source = readFileSync(path, "utf8");
      assert.doesNotMatch(source, banned, path);
    }
  });
});
