/**
 * Notification channels and alert routing (P3b, plan 2026-10-02 section 5,
 * contract docs/plans/2026-10-07-p3b-contract.md).
 *
 * Admins declare extra chat channels (today: the Eton chat-room webhook type)
 * and route each alert type to one of them. The built-in channel "Eton
 * (chung)" is the existing webhook settings, so nothing changes until an admin
 * routes an alert elsewhere. A channel URL is a secret: it is stored server-side
 * and only ever shown masked.
 */

export const BUILT_IN_CHANNEL_ID = "eton-default";
export const BUILT_IN_CHANNEL_NAME = "Eton (chung)";
export const MAX_CHANNELS = 20;

export type AlertRoute = "stranger" | "presence" | "presenceHealth";
export const ALERT_ROUTES: readonly AlertRoute[] = ["stranger", "presence", "presenceHealth"];
export type NotificationRoutes = Record<AlertRoute, string>;
export const DEFAULT_ROUTES: NotificationRoutes = {
  stranger: BUILT_IN_CHANNEL_ID,
  presence: BUILT_IN_CHANNEL_ID,
  presenceHealth: BUILT_IN_CHANNEL_ID,
};

export interface NotificationChannel {
  id: string;
  name: string;
  type: "eton-webhook";
  url: string;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ChannelView {
  id: string;
  name: string;
  type: "eton-webhook";
  builtIn: boolean;
  enabled: boolean;
  urlMasked: string;
  usedFor: AlertRoute[];
  updatedAt?: string;
  updatedBy?: string;
}

const CHANNEL_ID_RE = /^CH-[0-9a-f-]{36}$/;

/** `https://chat.example.vn/…/x7Qa`: scheme and host, never the path or query (the webhook's secret). */
export function maskWebhookUrl(raw: string): string {
  try {
    const u = new URL(String(raw || ""));
    const tail = (u.pathname + u.search).replace(/\/+$/, "");
    const last = tail.slice(-4);
    return `${u.protocol}//${u.host}${tail.length > 8 ? `/…/${last}` : tail ? "/…" : ""}`;
  } catch {
    return raw ? "(URL không hợp lệ)" : "";
  }
}

/** Stored channels, defensively (a damaged document never breaks sending). */
export function readChannels(stored: unknown): NotificationChannel[] {
  const list = Array.isArray((stored as any)?.channels) ? (stored as any).channels : [];
  return list
    .filter((c: any) => c && CHANNEL_ID_RE.test(String(c.id)) && typeof c.url === "string" && typeof c.name === "string")
    .slice(0, MAX_CHANNELS)
    .map((c: any) => ({
      id: String(c.id),
      name: String(c.name).slice(0, 60),
      type: "eton-webhook" as const,
      url: String(c.url),
      enabled: c.enabled !== false,
      createdAt: String(c.createdAt || ""),
      createdBy: String(c.createdBy || ""),
      updatedAt: String(c.updatedAt || c.createdAt || ""),
      updatedBy: String(c.updatedBy || c.createdBy || ""),
    }));
}

/** Stored routes; an unknown or missing channel falls back to the built-in one. */
export function readRoutes(stored: unknown, knownIds: ReadonlySet<string>): NotificationRoutes {
  const out = { ...DEFAULT_ROUTES };
  for (const r of ALERT_ROUTES) {
    const id = (stored as any)?.[r];
    if (typeof id === "string" && (id === BUILT_IN_CHANNEL_ID || knownIds.has(id))) out[r] = id;
  }
  return out;
}

export type ChannelInput = { name?: string; url?: string; enabled?: boolean };

/** Body of POST (all of name+url required) or PATCH (any subset). URL policy is checked by the caller (netGuard). */
export function parseChannelInput(body: unknown, mode: "create" | "update"):
  | { ok: true; value: ChannelInput }
  | { ok: false; error: string; field?: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const value: ChannelInput = {};
  if (b.name !== undefined) {
    if (typeof b.name !== "string") return { ok: false, error: "Tên kênh phải là chuỗi", field: "name" };
    const name = b.name.trim().replace(/\s+/g, " ");
    if (name.length < 1 || name.length > 60) return { ok: false, error: "Tên kênh dài 1-60 ký tự", field: "name" };
    value.name = name;
  }
  if (b.url !== undefined) {
    if (typeof b.url !== "string") return { ok: false, error: "URL phải là chuỗi", field: "url" };
    const url = b.url.trim();
    if (!url || url.length > 2048) return { ok: false, error: "URL webhook không hợp lệ", field: "url" };
    value.url = url;
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") return { ok: false, error: "enabled phải là true/false", field: "enabled" };
    value.enabled = b.enabled;
  }
  if (mode === "create") {
    if (!value.name) return { ok: false, error: "Cần tên kênh", field: "name" };
    if (!value.url) return { ok: false, error: "Cần URL webhook của kênh", field: "url" };
  } else if (Object.keys(value).length === 0) {
    return { ok: false, error: "Không có thay đổi nào", field: "name" };
  }
  return { ok: true, value };
}

/** Body of PUT /api/notification-routes: any subset of the three routes, each a known channel id. */
export function parseRoutesPatch(body: unknown, knownIds: ReadonlySet<string>):
  | { ok: true; patch: Partial<NotificationRoutes> }
  | { ok: false; error: string; code: string; field?: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const patch: Partial<NotificationRoutes> = {};
  for (const key of Object.keys(b)) {
    if (!(ALERT_ROUTES as readonly string[]).includes(key)) return { ok: false, error: `Loại cảnh báo không hợp lệ: ${key.slice(0, 40)}`, code: "ROUTE_UNKNOWN", field: key.slice(0, 40) };
  }
  for (const r of ALERT_ROUTES) {
    if (b[r] === undefined) continue;
    const id = b[r];
    if (typeof id !== "string" || !(id === BUILT_IN_CHANNEL_ID || knownIds.has(id))) {
      return { ok: false, error: "Kênh không tồn tại", code: "CHANNEL_UNKNOWN", field: r };
    }
    patch[r] = id;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "Không có thay đổi nào", code: "ROUTE_EMPTY" };
  return { ok: true, patch };
}

/** What the admin screen shows: the built-in channel first, URLs masked, which alerts use each channel. */
export function channelViews(
  channels: NotificationChannel[],
  builtIn: { url: string; enabled: boolean },
  routes: NotificationRoutes,
): ChannelView[] {
  const usedFor = (id: string) => ALERT_ROUTES.filter((r) => routes[r] === id);
  return [
    {
      id: BUILT_IN_CHANNEL_ID,
      name: BUILT_IN_CHANNEL_NAME,
      type: "eton-webhook",
      builtIn: true,
      enabled: builtIn.enabled && Boolean(builtIn.url),
      urlMasked: maskWebhookUrl(builtIn.url),
      usedFor: usedFor(BUILT_IN_CHANNEL_ID),
    },
    ...channels.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      builtIn: false,
      enabled: c.enabled,
      urlMasked: maskWebhookUrl(c.url),
      usedFor: usedFor(c.id),
      updatedAt: c.updatedAt,
      updatedBy: c.updatedBy,
    })),
  ];
}

/** Where an alert goes now: the routed channel's URL, or null when that channel is off/missing. */
export function routeTarget(
  route: AlertRoute,
  routes: NotificationRoutes,
  channels: NotificationChannel[],
  builtIn: { url: string; enabled: boolean },
): { id: string; name: string; url: string; builtIn: boolean } | null {
  const id = routes[route];
  if (id === BUILT_IN_CHANNEL_ID) {
    return builtIn.enabled && builtIn.url ? { id, name: BUILT_IN_CHANNEL_NAME, url: builtIn.url, builtIn: true } : null;
  }
  const c = channels.find((x) => x.id === id);
  return c && c.enabled && c.url ? { id: c.id, name: c.name, url: c.url, builtIn: false } : null;
}
