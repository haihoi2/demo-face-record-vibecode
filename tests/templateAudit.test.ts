/**
 * Unit tests for the template-gallery audit and the merge-time guard
 * (src/server/templateAudit.ts). Pure vector maths - no models required.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildGallery, cosine, l2Normalize } from "../src/server/faceFusion";
import { auditTemplates, checkTemplateAgainstGallery } from "../src/server/templateAudit";
import { FaceTemplate } from "../src/types";

const DIMS = 8;
const TAG = "arcface_w600k_r50";
function unit(axis: number): number[] {
  const v = new Array(DIMS).fill(0);
  v[axis] = 1;
  return v;
}
/** A view of `base` with cosine ≈ `target` against it (mixes in an orthogonal axis). */
function viewOf(base: number[], target: number, orthAxis: number): number[] {
  const orth = unit(orthAxis);
  const s = Math.sqrt(Math.max(0, 1 - target * target));
  return l2Normalize(base.map((b, i) => b * target + orth[i] * s));
}
const ALICE = unit(0);
const BOB = unit(1);
const CAROL = unit(2);

let seq = 0;
function template(
  employeeId: string,
  embedding: number[],
  extra: Partial<FaceTemplate> = {},
): FaceTemplate {
  seq++;
  return {
    id: `T-${employeeId}-${String(seq).padStart(3, "0")}`,
    employeeId,
    embedding,
    dims: embedding.length,
    modelTag: TAG,
    source: "enrollment",
    quality: 0.9,
    capturedAt: "2026-11-03T00:00:00.000Z",
    ...extra,
  };
}

/** Three near views per identity (cosine ≈ 0.9 to the axis), on distinct orthogonal axes. */
function cleanGallery(): FaceTemplate[] {
  return [
    template("ALICE", viewOf(ALICE, 0.9, 5)), template("ALICE", viewOf(ALICE, 0.9, 6)), template("ALICE", viewOf(ALICE, 0.9, 7)),
    template("BOB", viewOf(BOB, 0.9, 5)), template("BOB", viewOf(BOB, 0.9, 6)), template("BOB", viewOf(BOB, 0.9, 7)),
    template("CAROL", viewOf(CAROL, 0.9, 5)), template("CAROL", viewOf(CAROL, 0.9, 6)), template("CAROL", viewOf(CAROL, 0.9, 7)),
  ];
}

/** Walk any value and fail on arrays longer than `max` (an embedding would be DIMS or 512 long). */
function assertNoLongArrays(v: unknown, path = "$", max = 16): void {
  if (Array.isArray(v)) {
    assert.ok(v.length <= max, `${path} is an array of length ${v.length}`);
    v.forEach((x, i) => assertNoLongArrays(x, `${path}[${i}]`, max));
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) assertNoLongArrays(x, `${path}.${k}`, max);
  }
  if (v instanceof Float64Array || v instanceof Float32Array) assert.fail(`${path} is a typed array`);
}

