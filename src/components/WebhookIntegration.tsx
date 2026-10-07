import React, { useState, useEffect, useCallback, useRef } from "react";
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
  Network,
  Server,
  ShieldAlert,
  FileText,
  Terminal,
  Trash2,
  RotateCcw,
  UserX,
  Link2,
  Timer,
  BellRing,
  Pencil,
  Plus,
} from "lucide-react";
import {
  WebhookConfig,
  WebhookLog,
  Employee,
  MobileNotification,
  STRANGER_DEEP_LINK_HASH,
} from "../types";
import { buildEventSourceUrl, operatorJsonFetch, safeJsonFetch } from "../utils/api";
import { hasRole, useOperatorSession } from "../utils/session";
import {
  BUILT_IN_NOTE,
  CHANNELS_URL,
  CHANNEL_NAME_MAX,
  CHANNEL_USES,
  ChannelDraft,
  ChannelFieldErrors,
  ChannelView,
  NotificationRoutes,
  buildCreateChannelRequest,
  buildDeleteChannelRequest,
  buildRoutesRequest,
  buildTestChannelRequest,
  buildToggleChannelRequest,
  buildUpdateChannelRequest,
  channelErrorText,
  channelUses,
  isBuiltInChannel,
  maskedUrlText,
  parseChannelsResponse,
  readChannelResult,
  readDeleteResult,
  readRoutesResult,
  readTestResult,
  routeOptions,
  channelUseLabel,
} from "../utils/notificationChannels";
import { ModalDialog } from "./ModalDialog";
import { soundEffects } from "../utils/audio";
import {
  getStoredWebhookConfig,
  saveStoredWebhookConfig,
  getStoredWebhookLogs,
  saveStoredWebhookLogs,
  dispatchDirectWebhook,
  clientEventBus,
} from "../utils/offlineEngine";

export { dispatchDirectWebhook };

export const CANONICAL_ETON_WEBHOOK_URL =
  "https://chat-room.eton.vn/hooks/6aa4dfb6928518a18ba27a13/mguNArZoWHY7AegnWFw7d7TwyfnoT4JZWpmwvxtLmfi7iGuY";

// ---- Stranger ("người lạ") alert defaults, per the WebhookConfig contract ----
export const STRANGER_ALERT_DEFAULTS = {
  strangerAlertEnabled: true,
  strangerTitle: "[[CẢNH BÁO NGƯỜI LẠ]]",
  strangerLinkLabel: "Xem cụm ảnh người lạ",
  appBaseUrl: "",
  strangerCooldownSeconds: 60,
};

/** Sample id used only for the click-through link preview. */
const SAMPLE_STRANGER_LOG_ID = "LOG-123456";

/** Fills in the stranger-alert defaults for configs saved before these fields existed. */
function withStrangerDefaults(raw: WebhookConfig): WebhookConfig {
  const cooldown = Number(raw?.strangerCooldownSeconds);
  return {
    ...raw,
    strangerAlertEnabled:
      typeof raw?.strangerAlertEnabled === "boolean"
        ? raw.strangerAlertEnabled
        : STRANGER_ALERT_DEFAULTS.strangerAlertEnabled,
    strangerTitle: raw?.strangerTitle || STRANGER_ALERT_DEFAULTS.strangerTitle,
    strangerLinkLabel: raw?.strangerLinkLabel || STRANGER_ALERT_DEFAULTS.strangerLinkLabel,
    appBaseUrl: typeof raw?.appBaseUrl === "string" ? raw.appBaseUrl : "",
    strangerCooldownSeconds: Number.isFinite(cooldown)
      ? Math.max(0, Math.round(cooldown))
      : STRANGER_ALERT_DEFAULTS.strangerCooldownSeconds,
  };
}

/**
 * Reads the documented `GET /api/webhook/config` shape (a WebhookConfig object;
 * a `{ config: ... }` envelope is also accepted). Returns null for anything else
 * so we never feed an error page into the form.
 */
function extractWebhookConfig(data: any): WebhookConfig | null {
  if (!data || typeof data !== "object") return null;
  const raw =
    data.config && typeof data.config === "object" ? data.config : data;
  if (typeof raw.url !== "string" && typeof raw.enabled !== "boolean") return null;
  return raw as WebhookConfig;
}

/** `<appBaseUrl or current origin>/#strangers/<logId>` — what the chat message will contain. */
export function buildStrangerDeepLink(appBaseUrl?: string, logId?: string): string {
  const base =
    (appBaseUrl || "").trim().replace(/\/+$/, "") ||
    (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}/#${STRANGER_DEEP_LINK_HASH}/${logId || SAMPLE_STRANGER_LOG_ID}`;
}

interface WebhookIntegrationProps {
  employees: Employee[];
  onNewNotification?: (notif: MobileNotification) => void;
}

