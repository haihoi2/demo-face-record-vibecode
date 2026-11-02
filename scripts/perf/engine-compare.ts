#!/usr/bin/env -S npx tsx
/**
 * OFFLINE face-recogniser (and detector input size) comparison on this site's
 * own labelled crops - so a model switch is a measured decision (Taiga #513;
 * the detector part feeds #523).
 *
 *   npx tsx scripts/perf/engine-compare.ts <crops-dir> \
 *        --model r50=/models/w600k_r50.onnx \
 *        --model cand=/cand/x.onnx,input=112,mean=127.5,std=127.5,layout=NCHW,rgb \
 *        [--license r50="MIT code; weights non-commercial research (InsightFace)"] \
 *        [--ref r50] [--parent r50_int8=r50] [--threads 2] [--bench-threads 1,2,4] [--bench-iters 40] \
 *        [--exclude EMP-0001,...] [--max-crops N] [--out report.json] [--md report.md] \
 *        [--frames <dir> --detect-size 640,960,1280 [--detect-ref 1280] [--detector-dir /models]]
 *
 * <crops-dir> is the output of scripts/perf/calib-crops.ts (rec_<n>.u8 =
 * 112x112x3 uint8 RGB aligned crops + index.json with labels; crops listed in
 * <crops-dir>/calib are the INT8 calibration set and are excluded). The harness
 * never creates biometric data: it reads the crops, keeps embeddings in memory
 * only, and writes aggregates (assertNoVectors guards the report). Run it in a
 * throwaway container with --network none, models mounted read-only, and delete
 * the crops directory afterwards.
 *
 * Per recogniser: TAR at FAR = 0 and at the site's strict rule (0 strict false
 * accepts AND threshold >= impostor p95 + minMargin), TAR/FAR at FAR = 1e-3,
 * genuine / impostor cosine p5/p50/p95, d', the margin, the thresholds in the
 * candidate's own cosine space that reproduce the reference's operating point
 * at today's acceptSingle / acceptFused (faceFusion.ts DEFAULT_FUSION_THRESHOLDS
 * for arcface_w600k_r50), drift vs an FP32 parent (--parent, same dims only),
 * ms per face at 1/2/4 ORT intra-op threads on this CPU, file size, embedding
 * dim, and whether its input contract matches the engine's (faceEmbedding.ts).
 * Embeddings of different models are never compared with each other.
 *
 * With --frames (full frames, JPEG) the SCRFD detector of --detector-dir (default:
 * the directory of the reference model) runs at each --detect-size square
 * letterbox; faces found, recall / box IoU / landmark agreement with --detect-ref
 * (default the largest size), extra detections and ms per frame are reported.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ort from "onnxruntime-node";
import { DEFAULT_FUSION_THRESHOLDS } from "../../src/server/faceFusion";
import { CLEAR_FACE_LIMITS, detectFaces, faceModelTagFor, getFaceEngine, getFaceEngineInfo, loadImage, resetFaceEngine, type FaceBox, type RgbImage } from "../../src/server/faceEmbedding";
import {
  assertNoVectors,
  buildPairs,
  describePreprocess,
  detectorAgreement,
  dist,
  driftVsParent,
  faceSize,
  l2,
  parseLicenseSpec,
  parseModelSpec,
  parseParentSpec,
  preprocessCrop,
  preprocessMatchesBaseline,
  quantile,
  r3,
  renderDetectorTable,
  renderRecognizerTable,
  reproduceReference,
  resizeBilinearU8,
  scoreSets,
  summarize,
  type CropEntry,
  type DetectorRow,
  type ModelMetrics,
  type ModelSpec,
  type RecognizerRow,
  type Reproduction,
  type ScoreSets,
} from "./engineCompareLib";

// ---------------------------------------------------------------- arguments

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
const cropsDir = positional[0];
const optAll = (name: string) => args.flatMap((a, i) => (a === name && i + 1 < args.length ? [args[i + 1]] : []));
const opt = (name: string, d?: string) => optAll(name)[0] ?? d;
const usage = () => {
  console.error("usage: engine-compare.ts <crops-dir> --model name=path.onnx[,input=..,mean=..,std=..,layout=..,rgb|bgr] [--model ...] [--license name=text] [--ref name] [--parent child=parent] [--threads N] [--bench-threads 1,2,4] [--bench-iters N] [--out report.json] [--md report.md] [--frames dir --detect-size 640,960,1280]");
  process.exit(2);
};
if (!cropsDir || optAll("--model").length === 0) usage();

let MODELS: ModelSpec[] = [];
let LICENSES: Record<string, string> = {};
let PARENTS: Record<string, string> = {};
try {
  MODELS = optAll("--model").map(parseModelSpec);
  LICENSES = Object.fromEntries(optAll("--license").map(parseLicenseSpec).map((l) => [l.name, l.license]));
  PARENTS = Object.fromEntries(optAll("--parent").map(parseParentSpec).map((p) => [p.child, p.parent]));
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(2);
}
const names = new Set<string>();
for (const m of MODELS) {
  if (names.has(m.name)) {
    console.error(`--model: duplicate name "${m.name}"`);
    process.exit(2);
  }
  names.add(m.name);
  if (!fs.existsSync(m.file)) {
    console.error(`--model ${m.name}: file not found: ${m.file}`);
    process.exit(2);
  }
}
for (const [k, v] of Object.entries(LICENSES)) if (!names.has(k)) console.error(`warning: --license ${k}: no such model (${v.slice(0, 40)})`);
for (const [c, p] of Object.entries(PARENTS)) {
  if (!names.has(c) || !names.has(p)) {
    console.error(`--parent ${c}=${p}: both must be --model names`);
    process.exit(2);
  }
}
const REF = opt("--ref", MODELS[0].name)!;
if (!names.has(REF)) {
  console.error(`--ref ${REF}: no such model`);
  process.exit(2);
}
const THREADS = Math.max(1, Number(opt("--threads", process.env.FACE_ORT_THREADS || "2")));
const BENCH_THREADS = opt("--bench-threads", "1,2,4")!.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
const BENCH_ITERS = Math.max(1, Number(opt("--bench-iters", "40")));
const NO_BENCH = args.includes("--no-bench");
const EXCLUDE = new Set((opt("--exclude", "") || "").split(",").filter(Boolean));
const MAX_CROPS = Number(opt("--max-crops", "0"));
const OUT = opt("--out");
const MD = opt("--md");
const FRAMES = opt("--frames");
const DETECT_SIZES = (opt("--detect-size", "640,960,1280") || "").split(",").map(Number).filter((n) => Number.isInteger(n) && n % 32 === 0 && n >= 160);
const DETECT_REF = Number(opt("--detect-ref", String(Math.max(...DETECT_SIZES))));
const DETECTOR_DIR = opt("--detector-dir", path.dirname(MODELS.find((m) => m.name === REF)!.file))!;
const LEGACY = { acceptSingle: DEFAULT_FUSION_THRESHOLDS.acceptSingle, acceptFused: DEFAULT_FUSION_THRESHOLDS.acceptFused, minMargin: DEFAULT_FUSION_THRESHOLDS.minMargin };
const CROP = 112;

// ---------------------------------------------------------------- sessions

async function session(file: string, threads: number) {
  const t0 = Date.now();
  const s = await ort.InferenceSession.create(file, { executionProviders: ["cpu"], graphOptimizationLevel: "all", intraOpNumThreads: threads, logSeverityLevel: 3 });
  if (s.inputNames.length !== 1) throw new Error(`${path.basename(file)}: expected 1 input, got ${s.inputNames.length} (${s.inputNames.join(", ")})`);
  return { s, loadMs: Date.now() - t0, input: s.inputNames[0], output: s.outputNames[0] };
}

function readCrop(n: number): { width: number; height: number; data: Uint8Array } {
  const buf = fs.readFileSync(path.join(cropsDir, `rec_${n}.u8`));
  if (buf.length !== CROP * CROP * 3) throw new Error(`rec_${n}.u8: ${buf.length} bytes, expected ${CROP * CROP * 3} (112x112x3 RGB)`);
  return { width: CROP, height: CROP, data: new Uint8Array(buf.buffer, buf.byteOffset, buf.length) };
}

/** All crops through one model; embeddings stay in memory (never written). */
async function embedAll(m: ModelSpec, entries: CropEntry[]): Promise<{ emb: Map<number, Float32Array>; dim: number; loadMs: number; wallMs: number; outputs: number }> {
  const { s, loadMs, input, output } = await session(m.file, THREADS);
  const outputs = s.outputNames.length;
  const emb = new Map<number, Float32Array>();
  let dim = 0;
  const t0 = Date.now();
  try {
    for (const e of entries) {
      const { data, dims } = preprocessCrop(readCrop(e.n), m, resizeBilinearU8);
      const res = await s.run({ [input]: new ort.Tensor("float32", data, dims) });
      const raw = res[output].data;
      if (!(raw instanceof Float32Array)) throw new Error(`${m.name}: output "${output}" is ${res[output].type}, expected float32`);
      if (dim === 0) dim = raw.length;
      if (raw.length !== dim) throw new Error(`${m.name}: embedding length changed (${raw.length} vs ${dim})`);
      for (let i = 0; i < raw.length; i++) if (!Number.isFinite(raw[i])) throw new Error(`${m.name}: non-finite value in the embedding of crop ${e.n} (corrupt model or input?)`);
      emb.set(e.n, l2(raw));
    }
  } finally {
    await s.release();
  }
  return { emb, dim, loadMs, wallMs: Date.now() - t0, outputs };
}

