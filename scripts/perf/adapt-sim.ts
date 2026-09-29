#!/usr/bin/env -S npx tsx
/**
 * Camera-adaptation policy check on the site's own captures (plan Part C3,
 * accuracy wave). Uses the crops directory of scripts/perf/calib-crops.ts and
 * the embedding cache written by scripts/perf/calib-eval.ts (emb_<model>.f32);
 * run calib-eval first. Aggregates only - no embedding or pixel leaves the
 * directory.
 *
 *   npx tsx scripts/perf/adapt-sim.ts <crops-dir> --model r50 [--exclude EMP-0465]
 *        [--accept-single 0.55] [--grant-margin 0.08] [--templates 5]
 *        [--seed-gate ENTRY] [--target-gate EXIT] [--out report.json]
 *
 * Part 1 - who passes the policy. Gallery = the k best-quality crops of every
 * employee on the seed gate (what an operator enrols there); every other crop
 * is a probe scored like matchObservations (best employee, runner-up, margin).
 * A probe is a "grant" when best >= acceptSingle and margin >= grantMargin
 * (the single-strong rule); it "qualifies" when it also passes the adaptation
 * floors (best >= acceptSingle + 0.10, margin >= 0.15, quality >= 0.35).
 * Reported per probe gate for genuine probes (best == own id) and impostor
 * probes (best != own id: other employee or DENIED/stranger): a qualifying
 * impostor would become a WRONG template, the number that must be ~0.
 *
 * Part 2 - seeding camera B. Start from seed-gate templates only, replay the
 * target gate's crops in capture order; every correct grant is offered to the
 * REAL planAdaptation (galleryAdaptation.ts) which adds/evicts target-camera
 * templates under the real policy. After each grant the target-gate TAR
 * (fraction of the target gate's genuine crops, templates excluded, granted
 * correctly against the current gallery) and the stranger false-accept rate are
 * recorded, so the curve "grants -> TAR" is read off directly. Wrong grants
 * that qualify are counted (they would poison the gallery) and applied, as the
 * job would.
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ADAPTATION_POLICY, planAdaptation, type ExistingTemplate, type RecognisedFaceObservation } from "../../src/server/galleryAdaptation";

interface Entry {
  n: number;
  source: "log" | "clip";
  groupId: string;
  identity: string | null;
  status: string;
  gate: string;
  ts: string;
  quality: number;
}

const args = process.argv.slice(2);
const cropsDir = args[0];
const opt = (name: string, d?: string) => {
  const i = args.indexOf(name);
  return i > 0 ? args[i + 1] : d;
};
if (!cropsDir) {
  console.error("usage: adapt-sim.ts <crops-dir> --model r50 [options]");
  process.exit(2);
}
const MODEL = opt("--model", "r50")!;
const EXCLUDE = new Set((opt("--exclude", "") || "").split(",").filter(Boolean));
const ACCEPT_SINGLE = Number(opt("--accept-single", "0.55"));
const GRANT_MARGIN = Number(opt("--grant-margin", "0.08"));
const TEMPLATES = Number(opt("--templates", "5"));
const SEED_GATE = opt("--seed-gate", "ENTRY")!;
const TARGET_GATE = opt("--target-gate", "EXIT")!;
const OUT = opt("--out");
const POLICY = DEFAULT_ADAPTATION_POLICY;
const isEmployee = (id: string | null) => !!id && id.startsWith("EMP-");
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}% (${a}/${b})` : "n/a");

function loadEmbeddings(): Map<number, Float32Array> {
  const cache = path.join(cropsDir, `emb_${MODEL}.f32`);
  if (!fs.existsSync(cache)) throw new Error(`${cache} missing: run scripts/perf/calib-eval.ts with --models ${MODEL}=... first`);
  const buf = fs.readFileSync(cache);
  const idx: number[] = JSON.parse(fs.readFileSync(cache + ".idx", "utf8"));
  const out = new Map<number, Float32Array>();
  for (let i = 0; i < idx.length; i++) out.set(idx[i], new Float32Array(buf.buffer.slice(buf.byteOffset + i * 512 * 4, buf.byteOffset + (i + 1) * 512 * 4)));
  return out;
}
function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

interface Match {
  employeeId: string | undefined;
  cosine: number;
  second: number;
  margin: number;
}
/** matchObservations semantics: best employee by max-over-templates cosine, runner-up identity's best. */
function match(probe: Float32Array, gallery: Map<string, ExistingTemplate[]>): Match {
  let bestId: string | undefined, best = -1, second = -1;
  for (const [employeeId, templates] of gallery) {
    let c = -1;
    for (const t of templates) c = Math.max(c, dot(probe, t.embedding));
    if (c > best) {
      second = best;
      best = c;
      bestId = employeeId;
    } else if (c > second) second = c;
  }
  return { employeeId: bestId, cosine: Math.max(0, best), second: Math.max(0, second), margin: Math.max(0, best) - Math.max(0, second) };
}
const grants = (m: Match) => m.cosine >= ACCEPT_SINGLE && m.margin >= GRANT_MARGIN;
const qualifies = (m: Match, quality: number) =>
  m.cosine >= ACCEPT_SINGLE + POLICY.minCosineAboveAcceptSingle && m.margin >= POLICY.minMargin && quality >= POLICY.minQuality;

