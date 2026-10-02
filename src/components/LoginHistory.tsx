/**
 * Sign-in history (owner 2026-10-02: "audit login history for user").
 *
 * LoginHistoryPanel lists GET /api/users/login-events newest first with
 * "Tải thêm" paging; LoginHistoryDrawer shows it for one account. The server
 * decides who may read this (admin) - the panel only shows what it is sent, and
 * a refusal is shown as the server's own text, never as an empty list.
 *
 * Username, IP and user-agent are attacker controlled (anyone on the internet
 * can try to sign in): they are rendered as plain React text only.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, History, RefreshCw, X } from "lucide-react";
import { operatorJsonFetch } from "../utils/api";
import {
  LOGIN_KIND_FILTER_OPTIONS,
  LOGIN_TONE_CLASS,
  LoginEventRecord,
  LoginEventStream,
  LoginKindFilter,
  appendLoginEventsPage,
  buildLoginEventsUrl,
  formatLoginTime,
  isLoginFailureKind,
  loginEventsErrorText,
  loginKindLabel,
  loginKindTone,
  loginMethodLabel,
  loginReasonLabel,
  mergeLoginEventStreams,
  parseLoginEventsPage,
  parseLoginKindFilter,
  streamToAdvance,
  streamsForFilter,
  summarizeLoginFailures,
  userAgentLabel,
} from "../utils/loginEvents";

type FetchResult = { ok: true; stream: LoginEventStream } | { ok: false; error: string };

async function fetchStreamPage(stream: LoginEventStream, userId: string | undefined): Promise<FetchResult> {
  const res = await operatorJsonFetch<any>(
    buildLoginEventsUrl({ userId, kind: stream.kind, before: stream.events.length ? stream.nextCursor : undefined }),
  );
  if (!res.ok) return { ok: false, error: loginEventsErrorText(res) };
  const page = parseLoginEventsPage(res.data);
  if (!page) return { ok: false, error: loginEventsErrorText({ ...res, error: res.data?.error || "Máy chủ trả về dữ liệu không hợp lệ" }) };
  return { ok: true, stream: appendLoginEventsPage(stream, page) };
}

/** One owner for the requests of a panel; a response for an older filter is dropped. */
function useLoginEvents(userId: string | undefined, filter: LoginKindFilter) {
  const [streams, setStreams] = useState<LoginEventStream[]>(() => streamsForFilter(filter));
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    const initial = streamsForFilter(filter);
    setStreams(initial);
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    void Promise.all(initial.map((s) => fetchStreamPage(s, userId))).then((results) => {
      if (gen !== generation.current) return;
      const failed = results.find((r): r is { ok: false; error: string } => !r.ok);
      if (failed) setError(failed.error);
      else setStreams(results.map((r) => (r as { ok: true; stream: LoginEventStream }).stream));
      setLoading(false);
    });
    return () => {
      // Unmount or new filter: any response still in flight is ignored.
      generation.current++;
    };
  }, [userId, filter, reloadKey]);

  const loadMore = useCallback(async () => {
    const index = streamToAdvance(streams);
    if (index < 0 || loadingMore || loading) return;
    const gen = generation.current;
    setLoadingMore(true);
    setError(null);
    const result = await fetchStreamPage(streams[index], userId);
    if (gen !== generation.current) return;
    if (result.ok === true) {
      const next = result.stream;
      setStreams((prev) => prev.map((s, i) => (i === index ? next : s)));
    } else {
      setError(result.error);
    }
    setLoadingMore(false);
  }, [streams, userId, loading, loadingMore]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const merged = useMemo(() => mergeLoginEventStreams(streams), [streams]);
  return { ...merged, loading, loadingMore, error, loadMore, reload };
}

