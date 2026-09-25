/**
 * Accounts, roles and the permission table for the operator API.
 *
 * Pure logic only - no Express, no storage - so the whole authorization matrix
 * can be unit-tested. server.ts consults `requiredRoleFor()` at the single
 * fail-closed boundary; nothing else decides who may call what.
 */

import { randomBytes, scrypt, timingSafeEqual } from "crypto";

export type UserRole = "admin" | "operator" | "viewer";

export const USER_ROLES: readonly UserRole[] = ["admin", "operator", "viewer"];

const ROLE_RANK: Record<UserRole, number> = { viewer: 0, operator: 1, admin: 2 };

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Quản trị",
  operator: "Vận hành",
  viewer: "Chỉ xem",
};

export const isUserRole = (value: unknown): value is UserRole =>
  typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);

/** True when `role` carries every permission of `required`. Roles are strictly nested. */
export const roleAtLeast = (role: UserRole, required: UserRole): boolean =>
  ROLE_RANK[role] >= ROLE_RANK[required];

// ---------------------------------------------------------------------------
// Permission table
// ---------------------------------------------------------------------------
//
//   admin     everything
//   operator  view history; add/edit/remove camera streams and gate watch
//             settings; approve new members (create employee, stranger
//             register/merge/dismiss/restore); register faces (enrol, capture,
//             remove a template); manage departments and positions;
//             run recognition
//   viewer    view only
//
// Anything not listed below is decided by the defaults at the bottom: reads
// need `viewer`, writes need `admin`. A new route is therefore admin-only for
// writes until someone deliberately grants it here - fail-closed.

interface Rule {
  methods: readonly string[];
  pattern: RegExp;
  role: UserRole;
}

const READ = ["GET", "HEAD"] as const;
const WRITE = ["POST", "PUT", "PATCH", "DELETE"] as const;

