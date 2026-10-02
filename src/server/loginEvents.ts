/**
 * Sign-in audit (owner 2026-10-02: "harden login, audit login history for user").
 *
 * CONTRACT. One append-only row per sign-in attempt and per session event, so an
 * admin can see who signed in when and from where - and every failed attempt.
 * The site is reachable from the internet since 2026-10-02 (eton8 edge guards),
 * so failures from unknown addresses are expected and must be visible.
 *
 * Personal data: client IP and browser string. Retention LOGIN_EVENT_RETENTION_DAYS
 * (default 180; 0 keeps forever). Never stored: passwords, tokens, cookies, CSRF
 * tokens. An attempted username that is not a valid username (often a password
 * typed into the wrong field) is replaced by "(không hợp lệ)".
 *
 * API: GET /api/users/login-events (admin)
 *   query: userId, username, kind, before (cursor = id of the last row seen), limit (1..200, default 50)
 *   200 { success, events: LoginEventRecord[] (newest first), hasMore, nextCursor? }
 */
import { randomUUID } from "node:crypto";
import { envNumber } from "./env";

export type LoginEventKind =
  /** Signed in (account or setup token). */
  | "sign-in"
  /** Wrong password, unknown account, wrong setup token, disabled account. */
  | "sign-in-failed"
  /** Attempt refused because the account is locked (and the lock that a failure triggers). */
  | "locked"
  /** Too many attempts from one address (HTTP 429). At most one row per address per window. */
  | "rate-limited"
  | "sign-out"
  | "password-changed";

export const LOGIN_EVENT_KINDS: readonly LoginEventKind[] = ["sign-in", "sign-in-failed", "locked", "rate-limited", "sign-out", "password-changed"];

export type LoginFailureReason = "bad-password" | "unknown-user" | "bad-token" | "disabled" | "account-locked";

export interface LoginEventRecord {
  /** `LE-<uuid>`. */
  id: string;
  /** ISO time. */
  at: string;
  kind: LoginEventKind;
  method: "account" | "token";
  /** Account id when known. */
  userId?: string;
  /** Username as attempted (normalised), or the setup token's principal id. */
  username?: string;
  reason?: LoginFailureReason;
  /** Client address as the app resolves it (clientIp.ts); <= 64 chars. */
  ip?: string;
  /** Browser user-agent, <= 200 chars. */
  userAgent?: string;
}

export interface LoginEventQuery {
  userId?: string;
  username?: string;
  kind?: LoginEventKind;
  /** Cursor: id of the last event of the previous page. */
  before?: string;
  limit: number;
}

/** Implemented by SmartFaceDatabase for PostgreSQL, SQLite and the JSON fallback. */
export interface LoginEventStore {
  /** Append (ON CONFLICT DO NOTHING by id). Never throws. */
  saveLoginEvent(event: LoginEventRecord): Promise<boolean>;
  /** Newest first by (at DESC, id DESC). */
  getLoginEventsPage(query: LoginEventQuery): Promise<{ events: LoginEventRecord[]; hasMore: boolean }>;
  /** Delete rows with at < cutoffIso. Returns rows deleted. */
  purgeLoginEvents(cutoffIso: string): Promise<number>;
}

export const newLoginEventId = () => `LE-${randomUUID()}`;

export function loginEventRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber("LOGIN_EVENT_RETENTION_DAYS", 180, { min: 0, max: 3650, integer: true }, env);
}

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

/** What may be stored as the attempted username: a valid username, or a placeholder. */
export function auditUsername(raw: unknown): string | undefined {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return undefined;
  return USERNAME_RE.test(s) ? s : "(không hợp lệ)";
}

/** Trims and strips control characters; undefined when empty. */
export function auditText(raw: unknown, max: number): string | undefined {
  const s = String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
  return s || undefined;
}
