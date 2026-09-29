/**
 * Per-face stranger records (plan 2026-09-29): API boundaries that do not need
 * real face photos. Two-person frames end to end are covered by the dev demo on
 * the replay harness (no biometric fixtures are committed).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, authenticateAs, apiAs, noFaceJpegDataUrl, postJson, rawApi, recognize } from "./helpers";

const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";

async function deniedLog(seed: number): Promise<string> {
  const res = await recognize({ imageBase64: noFaceJpegDataUrl(64, seed), scanType: "ENTRY" });
  assert.equal(res.status, 200, res.text.slice(0, 300));
  return (res.body as any).log.id as string;
}

describe("stranger face crops", () => {
  it("need a session, reject malformed ids, and 404 unknown faces", async () => {
    assert.equal((await rawApi("/api/strangers/faces/SF-unknown/image")).status, 401);
    const viewer = await authenticateAs(VIEWER_TOKEN);
    assert.equal((await apiAs(viewer, "/api/strangers/faces/SF-unknown/image")).status, 404);
    assert.equal((await apiAs(viewer, "/api/strangers/faces/..%2Fetc/image")).status, 400);
  });

  it("refuse a cross-site request like the frame photo does", async () => {
    const viewer = await authenticateAs(VIEWER_TOKEN);
    const res = await apiAs(viewer, "/api/strangers/faces/SF-unknown/image", { headers: { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" } });
    assert.equal(res.status, 403);
  });

  it("lookup by face id validates and 404s unknown faces", async () => {
    assert.equal((await api("/api/strangers/lookup?faceId=bad%20id")).status, 400);
    assert.equal((await api("/api/strangers/lookup?faceId=SF-does-not-exist")).status, 404);
  });
});

describe("resolve requests with observation ids", () => {
  it("dismiss and restore a whole-frame capture by clusterObservationIds", async () => {
    const logId = await deniedLog(94001);
    const lookup = await api<any>(`/api/strangers/lookup?logId=${encodeURIComponent(logId)}`);
    assert.equal(lookup.status, 200, lookup.text.slice(0, 300));
    const cluster = lookup.body.cluster;
    const ids = cluster.photos.map((p: any) => p.observationId);
    assert.ok(ids.includes(`log:${logId}`), "tiles carry their observation id");

    const dismissed = await postJson<any>("/api/strangers/dismiss", {
      clusterId: cluster.clusterId, clusterVersion: cluster.clusterVersion, clusterObservationIds: ids, reason: "per-face api test",
    });
    assert.equal(dismissed.status, 200, dismissed.text.slice(0, 300));
    assert.equal((await api(`/api/strangers/lookup?logId=${encodeURIComponent(logId)}`)).status, 410);

    const restored = await postJson<any>("/api/strangers/restore", { clusterId: cluster.clusterId, clusterObservationIds: ids });
    assert.equal(restored.status, 200, restored.text.slice(0, 300));
    assert.equal((await api(`/api/strangers/lookup?logId=${encodeURIComponent(logId)}`)).status, 200);
  });

  it("malformed observation ids are a 400, and a non-member source is refused", async () => {
    const logId = await deniedLog(94002);
    const { body } = await api<any>(`/api/strangers/lookup?logId=${encodeURIComponent(logId)}`);
    const cluster = body.cluster;
    const bad = await postJson("/api/strangers/dismiss", { clusterId: cluster.clusterId, clusterObservationIds: [logId] });
    assert.equal(bad.status, 400);
    const merge = await postJson("/api/strangers/merge", {
      employeeId: "EMP-none", clusterId: cluster.clusterId, clusterObservationIds: [`log:${logId}`], sourceObservationId: "face:SF-other",
    });
    assert.ok(merge.status === 400 || merge.status === 404, `got ${merge.status}`);
  });

  it("older clients sending clusterLogIds still work for whole-frame captures", async () => {
    const logId = await deniedLog(94003);
    const { body } = await api<any>(`/api/strangers/lookup?logId=${encodeURIComponent(logId)}`);
    const res = await postJson("/api/strangers/dismiss", {
      clusterId: body.cluster.clusterId, clusterVersion: body.cluster.clusterVersion, clusterLogIds: [logId], reason: "legacy client",
    });
    assert.equal(res.status, 200, res.text.slice(0, 300));
  });
});
