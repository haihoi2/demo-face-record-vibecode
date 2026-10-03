/**
 * Person-presence review ("Hiện diện" tab), plan
 * docs/plans/2026-10-02-person-presence-alerts.md, phase P2 (SHADOW).
 *
 * Browser side of the contract in src/server/presence/contracts.ts:
 *   GET  /api/presence/status                      (viewer)
 *     -> { success, gates: [{ gateId, mode: "off"|"shadow", fps, lastFrameAgeMs,
 *                              worker: { state, restarts, models }, lastEventAt }] }
 *   GET  /api/presence/events?gate&period&faceOutcome&label&before&limit   (operator)
 *     -> { success, events: PresenceEventRecord[] newest first (each with label?), hasMore, nextCursor? }
 *   GET  /api/presence/events/:id/crop             (operator, protected image)
 *   POST /api/presence/events/:id/label  { kind }  (operator, CSRF) -> { success, event }
 * As implemented in server.ts (feat/presence-p2 3ab4912): `label=none` lists
 * events without a label; a status gate may carry a `note`; `worker` may be
 * null before the presence host is wired; a row may carry `cropPurgedAt`.
 *
 * The record types are mirrored here instead of imported so the browser bundle
 * never pulls a server module; tests/presenceUi.test.ts checks the mirror
 * against the contract at compile time.
 *
 * Everything here is pure (no fetch, no React) so it can be unit-tested.
 * Presence events only record that a person was in view; nothing here, or in
 * the panel, can open a door or send a message.
 */

export type PresencePeriod = "working" | "after-hours";
export type PresenceFaceOutcome = "employee" | "stranger" | "none";
export type PresenceLabelKind = "real" | "false-alarm" | "employee";
export type PresenceMode = "off" | "shadow";

export const PRESENCE_PERIODS: readonly PresencePeriod[] = ["working", "after-hours"];
export const PRESENCE_FACE_OUTCOMES: readonly PresenceFaceOutcome[] = ["employee", "stranger", "none"];
export const PRESENCE_LABEL_KINDS: readonly PresenceLabelKind[] = ["real", "false-alarm", "employee"];

/** Working hours are defined in this zone (contract PresenceRules.workingHours); times are shown in it so they agree with the period badge. */
export const PRESENCE_TIME_ZONE = "Asia/Ho_Chi_Minh";

/** Mirror of PresenceEventRecord (+ the list's optional `label`). */
export interface PresenceEventView {
  id: string;
  gateId: string;
  trackId: string;
  startedAt: string;
  endedAt?: string;
  inViewMs: number;
  framesSeen: number;
  peakPersons: number;
  period: PresencePeriod;
  faceOutcome: PresenceFaceOutcome;
  linkedLogIds?: string[];
  linkedEmployeeIds?: string[];
  wouldAlert: boolean;
  alertSentAt?: string | null;
  bestBox: [number, number, number, number];
  bestScore: number;
  bestFrameAt: string;
  models: string[];
  hasCrop: boolean;
  createdAt: string;
  label?: PresenceLabelKind;
  /** Set by the server once the crop was erased by retention. */
  cropPurgedAt?: string;
}

export interface PresenceGateStatus {
  gateId: string;
  /** "off" | "shadow" today; an unknown future mode is kept as-is and never described as shadow. */
  mode: string;
  fps: number | null;
  lastFrameAgeMs: number | null;
  worker: { state: string | null; restarts: number | null; models: string[] };
  lastEventAt: string | null;
  /** Server's explanation, e.g. the gate needs the real-time engine stream. Plain text. */
  note?: string;
}

// ---------------------------------------------------------------------------
// Labels and badges
// ---------------------------------------------------------------------------

export type PresenceTone = "emerald" | "sky" | "amber" | "rose" | "slate" | "indigo";

export const PRESENCE_TONE_CLASS: Record<PresenceTone, string> = {
  emerald: "bg-emerald-50 text-emerald-800 border-emerald-200",
  sky: "bg-sky-50 text-sky-800 border-sky-200",
  amber: "bg-amber-50 text-amber-900 border-amber-300",
  rose: "bg-rose-50 text-rose-700 border-rose-200",
  slate: "bg-slate-100 text-slate-700 border-slate-200",
  indigo: "bg-indigo-50 text-indigo-700 border-indigo-200",
};

