/**
 * Merge comparison (owner request 2026-10-04): before a stranger group is merged
 * into an existing employee, the operator compares the group's photos with that
 * employee's pictures (registration photo, recent recognised face crops at the
 * gates, camera frames their templates came from). The comparison only helps a
 * human decide; nothing here authorises anything, and the merge request itself
 * is unchanged.
 *
 * Contract: GET /api/employees/:id/face-samples (operator) ->
 *   { success, employee: { id, name, employeeCode, department, hasPhoto },
 *     samples: [{ faceId, capturedAt, gateId?, matchCosine? }],
 *     templateFrames: [{ logId, capturedAt, source, streamId? }] }
 * Images come from the existing protected routes (ids only in the JSON).
 *
 * Pure helpers only: no React, no fetch, no browser globals.
 */
import type { StrangerClusterSuggestion } from "../types";
import { formatCosinePercent, readSuggestion, SUGGESTION_WEAK_BELOW } from "./accuracyUi";
import { labelForGateId } from "./gates";

/** The server returns at most 8 face crops and 4 template frames; the UI never shows more. */
export const MERGE_COMPARE_MAX_SAMPLES = 8;
export const MERGE_COMPARE_MAX_TEMPLATE_FRAMES = 4;

/** An id that may be put into an image path. Anything else is dropped, never encoded into a request. */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface CompareEmployeeInfo {
  id: string;
  name: string;
  employeeCode: string;
  department: string;
  hasPhoto: boolean;
}

export interface CompareSample {
  faceId: string;
  capturedAt: string;
  gateId?: string;
  matchCosine?: number;
  /** Protected face crop: /api/strangers/faces/:faceId/image */
  imageUrl: string;
}

export interface CompareTemplateFrame {
  logId: string;
  capturedAt: string;
  source: string;
  streamId?: string;
  /** Protected full frame: /api/logs/:logId/image */
  imageUrl: string;
}

export interface FaceSamplesView {
  employee: CompareEmployeeInfo | null;
  samples: CompareSample[];
  templateFrames: CompareTemplateFrame[];
}

export const EMPTY_FACE_SAMPLES: FaceSamplesView = { employee: null, samples: [], templateFrames: [] };

export function faceSamplesUrl(employeeId: string): string {
  return `/api/employees/${encodeURIComponent(employeeId)}/face-samples`;
}

export function sampleImageUrl(faceId: string): string {
  return `/api/strangers/faces/${encodeURIComponent(faceId)}/image`;
}

export function templateFrameImageUrl(logId: string): string {
  return `/api/logs/${encodeURIComponent(logId)}/image`;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const timeOf = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : -Infinity;
};
/** Newest first; undated entries last; ties keep the server's order. */
const byNewest = <T extends { capturedAt: string }>(items: T[]): T[] =>
  items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => timeOf(b.item.capturedAt) - timeOf(a.item.capturedAt) || a.index - b.index)
    .map(({ item }) => item);

/**
 * The face-samples body as display data. Malformed entries and ids that are not
 * plain identifiers are dropped; lists are newest first and capped. A body that
 * is not a success yields the empty view (the caller shows the error).
 */
