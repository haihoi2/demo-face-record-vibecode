/** Gate watcher pace (src/server/gateWatchPace.ts, Taiga #506): busy gap while faces are seen. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { gateWatchPace } from "../src/server/gateWatchPace";

const base = { intervalMs: 3000, consecutiveErrors: 0, nowMs: 100_000, busyGapMs: 300, busyHoldMs: 8000, maxBackoffMs: 60_000 };

describe("gateWatchPace", () => {
  it("an empty gate keeps the configured gap", () => {
    assert.deepEqual(gateWatchPace(base), { delayMs: 3000, pace: "idle" });
    assert.deepEqual(gateWatchPace({ ...base, lastFacesAtMs: 100_000 - 8001 }), { delayMs: 3000, pace: "idle" });
  });

  it("a face seen within the hold scans again after the short gap", () => {
    assert.deepEqual(gateWatchPace({ ...base, lastFacesAtMs: 100_000 }), { delayMs: 300, pace: "busy" });
    assert.deepEqual(gateWatchPace({ ...base, lastFacesAtMs: 100_000 - 8000 }), { delayMs: 300, pace: "busy" });
  });

  it("errors back off whatever was seen", () => {
    assert.deepEqual(gateWatchPace({ ...base, consecutiveErrors: 2, lastFacesAtMs: 100_000 }), { delayMs: 12_000, pace: "backoff" });
    assert.equal(gateWatchPace({ ...base, consecutiveErrors: 30 }).delayMs, 60_000);
  });

  it("never lengthens a configured gap that is already shorter, and hold 0 disables it", () => {
    assert.deepEqual(gateWatchPace({ ...base, intervalMs: 200, lastFacesAtMs: 100_000 }), { delayMs: 200, pace: "idle" });
    assert.deepEqual(gateWatchPace({ ...base, busyHoldMs: 0, lastFacesAtMs: 100_000 }), { delayMs: 3000, pace: "idle" });
  });

  it("ignores a face time in the future (clock step) and garbage", () => {
    assert.equal(gateWatchPace({ ...base, lastFacesAtMs: 200_000 }).pace, "idle");
    assert.equal(gateWatchPace({ ...base, lastFacesAtMs: NaN }).pace, "idle");
  });
});
