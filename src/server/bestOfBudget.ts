/**
 * How many "sharpest of several" extra pictures a door scan may look at now
 * (Taiga #506, noon peak).
 *
 * The extras only run when the scan's own picture recognised nobody, and they
 * go to the off-thread extraction pool. At 12:00 both gates do this at once and
 * share the pool's workers, so one gate's extras queued behind the other's
 * frames: the median grant delay at the exit went from 2.5 s to 4.9 s. Extras
 * are worth a picture only when a worker is idle - while people are at the gate
 * the watcher scans again 0.3 s later with a fresh picture anyway.
 *
 * With the pool off or not ready (frames run on the main thread) nothing is
 * known about its load, so the configured number is kept, as before.
 */
export interface BestOfPoolState {
  enabled: boolean;
  ready: boolean;
  readyWorkers: number;
  busy: number;
  queued: number;
}

export function bestOfExtrasAllowed(wanted: number, pool: BestOfPoolState | null | undefined): number {
  const want = Math.max(0, Math.floor(Number.isFinite(wanted) ? wanted : 0));
  if (want === 0) return 0;
  if (!pool || !pool.enabled || !pool.ready) return want;
  const idle = Math.max(0, pool.readyWorkers - pool.busy - pool.queued);
  return Math.min(want, idle);
}
