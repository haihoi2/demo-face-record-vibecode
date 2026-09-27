import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RingBuffer } from "../src/server/pipeline/ringBuffer";

describe("RingBuffer", () => {
  it("is empty at first", () => {
    const ring = new RingBuffer<number>(3);
    assert.equal(ring.size, 0);
    assert.equal(ring.newest(), undefined);
    assert.deepEqual(ring.toArray(), []);
  });

  it("keeps only the last `capacity` items, newest first by at()", () => {
    const ring = new RingBuffer<number>(3);
    assert.equal(ring.push(1), undefined);
    ring.push(2);
    ring.push(3);
    assert.equal(ring.push(4), 1, "pushing into a full ring evicts the oldest");
    assert.equal(ring.size, 3);
    assert.equal(ring.newest(), 4);
    assert.equal(ring.at(1), 3);
    assert.equal(ring.at(2), 2);
    assert.equal(ring.at(3), undefined);
    assert.equal(ring.at(-1), undefined);
    assert.deepEqual(ring.toArray(), [2, 3, 4]);
  });

  it("stays bounded over many pushes", () => {
    const ring = new RingBuffer<number>(4);
    for (let i = 0; i < 1000; i += 1) ring.push(i);
    assert.deepEqual(ring.toArray(), [996, 997, 998, 999]);
  });

  it("clears", () => {
    const ring = new RingBuffer<string>(2);
    ring.push("a");
    ring.push("b");
    ring.clear();
    assert.equal(ring.size, 0);
    assert.equal(ring.newest(), undefined);
    ring.push("c");
    assert.deepEqual(ring.toArray(), ["c"]);
  });

  it("treats a nonsense capacity as 1", () => {
    for (const cap of [0, -3, Number.NaN]) {
      const ring = new RingBuffer<number>(cap);
      assert.equal(ring.capacity, 1);
      ring.push(1);
      ring.push(2);
      assert.deepEqual(ring.toArray(), [2]);
    }
  });
});
