/**
 * Sign-in history for the admin "Tài khoản" page (owner 2026-10-02: "audit
 * login history for user").
 *
 * Browser side of the contract in src/server/loginEvents.ts:
 *   GET /api/users/login-events?userId=&username=&kind=&before=&limit=   (admin)
 *   200 { success, events: LoginEventRecord[] (newest first), hasMore, nextCursor? }
 *
 * The types are mirrored here instead of imported so the browser bundle never
 * pulls a server module; tests/loginHistoryUi.test.ts checks the mirror against
 * the server's list of kinds.
 *
 * Everything here is pure (no fetch, no React) so it can be unit-tested. All
 * strings that come from the server (username, IP, user-agent) are attacker
 * controlled; the page renders them as React text only.
 */

export type LoginEventKind = "sign-in" | "sign-in-failed" | "locked" | "rate-limited" | "sign-out" | "password-changed";
export type LoginFailureReason = "bad-password" | "unknown-user" | "bad-token" | "disabled" | "account-locked";

export interface LoginEventRecord {
  id: string;
  at: string;
  kind: LoginEventKind;
  method: "account" | "token";
  userId?: string;
  username?: string;
  reason?: LoginFailureReason;
  ip?: string;
  userAgent?: string;
}

export const LOGIN_EVENT_KINDS: readonly LoginEventKind[] = [
  "sign-in",
  "sign-in-failed",
  "locked",
  "rate-limited",
  "sign-out",
  "password-changed",
];

/** Kinds an admin reads as "something went wrong". */
export const LOGIN_FAILURE_KINDS: readonly LoginEventKind[] = ["sign-in-failed", "locked", "rate-limited"];

export const isLoginFailureKind = (kind: string): boolean => (LOGIN_FAILURE_KINDS as readonly string[]).includes(kind);

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const LOGIN_KIND_LABEL: Record<LoginEventKind, string> = {
  "sign-in": "Đăng nhập",
  "sign-in-failed": "Đăng nhập thất bại",
  locked: "Bị khóa",
  "rate-limited": "Bị chặn tạm (quá nhiều lần)",
  "sign-out": "Đăng xuất",
  "password-changed": "Đổi mật khẩu",
};

export type LoginKindTone = "success" | "danger" | "warning" | "neutral";

const KIND_TONE: Record<LoginEventKind, LoginKindTone> = {
  "sign-in": "success",
  "sign-in-failed": "danger",
  locked: "warning",
  "rate-limited": "warning",
  "sign-out": "neutral",
  "password-changed": "neutral",
};

export const LOGIN_TONE_CLASS: Record<LoginKindTone, string> = {
  success: "bg-emerald-50 text-emerald-800 border-emerald-200",
  danger: "bg-rose-50 text-rose-700 border-rose-200",
  warning: "bg-amber-50 text-amber-800 border-amber-200",
  neutral: "bg-slate-100 text-slate-600 border-slate-200",
};

/** Label for a kind; an unknown kind (newer server) is shown as-is. */
export const loginKindLabel = (kind: string): string =>
  (LOGIN_KIND_LABEL as Record<string, string>)[kind] ?? String(kind || "—");

export const loginKindTone = (kind: string): LoginKindTone => (KIND_TONE as Record<string, LoginKindTone>)[kind] ?? "neutral";

export const LOGIN_REASON_LABEL: Record<LoginFailureReason, string> = {
  "bad-password": "Sai mật khẩu",
  "unknown-user": "Không có tài khoản",
  "bad-token": "Sai mã khởi tạo",
  disabled: "Tài khoản đã khóa bởi quản trị",
  "account-locked": "Tạm khóa do sai nhiều lần",
};

/** Empty string when there is no reason; an unknown reason is shown as-is. */
export const loginReasonLabel = (reason: string | undefined | null): string =>
  reason ? (LOGIN_REASON_LABEL as Record<string, string>)[reason] ?? String(reason) : "";

export const loginMethodLabel = (method: string | undefined | null): string =>
  method === "token" ? "Mã khởi tạo" : method === "account" ? "Tài khoản" : "—";

/** vi-VN date and time to the second; the raw string when it does not parse. */
export function formatLoginTime(iso: string, timeZone?: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso || "—");
  return new Date(t).toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  });
}

// ---------------------------------------------------------------------------
// User-agent -> short label
// ---------------------------------------------------------------------------

