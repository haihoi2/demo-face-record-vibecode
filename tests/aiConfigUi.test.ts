/**
 * "Cấu hình AI" page tells the truth about which recognition engine runs
 * (2026-11-02). Pure helpers from src/utils/aiConfigTruth.ts plus source
 * inspection of src/components/AiConfigPage.tsx. No browser.
 *
 * Backend facts pinned here were verified in server.ts / src/server/faceWorker.ts:
 * the door decision always uses the ONNX engine when FACE_ENGINE=onnx; engineMode,
 * googleAi.*, modelArchitecture, liveness/antiSpoofing/autoContrast/maxFaces and
 * hybridSettings are read only by the legacy recognizeFrame path (fail-closed when
 * it runs); similarityThreshold maps to fusion acceptSingle; the old benchmark
 * route only measured the demo worker pool.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ARCHITECTURE_DISPLAY_ONLY_BADGE,
  ARCHITECTURE_DISPLAY_ONLY_HINT,
  BENCHMARK_RETIRED_TEXT,
  BENCHMARK_RETIRED_TITLE,
  ENGINE_SOURCE_SENTENCE,
  LEGACY_EDIT_TOGGLE_LABEL,
  LEGACY_SECTION_HINT,
  LEGACY_SECTION_TITLE,
  bestOfRows,
  faceExtractRows,
  faceExtractStateLabel,
  formatCount,
  formatMs,
  legacyEngineModeLabel,
  readBestOfTelemetry,
  readFaceExtractTelemetry,
} from "../src/utils/aiConfigTruth";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Shape of GET /api/face-engine/status as server.ts builds it today.
const status = {
  success: true,
  engine: "onnx",
  requestedEngine: "onnx",
  ready: true,
  failClosed: false,
  info: { detectorModel: "det_10g", recognizerModel: "w600k_r50", embeddingDim: 512 },
  templates: { total: 12, byEmployee: { a: 6, b: 6 }, modelTag: "w600k_r50", matchingModelTag: 12 },
  thresholds: { acceptSingle: 0.5, minEvidence: 0.3, acceptFused: 0.45, minAgreeing: 2, minMargin: 0.08 },
  faceExtract: {
    enabled: true,
    ready: true,
    workers: 2,
    readyWorkers: 2,
    busy: 1,
    queued: 0,
    queueMax: 8,
    taskTimeoutMs: 4000,
    ortThreadsPerWorker: 1,
    modelTag: "w600k_r50",
    completed: 1543,
    failed: 3,
    failedByCode: { timeout: 3 },
    restarts: 0,
    avgWorkerMs: 212.4,
    avgTotalMs: 230.1,
    lastError: null,
  },
  bestOf: { extraFrames: 2, full: 900, trimmed: 40, skipped: 12 },
};

describe("wording", () => {
  it("says the server config picks the door engine, not the page", () => {
    assert.match(ENGINE_SOURCE_SENTENCE, /FACE_ENGINE \/ FACE_RECOGNIZER_MODEL/);
    assert.match(ENGINE_SOURCE_SENTENCE, /không phải bởi trang này/);
  });

  it("labels the legacy settings as not affecting the door and fail-closed", () => {
    assert.equal(LEGACY_SECTION_TITLE, "Cấu hình cũ (không ảnh hưởng quyết định cửa)");
    assert.match(LEGACY_SECTION_HINT, /^Chưa triển khai cho luồng cửa/);
    assert.match(LEGACY_SECTION_HINT, /recognizeFrame/);
    assert.match(LEGACY_SECTION_HINT, /fail-closed/);
    assert.match(LEGACY_SECTION_HINT, /Gemini không bao giờ mở cửa/);
    assert.match(LEGACY_EDIT_TOGGLE_LABEL, /không khuyến nghị/);
  });

  it("marks modelArchitecture as display-only over the demo matcher", () => {
    assert.equal(ARCHITECTURE_DISPLAY_ONLY_BADGE, "Chỉ hiển thị");
    assert.match(ARCHITECTURE_DISPLAY_ONLY_HINT, /chỉ đổi tên hiển thị/);
    assert.match(ARCHITECTURE_DISPLAY_ONLY_HINT, /src\/server\/faceWorker\.ts/);
  });

  it("explains what the retired benchmark measured and where real comparison happens", () => {
    assert.equal(BENCHMARK_RETIRED_TITLE, "Benchmark cũ đã gỡ khỏi giao diện");
    assert.match(BENCHMARK_RETIRED_TEXT, /POST \/api\/config\/ai\/benchmark/);
    assert.match(BENCHMARK_RETIRED_TEXT, /worker demo/);
    assert.match(BENCHMARK_RETIRED_TEXT, /vector tổng hợp/);
    assert.match(BENCHMARK_RETIRED_TEXT, /không đo gì về nhận diện thật/);
    assert.match(BENCHMARK_RETIRED_TEXT, /Taiga #513/);
    assert.match(BENCHMARK_RETIRED_TEXT, /GET \/api\/face-engine\/status/);
  });

  it("never presents a legacy engineMode as the live engine", () => {
    assert.equal(legacyEngineModeLabel("GOOGLE_GEMINI"), "Google Gemini (cũ)");
    assert.equal(legacyEngineModeLabel("LOCAL_BIOMETRIC"), "Local demo (cũ)");
    assert.equal(legacyEngineModeLabel("HYBRID_AUTO"), "Hybrid Auto (cũ)");
    assert.equal(legacyEngineModeLabel(undefined), "không rõ");
    assert.equal(legacyEngineModeLabel("nope"), "không rõ");
  });

  it("never describes the gap between scans as a period or frequency", () => {
    const banned = /chu kỳ|tần suất|(?:quét|lượt) mỗi\s*~?\s*[\d{]/i;
    for (const path of ["src/utils/aiConfigTruth.ts", "src/components/AiConfigPage.tsx"]) {
      assert.doesNotMatch(read(path), banned, path);
    }
  });
});

describe("live telemetry readers", () => {
  it("reads faceExtract and bestOf from the status body", () => {
    const fe = readFaceExtractTelemetry(status);
    assert.ok(fe);
    assert.equal(fe.enabled, true);
    assert.equal(fe.readyWorkers, 2);
    assert.equal(fe.completed, 1543);
    assert.equal(fe.failed, 3);
    assert.equal(fe.avgWorkerMs, 212.4);
    assert.equal(fe.avgTotalMs, 230.1);
    assert.equal(fe.modelTag, "w600k_r50");
    assert.equal(fe.lastError, null);
    assert.deepEqual(readBestOfTelemetry(status), { extraFrames: 2, full: 900, trimmed: 40, skipped: 12 });
  });

  it("returns null, not a guess, when an older server omits the blocks", () => {
    assert.equal(readFaceExtractTelemetry({ success: true, engine: "onnx" }), null);
    assert.equal(readBestOfTelemetry({ success: true, engine: "onnx" }), null);
    assert.equal(readFaceExtractTelemetry(null), null);
    assert.equal(readFaceExtractTelemetry("<!doctype html>"), null);
    assert.equal(readBestOfTelemetry({ bestOf: [1, 2] }), null);
  });

  it("keeps unknown fields as null and formats them as an em dash", () => {
    const fe = readFaceExtractTelemetry({ faceExtract: { completed: "12", avgWorkerMs: Number.NaN, lastError: "  " } });
    assert.ok(fe);
    assert.equal(fe.completed, null);
    assert.equal(fe.avgWorkerMs, null);
    assert.equal(fe.lastError, null);
    assert.equal(formatCount(null), "—");
    assert.equal(formatMs(null), "—");
    assert.equal(formatMs(212.4), "212.4 ms");
    assert.equal(formatCount(0), "0");
  });

  it("labels the pool state honestly", () => {
    assert.equal(faceExtractStateLabel(null), "máy chủ chưa báo");
    assert.equal(faceExtractStateLabel(readFaceExtractTelemetry(status)), "sẵn sàng");
    assert.equal(faceExtractStateLabel(readFaceExtractTelemetry({ faceExtract: { enabled: false } })), "tắt (trích xuất trên luồng chính)");
    assert.equal(faceExtractStateLabel(readFaceExtractTelemetry({ faceExtract: { enabled: true, ready: false } })), "chưa sẵn sàng");
    assert.equal(faceExtractStateLabel(readFaceExtractTelemetry({ faceExtract: {} })), "không rõ");
  });

  it("lists the rows the metrics tab shows, in order", () => {
    const fe = readFaceExtractTelemetry(status)!;
    const rows = faceExtractRows(fe);
    assert.deepEqual(
      rows.map((r) => r.key),
      ["workers", "busy", "queued", "completed", "failed", "restarts", "avgWorkerMs", "avgTotalMs"]
    );
    assert.equal(rows.find((r) => r.key === "workers")!.value, "2 / 2");
    assert.equal(rows.find((r) => r.key === "avgWorkerMs")!.value, "212.4 ms");
    const b = bestOfRows(readBestOfTelemetry(status)!);
    assert.deepEqual(
      b.map((r) => r.key),
      ["extraFrames", "full", "trimmed", "skipped"]
    );
    assert.equal(b[2].value, "40");
  });
});

describe("the page in the source", () => {
  const page = read("src/components/AiConfigPage.tsx");

  it("keeps the truthful engine status first and the server-config sentence under it", () => {
    assert.match(page, /safeJsonFetch<FaceEngineStatus>\("\/api\/face-engine\/status"\)/);
    assert.match(page, /\{ENGINE_SOURCE_SENTENCE\}/);
    assert.match(page, /Động cơ quyết định cửa: /);
    // The quick strip reads the server status, not the stored engineMode.
    const strip = page.slice(page.indexOf("Quick strip"), page.indexOf("Navigation Sub-tabs"));
    assert.doesNotMatch(strip, /config\.engineMode/);
    assert.doesNotMatch(page, /Local Edge Biometrics|Hybrid Auto \(Kép\)|< 40ms \(Siêu tốc\)|Mã hóa TLS 1\.3/);
  });

  it("collapses the legacy engine mode, Google and hybrid settings and keeps them read-only by default", () => {
    assert.match(page, /<details id="ai-config-legacy"/);
    assert.match(page, /\{LEGACY_SECTION_TITLE\}/);
    assert.match(page, /\{LEGACY_SECTION_HINT\}/);
    assert.match(page, /\[legacyEditable, setLegacyEditable\] = useState<boolean>\(false\)/, "legacyEditable starts false");
    assert.match(page, /id="chk-legacy-editable"/);
    const legacy = page.slice(page.indexOf('<details id="ai-config-legacy"'), page.indexOf("</details>"));
    for (const id of ["card-engine-google", "card-engine-local", "card-engine-hybrid", "chk-system-fallback", "chk-hybrid-cloud-fallback"]) {
      assert.ok(legacy.includes(id), `${id} is inside the legacy section`);
    }
    assert.match(legacy, /disabled=\{!legacyEditable\}/);
    assert.match(legacy, /if \(!legacyEditable\) return;/);
    assert.equal((legacy.match(/<fieldset disabled=\{!legacyEditable\}/g) || []).length, 2, "Google and hybrid fieldsets");
    // Every engineMode write lives inside the legacy section.
    const outside = page.slice(0, page.indexOf('<details id="ai-config-legacy"')) + page.slice(page.indexOf("</details>"));
    // (handleResetDefaults, before the render, legitimately sets the default shape.)
    assert.doesNotMatch(outside.slice(outside.indexOf("{/* Header Banner */}")), /engineMode: "/);
    // No separate Google tab any more.
    assert.doesNotMatch(page, /setActiveTabSection\("google"\)/);
    assert.match(page, /useState<"engine" \| "local" \| "benchmark">\("engine"\)/);
  });

  it("keeps the config shape and POST /api/config/ai so other code can still read it", () => {
    assert.match(page, /safeJsonFetch\("\/api\/config\/ai", \{\s*method: "POST"/);
    assert.match(page, /hybridSettings: \{\s*localPreFilterThreshold: 0\.85/);
  });

  it("keeps similarityThreshold editable and marks modelArchitecture display-only", () => {
    assert.match(page, /similarityThreshold: true,/);
    assert.match(page, /modelArchitecture: false,/);
    assert.match(page, /similarityThreshold: Number\(e\.target\.value\)/);
    assert.match(page, /Ngưỡng Tương Đồng Cosine → <span className="font-mono">acceptSingle<\/span>/);
    assert.match(page, /\{ARCHITECTURE_DISPLAY_ONLY_BADGE\}/);
    assert.match(page, /\{ARCHITECTURE_DISPLAY_ONLY_HINT\}/);
    assert.match(page, /The door decision always uses the ONNX engine/);
    // The four unsupported options still carry the existing badge.
    assert.ok((page.match(/\{NOT_IMPLEMENTED_BADGE\}/g) || []).length >= 3);
  });

  it("no longer calls the demo benchmark and shows live numbers instead", () => {
    assert.doesNotMatch(page, /safeJsonFetch[^;]*\/api\/config\/ai\/benchmark/);
    assert.doesNotMatch(page, /runLocalFaceRecognition|BenchmarkResult|btn-run-benchmark|runBenchmark\b|setBenchmarking/);
    assert.match(page, /\{BENCHMARK_RETIRED_TITLE\}/);
    assert.match(page, /\{BENCHMARK_RETIRED_TEXT\}/);
    assert.match(page, /readFaceExtractTelemetry\(engineStatus\)/);
    assert.match(page, /readBestOfTelemetry\(engineStatus\)/);
    assert.match(page, /faceExtractRows\(faceExtract\)/);
    assert.match(page, /bestOfRows\(bestOf\)/);
    assert.match(page, /Ngưỡng quyết định đang áp dụng/);
    // Refusal or transport failure is shown as "could not read", never as numbers.
    assert.match(page, /Không đọc được số liệu động cơ/);
  });

  it("keeps the tab list and radio groups accessible", () => {
    assert.match(page, /role="tablist" aria-label="Mục cấu hình AI"/);
    assert.equal((page.match(/role="tab"/g) || []).length, 3);
    assert.match(page, /aria-selected=\{activeTabSection === "engine"\}/);
    assert.match(page, /role="radiogroup"\s+aria-label="Chế độ động cơ cũ"/);
    assert.match(page, /aria-checked=\{selected\}/);
    assert.match(page, /role="status" aria-live="polite"/);
  });

  it("never touches a door or stores credentials", () => {
    assert.doesNotMatch(page, /\/api\/lock|unlock\(/i);
    assert.doesNotMatch(page, /apiKey|token|password/i);
  });
});
