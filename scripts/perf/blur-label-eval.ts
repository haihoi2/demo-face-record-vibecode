#!/usr/bin/env -S npx tsx
/**
 * Blur filter S1 (Taiga #511, plan docs/plans/2026-11-03-blur-filter.md):
 * how well do the capture metrics we ALREADY store separate the faces
 * operators labelled "blurred" from faces we know were sharp enough?
 *
 *   npx tsx scripts/perf/blur-label-eval.ts --from-db [--repo <dir>] --out <dir>   (repo defaults to cwd)
 *   npx tsx scripts/perf/blur-label-eval.ts --tsv <rows.tsv> --out <dir>
 *
 * Numbers only. The query (DUMP_SQL below) reads stranger_faces and
 * stranger_face_reports with a single SELECT and returns NO ids, NO images
 * and NO embeddings - one row of metrics per face plus a class label and the
 * gate. --from-db runs it through `docker compose exec -T postgres psql` from
 * the repo root (credentials stay inside the container); --tsv replays a dump
 * written by the same query (`psql -At -F "<tab>"`), e.g. when this script runs
 * inside the tester image where there is no docker CLI. Delete the dump after.
 *
 * Classes (per face, newest report wins):
 *   blurry        latest of blur/blur-withdrawn is 'blur', or rated-blurry
 *   sharp         rated-sharp, or recognised with matchCosine >= 0.65 (proxy:
 *                 the recogniser matched it with margin, so it was usable)
 *   stranger-unlabelled / recognised-other: everything else, used only to
 *                 estimate how many captures a rule would hide once wired
 *   not-face      excluded
 *
 * Scores are oriented as SHARPNESS (higher = sharper); a face is "blurry" when
 * sharpness < threshold. For each score, per gate and pooled: ROC AUC, the
 * threshold that catches >= 95 % (and >= 70 %) of the blurry faces with the
 * share of sharp faces lost, the threshold that loses <= 10 % of sharp faces
 * with the share of blurry caught, plus how the current stranger floors
 * (edgeEnergy < 0.16 or featureNorm < 20) would have scored. Logistic
 * combinations are fitted by IRLS on the pooled labelled faces and also
 * reported with deterministic 5-fold cross-validation (fold = row index mod 5)
 * so the in-sample optimism is visible. Output: report.md + report.json,
 * aggregates and counts only.
 *
 * KNOWN CONFOUND: every blurry label is a stranger capture and every sharp
 * proxy is a recognised employee. A metric that merely says "close to the
 * camera" would also score well, so the size-only AUC and the size-stratified
 * AUCs are reported as the control.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BLUR_MODEL_TAG, DEFAULT_BLUR_POLICY, blurSharpness } from "../../src/server/blurFilter";

const args = process.argv.slice(2);
const opt = (name: string, d?: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : d;
};
const OUT = opt("--out");
const TSV = opt("--tsv");
const FROM_DB = args.includes("--from-db");
const REPO = opt("--repo", process.cwd())!;
if (!OUT || (!TSV && !FROM_DB)) {
  console.error("usage: blur-label-eval.ts (--from-db [--repo <dir>] | --tsv <rows.tsv>) --out <dir>");
  process.exit(2);
}

/** One SELECT, no ids. Column order = Row below. */
export const DUMP_SQL = `
WITH latest_blur AS (
  SELECT DISTINCT ON ("faceId") "faceId", kind
  FROM stranger_face_reports WHERE kind IN ('blur','blur-withdrawn')
  ORDER BY "faceId", at DESC, id DESC
),
rated AS (
  SELECT "faceId",
         bool_or(kind = 'rated-blurry') AS rb,
         bool_or(kind = 'rated-sharp') AS rs,
         bool_or(kind = 'rated-not-face') AS rn
  FROM stranger_face_reports WHERE kind LIKE 'rated-%' GROUP BY 1
),
lab AS (
  SELECT f.id,
    CASE
      WHEN r.rn THEN 'not-face'
      WHEN lb.kind = 'blur' OR r.rb THEN 'blurry'
      WHEN r.rs THEN 'sharp-rated'
      WHEN f."employeeId" IS NOT NULL AND f."matchCosine" >= 0.65 THEN 'sharp-proxy'
      WHEN f."employeeId" IS NOT NULL THEN 'recognised-other'
      ELSE 'stranger-unlabelled'
    END AS label
  FROM stranger_faces f
  LEFT JOIN latest_blur lb ON lb."faceId" = f.id
  LEFT JOIN rated r ON r."faceId" = f.id
)
SELECT lab.label, COALESCE(f."gateId", lower(f.gate)) AS gate, f."modelTag",
       f.quality, f."edgeEnergy", f."featureNorm", f."detectorScore", f."sizePx",
       (f.box->>2)::float - (f.box->>0)::float AS "boxW", (f.box->>3)::float - (f.box->>1)::float AS "boxH",
       f."sourceWidth", f."sourceHeight", f."matchCosine", f."matchMargin", left(f."capturedAt", 10) AS day
FROM stranger_faces f JOIN lab ON lab.id = f.id
WHERE f."gateId" IS NOT NULL AND f."featureNorm" IS NOT NULL
ORDER BY f."capturedAt", f.id;
`;

