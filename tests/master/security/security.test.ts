/**
 * MT security suite (plan section 6): black-box checks against an ISOLATED gateway.
 *
 *   APP_URL=http://smartface-verify-rt-mt:3000 node --import tsx --test --test-concurrency=1 tests/master/security/*.test.ts
 *
 * Findings that are known and waived for a run are listed in MT_WAIVE
 * (comma-separated ids, e.g. "SSRF-VIEWER-URL,SSRF-STORED"); a waived case is
 * reported as TODO instead of failing. Never waive in a release sign-off
 * without the owner's written decision.
 *
 * Needs no NVR, camera or door: planted secrets are fake, outbound targets are
 * a listener inside this test container or RFC 5737 TEST-NET addresses.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { api, getLockState, lockDoor, postJson, rawApi } from "../../integration/helpers.ts";
import { assertNoCanary, BASE_URL, CANARY_PASSWORD, CANARY_RTSP, getAs, jpegSize, routePresent, sseCapture, tcpListener, viewer, waitFor, type Listener } from "../lib/probe.ts";

const WAIVED = new Set(String(process.env.MT_WAIVE || "").split(",").map((s) => s.trim()).filter(Boolean));
const finding = (id: string) => (WAIVED.has(id) ? { todo: `waived finding ${id}` } : {});

async function originalConfig() {
  const r = await api("/api/camera-streams/config");
  assert.equal(r.status, 200);
  return r.body.config;
}

describe("MT security: RBAC on footage, images and pipeline routes", () => {
  it("anonymous callers get 401 on recordings, log images and the watcher state", async () => {
    for (const path of ["/api/recordings/config", "/api/logs/LOG-1/recording", "/api/logs/LOG-1/image", "/api/camera-streams/watch", "/api/events"]) {
      const r = await rawApi(path);
      assert.equal(r.status, 401, `${path} -> ${r.status}`);
    }
  });

  it("a viewer can read recordings config but cannot change watch, streams or pipeline settings", async () => {
    const v = await viewer();
    const cfg = await getAs(v, "/api/recordings/config");
    assert.equal(cfg.status, 200);
    assertNoCanary("recordings config", cfg.text);
    assert.doesNotMatch(cfg.text, /rtsp:\/\//i, "recordings config must not name the NVR address");
    for (const [method, path] of [
      ["POST", "/api/camera-streams/entry/watch"],
      ["POST", "/api/camera-streams/config"],
      ["POST", "/api/camera-streams/exit/streams"],
      ["POST", "/api/pipeline/mode"],
      ["PUT", "/api/camera-streams/entry/roi"],
    ] as const) {
      const r = await rawApi(path, { method, headers: { Cookie: v, "Content-Type": "application/json", "X-CSRF-Token": "x" }, body: "{}" });
      assert.ok(r.status === 401 || r.status === 403, `${method} ${path} as viewer -> ${r.status}`);
    }
  });

  it("new pipeline read routes, when present, need a session and never carry credentials or embeddings", async (t) => {
    const candidates = ["/api/pipeline/status", "/api/pipeline/state", "/api/pipeline/shadow", "/api/pipeline/results", "/api/pipeline/tracks", "/api/camera-streams/entry/roi", "/api/camera-streams/exit/roi"];
    const v = await viewer();
    let present = 0;
    for (const path of candidates) {
      const anon = await rawApi(path);
      assert.equal(anon.status, 401, `${path} anonymous -> ${anon.status}`);
      if (!(await routePresent(v, path))) continue;
      present++;
      const r = await getAs(v, path);
      assert.ok(r.status === 200 || r.status === 403, `${path} as viewer -> ${r.status}`);
      assertNoCanary(path, r.text);
      assert.doesNotMatch(r.text, /"(?:embedding|faceEmbedding|rgb)"\s*:\s*\[/, `${path} exposes raw embeddings or pixels`);
    }
    if (present === 0) t.skip("no pipeline routes in this build yet (W2)");
  });
});

describe("MT security: no credentials in API responses or SSE", () => {
  let cfg: any;
  before(async () => {
    cfg = await originalConfig();
  });
  after(async () => {
    await postJson("/api/camera-streams/config", { entryGate: cfg.entryGate, exitGate: cfg.exitGate });
  });

  it("a planted camera password never comes back from config, streams, watch state, scans or SSE", async () => {
    const admin = (await api("/api/camera-streams/watch")).status === 200;
    assert.ok(admin);
    const v = await viewer();
    const sse = await sseCapture(v);
    try {
      const set = await postJson("/api/camera-streams/entry/streams", { id: "mt-canary", label: "MT canary", rtspUrl: CANARY_RTSP, enabled: false, priority: 999 });
      assert.equal(set.status, 201, set.text.slice(0, 200));
      assertNoCanary("POST streams response", set.text);
      for (const path of ["/api/camera-streams/config", "/api/camera-streams/entry/streams", "/api/camera-streams/watch", "/api/camera-streams/threads"]) {
        const r = await getAs(v, path);
        assert.equal(r.status, 200, path);
        assertNoCanary(`viewer GET ${path}`, r.text);
        const a = await api(path);
        assertNoCanary(`admin GET ${path}`, a.text);
      }
      // A scan of the (unreachable) canary stream fails; its error must not echo the URL.
      const scan = await postJson("/api/camera-streams/scan-rtsp", { gate: "entry", stream: "mt-canary", scanType: "ENTRY" });
      assertNoCanary("scan-rtsp response", scan.text);
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      sse.stop();
      await api("/api/camera-streams/entry/streams/mt-canary", { method: "DELETE" });
    }
    assert.ok(sse.events.some((e) => e.event === "camera_config_updated"), "expected a camera_config_updated event");
    assertNoCanary("SSE stream", sse.raw());
  });
});

describe("MT security: SSRF through camera, webhook and door destinations", () => {
  let listener: Listener | null = null;
  before(async () => {
    listener = await tcpListener();
  });
  after(async () => {
    await listener?.close();
  });

  it("[SSRF-VIEWER-URL] a VIEWER cannot make the gateway open an arbitrary RTSP destination via ?url=", finding("SSRF-VIEWER-URL"), async (t) => {
    if (!listener) return t.skip("no IPv4 on the test network");
    const v = await viewer();
    const target = `rtsp://${listener.host}:${listener.port}/mt-ssrf`;
    const before = listener.connections.length;
    const r = await getAs(v, `/api/camera-streams/snapshot?gate=entry&url=${encodeURIComponent(target)}`, { redirect: "manual" });
    const reached = await waitFor(() => listener!.connections.length > before, 4000);
    assert.equal(reached, false, `viewer GET snapshot?url= made the gateway connect to ${listener.host}:${listener.port} (HTTP ${r.status})`);
    assert.ok(r.status === 400 || r.status === 403, `expected 400/403 for an unconfigured destination, got ${r.status}`);
  });

  it("[SSRF-VIEWER-URL] the MJPEG proxy does not accept ?url= either", finding("SSRF-VIEWER-URL"), async (t) => {
    if (!listener) return t.skip("no IPv4 on the test network");
    const v = await viewer();
    const ctrl = new AbortController();
    const before = listener.connections.length;
    const pending = fetch(`${BASE_URL}/api/camera-streams/mjpeg?gate=exit&url=${encodeURIComponent(`rtsp://${listener.host}:${listener.port}/mt-mjpeg`)}`, {
      headers: { Cookie: v },
      signal: ctrl.signal,
    }).catch(() => null);
    const reached = await waitFor(() => listener!.connections.length > before, 4000);
    ctrl.abort();
    await pending;
    assert.equal(reached, false, "viewer GET mjpeg?url= made the gateway connect to an arbitrary host");
  });

  it("[SSRF-LOOPBACK] a stored stream may not target loopback, link-local or metadata addresses", finding("SSRF-STORED"), async () => {
    const bad = ["rtsp://127.0.0.1:3000/x", "rtsp://localhost:5432/x", "rtsp://169.254.169.254/latest", "rtsp://[::1]:3000/x", "rtsp://0.0.0.0:22/x"];
    const accepted: string[] = [];
    for (const [i, url] of bad.entries()) {
      const r = await postJson("/api/camera-streams/exit/streams", { id: `mt-ssrf-${i}`, rtspUrl: url, enabled: false, priority: 900 + i });
      if (r.status === 201) {
        accepted.push(url);
        await api(`/api/camera-streams/exit/streams/mt-ssrf-${i}`, { method: "DELETE" });
      }
    }
    assert.deepEqual(accepted, [], `stored stream destinations accepted without an allowlist: ${accepted.join(", ")}`);
  });

  it("[SSRF-STORED] a stored stream outside the camera allowlist is refused, not dialled", finding("SSRF-STORED"), async (t) => {
    if (!listener) return t.skip("no IPv4 on the test network");
    const url = `rtsp://${listener.host}:${listener.port}/mt-stored`;
    const before = listener.connections.length;
    const add = await postJson("/api/camera-streams/exit/streams", { id: "mt-ssrf-stored", rtspUrl: url, enabled: false, priority: 950 });
    try {
      if (add.status === 201) await postJson("/api/camera-streams/scan-rtsp", { gate: "exit", stream: "mt-ssrf-stored", scanType: "EXIT" });
      const reached = await waitFor(() => listener!.connections.length > before, 3000);
      assert.notEqual(add.status, 201, "an arbitrary internal destination was stored as a camera");
      assert.equal(reached, false, "the gateway dialled the stored arbitrary destination");
    } finally {
      await api("/api/camera-streams/exit/streams/mt-ssrf-stored", { method: "DELETE" });
    }
  });

  it("[SSRF-TEST-STREAM] test-stream does not act as a TCP port scanner for internal hosts", finding("SSRF-TEST-STREAM"), async (t) => {
    if (!listener) return t.skip("no IPv4 on the test network");
    const before = listener.connections.length;
    const r = await postJson("/api/camera-streams/test-stream", { url: `rtsp://${listener.host}:${listener.port}/mt-probe` });
    const reached = await waitFor(() => listener!.connections.length > before, 3000);
    assert.equal(reached, false, `test-stream connected to an arbitrary host:port (HTTP ${r.status})`);
  });

  it("[SSRF-WEBHOOK] the webhook destination is validated against an allowlist", finding("SSRF-WEBHOOK"), async (t) => {
    if (!listener) return t.skip("no IPv4 on the test network");
    const orig = await api("/api/webhook/config");
    if (orig.status !== 200) return t.skip(`webhook config not readable (${orig.status})`);
    const before = listener.connections.length;
    try {
      const set = await postJson("/api/webhook/config", { enabled: true, url: `http://${listener.host}:${listener.port}/hooks/mt` });
      if (set.status === 200) await postJson("/api/webhook/test", { testScanType: "ENTRY", customUser: "MT", customCode: "MT-1" });
      const reached = await waitFor(() => listener!.connections.length > before, 3000);
      assert.notEqual(set.status, 200, "an arbitrary internal webhook destination was accepted");
      assert.equal(reached, false, "the gateway posted a webhook to an arbitrary internal host");
    } finally {
      // Restore: the GET redacts the URL, so fall back to disabling the webhook.
      await postJson("/api/webhook/config", { enabled: false, url: "" });
    }
  });
});

describe("MT security: malformed and oversized input on pipeline-adjacent routes", () => {
  it("rejects a watch config with wrong types and leaves the gate unchanged", async () => {
    const before = await api("/api/camera-streams/watch");
    for (const body of [{ enabled: "yes" }, { intervalSeconds: "1e9" }, { frames: -1 }, { intervalSeconds: 0.1 }]) {
      const r = await postJson("/api/camera-streams/entry/watch", body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status}`);
    }
    const afterRes = await api("/api/camera-streams/watch");
    assert.deepEqual(
      afterRes.body.watchers.map((w: any) => [w.gate, w.enabled, w.intervalSeconds, w.frames]),
      before.body.watchers.map((w: any) => [w.gate, w.enabled, w.intervalSeconds, w.frames]),
    );
  });

  it("answers 413 to a body over the size limit and stays healthy", async () => {
    const big = "x".repeat(51 * 1024 * 1024);
    const r = await postJson("/api/camera-streams/config", { junk: big });
    assert.equal(r.status, 413, `oversized body -> ${r.status}`);
    const h = await rawApi("/api/health");
    assert.equal(h.status, 200);
  });

  it("refuses path tricks in stream ids and log ids", async () => {
    const r1 = await postJson("/api/camera-streams/exit/streams", { id: "../../etc", rtspUrl: "rtsp://192.0.2.11/x", enabled: false });
    assert.equal(r1.status, 400);
    for (const id of ["..%2F..%2Fetc", "%00", "a".repeat(300)]) {
      const r = await api(`/api/logs/${id}/image`);
      assert.ok(r.status === 400 || r.status === 404, `image ${id.slice(0, 20)} -> ${r.status}`);
    }
  });
});

describe("MT security: fail closed without a real engine (FAILCLOSED_APP_URL)", () => {
  const url = process.env.FAILCLOSED_APP_URL;
  it("reports the engine unavailable, denies recognition and never unlocks", async (t) => {
    if (!url) return t.skip("set FAILCLOSED_APP_URL to a gateway started with FACE_MODEL_DIR pointing at no models");
    const login = await fetch(`${url}/api/operator/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: process.env.OPERATOR_TOKEN || "integration-operator-token" }) });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") || "").split(";", 1)[0];
    const status = await (await fetch(`${url}/api/face-engine/status`, { headers: { Cookie: cookie } })).json();
    assert.notEqual(status?.engine, "onnx", `engine must not report onnx without models: ${JSON.stringify(status).slice(0, 200)}`);
    if (status?.requestedEngine === "onnx") assert.equal(status?.failClosed, true, "FACE_ENGINE=onnx without models must report failClosed");
    const rec = await fetch(`${url}/api/recognize-face`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.DEVICE_INGEST_TOKEN || "integration-device-token"}` },
      body: JSON.stringify({ imageBase64: "data:image/jpeg;base64,/9j/4AAQ", scanType: "ENTRY" }),
    });
    const body: any = await rec.json().catch(() => ({}));
    assert.notEqual(body.lockUnlocked, true, "recognition without an engine must not unlock");
    assert.notEqual(body.recognized, true, "recognition without an engine must not recognise");
    const lock = await (await fetch(`${url}/api/lock/status`, { headers: { Cookie: cookie } })).json();
    assert.notEqual(lock.state, "UNLOCKED");
    const watch = await (await fetch(`${url}/api/camera-streams/watch`, { headers: { Cookie: cookie } })).json();
    for (const w of watch.watchers || []) {
      if (w.enabled) assert.match(String(w.lastError || ""), /FAIL-CLOSED|không khả dụng|unavailable/i, `watcher ${w.gate} must idle fail-closed`);
    }
  });
});

describe("MT security: shadow mode never acts (gateway started with PIPELINE_MODE_*=shadow)", () => {
  it("a gate in shadow writes no access log and never unlocks while the harness plays an enrolled face", async (t) => {
    const watch = await api("/api/camera-streams/watch");
    const shadowGates = (watch.body?.watchers || []).filter((w: any) => w.pipelineMode === "shadow").map((w: any) => w.gate);
    if (shadowGates.length === 0) return t.skip("no gate runs in shadow mode on this gateway (needs the W2 wiring and PIPELINE_MODE_*=shadow)");
    const windowS = Number(process.env.MT_SHADOW_WINDOW_S || 60);
    if (!process.env.MT_HARNESS_PLAYING) return t.skip("set MT_HARNESS_PLAYING=1 once the runner plays an enrolled passage on the shadow gates");
    await lockDoor("mt shadow baseline");
    const v = await viewer();
    const sse = await sseCapture(v);
    const from = new Date().toISOString();
    await new Promise((r) => setTimeout(r, windowS * 1000));
    sse.stop();
    const logs = await api(`/api/logs?paging=cursor&from=${encodeURIComponent(from)}&limit=200`);
    const shadowLogs = (logs.body?.logs || []).filter((l: any) => shadowGates.includes(l.type));
    assert.equal(shadowLogs.length, 0, `shadow gates wrote ${shadowLogs.length} access log(s)`);
    const lock = await getLockState();
    assert.equal(lock.state, "LOCKED", "a shadow gate unlocked the door");
    assert.ok(!sse.events.some((e) => e.event === "lock_state" && /UNLOCK/.test(e.data)), "lock_state UNLOCK event during shadow run");
    assert.ok(sse.events.some((e) => e.event === "pipeline_shadow_result"), "shadow mode must publish pipeline_shadow_result events");
    for (const e of sse.events.filter((x) => x.event === "pipeline_shadow_result")) {
      assertNoCanary("pipeline_shadow_result", e.data);
      assert.doesNotMatch(e.data, /"(?:embedding|rgb|crop)"\s*:/, "shadow events must not carry embeddings, pixels or crops");
    }
  });
});

describe("MT security: only face crops are stored and served (MT_EXPECT_CROPS=1 after W2)", () => {
  it("every stored access-log image is a face crop, not a camera frame", async (t) => {
    if (process.env.MT_EXPECT_CROPS !== "1") return t.skip("crops are a W2 feature; set MT_EXPECT_CROPS=1 for the integrated build");
    const logs = await api("/api/logs?paging=cursor&limit=50");
    const withImage = (logs.body?.logs || []).filter((l: any) => l.hasImage);
    if (withImage.length === 0) return t.skip("no access log with an image yet (run a replay first)");
    for (const l of withImage) {
      const r = await fetch(`${BASE_URL}/api/logs/${encodeURIComponent(l.id)}/image`, { headers: { Cookie: await viewer() } });
      const buf = Buffer.from(await r.arrayBuffer());
      const size = jpegSize(buf);
      assert.ok(size, `log ${l.id} image is not a JPEG`);
      assert.ok(size!.width <= 1024 && size!.height <= 1024, `log ${l.id} image is ${size!.width}x${size!.height}: a frame, not a crop`);
      assert.ok(buf.length <= 200 * 1024, `log ${l.id} image is ${buf.length} bytes`);
    }
  });
});

describe("MT security: lock is untouched by the suite", () => {
  it("leaves the door LOCKED", async () => {
    const s = await getLockState();
    assert.notEqual(s.state, "UNLOCKED");
    assert.ok(!JSON.stringify(s).includes(CANARY_PASSWORD));
  });
});
