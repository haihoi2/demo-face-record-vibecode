/**
 * Notification channels and alert routing ("Kênh thông báo" on the Webhook
 * tab), P3b contract docs/plans/2026-10-07-p3b-contract.md section 2 (admin):
 *
 *   GET    /api/notification-channels       -> { success, channels: ChannelView[], routes }
 *   POST   /api/notification-channels       { name, url, enabled? }  -> { success, channel }
 *   PATCH  /api/notification-channels/:id   { name?, url?, enabled? } -> { success, channel }
 *   DELETE /api/notification-channels/:id   -> { success }
 *   POST   /api/notification-channels/:id/test -> { success, statusCode?, error? }
 *   PUT    /api/notification-routes         { stranger?, presence?, presenceHealth? } -> { success, routes }
 *
 * The server never returns a channel URL, only `urlMasked`; nothing here reads,
 * keeps or logs a `url` field from a reply. A URL typed by the admin travels
 * once in a request body. The server owns validation (destination guard,
 * https, limits); the checks here only catch obvious typos before a request.
 * Types are local (not src/types.ts) on purpose. Everything here is pure.
 */

export type ChannelUse = "stranger" | "presence" | "presenceHealth";
export const CHANNEL_USES: readonly ChannelUse[] = ["stranger", "presence", "presenceHealth"];

export interface ChannelView {
  id: string;
  name: string;
  type: string;
  builtIn: boolean;
  enabled: boolean;
  urlMasked: string;
  usedFor: ChannelUse[];
  updatedAt?: string;
  updatedBy?: string;
}

export type NotificationRoutes = Record<ChannelUse, string>;

export const BUILT_IN_CHANNEL_ID = "eton-default";
export const BUILT_IN_NOTE = "Eton (chung) - sửa URL ở phần Webhook phía trên";
export const CHANNEL_NAME_MAX = 60;
export const CHANNELS_URL = "/api/notification-channels";
export const ROUTES_URL = "/api/notification-routes";

/** Labels of the routing selects and of the "Dùng cho" chips. */
export const USE_LABEL: Record<ChannelUse, string> = {
  stranger: "Người lạ",
  presence: "Có người ngoài giờ",
  presenceHealth: "Phát hiện người ngừng hoạt động",
};

export const channelUseLabel = (use: string): string => (USE_LABEL as Record<string, string>)[use] ?? String(use || "—");

export const DEFAULT_ROUTES: NotificationRoutes = {
  stranger: BUILT_IN_CHANNEL_ID,
  presence: BUILT_IN_CHANNEL_ID,
  presenceHealth: BUILT_IN_CHANNEL_ID,
};

/** Built-in channel: no edit, no delete, on/off is the Webhook setting above. */
export const isBuiltInChannel = (c: Pick<ChannelView, "id" | "builtIn">): boolean => c.builtIn === true || c.id === BUILT_IN_CHANNEL_ID;

/** What is shown for the destination: the server's masked text only. */
export const maskedUrlText = (c: Pick<ChannelView, "urlMasked">): string => (c.urlMasked ? c.urlMasked : "—");

/** Name shown in the routing select; a channel that is off says so. */
export const channelOptionLabel = (c: Pick<ChannelView, "name" | "enabled" | "id">): string =>
  `${c.name || c.id}${c.enabled ? "" : " (đang tắt)"}`;

// ---------------------------------------------------------------------------
// Response parsing (never throws)
// ---------------------------------------------------------------------------

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** One channel, or null. Only known fields are copied; a `url` field is never kept. */
export function parseChannel(raw: unknown): ChannelView | null {
  const c = raw as any;
  if (!c || typeof c !== "object") return null;
  const id = str(c.id);
  if (!id) return null;
  const usedFor: ChannelUse[] = Array.isArray(c.usedFor)
    ? CHANNEL_USES.filter((u) => (c.usedFor as unknown[]).includes(u))
    : [];
  return {
    id,
    name: str(c.name) ?? id,
    type: str(c.type) ?? "eton-webhook",
    builtIn: c.builtIn === true || id === BUILT_IN_CHANNEL_ID,
    enabled: c.enabled === true,
    urlMasked: str(c.urlMasked) ?? "",
    usedFor,
    ...(str(c.updatedAt) ? { updatedAt: c.updatedAt } : {}),
    ...(str(c.updatedBy) ? { updatedBy: c.updatedBy } : {}),
  };
}

/** Routes from a reply; a missing or malformed key falls back to the built-in channel (the contract default). */
export function parseRoutes(raw: unknown): NotificationRoutes {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    stranger: str(r.stranger) ?? DEFAULT_ROUTES.stranger,
    presence: str(r.presence) ?? DEFAULT_ROUTES.presence,
    presenceHealth: str(r.presenceHealth) ?? DEFAULT_ROUTES.presenceHealth,
  };
}

