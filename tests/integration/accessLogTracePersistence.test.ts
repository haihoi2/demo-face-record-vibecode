/**
 * Persistence of the access-event trace (capturedAt, trackId, recordingChannel)
 * against real stores, driving src/server/db.ts in child processes exactly as
 * the gateway does at startup.
 *
 * PostgreSQL: set PERSISTENCE_PG_URL to an ADMIN connection of a THROWAWAY
 * server (e.g. postgresql://itest:itest-only@smartface-verify-pg-rt-dat:5432/itest).
 * The test creates its own database on it, builds access_logs in the schema of
 * the previous release with rows in it, boots the storage layer on it, checks
 * the migration, round trip, replays, concurrency, restart and rollback, then
 * drops the database. Without the variable the PostgreSQL cases are skipped.
 * It refuses the live database names.
 *
 * SQLite runs always, in a scratch DATA_DIR.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import pg from "pg";

const require = createRequire(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DB_MODULE = fileURLToPath(new URL("../../src/server/db.ts", import.meta.url));
const PG_ADMIN_URL = String(process.env.PERSISTENCE_PG_URL || "").trim();

/** access_logs exactly as the release before this change creates it on PostgreSQL (main 633d995). */
const LEGACY_PG_ACCESS_LOGS = `
  CREATE TABLE IF NOT EXISTS access_logs (
    id VARCHAR(64) PRIMARY KEY,
    timestamp VARCHAR(64) NOT NULL,
    type VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL,
    "employeeId" VARCHAR(64),
    "employeeName" VARCHAR(255),
    "employeeCode" VARCHAR(64),
    department VARCHAR(255),
    "photoSnapshot" TEXT,
    confidence NUMERIC(5, 2),
    "livenessScore" NUMERIC(5, 2),
    "lockAction" TEXT,
    "doorName" VARCHAR(255),
    reason TEXT,
    "faceEmbedding" BYTEA,
    "faceEmbeddingDims" INTEGER,
    "faceEmbeddingModelTag" VARCHAR(128),
    "faceEmbeddingQuality" REAL
  );
  CREATE INDEX IF NOT EXISTS idx_access_logs_ts_id ON access_logs ("timestamp" DESC, id DESC);
`;

/** The previous release's INSERT, used to prove old code still writes to the migrated table. */
const LEGACY_PG_INSERT = `
  INSERT INTO access_logs (
    id, timestamp, type, status, "employeeId", "employeeName", "employeeCode",
    department, "photoSnapshot", confidence, "livenessScore", "lockAction", "doorName", reason,
    "faceEmbedding", "faceEmbeddingDims", "faceEmbeddingModelTag", "faceEmbeddingQuality"
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
  ON CONFLICT (id) DO NOTHING`;

const LEGACY_SQLITE_ACCESS_LOGS = `
  CREATE TABLE IF NOT EXISTS access_logs (
    id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
    employeeId TEXT, employeeName TEXT, employeeCode TEXT, department TEXT, photoSnapshot TEXT,
    confidence REAL, livenessScore REAL, lockAction TEXT, doorName TEXT, reason TEXT,
    faceEmbedding BLOB, faceEmbeddingDims INTEGER, faceEmbeddingModelTag TEXT, faceEmbeddingQuality REAL
  );`;

const LEGACY_EMBEDDING = Buffer.from(new Float32Array([0.6, 0.8]).buffer);
const legacyParams = (id: string, timestamp: string) => [
  id, timestamp, "EXIT", "DENIED", null, null, null, null,
  "data:image/jpeg;base64,/9j/legacy", 25, 85, "Khóa giữ nguyên trạng thái LOCKED", "Cửa chính", "legacy stranger",
  LEGACY_EMBEDDING, 2, "arcface_legacy", 0.7,
];

