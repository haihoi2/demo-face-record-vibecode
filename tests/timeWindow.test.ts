/** 2026-10-23 hang: FPS windows must stay bounded and trim in one step. */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dropOlderThan, pushWithinWindow } from "../src/server/timeWindow";

describe("time windows", () => {
  it("drops exactly the expired entries", () => {
    const l = [1, 2, 3, 10, 11];
    dropOlderThan(l, 10);
    assert.deepEqual(l, [10, 11]);
    dropOlderThan(l, 0);
    assert.deepEqual(l, [10, 11]);
    dropOlderThan(l, 100);
    assert.deepEqual(l, []);
  });
  it("stays bounded however rarely it is read (11 days at 2 fps)", () => {
    const l: number[] = [];
    for (let t = 0; t < 11 * 86400 * 2; t++) pushWithinWindow(l, t * 500, 10_000);
    assert.ok(l.length <= 21, `length ${l.length}`);
  });
  it("trimming a million stale entries is instant (was quadratic with shift())", () => {
    const l = Array.from({ length: 1_000_000 }, (_, i) => i);
    const t0 = Date.now();
    dropOlderThan(l, 999_990);
    assert.equal(l.length, 10);
    assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
  });
  it("no FPS counter trims with shift() in a loop any more", () => {
    for (const f of ["src/server/presence/presenceHost.ts", "src/server/pipeline/streamReader.ts"]) {
      assert.doesNotMatch(readFileSync(f, "utf8"), /while \([^)]*\) this\.(processedAt|deliveries)\.shift\(\)/, f);
    }
  });
});