/** The GET reply; null when it is not a success payload. Malformed or repeated channels are dropped; built-in first. */
export function parseChannelsResponse(data: unknown): { channels: ChannelView[]; routes: NotificationRoutes } | null {
  const d = data as any;
  if (!d || typeof d !== "object" || d.success !== true || !Array.isArray(d.channels)) return null;
  const channels: ChannelView[] = [];
  for (const raw of d.channels) {
    const c = parseChannel(raw);
    if (c && !channels.some((x) => x.id === c.id)) channels.push(c);
  }
  channels.sort((a, b) => Number(isBuiltInChannel(b)) - Number(isBuiltInChannel(a)));
  return { channels, routes: parseRoutes(d.routes) };
}

/** Message for a refused or failed request: the server's own text when it sent one (DEST_* texts are Vietnamese). */
export function channelErrorText(res: { status: number; data?: any; error?: string }): string {
  const serverText = typeof res.data?.error === "string" && res.data.error.trim() ? res.data.error : "";
  if (serverText) return serverText;
  if (res.status === 0) return res.error || "Không kết nối được máy chủ";
  return res.error || `Yêu cầu thất bại (HTTP ${res.status})`;
}

type Reply = { ok: boolean; status: number; data?: unknown; error?: string };
const isSuccess = (res: Reply): boolean =>
  res.ok && res.status >= 200 && res.status < 300 && !!res.data && typeof res.data === "object" && (res.data as any).success === true;

export type ChannelOutcome = { ok: true; channel: ChannelView } | { ok: false; status: number; error: string; field?: string; code?: string };

const failure = (res: Reply): { ok: false; status: number; error: string; field?: string; code?: string } => {
  const data = (res.data && typeof res.data === "object" ? res.data : {}) as any;
  const field = str(data.field);
  const code = str(data.code);
  return { ok: false, status: res.status, error: channelErrorText({ status: res.status, data, error: res.error }), ...(field ? { field } : {}), ...(code ? { code } : {}) };
};

/** POST/PATCH reply: success only for a 2xx with `success: true` and a well-formed channel. */
export function readChannelResult(res: Reply): ChannelOutcome {
  if (isSuccess(res)) {
    const channel = parseChannel((res.data as any).channel);
    if (channel) return { ok: true, channel };
    return { ok: false, status: res.status, error: "Máy chủ trả về dữ liệu không hợp lệ." };
  }
  return failure(res);
}

/** DELETE reply. */
export function readDeleteResult(res: Reply): { ok: true } | { ok: false; status: number; error: string; code?: string } {
  return isSuccess(res) ? { ok: true } : failure(res);
}

/** PUT routes reply. */
export function readRoutesResult(res: Reply): { ok: true; routes: NotificationRoutes } | { ok: false; status: number; error: string; field?: string; code?: string } {
  if (isSuccess(res)) return { ok: true, routes: parseRoutes((res.data as any).routes) };
  return failure(res);
}

/**
 * Test reply: `success: true` means the chat server accepted the message.
 * HTTP 200 with `success: false` is the chat server refusing; both that and an
 * HTTP refusal show the server's text, never a success.
 */
export function readTestResult(res: Reply): { ok: boolean; text: string } {
  const data = (res.data && typeof res.data === "object" ? res.data : {}) as any;
  const statusCode = typeof data.statusCode === "number" && Number.isFinite(data.statusCode) ? data.statusCode : undefined;
  if (isSuccess(res)) {
    return { ok: true, text: `Đã gửi tin thử${statusCode ? ` (máy chủ chat trả HTTP ${statusCode})` : ""}.` };
  }
  if (res.ok && data.success === false) {
    const reason = str(data.error) ?? (statusCode ? `máy chủ chat trả HTTP ${statusCode}` : "không rõ nguyên nhân");
    return { ok: false, text: `Gửi thử thất bại: ${reason}` };
  }
  return { ok: false, text: `Gửi thử thất bại: ${channelErrorText({ status: res.status, data, error: res.error })}` };
}

// ---------------------------------------------------------------------------
// Validation and requests (sent through operatorJsonFetch: credentials, CSRF, 401 sign-in)
// ---------------------------------------------------------------------------

export interface ChannelDraft {
  name: string;
  /** Typed by the admin; empty in the edit form means "keep the current URL". */
  url: string;
  enabled: boolean;
}

export type ChannelFieldErrors = Partial<Record<"name" | "url", string>>;

