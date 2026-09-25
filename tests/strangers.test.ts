/**
 * Regression tests for server-side stranger clustering.
 */

import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  clusterStrangerFaces,
  collectStrangerWindow,
  pageStrangerClusters,
  strangerCaptureDecision,
  STRANGER_SAME_PERSON_COSINE,
} from "../src/server/strangers";
import { AccessLogRecord } from "../src/server/db";

function makeLog(overrides: Partial<AccessLogRecord> = {}): AccessLogRecord {
  return {
    id: "LOG-0001",
    timestamp: "2026-09-16T08:00:00.000Z",
    type: "ENTRY",
    status: "DENIED",
    photoSnapshot: "data:image/jpeg;base64,AAAABBBBCCCCDDDD",
    confidence: 31.4,
    lockAction: "Khóa giữ nguyên trạng thái LOCKED",
    doorName: "Cửa Chính Trụ Sở",
    ...overrides,
  };
}

describe("clusterStrangerFaces", () => {
  it("does not inject demo clusters unless explicitly enabled", () => {
    assert.deepEqual(clusterStrangerFaces([]), []);
    assert.ok(
      clusterStrangerFaces([], [], { includeDemoSeeds: true }).some(
        (cluster) => cluster.clusterId === "cluster-visitor-01",
      ),
    );
  });

  it("groups compatible ArcFace embeddings by deterministic cosine similarity", () => {
    const clusters = clusterStrangerFaces([
      makeLog({
        id: "LOG-A",
        timestamp: "2026-09-16T08:00:00.000Z",
        faceEmbedding: [1, 0, 0],
        faceEmbeddingModelTag: "arcface_w600k_r50",
      }),
      makeLog({
        id: "LOG-B",
        timestamp: "2026-09-16T09:00:00.000Z",
        faceEmbedding: [0.99, 0.01, 0],
        faceEmbeddingModelTag: "arcface_w600k_r50",
      }),
    ]);

    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0].photos.map((photo) => photo.logId), ["LOG-B", "LOG-A"]);
    assert.ok(clusters[0].similarityScore > 99);
  });

  it("never compares embeddings from different model tags", () => {
    const clusters = clusterStrangerFaces([
      makeLog({
        id: "LOG-A",
        faceEmbedding: [1, 0, 0],
        faceEmbeddingModelTag: "arcface_w600k_r50",
      }),
      makeLog({
        id: "LOG-B",
        faceEmbedding: [1, 0, 0],
        faceEmbeddingModelTag: "arcface_other",
      }),
    ]);

    assert.equal(clusters.length, 2);
    assert.ok(clusters.every((cluster) => cluster.totalSightings === 1));
  });

  it("does not merge distinct identities through a transitive similarity bridge", () => {
    const clusters = clusterStrangerFaces([
      makeLog({ id: "LOG-A", faceEmbedding: [1, 0], faceEmbeddingModelTag: "arcface" }),
      makeLog({ id: "LOG-B", faceEmbedding: [0.8, 0.6], faceEmbeddingModelTag: "arcface" }),
      makeLog({ id: "LOG-C", faceEmbedding: [0.28, 0.96], faceEmbeddingModelTag: "arcface" }),
    ], [], { cosineThreshold: 0.75 });

    assert.equal(clusters.length, 2);
    assert.deepEqual(clusters.map((cluster) => cluster.totalSightings).sort(), [1, 2]);
    assert.ok(!clusters.some((cluster) =>
      cluster.photos.some((photo) => photo.logId === "LOG-A") &&
      cluster.photos.some((photo) => photo.logId === "LOG-C")
    ));
  });

  it("keeps missing embeddings as singletons even when JPEG bytes are identical", () => {
    const snapshot = "data:image/jpeg;base64,SAMEJPEG";
    const clusters = clusterStrangerFaces([
      makeLog({ id: "LOG-A", photoSnapshot: snapshot }),
      makeLog({ id: "LOG-B", photoSnapshot: snapshot }),
    ]);

    assert.equal(clusters.length, 2);
    assert.ok(clusters.every((cluster) => cluster.totalSightings === 1));
  });

  it("returns image endpoint metadata and never raw images or embeddings", () => {
    const [cluster] = clusterStrangerFaces([
      makeLog({
        id: "LOG-IMAGE",
        photoSnapshot: "data:image/jpeg;base64,VERY-LARGE-SECRET-IMAGE",
        faceEmbedding: [1, 0, 0],
        faceEmbeddingModelTag: "arcface_w600k_r50",
      }),
    ]);

    const serialized = JSON.stringify(cluster);
    assert.equal(cluster.primaryPhoto, "/api/logs/LOG-IMAGE/image");
    assert.equal(cluster.photos[0].photoSnapshot, "/api/logs/LOG-IMAGE/image");
    assert.doesNotMatch(serialized, /VERY-LARGE-SECRET-IMAGE/);
    assert.doesNotMatch(serialized, /faceEmbedding/);
    assert.doesNotMatch(serialized, /\[1,0,0\]/);
  });

  it("filters resolved clusters and individually dismissed logs", () => {
    const logs = [
      makeLog({ id: "LOG-A", faceEmbedding: [1, 0], faceEmbeddingModelTag: "arcface" }),
      makeLog({ id: "LOG-B", faceEmbedding: [0, 1], faceEmbeddingModelTag: "arcface" }),
    ];
    const initial = clusterStrangerFaces(logs);
    const resolvedCluster = initial.find((cluster) => cluster.photos[0].logId === "LOG-A");
    assert.ok(resolvedCluster);

    const remaining = clusterStrangerFaces(logs, [resolvedCluster.clusterId, "log:LOG-B"]);
    assert.deepEqual(remaining, []);
  });

  it("keeps a later similar sighting visible after the adjudicated observation set is retired", () => {
    const oldLog = makeLog({ id: "LOG-OLD", faceEmbedding: [1, 0], faceEmbeddingModelTag: "arcface" });
    const newLog = makeLog({ id: "LOG-NEW", faceEmbedding: [1, 0], faceEmbeddingModelTag: "arcface" });
    const clusters = clusterStrangerFaces([oldLog, newLog], ["log:LOG-OLD"]);
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0].photos.map((photo) => photo.logId), ["LOG-NEW"]);
  });

  it("uses collision-resistant ids for independent observation memberships", () => {
    const clusters = clusterStrangerFaces([
      makeLog({ id: "LOG-A/unsafe-prefix-111111111111111111111111111111", timestamp: "2026-09-16T08:00:00.000Z" }),
      makeLog({ id: "LOG-A_unsafe-prefix-222222222222222222222222222222", timestamp: "2026-09-16T09:00:00.000Z" }),
    ]);

    assert.equal(clusters.length, 2);
    assert.notEqual(clusters[0].clusterId, clusters[1].clusterId);
    assert.ok(clusters.every((cluster) => /^cluster-[a-f0-9]{64}$/.test(cluster.clusterId)));
  });

  it("processes candidates beyond the former 5,000-row cap", () => {
    const logs = Array.from({ length: 5_001 }, (_, index) => makeLog({
      id: `LOG-${String(index).padStart(5, "0")}`,
      timestamp: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(),
    }));
    const clusters = clusterStrangerFaces(logs);
    assert.equal(clusters.length, 5_001);
    assert.ok(clusters.some((cluster) => cluster.photos[0].logId === "LOG-05000"));
  });
});

