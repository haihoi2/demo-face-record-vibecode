/**
 * Pure helpers for scripts/perf/engine-compare.ts (Taiga #513 / #523).
 *
 * Everything here is deterministic and free of I/O, ONNX Runtime and the face
 * engine, so tests/engineCompare.test.ts can pin the behaviour on a model-less
 * image: candidate-model spec parsing, crop preprocessing for a foreign
 * recogniser, pair-set construction (same rules as calib-eval.ts), the
 * genuine/impostor metrics, the operating-point reproduction, detector
 * agreement, the Markdown rendering and the "no vectors in the report" guard.
 */

// ---------------------------------------------------------------- model specs

export type TensorLayout = "NCHW" | "NHWC";
export type ChannelOrder = "rgb" | "bgr";

/**
 * One candidate recogniser as given on the command line:
 *   --model name=path.onnx[,input=112,mean=127.5,std=127.5,layout=NCHW|NHWC,rgb|bgr]
 * Per-channel mean/std use "/" (a comma separates options): mean=123.7/116.3/103.5.
 * Defaults are exactly what faceEmbedding.ts embedFace() feeds w600k_r50.
 */
export interface ModelSpec {
  name: string;
  file: string;
  /** Side of the square input the model takes; crops are 112 and are resized when this differs. */
  input: number;
  mean: [number, number, number];
  std: [number, number, number];
  layout: TensorLayout;
  channels: ChannelOrder;
}

export const BASELINE_PREPROCESS: Omit<ModelSpec, "name" | "file"> = {
  input: 112,
  mean: [127.5, 127.5, 127.5],
  std: [127.5, 127.5, 127.5],
  layout: "NCHW",
  channels: "rgb",
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function triple(raw: string, what: string): [number, number, number] {
  const parts = raw.split("/").map((p) => Number(p.trim()));
  if (parts.some((p) => !Number.isFinite(p))) throw new Error(`${what}: not a number: "${raw}"`);
  if (parts.length === 1) return [parts[0], parts[0], parts[0]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2]];
  throw new Error(`${what}: give one value or three separated by "/": "${raw}"`);
}

export function parseModelSpec(raw: string): ModelSpec {
  const parts = String(raw).split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("--model: empty");
  const eq = parts[0].indexOf("=");
  if (eq <= 0) throw new Error(`--model: expected name=path.onnx, got "${parts[0]}"`);
  const name = parts[0].slice(0, eq).trim();
  const file = parts[0].slice(eq + 1).trim();
  if (!NAME_RE.test(name)) throw new Error(`--model: bad name "${name}" (letters, digits, . _ - only)`);
  if (!/\.onnx$/i.test(file)) throw new Error(`--model ${name}: path must end in .onnx`);
  const spec: ModelSpec = { name, file, ...BASELINE_PREPROCESS, mean: [...BASELINE_PREPROCESS.mean], std: [...BASELINE_PREPROCESS.std] };
  for (const opt of parts.slice(1)) {
    const lower = opt.toLowerCase();
    if (lower === "rgb" || lower === "bgr") {
      spec.channels = lower;
      continue;
    }
    const i = opt.indexOf("=");
    if (i <= 0) throw new Error(`--model ${name}: unknown option "${opt}"`);
    const key = opt.slice(0, i).trim().toLowerCase();
    const val = opt.slice(i + 1).trim();
    switch (key) {
      case "input": {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 32 || n > 1024) throw new Error(`--model ${name}: input must be an integer 32..1024`);
        spec.input = n;
        break;
      }
      case "mean":
        spec.mean = triple(val, `--model ${name} mean`);
        break;
      case "std": {
        const t = triple(val, `--model ${name} std`);
        if (t.some((v) => v === 0)) throw new Error(`--model ${name}: std must not be 0`);
        spec.std = t;
        break;
      }
      case "layout": {
        const l = val.toUpperCase();
        if (l !== "NCHW" && l !== "NHWC") throw new Error(`--model ${name}: layout must be NCHW or NHWC`);
        spec.layout = l;
        break;
      }
      case "channels": {
        const c = val.toLowerCase();
        if (c !== "rgb" && c !== "bgr") throw new Error(`--model ${name}: channels must be rgb or bgr`);
        spec.channels = c;
        break;
      }
      default:
        throw new Error(`--model ${name}: unknown option "${key}"`);
    }
  }
  return spec;
}

