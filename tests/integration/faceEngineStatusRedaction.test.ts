/**
 * GET /api/face-engine/status after the off-thread extraction pool and the
 * best-of counters were added (#507, `faceExtract` and `bestOf`).
 *
 * A signed-in viewer may read it, so what it carries must be health numbers
 * only: no embeddings, no secrets, no credential-bearing URLs and no server
 * paths beyond the model file names.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { apiAs, authenticateAs, rawApi } from "./helpers";

const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";

/** Visits every (path, value) pair of a JSON document. */
function walk(value: unknown, path: string, visit: (path: string, value: unknown) => void): void {
  visit(path, value);
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, visit));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, visit);
  }
}

describe("face-engine status: who may read it", () => {
  it("anonymous 401, viewer 200 with the new pool and best-of sections, foreign browser origin 403", async () => {
    assert.equal((await rawApi("/api/face-engine/status")).status, 401);
    const viewer = await authenticateAs(VIEWER_TOKEN);
    const res = await apiAs<any>(viewer, "/api/face-engine/status");
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.equal(typeof res.body.faceExtract, "object");
    assert.equal(typeof res.body.bestOf, "object");
    const foreign = await apiAs(viewer, "/api/face-engine/status", { headers: { Origin: "https://evil.example" } });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body?.code, "ORIGIN_FORBIDDEN");
  });
});

describe("face-engine status: redaction", () => {
  it("carries no embedding-like vectors, no secret-looking keys and no credential-bearing URLs", async () => {
    const viewer = await authenticateAs(VIEWER_TOKEN);
    const res = await apiAs<any>(viewer, "/api/face-engine/status");
    assert.equal(res.status, 200);
    const offenders: string[] = [];
    walk(res.body, "", (path, v) => {
      if (Array.isArray(v) && v.length >= 32 && v.every((x) => typeof x === "number")) offenders.push(`${path}: numeric vector[${v.length}]`);
      const key = path.split(".").pop() || "";
      if (/token|password|secret|apikey|embedding(?!Dim$)|rtspUrl|databaseUrl/i.test(key)) offenders.push(`${path}: secret-looking key`);
      if (typeof v === "string" && /rtsp:\/\/|https?:\/\/[^/\s]*@|postgres(?:ql)?:\/\//i.test(v)) offenders.push(`${path}: credential-bearing URL`);
    });
    assert.deepEqual(offenders, []);
  });

  it("faceExtract and bestOf are counters, flags and a model tag - never a file-system path", async () => {
    const viewer = await authenticateAs(VIEWER_TOKEN);
    const { body } = await apiAs<any>(viewer, "/api/face-engine/status");
    const fe = body.faceExtract;
    for (const k of ["enabled", "ready"]) assert.equal(typeof fe[k], "boolean", k);
    for (const k of ["workers", "readyWorkers", "busy", "queued", "queueMax", "taskTimeoutMs", "ortThreadsPerWorker", "completed", "failed", "restarts", "avgWorkerMs", "avgTotalMs"]) {
      assert.equal(typeof fe[k], "number", `faceExtract.${k}`);
      assert.ok(fe[k] >= 0, `faceExtract.${k} >= 0`);
    }
    assert.ok(fe.modelTag === null || /^[A-Za-z0-9_-]+$/.test(fe.modelTag), "modelTag is an identifier");
    assert.ok(fe.lastError === null || typeof fe.lastError === "string");
    assert.equal(typeof fe.failedByCode, "object");
    for (const [code, n] of Object.entries(fe.failedByCode)) {
      assert.match(code, /^[a-z-]+$/, "failedByCode keys are error codes");
      assert.equal(typeof n, "number");
    }
    walk(fe, "faceExtract", (path, v) => {
      if (typeof v === "string") assert.doesNotMatch(v, /[\\/]/, `${path} must not carry a path: ${v}`);
    });
    for (const [k, v] of Object.entries(body.bestOf)) assert.equal(typeof v, "number", `bestOf.${k}`);
    assert.ok(body.bestOf.extraFrames >= 0 && body.bestOf.extraFrames <= 10);
    // Model identity: bare file names, no directory component.
    assert.match(String(body.info.detectorModel), /^[A-Za-z0-9._-]+\.onnx$/);
    assert.match(String(body.info.recognizerModel), /^[A-Za-z0-9._-]+\.onnx$/);
    assert.ok(body.info.lastError === null || !/[\\/]/.test(String(body.info.lastError)), "lastError must not reveal a path");
  });

  it(
    "info.modelDir reveals the server's model directory to viewers (finding S-04, low)",
    async () => {
      const viewer = await authenticateAs(VIEWER_TOKEN);
      const { body } = await apiAs<any>(viewer, "/api/face-engine/status");
      assert.doesNotMatch(String(body.info.modelDir ?? ""), /[\\/]/, "modelDir is a file-system path");
    },
  );
});
