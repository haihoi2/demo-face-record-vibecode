/**
 * Fourth card on the engine tab: the real-time pipeline engine.
 *
 * It is a SEPARATE engine flow beside the legacy recognize workflow and is
 * switched PER GATE (legacy | shadow | live) - it is NOT one of the three
 * legacy engine-mode values and this component never touches that setting. Everything
 * shown here comes from `GET /api/camera-streams/watch`; the only write is
 * `POST /api/camera-streams/:gate/pipeline-mode` (admin + CSRF), and the row
 * renders whatever the server hands back - never an optimistic guess.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Cpu, Gauge, GitBranch, Info, Radar, RefreshCw, ShieldAlert, X } from "lucide-react";

import { operatorJsonFetch, safeJsonFetch } from "../utils/api";
import { hasRole, useOperatorSession } from "../utils/session";
import {
  formatDurationMs,
  formatFps,
  isFrameAgeWorrying,
  pipelineModeFallbackNote,
  pipelineModeHint,
  pipelineModeLabel,
  pipelineModeTone,
  sourceStatusLabel,
  sourceStatusTone,
  workerStateLabel,
  type PipelineMode,
  type Tone,
} from "../utils/pipelineStatus";
import {
  GATE_KEYS,
  PIPELINE_MODES,
  PIPELINE_MODE_UNAVAILABLE_TITLE,
  buildPipelineModeRequest,
  gateLabel,
  interpretPipelineModeResponse,
  isPipelineModeSelectable,
  pipelineModeConfirmText,
  pipelineModeSourceLabel,
  readGatePipelineRow,
  readGatePipelineRows,
  type GateKey,
  type GatePipelineRow,
} from "../utils/pipelineMode";

/** Light-theme chips (the dashboard's dark map does not read on this page). */
const TONE_CHIP: Record<Tone, string> = {
  emerald: "bg-emerald-50 text-emerald-800 border-emerald-200",
  sky: "bg-sky-50 text-sky-800 border-sky-200",
  amber: "bg-amber-50 text-amber-800 border-amber-200",
  rose: "bg-rose-50 text-rose-800 border-rose-200",
  slate: "bg-slate-100 text-slate-700 border-slate-200",
};

const POLL_MS = 5000;

type Rows = Partial<Record<GateKey, GatePipelineRow>>;
type Notice = { tone: Tone; text: string } | null;
type PendingSwitch = { key: GateKey; target: PipelineMode | null } | null;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Small confirm dialog: focus moves in on open, Tab cycles inside, Escape and
 * the backdrop cancel, and focus returns to the button that opened it.
 */
const ConfirmSwitchDialog: React.FC<{
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ title, body, confirmLabel, busy, onConfirm, onCancel }) => {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => {
      previous?.focus?.();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!busy) onCancel();
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
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rt-engine-confirm-title"
        aria-describedby="rt-engine-confirm-body"
        onKeyDown={onKeyDown}
        className="w-full max-w-md rounded-2xl bg-white shadow-2xl"
        data-testid="rt-engine-confirm"
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-100">
          <h3 id="rt-engine-confirm-title" className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <ShieldAlert className="w-4 h-4 text-amber-600" /> {title}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-40"
            aria-label="Đóng hộp xác nhận"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p id="rt-engine-confirm-body" className="px-5 py-4 text-xs text-slate-700 leading-relaxed">
          {body}
        </p>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-100">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: React.ReactNode; tone?: Tone; icon?: React.ReactNode }> = ({ label, value, tone, icon }) => (
  <div className={`p-2 rounded-lg border ${tone ? TONE_CHIP[tone] : "bg-white border-slate-200"}`}>
    <div className={`text-[9px] uppercase tracking-wide inline-flex items-center gap-1 ${tone ? "opacity-80" : "text-slate-500"}`}>
      {icon}
      {label}
    </div>
    <div className={`font-mono text-[11px] font-bold ${tone ? "" : "text-slate-900"}`}>{value}</div>
  </div>
);