describe("auditTemplates", () => {
  it("reports a clean gallery with no suspects", () => {
    const r = auditTemplates(cleanGallery(), { modelTag: TAG });
    assert.equal(r.modelTag, TAG);
    assert.equal(r.acceptSingle, 0.55);
    assert.equal(r.templates, 9);
    assert.equal(r.employees, 3);
    assert.equal(r.skipped, 0);
    assert.deepEqual(r.suspects, []);
    assert.deepEqual(r.perEmployee, [
      { employeeId: "ALICE", templates: 3, suspects: 0 },
      { employeeId: "BOB", templates: 3, suspects: 0 },
      { employeeId: "CAROL", templates: 3, suspects: 0 },
    ]);
  });

  it("flags a contaminated template as closer-to-other, naming the right employee (NV-4386 case)", () => {
    const g = cleanGallery();
    // Alice's "merge" template is actually Bob's face (0.65 to Bob's templates).
    const bad = template("ALICE", viewOf(BOB, 0.95, 3), { source: "merge", streamId: "cam-1", sourceLogId: "LOG-1" });
    g.push(bad);
    const r = auditTemplates(g, { modelTag: TAG });
    assert.equal(r.templates, 10);
    assert.equal(r.suspects.length, 1);
    const s = r.suspects[0];
    assert.equal(s.templateId, bad.id);
    assert.equal(s.employeeId, "ALICE");
    assert.equal(s.otherEmployeeId, "BOB");
    assert.equal(s.reason, "closer-to-other");
    assert.equal(s.source, "merge");
    assert.equal(s.streamId, "cam-1");
    assert.equal(s.sourceLogId, "LOG-1");
    assert.equal(s.quality, 0.9);
    assert.equal(s.capturedAt, "2026-11-03T00:00:00.000Z");
    assert.ok(s.ownCosine != null && s.ownCosine < 0.1, `ownCosine ${s.ownCosine}`);
    assert.ok(s.otherCosine > 0.8, `otherCosine ${s.otherCosine}`);
    assert.ok(s.otherCentroidCosine > s.ownCosine!);
    assert.ok(Math.abs(s.severity - (s.otherCosine - s.ownCosine!)) < 1e-3);
    assert.deepEqual(r.perEmployee.find((p) => p.employeeId === "ALICE"), { employeeId: "ALICE", templates: 4, suspects: 1 });
    // The contaminated template must not drag Bob's own templates into suspicion
    // (they match it at ~0.85, but the culprit is already reported).
    assert.ok(!r.suspects.some((x) => x.employeeId === "BOB"));
    assert.deepEqual(r.perEmployee.find((p) => p.employeeId === "BOB"), { employeeId: "BOB", templates: 3, suspects: 0 });
  });

  it("flags a lookalike pair at 0.56 as matches-other (own agreement still higher)", () => {
    const g = cleanGallery();
    // Bob's extra template agrees with Bob (0.75) but also sits at ~0.59 to Carol's templates.
    const bobTwin = l2Normalize(BOB.map((b, i) => b * 0.75 + CAROL[i] * 0.66));
    g.push(template("BOB", bobTwin));
    const r = auditTemplates(g, { modelTag: TAG });
    const twin = r.suspects.find((s) => s.employeeId === "BOB" && s.otherEmployeeId === "CAROL");
    assert.ok(twin, "Bob's Carol-like template is flagged");
    assert.equal(twin!.reason, "matches-other");
    assert.ok(twin!.otherCosine >= 0.55 && twin!.otherCosine < 0.7, `otherCosine ${twin!.otherCosine}`);
    assert.ok(twin!.ownCosine! > twin!.otherCentroidCosine, "still agrees more with Bob");
    // Carol's templates see Bob's twin at ~0.6: they are flagged matches-other, not closer-to-other.
    for (const s of r.suspects.filter((x) => x.employeeId === "CAROL")) assert.equal(s.reason, "matches-other");
    assert.ok(r.suspects.every((s) => s.reason === "matches-other"));
  });

  it("does not flag a lookalike pair that stays below acceptSingle (and honours an override)", () => {
    const g = cleanGallery();
    g.push(template("BOB", l2Normalize(BOB.map((b, i) => b * 0.9 + CAROL[i] * 0.5))));
    const r = auditTemplates(g, { modelTag: TAG });
    assert.deepEqual(r.suspects, []);
    const strict = auditTemplates(g, { modelTag: TAG, acceptSingle: 0.4 });
    assert.ok(strict.suspects.length > 0);
    assert.equal(strict.acceptSingle, 0.4);
  });

  it("handles single-template employees: ownCosine null, suspect only when it matches someone else", () => {
    const clean = [template("ALICE", ALICE), template("BOB", BOB)];
    const r = auditTemplates(clean, { modelTag: TAG });
    assert.deepEqual(r.suspects, []);
    assert.deepEqual(r.perEmployee, [
      { employeeId: "ALICE", templates: 1, suspects: 0 },
      { employeeId: "BOB", templates: 1, suspects: 0 },
    ]);

    const g = cleanGallery();
    g.push(template("DAVE", viewOf(ALICE, 0.95, 3))); // Dave's only template is Alice's face
    const r2 = auditTemplates(g, { modelTag: TAG });
    const dave = r2.suspects.filter((s) => s.employeeId === "DAVE");
    assert.equal(dave.length, 1);
    assert.equal(dave[0].ownCosine, null);
    assert.equal(dave[0].otherEmployeeId, "ALICE");
    assert.equal(dave[0].reason, "closer-to-other");
    assert.equal(dave[0].severity, dave[0].otherCosine);
  });

  it("blames the contaminated template, not a single-template victim it resembles", () => {
    // Bob has exactly one enrolment; Alice holds three genuine views plus a Bob-faced merge template.
    const g = [
      template("ALICE", viewOf(ALICE, 0.9, 5)), template("ALICE", viewOf(ALICE, 0.9, 6)), template("ALICE", viewOf(ALICE, 0.9, 7)),
      template("ALICE", viewOf(BOB, 0.95, 3), { source: "merge" }),
      template("BOB", BOB),
    ];
    const r = auditTemplates(g, { modelTag: TAG });
    assert.deepEqual(r.suspects.map((s) => [s.employeeId, s.source, s.reason, s.otherEmployeeId]), [["ALICE", "merge", "closer-to-other", "BOB"]]);
    assert.deepEqual(r.perEmployee, [
      { employeeId: "ALICE", templates: 4, suspects: 1 },
      { employeeId: "BOB", templates: 1, suspects: 0 },
    ]);
  });

  it("returns nothing to compare for a single employee", () => {
    const r = auditTemplates([template("ALICE", ALICE), template("ALICE", viewOf(ALICE, 0.9, 5))], { modelTag: TAG });
    assert.equal(r.employees, 1);
    assert.deepEqual(r.suspects, []);
  });

  it("skips templates of a foreign modelTag, malformed embeddings, and odd dims - never compares them", () => {
    const g = cleanGallery();
    // Would be a glaring suspect if compared.
    g.push(template("ALICE", BOB, { modelTag: "arcface_w600k_mbf" }));
    g.push(template("ALICE", [], { dims: 0 }));
    g.push(template("ALICE", BOB, { dims: 512 }));
    g.push(template("ALICE", [1, 0, 0, 0], { dims: 4 }));
    const r = auditTemplates(g, { modelTag: TAG });
    assert.equal(r.templates, 9);
    assert.equal(r.skipped, 4);
    assert.deepEqual(r.suspects, []);
    const foreign = auditTemplates(g, { modelTag: "arcface_w600k_mbf" });
    assert.equal(foreign.templates, 1);
    assert.equal(foreign.employees, 1);
    assert.deepEqual(foreign.suspects, []);
  });

  it("weights the own centroid by quality", () => {
    // Alice: two high-quality true views plus one low-quality Bob-like template.
    const g = [
      template("ALICE", viewOf(ALICE, 0.9, 5), { quality: 0.95 }),
      template("ALICE", viewOf(ALICE, 0.9, 6), { quality: 0.95 }),
      template("ALICE", viewOf(BOB, 0.9, 7), { quality: 0.2, source: "adaptation" }),
      template("BOB", BOB),
    ];
    const r = auditTemplates(g, { modelTag: TAG });
    // The two good Alice views must not be flagged: the bad one carries little weight.
    assert.deepEqual(r.suspects.map((s) => s.source), ["adaptation"]);
  });

  it("sorts suspects by severity descending, then templateId, and is deterministic across shuffles", () => {
    const g = cleanGallery();
    g.push(template("ALICE", viewOf(BOB, 0.95, 3)));   // severe
    g.push(template("CAROL", viewOf(ALICE, 0.7, 4)));  // milder
    const a = auditTemplates(g, { modelTag: TAG });
    const b = auditTemplates([...g].reverse(), { modelTag: TAG });
    const c = auditTemplates([g[4], g[10], g[0], g[9], g[1], g[2], g[3], g[5], g[6], g[7], g[8]], { modelTag: TAG });
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
    for (let i = 1; i < a.suspects.length; i++) {
      const prev = a.suspects[i - 1], cur = a.suspects[i];
      assert.ok(prev.severity > cur.severity || (prev.severity === cur.severity && prev.templateId < cur.templateId));
    }
    assert.equal(a.suspects[0].employeeId, "ALICE");
  });

  it("never leaks embeddings: the result holds no arrays longer than 16 and no typed arrays", () => {
    const g = cleanGallery();
    g.push(template("ALICE", viewOf(BOB, 0.95, 3)));
    const r = auditTemplates(g, { modelTag: TAG });
    assert.ok(r.suspects.length > 0);
    assertNoLongArrays(r);
    assert.ok(!JSON.stringify(r).includes('"embedding"'));
    for (const s of r.suspects) assert.ok(!("embedding" in s));
  });

  it("does not mutate its input", () => {
    const g = cleanGallery();
    const before = JSON.stringify(g);
    auditTemplates(g, { modelTag: TAG });
    assert.equal(JSON.stringify(g), before);
  });

  it("runs 1,000 x 512-D templates in bounded time (target < 1 s on a free core; CI bound 3 s)", () => {
    const D = 512, perEmp = 5, emps = 200;
    // Deterministic pseudo-random identities (LCG), each with 5 noisy views.
    let state = 12345;
    const rnd = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff - 0.5; };
    const g: FaceTemplate[] = [];
    for (let e = 0; e < emps; e++) {
      const base = l2Normalize(Array.from({ length: D }, rnd));
      for (let k = 0; k < perEmp; k++) {
        const v = l2Normalize(base.map((b) => b + rnd() * 0.08));
        g.push(template(`E${String(e).padStart(3, "0")}`, v, { quality: 0.6 + k * 0.05 }));
      }
    }
    const t0 = performance.now();
    const r = auditTemplates(g, { modelTag: TAG });
    const ms = performance.now() - t0;
    assert.equal(r.templates, 1000);
    assert.equal(r.employees, 200);
    assert.deepEqual(r.suspects, []);
    console.log(`[templateAudit] 1000 x 512-D audit: ${ms.toFixed(0)} ms`);
    assert.ok(ms < 3000, `audit took ${ms.toFixed(0)} ms`);
  });
});

