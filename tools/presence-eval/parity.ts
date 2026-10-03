/**
 * P2 parity check (OFFLINE ONLY, dev tool): replays P1 entry clips through the
 * PRODUCTION presence path - PresenceHost -> detector cores -> OnnxPersonDetector
 * (real ONNX, sha256-checked) -> PresenceCore - and compares with P1b.
 *
 *   node --import tsx tools/presence-eval/parity.ts --work /work --models /models/presence \
 *     [--clips id1,id2 | --set day-evening] [--hour 10] [--out parity.json]
 *
 * Frames are decoded from the original clip like the production third stream
 * output: ffmpeg fps=4, scale=960:540:flags=area (the P1 frame grid); every 2nd
 * frame is processed (2 fps), i.e. P1 frame index i = 2k. Workers run in-process
 * (one thread; the host waits for both detectors before the next frame, so no
 * frame is dropped and RTMDet runs exactly on every 4th processed frame).
 *
 * Reported per clip and in total:
 *  - detection parity per model vs the saved P1 runs (runs/<model>__full__960__t2__entry):
 *    frames where "any box" agrees, matched boxes (IoU >= 0.5) and score differences;
 *  - person recall >= 3 s (UNION-LOWRATE, 2 s linking, as tools/presence-eval/combine.py)
 *    computed from the production detections and from the P1 detections with the same code;
 *  - production drafts: qualified events, how many have their best box on a ground-truth
 *    person at bestFrameAt (IoU >= 0.3), and ground-truth persons >= 3 s covered by an event.
 * Uses labels/gt.json (pooled, reviewed ground truth). Writes only aggregates.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import type { Box, PersonDetection, PresenceEventDraft, PresenceModelId } from "../../src/server/presence/contracts";
import { OnnxPersonDetector, boxIou, mergeDetections, applyMask, type PresenceFrame } from "../../src/server/presence/detectors";
import { PresenceHost, createInProcessDetectorWorker } from "../../src/server/presence/presenceHost";
import { presenceMaskForGate, presenceSettingsFromEnv } from "../../src/server/presence/presenceConfig";

const args = process.argv.slice(2);
const arg = (n: string, d = "") => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};
const work = arg("work", "/work");
const modelDir = arg("models", "/models/presence");
const outName = arg("out", "parity.json");
/** Local hour (Asia/Ho_Chi_Minh) the clips are replayed at: 10 = working hours (3 s rule), 22 = after hours (1 s). */
const hour = Number(arg("hour", "10"));
const W = 960;
const H = 540;
const GT_IOU = 0.3;
const GAP = 3; // frames at 2 fps: detections up to 2 s apart (UNION-LOWRATE, combine.py)
const NEED = 6; // 3 s at 2 fps

type NBox = [number, number, number, number];
interface Clip { id: string; file: string; gate: string; light?: string; frames: number; set: string }

const manifest = JSON.parse(fs.readFileSync(path.join(work, "manifest.json"), "utf8"));
const gtAll = JSON.parse(fs.readFileSync(path.join(work, "labels", "gt.json"), "utf8")).clips as Record<string, { frames: number[][][] }>;
let clips: Clip[] = manifest.clips.filter((c: Clip) => c.set === "nvr" && c.gate === "ENTRY" && gtAll[c.id]);
const pick = arg("clips");
if (pick) clips = clips.filter((c) => pick.split(",").includes(c.id));
else if (arg("set", "day-evening") === "day-evening") clips = clips.filter((c) => c.light === "day" || c.light === "evening");

function loadRun(model: string): Map<string, number[][]> {
  const m = new Map<string, number[][]>();
  const p = path.join(work, "runs", `${model}__full__960__t2__entry`, "dets.jsonl");
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line);
    m.set(`${r.c}#${r.i}`, r.d);
  }
  return m;
}
const p1 = { "yolox-nano": loadRun("yolox-nano"), "rtmdet-tiny": loadRun("rtmdet-tiny") };
const settings = { ...presenceSettingsFromEnv({ PRESENCE_MODEL_DIR: modelDir }).settings };
const mask = presenceMaskForGate("entry");

