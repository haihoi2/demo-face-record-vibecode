/**
 * planGalleryDerivation (src/server/faceFusion.ts): which pictures to re-embed
 * to build the pipeline's gallery under a second recogniser tag. Pure and
 * deterministic; never copies an embedding across tags.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { planGalleryDerivation, type GalleryDerivationSource } from "../src/server/faceFusion.ts";
import type { FaceTemplate } from "../src/types.ts";

const R50 = "arcface_w600k_r50";
const MBF = "arcface_w600k_mbf";

function tpl(employeeId: string, modelTag: string, extra: Partial<FaceTemplate> = {}): FaceTemplate {
  const embedding = new Array(512).fill(0);
  embedding[1] = 1;
  return { id: extra.id ?? `${employeeId}-${modelTag}-${extra.sourceLogId ?? "x"}`, employeeId, embedding, dims: 512, modelTag, source: "merge", quality: 0.8, capturedAt: "2026-09-20T00:00:00.000Z", ...extra };
}
function src(employeeId: string, sourceId: string, extra: Partial<GalleryDerivationSource> = {}): GalleryDerivationSource {
  return { employeeId, sourceId, kind: "access_log_crop", capturedAt: "2026-09-25T00:00:00.000Z", quality: 0.7, ...extra };
}

test("empty inputs and a missing target tag produce an empty plan", () => {
  assert.deepEqual(planGalleryDerivation([], [], { targetTag: MBF }), { targetTag: MBF, toEmbed: [], perEmployee: {}, uncovered: [] });
  assert.deepEqual(planGalleryDerivation([tpl("E1", R50)], [src("E1", "L1")], { targetTag: "" }).toEmbed, []);
});

test("legacy-tag templates are never copied: only source pictures are planned, and the plan carries no embedding", () => {
  const plan = planGalleryDerivation([tpl("E1", R50, { sourceLogId: "L0" })], [src("E1", "L1")], { targetTag: MBF });
  assert.deepEqual(plan.toEmbed.map((s) => s.sourceId), ["L1"]);
  assert.ok(plan.toEmbed.every((s) => !("embedding" in s)));
  assert.equal(plan.perEmployee.E1.existing, 0, "r50 templates do not count as mbf coverage");
});

test("sources already embedded under the target tag are skipped (by sourceLogId or template id)", () => {
  const existing = [tpl("E1", MBF, { sourceLogId: "L1" }), tpl("E1", MBF, { id: "T-9", sourceLogId: undefined })];
  const plan = planGalleryDerivation(existing, [src("E1", "L1"), src("E1", "T-9", { kind: "template_source" }), src("E1", "L2")], { targetTag: MBF });
  assert.deepEqual(plan.toEmbed.map((s) => s.sourceId), ["L2"]);
  assert.equal(plan.perEmployee.E1.existing, 2);
  assert.equal(plan.perEmployee.E1.skipped.alreadyDerived, 2);
});

test("cap per employee counts existing target-tag templates; the rest is reported as capReached", () => {
  const existing = [tpl("E1", MBF, { sourceLogId: "A" }), tpl("E1", MBF, { sourceLogId: "B" })];
  const sources = ["L1", "L2", "L3", "L4", "L5"].map((id, i) => src("E1", id, { quality: 0.9 - i * 0.1 }));
  const plan = planGalleryDerivation(existing, sources, { targetTag: MBF, capPerEmployee: 4 });
  assert.deepEqual(plan.toEmbed.map((s) => s.sourceId), ["L1", "L2"]);
  assert.deepEqual(plan.perEmployee.E1, { existing: 2, planned: 2, skipped: { capReached: 3 } });
  assert.equal(planGalleryDerivation(existing, sources, { targetTag: MBF, capPerEmployee: 2 }).toEmbed.length, 0);
  assert.equal(planGalleryDerivation([], sources, { targetTag: MBF }).toEmbed.length, 5, "default cap is 5");
});

test("ordering: enrolment photos first, then quality, then newest, then id; unknown quality counts as 0.5", () => {
  const sources = [
    src("E1", "log-old", { quality: 0.9, capturedAt: "2026-09-01T00:00:00.000Z" }),
    src("E1", "log-new", { quality: 0.9, capturedAt: "2026-09-26T00:00:00.000Z" }),
    src("E1", "photo", { kind: "enrollment_photo", quality: undefined }),
    src("E1", "tsrc", { kind: "template_source", quality: 0.4 }),
    src("E1", "log-mid", { quality: 0.6 }),
    src("E1", "log-unknown-q", { quality: undefined }),
  ];
  const plan = planGalleryDerivation([], sources, { targetTag: MBF, capPerEmployee: 10 });
  assert.deepEqual(plan.toEmbed.map((s) => s.sourceId), ["photo", "tsrc", "log-new", "log-old", "log-mid", "log-unknown-q"]);
  // Same input in another order gives the same plan.
  const shuffled = [...sources].reverse();
  assert.deepEqual(planGalleryDerivation([], shuffled, { targetTag: MBF, capPerEmployee: 10 }).toEmbed.map((s) => s.sourceId), plan.toEmbed.map((s) => s.sourceId));
});

test("picks alternate across camera streams so every camera gets templates", () => {
  const sources = [
    src("E1", "entry-1", { streamId: "entry", quality: 0.95 }),
    src("E1", "entry-2", { streamId: "entry", quality: 0.94 }),
    src("E1", "entry-3", { streamId: "entry", quality: 0.93 }),
    src("E1", "exit-1", { streamId: "exit", quality: 0.5 }),
    src("E1", "exit-2", { streamId: "exit", quality: 0.4 }),
  ];
  const plan = planGalleryDerivation([], sources, { targetTag: MBF, capPerEmployee: 3 });
  assert.deepEqual(plan.toEmbed.map((s) => s.sourceId), ["entry-1", "exit-1", "entry-2"]);
  assert.equal(plan.perEmployee.E1.skipped.capReached, 2);
});

test("low quality and malformed sources are skipped with a reason; duplicate ids are planned once", () => {
  const sources = [
    src("E1", "good", { quality: 0.3 }),
    src("E1", "good", { quality: 0.3 }),
    src("E1", "blurry", { quality: 0.1 }),
    { employeeId: "E1", sourceId: "", kind: "access_log_crop", capturedAt: "" } as GalleryDerivationSource,
    { employeeId: "", sourceId: "orphan", kind: "access_log_crop", capturedAt: "" } as GalleryDerivationSource,
    { employeeId: "E1", sourceId: "kind?", kind: "unknown" as any, capturedAt: "" },
  ];
  const plan = planGalleryDerivation([], sources, { targetTag: MBF });
  assert.deepEqual(plan.toEmbed.map((s) => s.sourceId), ["good"]);
  assert.deepEqual(plan.perEmployee.E1.skipped, { lowQuality: 1, invalid: 2 });
  assert.equal(planGalleryDerivation([], [src("E1", "g", { quality: 0.3 })], { targetTag: MBF, minQuality: 0.5 }).toEmbed.length, 0);
});

test("uncovered lists the employees who would still have nothing under the target tag", () => {
  const plan = planGalleryDerivation([tpl("E3", MBF, { sourceLogId: "z" })], [src("E1", "L1"), src("E2", "L2", { quality: 0.05 })], { targetTag: MBF, employeeIds: ["E1", "E2", "E3", "E4"] });
  assert.deepEqual(plan.uncovered, ["E2", "E4"]);
  assert.deepEqual(Object.keys(plan.perEmployee).sort(), ["E1", "E2", "E3"]);
});

test("employees are processed in a stable order and the input arrays are not mutated", () => {
  const sources = [src("E2", "b"), src("E1", "a"), src("E2", "a")];
  const copy = JSON.parse(JSON.stringify(sources));
  const plan = planGalleryDerivation([], sources, { targetTag: MBF });
  assert.deepEqual(plan.toEmbed.map((s) => `${s.employeeId}/${s.sourceId}`), ["E1/a", "E2/a", "E2/b"]);
  assert.deepEqual(sources, copy);
});
