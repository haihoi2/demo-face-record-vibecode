/**
 * The real-time engine card: per-gate switch of the pipeline flow (legacy |
 * shadow | live). Pure helpers first, then source-level checks that the card
 * stays a separate flow (never writes `engineMode`), goes through the
 * CSRF-aware session helper, and keeps the accessibility and wording rules.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LEGACY_GATE_KEYS,
  PIPELINE_MODES,
  PIPELINE_MODE_UNAVAILABLE_TITLE,
  buildPipelineModeRequest,
  gateKeyOf,
  gateLabel,
  interpretPipelineModeResponse,
  isPipelineModeSelectable,
  parsePipelineModeSource,
  pipelineModeConfirmText,
  pipelineModeSourceLabel,
  readGatePipelineRow,
  readGatePipelineRows,
} from "../src/utils/pipelineMode";
import { normalizePipelineStats, workerStateLabel } from "../src/utils/pipelineStatus";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("mode source and gate labels", () => {
  it("labels the source as agreed and admits it when the server sends none", () => {
    assert.equal(parsePipelineModeSource("config"), "config");
    assert.equal(parsePipelineModeSource("ENV"), "env");
    assert.equal(parsePipelineModeSource("file"), null);
    assert.equal(pipelineModeSourceLabel("config"), "theo cấu hình");
    assert.equal(pipelineModeSourceLabel("env"), "mặc định máy chủ");
    assert.equal(pipelineModeSourceLabel(null), "máy chủ chưa báo nguồn");
  });

  it("maps gates both ways (N-gate wave: any configured slug is a gate id)", () => {
    assert.deepEqual([...LEGACY_GATE_KEYS], ["entry", "exit"]);
    assert.equal(gateKeyOf("ENTRY"), "entry");
    assert.equal(gateKeyOf("exit"), "exit");
    assert.equal(gateKeyOf("side"), "side");
    assert.equal(gateKeyOf("SIDE"), null, "neither a slug nor a direction");
    assert.equal(gateLabel("entry"), "Cổng vào");
    assert.equal(gateLabel("exit"), "Cổng ra");
    assert.equal(gateLabel("side", "Cổng phụ"), "Cổng phụ");
    assert.equal(gateLabel("side"), "Cổng side");
  });

  it("offers legacy and shadow; live is greyed out with the agreed title", () => {
    assert.deepEqual([...PIPELINE_MODES], ["legacy", "shadow", "live"]);
    assert.equal(isPipelineModeSelectable("legacy"), true);
    assert.equal(isPipelineModeSelectable("shadow"), true);
    assert.equal(isPipelineModeSelectable("live"), false);
    assert.equal(PIPELINE_MODE_UNAVAILABLE_TITLE, "chưa có trong bản này");
  });
});

describe("reading one gate's row from the watcher payload", () => {
  it("server default: effective mode shown, nothing marked as configured", () => {
    const row = readGatePipelineRow({ gate: "EXIT", enabled: true, pipelineMode: "shadow", pipelineModeSource: "env" })!;
    assert.equal(row.key, "exit");
    assert.equal(row.gate, "EXIT");
    assert.equal(row.enabled, true);
    assert.equal(row.view.mode, "shadow");
    assert.equal(row.source, "env");
    assert.equal(row.configured, null);
  });

  it("configured live but downgraded: the switch shows live, the chip shows legacy", () => {
    const row = readGatePipelineRow({
      gate: "ENTRY",
      enabled: false,
      pipelineMode: "legacy",
      pipelineModeRequested: "live",
      pipelineModeSource: "config",
    })!;
    assert.equal(row.view.mode, "legacy");
    assert.equal(row.view.requested, "live");
    assert.equal(row.configured, "live");
    assert.equal(row.enabled, false);
  });

  it("older server without the new fields: no source, no configured value, no invented mode", () => {
    const row = readGatePipelineRow({ gate: "ENTRY", enabled: true })!;
    assert.equal(row.source, null);
    assert.equal(row.configured, null);
    assert.equal(row.view.mode, null);
    assert.equal(row.enabled, true);
  });

  it("drops rows without a known gate and reads the list defensively", () => {
    assert.equal(readGatePipelineRow({ gate: "SIDE" }), null);
    assert.equal(readGatePipelineRow("EXIT"), null);
    const rows = readGatePipelineRows({
      success: true,
      watchers: [{ gate: "ENTRY", pipelineMode: "legacy" }, { gate: "EXIT", pipelineMode: "shadow", pipelineModeSource: "config" }, 42],
    });
    assert.equal(rows.entry?.view.mode, "legacy");
    assert.equal(rows.exit?.configured, "shadow");
    assert.deepEqual(readGatePipelineRows({ watchers: "none" }), {});
    assert.deepEqual(readGatePipelineRows(null), {});
  });
});

describe("the switch request", () => {
  it("POSTs JSON to the per-gate route", () => {
    const { url, init } = buildPipelineModeRequest("exit", "shadow");
    assert.equal(url, "/api/camera-streams/exit/pipeline-mode");
    assert.equal(init.method, "POST");
    assert.deepEqual(init.headers, { "Content-Type": "application/json" });
    assert.deepEqual(JSON.parse(String(init.body)), { mode: "shadow" });
  });

  it("clears the override with an explicit null", () => {
    const { url, init } = buildPipelineModeRequest("entry", null);
    assert.equal(url, "/api/camera-streams/entry/pipeline-mode");
    assert.equal(String(init.body), '{"mode":null}');
  });
});

describe("confirmation wording", () => {
  it("shadow spells out the extra stream and worker and that it only observes", () => {
    const t = pipelineModeConfirmText("exit", "shadow");
    assert.match(t.title, /Cổng ra/);
    assert.match(t.body, /một luồng camera luôn mở và một worker nhận diện riêng cho cổng này/);
    assert.match(t.body, /chỉ quan sát, không mở cửa, không ghi nhật ký/);
  });

  it("back to legacy says the separate stream and worker stop and the door is unaffected", () => {
    const t = pipelineModeConfirmText("entry", "legacy");
    assert.match(t.title, /Cổng vào/);
    assert.match(t.body, /dừng luồng camera riêng và worker/);
    assert.match(t.body, /mở cửa không thay đổi/);
  });

  it("server default and live are also explained", () => {
    assert.match(pipelineModeConfirmText("entry", null).body, /mặc định của máy chủ/);
    assert.match(pipelineModeConfirmText("entry", "live").body, new RegExp(PIPELINE_MODE_UNAVAILABLE_TITLE));
  });
});

describe("what the server's answer means", () => {
  const ok = (data: unknown) => ({ ok: true, status: 200, data });
  const refused = (status: number, data: unknown, error?: string) => ({ ok: false, status, data, error });

  it("200 success is applied and carries the returned watcher and the new effective mode", () => {
    const out = interpretPipelineModeResponse("exit", ok({
      success: true,
      gate: "EXIT",
      pipelineMode: "shadow",
      pipelineModeSource: "config",
      watcher: { gate: "EXIT", pipelineMode: "shadow", pipelineModeSource: "config" },
    }));
    assert.equal(out.kind, "applied");
    if (out.kind !== "applied") return;
    assert.equal(out.gate, "EXIT");
    assert.equal(out.mode, "shadow");
    assert.equal(out.requested, null);
    assert.equal(out.source, "config");
    assert.deepEqual(out.watcher, { gate: "EXIT", pipelineMode: "shadow", pipelineModeSource: "config" });
    assert.match(out.message, /Cổng ra: đang chạy chạy thử \(shadow\) \(theo cấu hình\)/);
  });

  it("200 with a downgraded request says so", () => {
    const out = interpretPipelineModeResponse("entry", ok({
      success: true, gate: "ENTRY", pipelineMode: "legacy", pipelineModeRequested: "live", pipelineModeSource: "config",
    }));
    assert.equal(out.kind, "applied");
    if (out.kind !== "applied") return;
    assert.equal(out.requested, "live");
    assert.match(out.message, /Đã cấu hình đang áp dụng \(live\) nhưng máy chủ chưa có chế độ này/);
  });

  it("409 shows the server's own message and code", () => {
    const out = interpretPipelineModeResponse("entry", refused(409, {
      success: false, code: "PIPELINE_MODE_NOT_AVAILABLE", error: "Chế độ live chưa có trong bản này.",
    }));
    assert.equal(out.kind, "refused");
    if (out.kind !== "refused") return;
    assert.equal(out.status, 409);
    assert.equal(out.code, "PIPELINE_MODE_NOT_AVAILABLE");
    assert.match(out.message, /^Chế độ live chưa có trong bản này\./);
    assert.match(out.message, /CHƯA đổi/);
  });

  it("403 needs admin, 401 needs sign-in, 404 means an older server, 400 echoes the server", () => {
    const r403 = interpretPipelineModeResponse("exit", refused(403, { success: false }));
    assert.equal(r403.kind, "refused");
    assert.match(r403.message, /Quản trị/);
    const r401 = interpretPipelineModeResponse("exit", refused(401, null));
    assert.match(r401.message, /đăng nhập/);
    const r404 = interpretPipelineModeResponse("exit", refused(404, "<!DOCTYPE html>"));
    assert.match(r404.message, /HTTP 404/);
    const r400 = interpretPipelineModeResponse("exit", refused(400, { success: false, error: "Chế độ không hợp lệ: fast." }));
    assert.match(r400.message, /^Chế độ không hợp lệ: fast\./);
  });

  it("never turns a refusal or a false success into applied", () => {
    for (const status of [400, 403, 409, 500, 502, 503]) {
      assert.equal(interpretPipelineModeResponse("entry", refused(status, { success: true, pipelineMode: "shadow" })).kind, "refused", `HTTP ${status}`);
    }
    assert.equal(interpretPipelineModeResponse("entry", ok({ success: false, error: "nope" })).kind, "refused");
    assert.equal(interpretPipelineModeResponse("entry", ok("shadow")).kind, "refused");
  });

  it("a transport failure is unreachable, not a refusal and not success", () => {
    const out = interpretPipelineModeResponse("exit", { ok: false, status: 0, data: undefined, error: "Failed to fetch" });
    assert.equal(out.kind, "unreachable");
    assert.match(out.message, /Không kết nối được máy chủ/);
    assert.match(out.message, /CHƯA đổi/);
  });
});

describe("pipeline stats the card shows", () => {
  it("reads the counters, context and worker, masking credentials in messages", () => {
    const s = normalizePipelineStats({
      decisions: 12, employees: 9, strangers: 2, insufficient: 1, framesProcessed: 4000.9, framesDroppedBusy: 7,
      lastLoopMs: 88.5, lastDecisionLatencyMs: 640, contextOk: false,
      contextReason: "gallery empty at rtsp://admin:pw@192.168.60.1/x",
      worker: { state: "running", restarts: 1, engineReady: true, openTracks: 2, detectInput: "640x640" },
      lastError: "worker exited",
    })!;
    assert.equal(s.decisions, 12);
    assert.equal(s.employees, 9);
    assert.equal(s.strangers, 2);
    assert.equal(s.insufficient, 1);
    assert.equal(s.framesProcessed, 4000);
    assert.equal(s.framesDroppedBusy, 7);
    assert.equal(s.lastLoopMs, 88.5);
    assert.equal(s.contextOk, false);
    assert.equal(s.contextReason, "gallery empty at rtsp://•••@192.168.60.1/x");
    assert.deepEqual(s.worker, { state: "running", restarts: 1, engineReady: true, openTracks: 2, detectInput: "640x640" });
    assert.equal(s.lastError, "worker exited");
  });

  it("keeps the W0 shape for an older server and drops an empty worker", () => {
    assert.deepEqual(normalizePipelineStats({ lastDecisionLatencyMs: 640, decisions: 12.7 }), { lastDecisionLatencyMs: 640, decisions: 12 });
    assert.deepEqual(normalizePipelineStats({ decisions: 3, worker: {} }), { decisions: 3 });
    assert.equal(normalizePipelineStats({ worker: {} }), null);
  });

  it("labels worker states and passes unknown strings through", () => {
    assert.equal(workerStateLabel("running"), "đang chạy");
    assert.equal(workerStateLabel("restarting"), "đang khởi động lại");
    assert.equal(workerStateLabel("degraded"), "degraded");
    assert.equal(workerStateLabel(null), "—");
  });
});

describe("the card in the source", () => {
  const card = read("src/components/RealtimeEngineCard.tsx");
  const page = read("src/components/AiConfigPage.tsx");

  it("is a separate flow: never reads or writes engineMode or the AI config", () => {
    assert.doesNotMatch(card, /engineMode/);
    assert.doesNotMatch(card, /setConfig|saveStoredAiConfig|\/api\/config\/ai/);
  });

  it("never touches a door", () => {
    assert.doesNotMatch(card, /\/api\/lock|unlock/i);
  });

  it("writes through the CSRF-aware session helper and reads the watch route", () => {
    assert.match(card, /operatorJsonFetch<unknown>\(url, init\)/);
    assert.match(card, /safeJsonFetch<unknown>\("\/api\/camera-streams\/watch"\)/);
    assert.doesNotMatch(card, /\bfetch\(/);
  });

  it("shows the switch to admins only", () => {
    assert.match(card, /const isAdmin = hasRole\(session, "admin"\)/);
    assert.match(card, /Đổi chế độ cần quyền Quản trị/);
  });

  it("polls only while visible and cleans up", () => {
    assert.match(card, /const POLL_MS = 5000/);
    assert.match(card, /document\.visibilityState === "hidden"\) return/);
    assert.match(card, /clearInterval\(timer\)/);
    assert.match(card, /removeEventListener\("visibilitychange"/);
  });

  it("has an accessible confirm dialog and a live region", () => {
    assert.match(card, /role="dialog"/);
    assert.match(card, /aria-modal="true"/);
    assert.match(card, /aria-labelledby="rt-engine-confirm-title"/);
    assert.match(card, /e\.key === "Escape"/);
    assert.match(card, /role="status" aria-live="polite"/);
    assert.match(card, /role="group" aria-label=/);
    assert.match(card, /aria-pressed=\{selected\}/);
  });

  it("is rendered on the engine tab and the deployment note mentions the per-gate switch", () => {
    const engineTab = page.slice(page.indexOf('activeTabSection === "engine" && ('), page.indexOf("SECTION 2: GOOGLE AI"));
    assert.match(engineTab, /<RealtimeEngineCard \/>/);
    assert.match(engineTab, /Động cơ thời gian thực là luồng riêng, không thuộc ba chế độ này/);
    assert.match(engineTab, /cho từng cổng/);
    // The card sits outside the three selectable cards (each of which sets engineMode on click).
    const cardIndex = engineTab.indexOf("<RealtimeEngineCard />");
    const lastSelectable = engineTab.lastIndexOf('engineMode: "HYBRID_AUTO"');
    assert.ok(cardIndex > lastSelectable, "the fourth card comes after the three engineMode cards");
    assert.doesNotMatch(engineTab.slice(cardIndex), /engineMode: "/, "nothing after the card sets engineMode");
  });

  it("never describes the gap between scans as a period or frequency", () => {
    const banned = /chu kỳ|tần suất|(?:quét|lượt) mỗi\s*~?\s*[\d{]/i;
    for (const path of ["src/utils/pipelineMode.ts", "src/components/RealtimeEngineCard.tsx"]) {
      assert.doesNotMatch(read(path), banned, path);
    }
  });
});
