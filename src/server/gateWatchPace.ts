/**
 * How long a gate watcher waits before its next scan (Taiga #506, lunch peak).
 *
 * The configured interval is the GAP between two scans, used while the gate is
 * empty. While people are at the gate - the last scan saw a face, within
 * `busyHoldMs` - the next scan starts after `busyGapMs` instead, so a queue at
 * 12:00 is scanned back to back rather than one scan per interval. Errors keep
 * their backoff (gap doubled per consecutive error, capped) whatever was seen.
 *
 * Repeated decisions on the same person are not a concern here: the per-gate
 * grant cooldown and the per-person stranger cooldown already absorb them.
 */
export interface GateWatchPaceInput {
  intervalMs: number;
  consecutiveErrors: number;
  /** When a scan of this gate last saw at least one face (ms epoch), if ever. */
  lastFacesAtMs?: number;
  nowMs: number;
  busyGapMs: number;
  busyHoldMs: number;
  maxBackoffMs: number;
}

export type GateWatchPace = "busy" | "idle" | "backoff";

export function gateWatchPace(p: GateWatchPaceInput): { delayMs: number; pace: GateWatchPace } {
  const base = Math.max(0, p.intervalMs);
  if (p.consecutiveErrors > 0) {
    const factor = Math.pow(2, Math.min(p.consecutiveErrors, 16));
    return { delayMs: Math.min(p.maxBackoffMs, Math.round(base * factor)), pace: "backoff" };
  }
  const busy =
    p.busyHoldMs > 0 &&
    typeof p.lastFacesAtMs === "number" &&
    Number.isFinite(p.lastFacesAtMs) &&
    p.nowMs - p.lastFacesAtMs >= 0 &&
    p.nowMs - p.lastFacesAtMs <= p.busyHoldMs;
  if (busy && p.busyGapMs < base) return { delayMs: Math.max(0, p.busyGapMs), pace: "busy" };
  return { delayMs: base, pace: "idle" };
}
