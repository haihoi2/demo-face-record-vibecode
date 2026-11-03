/**
 * Template audit (owner request 2026-11-03, Taiga #508): one pass over the face
 * template gallery that lists templates looking more like ANOTHER employee than
 * their own owner, so an operator can delete a template that slipped in through a
 * wrong stranger merge. Pure helpers only: parsing of GET /api/face-templates/audit,
 * ordering, grouping, labels. The server decides who is a suspect; the browser
 * never computes or receives embeddings.
 */
import { templateFrameImageUrl, templateSourceLabel } from "./mergeCompare";

export const TEMPLATE_AUDIT_URL = "/api/face-templates/audit";

export type SuspectReason = "closer-to-other" | "matches-other";

export interface TemplateSuspect {
  templateId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  source: string;
  streamId: string;
  capturedAt: string;
  quality: number | null;
  sourceLogId: string | null;
  /** Mean cosine to the owner's other templates; null when the owner has only this one. */
  ownCosine: number | null;
  otherEmployeeId: string;
  otherEmployeeCode: string;
  otherEmployeeName: string;
  otherCosine: number;
  otherCentroidCosine: number | null;
  reason: SuspectReason;
}

export interface TemplateAuditView {
  generatedAt: string;
  modelTag: string;
  acceptSingle: number | null;
  templates: number;
  employees: number;
  suspects: TemplateSuspect[];
}

export interface SuspectGroup {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  suspects: TemplateSuspect[];
}

/* ---- Copy (pinned by tests/templateAuditUi.test.ts) ---- */
export const TEMPLATE_AUDIT_BUTTON = "So lại mẫu với nhân viên đã biết";
export const TEMPLATE_AUDIT_RUNNING = "Đang so…";
export const TEMPLATE_AUDIT_EMPTY = "Không có mẫu nào giống người khác hơn chính chủ.";
export const TEMPLATE_AUDIT_FORBIDDEN = "Cần quyền admin";
export const TEMPLATE_AUDIT_SINGLE_TEMPLATE = "chỉ có 1 mẫu";
export const TEMPLATE_AUDIT_DELETE = "Xóa mẫu";
export const TEMPLATE_AUDIT_EXPLANATION =
  "Mẫu nghi ngờ là mẫu giống các mẫu của một nhân viên khác hơn là giống các mẫu còn lại của chính chủ. " +
  "Xóa là vĩnh viễn và chỉ xóa mẫu khuôn mặt đó (dữ liệu sinh trắc); hồ sơ nhân viên và lịch sử ra vào giữ nguyên.";
export const REASON_LABEL: Record<SuspectReason, string> = {
  "closer-to-other": "Giống người khác hơn",
  "matches-other": "Khớp người khác ≥ 0,55",
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Template / employee / log ids are opaque tokens; anything else is dropped before it reaches a URL. */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const safeId = (v: unknown): string => {
  const s = str(v);
  return SAFE_ID.test(s) ? s : "";
};

function readSuspect(raw: unknown): TemplateSuspect | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const templateId = safeId(r.templateId);
  const employeeId = safeId(r.employeeId);
  const otherEmployeeId = safeId(r.otherEmployeeId);
  const otherCosine = num(r.otherCosine);
  const reason = str(r.reason);
  if (!templateId || !employeeId || !otherEmployeeId || otherCosine === null) return null;
  if (reason !== "closer-to-other" && reason !== "matches-other") return null;
  return {
    templateId,
    employeeId,
    employeeCode: str(r.employeeCode),
    employeeName: str(r.employeeName),
    source: str(r.source),
    streamId: str(r.streamId),
    capturedAt: str(r.capturedAt),
    quality: num(r.quality),
    sourceLogId: safeId(r.sourceLogId) || null,
    ownCosine: num(r.ownCosine),
    otherEmployeeId,
    otherEmployeeCode: str(r.otherEmployeeCode),
    otherEmployeeName: str(r.otherEmployeeName),
    otherCosine,
    otherCentroidCosine: num(r.otherCentroidCosine),
    reason,
  };
}

/** Defensive read of the audit body: unknown rows are dropped, duplicates (same templateId) collapse, order is by severity. */
export function readTemplateAudit(body: unknown): TemplateAuditView | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.success === false || !Array.isArray(b.suspects)) return null;
  const seen = new Set<string>();
  const suspects: TemplateSuspect[] = [];
  for (const raw of b.suspects) {
    const s = readSuspect(raw);
    if (!s || seen.has(s.templateId)) continue;
    seen.add(s.templateId);
    suspects.push(s);
  }
  const thresholds = (b.thresholds && typeof b.thresholds === "object" ? b.thresholds : {}) as Record<string, unknown>;
  return {
    generatedAt: str(b.generatedAt),
    modelTag: str(b.modelTag),
    acceptSingle: num(thresholds.acceptSingle),
    templates: num(b.templates) ?? 0,
    employees: num(b.employees) ?? 0,
    suspects: sortSuspects(suspects),
  };
}

