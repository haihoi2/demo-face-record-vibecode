/**
 * Per-gate presence settings ("Cài đặt cổng" on the "Hiện diện" tab), P3b
 * contract docs/plans/2026-10-07-p3b-contract.md section 2:
 *
 *   GET /api/presence/settings          (operator) -> { success, gates: PresenceGateSettingsView[] }
 *   PUT /api/presence/settings/:gateId  (admin, CSRF)
 *       { mode?, workingHours?, minSecondsWorking?, minSecondsAfterHours?, alertWindowSeconds?, alertHoldSeconds? }
 *       -> { success, gate: PresenceGateSettingsView }
 *   A field sent as `null` clears the saved override (the value falls back to .env).
 *
 * The server owns every value and every range check; the checks here only
 * mirror the contract ranges so an obvious typo is caught before a request.
 * Types are local (not src/types.ts) on purpose. Everything here is pure.
 */
import type { OperatorSessionInfo } from "./api";
import { hasRole } from "./session";

export type PresenceSettingsMode = "off" | "shadow" | "live";
export const PRESENCE_SETTINGS_MODES: readonly PresenceSettingsMode[] = ["off", "shadow", "live"];

/** The fields the server reports a `source` for and accepts in the PUT body. */
export type PresenceSettingsField =
  | "mode"
  | "workingHours"
  | "minSecondsWorking"
  | "minSecondsAfterHours"
  | "alertWindowSeconds"
  | "alertHoldSeconds";

export const PRESENCE_SETTINGS_FIELDS: readonly PresenceSettingsField[] = [
  "mode",
  "workingHours",
  "minSecondsWorking",
  "minSecondsAfterHours",
  "alertWindowSeconds",
  "alertHoldSeconds",
];

export type PresenceSettingsSource = "saved" | "env";

export interface PresenceGateSettingsView {
  gateId: string;
  label: string;
  /** Effective now. An unknown future mode is kept as-is. */
  mode: string;
  workingHours: string;
  minSecondsWorking: number;
  minSecondsAfterHours: number;
  alertWindowSeconds: number;
  alertHoldSeconds: number;
  source: Partial<Record<string, PresenceSettingsSource>>;
  updatedAt?: string;
  updatedBy?: string;
  needsStream?: boolean;
}

export type PresenceSettingsBody = Partial<{
  mode: PresenceSettingsMode | null;
  workingHours: string | null;
  minSecondsWorking: number | null;
  minSecondsAfterHours: number | null;
  alertWindowSeconds: number | null;
  alertHoldSeconds: number | null;
}>;

// ---------------------------------------------------------------------------
// Ranges (contract section 2) and labels
// ---------------------------------------------------------------------------

export const MIN_SECONDS_RANGE = { min: 0.5, max: 60 } as const;
export const ALERT_WINDOW_SECONDS_RANGE = { min: 30, max: 3600 } as const;
export const ALERT_HOLD_SECONDS_RANGE = { min: 0, max: 30 } as const;
/** "Gộp tin mỗi" is edited in minutes and stored as alertWindowSeconds. */
export const ALERT_WINDOW_MINUTES_RANGE = { min: ALERT_WINDOW_SECONDS_RANGE.min / 60, max: ALERT_WINDOW_SECONDS_RANGE.max / 60 } as const;

export const PRESENCE_SETTINGS_URL = "/api/presence/settings";
export const presenceGateSettingsPath = (gateId: string): string => `${PRESENCE_SETTINGS_URL}/${encodeURIComponent(gateId)}`;

export const SETTINGS_MODE_OPTIONS: ReadonlyArray<{ value: PresenceSettingsMode; label: string; hint: string }> = [
  { value: "off", label: "Tắt", hint: "Không phát hiện, không ghi nhận." },
  { value: "shadow", label: "Chạy thử", hint: "Chỉ ghi nhận sự kiện, không gửi tin." },
  { value: "live", label: "Đang báo", hint: "Ghi nhận và gửi tin tới nhóm bảo vệ ngoài giờ làm." },
];

