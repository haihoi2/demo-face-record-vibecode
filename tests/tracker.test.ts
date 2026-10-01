/**
 * Unit tests for the real-time multi-face tracker (src/server/pipeline/tracker.ts).
 * Synthetic detections and embeddings only - no models, no I/O.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { FaceDetection, Frame, Gate } from "../src/server/pipeline/contracts";
import { trackIdPrefix } from "../src/server/pipeline/gateId";
import {
  DEFAULT_TRACKER_CONFIG,
  FaceTracker,
  TrackerConfig,
  TrackerInput,
  TrackerStep,
} from "../src/server/pipeline/tracker";

const TAG = "arcface_test";
const DIMS = 512;
const T0 = 1_000_000;
const DT = 125; // 8 fps

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
function randUnit(seed: number): number[] {
  const r = rng(seed);
  const v: number[] = [];
  for (let i = 0; i < DIMS; i++) v.push(Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()));
  return norm(v);
}
function norm(v: number[]): number[] {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}
/** Unit vector with cosine exactly `c` to unit `base`, rest from `noiseSeed`. */
function mix(base: number[], c: number, noiseSeed: number): number[] {
  const r = randUnit(noiseSeed);
  const d = r.reduce((s, x, i) => s + x * base[i], 0);
  const orth = norm(r.map((x, i) => x - d * base[i]));
  const s = Math.sqrt(1 - c * c);
  return base.map((b, i) => c * b + s * orth[i]);
}
/** One camera frame of a person: close to that person's passage vector. */
function emb(person: number[], seed: number): Float32Array {
  return Float32Array.from(mix(person, 0.95, seed));
}

function frame(seq: number, t = T0 + seq * DT, over: Partial<Frame> = {}): Frame {
  return {
    gate: "entry", streamId: "entry-main", seq, capturedAtMs: t, width: 1920, height: 1080,
    roi: [0, 0, 1920, 1080], sourceWidth: 1920, sourceHeight: 1080, rgb: new Uint8Array(0), ...over,
  };
}
function det(cx: number, cy: number, size: number, o: { score?: number; clear?: boolean; yaw?: number } = {}): FaceDetection {
  const s = size;
  const yaw = o.yaw ?? 0;
  return {
    box: [cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2],
    landmarks: [
      [cx - 0.2 * s, cy - 0.1 * s], [cx + 0.2 * s, cy - 0.1 * s], [cx + yaw * 0.4 * s, cy + 0.05 * s],
      [cx - 0.15 * s, cy + 0.25 * s], [cx + 0.15 * s, cy + 0.25 * s],
    ],
    score: o.score ?? 0.9,
    sizePx: s,
    clear: o.clear ?? s >= 60,
  };
}
function inp(d: FaceDetection, quality = 0.6, embedding?: Float32Array, tag = TAG): TrackerInput {
  return embedding ? { detection: d, quality, embedding, embeddingModelTag: tag } : { detection: d, quality };
}
function tracker(config: Partial<TrackerConfig> = {}, gate: Gate = "entry"): FaceTracker {
  return new FaceTracker({ gate, modelTag: TAG, config, clock: () => T0, idPrefix: "T" });
}
/** plan -> embed exactly what was asked -> update. */
function step(tr: FaceTracker, f: Frame, faces: Array<{ d: FaceDetection; q?: number; person?: number[]; seed?: number }>): { st: TrackerStep; asked: boolean[] } {
  const plain = faces.map((x) => inp(x.d, x.q ?? 0.6));
  const plan = tr.plan(f, plain);
  const inputs = faces.map((x, i) =>
    plan.needsEmbedding[i] && x.person ? inp(x.d, x.q ?? 0.6, emb(x.person, x.seed ?? f.seq * 31 + i)) : plain[i]);
  return { st: tr.update(f, inputs), asked: plan.needsEmbedding };
}
const idOf = (st: TrackerStep, detIndex: number) => st.updates.find((u) => u.detectionIndex === detIndex)?.trackId;