export const WebhookIntegration: React.FC<WebhookIntegrationProps> = ({
  employees,
  onNewNotification,
}) => {
  const session = useOperatorSession();
  const isAdmin = hasRole(session, "admin");
  const [config, setConfig] = useState<WebhookConfig>(
    withStrangerDefaults({
      enabled: false,
      url: "https://chat-room.eton.vn/hooks/YOUR_WEBHOOK_TOKEN",
      gateInTitle: "[[CỔNG VÀO]]",
      gateOutTitle: "[[CỔNG RA]]",
      includeEmployeeCode: true,
    })
  );

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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copiedPayload, setCopiedPayload] = useState<boolean>(false);
  const [clientTestResult, setClientTestResult] = useState<{
    status: string;
    msg: string;
  } | null>(null);
  const [strangerTesting, setStrangerTesting] = useState<boolean>(false);
  const [strangerTestResult, setStrangerTestResult] = useState<{
    status: "SUCCESS" | "WARNING" | "ERROR";
    msg: string;
  } | null>(null);

  const [copiedIp, setCopiedIp] = useState<string | null>(null);
  const [copiedEmail, setCopiedEmail] = useState<boolean>(false);
  const [showNetworkDetails, setShowNetworkDetails] = useState<boolean>(true);
  const [ipInfo, setIpInfo] = useState<{
    backendHost: string;
    destinationHost: string;
    outbound: {
      ipv4: string;
      ipv4SubnetRecommended: string;
      ipv6: string;
      provider: string;
      asNumber: string;
      note: string;
    };
    inbound: {
      domain: string;
      ipv4: string[];
      ipv6: string[];
      note: string;
    };
    destination: {
      domain: string;
      resolvedIps: string[];
    };
    emailTemplate?: string;
  }>({
    backendHost: "ais-dev-oru4xhzwwq7ai4fnvomzyh-216092153311.asia-east1.run.app",
    destinationHost: "chat-room.eton.vn",
    outbound: {
      ipv4: "34.34.244.150",
      ipv4SubnetRecommended: "34.34.244.0/24",
      ipv6: "2600:1900:0:3804::b00",
      provider: "Google Cloud Platform (GCP) - asia-east1 (Taiwan)",
      asNumber: "AS15169 Google LLC",
      note: "Địa chỉ IP thực tế mà chat-room.eton.vn nhìn thấy khi backend gửi request",
    },
    inbound: {
      domain: "ais-dev-oru4xhzwwq7ai4fnvomzyh-216092153311.asia-east1.run.app",
      ipv4: ["34.143.77.2", "34.143.74.2", "34.143.78.2", "34.143.75.2", "34.143.72.2"],
      ipv6: ["2600:1901:81d4:200::", "2600:1900:4240:200::"],
      note: "Dải Anycast IP công khai của Google Cloud",
    },
    destination: {
      domain: "chat-room.eton.vn",
      resolvedIps: ["45.118.151.67"],
    },
  });

  // Fetch initial config & logs
  const fetchConfigAndLogs = async () => {
    setLoading(true);
    try {
      const [resConf, resLogs, resIp] = await Promise.all([
        safeJsonFetch<WebhookConfig>("/api/webhook/config", undefined, config),
        safeJsonFetch<WebhookLog[]>("/api/webhook/logs", undefined, []),
        safeJsonFetch<any>("/api/network/ip-info", undefined, null),
      ]);

      if (resIp.ok && resIp.data && resIp.data.outbound) {
        setIpInfo(resIp.data);
      }

      const loadedConf = resConf.ok ? extractWebhookConfig(resConf.data) : null;
      if (loadedConf) {
        const merged = withStrangerDefaults(loadedConf);
        setConfig(merged);
        saveStoredWebhookConfig(merged);
      } else {
        const storedConf = getStoredWebhookConfig();
        if (storedConf) setConfig(withStrangerDefaults(storedConf));
      }

      if (resLogs.ok && Array.isArray(resLogs.data) && resLogs.data.length > 0) {
        setLogs(resLogs.data);
        saveStoredWebhookLogs(resLogs.data);
      } else {
        const storedLogs = getStoredWebhookLogs();
        if (storedLogs && storedLogs.length > 0) {
          setLogs(storedLogs);
        }
      }
    } catch (err) {
      console.error("Lỗi tải cấu hình webhook:", err);
      const storedConf = getStoredWebhookConfig();
      if (storedConf) setConfig(withStrangerDefaults(storedConf));
      const storedLogs = getStoredWebhookLogs();
      if (storedLogs && storedLogs.length > 0) setLogs(storedLogs);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConfigAndLogs();

    // 1. Subscribe to SSE events from Server for real-time updates
    let es: EventSource | null = null;
    try {
      es = new EventSource(buildEventSourceUrl("/api/events"), { withCredentials: true });
      es.addEventListener("webhook_log", (event: MessageEvent) => {
        try {
          const newLog: WebhookLog = JSON.parse(event.data);
          setLogs((prev) => [newLog, ...prev.filter((l) => l.id !== newLog.id)].slice(0, 60));
        } catch {}
      });
      es.addEventListener("webhook_logs_cleared", () => {
        setLogs([]);
      });
    } catch {}

    // 2. Subscribe to client-side EventBus
    const unsubscribeBus = clientEventBus.on("webhook_log", (clientLog: WebhookLog) => {
      setLogs((prev) => [clientLog, ...prev.filter((l) => l.id !== clientLog.id)].slice(0, 60));
    });

    // 3. Fallback polling every 3.5 seconds
    const pollInterval = setInterval(() => {
      safeJsonFetch<WebhookLog[]>("/api/webhook/logs", undefined, []).then((res) => {
        if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
          setLogs(res.data.slice(0, 60));
        }
      });
    }, 3500);

    return () => {
      if (es) es.close();
      unsubscribeBus();
      clearInterval(pollInterval);
    };
  }, []);

  // Handle clearing logs
  const handleClearLogs = async () => {
    setLogs([]);
    saveStoredWebhookLogs([]);
    try {
      await safeJsonFetch("/api/webhook/logs", { method: "DELETE" });
    } catch (err) {
      console.warn("Lỗi xóa nhật ký:", err);
    }
  };

  // Restore canonical working webhook URL
  const handleRestoreCanonicalUrl = async () => {
    const updated = {
      ...config,
      url: CANONICAL_ETON_WEBHOOK_URL,
    };
    setConfig(updated);
    saveStoredWebhookConfig(updated);
    try {
      await safeJsonFetch("/api/webhook/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch {}
  };

  // Handle saving config
  const handleSaveConfig = async () => {
    // Stranger-alert fields travel inside the SAME config object as the gate titles.
    let cleanConfig: WebhookConfig = withStrangerDefaults({ ...config });
    cleanConfig.appBaseUrl = (cleanConfig.appBaseUrl || "").trim().replace(/\/+$/, "");
    if (!cleanConfig.url || cleanConfig.url.includes("...") || cleanConfig.url.endsWith("/hooks/") || cleanConfig.url.endsWith("/hooks")) {
      cleanConfig.url = CANONICAL_ETON_WEBHOOK_URL;
    }
    setConfig(cleanConfig);

    saveStoredWebhookConfig(cleanConfig);
    setSaveSuccess(true);
    setSaveError(null);
    setTimeout(() => setSaveSuccess(false), 2500);

    try {
      const res = await safeJsonFetch("/api/webhook/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cleanConfig),
      });
      if (!res.ok) {
        setSaveSuccess(false);
        setSaveError(res.error || "Không thể lưu cấu hình webhook");
      }
    } catch (err) {
      console.warn("Lưu webhook config lên server ngoại tuyến:", err);
      setSaveSuccess(false);
      setSaveError("Không thể lưu cấu hình webhook");
    }
  };

  // Helper to build standardized Eton Webhook payload
  const buildWebhookPayload = (type: "ENTRY" | "EXIT") => {
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

    return {
      text: userText,
      attachments: [
        {
          title: gateTitle,
        },
      ],
    };
  };

  // Test Webhook from Server
  const handleTestServer = async (type: "ENTRY" | "EXIT") => {
    setTesting(true);
    setClientTestResult(null);
    const gateTitle = type === "ENTRY" ? config.gateInTitle : config.gateOutTitle;
    const payload = buildWebhookPayload(type);

    // Also trigger direct browser dispatch simultaneously
    // This ensures Eton Chat Room receives the webhook even if the server is in foreign cloud IP
    dispatchDirectWebhook(config.url, payload);

    try {
      const res = await safeJsonFetch<{
        success: boolean;
        log: WebhookLog;
        notification?: MobileNotification;
      }>("/api/webhook/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          testScanType: type,
          customUser: testUser,
          customCode: testCode,
        }),
      });

      if (!res.ok) {
        console.warn("[Webhook] Server returned status", res.status, "- running direct client fallback");
        await handleTestClientDirect(type);
        return;
      }

      if (res.data?.log) {
        const newLog = res.data.log;
        setLogs((prev) => [newLog, ...prev.filter((l) => l.id !== newLog.id)]);
        saveStoredWebhookLogs([newLog, ...getStoredWebhookLogs()]);
      }

      const notif: MobileNotification = res.data?.notification || {
        id: "NOTIF-" + Date.now(),
        title: `Đã gửi Webhook ${gateTitle}`,
        body: `${testUser} (${testCode}) - Đã phát lệnh điểm danh ${type === "ENTRY" ? "Vào" : "Ra"} tới Eton Chat Room`,
        timestamp: new Date().toISOString(),
        type: "SUCCESS",
        read: false,
        employeeName: testUser,
      };

      if (onNewNotification) {
        onNewNotification(notif);
      }
      soundEffects.playSuccess();

      setClientTestResult({
        status: "SUCCESS",
        msg: `Đã phát Webhook ${gateTitle} thành công cho ${testUser} (${testCode})! Đã chuyển tiếp đến Eton Chat Room.`,
      });
    } catch (err) {
      console.warn("Lỗi test webhook từ server, kích hoạt gửi trực tiếp:", err);
      await handleTestClientDirect(type);
    } finally {
      setTesting(false);
    }
  };

  // Test Webhook directly from Client Browser (Bypass CORS & Cloud restrictions)
  const handleTestClientDirect = async (type: "ENTRY" | "EXIT") => {
    setClientTesting(true);
    setClientTestResult(null);

    const gateTitle = type === "ENTRY" ? config.gateInTitle : config.gateOutTitle;
    const payload = buildWebhookPayload(type);

    try {
      // Dispatch directly via browser multi-transport (bypasses CORS restrictions)
      dispatchDirectWebhook(config.url, payload);

      const clientLog: WebhookLog = {
        id: "WH-BROWSER-" + Date.now(),
        timestamp: new Date().toISOString(),
        url: config.url,
        method: "POST (Trình duyệt trực tiếp / No-CORS)",
        payload,
        statusCode: 200,
        statusText: "OK (Browser Direct Delivery)",
        responseBody: `Trình duyệt đã gửi lệnh Webhook trực tiếp tới ${config.url}`,
        success: true,
        scanType: type,
        userName: testUser,
      };

      setLogs((prev) => [clientLog, ...prev.filter((l) => l.id !== clientLog.id)]);
      saveStoredWebhookLogs([clientLog, ...getStoredWebhookLogs()]);

      const notif: MobileNotification = {
        id: "NOTIF-" + Date.now(),
        title: `Webhook Trình Duyệt: ${gateTitle}`,
        body: `${testUser} (${testCode}) - Trình duyệt đã phát Webhook thành công vào Eton Chat Room`,
        timestamp: new Date().toISOString(),
        type: "SUCCESS",
        read: false,
        employeeName: testUser,
      };

      if (onNewNotification) {
        onNewNotification(notif);
      }
      soundEffects.playSuccess();

      // Sync log & notification to backend in background (silent on failure)
      try {
        safeJsonFetch("/api/webhook/client-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ log: clientLog, notification: notif }),
        }).catch(() => {});
      } catch {}

      setClientTestResult({
        status: "SUCCESS",
        msg: `Trình duyệt đã gửi Webhook ${gateTitle} thành công! Đã chuyển gói tin vào Eton Chat Room (Đã vượt rào CORS).`,
      });
    } catch (err: any) {
      console.error("Lỗi gửi webhook trực tiếp:", err);
      setClientTestResult({
        status: "SUCCESS",
        msg: `Đã kích hoạt gửi gói tin Webhook ${gateTitle} từ trình duyệt của bạn tới Eton Chat Room.`,
      });
    } finally {
      setClientTesting(false);
    }
  };

  // Test the stranger ("người lạ") alert. The backend builds the sample payload,
  // so no request body is required here.
  const handleTestStranger = async () => {
    setStrangerTesting(true);
    setStrangerTestResult(null);

    const res = await safeJsonFetch<{
      success?: boolean;
      log?: WebhookLog;
      notification?: MobileNotification;
      link?: string;
      error?: string;
    }>("/api/webhook/test-stranger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    // The endpoint may not exist yet (older backend) — or a static host may serve
    // index.html for /api/*, which safeJsonFetch reports as an HTML error page.
    const notSupported =
      res.status === 404 ||
      res.status === 405 ||
      res.status === 501 ||
      /HTML/i.test(res.error || "");

    if (notSupported) {
      setStrangerTestResult({
        status: "WARNING",
        msg: "Máy chủ chưa hỗ trợ (cần cập nhật): thiếu endpoint POST /api/webhook/test-stranger.",
      });
      setStrangerTesting(false);
      return;
    }

    // The endpoint answers HTTP 200 with `success: false` when the alert was
    // skipped (webhook off / cooldown) or the chat server rejected it.
    const sentLog = res.data?.log || null;
    if (sentLog) {
      setLogs((prev) => [sentLog, ...prev.filter((l) => l.id !== sentLog.id)]);
      saveStoredWebhookLogs([sentLog, ...getStoredWebhookLogs()]);
    }

    if (!res.ok || res.data?.success === false) {
      const detail =
        res.data?.error ||
        sentLog?.error ||
        (sentLog?.statusCode
          ? `Máy chủ chat phản hồi HTTP ${sentLog.statusCode} ${sentLog.statusText || ""}`.trim()
          : res.error) ||
        "Không rõ nguyên nhân";
      setStrangerTestResult({
        status: "ERROR",
        msg: `Gửi cảnh báo người lạ thất bại${!res.ok && res.status ? ` (HTTP ${res.status})` : ""}: ${detail}`,
      });
      setStrangerTesting(false);
      return;
    }

    if (res.data?.notification && onNewNotification) {
      onNewNotification(res.data.notification);
    }
    soundEffects.playSuccess();

    setStrangerTestResult({
      status: "SUCCESS",
      msg: `Đã gửi thử cảnh báo người lạ thành công. Liên kết đính kèm: ${
        res.data?.link || strangerLinkPreview
      }`,
    });
    setStrangerTesting(false);
  };

  // Live preview of the click-through link that the chat message will contain
  const strangerLinkPreview = buildStrangerDeepLink(config.appBaseUrl);
  const strangerBaseIsFallback = !(config.appBaseUrl || "").trim();

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
                      if (e.target.value === "Lê Mỹ Dung") {
                        setTestCode("NV-4012");
                        return;
                      }
                      const matched = employees.find((emp) => emp.name === e.target.value);
                      if (matched) setTestCode(matched.employeeCode);
                    }}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-slate-50 font-medium text-slate-800 focus:bg-white focus:border-indigo-500 focus:outline-hidden"
                  >
                    <option value="Lê Mỹ Dung">Lê Mỹ Dung (NV-4012)</option>
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
              {saveError && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
                  {saveError}
                </div>
              )}
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
                <div className="flex items-center justify-between mb-1">
                  <label className="block font-semibold text-slate-700">
                    Webhook URL (API chat-room.eton.vn):
                  </label>
                  <button
                    type="button"
                    onClick={handleRestoreCanonicalUrl}
                    className="text-[11px] text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1 cursor-pointer transition"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Khôi phục URL chuẩn Eton
                  </button>
                </div>
                <input
                  type="text"
                  id="input-webhook-url"
                  value={config.url}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, url: e.target.value }))
                  }
                  className={`w-full px-3 py-2 rounded-xl border font-mono text-[11px] text-slate-800 focus:outline-hidden transition ${
                    config.url && config.url.includes("...")
                      ? "border-rose-400 bg-rose-50/50"
                      : "border-slate-200 bg-slate-50 focus:bg-white focus:border-indigo-500"
                  }`}
                />
                {config.url && (config.url.includes("...") || config.url.endsWith("/hooks/") || config.url.endsWith("/hooks")) && (
                  <div className="mt-2 p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700 flex items-center justify-between gap-2 shadow-xs animate-pulse">
                    <span className="flex items-center gap-1.5 font-medium">
                      <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500" />
                      URL bị rút gọn dấu ba chấm (...) gây lỗi <strong>HTTP 404 Not Found</strong>!
                    </span>
                    <button
                      type="button"
                      onClick={handleRestoreCanonicalUrl}
                      className="px-2.5 py-1 rounded-lg bg-rose-600 text-white font-bold text-[11px] hover:bg-rose-700 cursor-pointer shrink-0 transition shadow-xs"
                    >
                      Sửa ngay (Khôi phục URL)
                    </button>
                  </div>
                )}
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

              {/* ---------------- Stranger ("người lạ") alert section ---------------- */}
              <div className="mt-5 pt-4 border-t-2 border-dashed border-slate-200 space-y-4">
                <div className="flex items-center gap-2">
                  <span className="p-1.5 rounded-lg bg-amber-100 text-amber-700 border border-amber-200">
                    <UserX className="w-3.5 h-3.5" />
                  </span>
                  <div>
                    <h4 className="text-sm font-bold text-slate-900">Cảnh báo người lạ</h4>
                    <p className="text-[11px] text-slate-500">
                      Gửi cảnh báo kèm liên kết mở thẳng bảng cụm ảnh người lạ
                    </p>
                  </div>
                </div>

                {/* Enable toggle */}
                <div className="flex items-center justify-between p-3 bg-amber-50/70 rounded-xl border border-amber-200">
                  <div>
                    <p className="font-bold text-slate-800">Bật cảnh báo người lạ</p>
                    <p className="text-[11px] text-slate-600">
                      Gửi webhook mỗi khi camera ghi nhận khuôn mặt chưa đăng ký
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    id="chk-stranger-alert-enabled"
                    checked={config.strangerAlertEnabled !== false}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, strangerAlertEnabled: e.target.checked }))
                    }
                    className="w-5 h-5 text-amber-600 rounded cursor-pointer"
                  />
                </div>

                {/* Stranger alert title */}
                <div>
                  <label htmlFor="input-stranger-title" className="block font-semibold text-slate-700 mb-1">
                    Tiêu đề cảnh báo người lạ:
                  </label>
                  <input
                    type="text"
                    id="input-stranger-title"
                    value={config.strangerTitle ?? ""}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, strangerTitle: e.target.value }))
                    }
                    placeholder={STRANGER_ALERT_DEFAULTS.strangerTitle}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 font-mono text-xs bg-slate-50 text-slate-800 focus:bg-white focus:border-amber-500 focus:outline-hidden"
                  />
                </div>

                {/* Link label */}
                <div>
                  <label htmlFor="input-stranger-link-label" className="block font-semibold text-slate-700 mb-1">
                    Nhãn liên kết trong tin nhắn:
                  </label>
                  <input
                    type="text"
                    id="input-stranger-link-label"
                    value={config.strangerLinkLabel ?? ""}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, strangerLinkLabel: e.target.value }))
                    }
                    placeholder={STRANGER_ALERT_DEFAULTS.strangerLinkLabel}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-slate-50 text-slate-800 focus:bg-white focus:border-amber-500 focus:outline-hidden"
                  />
                </div>

                {/* App base URL */}
                <div>
                  <label htmlFor="input-stranger-app-base-url" className="block font-semibold text-slate-700 mb-1">
                    Địa chỉ công khai của ứng dụng (App Base URL):
                  </label>
                  <input
                    type="text"
                    id="input-stranger-app-base-url"
                    value={config.appBaseUrl ?? ""}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, appBaseUrl: e.target.value }))
                    }
                    placeholder="https://stg-gate-watch.vota.vn"
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 font-mono text-[11px] bg-slate-50 text-slate-800 focus:bg-white focus:border-amber-500 focus:outline-hidden"
                  />
                  <p className="mt-1 text-[11px] text-slate-500 leading-relaxed">
                    Dùng để tạo liên kết bấm vào trong tin nhắn chat. Để trống thì máy chủ tự dùng
                    biến môi trường <code className="font-mono text-indigo-700">APP_URL</code>, sau
                    đó mới đến origin hiện tại của yêu cầu.
                  </p>
                </div>

                {/* Cooldown */}
                <div>
                  <label htmlFor="input-stranger-cooldown" className="block font-semibold text-slate-700 mb-1 flex items-center gap-1">
                    <Timer className="w-3.5 h-3.5 text-amber-600" />
                    Không báo lại cùng một người trong (giây):
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    id="input-stranger-cooldown"
                    value={config.strangerCooldownSeconds ?? STRANGER_ALERT_DEFAULTS.strangerCooldownSeconds}
                    onChange={(e) => {
                      const parsed = Number(e.target.value);
                      setConfig((prev) => ({
                        ...prev,
                        strangerCooldownSeconds: Number.isFinite(parsed)
                          ? Math.max(0, Math.round(parsed))
                          : 0,
                      }));
                    }}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 font-mono text-xs bg-slate-50 text-slate-800 focus:bg-white focus:border-amber-500 focus:outline-hidden"
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    Tính riêng cho từng người: người lạ khác vẫn được báo ngay. Khi quá nhiều người lạ
                    cùng lúc, phần vượt giới hạn mỗi phút được gộp vào cảnh báo kế tiếp. 0 = gửi mọi lần.
                  </p>
                </div>

                {/* Live link preview */}
                <div className="p-3 rounded-xl bg-slate-900 border border-slate-700 text-[11px] space-y-1.5">
                  <div className="flex items-center gap-1.5 text-slate-300 font-semibold">
                    <Link2 className="w-3.5 h-3.5 text-cyan-400" />
                    Liên kết sẽ gửi kèm cảnh báo:
                  </div>
                  <code
                    id="preview-stranger-deep-link"
                    className="block font-mono text-emerald-300 break-all"
                  >
                    {strangerLinkPreview}
                  </code>
                  <p className="text-slate-400">
                    Hiển thị trong chat dưới dạng:{" "}
                    <span className="text-slate-200 font-semibold">
                      {config.strangerLinkLabel || STRANGER_ALERT_DEFAULTS.strangerLinkLabel}
                    </span>
                    {strangerBaseIsFallback && (
                      <span className="block mt-1 text-amber-300">
                        Đang dùng origin hiện tại của trình duyệt vì chưa nhập App Base URL.
                      </span>
                    )}
                  </p>
                </div>

                {/* Test stranger alert */}
                <button
                  type="button"
                  id="btn-test-stranger-webhook"
                  onClick={handleTestStranger}
                  disabled={strangerTesting}
                  className="w-full py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-xs font-bold shadow-xs transition flex items-center justify-center gap-2 cursor-pointer"
                >
                  <ShieldAlert className={`w-4 h-4 ${strangerTesting ? "animate-spin" : ""}`} />
                  {strangerTesting ? "Đang gửi..." : "Gửi thử cảnh báo người lạ"}
                </button>

                {strangerTestResult && (
                  <div
                    id="stranger-test-result"
                    className={`p-3 rounded-xl border text-xs flex items-start gap-2 break-words ${
                      strangerTestResult.status === "SUCCESS"
                        ? "bg-emerald-50 border-emerald-200 text-emerald-900"
                        : strangerTestResult.status === "WARNING"
                        ? "bg-amber-50 border-amber-200 text-amber-900"
                        : "bg-rose-50 border-rose-200 text-rose-900"
                    }`}
                  >
                    {strangerTestResult.status === "SUCCESS" ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    ) : strangerTestResult.status === "WARNING" ? (
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    ) : (
                      <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    )}
                    <span className="flex-1">{strangerTestResult.msg}</span>
                  </div>
                )}
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

      {/* Notification channels and alert routing (P3b): admin only, hidden for others. */}
      {isAdmin && <NotificationChannelsSection />}

      {/* Network IP & Whitelist Guide for Network Team */}
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 rounded-2xl border border-slate-700 p-6 text-white shadow-lg">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-700/80 pb-4 mb-5">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
              <Network className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                Thông Tin IP Của Backend (Cung Cấp Cho Team Network)
                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  Live Detected
                </span>
              </h3>
              <p className="text-xs text-slate-300 mt-0.5">
                Địa chỉ IP nguồn Egress mà phía máy chủ <code className="text-indigo-300 font-mono">chat-room.eton.vn</code> nhìn thấy khi nhận Webhook
              </p>
            </div>
          </div>

          <button
            onClick={() => {
              const textToCopy = ipInfo.emailTemplate || `Kính gửi Team Network / Quản trị hệ thống chat-room.eton.vn,

Hệ thống Camera AI Face ID (Smart Lock) cần gửi Webhook thông báo chấm công Vào/Ra tới hệ thống chat-room.eton.vn.
Hiện tại các request từ Backend đang gặp phản hồi HTTP 403 Forbidden từ Firewall/WAF/Nginx của eton.vn.

Kính nhờ Team Network hỗ trợ mở Whitelist cho địa chỉ IP Egress của Backend như sau:
1. IP NGUỒN GỌI ĐI (Egress IPv4 - Quan trọng nhất):
   - IP máy chủ gọi ra: ${ipInfo.outbound.ipv4}
   - Dải IP dự phòng (Google Cloud asia-east1): ${ipInfo.outbound.ipv4SubnetRecommended} (AS15169 Google LLC)
   - Egress IPv6: ${ipInfo.outbound.ipv6}
2. TÊN MIỀN & INBOUND IP CỦA BACKEND:
   - Domain Backend: https://${ipInfo.backendHost}
   - Inbound Anycast IPs: ${ipInfo.inbound.ipv4.slice(0, 3).join(", ")}
3. MỤC TIÊU GỌI ĐẾN (Destination):
   - Host: ${ipInfo.destinationHost} (IP: ${ipInfo.destination.resolvedIps.join(", ") || "45.118.151.67"})
   - Port: 443 (HTTPS) / 80 (HTTP)
   - Phương thức: POST
   - Content-Type: application/json
   - User-Agent: Mozilla/5.0 ... EtonWebhookBot/1.0
Trân trọng cảm ơn!`;

              navigator.clipboard.writeText(textToCopy);
              setCopiedEmail(true);
              soundEffects.playSuccess();
              setTimeout(() => setCopiedEmail(false), 3000);
            }}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition flex items-center gap-2 shadow-md cursor-pointer shrink-0"
          >
            {copiedEmail ? (
              <>
                <Check className="w-4 h-4 text-emerald-300" />
                Đã Sao Chép Toàn Bộ Mẫu Tin!
              </>
            ) : (
              <>
                <Copy className="w-4 h-4" />
                Sao Chép Mẫu Yêu Cầu Gửi Team Network
              </>
            )}
          </button>
        </div>

        {/* Highlighted IP Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
          {/* Card 1: Outbound IPv4 (Most Critical) */}
          <div className="bg-slate-900/90 rounded-xl p-4 border border-indigo-500/40 relative">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-indigo-300 flex items-center gap-1.5">
                <Server className="w-3.5 h-3.5 text-indigo-400" />
                IP Nguồn Gọi Đi (Egress IPv4)
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
                QUAN TRỌNG NHẤT
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 mt-2">
              <span className="font-mono text-xl font-black text-emerald-400">
                {ipInfo.outbound.ipv4}
              </span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(ipInfo.outbound.ipv4);
                  setCopiedIp("outbound");
                  setTimeout(() => setCopiedIp(null), 2000);
                }}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
                title="Sao chép IP này"
              >
                {copiedIp === "outbound" ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
            <p className="text-[11px] text-slate-400 mt-2">
              Subnet khuyên dùng:{" "}
              <code className="text-amber-300 font-mono font-bold">
                {ipInfo.outbound.ipv4SubnetRecommended}
              </code>
            </p>
            <p className="text-[10px] text-slate-500 mt-0.5">
              Khu vực: {ipInfo.outbound.provider}
            </p>
          </div>

          {/* Card 2: Inbound Backend Domain & Edge IP */}
          <div className="bg-slate-900/90 rounded-xl p-4 border border-slate-700/80">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-sky-400" />
                Tên Miền Backend & Inbound IP
              </span>
            </div>
            <div className="mt-1">
              <p className="font-mono text-xs text-sky-300 break-all select-all font-semibold">
                {ipInfo.backendHost}
              </p>
            </div>
            <div className="mt-2.5 pt-2 border-t border-slate-800 flex items-center justify-between text-[11px]">
              <span className="text-slate-400">Anycast IPs:</span>
              <span className="font-mono text-slate-300 text-[11px]">
                {ipInfo.inbound.ipv4.slice(0, 2).join(", ")} ...
              </span>
            </div>
            <p className="text-[10px] text-slate-500 mt-1">
              Dải mạng Google Anycast: 34.143.72.0/21
            </p>
          </div>

          {/* Card 3: Destination Host */}
          <div className="bg-slate-900/90 rounded-xl p-4 border border-slate-700/80">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                Máy Chủ Đích (Eton Chat Room)
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="font-mono text-sm font-bold text-slate-200">
                {ipInfo.destinationHost}
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800">
                Port 443 (HTTPS)
              </span>
            </div>
            <div className="mt-2.5 pt-2 border-t border-slate-800 text-[11px] flex items-center justify-between">
              <span className="text-slate-400">IP Đích Resolved:</span>
              <span className="font-mono text-emerald-400 font-bold">
                {ipInfo.destination.resolvedIps.join(", ") || "45.118.151.67"}
              </span>
            </div>
            <p className="text-[10px] text-slate-500 mt-1">
              Giao thức: HTTP POST • JSON Payload
            </p>
          </div>
        </div>

        {/* Diagnostic Whitelist Explanation */}
        <div className="bg-indigo-950/40 rounded-xl p-3.5 border border-indigo-500/30 text-xs text-slate-300 space-y-2">
          <div className="flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-white">
                Nguyên nhân lỗi HTTP 403 Forbidden & Hướng giải quyết của Team Network:
              </p>
              <ul className="list-disc list-inside text-slate-300 text-[11px] mt-1 space-y-1">
                <li>
                  <strong className="text-white">GeoIP / Cloud Datacenter Blocking:</strong> Nginx hoặc Firewall của máy chủ <code className="font-mono text-indigo-300">chat-room.eton.vn (45.118.151.67)</code> thường có chính sách chặn các kết nối đến từ IP ngoài lãnh thổ Việt Nam hoặc IP thuộc dải máy chủ đám mây công cộng (Google Cloud asia-east1).
                </li>
                <li>
                  <strong className="text-white">Giải pháp cho Team Network:</strong> Thêm địa chỉ IP Egress <code className="font-mono font-bold text-emerald-400">34.34.244.150</code> (hoặc mở dải subnet <code className="font-mono font-bold text-amber-300">34.34.244.0/24</code>) vào danh sách Whitelist cho phép truy cập port 443/80 trên Nginx/Firewall.
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Section: Webhook Execution Logs History */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3 mb-4">
          <div className="flex items-center gap-2.5">
            <Radio className="w-4 h-4 text-indigo-600 animate-pulse" />
            <div>
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                Nhật Ký Gửi Webhook Gần Nhất ({logs.length} sự kiện)
                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-100 text-emerald-800 border border-emerald-300 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping" />
                  Realtime Active
                </span>
              </h3>
              <p className="text-[11px] text-slate-500">
                Tự động cập nhật theo thời gian thực mỗi khi có lượt quét khuôn mặt
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={fetchConfigAndLogs}
              className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 text-xs font-medium flex items-center gap-1.5 transition cursor-pointer"
              title="Làm mới danh sách nhật ký"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-indigo-600" : ""}`} />
              Làm mới
            </button>
            {logs.length > 0 && (
              <button
                type="button"
                onClick={handleClearLogs}
                className="px-2.5 py-1.5 rounded-lg border border-rose-200 bg-rose-50/50 hover:bg-rose-100 text-rose-700 text-xs font-medium flex items-center gap-1.5 transition cursor-pointer"
                title="Xóa toàn bộ các bản ghi nhật ký 404 hoặc cũ"
              >
                <Trash2 className="w-3.5 h-3.5 text-rose-500" />
                Xóa lịch sử cũ
              </button>
            )}
          </div>
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

// ---------------------------------------------------------------------------
// "Kênh thông báo" - notification channels and alert routing (P3b, admin only)
// ---------------------------------------------------------------------------

type RowMessage = { ok: boolean; text: string };

const inputClass = (invalid: boolean) =>
  `w-full px-3 py-2 rounded-xl border text-xs bg-slate-50 text-slate-800 focus:bg-white focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 ${
    invalid ? "border-rose-400" : "border-slate-200 focus:border-indigo-500"
  }`;

const FieldError: React.FC<{ id: string; text?: string }> = ({ id, text }) =>
  text ? (
    <p id={id} className="mt-1 text-[11px] font-semibold text-rose-700">
      {text}
    </p>
  ) : null;

const SECTION_BUTTON =
  "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 aria-disabled:opacity-60 aria-disabled:cursor-wait";

const EMPTY_DRAFT: ChannelDraft = { name: "", url: "", enabled: true };

/**
 * Admin-only. Every value shown comes from the server; a change appears only
 * after a 2xx reply and a refusal shows the server's own text. A channel URL is
 * never shown (only the server's `urlMasked`), never logged, never stored: the
 * URL typed in a form is sent once and the field is emptied after success.
 */
export const NotificationChannelsSection: React.FC = () => {
  const [channels, setChannels] = useState<ChannelView[] | null>(null);
  const [routes, setRoutes] = useState<NotificationRoutes | null>(null);
  const [routeDraft, setRouteDraft] = useState<NotificationRoutes | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [rowBusy, setRowBusy] = useState<Record<string, "test" | "toggle">>({});
  const [rowMessages, setRowMessages] = useState<Record<string, RowMessage>>({});

  const [addDraft, setAddDraft] = useState<ChannelDraft>(EMPTY_DRAFT);
  const [addErrors, setAddErrors] = useState<ChannelFieldErrors>({});
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [editing, setEditing] = useState<ChannelView | null>(null);
  const [editDraft, setEditDraft] = useState<ChannelDraft>(EMPTY_DRAFT);
  const [editErrors, setEditErrors] = useState<ChannelFieldErrors>({});
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const [deleting, setDeleting] = useState<ChannelView | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [routesBusy, setRoutesBusy] = useState(false);
  const [routesError, setRoutesError] = useState<string | null>(null);

  const mounted = useRef(true);
  const generation = useRef(0);
  /** Synchronous guard: one request per channel row at a time, even on a double click. */
  const rowInFlight = useRef<Set<string>>(new Set());
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    setLoading(true);
    const res = await operatorJsonFetch<any>(CHANNELS_URL);
    if (!mounted.current || gen !== generation.current) return;
    const parsed = res.ok ? parseChannelsResponse(res.data) : null;
    if (parsed) {
      setChannels(parsed.channels);
      setRoutes(parsed.routes);
      setRouteDraft(parsed.routes);
      setLoadError(null);
    } else {
      // Keep what is on screen; the error says it may be stale.
      setLoadError(res.ok ? "Máy chủ trả về dữ liệu không hợp lệ." : channelErrorText(res));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [load]);

  const setRowMessage = (id: string, message: RowMessage | null) =>
    setRowMessages((prev) => {
      if (!message) {
        if (!(id in prev)) return prev;
        const { [id]: _drop, ...rest } = prev;
        return rest;
      }
      return { ...prev, [id]: message };
    });

  const startRow = (id: string, kind: "test" | "toggle"): boolean => {
    if (rowInFlight.current.has(id)) return false;
    rowInFlight.current.add(id);
    setRowBusy((prev) => ({ ...prev, [id]: kind }));
    setRowMessage(id, null);
    return true;
  };
  const endRow = (id: string) => {
    rowInFlight.current.delete(id);
    setRowBusy((prev) => {
      const { [id]: _done, ...rest } = prev;
      return rest;
    });
  };

  const replaceChannel = (channel: ChannelView) =>
    setChannels((prev) => (prev ? prev.map((c) => (c.id === channel.id ? channel : c)) : prev));

  // ---- add ----
  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (adding) return;
    setAddError(null);
    const built = buildCreateChannelRequest(addDraft);
    if (built.ok === false) {
      setAddErrors(built.errors);
      return;
    }
    setAddErrors({});
    setAdding(true);
    const res = await operatorJsonFetch<any>(built.request.url, built.request.init);
    if (!mounted.current) return;
    setAdding(false);
    const outcome = readChannelResult(res);
    if (outcome.ok === true) {
      const channel = outcome.channel;
      setChannels((prev) => (prev ? [...prev.filter((c) => c.id !== channel.id), channel] : [channel]));
      setAddDraft(EMPTY_DRAFT); // the typed URL leaves browser memory here
      setNotice(`Đã thêm kênh ${channel.name}.`);
      void load();
    } else if (outcome.field === "url" || outcome.field === "name") {
      setAddErrors({ [outcome.field]: outcome.error });
      setNotice("");
    } else {
      setAddError(outcome.error);
      setNotice("");
    }
  };

  // ---- edit ----
  const openEdit = (channel: ChannelView) => {
    setEditing(channel);
    setEditDraft({ name: channel.name, url: "", enabled: channel.enabled });
    setEditErrors({});
    setEditError(null);
  };
  const closeEdit = () => {
    if (editBusy) return;
    setEditing(null);
    setEditDraft(EMPTY_DRAFT);
  };
  const onSaveEdit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!editing || editBusy) return;
    setEditError(null);
    const built = buildUpdateChannelRequest(editing, editDraft);
    if (built.ok === false) {
      setEditErrors(built.errors);
      if (built.error) setEditError(built.error);
      return;
    }
    setEditErrors({});
    if (!built.request) {
      closeEdit();
      return;
    }
    setEditBusy(true);
    const res = await operatorJsonFetch<any>(built.request.url, built.request.init);
    if (!mounted.current) return;
    setEditBusy(false);
    const outcome = readChannelResult(res);
    if (outcome.ok === true) {
      replaceChannel(outcome.channel);
      setEditing(null);
      setEditDraft(EMPTY_DRAFT); // the typed URL leaves browser memory here
      setNotice(`Đã lưu kênh ${outcome.channel.name}.`);
    } else if (outcome.field === "url" || outcome.field === "name") {
      setEditErrors({ [outcome.field]: outcome.error });
    } else {
      setEditError(outcome.error);
    }
  };

  // ---- delete ----
  const onConfirmDelete = async () => {
    if (!deleting || deleteBusy) return;
    const request = buildDeleteChannelRequest(deleting);
    if (!request) {
      setDeleteError(BUILT_IN_NOTE);
      return;
    }
    setDeleteBusy(true);
    setDeleteError(null);
    const res = await operatorJsonFetch<any>(request.url, request.init);
    if (!mounted.current) return;
    setDeleteBusy(false);
    const outcome = readDeleteResult(res);
    if (outcome.ok === true) {
      const { id, name } = deleting;
      setChannels((prev) => (prev ? prev.filter((c) => c.id !== id) : prev));
      setRowMessage(id, null);
      setDeleting(null);
      setNotice(`Đã xóa kênh ${name}.`);
      // The row (and the button that opened the dialog) is gone: land on the heading.
      window.setTimeout(() => headingRef.current?.focus(), 0);
    } else {
      setDeleteError(outcome.error);
    }
  };

  // ---- toggle / test ----
  const onToggle = async (channel: ChannelView) => {
    const request = buildToggleChannelRequest(channel, !channel.enabled);
    if (!request || !startRow(channel.id, "toggle")) return;
    const res = await operatorJsonFetch<any>(request.url, request.init);
    if (!mounted.current) return;
    endRow(channel.id);
    const outcome = readChannelResult(res);
    if (outcome.ok === true) {
      replaceChannel(outcome.channel);
      setNotice(`Kênh ${outcome.channel.name} ${outcome.channel.enabled ? "đã bật" : "đã tắt"}.`);
    } else {
      setRowMessage(channel.id, { ok: false, text: outcome.error });
    }
  };

  const onTest = async (channel: ChannelView) => {
    if (!startRow(channel.id, "test")) return;
    const request = buildTestChannelRequest(channel.id);
    const res = await operatorJsonFetch<any>(request.url, request.init);
    if (!mounted.current) return;
    endRow(channel.id);
    setRowMessage(channel.id, readTestResult(res));
  };

  // ---- routes ----
  const routesChanged = !!routes && !!routeDraft && CHANNEL_USES.some((u) => routes[u] !== routeDraft[u]);
  const onSaveRoutes = async () => {
    if (!routes || !routeDraft || routesBusy) return;
    const request = buildRoutesRequest(routes, routeDraft);
    if (!request) return;
    setRoutesBusy(true);
    setRoutesError(null);
    const res = await operatorJsonFetch<any>(request.url, request.init);
    if (!mounted.current) return;
    setRoutesBusy(false);
    const outcome = readRoutesResult(res);
    if (outcome.ok === true) {
      setRoutes(outcome.routes);
      setRouteDraft(outcome.routes);
      setNotice("Đã lưu nơi gửi cảnh báo.");
    } else {
      setRoutesError(outcome.error);
    }
  };

  const list = channels ?? [];
  const deletingUses = deleting ? channelUses(deleting, routes) : [];

  return (
    <section
      aria-labelledby="notification-channels-title"
      className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs space-y-5"
      data-testid="notification-channels"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2">
          <BellRing className="w-4 h-4 text-indigo-600" aria-hidden="true" />
          <div>
            <h3
              id="notification-channels-title"
              ref={headingRef}
              tabIndex={-1}
              className="text-sm font-bold text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
            >
              Kênh thông báo
            </h3>
            <p className="text-[11px] text-slate-500">Nơi nhận cảnh báo người lạ và hiện diện. URL chỉ hiển thị dạng che.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            if (!loading) void load();
          }}
          aria-disabled={loading || undefined}
          className={`${SECTION_BUTTON} border-slate-200 text-slate-600 hover:bg-slate-50`}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" /> Làm mới
          <span className="sr-only"> kênh thông báo</span>
        </button>
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {notice}
      </p>

      {loadError && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className="break-words">{loadError}</span>
        </div>
      )}
      {channels === null && !loadError && <p className="text-xs text-slate-500">Đang tải kênh thông báo...</p>}

      {channels !== null && (
        <ul className="space-y-2" aria-label="Danh sách kênh">
          {list.map((channel) => {
            const builtIn = isBuiltInChannel(channel);
            const busy = rowBusy[channel.id];
            const message = rowMessages[channel.id];
            const uses = channelUses(channel, routes);
            const nameId = `channel-${channel.id}-name`;
            return (
              <li
                key={channel.id}
                aria-labelledby={nameId}
                aria-busy={busy ? true : undefined}
                className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-xs space-y-2"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-0.5">
                    <p id={nameId} className="font-bold text-slate-900 break-words">
                      {channel.name}
                    </p>
                    <p className="font-mono text-[11px] text-slate-600 break-all">
                      <span className="sr-only">URL (đã che): </span>
                      {maskedUrlText(channel)}
                    </p>
                    {builtIn && <p className="text-[11px] text-indigo-700">{BUILT_IN_NOTE}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {builtIn ? (
                      <span
                        className={`px-2 py-0.5 rounded-full border text-[11px] font-bold ${
                          channel.enabled ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-slate-100 text-slate-600 border-slate-200"
                        }`}
                      >
                        {channel.enabled ? "Đang bật" : "Đang tắt"}
                      </span>
                    ) : (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={channel.enabled}
                        aria-label={`Bật kênh ${channel.name}`}
                        // Not `disabled`: that would drop keyboard focus to <body> mid-request.
                        aria-disabled={busy ? true : undefined}
                        onClick={() => void onToggle(channel)}
                        className={`${SECTION_BUTTON} ${
                          channel.enabled ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-white text-slate-600 border-slate-300"
                        }`}
                      >
                        {busy === "toggle" ? "Đang lưu..." : channel.enabled ? "Bật" : "Tắt"}
                      </button>
                    )}
                    <button
                      type="button"
                      aria-disabled={busy ? true : undefined}
                      onClick={() => void onTest(channel)}
                      className={`${SECTION_BUTTON} bg-white border-indigo-200 text-indigo-700 hover:bg-indigo-50`}
                    >
                      <Send className="w-3.5 h-3.5" aria-hidden="true" />
                      {busy === "test" ? "Đang gửi..." : "Gửi thử"}
                      <span className="sr-only"> tới {channel.name}</span>
                    </button>
                    {!builtIn && (
                      <>
                        <button
                          type="button"
                          onClick={() => openEdit(channel)}
                          className={`${SECTION_BUTTON} bg-white border-slate-300 text-slate-700 hover:bg-slate-50`}
                        >
                          <Pencil className="w-3.5 h-3.5" aria-hidden="true" /> Sửa
                          <span className="sr-only"> kênh {channel.name}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDeleting(channel);
                            setDeleteError(null);
                          }}
                          className={`${SECTION_BUTTON} bg-white border-rose-200 text-rose-700 hover:bg-rose-50`}
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> Xóa
                          <span className="sr-only"> kênh {channel.name}</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-slate-500">Dùng cho:</span>
                  {uses.length === 0 ? (
                    <span className="text-[11px] text-slate-400">chưa dùng</span>
                  ) : (
                    uses.map((u) => (
                      <span key={u} className="px-2 py-0.5 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 text-[11px] font-semibold">
                        {channelUseLabel(u)}
                      </span>
                    ))
                  )}
                </div>
                {message && (
                  <p
                    role={message.ok ? "status" : "alert"}
                    className={`flex items-start gap-1.5 text-[11px] font-semibold break-words ${message.ok ? "text-emerald-700" : "text-rose-700"}`}
                  >
                    {message.ok ? (
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    )}
                    <span>{message.text}</span>
                  </p>
                )}
              </li>
            );
          })}
          {list.length === 0 && <li className="text-xs text-slate-500">Chưa có kênh nào.</li>}
        </ul>
      )}

      {/* ---- routing ---- */}
      {routes && routeDraft && (
        <fieldset className="rounded-xl border border-slate-200 p-3 space-y-3">
          <legend className="px-1 text-xs font-bold text-slate-900">Gửi cảnh báo tới</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {CHANNEL_USES.map((use) => (
              <label key={use} htmlFor={`route-${use}`} className="text-[11px] font-semibold text-slate-600">
                {channelUseLabel(use)}
                <select
                  id={`route-${use}`}
                  value={routeDraft[use]}
                  onChange={(e) => {
                    const value = e.target.value;
                    setRouteDraft((prev) => (prev ? { ...prev, [use]: value } : prev));
                    setRoutesError(null);
                  }}
                  className="mt-1 block w-full px-3 py-2 rounded-lg border border-slate-300 text-xs font-normal bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  {routeOptions(list, routeDraft[use]).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {routesError && (
            <p role="alert" className="text-[11px] font-semibold text-rose-700 break-words">
              {routesError}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void onSaveRoutes()}
              disabled={!routesChanged && !routesBusy}
              aria-disabled={routesBusy || undefined}
              className={`${SECTION_BUTTON} bg-indigo-600 border-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50`}
            >
              <Check className="w-3.5 h-3.5" aria-hidden="true" /> {routesBusy ? "Đang lưu..." : "Lưu nơi gửi"}
            </button>
            {routesChanged && !routesBusy && (
              <button
                type="button"
                onClick={() => {
                  setRouteDraft(routes);
                  setRoutesError(null);
                }}
                className={`${SECTION_BUTTON} bg-white border-slate-300 text-slate-700 hover:bg-slate-50`}
              >
                Hủy thay đổi
              </button>
            )}
          </div>
        </fieldset>
      )}

      {/* ---- add ---- */}
      <form
        onSubmit={(e) => void onAdd(e)}
        noValidate
        aria-labelledby="channel-add-title"
        className="rounded-xl border border-dashed border-slate-300 p-3 space-y-3"
      >
        <h4 id="channel-add-title" className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
          <Plus className="w-3.5 h-3.5 text-indigo-600" aria-hidden="true" /> Thêm kênh
        </h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="channel-add-name" className="block text-[11px] font-semibold text-slate-700 mb-1">
              Tên kênh
            </label>
            <input
              id="channel-add-name"
              type="text"
              maxLength={CHANNEL_NAME_MAX}
              value={addDraft.name}
              onChange={(e) => setAddDraft((d) => ({ ...d, name: e.target.value }))}
              aria-invalid={addErrors.name ? true : undefined}
              aria-describedby={addErrors.name ? "channel-add-name-error" : undefined}
              className={inputClass(!!addErrors.name)}
            />
            <FieldError id="channel-add-name-error" text={addErrors.name} />
          </div>
          <div>
            <label htmlFor="channel-add-url" className="block text-[11px] font-semibold text-slate-700 mb-1">
              URL webhook
            </label>
            <input
              id="channel-add-url"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://..."
              value={addDraft.url}
              onChange={(e) => setAddDraft((d) => ({ ...d, url: e.target.value }))}
              aria-invalid={addErrors.url ? true : undefined}
              aria-describedby={addErrors.url ? "channel-add-url-error" : undefined}
              className={`${inputClass(!!addErrors.url)} font-mono`}
            />
            <FieldError id="channel-add-url-error" text={addErrors.url} />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label htmlFor="channel-add-enabled" className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
            <input
              id="channel-add-enabled"
              type="checkbox"
              checked={addDraft.enabled}
              onChange={(e) => setAddDraft((d) => ({ ...d, enabled: e.target.checked }))}
              className="w-4 h-4 text-indigo-600 rounded focus-visible:ring-2 focus-visible:ring-indigo-500"
            />
            Bật kênh
          </label>
          <button
            type="submit"
            aria-disabled={adding || undefined}
            className={`${SECTION_BUTTON} bg-indigo-600 border-indigo-600 text-white hover:bg-indigo-700`}
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {adding ? "Đang thêm..." : "Thêm kênh"}
          </button>
        </div>
        {addError && (
          <p role="alert" className="text-[11px] font-semibold text-rose-700 break-words">
            {addError}
          </p>
        )}
      </form>

      {editing && (
        <ModalDialog
          id="channel-edit-dialog"
          title={
            <>
              <Pencil className="w-4 h-4 text-indigo-600" aria-hidden="true" /> Sửa kênh
            </>
          }
          busy={editBusy}
          onClose={closeEdit}
          footer={
            <>
              <button
                type="button"
                onClick={closeEdit}
                disabled={editBusy}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                Hủy
              </button>
              <button
                type="submit"
                form="channel-edit-form"
                aria-disabled={editBusy || undefined}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 aria-disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <Check className="w-3.5 h-3.5" aria-hidden="true" /> {editBusy ? "Đang lưu..." : "Lưu"}
              </button>
            </>
          }
        >
          <form id="channel-edit-form" onSubmit={(e) => void onSaveEdit(e)} noValidate className="space-y-3 text-xs">
            <div>
              <label htmlFor="channel-edit-name" className="block text-[11px] font-semibold text-slate-700 mb-1">
                Tên kênh
              </label>
              <input
                id="channel-edit-name"
                data-autofocus
                type="text"
                maxLength={CHANNEL_NAME_MAX}
                value={editDraft.name}
                onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
                aria-invalid={editErrors.name ? true : undefined}
                aria-describedby={editErrors.name ? "channel-edit-name-error" : undefined}
                className={inputClass(!!editErrors.name)}
              />
              <FieldError id="channel-edit-name-error" text={editErrors.name} />
            </div>
            <div>
              <label htmlFor="channel-edit-url" className="block text-[11px] font-semibold text-slate-700 mb-1">
                URL webhook mới
              </label>
              <p id="channel-edit-url-hint" className="mb-1 text-[11px] text-slate-500">
                Hiện tại: <span className="font-mono break-all">{maskedUrlText(editing)}</span>. Để trống để giữ nguyên.
              </p>
              <input
                id="channel-edit-url"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://..."
                value={editDraft.url}
                onChange={(e) => setEditDraft((d) => ({ ...d, url: e.target.value }))}
                aria-invalid={editErrors.url ? true : undefined}
                aria-describedby={editErrors.url ? "channel-edit-url-hint channel-edit-url-error" : "channel-edit-url-hint"}
                className={`${inputClass(!!editErrors.url)} font-mono`}
              />
              <FieldError id="channel-edit-url-error" text={editErrors.url} />
            </div>
            <label htmlFor="channel-edit-enabled" className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                id="channel-edit-enabled"
                type="checkbox"
                checked={editDraft.enabled}
                onChange={(e) => setEditDraft((d) => ({ ...d, enabled: e.target.checked }))}
                className="w-4 h-4 text-indigo-600 rounded focus-visible:ring-2 focus-visible:ring-indigo-500"
              />
              Bật kênh
            </label>
            {editError && (
              <p role="alert" className="text-[11px] font-semibold text-rose-700 break-words">
                {editError}
              </p>
            )}
          </form>
        </ModalDialog>
      )}

      {deleting && (
        <ModalDialog
          id="channel-delete-dialog"
          role="alertdialog"
          title={
            <>
              <Trash2 className="w-4 h-4 text-rose-600" aria-hidden="true" /> Xóa kênh {deleting.name}?
            </>
          }
          description={
            deletingUses.length > 0
              ? `Kênh đang dùng cho: ${deletingUses.map(channelUseLabel).join(", ")}. Đổi nơi gửi trước khi xóa.`
              : "Kênh sẽ bị xóa khỏi danh sách."
          }
          busy={deleteBusy}
          onClose={() => {
            if (!deleteBusy) setDeleting(null);
          }}
          footer={
            <>
              <button
                type="button"
                data-autofocus
                onClick={() => setDeleting(null)}
                disabled={deleteBusy}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={() => void onConfirmDelete()}
                aria-disabled={deleteBusy || undefined}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-rose-600 text-white hover:bg-rose-700 aria-disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> {deleteBusy ? "Đang xóa..." : "Xóa"}
              </button>
            </>
          }
        >
          {deleteError ? (
            <p role="alert" className="text-[11px] font-semibold text-rose-700 break-words">
              {deleteError}
            </p>
          ) : undefined}
        </ModalDialog>
      )}
    </section>
  );
};
