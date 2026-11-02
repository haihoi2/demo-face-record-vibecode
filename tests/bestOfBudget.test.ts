/** Extra "best-of" pictures only when an extraction worker is idle (src/server/bestOfBudget.ts, Taiga #506). */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { bestOfExtrasAllowed } from "../src/server/bestOfBudget";

const pool = (readyWorkers: number, busy: number, queued: number, extra: Partial<{ enabled: boolean; ready: boolean }> = {}) =>
  ({ enabled: true, ready: true, readyWorkers, busy, queued, ...extra });

describe("bestOfExtrasAllowed", () => {
  it("an idle pool keeps the configured extras", () => {
    assert.equal(bestOfExtrasAllowed(2, pool(2, 0, 0)), 2);
  });

  it("the other gate's frame in the pool leaves room for one", () => {
    assert.equal(bestOfExtrasAllowed(2, pool(2, 1, 0)), 1);
  });

  it("a full or queued pool gets none", () => {
    assert.equal(bestOfExtrasAllowed(2, pool(2, 2, 0)), 0);
    assert.equal(bestOfExtrasAllowed(2, pool(2, 1, 3)), 0);
  });

  it("pool off or still loading keeps the configured number (main-thread path, as before)", () => {
    assert.equal(bestOfExtrasAllowed(2, pool(0, 0, 0, { enabled: false })), 2);
    assert.equal(bestOfExtrasAllowed(2, pool(0, 0, 0, { ready: false })), 2);
    assert.equal(bestOfExtrasAllowed(2, null), 2);
  });

  it("never more than wanted, never negative", () => {
    assert.equal(bestOfExtrasAllowed(1, pool(4, 0, 0)), 1);
    assert.equal(bestOfExtrasAllowed(0, pool(4, 0, 0)), 0);
    assert.equal(bestOfExtrasAllowed(-3, pool(4, 0, 0)), 0);
    assert.equal(bestOfExtrasAllowed(NaN, pool(4, 0, 0)), 0);
  });
});
