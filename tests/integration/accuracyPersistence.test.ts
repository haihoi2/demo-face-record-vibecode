/**
 * Accuracy-wave persistence on PostgreSQL: pipeline_shadow_results, the
 * recognised-face observation columns on stranger_faces, "adaptation" face
 * templates, migration from the per-face release, rollback and restart. Runs
 * the same scenarios as tests/accuracyStore.test.ts (SQLite and JSON) through
 * src/server/db.ts in child processes, exactly as the gateway boots.
 *
 * Set PERSISTENCE_PG_URL to an ADMIN connection of a THROWAWAY server (e.g.
 * postgresql://itest:itest-only@smartface-verify-pg-acc-db:5432/itest). The
 * test creates its own database, builds the previous release's tables with a
 * face in them, runs the scenarios, inspects the schema, then drops the
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
  assertObservationReadBack,
  assertObservationScenario,
  assertShadowReadBack,
  assertShadowScenario,
  runAccuracyChild,
} from "../fixtures/accuracyScenario";

const PG_ADMIN_URL = String(process.env.PERSISTENCE_PG_URL || "").trim();

/** access_logs and stranger_faces exactly as the per-face release creates them (no observation columns). */
const LEGACY_PG = `
  CREATE TABLE access_logs (
    id VARCHAR(64) PRIMARY KEY, timestamp VARCHAR(64) NOT NULL, type VARCHAR(16) NOT NULL, status VARCHAR(16) NOT NULL,
    "employeeId" VARCHAR(64), "employeeName" VARCHAR(255), "employeeCode" VARCHAR(64), department VARCHAR(255),
    "photoSnapshot" TEXT, confidence NUMERIC(5, 2), "livenessScore" NUMERIC(5, 2), "lockAction" TEXT, "doorName" VARCHAR(255),
    reason TEXT, "faceEmbedding" BYTEA, "faceEmbeddingDims" INTEGER, "faceEmbeddingModelTag" VARCHAR(128),
    "faceEmbeddingQuality" REAL, "capturedAt" VARCHAR(64), "trackId" VARCHAR(64), "recordingChannel" VARCHAR(16));
  CREATE TABLE stranger_faces (
    id VARCHAR(64) COLLATE "C" PRIMARY KEY,
    "logId" VARCHAR(64) NOT NULL REFERENCES access_logs (id) ON DELETE CASCADE,
    "faceIndex" INTEGER NOT NULL, "capturedAt" VARCHAR(64) COLLATE "C" NOT NULL, gate VARCHAR(16) NOT NULL, "streamId" VARCHAR(64),
    engine VARCHAR(16) NOT NULL, "trackId" VARCHAR(64), box JSONB NOT NULL, "sourceWidth" INTEGER, "sourceHeight" INTEGER,
    "detectorScore" REAL NOT NULL, quality REAL NOT NULL, "edgeEnergy" REAL, "sizePx" INTEGER NOT NULL, embedding BYTEA, dims INTEGER,
    "modelTag" VARCHAR(128), crop BYTEA, "createdAt" VARCHAR(64) NOT NULL, "purgedAt" VARCHAR(64));
  CREATE INDEX idx_stranger_faces_captured ON stranger_faces ("capturedAt" DESC, id DESC) WHERE "purgedAt" IS NULL;
  CREATE UNIQUE INDEX idx_stranger_faces_log ON stranger_faces ("logId", "faceIndex");
  INSERT INTO access_logs (id, timestamp, type, status, "photoSnapshot") VALUES ('LOG-OLD-1', '2026-09-28T01:00:00.000Z', 'EXIT', 'DENIED', 'data:image/jpeg;base64,x');`;
/** The previous release's INSERT (20 columns) and SELECT (20 columns) for stranger_faces. */
const OLD_INSERT = `INSERT INTO stranger_faces (id, "logId", "faceIndex", "capturedAt", gate, "streamId", engine, "trackId", box,
    "sourceWidth", "sourceHeight", "detectorScore", quality, "edgeEnergy", "sizePx", embedding, dims, "modelTag", crop, "createdAt")
  VALUES ($1, 'LOG-OLD-1', $2, '2026-09-28T01:00:00.000Z', 'EXIT', 'exit-cam', 'legacy', NULL, '[1,2,3,4]'::jsonb,
    NULL, NULL, 0.9, 0.5, NULL, 80, $3, 4, 'arcface_test', NULL, '2026-09-28T01:00:00.000Z')`;
const OLD_SELECT = `SELECT id, "logId", "faceIndex", "capturedAt", gate, "streamId", engine, "trackId", box, "sourceWidth", "sourceHeight",
    "detectorScore", quality, "edgeEnergy", "sizePx", embedding, dims, "modelTag", "createdAt", "purgedAt" FROM stranger_faces WHERE id = $1`;