export function readFaceSamples(raw: unknown): FaceSamplesView {
  if (!raw || typeof raw !== "object") return EMPTY_FACE_SAMPLES;
  const body = raw as Record<string, unknown>;
  if (body.success !== true) return EMPTY_FACE_SAMPLES;

  let employee: CompareEmployeeInfo | null = null;
  if (body.employee && typeof body.employee === "object") {
    const e = body.employee as Record<string, unknown>;
    const id = str(e.id);
    if (id) {
      employee = {
        id,
        name: str(e.name),
        employeeCode: str(e.employeeCode),
        department: str(e.department),
        hasPhoto: e.hasPhoto === true,
      };
    }
  }

  const samples: CompareSample[] = [];
  const seenFaces = new Set<string>();
  for (const entry of Array.isArray(body.samples) ? body.samples : []) {
    if (!entry || typeof entry !== "object") continue;
    const s = entry as Record<string, unknown>;
    const faceId = str(s.faceId);
    if (!SAFE_ID_RE.test(faceId) || seenFaces.has(faceId)) continue;
    seenFaces.add(faceId);
    const gateId = str(s.gateId);
    const cosine = typeof s.matchCosine === "number" && Number.isFinite(s.matchCosine) ? s.matchCosine : undefined;
    samples.push({
      faceId,
      capturedAt: str(s.capturedAt),
      ...(gateId ? { gateId } : {}),
      ...(cosine !== undefined ? { matchCosine: cosine } : {}),
      imageUrl: sampleImageUrl(faceId),
    });
  }

  const templateFrames: CompareTemplateFrame[] = [];
  const seenLogs = new Set<string>();
  for (const entry of Array.isArray(body.templateFrames) ? body.templateFrames : []) {
    if (!entry || typeof entry !== "object") continue;
    const f = entry as Record<string, unknown>;
    const logId = str(f.logId);
    // Two templates from one frame show the same picture: list it once.
    if (!SAFE_ID_RE.test(logId) || seenLogs.has(logId)) continue;
    seenLogs.add(logId);
    const streamId = str(f.streamId);
    templateFrames.push({
      logId,
      capturedAt: str(f.capturedAt),
      source: str(f.source),
      ...(streamId ? { streamId } : {}),
      imageUrl: templateFrameImageUrl(logId),
    });
  }

  return {
    employee,
    samples: byNewest(samples).slice(0, MERGE_COMPARE_MAX_SAMPLES),
    templateFrames: byNewest(templateFrames).slice(0, MERGE_COMPARE_MAX_TEMPLATE_FRAMES),
  };
}

/**
 * Why the face-samples load failed, for display. An HTTP refusal shows the
 * server's own text as-is; a transport failure says the server was not reached.
 * Returns null when the response is a usable success.
 */
export function faceSamplesLoadError(res: { ok: boolean; status: number; data?: unknown; error?: string }): string | null {
  const data = (res.data && typeof res.data === "object" ? res.data : {}) as Record<string, unknown>;
  const serverText = str(data.error);
  if (res.status === 0) {
    return `Không kết nối được máy chủ để tải ảnh đối chiếu${res.error ? `: ${res.error}` : ""}`;
  }
  if (!res.ok) return serverText || str(res.error) || `HTTP ${res.status}`;
  if (data.success !== true) return serverText || "Máy chủ không trả về ảnh đối chiếu";
  return null;
}

