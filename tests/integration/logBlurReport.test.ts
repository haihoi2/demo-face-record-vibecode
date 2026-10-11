/** Quick blur report from the live activity list (2026-10-11). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, apiAs, authenticateAs, noFaceJpegDataUrl, postJson, rawApi, recognize } from "./helpers";

const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";

describe("quick blur report on an access event", () => {
  it("operator only; an event without stranger face records is refused; state lists nothing", async () => {
    assert.equal((await rawApi("/api/logs/blur-state?ids=LOG-1")).status, 401);
    const viewer = await authenticateAs(VIEWER_TOKEN);
    assert.equal((await apiAs(viewer, "/api/logs/blur-state?ids=LOG-1")).status, 403);
    const res = await recognize({ imageBase64: noFaceJpegDataUrl(64, 96001), scanType: "ENTRY" });
    const logId = (res.body as any).log.id as string;
    const report = await postJson<any>(`/api/logs/${encodeURIComponent(logId)}/blur-report`, {});
    assert.equal(report.status, 400);
    assert.equal(report.body.code, "NO_FACE_RECORDS");
    assert.equal((await postJson("/api/logs/bad%20id/blur-report", {})).status, 400);
    const state = await api<any>(`/api/logs/blur-state?ids=${encodeURIComponent(logId)}`);
    assert.equal(state.status, 200);
    assert.deepEqual(state.body.reported, []);
    assert.deepEqual(state.body.withFaces, []);
  });
});
