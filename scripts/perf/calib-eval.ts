#!/usr/bin/env -S npx tsx
/**
 * Recogniser calibration on this site's own captures (real-time pipeline, CALIB).
 *
 *   npx tsx scripts/perf/calib-eval.ts <crops-dir> --models r50=/models/w600k_r50.onnx,mbf=/models/candidates/w600k_mbf.onnx
 *        --out <report.json> [--ref r50] [--parents r50_int8=r50,mbf_int8=mbf] [--threads 2]
 *        [--bench-threads 1,2] [--bench-iters 60] [--via-crop] [--no-bench]
 *
 * <crops-dir> is the output of scripts/perf/calib-crops.ts. For every model the
 * aligned crops are embedded exactly as faceEmbedding.ts embedFace() does
 * ((px - 127.5) / 127.5, NCHW RGB, L2-normalised output) with a plain
 * onnxruntime-node session (CPU EP, graph optimisation "all"). Embeddings are
 * cached as <crops-dir>/emb_<model>.f32 (biometric derivatives: delete with the
 * directory).
 *
 * Pair sets (crops of the calibration subset <crops-dir>/calib are excluded):
 *   genuine           same identity, different capture (log row or clip frame);
 *                     split into same-gate / cross-gate, and "within track"
 *                     (two frames of one clip passage) reported separately
 *   impostor strict   two employee-labelled crops with different employeeIds
 *   impostor probable an employee-labelled crop vs a DENIED/stranger crop (the
 *                     stranger might be an employee the legacy engine missed)
 * Labels are WEAK: they come from the FP32 r50 decisions themselves, so the
 * comparison favours r50 and cannot see r50's own false accepts.
 *
 * Per model: cosine p5/p50/p95 of each set, TAR at FAR = 0 and 1e-3 (strict
 * impostors), FAR/TAR at the legacy thresholds (0.55 single / 0.45 fused), the
 * thresholds that reproduce the reference model's TAR and FAR at those points,
 * the margin between that threshold and the impostor p95 (the fusion margin is
 * 0.08), drift vs the FP32 parent for quantized models, k-best-frame fusion on
 * clip passages (k = 1, 2, 3, 5), and latency (median/p95) at 1 and 2 threads.
 * Aggregates only - no embeddings or pixels leave the crops directory.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ort from "onnxruntime-node";

interface Entry {
  n: number;
  source: "log" | "clip";
  groupId: string;
  identity: string | null;
  status: string;
  gate: string;
  quality: number;
  boxSize: number;
  viaCrop?: { found: boolean };
}

const args = process.argv.slice(2);
const cropsDir = args[0];
const opt = (name: string, d?: string) => {
  const i = args.indexOf(name);
  return i > 0 ? args[i + 1] : d;
};
if (!cropsDir || !opt("--models")) {
  console.error("usage: calib-eval.ts <crops-dir> --models name=path[,name=path...] --out report.json [options]");
  process.exit(2);
}
const MODELS = opt("--models")!.split(",").map((kv) => {
  const [name, file] = kv.split("=");
  return { name, file };
});
const REF = opt("--ref", MODELS[0].name)!;
const PARENTS = Object.fromEntries((opt("--parents", "") || "").split(",").filter(Boolean).map((kv) => kv.split("=") as [string, string]));
const THREADS = Number(opt("--threads", "2"));
const BENCH_THREADS = opt("--bench-threads", "1,2")!.split(",").map(Number);
const BENCH_ITERS = Number(opt("--bench-iters", "60"));
const VIA_CROP = args.includes("--via-crop");
const NO_BENCH = args.includes("--no-bench");
const OUT = opt("--out");
/** Identities excluded from scoring (declared in the report), e.g. a suspected duplicate employee id. */
const EXCLUDE = new Set((opt("--exclude", "") || "").split(",").filter(Boolean));
const SIZE = 112;
const PLANE = SIZE * SIZE;
const LEGACY = { acceptSingle: 0.55, acceptFused: 0.45, minMargin: 0.08 };

