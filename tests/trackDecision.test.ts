/**
 * Unit tests for per-track decisions (src/server/pipeline/trackDecision.ts):
 * one outcome per person per passage, existing fusion rules, fail closed.
 * Synthetic detections and embeddings only - no models, no I/O.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { FaceDetection, Frame } from "../src/server/pipeline/contracts";
import { DEFAULT_FUSION_THRESHOLDS, FaceGallery, recognizeObservations } from "../src/server/faceFusion";
import {
  DecisionContext,
  GateTrackSession,
  TrackDecider,
  TrackDecisionResult,
  qualityWeightedMean,
  validateDecisionContext,
} from "../src/server/pipeline/trackDecision";
import type { TrackedFace, TrackerStep } from "../src/server/pipeline/tracker";

const TAG = "arcface_test";
const DIMS = 512;
const T0 = 2_000_000;
const DT = 125; // 8 fps
const PROCESS_MS = 40; // simulated processing time after capture

// --- synthetic data --------------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function norm(v: number[]): number[] {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}
function randUnit(seed: number): number[] {
  const r = rng(seed);
  const v: number[] = [];
  for (let i = 0; i < DIMS; i++) v.push(Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()));
  return norm(v);
}
function orthTo(v: number[], bases: number[][]): number[] {
  let out = [...v];
  for (const b of bases) {
    const d = out.reduce((s, x, i) => s + x * b[i], 0);
    out = out.map((x, i) => x - d * b[i]);
  }
  return norm(out);
}
/** Unit vector with cosine exactly `c` to unit `base`. */
function mix(base: number[], c: number, noiseSeed: number): number[] {
  const orth = orthTo(randUnit(noiseSeed), [base]);
  const s = Math.sqrt(1 - c * c);
  return base.map((b, i) => c * b + s * orth[i]);
}
const cos = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/**
 * A passage of a person: a session vector at cosine `toTemplate` from their
 * enrolled template; each camera frame is close to the session vector (0.95),
 * as ArcFace frames of one walk are to each other.
 */
function passage(template: number[], toTemplate: number, seed: number) {
  const session = mix(template, toTemplate, seed);
  return (frameSeed: number) => Float32Array.from(mix(session, 0.95, seed * 1000 + frameSeed));
}

const E1 = randUnit(11);
const E2 = randUnit(22);
const E3 = randUnit(33);
// Two employees who look alike (templates at cosine 0.9).
const TWIN_A = randUnit(44);
const TWIN_B = mix(TWIN_A, 0.9, 55);
const GALLERY: FaceGallery = new Map([
  ["E1", [E1]],
  ["E2", [E2]],
  ["E3", [E3]],
  ["TWIN_A", [TWIN_A]],
  ["TWIN_B", [TWIN_B]],
]);

function ctx(over: Partial<DecisionContext> = {}): DecisionContext {
  return {
    gallery: GALLERY, galleryModelTag: TAG, engineModelTag: TAG,
    thresholds: { ...DEFAULT_FUSION_THRESHOLDS }, engineReady: true, ...over,
  };
}

function frame(seq: number, t = T0 + seq * DT): Frame {
  return {
    gate: "EXIT", streamId: "exit-main", seq, capturedAtMs: t, width: 1920, height: 1080,
    roi: [0, 0, 1920, 1080], sourceWidth: 1920, sourceHeight: 1080, rgb: new Uint8Array(0),
  };
}
function det(cx: number, cy: number, size: number, clear = size >= 60): FaceDetection {
  const s = size;
  return {
    box: [cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2],
    landmarks: [[cx - 0.2 * s, cy - 0.1 * s], [cx + 0.2 * s, cy - 0.1 * s], [cx, cy + 0.05 * s], [cx - 0.15 * s, cy + 0.25 * s], [cx + 0.15 * s, cy + 0.25 * s]],
    score: 0.9, sizePx: s, clear,
  };
}

interface Face {
  d: FaceDetection;
  q?: number;
  who?: (seed: number) => Float32Array;
  /** Embed even when the tracker did not ask (a misbehaving caller). */
  force?: boolean;
}