const RULES: readonly Rule[] = [
  // --- admin-only reads: account records and configuration that names secrets
  { methods: READ, pattern: /^\/api\/users(?:\/|$)/, role: "admin" },
  { methods: READ, pattern: /^\/api\/door-controller\/config$/, role: "admin" },
  { methods: READ, pattern: /^\/api\/webhook\/config$/, role: "admin" },
  { methods: READ, pattern: /^\/api\/system\//, role: "admin" },

  // --- any signed-in account may change its own password
  { methods: ["POST"], pattern: /^\/api\/operator\/password$/, role: "viewer" },

  // --- operator: camera streams and gate watching
  { methods: WRITE, pattern: /^\/api\/camera-streams\/(?:entry|exit)\/streams(?:\/[^/]+)?$/, role: "operator" },
  { methods: ["POST"], pattern: /^\/api\/camera-streams\/config$/, role: "operator" },
  { methods: ["POST"], pattern: /^\/api\/camera-streams\/(?:entry|exit)\/watch$/, role: "operator" },
  { methods: ["POST"], pattern: /^\/api\/camera-streams\/(?:test-stream|scan-rtsp)$/, role: "operator" },

  // --- operator: approving new members
  { methods: ["POST"], pattern: /^\/api\/employees$/, role: "operator" },
  {
    methods: ["POST"],
    pattern: /^\/api\/strangers\/(?:quick-register|register|merge|assign|dismiss|reject|restore)$/,
    role: "operator",
  },

  // --- operator: the department and position catalog
  { methods: WRITE, pattern: /^\/api\/org\/(?:departments|positions)(?:\/[^/]+)?$/, role: "operator" },

  // --- operator: registering faces
  { methods: ["POST"], pattern: /^\/api\/employees\/[^/]+\/templates(?:\/capture)?$/, role: "operator" },
  { methods: ["DELETE"], pattern: /^\/api\/employees\/[^/]+\/templates\/[^/]+$/, role: "operator" },

  // --- operator: running recognition and acknowledging notifications
  {
    methods: ["POST"],
    pattern: /^\/api\/(?:recognize-face|face\/recognize|face-recognize|face-recognition|recognize)$/,
    role: "operator",
  },
  { methods: ["POST"], pattern: /^\/api\/notifications\/mark-read$/, role: "operator" },
];

/** Legacy spellings of the same resources, mapped onto one canonical path. */
const ALIASES: ReadonlyArray<[RegExp, string]> = [
  [/^\/api\/employee(?=\/|$)/, "/api/employees"],
  [/^\/api\/access-logs(?=\/|$)/, "/api/logs"],
  // Bare /api/door-config IS the config resource (server.ts DOOR_CONFIG_ROUTES);
  // /api/door-config/test and /logs are its siblings under door-controller.
  [/^\/api\/door-config$/, "/api/door-controller/config"],
  [/^\/api\/door-config(?=\/)/, "/api/door-controller"],
];

/** `/employees/x/` and `/api/employees/x` both become `/api/employees/x`. */
export function canonicalApiPath(path: string): string {
  let p = String(path || "").split("?")[0].replace(/\/+$/, "") || "/";
  if (!p.startsWith("/api/") && p !== "/api") p = `/api${p}`;
  for (const [from, to] of ALIASES) p = p.replace(from, to);
  return p;
}

/** The least role allowed to call `method path`. */
export function requiredRoleFor(method: string, path: string): UserRole {
  const m = String(method || "GET").toUpperCase();
  const p = canonicalApiPath(path);
  for (const rule of RULES) {
    if (rule.methods.includes(m) && rule.pattern.test(p)) return rule.role;
  }
  return m === "GET" || m === "HEAD" || m === "OPTIONS" ? "viewer" : "admin";
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------
//
// scrypt with a per-password random salt. Stored as
//   scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>
// so the cost parameters can be raised later without breaking old hashes.

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLen, { N: n, r, p, maxmem: 128 * n * r * 2 }, (err, key) =>
      err ? reject(err) : resolve(key as Buffer)
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LEN);
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** Constant-time check. Any malformed stored value simply fails. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltRaw, keyRaw] = parts;
  const n = Number(nRaw), r = Number(rRaw), p = Number(pRaw);
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  try {
    const expected = Buffer.from(keyRaw, "base64url");
    if (expected.length === 0) return false;
    const actual = await scryptAsync(String(password || ""), Buffer.from(saltRaw, "base64url"), n, r, p, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * A real hash to verify against when the username does not exist, so an
 * unknown account costs the same time as a wrong password and login latency
 * does not reveal which usernames exist.
 */
let dummyHash: Promise<string> | null = null;
export function timingDummyHash(): Promise<string> {
  if (!dummyHash) dummyHash = hashPassword(randomBytes(24).toString("base64url"));
  return dummyHash;
}

// ---------------------------------------------------------------------------
// Validation and lockout
// ---------------------------------------------------------------------------

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;

export function normalizeUsername(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Returns an error message, or null when valid. */
export function validateUsername(username: string): string | null {
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    return "Tên đăng nhập gồm 3-32 ký tự: chữ thường, số, dấu chấm, gạch dưới hoặc gạch ngang, bắt đầu bằng chữ hoặc số";
  }
  return null;
}

/** Returns an error message, or null when valid. */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string") return "Mật khẩu không hợp lệ";
  if (password.length < PASSWORD_MIN_LENGTH) return `Mật khẩu phải có ít nhất ${PASSWORD_MIN_LENGTH} ký tự`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Mật khẩu tối đa ${PASSWORD_MAX_LENGTH} ký tự`;
  return null;
}

/** Remaining lock in ms, or 0 when the account may attempt a login. */
export function lockRemainingMs(lockedUntil: string | null | undefined, now = Date.now()): number {
  if (!lockedUntil) return 0;
  const until = Date.parse(lockedUntil);
  return Number.isFinite(until) && until > now ? until - now : 0;
}
