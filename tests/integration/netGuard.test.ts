/**
 * Outbound destination guard (src/server/netGuard.ts) wired into the gateway:
 * master test findings F2-F4 (SSRF through stored camera streams, test-stream,
 * webhook and door URLs) and N1 (door token in logs).
 *
 *   - saving a loopback / metadata / link-local destination answers 400 with a
 *     DEST_* code and stores nothing (streams, gate config, webhook, door);
 *   - test-stream refuses internal destinations without opening a socket;
 *   - a STORED destination the guard refuses at use is never dialled: the scan
 *     answers 409 with the code, the snapshot falls back to the placeholder;
 *   - webhook and door sends to a refused destination send nothing and log why;
 *   - the door token never appears in API responses or the door log.
 *
 * Refused-at-use destinations are made with `.invalid` host names (RFC 6761):
 * they are saved with a DEST_UNRESOLVED warning and refused before any dial,
 * which is exactly the path an existing stored config that the current
 * allowlist refuses takes. Works with or without CAMERA_/WEBHOOK_/DOOR_
 * allowlists on the gateway.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, postJson, rawApi } from "./helpers";

const DEST_CODE = /^DEST_[A-Z_]+$/;

async function cameraConfig() {
  const r = await api<any>("/api/camera-streams/config");
  assert.equal(r.status, 200, r.text.slice(0, 200));
  return r.body.config;
}

describe("net guard: camera destinations on save", () => {
  let original: any;
  before(async () => {
    original = await cameraConfig();
  });
  after(async () => {
    for (const id of ["itest-guard-ok", "itest-guard-stored"]) {
      await api(`/api/camera-streams/exit/streams/${id}`, { method: "DELETE" });
    }
    await postJson("/api/camera-streams/config", { entryGate: original.entryGate, exitGate: original.exitGate });
  });

  const refused: Array<[string, RegExp]> = [
    ["rtsp://127.0.0.1:554/x", /^DEST_LOOPBACK$/],
    ["rtsp://2130706433/x", /^DEST_LOOPBACK$/],
    ["rtsp://localhost:5432/x", /^DEST_LOOPBACK$/],
    ["rtsp://[::1]:3000/x", /^DEST_LOOPBACK$/],
    ["rtsp://[::ffff:127.0.0.1]/x", /^DEST_LOOPBACK$/],
    ["rtsp://169.254.169.254/latest", /^DEST_METADATA$/],
    ["rtsp://169.254.1.1/x", /^DEST_LINK_LOCAL$/],
    ["rtsp://0.0.0.0:22/x", /^DEST_UNSPECIFIED$/],
    ["rtsp://evil\\@127.0.0.1/x", /^DEST_BAD_URL$/],
  ];

  for (const [url, code] of refused) {
    it(`POST /:gate/streams refuses ${url} with 400 and stores nothing`, async () => {
      const r = await postJson("/api/camera-streams/exit/streams", { id: "itest-guard-bad", rtspUrl: url, enabled: false, priority: 990 });
      assert.equal(r.status, 400, r.text.slice(0, 200));
      assert.match(r.body.code, code);
      assert.equal(r.body.field, "rtspUrl");
      assert.ok(typeof r.body.error === "string" && r.body.error.length > 10);
      const list = await api<any>("/api/camera-streams/exit/streams");
      assert.ok(!list.body.streams.some((s: any) => s.id === "itest-guard-bad"), "a refused stream was stored");
    });
  }

  it("a refusal never echoes the camera login", async () => {
    const r = await postJson("/api/camera-streams/exit/streams", { id: "itest-guard-bad", rtspUrl: "rtsp://admin:Itest-S3cret@127.0.0.1:554/x", enabled: false });
    assert.equal(r.status, 400);
    assert.doesNotMatch(r.text, /Itest-S3cret|admin/);
  });

  it("POST /api/camera-streams/config with a new loopback stream answers 400 and saves nothing", async () => {
    const before = await cameraConfig();
    const r = await postJson("/api/camera-streams/config", {
      exitGate: {
        streams: [
          ...before.exitGate.streams,
          { id: "itest-guard-cfg", label: "guard cfg", sourceType: "RTSP", rtspUrl: "rtsp://169.254.169.254/x", enabled: false, priority: 995 },
        ],
      },
    });
    assert.equal(r.status, 400, r.text.slice(0, 200));
    assert.equal(r.body.code, "DEST_METADATA");
    assert.equal(r.body.streamId, "itest-guard-cfg");
    const afterCfg = await cameraConfig();
    assert.ok(!afterCfg.exitGate.streams.some((s: any) => s.id === "itest-guard-cfg"));
  });

  it("PUT refuses a changed URL, but a stored stream can still be edited without touching its URL", async () => {
    const ok = await postJson("/api/camera-streams/exit/streams", { id: "itest-guard-ok", rtspUrl: "rtsp://192.0.2.44:554/itest-guard", enabled: false, priority: 991 });
    assert.equal(ok.status, 201, ok.text.slice(0, 200));
    const bad = await api<any>("/api/camera-streams/exit/streams/itest-guard-ok", { method: "PUT", body: JSON.stringify({ rtspUrl: "rtsp://127.0.0.1:1/x" }) });
    assert.equal(bad.status, 400, bad.text.slice(0, 200));
    assert.equal(bad.body.code, "DEST_LOOPBACK");
    const relabel = await api<any>("/api/camera-streams/exit/streams/itest-guard-ok", { method: "PUT", body: JSON.stringify({ label: "relabelled" }) });
    assert.equal(relabel.status, 200, relabel.text.slice(0, 200));
    assert.equal(relabel.body.stream.label, "relabelled");
  });

  it("test-stream refuses internal destinations without connecting", async () => {
    for (const [url, code] of [
      ["rtsp://127.0.0.1:3000/x", "DEST_LOOPBACK"],
      ["rtsp://169.254.169.254:80/x", "DEST_METADATA"],
      ["http://[::1]:5432/", "DEST_LOOPBACK"],
    ] as const) {
      const r = await postJson("/api/camera-streams/test-stream", { url });
      assert.equal(r.status, 400, `${url}: ${r.text.slice(0, 200)}`);
      assert.equal(r.body.code, code);
      assert.equal(r.body.tcpConnected, false);
    }
  });

  it("test-stream answers never carry the URL", async () => {
    const r = await postJson("/api/camera-streams/test-stream", { url: "rtsp://admin:Itest-S3cret@192.0.2.45:1/x" });
    assert.doesNotMatch(r.text, /Itest-S3cret|rtsp:\/\//);
  });
});

describe("net guard: a stored destination refused at use is never dialled", () => {
  const STORED = "rtsp://itest-guard-camera.invalid:554/Streaming/Channels/1";
  let created = false;
  after(async () => {
    if (created) await api("/api/camera-streams/exit/streams/itest-guard-stored", { method: "DELETE" });
  });

  it("an unresolvable host is saved with a warning (DNS may be down while an operator edits)", async () => {
    const r = await postJson<any>("/api/camera-streams/exit/streams", { id: "itest-guard-stored", rtspUrl: STORED, enabled: false, priority: 992 });
    assert.equal(r.status, 201, r.text.slice(0, 200));
    created = true;
    assert.equal(r.body.warnings?.[0]?.code, "DEST_UNRESOLVED");
  });

  it("scan-rtsp on that stream answers 409 with the code and dials nothing", async () => {
    const r = await postJson<any>("/api/camera-streams/scan-rtsp", { gate: "exit", stream: "itest-guard-stored", scanType: "EXIT" });
    // 503 only when the recognition engine is unavailable and fails closed first.
    if (r.status === 503) return;
    assert.equal(r.status, 409, r.text.slice(0, 300));
    assert.equal(r.body.code, "DEST_UNRESOLVED");
    assert.equal(r.body.streamId, "itest-guard-stored");
    assert.equal(r.body.streams?.[0]?.code, "DEST_UNRESOLVED");
    assert.doesNotMatch(r.text, /itest-guard-camera\.invalid:554|rtsp:\/\//);
  });

  it("scan-rtsp's body `url` override is guarded too (400)", async () => {
    const r = await postJson<any>("/api/camera-streams/scan-rtsp", { gate: "exit", url: "rtsp://127.0.0.1:3000/x", scanType: "EXIT" });
    if (r.status === 503) return;
    assert.equal(r.status, 400, r.text.slice(0, 300));
    assert.equal(r.body.code, "DEST_LOOPBACK");
  });

  it("the snapshot falls back to the placeholder frame and names the code", async () => {
    const r = await api("/api/camera-streams/snapshot?gate=exit&stream=itest-guard-stored", { redirect: "manual" });
    assert.ok([302, 303].includes(r.status), `expected a redirect, got ${r.status}`);
    assert.equal(r.headers.get("x-dest-code"), "DEST_UNRESOLVED");
    assert.match(r.headers.get("location") || "", /test-frame/);
  });
});

describe("net guard: webhook destinations", () => {
  let original: any;
  before(async () => {
    const r = await api<any>("/api/webhook/config");
    assert.equal(r.status, 200);
    original = r.body;
  });
  after(async () => {
    await postJson("/api/webhook/config", { enabled: original.enabled, url: original.url || "" });
  });

  it("refuses loopback, metadata and private webhook URLs on save (400, nothing stored)", async () => {
    const cases: Array<[string, RegExp]> = [
      ["https://127.0.0.1/hooks/x", /^DEST_LOOPBACK$/],
      ["https://169.254.169.254/latest", /^DEST_METADATA$/],
      ["https://[::1]/hooks/x", /^DEST_LOOPBACK$/],
      ["https://10.1.2.3/hooks/x", /^DEST_(PRIVATE_WEBHOOK|NOT_ALLOWED)$/],
      ["https://192.168.1.10/hooks/x", /^DEST_(PRIVATE_WEBHOOK|NOT_ALLOWED)$/],
      ["http://127.0.0.1:9/stranger-webhook-sink", /^DEST_(SCHEME|LOOPBACK)$/],
    ];
    const before = (await api<any>("/api/webhook/config")).body.url;
    for (const [url, code] of cases) {
      const r = await postJson<any>("/api/webhook/config", { enabled: true, url });
      assert.equal(r.status, 400, `${url}: ${r.text.slice(0, 200)}`);
      assert.match(r.body.code, code, url);
      assert.equal(r.body.field, "url");
    }
    const afterUrl = (await api<any>("/api/webhook/config")).body.url;
    assert.equal(afterUrl, before, "a refused webhook URL was stored");
  });

  it("a stored webhook that the guard refuses at send time sends nothing and logs the code", async () => {
    const set = await postJson<any>("/api/webhook/config", { enabled: true, url: "https://itest-guard-webhook.invalid/itest", strangerAlertEnabled: true });
    assert.equal(set.status, 200, set.text.slice(0, 200));
    assert.equal(set.body.warnings?.[0]?.code, "DEST_UNRESOLVED");
    const r = await postJson<any>("/api/webhook/test-stranger", { logId: "LOG-ITEST-GUARD" });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.equal(r.body.log?.success, false);
    assert.equal(r.body.log?.code, "DEST_UNRESOLVED");
    assert.match(r.body.log?.error || "", /^DEST_UNRESOLVED: /);
  });
});

describe("net guard: door controller destination and token (N1)", () => {
  const TOKEN = "itest-door-token-Zq8x3";
  after(async () => {
    await api("/api/door-controller/config", { method: "POST", body: JSON.stringify({ enabled: false, apiUrl: "", apiToken: "", authHeaderType: "BEARER" }) });
  });

  it("refuses a loopback or metadata controller URL on save", async () => {
    for (const [url, code] of [
      ["http://127.0.0.1:3000/api/lock/unlock", "DEST_LOOPBACK"],
      ["http://169.254.169.254/latest", "DEST_METADATA"],
      ["http://localhost:8080/open", "DEST_LOOPBACK"],
    ] as const) {
      const r = await api<any>("/api/door-controller/config", { method: "POST", body: JSON.stringify({ apiUrl: url }) });
      assert.equal(r.status, 400, `${url}: ${r.text.slice(0, 200)}`);
      assert.equal(r.body.code, code);
      assert.equal(r.body.field, "apiUrl");
    }
    const cfg = await api<any>("/api/door-controller/config");
    assert.doesNotMatch(String(cfg.body.apiUrl || ""), /127\.0\.0\.1|169\.254|localhost/);
  });

  it("a refused controller gets no request, and the token is in no response or log entry", async () => {
    const saved = await api<any>("/api/door-controller/config", {
      method: "POST",
      body: JSON.stringify({
        enabled: true,
        apiUrl: "https://itest-guard-door.invalid/api/door?site=itest",
        apiToken: TOKEN,
        authHeaderType: "QUERY_PARAM",
      }),
    });
    assert.equal(saved.status, 200, saved.text.slice(0, 200));
    assert.equal(saved.body.warnings?.[0]?.code, "DEST_UNRESOLVED");
    assert.ok(!saved.text.includes(TOKEN));

    const test = await postJson<any>("/api/door-controller/test", { action: "OPEN", source: "net guard itest" });
    assert.equal(test.status, 200, test.text.slice(0, 200));
    assert.equal(test.body.success, false);
    assert.match(test.body.log?.error || "", /^DEST_UNRESOLVED: /);
    assert.ok(!test.text.includes(TOKEN), "door test response carries the token");
    assert.match(test.body.log?.url || "", /itest-guard-door\.invalid/);
    assert.doesNotMatch(test.body.log?.url || "", /token=/, "the logged URL must be the token-free base URL");

    const logs = await api<any>("/api/door-controller/logs");
    assert.equal(logs.status, 200);
    assert.ok(!logs.text.includes(TOKEN), "door log carries the token");
  });

  it("door config and logs stay admin-only", async () => {
    assert.equal((await rawApi("/api/door-controller/config")).status, 401);
    assert.equal((await rawApi("/api/door-controller/logs")).status, 401);
  });
});

describe("net guard: every refusal uses a DEST_* code", () => {
  it("codes are machine-readable", async () => {
    const r = await postJson<any>("/api/camera-streams/test-stream", { url: "rtsp://[fe80::1]/x" });
    assert.equal(r.status, 400);
    assert.match(r.body.code, DEST_CODE);
  });
});