describe("checkTemplateAgainstGallery", () => {
  const gallery = buildGallery(cleanGallery(), TAG);

  it("accepts a candidate that matches its target best", () => {
    const r = checkTemplateAgainstGallery(viewOf(ALICE, 0.9, 4), "ALICE", gallery);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.ok(r.targetCosine > 0.8);
      assert.equal(r.flag, undefined);
      assert.equal(r.otherEmployeeId !== "ALICE", true);
    }
  });

  it("refuses a candidate that matches another employee at >= acceptSingle more strongly than the target", () => {
    const r = checkTemplateAgainstGallery(viewOf(BOB, 0.95, 4), "ALICE", gallery);
    assert.equal(r.ok, false);
    if (!r.ok && r.reason === "matches-other-employee") {
      assert.equal(r.otherEmployeeId, "BOB");
      assert.ok(r.otherCosine >= 0.55);
      assert.ok(r.targetCosine < r.otherCosine);
    } else assert.fail(`unexpected ${JSON.stringify(r)}`);
  });

  it("reports targetCosine -1 and refuses when the target has no templates yet but the face is someone else's", () => {
    const r = checkTemplateAgainstGallery(viewOf(BOB, 0.95, 4), "NEW-EMP", gallery);
    assert.equal(r.ok, false);
    if (!r.ok && r.reason === "matches-other-employee") {
      assert.equal(r.targetCosine, -1);
      assert.equal(r.otherEmployeeId, "BOB");
    } else assert.fail(`unexpected ${JSON.stringify(r)}`);
  });

  it("accepts a new employee's unmatched face (targetCosine -1, others below acceptSingle) with a soft flag", () => {
    const r = checkTemplateAgainstGallery(unit(3), "NEW-EMP", gallery);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.targetCosine, -1);
      // Everyone else is at ~0 cosine which is still > -1: the soft flag is informational only.
      assert.equal(r.flag, "closer-to-other");
      assert.ok((r.otherCosine ?? 1) < 0.55);
    }
  });

  it("soft-flags closer-to-other below acceptSingle without refusing", () => {
    // Candidate: 0.5 to Bob, ~0.3 to Alice (the target).
    const cand = l2Normalize(ALICE.map((a, i) => a * 0.35 + BOB[i] * 0.55 + unit(3)[i] * 0.75));
    const r = checkTemplateAgainstGallery(cand, "ALICE", gallery);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.flag, "closer-to-other");
      assert.equal(r.otherEmployeeId, "BOB");
      assert.ok(r.otherCosine! < 0.55 && r.otherCosine! > r.targetCosine);
    }
  });

  it("does not refuse when another employee is >= acceptSingle but the target scores higher", () => {
    const cand = l2Normalize(ALICE.map((a, i) => a * 0.75 + BOB[i] * 0.66));
    const r = checkTemplateAgainstGallery(cand, "ALICE", gallery);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.flag, undefined);
      assert.equal(r.otherEmployeeId, "BOB");
      assert.ok(r.otherCosine! >= 0.55);
      assert.ok(r.targetCosine > r.otherCosine!);
    }
  });

  it("accepts a template list with a modelTag and ignores foreign-tag templates", () => {
    const list = [...cleanGallery(), template("CAROL", viewOf(BOB, 0.99, 3), { modelTag: "arcface_w600k_mbf" })];
    // Without the foreign template, Bob's face for Alice is refused because of Bob - not Carol.
    const r = checkTemplateAgainstGallery(viewOf(BOB, 0.95, 4), "ALICE", list, { modelTag: TAG });
    assert.equal(r.ok, false);
    if (!r.ok && r.reason === "matches-other-employee") assert.equal(r.otherEmployeeId, "BOB");
    else assert.fail(`unexpected ${JSON.stringify(r)}`);
  });

  it("fails closed on a template list without a modelTag", () => {
    const r = checkTemplateAgainstGallery(viewOf(ALICE, 0.9, 4), "ALICE", cleanGallery());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "incompatible-embedding");
  });

  it("fails closed on an empty or mismatched-dims candidate", () => {
    const empty = checkTemplateAgainstGallery([], "ALICE", gallery);
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.reason, "incompatible-embedding");
    const wrong = checkTemplateAgainstGallery(new Array(512).fill(0.1), "ALICE", gallery);
    assert.equal(wrong.ok, false);
    if (!wrong.ok && wrong.reason === "incompatible-embedding") {
      assert.equal(wrong.candidateDims, 512);
      assert.equal(wrong.galleryDims, DIMS);
    } else assert.fail(`unexpected ${JSON.stringify(wrong)}`);
  });

  it("accepts against an empty gallery (first template ever) without a flag", () => {
    const r = checkTemplateAgainstGallery(ALICE, "ALICE", new Map());
    assert.deepEqual(r, { ok: true, targetCosine: -1 });
  });

  it("honours an acceptSingle override and agrees with faceFusion's cosine", () => {
    const cand = l2Normalize(ALICE.map((a, i) => a * 0.35 + BOB[i] * 0.55 + unit(3)[i] * 0.75));
    const expectBob = Math.max(...gallery.get("BOB")!.map((t) => cosine(cand, t)));
    const strict = checkTemplateAgainstGallery(cand, "ALICE", gallery, { acceptSingle: 0.4 });
    assert.equal(strict.ok, false);
    if (!strict.ok && strict.reason === "matches-other-employee") assert.ok(Math.abs(strict.otherCosine - expectBob) < 1e-3);
    else assert.fail(`unexpected ${JSON.stringify(strict)}`);
  });

  it("never leaks embeddings in its result", () => {
    assertNoLongArrays(checkTemplateAgainstGallery(viewOf(BOB, 0.95, 4), "ALICE", gallery));
    assertNoLongArrays(checkTemplateAgainstGallery(viewOf(ALICE, 0.9, 4), "ALICE", gallery));
  });
});