class Harness {
  now = T0;
  readonly session: GateTrackSession;
  readonly results: TrackDecisionResult[] = [];
  embeddingsRun = 0;
  constructor(context: DecisionContext = ctx(), modelTag = TAG) {
    this.session = new GateTrackSession({ gate: "EXIT", modelTag, context, clock: () => this.now, idPrefix: "X" });
  }
  frame(seq: number, faces: Face[], t = T0 + seq * DT): TrackDecisionResult[] {
    const f = frame(seq, t);
    this.now = t + PROCESS_MS;
    const plain = faces.map((x) => ({ detection: x.d, quality: x.q ?? 0.6 }));
    const plan = this.session.plan(f, plain);
    const inputs = faces.map((x, i) => {
      if (!x.who || !(plan.needsEmbedding[i] || x.force)) return plain[i];
      this.embeddingsRun += 1;
      return { ...plain[i], embedding: x.who(seq * 7 + i), embeddingModelTag: TAG };
    });
    const { results } = this.session.process(f, inputs);
    this.results.push(...results);
    return results;
  }
  tick(t: number): TrackDecisionResult[] {
    this.now = t;
    const r = this.session.tick(t);
    this.results.push(...r);
    return r;
  }
  close(t: number): TrackDecisionResult[] {
    this.now = t;
    const r = this.session.close(t);
    this.results.push(...r);
    return r;
  }
}

// --- tests -------------------------------------------------------------------

