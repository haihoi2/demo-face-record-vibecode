/**
 * Door-unlock bypass regressions (commit 420c192).
 *
 * Before that fix, each request below opened the lock against a LOCKED door:
 *   1. POST /api/recognize-face {"employeeCode":"NV-5588"}   (no image at all)
 *   2. POST /api/recognize-face {"testEmployeeId":"TEST"}     (simulation shortcut)
 *   3. POST /api/recognize-face with an image containing no face
 *      (a fallback fabricated employees[0] at 96.5% confidence)
 *
 * Every test starts from a LOCKED baseline, fires the request, checks the
 * HTTP response, and then re-reads /api/lock/status to prove the door never
 * moved. The unlock path auto-relocks after 6 s, so the status read happens
 * immediately after the recognition call.
 *
 * Requires a running gateway at APP_URL with ALLOW_SIMULATED_RECOGNITION
 * unset or "false" (the production default). No Gemini key is needed.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  api,
  getLockState,
  listEmployees,
  lockDoor,
  noFaceJpegDataUrl,
  buildGreyJpeg,
  recognize,
  withAiConfig,
  type RecognizeResponse,
} from "./helpers";

/** The fabricated-match fallback used exactly these numbers. */
const LEGACY_FAKE_CONFIDENCE = 96.5;
const LEGACY_FAKE_LIVENESS = 98.8;

function assertDenied(res: { status: number; body: RecognizeResponse; text: string }, label: string) {
  assert.equal(res.status, 200, `${label}: expected HTTP 200 with a denial body, got ${res.status}: ${res.text.slice(0, 300)}`);
  const body = res.body;
  assert.ok(body, `${label}: response was not JSON`);
  assert.equal(body.recognized, false, `${label}: recognized must be false`);
  assert.equal(body.lockUnlocked, false, `${label}: lockUnlocked must be false`);
  assert.equal(body.authorizedCount, 0, `${label}: authorizedCount must be 0`);
  assert.equal(body.employee, undefined, `${label}: no employee may be attached to a denial`);
  assert.ok(Array.isArray(body.detectedFaces), `${label}: detectedFaces must be an array`);
  for (const face of body.detectedFaces!) {
    assert.equal(face.recognized, false, `${label}: every detected face must be unrecognised`);
    assert.equal(face.employeeId, undefined, `${label}: no face may carry an employeeId`);
  }
  assert.notEqual(body.confidence, LEGACY_FAKE_CONFIDENCE, `${label}: legacy 96.5% fabricated confidence resurfaced`);
  assert.notEqual(body.livenessScore, LEGACY_FAKE_LIVENESS, `${label}: legacy 98.8 fabricated liveness resurfaced`);
}

async function assertStillLocked(label: string) {
  const state = await getLockState();
  assert.equal(state.state, "LOCKED", `${label}: door state changed to ${state.state}`);
  assert.equal(state.isLocked, true, `${label}: isLocked flipped to false`);
}

