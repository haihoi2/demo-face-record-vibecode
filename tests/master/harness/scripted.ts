/**
 * Scripted passages for the MT replay harness.
 *
 * Renders gate-camera-like clips (HEVC, the site's resolution, frame rate and
 * keyframe interval) in which faces approach the camera on a known schedule,
 * so the ground truth - when each face first reaches 60 px - is exact by
 * construction instead of guessed from logs. Faces come from stills listed in
 * a local faces.json (biometric data: kept under /data/test-clips, never
 * committed); the repository only has faces.example.json.
 *
 *   node --import tsx tests/master/harness/scripted.ts \
 *     --faces /clips/scripted/faces.json --out /clips/scripted [--cycles 4] [--offsets 0,1,2,3]
 *     [--gates entry,exit] [--render-offsets 1,2 --no-assemble]   (parallel render, then one assembling run)
 *
 * Output (all under --out): slots/<gate>-<slot>-o<offset>.mp4, <gate>-sequence.mp4,
 * <gate>-empty.mp4 (idle scene), faces/<key>-enrol.jpg, clips.json.
 *
 * Face schedule inside a 25 s slot (tau = time since the face appeared):
 *   size(tau) = 40 + 20*tau px for tau in [0, 3.5], then 110 px until tau = 4,
 *   then the person has walked past (gone). So the face is >= 60 px from
 *   tau = 1.0 to tau = 4.0: a 3 s usable window, the "2-3 s" of the plan.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ClipTruth, Gate, GroundTruth, PassageTruth, PersonTruth } from "../lib/groundTruth.ts";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

export interface FaceSpec {
  /** Still image holding the face (container path). */
  image: string;
  /** Face box in that image: x1, y1, x2, y2. */
  box: [number, number, number, number];
  role: "employee" | "stranger";
  /** Same person as another key (a second, harder view of an enrolled employee). */
  identity?: string;
  /** Image to enrol the employee from (employees only; defaults to `image`). */
  enrol?: string;
}

export interface GateSpec {
  gate: Gate;
  width: number;
  height: number;
  fps: number;
  gop: number;
  /** Target bitrate: close to a real camera so decoding costs what it costs on site. */
  bitrateKbps: number;
}

/** Site facts (brief): entry EZVIZ 4K 15 fps keyframe ~4 s, exit NVR 1080p 25 fps keyframe ~2 s. */
export const GATES: Record<"entry" | "exit", GateSpec> = {
  entry: { gate: "ENTRY", width: 3840, height: 2160, fps: 15, gop: 60, bitrateKbps: 6000 },
  exit: { gate: "EXIT", width: 1920, height: 1080, fps: 25, gop: 50, bitrateKbps: 3000 },
};

export const SLOT_S = 25;
export const APPEAR_AT_S = 4.0;
export const STAGGER_S = 0.5;
export const FACE_MIN_PX = 60;

/** Face size (shorter box side, px) `tau` seconds after the person appeared; 0 = not in view. */
export function faceSizeAt(tau: number): number {
  if (tau < 0 || tau >= 4.0) return 0;
  return tau <= 3.5 ? 40 + 20 * tau : 110;
}
/** First tau at which the face is >= `minPx` (60 -> 1.0 s). */
export function firstUsableTau(minPx = FACE_MIN_PX): number {
  return Math.max(0, (minPx - 40) / 20);
}
export const LAST_USABLE_TAU = 4.0;

export interface SlotType {
  id: string;
  /** Face keys, one per lane, in order of appearance. */
  faces: string[];
  tags: string[];
}

/**
 * One cycle of 10 slots. Order chosen so the legacy cooldowns (grant 20 s per
 * employee, stranger 60 s per face) never hide a repeat: an employee repeats
 * >= 2 slots (50 s) later, a stranger >= 3 slots (75 s) later.
 */
export const CYCLE: string[] = ["A1", "B1", "C1", "E", "AB", "E", "A1h", "E", "ABC", "E"];

