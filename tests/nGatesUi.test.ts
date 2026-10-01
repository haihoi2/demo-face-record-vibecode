/**
 * N-gate wave UI (plan docs/plans/2026-09-29-scale-and-accuracy.md, Part E and
 * section 11): the one gate adapter (src/utils/gates.ts) against both server
 * shapes, the gate filter of the access history, legacy event gate derivation,
 * the door helpers (tokens never shown back, per-door lock), and source checks
 * that the changed screens key gates by id, never by direction.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CameraStreamsConfig, GateConfig, GateStreamConfig } from "../src/types";
import * as serverGates from "../src/server/gates";
import {
  GATE_ID_RE,
  LEGACY_DOOR_ID,
  LEGACY_GATE_IDS,
  MAX_GATES,
  buildCreateGateRequest,
  buildDeleteGateRequest,
  buildUpdateGateRequest,
  canDeleteGate,
  deleteGateConfirmText,
  eventGateId,
  gateDisplayLabel,
  gateDoorId,
  gateIdFromAny,
  gatesOf,
  interpretGateMutation,
  isGateId,
  labelForGateId,
  orderedGateIds,
  runtimeGateId,
  serverHasGates,
  suggestGateId,
  updateGateInConfig,
  validateGateDraft,
} from "../src/utils/gates";
import {
  TOKEN_PLACEHOLDER,
  buildDoorSavePayload,
  buildLockCommandRequest,
  buildLockStateUrl,
  doorsOf,
  interpretLockCommand,
  readLockState,
  withoutTokens,
} from "../src/utils/doors";
import { EMPTY_LOG_FILTERS, logFilterParams } from "../src/utils/accessLogs";
import { gateHasRecording, readRecordingGates } from "../src/utils/recordings";
import {
  buildPipelineModeRequest,
  gateKeysForCard,
  interpretPipelineModeResponse,
  readGatePipelineRows,
} from "../src/utils/pipelineMode";
import { shadowSummaryForGate } from "../src/utils/accuracyUi";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const gateBase = (name: string, gateType: "ENTRY" | "EXIT"): GateStreamConfig => ({
  gateType,
  name,
  enabled: true,
  sourceType: "RTSP",
  autoStart: true,
  reconnectIntervalSeconds: 5,
});

const globals = { workerThreadsCount: 4, multiThreadEnabled: true, autoFailoverToClientUvc: false, maxFpsPerStream: 30, backendCaptureFps: 15 };

/** What an older server sends: only the two legacy views. */
const OLD_CONFIG = {
  ...globals,
  entryGate: gateBase("Camera Cổng Vào", "ENTRY"),
  exitGate: gateBase("Camera Cổng Ra", "EXIT"),
} as CameraStreamsConfig;

/** What a new server sends: gates[] (wins) plus the legacy views. Two gates share ENTRY. */
const NEW_CONFIG = {
  ...OLD_CONFIG,
  gates: [
    { ...gateBase("Camera Cổng Vào", "ENTRY"), id: "entry", direction: "ENTRY", label: "Cổng vào" },
    { ...gateBase("Camera Cổng Ra", "EXIT"), id: "exit", direction: "EXIT", label: "Cổng ra", enabled: false },
    { ...gateBase("Camera kho", "ENTRY"), id: "kho-b", direction: "ENTRY", label: "Cổng kho B", doorId: "kho-b" },
    { ...gateBase("bad", "ENTRY"), id: "Bad Id", direction: "ENTRY" },
    { ...gateBase("dup", "EXIT"), id: "exit", direction: "EXIT" },
    { ...gateBase("sideways", "ENTRY"), id: "noway", direction: "SIDEWAYS" },
  ],
} as unknown as CameraStreamsConfig;