function seedGallery(entries: Entry[], emb: Map<number, Float32Array>, gate: string): { gallery: Map<string, ExistingTemplate[]>; used: Set<number> } {
  const gallery = new Map<string, ExistingTemplate[]>();
  const used = new Set<number>();
  const byId = new Map<string, Entry[]>();
  for (const e of entries) if (isEmployee(e.identity) && e.gate === gate && emb.has(e.n)) byId.set(e.identity!, [...(byId.get(e.identity!) ?? []), e]);
  for (const [id, crops] of byId) {
    const picked = [...crops].sort((a, b) => b.quality - a.quality || a.n - b.n).slice(0, TEMPLATES);
    gallery.set(id, picked.map((p) => ({ id: `seed:${p.n}`, employeeId: id, streamId: gate.toLowerCase(), source: "enrollment", quality: p.quality, embedding: emb.get(p.n)! })));
    for (const p of picked) used.add(p.n);
  }
  return { gallery, used };
}

function main() {
  const index = JSON.parse(fs.readFileSync(path.join(cropsDir, "index.json"), "utf8"));
  const calibSet = new Set<number>(
    fs.existsSync(path.join(cropsDir, "calib")) ? fs.readdirSync(path.join(cropsDir, "calib")).map((f) => Number(f.replace(/^rec_|\.u8$/g, ""))) : [],
  );
  const emb = loadEmbeddings();
  const entries: Entry[] = (index.entries as Entry[]).filter((e) => !calibSet.has(e.n) && !(e.identity && EXCLUDE.has(e.identity)) && emb.has(e.n));
  const report: any = { createdAt: new Date().toISOString(), model: MODEL, acceptSingle: ACCEPT_SINGLE, grantMargin: GRANT_MARGIN, policy: POLICY, templatesPerEmployee: TEMPLATES, seedGate: SEED_GATE, targetGate: TARGET_GATE, crops: entries.length, excluded: [...EXCLUDE] };

  // ---------------------------------------------------------------- part 1
  console.log(`\n== Part 1: policy pass rates (gallery = ${TEMPLATES} best ${SEED_GATE} crops per employee; probes = every other crop) ==`);
  const { gallery, used } = seedGallery(entries, emb, SEED_GATE);
  console.log(`gallery: ${gallery.size} employees, ${[...gallery.values()].reduce((s, t) => s + t.length, 0)} templates`);
  const perGate: Record<string, any> = {};
  const genuineCos: number[] = [];
  const impostorCos: number[] = [];
  for (const e of entries) {
    if (used.has(e.n)) continue;
    const m = match(emb.get(e.n)!, gallery);
    const g = (perGate[e.gate] ||= { genuine: { n: 0, grants: 0, qualify: 0 }, impostorEmployee: { n: 0, grants: 0, qualify: 0 }, impostorStranger: { n: 0, grants: 0, qualify: 0 }, qualifyQualityFails: 0, qualifyMarginFails: 0, qualifyCosineFails: 0 });
    const genuine = isEmployee(e.identity) && gallery.has(e.identity!) && m.employeeId === e.identity;
    const bucket = genuine ? g.genuine : isEmployee(e.identity) ? g.impostorEmployee : g.impostorStranger;
    bucket.n++;
    if (grants(m)) {
      bucket.grants++;
      if (qualifies(m, e.quality)) bucket.qualify++;
      else if (genuine) {
        if (m.cosine < ACCEPT_SINGLE + POLICY.minCosineAboveAcceptSingle) g.qualifyCosineFails++;
        else if (m.margin < POLICY.minMargin) g.qualifyMarginFails++;
        else g.qualifyQualityFails++;
      }
    }
    (genuine ? genuineCos : impostorCos).push(m.cosine);
  }
  for (const [gate, g] of Object.entries(perGate)) {
    console.log(`probe gate ${gate}:`);
    console.log(`  genuine   n ${g.genuine.n}: grants ${pct(g.genuine.grants, g.genuine.n)}, qualify for adaptation ${pct(g.genuine.qualify, g.genuine.n)} = ${pct(g.genuine.qualify, g.genuine.grants)} of grants (grants failing: cosine ${g.qualifyCosineFails}, margin ${g.qualifyMarginFails}, quality ${g.qualifyQualityFails})`);
    console.log(`  impostor (other employee) n ${g.impostorEmployee.n}: false grants ${pct(g.impostorEmployee.grants, g.impostorEmployee.n)}, WOULD-QUALIFY ${pct(g.impostorEmployee.qualify, g.impostorEmployee.n)}`);
    console.log(`  impostor (stranger/DENIED) n ${g.impostorStranger.n}: false grants ${pct(g.impostorStranger.grants, g.impostorStranger.n)}, WOULD-QUALIFY ${pct(g.impostorStranger.qualify, g.impostorStranger.n)}`);
  }
  genuineCos.sort((a, b) => a - b);
  impostorCos.sort((a, b) => a - b);
  const q = (v: number[], p: number) => (v.length ? r3(v[Math.min(v.length - 1, Math.floor(p * v.length))]) : NaN);
  report.part1 = { perGate, genuineBest: { n: genuineCos.length, p5: q(genuineCos, 0.05), p50: q(genuineCos, 0.5), p95: q(genuineCos, 0.95) }, impostorBest: { n: impostorCos.length, p50: q(impostorCos, 0.5), p95: q(impostorCos, 0.95), max: q(impostorCos, 1) } };
  console.log(`best-cosine distributions: genuine p5/p50/p95 ${report.part1.genuineBest.p5}/${report.part1.genuineBest.p50}/${report.part1.genuineBest.p95}; impostor p50/p95/max ${report.part1.impostorBest.p50}/${report.part1.impostorBest.p95}/${report.part1.impostorBest.max}`);

  // ---------------------------------------------------------------- part 2
  console.log(`\n== Part 2: seed camera ${TARGET_GATE} from confident grants (start: ${SEED_GATE} templates only; replay ${TARGET_GATE} crops in time order) ==`);
  const live = new Map<string, ExistingTemplate[]>();
  for (const [id, t] of gallery) live.set(id, [...t]);
  const targetCrops = entries.filter((e) => e.gate === TARGET_GATE && !used.has(e.n)).sort((a, b) => a.ts.localeCompare(b.ts) || a.n - b.n);
  const targetGenuine = targetCrops.filter((e) => isEmployee(e.identity) && live.has(e.identity!));
  const targetStrangers = targetCrops.filter((e) => !isEmployee(e.identity));
  const templateIds = new Set<string>();
  const measure = () => {
    let ok = 0, n = 0, fa = 0;
    for (const e of targetGenuine) {
      if (templateIds.has(`obs:${e.n}`)) continue;
      n++;
      const m = match(emb.get(e.n)!, live);
      if (grants(m) && m.employeeId === e.identity) ok++;
    }
    for (const e of targetStrangers) if (grants(match(emb.get(e.n)!, live))) fa++;
    return { tar: n ? r3(ok / n) : NaN, n, strangerFalseAccepts: fa, strangers: targetStrangers.length };
  };
  const curve: any[] = [{ grants: 0, adapted: 0, ...measure() }];
  console.log(`start: ${TARGET_GATE} TAR ${(curve[0].tar * 100).toFixed(1)}% over ${curve[0].n} genuine crops; stranger false accepts ${curve[0].strangerFalseAccepts}/${curve[0].strangers}`);
  let grantCount = 0, adapted = 0, wrongGrants = 0, wrongAdapted = 0, evictions = 0;
  const perEmployee: Record<string, { grants: number; adapted: number }> = {};
  const checkpoints = new Set([1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 75, 100, 150, 200]);
  for (const e of targetCrops) {
    const m = match(emb.get(e.n)!, live);
    if (!grants(m) || !m.employeeId) continue;
    grantCount++;
    const correct = m.employeeId === e.identity;
    if (!correct) wrongGrants++;
    const pe = (perEmployee[m.employeeId] ||= { grants: 0, adapted: 0 });
    pe.grants++;
    const o: RecognisedFaceObservation = { faceId: `obs:${e.n}`, logId: e.groupId, employeeId: m.employeeId, streamId: TARGET_GATE.toLowerCase(), gate: TARGET_GATE, capturedAt: e.ts, quality: e.quality, matchCosine: m.cosine, matchMargin: m.margin, embedding: emb.get(e.n)! };
    const existing = [...live.values()].flat();
    const plan = planAdaptation([o], existing, ACCEPT_SINGLE, POLICY);
    for (const item of plan) {
      const list = live.get(m.employeeId) ?? [];
      if (item.evictTemplateId) {
        evictions++;
        live.set(m.employeeId, list.filter((t) => t.id !== item.evictTemplateId));
      }
      live.get(m.employeeId)!.push({ id: o.faceId, employeeId: m.employeeId, streamId: o.streamId, source: "adaptation", quality: o.quality, embedding: o.embedding });
      templateIds.add(o.faceId);
      adapted++;
      pe.adapted++;
      if (!correct) wrongAdapted++;
    }
    if (checkpoints.has(grantCount) || plan.length) {
      const pt = { grants: grantCount, adapted, ...measure() };
      curve.push(pt);
      if (checkpoints.has(grantCount) || adapted <= 10) console.log(`after ${grantCount} grants (${adapted} templates adapted${wrongAdapted ? `, ${wrongAdapted} WRONG` : ""}): TAR ${(pt.tar * 100).toFixed(1)}%, stranger false accepts ${pt.strangerFalseAccepts}`);
    }
  }
  const final = { grants: grantCount, adapted, ...measure() };
  curve.push(final);
  console.log(`end: ${grantCount} grants (${wrongGrants} wrong), ${adapted} templates adapted (${wrongAdapted} wrong, ${evictions} evictions): TAR ${(final.tar * 100).toFixed(1)}% (from ${(curve[0].tar * 100).toFixed(1)}%), stranger false accepts ${final.strangerFalseAccepts}/${final.strangers}`);
  for (const [id, v] of Object.entries(perEmployee)) console.log(`  ${id}: ${v.grants} grants -> ${v.adapted} templates on ${TARGET_GATE}`);
  report.part2 = { start: curve[0], end: final, curve, wrongGrants, wrongAdapted, evictions, perEmployee, targetGenuineCrops: targetGenuine.length, targetStrangerCrops: targetStrangers.length };
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1), { mode: 0o600 });
}

main();