describe("stranger capture quality floor", () => {
  it("is a storage gate only - the constant never appears in a recognition decision", () => {
    const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    // The floor must not leak into matching, fusion or the unlock path: a poor
    // capture is still allowed to be recognised, it is just not stored.
    const uses = server.match(/FACE_STRANGER_MIN_QUALITY/g) || [];
    assert.ok(uses.length >= 2, "expected the floor to be declared and applied");
    assert.doesNotMatch(server, /recognizeObservations\([^)]*FACE_STRANGER_MIN_QUALITY/);
    assert.doesNotMatch(server, /FACE_STRANGER_MIN_QUALITY[^\n]*unlockDoor/);
    assert.match(server, /summary\.suppressed = "stranger-quality"/);
  });
});

describe("stranger capture cooldown (per person, not per gate)", () => {
  const A = [1, 0, 0];
  const A2 = [0.9, Math.sqrt(1 - 0.81), 0]; // same person again: cosine 0.9 with A
  const B = [0, 1, 0];                        // someone else: cosine 0 with A
  const WINDOW = 60_000;

  it("captures a second, different stranger who arrives inside the window", () => {
    const first = strangerCaptureDecision([], A, 0, WINDOW);
    assert.equal(first.capture, true);
    const second = strangerCaptureDecision(first.recent, B, 5_000, WINDOW);
    assert.equal(second.capture, true, "a different person is not suppressed by the first one's cooldown");
  });

  it("captures one person lingering only once, extending their window while they stay", () => {
    let state = strangerCaptureDecision([], A, 0, WINDOW);
    for (const t of [20_000, 50_000, 90_000, 140_000]) {
      state = strangerCaptureDecision(state.recent, A2, t, WINDOW);
      assert.equal(state.capture, false, `still suppressed at ${t} ms`);
    }
    const back = strangerCaptureDecision(state.recent, A2, 140_000 + WINDOW + 1, WINDOW);
    assert.equal(back.capture, true, "captured again after being away for a whole window");
  });

  it("uses the calibrated same-person threshold by default", () => {
    assert.equal(STRANGER_SAME_PERSON_COSINE, 0.45);
  });
});