// ---------------------------------------------------------------- helpers

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const r3 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
const r4 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : v);
function frac(sorted: number[], pred: (v: number) => boolean): number {
  if (sorted.length === 0) return NaN;
  let c = 0;
  for (const v of sorted) if (pred(v)) c++;
  return c / sorted.length;
}
function dist(sorted: number[]) {
  return sorted.length
    ? { n: sorted.length, min: r3(sorted[0]), p5: r3(quantile(sorted, 0.05)), p50: r3(quantile(sorted, 0.5)), p95: r3(quantile(sorted, 0.95)), max: r3(sorted[sorted.length - 1]) }
    : { n: 0 };
}
function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function l2(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  const out = new Float32Array(v.length);
  if (n > 0) for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}
function toTensor(u8: Buffer): ort.Tensor {
  const data = new Float32Array(3 * PLANE);
  for (let i = 0; i < PLANE; i++) {
    const s = i * 3;
    data[i] = (u8[s] - 127.5) / 127.5;
    data[PLANE + i] = (u8[s + 1] - 127.5) / 127.5;
    data[2 * PLANE + i] = (u8[s + 2] - 127.5) / 127.5;
  }
  return new ort.Tensor("float32", data, [1, 3, SIZE, SIZE]);
}
async function session(file: string, threads: number) {
  const t0 = Date.now();
  const s = await ort.InferenceSession.create(file, { executionProviders: ["cpu"], graphOptimizationLevel: "all", intraOpNumThreads: threads });
  return { s, loadMs: Date.now() - t0 };
}

// ---------------------------------------------------------------- embeddings

async function embedAll(model: { name: string; file: string }, entries: Entry[], prefix: "rec" | "crop"): Promise<Map<number, Float32Array>> {
  const cache = path.join(cropsDir, `emb_${model.name}${prefix === "crop" ? "_viacrop" : ""}.f32`);
  const out = new Map<number, Float32Array>();
  const wanted = entries.filter((e) => prefix === "rec" || e.viaCrop?.found).map((e) => e.n);
  if (fs.existsSync(cache)) {
    const buf = fs.readFileSync(cache);
    const idx: number[] = JSON.parse(fs.readFileSync(cache + ".idx", "utf8"));
    for (let i = 0; i < idx.length; i++) out.set(idx[i], new Float32Array(buf.buffer.slice(buf.byteOffset + i * 512 * 4, buf.byteOffset + (i + 1) * 512 * 4)));
    if (wanted.every((n) => out.has(n))) {
      console.log(`${model.name}/${prefix}: ${out.size} embeddings from cache`);
      return out;
    }
  }
  const missing = wanted.filter((n) => !out.has(n));
  const { s, loadMs } = await session(model.file, THREADS);
  const input = s.inputNames[0];
  const output = s.outputNames[0];
  const t0 = Date.now();
  let dim = 0;
  for (const n of missing) {
    const u8 = fs.readFileSync(path.join(cropsDir, `${prefix}_${n}.u8`));
    const res = await s.run({ [input]: toTensor(u8) });
    const raw = res[output].data as Float32Array;
    dim = raw.length;
    if (dim !== 512) throw new Error(`${model.name}: embedding dim ${dim}, expected 512`);
    out.set(n, l2(raw));
  }
  const idx = [...out.keys()];
  const buf = Buffer.alloc(idx.length * 512 * 4);
  idx.forEach((n, i) => Buffer.from(out.get(n)!.buffer).copy(buf, i * 512 * 4));
  fs.writeFileSync(cache, buf, { mode: 0o600 });
  fs.writeFileSync(cache + ".idx", JSON.stringify(idx), { mode: 0o600 });
  console.log(`${model.name}/${prefix}: ${missing.length} crops embedded in ${((Date.now() - t0) / 1000).toFixed(0)} s (load ${loadMs} ms, ${THREADS} threads); ${idx.length} cached`);
  await s.release();
  return out;
}

// ---------------------------------------------------------------- pairs

type PairKind = "genuineSameGate" | "genuineCrossGate" | "withinTrack" | "impostorStrict" | "impostorProbable" | "genuineEntry" | "genuineExit";
interface Pair {
  a: number;
  b: number;
  kind: PairKind;
}
const isEmployee = (id: string | null) => !!id && id.startsWith("EMP-");
const passageOf = (e: Entry) => (e.source === "clip" ? e.groupId.split("/")[0] : e.groupId);

