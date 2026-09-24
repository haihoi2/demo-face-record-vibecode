/**
 * Real face engine (SCRFD detector + ArcFace recogniser) over HTTP.
 *
 * Covers the wiring added in `server.ts`: the engine-status endpoint, the
 * face-template gallery CRUD, enrolment's rejection reasons, the fused
 * multi-stream `scan-rtsp` decision, and the invariant that matters most -
 * a recognition failure leaves the door LOCKED.
 *
 * The plain tester image deliberately ships WITHOUT the ONNX models, so every
 * assertion that needs a loaded model is gated on
 * `GET /api/face-engine/status -> ready === true` and skipped otherwise. The
 * whole suite therefore passes on the model-less image, and grows teeth on an
 * image built with models (`docker build --target runner`).
 *
 * `node --test` runs the integration FILES IN PARALLEL, and
 * `strangers.test.ts` asserts that the roster is byte-identical across its own
 * lifetime. So this file never adds or removes an employee on the default
 * path (the create -> enrol -> list -> delete cycle is model-gated, i.e. only
 * runs on a model-bearing image where this suite is run on its own), and never
 * rewrites the camera config: the scan tests use the single-stream `url` form,
 * which needs no configuration at all. It leaves the gateway exactly as it
 * found it.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  api,
  authenticateAs,
  postJson,
  rawApi,
  listEmployees,
  createTempEmployee,
  deleteEmployee,
  noFaceJpegDataUrl,
  getLockState,
  lockDoor,
  recognize,
  uniqueTestCode,
  type Employee,
} from "./helpers";

interface EngineStatus {
  success: boolean;
  engine: "onnx" | "hash" | "unavailable";
  requestedEngine: "auto" | "onnx" | "hash";
  ready: boolean;
  failClosed: boolean;
  info: Record<string, unknown>;
  templates: { total: number; byEmployee: Record<string, number>; modelTag: string };
  thresholds: {
    acceptSingle: number;
    minEvidence: number;
    acceptFused: number;
    minAgreeing: number;
    minMargin: number;
  };
  limits: Record<string, number>;
}

interface TemplateSummary {
  id: string;
  quality: number;
  source: string;
  capturedAt: string;
  streamId?: string;
  dims: number;
  modelTag: string;
}

interface TemplateList {
  success: boolean;
  employeeId: string;
  modelTag: string;
  count: number;
  max: number;
  templates: TemplateSummary[];
}

/** An RTSP URL that refuses instantly - no test may depend on a real camera. */
const UNREACHABLE = (suffix: string) => `rtsp://127.0.0.1:1/${suffix}`;

let status: EngineStatus;
/** An employee that already exists on the roster, or an isolated fixture when production starts empty. */
let existing: Employee;
let fixtureEmployeeId: string | null = null;

function templatesOf(employeeId: string) {
  return api<TemplateList>(`/api/employees/${encodeURIComponent(employeeId)}/templates`);
}

const engineReady = () => status.ready && status.engine === "onnx";

before(async () => {
  const res = await api<EngineStatus>("/api/face-engine/status");
  assert.equal(res.status, 200, res.text.slice(0, 300));
  status = res.body;
  let roster = await listEmployees();
  if (roster.length === 0) {
    const fixture = await createTempEmployee({ name: "Face Engine Fixture" });
    fixtureEmployeeId = fixture.id;
    roster = [fixture];
  }
  existing = roster[0];
});

after(async () => {
  if (fixtureEmployeeId) await deleteEmployee(fixtureEmployeeId);
});

