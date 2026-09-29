/**
 * planAdaptation / templateCoverage (src/server/galleryAdaptation.ts, plan
 * Part C3): the camera-adaptation POLICY. Pure and deterministic. These tests
 * pin the floors, the per-camera cap with eviction of the worst adaptation
 * template only (never a manual enrolment), the novelty skip, ordering and
 * determinism, and the coverage summary the enrolment list shows.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ADAPTATION_POLICY,
  planAdaptation,
  templateCoverage,
  type AdaptationPolicy,
  type ExistingTemplate,
  type RecognisedFaceObservation,
} from "../src/server/galleryAdaptation.ts";

const ACCEPT_SINGLE = 0.55;
/** Floors with the default policy at acceptSingle 0.55. */
const COS_FLOOR = ACCEPT_SINGLE + DEFAULT_ADAPTATION_POLICY.minCosineAboveAcceptSingle; // 0.65
const MARGIN_FLOOR = DEFAULT_ADAPTATION_POLICY.minMargin; // 0.15
const QUALITY_FLOOR = DEFAULT_ADAPTATION_POLICY.minQuality; // 0.35

/** Unit vector along axis `axis`; `tilt` mixes in axis+1 so cosines are controllable: cos(vec(a), vec(a, t)) = 1/sqrt(1+t^2). */
function vec(axis: number, tilt = 0): number[] {
  const v = new Array<number>(512).fill(0);
  v[axis] = 1;
  if (tilt) v[axis + 1] = tilt;
  const n = Math.hypot(1, tilt);
  return v.map((x) => x / n);
}
/** Tilt giving a cosine of exactly `c` to the untilted axis vector. */
const tiltFor = (c: number) => Math.sqrt(1 / (c * c) - 1);

let seq = 0;
function obs(over: Partial<RecognisedFaceObservation> = {}): RecognisedFaceObservation {
  seq++;
  return {
    faceId: `F${seq}`,
    logId: `L${seq}`,
    employeeId: "E1",
    streamId: "cam-exit",
    gate: "exit",
    capturedAt: `2026-09-29T10:${String(seq % 60).padStart(2, "0")}:00.000Z`,
    quality: 0.8,
    matchCosine: 0.72,
    matchMargin: 0.30,
    embedding: vec(seq % 400),
    ...over,
  };
}
function tpl(over: Partial<ExistingTemplate> = {}): ExistingTemplate {
  seq++;
  return { id: `T${seq}`, employeeId: "E1", streamId: "cam-exit", source: "adaptation", quality: 0.5, embedding: vec(400 + (seq % 100)), ...over };
}
const ids = (plan: ReturnType<typeof planAdaptation>) => plan.map((p) => p.observation.faceId);

// ---------------------------------------------------------------------------
// Floors
// ---------------------------------------------------------------------------

test("floors: cosine, margin and quality must each reach the policy floor (inclusive); a missing streamId disqualifies", () => {
  const ok = obs({ matchCosine: COS_FLOOR, matchMargin: MARGIN_FLOOR, quality: QUALITY_FLOOR });
  assert.equal(planAdaptation([ok], [], ACCEPT_SINGLE).length, 1, "exactly at every floor is accepted");
  assert.equal(planAdaptation([obs({ matchCosine: COS_FLOOR - 0.001 })], [], ACCEPT_SINGLE).length, 0, "cosine just under the floor");
  assert.equal(planAdaptation([obs({ matchCosine: ACCEPT_SINGLE + 0.05 })], [], ACCEPT_SINGLE).length, 0, "a plain grant (above acceptSingle) is not enough");
  assert.equal(planAdaptation([obs({ matchMargin: MARGIN_FLOOR - 0.001 })], [], ACCEPT_SINGLE).length, 0, "margin just under the floor");
  assert.equal(planAdaptation([obs({ matchMargin: 0.08 })], [], ACCEPT_SINGLE).length, 0, "the fusion minMargin (0.08) is not enough");
  assert.equal(planAdaptation([obs({ quality: QUALITY_FLOOR - 0.001 })], [], ACCEPT_SINGLE).length, 0, "quality just under the floor");
  assert.equal(planAdaptation([obs({ streamId: "" })], [], ACCEPT_SINGLE).length, 0, "no camera, no per-camera template");
  assert.equal(planAdaptation([], [], ACCEPT_SINGLE).length, 0, "empty input");
});

