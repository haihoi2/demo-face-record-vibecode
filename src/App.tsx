import React, { useState, useEffect, useCallback } from "react";
import { Navbar } from "./components/Navbar";
import { FaceScanner } from "./components/FaceScanner";
import { SmartLockCard } from "./components/SmartLockCard";
import { EmployeeRegistration } from "./components/EmployeeRegistration";
import { AccessLogs } from "./components/AccessLogs";
import { MobileCompanion } from "./components/MobileCompanion";
import { WebhookIntegration } from "./components/WebhookIntegration";
import {
  Employee,
  AccessLog,
  SmartLockState,
  MobileNotification,
  FaceRecognitionResult,
} from "./types";
import { Bell, CheckCircle2, AlertTriangle } from "lucide-react";
import { soundEffects } from "./utils/audio";
import { safeJsonFetch } from "./utils/api";

export default function App() {
  const [activeTab, setActiveTab] = useState<"scanner" | "register" | "logs" | "mobile" | "webhook">("scanner");

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

  // Fetch initial data safely without JSON parse errors
  const fetchData = useCallback(async () => {
    try {
      const [empRes, logRes, lockRes, notifRes] = await Promise.all([
        safeJsonFetch<Employee[]>("/api/employees", undefined, []),
        safeJsonFetch<AccessLog[]>("/api/logs", undefined, []),
        safeJsonFetch<SmartLockState | null>("/api/lock/status", undefined, null),
        safeJsonFetch<MobileNotification[]>("/api/notifications", undefined, []),
      ]);

      // Read local offline employees
      let localEmps: Employee[] = [];
      try {
        const raw = localStorage.getItem("smartlock_offline_employees");
        if (raw) localEmps = JSON.parse(raw);
      } catch {}

      if (empRes.ok && Array.isArray(empRes.data)) {
        // Merge server and local employees
        const merged = [...empRes.data];
        for (const localEmp of localEmps) {
          if (!merged.some((m) => m.id === localEmp.id || m.employeeCode === localEmp.employeeCode)) {
            merged.unshift(localEmp);
          }
        }
        setEmployees(merged);
      } else if (localEmps.length > 0) {
        setEmployees((prev) => {
          const merged = [...prev];
          for (const localEmp of localEmps) {
            if (!merged.some((m) => m.id === localEmp.id || m.employeeCode === localEmp.employeeCode)) {
              merged.unshift(localEmp);
            }
          }
          return merged;
        });
      }

      if (logRes.ok && Array.isArray(logRes.data)) setAccessLogs(logRes.data);
      if (lockRes.ok && lockRes.data) setLockState(lockRes.data);
      if (notifRes.ok && Array.isArray(notifRes.data)) setNotifications(notifRes.data);
    } catch (err) {
      console.error("Lỗi tải dữ liệu ban đầu:", err);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Connect to SSE event stream
  useEffect(() => {
    const eventSource = new EventSource("/api/events");

    eventSource.onopen = () => {
      setSseConnected(true);
    };

    eventSource.onerror = () => {
      setSseConnected(false);
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
        // Show floating toast
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

    return () => {
      eventSource.close();
    };
  }, []);

  // Recognition completion handler from FaceScanner
  const handleRecognitionComplete = (result: FaceRecognitionResult) => {
    if (result.logs && result.logs.length > 0) {
      setAccessLogs((prev) => {
        const existingIds = new Set(prev.map((l) => l.id));
        const newLogs = result.logs!.filter((l) => !existingIds.has(l.id));
        return [...newLogs, ...prev];
      });
    } else if (result.log) {
      setAccessLogs((prev) => [result.log!, ...prev.filter((l) => l.id !== result.log?.id)]);
    }
  };

  // Manual unlock trigger
  const handleManualUnlock = async () => {
    soundEffects.playLockClick();
    try {
      await fetch("/api/lock/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "Bảo Vệ Mở Cửa Khẩn Cấp (Manual API)",
          reason: "Kích hoạt trực tiếp từ trung tâm điều khiển",
        }),
      });
      soundEffects.playSuccess();
    } catch (err) {
      console.error("Lỗi gửi lệnh mở khóa:", err);
    }
  };

  // Switch to scanner and test an employee
  const handleTestEmployee = (emp: Employee) => {
    setActiveTab("scanner");
  };

  const handleEmployeeDeleted = async (id: string) => {
    try {
      await fetch(`/api/employees/${id}`, { method: "DELETE" });
      setEmployees((prev) => prev.filter((e) => e.id !== id));
    } catch (err) {
      console.error("Lỗi xóa nhân viên:", err);
    }
  };

  const handleClearLogs = async () => {
    try {
      await fetch("/api/logs/clear", { method: "POST" });
      setAccessLogs([]);
    } catch (err) {
      console.error("Lỗi xóa logs:", err);
    }
  };

  const handleClearNotifications = async () => {
    try {
      await fetch("/api/notifications/clear", { method: "POST" });
      setNotifications([]);
    } catch (err) {
      console.error("Lỗi xóa thông báo:", err);
    }
  };

  const handleMarkNotificationsRead = async () => {
    try {
      await fetch("/api/notifications/mark-read", { method: "POST" });
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch (err) {
      console.error("Lỗi đánh dấu đã đọc:", err);
    }
  };

  const unreadNotificationsCount = notifications.filter((n) => !n.read).length;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col antialiased">
      {/* Top Navbar */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        lockState={lockState}
        unreadCount={unreadNotificationsCount}
        sseConnected={sseConnected}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {activeTab === "scanner" && (
          <div className="space-y-8">
            {/* Primary Scanner Station */}
            <FaceScanner
              employees={employees}
              lockState={lockState}
              onRecognitionComplete={handleRecognitionComplete}
              onTriggerManualUnlock={handleManualUnlock}
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
          />
        )}

        {activeTab === "logs" && (
          <AccessLogs
            logs={accessLogs}
            onClearLogs={handleClearLogs}
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
          <WebhookIntegration employees={employees} />
        )}
      </main>

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
