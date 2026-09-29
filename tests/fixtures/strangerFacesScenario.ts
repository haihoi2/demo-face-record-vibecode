/**
 * One behavioural scenario for the per-face stranger store (src/server/db.ts,
 * StrangerFaceStore + faceIds on resolutions), run unchanged against the JSON
 * fallback, native SQLite and PostgreSQL. Each run starts on an EMPTY store and
 * returns a JSON-able summary; tests/strangerFacesStore.test.ts and
 * tests/integration/strangerFacesPersistence.test.ts assert on it with the
 * same expectations, so the three stores are held to identical semantics.
 *
 * Crops and embeddings here are synthetic bytes/vectors, never biometric data.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { StrangerFaceRecord } from "../../src/server/strangerFaces";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DB_MODULE = fileURLToPath(new URL("../../src/server/db.ts", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/**
 * Boot the storage layer in a fresh process (it is a singleton bound to
 * DATA_DIR/DATABASE_URL at import) and run one exported function of this
 * module against it. EXPECT_PG=1 waits for the PostgreSQL sync first.
 */
export function runScenarioChild(
  fn: "runStrangerFaceScenario" | "readBackStrangerFaceScenario" | "clearAndCount" | "resolutionsOnly" | "whileConnecting",
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

/** Resolutions as stored (used by the migration checks). */
export async function resolutionsOnly(db: Db): Promise<Record<string, any>> {
  return {
    mode: db.getStorageStatus().active,
    resolutions: db.getStrangerResolutions().sort((a, b) => a.clusterId.localeCompare(b.clusterId)),
    events: db.getStrangerResolutionEvents(),
    retired: db.getRetiredStrangerObservationIds().slice().sort(),
  };
}

type Db = typeof import("../../src/server/db").db;
type AccessLogRecord = import("../../src/server/db").AccessLogRecord;

export const CROP_A0 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9]);

const log = (id: string, timestamp: string, over: Partial<AccessLogRecord> = {}): AccessLogRecord => ({
  id,
  timestamp,
  type: "ENTRY",
  status: "DENIED",
  photoSnapshot: "data:image/jpeg;base64,/9j/frame",
  confidence: 20,
  lockAction: "Khóa giữ nguyên trạng thái LOCKED",
  doorName: "Cửa chính",
  reason: "per-face scenario",
  ...over,
});

export const face = (id: string, logId: string, faceIndex: number, capturedAt: string, over: Partial<StrangerFaceRecord> = {}): StrangerFaceRecord => ({
  id,
  logId,
  faceIndex,
  capturedAt,
  gate: "ENTRY",
  streamId: "entry-main",
  engine: "legacy",
  box: [100 + faceIndex, 50, 220 + faceIndex, 190],
  sourceWidth: 3840,
  sourceHeight: 2160,
  detectorScore: 0.91,
  quality: 0.62,
  edgeEnergy: 0.3,
  sizePx: 120,
  embedding: [0.6, 0.8, 0, 0],
  modelTag: "arcface_test",
  crop: Buffer.from([0xff, 0xd8, faceIndex, 0xff, 0xd9]),
  createdAt: "2026-09-29T02:00:00.000Z",
  ...over,
});

const round = (xs: number[] | undefined) => (xs ? xs.map((v) => Math.round(v * 1000) / 1000) : null);

async function walkFaces(db: Db, limit: number) {
  const ids: string[] = [];
  let cursor: { capturedAt: string; id: string } | null = null;
  let pages = 0;
  let sawCrop = false;
  for (;;) {
    const page = await db.getStrangerFacesPage(cursor, limit);
    pages += 1;
    for (const f of page.faces) {
      ids.push(f.id);
      if ("crop" in f) sawCrop = true;
    }
    if (!page.hasMore || !page.faces.length || pages > 50) break;
    const last = page.faces[page.faces.length - 1];
    cursor = { capturedAt: last.capturedAt, id: last.id };
  }
  return { ids, pages, sawCrop };
}

async function walkCandidates(db: Db, limit: number) {
  const ids: string[] = [];
  let cursor: { timestamp: string; id: string } | null = null;
  for (let i = 0; i < 50; i++) {
    const page = await db.getStrangerCandidateLogsPage(cursor, limit);
    ids.push(...page.logs.map((l) => l.id));
    if (!page.hasMore || !page.logs.length) break;
    const last = page.logs[page.logs.length - 1];
    cursor = { timestamp: last.timestamp, id: last.id };
  }
  return ids;
}