test("floors follow acceptSingle: the cosine floor is acceptSingle + minCosineAboveAcceptSingle", () => {
  const o = obs({ matchCosine: 0.655 });
  assert.equal(planAdaptation([o], [], 0.55).length, 1, "0.655 >= 0.65");
  assert.equal(planAdaptation([o], [], 0.56).length, 0, "0.655 < 0.66 with the r50_int8 operating point");
  const strict: AdaptationPolicy = { ...DEFAULT_ADAPTATION_POLICY, minCosineAboveAcceptSingle: 0.2 };
  assert.equal(planAdaptation([o], [], 0.55, strict).length, 0, "custom policy honoured");
});

test("DEFAULT_ADAPTATION_POLICY is the documented, frozen contract", () => {
  assert.deepEqual(DEFAULT_ADAPTATION_POLICY, { minCosineAboveAcceptSingle: 0.10, minMargin: 0.15, minQuality: 0.35, maxPerCamera: 5, minNovelty: 0.05 });
  assert.ok(Object.isFrozen(DEFAULT_ADAPTATION_POLICY));
});

// ---------------------------------------------------------------------------
// Cap per camera and eviction
// ---------------------------------------------------------------------------

test("cap: with 5 adaptation templates on the camera, a better observation evicts the WORST adaptation template only", () => {
  const existing = [0.40, 0.55, 0.30, 0.60, 0.45].map((q, i) => tpl({ id: `A${i}`, quality: q }));
  const better = obs({ quality: 0.50 });
  const plan = planAdaptation([better], existing, ACCEPT_SINGLE);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].evictTemplateId, "A2", "the 0.30 template goes");
  const worse = obs({ quality: 0.30 });
  assert.equal(planAdaptation([worse], existing, ACCEPT_SINGLE).length, 0, "equal to the worst: skipped, no churn");
  assert.equal(planAdaptation([obs({ quality: 0.29 })], existing, ACCEPT_SINGLE).length, 0, "below the worst: skipped");
});

test("cap: manual templates are never evicted and never count against the adaptation cap", () => {
  const manual = [tpl({ id: "M-enrol", source: "enrollment", quality: 0.10 }), tpl({ id: "M-merge", source: "merge", quality: 0.05 })];
  const adaptive = [0.40, 0.55, 0.30, 0.60, 0.45].map((q, i) => tpl({ id: `A${i}`, quality: q }));
  const plan = planAdaptation([obs({ quality: 0.99 })], [...manual, ...adaptive], ACCEPT_SINGLE);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].evictTemplateId, "A2", "the worst ADAPTATION template, not the far worse manual ones");
  // Only manual templates on the camera (any number): nothing to evict, the cap is free.
  const manyManual = Array.from({ length: 7 }, (_, i) => tpl({ id: `M${i}`, source: "enrollment", quality: 0.1 }));
  const p2 = planAdaptation([obs({ quality: 0.9 })], manyManual, ACCEPT_SINGLE);
  assert.equal(p2.length, 1);
  assert.equal(p2[0].evictTemplateId, undefined);
});

test("cap is per employee per camera: other cameras, other employees and camera-less templates do not count", () => {
  const otherCamera = Array.from({ length: 5 }, (_, i) => tpl({ id: `X${i}`, streamId: "cam-entry", quality: 0.9 }));
  const otherEmployee = Array.from({ length: 5 }, (_, i) => tpl({ id: `Y${i}`, employeeId: "E2", quality: 0.9 }));
  const noCamera = Array.from({ length: 5 }, (_, i) => tpl({ id: `Z${i}`, streamId: undefined, source: "enrollment", quality: 0.9 }));
  const plan = planAdaptation([obs({ quality: 0.5 })], [...otherCamera, ...otherEmployee, ...noCamera], ACCEPT_SINGLE);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].evictTemplateId, undefined);
});

