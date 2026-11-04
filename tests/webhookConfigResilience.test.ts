/**
 * getWebhookConfig is read-only and survives a transient SQLite failure
 * (regression for 2026-11-03: a "database is locked" during maintenance made
 * the getter return defaults and the heal paths persisted them, switching the
 * gate's webhook and presence alerts off for 18 hours).
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "webhook-cfg-"));
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
process.env.DATA_DIR = dataDir;
delete process.env.DATABASE_URL;
const { db } = await import("../src/server/db");

const DEFAULTS = {
  enabled: false,
  url: "",
  gateInTitle: "[[CỔNG VÀO]]",
  gateOutTitle: "[[CỔNG RA]]",
  includeEmployeeCode: true,
  strangerAlertEnabled: true,
  strangerTitle: "[[CẢNH BÁO NGƯỜI LẠ]]",
  strangerLinkLabel: "Xem cụm ảnh người lạ",
  appBaseUrl: "",
  strangerCooldownSeconds: 60,
} as any;
const CONFIGURED = { ...DEFAULTS, enabled: true, url: "https://chat.example.test/hooks/room/abc123" };

const sqlite = () => (db as any).db as { prepare: (sql: string) => any } | null;
assert.ok(sqlite(), "this test needs the native SQLite store");

describe("getWebhookConfig resilience", () => {
  it("no row yet: returns the defaults WITHOUT creating a row", () => {
    const got = db.getWebhookConfig(DEFAULTS);
    assert.equal(got.enabled, false);
    assert.equal(sqlite()!.prepare("SELECT count(*) AS n FROM webhook_config").get().n, 0);
  });

  it("reads back a saved configuration", () => {
    db.saveWebhookConfig(CONFIGURED);
    const got = db.getWebhookConfig(DEFAULTS);
    assert.equal(got.enabled, true);
    assert.equal(got.url, CONFIGURED.url);
  });

  it("a transient read failure returns the last good configuration and writes nothing", () => {
    const store = sqlite()!;
    const realPrepare = store.prepare.bind(store);
    let calls = 0;
    (store as any).prepare = (sql: string) => {
      calls += 1;
      if (/FROM webhook_config/i.test(sql) || /INTO webhook_config/i.test(sql)) throw new Error("database is locked");
      return realPrepare(sql);
    };
    try {
      const got = db.getWebhookConfig(DEFAULTS);
      assert.equal(got.enabled, true, "last good config, not the defaults");
      assert.equal(got.url, CONFIGURED.url);
    } finally {
      (store as any).prepare = realPrepare;
    }
    assert.ok(calls >= 1);
    const row = realPrepare("SELECT enabled, url FROM webhook_config WHERE id = 'default'").get();
    assert.equal(Boolean(row.enabled), true, "the stored row was not overwritten");
    assert.equal(row.url, CONFIGURED.url);
  });

  it("a malformed stored URL is reported as stored, never rewritten by the getter", () => {
    db.saveWebhookConfig({ ...CONFIGURED, url: "https://chat.example.test/hooks/" });
    const got = db.getWebhookConfig(DEFAULTS);
    assert.equal(got.url, "https://chat.example.test/hooks/");
    const row = sqlite()!.prepare("SELECT url FROM webhook_config WHERE id = 'default'").get();
    assert.equal(row.url, "https://chat.example.test/hooks/");
  });
});
