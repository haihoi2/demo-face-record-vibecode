import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  INITIAL_STORAGE_STATE,
  isConnectionError,
  recordConnectionError,
  recordQueryOk,
  storageStatus,
  StorageTrackerState,
} from "../src/server/dbStatus";

const pg = (over: Partial<StorageTrackerState> = {}): StorageTrackerState => ({
  ...INITIAL_STORAGE_STATE,
  postgresConfigured: true,
  sqliteActive: true,
  ...over,
});

describe("storage status", () => {
  it("is healthy on a local store when PostgreSQL was never configured", () => {
    const s = storageStatus({ ...INITIAL_STORAGE_STATE, sqliteActive: true });
    assert.equal(s.degraded, false);
    assert.equal(s.expected, "local");
    assert.equal(s.active, "sqlite");
  });

  it("is not degraded while the startup retries are still running", () => {
    const s = storageStatus(pg({ connecting: true }));
    assert.equal(s.active, "connecting");
    assert.equal(s.degraded, false);
  });

  it("is degraded after falling back at startup, dated from the fallback", () => {
    const at = Date.parse("2026-09-25T03:24:00Z");
    const s = storageStatus(pg({ fellBackAt: at }));
    assert.equal(s.degraded, true);
    assert.equal(s.active, "sqlite");
    assert.equal(s.since, "2026-09-25T03:24:00.000Z");
    assert.match(s.reason || "", /PostgreSQL/);
  });

  it("names the JSON store when SQLite is not available either", () => {
    assert.equal(storageStatus(pg({ sqliteActive: false, fellBackAt: 1 })).active, "json");
  });

  it("is degraded during a mid-run outage and recovers on the next good query", () => {
    let st = pg({ postgresActive: true });
    st = recordQueryOk(st, 1_000);
    assert.equal(storageStatus(st).degraded, false);

    st = recordConnectionError(st, 2_000);
    st = recordConnectionError(st, 5_000);
    const down = storageStatus(st);
    assert.equal(down.degraded, true);
    assert.equal(down.active, "postgresql");
    assert.equal(down.since, new Date(2_000).toISOString(), "dated from the first failure of the outage");

    st = recordQueryOk(st, 6_000);
    assert.equal(storageStatus(st).degraded, false);

    st = recordConnectionError(st, 9_000);
    assert.equal(storageStatus(st).since, new Date(9_000).toISOString(), "a new outage starts a new date");
  });

  it("never puts hosts or credentials in the reason", () => {
    for (const s of [storageStatus(pg({ fellBackAt: 1 })), storageStatus(recordConnectionError(pg({ postgresActive: true }), 1))]) {
      assert.doesNotMatch(s.reason || "", /postgres(ql)?:\/\/|@|:5432/i);
    }
  });
});

describe("connection errors vs SQL errors", () => {
  it("counts an unreachable server", () => {
    assert.equal(isConnectionError(Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" })), true);
    assert.equal(isConnectionError(new Error("Connection terminated unexpectedly")), true);
    assert.equal(isConnectionError(new Error("timeout exceeded when trying to connect")), true);
    assert.equal(isConnectionError(Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" })), true);
  });

  it("does not count a server that answered with an SQL error", () => {
    assert.equal(isConnectionError(Object.assign(new Error("duplicate key value"), { code: "23505" })), false);
    assert.equal(isConnectionError(Object.assign(new Error("value too long for type character varying(128)"), { code: "22001" })), false);
    assert.equal(isConnectionError(null), false);
  });
});