const PERSON_A = randUnit(101);
const PERSON_B = randUnit(202);
const PERSON_C = randUnit(303);

// --- tests -------------------------------------------------------------------

describe("tracker: single walker", () => {
  it("starts tentative, confirms on the second hit, asks for embeddings on frames 1 and 2", () => {
    const tr = tracker();
    const a = step(tr, frame(0), [{ d: det(900, 600, 70), person: PERSON_A }]);
    assert.equal(a.st.updates.length, 1);
    assert.equal(a.st.updates[0].state, "tentative");
    assert.equal(a.st.updates[0].newTrack, true);
    assert.deepEqual(a.asked, [true]);
    assert.equal(a.st.updates[0].embeddingStatus, "evidence");
    assert.ok(a.st.updates[0].embedding);
    const id = a.st.updates[0].trackId;

    const b = step(tr, frame(1), [{ d: det(905, 610, 72), person: PERSON_A }]);
    assert.equal(idOf(b.st, 0), id);
    assert.deepEqual(b.st.confirmed, [id]);
    assert.equal(b.st.updates[0].state, "confirmed");
    assert.deepEqual(b.asked, [true], "second usable frame is embedded (2 agreeing frames needed)");

    const c = step(tr, frame(2), [{ d: det(910, 620, 73), person: PERSON_A }]);
    assert.equal(idOf(c.st, 0), id);
    assert.deepEqual(c.asked, [false], "same quality: no third embedding");
  });

  it("respects the embedding budget: at most 5 per track, however long and however much better", () => {
    const tr = tracker();
    let asked = 0;
    let id = "";
    for (let i = 0; i < 60; i++) {
      const q = Math.min(1, 0.2 + i * 0.03); // steadily better
      const r = step(tr, frame(i), [{ d: det(900, 600 + i, 64 + i), q, person: PERSON_A }]);
      if (r.asked[0]) asked += 1;
      id ||= r.st.updates[0].trackId;
      assert.equal(r.st.updates[0].trackId, id);
    }
    assert.equal(asked, DEFAULT_TRACKER_CONFIG.maxEmbeddingsPerTrack);
    assert.equal(tr.snapshot()[0].embeddingsUsed, 5);
    // A caller that embeds anyway gets "over-budget" and no evidence.
    const extra = tr.update(frame(60), [inp(det(900, 660, 124), 1, emb(PERSON_A, 9))]);
    assert.equal(extra.updates[0].embeddingStatus, "over-budget");
    assert.equal(extra.updates[0].embedding, undefined);
  });

  it("asks again only for a clearly better face (+10% selection score)", () => {
    const tr = tracker();
    step(tr, frame(0), [{ d: det(900, 600, 80), q: 0.5, person: PERSON_A }]);
    step(tr, frame(1), [{ d: det(900, 600, 80), q: 0.5, person: PERSON_A }]);
    assert.deepEqual(step(tr, frame(2), [{ d: det(900, 600, 80), q: 0.54, person: PERSON_A }]).asked, [false]);
    assert.deepEqual(step(tr, frame(3), [{ d: det(900, 600, 80), q: 0.56, person: PERSON_A }]).asked, [true]);
    // A turned head lowers the selection score even at the same capture quality.
    assert.deepEqual(step(tr, frame(4), [{ d: det(900, 600, 80, { yaw: 1.2 }), q: 0.7, person: PERSON_A }]).asked, [false]);
  });

  it("never asks for embeddings once evidence is closed (decided)", () => {
    const tr = tracker();
    const a = step(tr, frame(0), [{ d: det(900, 600, 80), person: PERSON_A }]);
    tr.closeEvidence(a.st.updates[0].trackId);
    for (let i = 1; i < 10; i++) {
      assert.deepEqual(step(tr, frame(i), [{ d: det(900, 600, 80), q: 0.2 + i * 0.1, person: PERSON_A }]).asked, [false]);
    }
  });
});

