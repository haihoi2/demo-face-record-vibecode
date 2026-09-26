/**
 * MT replay-run collector: drives an ISOLATED gateway through its public API
 * and turns what it did into section-1 metrics. Used for the legacy baseline
 * now and for legacy-vs-pipeline acceptance later (same code, same clips).
 *
 * Runs inside the test image on the Docker test network:
 *   APP_URL=http://smartface-verify-rt-mt:3000 OPERATOR_TOKEN=... \
 *   node --import tsx tests/master/baseline/collect.ts <command> [--flags]
 *
 * Commands
 *   setup   --clips <clips.json> --state <state.json> [--rtsp-base rtsp://mediamtx-rt-mt:8554]
 *           enrol the fixtures, point both gates at the harness paths "entry" / "exit"
 *   watch   --on|--off [--interval 3] [--frames 1]
 *   record  --seconds N --out <sse.jsonl>        capture watcher SSE events
 *   analyze --clips <clips.json> --state <state.json> --ready ENTRY=<iso>,EXIT=<iso>
 *           [--sse sse.jsonl] [--cpu cpu.csv] [--phases phases.json] --name legacy --out <m.json> [--md <m.md>]
 *
 * Never aim this at the live gateway: `setup` rewrites the camera config and
 * creates employees. It refuses APP_URLs on :8080 or the public hostnames.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { api, BASE_URL, ensureFixtureCatalog, FIXTURE_DEPARTMENT, FIXTURE_POSITION, postJson } from "../../integration/helpers.ts";
import { loadGroundTruth, type GroundTruth } from "../lib/groundTruth.ts";
import {
  cpuByPhase,
  gateMetrics,
  lookStats,
  metricsTable,
  type CpuSample,
  type Gate,
  type LogObs,
  type LookObs,
  type PassageAbs,
  type PhaseWindow,
} from "../lib/metrics.ts";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[a.slice(2)] = true;
    else {
      args[a.slice(2)] = next;
      i++;
    }
  }
  return args;
}

export function refuseLiveTarget(url: string) {
  const u = new URL(url);
  if (u.port === "8080" || /vota\.vn$|eton\.vn$/i.test(u.hostname) || u.hostname === "smartface-local-gateway") {
    throw new Error(`refusing to drive ${u.host}: the collector mutates config and must only target an isolated gateway`);
  }
}

function dataUrlOf(file: string): string {
  const buf = readFileSync(file);
  const mime = /\.png$/i.test(file) ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

interface State {
  fixtures: Record<string, string>;
  createdAt: string;
  streams: Record<Gate, string>;
}

async function setup(args: Args) {
  const clipsPath = String(args.clips);
  const doc: GroundTruth = loadGroundTruth(clipsPath);
  const clipsDir = dirname(clipsPath);
  const rtspBase = String(args["rtsp-base"] || "rtsp://mediamtx-rt-mt:8554").replace(/\/+$/, "");
  await ensureFixtureCatalog();
  const fixtures: Record<string, string> = {};
  for (const [key, fx] of Object.entries(doc.fixtures || {})) {
    if (fx.role !== "employee") continue;
    const image = dataUrlOf(join(clipsDir, fx.enrolImage));
    const code = `MT-${key}-${Date.now().toString(36)}`.toUpperCase();
    const created = await postJson("/api/employees", {
      name: `MT Fixture ${key}`,
      employeeCode: code,
      department: FIXTURE_DEPARTMENT,
      position: FIXTURE_POSITION,
      photoUrl: image,
      accessLevel: "ALL_ACCESS",
    });
    if (created.status !== 200 || !created.body?.employee?.id) throw new Error(`create fixture ${key}: HTTP ${created.status} ${created.text.slice(0, 200)}`);
    const id = created.body.employee.id as string;
    const templates = await api(`/api/employees/${encodeURIComponent(id)}/templates`);
    const have = Array.isArray(templates.body?.templates) ? templates.body.templates.length : 0;
    if (have === 0) {
      const enrol = await postJson(`/api/employees/${encodeURIComponent(id)}/templates`, { image });
      if (enrol.status !== 200 && enrol.status !== 201) throw new Error(`enrol fixture ${key}: HTTP ${enrol.status} ${enrol.text.slice(0, 300)}`);
    }
    fixtures[key] = id;
    console.log(`[collect] fixture ${key} enrolled (templates before: ${have})`);
  }
  const streams: Record<Gate, string> = { ENTRY: `${rtspBase}/entry`, EXIT: `${rtspBase}/exit` };
  const gatePatch = (gate: "entry" | "exit", url: string) => ({
    enabled: true,
    streams: [{ id: `mt-${gate}`, label: `MT harness ${gate}`, sourceType: "RTSP", rtspUrl: url, rtspTransport: "TCP", enabled: true, priority: 1 }],
  });
  const cfg = await postJson("/api/camera-streams/config", { entryGate: gatePatch("entry", streams.ENTRY), exitGate: gatePatch("exit", streams.EXIT) });
  if (cfg.status !== 200) throw new Error(`camera config: HTTP ${cfg.status} ${cfg.text.slice(0, 300)}`);
  for (const gate of ["entry", "exit"]) {
    const s = await api(`/api/camera-streams/${gate}/streams`);
    const ids = (s.body?.streams || []).map((x: any) => x.id);
    if (ids.length !== 1 || ids[0] !== `mt-${gate}`) throw new Error(`gate ${gate} streams not replaced: ${JSON.stringify(ids)}`);
  }
  const state: State = { fixtures, createdAt: new Date().toISOString(), streams };
  writeFileSync(String(args.state), JSON.stringify(state, null, 2), { mode: 0o600 });
  console.log(`[collect] setup done: ${Object.keys(fixtures).length} fixture(s), gates -> harness`);
}

async function watch(args: Args) {
  const enabled = Boolean(args.on) && !args.off;
  const body: Record<string, unknown> = { enabled };
  if (enabled) {
    body.intervalSeconds = Number(args.interval || 3);
    body.frames = Number(args.frames || 1);
  }
  for (const gate of ["entry", "exit"]) {
    const r = await postJson(`/api/camera-streams/${gate}/watch`, body);
    if (r.status !== 200) throw new Error(`watch ${gate}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
    console.log(`[collect] watch ${gate} enabled=${r.body?.watcher?.enabled} pipelineMode=${r.body?.watcher?.pipelineMode ?? "n/a"}`);
  }
}

/** Captures SSE events for N seconds into JSONL (receivedAtMs + event + data). */
async function record(args: Args) {
  const seconds = Number(args.seconds || 60);
  const out = String(args.out);
  writeFileSync(out, "", { mode: 0o600 });
  const wanted = new Set(String(args.events || "gate_watch_result,gate_watch_state,access_log,new_access_log,pipeline_shadow_result,lock_state").split(","));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), seconds * 1000);
  // api() buffers whole bodies; SSE needs streaming, so open the stream directly.
  const cookieRes = await fetch(BASE_URL + "/api/events", { headers: { Cookie: await sessionCookie() }, signal: ctrl.signal });
  if (!cookieRes.ok || !cookieRes.body) throw new Error(`SSE: HTTP ${cookieRes.status}`);
  const reader = cookieRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let count = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (!ev || !data || !wanted.has(ev)) continue;
        appendFileSync(out, JSON.stringify({ receivedAtMs: Date.now(), event: ev, data: JSON.parse(data) }) + "\n");
        count++;
      }
    }
  } catch (err: any) {
    if (err?.name !== "AbortError") throw err;
  } finally {
    clearTimeout(timer);
  }
  console.log(`[collect] recorded ${count} SSE event(s) in ${seconds} s`);
}