describe("GET /api/face-engine/status", () => {
  it("reports the active engine, readiness, the gallery and the thresholds", () => {
    const body = status;
    assert.equal(body.success, true);
    assert.ok(
      ["onnx", "hash", "unavailable"].includes(body.engine),
      `unexpected engine ${JSON.stringify(body.engine)}`
    );
    assert.equal(typeof body.ready, "boolean");
    assert.ok(["auto", "onnx", "hash"].includes(body.requestedEngine));

    // Engine info snapshot (never throws, never triggers a model load).
    assert.equal(typeof body.info, "object");
    assert.equal(typeof (body.info as any).modelDir, "string");
    assert.equal(typeof (body.info as any).embeddingDim, "number");
    assert.equal((body.info as any).ready, body.ready);

    // Gallery summary.
    assert.equal(typeof body.templates.total, "number");
    assert.ok(body.templates.total >= 0);
    assert.equal(typeof body.templates.modelTag, "string");
    assert.ok(body.templates.modelTag.length > 0);
    assert.equal(typeof body.templates.byEmployee, "object");

    // Fusion operating points, all in [0, 1] plus an integer agreement count.
    for (const key of ["acceptSingle", "minEvidence", "acceptFused", "minMargin"] as const) {
      assert.equal(typeof body.thresholds[key], "number", `${key} must be numeric`);
      assert.ok(body.thresholds[key] >= 0 && body.thresholds[key] <= 1, `${key} out of range`);
    }
    assert.ok(Number.isInteger(body.thresholds.minAgreeing) && body.thresholds.minAgreeing >= 1);

    // Published caps, so an operator can reason about latency.
    assert.ok(body.limits.maxObservationsPerDecision >= 1);
    assert.ok(body.limits.maxFramesPerStream >= 1 && body.limits.maxFramesPerStream <= 5);
    assert.ok(body.limits.templatesPerEmployee >= 1);
    assert.ok(body.limits.enrollMinQuality >= 0 && body.limits.enrollMinQuality <= 1);
  });

  it("only claims engine 'onnx' when the models are actually loaded", () => {
    if (status.engine === "onnx") {
      assert.equal(status.ready, true, "engine 'onnx' must imply ready:true");
      assert.equal(status.failClosed, false);
    } else {
      assert.equal(status.ready, false, "only a loaded model set may report ready:true");
    }
    // FACE_ENGINE=onnx with missing models must fail closed, never fall back.
    if (status.requestedEngine === "onnx" && !status.ready) {
      assert.equal(status.engine, "unavailable");
      assert.equal(status.failClosed, true);
    }
  });
});

