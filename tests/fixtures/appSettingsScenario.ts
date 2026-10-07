/**
 * One behavioural scenario for the admin settings store (src/server/db.ts,
 * app_settings: getAppSetting / saveAppSetting / updateAppSetting), run
 * unchanged against the JSON fallback, native SQLite and PostgreSQL. Each run
 * starts on an EMPTY store and returns a JSON-able summary;
 * tests/appSettings.test.ts and tests/integration/appSettingsPersistence.test.ts
 * assert on it with the same expectations.
 *
 * Values are synthetic. SECRET_MARKER stands in for a credential-bearing URL
 * and must never appear in a log line.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DB_MODULE = fileURLToPath(new URL("../../src/server/db.ts", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

type Db = typeof import("../../src/server/db").db;

export const SECRET_MARKER = "tok-SECRET-7f3a91";

/** Everything the child process logged (stdout and stderr), without the RESULT payload line. */
export function logsOf(r: { stdout: string; stderr: string }): string {
  return (r.stdout + "\n" + r.stderr).split("\n").filter((l) => !l.startsWith("RESULT ")).join("\n");
}

export type AppSettingsScenarioFn =
  | "runAppSettingsScenario"
  | "readBackAppSettings"
  | "whileConnectingAppSettings"
  | "seedStrandedAppSetting"
  | "probeAppSettings";

/**
 * Boot the storage layer in a fresh process (a singleton bound to
 * DATA_DIR/DATABASE_URL at import) and run one exported function of this
 * module against it. EXPECT_PG=1 waits for db.onSync first, and the function
 * then runs synchronously inside the first onSync callback's turn.
 */
