import React, { useCallback, useEffect, useState } from "react";
import {
  ClipboardList,
  Search,
  Download,
  Trash2,
  CheckCircle2,
  XCircle,
  Filter,
  ArrowDownRight,
  ArrowUpRight,
  Lock,
  Unlock,
  ShieldCheck,
  Clock,
  Scan,
  BarChart3,
  ChevronDown,
  ChevronUp,
  UserX,
  UserPlus,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Loader2,
  Film,
} from "lucide-react";
import { AccessLog } from "../types";
import { EntryPatternAnalytics } from "./EntryPatternAnalytics";
import { ProtectedImage } from "./ProtectedImage";
import { RecordingPlayer } from "./RecordingPlayer";
import { useRecordingGates } from "../utils/recordings";
import {
  AccessLogFilters,
  AccessLogStats,
  EMPTY_LOG_FILTERS,
  downloadLogCsv,
  fetchLogPage,
  fetchLogStats,
} from "../utils/accessLogs";

interface AccessLogsProps {
  onClearLogs: () => void;
  /** Opens the stranger panel on the group containing this capture. */
  onOpenStrangerClusters?: (logId?: string) => void;
  /** Newest log id the app has seen; a change refreshes the first page and the totals. */
  latestLogId?: string;
}

const PAGE_SIZE = 50;

/**
 * The whole access history, filtered, counted and paged by the server. Search,
 * the summary cards, the chart and the CSV all cover every matching entry -
 * not just the newest page, which is what they used to silently describe.
 */
