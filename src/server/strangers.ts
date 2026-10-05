import { createHash } from "crypto";
import { AccessLogRecord } from "./db";
import { envNumber } from "./env";
import { faceObservationId, logObservationId, type StrangerFaceRecord } from "./strangerFaces";

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
  /** `face:<faceId>` for a per-face record, `log:<logId>` for a whole-frame capture. */
  observationId: string;
  faceId?: string;
  /** Compatibility key: this is a validated endpoint URL, never embedded image data. For a face, the crop. */
  photoSnapshot: string;
  /** Whole frame of the event. */
  frameUrl: string;
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
  /**
   * Set when an operator split these photos off another group: the split's id
   * and full membership, so the panel can offer "Gộp lại" (restore).
   */
  split?: { clusterId: string; observationIds: string[] };
}

export interface StrangerClusterOptions {
  includeDemoSeeds?: boolean;
  cosineThreshold?: number;
  /**
   * Operator splits (db.getStrangerSplitPartitions): an observation only ever
   * groups with observations of the same split; unsplit ones share "".
   */
  partitionOf?: ReadonlyMap<string, string>;
  /** Each split's full membership, attached to a group made only of that split's photos. */
  splits?: ReadonlyMap<string, string[]>;
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
        observationId: "log:LOG-STRANGER-DEMO-1",
        frameUrl: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=450&auto=format&fit=crop&q=80",
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
 * One thing the stranger panel groups: an older whole-frame capture
 * (`log:<id>`, one embedding per access log) or a per-face record
 * (`face:<id>`, plan 2026-09-29). Raw vectors stay server-side.
 */
export interface StrangerObservation {
  observationId: string;
  logId: string;
  faceId?: string;
  timestamp: string;
  embedding?: number[];
  modelTag?: string;
  /** Tile image: the face crop for a face, the whole frame for a log. */
  photoUrl: string;
  frameUrl: string;
  hasImage: boolean;
  confidence: number;
  doorName: string;
  reason?: string;
}

/** Whole-frame stranger captures, as today: DENIED/unknown logs with a stored photo, minus retired ones. */
export function observationsFromLogs(accessLogs: AccessLogRecord[], retiredIds: string[] = []): StrangerObservation[] {
  const dismissedLogs = new Set(retiredIds.filter((id) => id.startsWith("log:")).map((id) => id.slice(4)));
  return accessLogs
    .filter(
      (log) =>
        !dismissedLogs.has(log.id) &&
        Boolean(log.photoSnapshot) &&
        (log.status === "DENIED" || !log.employeeId || log.employeeName === "Không xác định"),
    )
    .map((log) => ({
      observationId: logObservationId(log.id),
      logId: log.id,
      timestamp: log.timestamp,
      embedding: log.faceEmbedding?.length ? log.faceEmbedding : undefined,
      modelTag: log.faceEmbeddingModelTag || undefined,
      photoUrl: imageUrl(log.id),
      frameUrl: imageUrl(log.id),
      hasImage: Boolean(log.photoSnapshot),
      confidence: log.confidence || 30,
      doorName: log.doorName || "Cổng Quét Cửa",
      reason: log.reason || "Cảnh báo người lạ chụp hình",
    }));
}

export function faceImageUrl(faceId: string): string {
  return `/api/strangers/faces/${encodeURIComponent(faceId)}/image`;
}

/** Per-face records (not purged, not retired). */
export function observationsFromFaces(faces: StrangerFaceRecord[], retiredIds: string[] = []): StrangerObservation[] {
  const retired = new Set(retiredIds);
  return faces
    .filter((f) => !f.purgedAt && !retired.has(faceObservationId(f.id)))
    .map((f) => ({
      observationId: faceObservationId(f.id),
      logId: f.logId,
      faceId: f.id,
      timestamp: f.capturedAt,
      embedding: f.embedding?.length ? f.embedding : undefined,
      modelTag: f.modelTag || undefined,
      photoUrl: faceImageUrl(f.id),
      frameUrl: imageUrl(f.logId),
      hasImage: true,
      confidence: 30,
      doorName: f.gate === "EXIT" ? "Cổng ra" : "Cổng vào",
      reason: "Người lạ (khuôn mặt riêng trong khung hình)",
    }));
}

/** Membership key: bare log id for whole-frame captures (so their cluster ids never change), `face:<id>` for faces. */
const membershipKey = (o: StrangerObservation) => (o.faceId ? o.observationId : o.logId);

/**
 * Deterministic connected-component grouping over compatible ArcFace vectors.
 * Missing embeddings are intentionally singletons; image bytes are never used
 * as an identity signal and raw vectors are never copied into the result.
 */
export function clusterStrangerObservations(
  observations: StrangerObservation[],
  resolvedClusterIds: string[] = [],
  options: StrangerClusterOptions = {},
): StrangerCluster[] {
  const resolved = new Set(resolvedClusterIds);
  const thresholdValue = options.cosineThreshold ?? STRANGER_SAME_PERSON_COSINE;
  const threshold = Number.isFinite(thresholdValue)
    ? Math.max(-1, Math.min(1, thresholdValue))
    : STRANGER_SAME_PERSON_COSINE;

  const items = observations
    .filter((o) => !resolved.has(o.observationId))
    .slice()
    .sort((a, b) => membershipKey(a).localeCompare(membershipKey(b)));

  const partitionOf = (o: StrangerObservation) => options.partitionOf?.get(o.observationId) || "";
  const groups: StrangerObservation[][] = [];
  const groupPartitions: string[] = [];
  for (const item of items) {
    const partition = partitionOf(item);
    if (!item.embedding?.length || !item.modelTag) {
      groups.push([item]);
      groupPartitions.push(partition);
      continue;
    }

    let bestGroup = -1;
    let bestMinimumSimilarity = -Infinity;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];
      // Photos an operator split apart never rejoin automatically.
      if (groupPartitions[groupIndex] !== partition) continue;
      if (group.some((member) => !member.embedding?.length || member.modelTag !== item.modelTag)) continue;
      const similarities = group.map((member) => cosineSimilarity(item.embedding!, member.embedding!));
      const minimumSimilarity = Math.min(...similarities);
      if (minimumSimilarity >= threshold && minimumSimilarity > bestMinimumSimilarity) {
        bestGroup = groupIndex;
        bestMinimumSimilarity = minimumSimilarity;
      }
    }
    if (bestGroup >= 0) groups[bestGroup].push(item);
    else {
      groups.push([item]);
      groupPartitions.push(partition);
    }
  }

  const clusters: StrangerCluster[] = [];
  let index = 1;
  for (const [groupIndex, members] of groups.entries()) {
    const clusterId = clusterIdFor(members.map(membershipKey));
    if (resolved.has(clusterId)) continue;

    members.sort((a, b) => {
      const recent = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      return recent || membershipKey(a).localeCompare(membershipKey(b));
    });
    const photos: StrangerPhoto[] = members.map((o) => ({
      logId: o.logId,
      observationId: o.observationId,
      ...(o.faceId ? { faceId: o.faceId } : {}),
      photoSnapshot: o.photoUrl,
      frameUrl: o.frameUrl,
      imageUrl: o.photoUrl,
      hasImage: o.hasImage,
      timestamp: o.timestamp,
      confidence: o.confidence,
      doorName: o.doorName,
      reason: o.reason,
    }));

    const similarities: number[] = [];
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        if (a.embedding?.length && b.embedding?.length && a.modelTag === b.modelTag) {
          similarities.push(cosineSimilarity(a.embedding, b.embedding));
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
      ...(groupPartitions[groupIndex] && options.splits?.has(groupPartitions[groupIndex])
        ? { split: { clusterId: groupPartitions[groupIndex], observationIds: [...options.splits.get(groupPartitions[groupIndex])!] } }
        : {}),
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

/** Whole-frame captures only (the behaviour before per-face records; cluster ids unchanged). */
export function clusterStrangerFaces(
  accessLogs: AccessLogRecord[],
  resolvedClusterIds: string[] = [],
  options: StrangerClusterOptions = {},
): StrangerCluster[] {
  return clusterStrangerObservations(observationsFromLogs(accessLogs, resolvedClusterIds), resolvedClusterIds, options);
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


/**
 * Gather up to `size` recent candidate captures from a paged source, so they
 * can be grouped together rather than page by page.
 */
export async function collectStrangerWindow(
  fetchPage: (
    cursor: { timestamp: string; id: string } | null,
    limit: number,
  ) => Promise<{ logs: AccessLogRecord[]; hasMore: boolean }>,
  size: number,
  pageSize = 100,
): Promise<AccessLogRecord[]> {
  const logs: AccessLogRecord[] = [];
  let cursor: { timestamp: string; id: string } | null = null;
  while (logs.length < size) {
    const page = await fetchPage(cursor, Math.min(pageSize, size - logs.length));
    logs.push(...page.logs);
    const last = page.logs[page.logs.length - 1];
    if (!page.hasMore || !last) break;
    cursor = { timestamp: last.timestamp, id: last.id };
  }
  return logs;
}

/**
 * One page of finished groups, continuing right after the group named by
 * `afterClusterId`. If that group is no longer present (it was resolved in the
 * meantime) paging restarts from the top, and `restarted` says so.
 */
export function pageStrangerClusters<T extends { clusterId: string }>(
  all: T[],
  afterClusterId: string | null,
  limit: number,
): { clusters: T[]; hasMore: boolean; restarted: boolean } {
  const after = afterClusterId ? all.findIndex((c) => c.clusterId === afterClusterId) : -1;
  const start = after >= 0 ? after + 1 : 0;
  const clusters = all.slice(start, start + limit);
  return { clusters, hasMore: start + limit < all.length, restarted: Boolean(afterClusterId) && after < 0 };
}

/**
 * Flood cap for stranger alerts: at most `maxPerMinute` sends in any rolling
 * minute. `sentAt` is the caller's list of recent send times; the returned
 * list replaces it (pruned, plus `nowMs` when the alert may go out).
 */
export function strangerAlertFloodDecision(
  sentAt: number[],
  nowMs: number,
  maxPerMinute: number,
): { send: boolean; sentAt: number[] } {
  const recent = sentAt.filter((t) => nowMs - t < 60_000);
  if (recent.length >= maxPerMinute) return { send: false, sentAt: recent };
  return { send: true, sentAt: [...recent, nowMs] };
}