/** Messages db.ts logs when a migration or a write breaks. */
const STARTUP_FAILURE = /Lỗi khởi tạo bảng|Lỗi đồng bộ dữ liệu ban đầu|Lỗi nạp/;

const SHADOW_COLUMNS: Record<string, [string, number | null, string, string | null]> = {
  id: ["character varying", 64, "NO", "C"],
  gate: ["character varying", 64, "NO", null],
  trackId: ["character varying", 64, "NO", null],
  outcome: ["character varying", 16, "NO", null],
  employeeId: ["character varying", 64, "YES", null],
  fusedCosine: ["real", null, "YES", null],
  margin: ["real", null, "YES", null],
  runnerUpEmployeeId: ["character varying", 64, "YES", null],
  runnerUpCosine: ["real", null, "YES", null],
  basis: ["character varying", 128, "NO", null],
  fusionBasis: ["character varying", 128, "YES", null],
  meanCheckRefused: ["boolean", null, "YES", null],
  framesSeen: ["integer", null, "NO", null],
  framesUsed: ["integer", null, "NO", null],
  firstSeenAt: ["character varying", 64, "NO", null],
  firstUsableAt: ["character varying", 64, "YES", null],
  decidedAt: ["character varying", 64, "NO", "C"],
  legacyLogId: ["character varying", 64, "YES", null],
  legacyStatus: ["character varying", 16, "YES", null],
  legacyEmployeeId: ["character varying", 64, "YES", null],
  agreement: ["character varying", 32, "NO", null],
  createdAt: ["character varying", 64, "NO", null],
};