const LoginEventRow: React.FC<{ event: LoginEventRecord }> = ({ event }) => {
  const tone = loginKindTone(event.kind);
  const reason = loginReasonLabel(event.reason);
  const browser = userAgentLabel(event.userAgent);
  return (
    <tr className={isLoginFailureKind(event.kind) ? "bg-rose-50/30" : ""}>
      <td className="px-3 py-2 text-xs tabular-nums text-slate-700 whitespace-nowrap">
        <time dateTime={event.at}>{formatLoginTime(event.at)}</time>
      </td>
      <td className="px-3 py-2">
        <span className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-bold whitespace-nowrap ${LOGIN_TONE_CLASS[tone]}`}>
          {loginKindLabel(event.kind)}
        </span>
      </td>
      <td className="px-3 py-2 text-xs text-slate-600 whitespace-nowrap">{loginMethodLabel(event.method)}</td>
      <td className="px-3 py-2 font-mono text-xs text-slate-800 break-all">{event.username || "—"}</td>
      <td className="px-3 py-2 text-xs text-slate-700">{reason || "—"}</td>
      <td className="px-3 py-2 font-mono text-xs text-slate-600 break-all">{event.ip || "—"}</td>
      <td className="px-3 py-2 text-xs text-slate-600 whitespace-nowrap" title={event.userAgent || undefined}>
        {browser}
      </td>
    </tr>
  );
};

export interface LoginHistoryPanelProps {
  /** Unique id prefix for labels. */
  id: string;
  /** Only this account's events; omitted = every event (incl. unknown usernames and the setup token). */
  userId?: string;
  /** Failure count for the last 24 h (page-level view). */
  showSummary?: boolean;
}

export const LoginHistoryPanel: React.FC<LoginHistoryPanelProps> = ({ id, userId, showSummary = false }) => {
  const [filter, setFilter] = useState<LoginKindFilter>("all");
  const { visible, hasMore, loading, loadingMore, error, loadMore, reload } = useLoginEvents(userId, filter);
  const summary = useMemo(() => summarizeLoginFailures(visible, hasMore, Date.now()), [visible, hasMore]);
  const filterHasFailures = filter === "all" || filter === "failures" || isLoginFailureKind(filter);

  const status = loading
    ? "Đang tải lịch sử đăng nhập..."
    : loadingMore
      ? "Đang tải thêm..."
      : error
        ? ""
        : visible.length === 0
          ? "Không có sự kiện đăng nhập nào."
          : `Đang hiển thị ${visible.length} sự kiện${hasMore ? ", còn sự kiện cũ hơn" : ""}.`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="text-[11px] font-semibold text-slate-600" htmlFor={`${id}-kind`}>
          Loại sự kiện
          <select
            id={`${id}-kind`}
            value={filter}
            onChange={(e) => setFilter(parseLoginKindFilter(e.target.value))}
            className="mt-1 block px-3 py-2 rounded-lg border border-slate-300 text-sm font-normal bg-white focus:ring-2 focus:ring-slate-900 outline-none"
          >
            {LOGIN_KIND_FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={reload}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-slate-600 border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-60"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" /> Làm mới
        </button>
      </div>

      {showSummary && !loading && !error && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700" data-testid={`${id}-summary`}>
          {filterHasFailures ? (
            <>
              <span className="font-bold text-slate-900">Thất bại trong 24 giờ qua: </span>
              <span className={`font-bold ${summary.failures > 0 ? "text-rose-700" : "text-emerald-700"}`}>{summary.failures}</span> lần, từ{" "}
              <span className="font-bold text-slate-900">{summary.distinctIps}</span> địa chỉ IP khác nhau.{" "}
              <span className="text-slate-500">
                {summary.complete
                  ? "(Tính trên các dòng đã tải — đã đủ 24 giờ với bộ lọc hiện tại.)"
                  : `(Chỉ tính trên ${summary.loadedRows} dòng đã tải — bấm "Tải thêm" để tính đủ 24 giờ.)`}
              </span>
            </>
          ) : (
            <span className="text-slate-500">Bộ lọc hiện tại không gồm các lần thất bại.</span>
          )}
        </div>
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>

      {error && (
        <div role="alert" className="flex items-start gap-2 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{error}</span>
          {visible.length === 0 && (
            <button type="button" onClick={reload} className="underline font-bold">
              Thử lại
            </button>
          )}
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-white overflow-x-auto">
        <table className="w-full text-sm" aria-describedby={`${id}-caption`}>
          <caption id={`${id}-caption`} className="sr-only">
            Lịch sử đăng nhập, mới nhất trước
          </caption>
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="text-left px-3 py-2 font-semibold">Thời gian</th>
              <th scope="col" className="text-left px-3 py-2 font-semibold">Sự kiện</th>
              <th scope="col" className="text-left px-3 py-2 font-semibold">Cách</th>
              <th scope="col" className="text-left px-3 py-2 font-semibold">Tên đăng nhập</th>
              <th scope="col" className="text-left px-3 py-2 font-semibold">Lý do</th>
              <th scope="col" className="text-left px-3 py-2 font-semibold">IP</th>
              <th scope="col" className="text-left px-3 py-2 font-semibold">Trình duyệt</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-xs text-slate-500">
                  Đang tải lịch sử đăng nhập...
                </td>
              </tr>
            )}
            {!loading && !error && visible.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-xs text-slate-500">
                  {filter === "all" ? "Chưa có sự kiện đăng nhập nào." : "Không có sự kiện nào khớp bộ lọc."}
                </td>
              </tr>
            )}
            {!loading && visible.map((e) => <LoginEventRow key={e.id} event={e} />)}
          </tbody>
        </table>
      </div>

      {!loading && hasMore && visible.length > 0 && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {loadingMore ? "Đang tải..." : "Tải thêm"}
          </button>
        </div>
      )}
    </div>
  );
};

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface LoginHistoryDrawerProps {
  account: { id: string; username: string; displayName: string };
  onClose: () => void;
}

/**
 * Side drawer for one account. Same keyboard contract as ModalDialog: focus
 * moves in on open, Tab cycles inside, Escape and the backdrop close, and focus
 * returns to the button that opened it.
 */
export const LoginHistoryDrawer: React.FC<LoginHistoryDrawerProps> = ({ account, onClose }) => {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = "login-history-drawer-title";

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    (dialogRef.current?.querySelector(FOCUSABLE) as HTMLElement | null)?.focus();
    return () => {
      previous?.focus?.();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = Array.from(dialogRef.current.querySelectorAll(FOCUSABLE)) as HTMLElement[];
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex justify-end bg-slate-900/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="h-full w-full max-w-5xl bg-white shadow-2xl overflow-y-auto"
        data-testid="login-history-drawer"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-100 bg-white">
          <div>
            <h2 id={titleId} className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <History className="w-4 h-4" aria-hidden="true" /> Lịch sử đăng nhập — {account.displayName}
            </h2>
            <p className="font-mono text-xs text-slate-500">{account.username}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100"
            aria-label="Đóng lịch sử đăng nhập"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        <div className="px-5 py-4">
          <LoginHistoryPanel id={`login-history-${account.id}`} userId={account.id} />
          <p className="mt-3 text-[11px] text-slate-500">
            Chỉ gồm sự kiện gắn với tài khoản này. Lần thử với tên đăng nhập không tồn tại, đăng nhập bằng mã khởi tạo và địa chỉ bị chặn
            nằm ở tab "Lịch sử đăng nhập".
          </p>
        </div>
      </div>
    </div>
  );
};

export default LoginHistoryPanel;