export function runAppSettingsChild(
  fn: AppSettingsScenarioFn,
  env: Record<string, string>,
  nodeArgs: string[] = [],
): Promise<{ code: number; out: any; stdout: string; stderr: string }> {
  const script = `
    const { db } = await import(${JSON.stringify(DB_MODULE)});
    const scenario = await import(${JSON.stringify(SELF)});
    let atSync;
    if (process.env.EXPECT_PG === "1") {
      const synced = await new Promise((resolve) => {
        db.onSync(() => { atSync = scenario.snapshotAtSync(db); resolve(true); });
        setTimeout(() => resolve(false), 60000);
      });
      if (!synced || db.getStorageStatus().active !== "postgresql") {
        process.stdout.write("RESULT " + JSON.stringify({ error: "postgres not ready", status: db.getStorageStatus() }) + "\\n");
        process.exit(3);
      }
    }
    const out = await scenario[${JSON.stringify(fn)}](db);
    if (atSync !== undefined) out.atSync = atSync;
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

/** What getAppSetting returns from inside the first onSync callback (synchronously). */
export function snapshotAtSync(db: Db): Record<string, any> {
  return {
    channels: db.getAppSetting("notification_channels")?.value ?? null,
    preseeded: db.getAppSetting("preseeded_key") ?? null,
  };
}

export const CHANNELS = {
  channels: [
    { id: "CH-1", name: "Kênh bảo vệ ngoài giờ", type: "eton-webhook", url: `https://chat.example.vn/hooks/${SECRET_MARKER}`, enabled: true },
  ],
};
const ROUTES = { stranger: "eton-default", presence: "CH-1", presenceHealth: "eton-default" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Make the next app_settings write of the active store fail once (a lost
 * connection, a locked file, a full disk). Returns a restore function.
 */
function failNextWrite(db: Db): () => void {
  const anyDb = db as any;
  const mode = db.getStorageStatus().active;
  if (mode === "postgresql") {
    const pool = anyDb.pgPool;
    const original = pool.query;
    let armed = true;
    pool.query = (...args: any[]) => {
      if (armed && typeof args[0] === "string" && args[0].includes("INSERT INTO app_settings")) {
        armed = false;
        return Promise.reject(Object.assign(new Error("simulated write failure"), { code: "57P01" }));
      }
      return original.apply(pool, args);
    };
    return () => { pool.query = original; };
  }
  if (mode === "sqlite") {
    const conn = anyDb.db;
    const original = conn.prepare;
    let armed = true;
    conn.prepare = (sql: string) => {
      if (armed && sql.includes("INSERT INTO app_settings")) {
        armed = false;
        throw new Error("simulated write failure: database is locked");
      }
      return original.call(conn, sql);
    };
    return () => { conn.prepare = original; };
  }
  const original = anyDb.fallbackFile;
  anyDb.fallbackFile = "/nonexistent-dir-for-app-settings-test/smartface_data.json";
  return () => { anyDb.fallbackFile = original; };
}

/** Delay the next app_settings write (PostgreSQL round trip), to observe the cache before the write is durable. */
function delayWrites(db: Db, ms: number): () => void {
  const anyDb = db as any;
  if (db.getStorageStatus().active !== "postgresql") return () => {};
  const pool = anyDb.pgPool;
  const original = pool.query;
  pool.query = async (...args: any[]) => {
    if (typeof args[0] === "string" && args[0].includes("INSERT INTO app_settings")) await sleep(ms);
    return original.apply(pool, args);
  };
  return () => { pool.query = original; };
}

const outcome = async (p: Promise<unknown>) => {
  try {
    return { ok: await p };
  } catch (e: any) {
    return { rejected: String(e?.message || e) };
  }
};

export async function runAppSettingsScenario(db: Db): Promise<Record<string, any>> {
  const out: Record<string, any> = { mode: db.getStorageStatus().active };

  // Empty store; malformed keys never read.
  out.missing = db.getAppSetting("notification_channels") ?? null;
  out.protoKeys = [db.getAppSetting("constructor") ?? null, db.getAppSetting("tostring") ?? null];
  out.badKeyReads = ["", "a", "A_b", "1abc", "has-dash", "has space", "Upper", "x".repeat(65), "__proto__", 42 as any, null as any]
    .map((k) => db.getAppSetting(k) ?? null);

  // Refused writes (nothing stored).
  const circular: any = { a: 1 };
  circular.self = circular;
  out.refused = {
    badKey: await db.saveAppSetting("Bad-Key", { a: 1 }, "admin"),
    shortKey: await db.saveAppSetting("a", { a: 1 }, "admin"),
    longKey: await db.saveAppSetting("k".repeat(65), { a: 1 }, "admin"),
    nonStringKey: await db.saveAppSetting(7 as any, { a: 1 }, "admin"),
    undefinedValue: await db.saveAppSetting("refused_a", undefined, "admin"),
    functionValue: await db.saveAppSetting("refused_b", (() => 1) as any, "admin"),
    circular: await db.saveAppSetting("refused_c", circular, "admin"),
    bigint: await db.saveAppSetting("refused_d", { n: BigInt(1) } as any, "admin"),
    nulInValue: await db.saveAppSetting("refused_e", { s: "a\u0000b" }, "admin"),
    nulInKey: await db.saveAppSetting("refused_f", { ["a\u0000"]: 1 }, "admin"),
    oversize: await db.saveAppSetting("refused_g", { s: "x".repeat(64 * 1024) }, "admin"),
    emptyActor: await db.saveAppSetting("refused_h", { a: 1 }, ""),
    blankActor: await db.saveAppSetting("refused_i", { a: 1 }, "   "),
    longActor: await db.saveAppSetting("refused_j", { a: 1 }, "u".repeat(256)),
    nonStringActor: await db.saveAppSetting("refused_k", { a: 1 }, null as any),
  };
  out.afterRefused = ["refused_a", "refused_b", "refused_c", "refused_d", "refused_e", "refused_f", "refused_g", "refused_h", "refused_i", "refused_j", "refused_k"]
    .map((k) => db.getAppSetting(k) ?? null);

  // Size boundary: exactly 64 KB of serialised JSON fits ({"s":"..."} = 8 bytes of framing).
  out.exact64k = await db.saveAppSetting("size_probe", { s: "y".repeat(64 * 1024 - 8) }, "admin");
  out.exact64kLen = (db.getAppSetting<{ s: string }>("size_probe")?.value.s.length) ?? null;
  out.multibyteOver = await db.saveAppSetting("size_probe", { s: "ê".repeat(32 * 1024) }, "admin"); // 2 bytes each -> > 64 KB
  out.sizeProbeAfter = (db.getAppSetting<{ s: string }>("size_probe")?.value.s.length) ?? null;

  // A normal write: durable before the cache changes.
  const restoreDelay = delayWrites(db, 150);
  const pending = db.saveAppSetting("notification_channels", CHANNELS, "  admin-a  ");
  out.beforeDurable = db.getAppSetting("notification_channels") ?? null;
  out.saved = await pending;
  restoreDelay();
  const rec = db.getAppSetting<typeof CHANNELS>("notification_channels");
  out.record = rec ? { key: rec.key, value: structuredClone(rec.value), updatedBy: rec.updatedBy, isoAt: !Number.isNaN(Date.parse(rec.updatedAt)) } : null;

  // Deep copies, both ways.
  rec!.value.channels[0].name = "changed by a caller";
  (rec as any).updatedBy = "forged";
  const input = { stranger: "eton-default", presence: "CH-1", presenceHealth: "eton-default" };
  out.savedRoutes = await db.saveAppSetting("notification_routes", input, "admin-a");
  input.presence = "mutated-after-save";
  out.copyIsolation = {
    channelName: db.getAppSetting<typeof CHANNELS>("notification_channels")?.value.channels[0].name,
    updatedBy: db.getAppSetting("notification_channels")?.updatedBy,
    routes: db.getAppSetting("notification_routes")?.value,
  };

  // JSON value kinds and canonical form (undefined members dropped, Date -> ISO string).
  out.kinds = {
    nullValue: await db.saveAppSetting("kind_null", null, "admin"),
    array: await db.saveAppSetting("kind_array", [1, "hai", { ba: true }], "admin"),
    string: await db.saveAppSetting("kind_string", "Tin thử từ SmartFace", "admin"),
    number: await db.saveAppSetting("kind_number", 0.1 + 0.2, "admin"),
    canonical: await db.saveAppSetting("kind_canonical", { keep: 1, drop: undefined, at: new Date("2026-10-07T01:02:03.000Z") }, "admin"),
  };
  out.kindValues = Object.fromEntries(["kind_null", "kind_array", "kind_string", "kind_number", "kind_canonical"]
    .map((k) => [k, db.getAppSetting(k) ? { value: db.getAppSetting(k)!.value } : "missing"]));

  // Overwrite: new value, new actor, updatedAt not earlier.
  const firstAt = db.getAppSetting("notification_routes")!.updatedAt;
  await sleep(5);
  out.overwrite = await db.saveAppSetting("notification_routes", ROUTES, "admin-b");
  const after = db.getAppSetting("notification_routes")!;
  out.overwritten = { value: after.value, updatedBy: after.updatedBy, later: after.updatedAt >= firstAt };

  // Retry after a failed write: false, cache unchanged, the retry succeeds.
  const restoreFail = failNextWrite(db);
  out.failedWrite = await db.saveAppSetting("notification_routes", { ...ROUTES, presence: "eton-default" }, "admin-c");
  restoreFail();
  out.afterFailed = { value: db.getAppSetting("notification_routes")?.value, updatedBy: db.getAppSetting("notification_routes")?.updatedBy };
  out.retry = await db.saveAppSetting("notification_routes", { ...ROUTES, presence: "eton-default" }, "admin-c");
  out.afterRetry = db.getAppSetting("notification_routes")?.value;

  // Duplicate submissions of the same document converge on one row.
  out.duplicates = await Promise.all([1, 2, 3].map(() => db.saveAppSetting("dup_key", { same: true }, "admin")));
  out.duplicateValue = db.getAppSetting("dup_key")?.value;

  // Concurrent overwrites: applied in call order; the cache ends on the last call.
  out.concurrent = await Promise.all(Array.from({ length: 20 }, (_, i) => db.saveAppSetting("race_key", { n: i }, `admin-${i}`)));
  out.raceFinal = db.getAppSetting("race_key")?.value;

  // Concurrent read-modify-write: no lost updates.
  const inc = () => db.updateAppSetting<{ count: number }>("counter", (cur) => ({ count: (cur?.value.count ?? 0) + 1 }), "admin");
  out.increments = (await Promise.all(Array.from({ length: 12 }, inc))).map((r) => r.status);
  out.counter = db.getAppSetting("counter")?.value;
  out.unchanged = await db.updateAppSetting("counter", () => undefined, "admin");
  out.mutateThrows = await outcome(db.updateAppSetting("counter", () => { throw new Error("CHANNEL_IN_USE"); }, "admin"));
  out.counterAfterAbort = db.getAppSetting("counter")?.value;
  out.updateRefused = {
    badKey: (await db.updateAppSetting("Bad", () => ({}), "admin")).status,
    badActor: (await db.updateAppSetting("counter", () => ({}), "")).status,
    oversize: (await db.updateAppSetting("counter", () => ({ s: "x".repeat(70_000) }), "admin")).status,
  };
  const restoreFail2 = failNextWrite(db);
  out.updateFailed = (await db.updateAppSetting<{ count: number }>("counter", (cur) => ({ count: cur!.value.count + 100 }), "admin")).status;
  restoreFail2();
  out.counterAfterFailed = db.getAppSetting("counter")?.value;
  // The queue keeps working after a rejected and a failed task.
  out.afterQueueErrors = await db.saveAppSetting("queue_ok", { ok: true }, "admin");

  return out;
}

/** Expectations shared by every store (JSON, SQLite, PostgreSQL). */
export function assertAppSettingsScenario(out: Record<string, any>, assert: typeof import("node:assert/strict")): void {
  assert.equal(out.missing, null, "an empty store has no document");
  assert.deepEqual(out.protoKeys, [null, null], "object-prototype names are not documents");
  assert.deepEqual(out.badKeyReads, Array(11).fill(null), "malformed keys read undefined");
  assert.deepEqual(out.refused, {
    badKey: false, shortKey: false, longKey: false, nonStringKey: false, undefinedValue: false, functionValue: false,
    circular: false, bigint: false, nulInValue: false, nulInKey: false, oversize: false, emptyActor: false,
    blankActor: false, longActor: false, nonStringActor: false,
  });
  assert.deepEqual(out.afterRefused, Array(11).fill(null), "refused writes store nothing");
  assert.equal(out.exact64k, true, "exactly 64 KB of JSON fits");
  assert.equal(out.exact64kLen, 64 * 1024 - 8);
  assert.equal(out.multibyteOver, false, "the limit counts UTF-8 bytes");
  assert.equal(out.sizeProbeAfter, 64 * 1024 - 8, "a refused overwrite keeps the previous document");

  assert.equal(out.beforeDurable, null, "the cache changes only after the write is durable");
  assert.equal(out.saved, true);
  assert.deepEqual(out.record, { key: "notification_channels", value: CHANNELS, updatedBy: "admin-a", isoAt: true }, "actor stored trimmed");
  assert.equal(out.savedRoutes, true);
  assert.deepEqual(out.copyIsolation, {
    channelName: "Kênh bảo vệ ngoài giờ",
    updatedBy: "admin-a",
    routes: { stranger: "eton-default", presence: "CH-1", presenceHealth: "eton-default" },
  }, "reads and writes are deep copies");

  assert.deepEqual(out.kinds, { nullValue: true, array: true, string: true, number: true, canonical: true });
  assert.deepEqual(out.kindValues, {
    kind_null: { value: null },
    kind_array: { value: [1, "hai", { ba: true }] },
    kind_string: { value: "Tin thử từ SmartFace" },
    kind_number: { value: 0.30000000000000004 },
    kind_canonical: { value: { keep: 1, at: "2026-10-07T01:02:03.000Z" } },
  }, "values are stored in their JSON form");

  assert.equal(out.overwrite, true);
  assert.deepEqual(out.overwritten, { value: ROUTES, updatedBy: "admin-b", later: true });
  assert.equal(out.failedWrite, false, "a store failure answers false");
  assert.deepEqual(out.afterFailed, { value: ROUTES, updatedBy: "admin-b" }, "...and leaves the cache as it was");
  assert.equal(out.retry, true, "a retry after a failure succeeds");
  assert.deepEqual(out.afterRetry, { ...ROUTES, presence: "eton-default" });

  assert.deepEqual(out.duplicates, [true, true, true]);
  assert.deepEqual(out.duplicateValue, { same: true });
  assert.deepEqual(out.concurrent, Array(20).fill(true));
  assert.deepEqual(out.raceFinal, { n: 19 }, "concurrent writes apply in call order");

  assert.deepEqual(out.increments, Array(12).fill("saved"));
  assert.deepEqual(out.counter, { count: 12 }, "concurrent read-modify-write loses no update");
  assert.equal(out.unchanged.status, "unchanged");
  assert.deepEqual(out.unchanged.record.value, { count: 12 });
  assert.deepEqual(out.mutateThrows, { rejected: "CHANNEL_IN_USE" }, "an exception from mutate reaches the caller");
  assert.deepEqual(out.counterAfterAbort, { count: 12 }, "...and writes nothing");
  assert.deepEqual(out.updateRefused, { badKey: "failed", badActor: "failed", oversize: "failed" });
  assert.equal(out.updateFailed, "failed");
  assert.deepEqual(out.counterAfterFailed, { count: 12 });
  assert.equal(out.afterQueueErrors, true, "the write queue survives errors");
}

/** Second process on the same store: what survived the restart. */
export async function readBackAppSettings(db: Db): Promise<Record<string, any>> {
  const keys = ["notification_channels", "notification_routes", "race_key", "counter", "kind_null", "kind_canonical", "size_probe", "refused_a", "preseeded_key"];
  return {
    mode: db.getStorageStatus().active,
    docs: Object.fromEntries(keys.map((k) => {
      const r = db.getAppSetting<any>(k);
      return [k, r ? { value: k === "size_probe" ? r.value.s.length : r.value, updatedBy: r.updatedBy } : null];
    })),
  };
}

export function assertAppSettingsReadBack(out: Record<string, any>, assert: typeof import("node:assert/strict")): void {
  const { preseeded_key, ...docs } = out.docs;
  void preseeded_key;
  assert.deepEqual(docs, {
    notification_channels: { value: CHANNELS, updatedBy: "admin-a" },
    notification_routes: { value: { ...ROUTES, presence: "eton-default" }, updatedBy: "admin-c" },
    race_key: { value: { n: 19 }, updatedBy: "admin-19" },
    counter: { value: { count: 12 }, updatedBy: "admin" },
    kind_null: { value: null, updatedBy: "admin" },
    kind_canonical: { value: { keep: 1, at: "2026-10-07T01:02:03.000Z" }, updatedBy: "admin" },
    size_probe: { value: 64 * 1024 - 8, updatedBy: "admin" },
    refused_a: null,
  }, "the store holds exactly what the cache showed before the restart");
}

/** PostgreSQL configured but not reachable yet: nothing read, nothing written locally. */
export async function whileConnectingAppSettings(db: Db): Promise<Record<string, any>> {
  return {
    mode: db.getStorageStatus().active,
    saved: await db.saveAppSetting("notification_routes", ROUTES, "admin"),
    updated: (await db.updateAppSetting("counter", () => ({ count: 1 }), "admin")).status,
    read: db.getAppSetting("notification_routes") ?? null,
    localRead: db.getAppSetting("local_only") ?? null,
  };
}

/** A value written to the local store during a fallback period (holds the secret marker). */
export async function seedStrandedAppSetting(db: Db): Promise<Record<string, any>> {
  return {
    mode: db.getStorageStatus().active,
    saved: await db.saveAppSetting("local_only", { url: `https://chat.example.vn/hooks/${SECRET_MARKER}` }, "admin"),
    savedShared: await db.saveAppSetting("notification_routes", { stranger: "local-value" }, "admin"),
  };
}

/** Minimal probe: one read and one write. */
export async function probeAppSettings(db: Db): Promise<Record<string, any>> {
  return {
    mode: db.getStorageStatus().active,
    before: db.getAppSetting("probe_key") ?? null,
    saved: await db.saveAppSetting("probe_key", { v: 1 }, "admin"),
    after: db.getAppSetting("probe_key")?.value ?? null,
    localOnly: db.getAppSetting("local_only") ?? null,
    routes: db.getAppSetting("notification_routes")?.value ?? null,
  };
}
