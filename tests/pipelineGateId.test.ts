/**
 * Gate ids in the real-time pipeline (N-gate wave): track-id prefixes derived
 * from the gate id and the boundary check every producer uses
 * (src/server/pipeline/gateId.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertGateId, trackIdPrefix } from "../src/server/pipeline/gateId";

describe("trackIdPrefix", () => {
  it("keeps E and X for the legacy gates, so logs stay comparable", () => {
    assert.equal(trackIdPrefix("entry"), "E");
    assert.equal(trackIdPrefix("exit"), "X");
  });

  it("derives a readable, stable prefix for any other gate id", () => {
    const p = trackIdPrefix("side-door");
    assert.match(p, /^S[0-9a-z]{4}$/);
    assert.equal(trackIdPrefix("side-door"), p, "stable across calls (and restarts)");
    assert.match(trackIdPrefix("garage"), /^G[0-9a-z]{4}$/);
    // A new gate never gets a legacy one-letter prefix, even one starting with e/x.
    assert.match(trackIdPrefix("east"), /^E[0-9a-z]{4}$/);
    assert.match(trackIdPrefix("exit-2"), /^E[0-9a-z]{4}$/);
    assert.match(trackIdPrefix("xray"), /^X[0-9a-z]{4}$/);
  });

  it("gives different gates different prefixes", () => {
    const ids = ["entry", "exit", "side-door", "side-door-2", "garage", "lobby", "east", "east-1", "west", "dock-a", "dock-b", "ab", "ba", "staff", "store", "roof"];
    const prefixes = ids.map(trackIdPrefix);
    assert.equal(new Set(prefixes).size, ids.length, JSON.stringify(prefixes));
  });

  it("refuses anything that is not a gate id", () => {
    for (const bad of ["ENTRY", "EXIT", "", "e", "Side", "side_door", "1st", undefined, null, 3]) {
      assert.throws(() => trackIdPrefix(bad as string), TypeError, String(bad));
    }
  });
});

describe("assertGateId", () => {
  it("returns a gate id unchanged and names the boundary when it refuses", () => {
    assert.equal(assertGateId("side-door", "x"), "side-door");
    assert.throws(() => assertGateId("ENTRY", "pipeline gate"), /pipeline gate: invalid gate id "ENTRY"/);
    assert.throws(() => assertGateId({ gate: "entry" }, "init"), /init: invalid gate id object/);
  });

  it("truncates a long refused value in the message", () => {
    let msg = "";
    try {
      assertGateId("A".repeat(500), "w");
    } catch (e) {
      msg = (e as Error).message;
    }
    assert.ok(msg.length < 80, msg);
  });
});