let cookieCache: string | null = null;
async function sessionCookie(): Promise<string> {
  if (cookieCache) return cookieCache;
  const r = await fetch(BASE_URL + "/api/operator/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: process.env.OPERATOR_TOKEN || "integration-operator-token" }),
  });
  if (r.status !== 200) throw new Error(`login: HTTP ${r.status}`);
  cookieCache = (r.headers.get("set-cookie") || "").split(";", 1)[0];
  return cookieCache;
}

async function fetchLogs(fromIso: string, toIso: string): Promise<LogObs[]> {
  const out: LogObs[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 200; page++) {
    const q = new URLSearchParams({ paging: "cursor", from: fromIso, to: toIso, limit: "200" });
    if (cursor) q.set("cursor", cursor);
    const r = await api(`/api/logs?${q}`);
    if (r.status !== 200) throw new Error(`logs: HTTP ${r.status} ${r.text.slice(0, 200)}`);
    for (const l of r.body.logs || []) {
      out.push({ id: l.id, gate: l.type === "EXIT" ? "EXIT" : "ENTRY", tsMs: Date.parse(l.timestamp), status: l.status, employeeId: l.employeeId ?? null });
    }
    if (!r.body.hasMore || !r.body.nextCursor) break;
    cursor = r.body.nextCursor;
  }
  return out;
}

export function absolutePassages(doc: GroundTruth, ready: Record<string, number>, fixtures: Record<string, string>): PassageAbs[] {
  const out: PassageAbs[] = [];
  for (const clip of doc.clips) {
    const t0 = ready[clip.gate];
    if (!Number.isFinite(t0)) continue;
    for (const p of clip.passages) {
      out.push({
        id: `${clip.id}/${p.id}`,
        gate: clip.gate,
        startMs: t0 + p.startS * 1000,
        endMs: t0 + p.endS * 1000,
        tags: p.tags,
        people: p.people.map((person) => {
          const who = person.who;
          const employeeId = who === "stranger" ? undefined : "employeeId" in who ? who.employeeId : fixtures[who.fixture];
          return {
            label: person.label,
            employeeId,
            stranger: who === "stranger",
            expected: person.expected,
            firstUsableMs: person.firstUsableS === null ? null : t0 + person.firstUsableS * 1000,
          };
        }),
      });
    }
  }
  return out;
}