/** Scenario run inside the child: boot the storage layer, then act per PHASE. Plain JS (node -e). */
const CHILD_SCRIPT = `
const { db } = await import(${JSON.stringify(DB_MODULE)});
const phase = process.env.PHASE;
if (process.env.EXPECT_PG === "1") {
  const synced = await new Promise((resolve) => { db.onSync(() => resolve(true)); setTimeout(() => resolve(false), 60000); });
  if (!synced || db.getStorageStatus().active !== "postgresql") {
    process.stdout.write("RESULT " + JSON.stringify({ error: "postgres not ready", status: db.getStorageStatus() }) + "\\n");
    process.exit(3);
  }
}
const log = (over) => ({ id: "LOG-T1", timestamp: "2026-09-26T03:00:05.000Z", type: "ENTRY", status: "GRANTED",
  employeeId: "EMP-1", employeeName: "Nguyễn Văn A", employeeCode: "NV001", department: "Kỹ thuật",
  photoSnapshot: "data:image/jpeg;base64,/9j/crop", confidence: 91.5, livenessScore: 98,
  lockAction: "Mở chốt tự động", doorName: "Cửa chính", reason: "trace test", ...over });
const out = { mode: db.getStorageStatus().active };
if (phase === "write") {
  out.saved = await db.saveAccessLog(log({ capturedAt: "2026-09-26T10:00:01.25+07:00", trackId: "entry-000017", recordingChannel: "2201" }));
  out.stranger = await db.saveAccessLog(log({ id: "LOG-T2", type: "EXIT", status: "DENIED", employeeId: undefined,
    employeeName: undefined, employeeCode: undefined, department: undefined, timestamp: "2026-09-26T03:00:06.000Z",
    capturedAt: "2026-09-26T03:00:02.000Z", trackId: "exit-000003", recordingChannel: "501",
    faceEmbedding: [0.6, 0.8], faceEmbeddingModelTag: "arcface_test", faceEmbeddingQuality: 0.7 }));
  out.replay = await db.saveAccessLog(log({ trackId: "entry-999999", recordingChannel: "9" }));
  out.concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) => db.saveAccessLog(log({ id: "LOG-DUP", trackId: "dup-" + i }))));
  out.invalid = await db.saveAccessLog(log({ id: "LOG-BAD", trackId: "t".repeat(65), recordingChannel: "1".repeat(17), capturedAt: "garbage" }));
  // Not awaited, like the existing callers: the next read must still see it.
  const rywIds = Array.from({ length: 10 }, (_, i) => "LOG-RYW-" + i);
  for (const id of rywIds) db.saveAccessLog(log({ id, status: "DENIED", employeeId: undefined, employeeName: undefined, trackId: "ryw" }));
  out.rywMeta = (await Promise.all(rywIds.map((id) => db.getAccessLogMetaById(id)))).filter(Boolean).length;
  for (const id of rywIds) db.saveAccessLog(log({ id: id + "-S", status: "DENIED", employeeId: undefined, employeeName: undefined }));
  out.rywStranger = (await Promise.all(rywIds.map((id) => db.getStrangerCandidateLogById(id + "-S")))).filter(Boolean).length;
  out.longId = await db.saveAccessLog(log({ id: "LOG-" + "9".repeat(60), trackId: "k".repeat(64), recordingChannel: "1".repeat(16) }));
}
out.t1 = await db.getAccessLogMetaById("LOG-T1");
out.t2 = await db.getAccessLogMetaById("LOG-T2");
out.bad = await db.getAccessLogMetaById("LOG-BAD");
out.legacy = await db.getAccessLogMetaById("LOG-LEGACY-1");
out.legacyAfterRollback = await db.getAccessLogMetaById("LOG-LEGACY-2");
const q = await db.queryAccessLogs({}, null, 50);
out.queryT1 = q.logs.find((l) => l.id === "LOG-T1");
out.queryLegacy = q.logs.find((l) => l.id === "LOG-LEGACY-1");
out.pageT2 = (await db.getAccessLogsPage(1, 50)).logs.find((l) => l.id === "LOG-T2");
const s = (await db.getStrangerCandidateLogsPage(null, 50)).logs;
const st2 = s.find((l) => l.id === "LOG-T2");
out.strangerT2 = st2 ? { ...st2, faceEmbedding: st2.faceEmbedding ? st2.faceEmbedding.length : 0 } : undefined;
const sl = s.find((l) => l.id === "LOG-LEGACY-1");
out.strangerLegacyEmbedding = sl && sl.faceEmbedding ? sl.faceEmbedding.map((v) => Math.round(v * 1000) / 1000) : null;
process.stdout.write("RESULT " + JSON.stringify(out) + "\\n");
process.exit(0);
`;

