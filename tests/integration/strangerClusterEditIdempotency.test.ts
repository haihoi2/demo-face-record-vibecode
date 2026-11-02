/**
 * POST /api/strangers/clusters/:id/split and /remove-photos: malformed ids and
 * payloads, replay and concurrent duplicates, and the immutability of the
 * access event behind the group. The groups here come from no-face frames
 * (single-capture DENIED events), so no biometric data is created.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, noFaceJpegDataUrl, postJson, recognize } from "./helpers";

async function deniedLog(seed: number): Promise<string> {
  const res = await recognize({ imageBase64: noFaceJpegDataUrl(64, seed), scanType: "ENTRY" });
  assert.equal(res.status, 200, res.text.slice(0, 300));
  const id = (res.body as any).log?.id as string;
  assert.ok(id, "a DENIED event was written");
  return id;
}

async function clusterOf(logId: string) {
  const found = await api<any>(`/api/strangers/lookup?logId=${encodeURIComponent(logId)}`);
  assert.equal(found.status, 200, found.text.slice(0, 300));
  return found.body.cluster;
}

const editBody = (cluster: any, selected: string[]) => ({
  clusterVersion: cluster.clusterVersion,
  clusterObservationIds: cluster.photos.map((p: any) => p.observationId),
  selectedObservationIds: selected,
});

describe("stranger group editing: malformed input never reaches storage", () => {
  it("odd cluster ids and oversized or mistyped selections are 4xx, never 500", async () => {
    const logId = await deniedLog(97001);
    const cluster = await clusterOf(logId);
    const body = editBody(cluster, [`log:${logId}`]);
    for (const cid of ["../../etc/passwd", "%00", "cluster-" + "x".repeat(300), "'; DROP TABLE stranger_resolutions; --"]) {
      for (const op of ["split", "remove-photos"]) {
        const res = await postJson<any>(`/api/strangers/clusters/${encodeURIComponent(cid)}/${op}`, body);
        assert.ok(res.status >= 400 && res.status < 500, `${op} ${JSON.stringify(cid)}: ${res.status} ${res.text.slice(0, 120)}`);
      }
    }
    const url = `/api/strangers/clusters/${encodeURIComponent(cluster.clusterId)}`;
    assert.equal((await postJson(`${url}/remove-photos`, { ...body, selectedObservationIds: Array.from({ length: 501 }, (_, i) => `log:LOG-${i}`) })).status, 400, "501 picks");
    assert.equal((await postJson(`${url}/remove-photos`, { ...body, selectedObservationIds: "log:x" })).status, 400, "picks must be an array");
    assert.equal((await postJson(`${url}/remove-photos`, { ...body, clusterObservationIds: 42 })).status, 400, "membership must be an array");
    assert.equal((await postJson(`${url}/remove-photos`, { ...body, selectedObservationIds: [{ id: 1 }] })).status, 400, "picks must be strings");
    assert.equal((await postJson(`${url}/remove-photos`, { ...body, reason: { text: "x" } })).status, 400, "reason must be a string");
    assert.equal((await postJson(`${url}/remove-photos`, [])).status, 400, "array body");
    assert.equal((await postJson(`${url}/split`, body)).status, 400, "a one-photo group cannot be split");
    // Everything above was refused: the group is still on screen and the event untouched.
    assert.equal((await api(`/api/strangers/lookup?logId=${encodeURIComponent(logId)}`)).status, 200);
  });
});

describe("stranger group editing: replay, concurrency and immutable history", () => {
  it("a replayed remove-photos is 409 (stale group), the DENIED event is unchanged, undo works once", async () => {
    const logId = await deniedLog(97002);
    const cluster = await clusterOf(logId);
    const url = `/api/strangers/clusters/${encodeURIComponent(cluster.clusterId)}/remove-photos`;
    const body = { ...editBody(cluster, [`log:${logId}`]), reason: "itest replay" };
    const first = await postJson<any>(url, body);
    assert.equal(first.status, 200, first.text.slice(0, 300));
    assert.equal(first.body.resolution.action, "DISMISS");
    assert.equal(first.body.resolution.actor, "itest-operator", "the adjudication names the actor");
    const replay = await postJson<any>(url, body);
    assert.equal(replay.status, 409, `replay: ${replay.status} ${replay.text.slice(0, 200)}`);
    assert.equal((await api(`/api/strangers/lookup?logId=${encodeURIComponent(logId)}`)).status, 410);

    const logs = await api<any>("/api/logs?limit=200");
    const stored = logs.body.logs.find((l: any) => l.id === logId);
    assert.ok(stored, "the access event is still in the history");
    assert.equal(stored.status, "DENIED", "the original outcome is never rewritten");

    const undo = await postJson<any>("/api/strangers/restore", first.body.undo);
    assert.equal(undo.status, 200, undo.text.slice(0, 300));
    assert.equal((await api(`/api/strangers/lookup?logId=${encodeURIComponent(logId)}`)).status, 200);
    const undoAgain = await postJson<any>("/api/strangers/restore", first.body.undo);
    assert.ok(undoAgain.status < 500, `a second undo is not a crash: ${undoAgain.status}`);
  });

  it("three identical remove-photos fired at once yield exactly one adjudication", async () => {
    const logId = await deniedLog(97003);
    const cluster = await clusterOf(logId);
    const url = `/api/strangers/clusters/${encodeURIComponent(cluster.clusterId)}/remove-photos`;
    const body = { ...editBody(cluster, [`log:${logId}`]), reason: "itest concurrent" };
    const results = await Promise.all([postJson<any>(url, body), postJson<any>(url, body), postJson<any>(url, body)]);
    const statuses = results.map((r) => r.status).sort();
    assert.ok(statuses.every((s) => s === 200 || s === 409), `statuses ${statuses.join(",")}`);
    const winners = results.filter((r) => r.status === 200);
    assert.equal(winners.length, 1, `exactly one request wins: ${statuses.join(",")}`);
    assert.equal((await api(`/api/strangers/lookup?logId=${encodeURIComponent(logId)}`)).status, 410);
    const stored = (await api<any>("/api/logs?limit=200")).body.logs.find((l: any) => l.id === logId);
    assert.equal(stored?.status, "DENIED");
    assert.equal((await postJson<any>("/api/strangers/restore", winners[0].body.undo)).status, 200);
  });
});