test("cap within one batch: an empty camera receives at most maxPerCamera templates, the best by quality; later ones cannot evict them", () => {
  const batch = [0.36, 0.9, 0.5, 0.7, 0.6, 0.8, 0.4].map((q) => obs({ quality: q }));
  const plan = planAdaptation(batch, [], ACCEPT_SINGLE);
  assert.equal(plan.length, 5);
  assert.deepEqual(plan.map((p) => p.observation.quality), [0.9, 0.8, 0.7, 0.6, 0.5]);
  assert.ok(plan.every((p) => p.evictTemplateId === undefined), "nothing existed, nothing evicted");
  const small: AdaptationPolicy = { ...DEFAULT_ADAPTATION_POLICY, maxPerCamera: 2 };
  assert.deepEqual(planAdaptation(batch, [], ACCEPT_SINGLE, small).map((p) => p.observation.quality), [0.9, 0.8]);
});

test("cap within one batch: two better observations evict the two worst adaptation templates, each once", () => {
  const existing = [0.40, 0.55, 0.30, 0.60, 0.45].map((q, i) => tpl({ id: `A${i}`, quality: q }));
  const plan = planAdaptation([obs({ quality: 0.70 }), obs({ quality: 0.42 }), obs({ quality: 0.41 })], existing, ACCEPT_SINGLE);
  assert.deepEqual(plan.map((p) => [p.observation.quality, p.evictTemplateId]), [[0.70, "A2"], [0.42, "A0"]]);
  // 0.41 would only beat the just-planned 0.42 or the remaining 0.45+: skipped.
});

// ---------------------------------------------------------------------------
// Novelty
// ---------------------------------------------------------------------------

test("novelty: an observation within minNovelty of an existing template of the SAME camera is skipped; another camera's template does not block", () => {
  const base = vec(10);
  const nearDuplicate = vec(10, tiltFor(0.97)); // cosine 0.97 >= 1 - 0.05
  const novel = vec(10, tiltFor(0.90)); // cosine 0.90 < 0.95
  const sameCam = [tpl({ id: "S", embedding: base })];
  assert.equal(planAdaptation([obs({ embedding: nearDuplicate })], sameCam, ACCEPT_SINGLE).length, 0, "adds nothing");
  assert.equal(planAdaptation([obs({ embedding: novel })], sameCam, ACCEPT_SINGLE).length, 1, "different enough");
  const otherCam = [tpl({ id: "O", streamId: "cam-entry", embedding: base })];
  assert.equal(planAdaptation([obs({ embedding: nearDuplicate })], otherCam, ACCEPT_SINGLE).length, 1, "novelty is per camera");
  const manualSameCam = [tpl({ id: "M", source: "enrollment", embedding: base })];
  assert.equal(planAdaptation([obs({ embedding: nearDuplicate })], manualSameCam, ACCEPT_SINGLE).length, 0, "manual templates count for novelty too");
});

test("novelty within one batch: near-identical observations yield one template (the higher quality one); exact threshold is inclusive", () => {
  const e = vec(20);
  const twin = vec(20, tiltFor(0.96));
  const plan = planAdaptation([obs({ quality: 0.6, embedding: twin }), obs({ quality: 0.9, embedding: e })], [], ACCEPT_SINGLE);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].observation.quality, 0.9);
  const loose: AdaptationPolicy = { ...DEFAULT_ADAPTATION_POLICY, minNovelty: 0.02 }; // requires cosine < 0.98
  assert.equal(planAdaptation([obs({ quality: 0.6, embedding: twin }), obs({ quality: 0.9, embedding: e })], [], ACCEPT_SINGLE, loose).length, 2);
  const exact = planAdaptation([obs({ embedding: vec(30) })], [tpl({ embedding: vec(30, tiltFor(0.95)) })], ACCEPT_SINGLE);
  assert.equal(exact.length, 0, "cosine exactly 1 - minNovelty is 'too similar'");
});

test("the injected cosine function is what novelty uses", () => {
  const always = () => 1;
  const never = () => 0;
  const existing = [tpl({ embedding: vec(1) })];
  assert.equal(planAdaptation([obs({ embedding: vec(2) })], existing, ACCEPT_SINGLE, DEFAULT_ADAPTATION_POLICY, always).length, 0);
  assert.equal(planAdaptation([obs({ embedding: vec(1) })], existing, ACCEPT_SINGLE, DEFAULT_ADAPTATION_POLICY, never).length, 1);
});

// ---------------------------------------------------------------------------
// Ordering and determinism
// ---------------------------------------------------------------------------

