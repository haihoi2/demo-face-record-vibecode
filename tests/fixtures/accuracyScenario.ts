/**
 * Behavioural scenarios for the accuracy wave's persistence (src/server/db.ts):
 * the pipeline_shadow_results store (ShadowResultStore), recognised-face
 * observations on stranger_faces (employeeId / matchCosine / matchMargin,
 * excluded from grouping pages, getRecognisedFaceObservations) and
 * "adaptation" face templates with the per-(employee, camera) count. Each
 * scenario starts on an EMPTY store and returns a JSON-able summary that
 * tests/accuracyStore.test.ts (JSON, SQLite) and
 * tests/integration/accuracyPersistence.test.ts (PostgreSQL) assert on with
 * the same expectations, so the three stores are held to identical semantics.
 *
 * Crops and embeddings here are synthetic bytes/vectors, never biometric data.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ShadowResultRecord } from "../../src/server/shadowResults";
import type { StrangerFaceRecord } from "../../src/server/strangerFaces";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DB_MODULE = fileURLToPath(new URL("../../src/server/db.ts", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

type Db = typeof import("../../src/server/db").db;
type AccessLogRecord = import("../../src/server/db").AccessLogRecord;
type FaceTemplateRecord = import("../../src/server/db").FaceTemplateRecord;
type Assert = typeof import("node:assert/strict");

export type AccuracyScenario =
  | "runShadowScenario"
  | "readBackShadowScenario"
  | "runObservationScenario"
  | "readBackObservationScenario"
  | "storeOnly"
  | "whileConnectingAccuracy";

/**
 * Boot the storage layer in a fresh process (it is a singleton bound to
 * DATA_DIR/DATABASE_URL at import) and run one exported function of this
 * module against it. EXPECT_PG=1 waits for the PostgreSQL sync first.
 */
export function runAccuracyChild(
  fn: AccuracyScenario,
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

const outcome = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e: any) {
    return String(e?.message || e);
  }
};

const round = (xs: number[] | undefined) => (xs ? xs.map((v) => Math.round(v * 1000) / 1000) : null);
const round1 = (v: number | undefined) => (v === undefined ? null : Math.round(v * 1000) / 1000);

// ================= SHADOW RESULTS =================

const AT = (s: string) => `2026-09-29T01:00:${s}Z`;
const LONG_GATE = "G".repeat(64);
const LONG_SR = "SR-" + "L".repeat(61);

export const shadow = (id: string, gate: string, decidedAt: string, over: Partial<ShadowResultRecord> = {}): ShadowResultRecord => ({
  id,
  gate,
  trackId: `${gate.slice(0, 5).toLowerCase()}-000042`,
  outcome: "employee",
  employeeId: "EMP-A",
  fusedCosine: 0.71,
  margin: 0.2,
  runnerUpEmployeeId: "EMP-B",
  runnerUpCosine: 0.51,
  basis: "fused-2",
  fusionBasis: "accepted-fused",
  framesSeen: 9,
  framesUsed: 3,
  firstSeenAt: AT("00.000"),
  decidedAt,
  legacyLogId: "LOG-1",
  legacyStatus: "GRANTED",
  legacyEmployeeId: "EMP-A",
  agreement: "agree",
  createdAt: AT("59.000"),
  ...over,
});

const NO_LEGACY: Partial<ShadowResultRecord> = { legacyLogId: undefined, legacyStatus: undefined, legacyEmployeeId: undefined };
const NO_MATCH: Partial<ShadowResultRecord> = { employeeId: undefined, fusedCosine: undefined, margin: undefined, runnerUpEmployeeId: undefined, runnerUpCosine: undefined, fusionBasis: undefined };

/**
 * EXIT: five employee outcomes with latencies 1000, 3000, 2000, 8000 ms
 * (median 2500) and one without firstUsableAt (no latency sample), two
 * strangers, one insufficient. ENTRY: one employee (500 ms), one insufficient.
 * Plus one August result for the purge. SR-7 and SR-8 share a decidedAt (id
 * tie-break); SR-3 sits exactly on the second summary's `since`.
 */