const outcome = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e: any) {
    return String(e?.message || e);
  }
};

export async function runStrangerFaceScenario(db: Db): Promise<Record<string, any>> {
  const out: Record<string, any> = { mode: db.getStorageStatus().active };

  // Access events (immutable facts), written oldest first so the JSON
  // fallback's insertion-ordered candidate list matches the SQL order.
  // LOG-C, LOG-D and LOG-G are legacy stranger logs with no faces.
  for (const l of [
    log("LOG-OLD", "2026-09-01T08:00:00.000Z", { type: "EXIT" }),
    log("LOG-G", "2026-09-02T00:00:00.000Z"),
    log("LOG-A", "2026-09-29T01:00:00.000Z"),
    log("LOG-B", "2026-09-29T01:00:05.000Z", { status: "GRANTED", employeeId: "EMP-1", employeeName: "Nguyễn Văn A", employeeCode: "NV001" }),
    log("LOG-C", "2026-09-29T01:00:10.000Z"),
    log("LOG-D", "2026-09-29T01:00:15.000Z"),
    log("LOG-E", "2026-09-29T01:00:20.000Z"),
  ]) {
    if (!(await db.saveAccessLog(l))) throw new Error(`access log ${l.id} not saved`);
  }

  const T_A = "2026-09-29T01:00:00.100Z";
  const batch = [
    face("SF-A0", "LOG-A", 0, T_A, { crop: CROP_A0, trackId: "entry-000017" }),
    face("SF-A1", "LOG-A", 1, T_A, { embedding: [0, 0, 0.6, 0.8] }),
    face("SF-B0", "LOG-B", 0, "2026-09-29T01:00:05.100Z", { gate: "ENTRY" }),
  ];
  out.saved = await db.saveStrangerFaces(batch);
  out.replay = await db.saveStrangerFaces(batch);
  // A writer retrying the same frame with fresh ids: slots already filled, nothing new.
  out.retryFreshIds = await db.saveStrangerFaces([face("SF-A0-retry", "LOG-A", 0, T_A), face("SF-A1-retry", "LOG-A", 1, T_A)]);
  out.logAFaces = (await db.getStrangerFacesByLogIds(["LOG-A"])).map((f) => `${f.id}#${f.faceIndex}`);

  // Old faces for the retention purge. SF-OLD-2 has no crop (missing image).
  out.savedOld = await db.saveStrangerFaces([
    face("SF-OLD-0", "LOG-OLD", 0, "2026-09-01T08:00:00.100Z", { gate: "EXIT", engine: "pipeline", trackId: "exit-000001" }),
    face("SF-OLD-1", "LOG-OLD", 1, "2026-09-01T08:00:00.100Z", { gate: "EXIT" }),
    face("SF-OLD-2", "LOG-OLD", 2, "2026-09-01T08:00:00.200Z", { gate: "EXIT", crop: undefined, embedding: undefined, modelTag: undefined }),
  ]);

  // Concurrent duplicate submissions of one face slot (same id and fresh ids).
  out.concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    db.saveStrangerFaces([face(i < 4 ? "SF-E0" : `SF-E0-${i}`, "LOG-E", 0, "2026-09-29T01:00:20.100Z")])));
  const eFaces = await db.getStrangerFacesByLogIds(["LOG-E"]);
  out.logEFaces = eFaces.length;
  out.eWinner = eFaces[0]?.id;

  // Refusals: all-or-nothing batches.
  out.unknownLog = await db.saveStrangerFaces([
    face("SF-A5", "LOG-A", 5, T_A),
    face("SF-MISSING", "LOG-MISSING", 0, T_A),
  ]);
  out.invalid = {
    longId: await db.saveStrangerFaces([face("SF-" + "x".repeat(62), "LOG-A", 6, T_A)]),
    gate: await db.saveStrangerFaces([face("SF-G", "LOG-A", 6, T_A, { gate: "SIDE" as any })]),
    box: await db.saveStrangerFaces([face("SF-BOX", "LOG-A", 6, T_A, { box: [1, 2, 3] as any })]),
    modelTag: await db.saveStrangerFaces([face("SF-MT", "LOG-A", 6, T_A, { modelTag: "m".repeat(129) })]),
    capturedAt: await db.saveStrangerFaces([face("SF-T", "LOG-A", 6, "yesterday")]),
    nanEmbedding: await db.saveStrangerFaces([face("SF-NAN", "LOG-A", 6, T_A, { embedding: [NaN, 1] })]),
    notAList: await db.saveStrangerFaces(null as any),
  };
  out.afterRefusals = (await db.getStrangerFacesByIds(["SF-A5", "SF-MISSING", "SF-G", "SF-BOX", "SF-MT", "SF-T", "SF-NAN"])).length;
  // Values at the PostgreSQL column limits fit; a malformed descriptive field is dropped, not fatal.
  out.limits = await db.saveStrangerFaces([
    face("SF-" + "L".repeat(61), "LOG-A", 7, "2026-09-29T08:00:00.050+07:00", {
      streamId: "s".repeat(64), trackId: "t".repeat(65), modelTag: "m".repeat(128), sizePx: 60.4,
    }),
  ]);
  const [limitRow] = await db.getStrangerFacesByIds(["SF-" + "L".repeat(61)]);
  out.limitRow = limitRow ? { streamId: limitRow.streamId?.length, trackId: limitRow.trackId ?? null, modelTag: limitRow.modelTag?.length, sizePx: limitRow.sizePx } : null;

  // Pages: newest first by (capturedAt DESC, id DESC), no crop, embedding decoded.
  const first = await db.getStrangerFacesPage(null, 2);
  out.firstPage = { ids: first.faces.map((f) => f.id), hasMore: first.hasMore };
  out.walk2 = await walkFaces(db, 2);
  out.walk1 = (await walkFaces(db, 1)).ids;
  out.clampLow = (await db.getStrangerFacesPage(null, 0)).faces.length;
  out.clampHigh = (await db.getStrangerFacesPage(null, 1000)).faces.length;
  const a0 = (await db.getStrangerFacesByIds(["SF-A0"]))[0];
  out.a0 = a0 && {
    ...a0,
    embedding: round(a0.embedding),
    hasCrop: "crop" in a0,
  };
  out.byIds = (await db.getStrangerFacesByIds(["SF-B0", "SF-NOPE", "SF-A1", "SF-B0", 42 as any])).map((f) => f.id).sort();
  out.byIdsEmpty = (await db.getStrangerFacesByIds([])).length;

  // Crops.
  const crop = await db.getStrangerFaceCrop("SF-A0");
  out.cropA0 = crop ? crop.toString("hex") : null;
  out.cropIsBuffer = Buffer.isBuffer(crop);
  out.cropUnknown = (await db.getStrangerFaceCrop("SF-NOPE")) ?? null;
  out.cropMissingImage = (await db.getStrangerFaceCrop("SF-OLD-2")) ?? null;

  // Candidate logs: logs with face rows are represented by their faces.
  out.candidates = await walkCandidates(db, 50);
  out.candidatesKeyset = await walkCandidates(db, 1);

  // Retention purge.
  out.badCutoff = await outcome(db.purgeStrangerFaces("not-a-date", new Set()));
  out.purged = await db.purgeStrangerFaces("2026-09-15T00:00:00.000Z", new Set(["SF-OLD-0"]));
  out.purgedAgain = await db.purgeStrangerFaces("2026-09-15T00:00:00.000Z", new Set(["SF-OLD-0"]));
  const old = await db.getStrangerFacesByIds(["SF-OLD-0", "SF-OLD-1", "SF-OLD-2"]);
  out.old = Object.fromEntries(old.map((f) => [f.id, {
    purged: Boolean(f.purgedAt), embedding: f.embedding ? f.embedding.length : 0, dims: f.dims ?? null,
    modelTag: f.modelTag ?? null, box: f.box, logId: f.logId,
  }]));
  out.cropPurged = (await db.getStrangerFaceCrop("SF-OLD-1")) ?? null;
  out.cropKept = Boolean(await db.getStrangerFaceCrop("SF-OLD-0"));
  out.walkAfterPurge = (await walkFaces(db, 3)).ids;
  out.candidatesAfterPurge = await walkCandidates(db, 50);

  // Resolutions with faceIds.
  const base = {
    clusterId: "SC-face-1", action: "DISMISS" as const, actor: "itest-operator", resolvedAt: "2026-09-29T03:00:00.000Z",
    logIds: [] as string[], metadata: { intent: { reason: "not a person" } },
  };
  const created = await db.commitStrangerResolution({ resolution: { ...base, id: "RES-face-1", faceIds: ["SF-A1", "SF-A0"] } });
  out.commit = { status: created.status, faceIds: created.resolution.faceIds };
  out.commitReplay = (await db.commitStrangerResolution({ resolution: { ...base, id: "RES-face-1b", faceIds: ["SF-A0", "SF-A1"] } })).status;
  out.commitFewerFaces = (await db.commitStrangerResolution({ resolution: { ...base, id: "RES-face-1c", faceIds: ["SF-A0"] } })).status;
  out.commitNoFaces = (await db.commitStrangerResolution({ resolution: { ...base, id: "RES-face-1d" } })).status;
  out.commitExtraLog = (await db.commitStrangerResolution({ resolution: { ...base, id: "RES-face-1e", logIds: ["LOG-C"], faceIds: ["SF-A0", "SF-A1"] } })).status;
  // Concurrent first commits of one cluster with different membership: exactly one wins.
  const race = await Promise.all([
    db.commitStrangerResolution({ resolution: { ...base, clusterId: "SC-race", id: "RES-race-1", faceIds: ["SF-B0"] } }),
    db.commitStrangerResolution({ resolution: { ...base, clusterId: "SC-race", id: "RES-race-2", faceIds: ["SF-E0"] } }),
  ]);
  out.race = race.map((r) => r.status).sort();
  out.raceStored = db.getStrangerResolution("SC-race")?.id;
  // A log-only (legacy) adjudication, as old clients send it.
  const legacy = await db.commitStrangerResolution({ resolution: { ...base, clusterId: "SC-log-1", id: "RES-log-1", logIds: ["LOG-C"] } });
  out.legacyCommit = { status: legacy.status, faceIds: legacy.resolution.faceIds };
  out.retired = db.getRetiredStrangerObservationIds().slice().sort();

  out.restoreWrongFaces = await outcome(db.restoreStrangerResolution({
    id: "RESTORE-1", clusterId: "SC-face-1", action: "RESTORE", actor: "itest-operator", resolvedAt: "2026-09-29T04:00:00.000Z",
    logIds: [], faceIds: ["SF-A0"],
  }));
  out.restoreNoFaces = await outcome(db.restoreStrangerResolution({
    id: "RESTORE-2", clusterId: "SC-face-1", action: "RESTORE", actor: "itest-operator", resolvedAt: "2026-09-29T04:00:00.000Z",
    logIds: [],
  }));
  out.restore = await outcome(db.restoreStrangerResolution({
    id: "RESTORE-3", clusterId: "SC-face-1", action: "RESTORE", actor: "itest-operator", resolvedAt: "2026-09-29T04:00:01.000Z",
    logIds: [], faceIds: ["SF-A1", "SF-A0"],
  }));
  out.retiredAfterRestore = db.getRetiredStrangerObservationIds().slice().sort();
  out.events = db.getStrangerResolutionEvents("SC-face-1").map((e) => ({ id: e.id, action: e.action, faceIds: e.faceIds, logIds: e.logIds }));
  // Re-dismissing after the restore is a new adjudication.
  out.recommit = (await db.commitStrangerResolution({ resolution: {
    ...base, id: "RES-face-2", resolvedAt: "2026-09-29T05:00:00.000Z", faceIds: ["SF-A0"],
  } })).status;
  return out;
}

