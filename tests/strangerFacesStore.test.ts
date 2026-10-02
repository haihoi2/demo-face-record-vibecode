/**
 * Per-face stranger records in the local stores (src/server/db.ts):
 * stranger_faces (StrangerFaceStore), faceIds on adjudications, retired
 * observation ids and the candidate-log exclusion. Native SQLite and the JSON
 * fallback run the same scenario (tests/fixtures/strangerFacesScenario.ts) in
 * child processes, since the storage module is a singleton bound to DATA_DIR
 * at import. PostgreSQL runs it in tests/integration/strangerFacesPersistence.test.ts.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  assertStrangerFaceReadBack,
  assertStrangerFaceScenario,
  face,
  runScenarioChild,
} from "./fixtures/strangerFacesScenario";

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

// Pure helpers. Importing db.ts opens a store, so point it at scratch first.
process.env.DATA_DIR = tmpDir("pf-db-pure-");
delete process.env.DATABASE_URL;
const { sameResolutionIntent, normalizeStrangerFace, STRANGER_FACE_MAX_CROP_BYTES } = await import("../src/server/db");
type StrangerResolutionRecord = import("../src/server/db").StrangerResolutionRecord;

describe("sameResolutionIntent compares faceIds like logIds", () => {
  const base: StrangerResolutionRecord = {
    id: "RES-1", clusterId: "SC-1", action: "DISMISS", actor: "op", resolvedAt: "2026-09-29T00:00:00.000Z",
    logIds: ["LOG-2", "LOG-1"], faceIds: ["SF-2", "SF-1"], metadata: { intent: { a: 1 } },
  };
  it("same members in any order is the same intent", () => {
    assert.equal(sameResolutionIntent(base, { ...base, id: "RES-2", faceIds: ["SF-1", "SF-2"], logIds: ["LOG-1", "LOG-2"] }), true);
  });
  it("other, fewer or more faces is another intent", () => {
    assert.equal(sameResolutionIntent(base, { ...base, faceIds: ["SF-1"] }), false);
    assert.equal(sameResolutionIntent(base, { ...base, faceIds: ["SF-1", "SF-2", "SF-3"] }), false);
    assert.equal(sameResolutionIntent(base, { ...base, faceIds: ["SF-1", "SF-9"] }), false);
  });
  it("missing faceIds equals [] (rows older than the column)", () => {
    const legacy = { ...base, faceIds: undefined };
    assert.equal(sameResolutionIntent(legacy, { ...base, faceIds: [] }), true);
    assert.equal(sameResolutionIntent(legacy, { ...base }), false);
  });
  it("logIds are still compared", () => {
    assert.equal(sameResolutionIntent(base, { ...base, logIds: ["LOG-1"] }), false);
  });
});

describe("normalizeStrangerFace (limits of the PostgreSQL columns, enforced for every store)", () => {
  const ok = face("SF-1", "LOG-1", 0, "2026-09-29T08:00:00+07:00");
  it("accepts a well-formed face and normalises capturedAt to UTC milliseconds", () => {
    const { row, error } = normalizeStrangerFace(ok);
    assert.equal(error, undefined);
    assert.equal(row?.capturedAt, "2026-09-29T01:00:00.000Z");
    assert.equal(row?.dims, 4);
    assert.equal(row?.embedding?.length, 16, "float32 little-endian");
  });
  it("refuses faces that cannot be paged, grouped or audited", () => {
    const bad: Array<[string, Partial<typeof ok>]> = [
      ["id", { id: "SF-" + "x".repeat(62) }],
      ["id", { id: "bad id" }],
      ["logId", { logId: "L".repeat(65) }],
      ["logId", { logId: "" }],
      ["faceIndex", { faceIndex: -1 }],
      ["faceIndex", { faceIndex: 1.5 }],
      ["capturedAt", { capturedAt: "1970-01-01T00:00:00Z" }],
      ["gate", { gate: "entry" as any }],
      ["engine", { engine: "gemini" as any }],
      ["box", { box: [1, 2, 3, Infinity] }],
      ["scores", { detectorScore: NaN }],
      ["scores", { sizePx: -1 }],
      ["scores", { sizePx: 3e9 }],
      ["scores", { quality: 1e300 }],
      ["embedding", { embedding: [1e39, 0] }],
      ["embedding", { embedding: new Array(4097).fill(0) }],
      ["modelTag", { modelTag: "tag with space" }],
      ["crop", { crop: "base64" as any }],
      ["crop", { crop: Buffer.alloc(STRANGER_FACE_MAX_CROP_BYTES + 1) }],
    ];
    for (const [field, over] of bad) {
      assert.equal(normalizeStrangerFace({ ...ok, ...over }).error, field, JSON.stringify(over).slice(0, 80));
    }
  });
  it("drops malformed descriptive fields instead of failing or truncating", () => {
    const { row } = normalizeStrangerFace({ ...ok, trackId: "t".repeat(65), streamId: "a b", sourceWidth: -5, edgeEnergy: NaN });
    assert.equal(row?.trackId, null);
    assert.equal(row?.streamId, null);
    assert.equal(row?.sourceWidth, null);
    assert.equal(row?.edgeEnergy, null);
  });
  it("never takes purgedAt from the writer", () => {
    const { row } = normalizeStrangerFace({ ...ok, purgedAt: "2026-09-29T00:00:00.000Z" });
    assert.equal((row as any)?.purgedAt, undefined);
  });
});

describe("SQLite: per-face stranger store", () => {
  const dataDir = tmpDir("pf-db-sqlite-");
  let first: any;

  it("runs the shared scenario", async () => {
    const r = await runScenarioChild("runStrangerFaceScenario", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.equal(r.out.mode, "sqlite");
    assertStrangerFaceScenario(r.out, assert);
    first = r.out;
  });

  it("keeps faces, purges and faceIds across a restart", async () => {
    const r = await runScenarioChild("readBackStrangerFaceScenario", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assertStrangerFaceReadBack(r.out, first, assert);
  });

  it("stores the schema the plan describes; purged rows keep no biometric bytes", () => {
    const inspect = new DatabaseSync(path.join(dataDir, "smartface.db"));
    try {
      const cols = (inspect.prepare("PRAGMA table_info(stranger_faces)").all() as Array<{ name: string }>).map((c) => c.name);
      assert.deepEqual(cols, [
        "id", "logId", "faceIndex", "capturedAt", "gate", "streamId", "engine", "trackId", "box",
        "sourceWidth", "sourceHeight", "detectorScore", "quality", "edgeEnergy", "sizePx", "embedding", "dims", "modelTag",
        "crop", "createdAt", "purgedAt", "employeeId", "matchCosine", "matchMargin", "gateId", "featureNorm",
      ]);
      const idx = (inspect.prepare("PRAGMA index_list(stranger_faces)").all() as Array<{ name: string; unique: number; partial: number }>)
        .filter((i) => i.name.startsWith("idx_")).map((i) => ({ name: i.name, unique: i.unique, partial: i.partial }))
        .sort((a, b) => a.name.localeCompare(b.name));
      assert.deepEqual(idx, [
        { name: "idx_stranger_faces_captured", unique: 0, partial: 1 },
        { name: "idx_stranger_faces_log", unique: 1, partial: 0 },
        { name: "idx_stranger_faces_recognised", unique: 0, partial: 1 },
      ]);
      const purged = inspect.prepare("SELECT crop, embedding, purgedAt FROM stranger_faces WHERE purgedAt IS NOT NULL").all() as any[];
      assert.equal(purged.length, 2);
      for (const row of purged) {
        assert.equal(row.crop, null);
        assert.equal(row.embedding, null);
      }
      const box = inspect.prepare("SELECT box FROM stranger_faces WHERE id = 'SF-A0'").get() as any;
      assert.equal(box.box, "[100,50,220,190]", "box stored as JSON text");
      const plan = (inspect.prepare(`EXPLAIN QUERY PLAN SELECT id FROM stranger_faces WHERE purgedAt IS NULL
        AND (capturedAt < ? OR (capturedAt = ? AND id < ?)) ORDER BY capturedAt DESC, id DESC LIMIT 5`).all("z", "z", "z") as any[])
        .map((p) => p.detail).join(" | ");
      assert.match(plan, /idx_stranger_faces_captured/, plan);
      const antiJoin = (inspect.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM access_logs
        WHERE NOT EXISTS (SELECT 1 FROM stranger_faces sf WHERE sf.logId = access_logs.id)`).all() as any[])
        .map((p) => p.detail).join(" | ");
      assert.match(antiJoin, /idx_stranger_faces_log/, antiJoin);
    } finally {
      inspect.close();
    }
  });

  it("clearing the access history removes the faces of those events", async () => {
    const r = await runScenarioChild("clearAndCount", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.deepEqual(r.out, { left: 0 });
    const inspect = new DatabaseSync(path.join(dataDir, "smartface.db"));
    try {
      assert.equal((inspect.prepare("SELECT count(*) AS n FROM stranger_faces").get() as any).n, 0);
      assert.equal((inspect.prepare("SELECT count(*) AS n FROM stranger_resolution_events").get() as any).n > 0, true,
        "adjudication history is not touched");
    } finally {
      inspect.close();
    }
  });
});

describe("PostgreSQL configured but still connecting", () => {
  it("refuses face writes instead of parking biometric data in the local store", async () => {
    const dataDir = tmpDir("pf-db-connecting-");
    // Port 1 on loopback: the connection is refused and the startup retries keep it "connecting".
    const r = await runScenarioChild("whileConnecting", { DATA_DIR: dataDir, DATABASE_URL: "postgresql://nobody:none@127.0.0.1:1/none" });
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.deepEqual(r.out, { mode: "connecting", logSaved: true, faceSaved: false, page: 0, crop: null, purged: 0 });
    const inspect = new DatabaseSync(path.join(dataDir, "smartface.db"));
    try {
      assert.equal((inspect.prepare("SELECT count(*) AS n FROM stranger_faces").get() as any).n, 0);
    } finally {
      inspect.close();
    }
  });
});

describe("SQLite: database from the previous release", () => {
  /** stranger_resolutions / _events exactly as the release before this change creates them. */
  const LEGACY = `
    CREATE TABLE stranger_resolutions (id TEXT PRIMARY KEY, clusterId TEXT UNIQUE NOT NULL, action TEXT NOT NULL,
      employeeId TEXT, actor TEXT NOT NULL, resolvedAt TEXT NOT NULL, logIds TEXT NOT NULL, sourceLogId TEXT,
      metadata TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE stranger_resolution_events (id TEXT PRIMARY KEY, clusterId TEXT NOT NULL, action TEXT NOT NULL,
      employeeId TEXT, actor TEXT NOT NULL, resolvedAt TEXT NOT NULL, logIds TEXT NOT NULL, sourceLogId TEXT,
      metadata TEXT NOT NULL DEFAULT '{}');`;
  const OLD_INSERT = (table: string) => `INSERT INTO ${table} (id, clusterId, action, actor, resolvedAt, logIds, metadata)
    VALUES (?, ?, 'DISMISS', 'op', '2026-09-20T00:00:00.000Z', '["LOG-OLD-1"]', '{}')`;

  it("adds faceIds (NOT NULL DEFAULT '[]'), old rows read [], old code still writes", async () => {
    const dataDir = tmpDir("pf-db-legacy-");
    const file = path.join(dataDir, "smartface.db");
    const legacy = new DatabaseSync(file);
    legacy.exec(LEGACY);
    legacy.prepare(OLD_INSERT("stranger_resolutions")).run("RES-OLD-1", "SC-OLD-1");
    legacy.prepare(OLD_INSERT("stranger_resolution_events")).run("RES-OLD-1", "SC-OLD-1");
    legacy.close();

    const r = await runScenarioChild("resolutionsOnly", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.deepEqual(r.out.resolutions.map((x: any) => [x.id, x.logIds, x.faceIds]), [["RES-OLD-1", ["LOG-OLD-1"], []]]);
    assert.deepEqual(r.out.events.map((x: any) => x.faceIds), [[]]);
    assert.deepEqual(r.out.retired, ["log:LOG-OLD-1"]);

    const inspect = new DatabaseSync(file);
    try {
      for (const table of ["stranger_resolutions", "stranger_resolution_events"]) {
        const col = (inspect.prepare(`PRAGMA table_info(${table})`).all() as any[]).find((c) => c.name === "faceIds");
        assert.ok(col, `${table}.faceIds added`);
        assert.equal(col.notnull, 1);
        assert.equal(col.dflt_value, "'[]'");
      }
      // Rollback to the previous image: its INSERT does not name faceIds and still works.
      inspect.prepare(OLD_INSERT("stranger_resolutions")).run("RES-OLD-2", "SC-OLD-2");
      assert.equal((inspect.prepare("SELECT faceIds FROM stranger_resolutions WHERE id = 'RES-OLD-2'").get() as any).faceIds, "[]");
    } finally {
      inspect.close();
    }
    // Restart is a no-op for the migration.
    const again = await runScenarioChild("resolutionsOnly", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(again.code, 0, again.stderr.slice(-3000));
    assert.deepEqual(again.out.retired, ["log:LOG-OLD-1", "log:LOG-OLD-1"]);
  });
});