function buildPairs(entries: Entry[]): Pair[] {
  const pairs: Pair[] = [];
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i];
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j];
      if (a.groupId === b.groupId) continue;
      if (a.identity && a.identity === b.identity) {
        if (a.source === "clip" && b.source === "clip" && passageOf(a) === passageOf(b)) pairs.push({ a: a.n, b: b.n, kind: "withinTrack" });
        else {
          pairs.push({ a: a.n, b: b.n, kind: a.gate === b.gate ? "genuineSameGate" : "genuineCrossGate" });
          if (a.gate === b.gate) pairs.push({ a: a.n, b: b.n, kind: a.gate === "ENTRY" ? "genuineEntry" : "genuineExit" });
        }
      } else if (isEmployee(a.identity) && isEmployee(b.identity)) pairs.push({ a: a.n, b: b.n, kind: "impostorStrict" });
      else if (isEmployee(a.identity) !== isEmployee(b.identity)) pairs.push({ a: a.n, b: b.n, kind: "impostorProbable" });
      // stranger vs stranger / denied vs denied: unknown relation, not a pair
    }
  }
  return pairs;
}

function scoreSets(emb: Map<number, Float32Array>, pairs: Pair[]): Record<PairKind, number[]> {
  const sets: Record<PairKind, number[]> = { genuineSameGate: [], genuineCrossGate: [], withinTrack: [], impostorStrict: [], impostorProbable: [], genuineEntry: [], genuineExit: [] };
  for (const p of pairs) {
    const a = emb.get(p.a);
    const b = emb.get(p.b);
    if (!a || !b) continue;
    sets[p.kind].push(dot(a, b));
  }
  for (const k of Object.keys(sets) as PairKind[]) sets[k].sort((x, y) => x - y);
  return sets;
}

interface OperatingPoint {
  threshold: number;
  tar: number;
  farStrict: number;
  farProbable: number;
  marginToImpostorP95: number;
}
function atThreshold(gen: number[], imp: number[], prob: number[], t: number): OperatingPoint {
  return {
    threshold: r3(t),
    tar: r4(frac(gen, (v) => v >= t)),
    farStrict: r4(frac(imp, (v) => v >= t)),
    farProbable: r4(frac(prob, (v) => v >= t)),
    marginToImpostorP95: r3(t - quantile(imp, 0.95)),
  };
}
/** Smallest threshold with FAR <= far on `imp` (sorted). */
function thresholdAtFar(imp: number[], far: number): number {
  if (imp.length === 0) return NaN;
  const allowed = Math.floor(far * imp.length);
  const idx = imp.length - allowed; // first accepted impostor index
  return idx >= imp.length ? imp[imp.length - 1] + 1e-6 : Math.max(imp[idx], (imp[idx - 1] ?? -1) + 1e-6);
}
/** Threshold at which `gen` (sorted) reaches TAR >= tar. */
function thresholdAtTar(gen: number[], tar: number): number {
  if (gen.length === 0) return NaN;
  const idx = Math.max(0, Math.min(gen.length - 1, Math.floor((1 - tar) * gen.length)));
  return gen[idx];
}

function summarize(sets: Record<PairKind, number[]>) {
  const gen = [...sets.genuineSameGate, ...sets.genuineCrossGate].sort((x, y) => x - y);
  const imp = sets.impostorStrict;
  const prob = sets.impostorProbable;
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);
  const varr = (v: number[]) => {
    const m = mean(v);
    return v.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(1, v.length - 1);
  };
  const tFar0 = thresholdAtFar(imp, 0);
  const tFar3 = thresholdAtFar(imp, 1e-3);
  return {
    genuine: dist(gen),
    genuineSameGate: dist(sets.genuineSameGate),
    genuineEntry: dist(sets.genuineEntry),
    genuineExit: dist(sets.genuineExit),
    genuineCrossGate: dist(sets.genuineCrossGate),
    withinTrack: dist(sets.withinTrack),
    impostorStrict: dist(imp),
    impostorProbable: dist(prob),
    dPrime: r3((mean(gen) - mean(imp)) / Math.sqrt((varr(gen) + varr(imp)) / 2)),
    tarAtFar0: { threshold: r3(tFar0), tar: r4(frac(gen, (v) => v >= tFar0)), tarEntry: r4(frac(sets.genuineEntry, (v) => v >= tFar0)), tarExit: r4(frac(sets.genuineExit, (v) => v >= tFar0)), tarCrossGate: r4(frac(sets.genuineCrossGate, (v) => v >= tFar0)), farProbable: r4(frac(prob, (v) => v >= tFar0)) },
    tarAtFar1e3: { threshold: r3(tFar3), tar: r4(frac(gen, (v) => v >= tFar3)), farProbable: r4(frac(prob, (v) => v >= tFar3)) },
    legacySingle: atThreshold(gen, imp, prob, LEGACY.acceptSingle),
    legacyFused: atThreshold(gen, imp, prob, LEGACY.acceptFused),
    _gen: gen,
    _imp: imp,
    _prob: prob,
  };
}

