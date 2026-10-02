/**
 * Sign-in attempt limiter (src/server/loginRateLimit.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SlidingWindowLimiter } from "../src/server/loginRateLimit";

describe("SlidingWindowLimiter", () => {
  it("allows `limit` attempts per window, then refuses with the wait until the oldest expires", () => {
    const l = new SlidingWindowLimiter(3, 60_000);
    assert.ok(l.hit("a", 0).allowed);
    assert.ok(l.hit("a", 10_000).allowed);
    assert.ok(l.hit("a", 20_000).allowed);
    const refused = l.hit("a", 30_000);
    assert.equal(refused.allowed, false);
    assert.equal(refused.retryAfterMs, 30_000);
    assert.ok(l.hit("b", 30_000).allowed, "keys are independent");
    assert.ok(l.hit("a", 60_001).allowed, "the first attempt left the window");
  });

  it("refused attempts do not extend the block", () => {
    const l = new SlidingWindowLimiter(1, 1000);
    l.hit("a", 0);
    for (let t = 100; t < 1000; t += 100) assert.equal(l.hit("a", t).allowed, false);
    assert.ok(l.hit("a", 1001).allowed);
  });

  it("stays memory-bounded", () => {
    const l = new SlidingWindowLimiter(5, 1000, 100);
    for (let i = 0; i < 500; i++) l.hit(`k${i}`, i);
    assert.ok(l.size <= 100);
  });
});
