import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RECORDING_WINDOW,
  nvrTime,
  playbackFailure,
  playbackFfmpegArgs,
  playbackUrl,
  recordingConfigFromEnv,
  recordingWindow,
  redactRtsp,
} from "../src/server/recording";

const NVR = "rtsp://viewer:s3cret@192.0.2.10:554";

describe("recording config from the environment", () => {
  it("is off unless an NVR URL and at least one channel are set", () => {
    assert.equal(recordingConfigFromEnv({}), null);
    assert.equal(recordingConfigFromEnv({ RECORDING_NVR_URL: NVR }), null);
    assert.equal(recordingConfigFromEnv({ RECORDING_ENTRY_CHANNEL: "2201" }), null);
  });

  it("keeps the login server-side and maps each gate to its own channel", () => {
    const cfg = recordingConfigFromEnv({ RECORDING_NVR_URL: NVR, RECORDING_ENTRY_CHANNEL: "2201", RECORDING_EXIT_CHANNEL: " 501 " })!;
    assert.equal(cfg.baseUrl, NVR);
    assert.deepEqual(cfg.channels, { ENTRY: "2201", EXIT: "501" });
  });

  it("refuses anything but a bare rtsp:// origin, and non-numeric channels", () => {
    for (const bad of ["http://192.0.2.10", "rtsp://192.0.2.10/Streaming/Channels/501", "rtsp://192.0.2.10?x=1", "not a url"]) {
      assert.equal(recordingConfigFromEnv({ RECORDING_NVR_URL: bad, RECORDING_EXIT_CHANNEL: "501" }), null, bad);
    }
    const cfg = recordingConfigFromEnv({ RECORDING_NVR_URL: NVR, RECORDING_ENTRY_CHANNEL: "22/../1", RECORDING_EXIT_CHANNEL: "501" })!;
    assert.equal(cfg.channels.ENTRY, null);
  });
});

describe("playback window and URL", () => {
  const event = Date.parse("2026-09-26T13:19:08.000Z");

  it("plays 8 s before to 7 s after the event, in UTC NVR format", () => {
    const w = recordingWindow(event, event + 60_000);
    assert.ok(w.ok);
    if (!w.ok) return;
    assert.equal(nvrTime(w.startMs), "20260926T131900Z");
    assert.equal(nvrTime(w.endMs), "20260926T131915Z");
    const cfg = recordingConfigFromEnv({ RECORDING_NVR_URL: NVR, RECORDING_EXIT_CHANNEL: "501" })!;
    assert.equal(
      playbackUrl(cfg, "501", w.startMs, w.endMs),
      `${NVR}/Streaming/tracks/501?starttime=20260926T131900Z&endtime=20260926T131915Z`,
    );
  });

  it("stops short of now for an event that just happened, or asks to retry", () => {
    const w = recordingWindow(event, event + 8_000);
    assert.ok(w.ok);
    if (w.ok) assert.equal(w.endMs, event + 8_000 - DEFAULT_RECORDING_WINDOW.minLagMs);
    // Right after the event, the seconds before it are already playable.
    const now = recordingWindow(event, event);
    assert.ok(now.ok);
    if (now.ok) assert.equal(now.endMs - now.startMs, 5_000);
    // A server clock slightly behind the event time: nothing recorded yet.
    const early = recordingWindow(event, event - 2_000);
    assert.equal(early.ok, false);
    if (!early.ok) {
      assert.equal(early.reason, "not-yet-recorded");
      assert.ok((early.retryAfterSeconds || 0) >= 1);
    }
  });

  it("rejects a missing or future event time", () => {
    assert.deepEqual(recordingWindow(NaN, event), { ok: false, reason: "invalid-time" });
    assert.deepEqual(recordingWindow(event + 3_600_000, event), { ok: false, reason: "invalid-time" });
  });

  it("asks FFmpeg for video only, H.264, streamable MP4", () => {
    const args = playbackFfmpegArgs("rtsp://x/y", 15);
    assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 2), ["-map", "0:v:0"]);
    assert.ok(args.includes("libx264"));
    assert.ok(args.join(" ").includes("frag_keyframe+empty_moov"));
    assert.equal(args[args.indexOf("-t") + 1], "15");
  });
});

describe("errors never leak the NVR login", () => {
  it("redacts credentials in FFmpeg output", () => {
    const text = `Error opening input ${NVR}/Streaming/tracks/501?starttime=x: 400 Bad Request`;
    assert.doesNotMatch(redactRtsp(text), /s3cret|viewer:/);
    assert.match(redactRtsp(text), /rtsp:\/\/<login>@192\.0\.2\.10/);
  });

  it("explains the failure to the operator", () => {
    assert.equal(playbackFailure("Server returned 400 Bad Request").code, "RECORDING_NOT_FOUND");
    assert.equal(playbackFailure("Server returned 401 Unauthorized").code, "RECORDING_AUTH_FAILED");
    assert.equal(playbackFailure("").code, "RECORDING_UNAVAILABLE");
  });
});