export const SHADOW_ROWS: ShadowResultRecord[] = [
  shadow("SR-E1", "ENTRY", AT("05.000"), { firstUsableAt: AT("04.500") }),
  shadow("SR-1", "EXIT", AT("10.000"), { firstUsableAt: AT("09.000") }),
  shadow("SR-2", "EXIT", AT("15.000"), { firstUsableAt: AT("12.000"), employeeId: "EMP-B", legacyEmployeeId: "EMP-C", agreement: "identity-mismatch" }),
  shadow("SR-3", "EXIT", AT("20.000"), { firstUsableAt: AT("18.000") }),
  shadow("SR-4", "EXIT", AT("30.000"), { firstUsableAt: AT("22.000"), employeeId: "EMP-B", legacyEmployeeId: "EMP-B", meanCheckRefused: false }),
  shadow("SR-5", "EXIT", AT("35.000"), { ...NO_LEGACY, agreement: "shadow-only" }),
  shadow("SR-6", "EXIT", AT("38.000"), { outcome: "stranger", employeeId: undefined, framesUsed: 2, basis: "rejected-ambiguous", fusionBasis: "rejected-ambiguous", meanCheckRefused: true, agreement: "legacy-only" }),
  shadow("SR-E2", "ENTRY", AT("39.000"), { ...NO_MATCH, ...NO_LEGACY, outcome: "insufficient", framesUsed: 0, basis: "no-usable-frame", agreement: "none" }),
  shadow("SR-7", "EXIT", AT("40.000"), { ...NO_MATCH, ...NO_LEGACY, outcome: "insufficient", framesUsed: 0, basis: "no-usable-frame", agreement: "none" }),
  shadow("SR-8", "EXIT", AT("40.000"), { ...NO_MATCH, outcome: "stranger", framesUsed: 0, basis: "rejected-low", legacyLogId: "LOG-2", legacyStatus: "DENIED", legacyEmployeeId: undefined, agreement: "agree" }),
  shadow("SR-OLD", "ENTRY", "2026-08-01T00:00:00.000Z", { firstUsableAt: "2026-07-31T23:59:59.000Z" }),
];

async function walkShadow(db: Db, limit: number, filter?: Parameters<Db["getShadowResultsPage"]>[2]) {
  const ids: string[] = [];
  let cursor: { decidedAt: string; id: string } | null = null;
  let pages = 0;
  for (;;) {
    const page = await db.getShadowResultsPage(cursor, limit, filter);
    pages += 1;
    ids.push(...page.results.map((r) => r.id));
    if (!page.hasMore || !page.results.length || pages > 50) break;
    const last = page.results[page.results.length - 1];
    cursor = { decidedAt: last.decidedAt, id: last.id };
  }
  return { ids, pages };
}

