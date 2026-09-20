/**
 * Unit tests for the on-device biometrics engine (src/utils/localBiometrics.ts).
 *
 * These cover the deterministic core of the local recognition path: embedding
 * generation, cosine matching, the anti-spoofing heuristic, and the branching
 * inside runLocalFaceRecognition (test hooks, targeted lookup, thresholds).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  generateFaceEmbedding,
  computeCosineSimilarity,
  evaluateAntiSpoofing,
  runLocalFaceRecognition,
} from "../src/utils/localBiometrics";
import { Employee } from "../src/types";

function makeEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: "EMP-0001",
    name: "Nguyễn Văn A",
    employeeCode: "NV-0001",
    department: "Phòng Kỹ Thuật",
    position: "Kỹ sư",
    photoUrl: "https://example.test/a.jpg",
    registeredAt: "2026-01-01T00:00:00.000Z",
    accessLevel: "ALL_ACCESS",
    ...overrides,
  };
}

const EMPLOYEES: Employee[] = [
  makeEmployee(),
  makeEmployee({
    id: "EMP-0002",
    name: "Trần Thị B",
    employeeCode: "NV-0002",
    photoUrl: "https://example.test/b.jpg",
  }),
  makeEmployee({
    id: "EMP-0003",
    name: "Lê Văn C",
    employeeCode: "NV-0003",
    photoUrl: "https://example.test/c.jpg",
  }),
];

const PROBE = "data:image/jpeg;base64," + "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo".repeat(40);

function l2Norm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
}

describe("generateFaceEmbedding", () => {
  it("is deterministic for the same seed", () => {
    assert.deepEqual(generateFaceEmbedding("seed-a"), generateFaceEmbedding("seed-a"));
  });

  it("defaults to 128 dimensions and honours an explicit dimension", () => {
    assert.equal(generateFaceEmbedding("seed-a").length, 128);
    assert.equal(generateFaceEmbedding("seed-a", 512).length, 512);
  });

  it("returns an L2-normalized unit vector", () => {
    const norm = l2Norm(generateFaceEmbedding("seed-a"));
    assert.ok(Math.abs(norm - 1) < 1e-9, `expected unit norm, got ${norm}`);
  });

  it("produces different embeddings for different seeds", () => {
    assert.notDeepEqual(generateFaceEmbedding("seed-a"), generateFaceEmbedding("seed-b"));
  });

  it("handles an empty seed without producing NaN", () => {
    const vector = generateFaceEmbedding("");
    assert.equal(vector.length, 128);
    assert.ok(vector.every((v) => Number.isFinite(v)));
  });
});

describe("computeCosineSimilarity", () => {
  it("returns 1 for a vector compared against itself", () => {
    const vector = generateFaceEmbedding("seed-a");
    assert.ok(Math.abs(computeCosineSimilarity(vector, vector) - 1) < 1e-9);
  });

  it("returns -1 for exactly opposed unit vectors", () => {
    const vector = generateFaceEmbedding("seed-a");
    const opposed = vector.map((v) => -v);
    assert.ok(Math.abs(computeCosineSimilarity(vector, opposed) + 1) < 1e-9);
  });

  it("returns 0 for orthogonal vectors", () => {
    assert.equal(computeCosineSimilarity([1, 0], [0, 1]), 0);
  });

  it("returns 0 when lengths differ or inputs are empty", () => {
    assert.equal(computeCosineSimilarity([1, 0, 0], [1, 0]), 0);
    assert.equal(computeCosineSimilarity([], []), 0);
  });

  it("clamps the result into [-1, 1] for non-normalized input", () => {
    assert.equal(computeCosineSimilarity([10, 10], [10, 10]), 1);
    assert.equal(computeCosineSimilarity([-10, -10], [10, 10]), -1);
  });
});

describe("evaluateAntiSpoofing", () => {
  it("is deterministic for the same image and sensitivity", () => {
    assert.deepEqual(evaluateAntiSpoofing(PROBE, "HIGH"), evaluateAntiSpoofing(PROBE, "HIGH"));
  });

  it("scores liveness inside the documented 94-100 band, rounded to one decimal", () => {
    const { livenessScore } = evaluateAntiSpoofing(PROBE);
    assert.ok(livenessScore >= 94 && livenessScore <= 100, `out of band: ${livenessScore}`);
    assert.equal(Math.round(livenessScore * 10), livenessScore * 10);
  });

  it("passes at every sensitivity, since the score floor (94) clears the strictest threshold (92)", () => {
    for (const sensitivity of ["LOW", "MEDIUM", "HIGH"] as const) {
      assert.equal(evaluateAntiSpoofing(PROBE, sensitivity).passed, true);
    }
  });

  it("handles an empty image string", () => {
    const { livenessScore, passed } = evaluateAntiSpoofing("");
    assert.equal(livenessScore, 94);
    assert.equal(passed, true);
  });
});

describe("runLocalFaceRecognition", () => {
  it("reports an unrecognized stranger for the UNKNOWN test hook", () => {
    for (const hook of ["UNKNOWN", "UNKNOWN_VISITOR"]) {
      const result = runLocalFaceRecognition({
        imageBase64: PROBE,
        employees: EMPLOYEES,
        testEmployeeId: hook,
      });

      assert.equal(result.recognized, false);
      assert.equal(result.bestMatch, undefined);
      assert.equal(result.overallConfidence, 34.2);
      assert.equal(result.cosineSimilarity, 0.38);
      assert.equal(result.detectedFaces.length, 1);
      assert.equal(result.detectedFaces[0].recognized, false);
      assert.equal(result.detectedFaces[0].employeeId, undefined);
    }
  });

  it("returns two recognized faces for the MULTI test hooks", () => {
    for (const hook of ["MULTI_EMPLOYEES", "MULTI_MIXED"]) {
      const result = runLocalFaceRecognition({
        imageBase64: PROBE,
        employees: EMPLOYEES,
        testEmployeeId: hook,
      });

      assert.equal(result.recognized, true);
      assert.equal(result.detectedFaces.length, 2);
      assert.equal(result.bestMatch?.id, EMPLOYEES[0].id);
      assert.equal(result.detectedFaces[0].employeeId, EMPLOYEES[0].id);
      assert.equal(result.detectedFaces[1].employeeId, EMPLOYEES[1].id);
      // Confidence is ranked, highest first.
      assert.ok(result.detectedFaces[0].confidence > result.detectedFaces[1].confidence);
    }
  });

  it("resolves a targeted employee by id", () => {
    const result = runLocalFaceRecognition({
      imageBase64: PROBE,
      employees: EMPLOYEES,
      testEmployeeId: "EMP-0002",
    });

    assert.equal(result.recognized, true);
    assert.equal(result.bestMatch?.id, "EMP-0002");
  });

  it("resolves a targeted employee by employeeCode, case-insensitively", () => {
    const result = runLocalFaceRecognition({
      imageBase64: PROBE,
      employees: EMPLOYEES,
      testEmployeeId: "nv-0003",
    });

    assert.equal(result.recognized, true);
    assert.equal(result.bestMatch?.id, "EMP-0003");
  });

  it("does NOT recognize an arbitrary image against a non-empty roster when no test hook is supplied", () => {
    // The hash-based "embeddings" cannot really match a camera frame; a fabricated match
    // here (the old employees[0] fallback) was a door-unlock bypass.
    const result = runLocalFaceRecognition({ imageBase64: PROBE, employees: EMPLOYEES });

    assert.equal(result.recognized, false);
    assert.equal(result.bestMatch, undefined);
    assert.equal(result.detectedFaces.length, 1);
    assert.equal(result.detectedFaces[0].recognized, false);
    assert.equal(result.detectedFaces[0].employeeId, undefined);
    assert.ok(result.cosineSimilarity < 0.72, `unexpected high similarity ${result.cosineSimilarity}`);
  });

  it("reports the real best cosine similarity with no artificial floor", () => {
    const probeVector = generateFaceEmbedding(PROBE.slice(0, 640));
    const realBest = Math.max(
      ...EMPLOYEES.map((emp) =>
        computeCosineSimilarity(probeVector, generateFaceEmbedding(emp.photoUrl || emp.id))
      )
    );

    const result = runLocalFaceRecognition({ imageBase64: PROBE, employees: EMPLOYEES });

    assert.equal(result.cosineSimilarity, realBest);
    assert.ok(result.cosineSimilarity < 0.74, "the old 0.82 + sin floor (>= 0.74) must be gone");
    assert.equal(
      result.overallConfidence,
      Math.max(0, Math.round(result.cosineSimilarity * 1000) / 10)
    );
    // Stable across calls: no Date.now()-dependent jitter in the score.
    const again = runLocalFaceRecognition({ imageBase64: PROBE, employees: EMPLOYEES });
    assert.equal(again.cosineSimilarity, result.cosineSimilarity);
  });

  it("respects similarityThreshold: grants only when the real similarity meets it", () => {
    const probeVector = generateFaceEmbedding(PROBE.slice(0, 640));
    const sims = EMPLOYEES.map((emp) =>
      computeCosineSimilarity(probeVector, generateFaceEmbedding(emp.photoUrl || emp.id))
    );
    const realBest = Math.max(...sims);
    const expectedEmployee = EMPLOYEES[sims.indexOf(realBest)];

    // Threshold just above the real best similarity -> denied.
    const denied = runLocalFaceRecognition({
      imageBase64: PROBE,
      employees: EMPLOYEES,
      similarityThreshold: realBest + 1e-6,
    });
    assert.equal(denied.recognized, false);
    assert.equal(denied.bestMatch, undefined);
    assert.equal(denied.cosineSimilarity, realBest);

    // Threshold at (or below) the real best similarity -> the genuine top match is granted.
    const granted = runLocalFaceRecognition({
      imageBase64: PROBE,
      employees: EMPLOYEES,
      similarityThreshold: realBest,
    });
    assert.equal(granted.recognized, true);
    assert.equal(granted.bestMatch?.id, expectedEmployee.id);
    assert.equal(granted.cosineSimilarity, realBest);
  });

  it("does not grant an unresolvable targeted hook via a fallback", () => {
    const result = runLocalFaceRecognition({
      imageBase64: PROBE,
      employees: EMPLOYEES,
      testEmployeeId: "EMP-DOES-NOT-EXIST",
    });

    assert.equal(result.recognized, false);
    assert.equal(result.bestMatch, undefined);
  });

  it("does not recognize anyone when the roster is empty", () => {
    const result = runLocalFaceRecognition({ imageBase64: PROBE, employees: [] });

    assert.equal(result.recognized, false);
    assert.equal(result.bestMatch, undefined);
    assert.equal(result.detectedFaces.length, 1);
    assert.equal(result.detectedFaces[0].recognized, false);
  });

  it("rejects the match when the similarity threshold is unreachable", () => {
    const result = runLocalFaceRecognition({
      imageBase64: PROBE,
      employees: EMPLOYEES,
      similarityThreshold: 1.01,
    });

    assert.equal(result.recognized, false);
    assert.equal(result.bestMatch, undefined);
    assert.equal(result.detectedFaces[0].employeeId, undefined);
  });

  it("names the model per requested architecture", () => {
    const cases = [
      ["blazeface-arcface-sota", "BlazeFace V2 + ArcFace SOTA (512-D Deep Metric)"],
      ["mediapipe-facemesh-dense", "MediaPipe FaceMesh (468 3D Dense Landmarks)"],
      ["mobilefacenet-quantized", "MobileFaceNet Edge Quantized INT8"],
    ] as const;

    for (const [architecture, expected] of cases) {
      const result = runLocalFaceRecognition({
        imageBase64: PROBE,
        employees: EMPLOYEES,
        modelArchitecture: architecture,
      });
      assert.equal(result.modelName, expected);
    }
  });

  it("reports a non-negative processing time and a 4-element bounding box", () => {
    const result = runLocalFaceRecognition({ imageBase64: PROBE, employees: EMPLOYEES });

    assert.ok(result.processingTimeMs >= 0);
    assert.equal(result.detectedFaces[0].box2d.length, 4);
  });
});
