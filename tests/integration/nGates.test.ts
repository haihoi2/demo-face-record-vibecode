/**
 * N gates, black-box (plan docs/plans/2026-09-29-scale-and-accuracy.md,
 * section 11): a third gate "side-door" (ENTRY) bound to its own door "kho"
 * next to the permanent "entry" and "exit".
 *
 * Covers: the gate admin routes and their validation, the gate in the config
 * and the watch runtimes, the per-gate stream/watch/pipeline-mode routes, the
 * 400 for an unknown gate (no silent fallback to "entry"), the permanent
 * gates, the legacy {entryGate, exitGate} config POST, the door list with
 * masked tokens, the lock per door, the logs gateId filter, and that removing
 * a gate keeps its history.
 *
 * Leaves the gateway as it found it: the gate and the door are removed at the
 * end (the access events written here stay, as history must).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, getLockState, noFaceJpegDataUrl, postJson, recognize, unreachableRtsp } from "./helpers";

const GATE = "side-door";
const DOOR = "kho";
const DOOR_TOKEN = "itest-kho-door-token-not-for-display";

const put = (path: string, payload: unknown) => api<any>(path, { method: "PUT", body: JSON.stringify(payload) });
const del = (path: string) => api<any>(path, { method: "DELETE" });
const config = async () => (await api<any>("/api/camera-streams/config")).body.config;
const runtimes = async () => (await api<any>("/api/camera-streams/watch")).body.watchers as any[];
const doorConfig = () => api<any>("/api/door-controller/config");

async function cleanup() {
  await del(`/api/gates/${GATE}`);
  const current = await doorConfig();
  if (current.body?.doors?.some((d: any) => d.id === DOOR)) {
    await postJson("/api/door-controller/config", { doors: current.body.doors.filter((d: any) => d.id !== DOOR).map((d: any) => ({ id: d.id })) });
  }
}

describe("N gates: a third gate with its own door", () => {
  let exitNameBefore = "";
  let sideLogId = "";

  before(async () => {
    await cleanup(); // a previous aborted run
    exitNameBefore = (await config()).exitGate.name;
  });

  after(async () => {
    await cleanup();
    await postJson("/api/camera-streams/config", { exitGate: { name: exitNameBefore } });
  });

  it("starts with the two permanent gates, as gates and as the legacy views", async () => {
    const cfg = await config();
    assert.ok(Array.isArray(cfg.gates), "config.gates");
    assert.deepEqual(cfg.gates.slice(0, 2).map((g: any) => [g.id, g.direction]), [["entry", "ENTRY"], ["exit", "EXIT"]]);
    assert.equal(cfg.entryGate.id, "entry");
    assert.equal(cfg.exitGate.id, "exit");
    const listed = await api<any>("/api/gates");
    assert.equal(listed.status, 200);
    assert.ok(listed.body.gates.find((g: any) => g.id === "entry")?.permanent);
    assert.doesNotMatch(listed.text, /rtsp:/i, "the gate list carries no stream URLs");
  });

  it("adds a door with a token that is never returned", async () => {
    const before = await doorConfig();
    assert.equal(before.status, 200);
    const doors = [...before.body.doors.map((d: any) => ({ id: d.id })), { id: DOOR, label: "Kho", enabled: false, apiToken: DOOR_TOKEN }];
    const saved = await postJson<any>("/api/door-controller/config", { doors });
    assert.equal(saved.status, 200, saved.text.slice(0, 300));
    const fresh = await doorConfig();
    for (const res of [saved, fresh]) {
      assert.doesNotMatch(res.text, new RegExp(DOOR_TOKEN), "the door token never leaves the server");
      assert.doesNotMatch(res.text, /"apiToken"/, "no apiToken key at all, only hasApiToken");
    }
    const kho = fresh.body.doors.find((d: any) => d.id === DOOR);
    assert.ok(kho, "door kho listed");
    assert.equal(kho.label, "Kho");
    assert.equal(kho.hasApiToken, true);
    assert.equal(typeof fresh.body.hasApiToken, "boolean", "door main (top level) says it too");
    assert.equal(fresh.body.doors[0].id, "main", "door main first, mirroring the legacy fields");
    // Saving again without the token (a client never has it) keeps it.
    const again = await postJson<any>("/api/door-controller/config", { doors: fresh.body.doors.map((d: any) => ({ id: d.id, label: d.label })) });
    assert.equal(again.status, 200, again.text.slice(0, 300));
    assert.equal(again.body.config.doors.find((d: any) => d.id === DOOR).hasApiToken, true);
  });

  it("never dispatches a door command without a token scheme (auth NONE fails closed)", async () => {
    const doors = (await doorConfig()).body.doors.map((d: any) =>
      d.id === DOOR ? { id: d.id, enabled: true, authHeaderType: "NONE", apiUrl: "https://door.example.invalid/api/door/control" } : { id: d.id }
    );
    const saved = await postJson<any>("/api/door-controller/config", { doors });
    assert.equal(saved.status, 200, saved.text.slice(0, 300));
    try {
      const test = await postJson<any>("/api/door-controller/test", { doorId: DOOR, action: "OPEN", source: "itest NONE" });
      assert.equal(test.status, 200, test.text.slice(0, 300));
      assert.equal(test.body.success, false);
      assert.match(String(test.body.log?.error), /NONE/, "refused before any network call");
      assert.equal(test.body.log?.statusCode, undefined, "nothing was sent");
      assert.doesNotMatch(test.text, new RegExp(DOOR_TOKEN));
      assert.doesNotMatch(test.text, /"apiToken"/);
    } finally {
      const off = (await doorConfig()).body.doors.map((d: any) => (d.id === DOOR ? { id: d.id, enabled: false, authHeaderType: "BEARER", apiUrl: "" } : { id: d.id }));
      await postJson("/api/door-controller/config", { doors: off });
    }
  });

  it("guards every door URL and validates the door list", async () => {
    const doors = (await doorConfig()).body.doors.map((d: any) => ({ id: d.id }));
    const loopback = await postJson<any>("/api/door-controller/config", {
      doors: doors.map((d: any) => (d.id === DOOR ? { ...d, apiUrl: "http://127.0.0.1:1/door" } : d)),
    });
    assert.equal(loopback.status, 400, loopback.text.slice(0, 300));
    assert.match(String(loopback.body.code), /^DEST_/);
    for (const bad of [[{ id: "Bad_Door" }], [{ id: DOOR }, { id: DOOR }], "not-a-list"]) {
      const res = await postJson<any>("/api/door-controller/config", { doors: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    const kho = (await doorConfig()).body.doors.find((d: any) => d.id === DOOR);
    assert.equal(kho.apiUrl || "", "", "a refused save changed nothing");
  });

  it("validates a new gate: id, direction, label, door, duplicates", async () => {
    const cases: Array<[unknown, number]> = [
      [{ id: "Side_Door", label: "x", direction: "ENTRY" }, 400],
      [{ id: "s", label: "x", direction: "ENTRY" }, 400],
      [{ id: "config", label: "x", direction: "ENTRY" }, 400],
      [{ id: GATE, label: "x", direction: "SIDEWAYS" }, 400],
      [{ id: GATE, direction: "ENTRY" }, 400],
      [{ id: GATE, label: "x", direction: "ENTRY", doorId: "no-such-door" }, 400],
      [{ id: "entry", label: "x", direction: "ENTRY" }, 409],
    ];
    for (const [body, status] of cases) {
      const res = await postJson<any>("/api/gates", body);
      assert.equal(res.status, status, `${JSON.stringify(body)} -> ${res.text.slice(0, 200)}`);
    }
  });

  it("creates side-door (ENTRY, door kho): in the config, the gate list and the watch runtimes", async () => {
    const res = await postJson<any>("/api/gates", { id: GATE, label: "Cửa hông", direction: "ENTRY", doorId: DOOR });
    assert.equal(res.status, 201, res.text.slice(0, 300));
    assert.equal(res.body.summary.doorId, DOOR);
    const cfg = await config();
    const g = cfg.gates.find((x: any) => x.id === GATE);
    assert.ok(g, "gate in config.gates");
    assert.equal(g.direction, "ENTRY");
    assert.equal(g.doorId, DOOR);
    assert.equal(g.watch.enabled, false, "a new gate is never watched until switched on");
    assert.ok(g.streams.every((s: any) => s.id.startsWith(`${GATE}-`)), "stream ids are prefixed with the gate id");
    const w = (await runtimes()).find((r: any) => r.gateId === GATE);
    assert.ok(w, "a watch runtime for the new gate");
    assert.equal(w.gate, "ENTRY", "`gate` stays the direction for older clients");
    assert.equal(w.gateLabel, "Cửa hông");
    assert.equal((await runtimes()).find((r: any) => r.gate === "ENTRY").gateId, "entry", "entry is still the first ENTRY runtime");
  });

  it("serves the streams, watch and pipeline-mode routes for side-door", async () => {
    const list = await api<any>(`/api/camera-streams/${GATE}/streams`);
    assert.equal(list.status, 200, list.text.slice(0, 200));
    const added = await postJson<any>(`/api/camera-streams/${GATE}/streams`, { id: `${GATE}-itest`, label: "itest", rtspUrl: unreachableRtsp("side-door"), enabled: false });
    assert.equal(added.status, 201, added.text.slice(0, 300));
    const edited = await put(`/api/camera-streams/${GATE}/streams/${GATE}-itest`, { label: "itest 2" });
    assert.equal(edited.status, 200, edited.text.slice(0, 300));
    assert.equal(edited.body.stream.label, "itest 2");
    const removed = await del(`/api/camera-streams/${GATE}/streams/${GATE}-itest`);
    assert.equal(removed.status, 200, removed.text.slice(0, 300));

    const watch = await postJson<any>(`/api/camera-streams/${GATE}/watch`, { enabled: false, intervalSeconds: 7 });
    assert.equal(watch.status, 200, watch.text.slice(0, 300));
    assert.equal(watch.body.gateId, GATE);
    assert.equal(watch.body.gate, "ENTRY");
    assert.equal(watch.body.watch.intervalSeconds, 7);

    const mode = await postJson<any>(`/api/camera-streams/${GATE}/pipeline-mode`, { mode: "legacy" });
    assert.equal(mode.status, 200, mode.text.slice(0, 300));
    assert.equal(mode.body.gateId, GATE);
    assert.equal(mode.body.pipelineModeSource, "config");
    const cleared = await postJson<any>(`/api/camera-streams/${GATE}/pipeline-mode`, { mode: null });
    assert.equal(cleared.body.pipelineModeSource, "env");
  });

  it("answers 400 for an unknown or malformed gate everywhere - never a fallback to entry", async () => {
    for (const gate of ["lobby", "Bad_Gate"]) {
      assert.equal((await api(`/api/camera-streams/${gate}/streams`)).status, 400, `GET streams ${gate}`);
      // (A non-slug segment needs admin at the auth table; this session is admin, so the route answers.)
      assert.equal((await postJson(`/api/camera-streams/${gate}/streams`, { rtspUrl: unreachableRtsp("x") })).status, 400, `POST streams ${gate}`);
      assert.equal((await postJson(`/api/camera-streams/${gate}/watch`, { enabled: false })).status, 400, `watch ${gate}`);
      assert.equal((await api(`/api/camera-streams/snapshot?gate=${gate}`, { redirect: "manual" })).status, 400, `snapshot ${gate}`);
      assert.equal((await postJson("/api/camera-streams/scan-rtsp", { gate, url: unreachableRtsp("x") })).status, 400, `scan-rtsp ${gate}`);
      assert.equal((await put(`/api/gates/${gate}`, { label: "x" })).status, 400, `PUT gate ${gate}`);
      assert.equal((await recognize({ imageBase64: noFaceJpegDataUrl(64, 7101), gateId: gate })).status, 400, `recognize ${gate}`);
    }
    assert.equal((await postJson("/api/camera-streams/lobby/pipeline-mode", { mode: "legacy" })).status, 400);
    assert.equal((await postJson("/api/camera-streams/scan-rtsp", { url: unreachableRtsp("x") })).status, 400, "a scan without a gate");
    assert.equal((await api("/api/camera-streams/snapshot", { redirect: "manual" })).status, 400, "a snapshot without a gate");
  });

  it("keeps entry and exit: they cannot be deleted and their direction is fixed", async () => {
    for (const id of ["entry", "exit"]) {
      const res = await del(`/api/gates/${id}`);
      assert.equal(res.status, 400, res.text.slice(0, 200));
    }
    assert.equal((await put("/api/gates/exit", { direction: "ENTRY" })).status, 400);
    const ids = (await config()).gates.map((g: any) => g.id);
    assert.ok(ids.includes("entry") && ids.includes("exit"));
  });

  it("still accepts the legacy {entryGate, exitGate} config POST, and `gates` patches", async () => {
    const legacy = await postJson<any>("/api/camera-streams/config", { exitGate: { name: "itest exit name" } });
    assert.equal(legacy.status, 200, legacy.text.slice(0, 300));
    assert.equal(legacy.body.config.exitGate.name, "itest exit name");
    assert.equal(legacy.body.config.gates.find((g: any) => g.id === "exit").name, "itest exit name");
    assert.ok(legacy.body.config.gates.some((g: any) => g.id === GATE), "a legacy POST leaves the other gates alone");

    const viaGates = await postJson<any>("/api/camera-streams/config", { gates: [{ id: GATE, name: "itest side name", doorId: "main", direction: "EXIT" }] });
    assert.equal(viaGates.status, 200, viaGates.text.slice(0, 300));
    const g = viaGates.body.config.gates.find((x: any) => x.id === GATE);
    assert.equal(g.name, "itest side name");
    assert.equal(g.doorId, DOOR, "the door binding is an admin change (PUT /api/gates), not a config patch");
    assert.equal(g.direction, "ENTRY", "so is the direction");

    const unknown = await postJson<any>("/api/camera-streams/config", { gates: [{ id: "lobby", name: "x" }] });
    assert.equal(unknown.status, 400, "the config POST never creates a gate");
  });

  it("edits a gate (label, direction, enabled, door) as admin", async () => {
    const res = await put(`/api/gates/${GATE}`, { label: "Cửa hông B", enabled: false });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body.summary.label, "Cửa hông B");
    assert.equal(res.body.summary.enabled, false);
    const back = await put(`/api/gates/${GATE}`, { enabled: true });
    assert.equal(back.body.summary.enabled, true);
    assert.equal((await put(`/api/gates/${GATE}`, { doorId: "no-such-door" })).status, 400);
    assert.equal((await put(`/api/gates/${GATE}`, { direction: "UP" })).status, 400);
  });

  it("refuses to remove a door a gate still uses", async () => {
    const doors = (await doorConfig()).body.doors.filter((d: any) => d.id !== DOOR).map((d: any) => ({ id: d.id }));
    const res = await postJson<any>("/api/door-controller/config", { doors });
    assert.equal(res.status, 409, res.text.slice(0, 300));
  });

  it("locks and unlocks per door; the main lock is untouched", async () => {
    const main = await getLockState();
    const open = await postJson<any>("/api/lock/unlock", { doorId: DOOR, source: "itest per-door" });
    assert.equal(open.status, 200, open.text.slice(0, 300));
    assert.equal(open.body.lockState.doorId, DOOR);
    assert.equal(open.body.lockState.isLocked, false);
    const state = await api<any>(`/api/lock/state?doorId=${DOOR}`);
    assert.equal(state.status, 200);
    assert.equal(state.body.doorId, DOOR);
    assert.equal(state.body.state, "UNLOCKED");
    assert.equal(state.body.doorName, "Kho");
    const mainAfter = await getLockState();
    assert.equal(mainAfter.state, main.state, "door main did not move");
    assert.equal(mainAfter.lastActionAt, main.lastActionAt);
    const closed = await postJson<any>("/api/lock/lock", { doorId: DOOR, source: "itest per-door" });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.lockState.isLocked, true);
    for (const bad of ["no-such-door", "Bad_Door"]) {
      assert.equal((await postJson("/api/lock/unlock", { doorId: bad })).status, 400, bad);
      assert.equal((await api(`/api/lock/state?doorId=${bad}`)).status, 400, bad);
    }
    const legacy = await api<any>("/api/lock/status");
    assert.equal(legacy.body.doorId, "main", "no doorId = the legacy single door");
    const all = await api<any>("/api/lock/states");
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.doors.slice(0, 1).map((d: any) => d.doorId), ["main"]);
    assert.equal(all.body.doors.find((d: any) => d.doorId === DOOR)?.isLocked, true);
    assert.doesNotMatch(all.text, new RegExp(DOOR_TOKEN));
  });

  it("writes the gate id (and the gate's door name) on its events; logs filter by gateId", async () => {
    const made = await recognize({ imageBase64: noFaceJpegDataUrl(64, 7201), gateId: GATE, scanType: "EXIT" });
    assert.equal(made.status, 200, made.text.slice(0, 300));
    const log = (made.body as any).log;
    assert.ok(log?.id, "a DENIED event");
    assert.equal(log.gateId, GATE);
    assert.equal(log.type, "ENTRY", "the gate's direction, not the body's scanType");
    assert.equal(log.doorName, "Kho", "the gate's door");
    sideLogId = log.id;

    const filtered = await api<any>(`/api/logs?gateId=${GATE}&paging=cursor`);
    assert.equal(filtered.status, 200, filtered.text.slice(0, 200));
    assert.ok(filtered.body.logs.some((l: any) => l.id === sideLogId), "the event is found by its gate");
    assert.ok(filtered.body.logs.every((l: any) => l.gateId === GATE), "and only that gate's events");
    const entryOnly = await api<any>("/api/logs?gateId=entry&paging=cursor");
    assert.ok(!entryOnly.body.logs.some((l: any) => l.id === sideLogId), "not under entry, though both are ENTRY");
    assert.ok(entryOnly.body.logs.every((l: any) => l.gateId === "entry"), "older rows without a gateId read as entry/exit");
    assert.equal((await api("/api/logs?gateId=Bad_Gate")).status, 400);

    const csv = await api(`/api/logs/export.csv?gateId=${GATE}`);
    assert.equal(csv.status, 200, csv.text.slice(0, 200));
    const lines = csv.text.replace(/^﻿/, "").trim().split("\n");
    assert.match(lines[0], /"Loại","Cổng","Trạng thái"/);
    assert.ok(lines.some((l) => l.startsWith(`"${sideLogId}"`) && l.includes('"Cửa hông B"')), "the gate's label in its column");
  });

  it("reports recording availability per gate id plus the legacy keys", async () => {
    const res = await api<any>("/api/recordings/config");
    assert.equal(res.status, 200);
    for (const key of ["ENTRY", "EXIT", "entry", "exit", GATE]) assert.equal(typeof res.body.gates[key], "boolean", key);
  });

  it("removes side-door: watcher and routes gone, its history kept", async () => {
    const res = await del(`/api/gates/${GATE}`);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.ok(!(await config()).gates.some((g: any) => g.id === GATE));
    assert.ok(!(await runtimes()).some((r: any) => r.gateId === GATE));
    assert.equal((await api(`/api/camera-streams/${GATE}/streams`)).status, 400);
    const history = await api<any>(`/api/logs?gateId=${GATE}&paging=cursor`);
    assert.equal(history.status, 200, "a removed gate's id is still a valid filter");
    assert.ok(history.body.logs.some((l: any) => l.id === sideLogId), "its events stay");

    // Now the door is free and can go too.
    const doors = (await doorConfig()).body.doors.filter((d: any) => d.id !== DOOR).map((d: any) => ({ id: d.id }));
    const freed = await postJson<any>("/api/door-controller/config", { doors });
    assert.equal(freed.status, 200, freed.text.slice(0, 300));
    assert.ok(!freed.body.config.doors.some((d: any) => d.id === DOOR));
    assert.equal((await api(`/api/lock/state?doorId=${DOOR}`)).status, 400, "a removed door is unknown");
  });
});