describe("gate adapter: both server shapes", () => {
  it("reads gates[] from a new server, in order, dropping invalid and duplicate entries", () => {
    const gates = gatesOf(NEW_CONFIG);
    assert.deepEqual(gates.map((g) => [g.id, g.direction, g.gateType]), [
      ["entry", "ENTRY", "ENTRY"],
      ["exit", "EXIT", "EXIT"],
      ["kho-b", "ENTRY", "ENTRY"],
    ]);
    assert.equal(serverHasGates(NEW_CONFIG), true);
    assert.equal(gateDoorId(gates[2]), "kho-b");
    assert.equal(gateDoorId(gates[0]), LEGACY_DOOR_ID, "no doorId = the legacy door main");
  });

  it("maps an old server's entryGate/exitGate to gates entry (ENTRY) and exit (EXIT)", () => {
    const gates = gatesOf(OLD_CONFIG);
    assert.deepEqual(gates.map((g) => [g.id, g.direction, g.name]), [
      ["entry", "ENTRY", "Camera Cổng Vào"],
      ["exit", "EXIT", "Camera Cổng Ra"],
    ]);
    assert.equal(serverHasGates(OLD_CONFIG), false);
    assert.deepEqual(gatesOf(null), []);
    assert.deepEqual(gatesOf({ ...OLD_CONFIG, gates: [] }).map((g) => g.id), ["entry", "exit"]);
  });

  it("mirrors the server's id rules and legacy derivation exactly", () => {
    assert.equal(String(GATE_ID_RE), String(serverGates.GATE_ID_RE));
    assert.equal(MAX_GATES, serverGates.MAX_GATES);
    assert.deepEqual([...LEGACY_GATE_IDS], [...serverGates.LEGACY_GATE_IDS]);
    assert.equal(LEGACY_DOOR_ID, serverGates.LEGACY_DOOR_ID);
    for (const v of ["entry", "exit", "side-door", "kho2", "", "e", "Entry", "2gate", "side_door", "a".repeat(33), null, 7]) {
      assert.equal(isGateId(v), serverGates.isGateId(v), String(v));
    }
    const rows = [{ type: "ENTRY" }, { type: "EXIT" }, { gateId: "side-door", type: "ENTRY" }, { gateId: "BAD", type: "EXIT" }, {}];
    for (const row of rows) assert.equal(eventGateId(row), serverGates.gateIdForLegacyRow(row), JSON.stringify(row));
  });

  it("keys runtimes and SSE payloads by gateId, falling back to the direction of an older server", () => {
    assert.equal(runtimeGateId({ gateId: "kho-b", gate: "ENTRY" }), "kho-b");
    assert.equal(runtimeGateId({ gateId: "entry", gate: "ENTRY" }), "entry");
    assert.equal(runtimeGateId({ gate: "EXIT" }), "exit");
    assert.equal(runtimeGateId({ gate: "entry" }), "entry");
    assert.equal(runtimeGateId({ gate: "SIDE" }), null);
    assert.equal(runtimeGateId(null), null);
    assert.equal(gateIdFromAny("Exit"), "exit");
    assert.equal(gateIdFromAny(42), null);
  });

  it("derives the gate of events written before gate ids: ENTRY -> entry, EXIT -> exit", () => {
    assert.equal(eventGateId({ type: "ENTRY" }), "entry");
    assert.equal(eventGateId({ type: "EXIT" }), "exit");
    assert.equal(eventGateId({ scanType: "EXIT" }), "exit", "the live feed's scanType alias");
    assert.equal(eventGateId({ type: "ENTRY", gateId: "kho-b" }), "kho-b");
    assert.equal(eventGateId({ type: "EXIT", gateId: "../x" }), "exit", "an invalid id is not trusted");
  });

  it("labels gates by label, then name, then the legacy label, and keeps removed gates readable", () => {
    assert.equal(gateDisplayLabel({ id: "kho-b", label: "Cổng kho B", name: "Camera kho" }), "Cổng kho B");
    assert.equal(gateDisplayLabel({ id: "entry", name: "Camera Cổng Vào" }), "Camera Cổng Vào");
    assert.equal(gateDisplayLabel({ id: "exit" }), "Cổng ra");
    assert.equal(gateDisplayLabel({ id: "side" }), "side");
    assert.equal(labelForGateId("kho-b", { "kho-b": "Cổng kho B" }), "Cổng kho B");
    assert.equal(labelForGateId("entry", {}), "Cổng vào");
    assert.equal(labelForGateId("old-gate", {}), "Cổng old-gate", "a deleted gate's history still shows its id");
  });

  it("updates one gate in either shape and keeps the legacy views in step", () => {
    const next = updateGateInConfig(NEW_CONFIG, "entry", (g) => ({ ...g, enabled: false }));
    assert.equal(gatesOf(next).find((g) => g.id === "entry")?.enabled, false);
    assert.equal(next.entryGate.enabled, false);
    const side = updateGateInConfig(NEW_CONFIG, "kho-b", (g) => ({ ...g, name: "X" }));
    assert.equal(gatesOf(side).find((g) => g.id === "kho-b")?.name, "X");
    assert.equal(side.entryGate, NEW_CONFIG.entryGate, "another gate sharing ENTRY does not touch the entry view");
    const old = updateGateInConfig(OLD_CONFIG, "exit", (g) => ({ ...g, name: "Ra mới" }));
    assert.equal(old.exitGate.name, "Ra mới");
    assert.equal(old.gates, undefined, "an older server's config gets no gates[]");
    assert.equal(updateGateInConfig(OLD_CONFIG, "nope", (g) => g), OLD_CONFIG);
  });

  it("orders rows by the gate list, then extra ids the server reported", () => {
    assert.deepEqual(orderedGateIds(gatesOf(NEW_CONFIG), ["exit", "late-gate", "BAD"]), ["entry", "exit", "kho-b", "late-gate"]);
    assert.deepEqual(orderedGateIds([], []), ["entry", "exit"]);
  });
});

