/**
 * Accuracy-wave persistence in the local stores (src/server/db.ts):
 * pipeline_shadow_results (ShadowResultStore), recognised-face observations on
 * stranger_faces (excluded from grouping, getRecognisedFaceObservations),
 * "adaptation" templates and the per-camera template count. Native SQLite and
 * the JSON fallback run the same scenarios (tests/fixtures/accuracyScenario.ts)
 * in child processes, since the storage module is a singleton bound to
 * DATA_DIR at import. PostgreSQL runs them in
 * tests/integration/accuracyPersistence.test.ts.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  assertObservationReadBack,
  assertObservationScenario,
  assertShadowReadBack,
  assertShadowScenario,
  runAccuracyChild,
  shadow,
} from "./fixtures/accuracyScenario";

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
process.env.DATA_DIR = tmpDir("acc-db-pure-");
delete process.env.DATABASE_URL;
const { normalizeShadowResult, normalizeStrangerFace, medianMs } = await import("../src/server/db");

const SHADOW_COLUMNS = [
  "id", "gate", "trackId", "outcome", "employeeId", "fusedCosine", "margin", "runnerUpEmployeeId", "runnerUpCosine",
  "basis", "fusionBasis", "meanCheckRefused", "framesSeen", "framesUsed", "firstSeenAt", "firstUsableAt", "decidedAt",
  "legacyLogId", "legacyStatus", "legacyEmployeeId", "agreement", "createdAt",
];
const FACE_COLUMNS = [
  "id", "logId", "faceIndex", "capturedAt", "gate", "streamId", "engine", "trackId", "box",
  "sourceWidth", "sourceHeight", "detectorScore", "quality", "edgeEnergy", "sizePx", "embedding", "dims", "modelTag",
  "crop", "createdAt", "purgedAt", "employeeId", "matchCosine", "matchMargin",
];

describe("medianMs", () => {
  it("is the middle value, or the mean of the two middle values, rounded; null for nothing", () => {
    assert.equal(medianMs([]), null);
    assert.equal(medianMs([NaN, Infinity]), null);
    assert.equal(medianMs([700]), 700);
    assert.equal(medianMs([3000, 1000, 2000]), 2000);
    assert.equal(medianMs([8000, 1000, 3000, 2000]), 2500);
    assert.equal(medianMs([1, 2]), 2, "1.5 rounds to 2");
  });
});

describe("normalizeShadowResult (limits of the PostgreSQL columns, enforced for every store)", () => {
  const ok = shadow("SR-1", "EXIT", "2026-09-29T08:00:10+07:00", { firstUsableAt: "2026-09-29T08:00:09+07:00" });
  it("accepts a well-formed result and normalises its times to UTC milliseconds", () => {
    const { row, error } = normalizeShadowResult(ok);
    assert.equal(error, undefined);
    assert.equal(row?.decidedAt, "2026-09-29T01:00:10.000Z");
    assert.equal(row?.firstUsableAt, "2026-09-29T01:00:09.000Z");
    assert.equal(row?.meanCheckRefused, null, "not given -> NULL");
  });
  it("refuses results that could not be paged, filtered or summarised", () => {
    const bad: Array<[string, Partial<typeof ok>]> = [
      ["id", { id: "SR-" + "x".repeat(62) }],
      ["id", { id: "" }],
      ["gate", { gate: "G".repeat(65) }],
      ["gate", { gate: "a gate" }],
      ["trackId", { trackId: "" }],
      ["outcome", { outcome: "person" as any }],
      ["employeeId", { outcome: "employee", employeeId: undefined }],
      ["employeeId", { employeeId: "E".repeat(65) }],
      ["runnerUpEmployeeId", { runnerUpEmployeeId: "with space" }],
      ["basis", { basis: undefined as any }],
      ["frames", { framesSeen: -1 }],
      ["frames", { framesUsed: 2 ** 31 }],
      ["firstSeenAt", { firstSeenAt: "1999-12-31T23:59:59Z" }],
      ["decidedAt", { decidedAt: "" }],
      ["legacyLogId", { legacyLogId: "L".repeat(65) }],
      ["legacyStatus", { legacyStatus: "granted" as any }],
      ["legacyEmployeeId", { legacyEmployeeId: 42 as any }],
      ["agreement", { agreement: "same" as any }],
    ];
    for (const [field, over] of bad) {
      assert.equal(normalizeShadowResult({ ...ok, ...over }).error, field, JSON.stringify(over).slice(0, 80));
    }
    assert.equal(normalizeShadowResult(undefined as any).error, "not-an-object");
  });
  it("drops malformed descriptive values instead of failing or truncating", () => {
    const { row } = normalizeShadowResult({ ...ok, fusedCosine: NaN, margin: 1e300, runnerUpCosine: "0.4" as any, fusionBasis: "f".repeat(129), firstUsableAt: "soon" });
    assert.equal(row?.fusedCosine, null);
    assert.equal(row?.margin, null);
    assert.equal(row?.runnerUpCosine, null);
    assert.equal(row?.fusionBasis, null);
    assert.equal(row?.firstUsableAt, null);
  });
  it("a stranger or insufficient outcome may carry its best candidate, or nothing", () => {
    assert.equal(normalizeShadowResult({ ...ok, outcome: "stranger", employeeId: undefined }).row?.employeeId, null);
    assert.equal(normalizeShadowResult({ ...ok, outcome: "stranger" }).row?.employeeId, "EMP-A");
    assert.equal(normalizeShadowResult({ ...ok, outcome: "insufficient", employeeId: "" }).row?.employeeId, null);
  });
});

describe("normalizeStrangerFace: recognised-face observation fields", () => {
  const base = {
    id: "SF-1", logId: "LOG-1", faceIndex: 0, capturedAt: "2026-09-29T01:00:00.000Z", gate: "EXIT" as const, engine: "legacy" as const,
    box: [1, 2, 3, 4] as [number, number, number, number], detectorScore: 0.9, quality: 0.5, sizePx: 80, createdAt: "2026-09-29T01:00:00.000Z",
  };
  it("a stranger face stores no employee and no match scores, even if a score was passed", () => {
    const { row } = normalizeStrangerFace({ ...base, matchCosine: 0.3 });
    assert.deepEqual([row?.employeeId, row?.matchCosine, row?.matchMargin], [null, null, null]);
  });
  it("an observation needs a storable employeeId and both scores", () => {
    assert.equal(normalizeStrangerFace({ ...base, employeeId: "EMP-1" }).error, "matchScores");
    assert.equal(normalizeStrangerFace({ ...base, employeeId: "EMP-1", matchCosine: 0.7 }).error, "matchScores");
    assert.equal(normalizeStrangerFace({ ...base, employeeId: "EMP-1", matchCosine: 0.7, matchMargin: Infinity }).error, "matchScores");
    assert.equal(normalizeStrangerFace({ ...base, employeeId: "E".repeat(65), matchCosine: 0.7, matchMargin: 0.1 }).error, "employeeId");
    assert.equal(normalizeStrangerFace({ ...base, employeeId: "no spaces", matchCosine: 0.7, matchMargin: 0.1 }).error, "employeeId");
    const { row, error } = normalizeStrangerFace({ ...base, employeeId: "EMP-1", matchCosine: 0.7, matchMargin: 0 });
    assert.equal(error, undefined);
    assert.deepEqual([row?.employeeId, row?.matchCosine, row?.matchMargin], ["EMP-1", 0.7, 0]);
  });
});

describe("SQLite: shadow results, observations, adaptation templates", () => {
  const dataDir = tmpDir("acc-db-sqlite-");

  it("runs the shadow-result scenario", async () => {
    const r = await runAccuracyChild("runShadowScenario", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.equal(r.out.mode, "sqlite");
    assertShadowScenario(r.out, assert);
  });

  it("runs the observation scenario", async () => {
    const r = await runAccuracyChild("runObservationScenario", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.equal(r.out.mode, "sqlite");
    assertObservationScenario(r.out, assert);
  });

  it("keeps everything across a restart", async () => {
    const s = await runAccuracyChild("readBackShadowScenario", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(s.code, 0, s.stderr.slice(-3000));
    assertShadowReadBack(s.out, assert);
    const o = await runAccuracyChild("readBackObservationScenario", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(o.code, 0, o.stderr.slice(-3000));
    assertObservationReadBack(o.out, assert);
  });

  it("stores the planned schema and serves pages and observations from the indexes", () => {
    const inspect = new DatabaseSync(path.join(dataDir, "smartface.db"));
    try {
      const shadowCols = (inspect.prepare("PRAGMA table_info(pipeline_shadow_results)").all() as Array<{ name: string }>).map((c) => c.name);
      assert.deepEqual(shadowCols, SHADOW_COLUMNS);
      const shadowIdx = (inspect.prepare("PRAGMA index_list(pipeline_shadow_results)").all() as Array<{ name: string }>)
        .map((i) => i.name).filter((n) => n.startsWith("idx_")).sort();
      assert.deepEqual(shadowIdx, ["idx_shadow_results_decided", "idx_shadow_results_gate"]);
      const faceCols = (inspect.prepare("PRAGMA table_info(stranger_faces)").all() as Array<{ name: string }>).map((c) => c.name);
      assert.deepEqual(faceCols, FACE_COLUMNS);
      const faceIdx = (inspect.prepare("PRAGMA index_list(stranger_faces)").all() as Array<{ name: string; partial: number }>)
        .filter((i) => i.name.startsWith("idx_")).map((i) => `${i.name}:${i.partial}`).sort();
      assert.deepEqual(faceIdx, ["idx_stranger_faces_captured:1", "idx_stranger_faces_log:0", "idx_stranger_faces_recognised:1"]);

      const plan = (sql: string, ...params: unknown[]) =>
        (inspect.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as any[]).map((p) => p.detail).join(" | ");
      const page = plan(`SELECT id FROM pipeline_shadow_results WHERE (decidedAt < ? OR (decidedAt = ? AND id < ?)) ORDER BY decidedAt DESC, id DESC LIMIT 5`, "z", "z", "z");
      assert.match(page, /idx_shadow_results_decided/, page);
      assert.doesNotMatch(page, /TEMP B-TREE/, page);
      const obs = plan(`SELECT id FROM stranger_faces WHERE employeeId IS NOT NULL AND purgedAt IS NULL AND capturedAt >= ? AND employeeId = ? ORDER BY capturedAt DESC, id DESC LIMIT 5`, "a", "EMP-A");
      assert.match(obs, /idx_stranger_faces_recognised/, obs);
      const grouping = plan(`SELECT id FROM stranger_faces WHERE purgedAt IS NULL AND employeeId IS NULL ORDER BY capturedAt DESC, id DESC LIMIT 5`);
      assert.match(grouping, /idx_stranger_faces_captured/, grouping);
      // Shadow results carry no biometric bytes: no BLOB column at all.
      const types = (inspect.prepare("PRAGMA table_info(pipeline_shadow_results)").all() as Array<{ type: string }>).map((c) => c.type);
      assert.ok(!types.includes("BLOB"));
      // meanCheckRefused stored as 0/1/NULL.
      const mean = (inspect.prepare("SELECT id, meanCheckRefused AS m FROM pipeline_shadow_results WHERE id IN ('SR-4','SR-6','SR-7') ORDER BY id").all() as any[]).map((r) => ({ ...r }));
      assert.deepEqual(mean, [{ id: "SR-4", m: 0 }, { id: "SR-6", m: 1 }, { id: "SR-7", m: null }]);
    } finally {
      inspect.close();
    }
  });
});

describe("PostgreSQL configured but still connecting", () => {
  it("refuses shadow results and observations instead of parking them in the local store", async () => {
    const dataDir = tmpDir("acc-db-connecting-");
    // Port 1 on loopback: the connection is refused and the startup retries keep it "connecting".
    const r = await runAccuracyChild("whileConnectingAccuracy", { DATA_DIR: dataDir, DATABASE_URL: "postgresql://nobody:none@127.0.0.1:1/none" });
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.deepEqual(r.out, { mode: "connecting", logSaved: true, faceSaved: false, obs: 0, shadowSaved: false, shadowPage: 0, summary: [], purged: 0 });
    const inspect = new DatabaseSync(path.join(dataDir, "smartface.db"));
    try {
      assert.equal((inspect.prepare("SELECT count(*) AS n FROM pipeline_shadow_results").get() as any).n, 0);
      assert.equal((inspect.prepare("SELECT count(*) AS n FROM stranger_faces").get() as any).n, 0);
    } finally {
      inspect.close();
    }
  });
});

describe("SQLite: database from the previous release (per-face)", () => {
  /** stranger_faces exactly as the per-face release creates it (no observation columns), plus one face. */
  const LEGACY = `
    CREATE TABLE stranger_faces (
      id TEXT PRIMARY KEY, logId TEXT NOT NULL, faceIndex INTEGER NOT NULL, capturedAt TEXT NOT NULL, gate TEXT NOT NULL,
      streamId TEXT, engine TEXT NOT NULL, trackId TEXT, box TEXT NOT NULL, sourceWidth INTEGER, sourceHeight INTEGER,
      detectorScore REAL NOT NULL, quality REAL NOT NULL, edgeEnergy REAL, sizePx INTEGER NOT NULL, embedding BLOB, dims INTEGER,
      modelTag TEXT, crop BLOB, createdAt TEXT NOT NULL, purgedAt TEXT);
    CREATE INDEX idx_stranger_faces_captured ON stranger_faces (capturedAt DESC, id DESC) WHERE purgedAt IS NULL;
    CREATE UNIQUE INDEX idx_stranger_faces_log ON stranger_faces (logId, faceIndex);`;
  /** The previous release's INSERT (20 columns, no observation fields). */
  const OLD_INSERT = `INSERT INTO stranger_faces (id, logId, faceIndex, capturedAt, gate, streamId, engine, trackId, box,
      sourceWidth, sourceHeight, detectorScore, quality, edgeEnergy, sizePx, embedding, dims, modelTag, crop, createdAt)
    VALUES (?, 'LOG-OLD-1', ?, '2026-09-28T01:00:00.000Z', 'EXIT', 'exit-cam', 'legacy', NULL, '[1,2,3,4]',
      NULL, NULL, 0.9, 0.5, NULL, 80, ?, 4, 'arcface_test', NULL, '2026-09-28T01:00:00.000Z')`;
  const OLD_SELECT = `SELECT id, logId, faceIndex, capturedAt, gate, streamId, engine, trackId, box, sourceWidth, sourceHeight,
      detectorScore, quality, edgeEnergy, sizePx, embedding, dims, modelTag, createdAt, purgedAt FROM stranger_faces WHERE id = ?`;
  const emb = Buffer.alloc(16);

  it("adds the nullable observation columns, the recognised index and the shadow table; old faces stay strangers; old code still works", async () => {
    const dataDir = tmpDir("acc-db-legacy-");
    const file = path.join(dataDir, "smartface.db");
    const legacy = new DatabaseSync(file);
    legacy.exec(LEGACY);
    legacy.prepare(OLD_INSERT).run("SF-OLD-1", 0, emb);
    legacy.close();

    const r = await runAccuracyChild("storeOnly", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.doesNotMatch(r.stderr, /Lỗi khởi tạo bảng/);
    assert.deepEqual(r.out, {
      mode: "sqlite", page: ["SF-OLD-1"],
      oldFaces: [{ id: "SF-OLD-1", employeeId: null, matchCosine: null, embedding: 4 }],
      obs: [], shadow: [], summary: [], templates: [],
    }, "a face from the previous release reads employeeId null and is still grouped");

    const inspect = new DatabaseSync(file);
    try {
      const cols = (inspect.prepare("PRAGMA table_info(stranger_faces)").all() as any[]);
      assert.deepEqual(cols.map((c) => c.name), FACE_COLUMNS, "columns appended in the same order as a fresh database");
      for (const name of ["employeeId", "matchCosine", "matchMargin"]) {
        const col = cols.find((c) => c.name === name);
        assert.equal(col.notnull, 0, `${name} nullable`);
        assert.equal(col.dflt_value, null, `${name} no default`);
      }
      const idx = (inspect.prepare("PRAGMA index_list(stranger_faces)").all() as any[]).map((i) => i.name).filter((n) => n.startsWith("idx_")).sort();
      assert.deepEqual(idx, ["idx_stranger_faces_captured", "idx_stranger_faces_log", "idx_stranger_faces_recognised"]);
      assert.deepEqual((inspect.prepare("PRAGMA table_info(pipeline_shadow_results)").all() as any[]).map((c) => c.name), SHADOW_COLUMNS);
      // Rollback to the previous image: its INSERT and SELECT never name the new columns and still work.
      inspect.prepare(OLD_INSERT).run("SF-OLD-2", 1, emb);
      const old = inspect.prepare(OLD_SELECT).get("SF-OLD-2") as any;
      assert.equal(old.logId, "LOG-OLD-1");
      assert.equal("employeeId" in old, false);
      assert.deepEqual({ ...(inspect.prepare("SELECT employeeId, matchCosine, matchMargin FROM stranger_faces WHERE id = 'SF-OLD-2'").get() as any) }, { employeeId: null, matchCosine: null, matchMargin: null });
    } finally {
      inspect.close();
    }
    // Restart is a no-op for the migration; the row written by "old code" is a stranger.
    const again = await runAccuracyChild("storeOnly", { DATA_DIR: dataDir, DATABASE_URL: "" });
    assert.equal(again.code, 0, again.stderr.slice(-3000));
    assert.doesNotMatch(again.stderr, /Lỗi khởi tạo bảng/);
    assert.deepEqual(again.out.page, ["SF-OLD-2", "SF-OLD-1"]);
  });
});

