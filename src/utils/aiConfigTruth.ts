/**
 * Pure helpers for the "Cấu hình AI" page so that what it says about the
 * recognition engine can be pinned by tests.
 *
 * Backend facts these helpers lean on (verified in server.ts, src/server/faceWorker.ts,
 * src/server/faceExtractPool.ts - do not re-derive here):
 *  - The door decision always uses the ONNX engine (SCRFD det_10g + ArcFace w600k_r50)
 *    when FACE_ENGINE=onnx. The engine is chosen by server config
 *    (FACE_ENGINE / FACE_RECOGNIZER_MODEL), never by this page.
 *  - `aiRecognitionConfig.engineMode`, `googleAi.*`, `localModel.modelArchitecture`,
 *    `livenessSensitivity`, `antiSpoofing`, `autoContrast`, `maxFaces` and
 *    `hybridSettings.*` are read only by the legacy `recognizeFrame` path, which runs
 *    only when the ONNX engine is not ready - and then the system is fail-closed
 *    (no unlock). Gemini never opens a door. The three "local architectures" only
 *    change a display name over a demo seed-based matcher.
 *  - `localModel.similarityThreshold` IS real: it maps to the fusion threshold
 *    `acceptSingle` (server.ts currentFusionThresholds).
 *  - POST /api/config/ai/benchmark runs the demo worker pool on employee photos with
 *    synthetic vectors; it measures nothing about real recognition.
 *  - GET /api/face-engine/status is the truthful source (engine, detector, recognizer,
 *    modelTag, thresholds, templates, faceExtract pool, bestOf counters).
 */

import type { RecognitionEngineMode } from "../types";

/** One plain sentence under the engine status: who decides which engine runs. */
export const ENGINE_SOURCE_SENTENCE =
  "Động cơ quyết định cửa được chọn bởi cấu hình máy chủ (FACE_ENGINE / FACE_RECOGNIZER_MODEL), không phải bởi trang này.";

export const LEGACY_SECTION_TITLE = "Cấu hình cũ (không ảnh hưởng quyết định cửa)";

export const LEGACY_SECTION_HINT =
  "Chưa triển khai cho luồng cửa: các tùy chọn dưới đây chỉ được đọc bởi luồng nhận diện cũ (recognizeFrame), luồng này chỉ chạy khi động cơ ONNX chưa sẵn sàng - và khi đó hệ thống đóng an toàn (fail-closed), không mở cửa. Gemini không bao giờ mở cửa. Giá trị vẫn được lưu để mã cũ còn đọc được, nhưng không phải là lựa chọn đang có hiệu lực.";

export const LEGACY_EDIT_TOGGLE_LABEL = "Cho phép sửa cấu hình cũ (không khuyến nghị)";

export const ARCHITECTURE_DISPLAY_ONLY_BADGE = "Chỉ hiển thị";

export const ARCHITECTURE_DISPLAY_ONLY_HINT =
  "Giá trị modelArchitecture lưu ở đây chỉ đổi tên hiển thị của bộ so khớp demo trong luồng cũ (src/server/faceWorker.ts). Bộ phát hiện và bộ nhận diện thật do máy chủ nạp lúc khởi động và được báo ở bảng trạng thái động cơ.";

export const BENCHMARK_RETIRED_TITLE = "Benchmark cũ đã gỡ khỏi giao diện";

export const BENCHMARK_RETIRED_TEXT =
  "Nút \"Bắt Đầu Benchmark\" trước đây gọi POST /api/config/ai/benchmark: lệnh này chạy bể worker demo trên ảnh nhân viên với vector tổng hợp, nên chỉ đo được thông lượng của worker demo - không đo gì về nhận diện thật, và phần \"Google AI\" là số mô phỏng. So sánh động cơ thật được làm ngoại tuyến (Taiga #513). Bên dưới là số liệu sống của động cơ đang chạy, đọc từ GET /api/face-engine/status.";

/** Labels for the legacy engineMode values; "cũ" so no one reads them as the live engine. */
export function legacyEngineModeLabel(mode: RecognitionEngineMode | string | undefined): string {
  switch (mode) {
    case "GOOGLE_GEMINI":
      return "Google Gemini (cũ)";
    case "LOCAL_BIOMETRIC":
      return "Local demo (cũ)";
    case "HYBRID_AUTO":
      return "Hybrid Auto (cũ)";
    default:
      return "không rõ";
  }
}

