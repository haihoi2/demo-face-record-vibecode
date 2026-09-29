/**
 * Identity of stranger-panel photo tiles (plan docs/plans/2026-09-29-per-face-stranger-observations.md,
 * section 9 "Contract"). Since the per-face wave one frame can yield several
 * tiles (two people in one frame), so a tile is identified by its observation
 * id (`face:<faceId>` or `log:<logId>`), never by `logId` alone. Servers from
 * before the per-face wave send no `observationId`; their tiles are one per log,
 * so `log:<logId>` is their identity.
 *
 * Pure helpers only: no React, no fetch, no browser globals.
 */
import type { StrangerCluster, StrangerPhoto } from "../types";

export const LOG_OBSERVATION_PREFIX = "log:";
export const FACE_OBSERVATION_PREFIX = "face:";

type PhotoIdentity = Pick<StrangerPhoto, "logId" | "observationId">;

/** The tile's identity in React keys, selection and resolve requests. */
export function observationIdOf(photo: PhotoIdentity): string {
  const id = typeof photo.observationId === "string" ? photo.observationId.trim() : "";
  return id || `${LOG_OBSERVATION_PREFIX}${photo.logId}`;
}

export function findPhotoByObservationId(
  photos: readonly StrangerPhoto[],
  observationId: string | null | undefined
): StrangerPhoto | undefined {
  if (!observationId) return undefined;
  return photos.find((photo) => observationIdOf(photo) === observationId);
}

/**
 * The tile selected when a cluster is opened: the caller's choice when it is in
 * the cluster, else the tile showing the cluster's primary photo, else the first.
 */
export function defaultActiveObservationId(
  cluster: Pick<StrangerCluster, "photos" | "primaryPhoto">,
  preferred?: string | null
): string {
  if (findPhotoByObservationId(cluster.photos, preferred)) return preferred as string;
  const primary = cluster.photos.find((photo) => photo.photoSnapshot === cluster.primaryPhoto) ?? cluster.photos[0];
  return primary ? observationIdOf(primary) : "";
}

export interface ClusterResolveIds {
  /** Legacy field for servers older than the per-face wave (a set: one entry per log). */
  clusterLogIds: string[];
  /** One entry per tile, `face:` or `log:`. */
  clusterObservationIds: string[];
}

export interface SourceResolveIds {
  sourceLogId?: string;
  sourceObservationId?: string;
}

/**
 * Ids every resolve request (quick-register, merge, dismiss, restore) carries,
 * plus the chosen tile for the requests that enrol from one photo. The server
 * already treats `clusterLogIds` as a set, so a log shared by two face tiles is
 * sent once.
 */
export function resolvePayloadIds(
  photos: readonly StrangerPhoto[],
  active?: StrangerPhoto | null
): ClusterResolveIds & SourceResolveIds {
  const ids: ClusterResolveIds & SourceResolveIds = {
    clusterLogIds: [...new Set(photos.map((photo) => photo.logId))],
    clusterObservationIds: photos.map(observationIdOf),
  };
  if (active) {
    ids.sourceLogId = active.logId;
    ids.sourceObservationId = observationIdOf(active);
  }
  return ids;
}

/**
 * The whole-frame link of a face tile, or null. Only a same-origin API path is
 * accepted (the operator cookie goes with the new tab), so a malformed or
 * foreign URL (`javascript:`, `//host`, `https://...`, `..`) never becomes a link.
 */
export function frameLinkPath(photo: Pick<StrangerPhoto, "frameUrl">): string | null {
  const raw = typeof photo.frameUrl === "string" ? photo.frameUrl.trim() : "";
  if (!/^\/api\/[A-Za-z0-9._~%/-]+(?:\?[A-Za-z0-9._~%&=-]*)?$/.test(raw)) return null;
  const path = raw.split("?")[0];
  if (path.includes("//") || path.split("/").some((segment) => segment === "." || segment === "..")) return null;
  if (/%2e|%2f|%5c/i.test(path)) return null;
  return raw;
}

/**
 * The tile for a photo URL from an in-app click. Callers outside the panel hold
 * the event's whole-frame URL, which is no longer a face tile's photoSnapshot
 * (the crop), so the tile's frameUrl is matched too; its own image wins.
 */
export function photoForSnapshot(
  photos: readonly StrangerPhoto[],
  url: string | null | undefined
): StrangerPhoto | undefined {
  if (!url) return undefined;
  return photos.find((photo) => photo.photoSnapshot === url) ?? photos.find((photo) => photo.frameUrl === url);
}

/** What a deep link or in-app click asks the panel to select. */
export type StrangerPreselectTarget = { kind: "face"; id: string } | { kind: "log"; id: string };

/** A face id (`#strangers/face/<faceId>`) wins over a log id (`#strangers/<logId>`). */
export function preselectTarget(
  faceId?: string | null,
  logId?: string | null
): StrangerPreselectTarget | null {
  const face = (faceId || "").trim();
  if (face) return { kind: "face", id: face };
  const log = (logId || "").trim();
  return log ? { kind: "log", id: log } : null;
}

export function photoMatchesTarget(photo: StrangerPhoto, target: StrangerPreselectTarget): boolean {
  if (target.kind === "face") {
    return photo.faceId === target.id || observationIdOf(photo) === `${FACE_OBSERVATION_PREFIX}${target.id}`;
  }
  return photo.logId === target.id;
}
