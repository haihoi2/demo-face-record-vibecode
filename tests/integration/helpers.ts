/**
 * Shared helpers for the HTTP integration suite.
 *
 * Every test talks to a live gateway over HTTP (APP_URL, default
 * http://127.0.0.1:3100). Nothing here imports server code, so the suite
 * exercises the real Express stack, CORS middleware, and body parsers.
 */

export const BASE_URL = (process.env.APP_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");

export interface ApiResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

/** Fetch without an operator session (used by authorization regressions). */
export async function rawApi<T = any>(path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  const res = await fetch(BASE_URL + path, init);
  const text = await res.text();
  let body: any = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  return { status: res.status, headers: res.headers, body, text };
}

let operatorCookiePromise: Promise<string> | null = null;
const csrfByCookie = new Map<string, string>();

export async function authenticateAs(token: string): Promise<string> {
  const res = await rawApi<{ success?: boolean; csrfToken?: string }>("/api/operator/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (res.status !== 200) {
    throw new Error(`Operator login failed: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  }
  const cookie = res.headers.get("set-cookie")?.split(";", 1)[0] || "";
  if (!cookie) throw new Error("Operator login returned no session cookie");
  if (!res.body?.csrfToken) throw new Error("Operator login returned no CSRF token");
  csrfByCookie.set(cookie, res.body.csrfToken);
  return cookie;
}

export function csrfTokenForCookie(cookie: string): string {
  return csrfByCookie.get(cookie) || "";
}

async function operatorCookie(): Promise<string> {
  if (!operatorCookiePromise) {
    const token = process.env.OPERATOR_TOKEN || "integration-operator-token";
    operatorCookiePromise = authenticateAs(token);
  }
  return operatorCookiePromise;
}

/** Fetch with the integration operator's short-lived HttpOnly session. */
export async function api<T = any>(path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  const headers = new Headers(init.headers);
  const cookie = await operatorCookie();
  headers.set("Cookie", cookie);
  if (!/^(GET|HEAD|OPTIONS)$/i.test(init.method || "GET")) {
    headers.set("X-CSRF-Token", csrfByCookie.get(cookie) || "");
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  }
  return rawApi<T>(path, { ...init, headers });
}

export function postJson<T = any>(path: string, payload: unknown, extraHeaders: Record<string, string> = {}) {
  return api<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Smart lock helpers
// ---------------------------------------------------------------------------

export interface LockState {
  state: "LOCKED" | "UNLOCKED" | "UNLOCKING" | "LOCKING";
  isLocked: boolean;
  lastActionBy?: string;
  [key: string]: unknown;
}

export async function getLockState(): Promise<LockState> {
  const res = await api<LockState>("/api/lock/status");
  if (res.status !== 200 || !res.body) {
    throw new Error(`GET /api/lock/status failed: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  }
  return res.body;
}

/** Force the door to LOCKED so every test starts from the same baseline. */
export async function lockDoor(source = "integration-test baseline"): Promise<LockState> {
  const res = await postJson("/api/lock/lock", { source });
  if (res.status !== 200) {
    throw new Error(`POST /api/lock/lock failed: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  }
  const state = await getLockState();
  if (state.state !== "LOCKED" || state.isLocked !== true) {
    throw new Error(`Door did not report LOCKED after /api/lock/lock: ${JSON.stringify(state)}`);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Employee roster helpers (temporary fixtures only - never touch seeded rows)
// ---------------------------------------------------------------------------

export interface Employee {
  id: string;
  name: string;
  employeeCode: string;
  department: string;
  position: string;
  photoUrl: string;
  registeredAt: string;
  accessLevel: string;
}

export async function listEmployees(): Promise<Employee[]> {
  const res = await api<Employee[]>("/api/employees");
  if (res.status !== 200 || !Array.isArray(res.body)) {
    throw new Error(`GET /api/employees did not return an array: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  }
  return res.body;
}

/** A roster code that cannot collide with anything real or with another run. */
export function uniqueTestCode(prefix = "ITEST"): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

export async function createTempEmployee(overrides: Partial<Employee> = {}): Promise<Employee> {
  const payload = {
    name: overrides.name || `Integration Fixture ${Date.now()}`,
    employeeCode: overrides.employeeCode || uniqueTestCode(),
    department: overrides.department || "Integration Test Dept",
    position: overrides.position || "Fixture",
    photoUrl: overrides.photoUrl || noFaceJpegDataUrl(),
    accessLevel: overrides.accessLevel || "ALL_ACCESS",
  };
  const res = await postJson<{ success: boolean; employee: Employee }>("/api/employees", payload);
  if (res.status !== 200 || !res.body?.employee?.id) {
    throw new Error(`POST /api/employees failed: HTTP ${res.status} ${res.text.slice(0, 300)}`);
  }
  return res.body.employee;
}

/** Delete by id, tolerating a row that is already gone. */
export async function deleteEmployee(id: string): Promise<void> {
  const res = await api(`/api/employees/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (res.status !== 200 && res.status !== 404) {
    throw new Error(`DELETE /api/employees/${id} failed: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Synthetic "no face" JPEG
// ---------------------------------------------------------------------------

/**
 * Builds a real baseline JPEG (SOF0) of a flat mid-grey square, entirely
 * in code. There is no face in it by construction.
 *
 * Layout: SOI, JFIF APP0, DQT (all-ones luminance table), SOF0 (1 greyscale
 * component, 8-bit), two single-symbol Huffman tables (DC category 0 and the
 * AC end-of-block symbol, each encoded as the one-bit code "0"), SOS, the
 * entropy-coded scan (two zero bits per 8x8 MCU), EOI.
 *
 * `size` must be a multiple of 8. The optional `noiseSeed` perturbs the DC
 * coefficients so that different seeds produce byte-different images, which
 * lets a test send several distinct no-face frames.
 */
export function buildGreyJpeg(size = 64, noiseSeed = 0): Buffer {
  if (size % 8 !== 0 || size <= 0 || size > 65535) {
    throw new Error("size must be a positive multiple of 8");
  }
  const mcus = (size / 8) * (size / 8);

  const soi = [0xff, 0xd8];
  const app0 = [
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, // version 1.1
    0x00, // density units: none
    0x00, 0x01, 0x00, 0x01, // x/y density 1
    0x00, 0x00, // no thumbnail
  ];
  const dqt = [0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array<number>(64).fill(1)];
  const sof0 = [
    0xff, 0xc0, 0x00, 0x0b,
    0x08, // precision
    (size >> 8) & 0xff, size & 0xff, // height
    (size >> 8) & 0xff, size & 0xff, // width
    0x01, // one component
    0x01, 0x11, 0x00, // id 1, 1x1 sampling, quant table 0
  ];

  // Huffman tables. When noiseSeed is 0 each table has a single one-bit code:
  // DC -> category 0 (diff = 0), AC -> 0x00 (EOB). When a seed is given the DC
  // table carries two symbols (category 0 as "0", category 1 as "10") so the
  // grey level can wobble by +/-1 per block and produce distinct bytes.
  const dcSymbols = noiseSeed === 0 ? [0x00] : [0x00, 0x01];
  const dcBits = new Array<number>(16).fill(0);
  if (noiseSeed === 0) {
    dcBits[0] = 1;
  } else {
    dcBits[0] = 1;
    dcBits[1] = 1;
  }
  const dhtDc = [0xff, 0xc4, 0x00, 19 + dcSymbols.length, 0x00, ...dcBits, ...dcSymbols];
  const acBits = new Array<number>(16).fill(0);
  acBits[0] = 1;
  const dhtAc = [0xff, 0xc4, 0x00, 19 + 1, 0x10, ...acBits, 0x00];

  const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];

  // Entropy-coded segment.
  const bits: number[] = [];
  let rng = (noiseSeed >>> 0) || 1;
  for (let i = 0; i < mcus; i++) {
    if (noiseSeed === 0) {
      bits.push(0); // DC category 0
    } else {
      // xorshift32 for a deterministic per-seed pattern
      rng ^= rng << 13; rng >>>= 0;
      rng ^= rng >>> 17;
      rng ^= rng << 5; rng >>>= 0;
      if (rng & 1) {
        bits.push(1, 0); // DC category 1
        bits.push((rng >>> 1) & 1); // +1 or -1
      } else {
        bits.push(0); // DC category 0
      }
    }
    bits.push(0); // AC EOB
  }
  while (bits.length % 8 !== 0) bits.push(1); // pad with 1s per spec
  const scan: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b];
    scan.push(byte);
    if (byte === 0xff) scan.push(0x00); // byte stuffing
  }

  const eoi = [0xff, 0xd9];

  return Buffer.from([...soi, ...app0, ...dqt, ...sof0, ...dhtDc, ...dhtAc, ...sos, ...scan, ...eoi]);
}

export function noFaceJpegDataUrl(size = 64, noiseSeed = 0): string {
  return "data:image/jpeg;base64," + buildGreyJpeg(size, noiseSeed).toString("base64");
}

// ---------------------------------------------------------------------------
// Recognition response assertions
// ---------------------------------------------------------------------------

export interface RecognizeResponse {
  recognized?: boolean;
  lockUnlocked?: boolean;
  authorizedCount?: number;
  unauthorizedCount?: number;
  employee?: Employee;
  recognizedEmployees?: Employee[];
  detectedFaces?: Array<{ recognized: boolean; confidence: number; employeeId?: string }>;
  confidence?: number;
  simulationDisabled?: boolean;
  error?: string;
  message?: string;
  engineUsed?: string;
  modelUsed?: string;
  [key: string]: unknown;
}

export function recognize(payload: unknown, extraHeaders: Record<string, string> = {}) {
  return postJson<RecognizeResponse>("/api/recognize-face", payload, extraHeaders);
}

/** Small helper for tests that want to leave the AI engine config as they found it. */
export async function withAiConfig<T>(patch: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const before = await api("/api/config/ai");
  if (before.status !== 200 || !before.body) {
    throw new Error(`GET /api/config/ai failed: HTTP ${before.status}`);
  }
  const { activeEngineInfo: _ignored, ...original } = before.body;
  const applied = await postJson("/api/config/ai", patch);
  if (applied.status !== 200) {
    throw new Error(`POST /api/config/ai failed: HTTP ${applied.status} ${applied.text.slice(0, 200)}`);
  }
  try {
    return await fn();
  } finally {
    await postJson("/api/config/ai", original);
  }
}
