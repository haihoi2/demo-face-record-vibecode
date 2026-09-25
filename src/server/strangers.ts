import { createHash } from "crypto";
import { AccessLogRecord } from "./db";
import { envNumber } from "./env";

/**
 * Cosine at or above which two stranger captures are treated as the same
 * person - for grouping in the cluster panel and for the per-person capture
 * cooldown. Measured on this site (2026-09-25): across 137 pairs of templates
 * of DIFFERENT people the highest similarity was 0.289; the same person seen
 * again by the same camera typically scores 0.50-0.62. The previous default,
 * 0.6, sat above most genuine repeats, so every stranger stayed a singleton.
 */
export const STRANGER_SAME_PERSON_COSINE = envNumber("FACE_STRANGER_CLUSTER_COSINE", 0.45, { min: 0, max: 1 });

export interface StrangerPhoto {
  logId: string;
  /** Compatibility key: this is a validated endpoint URL, never embedded image data. */
  photoSnapshot: string;
  imageUrl: string;
  hasImage: boolean;
  timestamp: string;
  confidence: number;
  doorName: string;
  reason?: string;
}

export interface StrangerCluster {
  clusterId: string;
  label: string;
  photos: StrangerPhoto[];
  firstSeen: string;
  lastSeen: string;
  totalSightings: number;
  primaryPhoto: string;
  estimatedGender?: string;
  similarityScore: number | null;
  suggestedName?: string;
  notes?: string;
}

export interface StrangerClusterOptions {
  includeDemoSeeds?: boolean;
  cosineThreshold?: number;
}

// Demo-only data. Production callers must explicitly opt in.
const SEED_STRANGER_CLUSTERS: StrangerCluster[] = [
  {
    clusterId: "cluster-visitor-01",
    label: "Cụm người lạ mẫu",
    similarityScore: null,
    notes: "Dữ liệu minh họa; chỉ hiển thị khi STRANGER_DEMO_SEEDS=true.",
    firstSeen: "2026-09-22T08:00:00.000Z",
    lastSeen: "2026-09-22T08:00:00.000Z",
    totalSightings: 1,
    primaryPhoto: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=450&auto=format&fit=crop&q=80",
    photos: [
      {
        logId: "LOG-STRANGER-DEMO-1",
        photoSnapshot: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=450&auto=format&fit=crop&q=80",
        imageUrl: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=450&auto=format&fit=crop&q=80",
        hasImage: true,
        timestamp: "2026-09-22T08:00:00.000Z",
        confidence: 30,
        doorName: "Cổng mẫu",
        reason: "Dữ liệu minh họa",
      },
    ],
  },
];

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return -1;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  if (aa === 0 || bb === 0) return -1;
  return dot / (Math.sqrt(aa) * Math.sqrt(bb));
}

function imageUrl(logId: string): string {
  return `/api/logs/${encodeURIComponent(logId)}/image`;
}

function clusterIdFor(logIds: string[]): string {
  const exactMembership = [...logIds].sort().map((id) => `${Buffer.byteLength(id, "utf8")}:${id}`).join("|");
  return `cluster-${createHash("sha256").update(exactMembership).digest("hex")}`;
}

/**
 * Deterministic connected-component grouping over compatible ArcFace vectors.
 * Missing embeddings are intentionally singletons; image bytes are never used
 * as an identity signal and raw vectors are never copied into the result.
 */