// ---------------------------------------------------------------- k-best fusion on clip passages

function fusion(entries: Entry[], emb: Map<number, Float32Array>) {
  const byId = new Map<string, Entry[]>();
  for (const e of entries) if (e.identity && emb.has(e.n)) byId.set(e.identity, [...(byId.get(e.identity) ?? []), e]);
  const employees = [...byId.keys()].filter(isEmployee);
  const passages = new Map<string, Entry[]>(); // "identity|passage" -> frames
  for (const e of entries) {
    if (!e.identity || e.source !== "clip" || !emb.has(e.n)) continue;
    const key = `${e.identity}|${passageOf(e)}`;
    passages.set(key, [...(passages.get(key) ?? []), e]);
  }
  const maxCos = (probe: Float32Array, gallery: Entry[]) => {
    let best = -1;
    for (const g of gallery) best = Math.max(best, dot(probe, emb.get(g.n)!));
    return best;
  };
  const ks = [1, 2, 3, 5];
  const out: Record<string, any> = {};
  for (const k of ks) {
    const gen: number[] = [];
    const imp: number[] = [];
    const prob: number[] = [];
    let probePassages = 0;
    for (const [key, frames] of passages) {
      const [identity, passage] = key.split("|");
      const top = [...frames].sort((a, b) => b.quality - a.quality).slice(0, k);
      const fused = (gallery: Entry[]) => top.reduce((s, f) => s + maxCos(emb.get(f.n)!, gallery), 0) / top.length;
      if (isEmployee(identity)) {
        const own = (byId.get(identity) ?? []).filter((e) => !(e.source === "clip" && passageOf(e) === passage));
        if (own.length === 0) continue;
        probePassages++;
        gen.push(fused(own));
        for (const other of employees) if (other !== identity) imp.push(fused(byId.get(other)!));
      } else {
        for (const other of employees) prob.push(fused(byId.get(other)!));
      }
    }
    gen.sort((a, b) => a - b);
    imp.sort((a, b) => a - b);
    prob.sort((a, b) => a - b);
    const t0 = thresholdAtFar(imp, 0);
    out[`k${k}`] = {
      employeePassages: probePassages,
      genuine: dist(gen),
      impostorStrict: dist(imp),
      impostorProbable: dist(prob),
      tarAtFar0: { threshold: r3(t0), tar: r4(frac(gen, (v) => v >= t0)), farProbable: r4(frac(prob, (v) => v >= t0)) },
      legacyFused: atThreshold(gen, imp, prob, LEGACY.acceptFused),
    };
  }
  return out;
}

// ---------------------------------------------------------------- gallery size per person (templates cap)

/**
 * Fewer templates per person: for each employee with enough crops, the gallery is
 * the k best-quality crops (ties by n) and every other crop of that employee is a
 * probe; impostor probes are all other-identity crops (employees and DENIED).
 * Scores are max cosine to the gallery, i.e. what scoreAgainstTemplates does.
 */
