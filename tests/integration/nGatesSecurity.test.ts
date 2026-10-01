/**
 * N gates, SECURITY black-box suite (plan docs/plans/2026-09-29-scale-and-accuracy.md
 * section 11; .claude/rules/security.md). Complements nGates.test.ts (happy path)
 * without repeating it.
 *
 * Three gates: the permanent "entry" and "exit" plus one created here (ENTRY,
 * bound to its own door). Covered:
 *   1. authN/authZ matrix (anonymous / viewer / operator / admin) and CSRF for
 *      every new or changed route, plus path case variants;
 *   2. input validation: gate and door ids (traversal, case, unicode, length,
 *      reserved words, SQL metacharacters, wrong JSON types), MAX_GATES,
 *      duplicates, retired ids, the permanent gates;
 *   3. secrets: a door token and a camera password never appear in any
 *      response or SSE frame this file sees;
 *   4. SSRF: the destination guard for the new gate's streams and the new
 *      door's controller URL, in parity with the legacy gate/door;
 *   5. isolation between doors and gates, history of a deleted gate;
 *   6. concurrency.
 *
 * Tests whose name starts with "FINDING NGSEC-<n>" document a defect found by
 * this suite (see docs/agent-handoffs/2026-10-01-ng-sec.md). They assert the
 * SECURE behaviour and are expected to fail until the defect is fixed.
 *
 * Environment: ITEST_STRICT_ALLOWLIST=1 when the gateway runs with
 * CAMERA_ALLOWED_HOSTS / DOOR_ALLOWED_HOSTS that do NOT include 10.20.30.40;
 * the private-host cases then also assert DEST_NOT_ALLOWED. Without it they
 * assert parity with the legacy gate/door only.
 *
 * Leaves the gateway as found: created gates are deleted (their ids stay
 * retired), doors removed, door "main" restored, accounts deleted. Access
 * events written here stay, as history must.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BASE_URL,
  UNREACHABLE_HOST,
  apiAs,
  authenticateAs,
  createTempEmployee,
  csrfTokenForCookie,
  deleteEmployee,
  loginWithPassword,
  noFaceJpegDataUrl,
  rawApi,
  unreachableRtsp,
  type ApiResponse,
} from "./helpers";

const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || "integration-operator-token";
const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";
const STRICT_ALLOWLIST = process.env.ITEST_STRICT_ALLOWLIST === "1";

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
/** The third gate. Starts with "k" on purpose (NGSEC-4, Kelvin sign). */
const GATE = `ksec-${RUN}`;
const DOOR = `dsec-${RUN}`;
const DOOR2 = `dsec-${RUN}-b`;
const DOOR_TOKEN = `itest-ngsec-door-token-${RUN}`;
const MAIN_TOKEN = `itest-ngsec-main-token-${RUN}`;
const CAM_SECRET = `Itest-Cam-S3cret-${RUN}`;
const URL_SECRET = `Itest-Url-S3cret-${RUN}`;
const PASSWORD = "Itest-ngsec-Passw0rd!";

type Role = "anon" | "viewer" | "operator" | "admin";
const RANK: Record<Role, number> = { anon: -1, viewer: 0, operator: 1, admin: 2 };

const sessions: Record<Exclude<Role, "anon">, string> = { viewer: "", operator: "", admin: "" };
const accounts: string[] = [];
let employeeId = "";
let mainBefore: any = null;

/** Every response this file sees, for the secret scan at the end. */
const seen: Array<{ where: string; text: string }> = [];
function record(where: string, res: ApiResponse) {
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
  seen.push({ where, text: `${res.text}\n${headers}` });
  return res;
}

interface CallOpts {
  /** Omit X-CSRF-Token (cookie still sent). */
  noCsrf?: boolean;
  csrf?: string;
  origin?: string;
  contentType?: string;
  rawBody?: string;
}

/** One request as `who` (anonymous = no cookie). JSON body for writes. */
async function call<T = any>(who: Role, method: string, path: string, body?: unknown, opts: CallOpts = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  const write = !/^(GET|HEAD)$/i.test(method);
  if (write) headers["Content-Type"] = opts.contentType || "application/json";
  if (opts.origin) headers.Origin = opts.origin;
  const init: RequestInit = { method, headers, redirect: "manual" };
  if (write) init.body = opts.rawBody ?? JSON.stringify(body === undefined ? {} : body);
  let res: ApiResponse<T>;
  if (who === "anon") {
    res = await rawApi<T>(path, init);
  } else {
    const cookie = sessions[who];
    headers.Cookie = cookie;
    if (write && !opts.noCsrf) headers["X-CSRF-Token"] = opts.csrf ?? csrfTokenForCookie(cookie);
    res = await rawApi<T>(path, init);
  }
  return record(`${who} ${method} ${path}`, res);
}
const admin = <T = any>(method: string, path: string, body?: unknown) => call<T>("admin", method, path, body);

const gatesList = async (): Promise<any[]> => (await admin("GET", "/api/gates")).body.gates;
const gateSummary = async (id: string) => (await gatesList()).find((g) => g.id === id);
const fullConfig = async () => (await admin("GET", "/api/camera-streams/config")).body.config;
const runtimeIds = async (): Promise<string[]> => (await admin("GET", "/api/camera-streams/watch")).body.watchers.map((w: any) => w.gateId);
const doorCfg = async () => (await admin("GET", "/api/door-controller/config")).body;
const lockOf = async (doorId: string) => (await admin("GET", `/api/lock/state?doorId=${doorId}`)).body;

async function createGate(id: string, direction: "ENTRY" | "EXIT" = "ENTRY", doorId?: string) {
  const res = await admin("POST", "/api/gates", { id, label: `itest ${id}`, direction, ...(doorId ? { doorId } : {}) });
  assert.equal(res.status, 201, `create ${id}: ${res.text.slice(0, 300)}`);
  return res;
}
async function deleteGate(id: string) {
  return admin("DELETE", `/api/gates/${id}`);
}
/** Puts the door list to main + the given extra doors (ids only keep their stored fields). */
async function setDoors(extra: any[]) {
  return admin("POST", "/api/door-controller/config", { doors: [{ id: "main" }, ...extra] });
}

/** A slow-to-resolve, never-resolving camera host (RFC 6761): saved with DEST_UNRESOLVED after a DNS round trip. */
const slowCameraUrl = (tag: string) => `rtsp://itest-ngsec-${tag}-${RUN}.invalid:554/x`;

