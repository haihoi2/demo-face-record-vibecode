/**
 * Sliding time windows of timestamps (FPS counters). 2026-10-23: the presence
 * host only trimmed its list when someone asked for its stats, and trimmed it
 * with one Array.shift() per expired entry. After 11 days without a stats call
 * the list held over a million timestamps, and the first call (opening the
 * Presence panel) shifted them one by one - quadratic - and held the main
 * thread until every request timed out (Cloudflare 524).
 *
 * Now: trim on every push, and drop all expired entries with ONE splice.
 */

/** Removes every entry older than `cutoff` (the list is in time order). O(log n) search + one splice. */
export function dropOlderThan(list: number[], cutoff: number): void {
  if (!list.length || list[0] >= cutoff) return;
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid] < cutoff) lo = mid + 1; else hi = mid;
  }
  list.splice(0, lo);
}

/** Records `now` and keeps only the last `windowMs` (bounded however rarely the list is read). */
export function pushWithinWindow(list: number[], now: number, windowMs: number): void {
  list.push(now);
  dropOlderThan(list, now - windowMs);
}
