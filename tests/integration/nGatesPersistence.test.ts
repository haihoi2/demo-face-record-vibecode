/**
 * N-gate persistence on PostgreSQL: access_logs."gateId" + its index and the
 * gate filter, stranger_faces."gateId", door_lock_states with the legacy
 * smart_lock_state row as door "main" (one transaction), shadow-result gate
 * normalisation, migration from the previous release, rollback and restart.
 * Runs the same scenarios as tests/nGatesStore.test.ts (SQLite and JSON)
 * through src/server/db.ts in child processes, exactly as the gateway boots.
 *
 * Set PERSISTENCE_PG_URL to an ADMIN connection of a THROWAWAY server (e.g.
 * postgresql://itest:itest-only@smartface-verify-pg-ng-db:5432/itest). The
 * test creates its own database, builds the previous release's tables with
 * data in them, runs the scenarios, inspects the schema, then drops the
 * database. Without the variable it is skipped. It refuses the live database.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import {
  assertDoorLockReadBack,
  assertDoorLockScenario,
  assertGateLogReadBack,
  assertGateLogScenario,
  assertLegacyCheck,
  assertShadowGateScenario,
  LEGACY_SHADOW_ROWS,
  runNGatesChild,
} from "../fixtures/nGatesScenario";
import { shadow } from "../fixtures/accuracyScenario";

const PG_ADMIN_URL = String(process.env.PERSISTENCE_PG_URL || "").trim();

/** The previous release's tables (accuracy wave): no gateId anywhere, no door_lock_states. */
const LEGACY_PG = `
  CREATE TABLE access_logs (
    id VARCHAR(64) PRIMARY KEY, timestamp VARCHAR(64) NOT NULL, type VARCHAR(16) NOT NULL, status VARCHAR(16) NOT NULL,
    "employeeId" VARCHAR(64), "employeeName" VARCHAR(255), "employeeCode" VARCHAR(64), department VARCHAR(255),
    "photoSnapshot" TEXT, confidence NUMERIC(5, 2), "livenessScore" NUMERIC(5, 2), "lockAction" TEXT, "doorName" VARCHAR(255),
    reason TEXT, "faceEmbedding" BYTEA, "faceEmbeddingDims" INTEGER, "faceEmbeddingModelTag" VARCHAR(128),
    "faceEmbeddingQuality" REAL, "capturedAt" VARCHAR(64), "trackId" VARCHAR(64), "recordingChannel" VARCHAR(16));
  CREATE INDEX idx_access_logs_ts_id ON access_logs ("timestamp" DESC, id DESC);
  CREATE TABLE smart_lock_state (
    "lockId" VARCHAR(64) PRIMARY KEY, "doorName" VARCHAR(255), state VARCHAR(32), "isLocked" BOOLEAN, "batteryLevel" INTEGER,
    "signalDbm" INTEGER, "firmwareVersion" VARCHAR(64), "lastActionAt" VARCHAR(64), "lastActionBy" VARCHAR(255),
    "autoRelockSeconds" INTEGER, status VARCHAR(32));
  CREATE TABLE stranger_faces (
    id VARCHAR(64) COLLATE "C" PRIMARY KEY,
    "logId" VARCHAR(64) NOT NULL REFERENCES access_logs (id) ON DELETE CASCADE,
    "faceIndex" INTEGER NOT NULL, "capturedAt" VARCHAR(64) COLLATE "C" NOT NULL, gate VARCHAR(16) NOT NULL, "streamId" VARCHAR(64),
    engine VARCHAR(16) NOT NULL, "trackId" VARCHAR(64), box JSONB NOT NULL, "sourceWidth" INTEGER, "sourceHeight" INTEGER,
    "detectorScore" REAL NOT NULL, quality REAL NOT NULL, "edgeEnergy" REAL, "sizePx" INTEGER NOT NULL, embedding BYTEA, dims INTEGER,
    "modelTag" VARCHAR(128), crop BYTEA, "createdAt" VARCHAR(64) NOT NULL, "purgedAt" VARCHAR(64),
    "employeeId" VARCHAR(64), "matchCosine" REAL, "matchMargin" REAL);
  CREATE INDEX idx_stranger_faces_captured ON stranger_faces ("capturedAt" DESC, id DESC) WHERE "purgedAt" IS NULL;
  CREATE UNIQUE INDEX idx_stranger_faces_log ON stranger_faces ("logId", "faceIndex");
  CREATE TABLE pipeline_shadow_results (
    id VARCHAR(64) COLLATE "C" PRIMARY KEY, gate VARCHAR(64) NOT NULL, "trackId" VARCHAR(64) NOT NULL, outcome VARCHAR(16) NOT NULL,
    "employeeId" VARCHAR(64), "fusedCosine" REAL, margin REAL, "runnerUpEmployeeId" VARCHAR(64), "runnerUpCosine" REAL,
    basis VARCHAR(128) NOT NULL, "fusionBasis" VARCHAR(128), "meanCheckRefused" BOOLEAN, "framesSeen" INTEGER NOT NULL,
    "framesUsed" INTEGER NOT NULL, "firstSeenAt" VARCHAR(64) NOT NULL, "firstUsableAt" VARCHAR(64),
    "decidedAt" VARCHAR(64) COLLATE "C" NOT NULL, "legacyLogId" VARCHAR(64), "legacyStatus" VARCHAR(16),
    "legacyEmployeeId" VARCHAR(64), agreement VARCHAR(32) NOT NULL, "createdAt" VARCHAR(64) NOT NULL);
  INSERT INTO access_logs (id, timestamp, type, status, "photoSnapshot", confidence, "lockAction", "doorName")
    VALUES ('OLD-1', '2026-09-30T01:00:00.000Z', 'ENTRY', 'GRANTED', '', 90, 'x', 'y'),
           ('OLD-2', '2026-09-30T02:00:00.000Z', 'EXIT', 'DENIED', 'data:image/jpeg;base64,x', 10, 'x', 'y');
  INSERT INTO smart_lock_state VALUES ('SL-HQ-01', 'Cửa chính', 'LOCKED', TRUE, 96, -54, 'v2', '2026-09-30T03:00:00.000Z', 'before-upgrade', 6, 'ONLINE');
  INSERT INTO stranger_faces (id, "logId", "faceIndex", "capturedAt", gate, engine, box, "detectorScore", quality, "sizePx", "createdAt")
    VALUES ('SF-OLD-1', 'OLD-2', 0, '2026-09-30T02:00:00.000Z', 'EXIT', 'legacy', '[1,2,3,4]', 0.9, 0.5, 80, '2026-09-30T02:00:00.000Z');`;
