import React, { useEffect, useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Cell,
} from "recharts";
import {
  Clock,
  TrendingUp,
  ShieldCheck,
  AlertTriangle,
  Users,
  Calendar,
  Filter,
  BarChart3,
  Layers,
} from "lucide-react";
import { AccessLogFilters, AccessLogStats, fetchLogStats } from "../utils/accessLogs";

interface EntryPatternAnalyticsProps {
  /** The same filters as the history table; the chart's own range narrows them further. */
  filters: AccessLogFilters;
  /** Bumped when new entries arrive, to refetch. */
  refreshKey?: number;
}

type TimeRangeFilter = "ALL" | "TODAY" | "7DAYS";
type ViewWindow = "24HOURS" | "BUSINESS_HOURS"; // 0-23 or 06-20
type DisplayMode = "ENTRY_STATUS" | "ENTRY_VS_EXIT";

interface HourlyDataPoint {
  hour: number;
  hourLabel: string;
  displayHour: string;
  grantedEntries: number;
  deniedEntries: number;
  totalEntries: number;
  exits: number;
  totalScans: number;
}

export const EntryPatternAnalytics: React.FC<EntryPatternAnalyticsProps> = ({ filters, refreshKey }) => {
  const [timeRange, setTimeRange] = useState<TimeRangeFilter>("ALL");
  const [viewWindow, setViewWindow] = useState<ViewWindow>("BUSINESS_HOURS");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("ENTRY_STATUS");
  const [selectedHour, setSelectedHour] = useState<number | null>(null);

  // Counted by the server over the whole history (hour of day in the site's
  // time zone), for the table's filters narrowed to this chart's range.
  const [serverStats, setServerStats] = useState<AccessLogStats | null>(null);
  useEffect(() => {
    let active = true;
    let extraFrom: string | undefined;
    if (timeRange === "TODAY") {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      extraFrom = midnight.toISOString();
    } else if (timeRange === "7DAYS") {
      extraFrom = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    }
    fetchLogStats(filters, extraFrom)
      .then((s) => active && setServerStats(s))
      .catch(() => active && setServerStats(null));
    return () => {
      active = false;
    };
  }, [filters, refreshKey, timeRange]);

  const allHours: HourlyDataPoint[] = useMemo(
    () =>
      Array.from({ length: 24 }, (_, h) => {
        const b = serverStats?.byHour?.[h];
        return {
          hour: h,
          hourLabel: `${h.toString().padStart(2, "0")}:00`,
          displayHour: `${h}h`,
          grantedEntries: b?.grantedEntries ?? 0,
          deniedEntries: b?.deniedEntries ?? 0,
          totalEntries: b?.totalEntries ?? 0,
          exits: b?.exits ?? 0,
          totalScans: b?.totalScans ?? 0,
        };
      }),
    [serverStats]
  );

  const hourlyData = useMemo(
    () => (viewWindow === "BUSINESS_HOURS" ? allHours.filter((item) => item.hour >= 6 && item.hour <= 20) : allHours),
    [allHours, viewWindow]
  );

  // Summary Metrics calculations
  const stats = useMemo(() => {
    const sum = (key: keyof HourlyDataPoint) => allHours.reduce((n, d) => n + (d[key] as number), 0);
    const totalEntries = serverStats?.entries ?? 0;
    const grantedEntries = sum("grantedEntries");
    const deniedEntries = sum("deniedEntries");
    const totalExits = serverStats?.exits ?? 0;

    // Find peak entry hour
    let peakHour = 8;
    let maxEntries = 0;
    hourlyData.forEach((d) => {
      if (d.totalEntries > maxEntries) {
        maxEntries = d.totalEntries;
        peakHour = d.hour;
      }
    });

    const peakHourFormatted = `${peakHour.toString().padStart(2, "0")}:00 - ${(peakHour + 1)
      .toString()
      .padStart(2, "0")}:00`;

    // Morning rush (07:00 - 09:59)
    const morningRushCount = allHours.filter((d) => d.hour >= 7 && d.hour <= 9).reduce((n, d) => n + d.totalEntries, 0);

    const morningRushPct = totalEntries > 0 ? Math.round((morningRushCount / totalEntries) * 100) : 0;
    const successRate = totalEntries > 0 ? Math.round((grantedEntries / totalEntries) * 100) : 100;

    return {
      totalEntries,
      grantedEntries,
      deniedEntries,
      totalExits,
      peakHour,
      peakHourFormatted,
      maxEntries,
      morningRushCount,
      morningRushPct,
      successRate,
    };
  }, [serverStats, allHours, hourlyData]);

  // Department distribution during entries
  const departmentBreakdown = serverStats?.grantedEntriesByDepartment ?? [];

  // Custom Chart Tooltip
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const data: HourlyDataPoint = payload[0].payload;
      return (
        <div className="bg-slate-900 text-white rounded-xl p-3 shadow-xl border border-slate-700 text-xs min-w-[190px]">
          <div className="flex items-center gap-2 mb-2 pb-1.5 border-b border-slate-800 font-semibold">
            <Clock className="w-3.5 h-3.5 text-indigo-400" />
            <span>Khung giờ: {data.hourLabel} - {(data.hour + 1).toString().padStart(2, "0")}:00</span>
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between items-center text-emerald-400">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
                Vào hợp lệ:
              </span>
              <span className="font-mono font-bold text-sm">{data.grantedEntries} lượt</span>
            </div>

            {data.deniedEntries > 0 && (
              <div className="flex justify-between items-center text-rose-400">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-rose-400 inline-block" />
                  Vào bị từ chối:
                </span>
                <span className="font-mono font-bold">{data.deniedEntries} lần</span>
              </div>
            )}

            {displayMode === "ENTRY_VS_EXIT" && (
              <div className="flex justify-between items-center text-sky-400">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-sky-400 inline-block" />
                  Lượt ra về:
                </span>
                <span className="font-mono font-bold">{data.exits} lượt</span>
              </div>
            )}

            <div className="pt-1.5 border-t border-slate-800 flex justify-between text-slate-300 font-medium">
              <span>Tổng lượt vào:</span>
              <span className="font-mono font-bold text-white">{data.totalEntries}</span>
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs space-y-5" id="entry-pattern-analytics-section">
      {/* Header & Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-100">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
              <BarChart3 className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">
                Phân Tích Quy Luật Điểm Danh & Giờ Cao Điểm
              </h3>
              <p className="text-xs text-slate-500">
                Mô hình tần suất nhân viên vào/ra qua cửa kiểm soát khuôn mặt theo từng khung giờ
              </p>
            </div>
          </div>
        </div>

        {/* Filter Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Range Selector */}
          <div className="flex bg-slate-100 p-1 rounded-xl text-xs font-medium">
            <button
              id="btn-range-all"
              onClick={() => setTimeRange("ALL")}
              className={`px-2.5 py-1 rounded-lg transition ${
                timeRange === "ALL" ? "bg-white text-slate-900 shadow-xs" : "text-slate-600"
              }`}
            >
              Tất cả
            </button>
            <button
              id="btn-range-today"
              onClick={() => setTimeRange("TODAY")}
              className={`px-2.5 py-1 rounded-lg transition ${
                timeRange === "TODAY" ? "bg-indigo-600 text-white shadow-xs" : "text-slate-600"
              }`}
            >
              Hôm nay
            </button>
            <button
              id="btn-range-7days"
              onClick={() => setTimeRange("7DAYS")}
              className={`px-2.5 py-1 rounded-lg transition ${
                timeRange === "7DAYS" ? "bg-indigo-600 text-white shadow-xs" : "text-slate-600"
              }`}
            >
              7 ngày qua
            </button>
          </div>

          {/* Window Range: 24h vs Business Hours */}
          <div className="flex bg-slate-100 p-1 rounded-xl text-xs font-medium">
            <button
              id="btn-window-business"
              onClick={() => setViewWindow("BUSINESS_HOURS")}
              className={`px-2.5 py-1 rounded-lg transition ${
                viewWindow === "BUSINESS_HOURS" ? "bg-white text-slate-900 shadow-xs" : "text-slate-600"
              }`}
              title="Khung giờ hành chính từ 06:00 đến 20:00"
            >
              06h - 20h
            </button>
            <button
              id="btn-window-24h"
              onClick={() => setViewWindow("24HOURS")}
              className={`px-2.5 py-1 rounded-lg transition ${
                viewWindow === "24HOURS" ? "bg-white text-slate-900 shadow-xs" : "text-slate-600"
              }`}
              title="Hiển thị đủ 24 giờ trong ngày"
            >
              24 Giờ
            </button>
          </div>

          {/* Metric Toggle */}
          <div className="flex bg-slate-100 p-1 rounded-xl text-xs font-medium">
            <button
              id="btn-display-status"
              onClick={() => setDisplayMode("ENTRY_STATUS")}
              className={`px-2.5 py-1 rounded-lg transition ${
                displayMode === "ENTRY_STATUS" ? "bg-indigo-600 text-white shadow-xs" : "text-slate-600"
              }`}
            >
              Vào Hợp Lệ / Từ Chối
            </button>
            <button
              id="btn-display-comparison"
              onClick={() => setDisplayMode("ENTRY_VS_EXIT")}
              className={`px-2.5 py-1 rounded-lg transition ${
                displayMode === "ENTRY_VS_EXIT" ? "bg-indigo-600 text-white shadow-xs" : "text-slate-600"
              }`}
            >
              Vào vs Ra
            </button>
          </div>
        </div>
      </div>

      {/* KPI Insight Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {/* Peak Hour */}
        <div id="card-stat-peak-hour" className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-xs font-medium">Khung Giờ Cao Điểm Vào</span>
            <Clock className="w-4 h-4 text-indigo-500" />
          </div>
          <div className="text-lg font-bold text-indigo-950 font-mono">
            {stats.peakHourFormatted}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 flex items-center gap-1">
            <span className="font-semibold text-indigo-600">{stats.maxEntries} lượt vào</span>
            <span>(đỉnh điểm trong ngày)</span>
          </div>
        </div>

        {/* Morning Rush Percentage */}
        <div id="card-stat-morning-rush" className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-xs font-medium">Lưu Lượng Đầu Ca Sáng</span>
            <TrendingUp className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="text-lg font-bold text-emerald-700 font-mono">
            {stats.morningRushPct}%
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {stats.morningRushCount} lượt check-in từ 07:00 - 09:59
          </div>
        </div>

        {/* Authorized Entry Rate */}
        <div id="card-stat-auth-rate" className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-xs font-medium">Tỷ Lệ Xác Thực Mở Cửa</span>
            <ShieldCheck className="w-4 h-4 text-blue-500" />
          </div>
          <div className="text-lg font-bold text-blue-700 font-mono">
            {stats.successRate}%
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {stats.grantedEntries}/{stats.totalEntries} lượt vào hợp lệ
          </div>
        </div>

        {/* Denied Entry Alerts */}
        <div id="card-stat-denied-alerts" className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-xs font-medium">Lượt Từ Chối Cửa Giữ Khóa</span>
            <AlertTriangle className="w-4 h-4 text-rose-500" />
          </div>
          <div className="text-lg font-bold text-rose-600 font-mono">
            {stats.deniedEntries} lần
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {stats.deniedEntries > 0 ? "Phát hiện khuôn mặt lạ / không khớp" : "Không có cảnh báo vi phạm"}
          </div>
        </div>
      </div>

      {/* Main Bar Chart Section */}
      <div id="section-hourly-entry-chart" className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-700">
            Số Lượt Quét Theo Khung Giờ (Entries / Hour)
          </span>
          <span className="text-[11px] text-slate-400">
            Di chuột vào từng cột để xem chi tiết
          </span>
        </div>

        <div id="container-hourly-bar-chart" className="h-[280px] w-full pt-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={hourlyData}
              margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              onMouseMove={(state: any) => {
                if (state && state.activePayload && state.activePayload.length) {
                  setSelectedHour(state.activePayload[0].payload.hour);
                }
              }}
              onMouseLeave={() => setSelectedHour(null)}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis
                dataKey="displayHour"
                stroke="#64748b"
                fontSize={11}
                tickLine={false}
                axisLine={{ stroke: "#e2e8f0" }}
              />
              <YAxis
                stroke="#64748b"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                wrapperStyle={{ paddingTop: "12px", fontSize: "11px" }}
                iconType="circle"
                iconSize={8}
              />

              {displayMode === "ENTRY_STATUS" ? (
                <>
                  <Bar
                    name="Vào Hợp Lệ (Authorized)"
                    dataKey="grantedEntries"
                    fill="#4f46e5"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={36}
                  >
                    {hourlyData.map((entry) => (
                      <Cell
                        key={`cell-granted-${entry.hour}`}
                        fill={
                          entry.hour === stats.peakHour && entry.totalEntries > 0
                            ? "#4338ca"
                            : selectedHour === entry.hour
                            ? "#6366f1"
                            : "#4f46e5"
                        }
                      />
                    ))}
                  </Bar>
                  <Bar
                    name="Vào Bị Từ Chối (Denied)"
                    dataKey="deniedEntries"
                    fill="#f43f5e"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={36}
                  />
                </>
              ) : (
                <>
                  <Bar
                    name="Lượt Vào (Entry)"
                    dataKey="totalEntries"
                    fill="#4f46e5"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={36}
                  />
                  <Bar
                    name="Lượt Ra (Exit)"
                    dataKey="exits"
                    fill="#0ea5e9"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={36}
                  />
                </>
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Department Distribution & Entry Pattern Context Footer */}
      {departmentBreakdown.length > 0 && (
        <div className="pt-3 border-t border-slate-100 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-slate-500">
            <Users className="w-3.5 h-3.5 text-indigo-500" />
            <span className="font-medium text-slate-700">Phân bổ phòng ban vào ca:</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {departmentBreakdown.slice(0, 4).map((dept) => (
                <span
                  key={dept.name}
                  className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md font-mono text-[11px]"
                >
                  {dept.name}: <strong className="text-slate-900">{dept.count}</strong>
                </span>
              ))}
            </div>
          </div>

          <div className="text-[11px] text-slate-600 flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
            Cập nhật tự động theo thời gian thực mỗi khi có lượt quét mới
          </div>
        </div>
      )}
    </div>
  );
};
