/**
 * History-preserving employee merge (owner 2026-09-30: fix duplicate records).
 * POST /api/employees/merge moves the source's face templates to the target,
 * removes the source, keeps access history untouched and appends an audit
 * record listed by GET /api/employees/merges (admin).
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, apiAs, authenticateAs, createTempEmployee, deleteEmployee, listEmployees, postJson, rawApi } from "./helpers";

const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";
const cleanup = new Set<string>();

describe("employee merge", () => {
  after(async () => {
    for (const id of cleanup) await deleteEmployee(id).catch(() => {});
  });

  it("removes the duplicate, keeps the target, records who merged what, and rewrites no history", async () => {
    const target = await createTempEmployee({ name: `Merge Keep ${Date.now()}` });
    const source = await createTempEmployee({ name: `Merge Dup ${Date.now()}` });
    cleanup.add(target.id);
    cleanup.add(source.id);

    const res = await postJson<any>("/api/employees/merge", { sourceId: source.id, targetId: target.id });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body.success, true);
    assert.equal(res.body.reattributedLogs, 0, "access history is never rewritten");
    assert.equal(res.body.merge.sourceId, source.id);
    assert.equal(res.body.merge.targetId, target.id);
    assert.equal(res.body.merge.sourceSnapshot.name, source.name);
    assert.ok(res.body.merge.actor, "the merge is attributed");
    assert.doesNotMatch(res.text, /faceEmbedding|embedding"/);

    const roster = await listEmployees();
    assert.ok(roster.some((e) => e.id === target.id), "target kept");
    assert.ok(!roster.some((e) => e.id === source.id), "duplicate removed");
    cleanup.delete(source.id);

    const merges = await api<any>("/api/employees/merges");
    assert.equal(merges.status, 200, merges.text.slice(0, 200));
    assert.ok(merges.body.merges.some((m: any) => m.id === res.body.merge.id && m.sourceId === source.id));
  });

  it("validates the request and refuses unknown or identical records", async () => {
    assert.equal((await postJson("/api/employees/merge", {})).status, 400);
    assert.equal((await postJson("/api/employees/merge", { sourceId: "EMP-x", targetId: "EMP-x" })).status, 400);
    assert.equal((await postJson("/api/employees/merge", { sourceId: "EMP-none-1", targetId: "EMP-none-2" })).status, 404);
  });

  it("is admin only, reads included", async () => {
    assert.equal((await rawApi("/api/employees/merges")).status, 401);
    const viewer = await authenticateAs(VIEWER_TOKEN);
    assert.equal((await apiAs(viewer, "/api/employees/merges")).status, 403);
    assert.equal((await apiAs(viewer, "/api/employees/merge", { method: "POST", body: JSON.stringify({ sourceId: "a", targetId: "b" }) })).status, 403);
  });
});