describe("gateway baseline", () => {
  it("GET /api/health answers ok", async () => {
    const res = await api("/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.body?.status, "ok");
  });

  it("the roster is non-empty (the bypasses only mattered with enrolled employees)", async () => {
    const employees = await listEmployees();
    assert.ok(employees.length > 0, "expected at least one enrolled employee");
  });

  it("POST /api/lock/lock forces LOCKED and /api/lock/status reflects it", async () => {
    const state = await lockDoor();
    assert.equal(state.state, "LOCKED");
    assert.equal(state.isLocked, true);
  });

  it("GET /api/recognize-face describes the endpoint without touching the lock", async () => {
    await lockDoor();
    const res = await api("/api/recognize-face");
    assert.equal(res.status, 200);
    assert.equal(res.body?.status, "online");
    await assertStillLocked("GET /api/recognize-face");
  });
});

describe("bypass 1: identity-only body without an image", () => {
  beforeEach(async () => {
    await lockDoor();
  });

  it('{"employeeCode":"NV-5588"} is rejected with 400 and the door stays LOCKED', async () => {
    const res = await recognize({ employeeCode: "NV-5588" });
    assert.equal(res.status, 400, `unexpected status ${res.status}: ${res.text.slice(0, 300)}`);
    assert.ok(res.body, "response must be JSON");
    assert.notEqual(res.body.recognized, true);
    assert.equal(res.body.lockUnlocked, undefined);
    assert.match(String(res.body.message || res.body.error), /imageBase64/, "400 body should tell the caller imageBase64 is missing");
    await assertStillLocked("employeeCode-only body");
  });

  it("a real enrolled employeeCode is refused just the same", async () => {
    const [first] = await listEmployees();
    const res = await recognize({ employeeCode: first.employeeCode });
    assert.equal(res.status, 400, `unexpected status ${res.status}: ${res.text.slice(0, 300)}`);
    assert.notEqual(res.body?.recognized, true);
    await assertStillLocked("real employeeCode-only body");
  });

  it("a real enrolled employeeId is refused just the same", async () => {
    const [first] = await listEmployees();
    const res = await recognize({ employeeId: first.id });
    assert.equal(res.status, 400, `unexpected status ${res.status}: ${res.text.slice(0, 300)}`);
    assert.notEqual(res.body?.recognized, true);
    await assertStillLocked("real employeeId-only body");
  });

  it("an empty JSON body is a 400, not an unlock", async () => {
    const res = await recognize({});
    assert.equal(res.status, 400);
    await assertStillLocked("empty body");
  });

  it("a short text/plain body (an employee code) is treated as no image", async () => {
    const res = await api("/api/recognize-face", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "NV-5588",
    });
    assert.equal(res.status, 400, `unexpected status ${res.status}: ${res.text.slice(0, 300)}`);
    await assertStillLocked("text/plain employee code");
  });
});

describe("bypass 2: simulation shortcuts are disabled by default", () => {
  beforeEach(async () => {
    await lockDoor();
  });

  for (const testId of ["TEST", "PING", "MULTI_EMPLOYEES", "MULTI_MIXED"]) {
    it(`{"testEmployeeId":"${testId}"} returns 403 simulationDisabled and keeps the door LOCKED`, async () => {
      const res = await recognize({ testEmployeeId: testId });
      assert.equal(res.status, 403, `unexpected status ${res.status}: ${res.text.slice(0, 300)}`);
      assert.ok(res.body, "response must be JSON");
      assert.equal(res.body.simulationDisabled, true);
      assert.equal(res.body.recognized, false);
      assert.equal(res.body.employee, undefined);
      assert.equal(res.body.lockUnlocked, undefined);
      await assertStillLocked(`testEmployeeId=${testId}`);
    });
  }

  it("a real enrolled code passed as testEmployeeId is refused too", async () => {
    const [first] = await listEmployees();
    const res = await recognize({ testEmployeeId: first.employeeCode });
    assert.equal(res.status, 403);
    assert.equal(res.body?.simulationDisabled, true);
    await assertStillLocked("testEmployeeId=<real code>");
  });

  it("the testEmployee alias is refused as well", async () => {
    const res = await recognize({ testEmployee: "TEST" });
    assert.equal(res.status, 403);
    assert.equal(res.body?.simulationDisabled, true);
    await assertStillLocked("testEmployee alias");
  });

  it("testEmployeeId cannot ride along with a no-face image", async () => {
    const res = await recognize({ testEmployeeId: "TEST", imageBase64: noFaceJpegDataUrl() });
    assert.equal(res.status, 403, `unexpected status ${res.status}: ${res.text.slice(0, 300)}`);
    assert.equal(res.body?.simulationDisabled, true);
    await assertStillLocked("testEmployeeId + image");
  });

  it("GET /api/config/ai is readable (simulation state is not exposed as enabled)", async () => {
    const res = await api("/api/config/ai");
    assert.equal(res.status, 200);
    assert.ok(res.body?.engineMode, "config should expose engineMode");
  });
});