describe("JSON fallback (SQLite unavailable): shadow results, observations, adaptation templates", () => {
  const dataDir = tmpDir("acc-db-json-");
  const NO_SQLITE = ["--no-experimental-sqlite"];

  it("reads a JSON store from the previous release (faces without employeeId, no shadow results)", async () => {
    fs.writeFileSync(path.join(dataDir, "smartface_data.json"), JSON.stringify({
      employees: [], access_logs: [], webhook_logs: [], mobile_notifications: [], door_api_logs: [],
      resolved_stranger_clusters: [], stranger_resolutions: [],
      stranger_faces: [{
        id: "SF-OLD-1", logId: "LOG-OLD-1", faceIndex: 0, capturedAt: "2026-09-28T01:00:00.000Z", gate: "EXIT", streamId: "exit-cam",
        engine: "legacy", box: [1, 2, 3, 4], detectorScore: 0.9, quality: 0.5, sizePx: 80, embedding: [0.6, 0.8, 0, 0], dims: 4,
        modelTag: "arcface_test", createdAt: "2026-09-28T01:00:00.000Z",
      }],
    }));
    const r = await runAccuracyChild("storeOnly", { DATA_DIR: dataDir, DATABASE_URL: "" }, NO_SQLITE);
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.deepEqual(r.out, {
      mode: "json", page: ["SF-OLD-1"],
      oldFaces: [{ id: "SF-OLD-1", employeeId: null, matchCosine: null, embedding: 4 }],
      obs: [], shadow: [], summary: [], templates: [],
    });
    // Start the scenarios from an empty store.
    fs.rmSync(path.join(dataDir, "smartface_data.json"));
  });

  it("runs the shadow-result scenario", async () => {
    const r = await runAccuracyChild("runShadowScenario", { DATA_DIR: dataDir, DATABASE_URL: "" }, NO_SQLITE);
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.equal(r.out.mode, "json");
    assertShadowScenario(r.out, assert);
  });

  it("runs the observation scenario", async () => {
    const r = await runAccuracyChild("runObservationScenario", { DATA_DIR: dataDir, DATABASE_URL: "" }, NO_SQLITE);
    assert.equal(r.code, 0, r.stderr.slice(-3000));
    assert.equal(r.out.mode, "json");
    assertObservationScenario(r.out, assert);
  });

  it("keeps everything across a restart; observation fields and shadow results are plain JSON on disk", async () => {
    const s = await runAccuracyChild("readBackShadowScenario", { DATA_DIR: dataDir, DATABASE_URL: "" }, NO_SQLITE);
    assert.equal(s.code, 0, s.stderr.slice(-3000));
    assertShadowReadBack(s.out, assert);
    const o = await runAccuracyChild("readBackObservationScenario", { DATA_DIR: dataDir, DATABASE_URL: "" }, NO_SQLITE);
    assert.equal(o.code, 0, o.stderr.slice(-3000));
    assertObservationReadBack(o.out, assert);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, "smartface_data.json"), "utf8"));
    assert.equal(onDisk.pipeline_shadow_results.length, 10);
    assert.ok(onDisk.pipeline_shadow_results.every((r: any) => !("embedding" in r) && !("crop" in r)));
    const g1 = onDisk.stranger_faces.find((f: any) => f.id === "SF-G1-0");
    assert.deepEqual([g1.employeeId, g1.matchCosine, g1.matchMargin, typeof g1.crop], ["EMP-A", 0.71, 0.2, "string"]);
    const gold = onDisk.stranger_faces.find((f: any) => f.id === "SF-GOLD-0");
    assert.deepEqual([gold.employeeId, "embedding" in gold, "crop" in gold, typeof gold.purgedAt], ["EMP-A", false, false, "string"]);
    assert.equal(onDisk.face_templates.find((t: any) => t.id === "T-1").source, "adaptation");
  });
});