describe("stranger grouping at the calibrated threshold", () => {
  it("groups a returning stranger whose similarity is in the measured same-person range", () => {
    const a = [1, 0];
    const b = [0.55, Math.sqrt(1 - 0.55 * 0.55)]; // cosine 0.55: typical same-camera repeat on this site
    const clusters = clusterStrangerFaces([
      makeLog({ id: "LOG-R1", faceEmbedding: a, faceEmbeddingModelTag: "arcface" }),
      makeLog({ id: "LOG-R2", faceEmbedding: b, faceEmbeddingModelTag: "arcface" }),
    ], []);
    assert.equal(clusters.length, 1, "0.55 was below the old 0.6 threshold and left both as singletons");
    assert.equal(clusters[0].totalSightings, 2);
  });

  it("keeps different people apart at the highest different-person similarity measured (0.289)", () => {
    const a = [1, 0];
    const b = [0.289, Math.sqrt(1 - 0.289 * 0.289)];
    const clusters = clusterStrangerFaces([
      makeLog({ id: "LOG-D1", faceEmbedding: a, faceEmbeddingModelTag: "arcface" }),
      makeLog({ id: "LOG-D2", faceEmbedding: b, faceEmbeddingModelTag: "arcface" }),
    ], []);
    assert.equal(clusters.length, 2);
  });
});

describe("grouping over a window, not page by page", () => {
  // 120 captures, newest first. The first and the 110th are the same person;
  // everything else is a distinct passer-by.
  const oneHot = (k: number) => Array.from({ length: 128 }, (_, j) => (j === k ? 1 : 0));
  const person = oneHot(0);
  const logs = Array.from({ length: 120 }, (_, i) => {
    const other = oneHot(i + 1); // orthogonal to everyone else: a distinct passer-by
    return makeLog({
      id: `LOG-W${String(1000 - i).padStart(4, "0")}`,
      timestamp: new Date(Date.UTC(2026, 8, 25, 10, 0, 0) - i * 60_000).toISOString(),
      faceEmbedding: i === 0 || i === 110 ? person : other,
      faceEmbeddingModelTag: "arcface",
    });
  });
  const pagedSource = async (cursor: { timestamp: string; id: string } | null, limit: number) => {
    const start = cursor ? logs.findIndex((l) => l.id === cursor.id) + 1 : 0;
    const page = logs.slice(start, start + Math.min(limit, 50)); // the store returns at most 50
    return { logs: page, hasMore: start + page.length < logs.length };
  };

  it("joins a returning stranger whose two captures are on different pages", async () => {
    const perPage = clusterStrangerFaces(logs.slice(0, 50), []);
    assert.ok(!perPage.some((c) => c.totalSightings > 1), "page by page, the return visit is never joined");

    const window = await collectStrangerWindow(pagedSource, 500);
    assert.equal(window.length, 120, "the window gathers every page");
    const grouped = clusterStrangerFaces(window, []);
    const repeat = grouped.find((c) => c.totalSightings === 2);
    assert.ok(repeat, "over the window the two visits form one group");
    assert.deepEqual(repeat!.photos.map((p) => p.logId).sort(), ["LOG-W0890", "LOG-W1000"]);
  });

  it("stops at the window size", async () => {
    assert.equal((await collectStrangerWindow(pagedSource, 70)).length, 70);
  });

  it("pages through groups exactly once, and restarts if the cursor's group is gone", () => {
    const all = Array.from({ length: 7 }, (_, i) => ({ clusterId: `c${i}` }));
    const seen: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page = pageStrangerClusters(all, after, 3);
      seen.push(...page.clusters.map((c) => c.clusterId));
      if (!page.hasMore) break;
      after = page.clusters[page.clusters.length - 1].clusterId;
    }
    assert.deepEqual(seen, all.map((c) => c.clusterId));
    const gone = pageStrangerClusters(all, "resolved-meanwhile", 3);
    assert.equal(gone.restarted, true);
    assert.equal(gone.clusters[0].clusterId, "c0");
  });
});
