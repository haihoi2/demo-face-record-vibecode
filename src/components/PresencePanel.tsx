/**
 * "Hiện diện" (person presence) review tab - plan
 * docs/plans/2026-10-02-person-presence-alerts.md, phase P2 (SHADOW).
 *
 * A presence event means a person (body) was in view at a gate for the minimum
 * time of the period, with or without a face. In P2 events are only recorded,
 * never messaged. Operators label them here so the thresholds can be tuned.
 *
 * The server is authoritative for everything shown: mode, period, face
 * outcome, "would alert" and labels. A label changes on screen only after a 2xx
 * reply; a refusal is shown as the server's own text. Gate ids, model names
 * and error texts come from the server and are rendered as plain React text.
 * Nothing on this page can open a door or send a message itself.
 *
 * P3b adds "Cài đặt cổng" (contract docs/plans/2026-10-07-p3b-contract.md):
 * per-gate mode, working hours, minimum seconds and alert grouping from
 * GET/PUT /api/presence/settings. Admin edits, operator reads, viewer does not
 * see it; switching a gate to "Đang báo" asks for confirmation. Values change
 * on screen only after a 2xx reply (helpers in src/utils/presenceSettings.ts).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Info, PersonStanding, RefreshCw, ImageOff, Users, Timer, BellRing, ChevronDown, ChevronRight, Settings2 } from "lucide-react";
import { operatorJsonFetch } from "../utils/api";
import { labelForGateId } from "../utils/gates";
import { formatDurationMs, formatFps, isFrameAgeWorrying, workerStateLabel } from "../utils/pipelineStatus";
import {
  DEFAULT_PRESENCE_FILTERS,
  FACE_OUTCOME_FILTER_OPTIONS,
  LABEL_ACTIONS,
  LABEL_FILTER_OPTIONS,
  PERIOD_FILTER_OPTIONS,
  PRESENCE_STATUS_URL,
  PRESENCE_TONE_CLASS,
  PresenceEventView,
  PresenceEventsPage,
  PresenceFilters,
  PresenceGateStatus,
  PresenceLabelKind,
  SHADOW_NOTICE,
  WOULD_ALERT_BADGE,
  WOULD_ALERT_HINT,
  ALL_OFF_NOTICE,
  allOff,
  anyShadow,
  appendPresencePage,
  buildPresenceEventsUrl,
  faceOutcomeLabel,
  faceOutcomeTone,
  formatAgo,
  formatInView,
  formatPeople,
  formatPresenceTime,
  labelKindLabel,
  labelKindTone,
  labelSuccessText,
  parsePresenceEventsPage,
  parsePresenceFilters,
  parsePresenceStatus,
  periodLabel,
  periodTone,
  presenceCropPath,
  presenceErrorText,
  presenceGateOptions,
  presenceLabelRequest,
  presenceModeLabel,
  presenceModeTone,
  readPresenceLabelResult,
  replacePresenceEvent,
  showWouldAlert,
  noCropText,
} from "../utils/presence";
import {
  DraftErrors,
  DraftField,
  FIELD_LABEL,
  HOURS_RESTART_HINT,
  LIVE_CONFIRM_TEXT,
  MODE_RESET_CONFIRM_TEXT,
  MODE_RESTART_HINT,
  NEEDS_STREAM_TEXT,
  PRESENCE_SETTINGS_FIELDS,
  PRESENCE_SETTINGS_URL,
  PresenceGateSettingsView,
  PresenceSettingsDraft,
  PresenceSettingsField,
  PresenceSettingsMode,
  RESET_TO_ENV_TEXT,
  SETTINGS_MODE_OPTIONS,
  buildDraftBody,
  canResetField,
  draftFromView,
  formatSecondsText,
  formatWindowText,
  isDraftDirty,
  needsLiveConfirm,
  parsePresenceSettings,
  presenceModeRequest,
  presenceResetRequest,
  presenceSettingsAccess,
  presenceSettingsRequest,
  readPresenceSettingsResult,
  resetDraftField,
  settingsErrorText,
  settingsModeLabel,
  settingsSavedText,
  sourceLabel,
} from "../utils/presenceSettings";
import { useOperatorSession } from "../utils/session";
import { ModalDialog } from "./ModalDialog";
import { ProtectedImage } from "./ProtectedImage";

/** Status refresh while the tab is open and the page is visible. */
const STATUS_POLL_MS = 15_000;
const NO_LABELS: Record<string, string> = {};

