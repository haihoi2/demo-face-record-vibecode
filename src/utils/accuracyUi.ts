/**
 * Accuracy wave (plan docs/plans/2026-09-29-scale-and-accuracy.md, Parts B and C,
 * section 9 "Contract"): pure helpers for
 *
 *  - the engine card's "Độ chính xác (24 giờ)" section, read from
 *    `GET /api/pipeline/shadow-summary?hours=24`;
 *  - the per-camera template coverage of an employee, read from the `coverage`
 *    array of `GET /api/employees/:id/templates` or derived from `byStream` /
 *    `templates` when an older server sends none;
 *  - the merge suggestion shown on a stranger group (`StrangerCluster.suggestion`).
 *
 * Everything here is a display aid. The shadow numbers are observations, the
 * suggestion is a hint the operator must confirm, and none of it authorises a
 * door. Pure helpers only: no React, no fetch, no browser globals.
 */
import type { Employee, ShadowAccuracySummaryView, StrangerClusterSuggestion } from "../types";
import type { Tone } from "./pipelineStatus";
import { gateKeyOf, type GateKey } from "./pipelineMode";

// ---------------------------------------------------------------------------
// Shadow accuracy summary
// ---------------------------------------------------------------------------

export interface ShadowSummary {
  since: string | null;
  gates: ShadowAccuracySummaryView[];
}

const COUNT_KEYS = [
  "decisions",
  "employees",
  "strangers",
  "insufficient",
  "framesUsedZero",
  "agree",
  "shadowOnly",
  "legacyOnly",
  "identityMismatch",
  "none",
] as const;

function nonNegativeInt(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

/** One gate's row, with every counter defaulting to 0 so a partial body still renders. */
export function readShadowGate(raw: unknown): ShadowAccuracySummaryView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const gate = typeof r.gate === "string" ? r.gate.trim() : "";
  if (!gate) return null;
  const view = {
    gate,
    since: typeof r.since === "string" ? r.since : "",
    decisionLatencyP50Ms:
      typeof r.decisionLatencyP50Ms === "number" && Number.isFinite(r.decisionLatencyP50Ms) && r.decisionLatencyP50Ms >= 0
        ? r.decisionLatencyP50Ms
        : null,
  } as ShadowAccuracySummaryView;
  for (const key of COUNT_KEYS) view[key] = nonNegativeInt(r[key]);
  return view;
}

/** The body of `GET /api/pipeline/shadow-summary`; null when it is not that shape. */
export function readShadowSummary(payload: unknown): ShadowSummary | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.success === false || !Array.isArray(p.gates)) return null;
  const gates: ShadowAccuracySummaryView[] = [];
  for (const raw of p.gates) {
    const view = readShadowGate(raw);
    if (view) gates.push(view);
  }
  return { since: typeof p.since === "string" ? p.since : null, gates };
}

/** The row for one card gate: rows carry the gate id, older ones the direction (ENTRY -> "entry"). */
export function shadowSummaryForGate(
  summary: ShadowSummary | null | undefined,
  key: GateKey
): ShadowAccuracySummaryView | null {
  if (!summary) return null;
  return summary.gates.find((g) => gateKeyOf(g.gate) === key) ?? null;
}

/** A window with no shadow decision at all: nothing to compare yet. */
export function isEmptyShadowWindow(view: ShadowAccuracySummaryView | null | undefined): boolean {
  return !view || view.decisions <= 0;
}

/** "37%" of a whole; an em dash when there is no whole. */
export function formatShare(part: number, total: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return "—";
  const pct = Math.round((Math.max(0, part) / total) * 100);
  return `${Math.min(100, pct)}%`;
}

/**
 * Share of tracks whose person never yielded a usable face (framesUsed = 0).
 * Plan section 1: this is the throughput indicator, not a model one. Null when
 * the window is empty.
 */
export function noUsableFaceShare(view: ShadowAccuracySummaryView | null | undefined): number | null {
  if (!view || view.decisions <= 0) return null;
  return Math.min(1, Math.max(0, view.framesUsedZero / view.decisions));
}

/** Plan Part A success line: "framesUsed = 0 share < 40%". Above it the stat turns amber. */
export const NO_USABLE_FACE_WARN_SHARE = 0.4;

export function noUsableFaceTone(view: ShadowAccuracySummaryView | null | undefined): Tone | undefined {
  const share = noUsableFaceShare(view);
  if (share === null) return undefined;
  return share >= NO_USABLE_FACE_WARN_SHARE ? "amber" : undefined;
}

export type AgreementKey = "agree" | "shadowOnly" | "legacyOnly" | "identityMismatch" | "none";

export interface AgreementRow {
  key: AgreementKey;
  label: string;
  count: number;
  /** Share of all decisions, "—" for an empty window. */
  share: string;
  tone: Tone;
  /** The false-accept candidates an operator must look at. */
  needsReview: boolean;
}

