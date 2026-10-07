import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { employeeAvatarSrc, employeeInitials } from "../src/utils/employeeAvatar";

describe("employee avatar in the merge list", () => {
  it("loads the protected photo route when the server says there is a photo", () => {
    assert.equal(employeeAvatarSrc({ id: "EMP-1 x", hasPhoto: true }), "/api/employees/EMP-1%20x/photo");
    assert.equal(employeeAvatarSrc({ id: "EMP-1", hasPhoto: false }), "");
    assert.equal(employeeAvatarSrc({ id: "EMP-1" }), "");
    assert.equal(employeeAvatarSrc({ id: "EMP-1", photoUrl: "data:image/png;base64,AA", hasPhoto: true }), "data:image/png;base64,AA");
  });
  it("initials from the last two words", () => {
    assert.equal(employeeInitials("Đặng Thị Bảo Linh"), "BL");
    assert.equal(employeeInitials("My"), "M");
    assert.equal(employeeInitials("  "), "?");
  });
  it("the list and the chosen target use it; the search reports hasPhoto", () => {
    const ui = readFileSync(new URL("../src/components/StrangerClusterModal.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(ui, /src=\{emp\.photoUrl\}/);
    assert.match(ui, /src=\{employeeAvatarSrc\(mergeTarget/);
    const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    assert.match(src, /hasPhoto: employeeHasPhoto\(employee\),\n  \};\n\}/);
  });
});
