/**
 * Stranger/list API regressions against an isolated disposable gateway.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  api,
  createTempEmployee,
  deleteEmployee,
  noFaceJpegDataUrl,
  postJson,
  recognize,
  type Employee,
} from "./helpers";

interface AccessLog {
  id: string;
  status: "GRANTED" | "DENIED";
  lockAction: string;
  photoSnapshot: string;
  imageUrl?: string;
  hasImage?: boolean;
  faceEmbedding?: number[];
}

async function makeDeniedLog(seed: number): Promise<AccessLog> {
  const res = await recognize({ imageBase64: noFaceJpegDataUrl(64, seed), scanType: "ENTRY" });
  assert.equal(res.status, 200, res.text.slice(0, 300));
  const body = res.body as any;
  assert.equal(body.recognized, false);
  assert.ok(body.log?.id);
  return body.log as AccessLog;
}

async function clusterFor(logId: string) {
  const res = await api<any>("/api/strangers/clusters?limit=20");
  assert.equal(res.status, 200, res.text.slice(0, 300));
  return res.body.clusters.find((cluster: any) =>
    cluster.photos.some((photo: any) => photo.logId === logId),
  );
}

describe("bounded image-free list APIs", () => {
  let denied: AccessLog;

  before(async () => {
    denied = await makeDeniedLog(91001);
  });

  it("GET /api/logs is bounded and never embeds full image data or embeddings", async () => {
    const res = await api<AccessLog[]>("/api/logs");
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length <= 50);
    assert.equal(typeof res.headers.get("x-total-count"), "string");
    assert.doesNotMatch(res.text, /data:image\//);
    assert.doesNotMatch(res.text, /faceEmbedding/);
    for (const log of res.body) {
      assert.equal(log.photoSnapshot, `/api/logs/${encodeURIComponent(log.id)}/image`);
      assert.equal(log.imageUrl, log.photoSnapshot);
    }
  });

  it("GET /api/logs?format=page returns pagination metadata", async () => {
    const res = await api<any>("/api/logs?format=page&page=1&limit=1");
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.page, 1);
    assert.equal(res.body.limit, 1);
    assert.equal(res.body.logs.length, 1);
    assert.equal(typeof res.body.total, "number");
    assert.equal(typeof res.body.hasMore, "boolean");
    assert.doesNotMatch(res.text, /data:image\//);
  });

  it("GET /api/logs/:id/image returns original bytes with safe headers", async () => {
    const res = await fetch(`${process.env.APP_URL || "http://127.0.0.1:3100"}/api/logs/${encodeURIComponent(denied.id)}/image`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("cache-control") || "", /private/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.ok(bytes.length > 20);
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
  });

  it("rejects malformed and unknown image ids", async () => {
    assert.equal((await api("/api/logs/LOG%00BAD/image")).status, 400);
    assert.equal((await api("/api/logs/LOG-DOES-NOT-EXIST/image")).status, 404);
  });

  it("production cluster listing has no demo seeds, image bytes, or embeddings", async () => {
    const res = await api<any>("/api/strangers/clusters?limit=20");
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body.success, true);
    assert.equal(res.body.demoSeedsEnabled, false);
    assert.ok(!res.body.clusters.some((cluster: any) => cluster.clusterId === "cluster-visitor-01"));
    assert.doesNotMatch(res.text, /data:image\//);
    assert.doesNotMatch(res.text, /faceEmbedding/);
    assert.equal(typeof res.body.page, "number");
    assert.equal(typeof res.body.limit, "number");
    assert.equal(typeof res.body.totalClusters, "number");
  });
});

describe("immutable DENIED history and durable idempotent resolutions", () => {
  const cleanupEmployeeIds = new Set<string>();
  let mergeTarget: Employee;

  before(async () => {
    mergeTarget = await createTempEmployee({ name: `Merge Target ${Date.now()}` });
    cleanupEmployeeIds.add(mergeTarget.id);
  });

  after(async () => {
    for (const id of cleanupEmployeeIds) await deleteEmployee(id);
  });

  it("rejects arbitrary log ids that are not members of the named cluster", async () => {
    const denied = await makeDeniedLog(92001);
    const cluster = await clusterFor(denied.id);
    assert.ok(cluster);

    const res = await postJson("/api/strangers/merge", {
      employeeId: mergeTarget.id,
      clusterId: cluster.clusterId,
      clusterLogIds: [denied.id, "LOG-INJECTED"],
    });
    assert.equal(res.status, 409, res.text.slice(0, 300));
    assert.equal(res.body.success, false);
  });

  it("merge records adjudication without rewriting DENIED status or lock facts", async () => {
    const denied = await makeDeniedLog(92002);
    const cluster = await clusterFor(denied.id);
    assert.ok(cluster);
    const payload = {
      employeeId: mergeTarget.id,
      clusterId: cluster.clusterId,
      clusterLogIds: cluster.photos.map((photo: any) => photo.logId),
      adoptPhoto: true,
      sourceLogId: denied.id,
    };

    const first = await postJson<any>("/api/strangers/merge", payload);
    assert.equal(first.status, 200, first.text.slice(0, 300));
    assert.equal(first.body.success, true);
    assert.equal(first.body.adjudicatedLogsCount, payload.clusterLogIds.length);
    assert.equal(first.body.updatedLogsCount, 0);
    assert.equal(first.body.resolution.action, "MERGE");

    const second = await postJson<any>("/api/strangers/merge", payload);
    assert.equal(second.status, 200, second.text.slice(0, 300));
    assert.equal(second.body.idempotentReplay, true);
    assert.equal(second.body.resolution.id, first.body.resolution.id);

    const logs = await api<AccessLog[]>("/api/logs");
    const stored = logs.body.find((log) => log.id === denied.id);
    assert.ok(stored);
    assert.equal(stored.status, "DENIED");
    assert.equal(stored.lockAction, denied.lockAction);
  });

  it("quick-register is idempotent and preserves the original denial", async () => {
    const denied = await makeDeniedLog(92003);
    const cluster = await clusterFor(denied.id);
    assert.ok(cluster);
    const payload = {
      name: `Quick Register ${Date.now()}`,
      employeeCode: `QR-${Date.now()}`,
      department: "Integration Test Dept",
      position: "Fixture",
      accessLevel: "ALL_ACCESS",
      clusterId: cluster.clusterId,
      clusterLogIds: cluster.photos.map((photo: any) => photo.logId),
      sourceLogId: denied.id,
    };

    const first = await postJson<any>("/api/strangers/quick-register", payload);
    assert.equal(first.status, 200, first.text.slice(0, 300));
    assert.equal(first.body.success, true);
    assert.equal(first.body.updatedLogsCount, 0);
    assert.equal(first.body.resolution.action, "QUICK_REGISTER");
    assert.equal(first.body.recognitionReady, Boolean(first.body.faceTemplate));
    cleanupEmployeeIds.add(first.body.employee.id);

    const second = await postJson<any>("/api/strangers/quick-register", payload);
    assert.equal(second.status, 200, second.text.slice(0, 300));
    assert.equal(second.body.idempotentReplay, true);
    assert.equal(second.body.employee.id, first.body.employee.id);

    const logs = await api<AccessLog[]>("/api/logs");
    const stored = logs.body.find((log) => log.id === denied.id);
    assert.ok(stored);
    assert.equal(stored.status, "DENIED");
    assert.equal(stored.lockAction, denied.lockAction);
  });
});
