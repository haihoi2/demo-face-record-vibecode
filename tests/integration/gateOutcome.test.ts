/**
 * Gate-scan OUTCOME: what a recognition RECORDS and DOES.
 *
 * `performGateScan` - the function the backend gate watcher AND
 * POST /api/camera-streams/scan-rtsp both run - used to perform no writes at
 * all: no access log, no stored snapshot, no stranger capture, no unlock. The
 * EXIT watcher had completed 4,574 scans and produced zero rows, so the
 * stranger panel (built by `clusterStrangerFaces` over the DENIED access logs)
 * had nothing to group. Both paths now call ONE shared
 * `applyRecognitionOutcome`, which is also what POST /api/recognize-face has
 * always used - that route is the reference behaviour this suite guards.
 *
 * Two tiers:
 *
 *  A. Always runs. The /api/recognize-face regression guard (the extraction
 *     must not have changed it), and the fact that a scan which captured
 *     nothing records nothing.
 *
 *  B. Opt-in, because the scan path can only be driven by a REAL RTSP feed and
 *     the real face engine. Every tier-B test skips unless the gateway reports
 *     `engine:"onnx"` (GET /api/face-engine/status) and the feeds below are
 *     provided:
 *
 *       GATE_OUTCOME_RTSP_NOFACE_URL    feed with no face in it
 *       GATE_OUTCOME_RTSP_FACE_URL      feed showing person A
 *       GATE_OUTCOME_FACE_IMAGE         path to a JPEG of person A (enrolment)
 *       GATE_OUTCOME_RTSP_STRANGER_URL  feed showing person B
 *       GATE_OUTCOME_STRANGER_IMAGE     path to a JPEG of person B (enrolment)
 *
 *     Tier B UNLOCKS THE DOOR and writes access logs, so it must not run
 *     concurrently with `security.test.ts` (which asserts the door stays
 *     locked). It is env-gated precisely so the shared smoke run never does.
 *
 * Isolation: every scan-path row this suite causes carries "Quét RTSP thủ công"
 * in `reason`, which nothing else in the suite (or in the product) writes, so
 * counting those rows is unaffected by the other suites running in parallel.
 * The only roster changes are temporary employees this file deletes itself;
 * deleting an employee also drops their face templates.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  api,
  postJson,
  recognize,
  noFaceJpegDataUrl,
  getLockState,
  lockDoor,
  createTempEmployee,
  deleteEmployee,
  uniqueTestCode,
  type Employee,
} from "./helpers";

interface AccessLog {
  id: string;
  status: "GRANTED" | "DENIED";
  type: "ENTRY" | "EXIT";
  photoSnapshot?: string;
  employeeId?: string;
  reason?: string;
  timestamp: string;
}

interface OutcomeSummary {
  trigger: "api" | "manual" | "watcher";
  gate: "entry" | "exit";
  granted: boolean;
  lockUnlocked: boolean;
  status?: "GRANTED" | "DENIED";
  logId?: string;
  logIds: string[];
  snapshotStored: boolean;
  suppressed?: "grant-cooldown" | "stranger-cooldown";
  suppressedEmployeeIds: string[];
  strangerWebhookDispatched: boolean;
  stats: Record<string, unknown>;
}

/** Only the scan path writes this marker, so parallel suites cannot perturb the count. */
const SCAN_MARKER = "Quét RTSP thủ công";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getLogs(): Promise<AccessLog[]> {
  const res = await api<AccessLog[]>("/api/logs");
  assert.equal(res.status, 200, res.text.slice(0, 200));
  assert.ok(Array.isArray(res.body), "GET /api/logs must return an array");
  return res.body;
}

/** Access logs written by a manual scan-rtsp call (ours; nothing else writes them). */
async function scanLogs(): Promise<AccessLog[]> {
  return (await getLogs()).filter((l) => typeof l.reason === "string" && l.reason.includes(SCAN_MARKER));
}

async function scan(url: string, extra: Record<string, unknown> = {}) {
  return postJson<any>("/api/camera-streams/scan-rtsp", { gate: "entry", url, frames: 1, ...extra });
}

