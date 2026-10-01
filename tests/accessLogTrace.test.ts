/**
 * Access-event trace fields (capturedAt, trackId, recordingChannel) in the
 * local stores, without a server: SQLite in this process (the storage module
 * is a singleton, so it is imported after DATA_DIR points at a scratch
 * directory holding a database in the schema the previous release created),
 * and the JSON fallback in a child process started with SQLite disabled.
 *
 * PostgreSQL is covered by tests/integration/accessLogTracePersistence.test.ts.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dat-trace-"));
const DB_FILE = path.join(DATA_DIR, "smartface.db");

/** access_logs exactly as the release before this change creates it (main 633d995). */
const LEGACY_SQLITE_ACCESS_LOGS = `
  CREATE TABLE IF NOT EXISTS access_logs (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    employeeId TEXT,
    employeeName TEXT,
    employeeCode TEXT,
    department TEXT,
    photoSnapshot TEXT,
    confidence REAL,
    livenessScore REAL,
    lockAction TEXT,
    doorName TEXT,
    reason TEXT,
    faceEmbedding BLOB,
    faceEmbeddingDims INTEGER,
    faceEmbeddingModelTag TEXT,
    faceEmbeddingQuality REAL
  );
  CREATE INDEX IF NOT EXISTS idx_access_logs_ts_id ON access_logs (timestamp DESC, id DESC);
`;

const LEGACY_ROW = {
  id: "LOG-LEGACY-1",
  timestamp: "2026-09-20T01:02:03.000Z",
  type: "EXIT",
  status: "DENIED",
  photoSnapshot: "data:image/jpeg;base64,/9j/legacy",
  confidence: 25,
  livenessScore: 85,
  lockAction: "Khóa giữ nguyên trạng thái LOCKED",
  doorName: "Cửa chính",
  reason: "legacy stranger",
};

