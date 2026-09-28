/**
 * Department/position selects in the stranger quick-register form: they must
 * never sit blank without saying why, and the always-mounted modal must fetch
 * the catalog again when it opens.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { orgChoice, orgPlaceholder } from "../src/utils/orgCatalog";

describe("org catalog selects", () => {
  it("say loading, failed, or empty instead of staying blank", () => {
    assert.match(orgPlaceholder(true, null), /Đang tải/);
    assert.match(orgPlaceholder(false, "HTTP 401"), /Không tải được/);
    assert.match(orgPlaceholder(false, null), /trống/);
  });

  it("pick the first offered value once the list arrives", () => {
    assert.equal(orgChoice([], "Phòng Kỹ Thuật AI"), "");
    assert.equal(orgChoice(["Inbound", "OutBound"], "Phòng Kỹ Thuật AI"), "Inbound");
    assert.equal(orgChoice(["Inbound", "OutBound"], "OutBound"), "OutBound");
  });

  it("the stranger modal reloads the catalog every time it opens and offers a retry", () => {
    const src = readFileSync(new URL("../src/components/StrangerClusterModal.tsx", import.meta.url), "utf8");
    assert.match(src, /if \(isOpen\) void orgCatalog\.reload\(\);\s*\n[^\n]*\n\s*\}, \[isOpen\]\);/);
    assert.match(src, /onClick=\{\(\) => void orgCatalog\.reload\(\)\}/);
    assert.equal((src.match(/orgPlaceholder\(orgCatalog\.loading, orgCatalog\.error\)/g) || []).length, 2);
  });
});
