/**
 * One stranger record per face (plan 2026-09-29): grouping over per-face
 * records next to older whole-frame captures, and the observation-id contract.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  clusterStrangerFaces,
  clusterStrangerObservations,
  observationsFromFaces,
  observationsFromLogs,
} from "../src/server/strangers";
import { parseObservationIds, strangerFaceRetentionDays, type StrangerFaceRecord } from "../src/server/strangerFaces";
import type { AccessLogRecord } from "../src/server/db";

function unit(seed: number, dims = 512): number[] {
  let x = seed * 7919 + 17;
  const v: number[] = [];
  for (let i = 0; i < dims; i++) { x = (x * 1103515245 + 12345) % 2147483648; v.push(x / 2147483648 - 0.5); }
  const n = Math.hypot(...v);
  return v.map((a) => a / n);
}
function near(base: number[], noise: number, seed: number): number[] {
  const r = unit(seed);
  const v = base.map((a, i) => a + noise * r[i]);
  const n = Math.hypot(...v);
  return v.map((a) => a / n);
}
const TAG = "arcface_w600k_r50";
function face(id: string, logId: string, embedding: number[], capturedAt = "2026-09-29T08:00:00.000Z", extra: Partial<StrangerFaceRecord> = {}): StrangerFaceRecord {
  return {
    id, logId, faceIndex: 0, capturedAt, gate: "ENTRY", engine: "legacy", box: [0, 0, 100, 100],
    detectorScore: 0.9, quality: 0.6, sizePx: 100, embedding, dims: embedding.length, modelTag: TAG, createdAt: capturedAt, ...extra,
  };
}
function log(id: string, embedding?: number[]): AccessLogRecord {
  return {
    id, timestamp: "2026-09-20T08:00:00.000Z", type: "ENTRY", status: "DENIED", photoSnapshot: "stored",
    confidence: 30, lockAction: "LOCKED", doorName: "Cổng", faceEmbedding: embedding, faceEmbeddingModelTag: embedding ? TAG : undefined,
  };
}

describe("per-face stranger grouping", () => {
  const personA = unit(1);
  const personB = unit(2);

  it("two strangers in ONE frame land in two groups, each joining their own later sightings", () => {
    const faces = [
      face("SF-a1", "LOG-1", personA), face("SF-b1", "LOG-1", personB, undefined, { faceIndex: 1 }),
      face("SF-a2", "LOG-2", near(personA, 0.4, 11), "2026-09-29T09:00:00.000Z"),
      face("SF-b2", "LOG-3", near(personB, 0.4, 12), "2026-09-29T10:00:00.000Z"),
    ];
    const clusters = clusterStrangerObservations(observationsFromFaces(faces));
    assert.equal(clusters.length, 2);
    const byMembers = clusters.map((c) => c.photos.map((p) => p.faceId).sort().join(","));
    assert.deepEqual(byMembers.sort(), ["SF-a1,SF-a2", "SF-b1,SF-b2"]);
    // Tiles of the same frame share the logId but are distinct observations.
    const tiles = clusters.flatMap((c) => c.photos).filter((p) => p.logId === "LOG-1");
    assert.equal(tiles.length, 2);
    assert.notEqual(tiles[0].observationId, tiles[1].observationId);
  });

  it("a face tile shows its crop and links the whole frame", () => {
    const [cluster] = clusterStrangerObservations(observationsFromFaces([face("SF-1", "LOG-9", personA)]));
    const [photo] = cluster.photos;
    assert.equal(photo.observationId, "face:SF-1");
    assert.equal(photo.photoSnapshot, "/api/strangers/faces/SF-1/image");
    assert.equal(photo.frameUrl, "/api/logs/LOG-9/image");
  });

  it("resolving one face leaves the other face of the frame open", () => {
    const faces = [face("SF-a1", "LOG-1", personA), face("SF-b1", "LOG-1", personB)];
    const retired = ["face:SF-a1"];
    const clusters = clusterStrangerObservations(observationsFromFaces(faces, retired), retired);
    assert.deepEqual(clusters.map((c) => c.photos.map((p) => p.faceId)), [["SF-b1"]]);
  });

  it("purged faces are not offered", () => {
    const clusters = clusterStrangerObservations(observationsFromFaces([face("SF-p", "LOG-1", personA, undefined, { purgedAt: "2026-10-13T00:00:00Z" })]));
    assert.equal(clusters.length, 0);
  });

  it("older whole-frame captures keep their cluster ids and still group with faces of the same person", () => {
    const logs = [log("LOG-OLD-1", near(personA, 0.3, 5))];
    const before = clusterStrangerFaces(logs);
    const after = clusterStrangerObservations(observationsFromLogs(logs));
    assert.equal(after[0].clusterId, before[0].clusterId, "log-only cluster id unchanged");
    const mixed = clusterStrangerObservations([...observationsFromLogs(logs), ...observationsFromFaces([face("SF-a", "LOG-NEW", personA)])]);
    assert.equal(mixed.length, 1);
    assert.deepEqual(mixed[0].photos.map((p) => p.observationId).sort(), ["face:SF-a", "log:LOG-OLD-1"]);
  });
});

describe("observation ids", () => {
  it("split face: and log: ids, sorted and de-duplicated", () => {
    assert.deepEqual(parseObservationIds(["face:SF-2", "log:LOG-1", "face:SF-1", "face:SF-2"]), {
      logIds: ["LOG-1"], faceIds: ["SF-1", "SF-2"],
    });
  });

  it("reject anything malformed as a whole", () => {
    assert.equal(parseObservationIds(["face:SF-1", "LOG-1"]), null, "no prefix");
    assert.equal(parseObservationIds(["face:../etc"]), null);
    assert.equal(parseObservationIds("face:SF-1"), null);
    assert.equal(parseObservationIds([1]), null);
  });

  it("retention defaults to the owner's 14 days; blank means unset, 0 disables", () => {
    assert.equal(strangerFaceRetentionDays({}), 14);
    assert.equal(strangerFaceRetentionDays({ FACE_STRANGER_FACE_RETENTION_DAYS: "" }), 14);
    assert.equal(strangerFaceRetentionDays({ FACE_STRANGER_FACE_RETENTION_DAYS: "0" }), 0);
    assert.equal(strangerFaceRetentionDays({ FACE_STRANGER_FACE_RETENTION_DAYS: "30" }), 30);
  });
});

describe("server wiring", () => {
  const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

  it("never stores a face that matches an employee on its own as a stranger", () => {
    assert.match(src, /if \(recognizeObservations\(\[o\.observation\], gallery, thresholds\)\.recognized\) return;/);
  });

  it("tailgating strangers are recorded only after the grant, never feeding the door decision", () => {
    const grant = src.indexOf("unlockDoor(unlockSource");
    const persist = src.indexOf("await persistStrangerFaces(tailgaterFaces");
    assert.ok(grant > 0 && persist > grant);
  });

  it("the crop route uses the same cross-site guard as the frame photo", () => {
    assert.match(src, /app\.get\("\/api\/strangers\/faces\/:faceId\/image", requireOperatorRole\("viewer"\), async \(req, res\) => \{\n  if \(!guardBiometricImage\(req, res\)\) return;/);
  });

  it("purge keeps faces that became an employee", () => {
    assert.match(src, /r\.action === "QUICK_REGISTER" \|\| r\.action === "MERGE"/);
  });
});
