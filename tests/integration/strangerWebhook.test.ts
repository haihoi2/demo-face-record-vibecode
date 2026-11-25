/**
 * Stranger ("người lạ") alert webhook - HTTP integration suite.
 *
 * Covers the deep-link payload posted to the chat webhook when an unrecognised
 * face is captured:
 *   - GET/POST /api/webhook/config round-trips the new stranger fields and a
 *     partial POST never drops them,
 *   - POST /api/webhook/test-stranger builds a clickable `#strangers/<logId>`
 *     markdown link in `text`; the body is text only, never an attachment
 *     (an attachment cannot be copied in the phone chat client, 2026-11-25),
 *   - the base URL resolution order: appBaseUrl > APP_URL > X-Forwarded-* > Host,
 *   - strangerAlertEnabled:false sends nothing,
 *   - the cooldown throttles real alerts while the test endpoint bypasses it,
 *   - the real detection path (/api/recognize-face on a face-less frame) emits
 *     the alert, with no image bytes in the payload and no door unlock.
 *
 * Nothing is asserted against a live chat server: the webhook URL is pointed at
 * a `.invalid` host (RFC 6761: never resolves). The destination guard saves it
 * with a DEST_UNRESOLVED warning and refuses it at send time, so nothing leaves
 * the gateway, and the exact body that would have been posted is read back
 * from GET /api/webhook/logs, which records `payload` verbatim.
 *
 * Start the disposable server per tests/integration/README.md, publishing a
 * free host port (this suite was developed against 3179):
 *
 *   docker compose --profile test run --rm -d --name smartface-stranger-itest \
 *     -e DATABASE_URL= -e DATA_DIR=/tmp/data \
 *     -e ALLOW_SIMULATED_RECOGNITION=false \
 *     -p 3179:3000 --entrypoint sh tests -c 'npx tsx server.ts'
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, noFaceJpegDataUrl, postJson, recognize } from "./helpers";

/**
 * Never resolves (RFC 6761), so the send-time destination guard refuses it at
 * once (DEST_UNRESOLVED) and the payload is still logged. The old loopback sink
 * (http://127.0.0.1:9) is refused on save: see tests/integration/netGuard.test.ts.
 */
const SINK_URL = "https://stranger-webhook-sink.invalid/hooks-itest/stranger-webhook-sink";
const STRANGER_USER_NAME = "Người lạ";

interface WebhookLog {
  id: string;
  url: string;
  method: string;
  payload: { text: string; attachments?: unknown };
  success: boolean;
  scanType: "ENTRY" | "EXIT";
  userName: string;
}

interface WebhookConfig {
  enabled: boolean;
  url: string;
  gateInTitle: string;
  gateOutTitle: string;
  includeEmployeeCode: boolean;
  strangerAlertEnabled?: boolean;
  strangerTitle?: string;
  strangerLinkLabel?: string;
  appBaseUrl?: string;
  strangerCooldownSeconds?: number;
}

interface TestStrangerResponse {
  success: boolean;
  error?: string;
  log?: WebhookLog | null;
  baseUrl?: string;
  link?: string;
  config?: WebhookConfig;
}

async function getConfig(): Promise<WebhookConfig> {
  const res = await api<WebhookConfig>("/api/webhook/config");
  assert.equal(res.status, 200, `GET /api/webhook/config -> HTTP ${res.status}`);
  assert.ok(res.body, "GET /api/webhook/config returned no body");
  return res.body;
}

async function patchConfig(patch: Partial<WebhookConfig>): Promise<WebhookConfig> {
  const res = await postJson<{ success: boolean; config: WebhookConfig }>(
    "/api/webhook/config",
    patch
  );
  assert.equal(res.status, 200, `POST /api/webhook/config -> HTTP ${res.status} ${res.text.slice(0, 200)}`);
  assert.equal(res.body?.success, true);
  return res.body.config;
}

async function getWebhookLogs(): Promise<WebhookLog[]> {
  const res = await api<WebhookLog[]>("/api/webhook/logs");
  assert.equal(res.status, 200, `GET /api/webhook/logs -> HTTP ${res.status}`);
  assert.ok(Array.isArray(res.body), "GET /api/webhook/logs did not return an array");
  return res.body;
}

/** Newest-first list, so the head is the most recent dispatch. */
async function newestLogId(): Promise<string | undefined> {
  return (await getWebhookLogs())[0]?.id;
}

function sendTestStranger(
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {}
) {
  return postJson<TestStrangerResponse>("/api/webhook/test-stranger", body, headers);
}

/** Pull the exact body that was POSTed for a given webhook log id. */
async function payloadOf(logId: string): Promise<WebhookLog> {
  const logs = await getWebhookLogs();
  const found = logs.find((l) => l.id === logId);
  assert.ok(found, `webhook log ${logId} not found in GET /api/webhook/logs`);
  return found;
}