export const PERIOD_LABEL: Record<PresencePeriod, string> = {
  working: "Giờ làm",
  "after-hours": "Ngoài giờ",
};

export const FACE_OUTCOME_LABEL: Record<PresenceFaceOutcome, string> = {
  employee: "Nhân viên",
  stranger: "Người lạ",
  none: "Không thấy mặt",
};

/** Text of the label as it is shown on a row. */
export const LABEL_KIND_LABEL: Record<PresenceLabelKind, string> = {
  real: "Đúng là người",
  "false-alarm": "Báo nhầm",
  employee: "Nhân viên",
};

/** The three label buttons, in order, with a tooltip each. */
export const LABEL_ACTIONS: ReadonlyArray<{ kind: PresenceLabelKind; text: string; hint: string; tone: PresenceTone }> = [
  { kind: "real", text: "Đúng là người", hint: "Có người thật trong khung hình (kể cả không thấy mặt).", tone: "emerald" },
  {
    kind: "false-alarm",
    text: "Báo nhầm",
    hint: "Không có người: bóng, phản chiếu, xe nâng, áp phích...",
    tone: "rose",
  },
  { kind: "employee", text: "Nhân viên", hint: "Người trong khung hình là nhân viên.", tone: "indigo" },
];

export const WOULD_ALERT_BADGE = "Sẽ cảnh báo";
export const WOULD_ALERT_HINT =
  "Theo quy tắc hiện tại sự kiện này sẽ được gửi cảnh báo (ngoài giờ, không có nhân viên được nhận diện). Ở chế độ chạy thử không gửi gì.";

export const SHADOW_NOTICE = "Chế độ chạy thử: chỉ ghi nhận, chưa gửi cảnh báo";

/** Label for a period; an unknown value (newer server) is shown as-is. */
export const periodLabel = (period: string): string =>
  (PERIOD_LABEL as Record<string, string>)[period] ?? String(period || "—");

export const periodTone = (period: string): PresenceTone =>
  period === "after-hours" ? "amber" : period === "working" ? "sky" : "slate";

export const faceOutcomeLabel = (outcome: string): string =>
  (FACE_OUTCOME_LABEL as Record<string, string>)[outcome] ?? String(outcome || "—");

export const faceOutcomeTone = (outcome: string): PresenceTone =>
  outcome === "employee" ? "emerald" : outcome === "stranger" ? "rose" : "slate";

/** "Chưa gắn nhãn" when there is none; an unknown kind is shown as-is. */
export const labelKindLabel = (kind: string | undefined | null): string =>
  kind ? (LABEL_KIND_LABEL as Record<string, string>)[kind] ?? String(kind) : "Chưa gắn nhãn";

export const labelKindTone = (kind: string | undefined | null): PresenceTone =>
  LABEL_ACTIONS.find((a) => a.kind === kind)?.tone ?? "slate";

/** The "Sẽ cảnh báo" badge shows only for a literal `true` from the server. */
export const showWouldAlert = (event: { wouldAlert?: unknown } | null | undefined): boolean => event?.wouldAlert === true;

export const isPresenceLabelKind = (v: unknown): v is PresenceLabelKind =>
  typeof v === "string" && (PRESENCE_LABEL_KINDS as readonly string[]).includes(v);

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** vi-VN date and time to the second, in the working-hours zone; the raw string when it does not parse. */
export function formatPresenceTime(iso: string | null | undefined, timeZone: string = PRESENCE_TIME_ZONE): string {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return iso ? String(iso) : "—";
  return new Date(t).toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  });
}

