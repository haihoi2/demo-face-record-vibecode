/**
 * Template-gallery audit (Taiga #508 follow-up).
 *
 * Pure vector maths over the stored face templates: no DB, no I/O, no
 * embeddings in any output. Two jobs:
 *
 *  1. `auditTemplates`: one pass over the whole gallery ("so lại 1 lượt với
 *     các nhân viên đã biết"). For every template of the running model it
 *     measures how well the template agrees with the rest of ITS OWN employee
 *     (leave-one-out, quality-weighted centroid) versus how strongly it
 *     resembles ANY OTHER employee, and flags the ones that look like another
 *     person's face. Background: NV-4386 had three merge templates that were
 *     another employee's face (cosine 0.64–0.66 to that person, 0.24–0.29 to
 *     its own leave-one-out centroid) and the gate attributed that person
 *     wrongly twice.
 *  2. `checkTemplateAgainstGallery`: the merge/enrol-time guard. Before a new
 *     template is saved for employee X, refuse it when it matches another
 *     employee at >= acceptSingle AND more strongly than X.
 *
 * Model tags are respected: only templates whose `modelTag` equals the
 * running tag (and whose embedding length equals `dims`) are compared.
 * Everything else is skipped and counted, never compared.
 *
 * ---------------------------------------------------------------------------
 * Route contract the integrator (server.ts owner) exposes on top of this
 * module - the frontend builds against this shape:
 *
 *   GET /api/face-templates/audit            (admin only)
 *   -> {
 *        success: true,
 *        generatedAt: string,                // ISO time the audit ran
 *        modelTag: string,                   // running embedding model
 *        thresholds: { acceptSingle: number },
 *        templates: number,                  // templates of modelTag audited
 *        employees: number,                  // employees owning >= 1 such template
 *        skipped: number,                    // foreign-tag / malformed templates not compared
 *        suspects: Array<{
 *          templateId: string,
 *          employeeId: string,
 *          employeeCode?: string,            // joined by the route
 *          employeeName?: string,            // joined by the route
 *          source: FaceTemplate["source"],
 *          streamId?: string,
 *          capturedAt: string,
 *          quality: number,
 *          sourceLogId?: string,
 *          ownCosine: number | null,         // null when it is the employee's only template
 *          otherEmployeeId: string,
 *          otherEmployeeCode?: string,       // joined by the route
 *          otherEmployeeName?: string,       // joined by the route
 *          otherCosine: number,              // max over that employee's templates
 *          otherCentroidCosine: number,      // to that employee's quality-weighted centroid
 *          reason: "closer-to-other" | "matches-other",
 *        }>,
 *        perEmployee: Array<{ employeeId: string, templates: number, suspects: number }>,
 *      }
 *
 * The route never returns embeddings; this module never emits them.
 * ---------------------------------------------------------------------------
 */

import { DEFAULT_FUSION_THRESHOLDS, FaceGallery } from "./faceFusion";
import { FaceTemplate } from "../types";

export type TemplateSuspectReason = "closer-to-other" | "matches-other";

export interface TemplateSuspect {
  templateId: string;
  employeeId: string;
  source: FaceTemplate["source"];
  streamId?: string;
  capturedAt: string;
  quality: number;
  sourceLogId?: string;
  /** Cosine to the quality-weighted leave-one-out centroid of the same employee's other templates; null when it is the only one. */
  ownCosine: number | null;
  /** The other employee this template resembles most (max over that employee's templates). */
  otherEmployeeId: string;
  otherCosine: number;
  /** Cosine to that other employee's quality-weighted centroid. */
  otherCentroidCosine: number;
  reason: TemplateSuspectReason;
  /** otherCosine - (ownCosine ?? 0); suspects are sorted by this, descending. */
  severity: number;
}

export interface TemplateAuditOptions {
  /** Running embedding model; templates with any other tag are skipped, never compared. */
  modelTag: string;
  /** Single-observation accept threshold; defaults to DEFAULT_FUSION_THRESHOLDS.acceptSingle (0.55). */
  acceptSingle?: number;
}

export interface TemplateAuditResult {
  modelTag: string;
  acceptSingle: number;
  /** Templates of `modelTag` that were compared. */
  templates: number;
  /** Employees owning at least one compared template. */
  employees: number;
  /** Templates not compared: foreign modelTag, empty embedding, or length != dims. */
  skipped: number;
  suspects: TemplateSuspect[];
  perEmployee: Array<{ employeeId: string; templates: number; suspects: number }>;
}

