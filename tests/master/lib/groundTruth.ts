/**
 * Ground truth of the MT replay clips (tests/master/clips.schema.json).
 *
 * The real file lives next to the clips in /data/test-clips/clips.json (0700,
 * never committed: it names employees). The repository only carries the
 * schema and a synthetic example (tests/master/clips.example.json).
 *
 * Pure code: no I/O besides `loadGroundTruth`, so the validator is unit-tested.
 */
import { readFileSync } from "node:fs";

export type Gate = "ENTRY" | "EXIT";

/** How far a label can be trusted. */
export type LabelQuality =
  /** Known by construction (scripted clip rendered from a schedule). */
  | "exact"
  /** Checked by a person or by an independent detector run. */
  | "verified"
  /** Bootstrapped from the legacy access log only; the legacy system may have been wrong. */
  | "weak";

export type Who =
  | "stranger"
  | { employeeId: string }
  /** Scripted clips: an identity the test run enrols itself (see faces.json), mapped at run time. */
  | { fixture: string };

export interface PersonTruth {
  /** Stable label within the passage ("A", "B", "p1"...). */
  label: string;
  who: Who;
  /** Seconds from the clip start at which this face is first >= 60 px and clear. */
  firstUsableS: number | null;
  /** Seconds from the clip start after which it is no longer usable. */
  lastUsableS?: number | null;
  /** Expected decision under the access policy. */
  expected: "GRANTED" | "DENIED";
  labelQuality: LabelQuality;
  /** Photo held up to the camera, printed face, screen: must never be GRANTED. */
  impostor?: boolean;
}

export interface PassageTruth {
  id: string;
  /** Seconds from the clip start. */
  startS: number;
  endS: number;
  people: PersonTruth[];
  /** Free tags: "day", "evening", "crossing", "occlusion", "empty"... */
  tags?: string[];
}

export interface ClipTruth {
  id: string;
  /** File name relative to the clips directory. */
  file: string;
  gate: Gate;
  source: "nvr" | "scripted";
  /** NVR clips: the UTC time the clip starts at (ISO). */
  recordedStartUtc?: string;
  /** NVR clips: channel it was exported from (2201 entry, 501 exit). */
  nvrChannel?: string;
  durationS: number;
  fps: number;
  /** Keyframe interval in frames. */
  gop?: number;
  width: number;
  height: number;
  codec: string;
  passages: PassageTruth[];
}

export interface GroundTruth {
  schemaVersion: 1;
  createdAt: string;
  /** Date after which the real clips must be deleted (owner decision: 30 days). */
  deleteAfter: string;
  clips: ClipTruth[];
  /** Scripted clips: identities to enrol before the run (paths are local, never committed). */
  fixtures?: Record<string, { enrolImage: string; role: "employee" | "stranger" }>;
}

const GATES = new Set(["ENTRY", "EXIT"]);
const QUALITIES = new Set(["exact", "verified", "weak"]);

function isWho(v: unknown): v is Who {
  if (v === "stranger") return true;
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (typeof o.employeeId === "string" && o.employeeId.length > 0) || (typeof o.fixture === "string" && o.fixture.length > 0);
}

/** Returns a list of problems; empty means valid. */
export function validateGroundTruth(doc: unknown): string[] {
  const errors: string[] = [];
  const d = doc as GroundTruth;
  if (!d || typeof d !== "object") return ["document is not an object"];
  if (d.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!d.deleteAfter || Number.isNaN(Date.parse(d.deleteAfter))) errors.push("deleteAfter must be an ISO date");
  if (!Array.isArray(d.clips)) return [...errors, "clips must be an array"];
  const clipIds = new Set<string>();
  for (const [i, c] of d.clips.entries()) {
    const at = `clips[${i}]`;
    if (!c.id || clipIds.has(c.id)) errors.push(`${at}.id missing or duplicate`);
    clipIds.add(c.id);
    if (!c.file || /(^\/|\.\.)/.test(c.file)) errors.push(`${at}.file must be a relative name inside the clips directory`);
    if (/rtsp:\/\/|@/.test(JSON.stringify(c))) errors.push(`${at} must not contain URLs or logins`);
    if (!GATES.has(c.gate)) errors.push(`${at}.gate must be ENTRY or EXIT`);
    if (c.source !== "nvr" && c.source !== "scripted") errors.push(`${at}.source must be nvr or scripted`);
    if (!(c.durationS > 0)) errors.push(`${at}.durationS must be > 0`);
    if (!(c.fps > 0)) errors.push(`${at}.fps must be > 0`);
    if (!Array.isArray(c.passages)) {
      errors.push(`${at}.passages must be an array`);
      continue;
    }
    let prevEnd = -Infinity;
    for (const [j, p] of c.passages.entries()) {
      const pat = `${at}.passages[${j}]`;
      if (!(p.startS >= 0) || !(p.endS > p.startS) || p.endS > c.durationS + 0.001) errors.push(`${pat} has an invalid time span`);
      if (p.startS < prevEnd - 0.001) errors.push(`${pat} overlaps the previous passage`);
      prevEnd = p.endS;
      if (!Array.isArray(p.people)) {
        errors.push(`${pat}.people must be an array`);
        continue;
      }
      const labels = new Set<string>();
      for (const [k, person] of p.people.entries()) {
        const ppat = `${pat}.people[${k}]`;
        if (!person.label || labels.has(person.label)) errors.push(`${ppat}.label missing or duplicate`);
        labels.add(person.label);
        if (!isWho(person.who)) errors.push(`${ppat}.who must be "stranger", {employeeId} or {fixture}`);
        if (!QUALITIES.has(person.labelQuality)) errors.push(`${ppat}.labelQuality must be exact|verified|weak`);
        if (person.expected !== "GRANTED" && person.expected !== "DENIED") errors.push(`${ppat}.expected must be GRANTED or DENIED`);
        if (person.who === "stranger" && person.expected === "GRANTED") errors.push(`${ppat}: a stranger cannot be expected GRANTED`);
        if (person.impostor && person.expected === "GRANTED") errors.push(`${ppat}: an impostor cannot be expected GRANTED`);
        if (person.firstUsableS !== null && person.firstUsableS !== undefined) {
          if (!(person.firstUsableS >= p.startS - 0.001 && person.firstUsableS <= p.endS + 0.001)) {
            errors.push(`${ppat}.firstUsableS must lie inside the passage`);
          }
        }
      }
    }
  }
  return errors;
}

export function loadGroundTruth(path: string): GroundTruth {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const errors = validateGroundTruth(doc);
  if (errors.length) throw new Error(`invalid ground truth ${path}:\n  ${errors.join("\n  ")}`);
  return doc as GroundTruth;
}

export function whoKey(who: Who): string {
  if (who === "stranger") return "stranger";
  return "employeeId" in who ? `employee:${who.employeeId}` : `fixture:${who.fixture}`;
}