export const RealtimeEngineCard: React.FC = () => {
  const session = useOperatorSession();
  const isAdmin = hasRole(session, "admin");

  const [rows, setRows] = useState<Rows>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [pendingGate, setPendingGate] = useState<GateKey | null>(null);
  const [confirm, setConfirm] = useState<PendingSwitch>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const mounted = useRef(true);

  const fetchRows = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const res = await safeJsonFetch<unknown>("/api/camera-streams/watch");
    if (!mounted.current) return;
    if (res.status === 404 || res.status === 501) {
      setSupported(false);
      setFetchError(null);
    } else if (res.ok) {
      setRows(readGatePipelineRows(res.data));
      setSupported(true);
      setFetchError(null);
    } else {
      setFetchError(
        res.status === 0
          ? "Không kết nối được máy chủ để đọc trạng thái động cơ thời gian thực."
          : res.error || `Không đọc được trạng thái động cơ thời gian thực (HTTP ${res.status}).`,
      );
    }
    setCheckedAt(new Date().toLocaleTimeString("vi-VN"));
    setLoading(false);
  }, []);

  // Poll every 5 s while the page is visible; catch up on return; stop on unmount.
  useEffect(() => {
    mounted.current = true;
    void fetchRows();
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void fetchRows(true);
    };
    const timer = setInterval(tick, POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void fetchRows(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchRows]);

  const applySwitch = useCallback(
    async (key: GateKey, target: PipelineMode | null) => {
      setPendingGate(key);
      setNotice(null);
      try {
        const { url, init } = buildPipelineModeRequest(key, target);
        const res = await operatorJsonFetch<unknown>(url, init);
        if (!mounted.current) return;
        const outcome = interpretPipelineModeResponse(key, res);
        if (outcome.kind === "applied") {
          const row = readGatePipelineRow(outcome.watcher);
          if (row) setRows((prev) => ({ ...prev, [row.key]: row }));
          setNotice({ tone: "emerald", text: outcome.message });
          void fetchRows(true);
        } else {
          setNotice({ tone: outcome.kind === "unreachable" ? "amber" : "rose", text: outcome.message });
        }
      } finally {
        if (mounted.current) {
          setPendingGate(null);
          setConfirm(null);
        }
      }
    },
    [fetchRows],
  );

  const renderControls = (row: GatePipelineRow | undefined, key: GateKey) => {
    if (!isAdmin) {
      return (
        <p className="text-[11px] text-slate-500 inline-flex items-center gap-1">
          <Info className="w-3 h-3" /> Đổi chế độ cần quyền Quản trị.
        </p>
      );
    }
    const busy = pendingGate === key;
    const configured = row?.configured ?? null;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={`Chế độ động cơ thời gian thực cho ${gateLabel(key)}`} className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
          {PIPELINE_MODES.map((mode) => {
            const selectable = isPipelineModeSelectable(mode);
            const selected = configured === mode;
            return (
              <button
                key={mode}
                type="button"
                aria-pressed={selected}
                disabled={busy || !selectable}
                title={selectable ? undefined : PIPELINE_MODE_UNAVAILABLE_TITLE}
                onClick={() => {
                  if (selected) return;
                  setConfirm({ key, target: mode });
                }}
                data-testid={`rt-mode-${key}-${mode}`}
                className={`px-2.5 py-1 text-[11px] font-semibold border-r last:border-r-0 border-slate-200 transition-colors disabled:cursor-not-allowed ${
                  selected ? "bg-indigo-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50 disabled:text-slate-400 disabled:bg-slate-50"
                }`}
              >
                {pipelineModeLabel(mode)}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          disabled={busy || row?.source !== "config"}
          onClick={() => setConfirm({ key, target: null })}
          title={row?.source === "config" ? "Bỏ giá trị đã cấu hình cho cổng này" : "Cổng này đang theo mặc định máy chủ"}
          data-testid={`rt-mode-${key}-default`}
          className="px-2.5 py-1 text-[11px] font-semibold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Dùng mặc định máy chủ
        </button>
        {busy && <RefreshCw className="w-3.5 h-3.5 text-indigo-600 animate-spin" aria-label="Đang gửi yêu cầu" />}
      </div>
    );
  };

  const renderRow = (key: GateKey) => {
    const row = rows[key];
    const view = row?.view;
    const state = view?.state ?? null;
    const stats = view?.stats ?? null;
    const fallback = view ? pipelineModeFallbackNote(view) : null;
    const ageWorrying = isFrameAgeWorrying(state?.newestFrameAgeMs);
    const worker = stats?.worker ?? null;
    const hasCounts =
      !!stats &&
      ["decisions", "employees", "strangers", "insufficient", "framesProcessed", "framesDroppedBusy"].some(
        (k) => typeof (stats as Record<string, unknown>)[k] === "number",
      );

    return (
      <div key={key} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 space-y-2" data-testid={`rt-gate-${key}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-bold text-slate-900">{gateLabel(key)}</span>
            {!row ? (
              <span className="text-slate-500">{loading ? "đang đọc..." : "máy chủ chưa báo cổng này"}</span>
            ) : (
              <>
                {view?.mode ? (
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold border ${TONE_CHIP[pipelineModeTone(view.mode)]}`}
                    data-testid={`rt-effective-${key}`}
                  >
                    {pipelineModeLabel(view.mode)}
                  </span>
                ) : (
                  <span className="text-slate-500">chế độ: máy chủ chưa báo</span>
                )}
                <span className="text-[10px] text-slate-500">({pipelineModeSourceLabel(row.source)})</span>
                {row.enabled === false && (
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${TONE_CHIP.amber}`}>
                    quét nền đang tắt - không chạy luồng riêng
                  </span>
                )}
              </>
            )}
          </div>
          {renderControls(row, key)}
        </div>

        {view?.mode && <p className="text-[11px] text-slate-600">{pipelineModeHint(view.mode)}</p>}

        {fallback && (
          <div className={`px-2 py-1.5 rounded-md border text-[11px] flex items-start gap-1.5 ${TONE_CHIP.amber}`}>
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>{fallback}</span>
          </div>
        )}

        {row && !state && !stats && (
          <p className="text-[11px] text-slate-500">
            Chưa có luồng riêng cho cổng này: watcher hiện tại quét từng lượt, nghỉ giữa hai lượt như trước.
          </p>
        )}

        {state && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            <Stat label="Luồng hình" value={sourceStatusLabel(state.status)} tone={sourceStatusTone(state.status)} />
            <Stat label="Tốc độ đọc" value={formatFps(state.fps)} />
            <Stat
              label="Khung mới nhất"
              tone={ageWorrying ? "amber" : undefined}
              value={state.newestFrameAgeMs === null ? "—" : `${formatDurationMs(state.newestFrameAgeMs)} trước`}
            />
            <Stat label="Kết nối lại" value={state.reconnects ?? "—"} />
          </div>
        )}

        {stats && (hasCounts || typeof stats.lastLoopMs === "number" || typeof stats.lastDecisionLatencyMs === "number") && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            <Stat
              label="Quyết định"
              icon={<Gauge className="w-2.5 h-2.5" />}
              value={
                <>
                  {stats.decisions ?? "—"}
                  <span className="font-normal text-slate-500">
                    {" "}
                    · NV {stats.employees ?? "—"} · lạ {stats.strangers ?? "—"} · chưa đủ {stats.insufficient ?? "—"}
                  </span>
                </>
              }
            />
            <Stat
              label="Khung đã xử lý"
              value={
                <>
                  {stats.framesProcessed ?? "—"}
                  {typeof stats.framesDroppedBusy === "number" && (
                    <span className="font-normal text-slate-500"> · bỏ {stats.framesDroppedBusy} vì bận</span>
                  )}
                </>
              }
            />
            <Stat label="Vòng xử lý cuối" value={formatDurationMs(stats.lastLoopMs)} />
            <Stat label="Độ trễ quyết định" value={formatDurationMs(stats.lastDecisionLatencyMs)} />
          </div>
        )}

        {stats && (typeof stats.contextOk === "boolean" || worker) && (
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            {typeof stats.contextOk === "boolean" && (
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border ${TONE_CHIP[stats.contextOk ? "emerald" : "amber"]}`}>
                <GitBranch className="w-3 h-3" />
                Ngữ cảnh: {stats.contextOk ? "sẵn sàng" : "chưa sẵn sàng"}
                {stats.contextReason && <span className="font-normal opacity-80">- {stats.contextReason}</span>}
              </span>
            )}
            {worker && (
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border ${TONE_CHIP.slate}`}>
                <Cpu className="w-3 h-3" />
                Worker: {workerStateLabel(worker.state)}
                {worker.restarts !== null && <span className="font-normal">· khởi động lại {worker.restarts}</span>}
                {worker.engineReady !== null && (
                  <span className="font-normal">· động cơ {worker.engineReady ? "sẵn sàng" : "chưa sẵn sàng"}</span>
                )}
                {worker.openTracks !== null && <span className="font-normal">· {worker.openTracks} dấu vết đang mở</span>}
                {worker.detectInput && <span className="font-mono font-normal">· detector {worker.detectInput}</span>}
              </span>
            )}
          </div>
        )}

        {(state?.lastError || stats?.lastError) && (
          <div className={`px-2 py-1.5 rounded-md border text-[11px] flex items-start gap-1.5 ${TONE_CHIP.rose}`}>
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span className="break-words">
              {state?.lastError && (
                <>
                  <b>Lỗi luồng hình:</b> {state.lastError}
                </>
              )}
              {state?.lastError && stats?.lastError && <br />}
              {stats?.lastError && (
                <>
                  <b>Lỗi worker:</b> {stats.lastError}
                </>
              )}
            </span>
          </div>
        )}
      </div>
    );
  };

  const confirmText = confirm ? pipelineModeConfirmText(confirm.key, confirm.target) : null;

  return (
    <section
      id="card-engine-realtime"
      aria-labelledby="card-engine-realtime-title"
      aria-describedby="card-engine-realtime-note"
      className="relative rounded-2xl p-6 border-2 border-sky-200 bg-white"
      data-testid="rt-engine-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="p-3 bg-sky-100 text-sky-700 rounded-xl">
          <Radar className="w-6 h-6" />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-sky-100 text-sky-700 border border-sky-200">
            Mới - luồng riêng
          </span>
          <button
            type="button"
            onClick={() => void fetchRows()}
            disabled={loading}
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            aria-label="Đọc lại trạng thái động cơ thời gian thực"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
            {checkedAt ? `Lúc ${checkedAt}` : "Đọc lại"}
          </button>
        </div>
      </div>

      <div className="mt-4">
        <h3 id="card-engine-realtime-title" className="text-base font-bold text-slate-900">
          Động cơ thời gian thực
        </h3>
        <p id="card-engine-realtime-note" className="text-xs text-slate-500 mt-1">
          Một luồng riêng chạy bên cạnh quy trình hiện tại và được bật cho từng cổng. Ở chạy thử (shadow) chỉ quan sát:
          không mở cửa, không ghi nhật ký. Thẻ này không thuộc ba chế độ động cơ ở trên và không đổi chế độ nhận diện.
        </p>
      </div>

      <div className="mt-4 space-y-3">
        {supported === false && (
          <div className={`px-3 py-2 rounded-lg border text-xs flex items-start gap-2 ${TONE_CHIP.amber}`}>
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>Máy chủ này chưa có API trạng thái quét nền (HTTP 404); không đọc được động cơ thời gian thực.</span>
          </div>
        )}
        {fetchError && (
          <div className={`px-3 py-2 rounded-lg border text-xs flex items-start gap-2 ${TONE_CHIP.rose}`}>
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{fetchError}</span>
          </div>
        )}
        {supported !== false && GATE_KEYS.map(renderRow)}
      </div>

      <div role="status" aria-live="polite" className="mt-3 min-h-[1.25rem]" data-testid="rt-engine-notice">
        {notice && (
          <div className={`px-3 py-2 rounded-lg border text-xs flex items-start gap-2 ${TONE_CHIP[notice.tone]}`}>
            {notice.tone === "emerald" ? <Check className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
            <span>{notice.text}</span>
          </div>
        )}
      </div>

      {confirm && confirmText && (
        <ConfirmSwitchDialog
          title={confirmText.title}
          body={confirmText.body}
          confirmLabel={confirmText.confirmLabel}
          busy={pendingGate === confirm.key}
          onConfirm={() => void applySwitch(confirm.key, confirm.target)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </section>
  );
};

export default RealtimeEngineCard;