describe("bypass 3: an image with no face never matches", () => {
  let originalEngineMode: string;

  before(async () => {
    const cfg = await api("/api/config/ai");
    originalEngineMode = cfg.body?.engineMode;
  });

  beforeEach(async () => {
    await lockDoor();
  });

  it("a synthetic grey JPEG data URL is denied in the server's default engine mode", async () => {
    const res = await recognize({ imageBase64: noFaceJpegDataUrl(64, 0) });
    assertDenied(res, `default engine (${originalEngineMode}) / grey jpeg`);
    await assertStillLocked("default engine / grey jpeg");
  });

  it("several byte-distinct no-face frames are all denied", async () => {
    for (const seed of [7, 99, 1234, 55555]) {
      await lockDoor();
      const res = await recognize({ imageBase64: noFaceJpegDataUrl(64, seed) });
      assertDenied(res, `default engine / noise seed ${seed}`);
      await assertStillLocked(`default engine / noise seed ${seed}`);
    }
  });

  it("an EXIT scan with a no-face image is denied too", async () => {
    const res = await recognize({ imageBase64: noFaceJpegDataUrl(), scanType: "EXIT" });
    assertDenied(res, "EXIT scan");
    await assertStillLocked("EXIT scan");
  });

  it("raw image/jpeg bytes (no JSON envelope) are denied", async () => {
    const res = await api<RecognizeResponse>("/api/recognize-face", {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: new Uint8Array(buildGreyJpeg(64, 0)),
    });
    assertDenied(res, "raw image/jpeg body");
    await assertStillLocked("raw image/jpeg body");
  });

  it("a bare base64 string sent as text/plain is denied", async () => {
    const res = await api<RecognizeResponse>("/api/recognize-face", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: noFaceJpegDataUrl(),
    });
    assertDenied(res, "text/plain data URL");
    await assertStillLocked("text/plain data URL");
  });

  it("HYBRID_AUTO engine mode denies a no-face image", async () => {
    await withAiConfig({ engineMode: "HYBRID_AUTO" }, async () => {
      const res = await recognize({ imageBase64: noFaceJpegDataUrl(64, 0) });
      assertDenied(res, "HYBRID_AUTO");
      await assertStillLocked("HYBRID_AUTO");
    });
  });

  it("GOOGLE_GEMINI engine mode without an API key denies a no-face image", async () => {
    await withAiConfig({ engineMode: "GOOGLE_GEMINI" }, async () => {
      const res = await recognize({ imageBase64: noFaceJpegDataUrl(64, 0) });
      assertDenied(res, "GOOGLE_GEMINI");
      await assertStillLocked("GOOGLE_GEMINI");
    });
  });

  it("LOCAL_BIOMETRIC engine mode denies a no-face image", async () => {
    await withAiConfig({ engineMode: "LOCAL_BIOMETRIC" }, async () => {
      const res = await recognize({ imageBase64: noFaceJpegDataUrl(64, 0) });
      assertDenied(res, "LOCAL_BIOMETRIC");
      await assertStillLocked("LOCAL_BIOMETRIC");
    });
  });

  it("a per-request config override to LOCAL_BIOMETRIC still denies", async () => {
    const res = await recognize({
      imageBase64: noFaceJpegDataUrl(64, 0),
      config: { engineMode: "LOCAL_BIOMETRIC" },
    });
    assertDenied(res, "per-request LOCAL_BIOMETRIC override");
    await assertStillLocked("per-request LOCAL_BIOMETRIC override");
  });

  it("the engine config is back to what it was before the suite", async () => {
    const cfg = await api("/api/config/ai");
    assert.equal(cfg.body?.engineMode, originalEngineMode);
  });
});