describe("stranger alert webhook", () => {
  let originalConfig: WebhookConfig;

  before(async () => {
    originalConfig = await getConfig();
    // Point the webhook at a dead local port before anything can fire, so no
    // test ever reaches the real Eton chat room.
    await patchConfig({
      enabled: true,
      url: SINK_URL,
      strangerAlertEnabled: true,
      strangerTitle: "[[CẢNH BÁO NGƯỜI LẠ]]",
      strangerLinkLabel: "Xem cụm ảnh người lạ",
      appBaseUrl: "",
      strangerCooldownSeconds: 0,
    });
  });

  after(async () => {
    // Restore whatever the gateway had before the suite ran.
    await patchConfig(originalConfig);
    const restored = await getConfig();
    assert.equal(restored.url, originalConfig.url, "original webhook url was not restored");
  });

  it("GET /api/webhook/config exposes the stranger fields with defaults", async () => {
    const config = await getConfig();
    assert.equal(typeof config.strangerAlertEnabled, "boolean");
    assert.equal(typeof config.strangerTitle, "string");
    assert.equal(typeof config.strangerLinkLabel, "string");
    assert.equal(typeof config.appBaseUrl, "string");
    assert.equal(typeof config.strangerCooldownSeconds, "number");
    assert.ok(config.strangerTitle!.length > 0);
    assert.ok(config.strangerLinkLabel!.length > 0);
  });

  it("POST /api/webhook/config round-trips every stranger field", async () => {
    const wanted = {
      strangerAlertEnabled: true,
      strangerTitle: "[[THỬ NGHIỆM NGƯỜI LẠ]]",
      strangerLinkLabel: "Mở cụm ảnh",
      appBaseUrl: "https://stg-gate-watch.vota.vn",
      strangerCooldownSeconds: 45,
    };
    const saved = await patchConfig(wanted);
    assert.equal(saved.strangerTitle, wanted.strangerTitle);
    assert.equal(saved.strangerLinkLabel, wanted.strangerLinkLabel);
    assert.equal(saved.appBaseUrl, wanted.appBaseUrl);
    assert.equal(saved.strangerCooldownSeconds, 45);

    const reloaded = await getConfig();
    assert.equal(reloaded.strangerTitle, wanted.strangerTitle);
    assert.equal(reloaded.strangerLinkLabel, wanted.strangerLinkLabel);
    assert.equal(reloaded.appBaseUrl, wanted.appBaseUrl);
    assert.equal(reloaded.strangerCooldownSeconds, 45);
    // The pre-existing half of the config must survive untouched.
    assert.equal(reloaded.url, SINK_URL);
    assert.equal(reloaded.gateInTitle, originalConfig.gateInTitle);
    assert.equal(reloaded.gateOutTitle, originalConfig.gateOutTitle);
  });

  it("a partial config POST does not drop the stranger fields", async () => {
    await patchConfig({ includeEmployeeCode: true });
    const reloaded = await getConfig();
    assert.equal(reloaded.strangerTitle, "[[THỬ NGHIỆM NGƯỜI LẠ]]");
    assert.equal(reloaded.appBaseUrl, "https://stg-gate-watch.vota.vn");
    assert.equal(reloaded.strangerCooldownSeconds, 45);
  });

  it("appBaseUrl wins and trailing slashes are stripped", async () => {
    await patchConfig({ appBaseUrl: "https://stg-gate-watch.vota.vn///" });
    const stored = await getConfig();
    assert.equal(stored.appBaseUrl, "https://stg-gate-watch.vota.vn");

    const res = await sendTestStranger({ logId: "LOG-ITEST-BASE" });
    assert.equal(res.status, 200);
    const log = res.body?.log;
    assert.ok(log, `no webhook log returned: ${res.text.slice(0, 300)}`);
    assert.equal(
      res.body!.link,
      "https://stg-gate-watch.vota.vn/#strangers/LOG-ITEST-BASE"
    );

    const posted = await payloadOf(log!.id);
    assert.equal(posted.userName, STRANGER_USER_NAME);
    assert.equal(posted.url, SINK_URL);
    assert.equal(posted.method, "POST");
    // The guard refused the unresolvable sink at send time: nothing was sent.
    assert.equal(posted.success, false);
    assert.equal((posted as any).code, "DEST_UNRESOLVED");
    assert.ok(
      posted.payload.text.includes("https://stg-gate-watch.vota.vn/#strangers/LOG-ITEST-BASE"),
      `text did not carry the configured base url: ${posted.payload.text}`
    );
  });

  it("the payload is one copyable text: title, alert line, details, markdown link; no attachment", async () => {
    const config = await getConfig();
    const res = await sendTestStranger({ logId: "LOG-ITEST-LINK", scanType: "EXIT" });
    assert.equal(res.status, 200);
    const log = res.body?.log;
    assert.ok(log, `no webhook log returned: ${res.text.slice(0, 300)}`);

    const posted = await payloadOf(log!.id);
    const { text } = posted.payload;

    // Text only. An attachment renders as a card the phone client cannot copy.
    assert.deepEqual(Object.keys(posted.payload), ["text"], "the chat body must be { text } and nothing else");
    assert.ok(text.includes("#strangers/"), `text has no deep link: ${text}`);
    assert.ok(
      text.includes(`[${config.strangerLinkLabel}](`),
      `text has no markdown link label: ${text}`
    );
    assert.ok(text.includes("Phát hiện người lạ"), `text is not the stranger alert: ${text}`);

    const lines = text.split("\n");
    assert.ok(lines[0].startsWith(`${config.strangerTitle} `), `the title must lead the first line: ${lines[0]}`);
    assert.ok(lines[0].includes("Phát hiện người lạ"), `first line is not the alert: ${lines[0]}`);
    assert.ok(lines.includes("Mã nhật ký: LOG-ITEST-LINK"), `the log id line is missing: ${text}`);
    assert.ok(
      lines.includes("Cửa giữ trạng thái KHÓA. Không có quyền ra vào nào được cấp."),
      `the door-stays-locked line is missing: ${text}`
    );
    assert.ok(lines[lines.length - 1].includes("#strangers/LOG-ITEST-LINK"), `the link must be the last line: ${text}`);

    // The log's own scan type is reused, and the user is the stranger label.
    assert.equal(posted.scanType, "EXIT");
    assert.equal(posted.userName, STRANGER_USER_NAME);

    // Chat webhooks reject large bodies: never attach the annotated snapshot.
    const serialized = JSON.stringify(posted.payload);
    assert.ok(!serialized.includes("base64"), "payload leaked image bytes");
    assert.ok(!serialized.includes("data:image"), "payload leaked an image data url");
    assert.ok(serialized.length < 4000, `payload unexpectedly large: ${serialized.length} bytes`);
  });

  // Owner request 2026-11-25: the recognised-employee message used to carry the
  // gate title as an attachment, which the phone chat client cannot copy.
  it("the recognised-employee message is one text line led by the gate title, no attachment", async () => {
    const config = await getConfig();
    const res = await postJson("/api/webhook/test", { testScanType: "EXIT", customUser: "Itest Person", customCode: "NV-ITEST" });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    const posted = await payloadOf(res.body.log.id);
    assert.deepEqual(Object.keys(posted.payload), ["text"], "the chat body must be { text } and nothing else");
    assert.ok(!posted.payload.text.includes("\n"), `expected a single line: ${posted.payload.text}`);
    assert.ok(
      posted.payload.text.startsWith(`${config.gateOutTitle} Itest Person`),
      `the gate title must lead the line: ${posted.payload.text}`
    );
    assert.equal(posted.scanType, "EXIT");
  });

  it("falls back to X-Forwarded-Proto / X-Forwarded-Host when appBaseUrl is empty", async () => {
    await patchConfig({ appBaseUrl: "" });
    const res = await sendTestStranger(
      { logId: "LOG-ITEST-FWD" },
      {
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "stg-gate-watch.vota.vn",
      }
    );
    assert.equal(res.status, 200);
    assert.equal(res.body?.baseUrl, "https://stg-gate-watch.vota.vn");
    assert.equal(res.body?.link, "https://stg-gate-watch.vota.vn/#strangers/LOG-ITEST-FWD");

    const posted = await payloadOf(res.body!.log!.id);
    assert.ok(
      posted.payload.text.includes("(https://stg-gate-watch.vota.vn/#strangers/LOG-ITEST-FWD)"),
      `the link ignored the forwarded headers: ${posted.payload.text}`
    );
  });

  it("falls back to the plain Host header when nothing else is configured", async () => {
    const res = await sendTestStranger({ logId: "LOG-ITEST-HOST" });
    assert.equal(res.status, 200);
    const link = res.body?.link || "";
    assert.ok(/^https?:\/\/[^/]+\/#strangers\/LOG-ITEST-HOST$/.test(link), `unexpected link: ${link}`);
    // Never a relative or scheme-less URL.
    assert.ok(link.startsWith("http://") || link.startsWith("https://"));
  });

  it("the real detection path emits a stranger alert with a log deep link", async () => {
    await patchConfig({
      appBaseUrl: "https://stg-gate-watch.vota.vn",
      strangerCooldownSeconds: 0,
    });
    const headBefore = await newestLogId();

    const res = await recognize({ imageBase64: noFaceJpegDataUrl(64, 7), scanType: "ENTRY" });
    assert.equal(res.status, 200, `POST /api/recognize-face -> HTTP ${res.status}`);
    assert.equal(res.body?.recognized, false, "a face-less frame must never be recognised");
    assert.notEqual(res.body?.lockUnlocked, true, "a stranger frame must never unlock the door");
    const accessLogId = (res.body as any)?.log?.id as string | undefined;
    assert.ok(accessLogId, "no DENIED access log returned");

    // Fire-and-forget dispatch: poll briefly for the log to land.
    let posted: WebhookLog | undefined;
    for (let i = 0; i < 40 && !posted; i++) {
      const logs = await getWebhookLogs();
      const head = logs[0];
      if (head && head.id !== headBefore && head.userName === STRANGER_USER_NAME) {
        posted = head;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(posted, "no stranger webhook was dispatched by /api/recognize-face");

    assert.equal(posted!.url, SINK_URL);
    assert.equal(posted!.scanType, "ENTRY");
    assert.ok(
      posted!.payload.text.includes(`#strangers/${accessLogId}`),
      `deep link does not target the access log: ${posted!.payload.text}`
    );
    assert.ok(
      posted!.payload.text.includes(`(https://stg-gate-watch.vota.vn/#strangers/${accessLogId})`),
      `deep link is not on the configured base url: ${posted!.payload.text}`
    );
    assert.equal(posted!.payload.attachments, undefined, "the real alert must be text only");
  });

  it("sends nothing when strangerAlertEnabled is false", async () => {
    await patchConfig({ strangerAlertEnabled: false });
    const headBefore = await newestLogId();

    const res = await sendTestStranger({ logId: "LOG-ITEST-OFF" });
    assert.equal(res.status, 200);
    assert.equal(res.body?.success, false);
    assert.equal(res.body?.log ?? null, null);
    assert.ok(res.body?.error, "no explanation returned for the suppressed alert");

    // And the real detection path stays quiet too.
    const detect = await recognize({ imageBase64: noFaceJpegDataUrl(64, 11), scanType: "ENTRY" });
    assert.equal(detect.status, 200);
    assert.notEqual(detect.body?.lockUnlocked, true);
    await new Promise((r) => setTimeout(r, 600));

    assert.equal(await newestLogId(), headBefore, "a webhook was dispatched while the alert was off");
    await patchConfig({ strangerAlertEnabled: true });
  });

  it("the cooldown suppresses a second immediate alert, and the test route bypasses it", async () => {
    // respectCooldown:true drives the same throttling path a real detection
    // uses. Start the window from a known point with the cooldown disabled, so
    // the test does not depend on what an earlier case dispatched.
    await patchConfig({ strangerCooldownSeconds: 0 });
    const first = await sendTestStranger({ logId: "LOG-ITEST-CD-1", respectCooldown: true });
    assert.equal(first.status, 200);
    assert.ok(first.body?.log, `first throttled alert was not sent: ${first.text.slice(0, 300)}`);

    await patchConfig({ strangerCooldownSeconds: 60 });
    const second = await sendTestStranger({ logId: "LOG-ITEST-CD-2", respectCooldown: true });
    assert.equal(second.status, 200);
    assert.equal(second.body?.success, false, "the cooldown did not suppress the second alert");
    assert.equal(second.body?.log ?? null, null);
    assert.match(String(second.body?.error), /cooldown|chờ/i);

    // A real detection inside the window is throttled as well, but the access
    // log and the HTTP response are unaffected.
    const beforeDetect = await newestLogId();
    const detect = await recognize({ imageBase64: noFaceJpegDataUrl(64, 13), scanType: "ENTRY" });
    assert.equal(detect.status, 200);
    assert.equal(detect.body?.recognized, false);
    assert.notEqual(detect.body?.lockUnlocked, true);
    assert.ok((detect.body as any)?.log?.id, "the cooldown blocked the access log");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await newestLogId(), beforeDetect, "the cooldown did not throttle a real alert");

    // The operator test endpoint still gets through.
    const bypass = await sendTestStranger({ logId: "LOG-ITEST-CD-3" });
    assert.equal(bypass.status, 200);
    assert.ok(bypass.body?.log, "the test endpoint did not bypass the cooldown");
    assert.ok(bypass.body!.log!.payload.text.includes("#strangers/LOG-ITEST-CD-3"));
  });

  it("sends nothing when the webhook itself is disabled", async () => {
    await patchConfig({ enabled: false });
    const headBefore = await newestLogId();

    const res = await sendTestStranger({ logId: "LOG-ITEST-DISABLED" });
    assert.equal(res.status, 200);
    assert.equal(res.body?.success, false);
    assert.equal(res.body?.log ?? null, null);
    assert.equal(await newestLogId(), headBefore, "a webhook was dispatched while disabled");

    await patchConfig({ enabled: true });
  });
});
