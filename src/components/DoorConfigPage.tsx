import React, { useState, useEffect, useCallback } from "react";
import {
  KeyRound,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Sliders,
  ShieldCheck,
  Check,
  Copy,
  Terminal,
  Trash2,
  RotateCcw,
  Eye,
  EyeOff,
  Send,
  Zap,
  Cpu,
  Lock,
  Unlock,
  Radio,
  ExternalLink,
  Code2,
} from "lucide-react";
import { DoorControllerConfig, DoorApiLog, DoorAuthHeaderType, SmartLockState } from "../types";
import { safeJsonFetch } from "../utils/api";
import { soundEffects } from "../utils/audio";
import {
  getStoredDoorConfig,
  saveStoredDoorConfig,
  getStoredDoorLogs,
  saveStoredDoorLogs,
  clearStoredDoorLogs,
  dispatchDirectDoorControllerCommand,
  clientEventBus,
  DEFAULT_OFFLINE_DOOR_CONFIG,
} from "../utils/offlineEngine";

interface DoorConfigPageProps {
  lockState: SmartLockState;
  onRefreshLockState?: () => void;
}

export const DoorConfigPage: React.FC<DoorConfigPageProps> = ({
  lockState,
  onRefreshLockState,
}) => {
  const [config, setConfig] = useState<DoorControllerConfig>(DEFAULT_OFFLINE_DOOR_CONFIG);
  const [logs, setLogs] = useState<DoorApiLog[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [testing, setTesting] = useState<boolean>(false);
  const [showToken, setShowToken] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [testAction, setTestAction] = useState<"OPEN" | "CLOSE">("OPEN");
  const [testSource, setTestSource] = useState<string>("Bảng Điều Khiển Quản Trị");
  const [updateUIAfterTest, setUpdateUIAfterTest] = useState<boolean>(true);
  const [copiedCurl, setCopiedCurl] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    statusCode?: number;
    durationMs?: number;
    responseBody?: string;
    error?: string;
  } | null>(null);

  // Load config & logs on mount
  const fetchConfigAndLogs = useCallback(async () => {
    setLoading(true);
    try {
      const configRes = await safeJsonFetch<DoorControllerConfig>("/api/door-controller/config");
      if (configRes.ok && configRes.data && configRes.data.apiUrl) {
        setConfig(configRes.data);
        saveStoredDoorConfig(configRes.data);
      } else {
        setConfig(getStoredDoorConfig());
      }

      const logsRes = await safeJsonFetch<DoorApiLog[]>("/api/door-controller/logs");
      if (logsRes.ok && Array.isArray(logsRes.data)) {
        setLogs(logsRes.data);
        saveStoredDoorLogs(logsRes.data);
      } else {
        setLogs(getStoredDoorLogs());
      }
    } catch {
      setConfig(getStoredDoorConfig());
      setLogs(getStoredDoorLogs());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfigAndLogs();

    // Listen to real-time events via client event bus
    const unsubLog = clientEventBus.on("door_api_log", (newLog: DoorApiLog) => {
      setLogs((prev) => [newLog, ...prev.filter((l) => l.id !== newLog.id)].slice(0, 60));
    });

    const unsubConfig = clientEventBus.on("door_config_updated", (newConfig: DoorControllerConfig) => {
      setConfig(newConfig);
    });

    const unsubClear = clientEventBus.on("door_api_logs_cleared", () => {
      setLogs([]);
    });

    return () => {
      unsubLog();
      unsubConfig();
      unsubClear();
    };
  }, [fetchConfigAndLogs]);

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSaving(true);
    setSaveSuccess(false);

    try {
      saveStoredDoorConfig(config);
      clientEventBus.emit("door_config_updated", config);

      await safeJsonFetch("/api/door-controller/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      setSaveSuccess(true);
      soundEffects.playGranted();
      setTimeout(() => setSaveSuccess(false), 3500);
    } catch (err) {
      console.warn("Lỗi lưu cấu hình API cửa:", err);
      // Fallback local save is already done
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3500);
    } finally {
      setSaving(false);
    }
  };

  const handleRunTest = async () => {
    setTesting(true);
    setTestResult(null);

    const startTime = Date.now();
    try {
      // First attempt server-side test endpoint
      const res = await safeJsonFetch<{ success: boolean; log: DoorApiLog; error?: string }>(
        "/api/door-controller/test",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: testAction,
            source: testSource,
            updateDoorState: updateUIAfterTest,
            testConfig: config,
          }),
        }
      );

      if (res.ok && res.data && res.data.log) {
        const testData = res.data;
        setTestResult({
          success: testData.success,
          statusCode: testData.log.statusCode,
          durationMs: testData.log.durationMs,
          responseBody: testData.log.responseBody,
          error: testData.log.error || testData.error,
        });
        setLogs((prev) => [testData.log, ...prev.filter((l) => l.id !== testData.log.id)].slice(0, 60));
        if (testData.success) {
          soundEffects.playGranted();
        } else {
          soundEffects.playDenied();
        }
      } else {
        // Direct browser dispatch fallback (if server offline or running static host)
        const directLog = await dispatchDirectDoorControllerCommand(testAction, testSource);
        if (directLog) {
          setTestResult({
            success: directLog.success,
            statusCode: directLog.statusCode,
            durationMs: directLog.durationMs,
            responseBody: directLog.responseBody,
            error: directLog.error,
          });
          setLogs((prev) => [directLog, ...prev.filter((l) => l.id !== directLog.id)].slice(0, 60));
          if (directLog.success) {
            soundEffects.playGranted();
          } else {
            soundEffects.playDenied();
          }
        }
      }

      if (onRefreshLockState && updateUIAfterTest) {
        onRefreshLockState();
      }
    } catch (err: any) {
      setTestResult({
        success: false,
        durationMs: Date.now() - startTime,
        error: err?.message || "Không thể kết nối đến API cửa",
      });
      soundEffects.playDenied();
    } finally {
      setTesting(false);
    }
  };

  const handleClearLogs = async () => {
    if (!window.confirm("Bạn có chắc chắn muốn xóa toàn bộ nhật ký gọi API mở cửa không?")) {
      return;
    }
    setLogs([]);
    clearStoredDoorLogs();
    clientEventBus.emit("door_api_logs_cleared", { success: true });

    try {
      await safeJsonFetch("/api/door-controller/logs", { method: "DELETE" });
    } catch {}
  };

  const handleApplyPreset = (preset: "GENERIC_RELAY" | "HOME_ASSISTANT" | "SHELLY" | "ESP32") => {
    if (preset === "GENERIC_RELAY") {
      setConfig((prev) => ({
        ...prev,
        apiUrl: "https://smartlock.eton.vn/api/door/control",
        authHeaderType: "BEARER",
        openMethod: "POST",
        closeMethod: "POST",
        openPayloadTemplate: JSON.stringify(
          {
            action: "OPEN",
            door: "{{DOOR}}",
            pulseSeconds: 6,
            triggeredBy: "{{TRIGGERED_BY}}",
            timestamp: "{{TIMESTAMP}}",
          },
          null,
          2
        ),
        closePayloadTemplate: JSON.stringify(
          {
            action: "CLOSE",
            door: "{{DOOR}}",
            triggeredBy: "{{TRIGGERED_BY}}",
            timestamp: "{{TIMESTAMP}}",
          },
          null,
          2
        ),
      }));
    } else if (preset === "HOME_ASSISTANT") {
      setConfig((prev) => ({
        ...prev,
        apiUrl: "http://homeassistant.local:8123/api/services/lock/unlock",
        authHeaderType: "BEARER",
        openMethod: "POST",
        closeMethod: "POST",
        openPayloadTemplate: JSON.stringify(
          {
            entity_id: "lock.main_gate",
          },
          null,
          2
        ),
        closePayloadTemplate: JSON.stringify(
          {
            entity_id: "lock.main_gate",
          },
          null,
          2
        ),
      }));
    } else if (preset === "SHELLY") {
      setConfig((prev) => ({
        ...prev,
        apiUrl: "http://192.168.1.150/relay/0?turn=on&timer=6",
        authHeaderType: "NONE",
        openMethod: "GET",
        closeMethod: "GET",
        openPayloadTemplate: "",
        closePayloadTemplate: "",
      }));
    } else if (preset === "ESP32") {
      setConfig((prev) => ({
        ...prev,
        apiUrl: "http://192.168.1.200/api/relay",
        authHeaderType: "API_KEY",
        customHeaderName: "X-Api-Key",
        openMethod: "POST",
        closeMethod: "POST",
        openPayloadTemplate: JSON.stringify(
          {
            command: "UNLOCK_PULSE",
            duration: 6,
          },
          null,
          2
        ),
        closePayloadTemplate: JSON.stringify(
          {
            command: "LOCK_NOW",
          },
          null,
          2
        ),
      }));
    }
  };

  const generateCurlCommand = () => {
    let authHeader = "";
    if (config.apiToken) {
      if (config.authHeaderType === "BEARER") {
        authHeader = ` \\\n  -H "Authorization: Bearer ${config.apiToken}"`;
      } else if (config.authHeaderType === "API_KEY") {
        authHeader = ` \\\n  -H "X-Api-Key: ${config.apiToken}"`;
      } else if (config.authHeaderType === "CUSTOM_HEADER") {
        authHeader = ` \\\n  -H "${config.customHeaderName || "X-Door-Token"}: ${config.apiToken}"`;
      }
    }

    let url = config.apiUrl || "https://smartlock.eton.vn/api/door/control";
    if (config.authHeaderType === "QUERY_PARAM" && config.apiToken) {
      url += (url.includes("?") ? "&" : "?") + `token=${config.apiToken}`;
    }

    let data = "";
    if (config.openMethod !== "GET") {
      const payload = config.openPayloadTemplate
        ? config.openPayloadTemplate
            .replace(/\{\{ACTION\}\}/g, "OPEN")
            .replace(/\{\{TRIGGERED_BY\}\}/g, "Admin Test")
            .replace(/\{\{TIMESTAMP\}\}/g, new Date().toISOString())
            .replace(/\{\{PULSE\}\}/g, String(config.pulseDurationSeconds || 6))
            .replace(/\{\{DOOR\}\}/g, lockState.doorName)
        : JSON.stringify({ action: "OPEN", pulse: config.pulseDurationSeconds || 6 });
      data = ` \\\n  -H "Content-Type: application/json" \\\n  -d '${payload.replace(/'/g, "\\'")}'`;
    }

    return `curl -X ${config.openMethod} "${url}"${authHeader}${data}`;
  };

  const handleCopyCurl = () => {
    navigator.clipboard.writeText(generateCurlCommand());
    setCopiedCurl(true);
    setTimeout(() => setCopiedCurl(false), 2500);
  };

  return (
    <div className="space-y-6 pb-12 animate-fade-in">
      {/* Header Banner */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start gap-3.5">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-600 to-teal-700 text-white flex items-center justify-center shrink-0 shadow-sm shadow-emerald-200">
            <KeyRound className="w-6 h-6" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900">
                Cấu Hình API Điều Khiển Mở/Đóng Cửa Tự Động
              </h1>
              <span
                className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                  config.enabled
                    ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                    : "bg-slate-100 text-slate-600 border-slate-300"
                }`}
              >
                {config.enabled ? (
                  <>
                    <Zap className="w-3 h-3 text-emerald-600 fill-emerald-600" />
                    ĐANG KÍCH HOẠT
                  </>
                ) : (
                  <>
                    <Lock className="w-3 h-3" />
                    TẮT ĐIỀU KHIỂN
                  </>
                )}
              </span>
            </div>
            <p className="text-xs sm:text-sm text-slate-600 mt-1 max-w-3xl leading-relaxed">
              Khai báo Endpoint URL và Token xác thực để hệ thống tự động bắn tín hiệu mở/đóng cửa tới
              phần cứng điều khiển (Relay IoT, ESP32, Raspberry Pi, Shelly, Hikvision, ZKTeco, Home
              Assistant) ngay khi nhận diện khuôn mặt hợp lệ.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-start md:self-center shrink-0">
          <button
            id="door-btn-refresh"
            type="button"
            onClick={fetchConfigAndLogs}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors disabled:opacity-60"
            title="Làm mới cấu hình và nhật ký"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Làm mới</span>
          </button>
          <button
            id="door-btn-save-header"
            type="button"
            onClick={() => handleSave()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 transition-colors shadow-xs disabled:opacity-60"
          >
            {saving ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : saveSuccess ? (
              <Check className="w-3.5 h-3.5" />
            ) : (
              <CheckCircle2 className="w-3.5 h-3.5" />
            )}
            <span>{saveSuccess ? "Đã lưu thành công!" : "Lưu Cấu Hình"}</span>
          </button>
        </div>
      </div>

      {/* Main Grid: Form Settings (Left) + Interactive Test & Logs (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Configuration Form (7 cols) */}
        <div className="lg:col-span-7 space-y-6">
          <form onSubmit={handleSave} className="space-y-6">
            {/* Section 1: Enable & Quick Presets */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-xs space-y-5">
              <div className="flex items-center justify-between pb-4 border-b border-slate-100">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center">
                    <Zap className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-slate-900">
                      Trạng Thái Kích Hoạt &amp; Chế Độ Hoạt Động
                    </h2>
                    <p className="text-xs text-slate-500">
                      Bật hoặc tắt chức năng tự động gọi Web API khi mở cửa
                    </p>
                  </div>
                </div>

                {/* Master Switch */}
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    id="door-toggle-enabled"
                    type="checkbox"
                    checked={config.enabled}
                    onChange={(e) => setConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
                    className="sr-only peer"
                  />
                  <div className="w-13 h-7 bg-slate-200 peer-focus:outline-hidden rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[3px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-emerald-600"></div>
                </label>
              </div>

              {/* Hardware / Gateway Presets */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  Mẫu Cấu Hình Thiết Bị Nhanh (Presets):
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <button
                    type="button"
                    onClick={() => handleApplyPreset("GENERIC_RELAY")}
                    className="flex flex-col items-center justify-center p-2.5 rounded-xl border border-slate-200 hover:border-emerald-500 hover:bg-emerald-50/50 text-slate-700 hover:text-emerald-800 text-xs transition-all"
                  >
                    <Cpu className="w-4 h-4 text-emerald-600 mb-1" />
                    <span className="font-semibold">Eton Smart Gateway</span>
                    <span className="text-[10px] text-slate-500">REST JSON</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleApplyPreset("ESP32")}
                    className="flex flex-col items-center justify-center p-2.5 rounded-xl border border-slate-200 hover:border-blue-500 hover:bg-blue-50/50 text-slate-700 hover:text-blue-800 text-xs transition-all"
                  >
                    <Sliders className="w-4 h-4 text-blue-600 mb-1" />
                    <span className="font-semibold">ESP32 / Arduino</span>
                    <span className="text-[10px] text-slate-500">X-Api-Key Relay</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleApplyPreset("HOME_ASSISTANT")}
                    className="flex flex-col items-center justify-center p-2.5 rounded-xl border border-slate-200 hover:border-cyan-500 hover:bg-cyan-50/50 text-slate-700 hover:text-cyan-800 text-xs transition-all"
                  >
                    <Radio className="w-4 h-4 text-cyan-600 mb-1" />
                    <span className="font-semibold">Home Assistant</span>
                    <span className="text-[10px] text-slate-500">Lock Service</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleApplyPreset("SHELLY")}
                    className="flex flex-col items-center justify-center p-2.5 rounded-xl border border-slate-200 hover:border-amber-500 hover:bg-amber-50/50 text-slate-700 hover:text-amber-800 text-xs transition-all"
                  >
                    <Zap className="w-4 h-4 text-amber-600 mb-1" />
                    <span className="font-semibold">Shelly / Sonoff</span>
                    <span className="text-[10px] text-slate-500">HTTP GET Pulse</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Section 2: URL & Authentication Token */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-xs space-y-4">
              <div className="flex items-center gap-2.5 pb-3 border-b border-slate-100">
                <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center">
                  <KeyRound className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-slate-900">
                    Endpoint URL &amp; Token Xác Thực
                  </h2>
                  <p className="text-xs text-slate-500">
                    Địa chỉ máy chủ hoặc IP bộ điều khiển rơ-le tiếp nhận lệnh
                  </p>
                </div>
              </div>

              {/* API URL Input */}
              <div>
                <label
                  htmlFor="door-api-url"
                  className="block text-xs font-semibold text-slate-700 mb-1.5"
                >
                  API Endpoint URL: <span className="text-rose-500">*</span>
                </label>
                <div className="relative">
                  <input
                    id="door-api-url"
                    type="url"
                    required
                    value={config.apiUrl}
                    onChange={(e) => setConfig((prev) => ({ ...prev, apiUrl: e.target.value }))}
                    placeholder="https://api.yourdomain.com/door/control hoặc http://192.168.1.100/relay"
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs sm:text-sm font-mono text-slate-900 focus:bg-white focus:outline-hidden focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-600 transition-all pr-10"
                  />
                  <div className="absolute right-3 top-3 text-slate-400">
                    <ExternalLink className="w-4 h-4" />
                  </div>
                </div>
                <p className="text-[11px] text-slate-500 mt-1">
                  Hỗ trợ cả giao thức HTTPS công khai hoặc IP mạng nội bộ LAN (HTTP).
                </p>
              </div>

              {/* Authentication Type */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div>
                  <label
                    htmlFor="door-auth-type"
                    className="block text-xs font-semibold text-slate-700 mb-1.5"
                  >
                    Kiểu Xác Thực (Auth Type):
                  </label>
                  <select
                    id="door-auth-type"
                    value={config.authHeaderType}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        authHeaderType: e.target.value as DoorAuthHeaderType,
                      }))
                    }
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-xl text-xs sm:text-sm text-slate-900 focus:bg-white focus:outline-hidden focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-600 transition-all font-medium"
                  >
                    <option value="BEARER">Authorization: Bearer &lt;token&gt;</option>
                    <option value="API_KEY">X-Api-Key: &lt;token&gt;</option>
                    <option value="CUSTOM_HEADER">Tùy chỉnh Header Name</option>
                    <option value="QUERY_PARAM">URL Query: ?token=&lt;token&gt;</option>
                    <option value="NONE">Không xác thực (None / No Auth)</option>
                  </select>
                </div>

                {config.authHeaderType === "CUSTOM_HEADER" && (
                  <div>
                    <label
                      htmlFor="door-custom-header"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      Tên Header Tùy Chỉnh:
                    </label>
                    <input
                      id="door-custom-header"
                      type="text"
                      value={config.customHeaderName || "X-Door-Token"}
                      onChange={(e) =>
                        setConfig((prev) => ({ ...prev, customHeaderName: e.target.value }))
                      }
                      placeholder="X-Door-Token"
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-xl text-xs sm:text-sm font-mono text-slate-900 focus:bg-white focus:outline-hidden focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-600 transition-all"
                    />
                  </div>
                )}
              </div>

              {/* Secret Token Input */}
              {config.authHeaderType !== "NONE" && (
                <div>
                  <label
                    htmlFor="door-api-token"
                    className="block text-xs font-semibold text-slate-700 mb-1.5"
                  >
                    Mã Token / Secret API Key:
                  </label>
                  <div className="relative">
                    <input
                      id="door-api-token"
                      type={showToken ? "text" : "password"}
                      value={config.apiToken}
                      onChange={(e) =>
                        setConfig((prev) => ({ ...prev, apiToken: e.target.value }))
                      }
                      placeholder="Nhập secret token mở khóa"
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs sm:text-sm font-mono text-slate-900 focus:bg-white focus:outline-hidden focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-600 transition-all pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken(!showToken)}
                      className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600 p-1"
                      title={showToken ? "Ẩn token" : "Hiện token"}
                    >
                      {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">
                    Token được lưu trữ an toàn trong Database và tự động ẩn khi hiển thị ra nhật ký.
                  </p>
                </div>
              )}
            </div>

            {/* Section 3: Trigger Rules & Pulse Duration */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-xs space-y-4">
              <div className="flex items-center gap-2.5 pb-3 border-b border-slate-100">
                <div className="w-8 h-8 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center">
                  <Sliders className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-slate-900">
                    Điều Kiện Kích Hoạt &amp; Thời Gian Mở Relay
                  </h2>
                  <p className="text-xs text-slate-500">
                    Quy định khi nào hệ thống tự động bắn tín hiệu và thời lượng mở chốt
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                <label className="flex items-start gap-3 p-3 rounded-xl border border-slate-200 hover:bg-slate-50 cursor-pointer transition-colors">
                  <input
                    id="door-trigger-face"
                    type="checkbox"
                    checked={config.triggerOnFaceRecognition}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        triggerOnFaceRecognition: e.target.checked,
                      }))
                    }
                    className="mt-0.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <div>
                    <span className="text-xs sm:text-sm font-semibold text-slate-900 block">
                      Kích hoạt khi AI nhận diện khuôn mặt thành công
                    </span>
                    <span className="text-xs text-slate-500 block mt-0.5">
                      Tự động gửi lệnh OPEN ngay khi nhân viên được xác thực hợp lệ qua camera.
                    </span>
                  </div>
                </label>

                <label className="flex items-start gap-3 p-3 rounded-xl border border-slate-200 hover:bg-slate-50 cursor-pointer transition-colors">
                  <input
                    id="door-trigger-manual"
                    type="checkbox"
                    checked={config.triggerOnManualUnlock}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        triggerOnManualUnlock: e.target.checked,
                      }))
                    }
                    className="mt-0.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <div>
                    <span className="text-xs sm:text-sm font-semibold text-slate-900 block">
                      Kích hoạt khi bấm &quot;Mở Cửa Thủ Công&quot; trên Web / Mobile
                    </span>
                    <span className="text-xs text-slate-500 block mt-0.5">
                      Gửi lệnh mở khi quản trị viên hoặc bảo vệ click mở trực tiếp từ dashboard.
                    </span>
                  </div>
                </label>
              </div>

              {/* Pulse duration slider */}
              <div className="pt-2">
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    htmlFor="door-pulse-seconds"
                    className="text-xs font-semibold text-slate-700"
                  >
                    Thời gian cấp xung rơ-le / Giữ mở chốt (Pulse Duration):
                  </label>
                  <span className="px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 font-mono text-xs font-bold">
                    {config.pulseDurationSeconds || 6} giây
                  </span>
                </div>
                <input
                  id="door-pulse-seconds"
                  type="range"
                  min={1}
                  max={30}
                  step={1}
                  value={config.pulseDurationSeconds || 6}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      pulseDurationSeconds: parseInt(e.target.value, 10) || 6,
                    }))
                  }
                  className="w-full accent-emerald-600 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-slate-400 mt-1 font-mono">
                  <span>1s (Xung nhả chốt)</span>
                  <span>6s (Chuẩn văn phòng)</span>
                  <span>15s</span>
                  <span>30s (Cổng xe tải)</span>
                </div>
              </div>
            </div>

            {/* Section 4: HTTP Methods & JSON Payload Templates */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-xs space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-800 flex items-center justify-center">
                    <Code2 className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-slate-900">
                      HTTP Method &amp; Mẫu Dữ Liệu Payload (JSON)
                    </h2>
                    <p className="text-xs text-slate-500">
                      Tùy biến cấu trúc dữ liệu JSON gửi tới phần cứng
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => handleApplyPreset("GENERIC_RELAY")}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-emerald-700"
                >
                  <RotateCcw className="w-3 h-3" />
                  Khôi phục mẫu chuẩn
                </button>
              </div>

              {/* Methods selection */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="door-open-method"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Phương thức MỞ (OPEN Method):
                  </label>
                  <select
                    id="door-open-method"
                    value={config.openMethod}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        openMethod: e.target.value as "POST" | "GET" | "PUT",
                      }))
                    }
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-xl text-xs font-mono font-bold text-slate-900 focus:bg-white"
                  >
                    <option value="POST">POST</option>
                    <option value="GET">GET</option>
                    <option value="PUT">PUT</option>
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="door-close-method"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Phương thức ĐÓNG (CLOSE Method):
                  </label>
                  <select
                    id="door-close-method"
                    value={config.closeMethod}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        closeMethod: e.target.value as "POST" | "GET" | "PUT",
                      }))
                    }
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-xl text-xs font-mono font-bold text-slate-900 focus:bg-white"
                  >
                    <option value="POST">POST</option>
                    <option value="GET">GET</option>
                    <option value="PUT">PUT</option>
                  </select>
                </div>
              </div>

              {/* Open Payload Template */}
              {config.openMethod !== "GET" && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label
                      htmlFor="door-open-payload"
                      className="text-xs font-semibold text-slate-700"
                    >
                      Mẫu JSON khi MỞ CỬA (OPEN Payload):
                    </label>
                    <div className="flex gap-1 text-[10px] text-slate-400">
                      <span>Thẻ thay thế:</span>
                      <code className="text-emerald-700 bg-emerald-50 px-1 rounded">
                        {"{{ACTION}}"}
                      </code>
                      <code className="text-emerald-700 bg-emerald-50 px-1 rounded">
                        {"{{PULSE}}"}
                      </code>
                      <code className="text-emerald-700 bg-emerald-50 px-1 rounded">
                        {"{{DOOR}}"}
                      </code>
                    </div>
                  </div>
                  <textarea
                    id="door-open-payload"
                    rows={4}
                    value={config.openPayloadTemplate}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, openPayloadTemplate: e.target.value }))
                    }
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs font-mono text-emerald-400 focus:outline-hidden focus:ring-2 focus:ring-emerald-500/30"
                  />
                </div>
              )}

              {/* Close Payload Template */}
              {config.closeMethod !== "GET" && (
                <div>
                  <label
                    htmlFor="door-close-payload"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Mẫu JSON khi ĐÓNG CỬA (CLOSE Payload):
                  </label>
                  <textarea
                    id="door-close-payload"
                    rows={3}
                    value={config.closePayloadTemplate}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, closePayloadTemplate: e.target.value }))
                    }
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs font-mono text-emerald-400 focus:outline-hidden focus:ring-2 focus:ring-emerald-500/30"
                  />
                </div>
              )}
            </div>

            {/* Bottom Save Action Button */}
            <div className="flex items-center justify-between bg-white rounded-2xl border border-slate-200 p-4 shadow-xs">
              <span className="text-xs text-slate-500">
                Thay đổi sẽ áp dụng ngay tức thì cho cả chế độ Cloud Server và Client Edge.
              </span>
              <button
                id="door-btn-save-bottom"
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 transition-all shadow-xs disabled:opacity-60"
              >
                {saving ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : saveSuccess ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <CheckCircle2 className="w-4 h-4" />
                )}
                <span>{saveSuccess ? "Đã lưu cài đặt!" : "Lưu Thay Đổi"}</span>
              </button>
            </div>
          </form>
        </div>

        {/* Right Column: Testing Console & Execution Logs (5 cols) */}
        <div className="lg:col-span-5 space-y-6">
          {/* Box 1: Interactive Testing Console */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-xs space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-emerald-600" />
                <h3 className="text-sm font-bold text-slate-900">Bảng Chạy Thử Nghiệm API Cửa</h3>
              </div>
              <span className="text-[11px] font-mono text-slate-500">Live Simulator</span>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              Bấm nút bên dưới để phát lệnh thử nghiệm tới URL đã cấu hình mà không cần phải đứng trước
              camera nhận diện.
            </p>

            {/* Test Action Picker */}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setTestAction("OPEN")}
                className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-bold border transition-all ${
                  testAction === "OPEN"
                    ? "bg-emerald-50 text-emerald-800 border-emerald-500 shadow-2xs"
                    : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100"
                }`}
              >
                <Unlock className="w-3.5 h-3.5" />
                LỆNH MỞ (OPEN)
              </button>
              <button
                type="button"
                onClick={() => setTestAction("CLOSE")}
                className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-bold border transition-all ${
                  testAction === "CLOSE"
                    ? "bg-rose-50 text-rose-800 border-rose-500 shadow-2xs"
                    : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100"
                }`}
              >
                <Lock className="w-3.5 h-3.5" />
                LỆNH ĐÓNG (CLOSE)
              </button>
            </div>

            {/* Source Label input */}
            <div>
              <label
                htmlFor="door-test-source"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Nguồn phát lệnh kiểm thử:
              </label>
              <input
                id="door-test-source"
                type="text"
                value={testSource}
                onChange={(e) => setTestSource(e.target.value)}
                placeholder="Bảng Điều Khiển Quản Trị"
                className="w-full px-3 py-1.5 bg-slate-50 border border-slate-300 rounded-lg text-xs font-medium text-slate-900"
              />
            </div>

            {/* Sync with UI Lock State toggle */}
            <label className="flex items-center gap-2 cursor-pointer pt-1">
              <input
                id="door-test-sync-ui"
                type="checkbox"
                checked={updateUIAfterTest}
                onChange={(e) => setUpdateUIAfterTest(e.target.checked)}
                className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
              />
              <span className="text-xs text-slate-700">
                Đồng thời cập nhật trạng thái chốt trên giao diện
              </span>
            </label>

            {/* Execute Test Button */}
            <button
              id="door-btn-execute-test"
              type="button"
              onClick={handleRunTest}
              disabled={testing || !config.apiUrl}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs sm:text-sm font-bold text-white bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 transition-all shadow-sm shadow-emerald-200 disabled:opacity-50 cursor-pointer"
            >
              {testing ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Đang gửi tín hiệu tới phần cứng...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  Gửi Lệnh {testAction === "OPEN" ? "MỞ CỬA" : "ĐÓNG CỬA"} Ngay
                </>
              )}
            </button>

            {/* Test Execution Result Banner */}
            {testResult && (
              <div
                className={`p-3.5 rounded-xl border text-xs space-y-1.5 animate-fade-in ${
                  testResult.success
                    ? "bg-emerald-50/80 border-emerald-200 text-emerald-900"
                    : "bg-rose-50/80 border-rose-200 text-rose-900"
                }`}
              >
                <div className="flex items-center justify-between font-bold">
                  <span className="flex items-center gap-1.5">
                    {testResult.success ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    ) : (
                      <XCircle className="w-4 h-4 text-rose-600" />
                    )}
                    {testResult.success
                      ? "Gọi API thành công (Thực thi hoàn tất)"
                      : "Gặp sự cố khi gọi API"}
                  </span>
                  {testResult.durationMs !== undefined && (
                    <span className="font-mono text-[11px] font-normal">
                      {testResult.durationMs}ms
                    </span>
                  )}
                </div>

                {testResult.statusCode && (
                  <p className="font-mono text-[11px]">
                    HTTP Status: <strong>{testResult.statusCode}</strong>
                  </p>
                )}

                {testResult.error && (
                  <p className="text-rose-700 text-[11px] leading-relaxed">
                    Lỗi: {testResult.error}
                  </p>
                )}

                {testResult.responseBody && (
                  <div className="mt-1 pt-1 border-t border-emerald-200/60">
                    <span className="text-[10px] text-slate-500 uppercase font-semibold">
                      Phản hồi từ thiết bị:
                    </span>
                    <pre className="font-mono text-[10px] bg-white/70 p-1.5 rounded-md overflow-x-auto max-h-24">
                      {testResult.responseBody}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* Quick cURL copy */}
            <div className="pt-2 border-t border-slate-100">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold text-slate-700 flex items-center gap-1">
                  <Terminal className="w-3.5 h-3.5 text-slate-500" />
                  Lệnh cURL tương đương:
                </span>
                <button
                  type="button"
                  onClick={handleCopyCurl}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 hover:text-emerald-800"
                >
                  {copiedCurl ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-600" />
                      Đã sao chép
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      Sao chép
                    </>
                  )}
                </button>
              </div>
              <pre className="p-2.5 rounded-xl bg-slate-900 text-slate-200 font-mono text-[11px] overflow-x-auto whitespace-pre-wrap break-all border border-slate-800 max-h-28">
                {generateCurlCommand()}
              </pre>
            </div>
          </div>

          {/* Box 2: Execution Logs */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-xs space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                <h3 className="text-sm font-bold text-slate-900">
                  Nhật Ký Gọi API Mở Cửa ({logs.length})
                </h3>
              </div>
              {logs.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearLogs}
                  className="inline-flex items-center gap-1 text-xs text-rose-600 hover:text-rose-700 font-medium"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Xóa log
                </button>
              )}
            </div>

            {logs.length === 0 ? (
              <div className="text-center py-8 px-4 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                <Radio className="w-8 h-8 text-slate-400 mx-auto mb-2 opacity-50" />
                <p className="text-xs font-semibold text-slate-600">Chưa có nhật ký gọi API cửa</p>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Các lệnh mở cửa qua nhận diện hoặc nút thử nghiệm sẽ xuất hiện tại đây theo thời gian
                  thực.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5 max-h-96 overflow-y-auto pr-1">
                {logs.map((log) => {
                  const isSuccess = log.success;
                  return (
                    <div
                      key={log.id}
                      className={`p-3 rounded-xl border text-xs transition-all ${
                        isSuccess
                          ? "bg-slate-50/80 border-slate-200 hover:border-slate-300"
                          : "bg-rose-50/50 border-rose-200"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold ${
                              log.action === "OPEN"
                                ? "bg-emerald-100 text-emerald-800"
                                : "bg-blue-100 text-blue-800"
                            }`}
                          >
                            {log.action}
                          </span>
                          <span className="font-mono text-[11px] text-slate-500">
                            {log.method}
                          </span>
                          <span
                            className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                              isSuccess
                                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                : "bg-rose-50 text-rose-700 border border-rose-200"
                            }`}
                          >
                            {log.statusCode ? `HTTP ${log.statusCode}` : isSuccess ? "OK" : "ERROR"}
                          </span>
                        </div>
                        <span className="text-[10px] text-slate-400 font-mono">
                          {new Date(log.timestamp).toLocaleTimeString("vi-VN")} (
                          {log.durationMs || 0}ms)
                        </span>
                      </div>

                      <p className="text-[11px] font-mono text-slate-700 truncate" title={log.url}>
                        {log.url}
                      </p>

                      <div className="flex items-center justify-between text-[10px] text-slate-500 mt-1 pt-1 border-t border-slate-200/60">
                        <span>
                          Phát bởi: <strong>{log.triggeredBy}</strong>
                        </span>
                        {log.error && (
                          <span className="text-rose-600 truncate max-w-[180px]" title={log.error}>
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
      </div>
    </div>
  );
};