/** True when a model's input contract is the one the current engine (faceEmbedding.ts) implements. */
export function preprocessMatchesBaseline(spec: ModelSpec): boolean {
  const b = BASELINE_PREPROCESS;
  return spec.input === b.input && spec.layout === b.layout && spec.channels === b.channels && spec.mean.every((v, i) => v === b.mean[i]) && spec.std.every((v, i) => v === b.std[i]);
}

/** `--license name=SPDX-or-text`; the text is printed verbatim in the report. */
export function parseLicenseSpec(raw: string): { name: string; license: string } {
  const i = String(raw).indexOf("=");
  if (i <= 0) throw new Error(`--license: expected name=text, got "${raw}"`);
  const name = raw.slice(0, i).trim();
  const license = raw.slice(i + 1).trim();
  if (!NAME_RE.test(name)) throw new Error(`--license: bad model name "${name}"`);
  if (!license) throw new Error(`--license ${name}: empty text`);
  return { name, license };
}

/** `--parent child=parent` (quantised child vs its FP32 parent; drift is only defined for equal dims). */
export function parseParentSpec(raw: string): { child: string; parent: string } {
  const [child, parent, ...rest] = String(raw).split("=").map((s) => s.trim());
  if (!child || !parent || rest.length) throw new Error(`--parent: expected child=parent, got "${raw}"`);
  return { child, parent };
}

// ---------------------------------------------------------------- preprocessing

export interface RgbU8 {
  width: number;
  height: number;
  /** HWC, RGB, length = width*height*3. */
  data: Uint8Array;
}
export type Resizer = (img: RgbU8, w: number, h: number) => RgbU8;

/**
 * A stored 112x112 RGB crop as the tensor data `spec` wants: optional resize
 * (injected, so the lib stays pure), per-channel (px - mean) / std, channel
 * order and layout. Returns the flat data and its dims.
 */
export function preprocessCrop(crop: RgbU8, spec: Pick<ModelSpec, "input" | "mean" | "std" | "layout" | "channels">, resize: Resizer): { data: Float32Array; dims: number[] } {
  if (crop.data.length !== crop.width * crop.height * 3) throw new Error(`crop: ${crop.data.length} bytes for ${crop.width}x${crop.height}x3`);
  const img = crop.width === spec.input && crop.height === spec.input ? crop : resize(crop, spec.input, spec.input);
  const side = spec.input;
  const plane = side * side;
  const data = new Float32Array(3 * plane);
  const order = spec.channels === "rgb" ? [0, 1, 2] : [2, 1, 0];
  for (let i = 0; i < plane; i++) {
    const s = i * 3;
    for (let c = 0; c < 3; c++) {
      const src = order[c];
      const v = (img.data[s + src] - spec.mean[src]) / spec.std[src];
      if (spec.layout === "NCHW") data[c * plane + i] = v;
      else data[s + c] = v;
    }
  }
  return { data, dims: spec.layout === "NCHW" ? [1, 3, side, side] : [1, side, side, 3] };
}

/** Pure bilinear resize (RGB HWC); used by the harness for non-112 inputs and by the fixture generator. */
export function resizeBilinearU8(src: RgbU8, dstW: number, dstH: number): RgbU8 {
  const out = new Uint8Array(dstW * dstH * 3);
  const sx = src.width / dstW;
  const sy = src.height / dstH;
  for (let y = 0; y < dstH; y++) {
    const fy = Math.min(src.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < dstW; x++) {
      const fx = Math.min(src.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const wx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const p00 = src.data[(y0 * src.width + x0) * 3 + c];
        const p01 = src.data[(y0 * src.width + x1) * 3 + c];
        const p10 = src.data[(y1 * src.width + x0) * 3 + c];
        const p11 = src.data[(y1 * src.width + x1) * 3 + c];
        const v = (p00 * (1 - wx) + p01 * wx) * (1 - wy) + (p10 * (1 - wx) + p11 * wx) * wy;
        out[(y * dstW + x) * 3 + c] = Math.round(v);
      }
    }
  }
  return { width: dstW, height: dstH, data: out };
}

