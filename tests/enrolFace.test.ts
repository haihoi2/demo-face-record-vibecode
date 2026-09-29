/**
 * Enrolment from a stored stranger photo takes only the face the stranger group
 * was built from (src/server/enrolFace.ts), never another person in the frame.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { chooseEnrolFaces, ENROL_SOURCE_MIN_COSINE } from "../src/server/enrolFace";
import { templateRejectHint } from "../src/components/StrangerClusterModal";

function unit(seed: number, dims = 512): Float32Array {
  let x = seed * 9301 + 49297;
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) { x = (x * 9301 + 49297) % 233280; v[i] = x / 233280 - 0.5; }
  const n = Math.hypot(...v);
  return v.map((a) => a / n);
}
function near(base: Float32Array, noise: number, seed: number): Float32Array {
  const r = unit(seed);
  const v = base.map((a, i) => a + noise * r[i]);
  const n = Math.hypot(...v);
  return v.map((a) => a / n);
}
const face = (embedding: Float32Array, quality: number, name: string) => ({ embedding, quality, name });

describe("chooseEnrolFaces", () => {
  const stranger = unit(1);
  const colleague = unit(2);

  it("picks the face matching the log's embedding even when another face is sharper", () => {
    const faces = [face(colleague, 0.9, "colleague"), face(near(stranger, 0.3, 7), 0.4, "stranger")];
    const c = chooseEnrolFaces(faces, stranger);
    assert.ok(!("rejected" in c));
    assert.deepEqual(c.faces.map((f) => f.name), ["stranger"]);
    assert.ok((c.matchCosine ?? 0) >= ENROL_SOURCE_MIN_COSINE);
  });

  it("refuses when no face in the photo matches the log's embedding", () => {
    const c = chooseEnrolFaces([face(colleague, 0.9, "colleague")], stranger);
    assert.ok("rejected" in c && c.rejected === "face-mismatch");
  });

  it("without a stored embedding, refuses a photo with several faces", () => {
    const c = chooseEnrolFaces([face(colleague, 0.9, "a"), face(stranger, 0.5, "b")], undefined);
    assert.ok("rejected" in c && c.rejected === "multiple-faces");
  });

  it("without a stored embedding, a single-face photo enrols as before", () => {
    const c = chooseEnrolFaces([face(stranger, 0.5, "only")], null);
    assert.ok(!("rejected" in c));
    assert.equal(c.faces.length, 1);
  });

  it("an embedding of another size (other model) is ignored, not compared", () => {
    const c = chooseEnrolFaces([face(stranger, 0.5, "only")], new Float32Array(128).fill(0.1));
    assert.ok(!("rejected" in c));
    const two = chooseEnrolFaces([face(stranger, 0.5, "a"), face(colleague, 0.5, "b")], new Float32Array(128).fill(0.1));
    assert.ok("rejected" in two && two.rejected === "multiple-faces");
  });
});

describe("wiring", () => {
  it("both stranger enrolment routes pass the sighting's own embedding", () => {
    const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    assert.equal((src.match(/expectedEmbedding: sightingEmbedding\(sightingLog\)/g) || []).length, 2);
    assert.match(src, /const choice = chooseEnrolFaces\(found, opts\.expectedEmbedding\);/);
  });

  it("the operator is told why no template was made", () => {
    assert.match(templateRejectHint("multiple-faces"), /nhiều người/);
    assert.match(templateRejectHint("face-mismatch"), /Không tìm thấy đúng khuôn mặt/);
    assert.equal(templateRejectHint(null), "");
  });
});