export function validateChannelName(name: string): string | undefined {
  const n = String(name ?? "").trim();
  if (!n) return "Nhập tên kênh.";
  if (n.length > CHANNEL_NAME_MAX) return `Tên kênh tối đa ${CHANNEL_NAME_MAX} ký tự.`;
  return undefined;
}

/** Shape check only; the destination guard (and https) is the server's decision. */
export function validateChannelUrl(url: string): string | undefined {
  const u = String(url ?? "").trim();
  if (!u) return "Nhập URL webhook.";
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return "URL không hợp lệ.";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "URL phải bắt đầu bằng https://";
  if (!parsed.hostname) return "URL không hợp lệ.";
  return undefined;
}

type RequestOut = { url: string; init: RequestInit };
const json = (method: string, body?: unknown): RequestInit =>
  body === undefined
    ? { method, headers: { "Content-Type": "application/json" } }
    : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };

export const channelPath = (id: string): string => `${CHANNELS_URL}/${encodeURIComponent(id)}`;

export function buildCreateChannelRequest(draft: ChannelDraft): { ok: true; request: RequestOut } | { ok: false; errors: ChannelFieldErrors } {
  const errors: ChannelFieldErrors = {};
  const nameError = validateChannelName(draft.name);
  const urlError = validateChannelUrl(draft.url);
  if (nameError) errors.name = nameError;
  if (urlError) errors.url = urlError;
  if (nameError || urlError) return { ok: false, errors };
  return {
    ok: true,
    request: { url: CHANNELS_URL, init: json("POST", { name: draft.name.trim(), url: draft.url.trim(), enabled: draft.enabled === true }) },
  };
}

/**
 * PATCH with only the changed fields. A blank URL keeps the current one. The
 * built-in channel is refused here too (the server answers CHANNEL_BUILT_IN).
 */
export function buildUpdateChannelRequest(
  current: ChannelView,
  draft: ChannelDraft,
): { ok: true; request: RequestOut | null } | { ok: false; errors: ChannelFieldErrors; error?: string } {
  if (isBuiltInChannel(current)) return { ok: false, errors: {}, error: BUILT_IN_NOTE };
  const errors: ChannelFieldErrors = {};
  const nameError = validateChannelName(draft.name);
  const url = String(draft.url ?? "").trim();
  const urlError = url ? validateChannelUrl(url) : undefined;
  if (nameError) errors.name = nameError;
  if (urlError) errors.url = urlError;
  if (nameError || urlError) return { ok: false, errors };
  const body: { name?: string; url?: string; enabled?: boolean } = {};
  if (draft.name.trim() !== current.name) body.name = draft.name.trim();
  if (url) body.url = url;
  if (draft.enabled !== current.enabled) body.enabled = draft.enabled;
  if (Object.keys(body).length === 0) return { ok: true, request: null };
  return { ok: true, request: { url: channelPath(current.id), init: json("PATCH", body) } };
}

export function buildToggleChannelRequest(current: ChannelView, enabled: boolean): RequestOut | null {
  if (isBuiltInChannel(current)) return null;
  return { url: channelPath(current.id), init: json("PATCH", { enabled }) };
}

export function buildDeleteChannelRequest(current: ChannelView): RequestOut | null {
  if (isBuiltInChannel(current)) return null;
  return { url: channelPath(current.id), init: json("DELETE") };
}

export const buildTestChannelRequest = (id: string): RequestOut => ({ url: `${channelPath(id)}/test`, init: json("POST", {}) });

/** PUT with only the keys that changed; null when nothing changed. */
export function buildRoutesRequest(current: NotificationRoutes, next: Partial<NotificationRoutes>): RequestOut | null {
  const body: Partial<NotificationRoutes> = {};
  for (const use of CHANNEL_USES) {
    const v = next[use];
    if (typeof v === "string" && v && v !== current[use]) body[use] = v;
  }
  if (Object.keys(body).length === 0) return null;
  return { url: ROUTES_URL, init: json("PUT", body) };
}

/**
 * "Dùng cho" chips. Derived from the server's routes (the latest reply, also
 * right after a routes PUT); the channel's own usedFor is only a fallback for
 * a reply without routes.
 */
export function channelUses(channel: ChannelView, routes: NotificationRoutes | null): ChannelUse[] {
  if (!routes) return channel.usedFor;
  return CHANNEL_USES.filter((u) => routes[u] === channel.id);
}

/** Routing select options: every channel listed, plus the routed id when the list no longer has it. */
export function routeOptions(channels: readonly ChannelView[], selected: string): Array<{ value: string; label: string }> {
  const options = channels.map((c) => ({ value: c.id, label: channelOptionLabel(c) }));
  if (selected && !channels.some((c) => c.id === selected)) options.push({ value: selected, label: `${selected} (không còn trong danh sách)` });
  return options;
}