/** Date and time with seconds (checkable against the NVR); "—" when missing or invalid. */
export function formatCompareTime(iso: string | null | undefined): string {
  const t = Date.parse(String(iso || ""));
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** "Độ giống 62%" for a 0..1 match score, "" when there is none. */
export function matchScoreLabel(cosine: number | null | undefined): string {
  if (typeof cosine !== "number" || !Number.isFinite(cosine)) return "";
  return `Độ giống ${formatCosinePercent(cosine)}`;
}

/** Caption parts of one recognised face crop: time, gate (when known), match score (when present). */
export function sampleCaptionParts(
  sample: Pick<CompareSample, "capturedAt" | "gateId" | "matchCosine">,
  gateLabels: Readonly<Record<string, string>> = {}
): string[] {
  const parts = [formatCompareTime(sample.capturedAt)];
  if (sample.gateId) parts.push(labelForGateId(sample.gateId, gateLabels));
  const score = matchScoreLabel(sample.matchCosine);
  if (score) parts.push(score);
  return parts;
}

/** How a template was made, in the panel's words; an unknown value is shown as-is. */
export function templateSourceLabel(source: string | null | undefined): string {
  switch (str(source)) {
    case "enrollment":
      return "Ảnh đăng ký";
    case "merge":
      return "Gộp từ người lạ";
    case "manual":
      return "Thêm thủ công";
    case "auto":
      return "Tự động";
    case "adaptation":
      return "Tự bổ sung khi nhận diện";
    case "":
      return "Không rõ nguồn";
    default:
      return str(source);
  }
}

export function templateFrameCaptionParts(frame: Pick<CompareTemplateFrame, "capturedAt" | "source" | "streamId">): string[] {
  const parts = [formatCompareTime(frame.capturedAt), templateSourceLabel(frame.source)];
  if (frame.streamId) parts.push(`luồng ${frame.streamId}`);
  return parts;
}

/**
 * The suggestion's score with its strength: "Độ giống 55% - yếu" below the
 * door engine's single-view accept (same line as the panel's "(yếu ...)"),
 * otherwise "- gần giống" (owner wording 2026-10-04). A hint's strength, never a result.
 */
export function suggestionStrengthLabel(cosine: number): string {
  const weak = !Number.isFinite(cosine) || cosine < SUGGESTION_WEAK_BELOW;
  return `Độ giống ${formatCosinePercent(cosine)} - ${weak ? "yếu" : "gần giống"}`;
}

export function isWeakSuggestion(cosine: number): boolean {
  return !Number.isFinite(cosine) || cosine < SUGGESTION_WEAK_BELOW;
}

/** "TIÊN OB (NV-4386)", or the name alone when there is no code. */
export function employeeHeading(name: string, employeeCode?: string | null): string {
  const n = str(name) || "Nhân viên";
  const c = str(employeeCode);
  return c ? `${n} (${c})` : n;
}

export const MERGE_COMPARE_CAUTION =
  "Chỉ là gợi ý từ độ giống với mẫu đã có, không phải kết luận - hãy so ảnh hai bên trước khi gộp.";

export const MERGE_COMPARE_NO_SAMPLES =
  "Chưa có ảnh nhận diện tại cổng của nhân viên này - chỉ có ảnh đăng ký";

/** The plain notice when the employee has no gate pictures at all, else null. */
export function noSamplesNotice(view: Pick<FaceSamplesView, "samples" | "templateFrames">): string | null {
  return view.samples.length === 0 && view.templateFrames.length === 0 ? MERGE_COMPARE_NO_SAMPLES : null;
}

export type RegistrationPhotoState = "photo" | "pending" | "none" | "unknown";

/**
 * What to show for the registration photo: the roster's photoUrl when there is
 * one; "pending" while a suggestion's placeholder record (no photoUrl yet) waits
 * for the roster search and the server says a photo exists; "none" when the
 * server says there is none; "unknown" when the server did not answer.
 */
export function registrationPhotoState(photoUrl: string | null | undefined, hasPhoto: boolean | null | undefined): RegistrationPhotoState {
  if (str(photoUrl)) return "photo";
  if (hasPhoto === true) return "pending";
  if (hasPhoto === false) return "none";
  return "unknown";
}

export function registrationPhotoText(state: RegistrationPhotoState): string {
  switch (state) {
    case "pending":
      return "Có ảnh đăng ký - đang lấy từ danh sách nhân viên…";
    case "none":
      return "Nhân viên này chưa có ảnh đăng ký";
    case "unknown":
      return "Chưa có ảnh đăng ký để hiển thị";
    default:
      return "";
  }
}

/** Caption parts of one stranger photo in the comparison: time, then the gate/camera name. */
export function strangerPhotoCaptionParts(photo: { timestamp?: string | null; doorName?: string | null }): string[] {
  const parts = [formatCompareTime(photo.timestamp)];
  const door = str(photo.doorName);
  if (door) parts.push(door);
  return parts;
}

/**
 * The group's suggestion when the merge target is the suggested employee (the
 * dialog then shows its score and strength); null for any other target.
 */
export function compareSuggestion(
  cluster: { suggestion?: unknown },
  target: { id: string } | null | undefined
): StrangerClusterSuggestion | null {
  const suggestion = readSuggestion(cluster.suggestion);
  return suggestion && target && suggestion.employeeId === target.id ? suggestion : null;
}
