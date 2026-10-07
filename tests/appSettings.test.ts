/**
 * Admin settings store in the local stores (src/server/db.ts, app_settings):
 * getAppSetting / saveAppSetting / updateAppSetting on native SQLite and the
 * JSON fallback, run as the same scenario (tests/fixtures/appSettingsScenario.ts)
 * in child processes, since the storage module is a singleton bound to DATA_DIR
 * at import. PostgreSQL runs it in tests/integration/appSettingsPersistence.test.ts.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  assertAppSettingsReadBack,
  assertAppSettingsScenario,
  runAppSettingsChild,
  logsOf,
  SECRET_MARKER,
} from "./fixtures/appSettingsScenario";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const scratch: string[] = [];
const tmpDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

// Importing db.ts opens a store, so point it at scratch first.
process.env.DATA_DIR = tmpDir("app-settings-pure-");
delete process.env.DATABASE_URL;
const { APP_SETTING_KEY_PATTERN, APP_SETTING_MAX_BYTES } = await import("../src/server/db");

const UNREACHABLE_PG = "postgresql://nobody:none@127.0.0.1:1/none";
const NO_SQLITE = ["--no-experimental-sqlite"];

describe("app settings constants", () => {
  it("key pattern and size limit match the contract", () => {
    assert.equal(APP_SETTING_KEY_PATTERN.source, "^[a-z][a-z0-9_]{1,63}$");
    assert.equal(APP_SETTING_MAX_BYTES, 65536);
    for (const ok of ["notification_channels", "notification_routes", "presence_gate_settings", "ab", "a".repeat(64)]) {
      assert.equal(APP_SETTING_KEY_PATTERN.test(ok), true, ok);
    }
    for (const bad of ["a", "_a", "1a", "a-b", "A", "a".repeat(65), "a b"]) {
      assert.equal(APP_SETTING_KEY_PATTERN.test(bad), false, bad);
    }
  });
});

describe("SQLite: app settings", () => {
  const dataDir = tmpDir("app-settings-sqlite-");
  const env = { DATA_DIR: dataDir, DATABASE_URL: "" };

  it("runs the shared scenario", async () => {
    const r = await runAppSettingsChild("runAppSettingsScenario", env);
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.equal(r.out.mode, "sqlite");
    assertAppSettingsScenario(r.out, assert);
    assert.doesNotMatch(logsOf(r), new RegExp(SECRET_MARKER), "values are never logged");
  });

  it("reads everything back after a restart", async () => {
    const r = await runAppSettingsChild("readBackAppSettings", env);
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.equal(r.out.mode, "sqlite");
    assertAppSettingsReadBack(r.out, assert);
  });

  it("stores the planned schema; the key CHECK and NOT NULL hold in the database itself", () => {
    const db = new DatabaseSync(path.join(dataDir, "smartface.db"));
    try {
      const cols = (db.prepare("PRAGMA table_info(app_settings)").all() as any[]).map((c) => [c.name, c.type, c.notnull, c.pk]);
      assert.deepEqual(cols, [
        ["key", "TEXT", 0, 1],
        ["value", "TEXT", 1, 0],
        ["updatedAt", "TEXT", 1, 0],
        ["updatedBy", "TEXT", 1, 0],
      ]);
      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'notification_routes'").get() as any;
      assert.equal(typeof row.value, "string", "value stored as JSON text");
      assert.deepEqual(JSON.parse(row.value).stranger, "eton-default");
      const insert = (key: string) => db.prepare("INSERT INTO app_settings (key, value, updatedAt, updatedBy) VALUES (?, '{}', 'x', 'y')").run(key);
      for (const bad of ["Bad", "a", "1ab", "a-b", "a".repeat(65), "_ab"]) {
        assert.throws(() => insert(bad), /CHECK constraint/, bad);
      }
      assert.throws(() => db.prepare("INSERT INTO app_settings (key, value, updatedAt, updatedBy) VALUES ('ok_key', NULL, 'x', 'y')").run(), /NOT NULL/);
      assert.throws(() => insert("counter"), /UNIQUE|PRIMARY/, "one row per key");
    } finally {
      db.close();
    }
  });

  it("skips a malformed row instead of failing (key logged, never the value)", async () => {
    const db = new DatabaseSync(path.join(dataDir, "smartface.db"));
    try {
      db.prepare("INSERT INTO app_settings (key, value, updatedAt, updatedBy) VALUES ('broken_row', ?, 'x', 'y')").run(`{"url":"${SECRET_MARKER}"`);
    } finally {
      db.close();
    }
    const r = await runAppSettingsChild("probeAppSettings", env);
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.equal(r.out.saved, true);
    assert.deepEqual(r.out.after, { v: 1 });
    assert.match(r.stdout + r.stderr, /broken_row/);
    assert.doesNotMatch(logsOf(r), new RegExp(SECRET_MARKER));
  });

  it("rollback by DROP TABLE, then a restart re-creates the table (idempotent migration)", async () => {
    const db = new DatabaseSync(path.join(dataDir, "smartface.db"));
    try {
      db.exec("DROP TABLE app_settings");
    } finally {
      db.close();
    }
    const r = await runAppSettingsChild("probeAppSettings", env);
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.deepEqual(
      { before: r.out.before, saved: r.out.saved, after: r.out.after, routes: r.out.routes },
      { before: null, saved: true, after: { v: 1 }, routes: null },
      "dropping the table loses only the settings; the store works again after a restart",
    );
    const again = await runAppSettingsChild("probeAppSettings", env);
    assert.equal(again.code, 0, again.stderr.slice(-3000));
    assert.deepEqual(again.out.before, { key: "probe_key", value: { v: 1 }, updatedAt: again.out.before.updatedAt, updatedBy: "admin" });
    assert.doesNotMatch(r.stderr + again.stderr, /Lỗi khởi tạo bảng app_settings/);
  });

  it("PostgreSQL configured but not reachable yet: reads undefined, writes refused, nothing kept locally", async () => {
    const dir = tmpDir("app-settings-connecting-");
    // A value in the local store from an earlier SQLite-only period.
    const seed = await runAppSettingsChild("seedStrandedAppSetting", { DATA_DIR: dir, DATABASE_URL: "" });
    assert.equal(seed.code, 0, seed.stderr.slice(-3000));
    assert.deepEqual(seed.out, { mode: "sqlite", saved: true, savedShared: true });

    const r = await runAppSettingsChild("whileConnectingAppSettings", { DATA_DIR: dir, DATABASE_URL: UNREACHABLE_PG });
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.deepEqual(r.out, { mode: "connecting", saved: false, updated: "failed", read: null, localRead: null },
      "the local store is not a second authority while PostgreSQL is expected");
    const db = new DatabaseSync(path.join(dir, "smartface.db"));
    try {
      const rows = (db.prepare("SELECT key, value FROM app_settings ORDER BY key").all() as any[]).map((x) => [x.key, JSON.parse(x.value)]);
      assert.deepEqual(rows, [
        ["local_only", { url: `https://chat.example.vn/hooks/${SECRET_MARKER}` }],
        ["notification_routes", { stranger: "local-value" }],
      ], "the refused write did not touch the local store");
    } finally {
      db.close();
    }
  });
});

describe("JSON fallback (SQLite unavailable): app settings", () => {
  const dataDir = tmpDir("app-settings-json-");
  const env = { DATA_DIR: dataDir, DATABASE_URL: "" };
  const file = path.join(dataDir, "smartface_data.json");

  it("opens a JSON store from the previous release (no app_settings) and keeps its data", async () => {
    fs.writeFileSync(file, JSON.stringify({
      employees: [{ id: "EMP-1", name: "Nguyễn Văn A", employeeCode: "NV001", department: "IT", position: "Dev", photoUrl: "", registeredAt: "2026-09-01T00:00:00.000Z", accessLevel: "ALL_ACCESS" }],
      access_logs: [], webhook_logs: [], mobile_notifications: [], door_api_logs: [],
    }));
    const r = await runAppSettingsChild("probeAppSettings", env, NO_SQLITE);
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.equal(r.out.mode, "json");
    assert.deepEqual([r.out.before, r.out.saved, r.out.after], [null, true, { v: 1 }]);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk.employees[0].id, "EMP-1", "existing data untouched");
    assert.deepEqual(Object.keys(onDisk.app_settings), ["probe_key"]);
    // Start the shared scenario from an empty settings store.
    fs.rmSync(file);
  });

  it("runs the shared scenario", async () => {
    const r = await runAppSettingsChild("runAppSettingsScenario", env, NO_SQLITE);
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.equal(r.out.mode, "json");
    assertAppSettingsScenario(r.out, assert);
    assert.doesNotMatch(logsOf(r), new RegExp(SECRET_MARKER), "values are never logged");
  });

  it("reads everything back after a restart; the file holds plain JSON objects and no temp files remain", async () => {
    const r = await runAppSettingsChild("readBackAppSettings", env, NO_SQLITE);
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.equal(r.out.mode, "json");
    assertAppSettingsReadBack(r.out, assert);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(onDisk.app_settings.counter.value, { count: 12 });
    assert.equal(onDisk.app_settings.counter.key, "counter");
    assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith(".tmp")), [], "atomic rename leaves no temp file");
  });

  it("ignores malformed entries in the file (key logged, never the value)", async () => {
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    onDisk.app_settings.broken_entry = { value: SECRET_MARKER }; // no updatedAt / updatedBy
    onDisk.app_settings["Bad-Key"] = { key: "Bad-Key", value: 1, updatedAt: "x", updatedBy: "y" };
    fs.writeFileSync(file, JSON.stringify(onDisk));
    const r = await runAppSettingsChild("probeAppSettings", env, NO_SQLITE);
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.equal(r.out.saved, true);
    assert.deepEqual(r.out.routes, { stranger: "eton-default", presence: "eton-default", presenceHealth: "eton-default" });
    assert.match(r.stdout + r.stderr, /broken_entry/);
    assert.doesNotMatch(logsOf(r), new RegExp(SECRET_MARKER));
  });
});