/** The previous release's statements: they never name gateId or door_lock_states. */
const OLD_LOG_INSERT = `INSERT INTO access_logs (id, timestamp, type, status, "employeeId", "employeeName", "employeeCode",
    department, "photoSnapshot", confidence, "livenessScore", "lockAction", "doorName", reason, "faceEmbedding", "faceEmbeddingDims",
    "faceEmbeddingModelTag", "faceEmbeddingQuality", "capturedAt", "trackId", "recordingChannel")
  VALUES ('OLD-3', '2026-09-30T04:00:00.000Z', 'ENTRY', 'GRANTED', NULL, NULL, NULL, NULL, '', 90, NULL, 'x', 'y', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
  ON CONFLICT (id) DO NOTHING`;
const OLD_LOCK_UPSERT = `INSERT INTO smart_lock_state ("lockId", "doorName", state, "isLocked", "batteryLevel", "signalDbm",
    "firmwareVersion", "lastActionAt", "lastActionBy", "autoRelockSeconds", status)
  VALUES ('SL-HQ-01', 'Cửa chính', 'LOCKED', TRUE, 96, -54, 'v2', $1, $2, 6, 'ONLINE')
  ON CONFLICT ("lockId") DO UPDATE SET state = EXCLUDED.state, "isLocked" = EXCLUDED."isLocked",
    "lastActionAt" = EXCLUDED."lastActionAt", "lastActionBy" = EXCLUDED."lastActionBy"`;
const SHADOW_COLS = [
  "id", "gate", "trackId", "outcome", "employeeId", "fusedCosine", "margin", "runnerUpEmployeeId", "runnerUpCosine",
  "basis", "fusionBasis", "meanCheckRefused", "framesSeen", "framesUsed", "firstSeenAt", "firstUsableAt", "decidedAt",
  "legacyLogId", "legacyStatus", "legacyEmployeeId", "agreement", "createdAt",
];
const insertRawShadow = (c: pg.Client, r: Record<string, any>) =>
  c.query(`INSERT INTO pipeline_shadow_results (${SHADOW_COLS.map((x) => `"${x}"`).join(", ")}) VALUES (${SHADOW_COLS.map((_, i) => `$${i + 1}`).join(", ")})`,
    SHADOW_COLS.map((x) => r[x] ?? null));

/** Messages db.ts logs when a migration or a write breaks. */
const STARTUP_FAILURE = /Lỗi khởi tạo bảng|Lỗi đồng bộ dữ liệu ban đầu|Lỗi nạp|Lỗi khởi tạo chỉ mục/;