export function l2(v: ArrayLike<number>): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  const out = new Float32Array(v.length);
  if (n > 0) for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`dot: dims differ (${a.length} vs ${b.length}) - embeddings of different models are never compared`);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ---------------------------------------------------------------- pairs (same rules as calib-eval.ts)

/** The subset of a calib-crops.ts index entry the pairing needs. */
export interface CropEntry {
  n: number;
  source: "log" | "clip";
  groupId: string;
  identity: string | null;
  gate: string;
  quality: number;
}
export type PairKind = "genuine" | "genuineCrossGate" | "withinTrack" | "impostorStrict" | "impostorProbable";
export interface Pair {
  a: number;
  b: number;
  kind: PairKind;
}
export const isEmployee = (id: string | null) => !!id && id.startsWith("EMP-");
const passageOf = (e: CropEntry) => (e.source === "clip" ? e.groupId.split("/")[0] : e.groupId);

/**
 * genuine          same identity, different capture (same gate)
 * genuineCrossGate same identity, different gate
 * withinTrack      two frames of one clip passage (reported, not scored as genuine)
 * impostorStrict   two employee-labelled crops, different employees
 * impostorProbable employee crop vs unlabelled (DENIED/stranger) crop
 * stranger vs stranger: unknown relation, no pair. Same groupId: no pair.
 */
export function buildPairs(entries: CropEntry[]): Pair[] {
  const pairs: Pair[] = [];
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i];
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j];
      if (a.groupId === b.groupId) continue;
      if (a.identity && a.identity === b.identity) {
        if (a.source === "clip" && b.source === "clip" && passageOf(a) === passageOf(b)) pairs.push({ a: a.n, b: b.n, kind: "withinTrack" });
        else pairs.push({ a: a.n, b: b.n, kind: a.gate === b.gate ? "genuine" : "genuineCrossGate" });
      } else if (isEmployee(a.identity) && isEmployee(b.identity)) pairs.push({ a: a.n, b: b.n, kind: "impostorStrict" });
      else if (isEmployee(a.identity) !== isEmployee(b.identity)) pairs.push({ a: a.n, b: b.n, kind: "impostorProbable" });
    }
  }
  return pairs;
}

export type ScoreSets = Record<PairKind, number[]>;
export function emptySets(): ScoreSets {
  return { genuine: [], genuineCrossGate: [], withinTrack: [], impostorStrict: [], impostorProbable: [] };
}
/** Sorted ascending cosine per pair kind; pairs whose crop lacks an embedding are skipped. */
export function scoreSets(emb: Map<number, Float32Array>, pairs: Pair[]): ScoreSets {
  const sets = emptySets();
  for (const p of pairs) {
    const a = emb.get(p.a);
    const b = emb.get(p.b);
    if (!a || !b) continue;
    sets[p.kind].push(dot(a, b));
  }
  for (const k of Object.keys(sets) as PairKind[]) sets[k].sort((x, y) => x - y);
  return sets;
}

// ---------------------------------------------------------------- statistics

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
export const r3 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
export const r4 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : v);
export function frac(sorted: number[], pred: (v: number) => boolean): number {
  if (sorted.length === 0) return NaN;
  let c = 0;
  for (const v of sorted) if (pred(v)) c++;
  return c / sorted.length;
}
export interface Dist {
  n: number;
  min?: number;
  p5?: number;
  p50?: number;
  p95?: number;
  max?: number;
}
export function dist(sorted: number[], round = r3): Dist {
  return sorted.length
    ? { n: sorted.length, min: round(sorted[0]), p5: round(quantile(sorted, 0.05)), p50: round(quantile(sorted, 0.5)), p95: round(quantile(sorted, 0.95)), max: round(sorted[sorted.length - 1]) }
    : { n: 0 };
}