const REASON_RANK: Record<SuspectReason, number> = { "matches-other": 0, "closer-to-other": 1 };

/** Most severe first: "matches-other" before "closer-to-other", then the larger otherCosine, then the smaller ownCosine (unknown own last), then id. */
export function sortSuspects(suspects: readonly TemplateSuspect[]): TemplateSuspect[] {
  return [...suspects].sort((a, b) => {
    const r = REASON_RANK[a.reason] - REASON_RANK[b.reason];
    if (r !== 0) return r;
    if (a.otherCosine !== b.otherCosine) return b.otherCosine - a.otherCosine;
    const ao = a.ownCosine ?? Infinity;
    const bo = b.ownCosine ?? Infinity;
    if (ao !== bo) return ao - bo;
    return a.templateId.localeCompare(b.templateId);
  });
}

/** Groups in order of first appearance (so the group with the worst suspect comes first); rows keep their order. */
export function groupSuspectsByEmployee(suspects: readonly TemplateSuspect[]): SuspectGroup[] {
  const groups = new Map<string, SuspectGroup>();
  for (const s of suspects) {
    let g = groups.get(s.employeeId);
    if (!g) {
      g = { employeeId: s.employeeId, employeeCode: s.employeeCode, employeeName: s.employeeName, suspects: [] };
      groups.set(s.employeeId, g);
    }
    g.suspects.push(s);
  }
  return [...groups.values()];
}

/** "0,66" - two decimals, Vietnamese decimal comma; "—" when unknown. */
export function formatCosine(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return v.toFixed(2).replace(".", ",");
}

/** The "Giống chính mình" cell: the cosine, or the reason there is none. */
export function ownCosineText(s: Pick<TemplateSuspect, "ownCosine">): string {
  return s.ownCosine === null ? TEMPLATE_AUDIT_SINGLE_TEMPLATE : formatCosine(s.ownCosine);
}

/** "NV-4658 · Nguyễn Văn A" or whichever part exists; the id as a last resort. */
export function employeeLabel(code: string, name: string, fallbackId = ""): string {
  const parts = [code, name].filter(Boolean);
  return parts.length ? parts.join(" · ") : fallbackId || "—";
}

export function reasonLabel(reason: SuspectReason): string {
  return REASON_LABEL[reason];
}

/** "Gộp từ người lạ · entry-101 · 03/11/2026 08:00:00" (missing parts omitted). */
export function templateCellParts(s: Pick<TemplateSuspect, "source" | "streamId" | "capturedAt">): string[] {
  const parts: string[] = [];
  if (s.source) parts.push(templateSourceLabel(s.source));
  if (s.streamId) parts.push(s.streamId);
  if (s.capturedAt) parts.push(formatAuditTime(s.capturedAt));
  return parts;
}

export function formatAuditTime(iso: string | null | undefined): string {
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

/** "Đã so 879 mẫu của 53 nhân viên – 3 mẫu nghi ngờ" */
export function auditSummaryText(view: Pick<TemplateAuditView, "templates" | "employees" | "suspects">): string {
  return `Đã so ${view.templates} mẫu của ${view.employees} nhân viên – ${view.suspects.length} mẫu nghi ngờ`;
}

/** Operator-facing text for a refused or failed audit read. HTTP refusals are never softened into "no suspects". */
export function auditErrorText(res: { ok: boolean; status: number; data?: unknown; error?: string }): string {
  if (res.status === 401 || res.status === 403) return TEMPLATE_AUDIT_FORBIDDEN;
  const bodyError = str((res.data as Record<string, unknown> | undefined)?.error);
  if (bodyError) return bodyError;
  if (res.status === 404) return "Máy chủ chưa hỗ trợ so lại mẫu (HTTP 404).";
  if (res.status === 0) return res.error || "Không thể kết nối đến máy chủ";
  return res.error || `Không so được mẫu (HTTP ${res.status}).`;
}

/** The existing protected frame route (same one the log thumbnails use). */
export function suspectImageUrl(s: Pick<TemplateSuspect, "sourceLogId">): string | null {
  return s.sourceLogId ? templateFrameImageUrl(s.sourceLogId) : null;
}

export function templateDeleteUrl(employeeId: string, templateId: string): string {
  return `/api/employees/${encodeURIComponent(employeeId)}/templates/${encodeURIComponent(templateId)}`;
}

/** Drops the deleted row; the summary count follows the remaining rows. */
export function withoutSuspect(view: TemplateAuditView, templateId: string): TemplateAuditView {
  return { ...view, suspects: view.suspects.filter((s) => s.templateId !== templateId) };
}
