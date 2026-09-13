import React, { useState } from "react";
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
} from "lucide-react";
import { AccessLog } from "../types";
import { EntryPatternAnalytics } from "./EntryPatternAnalytics";

interface AccessLogsProps {
  logs: AccessLog[];
  onClearLogs: () => void;
}

export const AccessLogs: React.FC<AccessLogsProps> = ({
  logs,
  onClearLogs,
}) => {
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "GRANTED" | "DENIED">("ALL");
  const [typeFilter, setTypeFilter] = useState<"ALL" | "ENTRY" | "EXIT">("ALL");
  const [showAnalytics, setShowAnalytics] = useState<boolean>(true);

  const filteredLogs = logs.filter((log) => {
    // Search filter
    const term = searchTerm.toLowerCase();
    const matchName = log.employeeName?.toLowerCase().includes(term);
    const matchCode = log.employeeCode?.toLowerCase().includes(term);
    const matchDept = log.department?.toLowerCase().includes(term);
    const matchReason = log.reason?.toLowerCase().includes(term);
    const matchesSearch = !term || matchName || matchCode || matchDept || matchReason;

    // Status filter
    const matchesStatus =
      statusFilter === "ALL" || log.status === statusFilter;

    // Type filter
    const matchesType = typeFilter === "ALL" || log.type === typeFilter;

    return matchesSearch && matchesStatus && matchesType;
  });

  const grantedCount = logs.filter((l) => l.status === "GRANTED").length;
  const deniedCount = logs.filter((l) => l.status === "DENIED").length;

  const exportCSV = () => {
    const headers = ["ID", "Thời Gian", "Loại", "Trạng Thái", "Mã NV", "Họ Tên", "Phòng Ban", "Độ Trùng Khớp (%)", "Hành Động Khóa"];
    const rows = filteredLogs.map((l) => [
      l.id,
      new Date(l.timestamp).toLocaleString("vi-VN"),
      l.type === "ENTRY" ? "Vào" : "Ra",
      l.status === "GRANTED" ? "Thành Công" : "Từ Chối",
      l.employeeCode || "N/A",
      l.employeeName || "Không xác định",
      l.department || "N/A",
      l.confidence + "%",
      l.lockAction,
    ]);

    const csvContent =
      "data:text/csv;charset=utf-8,\uFEFF" +
      [headers.join(","), ...rows.map((e) => e.map((val) => `"${val}"`).join(","))].join("\n");

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `nhat_ky_vao_ra_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
            <span className="text-2xl font-bold font-mono text-slate-900">
              {logs.length}
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
              {logs.length > 0
                ? Math.round((grantedCount / logs.length) * 100)
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
          <span className="text-xs text-slate-500 font-mono">({logs.length} bản ghi)</span>
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
        <EntryPatternAnalytics logs={logs} />
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
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-hidden focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition"
          />
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

          {/* Export CSV */}
          <button
            id="btn-export-csv"
            onClick={exportCSV}
            disabled={filteredLogs.length === 0}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Xuất CSV</span>
          </button>

          {/* Clear Logs */}
          <button
            id="btn-clear-logs"
            onClick={onClearLogs}
            disabled={logs.length === 0}
            className="p-1.5 text-slate-400 hover:text-rose-600 rounded-xl hover:bg-rose-50 border border-slate-200 transition"
            title="Xóa toàn bộ nhật ký"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

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
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    <ClipboardList className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p>Không tìm thấy bản ghi log nào phù hợp</p>
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log) => {
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
                        <img
                          src={log.photoSnapshot}
                          alt="Face snapshot"
                          className="w-10 h-10 rounded-lg object-cover border border-slate-200 shadow-xs"
                        />
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
                          <span className="inline-flex items-center gap-1 text-rose-600 font-semibold">
                            <XCircle className="w-3.5 h-3.5" /> Không xác định
                          </span>
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
                            Sống thật: {log.livenessScore}%
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
      </div>
    </div>
  );
};