// ---------------------------------------------------------------------------
// SSE capture (viewer)
// ---------------------------------------------------------------------------
interface SseCapture {
  status: number;
  text(): string;
  events(): Array<{ event: string; data: any }>;
  close(): Promise<void>;
}
async function openSse(cookie: string): Promise<SseCapture> {
  const ac = new AbortController();
  const res = await fetch(`${BASE_URL}/api/events`, { headers: { Cookie: cookie }, signal: ac.signal });
  let buf = "";
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    status: res.status,
    text: () => buf,
    events: () =>
      buf.split("\n\n").flatMap((block) => {
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (!ev || !data) return [];
        try {
          return [{ event: ev, data: JSON.parse(data) }];
        } catch {
          return [{ event: ev, data }];
        }
      }),
    close: async () => {
      ac.abort();
      await pump;
    },
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
describe("N gates: security (third gate + own door)", () => {
  before(async () => {
    sessions.admin = await authenticateAs(OPERATOR_TOKEN);
    sessions.viewer = await authenticateAs(VIEWER_TOKEN);
    const username = `it-ngsec-op-${RUN}`;
    const created = await admin("POST", "/api/users", { username, role: "operator", password: PASSWORD });
    assert.equal(created.status, 201, created.text.slice(0, 200));
    accounts.push(created.body.user.id);
    const login = await loginWithPassword(username, PASSWORD);
    assert.equal(login.status, 200, login.text.slice(0, 200));
    assert.equal(login.body.role, "operator");
    sessions.operator = login.cookie;

    const cfg = await doorCfg();
    mainBefore = { enabled: cfg.enabled, apiUrl: cfg.apiUrl, authHeaderType: cfg.authHeaderType, hadToken: cfg.hasApiToken };
    // Two doors with tokens; both disabled (no controller call is ever made).
    const doors = await setDoors([
      { id: DOOR, label: "Kho bảo mật", enabled: false, apiToken: DOOR_TOKEN },
      { id: DOOR2, label: "Kho phụ", enabled: false },
    ]);
    assert.equal(doors.status, 200, doors.text.slice(0, 300));
    // Door "main" (legacy top-level fields) with a token too, still disabled.
    const main = await admin("POST", "/api/door-controller/config", { apiToken: MAIN_TOKEN, enabled: false });
    assert.equal(main.status, 200, main.text.slice(0, 300));

    await createGate(GATE, "ENTRY", DOOR);
    // A stream with a camera password on the new gate (never dialled: disabled, refused port).
    const cam = await admin("POST", `/api/camera-streams/${GATE}/streams`, {
      id: `${GATE}-cam`,
      label: "itest cam",
      rtspUrl: `rtsp://itest:${CAM_SECRET}@${UNREACHABLE_HOST}:1/ngsec`,
      enabled: false,
    });
    assert.equal(cam.status, 201, cam.text.slice(0, 300));

    employeeId = (await createTempEmployee({ name: `NGSEC fixture ${RUN}` })).id;
    for (const d of ["main", DOOR, DOOR2]) await admin("POST", "/api/lock/lock", { doorId: d, source: "itest ngsec baseline" });
  });

  after(async () => {
    for (const d of ["main", DOOR, DOOR2]) await admin("POST", "/api/lock/lock", { doorId: d, source: "itest ngsec cleanup" });
    await deleteGate(GATE);
    await setDoors([]);
    if (mainBefore) {
      await admin("POST", "/api/door-controller/config", {
        enabled: mainBefore.enabled,
        apiUrl: mainBefore.apiUrl || "",
        authHeaderType: mainBefore.authHeaderType,
        apiToken: "",
      });
    }
    if (employeeId) await deleteEmployee(employeeId);
    for (const id of accounts) await admin("DELETE", `/api/users/${id}`);
  });

  // =========================================================================
  // 1. AuthN / AuthZ / CSRF
  // =========================================================================
  describe("1. authorization matrix", () => {
    interface Probe {
      name: string;
      method: string;
      path: () => string;
      /** Least role allowed (auth.ts + contract). */
      min: Exclude<Role, "anon">;
      /** Body for refused roles: a VALID mutation, so a bypass would show as a state change. */
      deny?: () => unknown;
      /** Path/body for the allowed roles: harmless (invalid input or unknown id). */
      allowPath?: () => string;
      allow?: () => unknown;
      /** Allowed statuses for the allowed roles. */
      expect?: number[];
    }
    const probes: Probe[] = [
      { name: "GET /api/gates", method: "GET", path: () => "/api/gates", min: "viewer", expect: [200] },
      {
        name: "POST /api/gates", method: "POST", path: () => "/api/gates", min: "admin",
        deny: () => ({ id: `deny-${RUN}`, label: "deny", direction: "ENTRY" }),
        allow: () => ({ id: "Bad_Id", label: "x", direction: "ENTRY" }), expect: [400],
      },
      {
        name: "PUT /api/gates/:gateId", method: "PUT", path: () => `/api/gates/${GATE}`, min: "admin",
        deny: () => ({ enabled: false, doorId: DOOR2, direction: "EXIT" }),
        allow: () => ({ label: "" }), expect: [400],
      },
      {
        name: "DELETE /api/gates/:gateId", method: "DELETE", path: () => `/api/gates/${GATE}`, min: "admin",
        deny: () => ({}), allowPath: () => "/api/gates/entry", allow: () => ({}), expect: [400],
      },
      { name: "GET /api/camera-streams/:gateId/streams", method: "GET", path: () => `/api/camera-streams/${GATE}/streams`, min: "viewer", expect: [200] },
      {
        name: "POST /api/camera-streams/:gateId/streams", method: "POST", path: () => `/api/camera-streams/${GATE}/streams`, min: "operator",
        deny: () => ({ id: `${GATE}-deny`, rtspUrl: unreachableRtsp("deny"), enabled: false }),
        allow: () => ({ id: "bad id!", rtspUrl: unreachableRtsp("x") }), expect: [400],
      },
      {
        name: "PUT /api/camera-streams/:gateId/streams/:id", method: "PUT", path: () => `/api/camera-streams/${GATE}/streams/${GATE}-primary`, min: "operator",
        deny: () => ({ label: "denied label" }),
        allowPath: () => `/api/camera-streams/${GATE}/streams/no-such-stream`, allow: () => ({ label: "x" }), expect: [404],
      },
      {
        name: "DELETE /api/camera-streams/:gateId/streams/:id", method: "DELETE", path: () => `/api/camera-streams/${GATE}/streams/${GATE}-cam`, min: "operator",
        deny: () => ({}), allowPath: () => `/api/camera-streams/${GATE}/streams/no-such-stream`, allow: () => ({}), expect: [404],
      },
      {
        name: "POST /api/camera-streams/:gateId/watch", method: "POST", path: () => `/api/camera-streams/${GATE}/watch`, min: "operator",
        deny: () => ({ enabled: false, intervalSeconds: 9 }),
        allow: () => ({ intervalSeconds: -5 }), expect: [400],
      },
      {
        name: "POST /api/camera-streams/:gateId/pipeline-mode", method: "POST", path: () => `/api/camera-streams/${GATE}/pipeline-mode`, min: "admin",
        deny: () => ({ mode: "shadow" }),
        allow: () => ({ mode: "bogus" }), expect: [400],
      },
      {
        name: "GET /api/camera-streams/snapshot?gate=", method: "GET", path: () => `/api/camera-streams/snapshot?gate=${GATE}`, min: "operator",
        expect: [302, 303], // the gate's primary stream has no URL: placeholder redirect, nothing dialled
      },
      {
        name: "POST /api/camera-streams/scan-rtsp {gate}", method: "POST", path: () => "/api/camera-streams/scan-rtsp", min: "operator",
        deny: () => ({ gate: GATE }), allow: () => ({ gate: GATE }), expect: [400, 503], // no enabled RTSP stream
      },
      {
        name: "POST /api/employees/:id/templates/capture {gate}", method: "POST", path: () => `/api/employees/${employeeId}/templates/capture`, min: "operator",
        deny: () => ({ gate: GATE }), allow: () => ({ gate: GATE }), expect: [400, 503], // primary stream is not RTSP
      },
      { name: "GET /api/door-controller/config", method: "GET", path: () => "/api/door-controller/config", min: "admin", expect: [200] },
      {
        name: "POST /api/door-controller/config", method: "POST", path: () => "/api/door-controller/config", min: "admin",
        deny: () => ({ doors: [{ id: "main" }, { id: DOOR }, { id: DOOR2 }, { id: `deny-door-${RUN}` }] }),
        allow: () => ({ doors: "not-a-list" }), expect: [400],
      },
      {
        name: "POST /api/door-controller/test {doorId}", method: "POST", path: () => "/api/door-controller/test", min: "admin",
        deny: () => ({ doorId: DOOR, action: "OPEN", updateDoorState: true }),
        allow: () => ({ doorId: "Bad_Door" }), expect: [400],
      },
      { name: "GET /api/lock/state?doorId=", method: "GET", path: () => `/api/lock/state?doorId=${DOOR}`, min: "viewer", expect: [200] },
      { name: "GET /api/lock/status?doorId=", method: "GET", path: () => `/api/lock/status?doorId=${DOOR}`, min: "viewer", expect: [200] },
      { name: "GET /api/lock/states", method: "GET", path: () => "/api/lock/states", min: "viewer", expect: [200] },
      {
        name: "POST /api/lock/unlock {doorId}", method: "POST", path: () => "/api/lock/unlock", min: "admin",
        deny: () => ({ doorId: DOOR, source: "itest deny" }), allow: () => ({ doorId: "Bad_Door" }), expect: [400],
      },
      {
        name: "POST /api/lock/lock {doorId}", method: "POST", path: () => "/api/lock/lock", min: "admin",
        deny: () => ({ doorId: DOOR2, source: "itest deny" }), allow: () => ({ doorId: "Bad_Door" }), expect: [400],
      },
      { name: "GET /api/logs?gateId=", method: "GET", path: () => `/api/logs?gateId=${GATE}`, min: "viewer", expect: [200] },
      { name: "GET /api/logs/stats?gateId=", method: "GET", path: () => `/api/logs/stats?gateId=${GATE}`, min: "viewer", expect: [200] },
      { name: "GET /api/logs/export.csv?gateId=", method: "GET", path: () => `/api/logs/export.csv?gateId=${GATE}`, min: "viewer", expect: [200] },
      { name: "GET /api/recordings/config", method: "GET", path: () => "/api/recordings/config", min: "viewer", expect: [200] },
      { name: "GET /api/camera-streams/watch", method: "GET", path: () => "/api/camera-streams/watch", min: "viewer", expect: [200] },
    ];

    let snapshotBefore: any = null;
    const snapshotState = async () => ({
      gate: await gateSummary(GATE),
      gateFull: (await fullConfig()).gates.find((g: any) => g.id === GATE),
      gateIds: (await gatesList()).map((g) => g.id),
      doors: (await doorCfg()).doors.map((d: any) => d.id),
      door: await lockOf(DOOR),
      door2: await lockOf(DOOR2),
    });
    before(async () => {
      snapshotBefore = await snapshotState();
    });

    for (const p of probes) {
      it(`${p.name}: anonymous 401, lower roles 403, allowed roles reach the route`, async () => {
        for (const role of ["anon", "viewer", "operator", "admin"] as Role[]) {
          const allowed = RANK[role] >= RANK[p.min];
          const isRead = p.method === "GET";
          const path = allowed && p.allowPath ? p.allowPath() : p.path();
          const body = isRead ? undefined : allowed ? (p.allow ?? p.deny)?.() : p.deny?.();
          const res = await call(role, p.method, path, body);
          const label = `${role} ${p.method} ${path} -> ${res.status} ${res.text.slice(0, 160)}`;
          if (role === "anon") {
            assert.equal(res.status, 401, label);
          } else if (!allowed) {
            assert.equal(res.status, 403, label);
            assert.equal(res.body?.code, "ROLE_REQUIRED", label);
          } else {
            assert.ok(![401, 403, 500].includes(res.status), label);
            if (p.expect) assert.ok(p.expect.includes(res.status), label);
          }
        }
      });
    }

    for (const p of probes.filter((x) => x.method !== "GET")) {
      it(`${p.name}: CSRF, origin and JSON are enforced for the allowed role`, async () => {
        const role = p.min;
        const body = p.deny?.() ?? {};
        const noCsrf = await call(role, p.method, p.path(), body, { noCsrf: true });
        assert.equal(noCsrf.status, 403, noCsrf.text.slice(0, 160));
        assert.equal(noCsrf.body?.code, "CSRF_REQUIRED");
        const wrong = await call(role, p.method, p.path(), body, { csrf: "itest-not-the-token" });
        assert.equal(wrong.status, 403);
        assert.equal(wrong.body?.code, "CSRF_REQUIRED");
        const evil = await call(role, p.method, p.path(), body, { origin: "http://evil.test" });
        assert.equal(evil.status, 403);
        assert.equal(evil.body?.code, "ORIGIN_FORBIDDEN");
        const text = await call(role, p.method, p.path(), body, { contentType: "text/plain" });
        assert.equal(text.status, 415);
      });
    }

    it("nothing changed: refused and CSRF-less requests had no effect", async () => {
      const now = await snapshotState();
      assert.deepEqual(now.gateIds, snapshotBefore.gateIds, "gate list");
      assert.deepEqual(now.doors, snapshotBefore.doors, "door list");
      assert.equal(now.gate.enabled, true);
      assert.equal(now.gate.direction, "ENTRY");
      assert.equal(now.gate.doorId, DOOR);
      assert.equal(now.gate.pipelineMode, undefined, "pipeline mode untouched");
      assert.deepEqual(now.gate.watch, snapshotBefore.gate.watch, "watch untouched");
      assert.deepEqual(now.gateFull.streams.map((s: any) => [s.id, s.label]), snapshotBefore.gateFull.streams.map((s: any) => [s.id, s.label]));
      assert.equal(now.door.state, "LOCKED");
      assert.equal(now.door.lastActionAt, snapshotBefore.door.lastActionAt, "door not operated");
      assert.equal(now.door2.lastActionAt, snapshotBefore.door2.lastActionAt, "door 2 not operated");
    });

    it("path case variants fail closed exactly like the canonical paths", async () => {
      const upper = GATE.toUpperCase();
      const adminOnly: Array<[string, string, unknown]> = [
        ["POST", "/API/Gates", { id: `case-${RUN}`, label: "x", direction: "ENTRY" }],
        ["PUT", `/api/GATES/${GATE}`, { enabled: false }],
        ["PUT", `/api/gates/${upper}`, { enabled: false }],
        ["DELETE", `/Api/Gates/${upper}`, {}],
        ["POST", `/API/CAMERA-STREAMS/${upper}/PIPELINE-MODE`, { mode: "shadow" }],
        ["POST", "/API/Lock/Unlock", { doorId: DOOR }],
        ["POST", "/api/LOCK/lock", { doorId: DOOR2 }],
        ["POST", "/API/Door-Controller/Config", { doors: [{ id: "main" }] }],
        ["GET", "/API/Door-Controller/Config", undefined],
        ["GET", "/api/DOOR-CONFIG", undefined],
      ];
      for (const [method, path, body] of adminOnly) {
        assert.equal((await call("anon", method, path, body)).status, 401, `anon ${method} ${path}`);
        for (const role of ["viewer", "operator"] as Role[]) {
          const res = await call(role, method, path, body);
          assert.equal(res.status, 403, `${role} ${method} ${path}: ${res.text.slice(0, 160)}`);
        }
      }
      for (const [method, path, body] of [
        ["POST", `/API/Camera-Streams/${upper}/Streams`, { id: `${GATE}-case`, rtspUrl: unreachableRtsp("case"), enabled: false }],
        ["POST", `/api/camera-streams/${upper}/WATCH`, { enabled: false, intervalSeconds: 9 }],
        ["GET", `/API/Camera-Streams/Snapshot?gate=${GATE}`, undefined],
        ["POST", "/API/CAMERA-STREAMS/SCAN-RTSP", { gate: GATE }],
      ] as Array<[string, string, unknown]>) {
        assert.equal((await call("anon", method, path, body)).status, 401, `anon ${method} ${path}`);
        assert.equal((await call("viewer", method, path, body)).status, 403, `viewer ${method} ${path}`);
      }
      for (const path of ["/API/GATES", `/Api/Lock/State?doorId=${DOOR}`, `/API/LOGS?gateId=${GATE}`, "/api/Logs/Export.csv", "/API/Recordings/Config"]) {
        assert.equal((await call("anon", "GET", path)).status, 401, `anon GET ${path}`);
      }

      // Routing is case-sensitive (server.ts "case sensitive routing"): for the
      // admin a re-spelled ROUTE is a 404 that does nothing; a re-spelled gate
      // id PARAMETER names the same gate (documented lower-casing), never entry.
      for (const [method, path, body] of [
        ["GET", "/API/GATES", undefined],
        ["PUT", `/api/GATES/${GATE}`, { enabled: false }],
        ["DELETE", `/Api/Gates/${GATE}`, {}],
        ["POST", `/api/camera-streams/${GATE}/Pipeline-Mode`, { mode: "shadow" }],
        ["POST", "/API/Lock/Unlock", { doorId: DOOR }],
      ] as Array<[string, string, unknown]>) {
        const res = await admin(method, path, body);
        if (method === "GET") {
          // Not an API route: the SPA shell (index.html) or a 404, never the gate data.
          assert.ok(res.status === 404 || /text\/html/.test(res.headers.get("content-type") || ""), `admin GET ${path}: ${res.status}`);
          assert.equal(res.body?.gates, undefined, "no gate data under a re-spelled route");
        } else {
          assert.equal(res.status, 404, `admin ${method} ${path}: ${res.text.slice(0, 160)}`);
        }
      }
      const streams = await admin("GET", `/api/camera-streams/${upper}/streams`);
      assert.equal(streams.status, 200, streams.text.slice(0, 200));
      assert.equal(streams.body.gate.id, GATE, "an upper-case gate id names the same gate, never entry");
      const relabel = await admin("PUT", `/api/gates/${upper}`, { label: "Cổng bảo mật" });
      assert.equal(relabel.status, 200, relabel.text.slice(0, 200));
      assert.equal(relabel.body.summary.id, GATE);
      assert.equal((await admin("DELETE", "/api/gates/ENTRY")).status, 400, "a spelling of a permanent gate is still permanent");
      assert.equal((await admin("DELETE", "/api/gates/Exit/")).status, 400);
      assert.equal((await lockOf(DOOR)).state, "LOCKED");

      const s = await gateSummary(GATE);
      assert.equal(s.enabled, true, "no case variant disabled the gate");
      assert.equal(s.pipelineMode, undefined);
      assert.ok(!(await gatesList()).some((g) => g.id === `case-${RUN}`));
      assert.ok(!(await fullConfig()).gates.find((g: any) => g.id === GATE).streams.some((x: any) => x.id === `${GATE}-case`));
    });
  });

  // =========================================================================
  // 2. Input validation / injection
  // =========================================================================
  describe("2. input validation", () => {
    const badGateIds: unknown[] = [
      "../entry", "entry/../exit", "..", "Side", "SIDE-DOOR", "cửa-hông", "ｓide", "a".repeat(33), "", " ", "a",
      "1gate", "-gate", "gate_", "gate.x", "gate x", "x';drop table access_logs;--", 'x" OR 1=1', "gate%2F", "entry\u0000",
      "config", "watch", "snapshot", "scan-rtsp", "test-stream", "test-frame", "benchmark", "streams", "all", "threads",
      null, 42, ["entry"], { id: "entry" }, true,
    ];

    it("POST /api/gates refuses every malformed or reserved id with 400 and creates nothing", async () => {
      const before = (await gatesList()).map((g) => g.id);
      for (const id of badGateIds) {
        const res = await admin("POST", "/api/gates", { id, label: "x", direction: "ENTRY" });
        assert.equal(res.status, 400, `${JSON.stringify(id)} -> ${res.status} ${res.text.slice(0, 160)}`);
      }
      assert.deepEqual((await gatesList()).map((g) => g.id), before);
    });

    it("a 32-character id is the longest accepted (boundary)", async () => {
      const id = `b${RUN}`.padEnd(32, "x");
      assert.equal(id.length, 32);
      await createGate(id);
      assert.equal((await deleteGate(id)).status, 200);
    });

    it("refuses wrong JSON types and malformed bodies with 400", async () => {
      const cases: unknown[] = [
        { id: `t1-${RUN}`, label: "x", direction: "entry" },
        { id: `t2-${RUN}`, label: "x", direction: ["ENTRY"] },
        { id: `t3-${RUN}`, label: "x", direction: "ENTRY", doorId: ["main"] },
        { id: `t4-${RUN}`, label: "x", direction: "ENTRY", doorId: 1 },
        { id: `t5-${RUN}`, label: "   ", direction: "ENTRY" },
        [{ id: `t6-${RUN}`, label: "x", direction: "ENTRY" }],
      ];
      for (const body of cases) {
        const res = await admin("POST", "/api/gates", body);
        assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.text.slice(0, 160)}`);
      }
      const broken = await call("admin", "POST", "/api/gates", undefined, { rawBody: "{not json" });
      assert.equal(broken.status, 400, broken.text.slice(0, 160));
      for (const body of [{ enabled: "false" }, { direction: "IN" }, { label: "" }, { doorId: "Bad_Door" }]) {
        assert.equal((await admin("PUT", `/api/gates/${GATE}`, body)).status, 400, JSON.stringify(body));
      }
      assert.ok(!(await gatesList()).some((g) => String(g.id).startsWith("t") && String(g.id).endsWith(RUN)));
    });

    it("a malformed or unknown gate in a PATH is 400 (never 2xx/500, never applied to entry)", async () => {
      const entryWatch = (await gateSummary("entry")).watch;
      const segments = ["lobby", "Bad_Gate", "..%2Fentry", "entry%2F..", "c%E1%BB%ADa", "a".repeat(33), "x'%20OR%20'1'%3D'1", "entry%00", "entry;", "%2Fentry"];
      for (const seg of segments) {
        const routes: Array<[string, string, unknown]> = [
          ["GET", `/api/camera-streams/${seg}/streams`, undefined],
          ["POST", `/api/camera-streams/${seg}/streams`, { id: `x-${RUN}`, rtspUrl: unreachableRtsp("x"), enabled: false }],
          ["PUT", `/api/camera-streams/${seg}/streams/entry-primary`, { label: "hijack" }],
          ["DELETE", `/api/camera-streams/${seg}/streams/entry-primary`, {}],
          ["POST", `/api/camera-streams/${seg}/watch`, { enabled: false, intervalSeconds: 9 }],
          ["POST", `/api/camera-streams/${seg}/pipeline-mode`, { mode: "shadow" }],
          ["PUT", `/api/gates/${seg}`, { label: "hijack" }],
          ["DELETE", `/api/gates/${seg}`, {}],
        ];
        for (const [method, path, body] of routes) {
          const res = await admin(method, path, body);
          const ok = seg === "lobby" ? res.status === 400 : res.status === 400 || res.status === 404;
          assert.ok(ok, `${method} ${path} -> ${res.status} ${res.text.slice(0, 160)}`);
        }
      }
      const entry = await gateSummary("entry");
      assert.deepEqual(entry.watch, entryWatch, "entry's watch was never touched");
      assert.equal(entry.pipelineMode, undefined);
      assert.notEqual(entry.label, "hijack");
    });

    it("a malformed or unknown gate in a QUERY or BODY is 400 (snapshot, scan-rtsp, capture, recognize, logs)", async () => {
      const values: unknown[] = ["lobby", "../entry", "Bad_Gate", "cửa", "a".repeat(33), "x' OR '1'='1", ["entry"], { $ne: null }, 0, true];
      for (const v of values) {
        const q = typeof v === "string" ? `gate=${encodeURIComponent(v)}` : Array.isArray(v) ? "gate[]=entry" : "gate[$ne]=x";
        const snap = await call("admin", "GET", `/api/camera-streams/snapshot?${q}`);
        assert.equal(snap.status, 400, `snapshot ${q}: ${snap.status}`);
        const scan = await admin("POST", "/api/camera-streams/scan-rtsp", { gate: v });
        assert.equal(scan.status, 400, `scan ${JSON.stringify(v)}: ${scan.text.slice(0, 160)}`);
        const cap = await admin("POST", `/api/employees/${employeeId}/templates/capture`, { gate: v });
        assert.ok([400, 503].includes(cap.status), `capture ${JSON.stringify(v)}: ${cap.status}`);
        if (v !== 0 && v !== true) {
          // (falsy/blank gateId = the legacy scanType path, by contract)
          const rec = await admin("POST", "/api/recognize-face", { imageBase64: noFaceJpegDataUrl(64, 8100), gateId: v });
          assert.equal(rec.status, 400, `recognize ${JSON.stringify(v)}: ${rec.text.slice(0, 160)}`);
          assert.ok(!rec.body?.log, "no event written for a bad gate");
        }
        const lq = typeof v === "string" ? `gateId=${encodeURIComponent(v)}` : Array.isArray(v) ? "gateId=entry&gateId=exit" : "gateId[$ne]=x";
        for (const route of ["/api/logs", "/api/logs/stats", "/api/logs/export.csv"]) {
          const res = await admin("GET", `${route}?${lq}`);
          if (v === "lobby") {
            assert.equal(res.status, 200, `${route} ${lq}: a well-formed unknown id is a valid (empty) filter`);
          } else {
            assert.equal(res.status, 400, `${route} ${lq}: ${res.status} ${res.text.slice(0, 120)}`);
          }
        }
      }
      // SQL metacharacters that ARE a valid slug are parameters, not SQL.
      const dashes = await admin("GET", "/api/logs?gateId=entry--");
      assert.equal(dashes.status, 200);
      assert.equal(dashes.body.total, 0);
    });

    it("door ids: malformed ids are 400 in the door list, the lock routes and the gate binding", async () => {
      const bad: unknown[] = ["../main", "MAIN", "Main", "khö", "a".repeat(33), "x' OR '1'='1", "m", "1door", "door_1", ["main"], { id: "main" }, 7, true];
      const doorsBefore = (await doorCfg()).doors.map((d: any) => d.id);
      const mainBefore = await lockOf("main");
      for (const id of bad) {
        const list = await admin("POST", "/api/door-controller/config", { doors: [{ id: "main" }, { id }] });
        assert.equal(list.status, 400, `doors ${JSON.stringify(id)}: ${list.text.slice(0, 160)}`);
        const unlock = await admin("POST", "/api/lock/unlock", { doorId: id, source: "itest bad door" });
        assert.equal(unlock.status, 400, `unlock ${JSON.stringify(id)}`);
        const lock = await admin("POST", "/api/lock/lock", { doorId: id, source: "itest bad door" });
        assert.equal(lock.status, 400, `lock ${JSON.stringify(id)}`);
        const test = await admin("POST", "/api/door-controller/test", { doorId: id, action: "OPEN" });
        assert.equal(test.status, 400, `door test ${JSON.stringify(id)}`);
        const gate = await admin("POST", "/api/gates", { id: `bd-${RUN}`, label: "x", direction: "ENTRY", doorId: id });
        assert.equal(gate.status, 400, `gate binding ${JSON.stringify(id)}`);
        const put = await admin("PUT", `/api/gates/${GATE}`, { doorId: id });
        assert.equal(put.status, 400, `rebinding ${JSON.stringify(id)}`);
        if (typeof id === "string") {
          for (const route of ["/api/lock/state", "/api/lock/status"]) {
            assert.equal((await admin("GET", `${route}?doorId=${encodeURIComponent(id)}`)).status, 400, `${route} ${id}`);
          }
        }
      }
      for (const q of ["doorId=main&doorId=x", "doorId[$ne]=x", "doorId[]=main"]) {
        assert.equal((await admin("GET", `/api/lock/state?${q}`)).status, 400, q);
      }
      // A well-formed but unknown door is refused the same way.
      assert.equal((await admin("POST", "/api/lock/unlock", { doorId: `nodoor-${RUN}` })).status, 400);
      assert.equal((await admin("GET", `/api/lock/state?doorId=nodoor-${RUN}`)).status, 400);
      assert.equal((await admin("POST", "/api/door-controller/config", { doors: Array.from({ length: 17 }, (_, i) => ({ id: `d${i}-${RUN}` })) })).status, 400, "MAX_DOORS");
      assert.deepEqual((await doorCfg()).doors.map((d: any) => d.id), doorsBefore);
      assert.equal((await lockOf("main")).lastActionAt, mainBefore.lastActionAt, "door main never moved");
      assert.equal((await gateSummary(GATE)).doorId, DOOR);
      assert.ok(!(await gatesList()).some((g) => g.id === `bd-${RUN}`));
    });

    it("MAX_GATES (16) is enforced, also under concurrent creates", async () => {
      const listed = await admin("GET", "/api/gates");
      assert.equal(listed.body.max, 16);
      const made: string[] = [];
      try {
        let n = listed.body.gates.length;
        let i = 0;
        while (n < 16) {
          const id = `max-${RUN}-${i++}`;
          await createGate(id);
          made.push(id);
          n++;
        }
        const over = await admin("POST", "/api/gates", { id: `max-${RUN}-over`, label: "x", direction: "ENTRY" });
        assert.equal(over.status, 400, over.text.slice(0, 160));
        const burst = await Promise.all([0, 1, 2, 3].map((k) => admin("POST", "/api/gates", { id: `max-${RUN}-b${k}`, label: "x", direction: "EXIT" })));
        assert.deepEqual(burst.map((r) => r.status), [400, 400, 400, 400]);
        assert.equal((await gatesList()).length, 16);
        assert.equal((await runtimeIds()).length, 16, "one runtime per configured gate");
      } finally {
        for (const id of made) await deleteGate(id);
      }
    });

    it("duplicates are 409; a deleted id is 409 forever (any direction); an upper-case retry is 400", async () => {
      assert.equal((await admin("POST", "/api/gates", { id: GATE, label: "dup", direction: "ENTRY" })).status, 409);
      assert.equal((await admin("POST", "/api/gates", { id: "exit", label: "dup", direction: "EXIT" })).status, 409);
      const id = `del-${RUN}`;
      await createGate(id, "ENTRY");
      assert.equal((await deleteGate(id)).status, 200);
      for (const direction of ["ENTRY", "EXIT"]) {
        const again = await admin("POST", "/api/gates", { id, label: "again", direction });
        assert.equal(again.status, 409, `${direction}: ${again.text.slice(0, 160)}`);
      }
      assert.equal((await admin("POST", "/api/gates", { id: id.toUpperCase(), label: "again", direction: "ENTRY" })).status, 400);
      assert.equal((await admin("POST", "/api/gates", { id: ` ${id} `, label: "again", direction: "ENTRY" })).status, 409, "whitespace does not dodge the tombstone");
    });

    it("entry/exit: undeletable under any spelling, direction fixed through every route", async () => {
      for (const path of ["/api/gates/entry", "/api/gates/EXIT", "/api/gates/Entry/", "/API/GATES/exit"]) {
        const res = await admin("DELETE", path);
        assert.ok([400, 404].includes(res.status), `${path}: ${res.status}`);
      }
      const burst = await Promise.all([0, 1, 2, 3, 4].map(() => admin("DELETE", "/api/gates/entry")));
      assert.ok(burst.every((r) => r.status === 400));
      assert.equal((await admin("PUT", "/api/gates/ENTRY", { direction: "EXIT" })).status, 400);
      assert.equal((await admin("PUT", "/api/gates/exit", { direction: "ENTRY" })).status, 400);
      const viaGates = await call("operator", "POST", "/api/camera-streams/config", { gates: [{ id: "entry", direction: "EXIT", gateType: "EXIT" }] });
      assert.equal(viaGates.status, 200, viaGates.text.slice(0, 160));
      const viaLegacy = await call("operator", "POST", "/api/camera-streams/config", { exitGate: { gateType: "ENTRY", direction: "ENTRY" } });
      assert.equal(viaLegacy.status, 200, viaLegacy.text.slice(0, 160));
      const viaGatesThird = await call("operator", "POST", "/api/camera-streams/config", { gates: [{ id: GATE, direction: "EXIT", doorId: "main" }] });
      assert.equal(viaGatesThird.status, 200);
      const list = await gatesList();
      assert.deepEqual(list.slice(0, 2).map((g) => [g.id, g.direction, g.permanent]), [["entry", "ENTRY", true], ["exit", "EXIT", true]]);
      const third = list.find((g) => g.id === GATE);
      assert.equal(third.direction, "ENTRY", "an operator cannot change a gate's direction");
      assert.equal(third.doorId, DOOR, "an operator cannot rebind a gate's door");
      const w = (await admin("GET", "/api/camera-streams/watch")).body.watchers;
      assert.equal(w.find((r: any) => r.gateId === "entry").gate, "ENTRY");
      assert.equal(w.find((r: any) => r.gateId === "exit").gate, "EXIT");
    });

    it("FINDING NGSEC-5: a non-string label/id is a 400 - never stored as \"[object Object]\", never a 500", async () => {
      const id = `lbl-${RUN}`;
      const results: string[] = [];
      const check = async (what: string, res: ApiResponse, cleanup?: () => Promise<unknown>) => {
        if (res.status >= 200 && res.status < 300 && cleanup) await cleanup();
        results.push(`${what} -> ${res.status}${res.status === 500 ? ` (${res.body?.error})` : ""}${res.body?.summary?.label ? ` label=${JSON.stringify(res.body.summary.label)}` : ""}`);
        return res.status === 400;
      };
      const oks = [
        await check("POST /api/gates label {a:1}", await admin("POST", "/api/gates", { id, label: { a: 1 }, direction: "ENTRY" }), () => deleteGate(id)),
        await check("POST /api/gates label {toString:'x'}", await admin("POST", "/api/gates", { id: `${id}-2`, label: { toString: "x" }, direction: "ENTRY" }), () => deleteGate(`${id}-2`)),
        await check("PUT /api/gates label ['a','b']", await admin("PUT", `/api/gates/${GATE}`, { label: ["a", "b"] }), () => admin("PUT", `/api/gates/${GATE}`, { label: "Cổng bảo mật" })),
        await check("PUT /api/gates label {toString:'x'}", await admin("PUT", `/api/gates/${GATE}`, { label: { toString: "x" } })),
        await check("door label {toString:'x'}", await admin("POST", "/api/door-controller/config", { doors: [{ id: "main" }, { id: DOOR }, { id: DOOR2, label: { toString: "x" } }] })),
        await check("operator stream label {toString:'x'}", await call("operator", "POST", `/api/camera-streams/${GATE}/streams`, { id: `${GATE}-lbl`, label: { toString: "x" }, rtspUrl: unreachableRtsp("lbl"), enabled: false }), () => admin("DELETE", `/api/camera-streams/${GATE}/streams/${GATE}-lbl`)),
        await check("operator stream id {toString:'x'}", await call("operator", "POST", `/api/camera-streams/${GATE}/streams`, { id: { toString: "x" }, rtspUrl: unreachableRtsp("lbl2"), enabled: false })),
      ];
      assert.ok(oks.every(Boolean), results.join("\n"));
    });

    it("FINDING NGSEC-4: a Unicode spelling (KELVIN SIGN U+212A) does not resolve to an ASCII gate", async () => {
      const kelvin = `K${GATE.slice(1)}`; // "Ksec-..." with U+212A; String#toLowerCase() maps it to "k"
      const unknownGate = (r: ApiResponse) => r.status === 400 && /Cổng không hợp lệ/.test(String(r.body?.error));
      const path = await admin("GET", `/api/camera-streams/${encodeURIComponent(kelvin)}/streams`);
      const scan = await admin("POST", "/api/camera-streams/scan-rtsp", { gate: kelvin });
      const rec = await admin("POST", "/api/recognize-face", { imageBase64: noFaceJpegDataUrl(64, 8150), gateId: kelvin });
      const put = await admin("PUT", `/api/gates/${encodeURIComponent(kelvin)}`, {});
      const resolved = { path: !unknownGate(path), scan: !unknownGate(scan), recognize: !unknownGate(rec), put: !unknownGate(put) };
      assert.deepEqual(
        resolved,
        { path: false, scan: false, recognize: false, put: false },
        `U+212A spelling resolved to "${GATE}": GET streams ${path.status} (gate ${path.body?.gate?.id}), scan-rtsp ${scan.status} ` +
          `(${String(scan.body?.error).slice(0, 60)}), recognize-face ${rec.status} (event at ${rec.body?.log?.gateId}), PUT /api/gates ${put.status}`
      );
    });
  });

  // =========================================================================
  // 3. Secrets
  // =========================================================================
  describe("3. secrets never leave the server", () => {
    let sse: SseCapture | null = null;
    before(async () => {
      sse = await openSse(sessions.viewer);
      assert.equal(sse.status, 200);
    });
    after(async () => {
      await sse?.close();
    });

    it("door tokens: hasApiToken only, in GET/POST echo, doors list, lock states, door test and gates", async () => {
      const get = await admin("GET", "/api/door-controller/config");
      const d = get.body.doors.find((x: any) => x.id === DOOR);
      assert.equal(d.hasApiToken, true);
      assert.equal(get.body.hasApiToken, true, "door main (top level) has its token");
      assert.equal(get.body.doors[0].hasApiToken, true, "door main in the list mirrors it");
      assert.ok(!get.body.doors.find((x: any) => x.id === DOOR2).hasApiToken);
      for (const res of [
        get,
        await admin("POST", "/api/door-controller/config", { doors: [{ id: "main" }, { id: DOOR }, { id: DOOR2 }] }),
        await admin("POST", "/api/door-controller/test", { doorId: DOOR, action: "OPEN", source: "itest ngsec" }),
        await admin("POST", "/api/door-controller/test", { doorId: "main", action: "CLOSE", source: "itest ngsec" }),
        await admin("GET", "/api/lock/states"),
        await admin("GET", `/api/lock/state?doorId=${DOOR}`),
        await admin("GET", "/api/gates"),
        await admin("PUT", `/api/gates/${GATE}`, { doorId: DOOR }),
        await admin("GET", "/api/door-controller/logs"),
      ]) {
        assert.ok(!res.text.includes(DOOR_TOKEN) && !res.text.includes(MAIN_TOKEN), `token in ${res.status} ${res.text.slice(0, 120)}`);
        assert.doesNotMatch(res.text, /"apiToken"\s*:/, "no apiToken key in any answer");
      }
    });

    it("omitting the token keeps it, \"\" clears it (per door and for main), and the door test refuses a disabled door", async () => {
      const keep = await admin("POST", "/api/door-controller/config", { doors: [{ id: "main" }, { id: DOOR, label: "Kho bảo mật" }, { id: DOOR2 }] });
      assert.equal(keep.status, 200);
      assert.equal(keep.body.config.doors.find((x: any) => x.id === DOOR).hasApiToken, true, "omitted = kept");
      // Echoing what the server sent (hasApiToken / apiTokenConfigured) never sets a token.
      const echo = await admin("POST", "/api/door-controller/config", {
        doors: keep.body.config.doors.map((x: any) => ({ ...x, apiTokenConfigured: true })),
      });
      assert.equal(echo.status, 200, echo.text.slice(0, 160));
      assert.equal(echo.body.config.doors.find((x: any) => x.id === DOOR2).hasApiToken, false, "an echo of hasApiToken sets nothing");
      const cleared = await admin("POST", "/api/door-controller/config", { doors: [{ id: "main" }, { id: DOOR, apiToken: "" }, { id: DOOR2 }] });
      assert.equal(cleared.body.config.doors.find((x: any) => x.id === DOOR).hasApiToken, false, "\"\" clears");
      const reset = await admin("POST", "/api/door-controller/config", { doors: [{ id: "main" }, { id: DOOR, apiToken: DOOR_TOKEN }, { id: DOOR2 }] });
      assert.equal(reset.body.config.doors.find((x: any) => x.id === DOOR).hasApiToken, true);
      // Legacy top-level POST = door main.
      const mainKeep = await admin("POST", "/api/door-controller/config", { enabled: false });
      assert.equal(mainKeep.body.config.hasApiToken, true);
      const mainClear = await admin("POST", "/api/door-controller/config", { apiToken: "" });
      assert.equal(mainClear.body.config.hasApiToken, false);
      assert.equal(mainClear.body.config.doors.find((x: any) => x.id === DOOR).hasApiToken, true, "clearing main leaves other doors alone");
      const mainSet = await admin("POST", "/api/door-controller/config", { apiToken: MAIN_TOKEN });
      assert.equal(mainSet.body.config.hasApiToken, true);
    });

    it("a credential or token inside the controller URL is redacted in every answer", async () => {
      const url = `https://ngsec:${URL_SECRET}@itest-ngsec-door-${RUN}.invalid/open?token=${URL_SECRET}q`;
      const saved = await admin("POST", "/api/door-controller/config", { doors: [{ id: "main" }, { id: DOOR, apiUrl: url }, { id: DOOR2 }] });
      assert.equal(saved.status, 200, saved.text.slice(0, 200));
      const get = await admin("GET", "/api/door-controller/config");
      const test = await admin("POST", "/api/door-controller/test", { doorId: DOOR, action: "OPEN" });
      for (const res of [saved, get, test]) assert.ok(!res.text.includes(URL_SECRET), `URL secret in ${res.text.slice(0, 160)}`);
      await admin("POST", "/api/door-controller/config", { doors: [{ id: "main" }, { id: DOOR, apiUrl: "" }, { id: DOOR2 }] });
    });

    it("camera password of the new gate's stream: redacted in config, streams, gates, watch, scan and refusals", async () => {
      for (const res of [
        await admin("GET", "/api/camera-streams/config"),
        await call("viewer", "GET", "/api/camera-streams/config"),
        await call("viewer", "GET", `/api/camera-streams/${GATE}/streams`),
        await admin("GET", "/api/gates"),
        await admin("GET", "/api/camera-streams/watch"),
        await admin("PUT", `/api/camera-streams/${GATE}/streams/${GATE}-cam`, { label: "itest cam 2" }),
        await admin("POST", "/api/camera-streams/scan-rtsp", { gate: GATE, stream: `${GATE}-cam` }),
        await admin("POST", `/api/camera-streams/${GATE}/watch`, { enabled: false }),
        await admin("PUT", `/api/gates/${GATE}`, { label: "Cổng bảo mật" }),
        await admin("POST", `/api/camera-streams/${GATE}/streams`, { id: `${GATE}-dup`, rtspUrl: `rtsp://itest:${CAM_SECRET}@${UNREACHABLE_HOST}:1/ngsec` }),
        await call("operator", "POST", `/api/camera-streams/${GATE}/streams`, { id: `${GATE}-lo`, rtspUrl: `rtsp://itest:${CAM_SECRET}@127.0.0.1:554/x` }),
      ]) {
        assert.ok(!res.text.includes(CAM_SECRET), `camera password in ${res.status} ${res.text.slice(0, 160)}`);
      }
    });

    it("SSE: no secret in any frame; other doors use door_lock_state, never lock_state", async () => {
      await admin("POST", "/api/lock/unlock", { doorId: DOOR, source: "itest ngsec sse" });
      await admin("POST", "/api/door-controller/config", { doors: [{ id: "main" }, { id: DOOR, label: "Kho bảo mật" }, { id: DOOR2 }] });
      await admin("POST", `/api/camera-streams/${GATE}/watch`, { enabled: false, intervalSeconds: 8 });
      await admin("POST", "/api/lock/lock", { doorId: DOOR, source: "itest ngsec sse" });
      let events: Array<{ event: string; data: any }> = [];
      for (let i = 0; i < 30; i++) {
        events = sse!.events();
        if (events.some((e) => e.event === "door_lock_state" && e.data?.doorId === DOOR && e.data?.state === "LOCKED")) break;
        await sleep(100);
      }
      const text = sse!.text();
      for (const secret of [DOOR_TOKEN, MAIN_TOKEN, CAM_SECRET, URL_SECRET]) assert.ok(!text.includes(secret), "secret in an SSE frame");
      assert.doesNotMatch(text, /"apiToken"\s*:/);
      assert.ok(events.some((e) => e.event === "door_config_updated"), "door_config_updated seen");
      assert.ok(events.some((e) => e.event === "door_lock_state" && e.data?.doorId === DOOR), "per-door lock event");
      const strayMain = events.filter((e) => e.event === "lock_state" && e.data?.doorId !== "main");
      assert.deepEqual(strayMain, [], "lock_state (the main lock for older dashboards) only ever carries door main");
      seen.push({ where: "SSE /api/events (viewer)", text });
    });
  });

  // =========================================================================
  // 4. SSRF / destination guard
  // =========================================================================
  describe("4. destination guard for the new gate and door", () => {
    const refusedCamera: Array<[string, RegExp]> = [
      ["rtsp://127.0.0.1:554/x", /^DEST_LOOPBACK$/],
      ["rtsp://2130706433/x", /^DEST_LOOPBACK$/],
      ["rtsp://localhost:5432/x", /^DEST_LOOPBACK$/],
      ["rtsp://[::1]:3000/x", /^DEST_LOOPBACK$/],
      ["rtsp://[::ffff:127.0.0.1]/x", /^DEST_LOOPBACK$/],
      ["rtsp://169.254.169.254/latest", /^DEST_METADATA$/],
      ["rtsp://169.254.1.1/x", /^DEST_LINK_LOCAL$/],
      ["rtsp://0.0.0.0:22/x", /^DEST_UNSPECIFIED$/],
      ["rtsp://evil\\@127.0.0.1/x", /^DEST_BAD_URL$/],
    ];
    const gatewayHost = new URL(BASE_URL).hostname;
    const selfHost = /^(127\.|localhost$|\[::1\]$)/.test(gatewayHost) ? null : gatewayHost;

    const streamIds = async (gate: string) => (await admin("GET", `/api/camera-streams/${gate}/streams`)).body.streams.map((s: any) => s.id);

    it("stream POST at the new gate refuses internal destinations exactly like at exit", async () => {
      const cases = selfHost ? [...refusedCamera, [`rtsp://${selfHost}:3000/x`, /^DEST_SELF$/] as [string, RegExp]] : refusedCamera;
      for (const [url, code] of cases) {
        const legacy = await call("operator", "POST", "/api/camera-streams/exit/streams", { id: `exit-ssrf-${RUN}`, rtspUrl: url, enabled: false });
        const fresh = await call("operator", "POST", `/api/camera-streams/${GATE}/streams`, { id: `${GATE}-ssrf`, rtspUrl: url, enabled: false });
        assert.equal(fresh.status, 400, `${url}: ${fresh.text.slice(0, 160)}`);
        assert.match(String(fresh.body.code), code, url);
        assert.deepEqual([fresh.status, fresh.body.code], [legacy.status, legacy.body.code], `parity with exit for ${url}`);
      }
      assert.ok(!(await streamIds(GATE)).includes(`${GATE}-ssrf`));
      assert.ok(!(await streamIds("exit")).includes(`exit-ssrf-${RUN}`));
    });

    it("stream PUT (rtspUrl / HTTP_MJPEG httpUrl), config POST `gates` and scan-rtsp `url` are guarded for the new gate", async () => {
      const before = (await fullConfig()).gates.find((g: any) => g.id === GATE).streams;
      const put = await call("operator", "PUT", `/api/camera-streams/${GATE}/streams/${GATE}-primary`, { rtspUrl: "rtsp://127.0.0.1:1/x" });
      assert.equal(put.status, 400, put.text.slice(0, 160));
      assert.equal(put.body.code, "DEST_LOOPBACK");
      const mjpeg = await call("operator", "PUT", `/api/camera-streams/${GATE}/streams/${GATE}-primary`, { sourceType: "HTTP_MJPEG", httpUrl: "http://169.254.169.254/latest/meta-data" });
      assert.equal(mjpeg.status, 400, mjpeg.text.slice(0, 160));
      assert.equal(mjpeg.body.code, "DEST_METADATA");
      const cfg = await call("operator", "POST", "/api/camera-streams/config", {
        gates: [{ id: GATE, streams: [...before.map((s: any) => ({ id: s.id })), { id: `${GATE}-meta`, rtspUrl: "rtsp://169.254.169.254/x", enabled: false }] }],
      });
      assert.equal(cfg.status, 400, cfg.text.slice(0, 160));
      assert.equal(cfg.body.code, "DEST_METADATA");
      const scan = await call("operator", "POST", "/api/camera-streams/scan-rtsp", { gate: GATE, url: "rtsp://127.0.0.1:3000/x" });
      if (scan.status !== 503) {
        assert.equal(scan.status, 400, scan.text.slice(0, 160));
        assert.equal(scan.body.code, "DEST_LOOPBACK");
      }
      const snapOverride = await call("operator", "GET", `/api/camera-streams/snapshot?gate=${GATE}&url=${encodeURIComponent("rtsp://127.0.0.1/x")}`);
      assert.equal(snapOverride.status, 400);
      assert.equal(snapOverride.body.code, "URL_OVERRIDE_NOT_ALLOWED");
      const after = (await fullConfig()).gates.find((g: any) => g.id === GATE).streams;
      assert.deepEqual(after.map((s: any) => [s.id, s.sourceType]), before.map((s: any) => [s.id, s.sourceType]), "nothing stored");
    });

    it("a private, non-allowlisted camera host is treated the same at the new gate as at exit", async () => {
      const url = "rtsp://10.20.30.40:554/itest-ngsec";
      const legacy = await call("operator", "POST", "/api/camera-streams/exit/streams", { id: `exit-priv-${RUN}`, rtspUrl: url, enabled: false });
      const fresh = await call("operator", "POST", `/api/camera-streams/${GATE}/streams`, { id: `${GATE}-priv`, rtspUrl: url, enabled: false });
      try {
        assert.deepEqual([fresh.status, fresh.body?.code], [legacy.status, legacy.body?.code], "parity with the legacy gate");
        if (STRICT_ALLOWLIST) {
          assert.equal(fresh.status, 400, fresh.text.slice(0, 160));
          assert.equal(fresh.body.code, "DEST_NOT_ALLOWED");
        }
      } finally {
        if (legacy.status === 201) await admin("DELETE", `/api/camera-streams/exit/streams/exit-priv-${RUN}`);
        if (fresh.status === 201) await admin("DELETE", `/api/camera-streams/${GATE}/streams/${GATE}-priv`);
      }
    });

    it("the new door's controller URL is guarded (loopback, metadata, link-local, self) and nothing is saved", async () => {
      const cases: Array<[string, RegExp]> = [
        ["http://127.0.0.1:3000/api/lock/unlock", /^DEST_LOOPBACK$/],
        ["http://localhost:8080/open", /^DEST_LOOPBACK$/],
        ["http://[::1]/open", /^DEST_LOOPBACK$/],
        ["http://2130706433/open", /^DEST_LOOPBACK$/],
        ["http://169.254.169.254/latest/meta-data/", /^DEST_METADATA$/],
        ["http://169.254.10.10/open", /^DEST_LINK_LOCAL$/],
        ["http://0.0.0.0/open", /^DEST_UNSPECIFIED$/],
        ...(selfHost ? [[`http://${selfHost}:3000/api/lock/unlock`, /^DEST_SELF$/] as [string, RegExp]] : []),
      ];
      for (const [url, code] of cases) {
        const res = await admin("POST", "/api/door-controller/config", { doors: [{ id: "main" }, { id: DOOR, apiUrl: url }, { id: DOOR2 }] });
        assert.equal(res.status, 400, `${url}: ${res.text.slice(0, 160)}`);
        assert.match(String(res.body.code), code, url);
        assert.equal(res.body.field, `doors.${DOOR}.apiUrl`);
        assert.equal(res.body.doorId, DOOR);
        const legacy = await admin("POST", "/api/door-controller/config", { apiUrl: url });
        assert.deepEqual([legacy.status, legacy.body.code], [res.status, res.body.code], `parity with door main for ${url}`);
      }
      const cfg = await doorCfg();
      assert.equal(cfg.doors.find((x: any) => x.id === DOOR).apiUrl || "", "", "nothing saved");
      assert.equal(cfg.apiUrl || "", mainBefore.apiUrl || "", "door main unchanged");
    });

    it("a private, non-allowlisted controller host is treated the same for the new door as for main", async () => {
      const url = "https://10.20.30.40/itest-ngsec/open";
      const fresh = await admin("POST", "/api/door-controller/config", { doors: [{ id: "main" }, { id: DOOR, apiUrl: url }, { id: DOOR2 }] });
      await admin("POST", "/api/door-controller/config", { doors: [{ id: "main" }, { id: DOOR, apiUrl: "" }, { id: DOOR2 }] });
      const legacy = await admin("POST", "/api/door-controller/config", { apiUrl: url });
      await admin("POST", "/api/door-controller/config", { apiUrl: mainBefore.apiUrl || "" });
      assert.deepEqual([fresh.status, fresh.body?.code], [legacy.status, legacy.body?.code], "parity with door main");
      if (STRICT_ALLOWLIST) {
        assert.equal(fresh.status, 400, fresh.text.slice(0, 160));
        assert.equal(fresh.body.code, "DEST_NOT_ALLOWED");
      }
    });
  });

  // =========================================================================
  // 5. Isolation between gates and doors; history
  // =========================================================================
  describe("5. isolation and history", () => {
    it("unlocking or locking one door never changes another door (or main)", async () => {
      for (const d of ["main", DOOR, DOOR2]) await admin("POST", "/api/lock/lock", { doorId: d, source: "itest ngsec iso" });
      const main0 = await lockOf("main");
      const b0 = await lockOf(DOOR2);
      const open = await admin("POST", "/api/lock/unlock", { doorId: DOOR, source: "itest ngsec iso" });
      assert.equal(open.status, 200);
      assert.equal(open.body.lockState.doorId, DOOR);
      assert.equal((await lockOf(DOOR)).state, "UNLOCKED");
      for (const [id, was] of [["main", main0], [DOOR2, b0]] as const) {
        const now = await lockOf(id);
        assert.equal(now.state, "LOCKED", `${id} stayed locked`);
        assert.equal(now.lastActionAt, was.lastActionAt, `${id} not touched`);
      }
      assert.equal((await admin("POST", "/api/lock/unlock", { doorId: DOOR2, source: "itest ngsec iso" })).status, 200);
      assert.equal((await admin("POST", "/api/lock/lock", { doorId: DOOR, source: "itest ngsec iso" })).status, 200);
      assert.equal((await lockOf(DOOR2)).state, "UNLOCKED", "locking A leaves B open");
      assert.equal((await lockOf("main")).lastActionAt, main0.lastActionAt);
      const all = (await admin("GET", "/api/lock/states")).body.doors;
      assert.equal(all.find((d: any) => d.doorId === DOOR).isLocked, true);
      assert.equal(all.find((d: any) => d.doorId === DOOR2).isLocked, false);
      await admin("POST", "/api/lock/lock", { doorId: DOOR2, source: "itest ngsec iso" });
    });

    it("an event at the third gate names ITS door and moves no door (DENIED; no face fixture for a grant)", async () => {
      const before = await Promise.all(["main", DOOR, DOOR2].map(lockOf));
      const rec = await admin("POST", "/api/recognize-face", { imageBase64: noFaceJpegDataUrl(64, 8201), gateId: GATE, scanType: "EXIT" });
      assert.equal(rec.status, 200, rec.text.slice(0, 200));
      assert.notEqual(rec.body.lockUnlocked, true);
      const log = rec.body.log;
      assert.ok(log?.id, "a DENIED event is written");
      assert.equal(log.gateId, GATE);
      assert.equal(log.type, "ENTRY", "the gate's direction, not the body's scanType");
      assert.equal(log.doorName, "Kho bảo mật", "the bound door");
      // Rebind to DOOR2: the next event names DOOR2.
      assert.equal((await admin("PUT", `/api/gates/${GATE}`, { doorId: DOOR2 })).status, 200);
      const rec2 = await admin("POST", "/api/recognize-face", { imageBase64: noFaceJpegDataUrl(64, 8202), gateId: GATE });
      if (rec2.body?.log) assert.equal(rec2.body.log.doorName, "Kho phụ");
      assert.equal((await admin("PUT", `/api/gates/${GATE}`, { doorId: DOOR })).status, 200);
      const after = await Promise.all(["main", DOOR, DOOR2].map(lockOf));
      assert.deepEqual(after.map((s) => [s.doorId, s.state, s.lastActionAt]), before.map((s) => [s.doorId, s.state, s.lastActionAt]));
      // The binding itself, as the API reports it.
      const summary = await gateSummary(GATE);
      assert.equal(summary.doorId, DOOR);
      assert.equal(summary.doorLabel, "Kho bảo mật");
    });

    it("a deleted gate's history stays readable by its id and is never reattributed", async () => {
      const id = `hist-${RUN}`;
      await createGate(id, "ENTRY");
      const rec = await admin("POST", "/api/recognize-face", { imageBase64: noFaceJpegDataUrl(64, 8301), gateId: id });
      assert.equal(rec.status, 200, rec.text.slice(0, 200));
      const logId = rec.body.log?.id;
      assert.ok(logId, "event written");
      assert.equal((await deleteGate(id)).status, 200);

      const mine = await call("viewer", "GET", `/api/logs?gateId=${id}&paging=cursor`);
      assert.equal(mine.status, 200);
      assert.ok(mine.body.logs.some((l: any) => l.id === logId), "still found by its gate id");
      assert.ok(mine.body.logs.every((l: any) => l.gateId === id));
      const entry = await call("viewer", "GET", "/api/logs?gateId=entry&paging=cursor&limit=200");
      assert.ok(!entry.body.logs.some((l: any) => l.id === logId), "not reattributed to entry (same direction)");
      const newest = await call("viewer", "GET", "/api/logs?limit=50");
      assert.equal(newest.body.logs.find((l: any) => l.id === logId)?.gateId, id, "unfiltered list keeps its gateId");
      const stats = await call("viewer", "GET", `/api/logs/stats?gateId=${id}`);
      assert.equal(stats.status, 200);
      assert.ok((stats.body.byGate || []).some((g: any) => g.gateId === id && g.total >= 1), JSON.stringify(stats.body.byGate));
      const csv = await call("viewer", "GET", `/api/logs/export.csv?gateId=${id}`);
      assert.equal(csv.status, 200);
      assert.ok(csv.text.split("\n").some((l) => l.startsWith(`"${logId}"`) && l.includes(`"${id}"`)), "CSV row carries the removed gate's id");
      for (const direction of ["ENTRY", "EXIT"]) {
        assert.equal((await admin("POST", "/api/gates", { id, label: "reuse", direction })).status, 409, "the id is never reused");
      }
    });

    it("FINDING NGSEC-7: a lock/unlock with a malformed `source` is refused (400) and leaves the door state untouched", async () => {
      await admin("POST", "/api/lock/lock", { doorId: DOOR2, source: "itest ngsec baseline" });
      const before = await lockOf(DOOR2);
      const unlock = await admin("POST", "/api/lock/unlock", { doorId: DOOR2, source: { toString: "x" } });
      const mid = await lockOf(DOOR2);
      // Wait past the auto-relock: a half-applied unlock never gets its relock timer.
      await sleep((Number(mid.autoRelockSeconds) || 6) * 1000 + 1500);
      const later = await lockOf(DOOR2);
      await admin("POST", "/api/lock/lock", { doorId: DOOR2, source: "itest ngsec cleanup" });
      assert.ok(
        unlock.status === 400 && mid.state === before.state && mid.lastActionAt === before.lastActionAt,
        `unlock {source: object} -> HTTP ${unlock.status} (${unlock.body?.error}); door ${DOOR2}: ${before.state} -> ${mid.state}, ` +
          `still ${later.state} ${(Number(mid.autoRelockSeconds) || 6) + 1.5}s later (no auto-relock, not persisted, no SSE, no controller command)`
      );
    });

    it("FINDING NGSEC-6: a disabled gate does not process recognitions (no event, no door)", async () => {
      const id = `dis-${RUN}`;
      await createGate(id, "ENTRY", DOOR2);
      try {
        assert.equal((await admin("PUT", `/api/gates/${id}`, { enabled: false })).status, 200);
        assert.equal((await gateSummary(id)).enabled, false);
        const rec = await admin("POST", "/api/recognize-face", { imageBase64: noFaceJpegDataUrl(64, 8401), gateId: id });
        assert.ok(
          rec.status >= 400 && rec.status < 500 && !rec.body?.log,
          `a recognition at a DISABLED gate was processed: HTTP ${rec.status}, event ${rec.body?.log?.id} at ${rec.body?.log?.gateId} (door ${rec.body?.log?.doorName}); a grant here would open door ${DOOR2}`
        );
      } finally {
        await deleteGate(id);
      }
    });

    it("O1: a device token may only name the gates it is bound to (DEVICE_INGEST_GATES, default entry,exit)", async () => {
      const id = `dev-${RUN}`;
      await createGate(id, "ENTRY", DOOR2);
      const device = (gateId: string, seed: number) =>
        rawApi("/api/recognize-face", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.DEVICE_INGEST_TOKEN || "integration-device-token"}` },
          body: JSON.stringify({ imageBase64: noFaceJpegDataUrl(64, seed), gateId }),
        });
      try {
        const other = await device(id, 8501);
        assert.equal(other.status, 403, `device recognition at gate ${id}: HTTP ${other.status}`);
        assert.equal(other.body?.code, "DEVICE_GATE_FORBIDDEN");
        assert.notEqual((await device("entry", 8502)).status, 403, "the legacy gates stay open to devices");
      } finally {
        await deleteGate(id);
      }
    });
  });

  // =========================================================================
  // 6. Concurrency
  // =========================================================================
  describe("6. concurrency", () => {
    it("8 concurrent creates of one id: exactly one 201, the rest 409", async () => {
      const id = `race-${RUN}`;
      const res = await Promise.all(Array.from({ length: 8 }, (_, i) => admin("POST", "/api/gates", { id, label: `r${i}`, direction: i % 2 ? "EXIT" : "ENTRY" })));
      const statuses = res.map((r) => r.status).sort();
      assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409, 409, 409]);
      assert.equal((await gatesList()).filter((g) => g.id === id).length, 1);
      assert.equal((await runtimeIds()).filter((g) => g === id).length, 1);
      const del = await Promise.all(Array.from({ length: 5 }, () => deleteGate(id)));
      assert.deepEqual(del.map((r) => r.status).sort(), [200, 400, 400, 400, 400], "exactly one delete wins");
    });

    it("concurrent creates and deletes leave one coherent list (config = /api/gates = watch runtimes)", async () => {
      const olds = [`co-${RUN}-a`, `co-${RUN}-b`];
      for (const id of olds) await createGate(id);
      const news = [0, 1, 2, 3].map((i) => `cn-${RUN}-${i}`);
      const ops = await Promise.all([
        ...news.map((id) => admin("POST", "/api/gates", { id, label: id, direction: "EXIT" })),
        ...olds.map((id) => deleteGate(id)),
        admin("PUT", `/api/gates/${GATE}`, { label: "Cổng bảo mật" }),
      ]);
      assert.ok(ops.every((r) => r.status === 200 || r.status === 201), ops.map((r) => r.status).join());
      try {
        const listed = (await gatesList()).map((g) => g.id);
        const cfg = await fullConfig();
        const rt = await runtimeIds();
        assert.equal(new Set(listed).size, listed.length, "no duplicate gate");
        assert.deepEqual(cfg.gates.map((g: any) => g.id), listed, "config.gates = /api/gates");
        assert.deepEqual([...rt].sort(), [...listed].sort(), "one watch runtime per configured gate, no orphan");
        for (const id of news) assert.ok(listed.includes(id), `${id} created`);
        for (const id of olds) {
          assert.ok(!listed.includes(id), `${id} deleted`);
          assert.ok((cfg.retiredGateIds || []).includes(id), `${id} retired`);
        }
        assert.ok(listed.includes("entry") && listed.includes("exit"));
      } finally {
        for (const id of news) await deleteGate(id);
      }
    });

    /**
     * POST /api/camera-streams/config (operator) reads the config, awaits the
     * destination guard's DNS lookup for a NEW stream host name, then commits
     * what it read: every gate change committed meanwhile is lost.
     */
    async function raceConfigSave(carrier: string, tag: string, mutate: () => Promise<ApiResponse>) {
      const save = call("operator", "POST", "/api/camera-streams/config", {
        gates: [{ id: carrier, streams: [{ id: `${carrier}-primary` }, { id: `${carrier}-${tag}`, rtspUrl: slowCameraUrl(tag), enabled: false }] }],
      });
      await sleep(5);
      const mutation = await mutate();
      const saved = await save;
      return { saved, mutation };
    }

    it("FINDING NGSEC-1a: an operator's camera-config save never resurrects a gate an admin deleted meanwhile", async () => {
      const carrier = `cc-${RUN}`;
      await createGate(carrier);
      const victims: string[] = [];
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const victim = `zv-${RUN}-${attempt}`;
          victims.push(victim);
          await createGate(victim, "EXIT", DOOR2);
          const { saved, mutation } = await raceConfigSave(carrier, `z${attempt}`, () => deleteGate(victim));
          assert.equal(mutation.status, 200, mutation.text.slice(0, 160));
          assert.equal(saved.status, 200, saved.text.slice(0, 160));
          const cfg = await fullConfig();
          const listed = cfg.gates.map((g: any) => g.id);
          const rt = await runtimeIds();
          assert.ok(
            !listed.includes(victim) && !rt.includes(victim) && (cfg.retiredGateIds || []).includes(victim),
            `attempt ${attempt}: DELETE /api/gates/${victim} answered 200, but after the concurrent config save the gate is ` +
              `${listed.includes(victim) ? "BACK in the config" : "absent"}, runtime ${rt.includes(victim) ? "running" : "absent"}, ` +
              `tombstone ${(cfg.retiredGateIds || []).includes(victim) ? "kept" : "LOST"}`
          );
        }
      } finally {
        for (const id of [...victims, carrier]) await deleteGate(id);
      }
    });

    it("FINDING NGSEC-1b: an operator's camera-config save never reverts an admin's disable / door rebinding made meanwhile", async () => {
      const carrier = `cd-${RUN}`;
      const victim = `zd-${RUN}`;
      await createGate(carrier);
      await createGate(victim, "ENTRY", DOOR);
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          assert.equal((await admin("PUT", `/api/gates/${victim}`, { enabled: true, doorId: DOOR })).status, 200);
          const { saved, mutation } = await raceConfigSave(carrier, `d${attempt}`, () =>
            admin("PUT", `/api/gates/${victim}`, { enabled: false, doorId: DOOR2 })
          );
          assert.equal(mutation.status, 200, mutation.text.slice(0, 160));
          assert.equal(mutation.body.summary.enabled, false);
          assert.equal(saved.status, 200);
          const g = await gateSummary(victim);
          assert.deepEqual(
            [g.enabled, g.doorId],
            [false, DOOR2],
            `attempt ${attempt}: the admin's PUT (disable + door ${DOOR2}) answered 200 but was silently reverted to enabled=${g.enabled}, door ${g.doorId}`
          );
        }
      } finally {
        for (const id of [victim, carrier]) await deleteGate(id);
      }
    });

    it("FINDING NGSEC-2: an operator cannot clear the retired gate ids (deleted ids must never be reused)", async () => {
      const id = `tomb-${RUN}`;
      await createGate(id, "ENTRY");
      assert.equal((await deleteGate(id)).status, 200);
      const before = (await fullConfig()).retiredGateIds || [];
      assert.ok(before.includes(id));
      const wipe = await call("operator", "POST", "/api/camera-streams/config", { retiredGateIds: [] });
      const after = (await fullConfig()).retiredGateIds || [];
      const reuse = await admin("POST", "/api/gates", { id, label: "reused id", direction: "EXIT" });
      try {
        assert.ok(
          after.includes(id) && reuse.status === 409,
          `operator config POST {retiredGateIds: []} -> HTTP ${wipe.status}; tombstones ${before.length} -> ${after.length}; ` +
            `re-creating deleted id "${id}" (now EXIT) -> HTTP ${reuse.status}: its ENTRY history would be filed under the new gate`
        );
      } finally {
        if (reuse.status === 201) await deleteGate(id);
        // Put the tombstones back (the operator route is the only one that writes the list).
        const now = (await fullConfig()).retiredGateIds || [];
        await call("operator", "POST", "/api/camera-streams/config", { retiredGateIds: [...new Set([...before, ...now, id])] });
      }
    });

    it("FINDING NGSEC-3: a deleted id stays retired after 256 further deletions", { timeout: 180_000 }, async () => {
      const first = `cap-${RUN}-first`;
      await createGate(first);
      assert.equal((await deleteGate(first)).status, 200);
      for (let i = 0; i < 256; i++) {
        const id = `cap-${RUN}-${i}`;
        const c = await admin("POST", "/api/gates", { id, label: "cap", direction: "ENTRY" });
        assert.equal(c.status, 201, `${id}: ${c.text.slice(0, 120)}`);
        assert.equal((await deleteGate(id)).status, 200);
      }
      const reuse = await admin("POST", "/api/gates", { id: first, label: "reused", direction: "EXIT" });
      if (reuse.status === 201) await deleteGate(first);
      assert.equal(reuse.status, 409, `after 256 more deletions the id "${first}" was handed out again (HTTP ${reuse.status})`);
    });
  });

  // =========================================================================
  it("no response or SSE frame in this file carried a door token, camera password or URL secret", () => {
    assert.ok(seen.length > 300, `scanned ${seen.length} responses`);
    const leaks = seen.filter((s) => [DOOR_TOKEN, MAIN_TOKEN, CAM_SECRET, URL_SECRET].some((secret) => s.text.includes(secret)));
    assert.deepEqual(leaks.map((l) => l.where), [], "responses that carried a secret");
  });
});