describe("PostgreSQL: N-gate persistence", () => {
  let admin: pg.Client | null = null;
  let client: pg.Client | null = null;
  let dbName = "";
  let dbUrl = "";
  const skip = !PG_ADMIN_URL ? "PERSISTENCE_PG_URL not set (throwaway PostgreSQL only)" : false;

  before(async () => {
    if (skip) return;
    const adminUrl = new URL(PG_ADMIN_URL);
    if (/smartface_db/i.test(adminUrl.pathname) || /smartface-postgres-18/i.test(adminUrl.hostname)) {
      throw new Error("Refusing to run the persistence test against the live database");
    }
    admin = new pg.Client({ connectionString: PG_ADMIN_URL });
    await admin.connect();
    dbName = `ng_db_${Date.now()}_${randomBytes(3).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(PG_ADMIN_URL);
    u.pathname = `/${dbName}`;
    dbUrl = u.toString();
    client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(LEGACY_PG);
    await insertRawShadow(client, shadow("SR-OLD-1", "EXIT", "2026-09-30T02:00:00.000Z"));
  });

  after(async () => {
    await client?.end().catch(() => {});
    if (admin && dbName) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin?.end().catch(() => {});
  });

  /** Fresh local DATA_DIR per boot (the local store is not the authority while PostgreSQL is active). */
  const boot = async (fn: Parameters<typeof runNGatesChild>[0]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ng-db-pg-"));
    try {
      return await runNGatesChild(fn, { DATABASE_URL: dbUrl, DATA_DIR: dir, EXPECT_PG: "1" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("migrates the previous release: additive nullable columns, index, door_lock_states; no backfill; old code still works", { skip }, async () => {
    const r = await boot("legacyCheck");
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.doesNotMatch(r.stdout + r.stderr, STARTUP_FAILURE);
    assert.equal(r.out.mode, "postgresql");
    assertLegacyCheck(r.out, assert);

    const cols = (await client!.query(
      `SELECT table_name, data_type, character_maximum_length AS len, is_nullable, column_default FROM information_schema.columns
        WHERE column_name = 'gateId' AND table_name IN ('access_logs', 'stranger_faces') ORDER BY table_name`,
    )).rows;
    assert.deepEqual(cols, [
      { table_name: "access_logs", data_type: "character varying", len: 32, is_nullable: "YES", column_default: null },
      { table_name: "stranger_faces", data_type: "character varying", len: 32, is_nullable: "YES", column_default: null },
    ], "additive, nullable, no default: catalog-only");
    const idx = (await client!.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_access_logs_gate_ts'`)).rows.map((x) => x.indexdef.replace(/^.* USING btree /, ""));
    assert.deepEqual(idx, [`("gateId", "timestamp" DESC, id DESC)`]);
    const doorCols = (await client!.query(
      `SELECT column_name, data_type, character_maximum_length AS len, is_nullable FROM information_schema.columns
        WHERE table_name = 'door_lock_states' ORDER BY ordinal_position`,
    )).rows;
    assert.deepEqual(doorCols, [
      { column_name: "doorId", data_type: "character varying", len: 32, is_nullable: "NO" },
      { column_name: "state", data_type: "jsonb", len: null, is_nullable: "NO" },
      { column_name: "updatedAt", data_type: "character varying", len: 64, is_nullable: "NO" },
    ]);
    assert.deepEqual((await client!.query(`SELECT id, "gateId" FROM access_logs ORDER BY id`)).rows,
      [{ id: "OLD-1", gateId: null }, { id: "OLD-2", gateId: null }], "no backfill write");
    assert.equal((await client!.query(`SELECT "gateId" FROM stranger_faces`)).rows[0].gateId, null);
    assert.equal((await client!.query(`SELECT gate FROM pipeline_shadow_results`)).rows[0].gate, "EXIT", "old shadow rows are not rewritten");
    assert.equal((await client!.query(`SELECT count(*)::int AS n FROM door_lock_states`)).rows[0].n, 0);

    // Rollback to the previous image: its statements never name the new column or table.
    await client!.query(OLD_LOG_INSERT);
    await client!.query(OLD_LOCK_UPSERT, ["2026-09-30T05:00:00.000Z", "old-code-after-rollback"]);
    const again = await boot("legacyCheck");
    assert.equal(again.code, 0, again.stderr.slice(-3000));
    assert.doesNotMatch(again.stdout + again.stderr, STARTUP_FAILURE);
    assertLegacyCheck(again.out, assert, ["OLD-3:entry"], "old-code-after-rollback");

    // Out of the way of the scenarios (each starts from an empty store).
    await client!.query(`DELETE FROM access_logs WHERE id LIKE 'OLD-%'`);
    assert.equal((await client!.query("SELECT count(*)::int AS n FROM stranger_faces")).rows[0].n, 0, "cascade still holds");
    await client!.query(`DELETE FROM pipeline_shadow_results`);
    await client!.query(`DELETE FROM smart_lock_state`);
  });

  it("runs the access-log and stranger-face scenario (same expectations as SQLite and JSON)", { skip }, async () => {
    const r = await boot("runGateLogScenario");
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.doesNotMatch(r.stdout + r.stderr, STARTUP_FAILURE);
    assert.equal(r.out.mode, "postgresql");
    assertGateLogScenario(r.out, assert);
  });

  it("runs the shadow scenario over rows the previous release wrote", { skip }, async () => {
    for (const row of LEGACY_SHADOW_ROWS) await insertRawShadow(client!, row);
    const r = await boot("runShadowGateScenario");
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assertShadowGateScenario(r.out, assert);
  });

  it("runs the door lock scenario", { skip }, async () => {
    const r = await boot("runDoorLockScenario");
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.doesNotMatch(r.stdout + r.stderr, STARTUP_FAILURE);
    assertDoorLockScenario(r.out, assert);
  });

  it("stores exactly what was written; the database enforces the limits itself", { skip }, async () => {
    const gates = Object.fromEntries((await client!.query(`SELECT id, "gateId" FROM access_logs WHERE id LIKE 'L-%'`)).rows.map((r) => [r.id, r.gateId]));
    assert.deepEqual(gates, {
      "L-01": null, "L-02": null, "L-03": "entry", "L-04": "exit", "L-05": "side-door", "L-06": null,
      "L-07": "loading-bay", "L-08": "side-door", "L-09": null, "L-10": null,
    });
    const faces = Object.fromEntries((await client!.query(`SELECT id, "gateId" FROM stranger_faces`)).rows.map((r) => [r.id, r.gateId]));
    assert.deepEqual(faces, { "SF-N1": "side-door", "SF-N2": null, "SF-N3": null, "SF-N4": null });
    const shadowGates = Object.fromEntries((await client!.query(`SELECT id, gate FROM pipeline_shadow_results`)).rows.map((r) => [r.id, r.gate]));
    assert.deepEqual(shadowGates, { "SR-L1": "ENTRY", "SR-L2": "EXIT", "SR-N1": "entry", "SR-N2": "exit", "SR-N3": "side-door", "SR-N4": "entry" });
    const doors = (await client!.query(`SELECT "doorId", state FROM door_lock_states ORDER BY "doorId"`)).rows;
    assert.deepEqual(doors.map((d) => [d.doorId, d.state.doorId, d.state.lastActionBy]), [["main", "main", "new-code"], ["side-door", "side-door", "op-final"]]);
    assert.ok(doors.every((d) => !("apiToken" in d.state)), "no credential rides along into the table");
    assert.deepEqual((await client!.query(`SELECT "lockId", state, "isLocked", "lastActionBy" FROM smart_lock_state`)).rows,
      [{ lockId: "SL-HQ-01", state: "UNLOCKED", isLocked: false, lastActionBy: "new-code" }], "door main is the legacy row too");

    await assert.rejects(client!.query(`INSERT INTO door_lock_states ("doorId", state, "updatedAt") VALUES ('Main', '{}', 'x')`), (e: any) => e.code === "23514", "CHECK = DOOR_ID_RE");
    await assert.rejects(client!.query(`INSERT INTO door_lock_states ("doorId", state, "updatedAt") VALUES ('main', '{}', 'x')`), (e: any) => e.code === "23505", "one row per door");
    await assert.rejects(client!.query(`UPDATE access_logs SET "gateId" = $1 WHERE id = 'L-01'`, ["g".repeat(33)]), (e: any) => e.code === "22001", "gateId VARCHAR(32)");
  });

  it("door main and its legacy row commit or roll back together (partial failure)", { skip }, async () => {
    const doorBefore = (await client!.query(`SELECT state FROM door_lock_states WHERE "doorId" = 'main'`)).rows[0].state;
    const legacyBefore = (await client!.query(`SELECT * FROM smart_lock_state`)).rows[0];
    await client!.query(`CREATE FUNCTION ng_db_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'legacy write refused (test)'; END $$`);
    await client!.query(`CREATE TRIGGER ng_db_fail BEFORE INSERT OR UPDATE ON smart_lock_state FOR EACH ROW EXECUTE FUNCTION ng_db_fail()`);
    try {
      const r = await boot("saveMainProbe");
      assert.equal(r.code, 0, r.stderr.slice(-3000));
      assert.equal(r.out.saved, false, "the failure is reported, not hidden");
      const door = (await client!.query(`SELECT state->>'lastActionBy' AS by FROM door_lock_states WHERE "doorId" = 'main'`)).rows[0];
      assert.equal(door.by, "new-code", "the door row rolled back with the failed legacy write");
    } finally {
      await client!.query(`DROP TRIGGER ng_db_fail ON smart_lock_state`);
      await client!.query(`DROP FUNCTION ng_db_fail()`);
    }
    // Retry after the fault: succeeds, both rows move together.
    const retry = await boot("saveMainProbe");
    assert.equal(retry.out.saved, true);
    assert.equal((await client!.query(`SELECT state->>'lastActionBy' AS by FROM door_lock_states WHERE "doorId" = 'main'`)).rows[0].by, "tx-probe");
    assert.equal((await client!.query(`SELECT "lastActionBy" AS by FROM smart_lock_state`)).rows[0].by, "tx-probe");
    // Back to the scenario's final state for the restart checks.
    await client!.query(`UPDATE door_lock_states SET state = $1::jsonb WHERE "doorId" = 'main'`, [JSON.stringify(doorBefore)]);
    await client!.query(`UPDATE smart_lock_state SET "doorName" = $1, "lastActionBy" = $2, "lastActionAt" = $3`,
      [legacyBefore.doorName, legacyBefore.lastActionBy, legacyBefore.lastActionAt]);
  });

  it("serves the gate filter from idx_access_logs_gate_ts", { skip }, async () => {
    await client!.query("BEGIN");
    try {
      await client!.query("SET LOCAL enable_seqscan = off");
      const explain = async (sql: string, params: unknown[]) => (await client!.query(`EXPLAIN ${sql}`, params)).rows.map((r) => r["QUERY PLAN"]).join("\n");
      const side = await explain(`SELECT id FROM access_logs WHERE "gateId" = $1 ORDER BY timestamp DESC, id DESC LIMIT 5`, ["side-door"]);
      assert.match(side, /idx_access_logs_gate_ts/, side);
      assert.doesNotMatch(side, /Sort/, side);
      const entry = await explain(`SELECT id FROM access_logs WHERE ("gateId" = $1 OR ("gateId" IS NULL AND upper(type) <> 'EXIT'))
          ORDER BY timestamp DESC, id DESC LIMIT 5`, ["entry"]);
      assert.match(entry, /idx_access_logs_(gate_ts|ts_id)/, entry);
    } finally {
      await client!.query("ROLLBACK");
    }
  });

  it("keeps everything across a restart", { skip }, async () => {
    const g = await boot("readBackGateLogScenario");
    assert.equal(g.code, 0, g.stderr.slice(-3000));
    assertGateLogReadBack(g.out, assert);
    const d = await boot("readBackDoorLockScenario");
    assert.equal(d.code, 0, d.stderr.slice(-3000));
    assertDoorLockReadBack(d.out, assert);
  });

  it("rollback by DROP keeps door main in smart_lock_state; a restart re-applies the migration (idempotent)", { skip }, async () => {
    await client!.query(`DROP TABLE door_lock_states`);
    await client!.query(`DROP INDEX idx_access_logs_gate_ts`);
    await client!.query(`ALTER TABLE access_logs DROP COLUMN "gateId"`);
    await client!.query(`ALTER TABLE stranger_faces DROP COLUMN "gateId"`);
    const d = await boot("readBackDoorLockScenario");
    assert.equal(d.code, 0, d.stderr.slice(-3000));
    assert.doesNotMatch(d.stdout + d.stderr, STARTUP_FAILURE);
    assert.deepEqual(d.out.list, [{ doorId: "main", state: "UNLOCKED", by: "new-code" }], "door main survives in the legacy row; other doors' states are lost (they relock)");
    const g = await boot("readBackGateLogScenario");
    assert.equal(g.code, 0, g.stderr.slice(-3000));
    assert.deepEqual(g.out.side.ids, [], "dropping the column turns every row into a legacy row (derived from type)");
    assert.equal(g.out.all.ids.length, 10, "no event is lost");
    const n = (await client!.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE column_name = 'gateId' AND table_name IN ('access_logs', 'stranger_faces')`)).rows[0].n;
    assert.equal(n, 2);
    assert.equal((await client!.query(`SELECT to_regclass('door_lock_states') IS NOT NULL AS ok`)).rows[0].ok, true);
    assert.equal((await client!.query(`SELECT to_regclass('idx_access_logs_gate_ts') IS NOT NULL AS ok`)).rows[0].ok, true);
  });
});