function galleryCap(entries: Entry[], emb: Map<number, Float32Array>) {
  const byId = new Map<string, Entry[]>();
  for (const e of entries) if (isEmployee(e.identity) && emb.has(e.n)) byId.set(e.identity!, [...(byId.get(e.identity!) ?? []), e]);
  const others = entries.filter((e) => emb.has(e.n));
  const out: Record<string, any> = {};
  for (const k of [1, 2, 3, 5, 10]) {
    const gen: number[] = [];
    const impS: number[] = [];
    const impP: number[] = [];
    let employees = 0;
    for (const [id, crops] of byId) {
      if (crops.length < k + 3) continue;
      employees++;
      const sorted = [...crops].sort((a, b) => b.quality - a.quality || a.n - b.n);
      const gallery = sorted.slice(0, k);
      const gallerySet = new Set(gallery.map((g) => g.n));
      const score = (n: number) => Math.max(...gallery.map((g) => dot(emb.get(n)!, emb.get(g.n)!)));
      for (const p of sorted) if (!gallerySet.has(p.n) && !gallery.some((g) => g.groupId === p.groupId)) gen.push(score(p.n));
      for (const o of others) {
        if (o.identity === id) continue;
        if (isEmployee(o.identity)) impS.push(score(o.n));
        else if (!o.identity) impP.push(score(o.n));
      }
    }
    gen.sort((a, b) => a - b);
    impS.sort((a, b) => a - b);
    impP.sort((a, b) => a - b);
    const t0 = thresholdAtFar(impS, 0);
    out[`k${k}`] = {
      employees,
      genuine: dist(gen),
      impostorStrict: dist(impS),
      impostorProbable: dist(impP),
      tarAtFar0: { threshold: r3(t0), tar: r4(frac(gen, (v) => v >= t0)), farProbable: r4(frac(impP, (v) => v >= t0)) },
      legacySingle: atThreshold(gen, impS, impP, LEGACY.acceptSingle),
    };
  }
  return out;
}

// ---------------------------------------------------------------- latency