describe("trackDecision: employees", () => {
  it("a single walker is decided within 2 usable frames (multi-agree), exactly once", () => {
    const h = new Harness();
    const walk = passage(E1, 0.52, 1); // each frame ~0.49: below acceptSingle, above acceptFused
    assert.deepEqual(h.frame(0, [{ d: det(900, 500, 70), who: walk }]), []);
    const r = h.frame(1, [{ d: det(905, 510, 72), who: walk }]);
    assert.equal(r.length, 1);
    const [res] = r;
    assert.equal(res.outcome.kind, "employee");
    assert.ok(res.outcome.kind === "employee" && res.outcome.employeeId === "E1");
    assert.equal(res.basis, "multi-agree");
    assert.equal(res.shadow.outcome, "employee");
    assert.equal(res.shadow.employeeId, "E1");
    assert.equal(res.shadow.firstSeenAtMs, T0);
    assert.equal(res.shadow.firstUsableAtMs, T0);
    assert.equal(res.shadow.decidedAtMs, T0 + DT + PROCESS_MS);
    assert.equal(res.shadow.framesSeen, 2);
    assert.equal(res.shadow.framesUsed, 2);
    assert.equal(h.embeddingsRun, 2);
    if (res.outcome.kind === "employee") {
      assert.equal(res.outcome.best.detection.sizePx, 70);
      assert.equal(res.outcome.decidedAtMs, T0 + DT + PROCESS_MS);
      assert.ok(!JSON.stringify(res.outcome.fused).includes("embedding"), "no embeddings in fusion evidence");
    }
  });

  it("one strong view decides at confirmation (single-strong)", () => {
    const h = new Harness();
    const walk = passage(E2, 0.78, 2);
    assert.deepEqual(h.frame(0, [{ d: det(900, 500, 90), who: walk }]), [], "tentative tracks never decide");
    const r = h.frame(1, [{ d: det(900, 505, 90), who: walk }]);
    assert.equal(r.length, 1);
    assert.equal(r[0].basis, "single-strong");
    assert.ok(r[0].outcome.kind === "employee" && r[0].outcome.employeeId === "E2");
  });

  it("a person lingering 30 s produces one outcome and no more embeddings after it", () => {
    const h = new Harness();
    const walk = passage(E3, 0.6, 3);
    for (let i = 0; i < 240; i++) h.frame(i, [{ d: det(900 + (i % 4), 500, 90), q: 0.4 + (i % 10) * 0.05, who: walk }]);
    const last = T0 + 239 * DT;
    h.tick(last + 2500);
    h.close(last + 3000);
    assert.equal(h.results.length, 1);
    assert.equal(h.results[0].outcome.kind, "employee");
    assert.equal(h.embeddingsRun, 2, "evidence closes once decided");
  });

  it("counts the delay from the first usable frame, not from the first sighting", () => {
    const h = new Harness();
    const walk = passage(E1, 0.52, 4);
    h.frame(0, [{ d: det(900, 300, 40), who: walk }]);
    h.frame(1, [{ d: det(900, 320, 48), who: walk }]);
    h.frame(2, [{ d: det(900, 340, 55), who: walk }]);
    assert.equal(h.results.length, 0);
    h.frame(3, [{ d: det(900, 360, 62), who: walk }]);
    const r = h.frame(4, [{ d: det(900, 380, 66), who: walk }]);
    assert.equal(r.length, 1);
    assert.equal(r[0].shadow.firstSeenAtMs, T0);
    assert.equal(r[0].shadow.firstUsableAtMs, T0 + 3 * DT);
    assert.equal(r[0].shadow.framesSeen, 5);
    assert.equal(r[0].shadow.framesUsed, 2);
  });

  it("two similar employees (margin < 0.08) are never granted", () => {
    // Every frame prefers TWIN_A, but only by ~0.04 over TWIN_B.
    const lean = norm(TWIN_A.map((x, i) => 0.8 * x + 0.2 * TWIN_B[i]));
    const walk = passage(lean, 0.75, 5);
    const probes = [0, 1, 2, 3].map((k) => walk(k));
    for (const p of probes) {
      const margin = cos(p, TWIN_A) - cos(p, TWIN_B);
      assert.ok(margin > 0 && margin < DEFAULT_FUSION_THRESHOLDS.minMargin, `margin ${margin}`);
      assert.ok(cos(p, TWIN_A) > DEFAULT_FUSION_THRESHOLDS.acceptSingle);
    }
    // faceFusion itself refuses this since the lookalike hotfix (550e568): the
    // multi-agree rule now checks each frame's own runner-up. It used to grant.
    const fusedOnly = recognizeObservations(
      probes.slice(0, 2).map((p, k) => ({ streamId: "s", frameIndex: k, embedding: Array.from(p), quality: 0.6, detectorScore: 0.9 })),
      GALLERY,
      DEFAULT_FUSION_THRESHOLDS,
    );
    assert.equal(fusedOnly.recognized, false);
    assert.equal(fusedOnly.basis, "rejected-ambiguous");

    // The tracker refuses too (fusion first; the track-mean check stays as a second guard).
    const h = new Harness();
    for (let i = 0; i < 16; i++) h.frame(i, [{ d: det(900, 500, 80), q: 0.3 + i * 0.05, who: walk }]);
    assert.equal(h.results.length, 0, "no early employee outcome");
    const end = h.tick(T0 + 15 * DT + 2000);
    assert.equal(end.length, 1);
    assert.notEqual(end[0].outcome.kind, "employee");
    assert.equal(end[0].fusionBasis, "rejected-ambiguous");
  });

  it("two similar employees split frame by frame are refused by fusion itself", () => {
    const h = new Harness();
    const mid = norm(TWIN_A.map((x, i) => x + TWIN_B[i]));
    const walk = passage(mid, 0.75, 5);
    for (let i = 0; i < 16; i++) h.frame(i, [{ d: det(900, 500, 80), q: 0.3 + i * 0.05, who: walk }]);
    const end = h.tick(T0 + 15 * DT + 2000);
    assert.equal(h.results.length, 1);
    assert.notEqual(end[0].outcome.kind, "employee");
  });

  it("two people at once: the employee early, the stranger at the end, one each", () => {
    const h = new Harness();
    const emp = passage(E1, 0.6, 6);
    const unknown = passage(randUnit(777), 0.9, 7);
    for (let i = 0; i < 12; i++) {
      h.frame(i, [
        { d: det(500, 500 + 4 * i, 80), who: emp },
        { d: det(1300, 520 + 4 * i, 80), who: unknown },
      ]);
    }
    assert.equal(h.results.length, 1);
    assert.equal(h.results[0].outcome.kind, "employee");
    h.tick(T0 + 11 * DT + 2000);
    assert.equal(h.results.length, 2);
    assert.equal(h.results[1].outcome.kind, "stranger");
    assert.notEqual(h.results[0].outcome.trackId, h.results[1].outcome.trackId);
  });

  it("two employees crossing each get their own identity", () => {
    const h = new Harness();
    const a = passage(E1, 0.6, 8);
    const b = passage(E2, 0.6, 9);
    for (let i = 0; i < 20; i++) {
      h.frame(i, [
        { d: det(400 + 40 * i, 500, 80), who: a },
        { d: det(1200 - 40 * i, 540, 80), who: b },
      ]);
    }
    h.tick(T0 + 19 * DT + 2000);
    const ids = h.results.map((r) => (r.outcome.kind === "employee" ? r.outcome.employeeId : r.outcome.kind)).sort();
    assert.deepEqual(ids, ["E1", "E2"]);
  });
});