describe("adding, editing and removing gates", () => {
  it("entry and exit can never be deleted; added gates can", () => {
    assert.equal(canDeleteGate("entry"), false);
    assert.equal(canDeleteGate("exit"), false);
    assert.equal(canDeleteGate("kho-b"), true);
    assert.equal(canDeleteGate("Bad Id"), false);
  });

  it("the delete confirmation says the history is kept", () => {
    const t = deleteGateConfirmText("Cổng kho B", "kho-b");
    assert.match(t.title, /Cổng kho B \(kho-b\)/);
    assert.match(t.body, /Lịch sử vào ra của cổng vẫn được giữ nguyên/);
    assert.match(t.body, /không dùng lại/);
  });

  it("validates a new gate before anything is sent", () => {
    const ids = ["entry", "exit"];
    const ok = { id: "kho-b", label: "Cổng kho B", direction: "ENTRY" as const, doorId: "main" };
    assert.equal(validateGateDraft(ok, ids), null);
    assert.match(validateGateDraft({ ...ok, id: "Kho B" }, ids)!, /Mã cổng gồm 2-32 ký tự/);
    assert.match(validateGateDraft({ ...ok, id: "exit" }, ids)!, /Đã có cổng mã "exit"/);
    assert.match(validateGateDraft({ ...ok, label: "  " }, ids)!, /tên hiển thị/);
    assert.match(validateGateDraft({ ...ok, direction: "" }, ids)!, /Vào hoặc Ra/);
    const full = Array.from({ length: MAX_GATES }, (_, i) => `g${i + 10}`);
    assert.match(validateGateDraft(ok, full)!, /Đã đủ 16 cổng/);
  });

  it("suggests a slug from a Vietnamese label", () => {
    assert.equal(suggestGateId("Cổng phụ Đông B"), "cong-phu-dong-b");
    assert.equal(suggestGateId("  2 Kho  "), "cong-2-kho");
    assert.equal(suggestGateId("!"), "");
    assert.ok(isGateId(suggestGateId("Một cái tên rất rất dài cho một cổng ở phía sau kho hàng")));
  });

  it("builds the admin requests on the contract routes", () => {
    const create = buildCreateGateRequest({ id: " kho-b ", label: " Cổng kho B ", direction: "EXIT", doorId: "kho-b" });
    assert.equal(create.url, "/api/gates");
    assert.equal(create.init.method, "POST");
    assert.deepEqual(JSON.parse(String(create.init.body)), { id: "kho-b", label: "Cổng kho B", direction: "EXIT", doorId: "kho-b" });
    const update = buildUpdateGateRequest("kho-b", { label: "B", direction: "ENTRY", doorId: "main" });
    assert.equal(update.url, "/api/gates/kho-b");
    assert.equal(update.init.method, "PUT");
    const del = buildDeleteGateRequest("kho-b");
    assert.equal(del.url, "/api/gates/kho-b");
    assert.equal(del.init.method, "DELETE");
    assert.equal(del.init.body, undefined);
  });

  it("only a 2xx success is applied; refusals and transport failures stay distinct", () => {
    const applied = interpretGateMutation("create", "Cổng kho B", { ok: true, status: 201, data: { success: true, config: NEW_CONFIG } });
    assert.equal(applied.kind, "applied");
    if (applied.kind === "applied") assert.equal(applied.config, NEW_CONFIG);
    const old = interpretGateMutation("create", "Cổng kho B", { ok: false, status: 404, data: undefined, error: "Máy chủ trả về trang lỗi HTML" });
    assert.equal(old.kind, "refused");
    assert.match(old.message, /chưa hỗ trợ quản lý nhiều cổng \(HTTP 404\)/);
    assert.match(old.message, /CHƯA được thêm/);
    const conflict = interpretGateMutation("delete", "Cổng vào", { ok: false, status: 409, data: { success: false, error: "Không xóa được cổng entry." } });
    assert.match(conflict.message, /^Không xóa được cổng entry\. Cổng vào CHƯA bị xóa\./);
    for (const status of [400, 403, 500, 503]) {
      assert.equal(interpretGateMutation("update", "X", { ok: false, status, data: { success: true } }).kind, "refused", `HTTP ${status}`);
    }
    assert.equal(interpretGateMutation("update", "X", { ok: true, status: 200, data: { success: false } }).kind, "refused");
    const offline = interpretGateMutation("update", "X", { ok: false, status: 0, data: undefined, error: "Failed to fetch" });
    assert.equal(offline.kind, "unreachable");
    assert.match(offline.message, /Không kết nối được máy chủ\. X CHƯA đổi\./);
  });
});