export type TemplateGalleryCheck =
  | {
      ok: true;
      /** Max cosine over the target employee's templates; -1 when the target has none. */
      targetCosine: number;
      otherEmployeeId?: string;
      otherCosine?: number;
      /** Set when another employee scores higher than the target but still below acceptSingle. Informational. */
      flag?: "closer-to-other";
    }
  | {
      ok: false;
      reason: "matches-other-employee";
      otherEmployeeId: string;
      otherCosine: number;
      targetCosine: number;
    }
  | {
      /** Fail closed: the candidate cannot be compared with the gallery (empty, or dims differ). */
      ok: false;
      reason: "incompatible-embedding";
      candidateDims: number;
      galleryDims: number;
    };

export interface TemplateGalleryCheckOptions {
  acceptSingle?: number;
  /** When `gallery` is a template list, only templates with this tag are used. Required for lists. */
  modelTag?: string;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Quality weight: clamped to [0.01, 1] so a zero-quality template still counts a little. */
function weightOf(q: number): number {
  return Math.max(0.01, clamp01(q));
}

function toUnit(v: ArrayLike<number>): Float64Array {
  const out = new Float64Array(v.length);
  let n = 0;
  for (let i = 0; i < v.length; i++) {
    const x = Number(v[i]);
    out[i] = Number.isFinite(x) ? x : 0;
    n += out[i] * out[i];
  }
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

function dot(a: Float64Array, b: Float64Array): number {
  const len = a.length;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, i = 0;
  for (; i + 3 < len; i += 4) {
    s0 += a[i] * b[i];
    s1 += a[i + 1] * b[i + 1];
    s2 += a[i + 2] * b[i + 2];
    s3 += a[i + 3] * b[i + 3];
  }
  for (; i < len; i++) s0 += a[i] * b[i];
  return Math.max(-1, Math.min(1, s0 + s1 + s2 + s3));
}

/** Cosine of a unit vector against an un-normalised sum vector (0 when the sum is empty). */
function cosineToSum(unit: Float64Array, sum: Float64Array): number {
  let d = 0, n = 0;
  for (let i = 0; i < unit.length; i++) {
    d += unit[i] * sum[i];
    n += sum[i] * sum[i];
  }
  if (n === 0) return 0;
  return Math.max(-1, Math.min(1, d / Math.sqrt(n)));
}

function usable(t: FaceTemplate, modelTag: string): boolean {
  return Boolean(
    t && t.modelTag === modelTag && Array.isArray(t.embedding) && t.embedding.length > 0 &&
    (t.dims == null || t.embedding.length === t.dims),
  );
}

interface Prepared {
  t: FaceTemplate;
  unit: Float64Array;
  w: number;
  empIdx: number;
}

/**
 * One pass over the gallery; see the module header. O(N^2 * D) once over
 * template pairs (symmetric dots computed once) plus O(N * D) centroid
 * cosines - well under a second for ~1,000 x 512-D templates.
 *
 * Reasons, in precedence order:
 *  - "closer-to-other": the template agrees more with another employee's
 *    centroid than with its own leave-one-out centroid (or it is the
 *    employee's only template and matches someone else at >= acceptSingle).
 *    This is the "wrong person's face filed here" case.
 *  - "matches-other": the template still agrees with its own employee, but
 *    some template of another employee scores >= acceptSingle against it
 *    (a lookalike pair - both sides are reported).
 *
 * "closer-to-other" culprits are removed one at a time (most confident first,
 * ties by templateId) and everything is re-judged after each removal, so one
 * contaminated template does not drag the victim's genuine templates into the
 * list and mutual accusations settle on the template with the weakest own
 * evidence. The procedure is deterministic for a given gallery regardless of
 * input order.
 */
export function auditTemplates(templates: FaceTemplate[], opts: TemplateAuditOptions): TemplateAuditResult {
  const modelTag = opts.modelTag;
  const acceptSingle = opts.acceptSingle ?? DEFAULT_FUSION_THRESHOLDS.acceptSingle;

  const kept = templates.filter((t) => usable(t, modelTag));
  const skipped = templates.length - kept.length;
  // All kept templates must share one dimensionality; the odd ones out are skipped too.
  const dimCounts = new Map<number, number>();
  for (const t of kept) dimCounts.set(t.embedding.length, (dimCounts.get(t.embedding.length) ?? 0) + 1);
  let dims = 0, dimsVotes = -1;
  for (const [d, c] of [...dimCounts.entries()].sort((a, b) => a[0] - b[0])) if (c > dimsVotes) { dims = d; dimsVotes = c; }
  const usableKept = kept.filter((t) => t.embedding.length === dims);
  const skippedTotal = skipped + (kept.length - usableKept.length);

  // Deterministic order: by employeeId, then templateId.
  const sorted = [...usableKept].sort((a, b) =>
    a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const employeeIds: string[] = [];
  const empIndex = new Map<string, number>();
  const prepared: Prepared[] = sorted.map((t) => {
    let idx = empIndex.get(t.employeeId);
    if (idx == null) { idx = employeeIds.length; employeeIds.push(t.employeeId); empIndex.set(t.employeeId, idx); }
    return { t, unit: toUnit(t.embedding), w: weightOf(t.quality), empIdx: idx };
  });
  const n = prepared.length;
  const e = employeeIds.length;

  // Per-employee quality-weighted sums (centroid direction) and member lists.
  const sums: Float64Array[] = Array.from({ length: e }, () => new Float64Array(dims));
  const members: number[][] = Array.from({ length: e }, () => []);
  for (let i = 0; i < n; i++) {
    const p = prepared[i];
    const s = sums[p.empIdx];
    for (let k = 0; k < dims; k++) s[k] += p.w * p.unit[k];
    members[p.empIdx].push(i);
  }

  // Pairwise cosines across employees, computed once (symmetric); -2 marks same-employee / self.
  const pair = new Float64Array(n * n).fill(-2);
  for (let i = 0; i < n; i++) {
    const pi = prepared[i];
    for (let j = i + 1; j < n; j++) {
      const pj = prepared[j];
      if (pj.empIdx === pi.empIdx) continue;
      const c = dot(pi.unit, pj.unit);
      pair[i * n + j] = c;
      pair[j * n + i] = c;
    }
  }

  // Judgement of one template against the current (non-culprit) gallery.
  interface Verdict { ownCosine: number | null; otherIdx: number; otherCosine: number; otherCentroidCosine: number; closer: boolean; confidence: number }
  const culprit = new Uint8Array(n);
  const live = members.map((m) => m.length); // non-culprit templates per employee
  const loo = new Float64Array(dims);
  const bestPerEmp = new Float64Array(e);
  const judge = (i: number): Verdict | null => {
    const p = prepared[i];
    let ownCosine: number | null = null;
    if (live[p.empIdx] > 1) {
      const s = sums[p.empIdx];
      for (let k = 0; k < dims; k++) loo[k] = s[k] - p.w * p.unit[k];
      ownCosine = cosineToSum(p.unit, loo);
    }
    // Strongest other employee (max over its non-culprit templates); ties by employee order.
    bestPerEmp.fill(-2);
    const row = i * n;
    for (let j = 0; j < n; j++) {
      if (culprit[j]) continue;
      const c = pair[row + j];
      if (c <= -2) continue;
      const m = prepared[j].empIdx;
      if (c > bestPerEmp[m]) bestPerEmp[m] = c;
    }
    let otherIdx = -1, otherCosine = -2;
    for (let m = 0; m < e; m++) if (bestPerEmp[m] > otherCosine) { otherCosine = bestPerEmp[m]; otherIdx = m; }
    if (otherIdx < 0) return null; // nobody else left to confuse with
    const otherCentroidCosine = cosineToSum(p.unit, sums[otherIdx]);
    // How far the template sits on the wrong side: measured own disagreement
    // when the employee has other templates, else distance above acceptSingle.
    const confidence = ownCosine == null ? otherCosine - acceptSingle : otherCentroidCosine - ownCosine;
    const closer = ownCosine == null ? otherCosine >= acceptSingle : otherCentroidCosine > ownCosine;
    return { ownCosine, otherIdx, otherCosine, otherCentroidCosine, closer, confidence };
  };

  // Culprits ("closer-to-other") leave the gallery one at a time, most
  // confident first, and everything is re-judged after each removal: both the
  // per-template max and the other employee's centroid stop seeing the culprit.
  // This settles mutual accusations (a contaminated template under A looks
  // like B, so B's genuine templates look like A) in favour of the template
  // with the weakest own evidence, and keeps one contaminated template from
  // dragging the victim's genuine templates into the list. O(culprits * N^2).
  const verdicts: Array<Verdict | null> = new Array(n).fill(null);
  const suspects: TemplateSuspect[] = [];
  const suspectCount = new Array<number>(e).fill(0);
  const emit = (i: number, v: Verdict, reason: TemplateSuspectReason) => {
    const p = prepared[i];
    suspectCount[p.empIdx]++;
    suspects.push({
      templateId: p.t.id,
      employeeId: p.t.employeeId,
      source: p.t.source,
      ...(p.t.streamId ? { streamId: p.t.streamId } : {}),
      capturedAt: p.t.capturedAt,
      quality: p.t.quality,
      ...(p.t.sourceLogId ? { sourceLogId: p.t.sourceLogId } : {}),
      ownCosine: v.ownCosine == null ? null : round4(v.ownCosine),
      otherEmployeeId: employeeIds[v.otherIdx],
      otherCosine: round4(v.otherCosine),
      otherCentroidCosine: round4(v.otherCentroidCosine),
      reason,
      severity: round4(v.otherCosine - (v.ownCosine ?? 0)),
    });
  };
  for (;;) {
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (culprit[i]) continue;
      const v = judge(i);
      verdicts[i] = v;
      if (!v?.closer) continue;
      if (pick < 0 || v.confidence > verdicts[pick]!.confidence ||
          (v.confidence === verdicts[pick]!.confidence && prepared[i].t.id < prepared[pick].t.id)) pick = i;
    }
    if (pick < 0) break;
    const p = prepared[pick];
    emit(pick, verdicts[pick]!, "closer-to-other");
    culprit[pick] = 1;
    live[p.empIdx]--;
    const s = sums[p.empIdx];
    for (let k = 0; k < dims; k++) s[k] -= p.w * p.unit[k];
  }
  // Final state: lookalikes among the templates that stayed.
  for (let i = 0; i < n; i++) {
    if (culprit[i]) continue;
    const v = verdicts[i];
    if (v && v.otherCosine >= acceptSingle) emit(i, v, "matches-other");
  }
  suspects.sort((a, b) => b.severity - a.severity || (a.templateId < b.templateId ? -1 : a.templateId > b.templateId ? 1 : 0));

  return {
    modelTag,
    acceptSingle,
    templates: n,
    employees: e,
    skipped: skippedTotal,
    suspects,
    perEmployee: employeeIds.map((employeeId, idx) => ({ employeeId, templates: members[idx].length, suspects: suspectCount[idx] })),
  };
}

/**
 * Merge/enrol-time guard. `gallery` is either a FaceGallery (already filtered
 * to the running model by buildGallery) or a template list plus `opts.modelTag`.
 *
 * Refuses (`matches-other-employee`) when some other employee scores
 * >= acceptSingle AND higher than the target. Returns a soft
 * `flag: "closer-to-other"` when another employee scores higher than the
 * target but below acceptSingle (the caller logs it; not a refusal). Fails
 * closed (`incompatible-embedding`) when the candidate cannot be compared.
 */
export function checkTemplateAgainstGallery(
  embedding: ArrayLike<number>,
  targetEmployeeId: string,
  gallery: FaceGallery | FaceTemplate[],
  opts: TemplateGalleryCheckOptions = {},
): TemplateGalleryCheck {
  const acceptSingle = opts.acceptSingle ?? DEFAULT_FUSION_THRESHOLDS.acceptSingle;
  if (Array.isArray(gallery) && !opts.modelTag) {
    // A template list without the running tag cannot be filtered safely: fail closed.
    return { ok: false, reason: "incompatible-embedding", candidateDims: embedding?.length ?? 0, galleryDims: 0 };
  }
  const map: FaceGallery = Array.isArray(gallery) ? galleryFromTemplates(gallery, opts.modelTag!) : gallery;

  const candidateDims = embedding?.length ?? 0;
  let galleryDims = 0;
  for (const list of map.values()) for (const v of list) if (v?.length) { galleryDims = v.length; break; }
  if (candidateDims === 0 || (galleryDims > 0 && galleryDims !== candidateDims)) {
    return { ok: false, reason: "incompatible-embedding", candidateDims, galleryDims };
  }
  const probe = toUnit(embedding);

  let targetCosine = -1;
  let otherEmployeeId: string | undefined;
  let otherCosine = -1;
  for (const employeeId of [...map.keys()].sort()) {
    let best = -1;
    for (const v of map.get(employeeId) ?? []) {
      if (!v || v.length !== candidateDims) continue; // never compare incompatible vectors
      const c = dot(probe, toUnit(v));
      if (c > best) best = c;
    }
    if (employeeId === targetEmployeeId) targetCosine = best;
    else if (best > otherCosine) { otherCosine = best; otherEmployeeId = employeeId; }
  }

  if (otherEmployeeId != null && otherCosine > targetCosine) {
    if (otherCosine >= acceptSingle) {
      return { ok: false, reason: "matches-other-employee", otherEmployeeId, otherCosine: round4(otherCosine), targetCosine: round4(targetCosine) };
    }
    return { ok: true, targetCosine: round4(targetCosine), otherEmployeeId, otherCosine: round4(otherCosine), flag: "closer-to-other" };
  }
  return otherEmployeeId == null
    ? { ok: true, targetCosine: round4(targetCosine) }
    : { ok: true, targetCosine: round4(targetCosine), otherEmployeeId, otherCosine: round4(otherCosine) };
}

function galleryFromTemplates(templates: FaceTemplate[], modelTag: string): FaceGallery {
  const out: FaceGallery = new Map();
  for (const t of templates) {
    if (!usable(t, modelTag)) continue;
    const list = out.get(t.employeeId) ?? [];
    list.push(t.embedding);
    out.set(t.employeeId, list);
  }
  return out;
}
