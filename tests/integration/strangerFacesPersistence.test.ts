/**
 * Per-face stranger records on PostgreSQL: stranger_faces, faceIds on
 * adjudications, the candidate-log exclusion, retention purge, foreign key,
 * migration from the previous release, rollback and restart. Runs the same
 * scenario as tests/strangerFacesStore.test.ts (SQLite and JSON) through
 * src/server/db.ts in child processes, exactly as the gateway boots.
 *
 * Set PERSISTENCE_PG_URL to an ADMIN connection of a THROWAWAY server (e.g.
 * postgresql://itest:itest-only@smartface-verify-pg-pf-db:5432/itest). The test
 * creates its own database, builds the previous release's stranger tables with
 * a row in them, runs the scenario, inspects the schema, then drops the
 * database. Without the variable it is skipped. It refuses the live database.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import pg from "pg";
import {
  assertStrangerFaceReadBack,
  assertStrangerFaceScenario,
  runScenarioChild,
} from "../fixtures/strangerFacesScenario";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const PG_ADMIN_URL = String(process.env.PERSISTENCE_PG_URL || "").trim();

/** The stranger adjudication tables exactly as the previous release creates them (no faceIds). */
const LEGACY_PG = `
  CREATE TABLE stranger_resolutions (
    id VARCHAR(128) PRIMARY KEY, "clusterId" VARCHAR(128) UNIQUE NOT NULL, action VARCHAR(32) NOT NULL,
    "employeeId" VARCHAR(64), actor VARCHAR(255) NOT NULL, "resolvedAt" VARCHAR(64) NOT NULL,
    "logIds" JSONB NOT NULL, "sourceLogId" VARCHAR(64), metadata JSONB NOT NULL DEFAULT '{}'::jsonb);
  CREATE TABLE stranger_resolution_events (
    id VARCHAR(128) PRIMARY KEY, "clusterId" VARCHAR(128) NOT NULL, action VARCHAR(32) NOT NULL,
    "employeeId" VARCHAR(64), actor VARCHAR(255) NOT NULL, "resolvedAt" VARCHAR(64) NOT NULL,
    "logIds" JSONB NOT NULL, "sourceLogId" VARCHAR(64), metadata JSONB NOT NULL DEFAULT '{}'::jsonb);`;
/** The previous release's INSERT and SELECT (commitStrangerResolution / loadStrangerResolutions). */
const LEGACY_INSERT = (table: string) => `INSERT INTO ${table} (id,"clusterId",action,"employeeId",actor,"resolvedAt","logIds","sourceLogId",metadata)
  VALUES ($1,$2,'DISMISS',NULL,'op','2026-09-20T00:00:00.000Z','["LOG-OLD-1"]'::jsonb,NULL,'{}'::jsonb)`;
const LEGACY_SELECT = `SELECT id, "clusterId", action, "employeeId", actor, "resolvedAt", "logIds", "sourceLogId", metadata FROM stranger_resolutions`;

/** Messages db.ts logs when a migration or a face write breaks. */
const STARTUP_FAILURE = /Lỗi khởi tạo bảng|Lỗi đồng bộ dữ liệu ban đầu|Lỗi nạp adjudication|Lỗi nạp lịch sử adjudication/;