describe("access history by gate", () => {
  it("sends gateId next to (never instead of) the direction filter", () => {
    assert.equal(logFilterParams(EMPTY_LOG_FILTERS).has("gateId"), false);
    const p = logFilterParams({ ...EMPTY_LOG_FILTERS, gateId: "kho-b", type: "ENTRY" });
    assert.equal(p.get("gateId"), "kho-b");
    assert.equal(p.get("type"), "ENTRY");
    assert.equal(logFilterParams({ ...EMPTY_LOG_FILTERS, gateId: "x&y=1" }).has("gateId"), false, "only a valid id is sent");
  });

  it("recording badge per gate: direction keys from an older server, gate ids from a newer one", () => {
    const old = readRecordingGates({ success: true, enabled: true, gates: { ENTRY: true, EXIT: false }, windowSeconds: { before: 8, after: 7 } });
    assert.equal(gateHasRecording(old, "entry"), true);
    assert.equal(gateHasRecording(old, "exit"), false);
    const next = readRecordingGates({ success: true, enabled: true, gates: { ENTRY: false, entry: true, "kho-b": true } });
    assert.equal(gateHasRecording(next, "entry"), true, "the gate-id key wins over the direction spelling");
    assert.equal(gateHasRecording(next, "kho-b"), true);
    assert.equal(gateHasRecording(next, "exit"), false);
    assert.equal(gateHasRecording(readRecordingGates({ success: true, enabled: false, gates: { ENTRY: true } }), "entry"), false);
  });
});

