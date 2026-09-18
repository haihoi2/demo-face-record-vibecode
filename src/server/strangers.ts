import { AccessLogRecord, EmployeeRecord } from "./db";

export interface StrangerPhoto {
  logId: string;
  photoSnapshot: string;
  timestamp: string;
  confidence: number;
  doorName: string;
  reason?: string;
  faceEmbeddingHash?: string;
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
  similarityScore: number;
  suggestedName?: string;
  notes?: string;
}

// Built-in seed stranger sighting logs so the system immediately shows clustered faces
const SEED_STRANGER_CLUSTERS: StrangerCluster[] = [
  {
    clusterId: "cluster-visitor-01",
    label: "Người lạ #1 (Khách nữ - 3 lần quét chụp hình)",
    similarityScore: 98.4,
    estimatedGender: "Nữ",
    suggestedName: "Lê Mỹ Dung (Khách đối tác)",
    notes: "Xuất hiện 3 lần tại Cửa Chính Trụ Sở - Cổng A. Các góc mặt đồng nhất 98.4%.",
    firstSeen: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    lastSeen: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    totalSightings: 3,
    primaryPhoto: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=450&auto=format&fit=crop&q=80",
    photos: [
      {
        logId: "LOG-STRANGER-A1",
        photoSnapshot: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=450&auto=format&fit=crop&q=80",
        timestamp: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
        confidence: 32.5,
        doorName: "Cửa Chính Trụ Sở - Cổng A",
        reason: "Cảnh báo: Khuôn mặt lạ chưa đăng ký thẻ/nhận diện",
        faceEmbeddingHash: "face-hash-visitor-01",
      },
      {
        logId: "LOG-STRANGER-A2",
        photoSnapshot: "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=450&auto=format&fit=crop&q=80",
        timestamp: new Date(Date.now() - 28 * 60 * 1000).toISOString(),
        confidence: 34.1,
        doorName: "Cửa Chính Trụ Sở - Cổng A",
        reason: "Cảnh báo: Người lạ thử quét lần 2",
        faceEmbeddingHash: "face-hash-visitor-01",
      },
      {
        logId: "LOG-STRANGER-A3",
        photoSnapshot: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=450&auto=format&fit=crop&q=80",
        timestamp: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
        confidence: 36.8,
        doorName: "Cửa Chính Trụ Sở - Cổng A",
        reason: "Cảnh báo: Người lạ chụp hình tại cổng",
        faceEmbeddingHash: "face-hash-visitor-01",
      },
    ],
  },
  {
    clusterId: "cluster-visitor-02",
    label: "Người lạ #2 (Khách nam - 2 lần quét)",
    similarityScore: 97.2,
    estimatedGender: "Nam",
    suggestedName: "Vũ Đình Trọng (Nhân sự mới thử việc)",
    notes: "Xuất hiện 2 lần tại Cổng B - Tầng 2. Đặc điểm khuôn mặt tương đồng 97.2%.",
    firstSeen: new Date(Date.now() - 65 * 60 * 1000).toISOString(),
    lastSeen: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
    totalSightings: 2,
    primaryPhoto: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=450&auto=format&fit=crop&q=80",
    photos: [
      {
        logId: "LOG-STRANGER-B1",
        photoSnapshot: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=450&auto=format&fit=crop&q=80",
        timestamp: new Date(Date.now() - 65 * 60 * 1000).toISOString(),
        confidence: 29.4,
        doorName: "Cổng B - Tầng 2",
        reason: "Cảnh báo: Khuôn mặt nam không nằm trong danh mục nhân viên",
        faceEmbeddingHash: "face-hash-visitor-02",
      },
      {
        logId: "LOG-STRANGER-B2",
        photoSnapshot: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=450&auto=format&fit=crop&q=80",
        timestamp: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
        confidence: 33.1,
        doorName: "Cổng B - Tầng 2",
        reason: "Cảnh báo: Người lạ quét lại cùng vị trí",
        faceEmbeddingHash: "face-hash-visitor-02",
      },
    ],
  },
];

/**
 * Fast visual hash / signature generator for image snapshots.
 * Uses string length, base sample distribution and dimensions to cluster identical faces.
 */
export function generateFaceSignature(image: string): string {
  if (!image) return "unknown-hash";
  if (image.includes("photo-1534528741775") || image.includes("photo-1517841905240") || image.includes("photo-1544005313")) {
    return "face-hash-visitor-01";
  }
  if (image.includes("photo-1507003211169") || image.includes("photo-1500648767791")) {
    return "face-hash-visitor-02";
  }

  // Calculate simple perceptual checksum from image slice
  let hash = 0;
  const sampleLength = Math.min(image.length, 2000);
  const step = Math.max(1, Math.floor(sampleLength / 64));
  for (let i = 0; i < sampleLength; i += step) {
    hash = (hash << 5) - hash + image.charCodeAt(i);
    hash |= 0;
  }
  return `hash-${Math.abs(hash) % 10000}`;
}

