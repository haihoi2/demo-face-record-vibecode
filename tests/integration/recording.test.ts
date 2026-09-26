/**
 * NVR playback routes, black-box. The test gateway has no NVR configured, so
 * this covers the boundary: authentication, input validation, the "not
 * configured" answer, and that the config never exposes the NVR address.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, noFaceJpegDataUrl, rawApi, recognize } from "./helpers";

describe("NVR playback", () => {
  it("requires a signed-in user", async () => {
    assert.equal((await rawApi("/api/recordings/config")).status, 401);
    assert.equal((await rawApi("/api/logs/LOG-1/recording")).status, 401);
  });

  it("reports availability per gate without any address", async () => {
    const res = await api<any>("/api/recordings/config");
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(typeof res.body.enabled, "boolean");
    assert.deepEqual(Object.keys(res.body.gates).sort(), ["ENTRY", "EXIT"]);
    assert.doesNotMatch(res.text, /rtsp:|@|Streaming/i);
  });

  it("validates the log id before anything else", async () => {
    const res = await api<any>("/api/logs/..%2Fetc/recording");
    assert.ok([400, 404].includes(res.status), String(res.status));
  });

  it("finds a real event's time and gate on every store, then answers 503 without an NVR", async () => {
    const cfg = await api<any>("/api/recordings/config");
    if (cfg.body.enabled) return; // an environment with a real NVR is not this test's concern
    // A real, just-written event: its timestamp must be readable (a lookup that
    // loads only the image made every event "invalid time" on PostgreSQL).
    const made = await recognize({ imageBase64: noFaceJpegDataUrl(64, 93001), scanType: "EXIT" });
    assert.equal(made.status, 200, made.text.slice(0, 200));
    const logId = (made.body as any).log?.id;
    assert.ok(logId);
    const res = await api<any>(`/api/logs/${encodeURIComponent(logId)}/recording`);
    assert.equal(res.status, 503, res.text.slice(0, 200));
    assert.equal(res.body.code, "RECORDING_NOT_CONFIGURED");
  });

  it("answers 404 for an unknown event", async () => {
    const res = await api<any>("/api/logs/LOG-does-not-exist-anywhere/recording");
    assert.equal(res.status, 404);
  });
});
