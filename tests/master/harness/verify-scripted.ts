/**
 * Checks a scripted clip set against its ground truth with the real detector:
 * for every face of every slot type, grabs frames just before and after the
 * scheduled "first >= 60 px" moment and reports the detected face size and
 * whether it is clear. Writes <dir>/verify-detect<size>.json; exit 1 if a scheduled face is not found.
 *
 *   FACE_MODEL_DIR=/models node --import tsx tests/master/harness/verify-scripted.ts /clips/scripted
 *
 * FACE_DETECT_SIZE can be raised (e.g. 1280) to separate "the face is there"
 * from "the production detector size can see it" on the 4K entry clips.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractFaces } from "../../../src/server/faceEmbedding.ts";
import { APPEAR_AT_S, GATES, SLOT_TYPES, STAGGER_S, firstUsableTau, laneCentre, slotFile } from "./scripted.ts";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

function frameAt(file: string, t: number): Buffer | null {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-i", file, "-ss", t.toFixed(3), "-frames:v", "1", "-q:v", "2", "-f", "image2", "pipe:1"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 && r.stdout.length > 0 ? r.stdout : null;
}

async function main() {
  const dir = process.argv[2] || "/clips/scripted";
  const doc = JSON.parse(readFileSync(join(dir, "clips.json"), "utf8"));
  const gates = Array.from(new Set(doc.clips.map((c: any) => (c.gate === "ENTRY" ? "entry" : "exit")))) as Array<"entry" | "exit">;
  const report: any[] = [];
  let failures = 0;
  for (const gateKey of gates) {
    const g = GATES[gateKey];
    for (const slot of Object.values(SLOT_TYPES)) {
      if (slot.faces.length === 0) continue;
      const file = join(dir, "slots", slotFile(gateKey, slot.id, 0));
      for (const [lane, key] of slot.faces.entries()) {
        const appear = APPEAR_AT_S + lane * STAGGER_S;
        const first = appear + firstUsableTau();
        for (const [label, t] of [["before", first - 0.4], ["at", first + 0.05], ["mid", first + 1.5]] as const) {
          const jpeg = frameAt(file, t);
          const faces = jpeg ? await extractFaces(jpeg) : [];
          const [cx, cy] = laneCentre(g, lane, t - appear);
          // The face of this lane is the detection nearest to the lane centre.
          const near = faces
            .map((f: any) => ({ f, d: Math.hypot((f.box[0] + f.box[2]) / 2 - cx, (f.box[1] + f.box[3]) / 2 - cy) }))
            .filter((x) => x.d < 200)
            .sort((a, b) => a.d - b.d)[0]?.f as any;
          const sizePx = near ? Math.round(Math.min(near.box[2] - near.box[0], near.box[3] - near.box[1])) : null;
          const row = { gate: g.gate, slot: slot.id, face: key, sample: label, t: Number(t.toFixed(2)), detected: Boolean(near), sizePx, clear: near ? near.clear : null, why: near?.unclearReason ?? null };
          report.push(row);
          if (label !== "before" && !near) failures += 1;
        }
      }
    }
  }
  const detectSize = process.env.FACE_DETECT_SIZE || "640";
  const outFile = join(dir, `verify-detect${detectSize}.json`);
  writeFileSync(outFile, JSON.stringify({ detectSize, failures, rows: report }, null, 1));
  for (const r of report) console.log(`VERIFY ${r.gate} ${r.slot} ${r.face} ${r.sample} t=${r.t} detected=${r.detected} size=${r.sizePx} clear=${r.clear} ${r.why ?? ""}`);
  console.log(`VERIFY failures=${failures} -> ${outFile}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(2);
});