{
  const legacy = new DatabaseSync(DB_FILE);
  legacy.exec(LEGACY_SQLITE_ACCESS_LOGS);
  legacy.prepare(`INSERT INTO access_logs (id, timestamp, type, status, photoSnapshot, confidence, livenessScore, lockAction, doorName, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    LEGACY_ROW.id, LEGACY_ROW.timestamp, LEGACY_ROW.type, LEGACY_ROW.status, LEGACY_ROW.photoSnapshot,
    LEGACY_ROW.confidence, LEGACY_ROW.livenessScore, LEGACY_ROW.lockAction, LEGACY_ROW.doorName, LEGACY_ROW.reason,
  );
  legacy.close();
}

process.env.DATA_DIR = DATA_DIR;
delete process.env.DATABASE_URL;
const { db, normalizeAccessLogTrace } = await import("../src/server/db");
type AccessLogRecord = import("../src/server/db").AccessLogRecord;

const baseLog = (over: Partial<AccessLogRecord>): AccessLogRecord => ({
  id: "LOG-X",
  timestamp: "2026-09-26T03:00:05.000Z",
  type: "ENTRY",
  status: "GRANTED",
  employeeId: "EMP-1",
  employeeName: "Nguyễn Văn A",
  employeeCode: "NV001",
  department: "Kỹ thuật",
  photoSnapshot: "data:image/jpeg;base64,/9j/crop",
  confidence: 91.5,
  livenessScore: 98,
  lockAction: "Mở chốt tự động",
  doorName: "Cửa chính",
  reason: "test",
  ...over,
});

const columns = () => {
  const inspect = new DatabaseSync(DB_FILE);
  try {
    return (inspect.prepare("PRAGMA table_info(access_logs)").all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>);
  } finally {
    inspect.close();
  }
};

after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("normalizeAccessLogTrace", () => {
  it("keeps valid values and normalises capturedAt to UTC milliseconds", () => {
    const t = normalizeAccessLogTrace({ capturedAt: "2026-09-26T10:00:01+07:00", trackId: "entry-000017", recordingChannel: "2201" });
    assert.deepEqual(t, { capturedAt: "2026-09-26T03:00:01.000Z", trackId: "entry-000017", recordingChannel: "2201", rejected: [] });
    assert.equal(normalizeAccessLogTrace({ recordingChannel: 501 }).recordingChannel, "501");
  });

  it("treats absent, null and empty as absent (not rejected)", () => {
    for (const v of [undefined, null, ""]) {
      assert.deepEqual(normalizeAccessLogTrace({ capturedAt: v, trackId: v, recordingChannel: v }), { rejected: [] });
    }
  });

  it("drops over-long values instead of truncating them or failing the event", () => {
    const t = normalizeAccessLogTrace({ trackId: "t".repeat(65), recordingChannel: "1".repeat(17) });
    assert.equal(t.trackId, undefined);
    assert.equal(t.recordingChannel, undefined);
    assert.deepEqual(t.rejected, ["trackId", "recordingChannel"]);
    assert.equal(normalizeAccessLogTrace({ trackId: "t".repeat(64), recordingChannel: "1".repeat(16) }).rejected.length, 0);
  });

  it("rejects values that are not what they claim to be", () => {
    for (const capturedAt of ["yesterday", "2026-09-26", "2026-13-40T99:99:99Z", "1970-01-01T00:00:00Z", 1_758_855_605_000, "2026-09-26T03:00:05Z; DROP TABLE x"]) {
      assert.deepEqual(normalizeAccessLogTrace({ capturedAt }).rejected, ["capturedAt"], String(capturedAt));
    }
    for (const trackId of [" lead-space", "a b", "x\n", "<script>", "../etc", 42]) {
      assert.deepEqual(normalizeAccessLogTrace({ trackId }).rejected, ["trackId"], String(trackId));
    }
    for (const recordingChannel of ["5 01", "501?x=1", "../501", -1, 1.5, "ch/1"]) {
      assert.deepEqual(normalizeAccessLogTrace({ recordingChannel }).rejected, ["recordingChannel"], String(recordingChannel));
    }
  });
});

describe("SQLite: database from the previous release", () => {
  it("gains the three nullable columns on startup, no default, rows intact", () => {
    const cols = columns();
    for (const name of ["capturedAt", "trackId", "recordingChannel"]) {
      const c = cols.find((col) => col.name === name);
      assert.ok(c, `${name} added`);
      assert.equal(c.notnull, 0, `${name} nullable`);
      assert.equal(c.dflt_value, null, `${name} has no default`);
    }
    // every pre-existing column is still there, in place
    assert.deepEqual(cols.slice(0, 18).map((c) => c.name), [
      "id", "timestamp", "type", "status", "employeeId", "employeeName", "employeeCode", "department",
      "photoSnapshot", "confidence", "livenessScore", "lockAction", "doorName", "reason",
      "faceEmbedding", "faceEmbeddingDims", "faceEmbeddingModelTag", "faceEmbeddingQuality",
    ]);
  });

  it("reads the old row back unchanged, with the new fields undefined", async () => {
    const meta = await db.getAccessLogMetaById(LEGACY_ROW.id);
    assert.deepEqual(
      { ...meta },
      { id: LEGACY_ROW.id, timestamp: LEGACY_ROW.timestamp, type: "EXIT", status: "DENIED", capturedAt: undefined, trackId: undefined, recordingChannel: undefined, gateId: "exit" },
      "gateId is derived from type for a row written before gate ids (N-gate wave)",
    );
    const full = await db.getAccessLogById(LEGACY_ROW.id);
    assert.equal(full?.photoSnapshot, LEGACY_ROW.photoSnapshot, "image untouched");
    assert.equal(full?.reason, LEGACY_ROW.reason);
    assert.equal(full?.capturedAt, undefined);
    const page = await db.queryAccessLogs({}, null, 50);
    const listed = page.logs.find((l) => l.id === LEGACY_ROW.id);
    assert.ok(listed);
    assert.equal(listed.trackId, undefined);
    assert.equal(listed.photoSnapshot, "stored", "list pages still never carry image bytes");
    assert.equal(JSON.stringify(listed).includes("capturedAt"), false, "absent fields do not serialise as null");
  });
});

describe("SQLite: trace round trip", () => {
  before(async () => {
    assert.equal(await db.saveAccessLog(baseLog({
      id: "LOG-T1", capturedAt: "2026-09-26T03:00:01.250Z", trackId: "entry-000017", recordingChannel: "2201",
    })), true);
    assert.equal(await db.saveAccessLog(baseLog({
      id: "LOG-T2", timestamp: "2026-09-26T03:00:06.000Z", status: "DENIED", employeeId: undefined, employeeName: undefined,
      employeeCode: undefined, department: undefined, type: "EXIT",
      capturedAt: "2026-09-26T03:00:02.000Z", trackId: "exit-000003", recordingChannel: "501",
      faceEmbedding: [0.6, 0.8], faceEmbeddingModelTag: "arcface_test", faceEmbeddingQuality: 0.7,
    })), true);
  });

  it("getAccessLogMetaById returns the trace", async () => {
    assert.deepEqual({ ...(await db.getAccessLogMetaById("LOG-T1")) }, {
      id: "LOG-T1", timestamp: "2026-09-26T03:00:05.000Z", type: "ENTRY", status: "GRANTED",
      capturedAt: "2026-09-26T03:00:01.250Z", trackId: "entry-000017", recordingChannel: "2201", gateId: "entry",
    });
    assert.equal(await db.getAccessLogMetaById("LOG-NOPE"), undefined);
  });

  it("history pages, the legacy page and stranger candidates carry it", async () => {
    const q = await db.queryAccessLogs({ status: "GRANTED" }, null, 50);
    const t1 = q.logs.find((l) => l.id === "LOG-T1");
    assert.equal(t1?.capturedAt, "2026-09-26T03:00:01.250Z");
    assert.equal(t1?.trackId, "entry-000017");
    assert.equal(t1?.recordingChannel, "2201");

    const p = await db.getAccessLogsPage(1, 50);
    assert.equal(p.logs.find((l) => l.id === "LOG-T2")?.trackId, "exit-000003");

    const s = await db.getStrangerCandidateLogsPage(null, 50);
    const t2 = s.logs.find((l) => l.id === "LOG-T2");
    assert.equal(t2?.recordingChannel, "501");
    assert.equal(t2?.capturedAt, "2026-09-26T03:00:02.000Z");
    assert.equal(t2?.faceEmbedding?.length, 2, "embedding handling unchanged");
  });

  it("a replay with the same id is a no-op: the first trace wins", async () => {
    assert.equal(await db.saveAccessLog(baseLog({ id: "LOG-T1", trackId: "entry-999999", recordingChannel: "9" })), true);
    const meta = await db.getAccessLogMetaById("LOG-T1");
    assert.equal(meta?.trackId, "entry-000017");
    assert.equal(meta?.recordingChannel, "2201");
  });

  it("concurrent duplicate submissions store exactly one row", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      db.saveAccessLog(baseLog({ id: "LOG-DUP", trackId: `entry-${i}` }))));
    assert.deepEqual(results, Array(8).fill(true));
    const inspect = new DatabaseSync(DB_FILE);
    try {
      const rows = inspect.prepare("SELECT trackId FROM access_logs WHERE id = ?").all("LOG-DUP") as Array<{ trackId: string }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].trackId, "entry-0");
    } finally {
      inspect.close();
    }
  });

  it("an invalid trace value is dropped, the event itself is still stored", async () => {
    assert.equal(await db.saveAccessLog(baseLog({
      id: "LOG-BAD", trackId: "t".repeat(65), recordingChannel: "501?x", capturedAt: "not-a-time",
    })), true);
    const meta = await db.getAccessLogMetaById("LOG-BAD");
    assert.equal(meta?.status, "GRANTED");
    assert.equal(meta?.trackId, undefined);
    assert.equal(meta?.recordingChannel, undefined);
    assert.equal(meta?.capturedAt, undefined);
  });

  it("restarting on the migrated database is a no-op (idempotent migration)", () => {
    const r = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e",
      `const { db } = await import(${JSON.stringify(path.resolve("src/server/db.ts"))});
       const m = await db.getAccessLogMetaById("LOG-T1");
       process.stdout.write(JSON.stringify(m));`,
    ], { env: { ...process.env, DATA_DIR, DATABASE_URL: "" }, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout.trim().split("\n").pop() || "{}").trackId, "entry-000017");
    assert.equal(columns().filter((c) => c.name === "trackId").length, 1);
  });
});

describe("JSON fallback (SQLite unavailable)", () => {
  it("stores, reads back and pages the trace; older JSON rows read back without it", () => {
    const jsonDir = fs.mkdtempSync(path.join(os.tmpdir(), "dat-trace-json-"));
    try {
      // A JSON store written by the previous release: no trace fields at all.
      fs.writeFileSync(path.join(jsonDir, "smartface_data.json"), JSON.stringify({
        employees: [], access_logs: [{ ...LEGACY_ROW }], webhook_logs: [], mobile_notifications: [],
        door_api_logs: [], resolved_stranger_clusters: [], stranger_resolutions: [],
      }));
      const script = `
        const { db } = await import(${JSON.stringify(path.resolve("src/server/db.ts"))});
        const log = (over) => ({ id: "LOG-J1", timestamp: "2026-09-26T03:00:05.000Z", type: "EXIT", status: "DENIED",
          photoSnapshot: "data:image/jpeg;base64,/9j/crop", confidence: 20, lockAction: "x", doorName: "y", ...over });
        const saved = await db.saveAccessLog(log({ capturedAt: "2026-09-26T03:00:01.000Z", trackId: "exit-1", recordingChannel: "501" }));
        const replay = await db.saveAccessLog(log({ trackId: "exit-2" }));
        const bad = await db.saveAccessLog(log({ id: "LOG-J2", trackId: "x".repeat(65) }));
        const out = {
          mode: db.getStorageStatus().active, saved, replay, bad,
          meta: await db.getAccessLogMetaById("LOG-J1"),
          legacy: await db.getAccessLogMetaById(${JSON.stringify(LEGACY_ROW.id)}),
          bad2: await db.getAccessLogMetaById("LOG-J2"),
          query: (await db.queryAccessLogs({}, null, 10)).logs.find((l) => l.id === "LOG-J1"),
          page: (await db.getAccessLogsPage(1, 10)).logs.find((l) => l.id === "LOG-J1"),
        };
        process.stdout.write("RESULT " + JSON.stringify(out) + "\\n");`;
      const r = spawnSync(process.execPath, ["--no-experimental-sqlite", "--import", "tsx", "--input-type=module", "-e", script], {
        env: { ...process.env, DATA_DIR: jsonDir, DATABASE_URL: "" }, encoding: "utf8", timeout: 60_000,
      });
      assert.equal(r.status, 0, r.stderr);
      const line = r.stdout.split("\n").find((l) => l.startsWith("RESULT "));
      assert.ok(line, r.stdout);
      const out = JSON.parse(line.slice(7));
      assert.equal(out.mode, "json");
      assert.deepEqual([out.saved, out.replay, out.bad], [true, true, true]);
      assert.deepEqual(out.meta, {
        id: "LOG-J1", timestamp: "2026-09-26T03:00:05.000Z", type: "EXIT", status: "DENIED",
        capturedAt: "2026-09-26T03:00:01.000Z", trackId: "exit-1", recordingChannel: "501", gateId: "exit",
      });
      assert.deepEqual(out.legacy, { id: LEGACY_ROW.id, timestamp: LEGACY_ROW.timestamp, type: "EXIT", status: "DENIED", gateId: "exit" });
      assert.deepEqual(out.bad2, { id: "LOG-J2", timestamp: "2026-09-26T03:00:05.000Z", type: "EXIT", status: "DENIED", gateId: "exit" });
      assert.equal(out.query.trackId, "exit-1");
      assert.equal(out.query.photoSnapshot, "stored");
      assert.equal(out.page.recordingChannel, "501");
      const onDisk = JSON.parse(fs.readFileSync(path.join(jsonDir, "smartface_data.json"), "utf8"));
      const stored = onDisk.access_logs.find((l: any) => l.id === "LOG-J1");
      assert.equal(stored.trackId, "exit-1", "the first write wins on disk too");
      assert.equal(onDisk.access_logs.find((l: any) => l.id === "LOG-J2").trackId, undefined);
    } finally {
      fs.rmSync(jsonDir, { recursive: true, force: true });
    }
  });
});