/** Non-browser clients, checked first (first match wins). */
const TOOL_PATTERNS: Array<[RegExp, string]> = [
  [/^curl\//i, "curl"],
  [/^wget\//i, "Wget"],
  [/python-requests|python-urllib|aiohttp|httpx/i, "Python"],
  [/^Go-http-client/i, "Go"],
  [/PostmanRuntime/i, "Postman"],
  [/insomnia/i, "Insomnia"],
  [/^node-fetch|^undici|^axios|^node\b/i, "Node.js"],
  [/okhttp/i, "OkHttp"],
  [/^Java\//i, "Java"],
  [/libwww-perl/i, "Perl"],
  [/powershell/i, "PowerShell"],
  [/bot\b|crawler|spider/i, "Bot"],
];

const BROWSER_PATTERNS: Array<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bCocCoc\b|\bcoc_coc_browser\//i, "Cốc Cốc"],
  [/\bZalo\b/i, "Zalo"],
  [/\bFBAN\/|\bFBAV\//, "Facebook"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\/|\bChromium\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\/|\bSafari\/.*\bVersion\//, "Safari"],
  [/\bMSIE\b|\bTrident\//, "Internet Explorer"],
];

const OS_PATTERNS: Array<[RegExp, string]> = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

/**
 * "Chrome · Windows", "Safari · iPhone", "curl" ... from a user-agent string.
 * "—" when missing; a short, safe excerpt when nothing is recognised.
 * The full string belongs in a title tooltip.
 */
export function userAgentLabel(ua: string | undefined | null): string {
  const s = String(ua ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!s) return "—";
  for (const [re, name] of TOOL_PATTERNS) if (re.test(s)) return name;
  const browser = BROWSER_PATTERNS.find(([re]) => re.test(s))?.[1];
  const os = OS_PATTERNS.find(([re]) => re.test(s))?.[1];
  if (browser && os) return `${browser} · ${os}`;
  if (browser) return browser;
  if (os) return `Trình duyệt · ${os}`;
  // Unrecognised: first product token, kept short.
  const first = s.split(/\s+/)[0].slice(0, 24);
  return first || "Không rõ";
}

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

export const LOGIN_EVENTS_PAGE_SIZE = 50;

export interface LoginEventsRequest {
  userId?: string;
  username?: string;
  kind?: LoginEventKind;
  before?: string;
  limit?: number;
}

/** GET URL for one page. limit is clamped to 1..200 as the server requires. */
export function buildLoginEventsUrl(req: LoginEventsRequest): string {
  const params = new URLSearchParams();
  if (req.userId) params.set("userId", req.userId);
  if (req.username) params.set("username", req.username);
  if (req.kind) params.set("kind", req.kind);
  if (req.before) params.set("before", req.before);
  const raw = Number(req.limit ?? LOGIN_EVENTS_PAGE_SIZE);
  const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.trunc(raw))) : LOGIN_EVENTS_PAGE_SIZE;
  params.set("limit", String(limit));
  return `/api/users/login-events?${params.toString()}`;
}

const optString = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Keeps well-formed rows only (id, at and kind are strings); never throws. */
export function parseLoginEventsPage(data: unknown): { events: LoginEventRecord[]; hasMore: boolean; nextCursor?: string } | null {
  const d = data as any;
  if (!d || typeof d !== "object" || d.success !== true || !Array.isArray(d.events)) return null;
  const events: LoginEventRecord[] = [];
  for (const e of d.events) {
    if (!e || typeof e !== "object" || typeof e.id !== "string" || !e.id || typeof e.at !== "string" || typeof e.kind !== "string") continue;
    events.push({
      id: e.id,
      at: e.at,
      kind: e.kind as LoginEventKind,
      method: e.method === "token" ? "token" : "account",
      userId: optString(e.userId),
      username: optString(e.username),
      reason: optString(e.reason) as LoginFailureReason | undefined,
      ip: optString(e.ip),
      userAgent: optString(e.userAgent),
    });
  }
  const nextCursor = optString(d.nextCursor) ?? (events.length ? events[events.length - 1].id : undefined);
  return { events, hasMore: d.hasMore === true && !!nextCursor, nextCursor };
}

/** Message for a refused or failed request: the server's own text when it sent one. */
export function loginEventsErrorText(res: { status: number; data?: any; error?: string }): string {
  const serverText = typeof res.data?.error === "string" && res.data.error ? res.data.error : "";
  if (serverText) return serverText;
  if (res.status === 0) return res.error || "Không kết nối được máy chủ";
  return res.error || `Không tải được lịch sử đăng nhập (HTTP ${res.status})`;
}

// ---------------------------------------------------------------------------
// Paging across one or more server streams
// ---------------------------------------------------------------------------

/**
 * The server filters by ONE kind. "Only failures" is three kinds, so the page
 * keeps one stream per kind and merges them; "all" or a single kind is one
 * stream. A row is shown only when no stream that still has older rows could
 * hold a row newer than it - so the merged list is always in the server's
 * order (at DESC, id DESC) with no gaps, whatever the mix of kinds.
 */
export interface LoginEventStream {
  kind?: LoginEventKind;
  events: LoginEventRecord[];
  hasMore: boolean;
  nextCursor?: string;
}

/** Sort comparator in server order (at DESC, id DESC): negative when a is newer than b. */
export function compareLoginEventsNewestFirst(a: LoginEventRecord, b: LoginEventRecord): number {
  const ta = Date.parse(a.at);
  const tb = Date.parse(b.at);
  const da = Number.isFinite(ta) ? ta : -Infinity;
  const db = Number.isFinite(tb) ? tb : -Infinity;
  if (da !== db) return db > da ? 1 : -1;
  if (a.id === b.id) return 0;
  return b.id > a.id ? 1 : -1;
}

/** Append a page to a stream, dropping ids it already has (a row may repeat if the list shifted). */
export function appendLoginEventsPage(
  stream: LoginEventStream,
  page: { events: LoginEventRecord[]; hasMore: boolean; nextCursor?: string },
): LoginEventStream {
  const seen = new Set(stream.events.map((e) => e.id));
  const fresh: LoginEventRecord[] = [];
  for (const e of page.events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    fresh.push(e);
  }
  return {
    kind: stream.kind,
    events: [...stream.events, ...fresh],
    // A page that brought nothing new cannot move the cursor; stop rather than loop.
    hasMore: page.hasMore && fresh.length > 0,
    nextCursor: page.nextCursor,
  };
}

/** The stream that limits what can be shown; the one "Tải thêm" should advance. */
export function streamToAdvance(streams: LoginEventStream[]): number {
  let best = -1;
  for (let i = 0; i < streams.length; i++) {
    const s = streams[i];
    if (!s.hasMore) continue;
    if (s.events.length === 0) return i;
    if (best < 0) {
      best = i;
      continue;
    }
    const a = s.events[s.events.length - 1];
    const b = streams[best].events[streams[best].events.length - 1];
    if (compareLoginEventsNewestFirst(a, b) < 0) best = i; // a is newer -> it blocks more
  }
  return best;
}

/** Rows that can be shown now, newest first, and whether more exist. */
export function mergeLoginEventStreams(streams: LoginEventStream[]): { visible: LoginEventRecord[]; hasMore: boolean } {
  const all: LoginEventRecord[] = [];
  const seen = new Set<string>();
  for (const s of streams) {
    for (const e of s.events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      all.push(e);
    }
  }
  all.sort(compareLoginEventsNewestFirst);
  const limiting = streamToAdvance(streams);
  if (limiting < 0) return { visible: all, hasMore: false };
  const frontierStream = streams[limiting];
  if (frontierStream.events.length === 0) return { visible: [], hasMore: true };
  const frontier = frontierStream.events[frontierStream.events.length - 1];
  const visible = all.filter((e) => compareLoginEventsNewestFirst(e, frontier) <= 0);
  return { visible, hasMore: true };
}

// ---------------------------------------------------------------------------
// Kind filter and summary
// ---------------------------------------------------------------------------

export type LoginKindFilter = "all" | "failures" | LoginEventKind;

export const LOGIN_KIND_FILTER_OPTIONS: Array<{ value: LoginKindFilter; label: string }> = [
  { value: "all", label: "Tất cả" },
  { value: "failures", label: "Chỉ thất bại (sai, bị khóa, bị chặn)" },
  ...LOGIN_EVENT_KINDS.map((k) => ({ value: k as LoginKindFilter, label: `Chỉ: ${LOGIN_KIND_LABEL[k]}` })),
];

/** One stream per server query the filter needs. */
export function streamsForFilter(filter: LoginKindFilter): LoginEventStream[] {
  if (filter === "all") return [{ events: [], hasMore: true }];
  if (filter === "failures") return LOGIN_FAILURE_KINDS.map((kind) => ({ kind, events: [], hasMore: true }));
  return [{ kind: filter, events: [], hasMore: true }];
}

export const parseLoginKindFilter = (value: string): LoginKindFilter =>
  value === "all" || value === "failures" || (LOGIN_EVENT_KINDS as readonly string[]).includes(value)
    ? (value as LoginKindFilter)
    : "all";

export interface LoginFailureSummary {
  failures: number;
  distinctIps: number;
  /** True when the loaded rows reach back past the window (or there is nothing older). */
  complete: boolean;
  loadedRows: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Failures (sign-in-failed, locked, rate-limited) in the last `windowMs` among
 * the rows already loaded, and how many distinct IPs they came from.
 */
export function summarizeLoginFailures(
  visible: LoginEventRecord[],
  hasMore: boolean,
  nowMs: number,
  windowMs = DAY_MS,
): LoginFailureSummary {
  const since = nowMs - windowMs;
  const ips = new Set<string>();
  let failures = 0;
  let oldest = Infinity;
  for (const e of visible) {
    const t = Date.parse(e.at);
    if (Number.isFinite(t) && t < oldest) oldest = t;
    if (!Number.isFinite(t) || t < since || !isLoginFailureKind(e.kind)) continue;
    failures++;
    if (e.ip) ips.add(e.ip);
  }
  return { failures, distinctIps: ips.size, complete: !hasMore || oldest < since, loadedRows: visible.length };
}
