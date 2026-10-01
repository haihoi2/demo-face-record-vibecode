/**
 * Behavioural scenarios for the N-gate wave's persistence (src/server/db.ts):
 * access_logs."gateId" (stored when valid, derived for rows written before
 * gate ids, the AccessLogQuery.gateId filter with keyset paging, counts and
 * per-gate stats), stranger_faces."gateId", per-door lock states with the
 * legacy smart_lock_state row as door "main", and shadow results whose legacy
 * gate spelling (ENTRY/EXIT) reads as the gate id. Each scenario starts on an
 * EMPTY store (apart from rows a test seeds on purpose) and returns a
 * JSON-able summary that tests/nGatesStore.test.ts (JSON, SQLite) and
 * tests/integration/nGatesPersistence.test.ts (PostgreSQL) assert on with the
 * same expectations, so the three stores are held to identical semantics.
 *
 * Embeddings and crops here are synthetic, never biometric data.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { StrangerFaceRecord } from "../../src/server/strangerFaces";
import { shadow } from "./accuracyScenario";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DB_MODULE = fileURLToPath(new URL("../../src/server/db.ts", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

type Db = typeof import("../../src/server/db").db;
type AccessLogRecord = import("../../src/server/db").AccessLogRecord;
type SmartLockStateRecord = import("../../src/server/db").SmartLockStateRecord;
type Assert = typeof import("node:assert/strict");

export type NGatesScenario =
  | "noop"
  | "runGateLogScenario"
  | "readBackGateLogScenario"
  | "runShadowGateScenario"
  | "runDoorLockScenario"
  | "readBackDoorLockScenario"
  | "legacyCheck"
  | "saveMainProbe";

/** Boot the storage layer in a fresh process and run one exported function of this module (EXPECT_PG=1 waits for PostgreSQL). */
export function runNGatesChild(
  fn: NGatesScenario,
  env: Record<string, string>,
  nodeArgs: string[] = [],
): Promise<{ code: number; out: any; stdout: string; stderr: string }> {
  const script = `
    const { db } = await import(${JSON.stringify(DB_MODULE)});
    if (process.env.EXPECT_PG === "1") {
      const synced = await new Promise((resolve) => { db.onSync(() => resolve(true)); setTimeout(() => resolve(false), 60000); });
      if (!synced || db.getStorageStatus().active !== "postgresql") {
        process.stdout.write("RESULT " + JSON.stringify({ error: "postgres not ready", status: db.getStorageStatus() }) + "\\n");
        process.exit(3);
      }
    }
    const scenario = await import(${JSON.stringify(SELF)});
    const out = await scenario[${JSON.stringify(fn)}](db);
    process.stdout.write("RESULT " + JSON.stringify(out) + "\\n");
    process.exit(0);`;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [...nodeArgs, "--import", "tsx", "--input-type=module", "-e", script],
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

export async function noop(db: Db): Promise<Record<string, any>> {
  return { mode: db.getStorageStatus().active };
}

// ================= ACCESS LOGS =================

const AT = (s: string) => `2026-10-01T01:00:${s}Z`;
const log = (id: string, s: string, type: "ENTRY" | "EXIT", status: "GRANTED" | "DENIED", gateId?: string): AccessLogRecord => ({
  id, timestamp: AT(s), type, status,
  ...(status === "GRANTED" ? { employeeId: "EMP-A", employeeName: "Nguyễn Văn A", employeeCode: "NV001", department: "Kỹ thuật" } : {}),
  photoSnapshot: "data:image/jpeg;base64,/9j/x", confidence: 90, lockAction: "x", doorName: "y",
  ...(gateId === undefined ? {} : { gateId }),
});

/**
 * L-01/L-02/L-09 are written like the previous release (no gateId); L-06 and
 * L-10 carry a value that is not a gate id (stored NULL); the rest carry ids.
 * L-08 and L-09 share a timestamp (id tie-break).
 */
export const GATE_LOGS: AccessLogRecord[] = [
  log("L-01", "01.000", "ENTRY", "GRANTED"),
  log("L-02", "02.000", "EXIT", "GRANTED"),
  log("L-03", "03.000", "ENTRY", "GRANTED", "entry"),
  log("L-04", "04.000", "EXIT", "DENIED", "exit"),
  log("L-05", "05.000", "ENTRY", "GRANTED", "side-door"),
  log("L-06", "06.000", "EXIT", "DENIED", "Bad Gate!"),
  log("L-07", "07.000", "EXIT", "GRANTED", "loading-bay"),
  log("L-08", "08.000", "ENTRY", "DENIED", "side-door"),
  log("L-09", "08.000", "ENTRY", "DENIED"),
  log("L-10", "10.000", "ENTRY", "GRANTED", "g".repeat(33)),
];

async function walkLogs(db: Db, limit: number, f: Parameters<Db["queryAccessLogs"]>[0]) {
  const ids: string[] = [];
  let cursor: { timestamp: string; id: string } | null = null;
  let pages = 0;
  let total = -1;
  for (;;) {
    const page = await db.queryAccessLogs(f, cursor, limit);
    pages += 1;
    total = page.total;
    ids.push(...page.logs.map((l) => `${l.id}:${l.gateId}`));
    if (!page.hasMore || !page.logs.length || pages > 50) break;
    const last = page.logs[page.logs.length - 1];
    cursor = { timestamp: last.timestamp, id: last.id };
  }
  return { ids, pages, total };
}

const gateMap = (logs: Array<{ id: string; gateId?: string }>) =>
  Object.fromEntries(logs.filter((l) => l.id.startsWith("L-")).map((l) => [l.id, l.gateId ?? null]));

const face = (id: string, logId: string, faceIndex: number, gate: "ENTRY" | "EXIT", gateId?: unknown): StrangerFaceRecord => ({
  id, logId, faceIndex, capturedAt: AT("08.000"), gate, engine: "pipeline", trackId: "side-door-000001",
  box: [10, 20, 110, 140], detectorScore: 0.9, quality: 0.6, sizePx: 100, embedding: [0.6, 0.8, 0, 0], modelTag: "arcface_test",
  createdAt: AT("09.000"), ...(gateId === undefined ? {} : { gateId }),
} as StrangerFaceRecord);

export async function runGateLogScenario(db: Db): Promise<Record<string, any>> {
  const out: Record<string, any> = { mode: db.getStorageStatus().active };
  out.saved = [];
  for (const l of GATE_LOGS) out.saved.push(await db.saveAccessLog(l));
  // Replay of an immutable event with another gate: a no-op, the first write wins.
  out.replay = await db.saveAccessLog({ ...GATE_LOGS[2], gateId: "side-door" });

  out.all = await walkLogs(db, 100, {});
  out.walk3 = await walkLogs(db, 3, {});
  out.entry = await walkLogs(db, 100, { gateId: "entry" });
  out.entryWalk1 = await walkLogs(db, 1, { gateId: "entry" });
  out.exit = await walkLogs(db, 2, { gateId: "exit" });
  out.side = await walkLogs(db, 1, { gateId: "side-door" });
  out.bay = await walkLogs(db, 100, { gateId: "loading-bay" });
  out.unknown = await walkLogs(db, 100, { gateId: "nope-gate" });
  out.malformed = await walkLogs(db, 100, { gateId: "Bad Gate!" });
  out.entryDenied = await walkLogs(db, 100, { gateId: "entry", status: "DENIED" });
  out.sideExit = await walkLogs(db, 100, { gateId: "side-door", type: "EXIT" });
  out.typeEntry = await walkLogs(db, 100, { type: "ENTRY" });
  out.entryFrom = await walkLogs(db, 100, { gateId: "entry", from: AT("03.000"), to: AT("10.000") });

  const stats = await db.accessLogStats({}, "Asia/Ho_Chi_Minh");
  out.stats = { total: stats.total, entries: stats.entries, exits: stats.exits, granted: stats.granted, denied: stats.denied, byGate: stats.byGate };
  const exitStats = await db.accessLogStats({ gateId: "exit" }, "Asia/Ho_Chi_Minh");
  out.exitStats = { total: exitStats.total, entries: exitStats.entries, exits: exitStats.exits, byGate: exitStats.byGate };
  const none = await db.accessLogStats({ gateId: "Bad Gate!" }, "Asia/Ho_Chi_Minh");
  out.noneStats = { total: none.total, byGate: none.byGate };

  out.meta = {
    l01: (await db.getAccessLogMetaById("L-01"))?.gateId ?? null,
    l05: (await db.getAccessLogMetaById("L-05"))?.gateId ?? null,
    l06: (await db.getAccessLogMetaById("L-06"))?.gateId ?? null,
  };
  out.page = gateMap((await db.getAccessLogsPage(1, 50)).logs);
  out.hydrate = gateMap(db.getAccessLogs([]));
  out.candidates = (await db.getStrangerCandidateLogsPage(null, 50)).logs.filter((l) => l.id.startsWith("L-")).map((l) => `${l.id}:${l.gateId}`);

  // Stranger faces: the optional gateId rides along with the contract record.
  out.faceSaved = await db.saveStrangerFaces([
    face("SF-N1", "L-08", 0, "ENTRY", "side-door"),
    face("SF-N2", "L-08", 1, "ENTRY"),
    face("SF-N3", "L-06", 0, "EXIT", "BAD ID"),
    face("SF-N4", "L-04", 0, "EXIT", 42),
  ]);
  const faceGates = (faces: StrangerFaceRecord[]) => Object.fromEntries(faces.map((f) => [f.id, (f as any).gateId ?? null]));
  out.facesById = faceGates(await db.getStrangerFacesByIds(["SF-N1", "SF-N2", "SF-N3", "SF-N4"]));
  out.facesByLog = faceGates(await db.getStrangerFacesByLogIds(["L-08", "L-06", "L-04"]));
  out.facesPage = faceGates((await db.getStrangerFacesPage(null, 100)).faces.filter((f) => f.id.startsWith("SF-N")));
  out.candidatesAfterFaces = (await db.getStrangerCandidateLogsPage(null, 50)).logs.filter((l) => l.id.startsWith("L-")).map((l) => l.id);
  return out;
}

/** A second process on the same store: what survived the restart. */
export async function readBackGateLogScenario(db: Db): Promise<Record<string, any>> {
  return {
    mode: db.getStorageStatus().active,
    all: await walkLogs(db, 100, {}),
    entry: await walkLogs(db, 2, { gateId: "entry" }),
    side: await walkLogs(db, 100, { gateId: "side-door" }),
    faces: Object.fromEntries((await db.getStrangerFacesByIds(["SF-N1", "SF-N2", "SF-N3"])).map((f) => [f.id, (f as any).gateId ?? null])),
  };
}

const ALL = ["L-10:entry", "L-09:entry", "L-08:side-door", "L-07:loading-bay", "L-06:exit", "L-05:side-door", "L-04:exit", "L-03:entry", "L-02:exit", "L-01:entry"];
const BY_GATE = [
  { gateId: "entry", total: 4, granted: 3, denied: 1 },
  { gateId: "exit", total: 3, granted: 1, denied: 2 },
  { gateId: "loading-bay", total: 1, granted: 1, denied: 0 },
  { gateId: "side-door", total: 2, granted: 1, denied: 1 },
];

/** Expectations shared by every store (JSON, SQLite, PostgreSQL). */
export function assertGateLogScenario(out: Record<string, any>, assert: Assert): void {
  assert.deepEqual(out.saved, Array(GATE_LOGS.length).fill(true), "every event is stored; a malformed gate id never fails the event");
  assert.equal(out.replay, true);
  assert.deepEqual(out.all, { ids: ALL, pages: 1, total: 10 }, "stored ids, derived ids for legacy and malformed rows; L-03 keeps its first gate");
  assert.deepEqual(out.walk3, { ids: ALL, pages: 4, total: 10 });
  assert.deepEqual(out.entry, { ids: ["L-10:entry", "L-09:entry", "L-03:entry", "L-01:entry"], pages: 1, total: 4 },
    "the entry gate: rows stored with it plus the legacy ENTRY rows (NULL gateId)");
  assert.deepEqual(out.entryWalk1, { ids: ["L-10:entry", "L-09:entry", "L-03:entry", "L-01:entry"], pages: 4, total: 4 }, "the gate filter composes with the keyset cursor");
  assert.deepEqual(out.exit, { ids: ["L-06:exit", "L-04:exit", "L-02:exit"], pages: 2, total: 3 });
  assert.deepEqual(out.side, { ids: ["L-08:side-door", "L-05:side-door"], pages: 2, total: 2 }, "a new gate matches only its own rows (no legacy rows)");
  assert.deepEqual(out.bay, { ids: ["L-07:loading-bay"], pages: 1, total: 1 });
  assert.deepEqual(out.unknown, { ids: [], pages: 1, total: 0 });
  assert.deepEqual(out.malformed, { ids: [], pages: 1, total: 0 }, "a value that is not a gate id matches nothing");
  assert.deepEqual(out.entryDenied.ids, ["L-09:entry"]);
  assert.deepEqual(out.sideExit, { ids: [], pages: 1, total: 0 }, "the direction filter is unchanged and composes with the gate");
  assert.deepEqual(out.typeEntry.ids, ["L-10:entry", "L-09:entry", "L-08:side-door", "L-05:side-door", "L-03:entry", "L-01:entry"]);
  assert.deepEqual(out.entryFrom.ids, ["L-09:entry", "L-03:entry"], "from inclusive, to exclusive");

  assert.deepEqual(out.stats, { total: 10, entries: 6, exits: 4, granted: 6, denied: 4, byGate: BY_GATE }, "per-gate counts next to the per-direction ones");
  assert.deepEqual(out.exitStats, { total: 3, entries: 0, exits: 3, byGate: [{ gateId: "exit", total: 3, granted: 1, denied: 2 }] });
  assert.deepEqual(out.noneStats, { total: 0, byGate: [] });

  assert.deepEqual(out.meta, { l01: "entry", l05: "side-door", l06: "exit" });
  const expectedMap = Object.fromEntries(ALL.map((s) => s.split(":")));
  assert.deepEqual(out.page, expectedMap, "the legacy page carries gateId");
  assert.deepEqual(out.hydrate, expectedMap, "startup hydration carries gateId");
  assert.deepEqual(out.candidates, ["L-09:entry", "L-08:side-door", "L-06:exit", "L-04:exit"], "stranger candidates carry gateId");

  assert.equal(out.faceSaved, true, "a malformed face gateId is dropped, never fatal");
  const faces = { "SF-N1": "side-door", "SF-N2": "entry", "SF-N3": "exit", "SF-N4": "exit" };
  assert.deepEqual(out.facesById, faces, "stored id, or derived from the face's direction");
  assert.deepEqual(out.facesByLog, faces);
  assert.deepEqual(out.facesPage, faces);
  assert.deepEqual(out.candidatesAfterFaces, ["L-09"], "logs with faces are represented by their faces (unchanged)");
}

export function assertGateLogReadBack(out: Record<string, any>, assert: Assert): void {
  assert.deepEqual(out.all, { ids: ALL, pages: 1, total: 10 });
  assert.deepEqual(out.entry, { ids: ["L-10:entry", "L-09:entry", "L-03:entry", "L-01:entry"], pages: 2, total: 4 });
  assert.deepEqual(out.side, { ids: ["L-08:side-door", "L-05:side-door"], pages: 1, total: 2 });
  assert.deepEqual(out.faces, { "SF-N1": "side-door", "SF-N2": "entry", "SF-N3": "exit" });
}

// ================= SHADOW RESULTS =================

const SAT = (s: string) => `2026-10-01T02:00:${s}Z`;
/** Rows the previous release wrote (gate = direction). Tests seed them RAW into the store before the scenario. */
export const LEGACY_SHADOW_ROWS = [
  shadow("SR-L1", "ENTRY", SAT("10.000"), { firstUsableAt: SAT("09.000") }),
  shadow("SR-L2", "EXIT", SAT("12.000"), { firstUsableAt: SAT("11.500") }),
];

export async function runShadowGateScenario(db: Db): Promise<Record<string, any>> {
  const out: Record<string, any> = { mode: db.getStorageStatus().active };
  out.saved = [
    await db.saveShadowResult(shadow("SR-N1", "entry", SAT("20.000"), { firstUsableAt: SAT("17.000") })),
    await db.saveShadowResult(shadow("SR-N2", "exit", SAT("21.000"), { firstUsableAt: SAT("19.500") })),
    await db.saveShadowResult(shadow("SR-N3", "side-door", SAT("22.000"), { trackId: "side-door-000001" })),
    // A writer still naming the direction: stored as the gate id.
    await db.saveShadowResult(shadow("SR-N4", "ENTRY", SAT("23.000"), { outcome: "stranger", employeeId: undefined })),
  ];
  const page = async (gate?: string) =>
    (await db.getShadowResultsPage(null, 100, gate === undefined ? undefined : { gate })).results
      .filter((r) => r.id.startsWith("SR-L") || r.id.startsWith("SR-N")).map((r) => `${r.id}:${r.gate}`);
  out.all = await page();
  out.entry = await page("entry");
  out.ENTRY = await page("ENTRY");
  out.exit = await page("exit");
  out.side = await page("side-door");
  out.SIDE = await page("SIDE-DOOR");
  // Keyset walk across both spellings of one gate.
  const walk: string[] = [];
  let cursor: { decidedAt: string; id: string } | null = null;
  for (let i = 0; i < 10; i += 1) {
    const p = await db.getShadowResultsPage(cursor, 1, { gate: "entry" });
    walk.push(...p.results.map((r) => r.id));
    if (!p.hasMore) break;
    const last = p.results[p.results.length - 1];
    cursor = { decidedAt: last.decidedAt, id: last.id };
  }
  out.entryWalk = walk;
  out.summary = (await db.summarizeShadowResults("2026-10-01T00:00:00.000Z"))
    .map((s) => ({ gate: s.gate, decisions: s.decisions, employees: s.employees, strangers: s.strangers, p50: s.decisionLatencyP50Ms }));
  return out;
}

export function assertShadowGateScenario(out: Record<string, any>, assert: Assert): void {
  assert.deepEqual(out.saved, [true, true, true, true]);
  assert.deepEqual(out.all, ["SR-N4:entry", "SR-N3:side-door", "SR-N2:exit", "SR-N1:entry", "SR-L2:exit", "SR-L1:entry"], "legacy spellings read as gate ids");
  assert.deepEqual(out.entry, ["SR-N4:entry", "SR-N1:entry", "SR-L1:entry"], "the entry filter matches both spellings");
  assert.deepEqual(out.ENTRY, out.entry, "a legacy-spelled filter means the same gate");
  assert.deepEqual(out.exit, ["SR-N2:exit", "SR-L2:exit"]);
  assert.deepEqual(out.side, ["SR-N3:side-door"]);
  assert.deepEqual(out.SIDE, [], "only ENTRY/EXIT are legacy spellings; other ids are exact");
  assert.deepEqual(out.entryWalk, ["SR-N4", "SR-N1", "SR-L1"]);
  assert.deepEqual(out.summary, [
    { gate: "entry", decisions: 3, employees: 2, strangers: 1, p50: 2000 },
    { gate: "exit", decisions: 2, employees: 2, strangers: 0, p50: 1000 },
    { gate: "side-door", decisions: 1, employees: 1, strangers: 0, p50: null },
  ], "one row per gate: legacy and new spellings merge (counts and latency samples)");
}

// ================= DOOR LOCK STATES =================

export const DEFAULT_LOCK: SmartLockStateRecord = {
  lockId: "SL-HQ-01", doorName: "Cửa chính", state: "LOCKED", isLocked: true, batteryLevel: 96, signalDbm: -54,
  firmwareVersion: "v2.5.8", lastActionAt: "2026-10-01T00:00:00.000Z", lastActionBy: "Hệ thống", autoRelockSeconds: 6,
  remainingRelockSeconds: 0, status: "ONLINE",
};
const T = (m: string) => `2026-10-01T03:${m}:00.000Z`;
const lock = (over: Partial<SmartLockStateRecord> & Record<string, unknown>): SmartLockStateRecord => ({ ...DEFAULT_LOCK, ...over } as SmartLockStateRecord);
const brief = (s: SmartLockStateRecord) => ({ doorId: s.doorId ?? null, state: s.state, by: s.lastActionBy });

export async function runDoorLockScenario(db: Db): Promise<Record<string, any>> {
  const out: Record<string, any> = { mode: db.getStorageStatus().active };
  out.initial = db.listDoorLockStates().map(brief);
  out.mainDefault = db.getDoorLockState("main", DEFAULT_LOCK);
  out.mainDefaultBrief = brief(out.mainDefault);
  out.unknownDoor = brief(db.getDoorLockState("side-door", DEFAULT_LOCK));
  out.badDoorGet = db.getDoorLockState("Side Door", DEFAULT_LOCK).doorId ?? null;

  out.saved = [
    await db.saveDoorLockState("main", lock({
      state: "UNLOCKED", isLocked: false, lastActionAt: T("01"), lastActionBy: "Nguyễn Văn A", remainingRelockSeconds: 5,
      apiToken: "must-not-be-stored", doorId: "other-door",
    })),
    await db.saveDoorLockState("side-door", lock({ lockId: "SL-SIDE", doorName: "Cửa hông", lastActionAt: T("02"), lastActionBy: "op-start" })),
  ];
  out.main = db.getDoorLockState("main", DEFAULT_LOCK);
  out.refused = {
    doorUpper: await db.saveDoorLockState("Main", DEFAULT_LOCK),
    doorEmpty: await db.saveDoorLockState("", DEFAULT_LOCK),
    doorShort: await db.saveDoorLockState("m", DEFAULT_LOCK),
    doorLong: await db.saveDoorLockState("d".repeat(33), DEFAULT_LOCK),
    notObject: await db.saveDoorLockState("side-door", null as any),
    lockId: await db.saveDoorLockState("side-door", lock({ lockId: "" })),
    lockIdLong: await db.saveDoorLockState("side-door", lock({ lockId: "L".repeat(65) })),
    state: await db.saveDoorLockState("side-door", lock({ state: "OPEN" as any })),
    isLocked: await db.saveDoorLockState("side-door", lock({ isLocked: "yes" as any })),
    status: await db.saveDoorLockState("side-door", lock({ status: "UP" as any })),
  };
  out.afterRefusals = brief(db.getDoorLockState("side-door", DEFAULT_LOCK));

  // Concurrent saves of one door: every one succeeds and the last call is what is stored.
  out.concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    db.saveDoorLockState("side-door", lock({ lockId: "SL-SIDE", doorName: "Cửa hông", lastActionAt: T(`1${i}`), lastActionBy: `op-${i}` }))));
  out.afterConcurrent = brief(db.getDoorLockState("side-door", DEFAULT_LOCK));

  // The previous release keeps writing smart_lock_state (rollback, or a caller not yet moved): door "main" shows the newer one.
  db.saveSmartLockState(lock({ state: "LOCKED", isLocked: true, lastActionAt: T("30"), lastActionBy: "old-code" }));
  out.mainAfterLegacy = brief(db.getDoorLockState("main", DEFAULT_LOCK));
  out.mainSavedAgain = await db.saveDoorLockState("main", lock({ state: "UNLOCKED", isLocked: false, lastActionAt: T("31"), lastActionBy: "new-code", doorName: "C".repeat(300) }));
  out.mainFinal = brief(db.getDoorLockState("main", DEFAULT_LOCK));
  out.doorNameLength = db.getDoorLockState("main", DEFAULT_LOCK).doorName.length;

  out.deleteMain = await db.deleteDoorLockState("main");
  out.deleteBad = await db.deleteDoorLockState("No!");
  out.deleteSide = await db.deleteDoorLockState("side-door");
  out.deleteSideAgain = await db.deleteDoorLockState("side-door");
  out.listAfterDelete = db.listDoorLockStates().map(brief);
  out.resaved = await db.saveDoorLockState("side-door", lock({ lockId: "SL-SIDE", lastActionAt: T("40"), lastActionBy: "op-final" }));
  out.list = db.listDoorLockStates().map(brief);
  return out;
}