type Label = "blurry" | "sharp-rated" | "sharp-proxy" | "recognised-other" | "stranger-unlabelled" | "not-face";
interface Row {
  label: Label;
  gate: string;
  modelTag: string;
  quality: number;
  edgeEnergy: number;
  featureNorm: number;
  detectorScore: number;
  sizePx: number;
  boxW: number;
  boxH: number;
  sourceWidth: number | null;
  sourceHeight: number | null;
  matchCosine: number | null;
  day: string;
}

function parseTsv(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const c = line.split("\t");
    const num = (s: string) => (s === "" || s === "\\N" ? null : Number(s));
    rows.push({
      label: c[0] as Label,
      gate: c[1],
      modelTag: c[2],
      quality: num(c[3]) ?? NaN,
      edgeEnergy: num(c[4]) ?? NaN,
      featureNorm: num(c[5]) ?? NaN,
      detectorScore: num(c[6]) ?? NaN,
      sizePx: num(c[7]) ?? NaN,
      boxW: num(c[8]) ?? NaN,
      boxH: num(c[9]) ?? NaN,
      sourceWidth: num(c[10]),
      sourceHeight: num(c[11]),
      matchCosine: num(c[12]),
      day: c[14] ?? "",
    });
  }
  return rows;
}

function loadRows(): Row[] {
  if (TSV) return parseTsv(fs.readFileSync(TSV, "utf8"));
  const r = spawnSync(
    "docker",
    ["compose", "--project-directory", REPO, "exec", "-T", "postgres", "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "\t" -v ON_ERROR_STOP=1'],
    { input: DUMP_SQL, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    console.error(r.stderr || "psql failed");
    process.exit(1);
  }
  return parseTsv(r.stdout);
}

// ---------------------------------------------------------------------------
// Scores (all oriented as sharpness: higher = sharper)
// ---------------------------------------------------------------------------

type Scorer = (r: Row) => number;
const size112 = (r: Row) => Math.max(1, r.sizePx) / 112;
const SCORES: Record<string, Scorer> = {
  edgeEnergy: (r) => r.edgeEnergy,
  featureNorm: (r) => r.featureNorm,
  quality: (r) => r.quality,
  detectorScore: (r) => r.detectorScore,
  sizePx: (r) => r.sizePx,
  // size-normalised variants: a small face is upscaled to 112 px and looks
  // soft; multiplying by (112/size)^k gives small faces credit back.
  "edgeEnergy*(112/size)^0.5": (r) => r.edgeEnergy / Math.sqrt(size112(r)),
  "edgeEnergy*(112/size)": (r) => r.edgeEnergy / size112(r),
  "edgeEnergy*(size/112)^0.5": (r) => r.edgeEnergy * Math.sqrt(size112(r)),
  "featureNorm*(112/size)^0.5": (r) => r.featureNorm / Math.sqrt(size112(r)),
  "featureNorm*(size/112)^0.5": (r) => r.featureNorm * Math.sqrt(size112(r)),
  "edgeEnergy*featureNorm": (r) => r.edgeEnergy * r.featureNorm,
  "z(edge)+z(featureNorm)": (r) => r.edgeEnergy / 0.1 + r.featureNorm / 4, // ~ unit spreads, see report
};

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** ROC AUC of `sharp` vs `blurry` sharpness values (Mann-Whitney, ties = 0.5). */
function auc(sharp: number[], blurry: number[]): number {
  if (!sharp.length || !blurry.length) return NaN;
  const all = [...sharp.map((v) => [v, 1] as const), ...blurry.map((v) => [v, 0] as const)].sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j < all.length && all[j][0] === all[i][0]) j++;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (all[k][1] === 1) rankSum += avgRank;
    i = j;
  }
  const n1 = sharp.length, n0 = blurry.length;
  return (rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n0);
}
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
const fracBelow = (vals: number[], t: number) => (vals.length ? vals.filter((v) => v < t).length / vals.length : NaN);
const r3 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a");

