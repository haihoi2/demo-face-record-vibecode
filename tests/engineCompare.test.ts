/**
 * Pure helpers of the offline engine-comparison harness
 * (scripts/perf/engineCompareLib.ts, Taiga #513 / #523): candidate-model spec
 * parsing (fail closed on bad contracts), crop preprocessing for a foreign
 * recogniser, pair rules, operating-point metrics incl. the site's strict rule
 * and the reproduction of today's thresholds, drift, detector agreement, the
 * "no vectors in the report" guard, Markdown rendering, and the synthetic
 * fixture's determinism. No models, no I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertNoVectors,
  atThreshold,
  buildPairs,
  cropRgb,
  deniedCrossing,
  describePreprocess,
  detectorAgreement,
  dot,
  driftVsParent,
  l2,
  matchFaces,
  mergeTileDetections,
  nmsFaces,
  parseLicenseSpec,
  parseModelSpec,
  parseParentSpec,
  preprocessCrop,
  preprocessMatchesBaseline,
  renderDeniedTable,
  renderDetectorTable,
  renderRecognizerTable,
  reproduceReference,
  resizeBilinearU8,
  scoreSets,
  summarize,
  suspiciousIdentityPairs,
  thresholdAtFar,
  thresholdAtTar,
  tilePlan,
  type CropEntry,
  type DetFace,
  type RgbU8,
} from "../scripts/perf/engineCompareLib.ts";
import { capture, identityPattern, rng } from "../scripts/perf/engine-compare-fixture.ts";

const LEGACY = { acceptSingle: 0.55, acceptFused: 0.45, minMargin: 0.08 };

// ---------------------------------------------------------------- specs

test("parseModelSpec: defaults are the engine's contract; options override; order-insensitive", () => {
  const d = parseModelSpec("r50=/models/w600k_r50.onnx");
  assert.deepEqual(d, { name: "r50", file: "/models/w600k_r50.onnx", input: 112, mean: [127.5, 127.5, 127.5], std: [127.5, 127.5, 127.5], layout: "NCHW", channels: "rgb" });
  assert.equal(preprocessMatchesBaseline(d), true);
  const c = parseModelSpec("facenet=/c/f.onnx, input=160 ,bgr,layout=nhwc,mean=127.5,std=128");
  assert.equal(c.input, 160);
  assert.equal(c.channels, "bgr");
  assert.equal(c.layout, "NHWC");
  assert.deepEqual(c.std, [128, 128, 128]);
  assert.equal(preprocessMatchesBaseline(c), false);
  const pc = parseModelSpec("x=/m.onnx,mean=123.7/116.3/103.5,std=58.4/57.1/57.4");
  assert.deepEqual(pc.mean, [123.7, 116.3, 103.5]);
  assert.deepEqual(pc.std, [58.4, 57.1, 57.4]);
  assert.equal(describePreprocess(pc), "112px NCHW rgb (x-123.7/116.3/103.5)/58.4/57.1/57.4");
  assert.equal(describePreprocess(d), "112px NCHW rgb (x-127.5)/127.5");
});

test("parseModelSpec: rejects malformed specs instead of guessing", () => {
  for (const bad of ["", "noequals", "=x.onnx", "a=/m.bin", "a b=/m.onnx", "a=/m.onnx,input=7", "a=/m.onnx,input=100.5", "a=/m.onnx,std=0", "a=/m.onnx,layout=CHW", "a=/m.onnx,channels=gray", "a=/m.onnx,mean=1/2", "a=/m.onnx,mean=abc", "a=/m.onnx,bogus", "a=/m.onnx,foo=1"]) {
    assert.throws(() => parseModelSpec(bad), `should reject "${bad}"`);
  }
});

test("parseLicenseSpec / parseParentSpec", () => {
  assert.deepEqual(parseLicenseSpec('r50=MIT code; weights "non-commercial research" (InsightFace)'), { name: "r50", license: 'MIT code; weights "non-commercial research" (InsightFace)' });
  assert.throws(() => parseLicenseSpec("r50="));
  assert.throws(() => parseLicenseSpec("=MIT"));
  assert.deepEqual(parseParentSpec("r50_int8=r50"), { child: "r50_int8", parent: "r50" });
  assert.throws(() => parseParentSpec("r50_int8"));
  assert.throws(() => parseParentSpec("a=b=c"));
});

// ---------------------------------------------------------------- preprocessing

function solidCrop(r: number, g: number, b: number, side = 112): RgbU8 {
  const data = new Uint8Array(side * side * 3);
  for (let i = 0; i < side * side; i++) {
    data[i * 3] = r;
    data[i * 3 + 1] = g;
    data[i * 3 + 2] = b;
  }
  return { width: side, height: side, data };
}
const noResize = (img: RgbU8) => img;

test("preprocessCrop: baseline contract reproduces faceEmbedding's (px-127.5)/127.5 NCHW RGB bytes", () => {
  const crop = solidCrop(255, 0, 127);
  const { data, dims } = preprocessCrop(crop, parseModelSpec("r50=/m.onnx"), noResize);
  assert.deepEqual(dims, [1, 3, 112, 112]);
  const plane = 112 * 112;
  assert.equal(data.length, 3 * plane);
  assert.equal(data[0], 1);
  assert.equal(data[plane], -1);
  assert.ok(Math.abs(data[2 * plane] - (127 - 127.5) / 127.5) < 1e-6);
});

test("preprocessCrop: bgr swaps channels, NHWC interleaves, per-channel mean/std apply to the source channel", () => {
  const crop = solidCrop(10, 20, 30);
  const bgr = preprocessCrop(crop, parseModelSpec("m=/m.onnx,bgr,mean=1/2/3,std=1"), noResize);
  const plane = 112 * 112;
  assert.equal(bgr.data[0], 30 - 3); // first plane = B with B's mean
  assert.equal(bgr.data[plane], 20 - 2);
  assert.equal(bgr.data[2 * plane], 10 - 1);
  const nhwc = preprocessCrop(crop, parseModelSpec("m=/m.onnx,layout=NHWC,mean=0,std=10"), noResize);
  assert.deepEqual(nhwc.dims, [1, 112, 112, 3]);
  assert.deepEqual([...nhwc.data.slice(0, 3)], [1, 2, 3]);
});

test("preprocessCrop: resizes through the injected resizer only when the input differs from 112", () => {
  let calls = 0;
  const spy = (img: RgbU8, w: number, h: number) => {
    calls++;
    return resizeBilinearU8(img, w, h);
  };
  preprocessCrop(solidCrop(1, 2, 3), parseModelSpec("m=/m.onnx"), spy);
  assert.equal(calls, 0);
  const { dims } = preprocessCrop(solidCrop(1, 2, 3), parseModelSpec("m=/m.onnx,input=160"), spy);
  assert.equal(calls, 1);
  assert.deepEqual(dims, [1, 3, 160, 160]);
  assert.throws(() => preprocessCrop({ width: 112, height: 112, data: new Uint8Array(10) }, parseModelSpec("m=/m.onnx"), noResize), /bytes/);
});

test("resizeBilinearU8: identity size is a copy; a solid colour stays solid; a 2x upscale keeps the gradient monotonic", () => {
  const solid = solidCrop(50, 100, 150, 8);
  const up = resizeBilinearU8(solid, 16, 16);
  assert.equal(up.data.length, 16 * 16 * 3);
  assert.ok(up.data.every((v, i) => v === [50, 100, 150][i % 3]));
  const grad: RgbU8 = { width: 4, height: 1, data: new Uint8Array([0, 0, 0, 85, 85, 85, 170, 170, 170, 255, 255, 255]) };
  const g2 = resizeBilinearU8(grad, 8, 1);
  for (let x = 1; x < 8; x++) assert.ok(g2.data[x * 3] >= g2.data[(x - 1) * 3]);
});

test("l2 / dot: unit length, and dot refuses mismatched dims (never compare models' embeddings)", () => {
  const v = l2(new Float32Array([3, 4]));
  assert.ok(Math.abs(v[0] - 0.6) < 1e-6 && Math.abs(v[1] - 0.8) < 1e-6);
  assert.deepEqual([...l2(new Float32Array([0, 0]))], [0, 0]);
  assert.throws(() => dot(new Float32Array(512), new Float32Array(128)), /never compared/);
});

// ---------------------------------------------------------------- pairs and metrics

const E = (n: number, identity: string | null, groupId: string, gate = "ENTRY", source: "log" | "clip" = "log"): CropEntry => ({ n, source, groupId, identity, gate, quality: 0.9 });

test("buildPairs: genuine / cross-gate / withinTrack / strict / probable; same group and stranger-stranger make no pair", () => {
  const entries = [E(0, "EMP-1", "g0"), E(1, "EMP-1", "g1"), E(2, "EMP-1", "g2", "EXIT"), E(3, "EMP-2", "g3"), E(4, null, "g4"), E(5, null, "g5"), E(6, "EMP-1", "g0"), E(7, "EMP-3", "p1/f1", "ENTRY", "clip"), E(8, "EMP-3", "p1/f2", "ENTRY", "clip"), E(9, "stranger:p2", "p2/f1", "ENTRY", "clip")];
  const pairs = buildPairs(entries);
  const kinds = (k: string) => pairs.filter((p) => p.kind === k).map((p) => `${p.a}-${p.b}`);
  assert.deepEqual(kinds("genuine"), ["0-1", "1-6"]);
  assert.deepEqual(kinds("genuineCrossGate"), ["0-2", "1-2", "2-6"]);
  assert.deepEqual(kinds("withinTrack"), ["7-8"]);
  assert.ok(kinds("impostorStrict").includes("0-3") && kinds("impostorStrict").includes("3-7"));
  assert.ok(kinds("impostorProbable").includes("0-4") && kinds("impostorProbable").includes("3-9"));
  assert.ok(!pairs.some((p) => (p.a === 4 && p.b === 5) || (p.a === 0 && p.b === 6) || (p.a === 4 && p.b === 9)));
  // Deterministic: same input, same output.
  assert.deepEqual(buildPairs(entries), pairs);
});

test("scoreSets skips pairs without embeddings and sorts ascending", () => {
  const emb = new Map<number, Float32Array>([
    [0, l2(new Float32Array([1, 0]))],
    [1, l2(new Float32Array([1, 1]))],
    [3, l2(new Float32Array([0, 1]))],
  ]);
  const sets = scoreSets(emb, [
    { a: 0, b: 1, kind: "genuine" },
    { a: 0, b: 3, kind: "impostorStrict" },
    { a: 0, b: 9, kind: "impostorStrict" },
  ]);
  assert.equal(sets.genuine.length, 1);
  assert.deepEqual(sets.impostorStrict, [0]);
});

test("thresholds: FAR=0 sits just above the worst impostor; FAR=1e-3 needs >= 1000 impostors to admit one; TAR threshold is the (1-tar) quantile", () => {
  const imp = [0.1, 0.2, 0.3, 0.4];
  assert.ok(thresholdAtFar(imp, 0) > 0.4 && thresholdAtFar(imp, 0) < 0.4001);
  assert.equal(thresholdAtFar(imp, 1e-3), thresholdAtFar(imp, 0));
  const big = Array.from({ length: 2000 }, (_, i) => i / 2000);
  const t = thresholdAtFar(big, 1e-3);
  assert.equal(big.filter((v) => v >= t).length, 2);
  assert.ok(Number.isNaN(thresholdAtFar([], 0)));
  assert.equal(thresholdAtTar([0.1, 0.5, 0.6, 0.9], 0.5), 0.6);
  assert.equal(thresholdAtTar([0.1, 0.5, 0.6, 0.9], 1), 0.1);
});

test("atThreshold reports TAR, FRR, strict false accepts and the margin to the impostor p95", () => {
  const op = atThreshold([0.3, 0.6, 0.7, 0.8], [0.1, 0.2, 0.3, 0.56], [0.5, 0.6], 0.55);
  assert.equal(op.tar, 0.75);
  assert.equal(op.frr, 0.25);
  assert.equal(op.falseAcceptsStrict, 1);
  assert.equal(op.farStrict, 0.25);
  assert.equal(op.farProbable, 0.5);
  assert.ok(Math.abs(op.marginToImpostorP95 - (0.55 - (0.3 + 0.85 * 0.26))) < 0.002);
});

test("summarize: the site's strict rule is 0 strict false accepts AND at least minMargin above the impostor p95, rounded up to 0.01", () => {
  const sets = { genuine: [0.4, 0.5, 0.6, 0.7, 0.8], genuineCrossGate: [0.45], withinTrack: [], impostorStrict: [0.05, 0.1, 0.15, 0.2, 0.3], impostorProbable: [0.2, 0.25] };
  const m = summarize(sets, LEGACY);
  assert.equal(m.genuine.n, 6);
  assert.equal(m.impostorStrict.max, 0.3);
  assert.equal(m.tarAtFar0.falseAcceptsStrict, 0);
  assert.equal(m.tarAtFar0.tar, 1);
  // p95 of the impostors = 0.28 -> 0.28 + 0.08 = 0.36 -> siteStrict threshold 0.36 (> FAR0 threshold 0.3).
  assert.equal(m.siteStrict.threshold, 0.36);
  assert.equal(m.siteStrict.falseAcceptsStrict, 0);
  assert.ok(m.siteStrict.marginToImpostorP95 >= 0.08);
  assert.equal(m.legacySingle.threshold, 0.55);
  assert.equal(m.legacyFused.threshold, 0.45);
  assert.ok(m.dPrime > 3);
  // When the worst impostor is above p95 + margin, FAR=0 wins.
  const m2 = summarize({ ...sets, impostorStrict: [0.05, 0.05, 0.05, 0.05, 0.5] }, LEGACY);
  assert.equal(m2.siteStrict.threshold, 0.51);
  assert.equal(m2.siteStrict.falseAcceptsStrict, 0);
});

test("reproduceReference: an identical model reproduces today's thresholds (within rounding) and is good enough; a shifted space gets shifted thresholds", () => {
  const sets = { genuine: [0.4, 0.5, 0.56, 0.6, 0.7, 0.8], genuineCrossGate: [], withinTrack: [], impostorStrict: [0.05, 0.1, 0.15, 0.2, 0.3], impostorProbable: [] };
  const ref = { sets, metrics: summarize(sets, LEGACY) };
  const same = reproduceReference("ref", ref, ref, LEGACY);
  assert.equal(same.reference, "ref");
  assert.equal(same.acceptSingle.sameTar.threshold, 0.56);
  assert.equal(same.acceptSingle.recommended.threshold, 0.56);
  assert.equal(same.acceptSingle.recommended.tar, ref.metrics.legacySingle.tar);
  assert.equal(same.goodEnough.verdict, true);
  // Candidate cosines run 0.1 lower: the reproducing thresholds shift down by 0.1.
  const shifted = { genuine: sets.genuine.map((v) => v - 0.1), genuineCrossGate: [], withinTrack: [], impostorStrict: sets.impostorStrict.map((v) => v - 0.1), impostorProbable: [] };
  const cand = { sets: shifted, metrics: summarize(shifted, LEGACY) };
  const rp = reproduceReference("ref", ref, cand, LEGACY);
  assert.ok(Math.abs(rp.acceptSingle.recommended.threshold - 0.46) < 1e-9);
  assert.ok(Math.abs(rp.acceptFused.recommended.threshold - 0.4) < 1e-9);
  assert.equal(rp.goodEnough.verdict, true);
  // A candidate whose impostors reach into the genuine range is not good enough (false accept at the reproduced threshold).
  const bad = { genuine: sets.genuine, genuineCrossGate: [], withinTrack: [], impostorStrict: [0.1, 0.2, 0.3, 0.5, 0.6], impostorProbable: [] };
  const rb = reproduceReference("ref", ref, { sets: bad, metrics: summarize(bad, LEGACY) }, LEGACY);
  assert.equal(rb.goodEnough.verdict, false);
  assert.equal(rb.goodEnough.tarAtFar0WithinTwoPoints, false);
});

test("reproduceReference: with a million strict pairs the reference's FAR comes from its false-accept count, not from the rounded farStrict (4e-5 must not become FAR 0)", () => {
  // 1,000,000 impostors spread 0..0.5, plus 40 at 0.56-0.60 that today's 0.55 lets through (FAR 4e-5 -> r4 rounds to 0).
  const imp: number[] = [];
  for (let i = 0; i < 1_000_000; i++) imp.push((i / 1_000_000) * 0.5);
  for (let i = 0; i < 40; i++) imp.push(0.56 + i * 0.001);
  // 1 impostor far above: the FAR=0 threshold is 0.9 and must NOT be what "same FAR" reproduces.
  imp.push(0.9);
  imp.sort((a, b) => a - b);
  const gen: number[] = [];
  for (let i = 0; i < 1000; i++) gen.push(0.3 + (i / 1000) * 0.6);
  const sets = { genuine: gen, genuineCrossGate: [], withinTrack: [], impostorStrict: imp, impostorProbable: [] };
  const metrics = summarize(sets, LEGACY);
  assert.equal(metrics.legacySingle.falseAcceptsStrict, 41);
  assert.ok(metrics.legacySingle.farStrict > 0 && metrics.legacySingle.farStrict < 1e-4, `farStrict ${metrics.legacySingle.farStrict} keeps 6 decimals`);
  assert.ok(metrics.tarAtFar1e4.threshold < metrics.tarAtFar0.threshold);
  assert.ok(metrics.tarAtFar1e4.falseAcceptsStrict <= 100 && metrics.tarAtFar1e4.falseAcceptsStrict > 41, `FAR=1e-4 admits ${metrics.tarAtFar1e4.falseAcceptsStrict} of 1,000,041`);
  assert.ok(metrics.tarAtFar1e3.falseAcceptsStrict <= 1000 && metrics.tarAtFar1e3.falseAcceptsStrict > metrics.tarAtFar1e4.falseAcceptsStrict);
  const rp = reproduceReference("ref", { metrics }, { sets, metrics }, LEGACY);
  // Same model, same data: the reproduced acceptSingle is today's 0.55 (rounded up to 0.01), not the FAR=0 point at 0.9.
  assert.ok(Math.abs(rp.acceptSingle.sameFar.threshold - 0.55) < 0.011, `sameFar ${rp.acceptSingle.sameFar.threshold}`);
  assert.ok(rp.acceptSingle.recommended.threshold <= 0.58, `recommended ${rp.acceptSingle.recommended.threshold}`);
  assert.equal(rp.acceptSingle.recommended.falseAcceptsStrict > 0, true);
});

test("driftVsParent: identical embeddings drift 0; mismatched dims throw", () => {
  const a = new Map([[1, l2(new Float32Array([1, 2, 3]))], [2, l2(new Float32Array([3, 2, 1]))]]);
  const d = driftVsParent(a, a);
  assert.equal(d.n, 2);
  assert.ok(Math.abs(d.max!) < 1e-6);
  assert.equal(driftVsParent(new Map(), a).n, 0);
  assert.throws(() => driftVsParent(a, new Map([[1, new Float32Array(2)]])), /dims differ/);
});

// ---------------------------------------------------------------- detector agreement

const F = (x: number, y: number, s: number, score = 0.9): DetFace => ({ box: [x, y, x + s, y + s], score, landmarks: [[x + s * 0.3, y + s * 0.4], [x + s * 0.7, y + s * 0.4], [x + s * 0.5, y + s * 0.6], [x + s * 0.35, y + s * 0.8], [x + s * 0.65, y + s * 0.8]] });

test("matchFaces is one-to-one by IoU >= 0.5 and deterministic on ties", () => {
  const ref = [F(0, 0, 100), F(300, 300, 80)];
  const cand = [F(302, 298, 80), F(5, 5, 100), F(900, 900, 70)];
  const m = matchFaces(ref, cand);
  assert.equal(m.get(0)!.j, 1);
  assert.equal(m.get(1)!.j, 0);
  assert.deepEqual([...matchFaces(ref, cand).entries()], [...m.entries()]);
  assert.equal(matchFaces([F(0, 0, 100)], [F(60, 60, 100)]).size, 0);
});

test("detectorAgreement: recall, extras, missed sizes and landmark error only for faces >= minPx", () => {
  const ref = [[F(0, 0, 100), F(300, 300, 80), F(500, 500, 40)], [F(10, 10, 120)]];
  const cand = [[F(2, 2, 100), F(900, 900, 70)], []];
  const a = detectorAgreement(ref, cand, 60);
  assert.equal(a.refFaces, 3); // the 40 px face does not count
  assert.equal(a.found, 1);
  assert.equal(a.recall, 0.333);
  assert.equal(a.extra, 1);
  assert.deepEqual(a.missedSizes, [80, 120]);
  assert.ok(a.landmarkErrPct.p50! > 0 && a.landmarkErrPct.p50! < 5);
  assert.ok(a.iou.min! > 0.9);
});

// ---------------------------------------------------------------- report guards and rendering

test("assertNoVectors refuses embeddings and binary data but accepts aggregates and short lists", () => {
  assertNoVectors({ a: { p50: 0.5, missedSizes: [60, 70, 80] }, b: ["x", "y"], c: null });
  assert.throws(() => assertNoVectors({ m: { emb: Array.from({ length: 512 }, () => 0.1) } }), /numeric array of 512 at \$\.m\.emb/);
  assert.throws(() => assertNoVectors({ e: new Float32Array(4) }), /binary data/);
  assert.throws(() => assertNoVectors([{ x: Buffer.alloc(3) }]), /binary data at \$\[0\]\.x/);
});

test("renderRecognizerTable / renderDetectorTable: one row per model, pipes escaped, '(ref)' for the reference", () => {
  const sets = { genuine: [0.5, 0.6, 0.7], genuineCrossGate: [], withinTrack: [], impostorStrict: [0.1, 0.2], impostorProbable: [0.15] };
  const metrics = summarize(sets, LEGACY);
  const md = renderRecognizerTable(
    [
      { name: "r50", license: "MIT code | weights research-only", fileMB: 174.4, dim: 512, preprocess: "engine", metrics, reproduction: null, latencyMs: { threads1: 200, threads2: 120 } },
      { name: "cand", license: "cần kiểm tra", fileMB: 10, dim: 128, preprocess: "160px NHWC bgr (x-0)/1", metrics, reproduction: reproduceReference("r50", { metrics }, { sets, metrics }, LEGACY), drift: null, latencyMs: { threads1: 20 }, identicalToRef: true },
    ],
    [1, 2],
  );
  const lines = md.split("\n");
  assert.equal(lines.length, 4);
  assert.ok(lines[0].startsWith("| model | license | MB | dim | preprocess |"));
  assert.ok(lines[2].includes("| r50 | MIT code \\| weights research-only | 174.4 | 512 | engine |"));
  assert.ok(lines[2].endsWith("| 200 / 120 | (ref) |"));
  assert.ok(lines[3].includes("| cand | cần kiểm tra | 10 | 128 |") && lines[3].includes("| 20 / - | yes (identical to ref) |"));
  const det = renderDetectorTable(
    [
      { size: 640, facesAll: 5, facesAtLeastMin: 4, msPerFrame: { n: 3, p50: 80, p95: 90 }, vsRef: detectorAgreement([[F(0, 0, 100)]], [[F(1, 1, 100)]], 60) },
      { size: 1280, facesAll: 6, facesAtLeastMin: 5, msPerFrame: { n: 3, p50: 300, p95: 330 }, vsRef: null },
    ],
    1280,
    60,
    2,
  );
  assert.ok(det.split("\n")[0].includes("recall vs 1280"));
  assert.ok(det.includes("| 640 | 5 / 4 | 1/1 (100%) | 0 |"));
  assert.ok(det.includes("| 1280 | 6 / 5 | (ref) |"));
});

// ---------------------------------------------------------------- synthetic fixture

test("fixture: deterministic for a seed, 112x112x3, and the same identity's captures are closer than different identities' (so the pairing has signal)", () => {
  const a = identityPattern(rng(7));
  const b = identityPattern(rng(7));
  assert.deepEqual(a.data, b.data);
  const other = identityPattern(rng(8));
  assert.notDeepEqual(a.data, other.data);
  const r = rng(3);
  const c1 = capture(a, r);
  const c2 = capture(a, r);
  const c3 = capture(other, r);
  assert.equal(c1.data.length, 112 * 112 * 3);
  const f = (img: RgbU8) => l2(Float32Array.from(img.data, (v) => v - 128));
  assert.ok(dot(f(c1), f(c2)) > dot(f(c1), f(c3)));
});

// ---------------------------------------------------------------- tiled detection (#523)

test("tilePlan: two horizontal halves share 10% of the width, cover the frame exactly, and degenerate to one tile", () => {
  const t = tilePlan(3840, 2160, 2, 0.1);
  assert.equal(t.length, 2);
  assert.deepEqual(t[0], { x: 0, y: 0, w: 2112, h: 2160 });
  assert.deepEqual(t[1], { x: 1728, y: 0, w: 2112, h: 2160 });
  assert.equal(t[0].x + t[0].w - t[1].x, 384); // overlap = 10% of 3840
  assert.equal(t[1].x + t[1].w, 3840);
  assert.deepEqual(tilePlan(1920, 1080, 1), [{ x: 0, y: 0, w: 1920, h: 1080 }]);
  const three = tilePlan(1920, 1080, 3, 0);
  assert.deepEqual(three.map((r) => r.x), [0, 640, 1280]);
  assert.ok(three.every((r) => r.w === 640 && r.h === 1080));
  assert.throws(() => tilePlan(100, 100, 0));
  assert.throws(() => tilePlan(100, 100, 2, 0.5));
});

test("cropRgb: pixel-exact window; refuses a rect outside the image", () => {
  const img: RgbU8 = { width: 4, height: 2, data: Uint8Array.from({ length: 24 }, (_, i) => i) };
  const c = cropRgb(img, { x: 1, y: 0, w: 2, h: 2 });
  assert.equal(c.width, 2);
  assert.equal(c.height, 2);
  assert.deepEqual([...c.data], [3, 4, 5, 6, 7, 8, 15, 16, 17, 18, 19, 20]);
  assert.throws(() => cropRgb(img, { x: 3, y: 0, w: 2, h: 2 }), /outside/);
  assert.throws(() => cropRgb(img, { x: 0, y: 0, w: 0, h: 2 }), /outside/);
});

test("nmsFaces keeps the higher score of overlapping boxes; mergeTileDetections shifts tile detections to frame coordinates and dedups the overlap", () => {
  const kept = nmsFaces([F(0, 0, 100, 0.8), F(5, 5, 100, 0.95), F(500, 500, 60, 0.7)], 0.4);
  assert.deepEqual(kept.map((f) => f.score), [0.95, 0.7]);
  const rects = tilePlan(1000, 500, 2, 0.2); // tiles at x=0 and x=400, each 600 wide
  assert.deepEqual(rects.map((r) => r.x), [0, 400]);
  // the same face sits in the overlap: at x=450 in the frame = 450 in tile 0 and 50 in tile 1
  const merged = mergeTileDetections([[F(450, 100, 80, 0.9), F(10, 10, 70, 0.6)], [F(52, 101, 80, 0.93), F(500, 300, 90, 0.8)]], rects);
  assert.equal(merged.length, 3);
  const boxes = merged.map((f) => f.box.map(Math.round)).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(boxes, [[10, 10, 80, 80], [452, 101, 532, 181], [900, 300, 990, 390]]);
  const seam = merged.find((f) => Math.round(f.box[0]) === 452)!;
  assert.equal(seam.score, 0.93); // tile 1's higher-scored copy won
  assert.deepEqual(seam.landmarks[0].map(Math.round), [452 + 24, 101 + 32]); // landmarks shifted with the box
  assert.throws(() => mergeTileDetections([[]], rects), /tile results/);
});

// ---------------------------------------------------------------- denied group and label radar

test("deniedCrossing: best cosine per denied crop against the employee crops; counts per named threshold; missing embeddings are skipped", () => {
  const e = (...v: number[]) => l2(Float32Array.from(v));
  const emb = new Map<number, Float32Array>([
    [1, e(1, 0, 0)], // EMP-a
    [2, e(0, 1, 0)], // EMP-b
    [10, e(1, 0.2, 0)], // denied, close to EMP-a (cos ~0.98)
    [11, e(0.3, 0.3, 1)], // denied, far from both (cos ~0.28)
  ]);
  const d = deniedCrossing(emb, [10, 11, 12], [1, 2, 3], { single: 0.55, fused: 0.45, lax: 0.2 });
  assert.equal(d.crops, 2);
  assert.equal(d.galleryCrops, 2);
  assert.equal(d.bestCosine.n, 2);
  assert.ok(d.bestCosine.max! > 0.97 && d.bestCosine.min! < 0.3);
  assert.deepEqual(d.crossing.single, { threshold: 0.55, count: 1, share: 0.5 });
  assert.deepEqual(d.crossing.fused, { threshold: 0.45, count: 1, share: 0.5 });
  assert.deepEqual(d.crossing.lax, { threshold: 0.2, count: 2, share: 1 });
  const md = renderDeniedTable([{ name: "r50", d }]);
  assert.ok(md.split("\n")[0].startsWith("| model | denied crops | best cosine p50/p95/max | cross @single (thr) | cross @fused (thr) | cross @lax (thr) |"));
  assert.ok(md.includes("| r50 | 2 |") && md.includes("| 1 (0.55) | 1 (0.45) | 2 (0.2) |"));
  assertNoVectors(d);
  const empty = deniedCrossing(emb, [], [1], { single: 0.55 });
  assert.equal(empty.crops, 0);
  assert.deepEqual(empty.crossing.single, { threshold: 0.55, count: 0, share: NaN });
});

test("suspiciousIdentityPairs: identity pairs whose strict-impostor cosines reach the threshold, counts only, sorted by count then max", () => {
  const entries: CropEntry[] = [
    { n: 1, source: "log", groupId: "g1", identity: "EMP-a", gate: "entry", quality: 1 },
    { n: 2, source: "log", groupId: "g2", identity: "EMP-a", gate: "entry", quality: 1 },
    { n: 3, source: "log", groupId: "g3", identity: "EMP-b", gate: "entry", quality: 1 },
    { n: 4, source: "log", groupId: "g4", identity: "EMP-c", gate: "entry", quality: 1 },
    { n: 5, source: "log", groupId: "g5", identity: null, gate: "entry", quality: 1, status: "DENIED" },
  ];
  const e = (...v: number[]) => l2(Float32Array.from(v));
  const emb = new Map<number, Float32Array>([
    [1, e(1, 0, 0)],
    [2, e(1, 0.1, 0)],
    [3, e(1, 0.3, 0)], // EMP-b looks like EMP-a (cos ~0.96)
    [4, e(0, 0, 1)], // EMP-c orthogonal
    [5, e(1, 0, 0)], // denied crop identical to EMP-a: not a strict pair, must not appear
  ]);
  const s = suspiciousIdentityPairs(emb, buildPairs(entries), entries, 0.55);
  assert.deepEqual(s.map((x) => [x.a, x.b, x.pairsAbove]), [["EMP-a", "EMP-b", 2]]);
  assert.ok(s[0].max > 0.95 && s[0].max <= 1);
  assert.deepEqual(suspiciousIdentityPairs(emb, buildPairs(entries), entries, 0.999), []);
  assertNoVectors(s);
});