/** Time in view: "2,8 giây", "45 giây", "3 phút 05 giây"; em dash when unknown. */
export function formatInView(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1).replace(".", ",")} giây`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} giây`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes} phút ${String(seconds).padStart(2, "0")} giây`;
}

/** "1 người", "3 người"; em dash when unknown. */
export function formatPeople(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
  return `${Math.round(n)} người`;
}

/** How long ago, short: "12 giây trước", "5 phút trước", "3 giờ trước", else the full time. */
export function formatAgo(iso: string | null | undefined, nowMs: number): string {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return iso ? String(iso) : "Chưa có";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return `${s} giây trước`;
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86_400) return `${Math.floor(s / 3600)} giờ trước`;
  return formatPresenceTime(iso);
}

/** Mode badge text. Unknown modes pass through so a newer server is never mislabelled. */
export function presenceModeLabel(mode: string): string {
  if (mode === "off") return "Đang tắt";
  if (mode === "shadow") return "Chạy thử";
  return mode ? String(mode) : "—";
}

export const presenceModeTone = (mode: string): PresenceTone => (mode === "shadow" ? "amber" : mode === "off" ? "slate" : "indigo");

/** True when the server reports gates and every one of them is off. */
export const allOff = (gates: readonly PresenceGateStatus[]): boolean => gates.length > 0 && gates.every((g) => g.mode === "off");

export const ALL_OFF_NOTICE = "Bộ phát hiện hiện diện đang tắt ở mọi cổng: không có sự kiện mới được ghi nhận.";

/** The shadow notice is shown when any gate runs in shadow mode. */
export const anyShadow = (gates: readonly PresenceGateStatus[]): boolean => gates.some((g) => g.mode === "shadow");

// ---------------------------------------------------------------------------
// Filters and request URLs
// ---------------------------------------------------------------------------

export const PRESENCE_EVENTS_PAGE_SIZE = 30;

export interface PresenceFilters {
  gate: string; // "all" or a gate id
  period: "all" | PresencePeriod;
  faceOutcome: "all" | PresenceFaceOutcome;
  /** "none" = events without a label yet (server-side filter). */
  label: "all" | "none" | PresenceLabelKind;
}

export const DEFAULT_PRESENCE_FILTERS: PresenceFilters = { gate: "all", period: "all", faceOutcome: "all", label: "all" };

export const PERIOD_FILTER_OPTIONS: Array<{ value: PresenceFilters["period"]; label: string }> = [
  { value: "all", label: "Mọi lúc" },
  { value: "working", label: "Giờ làm (07:00-19:00)" },
  { value: "after-hours", label: "Ngoài giờ (19:00-07:00)" },
];

export const FACE_OUTCOME_FILTER_OPTIONS: Array<{ value: PresenceFilters["faceOutcome"]; label: string }> = [
  { value: "all", label: "Tất cả" },
  ...PRESENCE_FACE_OUTCOMES.map((v) => ({ value: v, label: FACE_OUTCOME_LABEL[v] })),
];

export const LABEL_FILTER_OPTIONS: Array<{ value: PresenceFilters["label"]; label: string }> = [
  { value: "all", label: "Tất cả" },
  { value: "none", label: "Chưa gắn nhãn" },
  ...PRESENCE_LABEL_KINDS.map((v) => ({ value: v, label: LABEL_KIND_LABEL[v] })),
];

/** Same rule as gate ids elsewhere (src/utils/gates.ts GATE_ID_RE). */
const GATE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** Coerces raw <select> values back to a valid filter set; anything unknown becomes "all". */
export function parsePresenceFilters(raw: Partial<Record<keyof PresenceFilters, unknown>>): PresenceFilters {
  const gate = typeof raw.gate === "string" && GATE_ID_RE.test(raw.gate) ? raw.gate : "all";
  const period = (PRESENCE_PERIODS as readonly unknown[]).includes(raw.period) ? (raw.period as PresencePeriod) : "all";
  const faceOutcome = (PRESENCE_FACE_OUTCOMES as readonly unknown[]).includes(raw.faceOutcome)
    ? (raw.faceOutcome as PresenceFaceOutcome)
    : "all";
  const label = raw.label === "none" || isPresenceLabelKind(raw.label) ? raw.label : "all";
  return { gate, period, faceOutcome, label };
}

/** GET URL for one page. Only valid filter values are sent; limit is clamped to 1..100. */
export function buildPresenceEventsUrl(filters: PresenceFilters, before?: string, limit: number = PRESENCE_EVENTS_PAGE_SIZE): string {
  const f = parsePresenceFilters(filters);
  const params = new URLSearchParams();
  if (f.gate !== "all") params.set("gate", f.gate);
  if (f.period !== "all") params.set("period", f.period);
  if (f.faceOutcome !== "all") params.set("faceOutcome", f.faceOutcome);
  if (f.label !== "all") params.set("label", f.label);
  if (typeof before === "string" && before) params.set("before", before);
  const raw = Number(limit);
  const n = Number.isFinite(raw) ? Math.min(100, Math.max(1, Math.trunc(raw))) : PRESENCE_EVENTS_PAGE_SIZE;
  params.set("limit", String(n));
  return `/api/presence/events?${params.toString()}`;
}

export const PRESENCE_STATUS_URL = "/api/presence/status";

export const presenceCropPath = (id: string): string => `/api/presence/events/${encodeURIComponent(id)}/crop`;

export const presenceLabelPath = (id: string): string => `/api/presence/events/${encodeURIComponent(id)}/label`;

/** POST request for a label; sent through operatorJsonFetch (credentials, CSRF, 401 sign-in). */
export function presenceLabelRequest(id: string, kind: PresenceLabelKind): { url: string; init: RequestInit } {
  if (!isPresenceLabelKind(kind)) throw new Error(`Nhãn không hợp lệ: ${String(kind)}`);
  return {
    url: presenceLabelPath(id),
    init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) },
  };
}

// ---------------------------------------------------------------------------
// Response parsing (never throws)
// ---------------------------------------------------------------------------

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : undefined;

/** One well-formed event, or null. Unknown period/outcome strings are kept so the label helpers can show them as-is. */
export function parsePresenceEvent(raw: unknown): PresenceEventView | null {
  const e = raw as any;
  if (!e || typeof e !== "object") return null;
  const id = str(e.id);
  const startedAt = str(e.startedAt);
  if (!id || !startedAt) return null;
  const box = Array.isArray(e.bestBox) && e.bestBox.length === 4 && e.bestBox.every((n: unknown) => num(n) !== null)
    ? (e.bestBox as [number, number, number, number])
    : ([0, 0, 0, 0] as [number, number, number, number]);
  return {
    id,
    gateId: str(e.gateId) ?? "",
    trackId: str(e.trackId) ?? "",
    startedAt,
    endedAt: str(e.endedAt),
    inViewMs: num(e.inViewMs) ?? NaN,
    framesSeen: num(e.framesSeen) ?? 0,
    peakPersons: num(e.peakPersons) ?? NaN,
    period: (str(e.period) ?? "") as PresencePeriod,
    faceOutcome: (str(e.faceOutcome) ?? "none") as PresenceFaceOutcome,
    linkedLogIds: strList(e.linkedLogIds),
    linkedEmployeeIds: strList(e.linkedEmployeeIds),
    wouldAlert: e.wouldAlert === true,
    alertSentAt: str(e.alertSentAt) ?? null,
    bestBox: box,
    bestScore: num(e.bestScore) ?? 0,
    bestFrameAt: str(e.bestFrameAt) ?? startedAt,
    models: strList(e.models) ?? [],
    hasCrop: e.hasCrop === true,
    createdAt: str(e.createdAt) ?? startedAt,
    label: isPresenceLabelKind(e.label) ? e.label : undefined,
    cropPurgedAt: str(e.cropPurgedAt),
  };
}

export interface PresenceEventsPage {
  events: PresenceEventView[];
  hasMore: boolean;
  nextCursor?: string;
}

/** The list response; null when it is not a success payload. Malformed rows are dropped. */
export function parsePresenceEventsPage(data: unknown): PresenceEventsPage | null {
  const d = data as any;
  if (!d || typeof d !== "object" || d.success !== true || !Array.isArray(d.events)) return null;
  const events: PresenceEventView[] = [];
  for (const raw of d.events) {
    const e = parsePresenceEvent(raw);
    if (e) events.push(e);
  }
  const nextCursor = str(d.nextCursor);
  // Without a cursor there is no way to ask for the next page: stop rather than refetch page one.
  return { events, hasMore: d.hasMore === true && !!nextCursor, nextCursor };
}

/** The status response; null when it is not a success payload. Malformed gates are dropped. */
export function parsePresenceStatus(data: unknown): PresenceGateStatus[] | null {
  const d = data as any;
  if (!d || typeof d !== "object" || d.success !== true || !Array.isArray(d.gates)) return null;
  const gates: PresenceGateStatus[] = [];
  for (const g of d.gates) {
    if (!g || typeof g !== "object") continue;
    const gateId = str(g.gateId);
    if (!gateId) continue;
    const w = g.worker && typeof g.worker === "object" ? g.worker : {};
    const note = str(g.note);
    gates.push({
      gateId,
      mode: str(g.mode) ?? "",
      fps: num(g.fps),
      lastFrameAgeMs: num(g.lastFrameAgeMs),
      worker: { state: str(w.state) ?? null, restarts: num(w.restarts), models: strList(w.models) ?? [] },
      lastEventAt: str(g.lastEventAt) ?? null,
      ...(note ? { note } : {}),
    });
  }
  return gates;
}

/** Message for a refused or failed request: the server's own text when it sent one. */
export function presenceErrorText(res: { status: number; data?: any; error?: string }, what = "dữ liệu hiện diện"): string {
  const serverText = typeof res.data?.error === "string" && res.data.error.trim() ? res.data.error : "";
  if (serverText) return serverText;
  if (res.status === 0) return res.error || "Không kết nối được máy chủ";
  return res.error || `Không tải được ${what} (HTTP ${res.status})`;
}

export type PresenceLabelOutcome = { ok: true; event: PresenceEventView } | { ok: false; status: number; error: string };

/**
 * Reads the label reply. Only a 2xx with `success: true` and an event with the
 * same id is a success; the row is updated from the server's event (its label,
 * or the requested kind when the server's event omits it). Anything else is a
 * failure carrying the server's `error` text as-is. Status 0 is a transport
 * failure, never a success.
 */
export function readPresenceLabelResult(
  id: string,
  kind: PresenceLabelKind,
  res: { ok: boolean; status: number; data?: unknown; error?: string },
): PresenceLabelOutcome {
  const data = (res.data && typeof res.data === "object" ? res.data : {}) as { success?: unknown; event?: unknown; error?: unknown };
  if (res.ok && res.status >= 200 && res.status < 300 && data.success === true) {
    const event = parsePresenceEvent(data.event);
    if (event && event.id === id) return { ok: true, event: event.label ? event : { ...event, label: kind } };
    return { ok: false, status: res.status, error: "Máy chủ trả lời không đúng sự kiện." };
  }
  return { ok: false, status: res.status, error: presenceErrorText({ status: res.status, data, error: res.error }, "nhãn") };
}

// ---------------------------------------------------------------------------
// List state
// ---------------------------------------------------------------------------

/** Append a page, dropping ids already listed (a row may repeat when new events shift the list). */
export function appendPresencePage(current: PresenceEventsPage, page: PresenceEventsPage): PresenceEventsPage {
  const seen = new Set(current.events.map((e) => e.id));
  const fresh: PresenceEventView[] = [];
  for (const e of page.events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    fresh.push(e);
  }
  return {
    events: [...current.events, ...fresh],
    // A page that brought nothing new cannot move on; stop rather than loop.
    hasMore: page.hasMore && fresh.length > 0,
    nextCursor: page.nextCursor,
  };
}

/** Replaces one event by id with the server's copy. Same array when the id is not listed. */
export function replacePresenceEvent(events: PresenceEventView[], updated: PresenceEventView): PresenceEventView[] {
  const index = events.findIndex((e) => e.id === updated.id);
  if (index < 0) return events;
  const next = events.slice();
  next[index] = updated;
  return next;
}

/** Gate ids for the filter: those the status reports, plus any seen in events, in first-seen order. */
export function presenceGateOptions(status: readonly PresenceGateStatus[], events: readonly PresenceEventView[] = []): string[] {
  const ids: string[] = [];
  for (const id of [...status.map((g) => g.gateId), ...events.map((e) => e.gateId)]) {
    if (GATE_ID_RE.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Thumbnail placeholder when there is no crop. */
export const noCropText = (event: { cropPurgedAt?: string }): string =>
  event.cropPurgedAt ? "Ảnh đã xóa sau 7 ngày" : "Không có ảnh";

/** Live-region text after a confirmed label. */
export const labelSuccessText = (kind: PresenceLabelKind): string => `Đã gắn nhãn "${LABEL_KIND_LABEL[kind]}".`;