export async function runShadowScenario(db: Db): Promise<Record<string, any>> {
  const out: Record<string, any> = { mode: db.getStorageStatus().active };

  out.saved = [];
  for (const r of SHADOW_ROWS) out.saved.push(await db.saveShadowResult(r));
  // Replay by id: a no-op, the first write wins.
  out.replay = await db.saveShadowResult({ ...SHADOW_ROWS[1], outcome: "stranger", employeeId: undefined, agreement: "none" });
  // Concurrent duplicate submissions of one id: all succeed, one row.
  out.concurrent = await Promise.all(Array.from({ length: 6 }, () =>
    db.saveShadowResult(shadow("SR-DUP", "EXIT", AT("39.500"), { ...NO_MATCH, outcome: "stranger", framesUsed: 1, basis: "rejected-low", ...NO_LEGACY, agreement: "none" }))));

  // Refusals: required fields (server-generated, so a malformed one is a bug, never stored half-described).
  out.invalid = {
    id: await db.saveShadowResult(shadow("bad id", "EXIT", AT("50.000"))),
    longId: await db.saveShadowResult(shadow("SR-" + "x".repeat(62), "EXIT", AT("50.000"))),
    gate: await db.saveShadowResult(shadow("SR-X1", "", AT("50.000"))),
    trackId: await db.saveShadowResult(shadow("SR-X2", "EXIT", AT("50.000"), { trackId: "t".repeat(65) })),
    outcome: await db.saveShadowResult(shadow("SR-X3", "EXIT", AT("50.000"), { outcome: "maybe" as any })),
    employeeMissing: await db.saveShadowResult(shadow("SR-X4", "EXIT", AT("50.000"), { employeeId: undefined })),
    employeeLong: await db.saveShadowResult(shadow("SR-X5", "EXIT", AT("50.000"), { employeeId: "E".repeat(65) })),
    frames: await db.saveShadowResult(shadow("SR-X6", "EXIT", AT("50.000"), { framesUsed: -1 })),
    framesFloat: await db.saveShadowResult(shadow("SR-X7", "EXIT", AT("50.000"), { framesSeen: 1.5 })),
    decidedAt: await db.saveShadowResult(shadow("SR-X8", "EXIT", "yesterday")),
    firstSeenAt: await db.saveShadowResult(shadow("SR-X9", "EXIT", AT("50.000"), { firstSeenAt: "" })),
    agreement: await db.saveShadowResult(shadow("SR-X10", "EXIT", AT("50.000"), { agreement: "kinda" as any })),
    legacyStatus: await db.saveShadowResult(shadow("SR-X11", "EXIT", AT("50.000"), { legacyStatus: "MAYBE" as any })),
    legacyLogId: await db.saveShadowResult(shadow("SR-X12", "EXIT", AT("50.000"), { legacyLogId: "L".repeat(65) })),
    basis: await db.saveShadowResult(shadow("SR-X13", "EXIT", AT("50.000"), { basis: "b".repeat(129) })),
    basisEmpty: await db.saveShadowResult(shadow("SR-X14", "EXIT", AT("50.000"), { basis: "" })),
    notAnObject: await db.saveShadowResult(null as any),
  };
  out.afterRefusals = (await walkShadow(db, 100)).ids.filter((id) => /^SR-X|^bad|^SR-xxx/.test(id)).length;
  // Values at the PostgreSQL column limits fit; malformed descriptive values are dropped, not fatal.
  out.limits = await db.saveShadowResult(shadow(LONG_SR, LONG_GATE, AT("00.500"), {
    basis: "b".repeat(128), fusionBasis: "f".repeat(129), fusedCosine: NaN, margin: 1e300, runnerUpCosine: undefined,
    firstUsableAt: "not-a-time", trackId: "t".repeat(64),
  }));
  const [limitRow] = (await db.getShadowResultsPage(null, 1, { gate: LONG_GATE })).results;
  out.limitRow = limitRow ? {
    id: limitRow.id.length, gate: limitRow.gate.length, basis: limitRow.basis.length, fusionBasis: limitRow.fusionBasis ?? null,
    fusedCosine: limitRow.fusedCosine ?? null, margin: limitRow.margin ?? null, firstUsableAt: limitRow.firstUsableAt ?? null,
    trackId: limitRow.trackId.length,
  } : null;

  // Pages: newest first by (decidedAt DESC, id DESC), strict keyset cursor.
  const first = await db.getShadowResultsPage(null, 3);
  out.firstPage = { ids: first.results.map((r) => r.id), hasMore: first.hasMore };
  out.walk3 = await walkShadow(db, 3);
  out.walk1 = (await walkShadow(db, 1)).ids;
  out.clampLow = (await db.getShadowResultsPage(null, 0)).results.length;
  const big = await db.getShadowResultsPage(null, 1000);
  out.clampHigh = { n: big.results.length, hasMore: big.hasMore };
  // Filters.
  out.gateExit = (await walkShadow(db, 100, { gate: "EXIT" })).ids;
  out.agree = (await walkShadow(db, 100, { agreement: "agree" })).ids;
  out.exitAgreeWalk2 = (await walkShadow(db, 2, { gate: "EXIT", agreement: "agree" })).ids;
  out.since38 = (await walkShadow(db, 100, { sinceIso: AT("38.000") })).ids;
  out.unknownAgreement = (await db.getShadowResultsPage(null, 10, { agreement: "kinda" as any })).results.length;
  out.unknownGate = (await db.getShadowResultsPage(null, 10, { gate: "SIDE" })).results.length;
  out.badSince = await outcome(db.getShadowResultsPage(null, 10, { sinceIso: "not-a-time" }));
  // Round trips.
  const byId = new Map((await db.getShadowResultsPage(null, 100)).results.map((r) => [r.id, r]));
  out.sr6 = byId.get("SR-6") ?? null;
  out.sr4mean = byId.get("SR-4")?.meanCheckRefused ?? null;
  out.srE2keys = Object.keys(byId.get("SR-E2") || {}).sort();
  out.sr1 = byId.get("SR-1") ?? null;

  // Summaries.
  out.summary = await db.summarizeShadowResults("2026-09-29T00:00:00.000Z");
  out.summarySince20 = await db.summarizeShadowResults(AT("20.000"));
  out.summaryFuture = await db.summarizeShadowResults("2030-01-01T00:00:00.000Z");
  out.summaryBadSince = await outcome(db.summarizeShadowResults("tomorrow"));

  // Retention purge (strict <).
  out.badCutoff = await outcome(db.purgeShadowResults("not-a-date"));
  out.purgedOld = await db.purgeShadowResults("2026-09-01T00:00:00.000Z");
  out.purgedOldAgain = await db.purgeShadowResults("2026-09-01T00:00:00.000Z");
  out.purged10 = await db.purgeShadowResults(AT("10.000"));
  out.walkAfterPurge = (await walkShadow(db, 100)).ids;
  out.summaryAfterPurge = await db.summarizeShadowResults("2026-09-29T00:00:00.000Z");
  return out;
}

/** Second process on the same store: what survived the restart. */
export async function readBackShadowScenario(db: Db): Promise<Record<string, any>> {
  return {
    mode: db.getStorageStatus().active,
    walk: (await walkShadow(db, 100)).ids,
    summary: await db.summarizeShadowResults("2026-09-29T00:00:00.000Z"),
  };
}

