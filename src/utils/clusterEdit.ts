/**
 * Stranger group editing (2026-10-05): split picked photos into their own
 * group, or take them out of the group. Both are append-only on the server and
 * undone through /api/strangers/restore with what the server returned.
 */
import type { StrangerCluster } from "../types";

export type ClusterEditAction = "split" | "remove";

export interface ClusterEditUndo {
  clusterId: string;
  clusterObservationIds: string[];
}

interface PhotoIds {
  logId: string;
  observationId?: string;
}

const observationIdOf = (photo: PhotoIds) => photo.observationId || `log:${photo.logId}`;

const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** The request for one edit: the group on screen (membership + version) and the picked photos. */
export function clusterEditRequest(
  action: ClusterEditAction,
  cluster: Pick<StrangerCluster, "clusterId" | "clusterVersion"> & { photos: PhotoIds[] },
  selectedObservationIds: string[],
): { url: string; init: RequestInit } {
  const path = action === "split" ? "split" : "remove-photos";
  return {
    url: `/api/strangers/clusters/${encodeURIComponent(cluster.clusterId)}/${path}`,
    init: jsonPost({
      clusterVersion: cluster.clusterVersion,
      clusterObservationIds: cluster.photos.map(observationIdOf),
      selectedObservationIds: [...selectedObservationIds],
    }),
  };
}

/** Undo an edit (or re-join a split group): exactly the membership the server recorded. */
export function splitUndoRequest(undo: ClusterEditUndo): { url: string; init: RequestInit } {
  return {
    url: "/api/strangers/restore",
    init: jsonPost({ clusterId: undo.clusterId, clusterObservationIds: [...undo.clusterObservationIds] }),
  };
}

export function toggleObservation(selected: string[], observationId: string): string[] {
  return selected.includes(observationId) ? selected.filter((id) => id !== observationId) : [...selected, observationId];
}

export function clusterEditSuccessText(action: ClusterEditAction, count: number): string {
  return action === "split"
    ? `Đã tách ${count} ảnh thành cụm mới.`
    : `Đã bỏ ${count} ảnh khỏi cụm (ảnh được ẩn, không bị xóa).`;
}
