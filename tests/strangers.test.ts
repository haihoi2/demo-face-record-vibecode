/**
 * Regression tests for server-side stranger clustering.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { clusterStrangerFaces } from "../src/server/strangers";
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