const SUMMARY_ENTRY = {
  gate: "ENTRY", since: "2026-09-29T00:00:00.000Z", decisions: 2, employees: 1, strangers: 0, insufficient: 1, framesUsedZero: 1,
  agree: 1, shadowOnly: 0, legacyOnly: 0, identityMismatch: 0, none: 1, decisionLatencyP50Ms: 500,
};
const SUMMARY_EXIT = {
  gate: "EXIT", since: "2026-09-29T00:00:00.000Z", decisions: 9, employees: 5, strangers: 3, insufficient: 1, framesUsedZero: 2,
  agree: 4, shadowOnly: 1, legacyOnly: 1, identityMismatch: 1, none: 2, decisionLatencyP50Ms: 2500,
};
const SUMMARY_LONG_GATE = {
  gate: LONG_GATE, since: "2026-09-29T00:00:00.000Z", decisions: 1, employees: 1, strangers: 0, insufficient: 0, framesUsedZero: 0,
  agree: 1, shadowOnly: 0, legacyOnly: 0, identityMismatch: 0, none: 0, decisionLatencyP50Ms: null,
};
const SUMMARY_AFTER_PURGE = [
  { ...SUMMARY_ENTRY, decisions: 1, employees: 0, agree: 0, decisionLatencyP50Ms: null },
  SUMMARY_EXIT,
];
const AFTER_PURGE = ["SR-8", "SR-7", "SR-DUP", "SR-E2", "SR-6", "SR-5", "SR-4", "SR-3", "SR-2", "SR-1"];

/** Expectations shared by every store (JSON, SQLite, PostgreSQL). */
export function assertShadowScenario(out: Record<string, any>, assert: Assert): void {
  const all = ["SR-8", "SR-7", "SR-DUP", "SR-E2", "SR-6", "SR-5", "SR-4", "SR-3", "SR-2", "SR-1", "SR-E1", LONG_SR, "SR-OLD"];

  assert.deepEqual(out.saved, Array(SHADOW_ROWS.length).fill(true), "every well-formed result is stored (awaited)");
  assert.equal(out.replay, true, "a replay by id succeeds...");
  assert.equal(out.sr1?.outcome, "employee", "...and the first write wins");
  assert.deepEqual(out.concurrent, Array(6).fill(true), "concurrent duplicate submissions all succeed");
  assert.deepEqual(out.invalid, {
    id: false, longId: false, gate: false, trackId: false, outcome: false, employeeMissing: false, employeeLong: false,
    frames: false, framesFloat: false, decidedAt: false, firstSeenAt: false, agreement: false, legacyStatus: false,
    legacyLogId: false, basis: false, basisEmpty: false, notAnObject: false,
  });
  assert.equal(out.afterRefusals, 0, "refused results write nothing");
  assert.equal(out.limits, true, "values at the PostgreSQL column limits fit");
  assert.deepEqual(out.limitRow, { id: 64, gate: 64, basis: 128, fusionBasis: null, fusedCosine: null, margin: null, firstUsableAt: null, trackId: 64 },
    "over-long fusionBasis, NaN/huge scores and a malformed firstUsableAt are dropped, not truncated and not fatal");

  assert.deepEqual(out.firstPage, { ids: ["SR-8", "SR-7", "SR-DUP"], hasMore: true }, "newest first; same decidedAt -> id DESC");
  assert.deepEqual(out.walk3.ids, all, "keyset pages: decidedAt DESC, id DESC, each result once (one row per concurrent id)");
  assert.equal(out.walk3.pages, 5);
  assert.deepEqual(out.walk1, all, "same order with one result per page");
  assert.equal(out.clampLow, 1);
  assert.deepEqual(out.clampHigh, { n: all.length, hasMore: false }, "limit clamps to 100 (13 rows fit)");
  assert.deepEqual(out.gateExit, ["SR-8", "SR-7", "SR-DUP", "SR-6", "SR-5", "SR-4", "SR-3", "SR-2", "SR-1"]);
  assert.deepEqual(out.agree, ["SR-8", "SR-4", "SR-3", "SR-1", "SR-E1", LONG_SR, "SR-OLD"]);
  assert.deepEqual(out.exitAgreeWalk2, ["SR-8", "SR-4", "SR-3", "SR-1"], "gate + agreement filters compose with the cursor");
  assert.deepEqual(out.since38, ["SR-8", "SR-7", "SR-DUP", "SR-E2", "SR-6"], "sinceIso is inclusive");
  assert.equal(out.unknownAgreement, 0);
  assert.equal(out.unknownGate, 0);
  assert.match(out.badSince, /invalid sinceIso/);
  assert.deepEqual(out.sr6, {
    id: "SR-6", gate: "EXIT", trackId: "exit-000042", outcome: "stranger", fusedCosine: 0.71, margin: 0.2,
    runnerUpEmployeeId: "EMP-B", runnerUpCosine: 0.51, basis: "rejected-ambiguous", fusionBasis: "rejected-ambiguous",
    meanCheckRefused: true, framesSeen: 9, framesUsed: 2, firstSeenAt: AT("00.000"), decidedAt: AT("38.000"),
    legacyLogId: "LOG-1", legacyStatus: "GRANTED", legacyEmployeeId: "EMP-A", agreement: "legacy-only", createdAt: AT("59.000"),
  }, "a refused track keeps its best candidate's scores; no employeeId");
  assert.equal(out.sr4mean, false, "an explicit false is read back as false");
  assert.deepEqual(out.srE2keys, ["agreement", "basis", "createdAt", "decidedAt", "firstSeenAt", "framesSeen", "framesUsed", "gate", "id", "outcome", "trackId"],
    "absent optionals stay absent");

  assert.deepEqual(out.summary, [SUMMARY_ENTRY, SUMMARY_EXIT, SUMMARY_LONG_GATE], "per-gate counts and the p50 of (decidedAt - firstUsableAt) over employee outcomes");
  assert.deepEqual(out.summarySince20, [
    { ...SUMMARY_ENTRY, since: AT("20.000"), decisions: 1, employees: 0, agree: 0, decisionLatencyP50Ms: null },
    { ...SUMMARY_EXIT, since: AT("20.000"), decisions: 7, employees: 3, agree: 3, identityMismatch: 0, decisionLatencyP50Ms: 5000 },
  ], "since is inclusive (SR-3 at 20.000 counts); the long-gate row is older");
  assert.deepEqual(out.summaryFuture, []);
  assert.match(out.summaryBadSince, /invalid sinceIso/);

  assert.match(out.badCutoff, /invalid cutoff/);
  assert.equal(out.purgedOld, 1, "the August result is purged");
  assert.equal(out.purgedOldAgain, 0, "purge is idempotent");
  assert.equal(out.purged10, 2, "strictly older than the cutoff: SR-E1 and the long-gate row, not SR-1 at 10.000");
  assert.deepEqual(out.walkAfterPurge, AFTER_PURGE);
  assert.deepEqual(out.summaryAfterPurge, SUMMARY_AFTER_PURGE);
}