describe("PostgreSQL: per-face stranger records", () => {
  let admin: pg.Client | null = null;
  let client: pg.Client | null = null;
  let dbName = "";
  let dbUrl = "";
  let first: any;
  const skip = !PG_ADMIN_URL ? "PERSISTENCE_PG_URL not set (throwaway PostgreSQL only)" : false;
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-db-pg-local-"));

  before(async () => {
    if (skip) return;
    const adminUrl = new URL(PG_ADMIN_URL);
    if (/smartface_db/i.test(adminUrl.pathname) || /smartface-postgres-18/i.test(adminUrl.hostname)) {
      throw new Error("Refusing to run the persistence test against the live database");
    }
    admin = new pg.Client({ connectionString: PG_ADMIN_URL });
    await admin.connect();
    dbName = `pf_db_${Date.now()}_${randomBytes(3).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(PG_ADMIN_URL);
    u.pathname = `/${dbName}`;
    dbUrl = u.toString();
    client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(LEGACY_PG);
    await client.query(LEGACY_INSERT("stranger_resolutions"), ["RES-OLD-1", "SC-OLD-1"]);
    await client.query(LEGACY_INSERT("stranger_resolution_events"), ["RES-OLD-1", "SC-OLD-1"]);
  });

  after(async () => {
    await client?.end().catch(() => {});
    if (admin && dbName) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin?.end().catch(() => {});
    fs.rmSync(localDir, { recursive: true, force: true });
  });

  /** Fresh local DATA_DIR per boot unless one is given (the local store is not read while PostgreSQL is active). */
  const boot = async (fn: Parameters<typeof runScenarioChild>[0], dataDir?: string) => {
    const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "pf-db-pg-"));
    try {
      return await runScenarioChild(fn, { DATABASE_URL: dbUrl, DATA_DIR: dir, EXPECT_PG: "1" });
    } finally {
      if (!dataDir) fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("migrates the previous release: old adjudications read faceIds [], old code still reads and writes", { skip }, async () => {
    const r = await boot("resolutionsOnly");
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.doesNotMatch(r.stdout + r.stderr, STARTUP_FAILURE);
    assert.equal(r.out.mode, "postgresql");
    assert.deepEqual(r.out.resolutions.map((x: any) => [x.id, x.logIds, x.faceIds]), [["RES-OLD-1", ["LOG-OLD-1"], []]]);
    assert.deepEqual(r.out.events.map((x: any) => x.faceIds), [[]]);

    const cols = (await client!.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE column_name = 'faceIds' ORDER BY table_name`,
    )).rows;
    assert.deepEqual(cols, [
      { table_name: "stranger_resolution_events", column_name: "faceIds", data_type: "jsonb", is_nullable: "NO", column_default: "'[]'::jsonb" },
      { table_name: "stranger_resolutions", column_name: "faceIds", data_type: "jsonb", is_nullable: "NO", column_default: "'[]'::jsonb" },
    ]);
    // Rollback to the previous image: its INSERT and SELECT never name faceIds.
    await client!.query(LEGACY_INSERT("stranger_resolutions"), ["RES-OLD-2", "SC-OLD-2"]);
    const old = (await client!.query(`${LEGACY_SELECT} WHERE id = 'RES-OLD-2'`)).rows[0];
    assert.deepEqual(old.logIds, ["LOG-OLD-1"]);
    assert.equal("faceIds" in old, false);
    assert.deepEqual((await client!.query(`SELECT "faceIds" FROM stranger_resolutions WHERE id = 'RES-OLD-2'`)).rows[0].faceIds, []);
    // Out of the way of the shared scenario's expectations.
    await client!.query(`DELETE FROM stranger_resolutions WHERE "clusterId" LIKE 'SC-OLD-%'`);
  });

  it("runs the shared scenario (same expectations as SQLite and JSON)", { skip }, async () => {
    // A face left in the local SQLite store by an earlier fallback period.
    const seed = await runScenarioChild("runStrangerFaceScenario", { DATABASE_URL: "", DATA_DIR: localDir });
    assert.equal(seed.code, 0, seed.stderr.slice(-3000));
    const local = new DatabaseSync(path.join(localDir, "smartface.db"));
    try {
      local.exec("UPDATE stranger_faces SET id = 'SF-STRANDED' WHERE id = 'SF-OLD-0'");
    } finally {
      local.close();
    }

    const r = await boot("runStrangerFaceScenario", localDir);
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.doesNotMatch(r.stdout + r.stderr, STARTUP_FAILURE);
    assert.equal(r.out.mode, "postgresql");
    assertStrangerFaceScenario(r.out, assert);
    first = r.out;
    assert.match(r.stdout + r.stderr, /khuôn mặt người lạ chỉ nằm trong kho cục bộ/, "stranded local faces are reported at startup");

    const check = new DatabaseSync(path.join(localDir, "smartface.db"));
    try {
      const stranded = check.prepare("SELECT crop, embedding, purgedAt FROM stranger_faces WHERE id = 'SF-STRANDED'").get() as any;
      assert.equal(stranded.crop, null, "the retention purge also clears stranded local crops");
      assert.equal(stranded.embedding, null);
      assert.equal(typeof stranded.purgedAt, "string");
    } finally {
      check.close();
    }
  });

  it("has the planned schema: lengths, bytewise order, partial paging index, unique slot, cascading foreign key", { skip }, async () => {
    const cols = Object.fromEntries((await client!.query(
      `SELECT column_name, data_type, character_maximum_length, is_nullable, collation_name
         FROM information_schema.columns WHERE table_name = 'stranger_faces'`,
    )).rows.map((c) => [c.column_name, [c.data_type, c.character_maximum_length, c.is_nullable, c.collation_name]]));
    assert.deepEqual(cols, {
      id: ["character varying", 64, "NO", "C"],
      logId: ["character varying", 64, "NO", null],
      faceIndex: ["integer", null, "NO", null],
      capturedAt: ["character varying", 64, "NO", "C"],
      gate: ["character varying", 16, "NO", null],
      streamId: ["character varying", 64, "YES", null],
      engine: ["character varying", 16, "NO", null],
      trackId: ["character varying", 64, "YES", null],
      box: ["jsonb", null, "NO", null],
      sourceWidth: ["integer", null, "YES", null],
      sourceHeight: ["integer", null, "YES", null],
      detectorScore: ["real", null, "NO", null],
      quality: ["real", null, "NO", null],
      edgeEnergy: ["real", null, "YES", null],
      sizePx: ["integer", null, "NO", null],
      embedding: ["bytea", null, "YES", null],
      dims: ["integer", null, "YES", null],
      modelTag: ["character varying", 128, "YES", null],
      crop: ["bytea", null, "YES", null],
      createdAt: ["character varying", 64, "NO", null],
      purgedAt: ["character varying", 64, "YES", null],
      employeeId: ["character varying", 64, "YES", null],
      matchCosine: ["real", null, "YES", null],
      matchMargin: ["real", null, "YES", null],
    });
    const idx = (await client!.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'stranger_faces' ORDER BY indexname`,
    )).rows.map((r) => [r.indexname, r.indexdef.replace(/^.* USING btree /, "")]);
    assert.deepEqual(idx, [
      ["idx_stranger_faces_captured", `("capturedAt" DESC, id DESC) WHERE ("purgedAt" IS NULL)`],
      ["idx_stranger_faces_log", `("logId", "faceIndex")`],
      ["idx_stranger_faces_recognised", `("employeeId", "capturedAt" DESC, id DESC) WHERE (("employeeId" IS NOT NULL) AND ("purgedAt" IS NULL))`],
      ["stranger_faces_pkey", "(id)"],
    ]);
    const fk = (await client!.query(
      `SELECT confrelid::regclass::text AS ref, confdeltype FROM pg_constraint WHERE conrelid = 'stranger_faces'::regclass AND contype = 'f'`,
    )).rows;
    assert.deepEqual(fk, [{ ref: "access_logs", confdeltype: "c" }]);
    const box = (await client!.query(`SELECT box, jsonb_typeof(box) AS t FROM stranger_faces WHERE id = 'SF-A0'`)).rows[0];
    assert.deepEqual(box, { box: [100, 50, 220, 190], t: "array" });
    const emb = (await client!.query(`SELECT length(embedding) AS n, dims FROM stranger_faces WHERE id = 'SF-A0'`)).rows[0];
    assert.deepEqual(emb, { n: 16, dims: 4 }, "float32 little-endian, like access_logs.faceEmbedding");
  });

  it("enforces the foreign key and the column limits in the database itself", { skip }, async () => {
    const insert = (id: string, logId: string, faceIndex: number) => client!.query(
      `INSERT INTO stranger_faces (id, "logId", "faceIndex", "capturedAt", gate, engine, box, "detectorScore", quality, "sizePx", "createdAt")
       VALUES ($1, $2, $3, '2026-09-29T00:00:00.000Z', 'ENTRY', 'legacy', '[0,0,1,1]', 0.9, 0.5, 60, '2026-09-29T00:00:00.000Z')`,
      [id, logId, faceIndex],
    );
    await assert.rejects(insert("SF-FK", "LOG-NOPE", 0), (e: any) => e.code === "23503", "no face without its access event");
    await assert.rejects(insert("SF-" + "x".repeat(62), "LOG-A", 9), (e: any) => e.code === "22001", "VARCHAR(64) is real");
    await assert.rejects(insert("SF-DUP-SLOT", "LOG-A", 0), (e: any) => e.code === "23505", "one face per (logId, faceIndex)");
  });

  it("serves pages and the candidate anti-join from the indexes", { skip }, async () => {
    await client!.query("BEGIN");
    try {
      await client!.query("SET LOCAL enable_seqscan = off");
      const page = (await client!.query(
        `EXPLAIN SELECT id FROM stranger_faces WHERE "purgedAt" IS NULL AND ("capturedAt", id) < ('2026-09-30', 'SF-Z')
          ORDER BY "capturedAt" DESC, id DESC LIMIT 5`,
      )).rows.map((r) => r["QUERY PLAN"]).join("\n");
      assert.match(page, /idx_stranger_faces_captured/, page);
      assert.doesNotMatch(page, /Sort/, page);
      const anti = (await client!.query(
        `EXPLAIN SELECT id FROM access_logs WHERE NOT EXISTS (SELECT 1 FROM stranger_faces sf WHERE sf."logId" = access_logs.id)`,
      )).rows.map((r) => r["QUERY PLAN"]).join("\n");
      assert.match(anti, /idx_stranger_faces_log/, anti);
    } finally {
      await client!.query("ROLLBACK");
    }
  });

  it("keeps faces, purges and faceIds across a restart", { skip }, async () => {
    const r = await boot("readBackStrangerFaceScenario");
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assertStrangerFaceReadBack(r.out, first, assert);
    const purged = (await client!.query(
      `SELECT count(*)::int AS n FROM stranger_faces WHERE "purgedAt" IS NOT NULL AND (crop IS NOT NULL OR embedding IS NOT NULL)`,
    )).rows[0].n;
    assert.equal(purged, 0, "no purged row keeps biometric bytes");
    const tomb = (await client!.query(`SELECT count(*)::int AS n FROM stranger_faces WHERE "purgedAt" IS NOT NULL`)).rows[0].n;
    assert.equal(tomb, 2, "purged rows stay as tombstones");
  });

  it("clearing the access history removes the faces with it (ON DELETE CASCADE)", { skip }, async () => {
    const r = await boot("clearAndCount");
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.deepEqual(r.out, { left: 0 });
    assert.equal((await client!.query("SELECT count(*)::int AS n FROM stranger_faces")).rows[0].n, 0);
    assert.ok((await client!.query("SELECT count(*)::int AS n FROM stranger_resolution_events")).rows[0].n > 0,
      "adjudication history is not touched");
  });

  it("rollback by DROP, then a restart re-applies the migration (idempotent)", { skip }, async () => {
    await client!.query(`DROP TABLE stranger_faces`);
    await client!.query(`ALTER TABLE stranger_resolutions DROP COLUMN "faceIds"`);
    await client!.query(`ALTER TABLE stranger_resolution_events DROP COLUMN "faceIds"`);
    const r = await boot("resolutionsOnly");
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.doesNotMatch(r.stdout + r.stderr, STARTUP_FAILURE);
    assert.ok(r.out.resolutions.every((x: any) => Array.isArray(x.faceIds) && x.faceIds.length === 0),
      "dropping the column loses face membership only, never the adjudication");
    const again = await boot("resolutionsOnly");
    assert.equal(again.code, 0, again.stderr.slice(-3000));
    const n = (await client!.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE column_name = 'faceIds'`,
    )).rows[0].n;
    assert.equal(n, 2);
    assert.equal((await client!.query(`SELECT to_regclass('stranger_faces') IS NOT NULL AS ok`)).rows[0].ok, true);
  });
});
