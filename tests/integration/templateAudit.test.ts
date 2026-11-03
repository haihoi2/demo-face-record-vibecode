/**
 * GET /api/face-templates/audit: admin-only, read-only, never carries embeddings.
 * Black-box against the integration gateway (tests/integration/helpers.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { apiAs, authenticateAs, rawApi } from "./helpers";

const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || "integration-operator-token";
const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";

function longestNumberArray(v: unknown, depth = 0): number {
  if (depth > 8 || v === null || typeof v !== "object") return 0;
  if (Array.isArray(v)) {
    const nums = v.every((x) => typeof x === "number") ? v.length : 0;
    return Math.max(nums, ...v.map((x) => longestNumberArray(x, depth + 1)));
  }
  return Math.max(0, ...Object.values(v as Record<string, unknown>).map((x) => longestNumberArray(x, depth + 1)));
}

describe("GET /api/face-templates/audit", () => {
  it("anonymous 401, viewer 403", async () => {
    assert.equal((await rawApi("/api/face-templates/audit")).status, 401);
    const viewer = await authenticateAs(VIEWER_TOKEN);
    assert.equal((await apiAs(viewer, "/api/face-templates/audit")).status, 403);
  });

  it("admin gets the audit shape with ids and names only", async () => {
    const admin = await authenticateAs(OPERATOR_TOKEN);
    const res = await apiAs<any>(admin, "/api/face-templates/audit");
    assert.equal(res.status, 200, res.text.slice(0, 200));
    const b = res.body;
    assert.equal(b.success, true);
    assert.equal(typeof b.generatedAt, "string");
    assert.equal(typeof b.modelTag, "string");
    assert.ok(b.thresholds.acceptSingle >= 0.55, "audit never loosens below the door threshold");
    assert.equal(typeof b.templates, "number");
    assert.equal(typeof b.employees, "number");
    assert.ok(Array.isArray(b.suspects));
    for (const s of b.suspects) {
      assert.ok(["closer-to-other", "matches-other"].includes(s.reason));
      assert.equal(typeof s.templateId, "string");
      assert.equal(typeof s.otherEmployeeId, "string");
      assert.ok("employeeCode" in s && "otherEmployeeCode" in s);
    }
    assert.ok(longestNumberArray(b) <= 16, "no embedding-sized number arrays in the response");
    assert.ok(!res.text.includes('"embedding"'));
  });
});