/** Second process on the same store: what survived the restart. */
export async function readBackStrangerFaceScenario(db: Db): Promise<Record<string, any>> {
  return {
    mode: db.getStorageStatus().active,
    walk: (await walkFaces(db, 100)).ids,
    cropA0: (await db.getStrangerFaceCrop("SF-A0"))?.toString("hex") ?? null,
    old1: (await db.getStrangerFacesByIds(["SF-OLD-1"]))[0]?.purgedAt ? "purged" : "not-purged",
    resolution: db.getStrangerResolution("SC-face-1"),
    retired: db.getRetiredStrangerObservationIds().slice().sort(),
    events: db.getStrangerResolutionEvents("SC-face-1").map((e) => ({ id: e.id, faceIds: e.faceIds })),
    candidates: (await db.getStrangerCandidateLogsPage(null, 50)).logs.map((l) => l.id),
  };
}

/** clearAccessLogs takes the faces of those events with it. */
export async function clearAndCount(db: Db): Promise<Record<string, any>> {
  db.clearAccessLogs();
  let left = -1;
  for (let i = 0; i < 50; i++) {
    left = (await db.getStrangerFacesByIds(["SF-A0", "SF-A1", "SF-B0", "SF-OLD-0", "SF-E0"])).length;
    if (left === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { left };
}

const LONG_ID = "SF-" + "L".repeat(61);

/** Expectations shared by every store (JSON, SQLite, PostgreSQL). */
export function assertStrangerFaceScenario(out: Record<string, any>, assert: typeof import("node:assert/strict")): void {
  const E = out.eWinner;
  assert.match(String(E), /^SF-E0(-[4-7])?$/);

  // Writes: durable, idempotent, all-or-nothing.
  assert.equal(out.saved, true);
  assert.equal(out.replay, true, "a replay of the same batch succeeds");
  assert.equal(out.retryFreshIds, true, "a retry of the frame with fresh ids succeeds...");
  assert.deepEqual(out.logAFaces, ["SF-A0#0", "SF-A1#1"], "...without duplicating its faces");
  assert.equal(out.savedOld, true);
  assert.deepEqual(out.concurrent, Array(8).fill(true), "concurrent duplicate submissions all succeed");
  assert.equal(out.logEFaces, 1, "...and store exactly one face for the slot");
  assert.equal(out.unknownLog, false, "a face of an unknown access event refuses the batch");
  assert.deepEqual(out.invalid, {
    longId: false, gate: false, box: false, modelTag: false, capturedAt: false, nanEmbedding: false, notAList: false,
  });
  assert.equal(out.afterRefusals, 0, "refused batches write nothing (the valid face in a refused batch included)");
  assert.equal(out.limits, true, "values at the PostgreSQL column limits fit");
  assert.deepEqual(out.limitRow, { streamId: 64, trackId: null, modelTag: 128, sizePx: 60 },
    "an over-long trackId is dropped, not truncated and not fatal; sizePx is an integer");

  // Pages.
  const all = [E, "SF-B0", "SF-A1", "SF-A0", LONG_ID, "SF-OLD-2", "SF-OLD-1", "SF-OLD-0"];
  assert.deepEqual(out.firstPage, { ids: [E, "SF-B0"], hasMore: true });
  assert.deepEqual(out.walk2.ids, all, "keyset pages: capturedAt DESC, id DESC, each face once");
  assert.equal(out.walk2.pages, 4);
  assert.equal(out.walk2.sawCrop, false, "pages never carry the crop");
  assert.deepEqual(out.walk1, all, "same order with one face per page");
  assert.equal(out.clampLow, 1);
  assert.equal(out.clampHigh, all.length);
  assert.deepEqual(out.a0, {
    id: "SF-A0", logId: "LOG-A", faceIndex: 0, capturedAt: "2026-09-29T01:00:00.100Z", gate: "ENTRY",
    streamId: "entry-main", engine: "legacy", trackId: "entry-000017", box: [100, 50, 220, 190],
    sourceWidth: 3840, sourceHeight: 2160, detectorScore: 0.91, quality: 0.62, edgeEnergy: 0.3, sizePx: 120,
    embedding: [0.6, 0.8, 0, 0], dims: 4, modelTag: "arcface_test", createdAt: "2026-09-29T02:00:00.000Z",
    hasCrop: false,
  });
  assert.deepEqual(out.byIds, ["SF-A1", "SF-B0"], "unknown and non-string ids are skipped, duplicates collapse");
  assert.equal(out.byIdsEmpty, 0);

  // Crops.
  assert.equal(out.cropA0, CROP_A0.toString("hex"));
  assert.equal(out.cropIsBuffer, true);
  assert.equal(out.cropUnknown, null);
  assert.equal(out.cropMissingImage, null, "a face stored without a crop has no image");

  // Candidate logs exclude events that have faces.
  assert.deepEqual(out.candidates, ["LOG-D", "LOG-C", "LOG-G"]);
  assert.deepEqual(out.candidatesKeyset, ["LOG-D", "LOG-C", "LOG-G"]);

  // Retention purge.
  assert.match(out.badCutoff, /invalid cutoff/);
  assert.equal(out.purged, 2, "old faces purged, keepIds honoured");
  assert.equal(out.purgedAgain, 0, "purge is idempotent");
  assert.deepEqual(out.old, {
    "SF-OLD-0": { purged: false, embedding: 4, dims: 4, modelTag: "arcface_test", box: [100, 50, 220, 190], logId: "LOG-OLD" },
    "SF-OLD-1": { purged: true, embedding: 0, dims: 4, modelTag: "arcface_test", box: [101, 50, 221, 190], logId: "LOG-OLD" },
    "SF-OLD-2": { purged: true, embedding: 0, dims: null, modelTag: null, box: [102, 50, 222, 190], logId: "LOG-OLD" },
  }, "purged rows stay as tombstones without embedding");
  assert.equal(out.cropPurged, null, "a purged face has no crop");
  assert.equal(out.cropKept, true);
  assert.deepEqual(out.walkAfterPurge, [E, "SF-B0", "SF-A1", "SF-A0", LONG_ID, "SF-OLD-0"], "purged faces leave the pages");
  assert.deepEqual(out.candidatesAfterPurge, ["LOG-D", "LOG-C", "LOG-G"], "a purged face still represents its event");

  // Resolutions with faceIds.
  assert.deepEqual(out.commit, { status: "created", faceIds: ["SF-A0", "SF-A1"] }, "faceIds stored sorted");
  assert.equal(out.commitReplay, "replay", "same members in another order is a replay");
  assert.equal(out.commitFewerFaces, "conflict", "other face members is a conflict");
  assert.equal(out.commitNoFaces, "conflict", "missing faceIds is not the same intent");
  assert.equal(out.commitExtraLog, "conflict");
  assert.deepEqual(out.race, ["conflict", "created"], "concurrent first commits: exactly one wins");
  assert.match(String(out.raceStored), /^RES-race-[12]$/);
  const raceFace = out.raceStored === "RES-race-1" ? "face:SF-B0" : "face:SF-E0";
  assert.deepEqual(out.legacyCommit, { status: "created", faceIds: [] }, "a log-only adjudication reads faceIds []");
  assert.deepEqual(out.retired, ["face:SF-A0", "face:SF-A1", raceFace, "log:LOG-C"].sort());
  assert.equal(out.restoreWrongFaces, "restore-conflict");
  assert.equal(out.restoreNoFaces, "restore-conflict");
  assert.equal(out.restore, "ok");
  assert.deepEqual(out.retiredAfterRestore, [raceFace, "log:LOG-C"].sort());
  assert.deepEqual(out.events, [
    { id: "RES-face-1", action: "DISMISS", faceIds: ["SF-A0", "SF-A1"], logIds: [] },
    { id: "RESTORE-3", action: "RESTORE", faceIds: ["SF-A0", "SF-A1"], logIds: [] },
  ], "the adjudication history keeps the face members of every event");
  assert.equal(out.recommit, "created");
}

/** Expectations after a restart on the same store. */
export function assertStrangerFaceReadBack(out: Record<string, any>, first: Record<string, any>, assert: typeof import("node:assert/strict")): void {
  const raceFace = first.raceStored === "RES-race-1" ? "face:SF-B0" : "face:SF-E0";
  assert.deepEqual(out.walk, [first.eWinner, "SF-B0", "SF-A1", "SF-A0", LONG_ID, "SF-OLD-0"]);
  assert.equal(out.cropA0, CROP_A0.toString("hex"));
  assert.equal(out.old1, "purged");
  assert.equal(out.resolution?.id, "RES-face-2");
  assert.deepEqual(out.resolution?.faceIds, ["SF-A0"]);
  assert.deepEqual(out.retired, ["face:SF-A0", raceFace, "log:LOG-C"].sort());
  assert.deepEqual(out.events, [
    { id: "RES-face-1", faceIds: ["SF-A0", "SF-A1"] },
    { id: "RESTORE-3", faceIds: ["SF-A0", "SF-A1"] },
    { id: "RES-face-2", faceIds: ["SF-A0"] },
  ]);
  assert.deepEqual(out.candidates, ["LOG-D", "LOG-C", "LOG-G"]);
}

/**
 * PostgreSQL configured but not reachable yet: faces are refused (never parked
 * in the local store the gateway stops reading once connected) and reads are
 * empty, while the access event itself is still kept locally as before.
 */
export async function whileConnecting(db: Db): Promise<Record<string, any>> {
  const mode = db.getStorageStatus().active;
  const logSaved = await db.saveAccessLog(log("LOG-CONN", "2026-09-29T01:00:00.000Z"));
  return {
    mode,
    logSaved,
    faceSaved: await db.saveStrangerFaces([face("SF-CONN", "LOG-CONN", 0, "2026-09-29T01:00:00.100Z")]),
    page: (await db.getStrangerFacesPage(null, 10)).faces.length,
    crop: (await db.getStrangerFaceCrop("SF-CONN")) ?? null,
    purged: await db.purgeStrangerFaces("2030-01-01T00:00:00.000Z", new Set()),
  };
}
