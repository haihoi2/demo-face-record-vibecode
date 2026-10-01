/**
 * N-gate persistence in the local stores (src/server/db.ts): access_logs.gateId
 * (stored when valid, derived for older rows, never backfilled), the gate
 * filter with keyset paging / counts / per-gate stats, stranger_faces.gateId,
 * per-door lock states with smart_lock_state as door "main", and shadow
 * results whose legacy ENTRY/EXIT spelling reads as the gate id. Native SQLite
 * and the JSON fallback run the shared scenarios (tests/fixtures/nGatesScenario.ts)
 * in child processes, since the storage module is a singleton bound to
 * DATA_DIR at import. PostgreSQL runs them in tests/integration/nGatesPersistence.test.ts.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  assertDoorLockReadBack,
  assertDoorLockScenario,
  assertGateLogReadBack,
  assertGateLogScenario,
  assertLegacyCheck,
  assertShadowGateScenario,
  DEFAULT_LOCK,
  LEGACY_SHADOW_ROWS,
  runNGatesChild,
} from "./fixtures/nGatesScenario";
import { shadow } from "./fixtures/accuracyScenario";

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

process.env.DATA_DIR = tmpDir("ng-db-pure-");
delete process.env.DATABASE_URL;
const { normalizeDoorLockState, normalizeShadowResult, normalizeStrangerFace, shadowGateId } = await import("../src/server/db");

const SHADOW_COLS = [
  "id", "gate", "trackId", "outcome", "employeeId", "fusedCosine", "margin", "runnerUpEmployeeId", "runnerUpCosine",
  "basis", "fusionBasis", "meanCheckRefused", "framesSeen", "framesUsed", "firstSeenAt", "firstUsableAt", "decidedAt",
  "legacyLogId", "legacyStatus", "legacyEmployeeId", "agreement", "createdAt",
];
/** A shadow result as the previous release stored it (gate = direction), one raw INSERT. */
function insertRawShadow(db: any, r: Record<string, any>) {
  const row = SHADOW_COLS.map((c) => (c === "meanCheckRefused" ? (r[c] == null ? null : r[c] ? 1 : 0) : r[c] ?? null));
  db.prepare(`INSERT INTO pipeline_shadow_results (${SHADOW_COLS.join(", ")}) VALUES (${SHADOW_COLS.map(() => "?").join(", ")})`).run(...row);
}

describe("pure helpers", () => {
  it("normalizeDoorLockState keeps known fields, refuses structural errors, cuts descriptive text", () => {
    const { state, error } = normalizeDoorLockState("side-door", { ...DEFAULT_LOCK, apiToken: "x", doorId: "other", doorName: "D".repeat(300), batteryLevel: NaN });
    assert.equal(error, undefined);
    assert.equal(state?.doorId, "side-door", "the key wins over a doorId in the body");
    assert.equal("apiToken" in (state as any), false);
    assert.equal(state?.doorName.length, 255);
    assert.equal(state?.batteryLevel, 0);
    for (const [doorId, body, field] of [
      ["Main", DEFAULT_LOCK, "doorId"], ["", DEFAULT_LOCK, "doorId"], ["1door", DEFAULT_LOCK, "doorId"],
      ["main", null, "not-an-object"], ["main", [DEFAULT_LOCK], "not-an-object"],
      ["main", { ...DEFAULT_LOCK, lockId: "a b" }, "lockId"], ["main", { ...DEFAULT_LOCK, state: "OPEN" }, "state"],
      ["main", { ...DEFAULT_LOCK, isLocked: 1 }, "isLocked"], ["main", { ...DEFAULT_LOCK, status: "online" }, "status"],
    ] as Array<[string, unknown, string]>) {
      assert.equal(normalizeDoorLockState(doorId, body).error, field, `${doorId} ${JSON.stringify(body)?.slice(0, 40)}`);
    }
  });
  it("shadowGateId maps exactly the two legacy spellings", () => {
    assert.deepEqual(["ENTRY", "EXIT", "entry", "exit", "side-door", "Entry", "SIDE"].map(shadowGateId),
      ["entry", "exit", "entry", "exit", "side-door", "Entry", "SIDE"]);
    assert.equal(normalizeShadowResult(shadow("SR-1", "EXIT", "2026-10-01T00:00:00.000Z")).row?.gate, "exit", "new rows are stored with the gate id");
  });
  it("normalizeStrangerFace stores a valid gateId and drops anything else (never fatal)", () => {
    const base = {
      id: "SF-1", logId: "LOG-1", faceIndex: 0, capturedAt: "2026-10-01T00:00:00.000Z", gate: "EXIT" as const, engine: "legacy" as const,
      box: [1, 2, 3, 4] as [number, number, number, number], detectorScore: 0.9, quality: 0.5, sizePx: 80, createdAt: "2026-10-01T00:00:00.000Z",
    };
    assert.equal(normalizeStrangerFace({ ...base, gateId: "side-door" } as any).row?.gateId, "side-door");
    for (const bad of [undefined, null, "", "Side", "x", "g".repeat(33), 7]) {
      const r = normalizeStrangerFace({ ...base, gateId: bad } as any);
      assert.equal(r.error, undefined);
      assert.equal(r.row?.gateId, null, String(bad));
    }
  });
});