describe("face template gallery", () => {
  it("requires viewer auth for reads and operator auth for enrollment mutations", async () => {
    assert.equal((await rawApi(`/api/employees/${encodeURIComponent(existing.id)}/templates`)).status, 401);
    const viewerCookie = await authenticateAs(process.env.VIEWER_TOKEN || "integration-viewer-token");
    const list = await rawApi(`/api/employees/${encodeURIComponent(existing.id)}/templates`, {
      headers: { Cookie: viewerCookie },
    });
    assert.equal(list.status, 200, list.text.slice(0, 200));
    const enroll = await rawApi(`/api/employees/${encodeURIComponent(existing.id)}/templates`, {
      method: "POST",
      headers: { Cookie: viewerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ image: noFaceJpegDataUrl(64, 17) }),
    });
    assert.equal(enroll.status, 403, enroll.text.slice(0, 200));
  });

  it("lists an employee's templates without ever exposing raw embeddings", async () => {
    const res = await templatesOf(existing.id);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body.success, true);
    assert.equal(res.body.employeeId, existing.id);
    assert.equal(typeof res.body.modelTag, "string");
    assert.equal(res.body.count, res.body.templates.length);
    assert.ok(res.body.max >= 1);
    assert.ok(!/"embedding"/.test(res.text), "the response must not carry raw embeddings");
    for (const t of res.body.templates) {
      assert.equal(typeof t.id, "string");
      assert.equal(typeof t.quality, "number");
      assert.equal(typeof t.source, "string");
      assert.equal(typeof t.capturedAt, "string");
      assert.equal(typeof t.dims, "number");
      assert.equal(typeof t.modelTag, "string");
      assert.equal((t as any).embedding, undefined);
    }
  });

  it("enrolment rejects an image with no face in it and stores nothing", async () => {
    const before = await templatesOf(existing.id);
    assert.equal(before.status, 200);

    const res = await postJson(`/api/employees/${encodeURIComponent(existing.id)}/templates`, {
      image: noFaceJpegDataUrl(64, 11),
      streamId: "itest-noface",
    });

    if (!engineReady()) {
      // No models: enrolment is refused outright rather than guessed at.
      assert.equal(res.status, 503, res.text.slice(0, 300));
      assert.equal(res.body.success, false);
      assert.equal(res.body.ready, false);
    } else {
      assert.equal(res.status, 422, res.text.slice(0, 300));
      assert.equal(res.body.success, false);
      assert.equal(res.body.rejected, "no-face");
      assert.equal(res.body.detectedFaces, 0);
      assert.equal(typeof res.body.error, "string");
    }

    const after = await templatesOf(existing.id);
    assert.equal(after.body.count, before.body.count, "a rejected enrolment must not change the gallery");
  });

  it("enrolment without a usable image is a 400", async () => {
    const res = await postJson(`/api/employees/${encodeURIComponent(existing.id)}/templates`, {
      image: "https://example.test/not-a-data-url.jpg",
    });
    assert.equal(res.status, 400, res.text.slice(0, 300));
    assert.equal(res.body.success, false);
  });

  it("deleting an unknown template id is a 404", async () => {
    const res = await api(
      `/api/employees/${encodeURIComponent(existing.id)}/templates/FT-does-not-exist`,
      { method: "DELETE" }
    );
    assert.equal(res.status, 404, res.text.slice(0, 300));
    assert.equal(res.body.success, false);
    assert.equal(typeof res.body.error, "string");
  });

  it("listing, enrolling or deleting for an unknown employee is a 404", async () => {
    const list = await templatesOf("EMP-does-not-exist");
    assert.equal(list.status, 404, list.text.slice(0, 200));
    const del = await api("/api/employees/EMP-does-not-exist/templates/FT-x", { method: "DELETE" });
    assert.equal(del.status, 404, del.text.slice(0, 200));
    const enrol = await postJson("/api/employees/EMP-does-not-exist/templates", {
      image: noFaceJpegDataUrl(64, 2),
    });
    assert.equal(enrol.status, 404, enrol.text.slice(0, 200));
    const capture = await postJson("/api/employees/EMP-does-not-exist/templates/capture", { gate: "exit" });
    assert.equal(capture.status, 404, capture.text.slice(0, 200));
  });

  it("capture from a live gate stream needs the real engine (503 otherwise)", async () => {
    const res = await postJson(`/api/employees/${encodeURIComponent(existing.id)}/templates/capture`, {
      gate: "exit",
      frames: 1,
    });
    if (!engineReady()) {
      assert.equal(res.status, 503, res.text.slice(0, 300));
      assert.equal(res.body.success, false);
      assert.equal(res.body.ready, false);
      return;
    }
    // With models loaded the request gets as far as the camera: an unreachable
    // stream is a 502, a non-RTSP stream a 400, a live one a 200.
    assert.ok([200, 400, 502].includes(res.status), `unexpected ${res.status}: ${res.text.slice(0, 200)}`);
    if (res.status === 200) {
      assert.ok(Array.isArray(res.body.saved));
      assert.ok(Array.isArray(res.body.rejected));
      assert.equal(typeof res.body.minQuality, "number");
      for (const saved of res.body.saved as TemplateSummary[]) {
        const del = await api(`/api/employees/${existing.id}/templates/${saved.id}`, { method: "DELETE" });
        assert.equal(del.status, 200, "the suite must clean up what it enrolled");
      }
    }
  });

  /**
   * Full lifecycle: create an employee, enrol a template, list it, delete it,
   * delete the employee (which must take the rest of the gallery with it).
   * Model-gated, because it mutates the roster and would otherwise race the
   * roster-identity assertion in `strangers.test.ts` on the shared image.
   */
  it("create employee -> enrol -> list -> delete (skipped without models)", async (t) => {
    if (!engineReady()) {
      t.skip("no ONNX models on this image");
      return;
    }
    const employee = await createTempEmployee({
      name: `FaceEngine Lifecycle ${Date.now()}`,
      employeeCode: uniqueTestCode("ITEST-FE"),
    });
    try {
      const fresh = await templatesOf(employee.id);
      assert.equal(fresh.status, 200);
      assert.equal(fresh.body.count, 0, "a face-less registration photo enrols nothing");

      // Nothing here can invent a face, so the gallery stays empty and the
      // delete path is exercised through the unknown-id 404 above. What this
      // case proves is that the routes agree on the employee's identity and
      // that removing the employee removes their gallery.
      const removed = await api(`/api/employees/${employee.id}`, { method: "DELETE" });
      assert.equal(removed.status, 200, removed.text.slice(0, 200));
      assert.equal(typeof removed.body.removedTemplates, "number");

      const gone = await templatesOf(employee.id);
      assert.equal(gone.status, 404, "the gallery goes with the employee");
    } finally {
      await deleteEmployee(employee.id);
    }
  });
});