describe("PostgreSQL: accuracy-wave persistence", () => {
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
    dbName = `acc_db_${Date.now()}_${randomBytes(3).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(PG_ADMIN_URL);
    u.pathname = `/${dbName}`;
    dbUrl = u.toString();
    client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(LEGACY_PG);
    await client.query(OLD_INSERT, ["SF-OLD-1", 0, Buffer.alloc(16)]);
  });

  after(async () => {
    await client?.end().catch(() => {});
    if (admin && dbName) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin?.end().catch(() => {});
  });

  /** Fresh local DATA_DIR per boot (the local store is not read while PostgreSQL is active). */
  const boot = async (fn: Parameters<typeof runAccuracyChild>[0]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-db-pg-"));
    try {
      return await runAccuracyChild(fn, { DATABASE_URL: dbUrl, DATA_DIR: dir, EXPECT_PG: "1" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("migrates the previous release: old faces read employeeId NULL and stay strangers; old code still reads and writes", { skip }, async () => {
    const r = await boot("storeOnly");
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.doesNotMatch(r.stdout + r.stderr, STARTUP_FAILURE);
    assert.deepEqual(r.out, {
      mode: "postgresql", page: ["SF-OLD-1"],
      oldFaces: [{ id: "SF-OLD-1", employeeId: null, matchCosine: null, embedding: 4 }],
      obs: [], shadow: [], summary: [], templates: [],
    });
    const cols = (await client!.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'stranger_faces' AND column_name IN ('employeeId', 'matchCosine', 'matchMargin') ORDER BY column_name`,
    )).rows;
    assert.deepEqual(cols, [
      { column_name: "employeeId", data_type: "character varying", is_nullable: "YES", column_default: null },
      { column_name: "matchCosine", data_type: "real", is_nullable: "YES", column_default: null },
      { column_name: "matchMargin", data_type: "real", is_nullable: "YES", column_default: null },
    ], "additive, nullable, no default: catalog-only");
    // Rollback to the previous image: its INSERT and SELECT never name the new columns.
    await client!.query(OLD_INSERT, ["SF-OLD-2", 1, Buffer.alloc(16)]);
    const old = (await client!.query(OLD_SELECT, ["SF-OLD-2"])).rows[0];
    assert.equal(old.logId, "LOG-OLD-1");
    assert.equal("employeeId" in old, false);
    assert.deepEqual((await client!.query(`SELECT "employeeId", "matchCosine", "matchMargin" FROM stranger_faces WHERE id = 'SF-OLD-2'`)).rows[0],
      { employeeId: null, matchCosine: null, matchMargin: null });
    const again = await boot("storeOnly");
    assert.equal(again.code, 0, again.stderr.slice(-3000));
    assert.deepEqual(again.out.page, ["SF-OLD-2", "SF-OLD-1"], "a face written by old code is a stranger");
    // Out of the way of the scenarios.
    await client!.query(`DELETE FROM access_logs WHERE id = 'LOG-OLD-1'`);
    assert.equal((await client!.query("SELECT count(*)::int AS n FROM stranger_faces")).rows[0].n, 0, "cascade still holds");
  });

  it("runs the shadow-result scenario (same expectations as SQLite and JSON)", { skip }, async () => {
    const r = await boot("runShadowScenario");
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.doesNotMatch(r.stdout + r.stderr, STARTUP_FAILURE);
    assert.equal(r.out.mode, "postgresql");
    assertShadowScenario(r.out, assert);
  });

  it("runs the observation scenario (same expectations as SQLite and JSON)", { skip }, async () => {
    const r = await boot("runObservationScenario");
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.doesNotMatch(r.stdout + r.stderr, STARTUP_FAILURE);
    assert.equal(r.out.mode, "postgresql");
    assertObservationScenario(r.out, assert);
  });

  it("has the planned shadow schema: lengths, bytewise order, indexes, no biometric columns", { skip }, async () => {
    const cols = Object.fromEntries((await client!.query(
      `SELECT column_name, data_type, character_maximum_length, is_nullable, collation_name
         FROM information_schema.columns WHERE table_name = 'pipeline_shadow_results'`,
    )).rows.map((c) => [c.column_name, [c.data_type, c.character_maximum_length, c.is_nullable, c.collation_name]]));
    assert.deepEqual(cols, SHADOW_COLUMNS);
    const idx = (await client!.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'pipeline_shadow_results' ORDER BY indexname`,
    )).rows.map((r) => [r.indexname, r.indexdef.replace(/^.* USING btree /, "")]);
    assert.deepEqual(idx, [
      ["idx_shadow_results_decided", `("decidedAt" DESC, id DESC)`],
      ["idx_shadow_results_gate", `(gate, "decidedAt" DESC)`],
      ["pipeline_shadow_results_pkey", "(id)"],
    ]);
    const faceIdx = (await client!.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'stranger_faces' AND indexname = 'idx_stranger_faces_recognised'`,
    )).rows.map((r) => r.indexdef.replace(/^.* USING btree /, ""));
    assert.deepEqual(faceIdx, [`("employeeId", "capturedAt" DESC, id DESC) WHERE (("employeeId" IS NOT NULL) AND ("purgedAt" IS NULL))`]);
    const fk = (await client!.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'pipeline_shadow_results'::regclass AND contype = 'f'`)).rows[0].n;
    assert.equal(fk, 0, "no foreign key: a shadow result outlives a cleared access history");
    const mean = (await client!.query(`SELECT id, "meanCheckRefused" AS m FROM pipeline_shadow_results WHERE id IN ('SR-4','SR-6','SR-7') ORDER BY id`)).rows;
    assert.deepEqual(mean, [{ id: "SR-4", m: false }, { id: "SR-6", m: true }, { id: "SR-7", m: null }]);
  });

  it("enforces the column limits and the primary key in the database itself", { skip }, async () => {
    const insert = (id: string, gate: string) => client!.query(
      `INSERT INTO pipeline_shadow_results (id, gate, "trackId", outcome, basis, "framesSeen", "framesUsed", "firstSeenAt", "decidedAt", agreement, "createdAt")
       VALUES ($1, $2, 'exit-1', 'stranger', 'rejected-low', 1, 1, '2026-09-29T00:00:00.000Z', '2026-09-29T00:00:01.000Z', 'none', '2026-09-29T00:00:01.000Z')`,
      [id, gate],
    );
    await assert.rejects(insert("SR-" + "x".repeat(62), "EXIT"), (e: any) => e.code === "22001", "VARCHAR(64) is real");
    await assert.rejects(insert("SR-DB-1", "G".repeat(65)), (e: any) => e.code === "22001", "gate VARCHAR(64)");
    await insert("SR-DB-1", "EXIT");
    await assert.rejects(insert("SR-DB-1", "EXIT"), (e: any) => e.code === "23505", "one row per id (the store uses ON CONFLICT DO NOTHING)");
    await client!.query(`DELETE FROM pipeline_shadow_results WHERE id = 'SR-DB-1'`);
    await assert.rejects(client!.query(
      `INSERT INTO stranger_faces (id, "logId", "faceIndex", "capturedAt", gate, engine, box, "detectorScore", quality, "sizePx", "createdAt", "employeeId")
       VALUES ('SF-DB-1', 'LOG-G1', 9, '2026-09-29T00:00:00.000Z', 'EXIT', 'legacy', '[0,0,1,1]', 0.9, 0.5, 60, '2026-09-29T00:00:00.000Z', $1)`,
      ["E".repeat(65)]), (e: any) => e.code === "22001", "employeeId VARCHAR(64)");
  });

  it("serves shadow pages, the gate filter and observations from the indexes", { skip }, async () => {
    await client!.query("BEGIN");
    try {
      // Off: the planner's small-table shortcuts (a bitmap scan loses index order), not what is asserted here.
      await client!.query("SET LOCAL enable_seqscan = off");
      await client!.query("SET LOCAL enable_bitmapscan = off");
      const explain = async (sql: string) => (await client!.query(`EXPLAIN ${sql}`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
      const page = await explain(`SELECT id FROM pipeline_shadow_results WHERE ("decidedAt", id) < ('2026-09-30', 'SR-Z')
          ORDER BY "decidedAt" DESC, id DESC LIMIT 5`);
      assert.match(page, /idx_shadow_results_decided/, page);
      assert.doesNotMatch(page, /Sort/, page);
      const gate = await explain(`SELECT id FROM pipeline_shadow_results WHERE gate = 'EXIT' AND "decidedAt" >= '2026-09-29'
          ORDER BY "decidedAt" DESC, id DESC LIMIT 5`);
      assert.match(gate, /idx_shadow_results_(gate|decided)/, gate);
      const summary = await explain(`SELECT gate, count(*) FROM pipeline_shadow_results WHERE "decidedAt" >= '2026-09-29' GROUP BY gate`);
      assert.match(summary, /idx_shadow_results_(gate|decided)/, summary);
      const obs = await explain(`SELECT id FROM stranger_faces WHERE "employeeId" IS NOT NULL AND "purgedAt" IS NULL
          AND "capturedAt" >= '2026-09-29' AND "employeeId" = 'EMP-A' ORDER BY "capturedAt" DESC, id DESC LIMIT 5`);
      assert.match(obs, /idx_stranger_faces_recognised/, obs);
      const grouping = await explain(`SELECT id FROM stranger_faces WHERE "purgedAt" IS NULL AND "employeeId" IS NULL
          ORDER BY "capturedAt" DESC, id DESC LIMIT 5`);
      assert.match(grouping, /idx_stranger_faces_captured/, grouping);
      assert.doesNotMatch(grouping, /Sort/, grouping);
    } finally {
      await client!.query("ROLLBACK");
    }
  });

  it("keeps everything across a restart", { skip }, async () => {
    const s = await boot("readBackShadowScenario");
    assert.equal(s.code, 0, s.stderr.slice(-3000));
    assertShadowReadBack(s.out, assert);
    const o = await boot("readBackObservationScenario");
    assert.equal(o.code, 0, o.stderr.slice(-3000));
    assertObservationReadBack(o.out, assert);
    const src = (await client!.query(`SELECT id, source, "streamId" FROM face_templates ORDER BY id`)).rows;
    assert.deepEqual(src, [
      { id: "T-1", source: "adaptation", streamId: "exit-cam" },
      { id: "T-2", source: "enrollment", streamId: null },
      { id: "T-4", source: "merge", streamId: "entry-cam" },
      { id: "T-5", source: "adaptation", streamId: "entry-cam" },
    ], "adaptation templates are stored like any other; the deleted one is gone");
    const purged = (await client!.query(
      `SELECT "employeeId", embedding, crop, "purgedAt" IS NOT NULL AS purged FROM stranger_faces WHERE id = 'SF-GOLD-0'`,
    )).rows[0];
    assert.deepEqual(purged, { employeeId: "EMP-A", embedding: null, crop: null, purged: true }, "a purged observation keeps its provenance, never its bytes");
  });

  it("rollback by DROP, then a restart re-applies the migration (idempotent)", { skip }, async () => {
    await client!.query(`DROP TABLE pipeline_shadow_results`);
    await client!.query(`DROP INDEX idx_stranger_faces_recognised`);
    await client!.query(`ALTER TABLE stranger_faces DROP COLUMN "employeeId", DROP COLUMN "matchCosine", DROP COLUMN "matchMargin"`);
    const r = await boot("storeOnly");
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.doesNotMatch(r.stdout + r.stderr, STARTUP_FAILURE);
    assert.deepEqual(r.out.shadow, [], "dropping the table loses the comparison only");
    assert.deepEqual(r.out.obs, [], "dropping the columns turns observations into stranger faces (purge them first on a real rollback)");
    assert.ok(r.out.page.includes("SF-G1-0") && r.out.page.includes("SF-G2-1"), "...which then show up in grouping");
    assert.ok(r.out.templates.includes("T-1:adaptation"), "adaptation templates need no schema change to survive");
    const again = await boot("storeOnly");
    assert.equal(again.code, 0, again.stderr.slice(-3000));
    const n = (await client!.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'stranger_faces' AND column_name IN ('employeeId', 'matchCosine', 'matchMargin')`,
    )).rows[0].n;
    assert.equal(n, 3);
    assert.equal((await client!.query(`SELECT to_regclass('pipeline_shadow_results') IS NOT NULL AS ok`)).rows[0].ok, true);
    assert.equal((await client!.query(`SELECT to_regclass('idx_stranger_faces_recognised') IS NOT NULL AS ok`)).rows[0].ok, true);
  });
});
