/**
 * Unit tests for stranger face signature hashing and clustering
 * (src/server/strangers.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { generateFaceSignature, clusterStrangerFaces } from "../src/server/strangers";
import { AccessLogRecord } from "../src/server/db";

const KNOWN_VISITOR_01 = "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=450";
const KNOWN_VISITOR_02 = "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=450";

function makeLog(overrides: Partial<AccessLogRecord> = {}): AccessLogRecord {
  return {
    id: "LOG-0001",
    timestamp: "2026-09-16T08:00:00.000Z",
    type: "ENTRY",
    status: "DENIED",
    photoSnapshot: "data:image/jpeg;base64,AAAABBBBCCCCDDDD",
    confidence: 31.4,
    lockAction: "NONE",
    doorName: "Cửa Chính Trụ Sở",
    ...overrides,
  };
}

describe("generateFaceSignature", () => {
  it("returns a sentinel for an empty image", () => {
    assert.equal(generateFaceSignature(""), "unknown-hash");
  });

  it("maps the seeded visitor-01 photos onto one shared signature", () => {
    assert.equal(generateFaceSignature(KNOWN_VISITOR_01), "face-hash-visitor-01");
    assert.equal(
      generateFaceSignature("https://images.unsplash.com/photo-1517841905240-472988babdf9?w=450"),
      "face-hash-visitor-01"
    );
  });

  it("maps the seeded visitor-02 photos onto their own signature", () => {
    assert.equal(generateFaceSignature(KNOWN_VISITOR_02), "face-hash-visitor-02");
  });

  it("derives a stable hash-N signature for unseen images", () => {
    const signature = generateFaceSignature("data:image/jpeg;base64,ZZZZYYYYXXXX");
    assert.match(signature, /^hash-\d{1,4}$/);
    assert.equal(signature, generateFaceSignature("data:image/jpeg;base64,ZZZZYYYYXXXX"));
  });

  it("separates clearly different images", () => {
    assert.notEqual(
      generateFaceSignature("data:image/jpeg;base64,AAAAAAAAAAAA"),
      generateFaceSignature("data:image/jpeg;base64,ZZZZZZZZZZZZ")
    );
  });
});

describe("clusterStrangerFaces", () => {
  it("returns the seeded clusters when there are no logs", () => {
    const clusters = clusterStrangerFaces([]);

    assert.ok(clusters.length >= 1);
    assert.ok(clusters.some((c) => c.clusterId === "cluster-visitor-01"));
    for (const cluster of clusters) {
      assert.ok(cluster.photos.length > 0);
      assert.equal(cluster.totalSightings, cluster.photos.length);
      assert.equal(cluster.primaryPhoto, cluster.photos[0].photoSnapshot);
    }
  });

  it("folds a denied log with a known face into the matching seeded cluster", () => {
    const before = clusterStrangerFaces([]);
    const seeded = before.find((c) => c.clusterId === "cluster-visitor-01");
    assert.ok(seeded);

    const after = clusterStrangerFaces([
      makeLog({ id: "LOG-NEW-1", photoSnapshot: KNOWN_VISITOR_01 }),
    ]);
    const grown = after.find((c) => c.clusterId === "cluster-visitor-01");

    assert.ok(grown);
    assert.equal(grown.photos.length, seeded.photos.length + 1);
    assert.ok(grown.photos.some((p) => p.logId === "LOG-NEW-1"));
  });

  it("opens a new cluster for a face that matches nothing seeded", () => {
    const before = clusterStrangerFaces([]).length;
    const after = clusterStrangerFaces([
      makeLog({ id: "LOG-NOVEL-1", photoSnapshot: "data:image/jpeg;base64,NOVELFACE0001" }),
    ]);

    assert.equal(after.length, before + 1);
    const created = after.find((c) => c.photos.some((p) => p.logId === "LOG-NOVEL-1"));
    assert.ok(created);
    assert.equal(created.totalSightings, 1);
  });

  it("groups two sightings of the same novel face into a single cluster", () => {
    const snapshot = "data:image/jpeg;base64,REPEATEDFACE99";
    const clusters = clusterStrangerFaces([
      makeLog({ id: "LOG-R1", photoSnapshot: snapshot, timestamp: "2026-09-16T08:00:00.000Z" }),
      makeLog({ id: "LOG-R2", photoSnapshot: snapshot, timestamp: "2026-09-16T09:00:00.000Z" }),
    ]);

    const matched = clusters.filter((c) => c.photos.some((p) => p.photoSnapshot === snapshot));
    assert.equal(matched.length, 1);
    assert.equal(matched[0].totalSightings, 2);
  });

  it("skips denied logs that carry no photo snapshot", () => {
    const before = clusterStrangerFaces([]).length;
    const after = clusterStrangerFaces([makeLog({ id: "LOG-NOPHOTO", photoSnapshot: "" })]);

    assert.equal(after.length, before);
  });

  it("ignores granted logs that belong to a known employee", () => {
    const before = clusterStrangerFaces([]).length;
    const after = clusterStrangerFaces([
      makeLog({
        id: "LOG-GRANTED",
        status: "GRANTED",
        employeeId: "EMP-0001",
        employeeName: "Nguyễn Văn A",
        photoSnapshot: "data:image/jpeg;base64,EMPLOYEEFACE01",
      }),
    ]);

    assert.equal(after.length, before);
  });

  it("treats a granted log with no employeeId as a stranger", () => {
    const before = clusterStrangerFaces([]).length;
    const after = clusterStrangerFaces([
      makeLog({
        id: "LOG-ORPHAN",
        status: "GRANTED",
        photoSnapshot: "data:image/jpeg;base64,ORPHANFACE001",
      }),
    ]);

    assert.equal(after.length, before + 1);
  });

  it("orders photos newest-first and derives firstSeen/lastSeen from them", () => {
    const snapshot = "data:image/jpeg;base64,ORDEREDFACE01";
    const [cluster] = clusterStrangerFaces([
      makeLog({ id: "LOG-O1", photoSnapshot: snapshot, timestamp: "2026-09-16T08:00:00.000Z" }),
      makeLog({ id: "LOG-O2", photoSnapshot: snapshot, timestamp: "2026-09-16T10:00:00.000Z" }),
    ]).filter((c) => c.photos.some((p) => p.photoSnapshot === snapshot));

    assert.ok(cluster);
    assert.equal(cluster.photos[0].logId, "LOG-O2");
    assert.equal(cluster.lastSeen, "2026-09-16T10:00:00.000Z");
    assert.equal(cluster.firstSeen, "2026-09-16T08:00:00.000Z");
  });

  it("sorts clusters by sighting count, densest first", () => {
    const clusters = clusterStrangerFaces([
      makeLog({ id: "LOG-S1", photoSnapshot: "data:image/jpeg;base64,SINGLEFACE001" }),
    ]);

    for (let i = 1; i < clusters.length; i++) {
      assert.ok(
        clusters[i - 1].photos.length >= clusters[i].photos.length,
        "clusters must be ordered by descending photo count"
      );
    }
  });

  it("falls back to sensible defaults on generated clusters", () => {
    const clusters = clusterStrangerFaces([
      makeLog({
        id: "LOG-DEFAULTS",
        photoSnapshot: "data:image/jpeg;base64,DEFAULTSFACE1",
        confidence: 0,
        doorName: "",
        reason: undefined,
      }),
    ]);

    const created = clusters.find((c) => c.photos.some((p) => p.logId === "LOG-DEFAULTS"));
    assert.ok(created);

    const photo = created.photos.find((p) => p.logId === "LOG-DEFAULTS");
    assert.ok(photo);
    assert.equal(photo.confidence, 30);
    assert.equal(photo.doorName, "Cổng Quét Cửa");
    assert.equal(photo.reason, "Cảnh báo người lạ chụp hình");
    assert.equal(photo.faceEmbeddingHash, generateFaceSignature(photo.photoSnapshot));
  });
});
