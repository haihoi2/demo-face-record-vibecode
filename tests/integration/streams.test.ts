/**
 * Multiple video streams per gate (`GateStreamConfig.streams`).
 *
 * Covers the normalised config contract (both gates carry `streams`, legacy
 * single-stream fields mirror the primary), legacy-only config writes, the
 * per-stream CRUD endpoints, `?stream=` resolution on the media routes and
 * the multi-stream `scan-rtsp` response shape.
 *
 * The suite snapshots the camera config in `before` and restores it in
 * `after`, so the gateway is left exactly as it was found. Every stream it
 * adds points at `rtsp://127.0.0.1:1/...` (connection refused instantly) so
 * no test depends on a reachable camera. One optional positive scan against
 * the site NVR is soft-asserted and skipped when the NVR is unreachable.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { api, postJson } from "./helpers";

interface StreamSource {
  id: string;
  label: string;
  sourceType: string;
  rtspUrl?: string;
  rtspTransport?: "TCP" | "UDP";
  httpUrl?: string;
  enabled: boolean;
  priority: number;
  [key: string]: unknown;
}

interface GateConfig {
  gateType: "ENTRY" | "EXIT";
  name: string;
  streams: StreamSource[];
  sourceType: string;
  rtspUrl?: string;
  rtspTransport?: "TCP" | "UDP";
  httpUrl?: string;
  resolution?: string;
  fps?: number;
  [key: string]: unknown;
}

interface CameraConfig {
  entryGate: GateConfig;
  exitGate: GateConfig;
  [key: string]: unknown;
}

const LEGACY_FIELDS = [
  "sourceType",
  "rtspUrl",
  "rtspTransport",
  "httpUrl",
  "uvcDeviceId",
  "uvcDeviceLabel",
  "resolution",
  "fps",
  "backendDevicePath",
] as const;

const UNREACHABLE = (suffix: string) => `rtsp://127.0.0.1:1/${suffix}`;

function publicUrl(value: string): string {
  const parsed = new URL(value);
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

async function getConfig(): Promise<CameraConfig> {
  const res = await api("/api/camera-streams/config");
  assert.equal(res.status, 200, res.text.slice(0, 300));
  assert.equal(res.body?.success, true);
  return res.body.config;
}

function primaryOf(gate: GateConfig): StreamSource {
  return gate.streams.find((s) => s.enabled) || gate.streams[0];
}

function putJson(path: string, payload: unknown) {
  return api(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

function del(path: string) {
  return api(path, { method: "DELETE" });
}

function assertLegacyMirrorsPrimary(gate: GateConfig, label: string) {
  assert.ok(Array.isArray(gate.streams) && gate.streams.length >= 1, `${label}: streams[] missing`);
  const primary = primaryOf(gate);
  for (const field of LEGACY_FIELDS) {
    assert.deepEqual(gate[field], primary[field], `${label}: legacy ${field} must mirror the primary stream`);
  }
  const priorities = gate.streams.map((s) => s.priority);
  assert.deepEqual(priorities, [...priorities].sort((a, b) => a - b), `${label}: streams must be sorted by priority`);
  const ids = gate.streams.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, `${label}: stream ids must be unique`);
  for (const s of gate.streams) {
    assert.equal(typeof s.id, "string");
    assert.equal(typeof s.label, "string");
    assert.equal(typeof s.enabled, "boolean");
    assert.equal(typeof s.priority, "number");
  }
}

describe("camera streams: multi-stream gate config", () => {
  let original: CameraConfig;

  before(async () => {
    original = await getConfig();
  });

  after(async () => {
    // Restore both gates exactly (streams replace the list; legacy fields re-mirror).
    const res = await postJson("/api/camera-streams/config", original);
    assert.equal(res.status, 200, `restore failed: ${res.text.slice(0, 300)}`);
    const restored = await getConfig();
    assert.deepEqual(
      restored.entryGate.streams.map((s) => s.id),
      original.entryGate.streams.map((s) => s.id),
      "entry gate streams must be restored"
    );
    assert.deepEqual(
      restored.exitGate.streams.map((s) => s.id),
      original.exitGate.streams.map((s) => s.id),
      "exit gate streams must be restored"
    );
  });

  it("GET config returns streams[] for BOTH gates with legacy fields mirroring the primary", async () => {
    const cfg = await getConfig();
    assert.equal(cfg.entryGate.gateType, "ENTRY");
    assert.equal(cfg.exitGate.gateType, "EXIT");
    assertLegacyMirrorsPrimary(cfg.entryGate, "entryGate");
    assertLegacyMirrorsPrimary(cfg.exitGate, "exitGate");
    for (const s of cfg.entryGate.streams) assert.match(s.id, /^entry-/, "entry stream ids are prefixed entry-");
    for (const s of cfg.exitGate.streams) assert.match(s.id, /^exit-/, "exit stream ids are prefixed exit-");
  });

  it("GET /api/camera-streams/:gate/streams lists the gate's streams and its primary", async () => {
    for (const gate of ["entry", "exit"] as const) {
      const res = await api(`/api/camera-streams/${gate}/streams`);
      assert.equal(res.status, 200, res.text.slice(0, 300));
      assert.equal(res.body.success, true);
      assert.ok(Array.isArray(res.body.streams));
      assert.equal(res.body.primaryStreamId, primaryOf(res.body.gate).id);
    }
    const bad = await api("/api/camera-streams/side/streams");
    assert.equal(bad.status, 400);
  });

  describe("per-stream CRUD on the exit gate", () => {
    const addedId = `exit-itest-${Date.now().toString(36)}`;

    it("POST adds a stream (201) and keeps the legacy mirror on the primary", async () => {
      const before = await getConfig();
      const primaryBefore = primaryOf(before.exitGate);
      const res = await postJson("/api/camera-streams/exit/streams", {
        id: addedId,
        label: "ITEST Kho Sau",
        sourceType: "RTSP",
        rtspUrl: UNREACHABLE(addedId),
        rtspTransport: "TCP",
        // no priority -> appended after existing streams
      });
      assert.equal(res.status, 201, res.text.slice(0, 300));
      assert.equal(res.body.success, true);
      assert.equal(res.body.stream.id, addedId);
      assert.equal(res.body.stream.label, "ITEST Kho Sau");
      assert.equal(res.body.stream.enabled, true);
      const gate: GateConfig = res.body.gate;
      assertLegacyMirrorsPrimary(gate, "exitGate after add");
      assert.equal(primaryOf(gate).id, primaryBefore.id, "adding a lower-ranked stream must not change the primary");
      assert.equal(gate.rtspUrl, primaryBefore.rtspUrl, "legacy rtspUrl must still be the primary's");
      assert.ok(gate.streams.some((s) => s.id === addedId));

      const persisted = await getConfig();
      assert.ok(persisted.exitGate.streams.some((s) => s.id === addedId), "added stream must be persisted");
      assert.deepEqual(
        persisted.entryGate.streams.map((s) => s.id),
        before.entryGate.streams.map((s) => s.id),
        "entry gate must be untouched"
      );
    });

    it("POST with a duplicate id -> 409", async () => {
      const res = await postJson("/api/camera-streams/exit/streams", {
        id: addedId,
        label: "dup",
        sourceType: "RTSP",
        rtspUrl: UNREACHABLE("other"),
      });
      assert.equal(res.status, 409, res.text.slice(0, 300));
      assert.equal(res.body.success, false);
      assert.equal(res.body.conflictField, "id");
    });

    it("POST with a duplicate rtspUrl -> 409", async () => {
      const res = await postJson("/api/camera-streams/exit/streams", {
        label: "dup url",
        sourceType: "RTSP",
        rtspUrl: UNREACHABLE(addedId),
      });
      assert.equal(res.status, 409, res.text.slice(0, 300));
      assert.equal(res.body.conflictField, "rtspUrl");
      assert.equal(res.body.conflictStreamId, addedId);
    });

    it("POST without an id derives one from the RTSP channel", async () => {
      const channel = `ch${Date.now().toString(36)}`;
      const res = await postJson("/api/camera-streams/exit/streams", {
        label: "ITEST derived id",
        sourceType: "RTSP",
        rtspUrl: `rtsp://127.0.0.1:1/Streaming/Channels/${channel}`,
      });
      assert.equal(res.status, 201, res.text.slice(0, 300));
      assert.equal(res.body.stream.id, `exit-${channel}`);
      const cleanup = await del(`/api/camera-streams/exit/streams/exit-${channel}`);
      assert.equal(cleanup.status, 200, cleanup.text.slice(0, 300));
    });

    it("PUT partially updates label/transport/priority and re-ranks the primary", async () => {
      const res = await putJson(`/api/camera-streams/exit/streams/${addedId}`, {
        label: "ITEST Kho Sau (đổi tên)",
        rtspTransport: "UDP",
        priority: -1000, // now the lowest -> becomes primary
      });
      assert.equal(res.status, 200, res.text.slice(0, 300));
      assert.equal(res.body.stream.id, addedId, "id is immutable");
      assert.equal(res.body.stream.label, "ITEST Kho Sau (đổi tên)");
      assert.equal(res.body.stream.rtspTransport, "UDP");
      assert.equal(res.body.stream.rtspUrl, UNREACHABLE(addedId), "untouched fields survive a partial update");
      const gate: GateConfig = res.body.gate;
      assert.equal(res.body.primaryStreamId, addedId);
      assert.equal(gate.streams[0].id, addedId, "lowest priority sorts first");
      assert.equal(gate.rtspUrl, UNREACHABLE(addedId), "legacy fields now mirror the new primary");
      assert.equal(gate.rtspTransport, "UDP");
      assertLegacyMirrorsPrimary(gate, "exitGate after PUT");
    });

    it("PUT enabled=false demotes the stream from primary", async () => {
      const res = await putJson(`/api/camera-streams/exit/streams/${addedId}`, { enabled: false });
      assert.equal(res.status, 200, res.text.slice(0, 300));
      assert.equal(res.body.stream.enabled, false);
      assert.notEqual(res.body.primaryStreamId, addedId, "a disabled stream is never the primary");
      assert.notEqual(res.body.gate.rtspUrl, UNREACHABLE(addedId));
      assertLegacyMirrorsPrimary(res.body.gate, "exitGate after disable");
    });

    it("PUT on an unknown stream -> 404", async () => {
      const res = await putJson("/api/camera-streams/exit/streams/exit-does-not-exist", { label: "x" });
      assert.equal(res.status, 404, res.text.slice(0, 300));
      assert.equal(res.body.success, false);
    });

    it("DELETE on an unknown stream -> 404", async () => {
      const res = await del("/api/camera-streams/exit/streams/exit-does-not-exist");
      assert.equal(res.status, 404, res.text.slice(0, 300));
    });

    it("DELETE removes the stream and the primary mirror is intact", async () => {
      const res = await del(`/api/camera-streams/exit/streams/${addedId}`);
      assert.equal(res.status, 200, res.text.slice(0, 300));
      assert.equal(res.body.removedStreamId, addedId);
      assert.ok(!res.body.gate.streams.some((s: StreamSource) => s.id === addedId));
      assertLegacyMirrorsPrimary(res.body.gate, "exitGate after delete");
      const persisted = await getConfig();
      assert.ok(!persisted.exitGate.streams.some((s) => s.id === addedId), "deletion must be persisted");
    });

    it("DELETE refuses to remove the last stream of a gate (400)", async () => {
      // Collapse the entry gate to a single stream via a config write, then try to delete it.
      const cfg = await getConfig();
      const only = primaryOf(cfg.entryGate);
      const collapse = await postJson("/api/camera-streams/config", { entryGate: { streams: [only] } });
      assert.equal(collapse.status, 200, collapse.text.slice(0, 300));
      assert.equal(collapse.body.config.entryGate.streams.length, 1);

      const res = await del(`/api/camera-streams/entry/streams/${only.id}`);
      assert.equal(res.status, 400, res.text.slice(0, 300));
      assert.equal(res.body.success, false);
      const still = await getConfig();
      assert.equal(still.entryGate.streams.length, 1);
      assert.equal(still.entryGate.streams[0].id, only.id);
    });
  });

  describe("POST /api/camera-streams/config", () => {
    const secondaryId = `entry-itest-second-${Date.now().toString(36)}`;

    it("a body carrying streams[] replaces that gate's list (both gates independently)", async () => {
      const cfg = await getConfig();
      const primary = primaryOf(cfg.entryGate);
      const res = await postJson("/api/camera-streams/config", {
        entryGate: {
          streams: [
            { ...primary, priority: 1 },
            {
              id: secondaryId,
              label: "ITEST Entry Second",
              sourceType: "RTSP",
              rtspUrl: UNREACHABLE(secondaryId),
              rtspTransport: "TCP",
              enabled: true,
              priority: 5,
            },
          ],
        },
      });
      assert.equal(res.status, 200, res.text.slice(0, 300));
      const entry: GateConfig = res.body.config.entryGate;
      assert.deepEqual(entry.streams.map((s) => s.id), [primary.id, secondaryId]);
      assertLegacyMirrorsPrimary(entry, "entryGate after replace");
      assert.deepEqual(
        res.body.config.exitGate.streams.map((s: StreamSource) => s.id),
        cfg.exitGate.streams.map((s) => s.id),
        "exit gate untouched by an entry-only write"
      );
    });

    it("a legacy-only body (no streams) updates the PRIMARY stream and keeps the other streams", async () => {
      const cfg = await getConfig();
      const primary = primaryOf(cfg.entryGate);
      assert.ok(cfg.entryGate.streams.length >= 2, "precondition: entry gate has 2 streams");
      const newUrl = `rtsp://127.0.0.1:1/legacy/${Date.now().toString(36)}`;
      const res = await postJson("/api/camera-streams/config", {
        entryGate: {
          name: cfg.entryGate.name,
          enabled: true,
          sourceType: "RTSP",
          rtspUrl: newUrl,
          rtspTransport: "UDP",
          fps: 12,
        },
      });
      assert.equal(res.status, 200, res.text.slice(0, 300));
      const entry: GateConfig = res.body.config.entryGate;
      assert.deepEqual(entry.streams.map((s) => s.id), [primary.id, secondaryId], "stream list preserved");
      assert.equal(entry.streams[0].rtspUrl, publicUrl(newUrl), "primary stream exposes the credential-redacted legacy rtspUrl");
      assert.equal(entry.streams[0].rtspTransport, "UDP");
      assert.equal(entry.streams[0].fps, 12);
      assert.equal(entry.rtspUrl, publicUrl(newUrl), "legacy mirror follows with credentials redacted");
      assert.equal(entry.streams[1].rtspUrl, UNREACHABLE(secondaryId), "secondary stream untouched");
      assertLegacyMirrorsPrimary(entry, "entryGate after legacy write");
    });

    it("an old dashboard echoing streams[] while editing legacy fields still updates the primary", async () => {
      const cfg = await getConfig();
      const echoedUrl = `rtsp://127.0.0.1:1/echo/${Date.now().toString(36)}`;
      const res = await postJson("/api/camera-streams/config", {
        ...cfg,
        entryGate: { ...cfg.entryGate, rtspUrl: echoedUrl },
      });
      assert.equal(res.status, 200, res.text.slice(0, 300));
      const entry: GateConfig = res.body.config.entryGate;
      assert.equal(entry.rtspUrl, publicUrl(echoedUrl));
      assert.equal(primaryOf(entry).rtspUrl, publicUrl(echoedUrl), "the edited legacy field lands on the primary stream without exposing credentials");
      assert.equal(entry.streams.length, cfg.entryGate.streams.length, "no stream lost");
    });

    it("a body whose streams have no ids / no priorities is normalised", async () => {
      const res = await postJson("/api/camera-streams/config", {
        entryGate: {
          streams: [
            { label: "no id A", sourceType: "RTSP", rtspUrl: "rtsp://127.0.0.1:1/Streaming/Channels/7701" },
            { label: "no id B", sourceType: "RTSP", rtspUrl: "rtsp://127.0.0.1:1/Streaming/Channels/7702", enabled: false },
            { id: "entry-7701", label: "duplicate of A", sourceType: "RTSP", rtspUrl: "rtsp://127.0.0.1:1/x" },
          ],
        },
      });
      assert.equal(res.status, 200, res.text.slice(0, 300));
      const entry: GateConfig = res.body.config.entryGate;
      assert.deepEqual(entry.streams.map((s) => s.id), ["entry-7701", "entry-7702"], "ids derived from channel, duplicate dropped");
      assert.equal(entry.streams[0].label, "no id A");
      assert.equal(entry.streams[1].enabled, false);
      assert.ok(entry.streams[0].priority < entry.streams[1].priority);
      assertLegacyMirrorsPrimary(entry, "entryGate normalised");
    });
  });

  describe("media routes honour ?stream=", () => {
    it("snapshot with an unknown stream id -> 400", async () => {
      const res = await api("/api/camera-streams/snapshot?gate=exit&stream=exit-nope", { redirect: "manual" });
      assert.equal(res.status, 400, res.text.slice(0, 300));
      assert.equal(res.body?.success, false);
      assert.match(res.body.error, /exit-nope/);
    });

    it("mjpeg with an unknown stream id -> 400", async () => {
      const res = await api("/api/camera-streams/mjpeg?gate=entry&stream=entry-nope");
      assert.equal(res.status, 400);
    });

    it("snapshot of a known stream pointing at an unreachable host falls back to the test frame", async () => {
      const cfg = await getConfig();
      const add = await postJson("/api/camera-streams/exit/streams", {
        id: "exit-itest-snap",
        label: "ITEST snapshot",
        sourceType: "RTSP",
        rtspUrl: UNREACHABLE("snap"),
      });
      assert.equal(add.status, 201, add.text.slice(0, 300));
      try {
        const res = await api("/api/camera-streams/snapshot?gate=exit&stream=exit-itest-snap", { redirect: "manual" });
        assert.equal(res.status, 302, `expected redirect to the fallback frame, got ${res.status}`);
        assert.match(res.headers.get("location") || "", /test-frame\?gate=exit&source=RTSP%20Offline/);
      } finally {
        await del("/api/camera-streams/exit/streams/exit-itest-snap");
        const after = await getConfig();
        assert.deepEqual(after.exitGate.streams.map((s) => s.id), cfg.exitGate.streams.map((s) => s.id));
      }
    });
  });

  describe("POST /api/camera-streams/scan-rtsp", () => {
    it("rejects an unknown stream id with 400", async () => {
      const res = await postJson("/api/camera-streams/scan-rtsp", { gate: "exit", stream: "exit-nope" });
      assert.equal(res.status, 400, res.text.slice(0, 300));
      assert.equal(res.body.success, false);
    });

    it("rejects a non-RTSP url with 400", async () => {
      const res = await postJson("/api/camera-streams/scan-rtsp", { gate: "entry", url: "http://127.0.0.1:1/x" });
      assert.equal(res.status, 400);
    });

    it("an unreachable ?url -> 502 with a single failed streams[] entry", async () => {
      const res = await postJson("/api/camera-streams/scan-rtsp", { gate: "entry", url: UNREACHABLE("url-scan") });
      assert.equal(res.status, 502, res.text.slice(0, 300));
      assert.equal(res.body.success, false);
      assert.equal(res.body.recognized, false, "a failed grab must never be reported as recognised");
      assert.ok(Array.isArray(res.body.streams));
      assert.equal(res.body.streams.length, 1);
      assert.equal(res.body.streams[0].success, false);
      assert.equal(typeof res.body.streams[0].error, "string");
      assert.equal(res.body.streams[0].totalFacesDetected, 0);
    });

    it("scanning a configured stream id that points at an unreachable host -> streams[] entry success:false", async () => {
      const cfg = await getConfig();
      const streamId = "exit-itest-scan";
      const add = await postJson("/api/camera-streams/exit/streams", {
        id: streamId,
        label: "ITEST scan target",
        sourceType: "RTSP",
        rtspUrl: UNREACHABLE("scan-target"),
      });
      assert.equal(add.status, 201, add.text.slice(0, 300));
      try {
        const res = await postJson("/api/camera-streams/scan-rtsp", { gate: "exit", stream: streamId });
        assert.equal(res.status, 502, res.text.slice(0, 300));
        assert.equal(res.body.success, false);
        assert.equal(res.body.gate, "exit");
        const entry = res.body.streams.find((s: any) => s.streamId === streamId);
        assert.ok(entry, "streams[] must carry the scanned stream");
        assert.equal(entry.success, false);
        assert.equal(entry.streamLabel, "ITEST scan target");
        assert.equal(entry.recognized, false);
        assert.deepEqual(entry.detectedFaces, []);
        assert.equal(typeof entry.frameCaptureDurationMs, "number");
      } finally {
        await del(`/api/camera-streams/exit/streams/${streamId}`);
        const after = await getConfig();
        assert.deepEqual(after.exitGate.streams.map((s) => s.id), cfg.exitGate.streams.map((s) => s.id));
      }
    });

    it("gate-wide scan over several unreachable streams reports every stream and fails as 502", async () => {
      const cfg = await getConfig();
      const ids = ["exit-itest-multi-a", "exit-itest-multi-b"];
      const res = await postJson("/api/camera-streams/config", {
        exitGate: {
          streams: ids.map((id, i) => ({
            id,
            label: `ITEST multi ${i}`,
            sourceType: "RTSP",
            rtspUrl: UNREACHABLE(id),
            enabled: true,
            priority: i + 1,
          })),
        },
      });
      assert.equal(res.status, 200, res.text.slice(0, 300));
      try {
        const t0 = Date.now();
        const scan = await postJson("/api/camera-streams/scan-rtsp", { gate: "exit" });
        const elapsed = Date.now() - t0;
        assert.equal(scan.status, 502, scan.text.slice(0, 300));
        assert.deepEqual(scan.body.streams.map((s: any) => s.streamId), ids, "one entry per enabled stream, in priority order");
        for (const s of scan.body.streams) assert.equal(s.success, false);
        assert.ok(elapsed < 15000, `grabs must run concurrently (took ${elapsed} ms)`);
      } finally {
        const restore = await postJson("/api/camera-streams/config", { exitGate: { streams: cfg.exitGate.streams } });
        assert.equal(restore.status, 200, restore.text.slice(0, 300));
      }
    });

    it("gate-wide scan skips disabled streams", async () => {
      const cfg = await getConfig();
      const res = await postJson("/api/camera-streams/config", {
        exitGate: {
          streams: [
            { id: "exit-itest-on", label: "on", sourceType: "RTSP", rtspUrl: UNREACHABLE("on"), enabled: true, priority: 1 },
            { id: "exit-itest-off", label: "off", sourceType: "RTSP", rtspUrl: UNREACHABLE("off"), enabled: false, priority: 2 },
          ],
        },
      });
      assert.equal(res.status, 200, res.text.slice(0, 300));
      try {
        const scan = await postJson("/api/camera-streams/scan-rtsp", { gate: "exit" });
        assert.equal(scan.status, 502, scan.text.slice(0, 300));
        assert.deepEqual(scan.body.streams.map((s: any) => s.streamId), ["exit-itest-on"]);
      } finally {
        const restore = await postJson("/api/camera-streams/config", { exitGate: { streams: cfg.exitGate.streams } });
        assert.equal(restore.status, 200, restore.text.slice(0, 300));
      }
    });

    it("gate-wide scan with no enabled RTSP stream -> 400", async () => {
      const cfg = await getConfig();
      const res = await postJson("/api/camera-streams/config", {
        exitGate: {
          streams: [{ id: "exit-itest-uvc", label: "uvc", sourceType: "CLIENT_UVC", uvcDeviceId: "default", enabled: true, priority: 1 }],
        },
      });
      assert.equal(res.status, 200, res.text.slice(0, 300));
      try {
        const scan = await postJson("/api/camera-streams/scan-rtsp", { gate: "exit" });
        assert.equal(scan.status, 400, scan.text.slice(0, 300));
      } finally {
        const restore = await postJson("/api/camera-streams/config", { exitGate: { streams: cfg.exitGate.streams } });
        assert.equal(restore.status, 200, restore.text.slice(0, 300));
      }
    });

    /**
     * Optional positive multi-stream scan against the site NVR. Soft: when the
     * cameras are not reachable from the test network the case is skipped.
     */
    it("positive multi-stream scan against the site NVR (skipped when unreachable)", async (t) => {
      const urls = (process.env.INTEGRATION_NVR_RTSP_URLS || "")
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean);
      if (urls.length < 2) {
        t.skip("set INTEGRATION_NVR_RTSP_URLS to two comma-separated RTSP URLs");
        return;
      }
      const nvr = urls.slice(0, 2).map((rtspUrl, index) => ({
        id: `exit-itest-nvr-${index + 1}`,
        label: `NVR integration stream ${index + 1}`,
        rtspUrl,
      }));
      const probe = await postJson("/api/camera-streams/test-stream", { url: nvr[0].rtspUrl });
      if (probe.status !== 200 || probe.body?.success !== true || probe.body?.reachable === false) {
        t.skip(`NVR not reachable from the gateway (${probe.status}: ${probe.text.slice(0, 120)})`);
        return;
      }
      const cfg = await getConfig();
      const set = await postJson("/api/camera-streams/config", {
        exitGate: {
          streams: nvr.map((s, i) => ({ ...s, sourceType: "RTSP", rtspTransport: "TCP", enabled: true, priority: i + 1 })),
        },
      });
      assert.equal(set.status, 200, set.text.slice(0, 300));
      try {
        const scan = await postJson("/api/camera-streams/scan-rtsp", { gate: "exit" });
        if (scan.status === 503) {
          t.skip("worker pool busy (503)");
          return;
        }
        if (scan.status !== 200) {
          t.skip(`NVR grab failed (${scan.status}): ${scan.text.slice(0, 160)}`);
          return;
        }
        assert.equal(scan.body.success, true);
        assert.equal(scan.body.streamsScanned, 2);
        assert.ok(scan.body.streamsSucceeded >= 1);
        assert.equal(scan.body.streams.length, 2);
        assert.equal(
          scan.body.totalFacesDetected,
          scan.body.streams.reduce((n: number, s: any) => n + (s.success ? s.totalFacesDetected : 0), 0),
          "totalFacesDetected is the sum over successful streams"
        );
        assert.equal(scan.body.detectedFaces.length, scan.body.totalFacesDetected);
        for (const f of scan.body.detectedFaces) {
          assert.ok(nvr.some((s) => s.id === f.streamId), "each aggregated face carries its streamId");
          assert.equal(typeof f.streamLabel, "string");
        }
        assert.equal(scan.body.authorizedCount + scan.body.unauthorizedCount, scan.body.totalFacesDetected);
        assert.equal(
          scan.body.recognized,
          scan.body.streams.some((s: any) => s.recognized),
          "aggregate recognized is the OR of the per-stream results"
        );
        assert.ok(scan.body.frameCaptureDurationMs >= Math.max(...scan.body.streams.map((s: any) => s.frameCaptureDurationMs || 0)));
        assert.equal(typeof scan.body.engineUsed, "string");
      } finally {
        const restore = await postJson("/api/camera-streams/config", { exitGate: { streams: cfg.exitGate.streams } });
        assert.equal(restore.status, 200, restore.text.slice(0, 300));
      }
    });
  });
});