export const LIVE_CONFIRM_TEXT = "Tin nhắn sẽ được gửi tới nhóm bảo vệ ngoài giờ làm";
export const MODE_RESET_CONFIRM_TEXT =
  "Chế độ sẽ trở về giá trị trong .env. Nếu .env đặt Đang báo, tin nhắn sẽ được gửi tới nhóm bảo vệ ngoài giờ làm.";
export const RESET_TO_ENV_TEXT = "Đặt lại theo .env";
export const NEEDS_STREAM_TEXT = "Cổng chưa có luồng xử lý thời gian thực: bộ phát hiện chưa chạy dù chế độ đang bật.";
/** Shown under the mode control: off <-> on restarts the gate's stream (contract section 2). */
export const MODE_RESTART_HINT = "Bật hoặc tắt sẽ khởi động lại luồng của cổng (vài giây).";
export const HOURS_RESTART_HINT = "Đổi giờ làm hoặc thời gian tối thiểu sẽ khởi động lại bộ phát hiện của cổng.";

export const FIELD_LABEL: Record<PresenceSettingsField, string> = {
  mode: "Chế độ",
  workingHours: "Giờ làm",
  minSecondsWorking: "Tối thiểu trong giờ làm",
  minSecondsAfterHours: "Tối thiểu ngoài giờ",
  alertWindowSeconds: "Gộp tin mỗi",
  alertHoldSeconds: "Chờ nhận diện",
};

export function settingsModeLabel(mode: string): string {
  return SETTINGS_MODE_OPTIONS.find((o) => o.value === mode)?.label ?? (mode ? String(mode) : "—");
}

export const isSettingsMode = (v: unknown): v is PresenceSettingsMode =>
  typeof v === "string" && (PRESENCE_SETTINGS_MODES as readonly string[]).includes(v);

/** "Đã lưu" when the value is a saved override, ".env" otherwise (also when the server did not say). */
export const sourceLabel = (source: string | undefined): string => (source === "saved" ? "Đã lưu" : "Theo .env");

/** The reset button is offered only when the server says the field is a saved override. */
export const canResetField = (view: Pick<PresenceGateSettingsView, "source">, field: PresenceSettingsField): boolean =>
  view.source?.[field] === "saved";

/** Switching to "Đang báo" from anything else needs a confirmation. */
export const needsLiveConfirm = (from: string, to: string): boolean => to === "live" && from !== "live";

/** Admin edits, operator reads, viewer (and signed out) does not see the block. */
export type PresenceSettingsAccess = "edit" | "read" | "hidden";
export function presenceSettingsAccess(session: OperatorSessionInfo | null): PresenceSettingsAccess {
  if (hasRole(session, "admin")) return "edit";
  if (hasRole(session, "operator")) return "read";
  return "hidden";
}

// ---------------------------------------------------------------------------
// Number formatting (vi-VN decimal comma for display, dot inside <input>)
// ---------------------------------------------------------------------------

const trimNumber = (n: number): string => String(Math.round(n * 100) / 100);

export const formatSecondsText = (s: number): string =>
  Number.isFinite(s) ? `${trimNumber(s).replace(".", ",")} giây` : "—";

export const formatWindowText = (seconds: number): string => {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds % 60 === 0) return `${seconds / 60} phút`;
  return `${trimNumber(seconds / 60).replace(".", ",")} phút (${seconds} giây)`;
};

// ---------------------------------------------------------------------------
// Working hours
// ---------------------------------------------------------------------------