describe("engine card rows keyed by gate id", () => {
  it("two gates sharing a direction are two rows; an older runtime keys by its direction", () => {
    const rows = readGatePipelineRows({
      watchers: [
        { gateId: "entry", gate: "ENTRY", pipelineMode: "shadow" },
        { gateId: "kho-b", gateLabel: "Cổng kho B", gate: "ENTRY", pipelineMode: "legacy" },
        { gate: "EXIT", pipelineMode: "legacy" },
      ],
    });
    assert.deepEqual(Object.keys(rows).sort(), ["entry", "exit", "kho-b"]);
    assert.equal(rows["kho-b"].gate, "ENTRY");
    assert.equal(rows["kho-b"].label, "Cổng kho B");
    assert.equal(rows.entry.view.mode, "shadow");
    assert.deepEqual(gateKeysForCard(gatesOf(NEW_CONFIG), rows), ["entry", "exit", "kho-b"]);
    assert.deepEqual(gateKeysForCard([], { "kho-b": rows["kho-b"] }), ["kho-b"]);
  });

  it("switches a new gate on its own route and trusts the asked gate when an older answer names only a direction", () => {
    assert.equal(buildPipelineModeRequest("kho-b", "shadow").url, "/api/camera-streams/kho-b/pipeline-mode");
    const out = interpretPipelineModeResponse(
      "kho-b",
      { ok: true, status: 200, data: { success: true, gate: "ENTRY", pipelineMode: "shadow" } },
      "Cổng kho B",
    );
    assert.equal(out.kind, "applied");
    if (out.kind === "applied") {
      assert.equal(out.gateId, "kho-b");
      assert.equal(out.gate, "ENTRY");
      assert.match(out.message, /^Cổng kho B: đang chạy/);
    }
  });

  it("finds a gate's 24 h accuracy row by gate id, and old rows by direction", () => {
    const view = (gate: string) => ({ gate, since: "", decisions: 1, employees: 0, strangers: 0, insufficient: 0, framesUsedZero: 0, agree: 0, shadowOnly: 0, legacyOnly: 0, identityMismatch: 0, none: 0, decisionLatencyP50Ms: null });
    const summary = { since: null, gates: [view("ENTRY"), view("kho-b")] };
    assert.equal(shadowSummaryForGate(summary, "entry")?.gate, "ENTRY");
    assert.equal(shadowSummaryForGate(summary, "kho-b")?.gate, "kho-b");
    assert.equal(shadowSummaryForGate(summary, "exit"), null);
  });
});

describe("doors: list, save body, lock per door", () => {
  const OLD_DOOR = { enabled: true, apiUrl: "https://door.example.invalid/open", apiToken: "s3cr3t-raw", authHeaderType: "BEARER", openMethod: "POST", closeMethod: "POST", pulseDurationSeconds: 6, triggerOnFaceRecognition: true, triggerOnManualUnlock: true };
  const NEW_DOORS = {
    ...OLD_DOOR,
    apiToken: "••••",
    doors: [
      { ...OLD_DOOR, id: "main", label: "Cửa chính", apiToken: "••••" },
      { ...OLD_DOOR, id: "kho-b", label: "Cửa kho B", apiToken: "", apiUrl: "https://kho.example.invalid/open" },
      { ...OLD_DOOR, id: "BAD", label: "x" },
    ],
  };

  it("reads doors[] (new) or the single config as door main (old), never keeping a token", () => {
    const fresh = doorsOf(NEW_DOORS);
    assert.equal(fresh.multiDoor, true);
    assert.deepEqual(fresh.doors.map((d) => [d.id, d.hasToken, d.apiToken]), [["main", true, ""], ["kho-b", false, ""]]);
    const legacy = doorsOf(OLD_DOOR);
    assert.equal(legacy.multiDoor, false);
    assert.deepEqual(legacy.doors.map((d) => [d.id, d.label, d.hasToken, d.apiToken]), [["main", "Cửa chính", true, ""]]);
    assert.doesNotMatch(JSON.stringify([fresh, legacy]), /s3cr3t-raw|••••/);
  });

  it("sends a token only when typed; the top level mirrors door main; doors[] only to a server that has it", () => {
    const { doors } = doorsOf(NEW_DOORS);
    const untouched = buildDoorSavePayload(doors, {}, true);
    assert.equal("apiToken" in untouched, false);
    assert.equal(untouched.apiUrl, "https://door.example.invalid/open");
    assert.equal("id" in untouched, false);
    const list = untouched.doors as Array<Record<string, unknown>>;
    assert.deepEqual(list.map((d) => d.id), ["main", "kho-b"]);
    assert.ok(list.every((d) => !("apiToken" in d) && !("hasToken" in d)));
    const typed = buildDoorSavePayload(doors, { "kho-b": " new-token " }, true);
    assert.equal((typed.doors as Array<Record<string, unknown>>)[1].apiToken, "new-token");
    assert.equal("apiToken" in typed, false, "main's stored token is kept");
    const legacy = buildDoorSavePayload(doorsOf(OLD_DOOR).doors, {}, false);
    assert.equal("doors" in legacy, false);
    assert.equal("apiToken" in legacy, false);
    assert.doesNotMatch(JSON.stringify(withoutTokens(NEW_DOORS)), /••••|apiToken/);
  });

  it("reads and commands the lock of one door; an older server's single lock is door main only", () => {
    assert.equal(buildLockStateUrl("kho-b"), "/api/lock/state?doorId=kho-b");
    const cmd = buildLockCommandRequest("unlock", "kho-b", "Trang Cấu Hình Cửa");
    assert.equal(cmd.url, "/api/lock/unlock");
    assert.deepEqual(JSON.parse(String(cmd.init.body)), { doorId: "kho-b", source: "Trang Cấu Hình Cửa" });
    const legacyState = { lockId: "L1", doorName: "Cửa chính", state: "LOCKED", isLocked: true };
    assert.equal(readLockState(legacyState, "main")?.doorId, "main");
    assert.equal(readLockState(legacyState, "kho-b"), null, "door main's state is never shown for another door");
    assert.equal(readLockState({ success: true, lockState: { ...legacyState, doorId: "kho-b", isLocked: false, state: "UNLOCKED" } }, "kho-b")?.isLocked, false);
    assert.equal(readLockState("<html>", "main"), null);
  });

  it("a refused or failed door command is never shown as an opened door", () => {
    const refused = interpretLockCommand("unlock", "kho-b", "Cửa kho B", { ok: false, status: 403, data: { success: false } });
    assert.equal(refused.kind, "refused");
    assert.match(refused.message, /Quản trị.*Cửa kho B CHƯA được mở\./);
    const offline = interpretLockCommand("unlock", "kho-b", "Cửa kho B", { ok: false, status: 0, data: undefined });
    assert.equal(offline.kind, "unreachable");
    assert.equal(interpretLockCommand("unlock", "kho-b", "X", { ok: true, status: 200, data: { success: false } }).kind, "refused");
    const ok = interpretLockCommand("lock", "kho-b", "Cửa kho B", { ok: true, status: 200, data: { success: true, lockState: { doorId: "kho-b", state: "LOCKED", isLocked: true } } });
    assert.equal(ok.kind, "applied");
    if (ok.kind === "applied") assert.equal(ok.lockState?.isLocked, true);
    assert.equal(TOKEN_PLACEHOLDER, "<TOKEN>");
  });
});

