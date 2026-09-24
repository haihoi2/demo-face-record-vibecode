import React, { useState, useEffect, useCallback } from "react";
import { Navbar, NavTabType } from "./components/Navbar";
import { FaceScanner } from "./components/FaceScanner";
import { CameraDashboard } from "./components/CameraDashboard";
import { SmartLockCard } from "./components/SmartLockCard";
import { EmployeeRegistration } from "./components/EmployeeRegistration";
import { AccessLogs } from "./components/AccessLogs";
import { MobileCompanion } from "./components/MobileCompanion";
import { WebhookIntegration } from "./components/WebhookIntegration";
import { AiConfigPage } from "./components/AiConfigPage";
import { DoorConfigPage } from "./components/DoorConfigPage";
import { CameraStreamConfigPage } from "./components/CameraStreamConfigPage";
import { StrangerClusterModal } from "./components/StrangerClusterModal";
import {
  Employee,
  AccessLog,
  SmartLockState,
  MobileNotification,
  FaceRecognitionResult,
  STRANGER_DEEP_LINK_HASH,
} from "./types";
import { Bell, CheckCircle2, AlertTriangle, Sparkles, X, Code2, Copy, Check, Camera, ScanFace } from "lucide-react";
import { soundEffects } from "./utils/audio";
import { safeJsonFetch, operatorJsonFetch, normalizeApiUrl, getApiBaseUrl, getCustomBackendUrl, setCustomBackendUrl } from "./utils/api";
import { OperatorSessionBar } from "./components/OperatorSessionBar";
import {
  isNetlifyOrStaticHost,
  getStoredEmployees,
  saveStoredEmployees,
  getStoredLogs,
  saveStoredLogs,
  clearLegacyProtectedLogCache,
  getStoredLockState,
  saveStoredLockState,
  getStoredNotifications,
  saveStoredNotifications,
  clientDoorUnlock,
  clientEventBus,
  demoOfflinePersistenceEnabled,
} from "./utils/offlineEngine";

/**
 * Minimal hash deep-link support (no router). Only two shapes are recognised:
 *   #strangers            -> open the stranger-cluster panel
 *   #strangers/<logId>    -> open it with the cluster holding that sighting selected
 * plus a few optional aliases that jump straight to an existing tab.
 */
const HASH_TAB_ALIASES: Record<string, NavTabType> = {
  "camera-streams": "cameras",
  cameras: "cameras",
  scanner: "scanner",
  manual: "manual",
  register: "register",
  logs: "logs",
  mobile: "mobile",
  webhook: "webhook",
  door: "door",
  config: "config",
};

/** Normalizes `#/strangers/LOG-1%20/` -> `strangers/LOG-1`. */
function normalizeHash(rawHash: string): string {
  let hash = (rawHash || "").trim();
  if (hash.startsWith("#")) hash = hash.slice(1);
  // Tolerate hash-router style "#/strangers"
  hash = hash.replace(/^\/+/, "").replace(/\/+$/, "");
  // Ignore any query-string appended to the hash
  const queryIndex = hash.indexOf("?");
  if (queryIndex >= 0) hash = hash.slice(0, queryIndex);
  return hash;
}