export function assertShadowReadBack(out: Record<string, any>, assert: Assert): void {
  assert.deepEqual(out.walk, AFTER_PURGE);
  assert.deepEqual(out.summary, SUMMARY_AFTER_PURGE);
}

// ================= RECOGNISED-FACE OBSERVATIONS + ADAPTATION TEMPLATES =================

export const CROP_G1 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7, 0xff, 0xd9]);
const LONG_EMP = "E".repeat(64);

const log = (id: string, timestamp: string, over: Partial<AccessLogRecord> = {}): AccessLogRecord => ({
  id,
  timestamp,
  type: "EXIT",
  status: "DENIED",
  photoSnapshot: "data:image/jpeg;base64,/9j/frame",
  confidence: 20,
  lockAction: "Khóa giữ nguyên trạng thái LOCKED",
  doorName: "Cửa chính",
  reason: "accuracy scenario",
  ...over,
});
const granted = (employeeId: string): Partial<AccessLogRecord> => ({ status: "GRANTED", employeeId, employeeName: employeeId, employeeCode: employeeId, confidence: 90 });

export const face = (id: string, logId: string, faceIndex: number, capturedAt: string, over: Partial<StrangerFaceRecord> = {}): StrangerFaceRecord => ({
  id,
  logId,
  faceIndex,
  capturedAt,
  gate: "EXIT",
  streamId: "exit-cam",
  engine: "legacy",
  box: [100 + faceIndex, 50, 220 + faceIndex, 190],
  sourceWidth: 1920,
  sourceHeight: 1080,
  detectorScore: 0.91,
  quality: 0.62,
  sizePx: 120,
  embedding: [0.6, 0.8, 0, 0],
  modelTag: "arcface_test",
  crop: Buffer.from([0xff, 0xd8, faceIndex, 0xff, 0xd9]),
  createdAt: "2026-09-29T02:00:00.000Z",
  ...over,
});
const seen = (employeeId: string, matchCosine: number, matchMargin: number): Partial<StrangerFaceRecord> => ({ employeeId, matchCosine, matchMargin });

const template = (id: string, employeeId: string, source: string, over: Partial<FaceTemplateRecord> = {}): FaceTemplateRecord => ({
  id,
  employeeId,
  embedding: [0.6, 0.8, 0, 0],
  dims: 4,
  modelTag: "arcface_test",
  // "adaptation" is widened into FaceTemplate.source (src/types.ts) by the integrator; the stores never constrain it.
  source: source as FaceTemplateRecord["source"],
  quality: 0.7,
  capturedAt: "2026-09-29T01:00:00.100Z",
  streamId: "exit-cam",
  ...over,
});

async function walkFaces(db: Db, limit: number) {
  const ids: string[] = [];
  let cursor: { capturedAt: string; id: string } | null = null;
  for (let i = 0; i < 50; i++) {
    const page = await db.getStrangerFacesPage(cursor, limit);
    ids.push(...page.faces.map((f) => f.id));
    if (!page.hasMore || !page.faces.length) break;
    const last = page.faces[page.faces.length - 1];
    cursor = { capturedAt: last.capturedAt, id: last.id };
  }
  return ids;
}

const obsView = (f: StrangerFaceRecord) => ({
  id: f.id, employeeId: f.employeeId ?? null, matchCosine: round1(f.matchCosine), matchMargin: round1(f.matchMargin),
  embedding: round(f.embedding), hasCrop: "crop" in f, purged: Boolean(f.purgedAt),
});