export const SLOT_TYPES: Record<string, SlotType> = {
  A1: { id: "A1", faces: ["A"], tags: ["single", "employee"] },
  A1h: { id: "A1h", faces: ["Ah"], tags: ["single", "employee", "other-view"] },
  B1: { id: "B1", faces: ["B"], tags: ["single", "stranger", "impostor-set"] },
  C1: { id: "C1", faces: ["C"], tags: ["single", "stranger", "impostor-set"] },
  AB: { id: "AB", faces: ["A", "B"], tags: ["two"] },
  ABC: { id: "ABC", faces: ["A", "B", "C"], tags: ["three"] },
  E: { id: "E", faces: [], tags: ["empty"] },
};

interface Rgb {
  width: number;
  height: number;
  data: Buffer;
}

function decodeCrop(spec: FaceSpec): { img: Rgb; ratio: number } {
  const [x1, y1, x2, y2] = spec.box;
  const bw = x2 - x1;
  const bh = y2 - y1;
  const probe = spawnSync(FFMPEG, ["-hide_banner", "-i", spec.image], { encoding: "utf8" });
  const m = /, (\d{2,5})x(\d{2,5})/.exec(probe.stderr || "");
  if (!m) throw new Error(`cannot read size of ${basename(spec.image)}`);
  const iw = Number(m[1]);
  const ih = Number(m[2]);
  // Square crop of 2.5x the face, shifted to stay inside the image.
  let side = Math.round(2.5 * Math.max(bw, bh));
  // Even sizes and offsets: the stills are 4:2:0 and FFmpeg rounds odd crops down.
  side = Math.min(side, iw, ih) & ~1;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const left = Math.max(0, Math.min(iw - side, Math.round(cx - side / 2))) & ~1;
  const top = Math.max(0, Math.min(ih - side, Math.round(cy - side / 2))) & ~1;
  const out = spawnSync(
    FFMPEG,
    ["-hide_banner", "-loglevel", "error", "-i", spec.image, "-vf", `crop=${side}:${side}:${left}:${top}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (out.status !== 0 || out.stdout.length !== side * side * 3) throw new Error(`cannot crop ${basename(spec.image)}`);
  return { img: { width: side, height: side, data: out.stdout }, ratio: Math.min(bw, bh) / side };
}

/** Bilinear resize + paste of `src` scaled to `size` x `size`, centred at (cx, cy). */
function pasteScaled(dst: Rgb, src: Rgb, size: number, cx: number, cy: number) {
  const s = Math.max(2, Math.round(size));
  const x0 = Math.round(cx - s / 2);
  const y0 = Math.round(cy - s / 2);
  const scale = src.width / s;
  for (let y = 0; y < s; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= dst.height) continue;
    const sy = Math.min(src.height - 1.001, Math.max(0, (y + 0.5) * scale - 0.5));
    const syi = Math.floor(sy);
    const fy = sy - syi;
    for (let x = 0; x < s; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= dst.width) continue;
      const sx = Math.min(src.width - 1.001, Math.max(0, (x + 0.5) * scale - 0.5));
      const sxi = Math.floor(sx);
      const fx = sx - sxi;
      const i00 = (syi * src.width + sxi) * 3;
      const i01 = i00 + 3;
      const i10 = i00 + src.width * 3;
      const i11 = i10 + 3;
      const o = (dy * dst.width + dx) * 3;
      for (let c = 0; c < 3; c++) {
        const v =
          src.data[i00 + c] * (1 - fx) * (1 - fy) +
          src.data[i01 + c] * fx * (1 - fy) +
          src.data[i10 + c] * (1 - fx) * fy +
          src.data[i11 + c] * fx * fy;
        dst.data[o + c] = v;
      }
    }
  }
}

function background(g: GateSpec): Rgb {
  const data = Buffer.alloc(g.width * g.height * 3);
  let seed = 12345;
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = (seed >> 16) % 9;
      const o = (y * g.width + x) * 3;
      data[o] = 70 + ((x * 40) / g.width) + n;
      data[o + 1] = 80 + ((y * 30) / g.height) + n;
      data[o + 2] = 90 + n;
    }
  }
  return { width: g.width, height: g.height, data };
}

/** Where lane `k` stands (centre) at time tau: spread across the frame, drifting sideways slowly. */
export function laneCentre(g: GateSpec, lane: number, tau: number): [number, number] {
  const x = g.width * (0.3 + 0.2 * lane) + tau * g.width * 0.01;
  const y = g.height * 0.4;
  return [x, y];
}

export interface RenderedPerson {
  key: string;
  lane: number;
  appearS: number;
  firstUsableS: number;
  lastUsableS: number;
}

/** Who appears when in one slot rendered with its faces shifted by `offsetS`. */
export function slotPeople(slot: SlotType, offsetS = 0): RenderedPerson[] {
  return slot.faces.map((key, lane) => {
    const appearS = APPEAR_AT_S + offsetS + lane * STAGGER_S;
    return { key, lane, appearS, firstUsableS: appearS + firstUsableTau(), lastUsableS: appearS + LAST_USABLE_TAU };
  });
}

export function slotFile(gateKey: string, slotId: string, offsetS: number): string {
  return `${gateKey}-${slotId}-o${offsetS}.mp4`;
}

async function renderSlot(g: GateSpec, slot: SlotType, faces: Record<string, { img: Rgb; ratio: number }>, bg: Rgb, outFile: string, offsetS: number): Promise<RenderedPerson[]> {
  const people = slotPeople(slot, offsetS);
  const frames = Math.round(SLOT_S * g.fps);
  const ff = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${g.width}x${g.height}`, "-r", String(g.fps), "-i", "pipe:0",
    // Mild temporal sensor noise keeps the bitrate (hence decode cost) camera-like.
    "-vf", "noise=alls=5:allf=t",
    "-an", "-c:v", "libx265", "-preset", "ultrafast", "-b:v", `${g.bitrateKbps}k`,
    "-maxrate", `${g.bitrateKbps}k`, "-bufsize", `${g.bitrateKbps * 2}k`, "-pix_fmt", "yuv420p",
    "-x265-params", `keyint=${g.gop}:min-keyint=${g.gop}:scenecut=0:bframes=0:log-level=error:pools=2`,
    "-tag:v", "hvc1", "-r", String(g.fps), outFile,
  ], { stdio: ["pipe", "ignore", "inherit"] });
  const done = new Promise<void>((resolve, reject) => {
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code} for ${basename(outFile)}`))));
  });
  const frame: Rgb = { width: g.width, height: g.height, data: Buffer.alloc(bg.data.length) };
  for (let n = 0; n < frames; n++) {
    const t = n / g.fps;
    bg.data.copy(frame.data);
    for (const p of people) {
      const tau = t - p.appearS;
      const facePx = faceSizeAt(tau);
      if (facePx <= 0) continue;
      const face = faces[p.key];
      const [cx, cy] = laneCentre(g, p.lane, tau);
      pasteScaled(frame, face.img, facePx / face.ratio, cx, cy);
    }
    if (!ff.stdin.write(frame.data)) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  await done;
  return people;
}

function concat(files: string[], outFile: string, listFile: string) {
  writeFileSync(listFile, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-tag:v", "hvc1", outFile]);
  if (r.status !== 0) throw new Error(`concat failed: ${String(r.stderr).slice(-300)}`);
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
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

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const facesPath = String(args.faces || "");
  const out = String(args.out || "");
  const cycles = Math.max(1, Number(args.cycles || 4));
  const gatesWanted = String(args.gates || "entry,exit").split(",") as Array<"entry" | "exit">;
  // Cycle c shifts every face by offsets[c % n] seconds. The legacy watcher only
  // decodes keyframes (entry: one every 4 s), so without this every passage of
  // a slot type would sit at the same keyframe phase; 0,1,2,3 s samples a 4 s
  // GOP uniformly, as random arrivals do on site.
  const offsets = String(args.offsets ?? "0,1,2,3").split(",").map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 8);
  const renderOffsets = new Set(String(args["render-offsets"] ?? offsets.join(",")).split(",").map(Number));
  const assemble = !args["no-assemble"];
  if (!facesPath || !out) throw new Error("usage: scripted.ts --faces faces.json --out DIR [--cycles N] [--gates entry,exit]");
  const specs = JSON.parse(readFileSync(facesPath, "utf8")) as Record<string, FaceSpec>;
  for (const key of ["A", "Ah", "B", "C"]) if (!specs[key]) throw new Error(`faces.json needs key ${key}`);
  mkdirSync(join(out, "slots"), { recursive: true, mode: 0o700 });
  mkdirSync(join(out, "faces"), { recursive: true, mode: 0o700 });

  const faces: Record<string, { img: Rgb; ratio: number }> = {};
  for (const [key, spec] of Object.entries(specs)) faces[key] = decodeCrop(spec);

  // Enrolment images for employees (one per identity).
  const fixtures: GroundTruth["fixtures"] = {};
  for (const [key, spec] of Object.entries(specs)) {
    const identity = spec.identity || key;
    if (fixtures[identity]) continue;
    const dest = join(out, "faces", `${identity}-enrol.jpg`);
    if (spec.role === "employee") copyFileSync(spec.enrol || spec.image, dest);
    fixtures[identity] = { enrolImage: spec.role === "employee" ? `faces/${identity}-enrol.jpg` : "", role: spec.role };
  }

  const clips: ClipTruth[] = [];
  for (const gateKey of gatesWanted) {
    const g = GATES[gateKey];
    const bg = background(g);
    for (const o of offsets) {
      if (!renderOffsets.has(o)) continue;
      for (const slot of Object.values(SLOT_TYPES)) {
        if (slot.faces.length === 0 && o !== 0) continue; // an empty scene has no phase
        const file = join(out, "slots", slotFile(gateKey, slot.id, o));
        if (existsSync(file) && statSync(file).size > 0) continue; // resumable / parallel runs
        const t0 = Date.now();
        await renderSlot(g, slot, faces, bg, file, o);
        console.log(`[scripted] ${gateKey} ${slot.id} +${o}s rendered in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      }
    }
    if (!assemble) continue;
    // Idle scene for CPU-at-idle measurements: 4 empty slots.
    concat(Array(4).fill(join(out, "slots", slotFile(gateKey, "E", 0))), join(out, `${gateKey}-empty.mp4`), join(out, `${gateKey}-empty.txt`));

    const order: Array<{ id: string; o: number }> = [];
    for (let c = 0; c < cycles; c++) for (const id of CYCLE) order.push({ id, o: SLOT_TYPES[id].faces.length ? offsets[c % offsets.length] : 0 });
    concat(order.map(({ id, o }) => join(out, "slots", slotFile(gateKey, id, o))), join(out, `${gateKey}-sequence.mp4`), join(out, `${gateKey}-sequence.txt`));

    const passages: PassageTruth[] = order.map(({ id, o }, i) => {
      const startS = i * SLOT_S;
      const people: PersonTruth[] = slotPeople(SLOT_TYPES[id], o).map((p) => {
        const spec = specs[p.key];
        const identity = spec.identity || p.key;
        return {
          label: p.key,
          who: spec.role === "employee" ? { fixture: identity } : "stranger",
          firstUsableS: round3(startS + p.firstUsableS),
          lastUsableS: round3(startS + p.lastUsableS),
          expected: spec.role === "employee" ? "GRANTED" : "DENIED",
          labelQuality: "exact",
          ...(spec.role === "stranger" ? { impostor: false } : {}),
        };
      });
      return { id: `${gateKey}-${String(i + 1).padStart(3, "0")}-${id}`, startS, endS: startS + SLOT_S, people, tags: [...SLOT_TYPES[id].tags, `offset:${o}`] };
    });
    clips.push({
      id: `scripted-${gateKey}`,
      file: `${gateKey}-sequence.mp4`,
      gate: g.gate,
      source: "scripted",
      durationS: order.length * SLOT_S,
      fps: g.fps,
      gop: g.gop,
      width: g.width,
      height: g.height,
      codec: "hevc",
      passages,
    });
  }

  if (!assemble) return;
  const now = new Date();
  const doc: GroundTruth = {
    schemaVersion: 1,
    createdAt: now.toISOString(),
    deleteAfter: new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10),
    fixtures,
    clips,
  };
  writeFileSync(join(out, "clips.json"), JSON.stringify(doc, null, 2), { mode: 0o600 });
  console.log(`[scripted] wrote ${clips.length} clip(s), ${clips.reduce((n, c) => n + c.passages.length, 0)} passages -> ${join(out, "clips.json")}`);
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err?.stack || err);
    process.exit(1);
  });
}
