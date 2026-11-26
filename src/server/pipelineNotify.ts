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
