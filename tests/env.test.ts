import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { envNumber } from "../src/server/env";

describe("envNumber", () => {
  it("treats an empty or blank value as unset - compose passes unset variables as empty strings", () => {
    // Staging ran with FACE_STRANGER_MIN_QUALITY="" and the floor read as 0.
    assert.equal(envNumber("X", 0.25, { min: 0, max: 1 }, { X: "" }), 0.25);
    assert.equal(envNumber("X", 60, { min: 0, max: 86400, integer: true }, { X: "   " }), 60);
    assert.equal(envNumber("X", 7, {}, {}), 7);
  });

  it("uses a real value when it is valid", () => {
    assert.equal(envNumber("X", 0.25, { min: 0, max: 1 }, { X: "0.4" }), 0.4);
    assert.equal(envNumber("X", 0.25, { min: 0, max: 1 }, { X: "0" }), 0, "an explicit 0 still means 0");
  });

  it("falls back on garbage, out-of-range and non-integer values", () => {
    assert.equal(envNumber("X", 5, {}, { X: "abc" }), 5);
    assert.equal(envNumber("X", 5, { max: 10 }, { X: "11" }), 5);
    assert.equal(envNumber("X", 5, { integer: true }, { X: "2.5" }), 5);
  });
});
