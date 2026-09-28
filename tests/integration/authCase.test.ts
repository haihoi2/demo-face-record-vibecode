/**
 * The fail-closed boundary must not depend on the spelling of a path. Express
 * matches routes case-insensitively by default; the boundary compared exact
 * strings, so "/Api/employees" reached its handler with no session (found on
 * the live gateway, 2026-09-27).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, rawApi } from "./helpers";

describe("auth boundary is spelling-proof", () => {
  for (const path of ["/Api/employees", "/API/employees", "/API/logs/stats", "/api/Employees"]) {
    it(`anonymous GET ${path} is refused`, async () => {
      const res = await rawApi(path);
      assert.ok(res.status === 401 || res.status === 404, `${path} answered ${res.status}`);
      assert.doesNotMatch(res.text, /"employees"\s*:|employeeCode/, "no data leaked");
    });
  }

  for (const path of ["/API/lock/unlock", "/api/Lock/unlock", "/API/recognize-face", "/API/config/ai", "/API/employees"]) {
    it(`anonymous POST ${path} is refused`, async () => {
      const res = await rawApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.ok(res.status === 401 || res.status === 403 || res.status === 404, `${path} answered ${res.status}`);
    });
  }

  it("mixed case after /api/ does not downgrade the required role", async () => {
    const res = await rawApi("/api/System/db-info");
    assert.ok(res.status === 401 || res.status === 403 || res.status === 404, `answered ${res.status}`);
  });

  it("a signed-in operator still uses the canonical paths normally", async () => {
    const res = await api("/api/employees");
    assert.equal(res.status, 200);
  });
});

describe("recognition thresholds are server-owned", () => {
  it("ignores a per-request config that tries to lower the accept threshold", async () => {
    const { noFaceJpegDataUrl, recognize } = await import("./helpers");
    const res = await recognize({
      imageBase64: noFaceJpegDataUrl(64, 77001),
      scanType: "ENTRY",
      config: { engineMode: "LOCAL_BIOMETRIC", localModel: { similarityThreshold: 0.01, livenessSensitivity: 0 } },
    });
    assert.equal(res.status, 200, res.text.slice(0, 200));
    const th = (res.body as any)?.fusion?.thresholds;
    if (th) assert.ok(Number(th.acceptSingle) >= 0.3, `acceptSingle lowered to ${th.acceptSingle}`);
    assert.equal((res.body as any).recognized, false);
  });
});