async function bench(m: ModelSpec, sample: Array<{ width: number; height: number; data: Uint8Array }>) {
  const out: Record<string, { loadMs: number; medianMs: number; p95Ms: number; minMs: number }> = {};
  for (const th of BENCH_THREADS) {
    const { s, loadMs, input } = await session(m.file, th);
    try {
      const tensors = sample.map((c) => {
        const { data, dims } = preprocessCrop(c, m, resizeBilinearU8);
        return new ort.Tensor("float32", data, dims);
      });
      for (let i = 0; i < Math.min(5, BENCH_ITERS); i++) await s.run({ [input]: tensors[i % tensors.length] });
      const times: number[] = [];
      for (let i = 0; i < BENCH_ITERS; i++) {
        const t0 = process.hrtime.bigint();
        await s.run({ [input]: tensors[i % tensors.length] });
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      times.sort((a, b) => a - b);
      out[`threads${th}`] = { loadMs, medianMs: r3(quantile(times, 0.5)), p95Ms: r3(quantile(times, 0.95)), minMs: r3(times[0]) };
    } finally {
      await s.release();
    }
  }
  return out;
}

// ---------------------------------------------------------------- detector input size

async function detectorPass(frames: RgbImage[], size: number) {
  process.env.FACE_MODEL_DIR = DETECTOR_DIR;
  process.env.FACE_ORT_THREADS = String(THREADS);
  process.env.FACE_ORT_LOG_LEVEL = "3"; // det_10g's metadata is baked for 640: silence the per-run shape warnings
  process.env.FACE_DETECT_UPSCALE = process.env.FACE_DETECT_UPSCALE || "none";
  process.env.FACE_DETECT_SIZE = String(size);
  delete process.env.FACE_RECOGNIZER_MODEL; // the engine also opens a recogniser; use the directory's default
  resetFaceEngine();
  if (!(await getFaceEngine())) throw new Error(`detector engine unavailable in ${DETECTOR_DIR}: ${getFaceEngineInfo().lastError}`);
  const info = getFaceEngineInfo();
  const faces: FaceBox[][] = [];
  const ms: number[] = [];
  for (const img of frames) {
    const t0 = process.hrtime.bigint();
    faces.push(await detectFaces(img, { inputShape: { width: size, height: size } }));
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  ms.sort((a, b) => a - b);
  return { faces, ms, detector: info.detectorModel, loadMs: info.loadTimeMs };
}

// ---------------------------------------------------------------- main

async function main() {
  const indexFile = path.join(cropsDir, "index.json");
  if (!fs.existsSync(indexFile)) throw new Error(`${indexFile} missing: <crops-dir> must be a scripts/perf/calib-crops.ts output`);
  const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  const all: CropEntry[] = index.entries;
  const calibSet = new Set<number>(fs.existsSync(path.join(cropsDir, "calib")) ? fs.readdirSync(path.join(cropsDir, "calib")).map((f) => Number(f.replace(/^rec_|\.u8$/g, ""))) : []);
  let entries = all.filter((e) => !calibSet.has(e.n) && !(e.identity && EXCLUDE.has(e.identity)) && fs.existsSync(path.join(cropsDir, `rec_${e.n}.u8`)));
  if (MAX_CROPS > 0 && entries.length > MAX_CROPS) entries = entries.filter((_, i) => i % Math.ceil(entries.length / MAX_CROPS) === 0).slice(0, MAX_CROPS);
  if (entries.length < 2) throw new Error(`only ${entries.length} crops to score`);
  const identities = new Map<string, number>();
  for (const e of entries) identities.set(e.identity ?? "(none)", (identities.get(e.identity ?? "(none)") ?? 0) + 1);
  const pairs = buildPairs(entries);
  const pairCounts = pairs.reduce((acc, p) => ((acc[p.kind] = (acc[p.kind] ?? 0) + 1), acc), {} as Record<string, number>);
  const synthetic = index.synthetic === true;
  console.log(`crops ${all.length} (${calibSet.size} calibration-set, excluded) -> ${entries.length} scored; identities ${identities.size}; pairs ${JSON.stringify(pairCounts)}`);
  if (synthetic) console.log("WARNING: index.json is marked synthetic - the crop set is a non-biometric fixture; accuracy numbers mean nothing, only the report shape and model mechanics are validated.");

  // Template-tag collisions: two different files that would get the same tag could mix embeddings in the gallery.
  const tagOf = (m: ModelSpec) => faceModelTagFor(path.basename(m.file));
  const byTag = new Map<string, string[]>();
  for (const m of MODELS) byTag.set(tagOf(m), [...(byTag.get(tagOf(m)) ?? []), m.name]);

  const report: any = {
    createdAt: new Date().toISOString(),
    taiga: ["#513", "#523"],
    synthetic,
    cropsDir: path.basename(cropsDir),
    host: { cpu: os.cpus()[0]?.model ?? "unknown", cpus: os.cpus().length, loadavg: os.loadavg().map(r3), node: process.version, ort: "onnxruntime-node", threads: THREADS },
    crops: { total: all.length, scored: entries.length, calibrationExcluded: calibSet.size, identities: identities.size, employeesWithLabels: [...identities.keys()].filter((k) => k.startsWith("EMP-")).length, byIdentity: Object.fromEntries([...identities].sort((a, b) => b[1] - a[1])) },
    excludedIdentities: [...EXCLUDE],
    pairs: pairCounts,
    legacyThresholds: { ...LEGACY, tag: "arcface_w600k_r50", source: "faceFusion.ts DEFAULT_FUSION_THRESHOLDS" },
    reference: REF,
    models: {} as Record<string, any>,
  };

  const results = new Map<string, { sets: ScoreSets; metrics: ModelMetrics; emb: Map<number, Float32Array>; dim: number }>();
  for (const m of MODELS) {
    const { emb, dim, loadMs, wallMs } = await embedAll(m, entries);
    const sets = scoreSets(emb, pairs);
    const metrics = summarize(sets, LEGACY);
    results.set(m.name, { sets, metrics, emb, dim });
    const tag = tagOf(m);
    const collision = (byTag.get(tag) ?? []).filter((n) => n !== m.name);
    report.models[m.name] = {
      file: path.basename(m.file),
      fileMB: r3(fs.statSync(m.file).size / 1e6),
      license: LICENSES[m.name] ?? "cần kiểm tra (no --license given)",
      preprocess: { input: m.input, mean: m.mean, std: m.std, layout: m.layout, channels: m.channels, text: describePreprocess(m), matchesEngine: preprocessMatchesBaseline(m) },
      embeddingDim: dim,
      /** What faceEmbedding.ts would stamp on this file's templates if it were loaded through FACE_RECOGNIZER_MODEL / PIPELINE_RECOGNIZER_MODEL. */
      modelTagIfLoaded: tag,
      tagCollidesWith: collision,
      /** The engine refuses anything but 512-D NCHW 112 RGB today; a different contract needs engine work before any switch. */
      loadableByCurrentEngine: dim === 512 && preprocessMatchesBaseline(m),
      embed: { loadMs, wallMs, msPerFaceAtThreads: r3(wallMs / entries.length) },
      ...metrics,
    };
    console.log(`${m.name}: ${entries.length} crops in ${(wallMs / 1000).toFixed(1)} s (${r3(wallMs / entries.length)} ms/face at ${THREADS} threads, load ${loadMs} ms), dim ${dim}, tag ${tag}${collision.length ? ` (COLLIDES with ${collision.join(", ")})` : ""}`);
  }

  const ref = results.get(REF)!;
  for (const m of MODELS) {
    const r = results.get(m.name)!;
    const rp: Reproduction | null = m.name === REF ? null : reproduceReference(REF, ref, r, LEGACY);
    report.models[m.name].matchReference = rp;
    report.models[m.name].identicalToReference = m.name !== REF && JSON.stringify(r.metrics) === JSON.stringify(ref.metrics);
    const parent = PARENTS[m.name];
    if (parent) {
      const p = results.get(parent)!;
      report.models[m.name].driftVsParent = p.dim === r.dim ? { parent, ...driftVsParent(r.emb, p.emb) } : { parent, error: `dims differ (${r.dim} vs ${p.dim}); drift undefined` };
    }
  }

  if (!NO_BENCH) {
    const sample = entries.slice(0, 16).map((e) => readCrop(e.n));
    for (const m of MODELS) {
      report.models[m.name].latency = await bench(m, sample);
      const l = report.models[m.name].latency;
      const rl = report.models[REF].latency;
      for (const th of BENCH_THREADS) if (rl?.[`threads${th}`] && l[`threads${th}`]) l[`threads${th}`].speedupVsRef = r3(rl[`threads${th}`].medianMs / l[`threads${th}`].medianMs);
      console.log(`latency ${m.name}: ${BENCH_THREADS.map((th) => `${th}t ${l[`threads${th}`].medianMs} ms (p95 ${l[`threads${th}`].p95Ms})`).join(", ")}`);
    }
  }

  // Detector input size on full frames (Taiga #523).
  let detectorMd = "";
  if (FRAMES) {
    const files = fs.readdirSync(FRAMES).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
    const frames: RgbImage[] = [];
    for (const f of files) {
      const img = await loadImage(fs.readFileSync(path.join(FRAMES, f)));
      if (img) frames.push(img);
    }
    if (!frames.length) throw new Error(`--frames ${FRAMES}: no decodable frames`);
    const sizes = [...new Set([...DETECT_SIZES, DETECT_REF])].sort((a, b) => a - b);
    const minPx = CLEAR_FACE_LIMITS.minFacePx;
    const passes = new Map<number, Awaited<ReturnType<typeof detectorPass>>>();
    for (const s of sizes) {
      passes.set(s, await detectorPass(frames, s));
      const p = passes.get(s)!;
      console.log(`detector @${s}: faces ${p.faces.flat().length} (>=${minPx}px ${p.faces.flat().filter((f) => faceSize(f) >= minPx).length}), ms/frame p50 ${r3(quantile(p.ms, 0.5))}`);
    }
    const refPass = passes.get(DETECT_REF)!;
    const rows: DetectorRow[] = sizes.map((s) => {
      const p = passes.get(s)!;
      return {
        size: s,
        facesAll: p.faces.flat().length,
        facesAtLeastMin: p.faces.flat().filter((f) => faceSize(f) >= minPx).length,
        msPerFrame: dist(p.ms, (v) => Math.round(v)),
        vsRef: s === DETECT_REF ? null : detectorAgreement(refPass.faces, p.faces, minPx),
      };
    });
    report.detector = {
      detector: refPass.detector,
      detectorDir: path.basename(DETECTOR_DIR),
      frames: frames.length,
      frameSize: { width: frames[0].width, height: frames[0].height },
      refSize: DETECT_REF,
      minFacePx: minPx,
      threads: THREADS,
      sizes: Object.fromEntries(rows.map((r) => [String(r.size), { ...r, loadMs: passes.get(r.size)!.loadMs }])),
    };
    detectorMd = renderDetectorTable(rows, DETECT_REF, minPx, THREADS);
  }

  assertNoVectors(report);
  const rows: RecognizerRow[] = MODELS.map((m) => {
    const r = report.models[m.name];
    const lat: Record<string, number | undefined> = {};
    for (const th of BENCH_THREADS) lat[`threads${th}`] = r.latency?.[`threads${th}`]?.medianMs;
    return {
      name: m.name,
      license: r.license,
      fileMB: r.fileMB,
      dim: r.embeddingDim,
      preprocess: r.preprocess.matchesEngine ? "engine" : r.preprocess.text,
      metrics: results.get(m.name)!.metrics,
      reproduction: r.matchReference,
      drift: r.driftVsParent && !r.driftVsParent.error ? { parent: r.driftVsParent.parent, p50: r.driftVsParent.p50, p95: r.driftVsParent.p95 } : null,
      latencyMs: lat,
      identicalToRef: r.identicalToReference === true,
    };
  });
  const md = [
    `# Engine comparison ${report.createdAt}${synthetic ? " - SYNTHETIC FIXTURE, numbers are not accuracy" : ""}`,
    "",
    `Crops ${entries.length} (${identities.size} identities), pairs ${Object.entries(pairCounts).map(([k, v]) => `${k} ${v}`).join(", ")}; reference ${REF}; legacy thresholds ${LEGACY.acceptSingle} / ${LEGACY.acceptFused} (margin ${LEGACY.minMargin}); CPU ${report.host.cpu} (${report.host.cpus} cores, load ${report.host.loadavg.join("/")}).`,
    "",
    renderRecognizerTable(rows, BENCH_THREADS),
    "",
    "TAR = genuine pairs accepted; FA = strict false accepts (count); margin = threshold - strict impostor p95; preprocess 'engine' = the contract faceEmbedding.ts implements (112 NCHW RGB (x-127.5)/127.5). Labels are weak (from the current engine's decisions), so the table favours the baseline.",
  ];
  for (const m of MODELS) {
    const r = report.models[m.name];
    if (r.tagCollidesWith.length) md.push(`- WARNING ${m.name}: template tag ${r.modelTagIfLoaded} collides with ${r.tagCollidesWith.join(", ")} (same file name) - embeddings would mix in a gallery.`);
    if (!r.loadableByCurrentEngine) md.push(`- NOTE ${m.name}: dim ${r.embeddingDim}, ${r.preprocess.text}: the current engine cannot load this contract (fail closed); engine + tag work needed before any switch.`);
  }
  if (detectorMd) md.push("", `## Detector input size (${report.detector.detector}, ${report.detector.frames} frames of ${report.detector.frameSize.width}x${report.detector.frameSize.height}, ref ${DETECT_REF})`, "", detectorMd);
  const mdText = md.join("\n");
  console.log("\n" + mdText);
  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1), { mode: 0o600 });
    console.log(`\nreport -> ${OUT}`);
  }
  if (MD) fs.writeFileSync(MD, mdText + "\n", { mode: 0o600 });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