export async function runObservationScenario(db: Db): Promise<Record<string, any>> {
  const out: Record<string, any> = { mode: db.getStorageStatus().active };

  for (const l of [
    log("LOG-GOLD", "2026-09-01T08:00:00.000Z", granted("EMP-A")),
    log("LOG-G1", "2026-09-29T01:00:00.000Z", granted("EMP-A")),
    log("LOG-D1", "2026-09-29T01:00:05.000Z"),
    log("LOG-G2", "2026-09-29T01:00:10.000Z", granted("EMP-B")),
  ]) {
    if (!(await db.saveAccessLog(l))) throw new Error(`access log ${l.id} not saved`);
  }

  // One GRANTED frame with the recognised employee AND a stranger; a DENIED
  // frame; a frame with two recognised employees; an old observation.
  const T1 = "2026-09-29T01:00:00.100Z";
  const T2 = "2026-09-29T01:00:10.100Z";
  const batch = [
    face("SF-G1-0", "LOG-G1", 0, T1, { ...seen("EMP-A", 0.71, 0.2), crop: CROP_G1 }),
    face("SF-G1-1", "LOG-G1", 1, T1, { matchCosine: 0.31 }),
    face("SF-D1-0", "LOG-D1", 0, "2026-09-29T01:00:05.100Z"),
    face("SF-G2-0", "LOG-G2", 0, T2, seen("EMP-B", 0.66, 0.12)),
    face("SF-G2-1", "LOG-G2", 1, T2, seen("EMP-A", 0.8, 0.3)),
    face("SF-GOLD-0", "LOG-GOLD", 0, "2026-09-01T08:00:00.100Z", seen("EMP-A", 0.9, 0.4)),
  ];
  out.saved = await db.saveStrangerFaces(batch);
  out.replay = await db.saveStrangerFaces(batch);
  out.invalid = {
    noScores: await db.saveStrangerFaces([face("SF-R1", "LOG-G1", 5, T1, { employeeId: "EMP-A" })]),
    halfScores: await db.saveStrangerFaces([face("SF-R2", "LOG-G1", 5, T1, { employeeId: "EMP-A", matchCosine: 0.7, matchMargin: NaN })]),
    badEmployee: await db.saveStrangerFaces([face("SF-R3", "LOG-G1", 5, T1, seen("a b", 0.7, 0.2))]),
    longEmployee: await db.saveStrangerFaces([face("SF-R4", "LOG-G1", 5, T1, seen("E".repeat(65), 0.7, 0.2))]),
  };
  out.afterRefusals = (await db.getStrangerFacesByIds(["SF-R1", "SF-R2", "SF-R3", "SF-R4"])).length;
  out.limits = await db.saveStrangerFaces([face("SF-L1", "LOG-G1", 6, "2026-09-29T01:00:00.050Z", seen(LONG_EMP, -0.5, 0))]);
  const [l1] = await db.getStrangerFacesByIds(["SF-L1"]);
  out.limitRow = l1 ? { employeeId: l1.employeeId?.length, matchCosine: l1.matchCosine, matchMargin: l1.matchMargin } : null;

  // Grouping pages never see observations; direct lookups do.
  out.page = await walkFaces(db, 100);
  out.pageKeyset = await walkFaces(db, 1);
  out.byIds = (await db.getStrangerFacesByIds(["SF-G1-0", "SF-G2-1", "SF-G1-1"])).map(obsView).sort((a, b) => a.id.localeCompare(b.id));
  out.byLogIds = (await db.getStrangerFacesByLogIds(["LOG-G1"])).map((f) => `${f.id}#${f.faceIndex}`);
  out.cropG1 = (await db.getStrangerFaceCrop("SF-G1-0"))?.toString("hex") ?? null;
  out.g1_1keys = Object.keys((await db.getStrangerFacesByIds(["SF-G1-1"]))[0] || {}).filter((k) => /^(employeeId|matchCosine|matchMargin)$/.test(k));

  // Observations for camera adaptation.
  const since = "2026-09-29T00:00:00.000Z";
  const obs = await db.getRecognisedFaceObservations(since);
  out.obs = obs.map(obsView);
  out.obsEmpA = (await db.getRecognisedFaceObservations(since, "EMP-A")).map((f) => f.id);
  out.obsLimit1 = (await db.getRecognisedFaceObservations(since, undefined, 1)).map((f) => f.id);
  out.obsClampLow = (await db.getRecognisedFaceObservations(since, undefined, 0)).length;
  out.obsClampHigh = (await db.getRecognisedFaceObservations(since, undefined, 5000)).length;
  out.obsAll = (await db.getRecognisedFaceObservations("2026-01-01T00:00:00.000Z")).map((f) => f.id);
  out.obsUnknownEmployee = (await db.getRecognisedFaceObservations(since, "nobody")).length;
  out.obsBadEmployee = (await db.getRecognisedFaceObservations(since, "a b")).length;
  out.obsBadSince = await outcome(db.getRecognisedFaceObservations("last week"));

  // Retention applies to observations exactly as to stranger faces.
  out.purged = await db.purgeStrangerFaces("2026-09-15T00:00:00.000Z", new Set());
  out.obsAfterPurge = (await db.getRecognisedFaceObservations("2026-01-01T00:00:00.000Z")).map((f) => f.id);
  out.gold = (await db.getStrangerFacesByIds(["SF-GOLD-0"])).map(obsView)[0] ?? null;
  out.cropGold = (await db.getStrangerFaceCrop("SF-GOLD-0")) ?? null;

  // Adaptation templates round-trip like any other source and are counted per camera.
  db.saveFaceTemplate(template("T-1", "EMP-A", "adaptation", { sourceLogId: "LOG-G1" }));
  db.saveFaceTemplate(template("T-2", "EMP-A", "enrollment", { streamId: undefined }));
  db.saveFaceTemplate(template("T-3", "EMP-A", "adaptation", { quality: 0.6, sourceLogId: "LOG-G2" }));
  db.saveFaceTemplate(template("T-4", "EMP-B", "merge", { streamId: "entry-cam" }));
  db.saveFaceTemplate(template("T-5", "EMP-A", "adaptation", { streamId: "entry-cam" }));
  out.counts = await db.countFaceTemplatesByEmployeeAndStream();
  out.sourcesA = db.getFaceTemplatesForEmployee("EMP-A").map((t) => t.source).sort();
  out.deleteAdaptation = db.deleteFaceTemplate("T-3");
  out.deleteUnknown = db.deleteFaceTemplate("T-nope");
  out.countsAfterDelete = await db.countFaceTemplatesByEmployeeAndStream();
  // saveFaceTemplate/deleteFaceTemplate answer their callers before PostgreSQL has the row; the
  // writes run in issue order and a job that needs durability awaits them.
  await db.settleFaceTemplateWrites();
  return out;
}

