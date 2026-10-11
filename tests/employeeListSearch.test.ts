/** Employee list: quick search, avatars; registration photo from a saved recognised face (2026-10-11). */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { employeeMatchesQuery, foldVietnamese } from "../src/utils/employeeAvatar";
import { parseEmployeeEdit } from "../src/server/employeeEdit";
import { employeeEditPatch } from "../src/utils/employeeEdit";

describe("employee quick search", () => {
  const bich = { name: "Bích", employeeCode: "NV-4098", department: "Ban Điều Hành", position: "Warehouse Manager" };
  it("ignores accents and case; every word must match somewhere", () => {
    assert.equal(foldVietnamese("Đặng Thị Bảo Linh"), "dang thi bao linh");
    assert.equal(employeeMatchesQuery(bich, "bich"), true);
    assert.equal(employeeMatchesQuery(bich, "BÍCH 4098"), true);
    assert.equal(employeeMatchesQuery(bich, "dieu hanh"), true);
    assert.equal(employeeMatchesQuery(bich, "linh"), false);
    assert.equal(employeeMatchesQuery(bich, "   "), true);
  });
});

describe("registration photo from a saved recognised face", () => {
  it("accepts face:SF-... only, and not together with an upload", () => {
    assert.deepEqual(parseEmployeeEdit({ photoFrom: "face:SF-abc-1" }), { ok: true, value: { photoFrom: "face:SF-abc-1" } });
    assert.equal(parseEmployeeEdit({ photoFrom: "log:LOG-1" }).ok, false);
    assert.equal(parseEmployeeEdit({ photoFrom: "https://x/y.jpg" }).ok, false);
    assert.equal(parseEmployeeEdit({ photo: "data:image/png;base64,AAAA", photoFrom: "face:SF-1" }).ok, false);
  });
  it("the dialog sends it when no file was uploaded", () => {
    const o = { name: "A", department: "D", position: "P" };
    assert.deepEqual(employeeEditPatch(o, { ...o, photo: "", photoFrom: "face:SF-1" }), { photoFrom: "face:SF-1" });
    assert.deepEqual(employeeEditPatch(o, { ...o, photo: "data:x", photoFrom: "face:SF-1" }), { photo: "data:x" });
  });
});

describe("wiring", () => {
  const list = readFileSync(new URL("../src/components/EmployeeRegistration.tsx", import.meta.url), "utf8");
  const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  it("the list avatar uses the protected photo route, never emp.photoUrl", () => {
    assert.doesNotMatch(list, /src=\{emp\.photoUrl\}/);
    assert.match(list, /employeeMatchesQuery\(emp, employeeQuery\)/);
  });
  it("only this employee's own recognised face can be picked; its bytes are copied", () => {
    assert.match(src, /face\.employeeId !== before\.id \|\| face\.purgedAt/);
    assert.match(src, /savedPhoto = `data:image\/jpeg;base64,/);
  });
});