describe("component sources: gates keyed by id, never by direction", () => {
  const CHANGED = [
    "src/components/CameraStreamConfigPage.tsx",
    "src/components/CameraDashboard.tsx",
    "src/components/RealtimeEngineCard.tsx",
    "src/components/FaceScanner.tsx",
    "src/components/AccessLogs.tsx",
    "src/components/EmployeeRegistration.tsx",
    "src/components/DoorConfigPage.tsx",
    "src/components/GateAreaEditor.tsx",
    "src/utils/pipelineMode.ts",
    "src/utils/recordings.ts",
  ];
  const DIRECTION_KEYED: Array<[RegExp, string]> = [
    [/"entry" \| "exit"/, "a two-gate key type"],
    [/\b(?:entry|exit)(?:State|VideoRef|MediaStreamRef|Streams|Primary)\b/, "per-direction state or refs"],
    [/=== "ENTRY" \? "entry"|=== "EXIT" \? "exit"|=== "ENTRY" \? set|gateType === "ENTRY" \? /, "a direction -> key mapping"],
    [/\bGATE_KEYS\b/, "the fixed two-gate key list"],
    [/\[gateKeyOf\(/, "a map indexed by a direction-derived key"],
    [/recordingGates\[/, "a recording flag indexed by direction"],
    [/DUAL_MONITOR/, "the two-gate overview tab"],
  ];

  it("has no direction-keyed per-gate state left in the changed files", () => {
    for (const path of CHANGED) {
      const src = read(path);
      for (const [re, what] of DIRECTION_KEYED) assert.doesNotMatch(src, re, `${path}: ${what}`);
    }
  });

  it("camera page: gate tabs from the list, delete disabled for entry/exit, mutations through the session helper", () => {
    const src = read("src/components/CameraStreamConfigPage.tsx");
    assert.match(src, /role="tablist" aria-label="Danh sách cổng"/);
    assert.match(src, /\{gates\.map\(\(g\) => \{/);
    assert.match(src, /aria-selected=\{selected\}/);
    assert.match(src, /e\.key === "ArrowRight"/);
    assert.match(src, /disabled=\{!canDeleteGate\(currentGateKey\) \|\| !multiGate \|\| gateBusy\}/);
    assert.match(src, /if \(!target \|\| !canDeleteGate\(target\.id\)\)/);
    assert.match(src, /role="alertdialog"/);
    assert.equal((src.match(/await operatorJsonFetch<unknown>\(url, init\)/g) || []).length, 3, "create, update and delete");
    assert.match(src, /interpretGateMutation\("create"/);
    assert.match(src, /enabledGates\(gates\)\.map\(\(gate\) =>/, "the overview is a grid of every enabled gate");
    assert.match(src, /scanType: currentGateConfig\.direction/);
    assert.doesNotMatch(src, /localStorage\.setItem\("smartface_camera_streams_config"/, "no camera URLs in browser storage");
  });

  it("dashboard: SSE by gateId, per-gate maps, gate's own door, explicit webcam cleanup", () => {
    const src = read("src/components/CameraDashboard.tsx");
    assert.match(src, /const key = runtimeGateId\(payload\);/);
    assert.match(src, /const gateId = runtimeGateId\(raw\);/);
    assert.match(src, /useState<Record<GateKey, StreamScanState>>\(\{\}\)/);
    assert.match(src, /useRef<Record<GateKey, MediaStream \| null>>\(\{\}\)/);
    assert.match(src, /doorId: gateDoorId\(gate\)/);
    assert.match(src, /result\.status === 0 && demoOfflinePersistenceEnabled\(\)/, "only a transport failure on the demo build is simulated");
    assert.match(src, /scanType: gateConfig\.direction/);
    assert.match(src, /mediaStreamRefs\.current\[gateId\]\?\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
    assert.match(src, /Bật tất cả cổng/);
  });

  it("scanner, logs, enrolment and engine card read the gate list", () => {
    assert.match(read("src/components/FaceScanner.tsx"), /id="select-scanner-gate"/);
    assert.match(read("src/components/FaceScanner.tsx"), /gateId: scanGate\?\.id/);
    const logs = read("src/components/AccessLogs.tsx");
    assert.match(logs, /id="select-logs-gate"/);
    assert.match(logs, /const gateId = eventGateId\(log\);/);
    assert.match(logs, /gateHasRecording\(recordingGates, gateId\)/);
    const enrol = read("src/components/EmployeeRegistration.tsx");
    assert.match(enrol, /configGates\.map\(\(g\) => \(/);
    assert.match(enrol, /templateSections\.map\(\(section\) =>/);
    assert.match(read("src/components/RealtimeEngineCard.tsx"), /gateKeysForCard\(gates, rows\)\.map\(renderRow\)/);
  });

  it("door page: never shows a token back, lock per door, server answers only", () => {
    const src = read("src/components/DoorConfigPage.tsx");
    assert.doesNotMatch(src, /value=\{config\.apiToken\}/);
    assert.doesNotMatch(src, /\$\{config\.apiToken\}/);
    assert.match(src, /TOKEN_PLACEHOLDER/);
    assert.match(src, /buildDoorSavePayload\(doors, tokenDrafts, multiDoor\)/);
    assert.match(src, /buildLockStateUrl\(doorId\)/);
    assert.match(src, /interpretLockCommand\(action, door\.id, label, res\)/);
    assert.match(src, /const canOperateDoor = hasRole\(useOperatorSession\(\), "admin"\)/);
    assert.doesNotMatch(src, /clientDoorUnlock/);
  });

  it("new and changed copy never calls the gap between scans a period or frequency", () => {
    const banned = /chu kỳ|tần suất|(?:quét|lượt) mỗi\s*~?\s*[\d{]/i;
    for (const path of [
      "src/utils/gates.ts",
      "src/utils/doors.ts",
      "src/components/ModalDialog.tsx",
      "src/components/CameraDashboard.tsx",
      "src/components/RealtimeEngineCard.tsx",
      "src/components/DoorConfigPage.tsx",
    ]) {
      assert.doesNotMatch(read(path), banned, path);
    }
  });
});

// Type-level check that the adapter returns the shared contract type.
const _typed: GateConfig[] = gatesOf(NEW_CONFIG);
void _typed;
