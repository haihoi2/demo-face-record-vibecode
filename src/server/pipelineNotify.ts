/**
 * Chat messages from the real-time pipeline (plan step 3, #523, owner "go 3" 2026-11-26).
 *
 * A gate named in PIPELINE_NOTIFY_GATES lets its real-time pipeline post the
 * same chat message the door scan posts ("[[CỔNG RA]] Tên (Mã) - giờ") when it
 * recognises an employee. It is a MESSAGE only: no door command, no access-log
 * row, no image. The door scan keeps running and still records and acts.
 *
 * Both paths can see the same passage (the pipeline usually first, the door
 * scan a few seconds later), so every chat message for a gate in the list goes
 * through one claim per gate and employee: the first claim inside
 * PIPELINE_NOTIFY_DEDUPE_SECONDS sends, later ones are skipped. A gate that is
 * not in the list is not touched at all: its door scan sends as before.
 *
 * Pure: no I/O, the caller passes the clock.
 */

import { isGateId } from "./gates";

export const DEFAULT_NOTIFY_DEDUPE_SECONDS = 60;

/**
 * Gate ids from PIPELINE_NOTIFY_GATES: comma or space separated, lower-cased,
 * anything that is not a gate id is ignored (and reported back so the caller
 * can log it). Blank = no gate.
 */
export function parseNotifyGates(raw: unknown): { gates: Set<string>; ignored: string[] } {
  const gates = new Set<string>();
  const ignored: string[] = [];
  for (const part of String(raw ?? "").split(/[\s,]+/)) {
    const id = part.trim().toLowerCase();
    if (!id) continue;
    if (isGateId(id)) gates.add(id);
    else ignored.push(part.trim().slice(0, 40));
  }
  return { gates, ignored };
}

/** PIPELINE_NOTIFY_DEDUPE_SECONDS: whole seconds 1..3600, default 60. */
export function notifyDedupeSeconds(raw: unknown): number {
  const s = String(raw ?? "").trim();
  if (!/^\d+$/.test(s)) return DEFAULT_NOTIFY_DEDUPE_SECONDS;
  const n = Number(s);
  return n >= 1 && n <= 3600 ? n : DEFAULT_NOTIFY_DEDUPE_SECONDS;
}

export type NoticeSource = "pipeline" | "door-scan";

export interface NoticeClaim {
  send: boolean;
  /** Set when skipped: who sent the message this one duplicates, and how long ago. */
  duplicateOf?: { source: NoticeSource; agoMs: number };
}

/**
 * One chat message per gate and employee per window. claim() is synchronous,
 * so two paths that decide in the same tick cannot both send.
 */
export class GateNoticeDedupe {
  private readonly last = new Map<string, { atMs: number; source: NoticeSource }>();

  constructor(private readonly windowMs: number) {}

  claim(gate: string, employeeId: string, source: NoticeSource, nowMs: number): NoticeClaim {
    const key = `${gate}\u0000${employeeId}`;
    const prev = this.last.get(key);
    if (prev && nowMs - prev.atMs >= 0 && nowMs - prev.atMs < this.windowMs) {
      return { send: false, duplicateOf: { source: prev.source, agoMs: nowMs - prev.atMs } };
    }
    this.last.set(key, { atMs: nowMs, source });
    if (this.last.size > 2000) this.prune(nowMs);
    return { send: true };
  }

  /** Drops entries older than the window (bounded memory on a busy gate). */
  prune(nowMs: number): void {
    for (const [k, v] of this.last) if (nowMs - v.atMs >= this.windowMs) this.last.delete(k);
  }

  get size(): number {
    return this.last.size;
  }
}

// ---------------------------------------------------------------------------
// Attendance rows for passages only the pipeline saw (#523, owner choice A)
// ---------------------------------------------------------------------------

/** The fields of an access-log row the duplicate check reads. */
export interface GrantRowLike {
  id: string;
  timestamp: string;
  /** When the passage was seen; a pipeline row is written one pairing window after it. */
  capturedAt?: string;
  status: string;
  employeeId?: string;
}

/**
 * Id of the newest GRANTED row (door scan or pipeline) of `employeeId` at
 * `gate` whose passage (capturedAt, else its write time) is at or after
 * `sinceMs`, else null. Comparing passage times keeps one row per message:
 * the message window runs from the decision, not from the delayed write. `logs` is newest first (the
 * server's in-memory recent log); the scan stops at the first older row and
 * after `scanLimit` rows. `gateOf` resolves a row's gate (legacy rows have none).
 */
export function recentGrantRowId<T extends GrantRowLike>(
  logs: readonly T[],
  gate: string,
  employeeId: string,
  sinceMs: number,
  gateOf: (log: T) => string,
  scanLimit = 500
): string | null {
  for (let i = 0; i < logs.length && i < scanLimit; i++) {
    const log = logs[i];
    const written = Date.parse(log.timestamp);
    // capturedAt <= timestamp, so a row written before the window cannot match: stop there.
    if (Number.isFinite(written) && written < sinceMs) break;
    const seen = log.capturedAt ? Date.parse(log.capturedAt) : written;
    if (Number.isFinite(seen) && seen < sinceMs) continue;
    if (log.status === "GRANTED" && log.employeeId === employeeId && gateOf(log) === gate) return log.id;
  }
  return null;
}

/** Match percentage shown on an access-log row, the door scan's scale: (cosine - 0.35) / 0.65, 0..100. */
export function pipelineConfidencePct(fusedCosine: unknown): number {
  const c = Number(fusedCosine);
  if (fusedCosine === null || fusedCosine === undefined || !Number.isFinite(c)) return 0;
  return Math.round(Math.max(0, Math.min(1, (c - 0.35) / 0.65)) * 100);
}