function runChild(env: Record<string, string>): Promise<{ code: number; out: any; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", CHILD_SCRIPT],
      { cwd: REPO_ROOT, env: { ...process.env, ...env }, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const line = String(stdout).split("\n").find((l) => l.startsWith("RESULT "));
        resolve({
          code: err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0,
          out: line ? JSON.parse(line.slice(7)) : undefined,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

/** Startup errors that would mean the migration or a query broke (messages from db.ts). */
const STARTUP_FAILURE = /Lỗi khởi tạo bảng|Lỗi đồng bộ dữ liệu ban đầu|Lỗi saveAccessLog/;

const EXPECTED_T1 = {
  id: "LOG-T1", timestamp: "2026-09-26T03:00:05.000Z", type: "ENTRY", status: "GRANTED",
  capturedAt: "2026-09-26T03:00:01.250Z", trackId: "entry-000017", recordingChannel: "2201", gateId: "entry",
};

function assertRoundTrip(out: any) {
  assert.deepEqual(out.t1, EXPECTED_T1);
  assert.deepEqual(out.t2, {
    id: "LOG-T2", timestamp: "2026-09-26T03:00:06.000Z", type: "EXIT", status: "DENIED",
    capturedAt: "2026-09-26T03:00:02.000Z", trackId: "exit-000003", recordingChannel: "501", gateId: "exit",
  });
  assert.deepEqual(out.bad, { id: "LOG-BAD", timestamp: "2026-09-26T03:00:05.000Z", type: "ENTRY", status: "GRANTED", gateId: "entry" },
    "invalid trace values are dropped, the event is kept");
  assert.equal(out.queryT1.trackId, "entry-000017");
  assert.equal(out.queryT1.capturedAt, "2026-09-26T03:00:01.250Z");
  assert.equal(out.queryT1.photoSnapshot, "stored", "list pages never carry image bytes");
  assert.equal(out.pageT2.recordingChannel, "501");
  assert.equal(out.strangerT2.trackId, "exit-000003");
  assert.equal(out.strangerT2.faceEmbedding, 2, "embedding handling unchanged");
}

describe("PostgreSQL: access-log trace migration and persistence", () => {
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
    dbName = `dat_trace_${Date.now()}_${randomBytes(3).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(PG_ADMIN_URL);
    u.pathname = `/${dbName}`;
    dbUrl = u.toString();
    client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(LEGACY_PG_ACCESS_LOGS);
    await client.query(LEGACY_PG_INSERT, legacyParams("LOG-LEGACY-1", "2026-09-20T01:02:03.000Z"));
  });

  after(async () => {
    await client?.end().catch(() => {});
    if (admin && dbName) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin?.end().catch(() => {});
  });

  const boot = (phase: string) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dat-trace-pg-"));
    return runChild({ DATABASE_URL: dbUrl, DATA_DIR: dataDir, PHASE: phase, EXPECT_PG: "1" })
      .finally(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  };

  it("startup on the previous schema adds the columns and keeps existing rows intact", { skip }, async () => {
    const prior = (await client!.query(`SELECT * FROM access_logs WHERE id = 'LOG-LEGACY-1'`)).rows[0];
    const r = await boot("write");
    assert.equal(r.code, 0, r.stderr.slice(-2000));
    assert.doesNotMatch(r.stdout + r.stderr, STARTUP_FAILURE);
    assert.equal(r.out.mode, "postgresql");
    // First boot: these rows did not exist before, so this is the real read-after-write race.
    assert.equal(r.out.rywMeta, 10, "an unawaited save is visible to the next read by id");
    assert.equal(r.out.rywStranger, 10, "...and to the stranger lookup");

    const cols = (await client!.query(
      `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'access_logs' AND column_name IN ('capturedAt', 'trackId', 'recordingChannel')
        ORDER BY column_name`,
    )).rows;
    assert.deepEqual(cols, [
      { column_name: "capturedAt", data_type: "character varying", character_maximum_length: 64, is_nullable: "YES", column_default: null },
      { column_name: "recordingChannel", data_type: "character varying", character_maximum_length: 16, is_nullable: "YES", column_default: null },
      { column_name: "trackId", data_type: "character varying", character_maximum_length: 64, is_nullable: "YES", column_default: null },
    ]);

    const afterRow = (await client!.query(`SELECT * FROM access_logs WHERE id = 'LOG-LEGACY-1'`)).rows[0];
    for (const [k, v] of Object.entries(prior)) assert.deepEqual(afterRow[k], v, `legacy column ${k} unchanged`);
    assert.equal(afterRow.capturedAt, null);
    assert.equal(afterRow.trackId, null);
    assert.equal(afterRow.recordingChannel, null);

    assert.deepEqual(r.out.legacy, { id: "LOG-LEGACY-1", timestamp: "2026-09-20T01:02:03.000Z", type: "EXIT", status: "DENIED", gateId: "exit" });
    assert.equal(r.out.queryLegacy.capturedAt, undefined);
    assert.deepEqual(r.out.strangerLegacyEmbedding, [0.6, 0.8], "legacy embedding still decodes");
  });

  it("round-trips the values through every read path", { skip }, async () => {
    const r = await boot("read");
    assert.equal(r.code, 0, r.stderr.slice(-2000));
    assertRoundTrip(r.out);
    const row = (await client!.query(`SELECT "capturedAt", "trackId", "recordingChannel" FROM access_logs WHERE id = 'LOG-T1'`)).rows[0];
    assert.deepEqual(row, { capturedAt: "2026-09-26T03:00:01.250Z", trackId: "entry-000017", recordingChannel: "2201" });
  });

  it("awaits the durable write, ignores replays and survives concurrent duplicates", { skip }, async () => {
    // Re-run the writer: every save resolves true and nothing changes.
    const r = await boot("write");
    assert.equal(r.code, 0, r.stderr.slice(-2000));
    assert.equal(r.out.saved, true);
    assert.equal(r.out.replay, true);
    assert.deepEqual(r.out.concurrent, Array(8).fill(true));
    assert.equal(r.out.invalid, true, "an invalid trace never fails the event");
    assert.equal(r.out.longId, true, "values at the column limits fit");
    assert.equal(r.out.rywMeta, 10, "an unawaited save is visible to the next read by id");
    assert.equal(r.out.rywStranger, 10, "...and to the stranger lookup");
    assert.deepEqual(r.out.t1, EXPECTED_T1, "the first write wins");
    const dup = (await client!.query(`SELECT count(*)::int AS n, min("trackId") AS t FROM access_logs WHERE id = 'LOG-DUP'`)).rows[0];
    assert.equal(dup.n, 1);
    assert.match(dup.t, /^dup-[0-7]$/);
    const bad = (await client!.query(`SELECT "trackId", "recordingChannel", "capturedAt" FROM access_logs WHERE id = 'LOG-BAD'`)).rows[0];
    assert.deepEqual(bad, { trackId: null, recordingChannel: null, capturedAt: null });
    // The column limits are real: an unvalidated over-long value would fail the whole INSERT.
    await assert.rejects(
      client!.query(`UPDATE access_logs SET "trackId" = $1 WHERE id = 'LOG-BAD'`, ["t".repeat(65)]),
      (e: any) => e.code === "22001",
    );
  });

  it("old code keeps working against the migrated table (rollback without DDL)", { skip }, async () => {
    await client!.query(LEGACY_PG_INSERT, legacyParams("LOG-LEGACY-2", "2026-09-26T04:00:00.000Z"));
    const rows = (await client!.query(
      `SELECT id, timestamp, type, status FROM access_logs WHERE id = ANY($1) ORDER BY id`, [["LOG-LEGACY-2", "LOG-T1"]],
    )).rows;
    assert.deepEqual(rows.map((x) => x.id), ["LOG-LEGACY-2", "LOG-T1"]);
    const r = await boot("read");
    assert.equal(r.code, 0, r.stderr.slice(-2000));
    assert.equal(r.out.legacyAfterRollback.status, "DENIED");
    assert.equal(r.out.legacyAfterRollback.trackId, undefined);
    assertRoundTrip(r.out);
  });

  it("DROP COLUMN rollback, then a restart re-applies the migration (idempotent)", { skip }, async () => {
    await client!.query(`ALTER TABLE access_logs DROP COLUMN "capturedAt", DROP COLUMN "trackId", DROP COLUMN "recordingChannel"`);
    const r = await boot("read");
    assert.equal(r.code, 0, r.stderr.slice(-2000));
    assert.doesNotMatch(r.stdout + r.stderr, STARTUP_FAILURE);
    assert.deepEqual(r.out.t1, { id: "LOG-T1", timestamp: "2026-09-26T03:00:05.000Z", type: "ENTRY", status: "GRANTED", gateId: "entry" },
      "dropping the columns loses only the trace, never the event");
    const again = await boot("read");
    assert.equal(again.code, 0, again.stderr.slice(-2000));
    const n = (await client!.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'access_logs' AND column_name IN ('capturedAt','trackId','recordingChannel')`,
    )).rows[0].n;
    assert.equal(n, 3);
  });
});