describe("trackDecision: strangers and insufficient evidence", () => {
  it("a stranger is decided once, at track end, with a normalised mean embedding", () => {
    const h = new Harness();
    const walk = passage(randUnit(888), 0.9, 10);
    for (let i = 0; i < 10; i++) h.frame(i, [{ d: det(900, 500 + 5 * i, 70 + 3 * i), q: 0.3 + 0.05 * i, who: walk }]);
    assert.equal(h.results.length, 0, "no stranger while the person is still in view");
    const last = T0 + 9 * DT;
    assert.deepEqual(h.tick(last + 1999), []);
    const r = h.tick(last + 2000);
    assert.equal(r.length, 1);
    const out = r[0].outcome;
    assert.equal(out.kind, "stranger");
    if (out.kind === "stranger") {
      assert.equal(out.embedding.length, DIMS);
      assert.ok(Math.abs(Math.hypot(...out.embedding) - 1) < 1e-4);
      assert.equal(out.decidedAtMs, last + 2000);
      assert.equal(out.best.detection.sizePx, 97, "best = highest-quality clear face");
    }
    assert.equal(r[0].shadow.outcome, "stranger");
    assert.ok(r[0].shadow.framesUsed >= 2 && r[0].shadow.framesUsed <= 5);
    assert.deepEqual(h.tick(last + 5000), []);
    assert.deepEqual(h.close(last + 6000), []);
  });

  it("insufficient when fewer than 2 usable frames were seen", () => {
    const h = new Harness();
    const walk = passage(randUnit(999), 0.9, 11);
    h.frame(0, [{ d: det(900, 500, 45), who: walk }]);
    h.frame(1, [{ d: det(900, 510, 50), who: walk }]);
    h.frame(2, [{ d: det(900, 520, 64), who: walk }]); // the only usable frame
    h.frame(3, [{ d: det(900, 530, 64, false), who: walk }]); // turned away
    const r = h.tick(T0 + 3 * DT + 2000);
    assert.equal(r.length, 1);
    assert.equal(r[0].outcome.kind, "insufficient");
    assert.equal(r[0].basis, "insufficient-evidence");
    assert.equal(r[0].shadow.framesUsed, 1);
  });

  it("far (< 60 px) frames never decide, even when a caller embeds them", () => {
    const h = new Harness();
    const walk = passage(E1, 0.9, 12); // would be a certain match
    for (let i = 0; i < 12; i++) h.frame(i, [{ d: det(900, 500, 50, true), who: walk, force: true }]);
    assert.equal(h.results.length, 0);
    const r = h.tick(T0 + 11 * DT + 2000);
    assert.equal(r.length, 1);
    assert.equal(r[0].outcome.kind, "insufficient");
    assert.equal(r[0].shadow.framesUsed, 0);
    assert.equal(r[0].shadow.firstUsableAtMs, undefined);
  });

  it("a low-quality stranger is insufficient, not stored as a stranger", () => {
    const h = new Harness();
    const walk = passage(randUnit(1234), 0.9, 13);
    for (let i = 0; i < 6; i++) h.frame(i, [{ d: det(900, 500, 70), q: 0.2, who: walk }]);
    const r = h.tick(T0 + 5 * DT + 2000);
    assert.equal(r[0].outcome.kind, "insufficient");
    assert.equal(r[0].basis, "insufficient-quality");
  });

  it("a stranger the detector is unsure of (score < 0.80) is insufficient, not stored", () => {
    const h = new Harness();
    const walk = passage(randUnit(4321), 0.9, 17);
    for (let i = 0; i < 6; i++) h.frame(i, [{ d: { ...det(900, 500, 80), score: 0.72 }, q: 0.6, who: walk }]);
    const r = h.tick(T0 + 5 * DT + 2000);
    assert.equal(r[0].outcome.kind, "insufficient");
    assert.equal(r[0].basis, "insufficient-quality");
  });

  it("the detector-score floor is storage only: an employee is still recognised at a low score", () => {
    const h = new Harness();
    const walk = passage(E1, 0.52, 18);
    h.frame(0, [{ d: { ...det(900, 500, 70), score: 0.6 }, who: walk }]);
    const r = h.frame(1, [{ d: { ...det(905, 510, 72), score: 0.6 }, who: walk }]);
    assert.equal(r.length, 1);
    assert.equal(r[0].outcome.kind, "employee");
  });

  it("detector flicker (a single-frame track) produces no outcome", () => {
    const h = new Harness();
    h.frame(0, [{ d: det(900, 500, 80), who: passage(E1, 0.9, 14) }]);
    assert.deepEqual(h.tick(T0 + 1000), []);
    assert.deepEqual(h.close(T0 + 3000), []);
  });

  it("frames without faces produce nothing", () => {
    const h = new Harness();
    for (let i = 0; i < 20; i++) assert.deepEqual(h.frame(i, []), []);
    assert.deepEqual(h.tick(T0 + 10_000), []);
  });

  it("an empty gallery makes every confirmed walker a stranger", () => {
    const h = new Harness(ctx({ gallery: new Map() }));
    const walk = passage(E1, 0.9, 15);
    for (let i = 0; i < 4; i++) h.frame(i, [{ d: det(900, 500, 80), who: walk }]);
    const r = h.tick(T0 + 3 * DT + 2000);
    assert.equal(r[0].outcome.kind, "stranger");
  });
});