export interface OperatingPoint {
  threshold: number;
  /** Genuine pairs accepted (true-accept rate). */
  tar: number;
  /** Strict impostor pairs accepted (false-accept rate) and the count. */
  farStrict: number;
  falseAcceptsStrict: number;
  farProbable: number;
  /** 1 - tar: genuine pairs rejected (false-reject rate). */
  frr: number;
  /** threshold - impostor-strict p95 (the fusion margin is 0.08). */
  marginToImpostorP95: number;
}
export function atThreshold(gen: number[], imp: number[], prob: number[], t: number): OperatingPoint {
  const tar = frac(gen, (v) => v >= t);
  const fa = imp.filter((v) => v >= t).length;
  return {
    threshold: r3(t),
    tar: r4(tar),
    farStrict: r4(imp.length ? fa / imp.length : NaN),
    falseAcceptsStrict: fa,
    farProbable: r4(frac(prob, (v) => v >= t)),
    frr: r4(1 - tar),
    marginToImpostorP95: r3(t - quantile(imp, 0.95)),
  };
}
/** Smallest threshold with FAR <= far on `imp` (sorted ascending). */
export function thresholdAtFar(imp: number[], far: number): number {
  if (imp.length === 0) return NaN;
  const allowed = Math.floor(far * imp.length);
  const idx = imp.length - allowed;
  return idx >= imp.length ? imp[imp.length - 1] + 1e-6 : Math.max(imp[idx], (imp[idx - 1] ?? -1) + 1e-6);
}
/** Threshold at which `gen` (sorted ascending) reaches TAR >= tar (tar may carry 4-decimal rounding, hence round). */
export function thresholdAtTar(gen: number[], tar: number): number {
  if (gen.length === 0) return NaN;
  const idx = Math.max(0, Math.min(gen.length - 1, Math.round((1 - tar) * gen.length)));
  return gen[idx];
}
export const ceil2 = (v: number) => (Number.isFinite(v) ? Math.ceil(v * 100 - 1e-9) / 100 : v);

export interface LegacyThresholds {
  acceptSingle: number;
  acceptFused: number;
  minMargin: number;
}

export interface ModelMetrics {
  genuine: Dist;
  genuineCrossGate: Dist;
  withinTrack: Dist;
  impostorStrict: Dist;
  impostorProbable: Dist;
  dPrime: number;
  /** FAR = 0 on strict impostors: threshold just above the worst impostor. */
  tarAtFar0: OperatingPoint;
  tarAtFar1e3: OperatingPoint;
  /**
   * The site's rule: 0 strict false accepts AND the accept threshold at least
   * minMargin above the strict impostor p95; threshold rounded up to 0.01.
   */
  siteStrict: OperatingPoint;
  /** Today's door thresholds applied to this model's cosines (only meaningful for the baseline's space). */
  legacySingle: OperatingPoint;
  legacyFused: OperatingPoint;
}

export function summarize(sets: ScoreSets, legacy: LegacyThresholds): ModelMetrics {
  const gen = [...sets.genuine, ...sets.genuineCrossGate].sort((x, y) => x - y);
  const imp = sets.impostorStrict;
  const prob = sets.impostorProbable;
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);
  const varr = (v: number[]) => {
    const m = mean(v);
    return v.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(1, v.length - 1);
  };
  const tFar0 = thresholdAtFar(imp, 0);
  const tSite = ceil2(Math.max(tFar0, quantile(imp, 0.95) + legacy.minMargin));
  return {
    genuine: dist(gen),
    genuineCrossGate: dist(sets.genuineCrossGate),
    withinTrack: dist(sets.withinTrack),
    impostorStrict: dist(imp),
    impostorProbable: dist(prob),
    dPrime: r3((mean(gen) - mean(imp)) / Math.sqrt((varr(gen) + varr(imp)) / 2)),
    tarAtFar0: atThreshold(gen, imp, prob, tFar0),
    tarAtFar1e3: atThreshold(gen, imp, prob, thresholdAtFar(imp, 1e-3)),
    siteStrict: atThreshold(gen, imp, prob, tSite),
    legacySingle: atThreshold(gen, imp, prob, legacy.acceptSingle),
    legacyFused: atThreshold(gen, imp, prob, legacy.acceptFused),
  };
}

