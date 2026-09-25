/**
 * Stranger/list API regressions against an isolated disposable gateway.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  api,
  authenticateAs,
  csrfTokenForCookie,
  createTempEmployee,
  deleteEmployee,
  noFaceJpegDataUrl,
  postJson,
  rawApi,
  recognize,
  type Employee,
  ensureFixtureCatalog,
} from "./helpers";

interface AccessLog {
  id: string;
  status: "GRANTED" | "DENIED";
  lockAction: string;
  photoSnapshot: string;
  imageUrl?: string;
  hasImage?: boolean;
  faceEmbedding?: number[];
  reason?: string;
}

async function makeDeniedLog(seed: number): Promise<AccessLog> {
  const res = await recognize({ imageBase64: noFaceJpegDataUrl(64, seed), scanType: "ENTRY" });
  assert.equal(res.status, 200, res.text.slice(0, 300));
  const body = res.body as any;
  assert.equal(body.recognized, false);
  assert.ok(body.log?.id);
  assert.doesNotMatch(res.text, /data:image\//);
  assert.doesNotMatch(res.text, /faceEmbedding/);
  assert.match(body.log.photoSnapshot, /^\/api\/logs\//);
  return body.log as AccessLog;
}

async function clusterFor(logId: string) {
  const res = await api<any>("/api/strangers/clusters?limit=20");
  assert.equal(res.status, 200, res.text.slice(0, 300));
  return res.body.clusters.find((cluster: any) =>
    cluster.photos.some((photo: any) => photo.logId === logId),
  );
}


// Quick-register uses the fixture department/position, which must exist in the catalog.
before(() => ensureFixtureCatalog());

describe("operator authorization", () => {
  it("rejects unauthenticated stranger, access-log, and image reads", async () => {
    assert.equal((await rawApi("/api/strangers/clusters")).status, 401);
    assert.equal((await rawApi("/api/logs")).status, 401);
    assert.equal((await rawApi("/api/logs/LOG-DOES-NOT-EXIST/image")).status, 401);
  });

  it("allows viewer reads but forbids viewer mutations", async () => {
    const viewerCookie = await authenticateAs(process.env.VIEWER_TOKEN || "integration-viewer-token");
    const listing = await rawApi("/api/strangers/clusters", { headers: { Cookie: viewerCookie } });
    assert.equal(listing.status, 200, listing.text.slice(0, 200));
    const mutation = await rawApi("/api/strangers/dismiss", {
      method: "POST",
      headers: { Cookie: viewerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ clusterId: "cluster-any", clusterLogIds: ["LOG-any"] }),
    });
    assert.equal(mutation.status, 403, mutation.text.slice(0, 200));
  });

  it("protects every SSE alias with viewer authentication", async () => {
    for (const path of ["/api/events", "/api/events/", "/events", "/events/"]) {
      const res = await rawApi(path);
      assert.equal(res.status, 401, `${path}: ${res.text.slice(0, 200)}`);
    }
  });

  it("redacts biometric bytes and embeddings from authenticated SSE access events", async () => {
    const cookie = await authenticateAs(process.env.VIEWER_TOKEN || "integration-viewer-token");
    const controller = new AbortController();
    const stream = await fetch(`${process.env.APP_URL || "http://127.0.0.1:3100"}/api/events`, {
      headers: { Cookie: cookie },
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") || "", /text\/event-stream/);
    const reader = stream.body!.getReader();
    const deniedPromise = makeDeniedLog(91000);
    const decoder = new TextDecoder();
    let text = "";
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !text.includes("event: access_denied")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      controller.abort();
      await deniedPromise;
    }
    const event = text.split("\n\n").find((part) => part.includes("event: access_denied")) || "";
    assert.ok(event, text.slice(0, 1000));
    assert.doesNotMatch(event, /data:image\//);
    assert.doesNotMatch(event, /faceEmbedding/);
    const dataLine = event.split("\n").find((line) => line.startsWith("data: "))!;
    const payload = JSON.parse(dataLine.slice(6));
    assert.match(payload.log.photoSnapshot, /^https?:\/\//);
    assert.equal(payload.log.imageUrl, payload.log.photoSnapshot);
  });

  it("enforces session-bound CSRF, JSON content, and mutation origins", async () => {
    const cookie = await authenticateAs(process.env.OPERATOR_TOKEN || "integration-operator-token");
    const csrf = csrfTokenForCookie(cookie);
    const body = JSON.stringify({ clusterId: "cluster-any", clusterLogIds: ["LOG-any"] });
    assert.equal((await rawApi("/api/strangers/dismiss", {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body,
    })).status, 403);
    assert.equal((await rawApi("/api/strangers/dismiss", {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": "invalid" }, body,
    })).status, 403);
    assert.equal((await rawApi("/api/strangers/dismiss", {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", "X-CSRF-Token": csrf }, body: "clusterId=x",
    })).status, 415);
    assert.equal((await rawApi("/api/strangers/dismiss", {
      method: "POST", headers: { Cookie: cookie, Origin: "http://evil.test", "Content-Type": "application/json", "X-CSRF-Token": csrf }, body,
    })).status, 403);
    const valid = await rawApi("/api/strangers/dismiss", {
      method: "POST", headers: { Cookie: cookie, Origin: "http://allowed.test", "Content-Type": "application/json", "X-CSRF-Token": csrf }, body,
    });
    assert.equal(valid.status, 409, valid.text.slice(0, 200));
  });
});

describe("bounded image-free list APIs", () => {
  let denied: AccessLog;

  before(async () => {
    denied = await makeDeniedLog(91001);
  });

  it("GET /api/logs returns a bounded versioned metadata page without image data or embeddings", async () => {
    const res = await api<{ version: number; logs: AccessLog[]; total: number; limit: number }>("/api/logs");
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body.version, 1);
    assert.ok(Array.isArray(res.body.logs));
    assert.ok(res.body.logs.length <= res.body.limit);
    assert.equal(res.body.total, Number(res.headers.get("x-total-count")));
    assert.doesNotMatch(res.text, /data:image\//);
    assert.doesNotMatch(res.text, /faceEmbedding/);
    for (const log of res.body.logs) {
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
    const cookie = await authenticateAs(process.env.OPERATOR_TOKEN || "integration-operator-token");
    const res = await fetch(
      `${process.env.APP_URL || "http://127.0.0.1:3100"}/api/logs/${encodeURIComponent(denied.id)}/image`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("cache-control") || "", /private/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.ok(bytes.length > 20);
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
  });

  it("blocks hostile cross-site image embedding but permits configured split-origin fetches", async () => {
    const cookie = await authenticateAs(process.env.OPERATOR_TOKEN || "integration-operator-token");
    const url = `${process.env.APP_URL || "http://127.0.0.1:3100"}/api/logs/${encodeURIComponent(denied.id)}/image`;
    const hostile = await fetch(url, { headers: {
      Cookie: cookie, Origin: "http://evil.test", Referer: "http://evil.test/page", "Sec-Fetch-Site": "cross-site",
    } });
    assert.equal(hostile.status, 403);
    const trusted = await fetch(url, { headers: {
      Cookie: cookie, Origin: "http://allowed.test", Referer: "http://allowed.test/page", "Sec-Fetch-Site": "cross-site",
    } });
    assert.equal(trusted.status, 200);
    assert.equal(trusted.headers.get("cross-origin-resource-policy"), "cross-origin");
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

describe("persisted stranger cluster cursors and versions", () => {
  it("paginates authoritative candidates with a bounded cursor and reaches later observations", async () => {
    const older = await makeDeniedLog(91989);
    await makeDeniedLog(91990);
    const first = await api<any>("/api/strangers/clusters?limit=1");
    assert.equal(first.status, 200, first.text);
    assert.ok(first.body.clusters.length <= 1, "a page never exceeds its limit");
    // Grouping runs over a bounded window of recent captures, independent of
    // the page size, and the page walks the finished groups.
    assert.ok(first.body.workBound >= 50, "the grouping window is not the page size");
    assert.ok(first.body.totalClusters >= 2, "totals describe the whole window");
    assert.equal(typeof first.body.totalUnregisteredLogs, "number");
    assert.equal(typeof first.body.nextCursor, "string");
    const second = await api<any>(`/api/strangers/clusters?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    assert.equal(second.status, 200, second.text);
    assert.ok(second.body.clusters.length <= 1);
    assert.notEqual(second.body.clusters[0]?.clusterId, first.body.clusters[0]?.clusterId, "the next page continues, it does not repeat");
    const lookup = await api<any>(`/api/strangers/lookup?logId=${encodeURIComponent(older.id)}`);
    assert.equal(lookup.status, 200, lookup.text);
    assert.ok(lookup.body.cluster.observationCount >= 1);
  });

  it("looks up a log beyond list pagination and resolves by server-owned versioned membership", async () => {
    const denied = await makeDeniedLog(91991);
    const lookup = await api<any>(`/api/strangers/lookup?logId=${encodeURIComponent(denied.id)}`);
    assert.equal(lookup.status, 200, lookup.text.slice(0, 300));
    assert.equal(lookup.body.cluster.status, "OPEN");
    assert.equal(typeof lookup.body.cluster.clusterVersion, "number");

    const detail = await api<any>(`/api/strangers/clusters/${encodeURIComponent(lookup.body.cluster.clusterId)}?limit=1`);
    assert.equal(detail.status, 200, detail.text.slice(0, 300));
    assert.equal(detail.body.cluster.clusterVersion, lookup.body.cluster.clusterVersion);
    assert.ok(detail.body.observations.some((item: any) => item.logId === denied.id));

    const dismissed = await postJson<any>("/api/strangers/dismiss", {
      clusterId: lookup.body.cluster.clusterId,
      clusterVersion: lookup.body.cluster.clusterVersion,
      reason: "versioned persisted cluster test",
    });
    assert.equal(dismissed.status, 200, dismissed.text.slice(0, 300));

    const stale = await postJson("/api/strangers/dismiss", {
      clusterId: lookup.body.cluster.clusterId,
      clusterVersion: lookup.body.cluster.clusterVersion,
      reason: "stale replay with different intent",
    });
    assert.equal(stale.status, 409, stale.text.slice(0, 300));
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

    const forgedReplay = await postJson("/api/strangers/merge", { ...payload, adoptPhoto: false });
    assert.equal(forgedReplay.status, 409, forgedReplay.text.slice(0, 300));

    const logs = await api<{ logs: AccessLog[] }>("/api/logs?limit=100");
    const stored = logs.body.logs.find((log) => log.id === denied.id);
    assert.ok(stored);
    assert.equal(stored.status, "DENIED");
    assert.equal(stored.lockAction, denied.lockAction);
  });

  it("allows only one conflicting concurrent resolution", async () => {
    const denied = await makeDeniedLog(92006);
    const cluster = await clusterFor(denied.id);
    assert.ok(cluster);
    const logIds = cluster.photos.map((photo: any) => photo.logId);

    const [merge, dismiss] = await Promise.all([
      postJson("/api/strangers/merge", { employeeId: mergeTarget.id, clusterId: cluster.clusterId, clusterLogIds: logIds }),
      postJson("/api/strangers/dismiss", { clusterId: cluster.clusterId, clusterLogIds: logIds, reason: "race" }),
    ]);
    assert.deepEqual([merge.status, dismiss.status].sort(), [200, 409]);
  });

  it("dismiss records immutable adjudication and rejects forged membership", async () => {
    const denied = await makeDeniedLog(92004);
    const cluster = await clusterFor(denied.id);
    assert.ok(cluster);

    const forged = await postJson("/api/strangers/dismiss", {
      clusterId: cluster.clusterId,
      clusterLogIds: [...cluster.photos.map((photo: any) => photo.logId), "LOG-FORGED"],
      reason: "test",
    });
    assert.equal(forged.status, 409, forged.text.slice(0, 300));

    const dismissed = await postJson<any>("/api/strangers/dismiss", {
      clusterId: cluster.clusterId,
      clusterLogIds: cluster.photos.map((photo: any) => photo.logId),
      reason: "test",
    });
    assert.equal(dismissed.status, 200, dismissed.text.slice(0, 300));
    assert.equal(dismissed.body.resolution.action, "DISMISS");
    assert.equal(dismissed.body.resolution.actor, "itest-operator");

    const forgedReplay = await postJson("/api/strangers/dismiss", {
      clusterId: cluster.clusterId,
      clusterLogIds: cluster.photos.map((photo: any) => photo.logId),
      reason: "different replay intent",
    });
    assert.equal(forgedReplay.status, 409, forgedReplay.text.slice(0, 300));

    const logs = await api<{ logs: AccessLog[] }>("/api/logs?limit=100");
    const stored = logs.body.logs.find((log) => log.id === denied.id);
    assert.ok(stored);
    assert.equal((stored as AccessLog).status, "DENIED");
    assert.equal((stored as AccessLog).reason, (denied as any).reason);
  });

  it("restore appends an immutable adjudication event and validates stored membership", async () => {
    const denied = await makeDeniedLog(92007);
    const cluster = await clusterFor(denied.id);
    assert.ok(cluster);
    const logIds = cluster.photos.map((photo: any) => photo.logId);

    const dismissed = await postJson("/api/strangers/dismiss", {
      clusterId: cluster.clusterId,
      clusterLogIds: logIds,
      reason: "restore audit",
    });
    assert.equal(dismissed.status, 200, dismissed.text.slice(0, 300));

    const forged = await postJson("/api/strangers/restore", {
      clusterId: cluster.clusterId,
      clusterLogIds: [...logIds, "LOG-FORGED"],
    });
    assert.equal(forged.status, 409, forged.text.slice(0, 300));

    const restored = await postJson("/api/strangers/restore", {
      clusterId: cluster.clusterId,
      clusterLogIds: logIds,
    });
    assert.equal(restored.status, 200, restored.text.slice(0, 300));
    assert.equal(restored.body.resolution.action, "RESTORE");
    assert.equal(restored.body.resolution.actor, "itest-operator");

    const audit = await api<any>(`/api/strangers/resolutions/${encodeURIComponent(cluster.clusterId)}`);
    assert.equal(audit.status, 200, audit.text.slice(0, 300));
    assert.deepEqual(audit.body.resolutions.map((item: any) => item.action), ["DISMISS", "RESTORE"]);
    assert.equal(audit.body.resolutions[0].actor, "itest-operator");
    assert.equal(audit.body.resolutions[1].actor, "itest-operator");

    const logs = await api<{ logs: AccessLog[] }>("/api/logs?limit=100");
    const stored = logs.body.logs.find((log) => log.id === denied.id);
    assert.ok(stored);
    assert.equal(stored!.status, "DENIED");
    assert.equal(stored!.reason, denied.reason);
  });

  it("rejects duplicate employee codes and invalid access levels before quick-register mutation", async () => {
    const denied = await makeDeniedLog(92005);
    const cluster = await clusterFor(denied.id);
    assert.ok(cluster);

    const duplicate = await postJson("/api/strangers/quick-register", {
      name: "Duplicate Code",
      employeeCode: mergeTarget.employeeCode.toLowerCase(),
      department: "Integration Test Dept",
      position: "Fixture",
      accessLevel: "ALL_ACCESS",
      clusterId: cluster.clusterId,
      clusterLogIds: cluster.photos.map((photo: any) => photo.logId),
    });
    assert.equal(duplicate.status, 409, duplicate.text.slice(0, 300));

    const invalid = await postJson("/api/strangers/quick-register", {
      name: "Invalid Access",
      employeeCode: `BAD-${Date.now()}`,
      department: "Integration Test Dept",
      position: "Fixture",
      accessLevel: "SUPER_ADMIN",
      clusterId: cluster.clusterId,
      clusterLogIds: cluster.photos.map((photo: any) => photo.logId),
    });
    assert.equal(invalid.status, 400, invalid.text.slice(0, 300));

    const invalidType = await postJson("/api/strangers/quick-register", {
      name: { not: "a string" },
      employeeCode: `TYPE-${Date.now()}`,
      department: "Integration Test Dept",
      position: "Fixture",
      clusterId: cluster.clusterId,
      clusterLogIds: cluster.photos.map((photo: any) => photo.logId),
    });
    assert.equal(invalidType.status, 400, invalidType.text.slice(0, 300));
    assert.ok(await clusterFor(denied.id), "rejected validation must not resolve the cluster");
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

    const forgedReplay = await postJson("/api/strangers/quick-register", { ...payload, name: `${payload.name} forged` });
    assert.equal(forgedReplay.status, 409, forgedReplay.text.slice(0, 300));

    const logs = await api<{ logs: AccessLog[] }>("/api/logs?limit=100");
    const stored = logs.body.logs.find((log) => log.id === denied.id);
    assert.ok(stored);
    assert.equal(stored.status, "DENIED");
    assert.equal(stored.lockAction, denied.lockAction);
  });
});
