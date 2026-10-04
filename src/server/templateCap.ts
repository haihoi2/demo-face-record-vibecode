/**
 * The per-employee template cap (FACE_TEMPLATE_MAX).
 *
 * Only templates an operator caused (enrollment, merge, manual, auto) count
 * against it. Camera adaptation templates are capped per camera by
 * planAdaptation (galleryAdaptation.ts) and are never counted or evicted here -
 * counting them too refused merges for people the cameras had adapted to
 * (146 merges between 2026-09-29 and 2026-10-04, ÁNH OB among them).
 */

export interface CapTemplate {
  source: string;
  quality: number;
}

/** Whether a template takes one of the employee's FACE_TEMPLATE_MAX slots. */
export function countsAgainstTemplateCap(t: Pick<CapTemplate, "source">): boolean {
  return t.source !== "adaptation";
}

/**
 * A new template is refused only when the employee is full AND it is no
 * better than every template it could replace; otherwise it is kept and the
 * worst one is evicted after it is saved.
 */
export function templateCapRefuses(existing: CapTemplate[], newQuality: number, max: number): boolean {
  const capped = existing.filter(countsAgainstTemplateCap);
  if (capped.length < max) return false;
  return capped.every((t) => t.quality >= newQuality);
}