export interface Reproduction {
  reference: string;
  /** Thresholds in THIS model's space that give the reference's TAR / FAR at its acceptSingle. */
  acceptSingle: { sameTar: OperatingPoint; sameFar: OperatingPoint; recommended: OperatingPoint };
  acceptFused: { sameTar: OperatingPoint; sameFar: OperatingPoint; recommended: OperatingPoint };
  goodEnough: { tarAtFar0WithinTwoPoints: boolean; marginAtLeastMinMargin: boolean; zeroStrictFalseAccepts: boolean; verdict: boolean };
}

/**
 * The thresholds of `cand` that reproduce the reference model's operating
 * point at today's acceptSingle / acceptFused (same TAR, same FAR; the
 * recommended value is the stricter of the two, rounded up to 0.01), and the
 * calib-eval "good enough" verdict.
 */
export function reproduceReference(refName: string, ref: { metrics: ModelMetrics }, cand: { sets: ScoreSets; metrics: ModelMetrics }, legacy: LegacyThresholds): Reproduction {
  const gen = [...cand.sets.genuine, ...cand.sets.genuineCrossGate].sort((x, y) => x - y);
  const imp = cand.sets.impostorStrict;
  const prob = cand.sets.impostorProbable;
  const point = (refOp: OperatingPoint) => {
    const tTar = thresholdAtTar(gen, refOp.tar);
    const tFar = thresholdAtFar(imp, refOp.farStrict);
    return { sameTar: atThreshold(gen, imp, prob, tTar), sameFar: atThreshold(gen, imp, prob, tFar), recommended: atThreshold(gen, imp, prob, ceil2(Math.max(tTar, tFar))) };
  };
  const single = point(ref.metrics.legacySingle);
  const fused = point(ref.metrics.legacyFused);
  const tarOk = cand.metrics.tarAtFar0.tar >= ref.metrics.tarAtFar0.tar - 0.02;
  const marginOk = single.recommended.marginToImpostorP95 >= legacy.minMargin;
  const zeroFa = single.recommended.falseAcceptsStrict === 0;
  return {
    reference: refName,
    acceptSingle: single,
    acceptFused: fused,
    goodEnough: { tarAtFar0WithinTwoPoints: tarOk, marginAtLeastMinMargin: marginOk, zeroStrictFalseAccepts: zeroFa, verdict: tarOk && marginOk && zeroFa },
  };
}

/** 1 - cos between a child's and its parent's embedding of the same crop (equal dims only). */
export function driftVsParent(child: Map<number, Float32Array>, parent: Map<number, Float32Array>): Dist & { p99?: number } {
  const d: number[] = [];
  for (const [n, v] of child) {
    const p = parent.get(n);
    if (!p) continue;
    if (p.length !== v.length) throw new Error(`drift: dims differ (${v.length} vs ${p.length})`);
    d.push(1 - dot(v, p));
  }
  d.sort((a, b) => a - b);
  return d.length ? { ...dist(d, r4), p99: r4(quantile(d, 0.99)) } : { n: 0 };
}

// ---------------------------------------------------------------- detector agreement

export interface DetFace {
  box: readonly number[];
  score: number;
  landmarks: ReadonlyArray<readonly [number, number]>;
}
export const faceSize = (f: DetFace) => Math.min(f.box[2] - f.box[0], f.box[3] - f.box[1]);
export function iouBox(a: readonly number[], b: readonly number[]): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const ua = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]) + Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}
/** Greedy one-to-one match by IoU >= 0.5 (ref index -> candidate index). */
export function matchFaces(ref: DetFace[], other: DetFace[]): Map<number, { j: number; iou: number }> {
  const pairs: Array<{ i: number; j: number; iou: number }> = [];
  for (let i = 0; i < ref.length; i++) for (let j = 0; j < other.length; j++) {
    const o = iouBox(ref[i].box, other[j].box);
    if (o >= 0.5) pairs.push({ i, j, iou: o });
  }
  pairs.sort((a, b) => b.iou - a.iou || a.i - b.i || a.j - b.j);
  const usedI = new Set<number>();
  const usedJ = new Set<number>();
  const out = new Map<number, { j: number; iou: number }>();
  for (const p of pairs) {
    if (usedI.has(p.i) || usedJ.has(p.j)) continue;
    usedI.add(p.i);
    usedJ.add(p.j);
    out.set(p.i, { j: p.j, iou: p.iou });
  }
  return out;
}
/** Mean 5-landmark distance as a percentage of the reference face size. */
export function landmarkErrorPct(a: DetFace, b: DetFace): number {
  const size = Math.max(1, faceSize(a));
  let s = 0;
  for (let k = 0; k < 5; k++) s += Math.hypot(a.landmarks[k][0] - b.landmarks[k][0], a.landmarks[k][1] - b.landmarks[k][1]);
  return (100 * s) / 5 / size;
}