/** The parts of GET /api/face-engine/status that the metrics tab reads. All optional. */
export interface FaceExtractTelemetryView {
  enabled: boolean | null;
  ready: boolean | null;
  workers: number | null;
  readyWorkers: number | null;
  busy: number | null;
  queued: number | null;
  queueMax: number | null;
  completed: number | null;
  failed: number | null;
  restarts: number | null;
  avgWorkerMs: number | null;
  avgTotalMs: number | null;
  modelTag: string | null;
  lastError: string | null;
}

export interface BestOfTelemetryView {
  extraFrames: number | null;
  full: number | null;
  trimmed: number | null;
  skipped: number | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Null when the server sent no `faceExtract` block (older server), never a guess. */
export function readFaceExtractTelemetry(status: unknown): FaceExtractTelemetryView | null {
  const s = obj(status);
  const fe = s ? obj(s.faceExtract) : null;
  if (!fe) return null;
  return {
    enabled: bool(fe.enabled),
    ready: bool(fe.ready),
    workers: num(fe.workers),
    readyWorkers: num(fe.readyWorkers),
    busy: num(fe.busy),
    queued: num(fe.queued),
    queueMax: num(fe.queueMax),
    completed: num(fe.completed),
    failed: num(fe.failed),
    restarts: num(fe.restarts),
    avgWorkerMs: num(fe.avgWorkerMs),
    avgTotalMs: num(fe.avgTotalMs),
    modelTag: str(fe.modelTag),
    lastError: str(fe.lastError),
  };
}

/** Null when the server sent no `bestOf` block. */
export function readBestOfTelemetry(status: unknown): BestOfTelemetryView | null {
  const s = obj(status);
  const b = s ? obj(s.bestOf) : null;
  if (!b) return null;
  return {
    extraFrames: num(b.extraFrames),
    full: num(b.full),
    trimmed: num(b.trimmed),
    skipped: num(b.skipped),
  };
}

export const formatMs = (v: number | null): string => (v === null ? "—" : `${v} ms`);
export const formatCount = (v: number | null): string => (v === null ? "—" : String(v));

/** Pool state for the operator: ready / enabled-but-not-ready / disabled / unknown. */
export function faceExtractStateLabel(t: FaceExtractTelemetryView | null): string {
  if (!t) return "máy chủ chưa báo";
  if (t.enabled === false) return "tắt (trích xuất trên luồng chính)";
  if (t.ready === true) return "sẵn sàng";
  if (t.ready === false) return "chưa sẵn sàng";
  return "không rõ";
}

/** Rows for the metrics tab, in display order. Pure so the labels can be pinned. */
export function faceExtractRows(t: FaceExtractTelemetryView): Array<{ key: string; label: string; value: string }> {
  return [
    { key: "workers", label: "Worker sẵn sàng / tổng", value: `${formatCount(t.readyWorkers)} / ${formatCount(t.workers)}` },
    { key: "busy", label: "Đang bận", value: formatCount(t.busy) },
    { key: "queued", label: "Đang chờ / tối đa", value: `${formatCount(t.queued)} / ${formatCount(t.queueMax)}` },
    { key: "completed", label: "Đã trích xuất xong", value: formatCount(t.completed) },
    { key: "failed", label: "Thất bại", value: formatCount(t.failed) },
    { key: "restarts", label: "Worker khởi động lại", value: formatCount(t.restarts) },
    { key: "avgWorkerMs", label: "Thời gian trích xuất trung bình (trong worker)", value: formatMs(t.avgWorkerMs) },
    { key: "avgTotalMs", label: "Thời gian trung bình gồm cả chờ hàng đợi", value: formatMs(t.avgTotalMs) },
  ];
}

export function bestOfRows(b: BestOfTelemetryView): Array<{ key: string; label: string; value: string }> {
  return [
    { key: "extraFrames", label: "Ảnh phụ tối đa mỗi lần quét", value: formatCount(b.extraFrames) },
    { key: "full", label: "Lấy đủ ảnh phụ", value: formatCount(b.full) },
    { key: "trimmed", label: "Cắt bớt ảnh phụ (worker bận)", value: formatCount(b.trimmed) },
    { key: "skipped", label: "Bỏ qua ảnh phụ (không worker nào rỗi)", value: formatCount(b.skipped) },
  ];
}