/** Same rule as the server (src/server/presence/presenceConfig.ts parseWorkingHours): HH:MM-HH:MM, start != end. */
export function parseHoursRange(raw: string): { start: string; end: string } | null {
  const m = /^\s*([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)\s*$/.exec(String(raw ?? ""));
  if (!m) return null;
  const start = `${m[1]}:${m[2]}`;
  const end = `${m[3]}:${m[4]}`;
  return start === end ? null : { start, end };
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ---------------------------------------------------------------------------
// Response parsing (never throws)
// ---------------------------------------------------------------------------

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

/** One gate, or null when gateId is missing. Unknown fields are ignored. */
export function parsePresenceGateSettings(raw: unknown): PresenceGateSettingsView | null {
  const g = raw as any;
  if (!g || typeof g !== "object") return null;
  const gateId = str(g.gateId);
  if (!gateId) return null;
  const source: Partial<Record<string, PresenceSettingsSource>> = {};
  if (g.source && typeof g.source === "object") {
    for (const [k, v] of Object.entries(g.source)) if (v === "saved" || v === "env") source[k] = v;
  }
  return {
    gateId,
    label: str(g.label) ?? "",
    mode: str(g.mode) ?? "",
    workingHours: str(g.workingHours) ?? "",
    minSecondsWorking: num(g.minSecondsWorking),
    minSecondsAfterHours: num(g.minSecondsAfterHours),
    alertWindowSeconds: num(g.alertWindowSeconds),
    alertHoldSeconds: num(g.alertHoldSeconds),
    source,
    ...(str(g.updatedAt) ? { updatedAt: g.updatedAt } : {}),
    ...(str(g.updatedBy) ? { updatedBy: g.updatedBy } : {}),
    ...(g.needsStream === true ? { needsStream: true } : {}),
  };
}

/** The GET reply; null when it is not a success payload. Malformed gates are dropped. */
export function parsePresenceSettings(data: unknown): PresenceGateSettingsView[] | null {
  const d = data as any;
  if (!d || typeof d !== "object" || d.success !== true || !Array.isArray(d.gates)) return null;
  const gates: PresenceGateSettingsView[] = [];
  for (const raw of d.gates) {
    const g = parsePresenceGateSettings(raw);
    if (g && !gates.some((x) => x.gateId === g.gateId)) gates.push(g);
  }
  return gates;
}

/** Message for a refused or failed request: the server's own text when it sent one. */
export function settingsErrorText(res: { status: number; data?: any; error?: string }, what = "cài đặt cổng"): string {
  const serverText = typeof res.data?.error === "string" && res.data.error.trim() ? res.data.error : "";
  if (serverText) return serverText;
  if (res.status === 0) return res.error || "Không kết nối được máy chủ";
  return res.error || `Không tải được ${what} (HTTP ${res.status})`;
}

export type PresenceSettingsSaveOutcome =
  | { ok: true; gate: PresenceGateSettingsView }
  | { ok: false; status: number; error: string; field?: string };

/**
 * Reads the PUT reply. Only a 2xx with `success: true` and the same gate is a
 * success; anything else (including status 0 = transport failure) is a failure
 * carrying the server's `error` (and `field`) as-is.
 */
export function readPresenceSettingsResult(
  gateId: string,
  res: { ok: boolean; status: number; data?: unknown; error?: string },
): PresenceSettingsSaveOutcome {
  const data = (res.data && typeof res.data === "object" ? res.data : {}) as { success?: unknown; gate?: unknown; error?: unknown; field?: unknown };
  if (res.ok && res.status >= 200 && res.status < 300 && data.success === true) {
    const gate = parsePresenceGateSettings(data.gate);
    if (gate && gate.gateId === gateId) return { ok: true, gate };
    return { ok: false, status: res.status, error: "Máy chủ trả lời không đúng cổng." };
  }
  const field = typeof data.field === "string" && data.field ? data.field : undefined;
  return { ok: false, status: res.status, error: settingsErrorText({ status: res.status, data, error: res.error }, "cài đặt cổng"), ...(field ? { field } : {}) };
}

// ---------------------------------------------------------------------------
// Draft (form state as strings) -> PUT body
// ---------------------------------------------------------------------------

/** Form values as typed; the numbers stay strings until validation. */
export interface PresenceSettingsDraft {
  hoursStart: string;
  hoursEnd: string;
  minSecondsWorking: string;
  minSecondsAfterHours: string;
  /** Minutes in the form, seconds on the wire. */
  alertWindowMinutes: string;
  alertHoldSeconds: string;
}

/** Fields of the draft (mode is changed on its own, not through the form). */
export type DraftField = Exclude<PresenceSettingsField, "mode">;

const numText = (n: number): string => (Number.isFinite(n) ? trimNumber(n) : "");

export function draftFromView(view: PresenceGateSettingsView): PresenceSettingsDraft {
  const hours = parseHoursRange(view.workingHours);
  return {
    hoursStart: hours?.start ?? "",
    hoursEnd: hours?.end ?? "",
    minSecondsWorking: numText(view.minSecondsWorking),
    minSecondsAfterHours: numText(view.minSecondsAfterHours),
    alertWindowMinutes: Number.isFinite(view.alertWindowSeconds) ? trimNumber(view.alertWindowSeconds / 60) : "",
    alertHoldSeconds: numText(view.alertHoldSeconds),
  };
}

/** Takes the server's value for one field into the draft, keeping the others as typed. */
export function resetDraftField(draft: PresenceSettingsDraft, view: PresenceGateSettingsView, field: DraftField): PresenceSettingsDraft {
  const fresh = draftFromView(view);
  switch (field) {
    case "workingHours":
      return { ...draft, hoursStart: fresh.hoursStart, hoursEnd: fresh.hoursEnd };
    case "alertWindowSeconds":
      return { ...draft, alertWindowMinutes: fresh.alertWindowMinutes };
    default:
      return { ...draft, [field]: fresh[field] };
  }
}

/** Accepts "1,5" (vi-VN) as well as "1.5". Empty or junk -> NaN. */
export function parseDecimal(raw: string): number {
  const s = String(raw ?? "").trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}

const inRange = (n: number, r: { min: number; max: number }) => Number.isFinite(n) && n >= r.min && n <= r.max;
const viNum = (n: number) => String(n).replace(".", ",");

export type DraftErrors = Partial<Record<DraftField, string>>;

/** Values the draft would send; `errors` lists every field out of the contract range. */
export function validateDraft(draft: PresenceSettingsDraft): { values: Required<Omit<PresenceSettingsBody, "mode">>; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const start = draft.hoursStart.trim();
  const end = draft.hoursEnd.trim();
  let workingHours: string | null = null;
  if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) errors.workingHours = "Nhập giờ bắt đầu và kết thúc dạng HH:MM.";
  else if (start === end) errors.workingHours = "Giờ bắt đầu và kết thúc phải khác nhau.";
  else workingHours = `${start}-${end}`;

  const minW = parseDecimal(draft.minSecondsWorking);
  if (!inRange(minW, MIN_SECONDS_RANGE)) errors.minSecondsWorking = `Từ ${viNum(MIN_SECONDS_RANGE.min)} đến ${MIN_SECONDS_RANGE.max} giây.`;
  const minA = parseDecimal(draft.minSecondsAfterHours);
  if (!inRange(minA, MIN_SECONDS_RANGE)) errors.minSecondsAfterHours = `Từ ${viNum(MIN_SECONDS_RANGE.min)} đến ${MIN_SECONDS_RANGE.max} giây.`;

  const minutes = parseDecimal(draft.alertWindowMinutes);
  // Whole seconds on the wire; the range is checked on what is actually sent.
  const windowSeconds = Number.isFinite(minutes) ? Math.round(minutes * 60) : NaN;
  if (!inRange(windowSeconds, ALERT_WINDOW_SECONDS_RANGE))
    errors.alertWindowSeconds = `Từ ${viNum(ALERT_WINDOW_MINUTES_RANGE.min)} đến ${ALERT_WINDOW_MINUTES_RANGE.max} phút.`;

  const hold = parseDecimal(draft.alertHoldSeconds);
  if (!inRange(hold, ALERT_HOLD_SECONDS_RANGE)) errors.alertHoldSeconds = `Từ ${ALERT_HOLD_SECONDS_RANGE.min} đến ${ALERT_HOLD_SECONDS_RANGE.max} giây.`;

  return {
    values: {
      workingHours,
      minSecondsWorking: Number.isFinite(minW) ? minW : null,
      minSecondsAfterHours: Number.isFinite(minA) ? minA : null,
      alertWindowSeconds: Number.isFinite(windowSeconds) ? windowSeconds : null,
      alertHoldSeconds: Number.isFinite(hold) ? hold : null,
    },
    errors,
  };
}

const sameHours = (a: string, b: string): boolean => {
  const x = parseHoursRange(a);
  const y = parseHoursRange(b);
  return !!x && !!y && x.start === y.start && x.end === y.end;
};

/**
 * The PUT body for the form: only fields that differ from the server's view.
 * `changed` is false when there is nothing to send; `errors` blocks the save.
 */
export function buildDraftBody(
  view: PresenceGateSettingsView,
  draft: PresenceSettingsDraft,
): { ok: true; body: PresenceSettingsBody; changed: boolean } | { ok: false; errors: DraftErrors } {
  const { values, errors } = validateDraft(draft);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const body: PresenceSettingsBody = {};
  if (values.workingHours !== null && !sameHours(values.workingHours, view.workingHours)) body.workingHours = values.workingHours;
  if (values.minSecondsWorking !== view.minSecondsWorking) body.minSecondsWorking = values.minSecondsWorking;
  if (values.minSecondsAfterHours !== view.minSecondsAfterHours) body.minSecondsAfterHours = values.minSecondsAfterHours;
  if (values.alertWindowSeconds !== view.alertWindowSeconds) body.alertWindowSeconds = values.alertWindowSeconds;
  if (values.alertHoldSeconds !== view.alertHoldSeconds) body.alertHoldSeconds = values.alertHoldSeconds;
  return { ok: true, body, changed: Object.keys(body).length > 0 };
}

/** True when the form differs from what the server last reported (invalid input counts as a change). */
export function isDraftDirty(view: PresenceGateSettingsView, draft: PresenceSettingsDraft): boolean {
  const built = buildDraftBody(view, draft);
  return built.ok === false || built.changed;
}

// ---------------------------------------------------------------------------
// Requests (sent through operatorJsonFetch: credentials, CSRF, 401 sign-in)
// ---------------------------------------------------------------------------

export function presenceSettingsRequest(gateId: string, body: PresenceSettingsBody): { url: string; init: RequestInit } {
  const clean: Record<string, unknown> = {};
  for (const field of PRESENCE_SETTINGS_FIELDS) {
    if (!(field in body)) continue;
    const v = (body as Record<string, unknown>)[field];
    if (field === "mode" && v !== null && !isSettingsMode(v)) throw new Error(`Chế độ không hợp lệ: ${String(v)}`);
    clean[field] = v;
  }
  return {
    url: presenceGateSettingsPath(gateId),
    init: { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(clean) },
  };
}

export const presenceModeRequest = (gateId: string, mode: PresenceSettingsMode) => presenceSettingsRequest(gateId, { mode });

/** Clears one saved override: the field is sent as null and falls back to .env. */
export const presenceResetRequest = (gateId: string, field: PresenceSettingsField) =>
  presenceSettingsRequest(gateId, { [field]: null } as PresenceSettingsBody);

/** Live-region text after a confirmed change. */
export function settingsSavedText(gate: PresenceGateSettingsView, what: string): string {
  return `${what} - ${gate.label || gate.gateId}.`;
}