describe("POST /api/camera-streams/scan-rtsp fusion", () => {
  it("returns a fused decision with per-observation evidence even when no frame arrives", async () => {
    // Single-stream form: takes the URL straight from the body, so the shared
    // camera configuration is never touched.
    const scan = await postJson("/api/camera-streams/scan-rtsp", {
      gate: "exit",
      url: UNREACHABLE("fusion"),
      frames: 2,
      frameIntervalMs: 0,
    });

    assert.equal(scan.status, 502, scan.text.slice(0, 300));
    assert.equal(scan.body.success, false);
    assert.equal(scan.body.recognized, false);

    const fusion = scan.body.fusion;
    assert.ok(fusion, "scan-rtsp must always return a fusion object");
    assert.equal(fusion.recognized, false);
    assert.equal(typeof fusion.basis, "string");
    assert.equal(typeof fusion.fusedCosine, "number");
    assert.equal(typeof fusion.bestCosine, "number");
    assert.equal(typeof fusion.confidence, "number");
    assert.equal(typeof fusion.agreeingObservations, "number");
    assert.equal(typeof fusion.agreeingStreams, "number");
    assert.ok(Array.isArray(fusion.candidates), "per-candidate evidence must be an array");
    assert.ok(Array.isArray(fusion.perObservation), "per-observation cosines must be an array");
    assert.equal(fusion.perObservation.length, 0, "no frame arrived, so there is no evidence");
    assert.equal(typeof fusion.thresholds.acceptSingle, "number");
    assert.equal(typeof fusion.thresholds.acceptFused, "number");
    assert.equal(typeof fusion.thresholds.minEvidence, "number");
    assert.equal(typeof fusion.thresholds.minMargin, "number");
    assert.equal(typeof fusion.thresholds.minAgreeing, "number");
    assert.equal(typeof fusion.observations, "number");
    assert.ok(fusion.observationCap >= 1, "the observation cap must be published");
    assert.ok(["onnx", "hash", "unavailable"].includes(fusion.engine));
    assert.equal(typeof fusion.modelTag, "string");

    // Per-stream telemetry is still populated - the UI reads it.
    assert.ok(Array.isArray(scan.body.streams));
    assert.equal(scan.body.streams.length, 1);
    const stream = scan.body.streams[0];
    assert.equal(stream.success, false);
    assert.equal(typeof stream.streamId, "string");
    assert.equal(typeof stream.streamLabel, "string");
    assert.equal(typeof stream.error, "string");
    assert.equal(stream.framesCaptured, 0);
    assert.equal(typeof stream.frameCaptureDurationMs, "number");
  });

  it("clamps the multi-frame request instead of trusting the body", async () => {
    const scan = await postJson("/api/camera-streams/scan-rtsp", {
      gate: "exit",
      url: UNREACHABLE("clamp"),
      frames: 9999,
      frameIntervalMs: 999999,
    });
    assert.equal(scan.status, 502, scan.text.slice(0, 300));
    assert.ok(
      scan.body.fusion.framesPerStream <= 5,
      `frames must be capped at 5, got ${scan.body.fusion.framesPerStream}`
    );
    assert.ok(scan.body.fusion.frameIntervalMs <= 3000, "frameIntervalMs must be capped");
    // The hash path cannot use extra frames, so it must not pay for them.
    if (!engineReady()) assert.equal(scan.body.fusion.framesPerStream, 1);
  });

  it("an unknown stream id is a 400, not a fabricated scan", async () => {
    const scan = await postJson("/api/camera-streams/scan-rtsp", { gate: "exit", stream: "no-such-stream" });
    assert.equal(scan.status, 400, scan.text.slice(0, 300));
    assert.equal(scan.body.success, false);
  });
});

describe("fail-closed invariants", () => {
  it("a frame with no recognisable face is denied and the door stays LOCKED", async () => {
    await lockDoor("faceEngine integration baseline");
    const res = await recognize({ imageBase64: noFaceJpegDataUrl(64, 7), scanType: "ENTRY" });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body.recognized, false, "a face-less frame must never be recognised");
    assert.equal(res.body.lockUnlocked, false);
    assert.equal(res.body.authorizedCount, 0);
    assert.ok(!res.body.employee, "no employee may be attributed to an unrecognised frame");

    const lock = await getLockState();
    assert.equal(lock.state, "LOCKED", `door must stay LOCKED, got ${lock.state}`);
    assert.equal(lock.isLocked, true);
  });

  it("no recognised face is ever reported without an employee id", async () => {
    const res = await recognize({ imageBase64: noFaceJpegDataUrl(64, 3), scanType: "EXIT" });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    for (const face of res.body.detectedFaces || []) {
      if (face.recognized) {
        assert.ok(face.employeeId, "a recognised face must carry the employee it matched");
      }
    }
    const lock = await getLockState();
    assert.equal(lock.isLocked, true);
  });

  it("the recognition response names the engine that actually decided", async (t) => {
    const res = await recognize({ imageBase64: noFaceJpegDataUrl(64, 5), scanType: "ENTRY" });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    if (!engineReady()) {
      assert.ok(
        ["hash", "unavailable"].includes(String(res.body.faceEngine)),
        `unexpected faceEngine ${res.body.faceEngine}`
      );
      t.diagnostic(`engine=${status.engine} (no models on this image)`);
      return;
    }
    assert.equal(res.body.faceEngine, "onnx");
    assert.match(String(res.body.engineUsed), /Real Face Engine/);
    assert.equal(res.body.recognized, false);
  });
});