interface OperatingPoints {
  n: { sharp: number; blurry: number };
  auc: number | null;
  /** threshold catching >= 95 % of blurry; share of sharp lost at it */
  catch95: { threshold: number | null; sharpLost: number | null };
  catch70: { threshold: number | null; sharpLost: number | null };
  /** threshold losing <= 10 % (<= 5 %) of sharp; share of blurry caught at it */
  lose10: { threshold: number | null; blurryCaught: number | null };
  lose5: { threshold: number | null; blurryCaught: number | null };
}

function operatingPoints(sharp: number[], blurry: number[]): OperatingPoints {
  const s = [...sharp].sort((a, b) => a - b), b = [...blurry].sort((a, b) => a - b);
  const out: OperatingPoints = {
    n: { sharp: s.length, blurry: b.length },
    auc: r3(auc(s, b)),
    catch95: { threshold: null, sharpLost: null },
    catch70: { threshold: null, sharpLost: null },
    lose10: { threshold: null, blurryCaught: null },
    lose5: { threshold: null, blurryCaught: null },
  };
  if (!s.length || !b.length) return out;
  // "blurry" = sharpness < t. Catching q of blurry needs t just above the q-quantile of blurry.
  const eps = 1e-9;
  const t95 = quantile(b, 0.95) + eps, t70 = quantile(b, 0.7) + eps;
  out.catch95 = { threshold: r3(t95), sharpLost: r3(fracBelow(s, t95)) };
  out.catch70 = { threshold: r3(t70), sharpLost: r3(fracBelow(s, t70)) };
  const t10 = quantile(s, 0.1); // fracBelow(s, t10) <= 10 %
  out.lose10 = { threshold: r3(t10), blurryCaught: r3(fracBelow(b, t10)) };
  const t5 = quantile(s, 0.05);
  out.lose5 = { threshold: r3(t5), blurryCaught: r3(fracBelow(b, t5)) };
  return out;
}

// ---------------------------------------------------------------------------
// Logistic regression (IRLS with a small ridge), deterministic
// ---------------------------------------------------------------------------

function solve(a: number[][], y: number[]): number[] {
  const n = y.length;
  const m = a.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    const d = m[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / d;
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[n] / (row[i] || 1e-12));
}

