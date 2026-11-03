import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, ScanSearch, Trash2 } from "lucide-react";
import { safeJsonFetch } from "../utils/api";
import { FaceThumb } from "./FaceImage";
import {
  TEMPLATE_AUDIT_BUTTON,
  TEMPLATE_AUDIT_DELETE,
  TEMPLATE_AUDIT_EMPTY,
  TEMPLATE_AUDIT_EXPLANATION,
  TEMPLATE_AUDIT_RUNNING,
  TEMPLATE_AUDIT_URL,
  auditErrorText,
  auditSummaryText,
  employeeLabel,
  formatAuditTime,
  formatCosine,
  groupSuspectsByEmployee,
  ownCosineText,
  readTemplateAudit,
  reasonLabel,
  suspectImageUrl,
  templateCellParts,
  templateDeleteUrl,
  withoutSuspect,
  type TemplateAuditView,
  type TemplateSuspect,
} from "../utils/templateAudit";

/**
 * "So lại mẫu với nhân viên đã biết" (Taiga #508): runs GET /api/face-templates/audit
 * on demand and lists the templates the server found closer to another employee
 * than to their owner, grouped by owner, with a confirmed per-row delete through
 * the existing DELETE /api/employees/:id/templates/:templateId. Admin only - the
 * parent decides whether to mount it; a 401/403 from the server is shown as such.
 */

