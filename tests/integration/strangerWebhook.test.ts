/**
 * Stranger ("người lạ") alert webhook - HTTP integration suite.
 *
 * Covers the deep-link payload posted to the chat webhook when an unrecognised
 * face is captured:
 *   - GET/POST /api/webhook/config round-trips the new stranger fields and a
 *     partial POST never drops them,
 *   - POST /api/webhook/test-stranger builds a clickable `#strangers/<logId>`
 *     link (markdown in `text` AND `title_link` on the attachment),
 *   - the base URL resolution order: appBaseUrl > APP_URL > X-Forwarded-* > Host,
 *   - strangerAlertEnabled:false sends nothing,
 *   - the cooldown throttles real alerts while the test endpoint bypasses it,
 *   - the real detection path (/api/recognize-face on a face-less frame) emits
 *     the alert, with no image bytes in the payload and no door unlock.
 *
 * Nothing is asserted against a live chat server: the webhook URL is pointed at
 * a dead local port, and the exact posted body is read back from
 * GET /api/webhook/logs, which records `payload` verbatim.
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

/** Discard port on loopback: the POST fails fast, the payload is still logged. */
const SINK_URL = "http://127.0.0.1:9/stranger-webhook-sink";
const STRANGER_USER_NAME = "Người lạ";

interface WebhookAttachment {
  title: string;
  title_link?: string;
  text?: string;
}

interface WebhookLog {
  id: string;
  url: string;
  method: string;
  payload: { text: string; attachments: WebhookAttachment[] };
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
    assert.ok(
      posted.payload.text.includes("https://stg-gate-watch.vota.vn/#strangers/LOG-ITEST-BASE"),
      `text did not carry the configured base url: ${posted.payload.text}`
    );
  });

  it("the payload carries a markdown link and an attachment title_link", async () => {
    const config = await getConfig();
    const res = await sendTestStranger({ logId: "LOG-ITEST-LINK", scanType: "EXIT" });
    assert.equal(res.status, 200);
    const log = res.body?.log;
    assert.ok(log, `no webhook log returned: ${res.text.slice(0, 300)}`);

    const posted = await payloadOf(log!.id);
    const { text, attachments } = posted.payload;

    // Mattermost/Eton shape: { text, attachments: [{ title, title_link, text }] }
    assert.ok(text.includes("#strangers/"), `text has no deep link: ${text}`);
    assert.ok(
      text.includes(`[${config.strangerLinkLabel}](`),
      `text has no markdown link label: ${text}`
    );
    assert.ok(text.includes("Phát hiện người lạ"), `text is not the stranger alert: ${text}`);

    assert.equal(attachments.length, 1);
    const attachment = attachments[0];
    assert.equal(attachment.title, config.strangerTitle);
    assert.ok(attachment.title_link, "attachment has no title_link");
    assert.ok(attachment.title_link!.includes("#strangers/LOG-ITEST-LINK"));
    assert.ok(text.includes(attachment.title_link!), "text link and title_link disagree");

    // The log's own scan type is reused, and the user is the stranger label.
    assert.equal(posted.scanType, "EXIT");
    assert.equal(posted.userName, STRANGER_USER_NAME);

    // Chat webhooks reject large bodies: never attach the annotated snapshot.
    const serialized = JSON.stringify(posted.payload);
    assert.ok(!serialized.includes("base64"), "payload leaked image bytes");
    assert.ok(!serialized.includes("data:image"), "payload leaked an image data url");
    assert.ok(serialized.length < 4000, `payload unexpectedly large: ${serialized.length} bytes`);
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
      posted.payload.attachments[0].title_link ===
        "https://stg-gate-watch.vota.vn/#strangers/LOG-ITEST-FWD",
      `title_link ignored the forwarded headers: ${posted.payload.attachments[0].title_link}`
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
    assert.equal(
      posted!.payload.attachments[0].title_link,
      `https://stg-gate-watch.vota.vn/#strangers/${accessLogId}`
    );
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
