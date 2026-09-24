import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const read = (path: string) => readFileSync(path, "utf8");

describe("protected biometric images", () => {
  it("loads protected log images through the authenticated blob component", () => {
    const component = read("src/components/ProtectedImage.tsx");
    assert.match(component, /apiFetch\(/);
    assert.match(component, /URL\.createObjectURL/);
    assert.match(component, /URL\.revokeObjectURL/);

    for (const path of ["src/components/AccessLogs.tsx", "src/components/StrangerClusterModal.tsx"]) {
      const source = read(path);
      assert.match(source, /<ProtectedImage/);
      assert.doesNotMatch(source, /<img[\s\S]{0,160}normalizeApiAssetUrl\(/);
    }
  });

  it("paginates stranger clusters and resolves deep links through authoritative lookup", () => {
    const source = read("src/components/StrangerClusterModal.tsx");
    assert.match(source, /nextCursor/);
    assert.match(source, /\/api\/strangers\/lookup\?logId=/);
    assert.match(source, /btn-next-stranger-page/);
    assert.match(source, /btn-prev-stranger-page/);
  });
});