export const AccessLogs: React.FC<AccessLogsProps> = ({
  onClearLogs,
  onOpenStrangerClusters,
  latestLogId,
}) => {
  const [searchInput, setSearchInput] = useState<string>("");
  const [filters, setFilters] = useState<AccessLogFilters>(EMPTY_LOG_FILTERS);
  const [showAnalytics, setShowAnalytics] = useState<boolean>(true);
  // Cursors that led to the current page; empty = first page.
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [rows, setRows] = useState<AccessLog[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [stats, setStats] = useState<AccessLogStats | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<boolean>(false);
  const recordingGates = useRecordingGates();
  const [recordingOf, setRecordingOf] = useState<{ id: string; title: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState<number>(0);

  const statusFilter = filters.status;
  const typeFilter = filters.type;
  const setStatusFilter = (status: AccessLogFilters["status"]) => setFilters((f) => ({ ...f, status }));
  const setTypeFilter = (type: AccessLogFilters["type"]) => setFilters((f) => ({ ...f, type }));

  // Search is sent to the server once typing pauses.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === searchInput ? f : { ...f, q: searchInput })), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Any filter change starts again from the first page.
  useEffect(() => {
    setCursorStack([]);
  }, [filters]);

  const currentCursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchLogPage(filters, currentCursor, PAGE_SIZE);
      setRows(page.logs);
      setTotal(page.total);
      setNextCursor(page.hasMore ? page.nextCursor : null);
    } catch (err: any) {
      setError(err?.message || "Không tải được nhật ký");
    } finally {
      setLoading(false);
    }
  }, [filters, currentCursor]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    let active = true;
    fetchLogStats(filters)
      .then((s) => active && setStats(s))
      .catch(() => active && setStats(null));
    return () => {
      active = false;
    };
  }, [filters, refreshKey]);

  // A new entry arrived: refresh while the operator is looking at the newest page.
  useEffect(() => {
    if (cursorStack.length === 0) setRefreshKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestLogId]);

  const grantedCount = stats?.granted ?? 0;
  const deniedCount = stats?.denied ?? 0;
  const statsTotal = stats?.total ?? total;
  const pageStart = total === 0 ? 0 : cursorStack.length * PAGE_SIZE + 1;
  const pageEnd = cursorStack.length * PAGE_SIZE + rows.length;
  const filtersActive = JSON.stringify(filters) !== JSON.stringify(EMPTY_LOG_FILTERS);

  const handleExport = async () => {
    setExporting(true);
    setError(null);
    try {
      await downloadLogCsv(filters);
    } catch (err: any) {
      setError(err?.message || "Xuất CSV thất bại");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Quick Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-xs">
          <span className="text-xs text-slate-500 font-medium block">
            Tổng Lượt Quét Cửa
          </span>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-2xl font-bold font-mono text-slate-900 tabular-nums">
              {statsTotal.toLocaleString("vi-VN")}
            </span>
            <Scan className="w-5 h-5 text-indigo-500" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-xs">
          <span className="text-xs text-slate-500 font-medium block">
            Mở Cửa Hợp Lệ (Granted)
          </span>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-2xl font-bold font-mono text-emerald-600">
              {grantedCount}
            </span>
            <CheckCircle2 className="w-5 h-5 text-emerald-500" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-xs">
          <span className="text-xs text-slate-500 font-medium block">
            Cảnh Báo Từ Chối (Denied)
          </span>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-2xl font-bold font-mono text-rose-600">
              {deniedCount}
            </span>
            <XCircle className="w-5 h-5 text-rose-500" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-xs">
          <span className="text-xs text-slate-500 font-medium block">
            Tỷ Lệ Nhận Diện Chính Xác
          </span>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-2xl font-bold font-mono text-blue-600">
              {statsTotal > 0
                ? Math.round((grantedCount / statsTotal) * 100)
                : 100}
              %
            </span>
            <ShieldCheck className="w-5 h-5 text-blue-500" />
          </div>
        </div>
      </div>

      {/* Analytics Visibility Toggle & Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-slate-800 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-indigo-600" />
            Biểu Đồ Xu Hướng Vào Ra Theo Giờ
          </span>
          <span className="text-xs text-slate-500 font-mono tabular-nums">
            ({statsTotal.toLocaleString("vi-VN")} bản ghi{filtersActive ? " khớp bộ lọc" : ""})
          </span>
        </div>

        <button
          id="btn-toggle-analytics-section"
          onClick={() => setShowAnalytics((prev) => !prev)}
          className="px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition shadow-2xs cursor-pointer"
        >
          {showAnalytics ? (
            <>
              <ChevronUp className="w-3.5 h-3.5 text-slate-500" />
              <span>Thu gọn biểu đồ</span>
            </>
          ) : (
            <>
              <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
              <span>Hiển thị biểu đồ phân tích</span>
            </>
          )}
        </button>
      </div>

      {/* Entry Pattern Analytics Visualization Section */}
      {showAnalytics && (
        <EntryPatternAnalytics filters={filters} refreshKey={refreshKey} />
      )}

      {/* Filter and Control Bar */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-xs flex flex-col md:flex-row items-center justify-between gap-4">
        {/* Search */}
        <div className="relative w-full md:w-80">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            id="input-search-logs"
            type="text"
            placeholder="Tìm theo tên, mã NV, phòng ban..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-hidden focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition"
          />
        </div>

        {/* Date range (local calendar days, inclusive) */}
        <div className="flex items-center gap-1.5 text-xs text-slate-600">
          <CalendarDays className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            id="input-logs-from"
            type="date"
            value={filters.fromDate}
            max={filters.toDate || undefined}
            onChange={(e) => setFilters((f) => ({ ...f, fromDate: e.target.value }))}
            aria-label="Từ ngày"
            className="px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs"
          />
          <span>–</span>
          <input
            id="input-logs-to"
            type="date"
            value={filters.toDate}
            min={filters.fromDate || undefined}
            onChange={(e) => setFilters((f) => ({ ...f, toDate: e.target.value }))}
            aria-label="Đến ngày"
            className="px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs"
          />
          {filtersActive && (
            <button
              type="button"
              onClick={() => {
                setSearchInput("");
                setFilters(EMPTY_LOG_FILTERS);
              }}
              className="ml-1 px-2 py-1 rounded-lg text-[11px] font-semibold text-slate-500 hover:text-slate-800 hover:bg-slate-100"
            >
              Xóa lọc
            </button>
          )}
        </div>

        {/* Filter Pills */}
        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
          {/* Status Filter */}
          <div className="flex bg-slate-100 p-1 rounded-xl text-xs font-medium">
            <button
              onClick={() => setStatusFilter("ALL")}
              className={`px-3 py-1 rounded-lg transition ${
                statusFilter === "ALL" ? "bg-white text-slate-900 shadow-xs" : "text-slate-600"
              }`}
            >
              Tất cả
            </button>
            <button
              onClick={() => setStatusFilter("GRANTED")}
              className={`px-3 py-1 rounded-lg transition ${
                statusFilter === "GRANTED" ? "bg-emerald-600 text-white shadow-xs" : "text-slate-600"
              }`}
            >
              Hợp lệ
            </button>
            <button
              onClick={() => setStatusFilter("DENIED")}
              className={`px-3 py-1 rounded-lg transition ${
                statusFilter === "DENIED" ? "bg-rose-600 text-white shadow-xs" : "text-slate-600"
              }`}
            >
              Từ chối
            </button>
          </div>

          {/* Type Filter */}
          <div className="flex bg-slate-100 p-1 rounded-xl text-xs font-medium">
            <button
              onClick={() => setTypeFilter("ALL")}
              className={`px-2.5 py-1 rounded-lg transition ${
                typeFilter === "ALL" ? "bg-white text-slate-900 shadow-xs" : "text-slate-600"
              }`}
            >
              Vào/Ra
            </button>
            <button
              onClick={() => setTypeFilter("ENTRY")}
              className={`px-2.5 py-1 rounded-lg transition ${
                typeFilter === "ENTRY" ? "bg-indigo-600 text-white shadow-xs" : "text-slate-600"
              }`}
            >
              Vào
            </button>
            <button
              onClick={() => setTypeFilter("EXIT")}
              className={`px-2.5 py-1 rounded-lg transition ${
                typeFilter === "EXIT" ? "bg-indigo-600 text-white shadow-xs" : "text-slate-600"
              }`}
            >
              Ra
            </button>
          </div>

          {/* Stranger Clusters Action Button */}
          {onOpenStrangerClusters && (
            <button
              id="btn-open-strangers-from-logs"
              onClick={() => onOpenStrangerClusters()}
              className="px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 rounded-xl text-xs font-bold flex items-center gap-1.5 transition cursor-pointer shadow-2xs"
            >
              <UserX className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              <span>Cụm Người Lạ ({deniedCount})</span>
            </button>
          )}

          {/* Export CSV */}
          <button
            id="btn-export-csv"
            onClick={() => void handleExport()}
            disabled={total === 0 || exporting}
            title={`Xuất toàn bộ ${statsTotal.toLocaleString("vi-VN")} dòng khớp bộ lọc`}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
          >
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{exporting ? "Đang xuất..." : "Xuất CSV"}</span>
          </button>

          {/* Clear Logs */}
          <button
            id="btn-clear-logs"
            onClick={onClearLogs}
            disabled={total === 0}
            className="p-1.5 text-slate-400 hover:text-rose-600 rounded-xl hover:bg-rose-50 border border-slate-200 transition"
            title="Xóa toàn bộ nhật ký"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">
          {error}
        </p>
      )}

      {/* Access Logs Table */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
                <th className="py-3 px-4">Ảnh Quét</th>
                <th className="py-3 px-4">Thời Gian</th>
                <th className="py-3 px-4">Nhân Viên</th>
                <th className="py-3 px-4">Cổng / Chiều</th>
                <th className="py-3 px-4">Độ Trùng Khớp AI</th>
                <th className="py-3 px-4">Trạng Thái Khóa Cửa</th>
                <th className="py-3 px-4">Phản Hồi Hệ Thống</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    {loading ? (
                      <Loader2 className="w-6 h-6 mx-auto mb-2 animate-spin opacity-60" />
                    ) : (
                      <ClipboardList className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    )}
                    <p>{loading ? "Đang tải nhật ký..." : "Không tìm thấy bản ghi log nào phù hợp"}</p>
                  </td>
                </tr>
              ) : (
                rows.map((log) => {
                  const logDate = new Date(log.timestamp);
                  const formattedDate = logDate.toLocaleDateString("vi-VN");
                  const formattedTime = logDate.toLocaleTimeString("vi-VN", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  });

                  return (
                    <tr
                      key={log.id}
                      className="hover:bg-slate-50/70 transition-colors"
                    >
                      {/* Photo Thumbnail */}
                      <td className="py-3 px-4">
                        <ProtectedImage
                          src={log.photoSnapshot}
                          alt="Face snapshot"
                          className="w-10 h-10 rounded-lg object-cover border border-slate-200 shadow-xs"
                        />
                        {recordingGates[log.type === "EXIT" ? "EXIT" : "ENTRY"] && (
                          <button
                            type="button"
                            data-testid={`btn-recording-${log.id}`}
                            onClick={() =>
                              setRecordingOf({
                                id: log.id,
                                title: `${log.type === "EXIT" ? "Cổng ra" : "Cổng vào"} · ${formattedTime} ${formattedDate}`,
                              })
                            }
                            className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-slate-200 bg-white text-[10px] font-semibold text-slate-600 hover:bg-slate-50 hover:text-indigo-700"
                            title="Xem đoạn ghi của đầu ghi quanh thời điểm này"
                          >
                            <Film className="w-3 h-3" /> Đoạn ghi
                          </button>
                        )}
                      </td>

                      {/* Timestamp */}
                      <td className="py-3 px-4 font-mono text-slate-600">
                        <div className="font-bold text-slate-800">{formattedTime}</div>
                        <div className="text-[11px] text-slate-700">{formattedDate}</div>
                      </td>

                      {/* Employee Info */}
                      <td className="py-3 px-4">
                        {log.employeeName ? (
                          <div>
                            <div className="font-bold text-slate-900">
                              {log.employeeName}
                            </div>
                            <div className="font-mono text-[11px] text-indigo-600 font-semibold">
                              {log.employeeCode}
                            </div>
                            <div className="text-[11px] text-slate-700">
                              {log.department}
                            </div>
                          </div>
                        ) : (
                          <div>
                            <span className="inline-flex items-center gap-1 text-rose-600 font-semibold">
                              <XCircle className="w-3.5 h-3.5" /> Người lạ chưa đăng ký
                            </span>
                            {onOpenStrangerClusters && (
                              <button
                                id={`btn-quick-reg-log-${log.id}`}
                                onClick={() => onOpenStrangerClusters(log.id)}
                                className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gradient-to-r from-amber-500 to-rose-500 hover:from-amber-600 hover:to-rose-600 text-white text-[10px] font-bold shadow-2xs transition cursor-pointer"
                                title="Khai báo nhanh người lạ này thành nhân viên"
                              >
                                <UserPlus className="w-2.5 h-2.5" />
                                <span>Khai Báo NV</span>
                              </button>
                            )}
                          </div>
                        )}
                      </td>

                      {/* Scan Type (Entry vs Exit) */}
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${
                            log.type === "ENTRY"
                              ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                              : "bg-blue-50 text-blue-700 border border-blue-200"
                          }`}
                        >
                          {log.type === "ENTRY" ? (
                            <>
                              <ArrowDownRight className="w-3 h-3 text-emerald-600" />
                              <span>Vào</span>
                            </>
                          ) : (
                            <>
                              <ArrowUpRight className="w-3 h-3 text-blue-600" />
                              <span>Ra</span>
                            </>
                          )}
                        </span>
                      </td>

                      {/* Confidence Score */}
                      <td className="py-3 px-4 font-mono">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-800">
                            {log.confidence}%
                          </span>
                          <div className="w-12 bg-slate-200 h-1.5 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                log.confidence >= 70 ? "bg-emerald-500" : "bg-rose-500"
                              }`}
                              style={{ width: `${Math.min(log.confidence, 100)}%` }}
                            />
                          </div>
                        </div>
                        {log.livenessScore && (
                          <div className="text-[10px] text-slate-700 mt-0.5">
                            Chất lượng ảnh: {log.livenessScore}%
                          </div>
                        )}
                      </td>

                      {/* Lock Status */}
                      <td className="py-3 px-4">
                        {log.status === "GRANTED" ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-300">
                            <Unlock className="w-3 h-3 text-emerald-700" />
                            <span>MỞ TỰ ĐỘNG</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-100 text-rose-800 border border-rose-300">
                            <Lock className="w-3 h-3 text-rose-700" />
                            <span>GIỮ KHÓA</span>
                          </span>
                        )}
                      </td>

                      {/* Action / Reason */}
                      <td className="py-3 px-4 text-slate-600 max-w-xs truncate" title={log.reason}>
                        {log.reason || log.lockAction}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pager */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-slate-100 text-xs text-slate-600">
          <span className="tabular-nums" data-testid="logs-page-range">
            {total === 0
              ? "0 bản ghi"
              : `Hiển thị ${pageStart.toLocaleString("vi-VN")}–${pageEnd.toLocaleString("vi-VN")} / ${total.toLocaleString("vi-VN")}`}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={cursorStack.length === 0 || loading}
              onClick={() => setCursorStack((stack) => stack.slice(0, -1))}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Mới hơn
            </button>
            <button
              type="button"
              disabled={!nextCursor || loading}
              onClick={() => nextCursor && setCursorStack((stack) => [...stack, nextCursor])}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40"
            >
              Cũ hơn <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
      {recordingOf && (
        <RecordingPlayer
          logId={recordingOf.id}
          title={recordingOf.title}
          before={recordingGates.before}
          after={recordingGates.after}
          onClose={() => setRecordingOf(null)}
        />
      )}
    </div>
  );
};
