import React, { useState, useEffect } from "react";
import {
  Send,
  Radio,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  Code2,
  Settings,
  Sparkles,
  ArrowDownRight,
  ArrowUpRight,
  Globe,
  Sliders,
  ShieldCheck,
  Check,
  Copy,
} from "lucide-react";
import { WebhookConfig, WebhookLog, Employee } from "../types";

interface WebhookIntegrationProps {
  employees: Employee[];
}

export const WebhookIntegration: React.FC<WebhookIntegrationProps> = ({
  employees,
}) => {
  const [config, setConfig] = useState<WebhookConfig>({
    enabled: true,
    url: "https://chat-room.eton.vn/hooks/6aa4dfb6928518a18ba27a13/mguNArZoWHY7AegnWFw7d7TwyfnoT4JZWpmwvxtLmfi7iGuY",
    gateInTitle: "[[CỔNG VÀO]]",
    gateOutTitle: "[[CỔNG RA]]",
    includeEmployeeCode: true,
  });

  const [logs, setLogs] = useState<WebhookLog[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [testing, setTesting] = useState<boolean>(false);
  const [clientTesting, setClientTesting] = useState<boolean>(false);
  const [testUser, setTestUser] = useState<string>(
    employees[0]?.name || "Nguyễn Hoàng Minh"
  );
  const [testCode, setTestCode] = useState<string>(
    employees[0]?.employeeCode || "NV-1082"
  );
  const [testScanType, setTestScanType] = useState<"ENTRY" | "EXIT">("ENTRY");
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [copiedPayload, setCopiedPayload] = useState<boolean>(false);
  const [clientTestResult, setClientTestResult] = useState<{
    status: string;
    msg: string;
  } | null>(null);

  // Fetch initial config & logs
  const fetchConfigAndLogs = async () => {
    setLoading(true);
    try {
      const [resConf, resLogs] = await Promise.all([
        fetch("/api/webhook/config"),
        fetch("/api/webhook/logs"),
      ]);

      if (resConf.ok) {
        const confData = await resConf.json();
        setConfig(confData);
      }
      if (resLogs.ok) {
        const logsData = await resLogs.json();
        setLogs(logsData);
      }
    } catch (err) {
      console.error("Lỗi tải cấu hình webhook:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConfigAndLogs();
  }, []);

  // Handle saving config
  const handleSaveConfig = async () => {
    try {
      const res = await fetch("/api/webhook/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2500);
      }
    } catch (err) {
      console.error("Lỗi lưu webhook config:", err);
    }
  };

  // Test Webhook from Server
  const handleTestServer = async (type: "ENTRY" | "EXIT") => {
    setTesting(true);
    try {
      const res = await fetch("/api/webhook/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          testScanType: type,
          customUser: testUser,
          customCode: testCode,
        }),
      });
      const data = await res.json();
      if (data.log) {
        setLogs((prev) => [data.log, ...prev.filter((l) => l.id !== data.log.id)]);
      }
    } catch (err) {
      console.error("Lỗi test webhook từ server:", err);
    } finally {
      setTesting(false);
    }
  };

  // Test Webhook directly from Client Browser (Bypass Cloud proxy in case user is on Eton VPN / Intranet)
  const handleTestClientDirect = async (type: "ENTRY" | "EXIT") => {
    setClientTesting(true);
    setClientTestResult(null);

    const now = new Date();
    const formattedTime = now.toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const userText =
      config.includeEmployeeCode && testCode
        ? `${testUser} (${testCode}) - ${formattedTime}`
        : `${testUser} - ${formattedTime}`;

    const gateTitle =
      type === "ENTRY" ? config.gateInTitle : config.gateOutTitle;

    const payload = {
      text: userText,
      attachments: [
        {
          title: gateTitle,
        },
      ],
    };

    try {
      const res = await fetch(config.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        mode: "cors",
      });

      setClientTestResult({
        status: res.ok ? "SUCCESS" : "ERROR",
        msg: `Trình duyệt gửi trực tiếp: HTTP ${res.status} ${res.statusText}`,
      });
    } catch (err: any) {
      setClientTestResult({
        status: "BLOCKED",
        msg: `Trình duyệt: ${err?.message || "Không thể kết nối trực tiếp (CORS hoặc IP ngoài Intranet)"}`,
      });
    } finally {
      setClientTesting(false);
    }
  };

  // Generate real-time live preview payload
  const currentPreviewPayload = {
    text: config.includeEmployeeCode && testCode
      ? `${testUser} (${testCode}) - ${new Date().toLocaleString("vi-VN", { hour12: false })}`
      : `${testUser} - ${new Date().toLocaleString("vi-VN", { hour12: false })}`,
    attachments: [
      {
        title: testScanType === "ENTRY" ? config.gateInTitle : config.gateOutTitle,
      },
    ],
  };

  const copyPayloadJson = () => {
    navigator.clipboard.writeText(JSON.stringify(currentPreviewPayload, null, 2));
    setCopiedPayload(true);
    setTimeout(() => setCopiedPayload(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Top Banner Header */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 rounded-2xl border border-indigo-900/50 p-6 text-white shadow-xl relative overflow-hidden">
        <div className="absolute right-0 top-0 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="p-2 rounded-xl bg-indigo-600/80 text-white shadow-md">
                <Send className="w-5 h-5" />
              </span>
              <h2 className="text-xl font-bold tracking-tight text-white">
                Tích Hợp Webhook Điểm Danh Vào / Ra (Eton Chat Room)
              </h2>
              <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-semibold flex items-center gap-1">
                <Radio className="w-3 h-3 text-emerald-400 animate-pulse" />
                Đang Kích Hoạt Tự Động
              </span>
            </div>
            <p className="text-slate-300 text-xs sm:text-sm max-w-2xl leading-relaxed">
              Mỗi khi nhân viên được quét khuôn mặt Vào (Check-in) hoặc Ra (Check-out),
              hệ thống tự động phát webhook POST đến API Chat Room của Eton với định
              dạng JSON chính xác theo yêu cầu.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              id="btn-refresh-webhook-logs"
              onClick={fetchConfigAndLogs}
              disabled={loading}
              className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-medium border border-white/10 flex items-center gap-2 transition cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              Làm mới
            </button>
          </div>
        </div>

        {/* API Endpoint bar */}
        <div className="mt-4 p-3 bg-black/40 rounded-xl border border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-2 font-mono text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <span className="px-2 py-0.5 bg-indigo-600 text-white font-bold rounded text-[10px]">
              POST
            </span>
            <span className="text-slate-300 truncate">{config.url}</span>
          </div>
          <span className="text-indigo-300 text-[11px] shrink-0">
            Payload: JSON • Auto on Scan IN/OUT
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Quick Test & Payload Preview */}
        <div className="lg:col-span-7 space-y-6">
          {/* Quick Test Card */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-4">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-indigo-600" />
                <h3 className="text-sm font-bold text-slate-900">
                  Thử Nghiệm Gửi Webhook Ngay (Test Console)
                </h3>
              </div>
              <span className="text-xs text-slate-500">
                Mô phỏng sự kiện Vào hoặc Ra
              </span>
            </div>

            {/* Test Controls Form */}
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Chọn Nhân Viên Thử Nghiệm:
                  </label>
                  <select
                    id="select-test-employee"
                    value={testUser}
                    onChange={(e) => {
                      setTestUser(e.target.value);
                      const matched = employees.find((emp) => emp.name === e.target.value);
                      if (matched) setTestCode(matched.employeeCode);
                    }}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-slate-50 font-medium text-slate-800 focus:bg-white focus:border-indigo-500 focus:outline-hidden"
                  >
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.name}>
                        {emp.name} ({emp.employeeCode})
                      </option>
                    ))}
                    <option value="Nguyễn Văn A">Nguyễn Văn A (Nhân viên mới)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Loại Sự Kiện:
                  </label>
                  <div className="flex items-center bg-slate-100 p-1 rounded-xl">
                    <button
                      id="btn-test-select-entry"
                      type="button"
                      onClick={() => setTestScanType("ENTRY")}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer ${
                        testScanType === "ENTRY"
                          ? "bg-emerald-600 text-white shadow-xs"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      <ArrowDownRight className="w-3.5 h-3.5" /> Vào (Check-in)
                    </button>
                    <button
                      id="btn-test-select-exit"
                      type="button"
                      onClick={() => setTestScanType("EXIT")}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer ${
                        testScanType === "EXIT"
                          ? "bg-blue-600 text-white shadow-xs"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      <ArrowUpRight className="w-3.5 h-3.5" /> Ra (Check-out)
                    </button>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <button
                  id="btn-trigger-test-webhook"
                  onClick={() => handleTestServer(testScanType)}
                  disabled={testing}
                  className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold shadow-md shadow-indigo-200 flex items-center gap-2 transition cursor-pointer"
                >
                  <Send className={`w-3.5 h-3.5 ${testing ? "animate-spin" : ""}`} />
                  {testing ? "Đang Gửi..." : `Bấm Gửi Webhook (${testScanType === "ENTRY" ? "VÀO" : "RA"})`}
                </button>

                <button
                  id="btn-trigger-client-webhook"
                  onClick={() => handleTestClientDirect(testScanType)}
                  disabled={clientTesting}
                  className="px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-900 disabled:opacity-50 text-white text-xs font-medium border border-slate-700 flex items-center gap-2 transition cursor-pointer"
                  title="Gửi trực tiếp từ trình duyệt của bạn (hữu ích khi máy tính đang bật VPN hoặc ở trong mạng nội bộ Eton)"
                >
                  <Globe className={`w-3.5 h-3.5 text-cyan-400 ${clientTesting ? "animate-spin" : ""}`} />
                  <span>Gửi Trực Tiếp Từ Trình Duyệt</span>
                </button>
              </div>

              {clientTestResult && (
                <div
                  className={`p-3 rounded-xl border text-xs flex items-center gap-2 ${
                    clientTestResult.status === "SUCCESS"
                      ? "bg-emerald-50 border-emerald-200 text-emerald-900"
                      : "bg-amber-50 border-amber-200 text-amber-900"
                  }`}
                >
                  {clientTestResult.status === "SUCCESS" ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  )}
                  <span>{clientTestResult.msg}</span>
                </div>
              )}
            </div>

            {/* Live Payload Preview */}
            <div className="mt-5 pt-4 border-t border-slate-100">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <Code2 className="w-3.5 h-3.5 text-indigo-600" />
                  Mẫu Dữ Liệu JSON Chuẩn (Live Payload Schema):
                </span>
                <button
                  onClick={copyPayloadJson}
                  className="text-xs text-indigo-600 hover:text-indigo-800 flex items-center gap-1 font-medium cursor-pointer"
                >
                  {copiedPayload ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-600" />
                      <span className="text-emerald-600">Đã chép</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>Sao chép JSON</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="p-3.5 bg-slate-900 text-emerald-400 rounded-xl font-mono text-xs overflow-x-auto border border-slate-800">
                {JSON.stringify(currentPreviewPayload, null, 2)}
              </pre>
            </div>
          </div>

          {/* Intranet & Production Note */}
          <div className="bg-amber-50/80 border border-amber-200 rounded-2xl p-4 text-xs text-amber-900 space-y-2">
            <div className="flex items-center gap-2 font-bold text-amber-950">
              <ShieldCheck className="w-4 h-4 text-amber-600" />
              <span>Ghi Chú Về Tường Lửa &amp; Mạng Nội Bộ Eton:</span>
            </div>
            <p className="leading-relaxed">
              Máy chủ <code className="font-mono bg-amber-100 px-1 py-0.5 rounded">chat-room.eton.vn</code> được cấu hình Nginx bảo vệ chỉ cho phép các IP nội bộ / VPN hoặc trong nước. Khi gửi từ môi trường Cloud Sandbox nước ngoài, mã lỗi trả về là <strong className="font-mono text-amber-800">403 Forbidden</strong> là hoàn toàn bình thường.
            </p>
            <p className="leading-relaxed">
              👉 Khi ứng dụng được triển khai trên máy tính tại văn phòng / nhà kho Eton hoặc qua VPN công ty, Webhook sẽ kết nối và gửi thông báo thành công 100%!
            </p>
          </div>
        </div>

        {/* Right Column: Configuration & Formatting Presets */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-4">
              <div className="flex items-center gap-2">
                <Settings className="w-4 h-4 text-indigo-600" />
                <h3 className="text-sm font-bold text-slate-900">
                  Cấu Hình Tiêu Đề [[GATE]] &amp; URL
                </h3>
              </div>
              {saveSuccess && (
                <span className="text-xs text-emerald-600 font-bold flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" /> Đã lưu
                </span>
              )}
            </div>

            <div className="space-y-4 text-xs">
              {/* Webhook Enable Toggle */}
              <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-200">
                <div>
                  <p className="font-bold text-slate-800">Tự động phát Webhook</p>
                  <p className="text-[11px] text-slate-500">
                    Bật để gửi tự động mỗi khi có người điểm danh
                  </p>
                </div>
                <input
                  type="checkbox"
                  id="chk-webhook-enabled"
                  checked={config.enabled}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, enabled: e.target.checked }))
                  }
                  className="w-5 h-5 text-indigo-600 rounded cursor-pointer"
                />
              </div>

              {/* Webhook URL Field */}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Webhook URL (API chat-room.eton.vn):
                </label>
                <input
                  type="text"
                  id="input-webhook-url"
                  value={config.url}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, url: e.target.value }))
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 font-mono text-[11px] bg-slate-50 text-slate-800 focus:bg-white focus:border-indigo-500 focus:outline-hidden"
                />
              </div>

              {/* Quick Preset Buttons for [[GATE]] */}
              <div>
                <label className="block font-semibold text-slate-700 mb-1.5 flex items-center gap-1">
                  <Sliders className="w-3.5 h-3.5 text-indigo-600" />
                  Mẫu Tiêu Đề [[GATE]] Nhanh:
                </label>
                <div className="grid grid-cols-3 gap-1.5 mb-2">
                  <button
                    type="button"
                    onClick={() =>
                      setConfig((prev) => ({
                        ...prev,
                        gateInTitle: "[[CỔNG VÀO]]",
                        gateOutTitle: "[[CỔNG RA]]",
                      }))
                    }
                    className={`p-2 rounded-lg border text-center transition cursor-pointer ${
                      config.gateInTitle === "[[CỔNG VÀO]]"
                        ? "bg-indigo-50 border-indigo-400 text-indigo-900 font-bold"
                        : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    <span className="block font-mono text-[11px]">[[CỔNG VÀO]]</span>
                    <span className="text-[10px] text-slate-500">Tiếng Việt</span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setConfig((prev) => ({
                        ...prev,
                        gateInTitle: "[[GATE IN]]",
                        gateOutTitle: "[[GATE OUT]]",
                      }))
                    }
                    className={`p-2 rounded-lg border text-center transition cursor-pointer ${
                      config.gateInTitle === "[[GATE IN]]"
                        ? "bg-indigo-50 border-indigo-400 text-indigo-900 font-bold"
                        : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    <span className="block font-mono text-[11px]">[[GATE IN]]</span>
                    <span className="text-[10px] text-slate-500">English</span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setConfig((prev) => ({
                        ...prev,
                        gateInTitle: "[[GATE]]",
                        gateOutTitle: "[[GATE]]",
                      }))
                    }
                    className={`p-2 rounded-lg border text-center transition cursor-pointer ${
                      config.gateInTitle === "[[GATE]]"
                        ? "bg-indigo-50 border-indigo-400 text-indigo-900 font-bold"
                        : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    <span className="block font-mono text-[11px]">[[GATE]]</span>
                    <span className="text-[10px] text-slate-500">Nguyên mẫu</span>
                  </button>
                </div>
              </div>

              {/* Custom Gate In Title */}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Tiêu đề cho Cổng Vào (IN):
                </label>
                <input
                  type="text"
                  id="input-gate-in-title"
                  value={config.gateInTitle}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, gateInTitle: e.target.value }))
                  }
                  placeholder="[[CỔNG VÀO]]"
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 font-mono text-xs bg-slate-50 text-slate-800 focus:bg-white focus:border-indigo-500 focus:outline-hidden"
                />
              </div>

              {/* Custom Gate Out Title */}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Tiêu đề cho Cổng Ra (OUT):
                </label>
                <input
                  type="text"
                  id="input-gate-out-title"
                  value={config.gateOutTitle}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, gateOutTitle: e.target.value }))
                  }
                  placeholder="[[CỔNG RA]]"
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 font-mono text-xs bg-slate-50 text-slate-800 focus:bg-white focus:border-indigo-500 focus:outline-hidden"
                />
              </div>

              {/* Include Employee Code Toggle */}
              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="chk-include-code"
                  checked={config.includeEmployeeCode}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      includeEmployeeCode: e.target.checked,
                    }))
                  }
                  className="w-4 h-4 text-indigo-600 rounded cursor-pointer"
                />
                <label
                  htmlFor="chk-include-code"
                  className="text-xs text-slate-700 cursor-pointer"
                >
                  Kèm mã số nhân viên vào USER (ví dụ: <code className="font-mono text-indigo-700">Nguyễn Hoàng Minh (NV-1082)</code>)
                </label>
              </div>

              {/* Save Config Button */}
              <div className="pt-2">
                <button
                  id="btn-save-webhook-config"
                  onClick={handleSaveConfig}
                  className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold shadow-xs transition flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Check className="w-4 h-4" />
                  Lưu Cấu Hình Webhook
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Section: Webhook Execution Logs History */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-3 mb-4">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-indigo-600" />
            <h3 className="text-sm font-bold text-slate-900">
              Nhật Ký Gửi Webhook Gần Nhất ({logs.length} sự kiện)
            </h3>
          </div>
          <span className="text-xs text-slate-500">
            Tự động cập nhật theo thời gian thực mỗi khi có lượt quét
          </span>
        </div>

        {logs.length === 0 ? (
          <div className="text-center py-10 text-slate-400">
            <Send className="w-10 h-10 mx-auto mb-2 opacity-30 animate-pulse" />
            <p className="text-xs">Chưa có lịch sử gửi webhook.</p>
            <p className="text-[11px] text-slate-400 mt-1">
              Bấm nút &quot;Bấm Gửi Webhook&quot; ở trên hoặc thực hiện quét khuôn mặt để tạo bản ghi.
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {logs.map((log) => {
              const isEntry = log.scanType === "ENTRY";
              const isOk = log.success || log.statusCode === 200;

              return (
                <div
                  key={log.id}
                  className={`p-3 rounded-xl border text-xs transition-all ${
                    isOk
                      ? "bg-emerald-50/50 border-emerald-200"
                      : "bg-slate-50 border-slate-200"
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                          isEntry
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-blue-100 text-blue-800"
                        }`}
                      >
                        {isEntry ? "VÀO (IN)" : "RA (OUT)"}
                      </span>
                      <span className="font-bold text-slate-900">
                        {log.userName}
                      </span>
                      <span className="text-[11px] font-mono text-slate-500">
                        {new Date(log.timestamp).toLocaleTimeString("vi-VN")}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold flex items-center gap-1 ${
                          isOk
                            ? "bg-emerald-100 text-emerald-800 border border-emerald-300"
                            : "bg-amber-100 text-amber-800 border border-amber-300"
                        }`}
                      >
                        {isOk ? (
                          <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                        ) : (
                          <AlertTriangle className="w-3 h-3 text-amber-600" />
                        )}
                        HTTP {log.statusCode || "Gửi"} {log.statusText || ""}
                      </span>
                    </div>
                  </div>

                  {/* Transmitted Payload Snippet */}
                  <div className="bg-slate-900 rounded-lg p-2.5 text-[11px] font-mono text-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="truncate">
                      <span className="text-slate-400">text:</span> &quot;
                      <span className="text-emerald-300">{log.payload.text}</span>&quot;
                      &nbsp;|&nbsp;
                      <span className="text-slate-400">title:</span> &quot;
                      <span className="text-indigo-300">
                        {log.payload.attachments?.[0]?.title}
                      </span>
                      &quot;
                    </div>

                    {log.error && (
                      <span className="text-rose-400 text-[10px] truncate max-w-xs">
                        {log.error}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