describe("tracker: 60 px and clear-face rule", () => {
  it("far faces keep the track alive but are never usable and never embedded", () => {
    const tr = tracker();
    let id = "";
    for (let i = 0; i < 8; i++) {
      // The caller even claims clear:true; the size floor still applies.
      const r = step(tr, frame(i), [{ d: det(900, 400, 45, { clear: true }), person: PERSON_A }]);
      assert.deepEqual(r.asked, [false]);
      assert.equal(r.st.updates[0].usable, false);
      id ||= r.st.updates[0].trackId;
      assert.equal(r.st.updates[0].trackId, id);
    }
    const forced = tr.update(frame(8), [inp(det(900, 400, 45, { clear: true }), 0.9, emb(PERSON_A, 1))]);
    assert.equal(forced.updates[0].embeddingStatus, "unusable");
    assert.equal(forced.updates[0].embedding, undefined);
    assert.equal(tr.snapshot()[0].usableFrames, 0);
    assert.equal(tr.snapshot()[0].state, "confirmed");
  });

  it("an unclear (turned) face >= 60 px is not usable either", () => {
    const tr = tracker();
    const r = step(tr, frame(0), [{ d: det(900, 400, 90, { clear: false }), person: PERSON_A }]);
    assert.deepEqual(r.asked, [false]);
    assert.equal(r.st.updates[0].usable, false);
  });

  it("first usable time is the first >= 60 px clear frame", () => {
    const tr = tracker();
    step(tr, frame(0), [{ d: det(900, 400, 50) }]);
    step(tr, frame(1), [{ d: det(900, 410, 55) }]);
    step(tr, frame(2), [{ d: det(900, 420, 62) }]);
    const s = tr.snapshot()[0];
    assert.equal(s.firstSeenAtMs, T0);
    assert.equal(s.firstUsableAtMs, T0 + 2 * DT);
  });
});

describe("tracker: several people", () => {
  it("two people in view get two tracks and keep them", () => {
    const tr = tracker();
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const r = step(tr, frame(i), [
        { d: det(500, 500 + 5 * i, 80), person: PERSON_A },
        { d: det(1300, 520 + 5 * i, 80), person: PERSON_B },
      ]);
      assert.equal(r.st.updates.length, 2);
      ids.add(`${idOf(r.st, 0)}|${idOf(r.st, 1)}`);
    }
    assert.equal(ids.size, 1);
    assert.equal(tr.snapshot().length, 2);
  });

  it("two people crossing keep their IDs (motion prediction, no embeddings)", () => {
    const tr = tracker();
    let idA = "", idB = "";
    for (let i = 0; i < 20; i++) {
      const ax = 400 + 40 * i; // walks right
      const bx = 1200 - 40 * i; // walks left
      const r = tr.update(frame(i), [inp(det(ax, 500, 80)), inp(det(bx, 540, 80))]);
      if (i === 0) {
        idA = idOf(r, 0)!;
        idB = idOf(r, 1)!;
      }
      assert.equal(idOf(r, 0), idA, `A at frame ${i}`);
      assert.equal(idOf(r, 1), idB, `B at frame ${i}`);
    }
    assert.equal(tr.snapshot().length, 2);
  });

  it("an ambiguous overlap asks for tie-break embeddings and the embedding decides", () => {
    const build = () => {
      const tr = tracker();
      for (let i = 0; i < 4; i++) {
        step(tr, frame(i), [
          { d: det(500, 500, 90), person: PERSON_A, seed: 10 + i },
          { d: det(560, 500, 90), person: PERSON_B, seed: 20 + i },
        ]);
      }
      return tr;
    };
    const [idA, idB] = build().snapshot().map((s) => s.trackId);
    // B steps to x=525, A to x=535: by overlap alone they would swap.
    const faces = [det(525, 500, 90), det(535, 500, 90)];

    const blind = build();
    const bs = blind.update(frame(4), faces.map((d) => inp(d)));
    assert.equal(idOf(bs, 0), idA, "IoU alone picks the wrong person");

    const tr = build();
    const plan = tr.plan(frame(4), faces.map((d) => inp(d)));
    assert.deepEqual(plan.needsEmbedding, [true, true]);
    assert.ok(plan.requests.every((r) => r.reason === "tiebreak"));
    const st = tr.update(frame(4), [inp(faces[0], 0.6, emb(PERSON_B, 77)), inp(faces[1], 0.6, emb(PERSON_A, 78))]);
    assert.equal(idOf(st, 0), idB);
    assert.equal(idOf(st, 1), idA);
    assert.ok(st.updates.every((u) => u.embeddingStatus === "evidence"));
  });

  it("a different person in the same box is split off, not merged into the track", () => {
    const tr = tracker();
    for (let i = 0; i < 3; i++) step(tr, frame(i), [{ d: det(900, 600, 80), person: PERSON_A }]);
    const idA = tr.snapshot()[0].trackId;
    const st = tr.update(frame(3), [inp(det(902, 600, 80), 0.6, emb(PERSON_C, 5))]);
    assert.notEqual(idOf(st, 0), idA);
    assert.equal(st.updates[0].newTrack, true);
    assert.equal(tr.snapshot().length, 2);
  });

  it("an uncertain identity (cosine between split and same) is kept out of the evidence", () => {
    const tr = tracker();
    for (let i = 0; i < 2; i++) step(tr, frame(i), [{ d: det(900, 600, 80), person: PERSON_A }]);
    const idA = tr.snapshot()[0].trackId;
    const doubtful = Float32Array.from(mix(PERSON_A, 0.36, 999));
    const st = tr.update(frame(2), [inp(det(900, 600, 80), 0.9, doubtful)]);
    assert.equal(idOf(st, 0), idA);
    assert.equal(st.updates[0].embeddingStatus, "conflict");
    assert.equal(st.updates[0].embedding, undefined);
  });
});

