/**
 * Face sharpness S0 labelling (plan docs/plans/2026-10-07-face-sharpness.md):
 * request building and key mapping for the labelling screen.
 */
export type SharpnessRating = "sharp" | "blurry" | "not-face";

export interface SharpnessSampleFace {
  faceId: string;
  imageUrl: string;
  capturedAt: string;
  gateId: string | null;
}

export const RATING_LABELS: Record<SharpnessRating, string> = {
  sharp: "Rõ",
  blurry: "Mờ",
  "not-face": "Không phải mặt",
};

/** Keys 1/2/3 rate; S skips; Backspace goes back to the previous face. */
export function ratingForKey(key: string): SharpnessRating | "skip" | "back" | null {
  if (key === "1") return "sharp";
  if (key === "2") return "blurry";
  if (key === "3") return "not-face";
  if (key === "s" || key === "S") return "skip";
  if (key === "Backspace") return "back";
  return null;
}

export function sampleRequest(limit = 24): string {
  return `/api/strangers/sharpness/sample?limit=${Math.max(1, Math.min(100, Math.round(limit)))}`;
}

export function ratingRequest(faceId: string, rating: SharpnessRating): { url: string; init: RequestInit } {
  return {
    url: `/api/strangers/faces/${encodeURIComponent(faceId)}/rating`,
    init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rating }) },
  };
}

/** Reads the sample reply; anything malformed becomes an empty page. */
export function readSample(body: unknown): { faces: SharpnessSampleFace[]; ratedByMe: number; target: number; available: number } {
  const b = (body || {}) as Record<string, unknown>;
  const faces = Array.isArray(b.faces)
    ? (b.faces as any[])
        .filter((f) => f && typeof f.faceId === "string" && typeof f.imageUrl === "string")
        .map((f) => ({ faceId: f.faceId, imageUrl: f.imageUrl, capturedAt: String(f.capturedAt || ""), gateId: typeof f.gateId === "string" ? f.gateId : null }))
    : [];
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return { faces, ratedByMe: num(b.ratedByMe, 0), target: num(b.target, 300), available: num(b.available, 0) };
}
