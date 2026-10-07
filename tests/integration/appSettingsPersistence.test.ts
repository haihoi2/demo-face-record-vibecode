/**
 * Admin settings store on PostgreSQL (app_settings): migration, hydration at
 * the moment PostgreSQL becomes active (correct inside the first db.onSync
 * callback), the shared scenario (same expectations as SQLite and JSON),
 * schema and constraints, restart read-back, no silent second authority,
 * fail-closed on a broken table, and rollback by DROP TABLE. Runs through
 * src/server/db.ts in child processes, exactly as the gateway boots.
 *
 * Set PERSISTENCE_PG_URL to an ADMIN connection of a THROWAWAY server (e.g.
 * postgresql://itest:itest-only@smartface-itest-pg:5432/itest). The test
 * creates its own database and drops it afterwards. Without the variable it is
 * skipped. It refuses the live database.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import {
  assertAppSettingsReadBack,
  assertAppSettingsScenario,
  CHANNELS,
  runAppSettingsChild,
  logsOf,
  SECRET_MARKER,
} from "../fixtures/appSettingsScenario";

const PG_ADMIN_URL = String(process.env.PERSISTENCE_PG_URL || "").trim();

/** Messages db.ts logs when a migration or the startup sync breaks. */
const STARTUP_FAILURE = /Lỗi khởi tạo bảng|Lỗi đồng bộ dữ liệu ban đầu/;

