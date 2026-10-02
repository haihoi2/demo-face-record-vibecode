/**
 * Sign-in attempt limits inside the app (owner 2026-10-02: "harden login").
 * The edge (eton8) already limits POST /api/operator/session per visitor; this
 * is the second layer, and the only one for LAN clients reaching :8080 directly.
 * Sliding window per key, memory-bounded. Pure: no timers, `now` passed in.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Counts one attempt for `key`. allowed=false (and nothing counted) once `limit` attempts are inside the window. */
  hit(key: string, now: number): { allowed: boolean; retryAfterMs: number } {
    const from = now - this.windowMs;
    const list = (this.hits.get(key) || []).filter((t) => t > from);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return { allowed: false, retryAfterMs: Math.max(1, list[0] + this.windowMs - now) };
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) this.prune(now);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Drops keys with no attempt inside the window; if still too many, the oldest keys. */
  prune(now: number): void {
    const from = now - this.windowMs;
    for (const [k, list] of this.hits) if (!list.some((t) => t > from)) this.hits.delete(k);
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}