describe("trackDecision: fail closed", () => {
  const strongWalk = () => passage(E1, 0.85, 20);

  function runStrong(h: Harness): TrackDecisionResult[] {
    const walk = strongWalk();
    for (let i = 0; i < 6; i++) h.frame(i, [{ d: det(900, 500, 90), who: walk }]);
    return h.tick(T0 + 5 * DT + 2000);
  }

  it("a gallery of another model tag never grants and never stores a stranger", () => {
    const h = new Harness(ctx({ galleryModelTag: "arcface_old" }));
    assert.equal(h.session.decider.contextStatus().ok, false);
    const r = runStrong(h);
    assert.equal(h.results.length, 1);
    assert.equal(r[0].outcome.kind, "insufficient");
    assert.equal(r[0].basis, "context-invalid");
  });

  it("embeddings from a tracker running another model are ignored", () => {
    const h = new Harness(ctx({ galleryModelTag: "arcface_other", engineModelTag: "arcface_other" }), TAG);
    assert.equal(h.session.decider.contextStatus().ok, true);
    assert.equal(h.session.contextStatus().ok, false);
    const r = runStrong(h);
    assert.equal(r[0].outcome.kind, "insufficient");
    assert.equal(r[0].shadow.framesUsed, 0);
  });

  it("an engine that is not ready never grants; the decision resumes once it is", () => {
    const h = new Harness(ctx({ engineReady: false }));
    const walk = strongWalk();
    for (let i = 0; i < 3; i++) h.frame(i, [{ d: det(900, 500, 90), who: walk }]);
    assert.equal(h.results.length, 0);
    assert.equal(h.session.setContext(ctx()).ok, true);
    const r = h.frame(3, [{ d: det(900, 500, 90), who: walk }]);
    assert.equal(r.length, 1);
    assert.ok(r[0].outcome.kind === "employee" && r[0].outcome.employeeId === "E1");
  });

  it("invalid thresholds fail closed", () => {
    for (const bad of [
      { ...DEFAULT_FUSION_THRESHOLDS, acceptSingle: NaN },
      { ...DEFAULT_FUSION_THRESHOLDS, minAgreeing: 0 },
      { ...DEFAULT_FUSION_THRESHOLDS, acceptFused: 1.2 },
      { ...DEFAULT_FUSION_THRESHOLDS, minMargin: -0.1 },
      undefined as never,
    ]) {
      assert.equal(validateDecisionContext(ctx({ thresholds: bad })).status.ok, false);
    }
    const h = new Harness(ctx({ thresholds: { ...DEFAULT_FUSION_THRESHOLDS, minAgreeing: 0 } }));
    assert.equal(runStrong(h)[0].basis, "context-invalid");
  });

  it("uses the server's thresholds, not its own", () => {
    // Raising acceptSingle/acceptFused above the walker's scores must refuse.
    const h = new Harness(ctx({ thresholds: { ...DEFAULT_FUSION_THRESHOLDS, acceptSingle: 0.95, acceptFused: 0.95 } }));
    const r = runStrong(h);
    assert.equal(h.results.length, 1);
    assert.notEqual(r[0].outcome.kind, "employee");
  });

  it("drops malformed gallery templates and reports them", () => {
    const gallery: FaceGallery = new Map([
      ["E1", [E1, E1.slice(0, 128), E1.map(() => NaN)]],
      ["", [E2]],
    ]);
    const { status, valid } = validateDecisionContext(ctx({ gallery }));
    assert.equal(status.ok, true);
    assert.equal(status.droppedTemplates, 3);
    assert.equal(valid!.gallery.get("E1")!.length, 1);
    assert.equal(status.employees, 1);
    assert.equal(validateDecisionContext(ctx({ gallery: undefined as never })).status.ok, false);
    assert.equal(validateDecisionContext(null).status.ok, false);
  });

  it("the track-mean check can refuse a fused accept (identity-mixed evidence)", () => {
    // Built by hand: the tracker's identity guard would not let these frames
    // share a track. Frames a, b match E1 (0.47) and lean to E2 (0.34); frame c
    // matches E2 (0.36). Per-frame fusion accepts E1 (multi-agree, margin 0.11)
    // but the mean of the three points to E2: refuse.
    const rest = (seed: number) => orthTo(randUnit(seed), [E1, E2]);
    const build = (c1: number, c2: number, seed: number) => {
      const r = rest(seed);
      const s = Math.sqrt(1 - c1 * c1 - c2 * c2);
      return Float32Array.from(E1.map((x, i) => c1 * x + c2 * E2[i] + s * r[i]));
    };
    const vecs = [build(0.47, 0.34, 1), build(0.47, 0.34, 2), build(0.02, 0.36, 3)];
    const decider = new TrackDecider({ gate: "EXIT", context: ctx({ gallery: new Map([["E1", [E1]], ["E2", [E2]]]) }), clock: () => T0 });
    const f = frame(0);
    const updates: TrackedFace[] = vecs.map((embedding, i) => ({
      trackId: "M-1", frame: frame(i), detection: det(900, 500, 80), quality: 0.6, embedding,
      detectionIndex: 0, state: "confirmed", usable: true, selectScore: 0.6, newTrack: i === 0, embeddingStatus: "evidence",
    }));
    const stepOf = (u: TrackedFace[]): TrackerStep => ({
      gate: "EXIT", modelTag: TAG, frameSeq: f.seq, atMs: f.capturedAtMs, accepted: true, updates: u, confirmed: [], ended: [], rejected: [],
    });
    assert.deepEqual(decider.ingest(stepOf([updates[2]])), []);
    assert.deepEqual(decider.ingest(stepOf([updates[0]])), []);
    assert.deepEqual(decider.ingest(stepOf([updates[1]])), [], "fusion alone would accept E1 here");
    const end = decider.ingestEnds([{
      trackId: "M-1", gate: "EXIT", reason: "timeout", confirmed: true, firstSeenAtMs: T0, lastSeenAtMs: T0, endedAtMs: T0 + 2000, hits: 3, usableFrames: 3, embeddingsUsed: 3,
    }]);
    assert.equal(end.length, 1);
    assert.notEqual(end[0].outcome.kind, "employee");
  });
});