describe("tracker: occlusion, flicker, lifecycle", () => {
  it("a brief occlusion (0.6 s) does not create a new track", () => {
    const tr = tracker();
    for (let i = 0; i < 4; i++) tr.update(frame(i), [inp(det(600 + 10 * i, 500, 80))]);
    const id = tr.snapshot()[0].trackId;
    for (let i = 4; i < 9; i++) assert.equal(tr.update(frame(i), []).updates.length, 0);
    const back = tr.update(frame(9), [inp(det(690, 500, 80))]);
    assert.equal(idOf(back, 0), id);
    assert.equal(back.updates[0].newTrack, false);
    assert.equal(tr.snapshot().length, 1);
  });

  it("a lost track (1.2 s) is still found by overlap, and by embedding after a jump", () => {
    const tr = tracker();
    for (let i = 0; i < 3; i++) step(tr, frame(i), [{ d: det(600, 500, 80), person: PERSON_A }]);
    const id = tr.snapshot()[0].trackId;
    tr.tick(T0 + 2 * DT + 1100);
    assert.equal(tr.snapshot()[0].state, "lost");
    // Reappears 200 px away (no overlap) - only the embedding can tie it back.
    const t = T0 + 2 * DT + 1200;
    const st = tr.update(frame(3, t), [inp(det(800, 500, 80), 0.6, emb(PERSON_A, 42))]);
    assert.equal(idOf(st, 0), id);
    assert.equal(st.updates[0].state, "confirmed");

    const blind = tracker();
    for (let i = 0; i < 3; i++) blind.update(frame(i), [inp(det(600, 500, 80))]);
    const bst = blind.update(frame(3, t), [inp(det(800, 500, 80))]);
    assert.equal(bst.updates[0].newTrack, true, "without an embedding a jump is a new track");
  });

  it("detector flicker (missing and low-score frames) keeps one track", () => {
    const tr = tracker();
    let id = "";
    for (let i = 0; i < 16; i++) {
      const inputs = i % 3 === 1 ? [] : [inp(det(700, 500 + 3 * i, 80, { score: i % 3 === 2 && i > 2 ? 0.4 : 0.85 }))];
      const st = tr.update(frame(i), inputs);
      if (st.updates.length) {
        id ||= st.updates[0].trackId;
        assert.equal(st.updates[0].trackId, id);
      }
    }
    assert.equal(tr.snapshot().length, 1);
    assert.equal(tr.snapshot()[0].state, "confirmed");
  });

  it("a low-score detection alone never starts a track", () => {
    const tr = tracker();
    for (let i = 0; i < 5; i++) assert.equal(tr.update(frame(i), [inp(det(700, 500, 80, { score: 0.45 }))]).updates.length, 0);
    assert.equal(tr.snapshot().length, 0);
  });

  it("a single-frame false detection ends unconfirmed (no outcome owed)", () => {
    const tr = tracker();
    tr.update(frame(0), [inp(det(700, 500, 80))]);
    assert.deepEqual(tr.tick(T0 + 500), []);
    const ended = tr.tick(T0 + 501);
    assert.equal(ended.length, 1);
    assert.equal(ended[0].confirmed, false);
    assert.equal(tr.snapshot().length, 0);
  });

  it("lost after 1 s, ended after 2 s without a match (timeouts, via tick)", () => {
    const tr = tracker();
    tr.update(frame(0), [inp(det(700, 500, 80))]);
    tr.update(frame(1), [inp(det(700, 500, 80))]);
    const last = T0 + DT;
    tr.tick(last + 999);
    assert.equal(tr.snapshot()[0].state, "confirmed");
    tr.tick(last + 1000);
    assert.equal(tr.snapshot()[0].state, "lost");
    assert.deepEqual(tr.tick(last + 1999), []);
    const ended = tr.tick(last + 2000);
    assert.equal(ended.length, 1);
    assert.equal(ended[0].reason, "timeout");
    assert.equal(ended[0].confirmed, true);
    assert.equal(ended[0].endedAtMs, last + 2000);
  });

  it("a stream gap longer than 2 s ends tracks before the next frame is matched", () => {
    const tr = tracker();
    tr.update(frame(0), [inp(det(700, 500, 80))]);
    tr.update(frame(1), [inp(det(700, 500, 80))]);
    const st = tr.update(frame(0, T0 + 5000), [inp(det(700, 500, 80))]);
    assert.equal(st.ended.length, 1);
    assert.equal(st.updates[0].newTrack, true);
  });

  it("a person lingering 30 s stays one track", () => {
    const tr = tracker();
    for (let i = 0; i < 240; i++) tr.update(frame(i), [inp(det(700 + (i % 5), 500, 90))]);
    assert.equal(tr.snapshot().length, 1);
    assert.equal(tr.snapshot()[0].hits, 240);
  });

  it("a changed gate area or stream resets every track", () => {
    const tr = tracker();
    tr.update(frame(0), [inp(det(700, 500, 80))]);
    tr.update(frame(1), [inp(det(700, 500, 80))]);
    const st = tr.update(frame(2, undefined, { roi: [100, 0, 1820, 1080] }), [inp(det(700, 500, 80))]);
    assert.equal(st.ended.length, 1);
    assert.equal(st.ended[0].reason, "reset");
    assert.equal(st.updates[0].newTrack, true);
  });

  it("endAll ends every track (shutdown)", () => {
    const tr = tracker();
    tr.update(frame(0), [inp(det(500, 500, 80)), inp(det(1200, 500, 80))]);
    const ended = tr.endAll("shutdown", T0 + 10);
    assert.equal(ended.length, 2);
    assert.ok(ended.every((e) => e.reason === "shutdown"));
    assert.equal(tr.snapshot().length, 0);
  });
});

