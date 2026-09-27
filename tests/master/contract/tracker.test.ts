/**
 * pipeline-contract: tracker behaviour on synthetic detections (no pixels, no
 * biometric data): one track per person through crossing, short occlusion and
 * dropped frames. Identities are fixed random unit vectors + noise.
 *
 * Skips while src/server/pipeline/tracker.ts is absent. Bound to TRK's API
 * (feat/rt-trk 5d014d6): new FaceTracker({ gate, modelTag, clock }), then per
 * frame plan(frame, inputs) -> embeddings only where asked -> update(frame,
 * inputs) -> TrackerStep.updates[] (detectionIndex, trackId); endAll() at the end.
 * A generic createTracker/update(frame, detections, embeddings) shape is also
 * accepted; MT_TRACKER_EXPORT names the export when it is something else.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import type { FaceDetection, Frame, TrackUpdate } from "../../../src/server/pipeline/contracts.ts";

const MODULE = new URL("../../../src/server/pipeline/tracker.ts", import.meta.url);
const W = 1920;
const H = 1080;
const FPS = 8;
const PIXELS = new Uint8Array(0); // the tracker must not need pixels to assign tracks

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

function identity(seed: number): Float32Array {
  const r = rng(seed);
  const v = new Float32Array(512).map(() => r() - 0.5);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

function noisy(base: Float32Array, seed: number, amount = 0.25): Float32Array {
  const r = rng(seed);
  const v = base.map((x) => x + (r() - 0.5) * amount * 0.09);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

export interface Step {
  frame: Frame;
  detections: FaceDetection[];
  embeddings: Float32Array[];
  /** Ground-truth person per detection. */
  who: string[];
}

function frame(seq: number): Frame {
  return { gate: "EXIT", streamId: "mt-synthetic", seq, capturedAtMs: 1_790_000_000_000 + (seq * 1000) / FPS, width: W, height: H, roi: [0, 0, W, H], sourceWidth: W, sourceHeight: H, rgb: PIXELS };
}

function det(cx: number, cy: number, size: number): FaceDetection {
  const box: [number, number, number, number] = [cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2];
  const lm: Array<[number, number]> = [
    [cx - size * 0.18, cy - size * 0.1],
    [cx + size * 0.18, cy - size * 0.1],
    [cx, cy + size * 0.05],
    [cx - size * 0.14, cy + size * 0.22],
    [cx + size * 0.14, cy + size * 0.22],
  ];
  return { box, landmarks: lm, score: 0.9, sizePx: size, clear: size >= 60 };
}

/** Two people walking towards each other, crossing mid-frame (boxes overlap for ~3 frames). */
export function crossing(): Step[] {
  const a = identity(11);
  const b = identity(22);
  const steps: Step[] = [];
  for (let i = 0; i < 24; i++) {
    const t = i / 23;
    const ax = 500 + t * 900;
    const bx = 1400 - t * 900;
    const size = 70 + i * 2;
    steps.push({ frame: frame(i), detections: [det(ax, 500, size), det(bx, 520, size)], embeddings: [noisy(a, 100 + i), noisy(b, 200 + i)], who: ["A", "B"] });
  }
  return steps;
}

/** One person, hidden for 4 frames (0.5 s), then visible again. */
export function occlusion(): Step[] {
  const a = identity(33);
  const steps: Step[] = [];
  for (let i = 0; i < 20; i++) {
    if (i >= 8 && i < 12) {
      steps.push({ frame: frame(i), detections: [], embeddings: [], who: [] });
      continue;
    }
    steps.push({ frame: frame(i), detections: [det(700 + i * 15, 500, 80 + i)], embeddings: [noisy(a, 300 + i)], who: ["A"] });
  }
  return steps;
}

/** One person approaching with dropped frames (seq gaps). */
export function droppedFrames(): Step[] {
  const a = identity(44);
  return [0, 1, 2, 5, 6, 9, 10, 11, 15, 16].map((seq, k) => ({ frame: frame(seq), detections: [det(900 + k * 10, 500, 60 + k * 6)], embeddings: [noisy(a, 400 + k)], who: ["A"] }));
}

type Upd = TrackUpdate & { detectionIndex?: number; state?: string };
type Bound = { update(step: Step): Upd[]; end(): void };
const MODEL_TAG = "arcface_w600k_r50";