describe("SQLite: gate ids, gate filter, per-door lock states, shadow gate normalisation", () => {
  const dataDir = tmpDir("ng-db-sqlite-");
  const file = path.join(dataDir, "smartface.db");

  it("runs the access-log and stranger-face scenario", async () => {
    const r = await runNGatesChild("runGateLogScenario", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.equal(r.out.mode, "sqlite");
    assertGateLogScenario(r.out, assert);
  });

  it("runs the shadow scenario over rows the previous release wrote", async () => {
    const seed = new DatabaseSync(file);
    try {
      for (const row of LEGACY_SHADOW_ROWS) insertRawShadow(seed, row);
    } finally {
      seed.close();
    }
    const r = await runNGatesChild("runShadowGateScenario", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assertShadowGateScenario(r.out, assert);
  });

  it("runs the door lock scenario", async () => {
    const r = await runNGatesChild("runDoorLockScenario", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assertDoorLockScenario(r.out, assert);
  });

  it("keeps everything across a restart", async () => {
    const g = await runNGatesChild("readBackGateLogScenario", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(g.code, 0, g.stderr.slice(-3000));
    assertGateLogReadBack(g.out, assert);
    const d = await runNGatesChild("readBackDoorLockScenario", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(d.code, 0, d.stderr.slice(-3000));
    assertDoorLockReadBack(d.out, assert);
  });

  it("stores ids as given, never backfills, and serves the gate filter from its index", () => {
    const inspect = new DatabaseSync(file);
    try {
      const gates = Object.fromEntries((inspect.prepare("SELECT id, gateId FROM access_logs WHERE id LIKE 'L-%'").all() as any[]).map((r) => [r.id, r.gateId]));
      assert.deepEqual(gates, {
        "L-01": null, "L-02": null, "L-03": "entry", "L-04": "exit", "L-05": "side-door", "L-06": null,
        "L-07": "loading-bay", "L-08": "side-door", "L-09": null, "L-10": null,
      }, "legacy and malformed rows stay NULL: readers derive, nobody rewrites history");
      const faces = Object.fromEntries((inspect.prepare("SELECT id, gateId FROM stranger_faces").all() as any[]).map((r) => [r.id, r.gateId]));
      assert.deepEqual(faces, { "SF-N1": "side-door", "SF-N2": null, "SF-N3": null, "SF-N4": null });
      const shadowGates = Object.fromEntries((inspect.prepare("SELECT id, gate FROM pipeline_shadow_results").all() as any[]).map((r) => [r.id, r.gate]));
      assert.deepEqual(shadowGates, { "SR-L1": "ENTRY", "SR-L2": "EXIT", "SR-N1": "entry", "SR-N2": "exit", "SR-N3": "side-door", "SR-N4": "entry" },
        "old shadow rows keep their spelling; a new row named by direction is stored with the id");

      const doors = (inspect.prepare("SELECT doorId, state FROM door_lock_states ORDER BY doorId").all() as any[]).map((r) => [r.doorId, JSON.parse(r.state)]);
      assert.deepEqual(doors.map(([id, s]) => [id, s.doorId, s.lastActionBy]), [["main", "main", "new-code"], ["side-door", "side-door", "op-final"]]);
      assert.ok(doors.every(([, s]) => !("apiToken" in s)));
      const legacy = inspect.prepare("SELECT lockId, state, isLocked, lastActionBy, lastActionAt FROM smart_lock_state").all() as any[];
      assert.deepEqual(legacy.map((r) => ({ ...r })), [{ lockId: "SL-HQ-01", state: "UNLOCKED", isLocked: 0, lastActionBy: "new-code", lastActionAt: "2026-10-01T03:31:00.000Z" }],
        "door main is the legacy row too (one row, same transaction)");

      const col = (table: string, name: string) => (inspect.prepare(`PRAGMA table_info(${table})`).all() as any[]).find((c) => c.name === name);
      for (const table of ["access_logs", "stranger_faces"]) {
        const c = col(table, "gateId");
        assert.deepEqual([c.type, c.notnull, c.dflt_value], ["TEXT", 0, null], `${table}.gateId nullable, no default`);
      }
      const plan = (sql: string, ...params: unknown[]) =>
        (inspect.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as any[]).map((p) => p.detail).join(" | ");
      const side = plan(`SELECT id FROM access_logs WHERE gateId = ? ORDER BY timestamp DESC, id DESC LIMIT 5`, "side-door");
      assert.match(side, /idx_access_logs_gate_ts/, side);
      assert.doesNotMatch(side, /TEMP B-TREE/, side);
      const entry = plan(`SELECT id FROM access_logs WHERE (gateId = ? OR (gateId IS NULL AND upper(type) <> 'EXIT')) ORDER BY timestamp DESC, id DESC LIMIT 5`, "entry");
      assert.match(entry, /idx_access_logs_(gate_ts|ts_id)/, entry);
    } finally {
      inspect.close();
    }
  });
});

describe("SQLite: database from the previous release", () => {
  /** The previous release's tables (no gateId anywhere, no door_lock_states), with data. */
  const LEGACY = `
    CREATE TABLE access_logs (
      id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, employeeId TEXT, employeeName TEXT,
      employeeCode TEXT, department TEXT, photoSnapshot TEXT, confidence REAL, livenessScore REAL, lockAction TEXT, doorName TEXT,
      reason TEXT, faceEmbedding BLOB, faceEmbeddingDims INTEGER, faceEmbeddingModelTag TEXT, faceEmbeddingQuality REAL,
      capturedAt TEXT, trackId TEXT, recordingChannel TEXT);
    CREATE INDEX idx_access_logs_ts_id ON access_logs (timestamp DESC, id DESC);
    CREATE TABLE smart_lock_state (lockId TEXT PRIMARY KEY, doorName TEXT, state TEXT, isLocked INTEGER, batteryLevel INTEGER,
      signalDbm INTEGER, firmwareVersion TEXT, lastActionAt TEXT, lastActionBy TEXT, autoRelockSeconds INTEGER, status TEXT);
    CREATE TABLE stranger_faces (
      id TEXT PRIMARY KEY, logId TEXT NOT NULL, faceIndex INTEGER NOT NULL, capturedAt TEXT NOT NULL, gate TEXT NOT NULL,
      streamId TEXT, engine TEXT NOT NULL, trackId TEXT, box TEXT NOT NULL, sourceWidth INTEGER, sourceHeight INTEGER,
      detectorScore REAL NOT NULL, quality REAL NOT NULL, edgeEnergy REAL, sizePx INTEGER NOT NULL, embedding BLOB, dims INTEGER,
      modelTag TEXT, crop BLOB, createdAt TEXT NOT NULL, purgedAt TEXT, employeeId TEXT, matchCosine REAL, matchMargin REAL);
    CREATE TABLE pipeline_shadow_results (
      id TEXT PRIMARY KEY, gate TEXT NOT NULL, trackId TEXT NOT NULL, outcome TEXT NOT NULL, employeeId TEXT, fusedCosine REAL,
      margin REAL, runnerUpEmployeeId TEXT, runnerUpCosine REAL, basis TEXT NOT NULL, fusionBasis TEXT, meanCheckRefused INTEGER,
      framesSeen INTEGER NOT NULL, framesUsed INTEGER NOT NULL, firstSeenAt TEXT NOT NULL, firstUsableAt TEXT, decidedAt TEXT NOT NULL,
      legacyLogId TEXT, legacyStatus TEXT, legacyEmployeeId TEXT, agreement TEXT NOT NULL, createdAt TEXT NOT NULL);
    INSERT INTO access_logs (id, timestamp, type, status, photoSnapshot, confidence, lockAction, doorName)
      VALUES ('OLD-1', '2026-09-30T01:00:00.000Z', 'ENTRY', 'GRANTED', '', 90, 'x', 'y'),
             ('OLD-2', '2026-09-30T02:00:00.000Z', 'EXIT', 'DENIED', 'data:image/jpeg;base64,x', 10, 'x', 'y');
    INSERT INTO smart_lock_state VALUES ('SL-HQ-01', 'Cửa chính', 'LOCKED', 1, 96, -54, 'v2', '2026-09-30T03:00:00.000Z', 'before-upgrade', 6, 'ONLINE');
    INSERT INTO stranger_faces (id, logId, faceIndex, capturedAt, gate, engine, box, detectorScore, quality, sizePx, createdAt)
      VALUES ('SF-OLD-1', 'OLD-2', 0, '2026-09-30T02:00:00.000Z', 'EXIT', 'legacy', '[1,2,3,4]', 0.9, 0.5, 80, '2026-09-30T02:00:00.000Z');`;
  /** The previous release's statements: they never name gateId or door_lock_states. */
  const OLD_LOG_INSERT = `INSERT OR IGNORE INTO access_logs (id, timestamp, type, status, employeeId, employeeName, employeeCode,
      department, photoSnapshot, confidence, livenessScore, lockAction, doorName, reason, faceEmbedding, faceEmbeddingDims,
      faceEmbeddingModelTag, faceEmbeddingQuality, capturedAt, trackId, recordingChannel)
    VALUES ('OLD-3', '2026-09-30T04:00:00.000Z', 'ENTRY', 'GRANTED', NULL, NULL, NULL, NULL, '', 90, NULL, 'x', 'y', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`;
  const OLD_LOCK_UPSERT = `INSERT INTO smart_lock_state (lockId, doorName, state, isLocked, batteryLevel, signalDbm, firmwareVersion,
      lastActionAt, lastActionBy, autoRelockSeconds, status) VALUES ('SL-HQ-01', 'Cửa chính', 'LOCKED', 1, 96, -54, 'v2', ?, ?, 6, 'ONLINE')
    ON CONFLICT(lockId) DO UPDATE SET state = excluded.state, isLocked = excluded.isLocked, lastActionAt = excluded.lastActionAt, lastActionBy = excluded.lastActionBy`;

  it("adds the nullable columns, the index and door_lock_states; old rows read derived ids and stay NULL; old code still works", async () => {
    const dataDir = tmpDir("ng-db-legacy-");
    const file = path.join(dataDir, "smartface.db");
    const legacy = new DatabaseSync(file);
    legacy.exec(LEGACY);
    insertRawShadow(legacy, shadow("SR-OLD-1", "EXIT", "2026-09-30T02:00:00.000Z"));
    legacy.close();

    const r = await runNGatesChild("legacyCheck", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.doesNotMatch(r.stderr, /Lỗi khởi tạo|Lỗi nạp/);
    assert.equal(r.out.mode, "sqlite");
    assertLegacyCheck(r.out, assert);

    const inspect = new DatabaseSync(file);
    try {
      assert.deepEqual((inspect.prepare("SELECT id, gateId FROM access_logs ORDER BY id").all() as any[]).map((x) => ({ ...x })),
        [{ id: "OLD-1", gateId: null }, { id: "OLD-2", gateId: null }], "no backfill write");
      assert.equal((inspect.prepare("SELECT gateId FROM stranger_faces").get() as any).gateId, null);
      assert.equal((inspect.prepare("SELECT gate FROM pipeline_shadow_results").get() as any).gate, "EXIT", "old shadow rows are not rewritten");
      const idx = (inspect.prepare("PRAGMA index_list(access_logs)").all() as any[]).map((i) => i.name).filter((n) => n.startsWith("idx_")).sort();
      assert.deepEqual(idx, ["idx_access_logs_gate_ts", "idx_access_logs_ts_id"]);
      assert.equal((inspect.prepare("SELECT count(*) AS n FROM door_lock_states").get() as any).n, 0, "door main stays in smart_lock_state until it is saved");
      // Rollback to the previous image: its statements never name the new column or table.
      inspect.prepare(OLD_LOG_INSERT).run();
      inspect.prepare(OLD_LOCK_UPSERT).run("2026-09-30T05:00:00.000Z", "old-code-after-rollback");
    } finally {
      inspect.close();
    }
    const again = await runNGatesChild("legacyCheck", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(again.code, 0, again.stderr.slice(-3000));
    assertLegacyCheck(again.out, assert, ["OLD-3:entry"], "old-code-after-rollback");
  });

  it("a door main row older than a later legacy write loses to it (roll back, then forward again)", async () => {
    const dataDir = tmpDir("ng-db-rollforward-");
    const file = path.join(dataDir, "smartface.db");
    const first = await runNGatesChild("runDoorLockScenario", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(first.code, 0, first.stderr.slice(-3000));
    // The previous release runs for a while and locks the door: it only knows smart_lock_state.
    const old = new DatabaseSync(file);
    try {
      old.prepare(OLD_LOCK_UPSERT).run("2026-10-01T05:00:00.000Z", "old-code-after-rollback");
    } finally {
      old.close();
    }
    const r = await runNGatesChild("readBackDoorLockScenario", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.deepEqual(r.out.list, [
      { doorId: "main", state: "LOCKED", by: "old-code-after-rollback" },
      { doorId: "side-door", state: "LOCKED", by: "op-final" },
    ]);
  });
});

describe("JSON fallback (SQLite unavailable)", () => {
  const dataDir = tmpDir("ng-db-json-");
  const jsonFile = path.join(dataDir, "smartface_data.json");
  const NO_SQLITE = ["--no-experimental-sqlite"];
  const EMPTY = { employees: [], webhook_logs: [], mobile_notifications: [], door_api_logs: [], resolved_stranger_clusters: [], stranger_resolutions: [] };

  it("reads a JSON store from the previous release (no gate ids, no door_lock_states)", async () => {
    fs.writeFileSync(jsonFile, JSON.stringify({
      ...EMPTY,
      access_logs: [
        { id: "OLD-2", timestamp: "2026-09-30T02:00:00.000Z", type: "EXIT", status: "DENIED", photoSnapshot: "data:image/jpeg;base64,x", confidence: 10, lockAction: "x", doorName: "y" },
        { id: "OLD-1", timestamp: "2026-09-30T01:00:00.000Z", type: "ENTRY", status: "GRANTED", photoSnapshot: "", confidence: 90, lockAction: "x", doorName: "y" },
      ],
      smart_lock_state: { ...DEFAULT_LOCK, lastActionAt: "2026-09-30T03:00:00.000Z", lastActionBy: "before-upgrade" },
      stranger_faces: [{
        id: "SF-OLD-1", logId: "OLD-2", faceIndex: 0, capturedAt: "2026-09-30T02:00:00.000Z", gate: "EXIT", engine: "legacy",
        box: [1, 2, 3, 4], detectorScore: 0.9, quality: 0.5, sizePx: 80, createdAt: "2026-09-30T02:00:00.000Z",
      }],
      pipeline_shadow_results: [shadow("SR-OLD-1", "EXIT", "2026-09-30T02:00:00.000Z")],
    }));
    const before = fs.readFileSync(jsonFile, "utf8");
    const r = await runNGatesChild("legacyCheck", { DATA_DIR: dataDir, DATABASE_URL: "" }, NO_SQLITE);
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.equal(r.out.mode, "json");
    assertLegacyCheck(r.out, assert);
    assert.equal(fs.readFileSync(jsonFile, "utf8"), before, "reading never rewrites the store (no backfill)");
    // Start the scenarios from a store holding only the previous release's shadow rows.
    fs.writeFileSync(jsonFile, JSON.stringify({ ...EMPTY, access_logs: [], pipeline_shadow_results: LEGACY_SHADOW_ROWS }));
  });

  it("runs the access-log, shadow and door lock scenarios", async () => {
    const g = await runNGatesChild("runGateLogScenario", { DATA_DIR: dataDir, DATABASE_URL: "" }, NO_SQLITE);
    assert.equal(g.code, 0, g.stderr.slice(-3000));
    assert.equal(g.out.mode, "json");
    assertGateLogScenario(g.out, assert);
    const s = await runNGatesChild("runShadowGateScenario", { DATA_DIR: dataDir, DATABASE_URL: "" }, NO_SQLITE);
    assert.equal(s.code, 0, s.stderr.slice(-3000));
    assertShadowGateScenario(s.out, assert);
    const d = await runNGatesChild("runDoorLockScenario", { DATA_DIR: dataDir, DATABASE_URL: "" }, NO_SQLITE);
    assert.equal(d.code, 0, d.stderr.slice(-3000));
    assertDoorLockScenario(d.out, assert);
  });

  it("keeps everything across a restart; stored values are exactly what was written", async () => {
    const g = await runNGatesChild("readBackGateLogScenario", { DATA_DIR: dataDir, DATABASE_URL: "" }, NO_SQLITE);
    assert.equal(g.code, 0, g.stderr.slice(-3000));
    assertGateLogReadBack(g.out, assert);
    const d = await runNGatesChild("readBackDoorLockScenario", { DATA_DIR: dataDir, DATABASE_URL: "" }, NO_SQLITE);
    assert.equal(d.code, 0, d.stderr.slice(-3000));
    assertDoorLockReadBack(d.out, assert);

    const onDisk = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
    const logs = Object.fromEntries(onDisk.access_logs.map((l: any) => [l.id, "gateId" in l ? l.gateId : "(absent)"]));
    assert.deepEqual(logs, {
      "L-01": "(absent)", "L-02": "(absent)", "L-03": "entry", "L-04": "exit", "L-05": "side-door", "L-06": "(absent)",
      "L-07": "loading-bay", "L-08": "side-door", "L-09": "(absent)", "L-10": "(absent)",
    }, "no derived value is ever written");
    const faces = Object.fromEntries(onDisk.stranger_faces.map((f: any) => [f.id, "gateId" in f ? f.gateId : "(absent)"]));
    assert.deepEqual(faces, { "SF-N1": "side-door", "SF-N2": "(absent)", "SF-N3": "(absent)", "SF-N4": "(absent)" });
    const shadowGates = Object.fromEntries(onDisk.pipeline_shadow_results.map((r: any) => [r.id, r.gate]));
    assert.deepEqual(shadowGates, { "SR-L1": "ENTRY", "SR-L2": "EXIT", "SR-N1": "entry", "SR-N2": "exit", "SR-N3": "side-door", "SR-N4": "entry" });
    assert.deepEqual(Object.keys(onDisk.door_lock_states).sort(), ["main", "side-door"]);
    assert.equal(onDisk.smart_lock_state.lastActionBy, "new-code");
    assert.equal("doorId" in onDisk.smart_lock_state, false, "the legacy key keeps the previous release's shape");
    assert.equal(JSON.stringify(onDisk).includes("must-not-be-stored"), false);
  });

  it("an event added to the hydrated list before it is saved is still written (the list is the caller's copy)", () => {
    const dir = tmpDir("ng-db-json-hydrate-");
    fs.writeFileSync(path.join(dir, "smartface_data.json"), JSON.stringify({
      ...EMPTY, access_logs: [{ id: "OLD-1", timestamp: "2026-09-30T01:00:00.000Z", type: "ENTRY", status: "GRANTED", photoSnapshot: "", confidence: 90, lockAction: "x", doorName: "y" }],
    }));
    const script = `
      const { db } = await import(${JSON.stringify(path.resolve("src/server/db.ts"))});
      const list = db.getAccessLogs([]);
      const log = { id: "NEW-1", timestamp: "2026-10-01T00:00:00.000Z", type: "EXIT", status: "DENIED", photoSnapshot: "", confidence: 1, lockAction: "x", doorName: "y", gateId: "exit" };
      list.unshift(log); // what server.ts does before saveAccessLog
      const saved = await db.saveAccessLog(log);
      process.stdout.write("RESULT " + JSON.stringify({ saved, first: list[1].gateId }) + "\\n");`;
    const r = spawnSync(process.execPath, ["--no-experimental-sqlite", "--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, DATA_DIR: dir, DATABASE_URL: "" }, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.split("\n").find((l) => l.startsWith("RESULT "))!.slice(7));
    assert.deepEqual(out, { saved: true, first: "entry" });
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "smartface_data.json"), "utf8"));
    assert.deepEqual(onDisk.access_logs.map((l: any) => [l.id, l.gateId ?? null]), [["NEW-1", "exit"], ["OLD-1", null]]);
  });
});
