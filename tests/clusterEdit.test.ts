/**
 * Stranger group editing (2026-10-05): photos an operator split off a group
 * form their own group and never rejoin it automatically; removed photos are a
 * DISMISS (hidden, restorable); both are undone through /api/strangers/restore.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { clusterStrangerObservations, observationsFromFaces } from "../src/server/strangers";
import type { StrangerFaceRecord } from "../src/server/strangerFaces";
import { isRestorableResolutionAction } from "../src/server/db";
import { clusterEditRequest, clusterEditSuccessText, splitUndoRequest, toggleObservation } from "../src/utils/clusterEdit";

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
function face(id: string, embedding: number[], capturedAt = "2026-10-05T08:00:00.000Z"): StrangerFaceRecord {
  return {
    id, logId: `LOG-${id}`, faceIndex: 0, capturedAt, gate: "ENTRY", engine: "legacy", box: [0, 0, 100, 100],
    detectorScore: 0.9, quality: 0.6, sizePx: 100, embedding, dims: embedding.length, modelTag: "arcface_w600k_r50", createdAt: capturedAt,
  };
}
const members = (c: { photos: Array<{ faceId?: string }> }) => c.photos.map((p) => p.faceId).sort().join(",");

describe("split partitions in grouping", () => {
  const person = unit(1);
  const faces = [face("SF-1", person), face("SF-2", near(person, 0.3, 11)), face("SF-3", near(person, 0.3, 12)), face("SF-4", near(person, 0.3, 13))];

  it("without splits the four photos are one group", () => {
    const clusters = clusterStrangerObservations(observationsFromFaces(faces));
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].split, undefined);
  });

  it("split-off photos form their own group and carry the split's id and membership", () => {
    const partitionOf = new Map([["face:SF-3", "SPLIT-a"], ["face:SF-4", "SPLIT-a"]]);
    const splits = new Map([["SPLIT-a", ["face:SF-3", "face:SF-4"]]]);
    const clusters = clusterStrangerObservations(observationsFromFaces(faces), [], { partitionOf, splits });
    assert.deepEqual(clusters.map(members).sort(), ["SF-1,SF-2", "SF-3,SF-4"]);
    const split = clusters.find((c) => members(c) === "SF-3,SF-4")!;
    assert.deepEqual(split.split, { clusterId: "SPLIT-a", observationIds: ["face:SF-3", "face:SF-4"] });
    assert.equal(clusters.find((c) => members(c) === "SF-1,SF-2")!.split, undefined);
  });

  it("a new sighting of the person joins the unsplit group, never the split one", () => {
    const partitionOf = new Map([["face:SF-3", "SPLIT-a"], ["face:SF-4", "SPLIT-a"]]);
    const later = face("SF-5", near(person, 0.3, 14), "2026-10-05T09:00:00.000Z");
    const clusters = clusterStrangerObservations(observationsFromFaces([...faces, later]), [], { partitionOf });
    assert.deepEqual(clusters.map(members).sort(), ["SF-1,SF-2,SF-5", "SF-3,SF-4"]);
  });

  it("splitting a split again: the newest split wins for its photos", () => {
    const partitionOf = new Map([["face:SF-2", "SPLIT-a"], ["face:SF-3", "SPLIT-b"], ["face:SF-4", "SPLIT-a"]]);
    const clusters = clusterStrangerObservations(observationsFromFaces(faces), [], { partitionOf });
    assert.deepEqual(clusters.map(members).sort(), ["SF-1", "SF-2,SF-4", "SF-3"]);
  });

  it("a split never pulls in another person", () => {
    const other = face("SF-x", unit(2));
    const partitionOf = new Map([["face:SF-x", "SPLIT-a"], ["face:SF-4", "SPLIT-a"]]);
    const clusters = clusterStrangerObservations(observationsFromFaces([...faces, other]), [], { partitionOf });
    assert.ok(clusters.some((c) => members(c) === "SF-x"));
    assert.ok(clusters.some((c) => members(c) === "SF-4"));
  });

  it("only DISMISS and SPLIT can be undone", () => {
    assert.equal(isRestorableResolutionAction("DISMISS"), true);
    assert.equal(isRestorableResolutionAction("SPLIT"), true);
    for (const a of ["MERGE", "QUICK_REGISTER", "RESTORE", undefined]) assert.equal(isRestorableResolutionAction(a), false, String(a));
  });
});

describe("client requests", () => {
  const cluster = {
    clusterId: "cluster-abc", clusterVersion: 42,
    photos: [{ logId: "L1", observationId: "face:SF-1", faceId: "SF-1" }, { logId: "L2", observationId: "log:L2" }],
  } as any;

  it("split and remove name the group, its full membership and the picked photos", () => {
    const split = clusterEditRequest("split", cluster, ["face:SF-1"]);
    assert.equal(split.url, "/api/strangers/clusters/cluster-abc/split");
    const body = JSON.parse(String(split.init.body));
    assert.equal(body.clusterVersion, 42);
    assert.deepEqual(body.clusterObservationIds, ["face:SF-1", "log:L2"]);
    assert.deepEqual(body.selectedObservationIds, ["face:SF-1"]);
    assert.equal(split.init.method, "POST");
    assert.equal(clusterEditRequest("remove", cluster, ["log:L2"]).url, "/api/strangers/clusters/cluster-abc/remove-photos");
  });

  it("an id with URL characters is encoded", () => {
    assert.equal(clusterEditRequest("split", { ...cluster, clusterId: "a/b" }, ["log:L2"]).url, "/api/strangers/clusters/a%2Fb/split");
  });

  it("undo restores exactly what the server recorded", () => {
    const undo = splitUndoRequest({ clusterId: "SPLIT-1", clusterObservationIds: ["face:SF-1"] });
    assert.equal(undo.url, "/api/strangers/restore");
    assert.deepEqual(JSON.parse(String(undo.init.body)), { clusterId: "SPLIT-1", clusterObservationIds: ["face:SF-1"] });
  });

  it("selection toggles one photo at a time", () => {
    assert.deepEqual(toggleObservation([], "face:SF-1"), ["face:SF-1"]);
    assert.deepEqual(toggleObservation(["face:SF-1", "log:L2"], "face:SF-1"), ["log:L2"]);
  });

  it("success text says what happened and how many", () => {
    assert.match(clusterEditSuccessText("split", 2), /Đã tách 2 ảnh/);
    assert.match(clusterEditSuccessText("remove", 1), /Đã bỏ 1 ảnh/);
  });
});

describe("wiring", () => {
  const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const db = readFileSync(new URL("../src/server/db.ts", import.meta.url), "utf8");
  const auth = readFileSync(new URL("../src/server/auth.ts", import.meta.url), "utf8");
  it("both routes are operator-only, CSRF-protected, validated against the group on screen", () => {
    assert.match(src, /app\.post\("\/api\/strangers\/clusters\/:clusterId\/split", requireOperatorRole\("operator"\), requireCsrf,/);
    assert.match(src, /app\.post\("\/api\/strangers\/clusters\/:clusterId\/remove-photos", requireOperatorRole\("operator"\), requireCsrf,/);
    assert.match(src, /validatedStrangerCluster\(req\.params\.clusterId, membership, req\.body\?\.clusterVersion\)/);
    assert.match(auth, /\\\/api\\\/strangers\\\/clusters\\\/\[\^\/\]\+\\\/\(\?:split\|remove-photos\)\$\/, role: "operator"/);
  });
  it("a split does not hide its photos; the window groups with the split partitions", () => {
    assert.match(db, /filter\(\(resolution\) => resolution\.action !== "SPLIT"\)/);
    assert.match(src, /clusterStrangerObservations\(observations, retired, \{ includeDemoSeeds: DEMO_DATA_ENABLED, partitionOf, splits \}\)/);
  });
  it("neither route rewrites access history or touches the door", () => {
    const routes = src.slice(src.indexOf("async function pickedFromStrangerCluster"), src.indexOf("Admin: retire stored stranger captures"));
    assert.doesNotMatch(routes, /saveAccessLog|updateAccessLog|unlockDoor|lockDoor|deleteStrangerFace/);
  });
});
