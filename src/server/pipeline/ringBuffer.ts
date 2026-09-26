/**
 * Fixed-capacity ring buffer (step 1, STR). Pushing into a full buffer drops the
 * oldest entry, so memory stays bounded however fast a producer runs. The stream
 * reader keeps its last few frames here for the motion check; only the newest
 * one is ever handed to recognition.
 */
export class RingBuffer<T> {
  readonly capacity: number;
  private readonly items: Array<T | undefined>;
  private head = 0; // index of the next write
  private count = 0;

  constructor(capacity: number) {
    const cap = Number.isFinite(capacity) ? Math.floor(capacity) : 1;
    this.items = new Array(Math.max(1, cap));
    this.capacity = this.items.length;
  }

  get size(): number {
    return this.count;
  }

  /** Adds an item; returns the one it evicted, if any. */
  push(item: T): T | undefined {
    const evicted = this.count === this.capacity ? this.items[this.head] : undefined;
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
    return evicted;
  }

  /** The newest item, or undefined when empty. */
  newest(): T | undefined {
    return this.at(0);
  }

  /** `at(0)` is the newest, `at(1)` the one before it, ... */
  at(back: number): T | undefined {
    if (!Number.isInteger(back) || back < 0 || back >= this.count) return undefined;
    return this.items[(this.head - 1 - back + this.capacity * 2) % this.capacity];
  }

  /** Oldest first. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = this.count - 1; i >= 0; i -= 1) out.push(this.at(i) as T);
    return out;
  }

  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}
