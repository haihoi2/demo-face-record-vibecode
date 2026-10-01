/**
 * Stored-frame choice for unrecognised faces (src/server/bestFrame.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { pickSharpestObservation } from "../src/server/bestFrame";

describe("pickSharpestObservation", () => {
  it("prefers the strongest recogniser response over pixel quality (motion blur)", () => {
    // A smeared face can score full pixel quality; its feature strength is low.
    const obs = [
      { quality: 1.0, featureNorm: 19.1 },
      { quality: 0.8, featureNorm: 24.2 },
      { quality: 0.9, featureNorm: 21.5 },
    ];
    assert.equal(pickSharpestObservation(obs, true), 1);
  });

  it("falls back to quality when strength is not calibrated or missing", () => {
    const obs = [
      { quality: 0.6, featureNorm: 30 },
      { quality: 0.9, featureNorm: 20 },
    ];
    assert.equal(pickSharpestObservation(obs, false), 1);
    assert.equal(pickSharpestObservation([{ quality: 0.5 }, { quality: 0.7, featureNorm: 25 }], true), 1);
  });

  it("keeps the earlier observation on a tie and returns -1 for none", () => {
    assert.equal(pickSharpestObservation([{ quality: 0.5, featureNorm: 22 }, { quality: 0.9, featureNorm: 22 }], true), 0);
    assert.equal(pickSharpestObservation([], true), -1);
  });
});