function parseStrangerDeepLink(rawHash: string): { open: boolean; logId: string | null } {
  const hash = normalizeHash(rawHash);
  if (!hash) return { open: false, logId: null };
  const segments = hash.split("/");
  if (segments[0].toLowerCase() !== STRANGER_DEEP_LINK_HASH) {
    return { open: false, logId: null };
  }
  const rawId = segments.slice(1).join("/");
  if (!rawId) return { open: true, logId: null };
  let logId = rawId;
  try {
    logId = decodeURIComponent(rawId);
  } catch {
    // Malformed percent-encoding: keep the raw segment rather than crashing.
  }
  logId = logId.trim();
  return { open: true, logId: logId || null };
}

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTabType>("scanner");

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [accessLogs, setAccessLogs] = useState<AccessLog[]>([]);
  const [notifications, setNotifications] = useState<MobileNotification[]>([]);
  const [lockState, setLockState] = useState<SmartLockState>({
    lockId: "SL-HQ-01",
    doorName: "Cửa Chính Trụ Sở - Cổng A",
    state: "LOCKED",
    isLocked: true,
    batteryLevel: 96,
    signalDbm: -54,
    firmwareVersion: "v2.5.8-Zigbee/IP",
    lastActionAt: new Date().toISOString(),
    lastActionBy: "Khởi động hệ thống",
    autoRelockSeconds: 6,
    remainingRelockSeconds: 0,
    status: "ONLINE",
  });

  const [sseConnected, setSseConnected] = useState<boolean>(false);
  const [latestToast, setLatestToast] = useState<MobileNotification | null>(null);
  const [showDeploymentGuide, setShowDeploymentGuide] = useState<boolean>(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [customBackendInput, setCustomBackendInput] = useState<string>(getCustomBackendUrl());
  const [pingStatus, setPingStatus] = useState<{ testing: boolean; success?: boolean; message?: string } | null>(null);
  const [isStrangerModalOpen, setIsStrangerModalOpen] = useState<boolean>(false);
  const [preselectedStrangerPhoto, setPreselectedStrangerPhoto] = useState<string | null>(null);
  const [preselectedStrangerLogId, setPreselectedStrangerLogId] = useState<string | null>(null);

  const handleOpenStrangerModal = (photo?: string) => {
    setPreselectedStrangerPhoto(photo || null);
    setPreselectedStrangerLogId(null);
    setIsStrangerModalOpen(true);
  };

  // --- Deep link: webhook alerts link to <base>/#strangers/<logId> ---
  const applyHashRoute = useCallback(() => {
    if (typeof window === "undefined") return;
    const deepLink = parseStrangerDeepLink(window.location.hash);
    if (deepLink.open) {
      setPreselectedStrangerPhoto(null);
      setPreselectedStrangerLogId(deepLink.logId);
      setIsStrangerModalOpen(true);
      return;
    }
    const alias = HASH_TAB_ALIASES[normalizeHash(window.location.hash).toLowerCase()];
    if (alias) setActiveTab(alias);
  }, []);

  useEffect(() => {
    clearLegacyProtectedLogCache();
    applyHashRoute();
    window.addEventListener("hashchange", applyHashRoute);
    return () => window.removeEventListener("hashchange", applyHashRoute);
  }, [applyHashRoute]);

  const handleCloseStrangerModal = () => {
    setIsStrangerModalOpen(false);
    setPreselectedStrangerPhoto(null);
    setPreselectedStrangerLogId(null);
    // Drop the #strangers hash so a refresh doesn't reopen the panel.
    if (typeof window !== "undefined" && parseStrangerDeepLink(window.location.hash).open) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  };

  const handleSaveBackendUrl = (url: string) => {
    setCustomBackendUrl(url);
    setCustomBackendInput(url.trim());
    setPingStatus({
      testing: false,
      success: true,
      message: url.trim()
        ? `Đã lưu URL Backend: ${url.trim()}. Đang đồng bộ dữ liệu...`
        : "Đã chuyển về chế độ Client-Side Biometrics (Chạy 100% trong trình duyệt).",
    });
    fetchData();
  };

  const handleTestBackendPing = async (url: string) => {
    setPingStatus({ testing: true });
    const target = (url || getApiBaseUrl() || "").trim();
    if (!target) {
      setPingStatus({
        testing: false,
        success: true,
        message: "Chế độ Standalone On-Device: Chạy 100% Client-Side SOTA AI (Zero CORS, Không cần Server)!",
      });
      return;
    }
    const testUrl = target.endsWith("/api/health")
      ? target
      : `${target.replace(/\/+$/, "")}/api/health`;
    try {
      const res = await fetch(testUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const json = await res.json().catch(() => null);
        setPingStatus({
          testing: false,
          success: true,
          message: `Kết nối thành công (HTTP ${res.status}): CORS hợp lệ! Backend: ${json?.status || "OK"}`,
        });
      } else {
        setPingStatus({
          testing: false,
          success: false,
          message: `Máy chủ phản hồi HTTP ${res.status} ${res.statusText}`,
        });
      }
    } catch (err: any) {
      setPingStatus({
        testing: false,
        success: false,
        message: `Lỗi kết nối / CORS: ${err?.message || "Không thể kết nối đến URL này"}. Đảm bảo URL backend đã bật CORS và đang online.`,
      });
    }
  };

  // Fetch initial data safely without JSON parse errors
  const fetchData = useCallback(async () => {
    try {
      const [empRes, logRes, lockRes, notifRes] = await Promise.all([
        safeJsonFetch<Employee[]>("/api/employees", undefined, []),
        operatorJsonFetch<{ logs: AccessLog[] }>("/api/logs?limit=100", undefined, { logs: [] }),
        safeJsonFetch<SmartLockState | null>("/api/lock/status", undefined, null),
        safeJsonFetch<MobileNotification[]>("/api/notifications", undefined, []),
      ]);

      // Employees
      if (empRes.ok && Array.isArray(empRes.data) && empRes.data.length > 0) {
        setEmployees(empRes.data);
        saveStoredEmployees(empRes.data);
      } else {
        setEmployees(getStoredEmployees());
      }

      // Access Logs
      if (logRes.ok && Array.isArray(logRes.data?.logs)) {
        setAccessLogs(logRes.data.logs);
        saveStoredLogs(logRes.data.logs);
      } else {
        setAccessLogs(getStoredLogs());
      }

      // Lock State
      if (lockRes.ok && lockRes.data) {
        setLockState(lockRes.data);
        saveStoredLockState(lockRes.data);
      } else {
        setLockState(getStoredLockState());
      }

      // Notifications
      if (notifRes.ok && Array.isArray(notifRes.data) && notifRes.data.length > 0) {
        setNotifications(notifRes.data);
        saveStoredNotifications(notifRes.data);
      } else {
        setNotifications(getStoredNotifications());
      }
    } catch (err) {
      console.warn("[App] Sử dụng bộ dữ liệu Client-Side offline:", err);
      setEmployees(getStoredEmployees());
      setAccessLogs(getStoredLogs());
      setLockState(getStoredLockState());
      setNotifications(getStoredNotifications());
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Connect to SSE event stream with controlled backoff & Netlify offline resilience
  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let isMounted = true;
    let errorCount = 0;

    // Listen to local in-browser client events (works even if Netlify 404s on backend)
    const unsubLock = clientEventBus.on("lock_state", (data: SmartLockState) => {
      if (isMounted) setLockState(data);
    });
    const unsubCount = clientEventBus.on("lock_countdown", ({ remainingSeconds }) => {
      if (isMounted) {
        setLockState((prev) => ({
          ...prev,
          remainingRelockSeconds: remainingSeconds,
        }));
      }
    });
    const unsubNotif = clientEventBus.on("notification", (notif: MobileNotification) => {
      if (isMounted) {
        setNotifications((prev) => [notif, ...prev.filter((n) => n.id !== notif.id)]);
        setLatestToast(notif);
        setTimeout(() => setLatestToast(null), 4500);
      }
    });

    // If running on Netlify and no external backend base URL is configured,
    // do not flood console with 404s from EventSource("/api/events")
    const isNetlifyWithoutBackend = isNetlifyOrStaticHost() && !getApiBaseUrl();
    if (isNetlifyWithoutBackend) {
      setSseConnected(true);
      return () => {
        unsubLock();
        unsubCount();
        unsubNotif();
      };
    }

    function connect() {
      if (!isMounted) return;
      try {
        const eventsUrl = normalizeApiUrl("/api/events");
        eventSource = new EventSource(eventsUrl, { withCredentials: true });

        eventSource.onopen = () => {
          if (isMounted) {
            setSseConnected(true);
            errorCount = 0;
          }
        };

        eventSource.onerror = () => {
          if (isMounted) {
            errorCount += 1;
            if (eventSource) {
              eventSource.close();
              eventSource = null;
            }

            // If 2 failures in a row (e.g. backend not deployed on static host)
            if (errorCount >= 2) {
              console.info("[SSE] Máy chủ tĩnh hoặc không có SSE endpoint. Chuyển sang chế độ Client-Side EventBus.");
              setSseConnected(true);
              return;
            }

            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => {
              if (isMounted) connect();
            }, 10000);
          }
        };

        // Lock State Updates
        eventSource.addEventListener("lock_state", (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data);
            setLockState(data);
          } catch {}
        });

        // Countdown updates
        eventSource.addEventListener("lock_countdown", (e: MessageEvent) => {
          try {
            const { remainingSeconds } = JSON.parse(e.data);
            setLockState((prev) => ({
              ...prev,
              remainingRelockSeconds: remainingSeconds,
            }));
          } catch {}
        });

        // New Push Notifications
        eventSource.addEventListener("notification", (e: MessageEvent) => {
          try {
            const notif: MobileNotification = JSON.parse(e.data);
            setNotifications((prev) => [notif, ...prev.filter((n) => n.id !== notif.id)]);
            setLatestToast(notif);
            setTimeout(() => setLatestToast(null), 4500);
          } catch {}
        });

        // Access Granted Event
        eventSource.addEventListener("access_granted", (e: MessageEvent) => {
          try {
            const { log } = JSON.parse(e.data);
            if (log) {
              setAccessLogs((prev) => [log, ...prev.filter((l) => l.id !== log.id)]);
            }
          } catch {}
        });

        // Access Denied Event
        eventSource.addEventListener("access_denied", (e: MessageEvent) => {
          try {
            const { log } = JSON.parse(e.data);
            if (log) {
              setAccessLogs((prev) => [log, ...prev.filter((l) => l.id !== log.id)]);
            }
          } catch {}
        });

        // Stranger Detected Event (Real-time warning & snapshot capture)
        eventSource.addEventListener("stranger_detected", (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data);
            if (data.log) {
              setAccessLogs((prev) => [data.log, ...prev.filter((l) => l.id !== data.log.id)]);
            }
            soundEffects.playStrangerAlert();
            setLatestToast({
              id: `NOTIF-STRANGER-${Date.now()}`,
              timestamp: new Date().toISOString(),
              type: "ALERT",
              title: "🚨 CẢNH BÁO: PHÁT HIỆN NGƯỜI LẠ CHỤP HÌNH",
              body: data.message || "Phát hiện khuôn mặt người lạ tại cửa. Hệ thống đã lưu hình an ninh.",
              priority: "HIGH",
              read: false,
              photoSnapshot: data.photoSnapshot || data.log?.photoSnapshot,
            });
            setTimeout(() => setLatestToast(null), 6000);
          } catch {}
        });

        // Employee Registered
        eventSource.addEventListener("employee_registered", (e: MessageEvent) => {
          try {
            const newEmp = JSON.parse(e.data);
            setEmployees((prev) => [newEmp, ...prev.filter((item) => item.id !== newEmp.id)]);
          } catch {}
        });

        // Employee Deleted
        eventSource.addEventListener("employee_deleted", (e: MessageEvent) => {
          try {
            const { id } = JSON.parse(e.data);
            setEmployees((prev) => prev.filter((item) => item.id !== id));
          } catch {}
        });

        // Logs Cleared
        eventSource.addEventListener("logs_cleared", () => {
          setAccessLogs([]);
        });
      } catch (err) {
        console.warn("[SSE Warning] Could not establish EventSource:", err);
      }
    }

    connect();

    return () => {
      isMounted = false;
      unsubLock();
      unsubCount();
      unsubNotif();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    };
  }, []);

  // Recognition completion handler from FaceScanner
  const handleRecognitionComplete = (result: FaceRecognitionResult) => {
    if (result.logs && result.logs.length > 0) {
      setAccessLogs((prev) => {
        const existingIds = new Set(prev.map((l) => l.id));
        const newLogs = result.logs!.filter((l) => !existingIds.has(l.id));
        const updated = [...newLogs, ...prev];
        saveStoredLogs(updated);
        return updated;
      });
    } else if (result.log) {
      setAccessLogs((prev) => {
        const updated = [result.log!, ...prev.filter((l) => l.id !== result.log?.id)];
        saveStoredLogs(updated);
        return updated;
      });
    }
  };

  // Manual unlock trigger
  const handleManualUnlock = async () => {
    soundEffects.playLockClick();
    try {
      const res = await operatorJsonFetch("/api/lock/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "Bảo Vệ Mở Cửa Khẩn Cấp (Manual API)",
          reason: "Kích hoạt trực tiếp từ trung tâm điều khiển",
        }),
      });
      if (!res.ok) throw new Error(res.error || `Unlock request failed with status ${res.status}`);
      soundEffects.playSuccess();
    } catch (err) {
      if (demoOfflinePersistenceEnabled()) {
        console.warn("Mở cửa qua Client Fallback:", err);
        clientDoorUnlock("Bảo Vệ Mở Cửa Khẩn Cấp (Client Fallback)");
        soundEffects.playSuccess();
      } else {
        console.warn("Mở cửa khẩn cấp thất bại:", err);
        soundEffects.playDenied();
      }
    }
  };

  // Switch to manual track and test an employee
  const handleTestEmployee = (emp: Employee) => {
    setActiveTab("manual");
  };

  const handleEmployeeDeleted = async (id: string) => {
    try {
      const result = await operatorJsonFetch(`/api/employees/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!result.ok) throw new Error(result.error || `Xóa nhân viên thất bại (HTTP ${result.status})`);
    } catch (err) {
      console.warn("Xóa nhân viên trên máy chủ thất bại:", err);
      return;
    }
    setEmployees((prev) => {
      const updated = prev.filter((e) => e.id !== id);
      saveStoredEmployees(updated);
      return updated;
    });
  };

  const handleClearLogs = async () => {
    try {
      const result = await operatorJsonFetch("/api/logs/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!result.ok) throw new Error(result.error || `Xóa logs thất bại (HTTP ${result.status})`);
    } catch (err) {
      console.warn("Xóa logs trên máy chủ thất bại:", err);
      return;
    }
    setAccessLogs([]);
    saveStoredLogs([]);
  };

  const handleClearNotifications = async () => {
    try {
      const result = await operatorJsonFetch("/api/notifications/clear", { method: "POST" });
      if (!result.ok) throw new Error(result.error || `Xóa thông báo thất bại (HTTP ${result.status})`);
    } catch (err) {
      console.warn("Xóa thông báo trên máy chủ thất bại:", err);
      return;
    }
    setNotifications([]);
    saveStoredNotifications([]);
  };

  const handleMarkNotificationsRead = async () => {
    try {
      const result = await operatorJsonFetch("/api/notifications/mark-read", { method: "POST" });
      if (!result.ok) throw new Error(result.error || `Đánh dấu thông báo thất bại (HTTP ${result.status})`);
    } catch (err) {
      console.warn("Đánh dấu đã đọc trên máy chủ thất bại:", err);
      return;
    }
    setNotifications((prev) => {
      const updated = prev.map((n) => ({ ...n, read: true }));
      saveStoredNotifications(updated);
      return updated;
    });
  };

  const unreadNotificationsCount = notifications.filter((n) => !n.read).length;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col antialiased">
      {/* Operator session: sign-in, role, sign-out. Also answers a 401 raised
          anywhere in the app so the failed request can be retried. */}
      <OperatorSessionBar />

      {/* Top Navbar */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        lockState={lockState}
        unreadCount={unreadNotificationsCount}
        sseConnected={sseConnected}
        onOpenStrangers={() => handleOpenStrangerModal()}
        strangerCount={accessLogs.filter((l) => l.status === "DENIED" || !l.employeeId).length || 2}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Notice Banner for Netlify or Client-Only Environments */}
        {isNetlifyOrStaticHost() && !getApiBaseUrl() && (
          <div className="mb-6 rounded-2xl bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200/80 p-4 sm:p-5 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-start gap-3.5">
              <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0 shadow-sm shadow-blue-200">
                <Sparkles className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-slate-900 text-sm">
                    Đang chạy trên Netlify (Chế độ Client-Side Biometrics)
                  </h3>
                  <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
                    Hoạt động 100%
                  </span>
                </div>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  Netlify là hosting web tĩnh nên các route backend <code className="text-rose-600 font-mono bg-rose-50 px-1 py-0.5 rounded">/api/*</code> sẽ trả về 404 nếu không có Node.js server. Hệ thống đã tự động kích hoạt bộ nhận diện Client Biometrics: quét khuôn mặt, mở khóa cửa thông minh và lưu lịch sử hoàn toàn ngay trên trình duyệt mà không cần server.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 self-start md:self-center shrink-0">
              <button
                id="btn-show-deployment-guide"
                onClick={() => setShowDeploymentGuide(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-all shadow-xs"
              >
                <Code2 className="w-4 h-4" />
                Hướng dẫn kết nối Node Server
              </button>
            </div>
          </div>
        )}

        {activeTab === "scanner" && (
          <div className="space-y-8">
            {/* Multi-Stream Live Surveillance & Recognition Dashboard */}
            <CameraDashboard
              employees={employees}
              lockState={lockState}
              accessLogs={accessLogs}
              onRecognitionComplete={handleRecognitionComplete}
              onTriggerManualUnlock={handleManualUnlock}
              onOpenStrangerClusters={(photo) => handleOpenStrangerModal(photo)}
              onNavigateToCamerasConfig={() => setActiveTab("cameras")}
              onNavigateToManualTrack={() => setActiveTab("manual")}
              onNavigateToLogs={() => setActiveTab("logs")}
            />

            {/* Smart Lock Hardware & API Section */}
            <SmartLockCard
              lockState={lockState}
              onRefresh={fetchData}
            />
          </div>
        )}

        {activeTab === "manual" && (
          <div className="space-y-8">
            {/* Manual Track Header Banner */}
            <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 shadow-2xs">
                  <Camera className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-900 tracking-tight flex items-center gap-2">
                    Nhận Diện Thủ Công - Manual Track
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Nhận diện khuôn mặt qua webcam mặc định của thiết bị, kiểm thử kịch bản giả lập hoặc tải ảnh thủ công từ máy tính.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setActiveTab("scanner")}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold transition-colors cursor-pointer"
              >
                <ScanFace className="w-4 h-4" />
                <span>Quay Lại Quét Cửa AI (Dashboard)</span>
              </button>
            </div>

            {/* Primary Manual Scanner Station (Default Webcam / Test Scenarios) */}
            <FaceScanner
              employees={employees}
              lockState={lockState}
              onRecognitionComplete={handleRecognitionComplete}
              onTriggerManualUnlock={handleManualUnlock}
              onOpenStrangerClusters={(photo) => handleOpenStrangerModal(photo)}
            />

            {/* Smart Lock Hardware & API Section */}
            <SmartLockCard
              lockState={lockState}
              onRefresh={fetchData}
            />
          </div>
        )}

        {activeTab === "register" && (
          <EmployeeRegistration
            employees={employees}
            onEmployeeAdded={(emp) => setEmployees((prev) => [emp, ...prev])}
            onEmployeeDeleted={handleEmployeeDeleted}
            onTestEmployee={handleTestEmployee}
            onOpenStrangerClusters={() => handleOpenStrangerModal()}
          />
        )}

        {activeTab === "logs" && (
          <AccessLogs
            logs={accessLogs}
            onClearLogs={handleClearLogs}
            onOpenStrangerClusters={(photo) => handleOpenStrangerModal(photo)}
          />
        )}

        {activeTab === "mobile" && (
          <MobileCompanion
            notifications={notifications}
            lockState={lockState}
            onClearNotifications={handleClearNotifications}
            onMarkRead={handleMarkNotificationsRead}
            sseConnected={sseConnected}
          />
        )}

        {activeTab === "webhook" && (
          <WebhookIntegration
            employees={employees}
            onNewNotification={(notif) => {
              setNotifications((prev) => [notif, ...prev.filter((n) => n.id !== notif.id)]);
              setLatestToast(notif);
              setTimeout(() => setLatestToast(null), 4500);
            }}
          />
        )}

        {activeTab === "door" && (
          <DoorConfigPage
            lockState={lockState}
            onRefreshLockState={fetchData}
          />
        )}

        {activeTab === "cameras" && (
          <CameraStreamConfigPage />
        )}

        {activeTab === "config" && (
          <AiConfigPage
            employees={employees}
            onNavigateToScanner={() => setActiveTab("scanner")}
          />
        )}
      </main>

      {/* Stranger Cluster Management & Quick Registration Modal */}
      <StrangerClusterModal
        isOpen={isStrangerModalOpen}
        onClose={handleCloseStrangerModal}
        initialPreselectedPhoto={preselectedStrangerPhoto}
        initialPreselectedLogId={preselectedStrangerLogId}
        onEmployeeAdded={(emp) => {
          setEmployees((prev) => [emp, ...prev.filter((e) => e.id !== emp.id)]);
        }}
        onLogsUpdated={() => {
          fetchData();
        }}
      />

      {/* Deployment & Backend Connection Guide Modal */}
      {showDeploymentGuide && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto border border-slate-200 shadow-2xl p-6 sm:p-8 space-y-6">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center">
                  <Code2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-base">
                    Giải thích mã 404 &amp; Hướng dẫn triển khai Backend
                  </h3>
                  <p className="text-xs text-slate-500">
                    Cách xử lý khi deploy ứng dụng lên Netlify
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowDeploymentGuide(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 text-xs text-slate-700 leading-relaxed">
              {/* CORS explanation box */}
              <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-950 space-y-2">
                <div className="font-semibold text-sm flex items-center gap-1.5 text-emerald-900">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  Đã khắc phục lỗi CORS khi deploy lên Netlify
                </div>
                <p className="text-emerald-800 leading-relaxed">
                  <strong>Nguyên nhân lỗi trước đó:</strong> Trình duyệt gửi preflight <code className="bg-emerald-100/70 px-1 py-0.5 rounded font-mono">OPTIONS /api/recognize-face</code> đến URL sandbox nội bộ vốn trả về HTTP 302 Redirect (yêu cầu session AI Studio), khiến trình duyệt chặn do spec CORS không cho phép redirect khi preflight (<code className="bg-emerald-100/70 px-1 py-0.5 rounded font-mono">net::ERR_INVALID_REDIRECT</code>).
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 text-[11px] text-emerald-900 font-medium">
                  <div className="p-2 rounded-lg bg-white/70 border border-emerald-200/60">
                    ✅ <strong>Chế độ SOTA On-Device:</strong> Tự động nhận diện trên trình duyệt (Zero CORS, không cần server).
                  </div>
                  <div className="p-2 rounded-lg bg-white/70 border border-emerald-200/60">
                    ✅ <strong>CORS Headers Toàn Diện:</strong> Server hỗ trợ dynamic Origin, Credentials, và OPTIONS 204.
                  </div>
                </div>
              </div>

              {/* Interactive Backend URL Configuration */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-slate-900 text-sm">
                    Cấu hình URL Backend Trực Tiếp (Tùy chọn)
                  </h4>
                  <span className="text-[11px] text-slate-500 font-mono">
                    Hiện tại: {getApiBaseUrl() ? getApiBaseUrl() : "(Client-Side On-Device)"}
                  </span>
                </div>
                <p className="text-slate-600 text-xs">
                  Nếu bạn đã deploy <code className="bg-white px-1 py-0.5 rounded border border-slate-200 font-mono">server.ts</code> lên Render, Railway, Cloud Run hoặc VPS, hãy nhập URL tại đây:
                </p>

                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={customBackendInput}
                    onChange={(e) => setCustomBackendInput(e.target.value)}
                    placeholder="https://your-backend.onrender.com (hoặc để trống)"
                    className="flex-1 px-3 py-2 rounded-xl bg-white border border-slate-300 text-slate-900 text-xs font-mono focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                  />
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleTestBackendPing(customBackendInput)}
                      disabled={pingStatus?.testing}
                      className="px-3 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-800 font-medium text-xs transition-colors disabled:opacity-50"
                    >
                      {pingStatus?.testing ? "Đang ping..." : "Kiểm tra Ping"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSaveBackendUrl(customBackendInput)}
                      className="px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs transition-colors"
                    >
                      Lưu URL
                    </button>
                    {customBackendInput && (
                      <button
                        type="button"
                        onClick={() => handleSaveBackendUrl("")}
                        className="px-2.5 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 font-medium text-xs transition-colors"
                        title="Xóa URL và chạy On-Device"
                      >
                        Xóa
                      </button>
                    )}
                  </div>
                </div>

                {pingStatus && (
                  <div
                    className={`p-2.5 rounded-lg text-xs font-medium ${
                      pingStatus.success
                        ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                        : "bg-rose-50 text-rose-800 border border-rose-200"
                    }`}
                  >
                    {pingStatus.message}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <h4 className="font-bold text-slate-900 text-sm">
                  1. Chế độ Trình duyệt Tự Động (Đã tích hợp sẵn)
                </h4>
                <p>
                  Hệ thống đã được tích hợp bộ <strong>Client-Side Biometrics &amp; Offline Store</strong>. Khi chạy tĩnh trên Netlify, ứng dụng tự động thực hiện nhận diện khuôn mặt, tính độ tin cậy, mở khóa cửa thông minh (đếm ngược 6s tự khóa), tạo thông báo và lưu log lịch sử vào <code className="bg-slate-100 px-1 rounded font-mono">localStorage</code> mà không cần backend!
                </p>
              </div>

              <div className="space-y-2">
                <h4 className="font-bold text-slate-900 text-sm">
                  2. Cách triển khai Node.js Server thật (Nếu muốn chạy Full-Stack)
                </h4>
                <p>
                  Để chạy server Express <code className="bg-slate-100 px-1 rounded font-mono">server.ts</code> trên môi trường production có IP Camera thật hoặc webhook server-side:
                </p>
                <div className="p-3 bg-slate-900 text-slate-100 rounded-xl font-mono text-[11px] space-y-2">
                  <p className="text-slate-400"># Bước 1: Deploy server.ts lên Render, Railway, Cloud Run hoặc VPS</p>
                  <p className="text-emerald-400">npm run build &amp;&amp; npm start</p>
                  <p className="text-slate-400"># Bước 2: Thiết lập biến môi trường trên Netlify Dashboard:</p>
                  <p className="text-indigo-300">VITE_API_BASE_URL=https://your-express-backend.onrender.com</p>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="font-bold text-slate-900 text-sm">
                  3. Cấu hình Netlify Proxy (Trong file netlify.toml)
                </h4>
                <p>
                  Dự án đã tạo sẵn file <code className="bg-slate-100 px-1 rounded font-mono">netlify.toml</code>. Bạn có thể mở ra và cấu hình proxy chuyển tiếp các request <code className="bg-slate-100 px-1 rounded font-mono">/api/*</code> sang server riêng của bạn:
                </p>
                <div className="relative">
                  <pre className="p-3 bg-slate-900 text-emerald-400 rounded-xl font-mono text-[11px] overflow-x-auto">
{`[[redirects]]
  from = "/api/*"
  to = "https://your-backend.onrender.com/api/:splat"
  status = 200
  force = true`}
                  </pre>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(
                        `[[redirects]]\n  from = "/api/*"\n  to = "https://your-backend.onrender.com/api/:splat"\n  status = 200\n  force = true`
                      );
                      setCopiedCode("toml");
                      setTimeout(() => setCopiedCode(null), 2500);
                    }}
                    className="absolute top-2.5 right-2.5 p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                    title="Sao chép"
                  >
                    {copiedCode === "toml" ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-100">
              <button
                onClick={() => setShowDeploymentGuide(false)}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-medium text-xs transition-colors"
              >
                Đã hiểu, đóng hướng dẫn
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Real-time Floating Notification Toast (visible on any tab) */}
      {latestToast && (
        <div className="fixed bottom-5 right-5 z-50 max-w-md w-full animate-in slide-in-from-bottom-5 duration-300">
          <div
            className={`p-4 rounded-2xl shadow-xl border flex items-start gap-3 text-slate-900 ${
              latestToast.type === "WARNING"
                ? "bg-rose-50 border-rose-200"
                : "bg-white border-slate-200"
            }`}
          >
            <div
              className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                latestToast.type === "WARNING"
                  ? "bg-rose-100 text-rose-600"
                  : "bg-emerald-100 text-emerald-600"
              }`}
            >
              {latestToast.type === "WARNING" ? (
                <AlertTriangle className="w-4 h-4" />
              ) : (
                <CheckCircle2 className="w-4 h-4" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between">
                <h5 className="font-bold text-xs text-slate-900">
                  {latestToast.title}
                </h5>
                <span className="text-[10px] text-slate-400 font-mono">Real-time</span>
              </div>
              <p className="text-xs text-slate-600 mt-0.5 leading-snug">
                {latestToast.body}
              </p>
            </div>
            <button
              onClick={() => setLatestToast(null)}
              className="text-slate-400 hover:text-slate-600 text-xs px-1"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white py-4 mt-auto text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>
            Hệ Thống Mở Cửa Tự Động Bằng Nhận Diện Khuôn Mặt AI &amp; Khóa Thông Minh Qua API
          </span>
          <span className="font-mono text-slate-400">
            Node.js / Express • Vite / React • Gemini Vision AI • SSE Real-Time
          </span>
        </div>
      </footer>
    </div>
  );
}