async function strangerClusterLogIds(): Promise<Set<string>> {
  const res = await api<any>("/api/strangers/clusters");
  assert.equal(res.status, 200, res.text.slice(0, 200));
  const ids = new Set<string>();
  for (const cluster of res.body?.clusters || []) {
    for (const photo of cluster.photos || []) ids.add(photo.logId);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Tier A - always runs
// ---------------------------------------------------------------------------

describe("recognition outcome - /api/recognize-face reference behaviour", () => {
  it("still writes a DENIED log with a stored snapshot that the stranger clusters pick up", async () => {
    await lockDoor("gateOutcome baseline");
    const frame = noFaceJpegDataUrl(64, 20260921);

    const res = await recognize({ imageBase64: frame, scanType: "ENTRY" });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body.recognized, false);
    assert.equal(res.body.strangerAlert, true);
    assert.equal(res.body.lockUnlocked, false);

    const log = res.body.log as AccessLog;
    assert.ok(log?.id, "a DENIED access log must be returned");
    assert.equal(log.status, "DENIED");
    assert.ok(log.photoSnapshot, "the DENIED log must carry the stored snapshot");

    // The extraction must not have changed the shape: the same log is really
    // persisted, and it is what the stranger panel groups.
    const stored = (await getLogs()).find((l) => l.id === log.id);
    assert.ok(stored, "the DENIED log must be persisted in /api/logs");
    assert.ok(stored!.photoSnapshot, "the persisted log must keep its photoSnapshot");
    assert.ok((await strangerClusterLogIds()).has(log.id), "the log must appear in /api/strangers/clusters");

    // New, additive: the route now reports what it recorded.
    const outcome = res.body.outcome as OutcomeSummary;
    assert.equal(outcome?.trigger, "api");
    assert.equal(outcome.status, "DENIED");
    assert.equal(outcome.logId, log.id);
    assert.equal(outcome.granted, false);
    assert.equal(outcome.lockUnlocked, false);
    assert.equal(outcome.suppressed, undefined, "the API route is never rate limited");

    const lock = await getLockState();
    assert.equal(lock.state, "LOCKED", "an unrecognised frame must never unlock");
  });

  it("is not rate limited: two frames in a row produce two stranger rows", async () => {
    const first = await recognize({ imageBase64: noFaceJpegDataUrl(64, 111), scanType: "ENTRY" });
    const second = await recognize({ imageBase64: noFaceJpegDataUrl(64, 222), scanType: "ENTRY" });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const a = (first.body.log as AccessLog | undefined)?.id;
    const b = (second.body.log as AccessLog | undefined)?.id;
    assert.ok(a && b, "both posts must write a log");
    assert.notEqual(a, b, "the reference route must keep writing one row per frame");

    const ids = new Set((await getLogs()).map((l) => l.id));
    assert.ok(ids.has(a!) && ids.has(b!), "both rows must be persisted");
  });
});

describe("recognition outcome - a gate scan that captured nothing records nothing", () => {
  it("returns 502 and writes no access log", async () => {
    const before = await scanLogs();
    const res = await scan("rtsp://127.0.0.1:1/gate-outcome-itest");
    assert.equal(res.status, 502, res.text.slice(0, 300));
    assert.equal(res.body?.success, false);
    assert.equal(res.body?.outcome, undefined, "a failed capture must not produce an outcome");
    assert.equal(res.body?.accessLogId, undefined);

    const after = await scanLogs();
    assert.equal(after.length, before.length, "a failed capture must write no access log");
  });
});

describe("recognition outcome - watcher telemetry", () => {
  it("exposes the per-gate dedupe counters so suppression is visible", async () => {
    const res = await api<any>("/api/camera-streams/watch");
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.ok(Array.isArray(res.body?.watchers));
    for (const w of res.body.watchers) {
      assert.ok(w.outcomeStats, `watcher ${w.gate} must expose outcomeStats`);
      for (const field of [
        "grantsWritten",
        "grantsSuppressed",
        "strangersWritten",
        "strangersSuppressed",
        "strangerWebhooksNotSent",
        "unlocks",
      ]) {
        assert.equal(typeof w.outcomeStats[field], "number", `outcomeStats.${field} must be a number`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tier B - real RTSP feeds + the real face engine
// ---------------------------------------------------------------------------

const NOFACE_URL = process.env.GATE_OUTCOME_RTSP_NOFACE_URL || "";
const FACE_URL = process.env.GATE_OUTCOME_RTSP_FACE_URL || "";
const FACE_IMAGE = process.env.GATE_OUTCOME_FACE_IMAGE || "";
const STRANGER_URL = process.env.GATE_OUTCOME_RTSP_STRANGER_URL || "";
const STRANGER_IMAGE = process.env.GATE_OUTCOME_STRANGER_IMAGE || "";

function fileAsDataUrl(path: string): string {
  return "data:image/jpeg;base64," + readFileSync(path).toString("base64");
}

describe("recognition outcome - the gate scan path (real feeds)", () => {
  let engineReady = false;
  const createdEmployees: string[] = [];
  /** Set by the grant-cooldown test; the next test needs them still in cooldown. */
  let personA: Employee | undefined;

  before(async () => {
    const res = await api<any>("/api/face-engine/status");
    engineReady = res.status === 200 && res.body?.engine === "onnx";
  });

  after(async () => {
    for (const id of createdEmployees) await deleteEmployee(id);
  });

  async function enrol(namePrefix: string, imagePath: string): Promise<Employee> {
    const emp = await createTempEmployee({
      name: `${namePrefix} ${Date.now()}`,
      employeeCode: uniqueTestCode("GOUT"),
    });
    createdEmployees.push(emp.id);
    const res = await postJson<any>(`/api/employees/${emp.id}/templates`, { image: fileAsDataUrl(imagePath) });
    assert.equal(res.status, 200, `enrolment failed: ${res.text.slice(0, 300)}`);
    return emp;
  }

  it("a scan whose frames contain no face writes NO access log and NO stranger row", async (t) => {
    if (!engineReady || !NOFACE_URL) {
      t.skip("needs FACE_ENGINE=onnx with models and GATE_OUTCOME_RTSP_NOFACE_URL");
      return;
    }
    const logsBefore = await scanLogs();
    const clustersBefore = await strangerClusterLogIds();

    const res = await scan(NOFACE_URL);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body.success, true);
    assert.equal(res.body.recognized, false);
    assert.equal(res.body.fusion?.observations, 0, "an empty corridor must yield no observations");

    const outcome = res.body.outcome as OutcomeSummary;
    assert.equal(outcome.status, undefined, "nothing may be recorded");
    assert.equal(outcome.logId, undefined);
    assert.equal(outcome.snapshotStored, false, "no frame contained a face, so nothing is stored");
    assert.equal(outcome.suppressed, undefined, "this is not a cooldown - there was simply nothing to record");
    assert.equal(res.body.lockUnlocked, false);

    assert.equal((await scanLogs()).length, logsBefore.length, "no access log may be written");
    const clustersAfter = await strangerClusterLogIds();
    assert.equal(clustersAfter.size, clustersBefore.size, "no stranger row may be created");
  });

  it("an unrecognised face writes ONE DENIED row with a stored image, then the gate cooldown holds", async (t) => {
    if (!engineReady || !STRANGER_URL) {
      t.skip("needs FACE_ENGINE=onnx with models and GATE_OUTCOME_RTSP_STRANGER_URL");
      return;
    }
    const first = await scan(STRANGER_URL);
    assert.equal(first.status, 200, first.text.slice(0, 300));
    const firstOutcome = first.body.outcome as OutcomeSummary;

    // The first scan of an unknown face in this window must record it. If a
    // previous test in this run already consumed the window the API says so,
    // and the cooldown assertion below is the only thing that matters.
    if (firstOutcome.suppressed === "stranger-cooldown") {
      assert.equal(firstOutcome.logId, undefined);
    } else {
      assert.equal(first.body.recognized, false);
      assert.equal(firstOutcome.status, "DENIED");
      assert.ok(firstOutcome.logId, "a stranger must produce a DENIED access log");
      assert.equal(firstOutcome.snapshotStored, true, "the DENIED row must carry the annotated frame");
      assert.equal(firstOutcome.strangerWebhookDispatched, true);

      const stored = (await getLogs()).find((l) => l.id === firstOutcome.logId);
      assert.ok(stored, "the DENIED row must be persisted");
      assert.equal(stored!.status, "DENIED");
      assert.ok(
        stored!.photoSnapshot && stored!.photoSnapshot.startsWith("data:image/"),
        "the stored snapshot must be a real image - this is what feeds the clusters"
      );
      assert.ok(
        (await strangerClusterLogIds()).has(firstOutcome.logId!),
        "the DENIED row must show up in /api/strangers/clusters"
      );
    }

    // Immediately again: at most one stranger row per gate per window.
    const second = await scan(STRANGER_URL);
    assert.equal(second.status, 200, second.text.slice(0, 300));
    const secondOutcome = second.body.outcome as OutcomeSummary;
    assert.equal(secondOutcome.suppressed, "stranger-cooldown", "the second stranger row must be deduped");
    assert.equal(secondOutcome.logId, undefined, "no second row may be written");
    assert.equal(second.body.suppressed, "stranger-cooldown", "the reason must be visible in the response");
  });

  it("a recognised employee unlocks the door and the grant cooldown suppresses the next scan", async (t) => {
    if (!engineReady || !FACE_URL || !FACE_IMAGE) {
      t.skip("needs FACE_ENGINE=onnx with models, GATE_OUTCOME_RTSP_FACE_URL and GATE_OUTCOME_FACE_IMAGE");
      return;
    }
    const employee = await enrol("GateOutcome Person A", FACE_IMAGE);
    await lockDoor("gateOutcome grant baseline");
    personA = employee;

    const first = await scan(FACE_URL);
    assert.equal(first.status, 200, first.text.slice(0, 300));
    if (!first.body.recognized) {
      t.skip(`the feed did not match the enrolled template (${first.body.message}) - nothing to dedupe`);
      return;
    }
    const firstOutcome = first.body.outcome as OutcomeSummary;
    assert.equal(firstOutcome.status, "GRANTED");
    assert.equal(firstOutcome.granted, true);
    assert.equal(firstOutcome.lockUnlocked, true, "a recognised employee must unlock the door");
    assert.ok(firstOutcome.logId, "a GRANTED access log must be written");
    assert.equal(firstOutcome.snapshotStored, true);
    assert.equal(first.body.lockUnlocked, true);

    const grantedLog = (await getLogs()).find((l) => l.id === firstOutcome.logId);
    assert.ok(grantedLog, "the GRANTED row must be persisted");
    assert.equal(grantedLog!.status, "GRANTED");
    assert.equal(grantedLog!.employeeId, employee.id);
    assert.ok(
      grantedLog!.photoSnapshot && grantedLog!.photoSnapshot.startsWith("data:image/"),
      "the GRANTED row must store the frame the winning observation came from"
    );

    const unlocked = await getLockState();
    assert.equal(unlocked.state, "UNLOCKED", "the lock must have transitioned to UNLOCKED");

    // Force LOCKED again so a second unlock would be unmistakable, then rescan
    // at once: the same employee at the same gate must be deduped.
    await lockDoor("gateOutcome re-lock before cooldown probe");
    const second = await scan(FACE_URL);
    assert.equal(second.status, 200, second.text.slice(0, 300));
    const secondOutcome = second.body.outcome as OutcomeSummary;
    assert.equal(secondOutcome.suppressed, "grant-cooldown", "the repeat grant must be deduped");
    assert.equal(secondOutcome.logId, undefined, "no duplicate GRANTED row may be written");
    assert.equal(secondOutcome.lockUnlocked, false, "the door must NOT be unlocked again");
    assert.deepEqual(secondOutcome.suppressedEmployeeIds, [employee.id]);
    assert.equal(second.body.suppressed, "grant-cooldown", "the reason must be visible in the response");

    const stillLocked = await getLockState();
    assert.equal(stillLocked.state, "LOCKED", "a suppressed grant must leave the lock alone");
  });

  it("a DIFFERENT employee at the same gate is not suppressed by the first one's cooldown", async (t) => {
    if (!engineReady || !STRANGER_URL || !STRANGER_IMAGE || !personA) {
      t.skip("needs the previous grant test to have put person A into cooldown, plus GATE_OUTCOME_RTSP_STRANGER_URL");
      return;
    }
    // Person A is still inside their grant cooldown from the previous test -
    // enrolling them a second time here would put two employees behind one face
    // and the fusion would (correctly) reject it as ambiguous.
    const personB = await enrol("GateOutcome Person B", STRANGER_IMAGE);
    await sleep(250);
    const res = await scan(STRANGER_URL);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    if (!res.body.recognized) {
      t.skip(`person B was not recognised from their own feed (${res.body.message})`);
      return;
    }
    const outcome = res.body.outcome as OutcomeSummary;
    assert.equal(outcome.status, "GRANTED", "a different employee must still be recorded");
    assert.ok(outcome.logId, "the second employee must get their own GRANTED row");
    assert.equal(outcome.lockUnlocked, true, "a different employee must still open the door");
    assert.deepEqual(outcome.suppressedEmployeeIds, [], "nobody in this scan was deduped");

    const log = (await getLogs()).find((l) => l.id === outcome.logId);
    assert.ok(log, "the row must be persisted");
    assert.equal(log!.employeeId, personB.id);
    assert.notEqual(log!.employeeId, personA!.id);
  });
});