/** A second process: what survived the restart, also through the legacy single-lock method. */
export async function readBackDoorLockScenario(db: Db): Promise<Record<string, any>> {
  return {
    mode: db.getStorageStatus().active,
    list: db.listDoorLockStates().map(brief),
    main: db.getDoorLockState("main", DEFAULT_LOCK),
    legacy: brief(db.getSmartLockState(DEFAULT_LOCK)),
  };
}

export function assertDoorLockScenario(out: Record<string, any>, assert: Assert): void {
  if (out.mode === "postgresql") {
    // The existing startup sync seeds smart_lock_state on an empty PostgreSQL: that row is door main.
    const seeded = { doorId: "main", state: "LOCKED", by: "Hệ thống bảo mật tự động" };
    assert.deepEqual(out.initial, [seeded]);
    assert.deepEqual(out.mainDefaultBrief, seeded);
  } else {
    assert.deepEqual(out.initial, [], "a fresh store has no lock state");
    assert.deepEqual(out.mainDefault, { ...DEFAULT_LOCK, doorId: "main" }, "no row: the caller's default, as door main");
  }
  assert.deepEqual(out.unknownDoor, { doorId: "side-door", state: "LOCKED", by: "Hệ thống" });
  assert.equal(out.badDoorGet, null, "a malformed door id gets the plain default");
  assert.deepEqual(out.saved, [true, true]);
  assert.deepEqual(out.main, {
    ...DEFAULT_LOCK, doorId: "main", state: "UNLOCKED", isLocked: false, lastActionAt: T("01"), lastActionBy: "Nguyễn Văn A", remainingRelockSeconds: 5,
  }, "known fields only (no token rides along) and the key is the door id");
  assert.deepEqual(out.refused, {
    doorUpper: false, doorEmpty: false, doorShort: false, doorLong: false, notObject: false,
    lockId: false, lockIdLong: false, state: false, isLocked: false, status: false,
  });
  assert.deepEqual(out.afterRefusals, { doorId: "side-door", state: "LOCKED", by: "op-start" }, "a refused write changes nothing");
  assert.deepEqual(out.concurrent, Array(8).fill(true));
  assert.deepEqual(out.afterConcurrent, { doorId: "side-door", state: "LOCKED", by: "op-7" });
  assert.deepEqual(out.mainAfterLegacy, { doorId: "main", state: "LOCKED", by: "old-code" }, "a newer legacy row wins for door main");
  assert.equal(out.mainSavedAgain, true);
  assert.deepEqual(out.mainFinal, { doorId: "main", state: "UNLOCKED", by: "new-code" });
  assert.equal(out.doorNameLength, 255, "descriptive text is cut to its column, never failing the write");
  assert.deepEqual([out.deleteMain, out.deleteBad, out.deleteSide, out.deleteSideAgain], [false, false, true, true], "door main cannot be removed; delete is idempotent");
  assert.deepEqual(out.listAfterDelete, [{ doorId: "main", state: "UNLOCKED", by: "new-code" }]);
  assert.equal(out.resaved, true);
  assert.deepEqual(out.list, [
    { doorId: "main", state: "UNLOCKED", by: "new-code" },
    { doorId: "side-door", state: "LOCKED", by: "op-final" },
  ]);
}