async function bindTracker(): Promise<{ make: (() => Bound) | null; why?: string }> {
  if (!existsSync(MODULE)) return { make: null, why: "tracker.ts not in this build (TRK, W1)" };
  const spec: string = MODULE.href;
  const mod: any = await import(spec);
  const named = process.env.MT_TRACKER_EXPORT;
  if (!named && typeof mod.FaceTracker === "function") {
    return {
      make: () => {
        let now = 0;
        const tr = new mod.FaceTracker({ gate: "EXIT", modelTag: MODEL_TAG, clock: () => now });
        return {
          update: (s: Step) => {
            now = s.frame.capturedAtMs;
            const bare = s.detections.map((detection) => ({ detection, quality: 0.8 }));
            const plan = tr.plan(s.frame, bare);
            const inputs = bare.map((x, i) => (plan.needsEmbedding[i] ? { ...x, embedding: s.embeddings[i], embeddingModelTag: MODEL_TAG } : x));
            return tr.update(s.frame, inputs).updates;
          },
          end: () => tr.endAll("shutdown", now + 60_000),
        };
      },
    };
  }
  const cand = (named && mod[named]) || mod.createTracker || mod.Tracker || mod.default;
  if (typeof cand !== "function") return { make: null, why: `no recognised tracker export (found: ${Object.keys(mod).join(", ")})` };
  const isClass = /^class\s/.test(Function.prototype.toString.call(cand));
  return {
    make: () => {
      const tr = isClass ? new cand({}) : cand({});
      if (typeof tr?.update !== "function") throw new Error("tracker has no update()");
      return {
        update: (s: Step) => {
          const out = tr.update(s.frame, s.detections, s.embeddings);
          const list = Array.isArray(out) ? out : out?.updates;
          return Array.isArray(list) ? list : [];
        },
        end: () => (tr.end || tr.flush || (() => undefined)).call(tr),
      };
    },
  };
}

/**
 * Confirmed trackIds per ground-truth person. Tentative tracks (detector
 * flicker, first frames of fast motion) owe no outcome, so they are counted
 * separately and only reported as a diagnostic.
 */
function tracksByPerson(steps: Step[], run: (s: Step) => Upd[], tentative?: Set<string>) {
  const map = new Map<string, Set<string>>();
  for (const s of steps) {
    const updates = run(s);
    for (const u of updates) {
      if (u.state !== undefined && u.state !== "confirmed") {
        tentative?.add(u.trackId);
        continue;
      }
      const idx = typeof u.detectionIndex === "number" ? u.detectionIndex : s.detections.findIndex((d) => d.box.every((v, k) => Math.abs(v - u.detection.box[k]) < 1e-6));
      if (idx < 0) continue;
      const who = s.who[idx];
      if (!map.has(who)) map.set(who, new Set());
      map.get(who)!.add(u.trackId);
    }
  }
  return map;
}

describe("pipeline-contract: tracker scenarios", () => {
  it("crossing people keep their own track ids", async (t) => {
    const { make, why } = await bindTracker();
    if (!make) return t.skip(why);
    const tr = make();
    const tentative = new Set<string>();
    const m = tracksByPerson(crossing(), (s) => tr.update(s), tentative);
    tr.end();
    const orphans = [...tentative].filter((id) => ![...m.values()].some((set) => set.has(id)));
    t.diagnostic(`tentative tracks that never confirmed: ${orphans.length}`);
    assert.equal(m.get("A")?.size, 1, `A spread over tracks ${[...(m.get("A") || [])]}`);
    assert.equal(m.get("B")?.size, 1, `B spread over tracks ${[...(m.get("B") || [])]}`);
    assert.notEqual([...m.get("A")!][0], [...m.get("B")!][0], "A and B merged into one track");
  });

  it("a 0.5 s occlusion does not start a second track", async (t) => {
    const { make, why } = await bindTracker();
    if (!make) return t.skip(why);
    const tr = make();
    const m = tracksByPerson(occlusion(), (s) => tr.update(s));
    tr.end();
    assert.equal(m.get("A")?.size, 1);
  });

  it("dropped frames (seq gaps) keep one track", async (t) => {
    const { make, why } = await bindTracker();
    if (!make) return t.skip(why);
    const tr = make();
    const m = tracksByPerson(droppedFrames(), (s) => tr.update(s));
    tr.end();
    assert.equal(m.get("A")?.size, 1);
  });

  it("scenario generators are well-formed (always runs)", () => {
    for (const steps of [crossing(), occlusion(), droppedFrames()]) {
      for (const s of steps) {
        assert.equal(s.detections.length, s.embeddings.length);
        assert.equal(s.detections.length, s.who.length);
      }
    }
    const c = crossing();
    const mid = c[12].detections;
    const overlap = Math.max(0, Math.min(mid[0].box[2], mid[1].box[2]) - Math.max(mid[0].box[0], mid[1].box[0]));
    assert.ok(overlap > 0, "the crossing scenario must actually overlap the boxes");
  });
});
