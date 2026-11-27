/**
 * Persistence of the access-event source (#523): NULL for door-scan rows,
 * "pipeline" for the attendance-only rows a notify gate's real-time pipeline
 * writes (no unlock, no image). Drives src/server/db.ts in child processes as
 * the gateway does at startup.
 *
 * PostgreSQL: set PERSISTENCE_PG_URL to an ADMIN connection of a THROWAWAY
 * server; the test creates and drops its own database and refuses the live
 * database names. Without the variable the PostgreSQL cases are skipped.
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

/** access_logs as the release before this change (main 1bd39b8) creates it on PostgreSQL. */
const PREVIOUS_PG_ACCESS_LOGS = `
  CREATE TABLE IF NOT EXISTS access_logs (
    id VARCHAR(64) PRIMARY KEY, timestamp VARCHAR(64) NOT NULL, type VARCHAR(16) NOT NULL, status VARCHAR(16) NOT NULL,
    "employeeId" VARCHAR(64), "employeeName" VARCHAR(255), "employeeCode" VARCHAR(64), department VARCHAR(255),
    "photoSnapshot" TEXT, confidence NUMERIC(5, 2), "livenessScore" NUMERIC(5, 2), "lockAction" TEXT,
    "doorName" VARCHAR(255), reason TEXT, "faceEmbedding" BYTEA, "faceEmbeddingDims" INTEGER,
    "faceEmbeddingModelTag" VARCHAR(128), "faceEmbeddingQuality" REAL,
    "capturedAt" VARCHAR(64), "trackId" VARCHAR(64), "recordingChannel" VARCHAR(16), "gateId" VARCHAR(32)
  );`;
/** The previous release's INSERT: old code must still write to the migrated table. */
const PREVIOUS_PG_INSERT = `
  INSERT INTO access_logs (id, timestamp, type, status, "employeeId", "employeeName", "photoSnapshot", confidence,
    "lockAction", "doorName", reason, "gateId")
  VALUES ($1, $2, 'EXIT', 'GRANTED', 'EMP-OLD', 'Old Row', 'data:image/jpeg;base64,/9j/old', 80,
    'Mở chốt tự động', 'Cửa chính', 'door scan', 'exit') ON CONFLICT (id) DO NOTHING`;