const Badge: React.FC<{ tone: keyof typeof PRESENCE_TONE_CLASS; title?: string; children: React.ReactNode }> = ({ tone, title, children }) => (
  <span
    title={title}
    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-bold whitespace-nowrap ${PRESENCE_TONE_CLASS[tone]}`}
  >
    {children}
  </span>
);

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function usePresenceStatus() {
  const [gates, setGates] = useState<PresenceGateStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number>(0);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    const res = await operatorJsonFetch<any>(PRESENCE_STATUS_URL);
    if (gen !== generation.current) return;
    const parsed = res.ok ? parsePresenceStatus(res.data) : null;
    if (parsed) {
      setGates(parsed);
      setError(null);
      setLoadedAt(Date.now());
    } else {
      // Keep the last good status on screen, flagged by the error.
      setError(presenceErrorText(res.ok ? { ...res, error: "Máy chủ trả về dữ liệu không hợp lệ" } : res, "trạng thái hiện diện"));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void load();
    }, STATUS_POLL_MS);
    return () => {
      window.clearInterval(timer);
      generation.current++; // drop any reply still in flight
    };
  }, [load]);

  return { gates, error, loadedAt, reload: load };
}

const PresenceStatusStrip: React.FC<{ gates: PresenceGateStatus[] | null; error: string | null; loadedAt: number }> = ({
  gates,
  error,
  loadedAt,
}) => {
  const shadow = gates ? anyShadow(gates) : false;
  return (
    <section aria-labelledby="presence-status-title" className="space-y-2">
      <h2 id="presence-status-title" className="sr-only">
        Trạng thái bộ phát hiện
      </h2>
      {shadow && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-900" data-testid="presence-shadow-notice">
          <Info className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{SHADOW_NOTICE}</span>
        </div>
      )}
      {gates && allOff(gates) && (
        <div className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-700">
          <Info className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{ALL_OFF_NOTICE}</span>
        </div>
      )}
      {error && (
        <div role="alert" className="flex items-start gap-2 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {gates === null && !error && <p className="text-xs text-slate-500">Đang tải trạng thái...</p>}
      {gates && gates.length === 0 && (
        <p className="text-xs text-slate-500">Máy chủ chưa báo cổng nào có bộ phát hiện hiện diện.</p>
      )}
      {gates && gates.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="Trạng thái theo cổng">
          {gates.map((g) => {
            const staleFrame = g.mode !== "off" && isFrameAgeWorrying(g.lastFrameAgeMs);
            return (
              <li key={g.gateId} className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-700 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-slate-900 truncate">{labelForGateId(g.gateId, NO_LABELS)}</span>
                  <Badge tone={presenceModeTone(g.mode)}>{presenceModeLabel(g.mode)}</Badge>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                  <dt className="text-slate-500">Tốc độ</dt>
                  <dd className="tabular-nums">{formatFps(g.fps)}</dd>
                  <dt className="text-slate-500">Khung mới nhất</dt>
                  <dd className={`tabular-nums ${staleFrame ? "text-amber-700 font-semibold" : ""}`}>
                    {g.lastFrameAgeMs === null ? "—" : `${formatDurationMs(g.lastFrameAgeMs)} trước`}
                    {staleFrame && " (chậm)"}
                  </dd>
                  <dt className="text-slate-500">Bộ xử lý</dt>
                  <dd>
                    {workerStateLabel(g.worker.state)}
                    {g.worker.restarts !== null && g.worker.restarts > 0 && `, khởi động lại ${g.worker.restarts} lần`}
                  </dd>
                  {g.worker.models.length > 0 && (
                    <>
                      <dt className="text-slate-500">Mô hình</dt>
                      <dd className="font-mono break-all">{g.worker.models.join(", ")}</dd>
                    </>
                  )}
                  <dt className="text-slate-500">Sự kiện gần nhất</dt>
                  <dd title={g.lastEventAt ? formatPresenceTime(g.lastEventAt) : undefined}>
                    {g.lastEventAt ? formatAgo(g.lastEventAt, loadedAt || Date.now()) : "Chưa có"}
                  </dd>
                </dl>
                {g.note && <p className="text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">{g.note}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const EMPTY_PAGE: PresenceEventsPage = { events: [], hasMore: false };

/** One owner for the list requests; a reply for an older filter or reload is dropped. */
function usePresenceEvents(filters: PresenceFilters) {
  const [page, setPage] = useState<PresenceEventsPage>(EMPTY_PAGE);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const generation = useRef(0);

  const fetchPage = useCallback(async (before?: string): Promise<{ ok: true; page: PresenceEventsPage } | { ok: false; error: string }> => {
    const res = await operatorJsonFetch<any>(buildPresenceEventsUrl(filters, before));
    if (!res.ok) return { ok: false, error: presenceErrorText(res, "danh sách sự kiện") };
    const parsed = parsePresenceEventsPage(res.data);
    if (!parsed) return { ok: false, error: presenceErrorText({ ...res, error: "Máy chủ trả về dữ liệu không hợp lệ" }) };
    return { ok: true, page: parsed };
  }, [filters]);

  useEffect(() => {
    const gen = ++generation.current;
    setPage(EMPTY_PAGE);
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    void fetchPage().then((result) => {
      if (gen !== generation.current) return;
      if (result.ok === true) setPage(result.page);
      else setError(result.error);
      setLoading(false);
    });
    return () => {
      generation.current++;
    };
  }, [fetchPage, reloadKey]);

  const loadMore = useCallback(async () => {
    if (loading || loadingMore || !page.hasMore || !page.nextCursor) return;
    const gen = generation.current;
    setLoadingMore(true);
    setError(null);
    const result = await fetchPage(page.nextCursor);
    if (gen !== generation.current) return;
    if (result.ok === true) {
      const next = result.page;
      setPage((prev) => appendPresencePage(prev, next));
    } else setError(result.error);
    setLoadingMore(false);
  }, [fetchPage, loading, loadingMore, page]);

  const applyEvent = useCallback((event: PresenceEventView) => {
    setPage((prev) => {
      const events = replacePresenceEvent(prev.events, event);
      return events === prev.events ? prev : { ...prev, events };
    });
  }, []);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  return { ...page, loading, loadingMore, error, loadMore, reload, applyEvent };
}

interface PresenceEventRowProps {
  event: PresenceEventView;
  pendingKind: PresenceLabelKind | undefined;
  rowError: string | undefined;
  onLabel: (event: PresenceEventView, kind: PresenceLabelKind) => void;
}

const PresenceEventRow: React.FC<PresenceEventRowProps> = ({ event, pendingKind, rowError, onLabel }) => {
  const time = formatPresenceTime(event.startedAt);
  const titleId = `presence-event-${event.id}-title`;
  const busy = pendingKind !== undefined;
  return (
    <li>
      <article
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        className={`flex gap-3 rounded-2xl border bg-white p-3 ${showWouldAlert(event) ? "border-amber-300" : "border-slate-200"}`}
      >
        <div className="w-20 h-28 shrink-0 rounded-lg overflow-hidden bg-slate-900 flex items-center justify-center">
          {event.hasCrop ? (
            <ProtectedImage
              src={presenceCropPath(event.id)}
              alt={`Ảnh toàn thân lúc ${time}`}
              loading="lazy"
              className="w-full h-full object-contain"
            />
          ) : (
            <span className="flex flex-col items-center gap-1 px-1 text-center text-[10px] text-slate-400">
              <ImageOff className="w-4 h-4" aria-hidden="true" />
              {noCropText(event)}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 id={titleId} className="text-sm font-bold text-slate-900 tabular-nums">
              <time dateTime={event.startedAt}>{time}</time>
            </h3>
            <span className="text-xs text-slate-500">{labelForGateId(event.gateId, NO_LABELS)}</span>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-700">
            <span className="inline-flex items-center gap-1" title="Thời gian trong khung hình">
              <Timer className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
              <span className="sr-only">Thời gian trong khung hình: </span>
              {formatInView(event.inViewMs)}
              {!event.endedAt && <span className="text-slate-500">(chưa kết thúc)</span>}
            </span>
            <span className="inline-flex items-center gap-1" title="Số người cùng lúc nhiều nhất">
              <Users className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
              <span className="sr-only">Số người: </span>
              {formatPeople(event.peakPersons)}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={periodTone(event.period)}>{periodLabel(event.period)}</Badge>
            <Badge tone={faceOutcomeTone(event.faceOutcome)}>{faceOutcomeLabel(event.faceOutcome)}</Badge>
            {showWouldAlert(event) && (
              <Badge tone="amber" title={WOULD_ALERT_HINT}>
                <BellRing className="w-3 h-3" aria-hidden="true" />
                {WOULD_ALERT_BADGE}
              </Badge>
            )}
            <span className="text-[11px] text-slate-500">Nhãn:</span>
            <Badge tone={labelKindTone(event.label)}>{labelKindLabel(event.label)}</Badge>
          </div>

          <div role="group" aria-label={`Gắn nhãn sự kiện lúc ${time}`} className="flex flex-wrap gap-1.5">
            {LABEL_ACTIONS.map((action) => {
              const current = event.label === action.kind;
              return (
                <button
                  key={action.kind}
                  type="button"
                  title={action.hint}
                  aria-pressed={current}
                  // Not `disabled`: that would drop keyboard focus to <body> mid-request.
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (!busy) onLabel(event, action.kind);
                  }}
                  className={`px-2.5 py-1 rounded-lg border text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 aria-disabled:opacity-60 aria-disabled:cursor-wait ${
                    current ? PRESENCE_TONE_CLASS[action.tone] : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                  }`}
                >
                  {pendingKind === action.kind ? "Đang lưu..." : action.text}
                </button>
              );
            })}
          </div>

          {rowError && (
            <p role="alert" className="flex items-start gap-1.5 text-xs font-semibold text-rose-700">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
              <span>{rowError}</span>
            </p>
          )}
        </div>
      </article>
    </li>
  );
};

const FilterSelect = <T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: string) => void;
}) => (
  <label className="text-[11px] font-semibold text-slate-600" htmlFor={id}>
    {label}
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="mt-1 block px-3 py-2 rounded-lg border border-slate-300 text-sm font-normal bg-white focus:ring-2 focus:ring-indigo-500 outline-none"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  </label>
);

// ---------------------------------------------------------------------------
// Per-gate settings ("Cài đặt cổng", P3b): admin edits, operator reads
// ---------------------------------------------------------------------------

/** One owner for the settings list; a reply for an older load is dropped. */
function usePresenceSettings(active: boolean, reloadKey: number) {
  const [gates, setGates] = useState<PresenceGateSettingsView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    setLoading(true);
    const res = await operatorJsonFetch<any>(PRESENCE_SETTINGS_URL);
    if (gen !== generation.current) return;
    const parsed = res.ok ? parsePresenceSettings(res.data) : null;
    if (parsed) {
      setGates(parsed);
      setError(null);
    } else {
      // Keep the last good settings on screen, flagged by the error.
      setError(settingsErrorText(res.ok ? { ...res, error: "Máy chủ trả về dữ liệu không hợp lệ" } : res));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
    return () => {
      generation.current++; // drop any reply still in flight
    };
  }, [active, load, reloadKey]);

  /** Applies the server's copy of one gate after a confirmed save. */
  const applyGate = useCallback((gate: PresenceGateSettingsView) => {
    setGates((prev) => (prev ? prev.map((g) => (g.gateId === gate.gateId ? gate : g)) : prev));
  }, []);

  return { gates, error, loading, reload: load, applyGate };
}

const SETTINGS_INPUT =
  "mt-1 block w-full px-3 py-2 rounded-lg border text-sm font-normal bg-white text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500";

const SourceTag: React.FC<{ source: string | undefined }> = ({ source }) => (
  <span
    className={`ml-1.5 inline-flex px-1.5 py-0.5 rounded border text-[10px] font-semibold ${
      source === "saved" ? "bg-indigo-50 text-indigo-700 border-indigo-200" : "bg-slate-50 text-slate-500 border-slate-200"
    }`}
  >
    {sourceLabel(source)}
  </span>
);

type PendingConfirm = { kind: "live" } | { kind: "reset-mode" };

interface GateSettingsCardProps {
  view: PresenceGateSettingsView;
  canEdit: boolean;
  onSaved: (gate: PresenceGateSettingsView, announcement: string) => void;
}

const GateSettingsCard: React.FC<GateSettingsCardProps> = ({ view, canEdit, onSaved }) => {
  const [draft, setDraft] = useState<PresenceSettingsDraft>(() => draftFromView(view));
  const [fieldErrors, setFieldErrors] = useState<DraftErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  /** What is being sent: "form", "mode", or the field being reset. */
  const [busy, setBusy] = useState<null | "form" | "mode" | PresenceSettingsField>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const lastView = useRef(view);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A reload brings the server's values into the form unless the admin is mid-edit.
  useEffect(() => {
    if (lastView.current === view) return;
    if (!isDraftDirty(lastView.current, draftRef.current)) setDraft(draftFromView(view));
    lastView.current = view;
  }, [view]);

  const gateName = view.label || labelForGateId(view.gateId, NO_LABELS);
  const idp = `presence-settings-${view.gateId}`;
  const dirty = canEdit && isDraftDirty(view, draft);

  /** Sends one PUT; the card changes only after a confirmed 2xx. */
  const send = async (
    kind: "form" | "mode" | PresenceSettingsField,
    request: { url: string; init: RequestInit },
    after: (gate: PresenceGateSettingsView) => { draft?: PresenceSettingsDraft; announce: string },
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(kind);
    setFormError(null);
    const res = await operatorJsonFetch<any>(request.url, request.init);
    inFlight.current = false;
    if (!mounted.current) return;
    setBusy(null);
    const outcome = readPresenceSettingsResult(view.gateId, res);
    if (outcome.ok === true) {
      const next = after(outcome.gate);
      lastView.current = outcome.gate;
      if (next.draft) setDraft(next.draft);
      setFieldErrors({});
      onSaved(outcome.gate, next.announce);
    } else {
      const field = outcome.field;
      if (field && field !== "mode" && (PRESENCE_SETTINGS_FIELDS as readonly string[]).includes(field)) {
        setFieldErrors({ [field as DraftField]: outcome.error });
      } else {
        setFormError(outcome.error);
      }
    }
  };

  const applyMode = (mode: PresenceSettingsMode) =>
    void send("mode", presenceModeRequest(view.gateId, mode), (gate) => ({
      announce: settingsSavedText(gate, `Chế độ: ${settingsModeLabel(gate.mode)}`),
    }));

  const onPickMode = (mode: PresenceSettingsMode) => {
    if (!canEdit || busy || mode === view.mode) return;
    if (needsLiveConfirm(view.mode, mode)) {
      setConfirm({ kind: "live" });
      return;
    }
    applyMode(mode);
  };

  const onReset = (field: PresenceSettingsField) => {
    if (!canEdit || busy) return;
    if (field === "mode") {
      setConfirm({ kind: "reset-mode" });
      return;
    }
    void send(field, presenceResetRequest(view.gateId, field), (gate) => ({
      draft: resetDraftField(draftRef.current, gate, field),
      announce: settingsSavedText(gate, `${FIELD_LABEL[field]}: đã đặt lại theo .env`),
    }));
  };

  const onConfirm = () => {
    const pending = confirm;
    setConfirm(null);
    if (!pending) return;
    if (pending.kind === "live") applyMode("live");
    else
      void send("mode", presenceResetRequest(view.gateId, "mode"), (gate) => ({
        announce: settingsSavedText(gate, `Chế độ đã đặt lại theo .env: ${settingsModeLabel(gate.mode)}`),
      }));
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit || busy) return;
    const built = buildDraftBody(view, draft);
    if (built.ok === false) {
      setFieldErrors(built.errors);
      setFormError("Kiểm tra lại các ô đánh dấu đỏ.");
      return;
    }
    setFieldErrors({});
    if (!built.changed) return;
    void send("form", presenceSettingsRequest(view.gateId, built.body), (gate) => ({
      draft: draftFromView(gate),
      announce: settingsSavedText(gate, "Đã lưu cài đặt"),
    }));
  };

  const resetButton = (field: PresenceSettingsField) =>
    canEdit && canResetField(view, field) ? (
      <button
        type="button"
        onClick={() => onReset(field)}
        aria-disabled={busy ? true : undefined}
        className="text-[11px] font-semibold text-indigo-700 underline underline-offset-2 hover:text-indigo-900 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 aria-disabled:opacity-60 aria-disabled:cursor-wait"
      >
        {busy === field ? "Đang đặt lại..." : RESET_TO_ENV_TEXT}
        <span className="sr-only">: {FIELD_LABEL[field]}</span>
      </button>
    ) : null;

  const numberField = (field: Exclude<DraftField, "workingHours">, draftKey: keyof PresenceSettingsDraft, unit: string, hint?: string) => {
    const id = `${idp}-${field}`;
    const err = fieldErrors[field];
    const describedBy = [hint ? `${id}-hint` : "", err ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
    return (
      <div>
        <label htmlFor={id} className="flex items-center text-[11px] font-semibold text-slate-600">
          {FIELD_LABEL[field]} ({unit})
          <SourceTag source={view.source[field]} />
        </label>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={draft[draftKey]}
          onChange={(e) => {
            const value = e.target.value;
            setDraft((d) => ({ ...d, [draftKey]: value }));
          }}
          aria-invalid={err ? true : undefined}
          aria-describedby={describedBy}
          className={`${SETTINGS_INPUT} ${err ? "border-rose-400" : "border-slate-300"}`}
        />
        {hint && (
          <p id={`${id}-hint`} className="mt-0.5 text-[10px] text-slate-500">
            {hint}
          </p>
        )}
        {err && (
          <p id={`${id}-error`} className="mt-0.5 text-[11px] font-semibold text-rose-700">
            {err}
          </p>
        )}
        <div className="mt-0.5">{resetButton(field)}</div>
      </div>
    );
  };

  return (
    <li>
      <article aria-labelledby={`${idp}-title`} aria-busy={busy ? true : undefined} className="rounded-xl border border-slate-200 bg-white p-4 space-y-3 text-xs text-slate-700">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`${idp}-title`} className="text-sm font-bold text-slate-900">
            {gateName}
          </h3>
          <Badge tone={presenceModeTone(view.mode)}>{presenceModeLabel(view.mode)}</Badge>
        </div>

        {view.needsStream && (
          <p className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 font-semibold text-amber-900">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
            <span>{NEEDS_STREAM_TEXT}</span>
          </p>
        )}

        {canEdit ? (
          <>
            <div>
              <div className="flex items-center text-[11px] font-semibold text-slate-600" id={`${idp}-mode-label`}>
                {FIELD_LABEL.mode}
                <SourceTag source={view.source.mode} />
              </div>
              <div role="group" aria-labelledby={`${idp}-mode-label`} aria-describedby={`${idp}-mode-hint`} className="mt-1 flex flex-wrap gap-1.5">
                {SETTINGS_MODE_OPTIONS.map((o) => {
                  const current = view.mode === o.value;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      title={o.hint}
                      aria-pressed={current}
                      // Not `disabled`: that would drop keyboard focus to <body> mid-request.
                      aria-disabled={busy ? true : undefined}
                      onClick={() => onPickMode(o.value)}
                      className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 aria-disabled:opacity-60 aria-disabled:cursor-wait ${
                        current
                          ? o.value === "live"
                            ? "bg-indigo-600 text-white border-indigo-600"
                            : o.value === "shadow"
                              ? "bg-amber-100 text-amber-900 border-amber-300"
                              : "bg-slate-200 text-slate-800 border-slate-300"
                          : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                      }`}
                    >
                      {busy === "mode" && current ? "Đang lưu..." : o.label}
                    </button>
                  );
                })}
              </div>
              <p id={`${idp}-mode-hint`} className="mt-0.5 text-[10px] text-slate-500">
                {MODE_RESTART_HINT}
              </p>
              <div className="mt-0.5">{resetButton("mode")}</div>
            </div>

            <form onSubmit={onSubmit} noValidate className="space-y-3" aria-label={`Cài đặt ${gateName}`}>
              <fieldset aria-describedby={`${idp}-hours-hint${fieldErrors.workingHours ? ` ${idp}-hours-error` : ""}`}>
                <legend className="flex items-center text-[11px] font-semibold text-slate-600">
                  {FIELD_LABEL.workingHours}
                  <SourceTag source={view.source.workingHours} />
                </legend>
                <div className="mt-1 grid grid-cols-2 gap-2">
                  <label htmlFor={`${idp}-hours-start`} className="text-[11px] text-slate-600">
                    Bắt đầu
                    <input
                      id={`${idp}-hours-start`}
                      type="time"
                      value={draft.hoursStart}
                      onChange={(e) => {
                        const value = e.target.value;
                        setDraft((d) => ({ ...d, hoursStart: value }));
                      }}
                      aria-invalid={fieldErrors.workingHours ? true : undefined}
                      className={`${SETTINGS_INPUT} ${fieldErrors.workingHours ? "border-rose-400" : "border-slate-300"}`}
                    />
                  </label>
                  <label htmlFor={`${idp}-hours-end`} className="text-[11px] text-slate-600">
                    Kết thúc
                    <input
                      id={`${idp}-hours-end`}
                      type="time"
                      value={draft.hoursEnd}
                      onChange={(e) => {
                        const value = e.target.value;
                        setDraft((d) => ({ ...d, hoursEnd: value }));
                      }}
                      aria-invalid={fieldErrors.workingHours ? true : undefined}
                      className={`${SETTINGS_INPUT} ${fieldErrors.workingHours ? "border-rose-400" : "border-slate-300"}`}
                    />
                  </label>
                </div>
                <p id={`${idp}-hours-hint`} className="mt-0.5 text-[10px] text-slate-500">
                  Giờ Việt Nam. {HOURS_RESTART_HINT}
                </p>
                {fieldErrors.workingHours && (
                  <p id={`${idp}-hours-error`} className="mt-0.5 text-[11px] font-semibold text-rose-700">
                    {fieldErrors.workingHours}
                  </p>
                )}
                <div className="mt-0.5">{resetButton("workingHours")}</div>
              </fieldset>

              <div className="grid gap-3 sm:grid-cols-2">
                {numberField("minSecondsWorking", "minSecondsWorking", "giây", "Thời gian tối thiểu trong khung hình, giờ làm.")}
                {numberField("minSecondsAfterHours", "minSecondsAfterHours", "giây", "Thời gian tối thiểu trong khung hình, ngoài giờ.")}
                {numberField("alertWindowSeconds", "alertWindowMinutes", "phút", "Các sự kiện trong khoảng này được gộp vào một tin.")}
                {numberField("alertHoldSeconds", "alertHoldSeconds", "giây", "Chờ kết quả nhận diện khuôn mặt trước khi báo.")}
              </div>

              {formError && (
                <p role="alert" className="flex items-start gap-1.5 text-xs font-semibold text-rose-700 break-words">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{formError}</span>
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="submit"
                  disabled={!dirty && busy !== "form"}
                  aria-disabled={busy ? true : undefined}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700 disabled:opacity-50 aria-disabled:opacity-60 aria-disabled:cursor-wait focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  {busy === "form" ? "Đang lưu..." : "Lưu"}
                  <span className="sr-only"> cài đặt {gateName}</span>
                </button>
                {dirty && !busy && (
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(draftFromView(view));
                      setFieldErrors({});
                      setFormError(null);
                    }}
                    className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  >
                    Hủy thay đổi
                  </button>
                )}
              </div>
            </form>
          </>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-slate-500">{FIELD_LABEL.mode}</dt>
            <dd>
              {settingsModeLabel(view.mode)}
              <SourceTag source={view.source.mode} />
            </dd>
            <dt className="text-slate-500">{FIELD_LABEL.workingHours}</dt>
            <dd className="tabular-nums">
              {view.workingHours || "—"}
              <SourceTag source={view.source.workingHours} />
            </dd>
            <dt className="text-slate-500">{FIELD_LABEL.minSecondsWorking}</dt>
            <dd className="tabular-nums">
              {formatSecondsText(view.minSecondsWorking)}
              <SourceTag source={view.source.minSecondsWorking} />
            </dd>
            <dt className="text-slate-500">{FIELD_LABEL.minSecondsAfterHours}</dt>
            <dd className="tabular-nums">
              {formatSecondsText(view.minSecondsAfterHours)}
              <SourceTag source={view.source.minSecondsAfterHours} />
            </dd>
            <dt className="text-slate-500">{FIELD_LABEL.alertWindowSeconds}</dt>
            <dd className="tabular-nums">
              {formatWindowText(view.alertWindowSeconds)}
              <SourceTag source={view.source.alertWindowSeconds} />
            </dd>
            <dt className="text-slate-500">{FIELD_LABEL.alertHoldSeconds}</dt>
            <dd className="tabular-nums">
              {formatSecondsText(view.alertHoldSeconds)}
              <SourceTag source={view.source.alertHoldSeconds} />
            </dd>
          </dl>
        )}

        {(view.updatedAt || view.updatedBy) && (
          <p className="text-[10px] text-slate-500">
            Lưu lần cuối{view.updatedAt ? ` ${formatPresenceTime(view.updatedAt)}` : ""}
            {view.updatedBy ? ` bởi ${view.updatedBy}` : ""}
          </p>
        )}
      </article>

      {confirm && (
        <ModalDialog
          id={`${idp}-confirm`}
          role="alertdialog"
          title={
            <>
              <BellRing className="w-4 h-4 text-indigo-600" aria-hidden="true" />
              {confirm.kind === "live" ? `Bật Đang báo cho ${gateName}?` : `Đặt lại chế độ của ${gateName} theo .env?`}
            </>
          }
          description={confirm.kind === "live" ? `${LIVE_CONFIRM_TEXT}.` : MODE_RESET_CONFIRM_TEXT}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button
                type="button"
                data-autofocus
                onClick={() => setConfirm(null)}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                {confirm.kind === "live" ? "Bật Đang báo" : "Đặt lại"}
              </button>
            </>
          }
        />
      )}
    </li>
  );
};