describe("SQLite: access-log trace migration and persistence", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dat-trace-sqlite-"));
  const dbFile = path.join(dataDir, "smartface.db");
  const { DatabaseSync } = require("node:sqlite");

  before(() => {
    const legacy = new DatabaseSync(dbFile);
    legacy.exec(LEGACY_SQLITE_ACCESS_LOGS);
    legacy.prepare(`INSERT INTO access_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...legacyParams("LOG-LEGACY-1", "2026-09-20T01:02:03.000Z"));
    legacy.close();
  });
  after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it("adds the columns on startup, keeps the old row, round-trips and restarts cleanly", async () => {
    const first = await runChild({ DATABASE_URL: "", DATA_DIR: dataDir, PHASE: "write" });
    assert.equal(first.code, 0, first.stderr.slice(-2000));
    assert.equal(first.out.mode, "sqlite");
    assert.deepEqual(first.out.concurrent, Array(8).fill(true));
    assert.equal(first.out.invalid, true);
    assert.equal(first.out.rywMeta, 10);
    assert.equal(first.out.rywStranger, 10);
    assertRoundTrip(first.out);
    assert.deepEqual(first.out.legacy, { id: "LOG-LEGACY-1", timestamp: "2026-09-20T01:02:03.000Z", type: "EXIT", status: "DENIED", gateId: "exit" });
    assert.deepEqual(first.out.strangerLegacyEmbedding, [0.6, 0.8]);

    const second = await runChild({ DATABASE_URL: "", DATA_DIR: dataDir, PHASE: "read" });
    assert.equal(second.code, 0, second.stderr.slice(-2000));
    assertRoundTrip(second.out);

    const inspect = new DatabaseSync(dbFile);
    try {
      const cols = (inspect.prepare("PRAGMA table_info(access_logs)").all() as Array<{ name: string }>).map((c) => c.name);
      // The trace columns, then the N-gate wave's gateId (appended after them by its own migration).
      assert.deepEqual(cols.slice(-4), ["capturedAt", "trackId", "recordingChannel", "gateId"]);
      const legacy = inspect.prepare("SELECT photoSnapshot, reason, faceEmbeddingModelTag FROM access_logs WHERE id = 'LOG-LEGACY-1'").get();
      assert.deepEqual({ ...legacy }, { photoSnapshot: "data:image/jpeg;base64,/9j/legacy", reason: "legacy stranger", faceEmbeddingModelTag: "arcface_legacy" });
      assert.equal((inspect.prepare("SELECT count(*) AS n FROM access_logs WHERE id = 'LOG-DUP'").get() as any).n, 1);
    } finally {
      inspect.close();
    }
  });
});
