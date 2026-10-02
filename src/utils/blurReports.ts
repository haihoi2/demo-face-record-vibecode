/**
 * Blur reports in the stranger panel (owner 2026-10-02: "report blur to validate
 * and optimize rather than delete"). A report is a LABEL on one stored stranger
 * face, kept for re-tuning the blur filter. It never deletes or hides the photo.
 *
 * Contract: src/server/blurReports.ts
 *   POST   /api/strangers/faces/:faceId/blur-report  body {} or { note <= 200 }
 *   DELETE /api/strangers/faces/:faceId/blur-report
 *   -> 200 { success, faceId, blurReported: boolean, report }
 *   GET /api/strangers/clusters: per-face photos carry `blurReported: true` while reported.
 *
 * Pure helpers only (no React, no fetch) so they can be unit tested.
 */
import type { StrangerCluster, StrangerPhoto } from "../types";

/** Server limit for the optional note. */
export const BLUR_NOTE_MAX = 200;

/** Tooltip / helper copy. The photo is kept: say so every time. */
export const BLUR_REPORT_HINT = "Đánh dấu ảnh này là quá mờ để hiệu chỉnh bộ lọc. Ảnh không bị xóa.";
export const BLUR_WITHDRAW_HINT = "Bỏ đánh dấu ảnh mờ. Ảnh vẫn được giữ nguyên.";
export const BLUR_EXPLAINER =
  "Báo ảnh mờ chỉ gắn nhãn để hiệu chỉnh bộ lọc ảnh mờ; ảnh không bị xóa và không bị ẩn.";

/** Only per-face records can be reported; older whole-frame photos have no faceId. */
export function canBlurReport(photo: Pick<StrangerPhoto, "faceId"> | null | undefined): photo is StrangerPhoto & { faceId: string } {
  return typeof photo?.faceId === "string" && photo.faceId.length > 0;
}

/**
 * The server's flag on a cluster photo. `blurReported` is not (yet) declared on
 * StrangerPhoto in src/types.ts, so read it defensively: only a literal `true`
 * counts as reported.
 */
export function isBlurReported(photo: StrangerPhoto | null | undefined): boolean {
  return canBlurReport(photo) && (photo as { blurReported?: unknown }).blurReported === true;
}

export function blurReportPath(faceId: string): string {
  return `/api/strangers/faces/${encodeURIComponent(faceId)}/blur-report`;
}

/** Trimmed note, at most BLUR_NOTE_MAX characters; undefined when empty. */
export function normalizeBlurNote(note?: string | null): string | undefined {
  if (typeof note !== "string") return undefined;
  const trimmed = note.trim();
  if (!trimmed) return undefined;
  return Array.from(trimmed).slice(0, BLUR_NOTE_MAX).join("").trim();
}

/**
 * Request for reporting (`report = true`, POST) or withdrawing (`false`, DELETE).
 * Sent through operatorJsonFetch, which adds credentials and the CSRF token.
 */
export function blurReportRequest(
  faceId: string,
  report: boolean,
  note?: string | null,
): { url: string; init: RequestInit } {
  const url = blurReportPath(faceId);
  if (!report) {
    return { url, init: { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" } };
  }
  const cleanNote = normalizeBlurNote(note);
  return {
    url,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cleanNote ? { note: cleanNote } : {}),
    },
  };
}

export type BlurReportOutcome =
  | { ok: true; faceId: string; blurReported: boolean }
  | { ok: false; status: number; error: string };

/**
 * Reads the server reply. Only a 2xx with `success` and a boolean `blurReported`
 * for the same face is a success; anything else is a failure carrying the
 * server's `error` text as-is (404 unknown face, 400 invalid id, 403 role).
 * Status 0 is a transport failure, never a success.
 */
export function readBlurReportResult(
  faceId: string,
  res: { ok: boolean; status: number; data?: unknown; error?: string },
): BlurReportOutcome {
  const data = (res.data && typeof res.data === "object" ? res.data : {}) as {
    success?: unknown;
    faceId?: unknown;
    blurReported?: unknown;
    error?: unknown;
  };
  const serverError = typeof data.error === "string" && data.error.trim() ? data.error : "";
  if (res.ok && res.status >= 200 && res.status < 300 && data.success === true && typeof data.blurReported === "boolean") {
    if (data.faceId === undefined || data.faceId === faceId) {
      return { ok: true, faceId, blurReported: data.blurReported };
    }
    return { ok: false, status: res.status, error: "Máy chủ trả lời cho một khuôn mặt khác." };
  }
  if (serverError) return { ok: false, status: res.status, error: serverError };
  if (res.status === 0) {
    return { ok: false, status: 0, error: res.error || "Không thể kết nối đến máy chủ" };
  }
  return { ok: false, status: res.status, error: res.error || `HTTP ${res.status}` };
}

/**
 * Applies a confirmed (2xx) state to one face across clusters. Returns the same
 * array when nothing changed, so React can skip the render.
 */
export function applyBlurState(
  clusters: StrangerCluster[],
  faceId: string,
  blurReported: boolean,
): StrangerCluster[] {
  let changed = false;
  const next = clusters.map((cluster) => {
    let clusterChanged = false;
    const photos = cluster.photos.map((photo) => {
      if (photo.faceId !== faceId || isBlurReported(photo) === blurReported) return photo;
      clusterChanged = true;
      return { ...photo, blurReported } as StrangerPhoto;
    });
    if (!clusterChanged) return cluster;
    changed = true;
    return { ...cluster, photos };
  });
  return changed ? next : clusters;
}

/** Live-region text after a confirmed change. */
export function blurReportSuccessText(blurReported: boolean): string {
  return blurReported
    ? "Đã báo ảnh mờ. Ảnh vẫn được giữ; báo cáo dùng để hiệu chỉnh bộ lọc ảnh mờ."
    : "Đã bỏ báo ảnh mờ. Ảnh vẫn được giữ nguyên.";
}