export function assertDoorLockReadBack(out: Record<string, any>, assert: Assert): void {
  assert.deepEqual(out.list, [
    { doorId: "main", state: "UNLOCKED", by: "new-code" },
    { doorId: "side-door", state: "LOCKED", by: "op-final" },
  ]);
  assert.equal(out.main.lastActionAt, T("31"));
  assert.equal(out.main.doorName.length, 255);
  assert.equal("apiToken" in out.main, false);
  assert.deepEqual(out.legacy, { doorId: null, state: "UNLOCKED", by: "new-code" }, "the legacy row was written with door main: a rollback keeps the current state");
}

/** One write of door main ("tx-probe"): used to prove the door row and the legacy row commit or roll back together. */
export async function saveMainProbe(db: Db): Promise<Record<string, any>> {
  const saved = await db.saveDoorLockState("main", lock({ state: "UNLOCKED", isLocked: false, lastActionAt: T("50"), lastActionBy: "tx-probe" }));
  return { mode: db.getStorageStatus().active, saved };
}

// ================= MIGRATED STORE =================

/**
 * What a store migrated from the previous release reads: tests seed old
 * access logs (OLD-1 ENTRY, OLD-2 EXIT), a smart_lock_state row
 * ("before-upgrade"), a stranger face on OLD-2 and an EXIT shadow result.
 */