describe("trackDecision: retention and helpers", () => {
  it("drops evidence as soon as a track is decided", () => {
    const h = new Harness();
    const walk = passage(E1, 0.85, 30);
    h.frame(0, [{ d: det(900, 500, 90), who: walk }]);
    assert.equal(h.session.decider.pending()[0].evidenceFrames, 1);
    h.frame(1, [{ d: det(900, 500, 90), who: walk }]);
    assert.equal(h.results.length, 1);
    assert.deepEqual(h.session.decider.pending(), []);
    assert.ok(h.session.decider.isDecided(h.results[0].outcome.trackId));
  });

  it("keeps at most keepBestFrames embedded frames per track", () => {
    const h = new Harness(ctx({ gallery: new Map() }));
    const walk = passage(randUnit(4321), 0.9, 31);
    for (let i = 0; i < 30; i++) h.frame(i, [{ d: det(900, 500, 80), q: 0.3 + i * 0.02, who: walk, force: true }]);
    assert.ok(h.session.decider.pending()[0].evidenceFrames <= 5);
  });

  it("qualityWeightedMean weights by quality and normalises", () => {
    const m = qualityWeightedMean([
      { embedding: [1, 0], quality: 0.9 },
      { embedding: [0, 2], quality: 0.3 },
    ])!;
    assert.ok(Math.abs(Math.hypot(m[0], m[1]) - 1) < 1e-6);
    assert.ok(m[0] > m[1]);
    assert.equal(qualityWeightedMean([]), null);
    assert.equal(qualityWeightedMean([{ embedding: [1, 0], quality: 1 }, { embedding: [1, 0, 0], quality: 1 }]), null);
  });

  it("is deterministic for the same input", () => {
    const run = () => {
      const h = new Harness();
      const a = passage(E1, 0.52, 40);
      const b = passage(randUnit(41), 0.9, 41);
      for (let i = 0; i < 15; i++) h.frame(i, [{ d: det(500, 500, 80), who: a }, { d: det(1300, 500, 80), who: b }]);
      h.tick(T0 + 14 * DT + 2000);
      return h.results.map((r) => [r.outcome.kind, r.outcome.trackId, r.basis, r.shadow]);
    };
    assert.deepEqual(run(), run());
  });
});
