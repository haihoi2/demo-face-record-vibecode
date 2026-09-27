/**
 * Turns exported NVR clips (export-nvr-clips.sh) into replayable sequences and
 * ground truth, so run-replay.sh works on real footage exactly as on the
 * scripted set:
 *
 *   FACE_MODEL_DIR=/models FACE_DETECT_SIZE=1280 node --import tsx \
 *     tests/master/harness/build-nvr-truth.ts /clips/candidates.json /clips/nvr
 *
 * Writes into the nvr directory: entry-sequence.mp4 / exit-sequence.mp4
 * (clip, empty filler, clip, ... so the legacy 20 s grant cooldown never joins
 * two passages), entry-empty.mp4 / exit-empty.mp4, and clips.json.
 *
 * Labels: who comes from the legacy access log (WEAK - it is the system being
 * measured). firstUsableS is MEASURED here: the first sampled frame (5 fps)
 * with a clear face >= 60 px, found with a larger detector input than
 * production so small-but-usable faces on the 4K entry camera are not missed.
 * Review and upgrade labels to "verified" by hand where possible.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractFaces } from "../../../src/server/faceEmbedding.ts";
import type { ClipTruth, GroundTruth, PersonTruth } from "../lib/groundTruth.ts";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const SAMPLE_FPS = 5;
const MIN_PX = Number(process.env.FACE_MIN_SIZE_PX || 60);

interface Probe {
  durationS: number;
  fps: number;
  width: number;
  height: number;
  codec: string;
}

export function parseProbe(stderr: string): Probe | null {
  const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const vid = /Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})[^\n]*?, (\d+(?:\.\d+)?) fps/.exec(stderr);
  if (!dur || !vid) return null;
  return {
    durationS: Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]),
    codec: vid[1],
    width: Number(vid[2]),
    height: Number(vid[3]),
    fps: Number(vid[4]),
  };
}

function probe(file: string): Probe {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-i", file], { encoding: "utf8" });
  const p = parseProbe(r.stderr || "");
  if (!p) throw new Error(`cannot probe ${file}`);
  return p;
}

/** Splits an MJPEG byte stream into JPEG frames. */
function splitJpegs(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = -1;
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && start < 0) start = i;
    else if (buf[i] === 0xff && buf[i + 1] === 0xd9 && start >= 0) {
      out.push(buf.subarray(start, i + 2));
      start = -1;
      i++;
    }
  }
  return out;
}

async function scanFirstUsable(file: string): Promise<{ firstUsableS: number | null; maxUsableFaces: number }> {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-i", file, "-an", "-vf", `fps=${SAMPLE_FPS}`, "-q:v", "3", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"], {
    maxBuffer: 2 * 1024 * 1024 * 1024,
  });
  const frames = splitJpegs(r.stdout || Buffer.alloc(0));
  let first: number | null = null;
  let maxFaces = 0;
  for (const [i, jpeg] of frames.entries()) {
    const faces = await extractFaces(jpeg);
    const usable = faces.filter((f: any) => f.clear && Math.min(f.box[2] - f.box[0], f.box[3] - f.box[1]) >= MIN_PX);
    if (usable.length > 0 && first === null) first = i / SAMPLE_FPS;
    maxFaces = Math.max(maxFaces, usable.length);
  }
  return { firstUsableS: first, maxUsableFaces: maxFaces };
}

function concat(files: string[], out: string) {
  const list = out + ".txt";
  writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n", { mode: 0o600 });
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-map", "0:v", "-c", "copy", out]);
  if (r.status !== 0) throw new Error(`concat ${out}: ${String(r.stderr).slice(-300)}`);
  // Decode it once end to end: parameter-set changes between recordings show up here.
  const check = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-i", out, "-f", "null", "-"], { encoding: "utf8" });
  if ((check.stderr || "").trim()) console.warn(`[nvr-truth] decode warnings in ${out}: ${check.stderr.trim().slice(0, 300)}`);
}