async function* decode(file: string): AsyncGenerator<Uint8Array> {
  const ff = spawn("ffmpeg", ["-v", "error", "-threads", "2", "-i", file, "-vf", `fps=4,scale=${W}:${H}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { stdio: ["ignore", "pipe", "inherit"] });
  const size = W * H * 3;
  let buf = Buffer.alloc(0);
  for await (const chunk of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, chunk as Buffer]) : (chunk as Buffer);
    while (buf.length >= size) {
      yield new Uint8Array(buf.subarray(0, size));
      buf = buf.subarray(size);
    }
  }
}

/** score.py match(): greedy by score, IoU >= thr, one GT box per detection. Returns matched GT indices. */
function match(dets: Array<{ box: number[]; score: number }>, gts: number[][], thr: number): Set<number> {
  const used = new Set<number>();
  for (const d of [...dets].sort((a, b) => b.score - a.score)) {
    let best = thr;
    let bj = -1;
    gts.forEach((g, j) => {
      if (used.has(j)) return;
      const v = boxIou(d.box, g);
      if (v >= best) {
        best = v;
        bj = j;
      }
    });
    if (bj >= 0) used.add(bj);
  }
  return used;
}

function episodes(flags: boolean[], gap: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let s = -1;
  let l = -1;
  flags.forEach((f, i) => {
    if (!f) return;
    if (s < 0) s = l = i;
    else if (i - l - 1 <= gap) l = i;
    else {
      out.push([s, l]);
      s = l = i;
    }
  });
  if (s >= 0) out.push([s, l]);
  return out;
}
const longest = (f: boolean[]) => Math.max(0, ...episodes(f, GAP).map(([a, b]) => b - a + 1));

/** Person recall >= 3 s from per-processed-frame detections (normalised boxes). */
function personRecall(perFrame: Array<Array<{ box: number[]; score: number }>>, gtFrames: number[][][]): { pos: number; hit: number; persons: Map<number, boolean> } {
  const tids = new Set<number>();
  for (const f of gtFrames) for (const b of f) tids.add(b[4]);
  const persons = new Map<number, boolean>();
  let pos = 0;
  let hit = 0;
  for (const tid of tids) {
    const seen = gtFrames.map((f) => f.some((b) => b[4] === tid));
    const hits = gtFrames.map((f, k) => {
      const used = match(perFrame[k] || [], f, GT_IOU);
      return [...used].some((j) => f[j][4] === tid);
    });
    if (longest(seen) >= NEED) {
      pos += 1;
      const h = longest(hits) >= NEED;
      hit += h ? 1 : 0;
      persons.set(tid, h);
    }
  }
  return { pos, hit, persons };
}

const norm = (d: PersonDetection, sw: number, sh: number) => ({ box: [d.box[0] / sw, d.box[1] / sh, d.box[2] / sw, d.box[3] / sh], score: d.score, model: d.model });
const p1Dets = (model: PresenceModelId, clip: string, i: number, thr: number) =>
  applyMask((p1[model].get(`${clip}#${i}`) || []).filter((d) => d[4] >= thr).map((d) => ({ box: d.slice(0, 4) as NBox, score: d[4], model })), mask, 1, 1);

async function runClip(clip: Clip, idx: number) {
  // one day apart, always at the same local hour (UTC+7), so every clip runs under the same rule
  const base = Date.UTC(2026, 9, 3, hour - 7, 0, 0) + idx * 86_400_000;
  const recorded: Record<PresenceModelId, Map<number, PersonDetection[]>> = { "yolox-nano": new Map(), "rtmdet-tiny": new Map() };
  const drafts: PresenceEventDraft[] = [];
  let clock = base;
  const host = new PresenceHost({
    gateId: "entry",
    settings,
    cropper: null,
    onDraft: (d) => drafts.push(d),
    now: () => clock,
    tickMs: 5,
    statsMs: 50,
    createWorker: (model) =>
      createInProcessDetectorWorker((init) => {
        const real = new OnnxPersonDetector({ model: init.model, modelDir: init.modelDir, mask: init.mask, ortThreads: init.ortThreads });
        return {
          load: () => real.load(),
          ready: () => real.ready(),
          error: () => real.error(),
          tag: () => real.tag(),
          lastRunMs: () => real.lastRunMs(),
          detect: async (f: PresenceFrame) => {
            const d = await real.detect(f);
            recorded[model].set(f.capturedAtMs, d);
            return d;
          },
        };
      }),
  });
  host.start();
  const wait = async (cond: () => boolean, what: string) => {
    const end = Date.now() + 120_000;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`${clip.id}: timed out waiting for ${what}; ${host.stats().lastError}`);
      await new Promise((r) => setTimeout(r, 2));
    }
  };
  await wait(() => host.stats().engineReady, "models");
  let i = 0;
  let processed = 0;
  const times: number[] = [];
  for await (const rgb of decode(clip.file)) {
    if (i >= clip.frames) break;
    if (i % 2 === 0) {
      const t = base + i * 250;
      clock = t + 100;
      times.push(t);
      host.offer({ width: W, height: H, rgb, capturedAtMs: t, sourceWidth: 3840, sourceHeight: 2160 });
      processed += 1;
      await wait(() => host.stats().framesProcessed === processed && host.stats().workers["rtmdet-tiny"].runs === host.stats().rtmdetRuns, `frame ${i}`);
    }
    i += 1;
  }
  clock += 5000;
  await new Promise((r) => setTimeout(r, 50));
  await host.stop();
  const st = host.stats();

  // per processed frame k (P1 index 2k)
  const gtFrames = times.map((_, k) => (gtAll[clip.id].frames[2 * k] || []) as number[][]);
  const prodFrames = times.map((t) => {
    const y = recorded["yolox-nano"].get(t) || [];
    const r = recorded["rtmdet-tiny"].get(t);
    return (r ? mergeDetections(y, r) : y).map((d) => norm(d, 3840, 2160));
  });
  const refFrames = times.map((t, k) => {
    const y = p1Dets("yolox-nano", clip.id, 2 * k, settings.models.primary.threshold);
    const r = recorded["rtmdet-tiny"].has(t) ? p1Dets("rtmdet-tiny", clip.id, 2 * k, settings.models.secondary.threshold) : null;
    return r ? mergeDetections(y as any, r as any) : y;
  });
  const det: Record<string, { frames: number; anyAgree: number; prodBoxes: number; refBoxes: number; matched: number; scoreDiffs: number[] }> = {};
  for (const model of ["yolox-nano", "rtmdet-tiny"] as PresenceModelId[]) {
    const thr = model === "yolox-nano" ? settings.models.primary.threshold : settings.models.secondary.threshold;
    const acc = { frames: 0, anyAgree: 0, prodBoxes: 0, refBoxes: 0, matched: 0, scoreDiffs: [] as number[] };
    times.forEach((t, k) => {
      const prod = recorded[model].get(t);
      if (!prod) return;
      const a = prod.map((d) => norm(d, 3840, 2160));
      const b = p1Dets(model, clip.id, 2 * k, thr);
      acc.frames += 1;
      acc.anyAgree += (a.length > 0) === (b.length > 0) ? 1 : 0;
      acc.prodBoxes += a.length;
      acc.refBoxes += b.length;
      const usedB = new Set<number>();
      for (const x of a) {
        let bj = -1;
        let best = 0.5;
        b.forEach((y, j) => {
          if (usedB.has(j)) return;
          const v = boxIou(x.box, y.box);
          if (v >= best) {
            best = v;
            bj = j;
          }
        });
        if (bj >= 0) {
          usedB.add(bj);
          acc.matched += 1;
          acc.scoreDiffs.push(Math.abs(x.score - b[bj].score));
        }
      }
    });
    det[model] = acc;
  }
  const prodRecall = personRecall(prodFrames, gtFrames);
  const refRecall = personRecall(refFrames, gtFrames);
  // drafts: true events (best box on a GT person at bestFrameAt) and GT persons covered
  const qualified = drafts.filter((d) => !d.final);
  const covered = new Set<number>();
  const falseEventDetails: Array<Record<string, unknown>> = [];
  let trueEvents = 0;
  for (const d of qualified) {
    const t = Date.parse(d.bestFrameAt);
    const k = times.indexOf(t);
    const g = k >= 0 ? gtFrames[k] : [];
    const b = d.bestBox as Box;
    const nb = [b[0] / 3840, b[1] / 2160, b[2] / 3840, b[3] / 2160];
    let hitTid: number | null = null;
    let best = GT_IOU;
    for (const gb of g) {
      const v = boxIou(nb, gb);
      if (v >= best) {
        best = v;
        hitTid = gb[4];
      }
    }
    if (hitTid !== null) {
      trueEvents += 1;
      if (prodRecall.persons.has(hitTid)) covered.add(hitTid);
    } else {
      falseEventDetails.push({
        atS: Math.round((t - base) / 100) / 10, box: nb.map((v) => Math.round(v * 1000) / 1000), score: d.bestScore,
        models: d.models, inViewMs: d.inViewMs, framesSeen: d.framesSeen,
      });
    }
  }
  return {
    clip: clip.id,
    light: clip.light,
    processed,
    rtmdetRuns: st.rtmdetRuns,
    framesDroppedBusy: st.framesDroppedBusy,
    det,
    personRecall: { prod: [prodRecall.hit, prodRecall.pos], p1: [refRecall.hit, refRecall.pos] },
    personsDisagree: [...prodRecall.persons.entries()].filter(([tid, h]) => refRecall.persons.get(tid) !== h).map(([tid, h]) => ({ tid, prod: h })),
    events: { qualified: qualified.length, finals: drafts.filter((d) => d.final).length, trueEvents, falseEvents: qualified.length - trueEvents, gtPersonsCovered: covered.size },
    falseEventDetails,
    errors: st.errors,
    lastError: st.lastError,
  };
}

async function main() {
  process.stdout.write(`parity: ${clips.length} clips, models ${modelDir}, replayed at ${hour}:00 local\n`);
  const results = [];
  for (const [idx, clip] of clips.entries()) {
    const t0 = Date.now();
    const r = await runClip(clip, idx);
    results.push(r);
    process.stdout.write(
      `${clip.id.slice(0, 36).padEnd(36)} frames ${r.processed} rtm ${r.rtmdetRuns} | recall prod ${r.personRecall.prod.join("/")} p1 ${r.personRecall.p1.join("/")} | ` +
        `events ${r.events.qualified} (true ${r.events.trueEvents}) | yolox agree ${r.det["yolox-nano"].anyAgree}/${r.det["yolox-nano"].frames} | ${Math.round((Date.now() - t0) / 1000)} s\n`,
    );
  }
  const sum = (f: (r: any) => number) => results.reduce((s, r) => s + f(r), 0);
  const diffs = (m: string) => results.flatMap((r) => r.det[m].scoreDiffs).sort((a, b) => a - b);
  const summary: any = {
    clips: results.length,
    hourLocal: hour,
    personRecall: { prod: [sum((r) => r.personRecall.prod[0]), sum((r) => r.personRecall.prod[1])], p1: [sum((r) => r.personRecall.p1[0]), sum((r) => r.personRecall.p1[1])] },
    personsDisagree: sum((r) => r.personsDisagree.length),
    events: {
      qualified: sum((r) => r.events.qualified),
      finals: sum((r) => r.events.finals),
      trueEvents: sum((r) => r.events.trueEvents),
      falseEvents: sum((r) => r.events.falseEvents),
      gtPersonsCovered: sum((r) => r.events.gtPersonsCovered),
    },
    framesDroppedBusy: sum((r) => r.framesDroppedBusy),
    errors: sum((r) => r.errors),
  };
  for (const m of ["yolox-nano", "rtmdet-tiny"]) {
    const d = diffs(m);
    summary[m] = {
      frames: sum((r) => r.det[m].frames),
      anyAgree: sum((r) => r.det[m].anyAgree),
      prodBoxes: sum((r) => r.det[m].prodBoxes),
      refBoxes: sum((r) => r.det[m].refBoxes),
      matched: sum((r) => r.det[m].matched),
      scoreDiffMedian: d.length ? Math.round(d[Math.floor(d.length / 2)] * 1000) / 1000 : null,
      scoreDiffP95: d.length ? Math.round(d[Math.floor(d.length * 0.95)] * 1000) / 1000 : null,
    };
  }
  const out = path.join(work, outName);
  fs.writeFileSync(out, JSON.stringify({ summary, results: results.map((r) => ({ ...r, det: Object.fromEntries(Object.entries(r.det).map(([k, v]: any) => [k, { ...v, scoreDiffs: undefined }])) })) }, null, 1));
  process.stdout.write(`\nsummary ${JSON.stringify(summary)}\nwrote ${out}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