describe("PostgreSQL: app settings", () => {
  let admin: pg.Client | null = null;
  let client: pg.Client | null = null;
  let dbName = "";
  let dbUrl = "";
  const skip = !PG_ADMIN_URL ? "PERSISTENCE_PG_URL not set (throwaway PostgreSQL only)" : false;
  const scratch: string[] = [];

  before(async () => {
    if (skip) return;
    const adminUrl = new URL(PG_ADMIN_URL);
    if (/smartface_db/i.test(adminUrl.pathname) || /smartface-postgres-18/i.test(adminUrl.hostname)) {
      throw new Error("Refusing to run the persistence test against the live database");
    }
    admin = new pg.Client({ connectionString: PG_ADMIN_URL });
    await admin.connect();
    dbName = `app_settings_${Date.now()}_${randomBytes(3).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(PG_ADMIN_URL);
    u.pathname = `/${dbName}`;
    dbUrl = u.toString();
    client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
  });

  after(async () => {
    await client?.end().catch(() => {});
    if (admin && dbName) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin?.end().catch(() => {});
    for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
  });

  const tmpDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-settings-pg-"));
    scratch.push(dir);
    return dir;
  };
  /** Fresh local DATA_DIR per boot unless one is given (the local store is not read while PostgreSQL is active). */
  const boot = (fn: Parameters<typeof runAppSettingsChild>[0], dataDir?: string) =>
    runAppSettingsChild(fn, { DATABASE_URL: dbUrl, DATA_DIR: dataDir || tmpDir(), EXPECT_PG: "1" });

  it("creates the table on a database that predates it (additive migration) and serves an empty store", { skip }, async () => {
    assert.equal((await client!.query(`SELECT to_regclass('app_settings') IS NULL AS absent`)).rows[0].absent, true);
    const r = await boot("probeAppSettings");
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.doesNotMatch(r.stdout + r.stderr, STARTUP_FAILURE);
    assert.equal(r.out.mode, "postgresql");
    assert.deepEqual([r.out.before, r.out.saved, r.out.after], [null, true, { v: 1 }]);
    await client!.query("DELETE FROM app_settings");
  });

  it("has the planned schema and enforces it in the database itself", { skip }, async () => {
    const cols = (await client!.query(
      `SELECT column_name, data_type, character_maximum_length, is_nullable
         FROM information_schema.columns WHERE table_name = 'app_settings' ORDER BY ordinal_position`,
    )).rows.map((c) => [c.column_name, c.data_type, c.character_maximum_length, c.is_nullable]);
    assert.deepEqual(cols, [
      ["key", "character varying", 64, "NO"],
      ["value", "jsonb", null, "NO"],
      ["updatedAt", "character varying", 64, "NO"],
      ["updatedBy", "character varying", 255, "NO"],
    ]);
    const pk = (await client!.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'app_settings'::regclass AND contype = 'p'`,
    )).rows.map((r) => r.def);
    assert.deepEqual(pk, ["PRIMARY KEY (key)"]);
    const fks = (await client!.query(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE (conrelid = 'app_settings'::regclass OR confrelid = 'app_settings'::regclass) AND contype = 'f'`,
    )).rows[0].n;
    assert.equal(fks, 0, "nothing references app_settings, so DROP TABLE is a complete rollback");
    const insert = (key: string, value = "{}", by: string | null = "itest") => client!.query(
      `INSERT INTO app_settings (key, value, "updatedAt", "updatedBy") VALUES ($1, $2::jsonb, '2026-10-07T00:00:00.000Z', $3)`, [key, value, by],
    );
    for (const bad of ["Bad", "a", "1ab", "a-b", "_ab"]) {
      await assert.rejects(insert(bad), (e: any) => e.code === "23514", `CHECK refuses ${bad}`);
    }
    await assert.rejects(insert("k".repeat(65)), (e: any) => e.code === "22001" || e.code === "23514");
    await assert.rejects(insert("no_actor", "{}", null), (e: any) => e.code === "23502");
    await assert.rejects(insert("bad_json", "{nope"), (e: any) => e.code === "22P02");
    await insert("dup_check");
    await assert.rejects(insert("dup_check"), (e: any) => e.code === "23505", "one row per key");
    await client!.query("DELETE FROM app_settings");
  });

  it("hydrates rows written by an earlier process before the first onSync callback", { skip }, async () => {
    await client!.query(
      `INSERT INTO app_settings (key, value, "updatedAt", "updatedBy") VALUES ('preseeded_key', $1::jsonb, '2026-10-06T00:00:00.000Z', 'itest')`,
      [JSON.stringify({ gates: { entry: { mode: "shadow" } } })],
    );
    const r = await boot("probeAppSettings");
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.deepEqual(r.out.atSync.preseeded, {
      key: "preseeded_key", value: { gates: { entry: { mode: "shadow" } } }, updatedAt: "2026-10-06T00:00:00.000Z", updatedBy: "itest",
    }, "getAppSetting is correct synchronously inside db.onSync");
    await client!.query("DELETE FROM app_settings");
  });

  it("runs the shared scenario (same expectations as SQLite and JSON)", { skip }, async () => {
    const r = await boot("runAppSettingsScenario");
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.doesNotMatch(r.stdout + r.stderr, STARTUP_FAILURE);
    assert.equal(r.out.mode, "postgresql");
    assertAppSettingsScenario(r.out, assert);
    assert.doesNotMatch(logsOf(r), new RegExp(SECRET_MARKER), "values are never logged");

    const rows = (await client!.query(
      `SELECT key, jsonb_typeof(value) AS t, "updatedBy" FROM app_settings ORDER BY key COLLATE "C"`,
    )).rows;
    const byKey = Object.fromEntries(rows.map((x) => [x.key, [x.t, x.updatedBy]]));
    assert.deepEqual(byKey.notification_channels, ["object", "admin-a"], "stored as JSONB, not as a JSON string");
    assert.deepEqual(byKey.kind_array, ["array", "admin"]);
    assert.deepEqual(byKey.kind_null, ["null", "admin"]);
    assert.deepEqual(byKey.race_key, ["object", "admin-19"], "the database applied the concurrent writes in call order too");
    assert.equal(rows.filter((x) => x.key.startsWith("refused_")).length, 0);
    assert.deepEqual(rows.map((x) => x.key), [
      "counter", "dup_key", "kind_array", "kind_canonical", "kind_null", "kind_number", "kind_string",
      "notification_channels", "notification_routes", "queue_ok", "race_key", "size_probe",
    ], "exactly the accepted writes, one row per key");
  });

  it("reads everything back after a restart, from inside the first onSync callback", { skip }, async () => {
    const r = await boot("readBackAppSettings");
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.equal(r.out.mode, "postgresql");
    assertAppSettingsReadBack(r.out, assert);
    assert.deepEqual(r.out.atSync.channels, CHANNELS);
  });

  it("does not read or copy values left in the local store by a fallback period; reports their keys only", { skip }, async () => {
    const dir = tmpDir();
    const seed = await runAppSettingsChild("seedStrandedAppSetting", { DATA_DIR: dir, DATABASE_URL: "" });
    assert.equal(seed.code, 0, seed.stderr.slice(-3000));
    assert.equal(seed.out.mode, "sqlite");
    const r = await boot("probeAppSettings", dir);
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.equal(r.out.localOnly, null, "a local-only key is not served");
    assert.deepEqual(r.out.routes, { stranger: "eton-default", presence: "eton-default", presenceHealth: "eton-default" },
      "PostgreSQL wins over a newer local value");
    assert.match(r.stdout + r.stderr, /không được dùng: .*local_only/);
    assert.doesNotMatch(logsOf(r), new RegExp(SECRET_MARKER), "the stranded value is not logged");
    assert.equal((await client!.query(`SELECT count(*)::int AS n FROM app_settings WHERE key = 'local_only'`)).rows[0].n, 0, "nor copied");
  });

  it("fails closed when the table cannot be read: reads undefined, writes refused, no local fallback", { skip }, async () => {
    await client!.query("ALTER TABLE app_settings RENAME TO app_settings_saved");
    await client!.query("CREATE TABLE app_settings (key VARCHAR(64) PRIMARY KEY)"); // incompatible shape
    try {
      const dir = tmpDir();
      const r = await boot("probeAppSettings", dir);
      assert.equal(r.code, 0, r.stderr.slice(-3000));
      assert.equal(r.out.mode, "postgresql", "the rest of the gateway still runs on PostgreSQL");
      assert.deepEqual([r.out.before, r.out.saved, r.out.after], [null, false, null]);
      assert.match(r.stderr, /Lỗi khởi tạo bảng app_settings/);
      assert.equal(fs.existsSync(path.join(dir, "smartface_data.json")) &&
        "app_settings" in JSON.parse(fs.readFileSync(path.join(dir, "smartface_data.json"), "utf8")), false, "nothing parked in JSON");
    } finally {
      await client!.query("DROP TABLE app_settings");
      await client!.query("ALTER TABLE app_settings_saved RENAME TO app_settings");
    }
  });

  it("rollback by DROP TABLE, then a restart re-applies the migration (idempotent)", { skip }, async () => {
    await client!.query("DROP TABLE app_settings");
    const r = await boot("probeAppSettings");
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.doesNotMatch(r.stdout + r.stderr, STARTUP_FAILURE);
    assert.deepEqual([r.out.before, r.out.saved, r.out.routes], [null, true, null], "dropping the table loses only the settings");
    const again = await boot("probeAppSettings");
    assert.equal(again.code, 0, again.stderr.slice(-3000));
    assert.doesNotMatch(again.stdout + again.stderr, STARTUP_FAILURE);
    assert.deepEqual(again.out.before?.value, { v: 1 });
    assert.equal((await client!.query(`SELECT count(*)::int AS n FROM app_settings`)).rows[0].n, 1);
  });
});
