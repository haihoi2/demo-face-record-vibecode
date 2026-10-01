/**
 * Lock status for every door (owner request 2026-10-01): the door-lock list in
 * src/utils/doorLocks.ts (`/api/lock/states`, the SSE reducer for
 * `lock_state`/`lock_countdown` and `door_lock_state`/`door_lock_countdown`,
 * texts) and source checks that the lock panel and App wire it as agreed
 * (single door unchanged, no client-side door fallback in the door list,
 * one event stream, polling only while SSE is down).
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DOOR_LOCK_POLL_MS,
  LOCK_PANEL_SOURCE,
  LOCK_STATES_URL,
  interpretLockStatesResponse,
  lockStateText,
  readLockStates,
  reduceDoorLocks,
  relockPercent,
  showDoorList,
  type DoorLockRow,
} from "../src/utils/doorLocks";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// Door locks
// ---------------------------------------------------------------------------

const lock = (doorId: string | undefined, over: Record<string, unknown> = {}) => ({
  ...(doorId === undefined ? {} : { doorId }),
  lockId: `SL-${doorId ?? "main"}`,
  doorName: `Khóa ${doorId ?? "main"}`,
  state: "LOCKED",
  isLocked: true,
  batteryLevel: 90,
  signalDbm: -50,
  firmwareVersion: "v1",
  lastActionAt: "2026-10-01T08:00:00.000Z",
  lastActionBy: "Hệ thống",
  autoRelockSeconds: 6,
  remainingRelockSeconds: 0,
  status: "ONLINE",
  ...over,
});

const STATES = {
  success: true,
  doors: [
    lock("kho-b", { label: "Cửa kho B" }),
    lock("main", { label: "Cửa chính" }),
    lock("side", { label: "" }),
  ],
};

const loaded = (): DoorLockRow[] => readLockStates(STATES)!;

describe("readLockStates / interpretLockStatesResponse", () => {
  it("reads every door, door main first, with labels", () => {
    const rows = loaded();
    assert.deepEqual(rows.map((r) => r.doorId), ["main", "kho-b", "side"]);
    assert.equal(rows[0].label, "Cửa chính");
    assert.equal(rows[1].label, "Cửa kho B");
    assert.equal(rows[2].label, "Khóa side", "no label: the lock's doorName");
    assert.equal(rows[1].isLocked, true);
    assert.equal(rows[1].state, "LOCKED");
  });

  it("skips malformed entries, bad door ids and repeats; null for a wrong shape", () => {
    const rows = readLockStates({
      success: true,
      doors: [lock("main"), lock("main"), lock("BAD ID"), { doorId: "x1" }, null, "x", lock("ok-door", { state: "UNLOCKED", isLocked: false })],
    })!;
    assert.deepEqual(rows.map((r) => r.doorId), ["main", "ok-door"]);
    assert.equal(readLockStates({ success: true }), null);
    assert.equal(readLockStates(null), null);
    assert.deepEqual(readLockStates({ doors: [] }), []);
  });

  it("clamps negative or missing counters to 0", () => {
    const [row] = readLockStates({ doors: [lock("main", { remainingRelockSeconds: -3, autoRelockSeconds: "6" })] })!;
    assert.equal(row.remainingRelockSeconds, 0);
    assert.equal(row.autoRelockSeconds, 0);
  });

  it("keeps an older server (404), a refusal and a lost connection apart", () => {
    assert.equal(LOCK_STATES_URL, "/api/lock/states");
    const ok = interpretLockStatesResponse({ ok: true, status: 200, data: STATES });
    assert.equal(ok.kind, "loaded");
    if (ok.kind === "loaded") assert.equal(ok.rows.length, 3);
    assert.deepEqual(interpretLockStatesResponse({ ok: false, status: 404, data: null }), { kind: "unsupported" });
    const refused = interpretLockStatesResponse({ ok: false, status: 403, data: { error: "Không đủ quyền" } });
    assert.equal(refused.kind, "refused");
    if (refused.kind === "refused") assert.match(refused.message, /^Không đủ quyền /);
    assert.equal(interpretLockStatesResponse({ ok: false, status: 500, data: null, error: "x" }).kind, "refused");
    assert.equal(interpretLockStatesResponse({ ok: false, status: 0, data: null }).kind, "unreachable");
    assert.equal(interpretLockStatesResponse({ ok: true, status: 200, data: { success: true } }).kind, "refused", "unreadable 200");
  });
});

describe("reduceDoorLocks (SSE)", () => {
  it("snapshot replaces the list, main first", () => {
    const rows = reduceDoorLocks([], { type: "snapshot", rows: [...loaded()].reverse() });
    assert.deepEqual(rows.map((r) => r.doorId), ["main", "side", "kho-b"]);
  });

  it("lock_state updates door main only and keeps its label", () => {
    const rows = loaded();
    const next = reduceDoorLocks(rows, {
      type: "state",
      source: "main",
      payload: lock(undefined, { state: "UNLOCKED", isLocked: false, remainingRelockSeconds: 6, lastActionBy: "Admin" }),
    });
    assert.equal(next[0].isLocked, false);
    assert.equal(next[0].label, "Cửa chính");
    assert.equal(next[0].lastActionBy, "Admin");
    assert.equal(next[1], rows[1], "other doors untouched");
    // A legacy event naming another door is not that door's state.
    assert.equal(reduceDoorLocks(rows, { type: "state", source: "main", payload: lock("kho-b", { isLocked: false, state: "UNLOCKED" }) }), rows);
  });

  it("door_lock_state updates its own door; without a door id it is dropped, never read as main", () => {
    const rows = loaded();
    const next = reduceDoorLocks(rows, {
      type: "state",
      source: "door",
      payload: lock("kho-b", { state: "UNLOCKED", isLocked: false, remainingRelockSeconds: 5 }),
    });
    assert.equal(next[1].doorId, "kho-b");
    assert.equal(next[1].isLocked, false);
    assert.equal(next[1].label, "Cửa kho B");
    assert.equal(next[0], rows[0]);
    assert.equal(reduceDoorLocks(rows, { type: "state", source: "door", payload: lock(undefined, { isLocked: false, state: "UNLOCKED" }) }), rows);
    assert.equal(reduceDoorLocks(rows, { type: "state", source: "door", payload: lock("BAD!", { isLocked: false }) }), rows);
    assert.equal(reduceDoorLocks(rows, { type: "state", source: "door", payload: "garbage" }), rows);
    assert.equal(reduceDoorLocks(rows, { type: "state", source: "door", payload: { doorId: "kho-b" } }), rows, "no state field");
  });

  it("a door configured later appears; events alone never create a list", () => {
    const rows = loaded();
    const next = reduceDoorLocks(rows, { type: "state", source: "door", payload: lock("new-door", { label: "Cửa mới" }) });
    assert.deepEqual(next.map((r) => r.doorId), ["main", "kho-b", "side", "new-door"]);
    assert.equal(next[3].label, "Cửa mới");
    assert.deepEqual(reduceDoorLocks([], { type: "state", source: "door", payload: lock("kho-b") }), []);
    assert.deepEqual(reduceDoorLocks([], { type: "state", source: "main", payload: lock(undefined) }), []);
  });

  it("countdowns: lock_countdown for main, door_lock_countdown by door id", () => {
    const rows = loaded();
    const main = reduceDoorLocks(rows, { type: "countdown", source: "main", payload: { doorId: "main", remainingSeconds: 4 } });
    assert.equal(main[0].remainingRelockSeconds, 4);
    const legacy = reduceDoorLocks(rows, { type: "countdown", source: "main", payload: { remainingSeconds: 3 } });
    assert.equal(legacy[0].remainingRelockSeconds, 3, "an older server sends no doorId");
    const door = reduceDoorLocks(rows, { type: "countdown", source: "door", payload: { doorId: "side", remainingSeconds: 2 } });
    assert.equal(door[2].remainingRelockSeconds, 2);
    assert.equal(door[0], rows[0]);
  });

  it("countdowns that do not fit are ignored (same array)", () => {
    const rows = loaded();
    for (const payload of [
      { doorId: "unknown-door", remainingSeconds: 2 },
      { doorId: "side", remainingSeconds: -1 },
      { doorId: "side", remainingSeconds: "2" },
      { doorId: "side", remainingSeconds: Number.NaN },
      { remainingSeconds: 2 },
      null,
    ]) {
      assert.equal(reduceDoorLocks(rows, { type: "countdown", source: "door", payload }), rows, JSON.stringify(payload));
    }
    assert.equal(reduceDoorLocks(rows, { type: "countdown", source: "main", payload: { doorId: "side", remainingSeconds: 2 } }), rows);
    assert.equal(reduceDoorLocks(rows, { type: "countdown", source: "main", payload: { remainingSeconds: 0 } }), rows, "unchanged value");
  });
});

describe("door lock texts", () => {
  it("lists doors only when there is more than one", () => {
    assert.equal(showDoorList([]), false);
    assert.equal(showDoorList(loaded().slice(0, 1)), false);
    assert.equal(showDoorList(loaded()), true);
  });

  it("state text and relock bar", () => {
    assert.equal(lockStateText({ state: "LOCKED", isLocked: true }), "Đã khóa");
    assert.equal(lockStateText({ state: "UNLOCKED", isLocked: false }), "Đang mở");
    assert.equal(lockStateText({ state: "UNLOCKING", isLocked: true }), "Đang mở khóa…");
    assert.equal(lockStateText({ state: "LOCKING", isLocked: false }), "Đang khóa…");
    assert.equal(relockPercent({ remainingRelockSeconds: 3, autoRelockSeconds: 6 }), 50);
    assert.equal(relockPercent({ remainingRelockSeconds: 9, autoRelockSeconds: 6 }), 100);
    assert.equal(relockPercent({ remainingRelockSeconds: 3, autoRelockSeconds: 0 }), 0);
  });

  it("the manual command source fits the server's 120-character limit", () => {
    assert.ok(LOCK_PANEL_SOURCE.length > 0 && LOCK_PANEL_SOURCE.length <= 120);
    assert.ok(DOOR_LOCK_POLL_MS >= 1000);
  });
});

// ---------------------------------------------------------------------------
// Component wiring (source checks)
// ---------------------------------------------------------------------------

describe("door lock wiring", () => {
  it("lock panel: one door renders the panel as before; several doors render the list without any client fallback", () => {
    const src = read("src/components/SmartLockCard.tsx");
    assert.match(src, /\{showDoorList\(doorLocks\) \? \(\s*<DoorLockList/);
    assert.match(src, /id="btn-trigger-unlock-api"/, "single-door buttons kept");
    assert.match(src, /id="btn-trigger-lock-api"/);
    const list = src.slice(src.indexOf("const DoorLockList"), src.indexOf("export const SmartLockCard"));
    assert.match(list, /buildLockCommandRequest\(action, row\.doorId, LOCK_PANEL_SOURCE\)/);
    assert.match(list, /interpretLockCommand\(action, row\.doorId, row\.label, res\)/);
    assert.match(list, /\{canOperateDoor && \(/);
    assert.match(list, /role="status" aria-live="polite"/);
    assert.doesNotMatch(list, /clientDoorUnlock|clientDoorLock|demoOfflinePersistenceEnabled/);
  });

  it("App: one event stream feeds both the main lock and the door list; polling only while SSE is down", () => {
    const src = read("src/App.tsx");
    assert.equal((src.match(/new EventSource\(/g) || []).length, 1, "SSE stays centralised");
    assert.match(src, /addEventListener\("lock_state"[\s\S]*?setLockState\(data\);\s*dispatchDoorLocks\(\{ type: "state", source: "main"/);
    assert.match(src, /addEventListener\("lock_countdown"[\s\S]*?dispatchDoorLocks\(\{ type: "countdown", source: "main"/);
    assert.match(src, /addEventListener\("door_lock_state"[\s\S]*?source: "door"/);
    assert.match(src, /addEventListener\("door_lock_countdown"[\s\S]*?source: "door"/);
    assert.match(src, /if \(sseLive \|\| !doorListShown\) return;/);
    assert.match(src, /setInterval\(\(\) => void fetchDoorLocks\(\), DOOR_LOCK_POLL_MS\)/);
    assert.match(src, /return \(\) => clearInterval\(timer\);/);
  });
});