function readJsonl(file: string): any[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function readCpuCsv(file: string): CpuSample[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [t, pct] = line.split(",");
        return { tMs: Number(t), cores: Number(String(pct).replace("%", "")) / 100 };
      })
      .filter((s) => Number.isFinite(s.tMs) && Number.isFinite(s.cores));
  } catch {
    return [];
  }
}

async function analyze(args: Args) {
  const doc = loadGroundTruth(String(args.clips));
  const state: State = JSON.parse(readFileSync(String(args.state), "utf8"));
  const ready: Record<string, number> = {};
  for (const pair of String(args.ready || "").split(",")) {
    const [gate, iso] = pair.split("=");
    if (gate && iso) ready[gate.toUpperCase()] = Date.parse(iso);
  }
  const passages = absolutePassages(doc, ready, state.fixtures);
  if (passages.length === 0) throw new Error("no passages with a known start time (--ready)");
  const from = new Date(Math.min(...passages.map((p) => p.startMs)) - 1000).toISOString();
  const to = new Date(Math.max(...passages.map((p) => p.endMs)) + 60_000).toISOString();
  const logs = await fetchLogs(from, to);

  const sse = args.sse ? readJsonl(String(args.sse)) : [];
  const looks: LookObs[] = sse
    .filter((e) => e.event === "gate_watch_result")
    .map((e) => ({
      gate: e.data.gate === "EXIT" ? "EXIT" : "ENTRY",
      atMs: Date.parse(e.data.at) || e.receivedAtMs,
      durationMs: e.data.durationMs,
      captureMs: e.data.frameCaptureDurationMs,
      processingMs: e.data.processingTimeMs,
      ok: e.data.ok === true,
      faces: e.data.totalFacesDetected,
    }));
  const cpu = args.cpu ? readCpuCsv(String(args.cpu)) : [];
  const phases: PhaseWindow[] = args.phases ? JSON.parse(readFileSync(String(args.phases), "utf8")) : [];

  const perGate: Record<string, ReturnType<typeof gateMetrics>["metrics"]> = {};
  const persons: any[] = [];
  for (const gate of ["ENTRY", "EXIT"] as Gate[]) {
    const mine = passages.filter((p) => p.gate === gate);
    if (mine.length === 0) continue;
    const r = gateMetrics(mine, logs);
    perGate[gate] = r.metrics;
    persons.push(...r.persons);
  }
  const all = gateMetrics(passages, logs);
  const name = String(args.name || "run");
  const result = {
    name,
    generatedAt: new Date().toISOString(),
    gateway: BASE_URL.replace(/\/\/[^@/]*@/, "//"),
    ready: Object.fromEntries(Object.entries(ready).map(([k, v]) => [k, new Date(v).toISOString()])),
    perGate,
    overall: all.metrics,
    looks: { ENTRY: lookStats(looks, "ENTRY"), EXIT: lookStats(looks, "EXIT") },
    cpu: cpuByPhase(cpu, phases),
    phases,
    // Per-person rows carry passage ids and labels only - no employee ids or names.
    persons: persons.map(({ passageId, gate, label, kind, decided, outcome, correct, latencyMs, logs: n }) => ({ passageId, gate, label, kind, decided, outcome, correct, latencyMs, logs: n })),
    logsOutsidePassages: logs.filter((l) => !passages.some((p) => p.gate === l.gate && l.tsMs >= p.startMs && l.tsMs < p.endMs)).length,
  };
  writeFileSync(String(args.out), JSON.stringify(result, null, 2));
  const table = metricsTable([{ name, perGate: { ...perGate, ALL: all.metrics } }]);
  const cpuRows = Object.entries(result.cpu).map(([ph, c]) => `| ${ph} | ${c.meanCores ?? "n/a"} | ${c.p95Cores ?? "n/a"} | ${c.n} |`);
  const lookRows = (["ENTRY", "EXIT"] as const).map((g) => {
    const l = result.looks[g];
    const s = (v: number | null) => (v === null ? "n/a" : `${(v / 1000).toFixed(2)} s`);
    return `| ${g} | ${l.looks} | ${l.failed} | ${s(l.startToStartMs.p50)} / ${s(l.startToStartMs.p95)} | ${s(l.captureMs.p50)} | ${s(l.processingMs.p50)} |`;
  });
  const md = [
    `### ${name} (${result.generatedAt})`,
    "",
    table,
    "",
    "| CPU phase | mean cores | p95 cores | samples |",
    "|---|---|---|---|",
    ...cpuRows,
    "",
    "| Gate | looks | failed | look start-to-start p50 / p95 | frame grab p50 | processing p50 |",
    "|---|---|---|---|---|---|",
    ...lookRows,
    "",
  ].join("\n");
  if (args.md) writeFileSync(String(args.md), md);
  console.log(md);
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  refuseLiveTarget(BASE_URL);
  if (command === "setup") return setup(args);
  if (command === "watch") return watch(args);
  if (command === "record") return record(args);
  if (command === "analyze") return analyze(args);
  throw new Error("usage: collect.ts setup|watch|record|analyze [--flags]");
}

if (process.argv[1] && /collect\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(`[collect] ${err?.message || err}`);
    process.exit(1);
  });
}
