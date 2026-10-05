/**
 * Stranger group editing (2026-10-05): split photos into their own group, take
 * photos out of a group, and undo both through /api/strangers/restore.
 *
 * The first part needs no real faces (single-capture groups from no-face
 * frames). The second part needs a group of several photos: with
 * PERSISTENCE_PG_URL (the throwaway PostgreSQL the gateway runs on) it inserts
 * SYNTHETIC stranger faces - made-up vectors and bytes, never biometric data -
 * on top of real DENIED events. It refuses the live database.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";

import { api, apiAs, authenticateAs, noFaceJpegDataUrl, postJson, rawApi, recognize } from "./helpers";

const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";
const PG_URL = String(process.env.PERSISTENCE_PG_URL || "").trim();

async function deniedLog(seed: number): Promise<string> {
  const res = await recognize({ imageBase64: noFaceJpegDataUrl(64, seed), scanType: "ENTRY" });
  assert.equal(res.status, 200, res.text.slice(0, 300));
  return (res.body as any).log.id as string;
}

async function lookup(query: string) {
  return api<any>(`/api/strangers/lookup?${query}`);
}

const editBody = (cluster: any, selected: string[]) => ({
  clusterVersion: cluster.clusterVersion,
  clusterObservationIds: cluster.photos.map((p: any) => p.observationId),
  selectedObservationIds: selected,
});

describe("stranger group editing: boundaries", () => {
  it("needs a session and the operator role", async () => {
    const path = "/api/strangers/clusters/cluster-x/split";
    assert.equal((await rawApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
    const viewer = await authenticateAs(VIEWER_TOKEN);
    for (const p of [path, "/api/strangers/clusters/cluster-x/remove-photos"]) {
      const res = await apiAs(viewer, p, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(res.status, 403, p);
    }
  });

  it("validates the picked photos against the group on screen", async () => {
    const logId = await deniedLog(95001);
    const found = await lookup(`logId=${encodeURIComponent(logId)}`);
    assert.equal(found.status, 200, found.text.slice(0, 300));
    const cluster = found.body.cluster;
    const url = `/api/strangers/clusters/${encodeURIComponent(cluster.clusterId)}`;

    assert.equal((await postJson(`${url}/split`, editBody(cluster, ["nope"]))).status, 400, "malformed id");
    assert.equal((await postJson(`${url}/split`, editBody(cluster, []))).status, 400, "nothing picked");
    assert.equal((await postJson(`${url}/remove-photos`, { ...editBody(cluster, [`log:${logId}`]), reason: 7 })).status, 400, "reason type");
    assert.equal((await postJson(`${url}/split`, editBody(cluster, ["log:LOG-not-a-member"]))).status, 409, "not a member");
    assert.equal((await postJson(`${url}/split`, { ...editBody(cluster, [`log:${logId}`]), clusterVersion: 1 })).status, 409, "stale version");
    assert.equal((await postJson("/api/strangers/clusters/cluster-unknown/split", editBody(cluster, [`log:${logId}`]))).status, 409, "unknown group");
    const all = await postJson<any>(`${url}/split`, editBody(cluster, [`log:${logId}`]));
    assert.equal(all.status, 400, "a split must leave a photo behind");
  });

  it("removing photos hides them (history kept) and the undo brings them back", async () => {
    const logId = await deniedLog(95002);
    const cluster = (await lookup(`logId=${encodeURIComponent(logId)}`)).body.cluster;
    const removed = await postJson<any>(`/api/strangers/clusters/${encodeURIComponent(cluster.clusterId)}/remove-photos`, {
      ...editBody(cluster, [`log:${logId}`]), reason: "integration test",
    });
    assert.equal(removed.status, 200, removed.text.slice(0, 300));
    assert.equal(removed.body.resolution.action, "DISMISS");
    assert.equal(removed.body.resolution.metadata.kind, "removed-from-group");
    assert.match(removed.body.undo.clusterId, /^REMOVED-/);
    assert.equal((await lookup(`logId=${encodeURIComponent(logId)}`)).status, 410);

    const logs = await api<any>("/api/logs?limit=100");
    const stored = logs.body.logs.find((l: any) => l.id === logId);
    assert.equal(stored?.status, "DENIED", "the access event is unchanged");

    const undone = await postJson<any>("/api/strangers/restore", removed.body.undo);
    assert.equal(undone.status, 200, undone.text.slice(0, 300));
    assert.equal((await lookup(`logId=${encodeURIComponent(logId)}`)).status, 200);
  });
});

describe("stranger group editing: a group of several photos (synthetic faces, throwaway PostgreSQL)", () => {
  const skip = !PG_URL ? "PERSISTENCE_PG_URL not set (throwaway PostgreSQL only)" : false;

  it("split, re-join, remove and undo", { skip }, async () => {
    const u = new URL(PG_URL);
    if (/smartface_db/i.test(u.pathname) || /smartface-postgres-18/i.test(u.hostname)) throw new Error("Refusing to seed the live database");
    const tag = randomBytes(3).toString("hex");
    const ids = [1, 2, 3].map((i) => `SF-CE-${tag}-${i}`);
    const logIds = [await deniedLog(95101), await deniedLog(95102), await deniedLog(95103)];
    // Synthetic vectors: one "person" with tiny differences (cosine ~1), never a real face.
    const vec = (i: number) => {
      const v = [1, 0.2, 0.1, 0.05, 0, 0, 0, 0.01 * i];
      const n = Math.hypot(...v);
      return Buffer.from(new Float32Array(v.map((x) => x / n)).buffer);
    };
    const client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
    try {
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        await client.query(
          `INSERT INTO stranger_faces (id,"logId","faceIndex","capturedAt",gate,engine,box,"detectorScore",quality,"sizePx",embedding,dims,"modelTag",crop,"createdAt")
           VALUES ($1,$2,0,$3,'ENTRY','legacy','[0,0,100,100]'::jsonb,0.9,0.6,120,$4,8,'itest_synthetic',$5,$3)`,
          [ids[i], logIds[i], new Date(now + i * 1000).toISOString(), vec(i), Buffer.from([0xff, 0xd8, i, 0xff, 0xd9])],
        );
      }
    } finally {
      await client.end();
    }

    const groupOf = async (faceId: string) => {
      const res = await lookup(`faceId=${encodeURIComponent(faceId)}`);
      assert.equal(res.status, 200, res.text.slice(0, 300));
      return res.body.cluster;
    };
    const faceIdsOf = (cluster: any) => cluster.photos.map((p: any) => p.faceId).filter(Boolean).sort();

    const whole = await groupOf(ids[0]);
    assert.deepEqual(faceIdsOf(whole), ids, "the three synthetic faces group together");

    // Split face 3 off.
    const split = await postJson<any>(`/api/strangers/clusters/${encodeURIComponent(whole.clusterId)}/split`, editBody(whole, [`face:${ids[2]}`]));
    assert.equal(split.status, 200, split.text.slice(0, 300));
    assert.equal(split.body.resolution.action, "SPLIT");
    assert.match(split.body.undo.clusterId, /^SPLIT-/);
    const alone = await groupOf(ids[2]);
    assert.deepEqual(faceIdsOf(alone), [ids[2]]);
    assert.deepEqual(alone.split, { clusterId: split.body.undo.clusterId, observationIds: [`face:${ids[2]}`] });
    const rest = await groupOf(ids[0]);
    assert.deepEqual(faceIdsOf(rest), [ids[0], ids[1]]);
    assert.equal(rest.split, undefined);
    // The old group is gone: acting on it again is refused.
    const stale = await postJson(`/api/strangers/clusters/${encodeURIComponent(whole.clusterId)}/remove-photos`, editBody(whole, [`face:${ids[0]}`]));
    assert.equal(stale.status, 409);

    // Re-join ("Gộp lại") with the membership the group carries.
    const rejoin = await postJson<any>("/api/strangers/restore", { clusterId: alone.split.clusterId, clusterObservationIds: alone.split.observationIds });
    assert.equal(rejoin.status, 200, rejoin.text.slice(0, 300));
    const again = await groupOf(ids[0]);
    assert.deepEqual(faceIdsOf(again), ids);

    // Take face 2 out, then undo.
    const removed = await postJson<any>(`/api/strangers/clusters/${encodeURIComponent(again.clusterId)}/remove-photos`, editBody(again, [`face:${ids[1]}`]));
    assert.equal(removed.status, 200, removed.text.slice(0, 300));
    assert.equal((await lookup(`faceId=${encodeURIComponent(ids[1])}`)).status, 410);
    assert.deepEqual(faceIdsOf(await groupOf(ids[0])), [ids[0], ids[2]]);
    const undo = await postJson<any>("/api/strangers/restore", removed.body.undo);
    assert.equal(undo.status, 200, undo.text.slice(0, 300));
    const restored = await groupOf(ids[0]);
    assert.deepEqual(faceIdsOf(restored), ids);

    // A merge/register-style action is not something restore undoes.
    const history = await api<any>(`/api/strangers/resolutions/${encodeURIComponent(split.body.undo.clusterId)}`);
    assert.deepEqual(history.body.resolutions.map((r: any) => r.action), ["SPLIT", "RESTORE"]);

    // Leave the panel as it was: hide the synthetic group.
    const hide = await postJson("/api/strangers/dismiss", {
      clusterId: restored.clusterId, clusterVersion: restored.clusterVersion,
      clusterObservationIds: restored.photos.map((p: any) => p.observationId), reason: "integration cleanup",
    });
    assert.equal(hide.status, 200);
  });
});
