/** The operator login dialog must paint above every other overlay (deep link without a session, 2026-11-04). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const bar = fs.readFileSync(new URL("../src/components/OperatorSessionBar.tsx", import.meta.url), "utf8");
const overlays = ["StrangerClusterModal", "MergeCompareDialog", "EmployeeEditDialog", "TemplateAuditPanel"].map((n) => {
  const p = new URL(`../src/components/${n}.tsx`, import.meta.url);
  return [n, fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""] as const;
});
const zOf = (s: string) => [...s.matchAll(/\bz-\[(\d+)\]|\bz-(\d+)\b/g)].map((m) => Number(m[1] ?? m[2]));

describe("login dialog stacking", () => {
  it("login dialog overlays use z-[70]", () => {
    const loginZ = zOf(bar.split("fixed inset-0")[1] || "");
    assert.ok(loginZ.includes(70), `login dialog z classes: ${loginZ.join(",")}`);
    assert.doesNotMatch(bar, /fixed inset-0 z-50/);
  });
  it("no other modal reaches the login dialog's layer", () => {
    for (const [name, src] of overlays) {
      const max = Math.max(0, ...zOf(src));
      assert.ok(max < 70, `${name} uses z-${max}`);
    }
  });
});