/**
 * Camera configuration must survive a process restart. Before it was persisted
 * server-side beyond the local stores, a host without a durable ./data reverted
 * every gate to the compiled defaults.
 */
describe("camera streams config durability", () => {
  it("round-trips an edited gate through the server's own store", async () => {
    const before = await getConfig();
    const label = `ITEST durability ${Date.now().toString(36)}`;
    const created = await postJson("/api/camera-streams/exit/streams", {
      label,
      sourceType: "RTSP",
      rtspUrl: "rtsp://127.0.0.1:1/Streaming/Channels/4099",
      rtspTransport: "TCP",
      enabled: false,
      priority: 90,
    });
    assert.equal(created.status, 201, created.text.slice(0, 300));
    const addedId = created.body.stream.id;
    try {
      // Re-read through a fresh request: the value must come back from the
      // server's store, not the caller's optimism.
      const after = await getConfig();
      const found = after.exitGate.streams.find((s: any) => s.id === addedId);
      assert.ok(found, "the added stream must be readable back from the server");
      assert.equal(found.label, label);
      assert.equal(found.enabled, false);
      assert.ok(
        after.exitGate.streams.length > before.exitGate.streams.length,
        "adding a stream must append, never replace the gate's list"
      );
    } finally {
      await api(`/api/camera-streams/exit/streams/${encodeURIComponent(addedId)}`, { method: "DELETE" });
    }
  });
});
