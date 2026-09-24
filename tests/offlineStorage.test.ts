import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  clearLegacyProtectedLogCache,
  getStoredEmployees,
  getStoredLogs,
  isDemoOfflinePersistenceAllowed,
  saveStoredEmployees,
  saveStoredLogs,
} from "../src/utils/offlineEngine";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

const sensitiveKeys = [
  "smartlock_offline_logs_v2",
  "smartlock_demo_only_logs_v3",
  "smartlock_demo_offline_logs_v4",
  "smartlock_offline_employees",
  "smartlock_offline_employees_v2",
  "smartlock_demo_offline_employees_v3",
];

describe("demo-only biometric storage", () => {
  beforeEach(() => storage.clear());

  it("requires an explicit flag, static/demo host, and no backend API", () => {
    assert.equal(isDemoOfflinePersistenceAllowed({ explicitlyEnabled: false, staticHost: true, apiBaseUrl: "" }), false);
    assert.equal(isDemoOfflinePersistenceAllowed({ explicitlyEnabled: true, staticHost: false, apiBaseUrl: "" }), false);
    assert.equal(isDemoOfflinePersistenceAllowed({ explicitlyEnabled: true, staticHost: true, apiBaseUrl: "https://api.example.test" }), false);
    assert.equal(isDemoOfflinePersistenceAllowed({ explicitlyEnabled: true, staticHost: true, apiBaseUrl: "" }), true);
  });

  it("removes every historical sensitive key and the current demo keys when disabled", () => {
    for (const key of sensitiveKeys) storage.setItem(key, "secret");
    clearLegacyProtectedLogCache(false);
    for (const key of sensitiveKeys) assert.equal(storage.getItem(key), null, key);
  });

  it("does not persist employees or logs when the gate is disabled", () => {
    saveStoredLogs([{ id: "SECRET", photoSnapshot: "data:image/jpeg;base64,RAW" } as any], false);
    saveStoredEmployees([{ id: "EMP", photoUrl: "data:image/jpeg;base64,RAW" } as any], false);
    assert.deepEqual(getStoredLogs(false), []);
    assert.deepEqual(getStoredEmployees(false), []);
    for (const key of sensitiveKeys) assert.equal(storage.getItem(key), null, key);
  });

  it("persists only under demo-namespaced keys when explicitly enabled", () => {
    saveStoredLogs([], true);
    saveStoredEmployees([], true);
    assert.equal(storage.getItem("smartlock_demo_offline_logs_v4"), "[]");
    assert.equal(storage.getItem("smartlock_demo_offline_employees_v3"), "[]");
    assert.equal(storage.getItem("smartlock_offline_logs_v2"), null);
    assert.equal(storage.getItem("smartlock_offline_employees_v2"), null);
  });
});