export function clusterStrangerFaces(
  accessLogs: AccessLogRecord[],
  resolvedClusterIds: string[] = [],
  options: StrangerClusterOptions = {},
): StrangerCluster[] {
  const resolved = new Set(resolvedClusterIds);
  const dismissedLogs = new Set(
    resolvedClusterIds.filter((id) => id.startsWith("log:")).map((id) => id.slice(4)),
  );
  const thresholdValue = options.cosineThreshold ?? STRANGER_SAME_PERSON_COSINE;
  const threshold = Number.isFinite(thresholdValue)
    ? Math.max(-1, Math.min(1, thresholdValue))
    : STRANGER_SAME_PERSON_COSINE;

  const logs = accessLogs
    .filter(
      (log) =>
        !dismissedLogs.has(log.id) &&
        Boolean(log.photoSnapshot) &&
        (log.status === "DENIED" || !log.employeeId || log.employeeName === "Không xác định"),
    )
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));

  const groups: AccessLogRecord[][] = [];
  for (const log of logs) {
    if (!log.faceEmbedding?.length || !log.faceEmbeddingModelTag) {
      groups.push([log]);
      continue;
    }

    let bestGroup = -1;
    let bestMinimumSimilarity = -Infinity;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];
      if (group.some((member) =>
        !member.faceEmbedding?.length || member.faceEmbeddingModelTag !== log.faceEmbeddingModelTag
      )) continue;
      const similarities = group.map((member) => cosineSimilarity(log.faceEmbedding!, member.faceEmbedding!));
      const minimumSimilarity = Math.min(...similarities);
      if (minimumSimilarity >= threshold && minimumSimilarity > bestMinimumSimilarity) {
        bestGroup = groupIndex;
        bestMinimumSimilarity = minimumSimilarity;
      }
    }
    if (bestGroup >= 0) groups[bestGroup].push(log);
    else groups.push([log]);
  }

  const clusters: StrangerCluster[] = [];
  let index = 1;
  for (const members of groups) {
    const clusterId = clusterIdFor(members.map((log) => log.id));
    if (resolved.has(clusterId)) continue;

    members.sort((a, b) => {
      const recent = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      return recent || a.id.localeCompare(b.id);
    });
    const photos: StrangerPhoto[] = members.map((log) => ({
      logId: log.id,
      photoSnapshot: imageUrl(log.id),
      imageUrl: imageUrl(log.id),
      hasImage: Boolean(log.photoSnapshot),
      timestamp: log.timestamp,
      confidence: log.confidence || 30,
      doorName: log.doorName || "Cổng Quét Cửa",
      reason: log.reason || "Cảnh báo người lạ chụp hình",
    }));

    const similarities: number[] = [];
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        if (
          a.faceEmbedding?.length &&
          b.faceEmbedding?.length &&
          a.faceEmbeddingModelTag === b.faceEmbeddingModelTag
        ) {
          similarities.push(cosineSimilarity(a.faceEmbedding, b.faceEmbedding));
        }
      }
    }
    const similarityScore = similarities.length
      ? Math.round((similarities.reduce((sum, value) => sum + value, 0) / similarities.length) * 1000) / 10
      : null;

    clusters.push({
      clusterId,
      label: `Người lạ #${index} (${photos.length} lần phát hiện)`,
      photos,
      firstSeen: photos[photos.length - 1].timestamp,
      lastSeen: photos[0].timestamp,
      totalSightings: photos.length,
      primaryPhoto: photos[0].photoSnapshot,
      similarityScore,
      notes: `Đã phát hiện ${photos.length} lần quét tại ${photos[0].doorName}.`,
    });
    index++;
  }

  if (options.includeDemoSeeds) {
    for (const seed of SEED_STRANGER_CLUSTERS) {
      if (!resolved.has(seed.clusterId)) {
        clusters.push({ ...seed, photos: seed.photos.map((photo) => ({ ...photo })) });
      }
    }
  }

  clusters.sort((a, b) => {
    if (b.totalSightings !== a.totalSightings) return b.totalSightings - a.totalSightings;
    const recent = new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
    return recent || a.clusterId.localeCompare(b.clusterId);
  });
  return clusters;
}


export interface RecentStranger {
  at: number;
  embedding: number[];
}

/**
 * Per-person capture cooldown at one gate. Returns whether this sighting should
 * be stored, and the updated list of recent strangers for the gate.
 *
 * A sighting that matches someone captured within `windowMs` is suppressed and
 * extends that person's window, so one person lingering is captured once. A
 * sighting that matches nobody is captured and remembered, so two strangers
 * arriving together are both captured.
 */
export function strangerCaptureDecision(
  recent: RecentStranger[],
  embedding: number[],
  nowMs: number,
  windowMs: number,
  threshold = STRANGER_SAME_PERSON_COSINE,
  max = 32,
): { capture: boolean; recent: RecentStranger[] } {
  const live = recent.filter((r) => nowMs - r.at < windowMs).map((r) => ({ ...r }));
  const same = live.find((r) => cosineSimilarity(r.embedding, embedding) >= threshold);
  if (same) {
    same.at = nowMs;
    return { capture: false, recent: live };
  }
  live.push({ at: nowMs, embedding });
  return { capture: true, recent: live.slice(-max) };
}