export async function legacyCheck(db: Db): Promise<Record<string, any>> {
  const all = await db.queryAccessLogs({}, null, 50);
  return {
    mode: db.getStorageStatus().active,
    logs: all.logs.map((l) => `${l.id}:${l.gateId}`),
    entry: (await db.queryAccessLogs({ gateId: "entry" }, null, 50)).logs.map((l) => l.id),
    exit: (await db.queryAccessLogs({ gateId: "exit" }, null, 50)).logs.map((l) => l.id),
    meta: (await db.getAccessLogMetaById("OLD-2"))?.gateId ?? null,
    byGate: (await db.accessLogStats({}, "UTC")).byGate,
    main: brief(db.getDoorLockState("main", DEFAULT_LOCK)),
    list: db.listDoorLockStates().map(brief),
    face: Object.fromEntries((await db.getStrangerFacesByLogIds(["OLD-2"])).map((f) => [f.id, (f as any).gateId ?? null])),
    shadow: (await db.getShadowResultsPage(null, 10, { gate: "exit" })).results.map((r) => `${r.id}:${r.gate}`),
    summary: (await db.summarizeShadowResults("2026-01-01T00:00:00.000Z")).map((s) => `${s.gate}:${s.decisions}`),
  };
}

export function assertLegacyCheck(out: Record<string, any>, assert: Assert, extraLogs: string[] = [], mainBy = "before-upgrade"): void {
  assert.deepEqual(out.logs, [...extraLogs, "OLD-2:exit", "OLD-1:entry"], "rows from the previous release read derived gate ids");
  assert.deepEqual(out.entry, [...extraLogs.filter((s) => s.endsWith(":entry")).map((s) => s.split(":")[0]), "OLD-1"]);
  assert.deepEqual(out.exit, [...extraLogs.filter((s) => s.endsWith(":exit")).map((s) => s.split(":")[0]), "OLD-2"]);
  assert.equal(out.meta, "exit");
  assert.deepEqual(out.main, { doorId: "main", state: "LOCKED", by: mainBy }, "the legacy smart_lock_state row is door main");
  assert.deepEqual(out.list, [{ doorId: "main", state: "LOCKED", by: mainBy }]);
  assert.deepEqual(out.face, { "SF-OLD-1": "exit" });
  assert.deepEqual(out.shadow, ["SR-OLD-1:exit"]);
  assert.deepEqual(out.summary, ["exit:1"]);
}