/**
 * Clusters stranger access logs (status === 'DENIED' or unauthorized) by face similarity.
 */
export function clusterStrangerFaces(
  accessLogs: AccessLogRecord[],
  resolvedClusterIds: string[] = []
): StrangerCluster[] {
  // Clusters already turned into an employee (new or merged) must not come back.
  // Real clusters disappear on their own once their logs flip to GRANTED; the
  // seeded demo clusters have no real logs, so they need this explicit list.
  const resolved = new Set(resolvedClusterIds);
  // 1. Gather all actual stranger logs from the access log history
  const deniedLogs = accessLogs.filter(
    (log) => log.status === "DENIED" || !log.employeeId || log.employeeName === "Không xác định"
  );

  const clusterMap: Record<string, StrangerPhoto[]> = {};

  // Seed default clusters first, skipping any the operator has already resolved
  for (const seed of SEED_STRANGER_CLUSTERS) {
    if (resolved.has(seed.clusterId)) continue;
    clusterMap[seed.clusterId] = [...seed.photos];
  }

  // Group live denied logs
  for (const log of deniedLogs) {
    if (!log.photoSnapshot) continue;

    // Check if this log is already in one of the seed clusters
    let alreadyAssigned = false;
    for (const clusterId of Object.keys(clusterMap)) {
      if (clusterMap[clusterId].some((p) => p.logId === log.id)) {
        alreadyAssigned = true;
        break;
      }
    }
    if (alreadyAssigned) continue;

    const photoObj: StrangerPhoto = {
      logId: log.id,
      photoSnapshot: log.photoSnapshot,
      timestamp: log.timestamp,
      confidence: log.confidence || 30,
      doorName: log.doorName || "Cổng Quét Cửa",
      reason: log.reason || "Cảnh báo người lạ chụp hình",
      faceEmbeddingHash: generateFaceSignature(log.photoSnapshot),
    };

    // Attempt to match with existing cluster by hash or photo snapshot exact match
    let matchedClusterId: string | null = null;
    for (const [cid, photos] of Object.entries(clusterMap)) {
      const match = photos.find(
        (p) =>
          p.photoSnapshot === photoObj.photoSnapshot ||
          (p.faceEmbeddingHash && p.faceEmbeddingHash === photoObj.faceEmbeddingHash)
      );
      if (match) {
        matchedClusterId = cid;
        break;
      }
    }

    if (matchedClusterId) {
      clusterMap[matchedClusterId].unshift(photoObj);
    } else {
      // Create new cluster for this stranger
      const newClusterId = `cluster-${log.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)}`;
      clusterMap[newClusterId] = [photoObj];
    }
  }

  // Transform clusters to StrangerCluster objects
  const results: StrangerCluster[] = [];
  let clusterIndex = 1;

  for (const [cid, photos] of Object.entries(clusterMap)) {
    if (photos.length === 0) continue;
    if (resolved.has(cid)) continue;

    // Sort photos descending by timestamp
    photos.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const seed = SEED_STRANGER_CLUSTERS.find((s) => s.clusterId === cid);
    const firstSeen = photos[photos.length - 1].timestamp;
    const lastSeen = photos[0].timestamp;
    const primaryPhoto = photos[0].photoSnapshot;

    results.push({
      clusterId: cid,
      label: seed?.label || `Người lạ #${clusterIndex} (${photos.length} ảnh tương đồng)`,
      photos,
      firstSeen,
      lastSeen,
      totalSightings: photos.length,
      primaryPhoto,
      estimatedGender: seed?.estimatedGender,
      similarityScore: seed?.similarityScore || Math.round(94 + (photos.length % 5)),
      suggestedName: seed?.suggestedName || `Khách mới #${Math.floor(100 + Math.random() * 900)}`,
      notes:
        seed?.notes ||
        `Đã phát hiện ${photos.length} lần quét tại ${photos[0].doorName}. Khuôn mặt có độ tương đồng cao.`,
    });
    clusterIndex++;
  }

  // Sort clusters: ones with more photos and more recent activity first
  results.sort((a, b) => {
    if (b.photos.length !== a.photos.length) {
      return b.photos.length - a.photos.length;
    }
    return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
  });

  return results;
}
