/**
 * Admin "not a face" retirement of stored stranger captures:
 * POST /api/strangers/retire-non-faces { logIds, reason?, dryRun? }.
 * The DENIED access events stay; the captures leave the stranger panel through
 * one append-only DISMISS adjudication that /api/strangers/restore can undo.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, apiAs, authenticateAs, loginWithPassword, noFaceJpegDataUrl, postJson, recognize } from "./helpers";

const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || "integration-operator-token";
const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";
const PASSWORD = "Retire-NonFace-Test-2026!";
const accounts: string[] = [];

async function deniedLog(seed: number): Promise<string> {
  const res = await recognize({ imageBase64: noFaceJpegDataUrl(64, seed), scanType: "ENTRY" });
  assert.equal(res.status, 200, res.text.slice(0, 300));
  assert.equal((res.body as any).recognized, false);
  return (res.body as any).log.id as string;
}
const lookupStatus = async (logId: string) => (await api(`/api/strangers/lookup?logId=${encodeURIComponent(logId)}`)).status;

describe("retire non-face stranger captures", () => {
  after(async () => {
    const bootstrap = await authenticateAs(OPERATOR_TOKEN);
    for (const id of accounts) await apiAs(bootstrap, `/api/users/${id}`, { method: "DELETE" });
  });

  it("dry run counts without changing anything", async () => {
    const a = await deniedLog(93001);
    const res = await postJson<any>("/api/strangers/retire-non-faces", { logIds: [a, "LOG-DOES-NOT-EXIST", "bad id!"], dryRun: true });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body.dryRun, true);
    assert.equal(res.body.wouldRetire, 1);
    assert.deepEqual(res.body.skipped, { invalid: 1, notCandidate: 1, alreadyRetired: 0 });
    assert.equal(await lookupStatus(a), 200, "still in the panel");
  });

  it("retires captures, keeps the access events, and restore brings them back", async () => {
    const a = await deniedLog(93002);
    const b = await deniedLog(93003);
    const res = await postJson<any>("/api/strangers/retire-non-faces", { logIds: [a, b, a], reason: "không phải khuôn mặt" });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body.retired, 2);
    assert.equal(res.body.skipped.alreadyRetired, 1, "a duplicate id is counted once");
    assert.match(res.body.clusterId, /^NOTFACE-/);
    assert.equal(res.body.resolution.action, "DISMISS");
    assert.equal(res.body.resolution.metadata.kind, "not-a-face");
    assert.equal(await lookupStatus(a), 410);
    assert.equal(await lookupStatus(b), 410);

    // Immutable history: both DENIED events are still there.
    for (const id of [a, b]) {
      const photo = await api(`/api/logs/${encodeURIComponent(id)}/image`);
      assert.equal(photo.status, 200, `access event ${id} and its photo must survive`);
    }

    const again = await postJson<any>("/api/strangers/retire-non-faces", { logIds: [a] });
    assert.equal(again.status, 200);
    assert.equal(again.body.wouldRetire, 0);
    assert.equal(again.body.skipped.alreadyRetired, 1);

    const restored = await postJson<any>("/api/strangers/restore", { clusterId: res.body.clusterId, clusterLogIds: [a, b] });
    assert.equal(restored.status, 200, restored.text.slice(0, 300));
    assert.equal(await lookupStatus(a), 200);
  });

  it("accepts face-record ids too: unknown faces are counted, malformed ids are invalid", async () => {
    const res = await postJson<any>("/api/strangers/retire-non-faces", { faceIds: ["SF-does-not-exist", "bad id!"], dryRun: true });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body.wouldRetire, 0);
    assert.equal(res.body.wouldRetireFaces, 0);
    assert.deepEqual(res.body.skipped, { invalid: 1, notCandidate: 1, alreadyRetired: 0 });
    const big = Array.from({ length: 300 }, (_, i) => `SF-${i}`);
    assert.equal((await postJson("/api/strangers/retire-non-faces", { logIds: big, faceIds: big })).status, 400, "logIds + faceIds capped at 500 together");
  });

  it("refuses empty and oversized batches", async () => {
    assert.equal((await postJson("/api/strangers/retire-non-faces", { logIds: [] })).status, 400);
    assert.equal((await postJson("/api/strangers/retire-non-faces", {})).status, 400);
    const big = Array.from({ length: 501 }, (_, i) => `LOG-${i}`);
    assert.equal((await postJson("/api/strangers/retire-non-faces", { logIds: big })).status, 400);
  });

  it("is admin only", async () => {
    const a = await deniedLog(93004);
    const viewer = await authenticateAs(VIEWER_TOKEN);
    const v = await apiAs(viewer, "/api/strangers/retire-non-faces", { method: "POST", body: JSON.stringify({ logIds: [a] }) });
    assert.equal(v.status, 403, v.text.slice(0, 200));

    const bootstrap = await authenticateAs(OPERATOR_TOKEN);
    const username = `it-rnf-op-${Date.now().toString(36)}`;
    const created = await apiAs<any>(bootstrap, "/api/users", { method: "POST", body: JSON.stringify({ username, role: "operator", password: PASSWORD }) });
    assert.equal(created.status, 201, created.text.slice(0, 200));
    accounts.push(created.body.user.id);
    const login = await loginWithPassword(username, PASSWORD);
    const o = await apiAs(login.cookie, "/api/strangers/retire-non-faces", { method: "POST", body: JSON.stringify({ logIds: [a] }) });
    assert.equal(o.status, 403, o.text.slice(0, 200));

    const anon = await fetch(`${process.env.APP_URL || "http://127.0.0.1:3100"}/api/strangers/retire-non-faces`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ logIds: [a] }),
    });
    assert.equal(anon.status, 401);
    assert.equal(await lookupStatus(a), 200, "refused requests change nothing");
  });
});
