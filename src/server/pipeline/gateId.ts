/**
 * Gate ids inside the real-time pipeline (N-gate wave, plan
 * docs/plans/2026-09-29-scale-and-accuracy.md section 11, "Pipeline").
 *
 * The pipeline's `Gate` is the configured gate id (src/server/gates.ts:
 * lowercase slug). Every boundary that accepts one (GatePipeline, the worker's
 * init message, StreamReader, FaceTracker, TrackDecider) REFUSES an invalid id
 * instead of coercing it to a default gate: a mislabelled stream must never be
 * decided on as if it were another gate. The direction (ENTRY/EXIT) is not a
 * pipeline concern; it travels beside the gate id in the server.
 */
import { isGateId } from "../gates";

export { isGateId };

/** Throws a TypeError naming `what` unless `value` is a gate id. */
export function assertGateId(value: unknown, what: string): string {
  if (!isGateId(value)) {
    const shown = typeof value === "string" ? JSON.stringify(value.slice(0, 40)) : typeof value;
    throw new TypeError(`${what}: invalid gate id ${shown}`);
  }
  return value;
}

/** Legacy prefixes, kept so logs and stored shadow results stay comparable. */
const LEGACY_TRACK_PREFIX: Readonly<Record<string, string>> = { entry: "E", exit: "X" };

/**
 * Track-id prefix of a gate: "E" for "entry" and "X" for "exit" (unchanged),
 * otherwise the id's first letter upper-cased plus 4 base-36 characters of a
 * hash of the whole id ("side-door" -> "S" + 4 chars). Readable, stable across
 * restarts, distinct from the legacy one-letter prefixes, and unique per gate
 * in practice (two of at most 16 gates share one only with p < 1e-4; the
 * outcome carries the gate id as well).
 */
export function trackIdPrefix(gateId: string): string {
  const id = assertGateId(gateId, "track id prefix");
  const legacy = LEGACY_TRACK_PREFIX[id];
  if (legacy) return legacy;
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  const tag = ((h >>> 0) % 36 ** 4).toString(36).padStart(4, "0");
  return `${id[0].toUpperCase()}${tag}`;
}