export interface DetectorAgreement {
  refFaces: number;
  found: number;
  recall: number | null;
  extra: number;
  iou: Dist;
  landmarkErrPct: Dist;
  scoreAbsDelta: Dist;
  missedSizes: number[];
}
/** Per-frame candidate detections vs the reference size's, faces >= minPx only. */
export function detectorAgreement(ref: DetFace[][], cand: DetFace[][], minPx: number): DetectorAgreement {
  let refN = 0;
  let hit = 0;
  let extra = 0;
  const ious: number[] = [];
  const lmk: number[] = [];
  const sd: number[] = [];
  const missed: number[] = [];
  for (let k = 0; k < ref.length; k++) {
    const R = ref[k];
    const C = cand[k] ?? [];
    const m = matchFaces(R, C);
    for (let i = 0; i < R.length; i++) {
      if (faceSize(R[i]) < minPx) continue;
      refN++;
      const mm = m.get(i);
      if (!mm) {
        missed.push(Math.round(faceSize(R[i])));
        continue;
      }
      hit++;
      ious.push(mm.iou);
      lmk.push(landmarkErrorPct(R[i], C[mm.j]));
      sd.push(Math.abs(R[i].score - C[mm.j].score));
    }
    const matchedJ = new Set([...m.values()].map((v) => v.j));
    extra += C.filter((f, j) => faceSize(f) >= minPx && !matchedJ.has(j)).length;
  }
  const sorted = (v: number[]) => [...v].sort((a, b) => a - b);
  return {
    refFaces: refN,
    found: hit,
    recall: refN ? r3(hit / refN) : null,
    extra,
    iou: dist(sorted(ious)),
    landmarkErrPct: dist(sorted(lmk), (v) => Math.round(v * 10) / 10),
    scoreAbsDelta: dist(sorted(sd)),
    missedSizes: missed.sort((a, b) => a - b),
  };
}

// ---------------------------------------------------------------- report guards and rendering

/**
 * Refuses a report object that contains anything vector-like: a numeric array
 * longer than `maxLen` or a typed array. Aggregates only ever leave the harness.
 */