const CHILD_SCRIPT = `
const { db } = await import(${JSON.stringify(DB_MODULE)});
if (process.env.EXPECT_PG === "1") {
  const synced = await new Promise((resolve) => { db.onSync(() => resolve(true)); setTimeout(() => resolve(false), 60000); });
  if (!synced || db.getStorageStatus().active !== "postgresql") { process.stdout.write("RESULT " + JSON.stringify({ error: "postgres not ready" }) + "\\n"); process.exit(3); }
}
const row = (over) => ({ id: "LOG-P1", timestamp: "2026-11-27T03:00:05.000Z", type: "EXIT", gateId: "exit", status: "GRANTED",
  employeeId: "EMP-1", employeeName: "Nguyễn Văn A", employeeCode: "NV001", department: "Kỹ thuật",
  photoSnapshot: "", confidence: 52, lockAction: "Không mở cửa (chỉ ghi nhận lượt đi qua)", doorName: "Cửa chính",
  reason: "pipeline", trackId: "X-7", source: "pipeline", ...over });
const out = { mode: db.getStorageStatus().active };
if (process.env.PHASE === "write") {
  out.saved = [
    await db.saveAccessLog(row({})),
    await db.saveAccessLog(row({ id: "LOG-D1", source: undefined, photoSnapshot: "data:image/jpeg;base64,/9j/door", reason: "door scan" })),
    await db.saveAccessLog(row({ id: "LOG-X1", source: "browser" })),
  ];
}
const pick = (l) => l && { id: l.id, source: l.source ?? null, hasSourceKey: "source" in l, photo: l.photoSnapshot ? "yes" : "no" };
const q = await db.queryAccessLogs({}, null, 50);
const page = await db.getAccessLogsPage(1, 50);
const all = db.getAccessLogs([]);
out.query = ["LOG-P1", "LOG-D1", "LOG-X1", "LOG-OLD"].map((id) => pick(q.logs.find((l) => l.id === id)));
out.page = ["LOG-P1", "LOG-D1"].map((id) => pick(page.logs.find((l) => l.id === id)));
out.hydrated = ["LOG-P1", "LOG-D1"].map((id) => pick(all.find((l) => l.id === id)));
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

const STARTUP_FAILURE = /Lỗi khởi tạo bảng|Lỗi đồng bộ dữ liệu ban đầu|Lỗi saveAccessLog/;

/** Every read path: the pipeline row says so, a door-scan row has no source key at all, an unknown value is never stored. */
function assertSources(out: any, withOld: boolean) {
  assert.deepEqual(out.query.slice(0, 3), [
    { id: "LOG-P1", source: "pipeline", hasSourceKey: true, photo: "no" },
    { id: "LOG-D1", source: null, hasSourceKey: false, photo: "yes" },
    { id: "LOG-X1", source: null, hasSourceKey: false, photo: "no" },
  ]);
  if (withOld) assert.deepEqual(out.query[3], { id: "LOG-OLD", source: null, hasSourceKey: false, photo: "yes" });
  assert.deepEqual(out.page, [
    { id: "LOG-P1", source: "pipeline", hasSourceKey: true, photo: "no" },
    { id: "LOG-D1", source: null, hasSourceKey: false, photo: "yes" },
  ]);
  assert.equal(out.hydrated[0]?.source, "pipeline", "startup hydration keeps the source (pairing skips pipeline rows)");
  assert.equal(out.hydrated[1]?.hasSourceKey, false);
}

describe("PostgreSQL: access-log source column", () => {
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
    dbName = `dat_source_${Date.now()}_${randomBytes(3).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(PG_ADMIN_URL);
    u.pathname = `/${dbName}`;
    dbUrl = u.toString();
    client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(PREVIOUS_PG_ACCESS_LOGS);
    await client.query(PREVIOUS_PG_INSERT, ["LOG-OLD", "2026-11-26T01:00:00.000Z"]);
  });

  after(async () => {
    await client?.end().catch(() => {});
    if (admin && dbName) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin?.end().catch(() => {});
  });

  const boot = (phase: string) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dat-source-pg-"));
    return runChild({ DATABASE_URL: dbUrl, DATA_DIR: dataDir, PHASE: phase, EXPECT_PG: "1" })
      .finally(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  };

  it("adds a nullable VARCHAR(16) without default or backfill and round-trips it", { skip }, async () => {
    const r = await boot("write");
    assert.equal(r.code, 0, r.stderr.slice(-2000));
    assert.doesNotMatch(r.stdout + r.stderr, STARTUP_FAILURE);
    assert.deepEqual(r.out.saved, [true, true, true]);
    const col = (await client!.query(
      `SELECT data_type, character_maximum_length, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'access_logs' AND column_name = 'source'`,
    )).rows;
    assert.deepEqual(col, [{ data_type: "character varying", character_maximum_length: 16, is_nullable: "YES", column_default: null }]);
    const stored = (await client!.query(`SELECT id, source FROM access_logs ORDER BY id`)).rows;
    assert.deepEqual(stored, [
      { id: "LOG-D1", source: null }, { id: "LOG-OLD", source: null }, { id: "LOG-P1", source: "pipeline" }, { id: "LOG-X1", source: null },
    ]);
    assertSources(r.out, true);
    const again = await boot("read");
    assert.equal(again.code, 0, again.stderr.slice(-2000));
    assertSources(again.out, true);
  });

  it("old code still writes; DROP COLUMN rollback loses only the source, a restart re-adds it", { skip }, async () => {
    await client!.query(PREVIOUS_PG_INSERT, ["LOG-OLD-2", "2026-11-27T04:00:00.000Z"]);
    assert.equal((await client!.query(`SELECT source FROM access_logs WHERE id = 'LOG-OLD-2'`)).rows[0].source, null);
    await client!.query(`ALTER TABLE access_logs DROP COLUMN "source"`);
    const r = await boot("read");
    assert.equal(r.code, 0, r.stderr.slice(-2000));
    assert.doesNotMatch(r.stdout + r.stderr, STARTUP_FAILURE);
    assert.equal(r.out.query[0].id, "LOG-P1", "the event survives the rollback");
    assert.equal(r.out.query[0].source, null);
    const n = (await client!.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'access_logs' AND column_name = 'source'`,
    )).rows[0].n;
    assert.equal(n, 1);
  });
});

describe("SQLite: access-log source column", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dat-source-sqlite-"));
  const { DatabaseSync } = require("node:sqlite");
  after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it("adds the column on startup and round-trips it across a restart", async () => {
    const first = await runChild({ DATABASE_URL: "", DATA_DIR: dataDir, PHASE: "write" });
    assert.equal(first.code, 0, first.stderr.slice(-2000));
    assert.equal(first.out.mode, "sqlite");
    assert.deepEqual(first.out.saved, [true, true, true]);
    assertSources(first.out, false);
    const second = await runChild({ DATABASE_URL: "", DATA_DIR: dataDir, PHASE: "read" });
    assert.equal(second.code, 0, second.stderr.slice(-2000));
    assertSources(second.out, false);
    const inspect = new DatabaseSync(path.join(dataDir, "smartface.db"));
    try {
      const rows = inspect.prepare("SELECT id, source FROM access_logs ORDER BY id").all().map((x: any) => ({ ...x }));
      assert.deepEqual(rows, [{ id: "LOG-D1", source: null }, { id: "LOG-P1", source: "pipeline" }, { id: "LOG-X1", source: null }]);
    } finally {
      inspect.close();
    }
  });
});