/** `onChanged` runs after a confirmed save so the status strip shows the new mode without waiting for its poll. */
const PresenceSettingsBlock: React.FC<{ reloadKey: number; onChanged: () => void }> = ({ reloadKey, onChanged }) => {
  const session = useOperatorSession();
  const access = presenceSettingsAccess(session);
  const [open, setOpen] = useState(false);
  const settings = usePresenceSettings(open && access !== "hidden", reloadKey);
  const [announcement, setAnnouncement] = useState("");

  if (access === "hidden") return null;
  const canEdit = access === "edit";

  return (
    <section aria-labelledby="presence-settings-title" className="space-y-3" data-testid="presence-settings">
      <h2 id="presence-settings-title" className="text-sm font-bold text-slate-900">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="presence-settings-body"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {open ? <ChevronDown className="w-4 h-4" aria-hidden="true" /> : <ChevronRight className="w-4 h-4" aria-hidden="true" />}
          <Settings2 className="w-4 h-4 text-indigo-600" aria-hidden="true" />
          Cài đặt cổng
          {!canEdit && <span className="text-[11px] font-normal text-slate-500">(chỉ xem)</span>}
        </button>
      </h2>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {open && (
        <div id="presence-settings-body" className="space-y-2">
          <p className="text-xs text-slate-600 max-w-3xl">
            Giá trị đã lưu ở đây được dùng thay cho .env; đặt lại để quay về .env.
            {canEdit ? "" : " Chỉ quản trị viên được thay đổi."}
          </p>
          {settings.error && (
            <div role="alert" className="flex items-start gap-2 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span className="flex-1 break-words">{settings.error}</span>
              <button
                type="button"
                onClick={() => void settings.reload()}
                className="underline font-bold rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                Thử lại
              </button>
            </div>
          )}
          {settings.gates === null && !settings.error && <p className="text-xs text-slate-500">Đang tải cài đặt cổng...</p>}
          {settings.gates && settings.gates.length === 0 && <p className="text-xs text-slate-500">Máy chủ chưa báo cổng nào.</p>}
          {settings.gates && settings.gates.length > 0 && (
            <ul className="grid gap-3 lg:grid-cols-2" aria-label="Cài đặt theo cổng">
              {settings.gates.map((gate) => (
                <GateSettingsCard
                  key={gate.gateId}
                  view={gate}
                  canEdit={canEdit}
                  onSaved={(saved, text) => {
                    settings.applyGate(saved);
                    setAnnouncement(text);
                    onChanged();
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export const PresencePanel: React.FC = () => {
  const status = usePresenceStatus();
  const [filters, setFilters] = useState<PresenceFilters>(DEFAULT_PRESENCE_FILTERS);
  const list = usePresenceEvents(filters);
  const [pending, setPending] = useState<Record<string, PresenceLabelKind>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");
  const [settingsReloadKey, setSettingsReloadKey] = useState(0);
  const mounted = useRef(true);
  /** Synchronous guard: one label request per event at a time, even on a double click. */
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const gateOptions = useMemo(() => {
    const ids = presenceGateOptions(status.gates ?? [], list.events);
    if (filters.gate !== "all" && !ids.includes(filters.gate)) ids.push(filters.gate);
    return [{ value: "all", label: "Tất cả cổng" }, ...ids.map((id) => ({ value: id, label: labelForGateId(id, NO_LABELS) }))];
  }, [status.gates, list.events, filters.gate]);

  const setFilter = (key: keyof PresenceFilters, value: string) => {
    setFilters((prev) => parsePresenceFilters({ ...prev, [key]: value }));
    setRowErrors({});
  };

  const onLabel = useCallback(
    async (event: PresenceEventView, kind: PresenceLabelKind) => {
      if (inFlight.current.has(event.id) || event.label === kind) return;
      inFlight.current.add(event.id);
      setPending((p) => ({ ...p, [event.id]: kind }));
      setRowErrors((e) => {
        if (!(event.id in e)) return e;
        const { [event.id]: _drop, ...rest } = e;
        return rest;
      });
      const { url, init } = presenceLabelRequest(event.id, kind);
      const res = await operatorJsonFetch<any>(url, init);
      inFlight.current.delete(event.id);
      if (!mounted.current) return;
      const outcome = readPresenceLabelResult(event.id, kind, res);
      if (outcome.ok === true) {
        list.applyEvent(outcome.event);
        // The time makes consecutive announcements differ, so each one is read out.
        setAnnouncement(`${labelSuccessText(kind)} Sự kiện lúc ${formatPresenceTime(event.startedAt)}.`);
      } else {
        const message = outcome.error;
        setRowErrors((e) => ({ ...e, [event.id]: message }));
        setAnnouncement("");
      }
      setPending((p) => {
        const { [event.id]: _done, ...rest } = p;
        return rest;
      });
    },
    [list.applyEvent],
  );

  const filtered =
    filters.gate !== "all" || filters.period !== "all" || filters.faceOutcome !== "all" || filters.label !== "all";

  const listStatus = list.loading
    ? "Đang tải sự kiện hiện diện..."
    : list.loadingMore
      ? "Đang tải thêm..."
      : list.error
        ? ""
        : list.events.length === 0
          ? "Không có sự kiện hiện diện nào."
          : `Đang hiển thị ${list.events.length} sự kiện${list.hasMore ? ", còn sự kiện cũ hơn" : ""}.`;

  const refreshAll = () => {
    void status.reload();
    list.reload();
    setSettingsReloadKey((k) => k + 1);
  };

  return (
    <div className="space-y-5" data-testid="presence-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold text-slate-900">
            <PersonStanding className="w-5 h-5 text-indigo-600" aria-hidden="true" /> Hiện diện
          </h1>
          <p className="text-xs text-slate-600 max-w-3xl">
            Ghi nhận khi có người trong khung hình ở cổng, kể cả khi không thấy mặt, đủ thời gian tối thiểu của cổng (xem Cài đặt
            cổng). Gắn nhãn từng sự kiện để hiệu chỉnh ngưỡng. Trang này không mở cửa; chỉ cổng ở chế độ Đang báo mới gửi tin.
          </p>
        </div>
        <button
          type="button"
          onClick={refreshAll}
          disabled={list.loading}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-slate-600 border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${list.loading ? "animate-spin" : ""}`} aria-hidden="true" /> Làm mới
        </button>
      </div>

      <PresenceStatusStrip gates={status.gates} error={status.error} loadedAt={status.loadedAt} />

      <PresenceSettingsBlock reloadKey={settingsReloadKey} onChanged={() => void status.reload()} />

      <section aria-labelledby="presence-events-title" className="space-y-3">
        <h2 id="presence-events-title" className="text-sm font-bold text-slate-900">
          Sự kiện, mới nhất trước
        </h2>

        <div className="flex flex-wrap items-end gap-3">
          <FilterSelect id="presence-filter-gate" label="Cổng" value={filters.gate} options={gateOptions} onChange={(v) => setFilter("gate", v)} />
          <FilterSelect id="presence-filter-period" label="Khung giờ" value={filters.period} options={PERIOD_FILTER_OPTIONS} onChange={(v) => setFilter("period", v)} />
          <FilterSelect
            id="presence-filter-face"
            label="Khuôn mặt"
            value={filters.faceOutcome}
            options={FACE_OUTCOME_FILTER_OPTIONS}
            onChange={(v) => setFilter("faceOutcome", v)}
          />
          <FilterSelect id="presence-filter-label" label="Nhãn" value={filters.label} options={LABEL_FILTER_OPTIONS} onChange={(v) => setFilter("label", v)} />
        </div>

        <p role="status" aria-live="polite" className="sr-only">
          {listStatus}
        </p>
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>

        {list.error && (
          <div role="alert" className="flex items-start gap-2 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">{list.error}</span>
            {list.events.length === 0 && (
              <button type="button" onClick={list.reload} className="underline font-bold">
                Thử lại
              </button>
            )}
          </div>
        )}

        {list.loading && <p className="rounded-2xl border border-slate-200 bg-white px-4 py-8 text-center text-xs text-slate-500">Đang tải sự kiện hiện diện...</p>}

        {!list.loading && !list.error && list.events.length === 0 && (
          <p className="rounded-2xl border border-slate-200 bg-white px-4 py-8 text-center text-xs text-slate-500">
            {filtered ? "Không có sự kiện nào khớp bộ lọc." : "Chưa có sự kiện hiện diện nào."}
          </p>
        )}

        {!list.loading && list.events.length > 0 && (
          <ul className="grid gap-2 lg:grid-cols-2" aria-label="Sự kiện hiện diện">
            {list.events.map((event) => (
              <PresenceEventRow
                key={event.id}
                event={event}
                pendingKind={pending[event.id]}
                rowError={rowErrors[event.id]}
                onLabel={(e, kind) => void onLabel(e, kind)}
              />
            ))}
          </ul>
        )}

        {!list.loading && list.hasMore && list.events.length > 0 && (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => void list.loadMore()}
              disabled={list.loadingMore}
              className="px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {list.loadingMore ? "Đang tải..." : "Tải thêm"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
};

export default PresencePanel;