export interface TemplateAuditViewProps {
  view: TemplateAuditView | null;
  running: boolean;
  error: string | null;
  /** Row whose delete is awaiting confirmation. */
  confirmId: string | null;
  /** Row whose DELETE is in flight. */
  deletingId: string | null;
  /** Inline error of the last failed delete, keyed by templateId. */
  deleteErrors: Record<string, string>;
  onRun: () => void;
  onAskDelete: (templateId: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (s: TemplateSuspect) => void;
}

const REASON_CLASS: Record<TemplateSuspect["reason"], string> = {
  "matches-other": "bg-rose-100 text-rose-800 border-rose-200",
  "closer-to-other": "bg-amber-100 text-amber-900 border-amber-200",
};

/** Static markup of the panel (tested with renderToStaticMarkup). */
export const TemplateAuditPanelView: React.FC<TemplateAuditViewProps> = ({
  view,
  running,
  error,
  confirmId,
  deletingId,
  deleteErrors,
  onRun,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}) => {
  const groups = view ? groupSuspectsByEmployee(view.suspects) : [];
  return (
    <section
      aria-labelledby="template-audit-heading"
      data-testid="template-audit-panel"
      className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3"
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 id="template-audit-heading" className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
            <ScanSearch className="w-4 h-4 text-indigo-600" />
            So lại mẫu khuôn mặt với nhân viên đã biết
          </h3>
          <p className="text-[11px] text-slate-500 leading-relaxed mt-0.5">{TEMPLATE_AUDIT_EXPLANATION}</p>
        </div>
        <button
          type="button"
          data-testid="template-audit-run"
          onClick={onRun}
          disabled={running}
          aria-busy={running || undefined}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition disabled:opacity-60 disabled:cursor-wait shrink-0"
        >
          {running ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ScanSearch className="w-3.5 h-3.5" />}
          <span>{running ? TEMPLATE_AUDIT_RUNNING : TEMPLATE_AUDIT_BUTTON}</span>
        </button>
      </div>

      {/* Outcome of the last run (polite so a screen reader hears the count once it lands). */}
      <div aria-live="polite" className="space-y-2">
        {error && (
          <div
            role="alert"
            data-testid="template-audit-error"
            className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-[11px] text-amber-900 flex items-start gap-2"
          >
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}

        {view && !error && (
          <p data-testid="template-audit-summary" className="text-[11px] text-slate-700">
            <strong>{auditSummaryText(view)}</strong>
            {view.generatedAt && <span className="text-slate-500"> · {formatAuditTime(view.generatedAt)}</span>}
            {view.modelTag && <span className="text-slate-400 font-mono"> · {view.modelTag}</span>}
          </p>
        )}

        {view && !error && view.suspects.length === 0 && (
          <p data-testid="template-audit-empty" className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-[11px] text-emerald-900">
            {TEMPLATE_AUDIT_EMPTY}
          </p>
        )}
      </div>

      {view && !error && groups.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] border-collapse" data-testid="template-audit-table">
            <caption className="sr-only">Mẫu khuôn mặt nghi ngờ, nhóm theo nhân viên</caption>
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-200">
                <th scope="col" className="py-1.5 pr-2 font-semibold">Nhân viên</th>
                <th scope="col" className="py-1.5 pr-2 font-semibold">Mẫu</th>
                <th scope="col" className="py-1.5 pr-2 font-semibold">Giống chính mình</th>
                <th scope="col" className="py-1.5 pr-2 font-semibold">Giống người khác</th>
                <th scope="col" className="py-1.5 pr-2 font-semibold">Lý do</th>
                <th scope="col" className="py-1.5 font-semibold">
                  <span className="sr-only">Thao tác</span>
                </th>
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.employeeId} data-testid="template-audit-group" className="border-b border-slate-100">
                {g.suspects.map((s, idx) => {
                  const confirming = confirmId === s.templateId;
                  const deleting = deletingId === s.templateId;
                  const rowError = deleteErrors[s.templateId];
                  const img = suspectImageUrl(s);
                  return (
                    <tr key={s.templateId} data-testid="template-audit-row" className="align-top">
                      {idx === 0 && (
                        <th scope="rowgroup" rowSpan={g.suspects.length} className="py-2 pr-2 text-left font-semibold text-slate-800 whitespace-nowrap">
                          {employeeLabel(g.employeeCode, g.employeeName, g.employeeId)}
                          <div className="text-slate-400 font-normal">{g.suspects.length} mẫu</div>
                        </th>
                      )}
                      <td className="py-2 pr-2">
                        <div className="flex items-start gap-2">
                          {img && (
                            <FaceThumb
                              src={img}
                              alt={`Khung hình gốc của mẫu ${s.templateId}`}
                              className="w-10 h-10 rounded-md"
                              caption={templateCellParts(s).join(" · ")}
                            />
                          )}
                          <div className="min-w-0">
                            <div className="text-slate-700">{templateCellParts(s).join(" · ") || "—"}</div>
                            <div className="text-slate-400 font-mono break-all">
                              {s.templateId}
                              {s.quality !== null && <> · chất lượng {formatCosine(s.quality)}</>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-2 pr-2 font-mono text-slate-700 whitespace-nowrap">{ownCosineText(s)}</td>
                      <td className="py-2 pr-2">
                        <div className="text-slate-800">{employeeLabel(s.otherEmployeeCode, s.otherEmployeeName, s.otherEmployeeId)}</div>
                        <div className="font-mono text-slate-600">
                          {formatCosine(s.otherCosine)}
                          {s.otherCentroidCosine !== null && (
                            <span className="text-slate-400"> (tâm {formatCosine(s.otherCentroidCosine)})</span>
                          )}
                        </div>
                      </td>
                      <td className="py-2 pr-2">
                        <span className={`inline-block px-1.5 py-0.5 rounded border font-semibold whitespace-nowrap ${REASON_CLASS[s.reason]}`}>
                          {reasonLabel(s.reason)}
                        </span>
                      </td>
                      <td className="py-2 whitespace-nowrap">
                        {confirming ? (
                          <div role="group" aria-label={`Xác nhận xóa mẫu ${s.templateId}`} className="flex items-center gap-1">
                            <button
                              type="button"
                              data-testid={`template-audit-confirm-${s.templateId}`}
                              onClick={() => onConfirmDelete(s)}
                              disabled={deleting}
                              className="px-2 py-1 rounded-md bg-rose-600 hover:bg-rose-700 text-white font-semibold disabled:opacity-60"
                            >
                              {deleting ? "Đang xóa…" : "Xóa vĩnh viễn"}
                            </button>
                            <button
                              type="button"
                              onClick={onCancelDelete}
                              disabled={deleting}
                              className="px-2 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold disabled:opacity-60"
                            >
                              Hủy
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            data-testid={`template-audit-delete-${s.templateId}`}
                            onClick={() => onAskDelete(s.templateId)}
                            disabled={deletingId !== null}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-rose-700 hover:bg-rose-50 font-semibold disabled:opacity-40"
                            title="Xóa mẫu này khỏi kho mẫu của nhân viên (vĩnh viễn)"
                          >
                            <Trash2 className="w-3.5 h-3.5" /> {TEMPLATE_AUDIT_DELETE}
                          </button>
                        )}
                        {rowError && (
                          <div role="alert" data-testid={`template-audit-delete-error-${s.templateId}`} className="mt-1 text-rose-700 max-w-[16rem] whitespace-normal break-words">
                            {rowError}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </section>
  );
};

interface TemplateAuditPanelProps {
  /** Called after a template was deleted on the server (the owner's template list may need a reload). */
  onDeleted?: (employeeId: string, templateId: string) => void;
}

export const TemplateAuditPanel: React.FC<TemplateAuditPanelProps> = ({ onDeleted }) => {
  const [view, setView] = useState<TemplateAuditView | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    setConfirmId(null);
    const res = await safeJsonFetch<unknown>(TEMPLATE_AUDIT_URL);
    if (!alive.current) return;
    const parsed = res.ok ? readTemplateAudit(res.data) : null;
    if (parsed) {
      setView(parsed);
      setDeleteErrors({});
    } else {
      // A refusal or a malformed body is an error - never an empty "all clear".
      setError(auditErrorText(res));
    }
    setRunning(false);
  }, [running]);

  const confirmDelete = useCallback(
    async (s: TemplateSuspect) => {
      if (deletingId) return;
      setDeletingId(s.templateId);
      setDeleteErrors((m) => {
        const { [s.templateId]: _dropped, ...rest } = m;
        return rest;
      });
      const res = await safeJsonFetch<{ success?: boolean; error?: string }>(templateDeleteUrl(s.employeeId, s.templateId), {
        method: "DELETE",
      });
      if (!alive.current) return;
      if (res.ok && res.data?.success !== false) {
        setView((v) => (v ? withoutSuspect(v, s.templateId) : v));
        setConfirmId(null);
        onDeleted?.(s.employeeId, s.templateId);
      } else {
        const msg =
          res.status === 401 || res.status === 403
            ? "Không đủ quyền xóa mẫu này."
            : res.data?.error || res.error || `Không xóa được mẫu này (HTTP ${res.status || 0}).`;
        setDeleteErrors((m) => ({ ...m, [s.templateId]: msg }));
      }
      setDeletingId(null);
    },
    [deletingId, onDeleted]
  );

  return (
    <TemplateAuditPanelView
      view={view}
      running={running}
      error={error}
      confirmId={confirmId}
      deletingId={deletingId}
      deleteErrors={deleteErrors}
      onRun={run}
      onAskDelete={setConfirmId}
      onCancelDelete={() => setConfirmId(null)}
      onConfirmDelete={confirmDelete}
    />
  );
};