/** P(blurry) = sigmoid(b0 + sum b_i x_i). Returns coefficients in raw feature units. */
function fitLogistic(x: number[][], y: number[], ridge = 1e-3, iters = 25): { intercept: number; coef: number[] } {
  const k = x[0].length;
  const mean = Array(k).fill(0), sd = Array(k).fill(0);
  for (const row of x) row.forEach((v, j) => (mean[j] += v / x.length));
  for (const row of x) row.forEach((v, j) => (sd[j] += (v - mean[j]) ** 2 / x.length));
  for (let j = 0; j < k; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const z = x.map((row) => [1, ...row.map((v, j) => (v - mean[j]) / sd[j])]);
  let w = Array(k + 1).fill(0);
  for (let it = 0; it < iters; it++) {
    const h = Array.from({ length: k + 1 }, () => Array(k + 1).fill(0));
    const g = Array(k + 1).fill(0);
    for (let i = 0; i < z.length; i++) {
      const eta = z[i].reduce((s, v, j) => s + v * w[j], 0);
      const p = 1 / (1 + Math.exp(-eta));
      const wi = Math.max(p * (1 - p), 1e-6);
      for (let a = 0; a <= k; a++) {
        g[a] += z[i][a] * (y[i] - p);
        for (let b = 0; b <= k; b++) h[a][b] += wi * z[i][a] * z[i][b];
      }
    }
    for (let a = 1; a <= k; a++) {
      h[a][a] += ridge * z.length;
      g[a] -= ridge * z.length * w[a];
    }
    const step = solve(h, g);
    w = w.map((v, j) => v + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  const coef = w.slice(1).map((v, j) => v / sd[j]);
  const intercept = w[0] - coef.reduce((s, c, j) => s + c * mean[j], 0);
  return { intercept, coef };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const rows = loadRows().filter((r) => r.label !== "not-face" && r.modelTag === BLUR_MODEL_TAG);
const isSharp = (r: Row) => r.label === "sharp-proxy" || r.label === "sharp-rated";
const isBlurry = (r: Row) => r.label === "blurry";
const gates = [...new Set(rows.map((r) => r.gate))].sort();
const labelled = rows.filter((r) => isSharp(r) || isBlurry(r));

const classSizes: Record<string, Record<string, number>> = {};
for (const r of rows) {
  classSizes[r.gate] ??= {};
  classSizes[r.gate][r.label] = (classSizes[r.gate][r.label] || 0) + 1;
}
const dayRange = (pred: (r: Row) => boolean) => {
  const d = rows.filter(pred).map((r) => r.day).sort();
  return d.length ? { from: d[0], to: d[d.length - 1] } : null;
};

// Logistic candidates (feature extractors in raw units)
const LOGIT_FEATURES: Record<string, Array<{ name: string; f: Scorer }>> = {
  "logit(fn)": [{ name: "featureNorm", f: (r) => r.featureNorm }],
  "logit(fn,lnSize)": [
    { name: "featureNorm", f: (r) => r.featureNorm },
    { name: "ln(sizePx)", f: (r) => Math.log(Math.max(1, r.sizePx)) },
  ],
  "logit(edge,fn)": [
    { name: "edgeEnergy", f: (r) => r.edgeEnergy },
    { name: "featureNorm", f: (r) => r.featureNorm },
  ],
  "logit(edge,fn,lnSize)": [
    { name: "edgeEnergy", f: (r) => r.edgeEnergy },
    { name: "featureNorm", f: (r) => r.featureNorm },
    { name: "ln(sizePx)", f: (r) => Math.log(Math.max(1, r.sizePx)) },
  ],
  "logit(edge,fn,quality)": [
    { name: "edgeEnergy", f: (r) => r.edgeEnergy },
    { name: "featureNorm", f: (r) => r.featureNorm },
    { name: "quality", f: (r) => r.quality },
  ],
};
const fits: Record<string, { intercept: number; coef: Record<string, number>; cvAuc: number | null }> = {};
for (const [name, feats] of Object.entries(LOGIT_FEATURES)) {
  const x = labelled.map((r) => feats.map((f) => f.f(r)));
  const y = labelled.map((r) => (isBlurry(r) ? 1 : 0));
  const fit = fitLogistic(x, y);
  // deterministic 5-fold CV: fold = index mod 5 in capturedAt order
  const cvScore = new Array<number>(labelled.length);
  for (let fold = 0; fold < 5; fold++) {
    const tr = labelled.map((_, i) => i).filter((i) => i % 5 !== fold);
    const f = fitLogistic(tr.map((i) => x[i]), tr.map((i) => y[i]));
    labelled.forEach((_, i) => {
      if (i % 5 === fold) cvScore[i] = -(f.intercept + x[i].reduce((s, v, j) => s + v * f.coef[j], 0));
    });
  }
  const sharpCv: number[] = [], blurCv: number[] = [];
  labelled.forEach((r, i) => (isSharp(r) ? sharpCv : blurCv).push(cvScore[i]));
  fits[name] = {
    intercept: fit.intercept,
    coef: Object.fromEntries(feats.map((f, j) => [f.name, fit.coef[j]])),
    cvAuc: r3(auc(sharpCv, blurCv)),
  };
  // sharpness = -logit (higher = sharper)
  SCORES[name] = (r) => -(fit.intercept + feats.reduce((s, f, j) => s + f.f(r) * fit.coef[j], 0));
}
// The shipped default (src/server/blurFilter.ts) must reproduce the chosen fit.
SCORES["shipped DEFAULT_BLUR_POLICY"] = (r) =>
  blurSharpness({ edgeEnergy: r.edgeEnergy, featureNorm: r.featureNorm, sizePx: r.sizePx, modelTag: r.modelTag }) ?? NaN;

const perScore: Record<string, Record<string, OperatingPoints>> = {};
for (const [name, f] of Object.entries(SCORES)) {
  perScore[name] = {};
  const groups: Array<[string, Row[]]> = [["pooled", labelled], ...gates.map((g) => [g, labelled.filter((r) => r.gate === g)] as [string, Row[]])];
  for (const [g, rs] of groups) {
    perScore[name][g] = operatingPoints(rs.filter(isSharp).map(f).filter(Number.isFinite), rs.filter(isBlurry).map(f).filter(Number.isFinite));
  }
}

// Size-stratified AUC (confound control): does edgeEnergy still separate within a size band?
const SIZE_BANDS: Array<[string, (s: number) => boolean]> = [
  ["60-79 px", (s) => s >= 60 && s < 80],
  ["80-109 px", (s) => s >= 80 && s < 110],
  [">=110 px", (s) => s >= 110],
];
const stratified: Record<string, Record<string, { nSharp: number; nBlurry: number; auc: number | null }>> = {};
for (const name of ["edgeEnergy", "featureNorm", "quality", "sizePx", "logit(fn,lnSize)", "logit(edge,fn,lnSize)", "shipped DEFAULT_BLUR_POLICY"]) {
  stratified[name] = {};
  for (const [band, inBand] of SIZE_BANDS) {
    const rs = labelled.filter((r) => inBand(r.sizePx));
    const s = rs.filter(isSharp).map(SCORES[name]), b = rs.filter(isBlurry).map(SCORES[name]);
    stratified[name][band] = { nSharp: s.length, nBlurry: b.length, auc: r3(auc(s, b)) };
  }
}

// Current stranger floors
const floors = (r: Row) => r.edgeEnergy < 0.16 || r.featureNorm < 20;
const floorsByGroup: Record<string, { blurryCaught: number | null; sharpLost: number | null }> = {};
for (const [g, rs] of [["pooled", labelled], ...gates.map((g) => [g, labelled.filter((r) => r.gate === g)] as [string, Row[]])] as Array<[string, Row[]]>) {
  const b = rs.filter(isBlurry), s = rs.filter(isSharp);
  floorsByGroup[g] = { blurryCaught: r3(b.filter(floors).length / (b.length || 1)), sharpLost: r3(s.filter(floors).length / (s.length || 1)) };
}

// Expected impact of the shipped default once wired, per gate and class
const shipped = SCORES["shipped DEFAULT_BLUR_POLICY"];
const flagged = (r: Row) => {
  const v = shipped(r);
  return Number.isFinite(v) && v < DEFAULT_BLUR_POLICY.threshold;
};
const impact: Record<string, Record<string, { n: number; flagged: number; share: number | null }>> = {};
for (const g of ["pooled", ...gates]) {
  impact[g] = {};
  for (const label of ["blurry", "sharp-proxy", "sharp-rated", "stranger-unlabelled", "recognised-other"] as Label[]) {
    const rs = rows.filter((r) => r.label === label && (g === "pooled" || r.gate === g));
    const n = rs.length, fl = rs.filter(flagged).length;
    impact[g][label] = { n, flagged: fl, share: n ? r3(fl / n) : null };
  }
  const strangers = rows.filter((r) => (r.label === "blurry" || r.label === "stranger-unlabelled") && (g === "pooled" || r.gate === g));
  impact[g]["all-stranger-captures"] = { n: strangers.length, flagged: strangers.filter(flagged).length, share: strangers.length ? r3(strangers.filter(flagged).length / strangers.length) : null };
}

// Distribution summary (quantiles) per class for the raw metrics
const q = (vals: number[], p: number) => r3(quantile([...vals].sort((a, b) => a - b), p));
const dist: Record<string, Record<string, { p10: number | null; p50: number | null; p90: number | null }>> = {};
for (const metric of ["edgeEnergy", "featureNorm", "quality", "sizePx", "detectorScore"]) {
  dist[metric] = {};
  for (const label of ["blurry", "sharp-proxy", "stranger-unlabelled", "recognised-other"] as Label[]) {
    const v = rows.filter((r) => r.label === label).map(SCORES[metric]);
    dist[metric][label] = { p10: q(v, 0.1), p50: q(v, 0.5), p90: q(v, 0.9) };
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  modelTag: BLUR_MODEL_TAG,
  rowsEvaluated: rows.length,
  classSizes,
  labelWindow: { blurry: dayRange(isBlurry), sharp: dayRange(isSharp) },
  distributions: dist,
  perScore,
  logisticFits: fits,
  sizeStratifiedAuc: stratified,
  currentFloors: { rule: "edgeEnergy < 0.16 OR featureNorm < 20", byGroup: floorsByGroup },
  shippedPolicy: DEFAULT_BLUR_POLICY,
  expectedImpactOfShippedPolicy: impact,
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));

const md: string[] = [];
md.push(`# Blur filter S1 - label evaluation (${report.generatedAt.slice(0, 10)})`, "");
md.push(`Rows: ${rows.length} faces with gateId and featureNorm, model ${BLUR_MODEL_TAG}. Labels: blurry ${labelled.filter(isBlurry).length}, sharp ${labelled.filter(isSharp).length}.`, "");
md.push("## Class sizes per gate", "", "| gate | " + ["blurry", "sharp-rated", "sharp-proxy", "recognised-other", "stranger-unlabelled"].join(" | ") + " |", "|---|---|---|---|---|---|");
for (const g of gates) md.push(`| ${g} | ` + ["blurry", "sharp-rated", "sharp-proxy", "recognised-other", "stranger-unlabelled"].map((l) => classSizes[g][l] || 0).join(" | ") + " |");
md.push("", "## Metric distributions (p10 / p50 / p90)", "", "| metric | blurry | sharp-proxy | stranger-unlabelled | recognised-other |", "|---|---|---|---|---|");
for (const [m, d] of Object.entries(dist)) md.push(`| ${m} | ` + ["blurry", "sharp-proxy", "stranger-unlabelled", "recognised-other"].map((l) => `${d[l].p10} / ${d[l].p50} / ${d[l].p90}`).join(" | ") + " |");
for (const g of ["pooled", ...gates]) {
  md.push("", `## Scores - ${g}`, "", "| score | n sharp/blurry | AUC | t @95% caught | sharp lost | t @70% caught | sharp lost | t @<=10% sharp lost | blurry caught | t @<=5% sharp lost | blurry caught |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [name, byG] of Object.entries(perScore)) {
    const o = byG[g];
    md.push(`| ${name} | ${o.n.sharp}/${o.n.blurry} | ${o.auc} | ${o.catch95.threshold} | ${pct(o.catch95.sharpLost ?? NaN)} | ${o.catch70.threshold} | ${pct(o.catch70.sharpLost ?? NaN)} | ${o.lose10.threshold} | ${pct(o.lose10.blurryCaught ?? NaN)} | ${o.lose5.threshold} | ${pct(o.lose5.blurryCaught ?? NaN)} |`);
  }
  md.push("", `Current floors (edgeEnergy < 0.16 or featureNorm < 20) at ${g}: blurry caught ${pct(floorsByGroup[g].blurryCaught ?? NaN)}, sharp lost ${pct(floorsByGroup[g].sharpLost ?? NaN)}.`);
}
md.push("", "## Logistic fits (raw units; P(blurry) = sigmoid(intercept + sum coef*x); 5-fold CV AUC)", "");
for (const [name, f] of Object.entries(fits)) md.push(`- ${name}: intercept ${f.intercept.toFixed(4)}, ` + Object.entries(f.coef).map(([k, v]) => `${k} ${v.toFixed(4)}`).join(", ") + `; CV AUC ${f.cvAuc}`);
md.push("", "## Size-stratified AUC (confound control)", "", "| score | " + SIZE_BANDS.map(([b]) => b).join(" | ") + " |", "|---|---|---|---|");
for (const [name, bands] of Object.entries(stratified)) md.push(`| ${name} | ` + SIZE_BANDS.map(([b]) => `${bands[b].auc} (${bands[b].nSharp}/${bands[b].nBlurry})`).join(" | ") + " |");
md.push("", `## Expected impact of the shipped default (threshold ${DEFAULT_BLUR_POLICY.threshold})`, "", "| gate | class | n | flagged | share |", "|---|---|---|---|---|");
for (const [g, byLabel] of Object.entries(impact)) for (const [l, v] of Object.entries(byLabel)) md.push(`| ${g} | ${l} | ${v.n} | ${v.flagged} | ${pct(v.share ?? NaN)} |`);
fs.writeFileSync(path.join(OUT, "report.md"), md.join("\n") + "\n");
console.log(md.join("\n"));