export function assertNoVectors(obj: unknown, maxLen = 32, path = "$"): void {
  if (obj === null || typeof obj !== "object") return;
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) throw new Error(`report: binary data at ${path}`);
  if (Array.isArray(obj)) {
    if (obj.length > maxLen && obj.every((v) => typeof v === "number")) throw new Error(`report: numeric array of ${obj.length} at ${path}`);
    obj.forEach((v, i) => assertNoVectors(v, maxLen, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) assertNoVectors(v, maxLen, `${path}.${k}`);
}

export interface RecognizerRow {
  name: string;
  license: string;
  fileMB: number;
  dim: number;
  preprocess: string;
  metrics: ModelMetrics;
  reproduction: Reproduction | null;
  drift?: { parent: string; p50?: number; p95?: number } | null;
  latencyMs: Record<string, number | undefined>;
  /** Every metric equals the reference's (same file under two names): the sanity case. */
  identicalToRef?: boolean;
}
const pct = (v: number | undefined | null, d = 1) => (v === undefined || v === null || Number.isNaN(v) ? "-" : `${(v * 100).toFixed(d)}%`);
const num = (v: number | undefined | null) => (v === undefined || v === null || Number.isNaN(v) ? "-" : String(v));
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderRecognizerTable(rows: RecognizerRow[], threads: number[]): string {
  const head = `| model | license | MB | dim | preprocess | genuine p5/p50/p95 | impostor strict p5/p50/p95 (max) | probable p95/max | TAR@FAR=0 (thr) | TAR@site strict (thr, margin) | TAR/FA @legacy 0.55 | acceptSingle reproducing ref (TAR, FA, margin) | acceptFused | drift p50/p95 | ms/face ${threads.map((t) => `${t}t`).join(" / ")} | good enough |`;
  const sep = `|${"---|".repeat(16)}`;
  const body = rows.map((r) => {
    const m = r.metrics;
    const rp = r.reproduction;
    const lat = threads.map((t) => num(r.latencyMs[`threads${t}`])).join(" / ");
    const ge = rp ? `${rp.goodEnough.verdict ? "yes" : "no"}${r.identicalToRef ? " (identical to ref)" : ""}` : "(ref)";
    return `| ${cell(r.name)} | ${cell(r.license)} | ${r.fileMB} | ${r.dim} | ${cell(r.preprocess)} | ${num(m.genuine.p5)} / ${num(m.genuine.p50)} / ${num(m.genuine.p95)} | ${num(m.impostorStrict.p5)} / ${num(m.impostorStrict.p50)} / ${num(m.impostorStrict.p95)} (${num(m.impostorStrict.max)}) | ${num(m.impostorProbable.p95)} / ${num(m.impostorProbable.max)} | ${pct(m.tarAtFar0.tar)} (${num(m.tarAtFar0.threshold)}) | ${pct(m.siteStrict.tar)} (${num(m.siteStrict.threshold)}, ${num(m.siteStrict.marginToImpostorP95)}) | ${pct(m.legacySingle.tar)} / ${m.legacySingle.falseAcceptsStrict} | ${rp ? `${num(rp.acceptSingle.recommended.threshold)} (${pct(rp.acceptSingle.recommended.tar)}, ${rp.acceptSingle.recommended.falseAcceptsStrict}, ${num(rp.acceptSingle.recommended.marginToImpostorP95)})` : "-"} | ${rp ? num(rp.acceptFused.recommended.threshold) : "-"} | ${r.drift ? `${num(r.drift.p50)} / ${num(r.drift.p95)}` : "-"} | ${lat} | ${ge} |`;
  });
  return [head, sep, ...body].join("\n");
}

export interface DetectorRow {
  size: number;
  facesAll: number;
  facesAtLeastMin: number;
  msPerFrame: Dist;
  vsRef: DetectorAgreement | null;
}
export function renderDetectorTable(rows: DetectorRow[], refSize: number, minPx: number, threads: number): string {
  const head = `| detect size | faces (all / >=${minPx}px) | recall vs ${refSize} | extra | IoU p50/min | lmk err % p50/p95 | missed sizes | ms/frame p50/p95 (${threads}t) |`;
  const sep = `|${"---|".repeat(8)}`;
  const body = rows.map((r) => {
    const v = r.vsRef;
    return `| ${r.size} | ${r.facesAll} / ${r.facesAtLeastMin} | ${v ? `${v.found}/${v.refFaces} (${pct(v.recall, 0)})` : "(ref)"} | ${v ? v.extra : "-"} | ${v ? `${num(v.iou.p50)} / ${num(v.iou.min)}` : "-"} | ${v ? `${num(v.landmarkErrPct.p50)} / ${num(v.landmarkErrPct.p95)}` : "-"} | ${v ? (v.missedSizes.length ? v.missedSizes.join(",") : "none") : "-"} | ${num(r.msPerFrame.p50)} / ${num(r.msPerFrame.p95)} |`;
  });
  return [head, sep, ...body].join("\n");
}

export function describePreprocess(spec: Pick<ModelSpec, "input" | "mean" | "std" | "layout" | "channels">): string {
  const one = (t: [number, number, number]) => (t[0] === t[1] && t[1] === t[2] ? String(t[0]) : t.join("/"));
  return `${spec.input}px ${spec.layout} ${spec.channels} (x-${one(spec.mean)})/${one(spec.std)}`;
}