export async function readBackObservationScenario(db: Db): Promise<Record<string, any>> {
  return {
    mode: db.getStorageStatus().active,
    page: await walkFaces(db, 100),
    obs: (await db.getRecognisedFaceObservations("2026-01-01T00:00:00.000Z")).map((f) => f.id),
    gold: (await db.getStrangerFacesByIds(["SF-GOLD-0"])).map(obsView)[0] ?? null,
    templates: db.getFaceTemplates().map((t) => `${t.id}:${t.source}:${t.streamId || "-"}`).sort(),
    counts: await db.countFaceTemplatesByEmployeeAndStream(),
  };
}

const COUNTS = [
  { employeeId: "EMP-A", streamId: null, source: "enrollment", count: 1 },
  { employeeId: "EMP-A", streamId: "entry-cam", source: "adaptation", count: 1 },
  { employeeId: "EMP-A", streamId: "exit-cam", source: "adaptation", count: 2 },
  { employeeId: "EMP-B", streamId: "entry-cam", source: "merge", count: 1 },
];
const COUNTS_AFTER_DELETE = COUNTS.map((c) => (c.streamId === "exit-cam" ? { ...c, count: 1 } : c));
const GOLD_TOMBSTONE = { id: "SF-GOLD-0", employeeId: "EMP-A", matchCosine: 0.9, matchMargin: 0.4, embedding: null, hasCrop: false, purged: true };

