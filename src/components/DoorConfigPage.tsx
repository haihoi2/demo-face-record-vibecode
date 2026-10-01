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
  Plus,
  DoorOpen,
} from "lucide-react";
import { CameraStreamsConfig, DoorControllerConfig, DoorApiLog, DoorAuthHeaderType, SmartLockState } from "../types";
import { operatorJsonFetch, safeJsonFetch } from "../utils/api";
import { ModalDialog } from "./ModalDialog";
import { hasRole, useOperatorSession } from "../utils/session";
import { gateDisplayLabel, gateDoorId, gatesOf } from "../utils/gates";
import {
  LEGACY_DOOR_ID,
  LEGACY_LOCK_STATUS_URL,
  TOKEN_PLACEHOLDER,
  buildDoorSavePayload,
  buildDoorTestConfig,
  buildLockCommandRequest,
  buildLockStateUrl,
  doorDisplayLabel,
  doorsOf,
  interpretLockCommand,
  newDoorView,
  readLockState,
  validateDoorDraft,
  withoutTokens,
  type DoorDraft,
  type DoorView,
} from "../utils/doors";
import { soundEffects } from "../utils/audio";
import {
  getStoredDoorLogs,
  saveStoredDoorLogs,
  clearStoredDoorLogs,
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
  // Manual door commands are admin-only; the server refuses them for anyone else.
  const canOperateDoor = hasRole(useOperatorSession(), "admin");
  // Doors (N-gate wave): `doors[]` from the server, or its single config read as door "main".
  // The page never holds a controller token: what the server sends is dropped on read,
  // and a token is sent only when the admin types a new one (tokenDrafts).
  const [doors, setDoors] = useState<DoorView[]>(() => doorsOf(DEFAULT_OFFLINE_DOOR_CONFIG).doors);
  const [multiDoor, setMultiDoor] = useState<boolean>(false);
  const [selectedDoorId, setSelectedDoorId] = useState<string>(LEGACY_DOOR_ID);
  const [tokenDrafts, setTokenDrafts] = useState<Record<string, string | undefined>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [addDoorOpen, setAddDoorOpen] = useState<boolean>(false);
  const [doorDraft, setDoorDraft] = useState<DoorDraft>({ id: "", label: "" });
  const [doorDraftError, setDoorDraftError] = useState<string | null>(null);
  /** Gates and the door each one opens (read-only here; bound on the camera page). */
  const [gateBindings, setGateBindings] = useState<Array<{ id: string; label: string; doorId: string }>>([]);
  // Lock state per door, read from the server; null = could not be read.
  const [lockStates, setLockStates] = useState<Record<string, SmartLockState | null>>({});
  const [lockBusy, setLockBusy] = useState<string | null>(null);
  const [lockNotice, setLockNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const config: DoorView = doors.find((d) => d.id === selectedDoorId) ?? doors[0] ?? doorsOf(DEFAULT_OFFLINE_DOOR_CONFIG).doors[0];
  /** Edit the selected door's controller fields (the form below is unchanged). */
  const setConfig = (action: React.SetStateAction<DoorControllerConfig>) => {
    const id = config.id;
    setDoors((prev) =>
      prev.map((d) => {
        if (d.id !== id) return d;
        const next = typeof action === "function" ? (action as (p: DoorControllerConfig) => DoorControllerConfig)(d) : action;
        // Identity and token stay out of the form's reach.
        return { ...d, ...next, id: d.id, label: d.label, apiToken: "", hasToken: d.hasToken } as DoorView;
      })
    );
  };
  const tokenDraft = tokenDrafts[config.id];

  const applyServerDoors = useCallback((raw: unknown) => {
    const { doors: list, multiDoor: multi } = doorsOf(raw);
    if (list.length === 0) return;
    setDoors(list);
    setMultiDoor(multi);
    setTokenDrafts({});
    setSelectedDoorId((prev) => (list.some((d) => d.id === prev) ? prev : list[0].id));
  }, []);
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
      const configRes = await operatorJsonFetch<DoorControllerConfig>("/api/door-controller/config");
      if (configRes.ok && configRes.data && (configRes.data.apiUrl || Array.isArray(configRes.data.doors))) {
        applyServerDoors(configRes.data);
        setLoadError(null);
      } else {
        applyServerDoors(DEFAULT_OFFLINE_DOOR_CONFIG);
        // A refusal or an unreachable server is said as such; the form then shows defaults, not the stored config.
        setLoadError(
          configRes.ok
            ? null
            : configRes.status === 0
              ? "Không kết nối được máy chủ: đang hiển thị cấu hình mặc định, không phải cấu hình đã lưu."
              : `Máy chủ từ chối đọc cấu hình cửa (HTTP ${configRes.status}): đang hiển thị cấu hình mặc định.`
        );
      }

      const camRes = await safeJsonFetch<{ config?: CameraStreamsConfig }>("/api/camera-streams/config");
      if (camRes.ok) {
        setGateBindings(
          gatesOf(camRes.data?.config).map((g) => ({ id: g.id, label: gateDisplayLabel(g), doorId: gateDoorId(g) }))
        );
      }

      const logsRes = await operatorJsonFetch<DoorApiLog[]>("/api/door-controller/logs");
      if (logsRes.ok && Array.isArray(logsRes.data)) {
        setLogs(logsRes.data);
        saveStoredDoorLogs(logsRes.data);
      } else {
        setLogs(getStoredDoorLogs());
      }
    } catch {
      applyServerDoors(DEFAULT_OFFLINE_DOOR_CONFIG);
      setLogs(getStoredDoorLogs());
    } finally {
      setLoading(false);
    }
  }, [applyServerDoors]);

  useEffect(() => {
    fetchConfigAndLogs();

    // Listen to real-time events via client event bus
    const unsubLog = clientEventBus.on("door_api_log", (newLog: DoorApiLog) => {
      setLogs((prev) => [newLog, ...prev.filter((l) => l.id !== newLog.id)].slice(0, 60));
    });

    const unsubConfig = clientEventBus.on("door_config_updated", (newConfig: DoorControllerConfig) => {
      applyServerDoors(newConfig);
    });

    const unsubClear = clientEventBus.on("door_api_logs_cleared", () => {
      setLogs([]);
    });

    return () => {
      unsubLog();
      unsubConfig();
      unsubClear();
    };
  }, [fetchConfigAndLogs, applyServerDoors]);

  // ---- Lock state and commands per door (server-owned; nothing is simulated here) ----
  const fetchLockState = useCallback(async (doorId: string) => {
    let res = await operatorJsonFetch<unknown>(buildLockStateUrl(doorId));
    // An older server has one lock at /api/lock/status; only door "main" may use it.
    if (res.status === 404 && doorId === LEGACY_DOOR_ID) res = await operatorJsonFetch<unknown>(LEGACY_LOCK_STATUS_URL);
    setLockStates((prev) => ({ ...prev, [doorId]: res.ok ? readLockState(res.data, doorId) : null }));
  }, []);

  const doorIdsKey = doors.map((d) => d.id).join("|");
  useEffect(() => {
    for (const id of doorIdsKey.split("|")) if (id) void fetchLockState(id);
  }, [doorIdsKey, fetchLockState]);

  const handleLockCommand = async (door: DoorView, action: "unlock" | "lock") => {
    const label = doorDisplayLabel(door);
    setLockBusy(door.id);
    setLockNotice(null);
    try {
      const { url, init } = buildLockCommandRequest(action, door.id, `Trang Cấu Hình Cửa (${label})`);
      const res = await operatorJsonFetch<unknown>(url, init);
      const outcome = interpretLockCommand(action, door.id, label, res);
      if (outcome.kind === "applied") {
        if (outcome.lockState) setLockStates((prev) => ({ ...prev, [door.id]: outcome.lockState }));
        else void fetchLockState(door.id);
        if (door.id === LEGACY_DOOR_ID) onRefreshLockState?.();
        soundEffects.playGranted();
      } else {
        soundEffects.playDenied();
      }
      setLockNotice({ ok: outcome.kind === "applied", text: outcome.message });
    } finally {
      setLockBusy(null);
    }
  };

  // ---- Adding a door: local until "Lưu Cấu Hình" sends it with the others ----
  const handleAddDoor = () => {
    const error = validateDoorDraft(doorDraft, doors.map((d) => d.id));
    if (error) {
      setDoorDraftError(error);
      return;
    }
    const door = newDoorView(doorDraft, DEFAULT_OFFLINE_DOOR_CONFIG);
    setDoors((prev) => [...prev, door]);
    setSelectedDoorId(door.id);
    setAddDoorOpen(false);
    setDoorDraft({ id: "", label: "" });
    setDoorDraftError(null);
  };

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSaving(true);
    setSaveSuccess(false);
    setSaveError(null);

    try {
      const result = await operatorJsonFetch<{ success?: boolean; config?: unknown; error?: string }>(
        "/api/door-controller/config",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildDoorSavePayload(doors, tokenDrafts, multiDoor)),
        }
      );
      if (!result.ok || result.data?.success === false) {
        throw new Error(
          result.status === 0
            ? "Không kết nối được máy chủ: cấu hình cửa CHƯA được lưu."
            : `${result.data?.error || result.error || `Lưu cấu hình thất bại (HTTP ${result.status})`}. Cấu hình cửa CHƯA được lưu.`
        );
      }

      // Render what the server stored (tokens dropped on read), not what was sent.
      if (result.data?.config) {
        applyServerDoors(result.data.config);
        clientEventBus.emit("door_config_updated", withoutTokens(result.data.config));
      } else {
        setTokenDrafts({});
        await fetchConfigAndLogs();
      }
      setSaveSuccess(true);
      soundEffects.playGranted();
      setTimeout(() => setSaveSuccess(false), 3500);
    } catch (err: any) {
      console.warn("Lỗi lưu cấu hình API cửa:", err?.message);
      setSaveError(err?.message || "Lưu cấu hình cửa thất bại.");
      setSaveSuccess(false);
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
      const res = await operatorJsonFetch<{ success: boolean; log: DoorApiLog; error?: string }>(
        "/api/door-controller/test",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: testAction,
            source: testSource,
            updateDoorState: updateUIAfterTest,
            doorId: config.id,
            testConfig: buildDoorTestConfig(config, tokenDraft),
          }),
        }
      );

      // A rejected or malformed server response is the result - it is never
      // retried locally and never reported as a successful door command.
      if (!res.ok || !res.data?.log) {
        setTestResult({
          success: false,
          durationMs: Date.now() - startTime,
          error: res.data?.error || res.error || `Kiểm tra thất bại (HTTP ${res.status})`,
        });
        soundEffects.playDenied();
        return;
      }

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
    try {
      const result = await operatorJsonFetch("/api/door-controller/logs", { method: "DELETE" });
      if (!result.ok) throw new Error(result.error || `Xóa nhật ký thất bại (HTTP ${result.status})`);
      setLogs([]);
      clearStoredDoorLogs();
      clientEventBus.emit("door_api_logs_cleared", { success: true });
    } catch (err) {
      console.warn("Lỗi xóa nhật ký API cửa:", err);
    }
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
    // Never the token itself (stored or typed): the preview is copied and pasted around.
    const hasAnyToken = config.hasToken || !!tokenDraft;
    let authHeader = "";
    if (hasAnyToken) {
      if (config.authHeaderType === "BEARER") {
        authHeader = ` \\\n  -H "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`;
      } else if (config.authHeaderType === "API_KEY") {
        authHeader = ` \\\n  -H "X-Api-Key: ${TOKEN_PLACEHOLDER}"`;
      } else if (config.authHeaderType === "CUSTOM_HEADER") {
        authHeader = ` \\\n  -H "${config.customHeaderName || "X-Door-Token"}: ${TOKEN_PLACEHOLDER}"`;
      }
    }

    let url = config.apiUrl || "https://smartlock.eton.vn/api/door/control";
    if (config.authHeaderType === "QUERY_PARAM" && hasAnyToken) {
      url += (url.includes("?") ? "&" : "?") + `token=${TOKEN_PLACEHOLDER}`;
    }

    let data = "";
    if (config.openMethod !== "GET") {
      const payload = config.openPayloadTemplate
        ? config.openPayloadTemplate
            .replace(/\{\{ACTION\}\}/g, "OPEN")
            .replace(/\{\{TRIGGERED_BY\}\}/g, "Admin Test")
            .replace(/\{\{TIMESTAMP\}\}/g, new Date().toISOString())
            .replace(/\{\{PULSE\}\}/g, String(config.pulseDurationSeconds || 6))
            .replace(/\{\{DOOR\}\}/g, config.id === LEGACY_DOOR_ID ? lockState.doorName : doorDisplayLabel(config))
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

      {(loadError || saveError) && (
        <div role="alert" className="p-3 rounded-xl border border-rose-200 bg-rose-50 text-xs text-rose-800 space-y-1">
          {loadError && <p>{loadError}</p>}
          {saveError && <p>{saveError}</p>}
        </div>
      )}

      {/* Door list (N-gate wave): each gate opens exactly its own door */}
      <section
        aria-labelledby="door-list-title"
        className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-xs space-y-4"
        data-testid="door-list"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-teal-100 text-teal-700 flex items-center justify-center">
              <DoorOpen className="w-4 h-4" />
            </div>
            <div>
              <h2 id="door-list-title" className="text-sm font-bold text-slate-900">
                Danh Sách Cửa ({doors.length})
              </h2>
              <p className="text-xs text-slate-500">
                Chọn một cửa để sửa bộ điều khiển của cửa đó bên dưới. Mỗi cổng mở đúng cửa đã gán ở trang Cấu Hình Luồng Camera.
              </p>
            </div>
          </div>
          <button
            id="door-btn-add"
            type="button"
            onClick={() => {
              setDoorDraft({ id: "", label: "" });
              setDoorDraftError(null);
              setAddDoorOpen(true);
            }}
            disabled={!multiDoor}
            title={multiDoor ? "Thêm một cửa và bộ điều khiển của cửa đó" : "Máy chủ này chưa hỗ trợ nhiều cửa: chỉ có cửa chính"}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="w-3.5 h-3.5" />
            Thêm cửa
          </button>
        </div>

        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200" aria-label="Các cửa">
          {doors.map((door) => {
            const selected = door.id === config.id;
            const lock = lockStates[door.id];
            const usedBy = gateBindings.filter((g) => g.doorId === door.id);
            const busy = lockBusy === door.id;
            return (
              <li
                key={door.id}
                data-door-id={door.id}
                className={`px-3 py-2.5 flex flex-wrap items-center gap-3 text-xs ${selected ? "bg-teal-50/60" : ""}`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedDoorId(door.id)}
                  aria-pressed={selected}
                  className="flex-1 min-w-[12rem] text-left"
                  title="Sửa bộ điều khiển của cửa này"
                >
                  <span className="font-bold text-slate-900">{doorDisplayLabel(door)}</span>
                  <span className="ml-1.5 font-mono text-[11px] text-slate-500">{door.id}</span>
                  <span className={`ml-2 text-[10px] font-semibold ${door.enabled ? "text-emerald-700" : "text-slate-500"}`}>
                    {door.enabled ? "đang bật" : "đang tắt"}
                  </span>
                  <span className="block text-[11px] text-slate-500 mt-0.5">
                    {usedBy.length > 0 ? `Cổng dùng cửa này: ${usedBy.map((g) => g.label).join(", ")}` : "Chưa có cổng nào gán vào cửa này"}
                  </span>
                </button>
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold ${
                    lock === undefined
                      ? "bg-slate-50 text-slate-500 border-slate-200"
                      : lock === null
                        ? "bg-amber-50 text-amber-800 border-amber-200"
                        : lock.isLocked
                          ? "bg-slate-100 text-slate-800 border-slate-300"
                          : "bg-emerald-50 text-emerald-800 border-emerald-300"
                  }`}
                >
                  {lock === undefined ? (
                    "đang đọc..."
                  ) : lock === null ? (
                    "không đọc được trạng thái"
                  ) : lock.isLocked ? (
                    <>
                      <Lock className="w-3 h-3" /> Đang khóa
                    </>
                  ) : (
                    <>
                      <Unlock className="w-3 h-3" /> Đang mở
                    </>
                  )}
                </span>
                {canOperateDoor && (
                  <span className="inline-flex gap-1.5">
                    <button
                      type="button"
                      id={`door-btn-unlock-${door.id}`}
                      disabled={busy}
                      onClick={() => void handleLockCommand(door, "unlock")}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-emerald-300 text-emerald-800 bg-white hover:bg-emerald-50 font-semibold disabled:opacity-40"
                    >
                      <Unlock className="w-3 h-3" /> Mở
                    </button>
                    <button
                      type="button"
                      id={`door-btn-lock-${door.id}`}
                      disabled={busy}
                      onClick={() => void handleLockCommand(door, "lock")}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-300 text-slate-800 bg-white hover:bg-slate-50 font-semibold disabled:opacity-40"
                    >
                      <Lock className="w-3 h-3" /> Khóa
                    </button>
                    <button
                      type="button"
                      onClick={() => void fetchLockState(door.id)}
                      className="p-1 rounded-lg text-slate-500 hover:bg-slate-100"
                      aria-label={`Đọc lại trạng thái khóa của ${doorDisplayLabel(door)}`}
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        <div role="status" aria-live="polite" className="empty:hidden">
          {lockNotice && (
            <p
              className={`px-3 py-2 rounded-lg border text-xs ${
                lockNotice.ok ? "bg-emerald-50 border-emerald-200 text-emerald-900" : "bg-rose-50 border-rose-200 text-rose-900"
              }`}
            >
              {lockNotice.text}
            </p>
          )}
        </div>

        {multiDoor && (
          <div className="flex flex-wrap items-end gap-3 pt-1">
            <div>
              <label htmlFor="door-label-input" className="block text-xs font-semibold text-slate-700 mb-1">
                Tên hiển thị của cửa đang chọn ({config.id})
              </label>
              <input
                id="door-label-input"
                type="text"
                maxLength={80}
                value={config.label}
                onChange={(e) => {
                  const label = e.target.value;
                  setDoors((prev) => prev.map((d) => (d.id === config.id ? { ...d, label } : d)));
                }}
                className="w-64 px-3 py-1.5 bg-slate-50 border border-slate-300 rounded-lg text-xs"
              />
            </div>
            <p className="text-[11px] text-slate-500">Thay đổi tên và bộ điều khiển được lưu khi bấm "Lưu Cấu Hình".</p>
          </div>
        )}
      </section>

      {/* Main Grid: Form Settings (Left) + Interactive Test & Logs (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Configuration Form (7 cols) */}
        <div className="lg:col-span-7 space-y-6">
          <p className="text-xs font-semibold text-slate-700">
            Đang sửa bộ điều khiển của: <span className="text-teal-700">{doorDisplayLabel(config)}</span>{" "}
            <span className="font-mono text-slate-500">({config.id})</span>
          </p>
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
              {/* "NONE" is sent by the presets/select but missing from DoorAuthHeaderType (proposed type fix in the handoff). */}
              {(config.authHeaderType as string) !== "NONE" && (
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
                      value={tokenDraft ?? ""}
                      autoComplete="off"
                      onChange={(e) => {
                        const value = e.target.value;
                        // Empty again = keep the stored token (nothing is sent).
                        setTokenDrafts((prev) => ({ ...prev, [config.id]: value === "" ? undefined : value }));
                      }}
                      placeholder={
                        config.hasToken
                          ? "Đã có token lưu trên máy chủ - để trống để giữ nguyên"
                          : "Nhập secret token mở khóa"
                      }
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
                    Token chỉ được gửi lên khi bạn nhập token mới; máy chủ không trả token về trình duyệt và trang không
                    hiển thị lại token đã lưu.
                    {config.hasToken ? " Cửa này đã có token." : " Cửa này chưa có token."}
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
      {addDoorOpen && (
        <ModalDialog
          id="add-door-dialog"
          title={
            <>
              <Plus className="w-4 h-4 text-teal-600" /> Thêm cửa
            </>
          }
          description="Cửa mới bắt đầu ở trạng thái tắt, chưa có URL và token. Điền bộ điều khiển bên dưới rồi bấm Lưu Cấu Hình; sau đó gán cửa cho cổng ở trang Cấu Hình Luồng Camera."
          onClose={() => setAddDoorOpen(false)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setAddDoorOpen(false)}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={handleAddDoor}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-teal-600 text-white hover:bg-teal-700"
              >
                <Plus className="w-3.5 h-3.5" />
                Thêm vào danh sách
              </button>
            </>
          }
        >
          <div>
            <label htmlFor="new-door-label" className="block text-xs font-semibold text-slate-700">
              Tên hiển thị
            </label>
            <input
              id="new-door-label"
              data-autofocus
              type="text"
              maxLength={80}
              value={doorDraft.label}
              onChange={(e) => setDoorDraft((d) => ({ ...d, label: e.target.value }))}
              placeholder="VD: Cửa kho B"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
            />
          </div>
          <div>
            <label htmlFor="new-door-id" className="block text-xs font-semibold text-slate-700">
              Mã cửa
            </label>
            <input
              id="new-door-id"
              type="text"
              maxLength={32}
              value={doorDraft.id}
              onChange={(e) => setDoorDraft((d) => ({ ...d, id: e.target.value.trim().toLowerCase() }))}
              placeholder="vd: kho-b"
              aria-describedby="new-door-id-hint"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono"
            />
            <p id="new-door-id-hint" className="mt-1 text-[11px] text-slate-500">
              2-32 ký tự: chữ thường không dấu, số, dấu gạch ngang; bắt đầu bằng chữ cái.
            </p>
          </div>
          <div role="alert" className="empty:hidden">
            {doorDraftError && (
              <p className="px-3 py-2 rounded-lg border border-rose-200 bg-rose-50 text-xs text-rose-800">{doorDraftError}</p>
            )}
          </div>
        </ModalDialog>
      )}
    </div>
  );
};