const AGREEMENT_LABELS: Record<AgreementKey, string> = {
  agree: "Trùng khớp",
  shadowOnly: "Chỉ động cơ mới nhận ra",
  legacyOnly: "Chỉ động cơ cũ nhận ra",
  identityMismatch: "Lệch danh tính",
  none: "Cả hai đều không nhận ra",
};

export const IDENTITY_MISMATCH_REVIEW_LABEL = "cần kiểm tra";

/** The agreement breakdown in display order, identity mismatch flagged for review when non-zero. */
export function agreementRows(view: ShadowAccuracySummaryView): AgreementRow[] {
  const keys: AgreementKey[] = ["agree", "shadowOnly", "legacyOnly", "identityMismatch", "none"];
  return keys.map((key) => {
    const count = view[key];
    const mismatch = key === "identityMismatch";
    let tone: Tone = "slate";
    if (key === "agree" && count > 0) tone = "emerald";
    else if ((key === "shadowOnly" || key === "legacyOnly") && count > 0) tone = "sky";
    else if (mismatch && count > 0) tone = "rose";
    return {
      key,
      label: AGREEMENT_LABELS[key],
      count,
      share: formatShare(count, view.decisions),
      tone,
      needsReview: mismatch && count > 0,
    };
  });
}

/** "từ 10:08 29/09" style start of the window; null when unknown or unparsable. */
export function formatSince(since: string | null | undefined): string | null {
  if (!since) return null;
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
}

// ---------------------------------------------------------------------------
// Per-camera template coverage
// ---------------------------------------------------------------------------

/** One camera's template count for one employee (contract: `coverage[]`). */
export interface CoverageEntry {
  streamId: string;
  gate: string;
  count: number;
  /** How many of `count` were made by the camera-adaptation job (source "adaptation"). */
  adaptation: number;
}

/** The camera as the enrolment screen lists it; `enabled` false hides it from the indicator. */
export interface CoverageStream {
  id: string;
  label: string;
  gateKey: GateKey;
  gateName: string;
  enabled?: boolean;
}

export const ADAPTATION_SOURCE = "adaptation";

export function isAdaptationTemplate(tpl: { source?: string | null }): boolean {
  return typeof tpl.source === "string" && tpl.source.trim().toLowerCase() === ADAPTATION_SOURCE;
}

/** The small tag shown next to a camera-adaptation template. */
export const ADAPTATION_TAG = "tự động";

interface TemplatesBodyLike {
  coverage?: unknown;
  byStream?: unknown;
  templates?: unknown;
}

function readCoverageArray(raw: unknown): CoverageEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CoverageEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const streamId = typeof r.streamId === "string" ? r.streamId.trim() : "";
    if (!streamId) continue;
    out.push({
      streamId,
      gate: typeof r.gate === "string" ? r.gate : "",
      count: nonNegativeInt(r.count),
      adaptation: nonNegativeInt(r.adaptation),
    });
  }
  return out;
}

/**
 * Per-camera coverage of one employee. Prefers the server's `coverage` array
 * (accuracy wave). Against an older server it is derived from `byStream`
 * (`{ streamId: count }`, no adaptation split) and, when the template list is
 * present, from the templates themselves so adaptation counts are still right.
 * Templates without a streamId are reported under `streamId: "unknown"`, the
 * key the server's own `byStream` uses.
 */
export function deriveCoverage(body: TemplatesBodyLike | null | undefined): CoverageEntry[] {
  if (!body) return [];
  const fromServer = readCoverageArray(body.coverage);
  if (fromServer) return fromServer;

  const byId = new Map<string, CoverageEntry>();
  const bump = (streamId: string, count: number, adaptation: number) => {
    const key = streamId || "unknown";
    const entry = byId.get(key) ?? { streamId: key, gate: "", count: 0, adaptation: 0 };
    entry.count += count;
    entry.adaptation += adaptation;
    byId.set(key, entry);
  };

  if (Array.isArray(body.templates)) {
    for (const item of body.templates) {
      if (!item || typeof item !== "object") continue;
      const tpl = item as { streamId?: unknown; source?: unknown };
      const streamId = typeof tpl.streamId === "string" ? tpl.streamId.trim() : "";
      bump(streamId, 1, isAdaptationTemplate({ source: typeof tpl.source === "string" ? tpl.source : null }) ? 1 : 0);
    }
    return [...byId.values()];
  }

  if (body.byStream && typeof body.byStream === "object") {
    for (const [streamId, raw] of Object.entries(body.byStream as Record<string, unknown>)) {
      bump(streamId.trim(), nonNegativeInt(raw), 0);
    }
  }
  return [...byId.values()];
}

export function coverageCount(coverage: readonly CoverageEntry[], streamId: string): number {
  return coverage.find((c) => c.streamId === streamId)?.count ?? 0;
}