export function assertObservationScenario(out: Record<string, any>, assert: Assert): void {
  assert.equal(out.saved, true, "observations and strangers of one frame are stored together");
  assert.equal(out.replay, true);
  assert.deepEqual(out.invalid, { noScores: false, halfScores: false, badEmployee: false, longEmployee: false },
    "an observation without both match scores, or with an employeeId the column cannot hold, refuses the batch");
  assert.equal(out.afterRefusals, 0);
  assert.equal(out.limits, true);
  assert.deepEqual(out.limitRow, { employeeId: 64, matchCosine: -0.5, matchMargin: 0 }, "a zero margin survives");

  assert.deepEqual(out.page, ["SF-D1-0", "SF-G1-1"], "grouping pages exclude recognised faces (GRANTED frame's stranger still listed)");
  assert.deepEqual(out.pageKeyset, ["SF-D1-0", "SF-G1-1"]);
  assert.deepEqual(out.byIds, [
    { id: "SF-G1-0", employeeId: "EMP-A", matchCosine: 0.71, matchMargin: 0.2, embedding: [0.6, 0.8, 0, 0], hasCrop: false, purged: false },
    { id: "SF-G1-1", employeeId: null, matchCosine: null, matchMargin: null, embedding: [0.6, 0.8, 0, 0], hasCrop: false, purged: false },
    { id: "SF-G2-1", employeeId: "EMP-A", matchCosine: 0.8, matchMargin: 0.3, embedding: [0.6, 0.8, 0, 0], hasCrop: false, purged: false },
  ], "byIds returns observations with their scores; a stranger's stray matchCosine is not stored");
  assert.deepEqual(out.byLogIds, ["SF-G1-0#0", "SF-G1-1#1", "SF-L1#6"], "byLogIds returns the whole frame, observations included");
  assert.equal(out.cropG1, CROP_G1.toString("hex"), "the crop of a recognised face is served");
  assert.deepEqual(out.g1_1keys, [], "a stranger face carries none of the observation keys");

  assert.deepEqual(out.obs.map((o: any) => o.id), ["SF-G2-1", "SF-G2-0", "SF-G1-0", "SF-L1"], "newest first by (capturedAt DESC, id DESC)");
  assert.ok(out.obs.every((o: any) => o.employeeId && o.embedding?.length === 4 && !o.hasCrop && !o.purged), "embedding included, crop excluded");
  assert.deepEqual(out.obsEmpA, ["SF-G2-1", "SF-G1-0"]);
  assert.deepEqual(out.obsLimit1, ["SF-G2-1"]);
  assert.equal(out.obsClampLow, 1);
  assert.equal(out.obsClampHigh, 4);
  assert.deepEqual(out.obsAll, ["SF-G2-1", "SF-G2-0", "SF-G1-0", "SF-L1", "SF-GOLD-0"]);
  assert.equal(out.obsUnknownEmployee, 0);
  assert.equal(out.obsBadEmployee, 0, "an employeeId the column cannot hold matches nothing");
  assert.match(out.obsBadSince, /invalid since/);

  assert.equal(out.purged, 1, "retention purges observations on the same clock");
  assert.deepEqual(out.obsAfterPurge, ["SF-G2-1", "SF-G2-0", "SF-G1-0", "SF-L1"], "purged observations are excluded");
  assert.deepEqual(out.gold, GOLD_TOMBSTONE, "the tombstone keeps who was seen and the scores, never the embedding");
  assert.equal(out.cropGold, null);

  assert.deepEqual(out.counts, COUNTS, "counts per (employee, camera, source); no camera -> null");
  assert.deepEqual(out.sourcesA, ["adaptation", "adaptation", "adaptation", "enrollment"]);
  assert.equal(out.deleteAdaptation, true, "an adaptation template is deletable like any other");
  assert.equal(out.deleteUnknown, false);
  assert.deepEqual(out.countsAfterDelete, COUNTS_AFTER_DELETE);
}

export function assertObservationReadBack(out: Record<string, any>, assert: Assert): void {
  assert.deepEqual(out.page, ["SF-D1-0", "SF-G1-1"]);
  assert.deepEqual(out.obs, ["SF-G2-1", "SF-G2-0", "SF-G1-0", "SF-L1"]);
  assert.deepEqual(out.gold, GOLD_TOMBSTONE);
  assert.deepEqual(out.templates, ["T-1:adaptation:exit-cam", "T-2:enrollment:-", "T-4:merge:entry-cam", "T-5:adaptation:entry-cam"],
    "adaptation templates survive a restart with their source and camera");
  assert.deepEqual(out.counts, COUNTS_AFTER_DELETE);
}

// ================= MIGRATION / ROLLBACK HELPERS =================

/** What the stores hold, without writing anything (migration checks on databases from the previous release). */
export async function storeOnly(db: Db): Promise<Record<string, any>> {
  const faces = await db.getStrangerFacesByLogIds(["LOG-OLD-1"]);
  return {
    mode: db.getStorageStatus().active,
    page: await walkFaces(db, 100),
    oldFaces: faces.map((f) => ({ id: f.id, employeeId: f.employeeId ?? null, matchCosine: f.matchCosine ?? null, embedding: f.embedding?.length ?? 0 })),
    obs: (await db.getRecognisedFaceObservations("2000-01-01T00:00:00.000Z")).map((f) => f.id),
    shadow: (await db.getShadowResultsPage(null, 100)).results.map((r) => r.id),
    summary: await db.summarizeShadowResults("2000-01-01T00:00:00.000Z"),
    templates: db.getFaceTemplates().map((t) => `${t.id}:${t.source}`),
  };
}

/**
 * PostgreSQL configured but not reachable yet: shadow results and observations
 * are refused (never parked in a local store the gateway stops reading once
 * connected) and reads are empty, while the access event is still kept locally.
 */
export async function whileConnectingAccuracy(db: Db): Promise<Record<string, any>> {
  const mode = db.getStorageStatus().active;
  const logSaved = await db.saveAccessLog(log("LOG-CONN", "2026-09-29T01:00:00.000Z", granted("EMP-A")));
  return {
    mode,
    logSaved,
    faceSaved: await db.saveStrangerFaces([face("SF-CONN", "LOG-CONN", 0, "2026-09-29T01:00:00.100Z", seen("EMP-A", 0.7, 0.2))]),
    obs: (await db.getRecognisedFaceObservations("2026-01-01T00:00:00.000Z")).length,
    shadowSaved: await db.saveShadowResult(shadow("SR-CONN", "EXIT", AT("01.000"))),
    shadowPage: (await db.getShadowResultsPage(null, 10)).results.length,
    summary: await db.summarizeShadowResults("2026-01-01T00:00:00.000Z"),
    purged: await db.purgeShadowResults("2030-01-01T00:00:00.000Z"),
  };
}
