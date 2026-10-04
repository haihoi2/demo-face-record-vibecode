import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { countsAgainstTemplateCap, templateCapRefuses } from "../src/server/templateCap";
import { templateRejectReason } from "../src/utils/templateReject";

const t = (source: string, quality: number) => ({ source, quality });

describe("template cap", () => {
  it("camera adaptation templates never take a slot", () => {
    assert.equal(countsAgainstTemplateCap({ source: "adaptation" }), false);
    for (const s of ["enrollment", "merge", "manual", "auto"]) assert.equal(countsAgainstTemplateCap({ source: s }), true, s);
  });

  it("8 merge/enrollment + 5 adaptation (13 in total) still has room (ÁNH OB, 2026-10-04)", () => {
    const existing = [...Array(8)].map(() => t("merge", 0.9)).concat([...Array(5)].map(() => t("adaptation", 0.9)));
    assert.equal(templateCapRefuses(existing, 0.5, 12), false);
  });

  it("a full employee takes a better photo (the worst is evicted later) and refuses a worse one", () => {
    const full = [...Array(11)].map(() => t("merge", 0.8)).concat([t("enrollment", 0.6)]);
    assert.equal(templateCapRefuses(full, 0.7, 12), false);
    assert.equal(templateCapRefuses(full, 0.6, 12), true, "no better than the worst");
    assert.equal(templateCapRefuses(full, 0.5, 12), true);
  });
});

describe("refusal reasons", () => {
  it("every code the enrolment paths return has words, and an unknown code is still shown", () => {
    for (const code of ["multiple-faces", "face-mismatch", "not-frontal", "low-quality", "template-cap", "duplicate",
      "no-face", "unsupported-image", "engine-unavailable", "engine-disabled", "engine-error"]) {
      const text = templateRejectReason(code);
      assert.ok(text.length > 10 && !text.startsWith("Mã lỗi"), code);
    }
    assert.equal(templateRejectReason("something-new"), "Mã lỗi: something-new.");
    assert.equal(templateRejectReason(null), "");
  });

  it("every rejected code in the enrolment code has words", () => {
    const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const codes = new Set([...src.matchAll(/rejected: "([a-z-]+)"/g)].map((m) => m[1]));
    assert.ok(codes.has("template-cap") && codes.size >= 6);
    for (const code of codes) assert.ok(!templateRejectReason(code).startsWith("Mã lỗi"), code);
  });
});

describe("wiring", () => {
  const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  it("the merge enrolment check uses the shared cap rule, not the total count", () => {
    assert.doesNotMatch(src, /getFaceTemplatesForEmployee\(employeeId\)\.length >= FACE_TEMPLATE_MAX/);
    assert.match(src, /templateCapRefuses\(existingTemplates, quality, FACE_TEMPLATE_MAX\)/);
    assert.match(src, /filter\(\(t\) => countsAgainstTemplateCap\(t\)\)/);
  });
  it("a merge that added a template trims the gallery back to the cap after the commit", () => {
    assert.match(src, /enrolled\.record \? enforceTemplateCap\(target\.id\) : \[\]/);
  });
});