/** Configured, enabled cameras on which the employee has no template. */
export function missingCameras(coverage: readonly CoverageEntry[], streams: readonly CoverageStream[]): CoverageStream[] {
  return streams.filter((st) => st.enabled !== false && coverageCount(coverage, st.id) === 0);
}

/**
 * Short name for one camera in a compact chip: the gate's name, plus the
 * stream label when that gate has more than one camera.
 */
export function cameraShortLabel(stream: CoverageStream, streams: readonly CoverageStream[]): string {
  const siblings = streams.filter((st) => st.gateKey === stream.gateKey && st.enabled !== false);
  return siblings.length > 1 ? `${stream.gateName} / ${stream.label}` : stream.gateName;
}

/**
 * "thiếu mẫu ở Cổng ra" / "thiếu mẫu ở Cổng vào, Cổng ra" / "đủ mẫu trên 2 camera",
 * or null when there is no camera to speak of. Written for the employee list,
 * where one line per employee is all the room there is.
 */
export function coverageIndicatorText(
  coverage: readonly CoverageEntry[],
  streams: readonly CoverageStream[]
): string | null {
  const active = streams.filter((st) => st.enabled !== false);
  if (active.length === 0) return null;
  const missing = missingCameras(coverage, active);
  if (missing.length === 0) return `đủ mẫu trên ${active.length} camera`;
  if (missing.length === active.length) return "chưa có mẫu ở camera nào";
  return `thiếu mẫu ở ${missing.map((st) => cameraShortLabel(st, active)).join(", ")}`;
}

/** Value of the "Thiếu mẫu trên camera…" filter: none, any camera, or one stream id. */
export type CoverageFilter = "" | "__any__" | string;

/**
 * Whether an employee passes the filter. Coverage that has not loaded yet
 * (`null`) never passes a "missing" filter, so the list only ever claims a gap
 * it has actually read.
 */
export function passesCoverageFilter(
  filter: CoverageFilter,
  coverage: readonly CoverageEntry[] | null | undefined,
  streams: readonly CoverageStream[]
): boolean {
  if (!filter) return true;
  if (!coverage) return false;
  if (filter === "__any__") return missingCameras(coverage, streams).length > 0;
  const stream = streams.find((st) => st.id === filter);
  if (!stream) return false;
  return coverageCount(coverage, stream.id) === 0;
}

// ---------------------------------------------------------------------------
// Stranger group suggestion
// ---------------------------------------------------------------------------

/** 0..1 cosine as "62%"; clamped, never NaN. */
export function formatCosinePercent(cosine: number): string {
  if (!Number.isFinite(cosine)) return "—";
  return `${Math.round(Math.min(1, Math.max(0, cosine)) * 100)}%`;
}

/**
 * "Có thể là Nguyễn Văn A (NV-001) – 62% – chưa có mẫu ở Cổng ra". The last part
 * is omitted when the employee already has templates on every camera. This is
 * the wording of a hint; the caller must never render it as a result.
 */
/** Below the door engine's single-view accept (0.55) a suggestion is weak: check the photos before merging. */
export const SUGGESTION_WEAK_BELOW = 0.55;

export function suggestionText(s: StrangerClusterSuggestion): string {
  const weak = Number.isFinite(s.cosine) && s.cosine < SUGGESTION_WEAK_BELOW ? " (yếu – hãy so ảnh trước khi gộp)" : "";
  const head = `Có thể là ${s.name} (${s.employeeCode}) – ${formatCosinePercent(s.cosine)}${weak}`;
  const cameras = (s.missingCameras || []).map((c) => String(c).trim()).filter(Boolean);
  return cameras.length > 0 ? `${head} – chưa có mẫu ở ${cameras.join(", ")}` : head;
}

export function suggestionMergeLabel(s: StrangerClusterSuggestion): string {
  return `Gộp vào ${s.name}`;
}

/**
 * The suggested employee as a roster entry, so the existing merge flow can be
 * pre-filled before the roster search answers. Only `id` and `employeeCode` go
 * into the merge request; the rest is display filler the search result replaces.
 */
export function suggestionAsEmployee(s: StrangerClusterSuggestion): Employee {
  return {
    id: s.employeeId,
    name: s.name,
    employeeCode: s.employeeCode,
    department: "",
    position: "",
    photoUrl: "",
    registeredAt: "",
    accessLevel: "ALL_ACCESS",
  };
}

/** A payload's `suggestion` only when it names an employee; anything else is ignored. */
export function readSuggestion(raw: unknown): StrangerClusterSuggestion | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const employeeId = typeof r.employeeId === "string" ? r.employeeId.trim() : "";
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!employeeId || !name) return null;
  return {
    employeeId,
    name,
    employeeCode: typeof r.employeeCode === "string" ? r.employeeCode.trim() : "",
    cosine: typeof r.cosine === "number" && Number.isFinite(r.cosine) ? r.cosine : 0,
    missingCameras: Array.isArray(r.missingCameras) ? r.missingCameras.filter((c): c is string => typeof c === "string") : [],
  };
}