async function bench(model: { name: string; file: string }, sample: Buffer[]) {
  const res: Record<string, any> = { fileMB: r3(fs.statSync(model.file).size / 1e6) };
  for (const th of BENCH_THREADS) {
    const { s, loadMs } = await session(model.file, th);
    const input = s.inputNames[0];
    for (let i = 0; i < 5; i++) await s.run({ [input]: toTensor(sample[i % sample.length]) });
    const times: number[] = [];
    for (let i = 0; i < BENCH_ITERS; i++) {
      const t = toTensor(sample[i % sample.length]);
      const t0 = process.hrtime.bigint();
      await s.run({ [input]: t });
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    times.sort((a, b) => a - b);
    res[`threads${th}`] = { loadMs, medianMs: r3(quantile(times, 0.5)), p95Ms: r3(quantile(times, 0.95)), minMs: r3(times[0]) };
    await s.release();
  }
  return res;
}

// ---------------------------------------------------------------- main

async function main() {
  const index = JSON.parse(fs.readFileSync(path.join(cropsDir, "index.json"), "utf8"));
  const all: Entry[] = index.entries;
  const calibSet = new Set<number>(
    fs.existsSync(path.join(cropsDir, "calib")) ? fs.readdirSync(path.join(cropsDir, "calib")).map((f) => Number(f.replace(/^rec_|\.u8$/g, ""))) : [],
  );
  const entries = all.filter((e) => !calibSet.has(e.n) && !(e.identity && EXCLUDE.has(e.identity)));
  const identities = new Map<string, number>();
  for (const e of entries) identities.set(e.identity ?? "(none)", (identities.get(e.identity ?? "(none)") ?? 0) + 1);
  const pairs = buildPairs(entries);
  const counts = pairs.reduce((acc, p) => ((acc[p.kind] = (acc[p.kind] ?? 0) + 1), acc), {} as Record<string, number>);
  console.log(`crops ${all.length} (${calibSet.size} in the INT8 calibration set, excluded) -> ${entries.length} scored; identities:`, Object.fromEntries([...identities].sort((a, b) => b[1] - a[1])));
  console.log("pairs:", counts);

  const report: any = {
    createdAt: new Date().toISOString(),
    cropsDir: path.basename(cropsDir),
    host: { cpus: os.cpus().length, loadavg: os.loadavg().map(r3), ort: "onnxruntime-node" },
    minFacePx: index.minFacePx,
    detectSize: index.detectSize,
    excludedIdentities: [...EXCLUDE],
    crops: { total: all.length, scored: entries.length, calibrationExcluded: calibSet.size, byIdentity: Object.fromEntries(identities), employeesWithLabels: [...identities.keys()].filter(isEmployee).length },
    pairs: counts,
    legacyThresholds: LEGACY,
    models: {},
  };

  const embs = new Map<string, Map<number, Float32Array>>();
  const sums = new Map<string, ReturnType<typeof summarize>>();
  for (const m of MODELS) {
    const emb = await embedAll(m, entries, "rec");
    embs.set(m.name, emb);
    const sum = summarize(scoreSets(emb, pairs));
    sums.set(m.name, sum);
    const { _gen, _imp, _prob, ...pub } = sum;
    report.models[m.name] = { file: path.basename(m.file), ...pub, fusion: fusion(entries, emb), galleryCap: galleryCap(entries, emb) };
    if (VIA_CROP) {
      const embC = await embedAll(m, entries, "crop");
      // Same-face agreement between the full-frame path and the stored-crop path (what a derived gallery would embed).
      const agree: number[] = [];
      for (const [n, v] of embC) if (emb.has(n)) agree.push(dot(v, emb.get(n)!));
      agree.sort((a, b) => a - b);
      const { _gen: g2, _imp: i2, _prob: p2, ...pubC } = summarize(scoreSets(embC, pairs));
      // Cross path: probe from the frame (pipeline), gallery from the crop (derived template).
      const cross: Record<PairKind, number[]> = { genuineSameGate: [], genuineCrossGate: [], withinTrack: [], impostorStrict: [], impostorProbable: [], genuineEntry: [], genuineExit: [] };
      for (const p of pairs) {
        const a = emb.get(p.a);
        const b = embC.get(p.b);
        if (a && b) cross[p.kind].push(dot(a, b));
      }
      for (const k of Object.keys(cross) as PairKind[]) cross[k].sort((x, y) => x - y);
      const { _gen: g3, _imp: i3, _prob: p3, ...pubX } = summarize(cross);
      report.models[m.name].viaCrop = { sameFaceCosine: dist(agree), cropVsCrop: pubC, frameProbeVsCropGallery: pubX };
    }
  }

  // Reference operating point reproduction and the good-enough verdict.
  const ref = sums.get(REF)!;
  const refSingle = report.models[REF].legacySingle;
  const refFused = report.models[REF].legacyFused;
  for (const m of MODELS) {
    const s = sums.get(m.name)!;
    const tTar = thresholdAtTar(s._gen, refSingle.tar);
    const tFar = thresholdAtFar(s._imp, refSingle.farStrict);
    const tTarF = thresholdAtTar(s._gen, refFused.tar);
    const tFarF = thresholdAtFar(s._imp, refFused.farStrict);
    const recommendedSingle = Math.ceil(Math.max(tTar, tFar) * 100) / 100;
    const recommendedFused = Math.ceil(Math.max(tTarF, tFarF) * 100) / 100;
    const rec = atThreshold(s._gen, s._imp, s._prob, recommendedSingle);
    const tarFar0Ref = report.models[REF].tarAtFar0.tar;
    const tarFar0 = report.models[m.name].tarAtFar0.tar;
    report.models[m.name].matchReference = {
      reference: REF,
      acceptSingle: { sameTar: atThreshold(s._gen, s._imp, s._prob, tTar), sameFar: atThreshold(s._gen, s._imp, s._prob, tFar), recommended: rec },
      acceptFused: { sameTar: atThreshold(s._gen, s._imp, s._prob, tTarF), sameFar: atThreshold(s._gen, s._imp, s._prob, tFarF), recommended: r3(recommendedFused) },
      goodEnough: {
        tarAtFar0WithinTwoPoints: tarFar0 >= tarFar0Ref - 0.02,
        impostorP95AtLeast008BelowAccept: rec.marginToImpostorP95 >= LEGACY.minMargin,
        verdict: tarFar0 >= tarFar0Ref - 0.02 && rec.marginToImpostorP95 >= LEGACY.minMargin,
      },
    };
    const parent = PARENTS[m.name];
    if (parent && embs.has(parent)) {
      const drift: number[] = [];
      for (const [n, v] of embs.get(m.name)!) {
        const p = embs.get(parent)!.get(n);
        if (p) drift.push(1 - dot(v, p));
      }
      drift.sort((a, b) => a - b);
      report.models[m.name].driftVsParent = { parent, ...dist(drift), p99: r4(quantile(drift, 0.99)), median: r4(quantile(drift, 0.5)) };
    }
  }

  if (!NO_BENCH) {
    const sample = entries.slice(0, 16).map((e) => fs.readFileSync(path.join(cropsDir, `rec_${e.n}.u8`)));
    for (const m of MODELS) {
      report.models[m.name].latency = await bench(m, sample);
      const l = report.models[m.name].latency;
      const rl = report.models[REF].latency;
      if (rl) for (const th of BENCH_THREADS) l[`threads${th}`].ratioVsRef = r3(rl[`threads${th}`].medianMs / l[`threads${th}`].medianMs);
      console.log(`latency ${m.name}:`, JSON.stringify(l));
    }
  }

  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1), { mode: 0o600 });

  // Markdown summary
  const rows = MODELS.map((m) => {
    const r = report.models[m.name];
    const mr = r.matchReference;
    const lat = r.latency ? `${r.latency.threads1?.medianMs ?? "-"} / ${r.latency.threads2?.medianMs ?? "-"}` : "-";
    return `| ${m.name} | ${r.genuine.p5} / ${r.genuine.p50} / ${r.genuine.p95} | ${r.impostorStrict.p5} / ${r.impostorStrict.p50} / ${r.impostorStrict.p95} (max ${r.impostorStrict.max}) | ${r.impostorProbable.p95} / ${r.impostorProbable.max} | ${(r.tarAtFar0.tar * 100).toFixed(1)}% @ ${r.tarAtFar0.threshold} (entry ${(r.tarAtFar0.tarEntry * 100).toFixed(0)} / exit ${(r.tarAtFar0.tarExit * 100).toFixed(0)} / cross ${(r.tarAtFar0.tarCrossGate * 100).toFixed(0)}) | ${(r.tarAtFar1e3.tar * 100).toFixed(1)}% @ ${r.tarAtFar1e3.threshold} | ${(r.legacySingle.tar * 100).toFixed(1)}% / ${(r.legacySingle.farStrict * 100).toFixed(2)}% | ${mr.acceptSingle.recommended.threshold} (TAR ${(mr.acceptSingle.recommended.tar * 100).toFixed(1)}%, FAR ${(mr.acceptSingle.recommended.farStrict * 100).toFixed(2)}%, margin ${mr.acceptSingle.recommended.marginToImpostorP95}) | ${mr.acceptFused.recommended} | ${r.driftVsParent ? `${r.driftVsParent.median} / ${r.driftVsParent.p95}` : "-"} | ${lat} | ${mr.goodEnough.verdict ? "yes" : "no"} |`;
  });
  console.log("\n| model | genuine p5/p50/p95 | impostor strict p5/p50/p95 | probable p95/max | TAR@FAR=0 | TAR@FAR=1e-3 | TAR/FAR @0.55 | acceptSingle (reproduces ref) | acceptFused | drift med/p95 | ms 1t / 2t | good enough |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(r);
  const line = (v: any, extra: string) =>
    v.genuine.n ? `gen n ${v.genuine.n} p5 ${v.genuine.p5} p50 ${v.genuine.p50} | imp strict max ${v.impostorStrict.max} p95 ${v.impostorStrict.p95} | probable p95 ${v.impostorProbable.p95} max ${v.impostorProbable.max} | TAR@FAR0 ${(v.tarAtFar0.tar * 100).toFixed(1)}% @ ${v.tarAtFar0.threshold}${extra}` : "n/a (no data)";
  console.log("\nk-best fusion (clip passages, leave-one-passage-out gallery):");
  for (const m of MODELS) {
    const f = report.models[m.name].fusion;
    console.log(`  ${m.name}: ` + Object.entries(f).map(([k, v]: [string, any]) => `${k} (${v.employeePassages} passages): ` + line(v, v.genuine.n ? ` | @0.45 TAR ${(v.legacyFused.tar * 100).toFixed(0)}% FAR ${(v.legacyFused.farStrict * 100).toFixed(1)}%` : "")).join("\n     "));
  }
  console.log("\ntemplates per person (gallery = k best-quality crops, probes = the rest):");
  for (const m of MODELS) {
    const g = report.models[m.name].galleryCap;
    console.log(`  ${m.name}: ` + Object.entries(g).map(([k, v]: [string, any]) => `${k} (${v.employees} employees): ` + line(v, v.genuine.n ? ` | @0.55 TAR ${(v.legacySingle.tar * 100).toFixed(1)}% FAR ${(v.legacySingle.farStrict * 100).toFixed(2)}%` : "")).join("\n     "));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
