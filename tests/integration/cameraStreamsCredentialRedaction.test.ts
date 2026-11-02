/**
 * Camera-stream routes never echo an RTSP login. A stream URL carrying a
 * made-up user:password is pushed through every route that can fail on it
 * (test-stream, scan-rtsp by url and by stream id, snapshot, the config and
 * stream listings, the watch status) and no answer may contain the password
 * or the userinfo form of the URL.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { UNREACHABLE_HOST, api, postJson } from "./helpers";

const PASSWORD = `pw${randomBytes(8).toString("hex")}`;
const USER = `itestcam${randomBytes(3).toString("hex")}`;
const URL_WITH_LOGIN = `rtsp://${USER}:${PASSWORD}@${UNREACHABLE_HOST}:1/sec/${randomBytes(4).toString("hex")}`;
const STREAM_ID = `exit-sec-${randomBytes(3).toString("hex")}`;
const LEAK = new RegExp(`${PASSWORD}|${USER}:|${USER}@`);

function assertNoLogin(label: string, text: string) {
  assert.doesNotMatch(text, LEAK, `${label} carries the camera login`);
}

describe("camera streams: no RTSP login in any answer", () => {
  let added = false;
  before(async () => {
    const res = await postJson<any>("/api/camera-streams/exit/streams", { id: STREAM_ID, label: "Credential probe", sourceType: "RTSP", rtspUrl: URL_WITH_LOGIN, rtspTransport: "TCP", enabled: true, priority: 9 });
    assert.equal(res.status, 201, res.text.slice(0, 300));
    added = true;
    assertNoLogin("POST stream", res.text);
  });
  after(async () => {
    if (added) await api(`/api/camera-streams/exit/streams/${STREAM_ID}`, { method: "DELETE" });
  });

  it("test-stream, scan-rtsp (?url) and the refused snapshot override", async () => {
    const probe = await postJson<any>("/api/camera-streams/test-stream", { url: URL_WITH_LOGIN });
    assert.equal(probe.status, 200, probe.text.slice(0, 200));
    assert.equal(probe.body.success, false);
    assertNoLogin("test-stream", probe.text);

    const scan = await postJson<any>("/api/camera-streams/scan-rtsp", { url: URL_WITH_LOGIN, gate: "exit", frames: 1 });
    assert.ok([409, 502, 503].includes(scan.status), `scan by url: ${scan.status} ${scan.text.slice(0, 160)}`);
    assertNoLogin("scan-rtsp ?url", scan.text);
    assert.doesNotMatch(scan.text, /<login>:|password=/i);

    const snapshot = await api<any>(`/api/camera-streams/snapshot?gate=exit&url=${encodeURIComponent(URL_WITH_LOGIN)}`);
    assert.equal(snapshot.status, 400);
    assert.equal(snapshot.body.code, "URL_OVERRIDE_NOT_ALLOWED");
    assertNoLogin("snapshot", snapshot.text);

    const loopback = await postJson<any>("/api/camera-streams/scan-rtsp", { url: `rtsp://${USER}:${PASSWORD}@127.0.0.1:554/x`, gate: "exit" });
    assert.ok(loopback.status === 400 || loopback.status === 409, `loopback: ${loopback.status}`);
    assertNoLogin("scan-rtsp loopback refusal", loopback.text);
  });

  it("the stored stream: config, stream list, watch status and a scan by stream id", async () => {
    const config = await api<any>("/api/camera-streams/config");
    assert.equal(config.status, 200);
    assertNoLogin("GET config", config.text);
    const stored = config.body.config.exitGate.streams.find((s: any) => s.id === STREAM_ID);
    assert.ok(stored, "the stream is stored");
    assert.ok(stored.rtspUrl === undefined || /^rtsp:\/\/[^@]*$/.test(stored.rtspUrl), "the stored URL comes back without userinfo");

    const list = await api<any>("/api/camera-streams/exit/streams");
    assert.equal(list.status, 200);
    assertNoLogin("GET streams", list.text);

    const watch = await api<any>("/api/camera-streams/watch");
    assert.equal(watch.status, 200);
    assertNoLogin("GET watch", watch.text);

    const scan = await postJson<any>("/api/camera-streams/scan-rtsp", { gate: "exit", streamId: STREAM_ID, frames: 1 });
    assert.ok([409, 502, 503].includes(scan.status), `scan by id: ${scan.status} ${scan.text.slice(0, 160)}`);
    assertNoLogin("scan-rtsp streamId", scan.text);
    const mine = (scan.body.streams || []).find((s: any) => s.streamId === STREAM_ID);
    if (mine) assertNoLogin("scan-rtsp streams[] entry", JSON.stringify(mine));

    const snapshot = await api<any>(`/api/camera-streams/snapshot?gate=exit&stream=${STREAM_ID}`);
    assert.ok([200, 302, 400].includes(snapshot.status), `snapshot: ${snapshot.status}`);
    assertNoLogin("snapshot by id", snapshot.text);
    assertNoLogin("snapshot location", snapshot.headers.get("location") || "");
  });

  it("an edit that fails validation does not echo the login either", async () => {
    const bad = await api<any>(`/api/camera-streams/exit/streams/${STREAM_ID}`, { method: "PUT", body: JSON.stringify({ rtspUrl: `rtsp://${USER}:${PASSWORD}@169.254.169.254/x` }) });
    assert.equal(bad.status, 400, bad.text.slice(0, 200));
    assertNoLogin("PUT refusal", bad.text);
    const dup = await postJson<any>("/api/camera-streams/exit/streams", { id: STREAM_ID, rtspUrl: URL_WITH_LOGIN, sourceType: "RTSP" });
    assert.equal(dup.status, 409);
    assertNoLogin("duplicate refusal", dup.text);
  });
});