describe("tracker: no face, overload, corrupted input", () => {
  it("frames without faces produce nothing", () => {
    const tr = tracker();
    for (let i = 0; i < 5; i++) {
      const st = tr.update(frame(i), []);
      assert.equal(st.accepted, true);
      assert.equal(st.updates.length, 0);
      assert.deepEqual(tr.plan(frame(i + 1), []), { needsEmbedding: [], requests: [] });
    }
    assert.equal(tr.snapshot().length, 0);
  });

  it("caps detections per frame (highest scores kept) and tracks per gate", () => {
    const tr = tracker();
    const many = Array.from({ length: 30 }, (_, i) => inp(det(100 + 60 * i, 500, 50, { score: 0.61 + i * 0.01 })));
    const st = tr.update(frame(0), many);
    const over = st.rejected.filter((r) => r.reason === "overload").map((r) => r.index);
    assert.deepEqual(over, [0, 1, 2, 3, 4, 5]);
    assert.equal(st.updates.length, DEFAULT_TRACKER_CONFIG.maxTracks);
    assert.equal(st.rejected.filter((r) => r.reason === "track-limit").length, 24 - DEFAULT_TRACKER_CONFIG.maxTracks);

    const small = tracker({ maxTracks: 2 });
    const s2 = small.update(frame(0), [inp(det(300, 500, 80)), inp(det(800, 500, 80)), inp(det(1400, 500, 80))]);
    assert.equal(s2.updates.length, 2);
    assert.deepEqual(s2.rejected, [{ index: 2, reason: "track-limit" }]);
  });

  it("caps embedding requests per frame", () => {
    const tr = tracker({ maxEmbeddingsPerFrame: 2 });
    const plan = tr.plan(frame(0), [300, 700, 1100, 1500].map((x, i) => inp(det(x, 500, 80), 0.5 + i * 0.1)));
    assert.equal(plan.requests.length, 2);
    assert.deepEqual(plan.needsEmbedding, [false, false, true, true], "highest quality first");
  });

  it("rejects malformed detections without throwing", () => {
    const tr = tracker();
    const bad: TrackerInput[] = [
      { detection: { ...det(500, 500, 80), box: [NaN, 0, 10, 10] } },
      { detection: { ...det(500, 500, 80), box: [100, 100, 50, 150] } },
      { detection: { ...det(500, 500, 80), score: 1.5 } },
      { detection: { ...det(500, 500, 80), sizePx: Number.POSITIVE_INFINITY } },
      { detection: undefined as unknown as FaceDetection },
      null as unknown as TrackerInput,
      inp(det(500, 500, 80, { score: 0.1 })),
      inp(det(900, 500, 80)),
    ];
    const st = tr.update(frame(0), bad);
    assert.deepEqual(st.rejected.map((r) => r.reason), [
      "invalid-detection", "invalid-detection", "invalid-detection", "invalid-detection",
      "invalid-detection", "invalid-detection", "below-floor",
    ]);
    assert.equal(st.updates.length, 1);
    assert.equal(st.updates[0].detectionIndex, 7);
  });

  it("rejects corrupted or foreign-model embeddings as invalid (never evidence)", () => {
    const cases: Array<[string, TrackerInput]> = [
      ["NaN", { detection: det(900, 500, 80), quality: 0.6, embedding: new Float32Array(DIMS).fill(NaN), embeddingModelTag: TAG }],
      ["zero", { detection: det(900, 500, 80), quality: 0.6, embedding: new Float32Array(DIMS), embeddingModelTag: TAG }],
      ["short", { detection: det(900, 500, 80), quality: 0.6, embedding: new Float32Array(128).fill(0.1), embeddingModelTag: TAG }],
      ["other model", inp(det(900, 500, 80), 0.6, emb(PERSON_A, 1), "arcface_other")],
      ["no tag", { detection: det(900, 500, 80), quality: 0.6, embedding: emb(PERSON_A, 1) }],
    ];
    for (const [name, input] of cases) {
      const tr = tracker();
      const st = tr.update(frame(0), [input]);
      assert.equal(st.updates[0].embeddingStatus, "invalid", name);
      assert.equal(st.updates[0].embedding, undefined, name);
      assert.equal(tr.snapshot()[0].embeddingsUsed, 0, name);
    }
  });

  it("refuses invalid, foreign-gate and out-of-order frames without changing state", () => {
    const tr = tracker();
    tr.update(frame(5), [inp(det(900, 500, 80))]);
    const before = JSON.stringify(tr.snapshot());
    assert.equal(tr.update(frame(4), [inp(det(900, 500, 80))]).reason, "stale-frame");
    assert.equal(tr.update(frame(6, undefined, { gate: "exit" }), [inp(det(900, 500, 80))]).reason, "wrong-gate");
    assert.equal(tr.update(frame(6, NaN), [inp(det(900, 500, 80))]).reason, "invalid-frame");
    assert.equal(tr.update(null as unknown as Frame, []).reason, "invalid-frame");
    assert.equal(JSON.stringify(tr.snapshot()), before);
    assert.deepEqual(tr.plan(frame(4), [inp(det(900, 500, 80))]).needsEmbedding, [false]);
  });

  it("works for any gate id: a third gate's tracks carry its id and the derived prefix", () => {
    const tr = new FaceTracker({ gate: "side-door", modelTag: TAG, clock: () => T0 });
    const st = tr.update(frame(1, undefined, { gate: "side-door", streamId: "side-door-main" }), [inp(det(900, 500, 80))]);
    assert.equal(st.accepted, true);
    assert.equal(st.gate, "side-door");
    // default prefix: trackIdPrefix(gate) + "-" + clock in base 36
    assert.equal(st.updates[0].trackId, `${trackIdPrefix("side-door")}-${T0.toString(36)}-1`);
    assert.equal(tr.update(frame(2, undefined, { gate: "entry" }), [inp(det(900, 500, 80))]).reason, "wrong-gate");
    for (const [gate, p] of [["entry", "E"], ["exit", "X"]] as const) {
      const legacy = new FaceTracker({ gate, modelTag: TAG, clock: () => T0 });
      const s = legacy.update(frame(1, undefined, { gate }), [inp(det(900, 500, 80))]);
      assert.equal(s.updates[0].trackId, `${p}-${T0.toString(36)}-1`);
    }
  });

  it("refuses an invalid gate id instead of coercing it", () => {
    for (const bad of ["ENTRY", "EXIT", "", "Side", "side door", undefined, null]) {
      assert.throws(() => new FaceTracker({ gate: bad as Gate, modelTag: TAG }), /tracker gate: invalid gate id/, String(bad));
    }
  });

  it("refuses an invalid configuration or a missing model tag at construction", () => {
    assert.throws(() => new FaceTracker({ gate: "entry", modelTag: "" }));
    assert.throws(() => new FaceTracker({ gate: "SIDE" as Gate, modelTag: TAG }));
    assert.throws(() => tracker({ lowScore: 0.9, highScore: 0.5 }));
    assert.throws(() => tracker({ maxEmbeddingsPerTrack: 0 }));
    assert.throws(() => tracker({ lostAfterMs: 3000, endAfterMs: 2000 }));
    assert.throws(() => tracker({ iouHigh: NaN }));
  });
});

describe("tracker: determinism and privacy", () => {
  it("the same input gives the same tracks, ids and requests", () => {
    const run = () => {
      const tr = tracker();
      const log: unknown[] = [];
      for (let i = 0; i < 25; i++) {
        const r = step(tr, frame(i), [
          { d: det(400 + 30 * i, 500, 70 + i), q: 0.3 + i * 0.02, person: PERSON_A },
          { d: det(1300 - 30 * i, 520, 70 + i), q: 0.3 + i * 0.02, person: PERSON_B },
        ]);
        log.push(r.asked, r.st.updates.map((u) => [u.trackId, u.state, u.embeddingStatus]), r.st.confirmed);
      }
      log.push(tr.tick(T0 + 25 * DT + 3000).map((e) => [e.trackId, e.hits, e.embeddingsUsed]));
      return log;
    };
    assert.deepEqual(run(), run());
  });

  it("snapshots never expose embeddings", () => {
    const tr = tracker();
    step(tr, frame(0), [{ d: det(900, 500, 80), person: PERSON_A }]);
    const text = JSON.stringify(tr.snapshot());
    assert.ok(!/ref|embedding"/.test(text), text);
  });
});