async function main() {
  const candidatesPath = process.argv[2] || "/clips/candidates.json";
  const dir = process.argv[3] || "/clips/nvr";
  const { candidates } = JSON.parse(readFileSync(candidatesPath, "utf8"));
  const files = readdirSync(dir).filter((f) => /^\d{3}-(entry|exit)-\d+-\d{8}T\d{6}Z\.mp4$/.test(f)).sort();
  const clips: ClipTruth[] = [];
  const now = new Date();
  for (const gateKey of ["entry", "exit"] as const) {
    const mine = files.filter((f) => f.includes(`-${gateKey}-`));
    const withPeople: Array<{ file: string; c: any; p: Probe }> = [];
    const empties: string[] = [];
    for (const f of mine) {
      const c = candidates[Number(f.slice(0, 3))];
      if (!c) continue;
      const p = probe(join(dir, f));
      if (c.outcome === "empty") empties.push(join(dir, f));
      else withPeople.push({ file: f, c, p });
    }
    if (withPeople.length === 0) continue;
    if (empties.length === 0) throw new Error(`${gateKey}: need at least one empty clip as filler`);
    const filler = empties[0];
    const fillerS = probe(filler).durationS;
    concat(empties, join(dir, `${gateKey}-empty.mp4`));

    const order: string[] = [];
    const passages: ClipTruth["passages"] = [];
    let t = 0;
    for (const [i, { file, c, p }] of withPeople.entries()) {
      const scan = await scanFirstUsable(join(dir, file));
      const people: PersonTruth[] = [];
      for (const [k, emp] of (c.grantedEmployeeIds as string[]).entries()) {
        people.push({ label: `e${k + 1}`, who: { employeeId: emp }, firstUsableS: scan.firstUsableS === null ? null : t + scan.firstUsableS, expected: "GRANTED", labelQuality: "weak" });
      }
      for (let k = 0; k < c.deniedLogs; k++) {
        people.push({ label: `s${k + 1}`, who: "stranger", firstUsableS: scan.firstUsableS === null ? null : t + scan.firstUsableS, expected: "DENIED", labelQuality: "weak" });
      }
      passages.push({ id: `${file.replace(/\.mp4$/, "")}`, startS: t, endS: t + p.durationS, people, tags: [c.peopleBucket, c.outcome, c.light, `usable-faces-max:${scan.maxUsableFaces}`] });
      order.push(join(dir, file));
      t += p.durationS;
      if (i < withPeople.length - 1) {
        passages.push({ id: `${gateKey}-filler-${i + 1}`, startS: t, endS: t + fillerS, people: [], tags: ["empty", "filler"] });
        order.push(filler);
        t += fillerS;
      }
      console.log(`[nvr-truth] ${file}: ${people.length} weak label(s), first usable ${scan.firstUsableS ?? "none"} s, max usable faces ${scan.maxUsableFaces}`);
    }
    concat(order, join(dir, `${gateKey}-sequence.mp4`));
    const p0 = withPeople[0].p;
    clips.push({
      id: `nvr-${gateKey}`,
      file: `${gateKey}-sequence.mp4`,
      gate: gateKey === "entry" ? "ENTRY" : "EXIT",
      source: "nvr",
      nvrChannel: withPeople[0].c.nvrChannel,
      durationS: t,
      fps: p0.fps,
      width: p0.width,
      height: p0.height,
      codec: p0.codec,
      passages,
    });
  }
  const doc: GroundTruth = {
    schemaVersion: 1,
    createdAt: now.toISOString(),
    deleteAfter: new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10),
    clips,
  };
  const out = join(dir, "clips.json");
  if (existsSync(out)) console.warn(`[nvr-truth] overwriting ${out}`);
  writeFileSync(out, JSON.stringify(doc, null, 2), { mode: 0o600 });
  console.log(`[nvr-truth] ${clips.length} sequence(s), ${clips.reduce((n, c) => n + c.passages.filter((p) => p.people.length).length, 0)} passages -> ${out}`);
}

if (process.argv[1] && /build-nvr-truth\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e?.stack || e);
    process.exit(1);
  });
}