describe("JSON fallback (SQLite unavailable): per-face stranger store", () => {
  const dataDir = tmpDir("pf-db-json-");
  const NO_SQLITE = ["--no-experimental-sqlite"];
  let first: any;

  it("reads a JSON store from the previous release (no stranger_faces, no faceIds)", async () => {
    fs.writeFileSync(path.join(dataDir, "smartface_data.json"), JSON.stringify({
      employees: [], access_logs: [], webhook_logs: [], mobile_notifications: [], door_api_logs: [],
      resolved_stranger_clusters: ["SC-OLD-1"],
      stranger_resolutions: [{ id: "RES-OLD-1", clusterId: "SC-OLD-1", action: "DISMISS", actor: "op", resolvedAt: "2026-09-20T00:00:00.000Z", logIds: ["LOG-OLD-1"], metadata: {} }],
      stranger_resolution_events: [{ id: "RES-OLD-1", clusterId: "SC-OLD-1", action: "DISMISS", actor: "op", resolvedAt: "2026-09-20T00:00:00.000Z", logIds: ["LOG-OLD-1"], metadata: {} }],
    }));
    const r = await runScenarioChild("resolutionsOnly", { DATA_DIR: dataDir, DATABASE_URL: "" }, NO_SQLITE);
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.equal(r.out.mode, "json");
    assert.deepEqual(r.out.resolutions.map((x: any) => [x.id, x.faceIds]), [["RES-OLD-1", []]]);
    assert.deepEqual(r.out.events.map((x: any) => x.faceIds), [[]]);
    // Start the shared scenario from an empty store.
    fs.rmSync(path.join(dataDir, "smartface_data.json"));
  });

  it("runs the shared scenario", async () => {
    const r = await runScenarioChild("runStrangerFaceScenario", { DATA_DIR: dataDir, DATABASE_URL: "" }, NO_SQLITE);
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.equal(r.out.mode, "json");
    assertStrangerFaceScenario(r.out, assert);
    first = r.out;
  });

  it("keeps faces, purges and faceIds across a restart; crops are base64 on disk, purged ones gone", async () => {
    const r = await runScenarioChild("readBackStrangerFaceScenario", { DATA_DIR: dataDir, DATABASE_URL: "" }, NO_SQLITE);
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assertStrangerFaceReadBack(r.out, first, assert);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, "smartface_data.json"), "utf8"));
    const a0 = onDisk.stranger_faces.find((f: any) => f.id === "SF-A0");
    assert.equal(typeof a0.crop, "string");
    const old1 = onDisk.stranger_faces.find((f: any) => f.id === "SF-OLD-1");
    assert.equal("crop" in old1, false);
    assert.equal("embedding" in old1, false);
    assert.equal(typeof old1.purgedAt, "string");
    assert.deepEqual(onDisk.stranger_resolutions.find((x: any) => x.clusterId === "SC-face-1").faceIds, ["SF-A0"]);
  });

  it("clearing the access history removes the faces of those events", async () => {
    const r = await runScenarioChild("clearAndCount", { DATA_DIR: dataDir, DATABASE_URL: "" }, NO_SQLITE);
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.deepEqual(r.out, { left: 0 });
  });
});