test("ordering: best quality first, then newest; the plan is identical for any input order", () => {
  const a = obs({ faceId: "old-good", quality: 0.9, capturedAt: "2026-09-29T08:00:00.000Z" });
  const b = obs({ faceId: "new-good", quality: 0.9, capturedAt: "2026-09-29T09:00:00.000Z" });
  const c = obs({ faceId: "new-ok", quality: 0.7, capturedAt: "2026-09-29T09:30:00.000Z" });
  const d = obs({ faceId: "too-low", quality: 0.3 });
  const expected = ["new-good", "old-good", "new-ok"];
  const orders = [[a, b, c, d], [d, c, b, a], [c, a, d, b], [b, d, a, c]];
  for (const order of orders) assert.deepEqual(ids(planAdaptation(order, [], ACCEPT_SINGLE)), expected);
  // Existing templates in any order give the same eviction.
  const existing = [0.40, 0.55, 0.30, 0.60, 0.45].map((q, i) => tpl({ id: `A${i}`, quality: q }));
  const e1 = planAdaptation([obs({ quality: 0.5 })], existing, ACCEPT_SINGLE)[0].evictTemplateId;
  const e2 = planAdaptation([obs({ quality: 0.5 })], [...existing].reverse(), ACCEPT_SINGLE)[0].evictTemplateId;
  assert.equal(e1, "A2");
  assert.equal(e2, "A2");
});

test("planAdaptation does not mutate its inputs and carries the observation through unchanged", () => {
  const o = obs({ faceId: "keep", logId: "LOG-1" });
  const existing = [tpl({ id: "T1" })];
  const snapshotO = JSON.stringify(o);
  const snapshotE = JSON.stringify(existing);
  const plan = planAdaptation([o], existing, ACCEPT_SINGLE);
  assert.equal(plan[0].observation, o, "same object: the writer attributes the template to faceId/logId");
  assert.equal(JSON.stringify(o), snapshotO);
  assert.equal(JSON.stringify(existing), snapshotE);
  assert.equal(existing.length, 1, "planned templates are not pushed into the caller's array");
});

test("employees are independent: one employee's full camera does not affect another's", () => {
  const full = Array.from({ length: 5 }, (_, i) => tpl({ id: `E1-${i}`, employeeId: "E1", quality: 0.9 }));
  const plan = planAdaptation([obs({ employeeId: "E1", quality: 0.5 }), obs({ employeeId: "E2", quality: 0.5 })], full, ACCEPT_SINGLE);
  assert.deepEqual(plan.map((p) => p.observation.employeeId), ["E2"]);
});

// ---------------------------------------------------------------------------
// templateCoverage
// ---------------------------------------------------------------------------

test("templateCoverage: per employee, one row per camera in camera order, with total and adaptation counts", () => {
  const cameras = [{ streamId: "cam-entry", gate: "entry" }, { streamId: "cam-exit", gate: "exit" }];
  const templates = [
    { employeeId: "E1", streamId: "cam-entry", source: "enrollment" },
    { employeeId: "E1", streamId: "cam-entry", source: "adaptation" },
    { employeeId: "E1", streamId: "cam-exit", source: "adaptation" },
    { employeeId: "E1", streamId: undefined, source: "enrollment" }, // photo template: no camera
    { employeeId: "E2", streamId: "cam-entry", source: "merge" },
    { employeeId: "E2", streamId: "cam-old", source: "merge" }, // a camera that no longer exists
  ];
  const cov = templateCoverage(templates, cameras);
  assert.deepEqual([...cov.keys()], ["E1", "E2"]);
  assert.deepEqual(cov.get("E1"), [
    { streamId: "cam-entry", gate: "entry", count: 2, adaptation: 1 },
    { streamId: "cam-exit", gate: "exit", count: 1, adaptation: 1 },
  ]);
  assert.deepEqual(cov.get("E2"), [
    { streamId: "cam-entry", gate: "entry", count: 1, adaptation: 0 },
    { streamId: "cam-exit", gate: "exit", count: 0, adaptation: 0 },
  ]);
  assert.deepEqual(templateCoverage([], cameras), new Map(), "no templates, no rows");
  assert.deepEqual(templateCoverage(templates, []).get("E1"), [], "no cameras, empty rows");
});
