import React, { useState } from "react";
import {
  Smartphone,
  Bell,
  CheckCircle2,
  AlertTriangle,
  Info,
  Trash2,
  CheckCheck,
  Lock,
  Unlock,
  Radio,
  Wifi,
  Battery,
  ShieldAlert,
  ArrowDownToLine,
  SlidersHorizontal,
} from "lucide-react";
import { MobileNotification, SmartLockState } from "../types";
import { soundEffects } from "../utils/audio";
import { normalizeApiUrl, getApiBaseUrl } from "../utils/api";
import { clientDoorUnlock, isNetlifyOrStaticHost } from "../utils/offlineEngine";

interface MobileCompanionProps {
  notifications: MobileNotification[];
  lockState: SmartLockState;
  onClearNotifications: () => void;
  onMarkRead: () => void;
  sseConnected: boolean;
}

export const MobileCompanion: React.FC<MobileCompanionProps> = ({
  notifications,
  lockState,
  onClearNotifications,
  onMarkRead,
  sseConnected,
}) => {
  const [filter, setFilter] = useState<"ALL" | "SUCCESS" | "WARNING">("ALL");
  const [isUnlocking, setIsUnlocking] = useState<boolean>(false);
  const shouldUseClientFallback = isNetlifyOrStaticHost() && !getApiBaseUrl();

  const filteredNotifications = notifications.filter((notif) => {
    if (filter === "SUCCESS") return notif.type === "SUCCESS";
    if (filter === "WARNING") return notif.type === "WARNING" || notif.type === "ALERT";
    return true;
  });

  const handleRemoteMobileUnlock = async () => {
    setIsUnlocking(true);
    try {
      soundEffects.playLockClick();
      const res = await fetch(normalizeApiUrl("/api/lock/unlock"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "Ứng Dụng Di Động (SmartFace Mobile App)",
          reason: "Người quản lý mở cửa từ xa qua điện thoại",
        }),
      });
      if (!res.ok) {
        throw new Error(`Unlock request failed with status ${res.status}`);
      }
      soundEffects.playSuccess();
    } catch (err) {
      if (shouldUseClientFallback) {
        console.warn("Mở cửa qua Client Fallback:", err);
        clientDoorUnlock("Ứng Dụng Di Động (Client Fallback)");
        soundEffects.playSuccess();
      } else {
        console.warn("Mở cửa từ xa thất bại:", err);
        soundEffects.playDenied();
      }
    } finally {
      setIsUnlocking(false);
    }
  };

  const currentTime = new Date().toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
      {/* Left Column: Device Mockup */}
      <div className="lg:col-span-6 flex justify-center">
        {/* Smartphone Hardware Frame */}
        <div className="relative w-[340px] sm:w-[380px] rounded-[48px] bg-slate-950 p-4 shadow-2xl border-4 border-slate-800 ring-1 ring-white/10">
          {/* Speaker / Notch */}
          <div className="absolute top-6 left-1/2 -translate-x-1/2 w-28 h-5 bg-black rounded-full z-30 flex items-center justify-center">
            <div className="w-3 h-3 rounded-full bg-slate-900 border border-slate-700 mr-2" />
            <div className="w-12 h-1 bg-slate-800 rounded-full" />
          </div>

          {/* Smartphone Screen Viewport */}
          <div className="relative h-[680px] rounded-[36px] bg-slate-900 overflow-hidden flex flex-col text-slate-100 border border-slate-800">
            {/* Status Bar */}
            <div className="pt-3 px-6 pb-2 flex items-center justify-between text-xs text-slate-300 z-20">
              <span className="font-semibold font-mono">{currentTime}</span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-indigo-900 text-indigo-300">
                  5G
                </span>
                <Wifi className="w-3.5 h-3.5" />
                <Battery className="w-4 h-4 text-emerald-400" />
              </div>
            </div>

            {/* Mobile App Header */}
            <div className="px-5 py-3 border-b border-slate-800 bg-slate-900/90 backdrop-blur-md flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center text-white">
                  <Smartphone className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-xs text-white">SmartFace Mobile</h3>
                  <div className="flex items-center gap-1 text-[10px] text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span>SSE Trực Tuyến</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1">
                <button
                  onClick={onMarkRead}
                  className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition"
                  title="Đánh dấu đã đọc"
                >
                  <CheckCheck className="w-4 h-4" />
                </button>
                <button
                  onClick={onClearNotifications}
                  className="p-1.5 text-slate-400 hover:text-rose-400 rounded-lg hover:bg-slate-800 transition"
                  title="Xóa thông báo"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Latest Incoming Push Banner (Simulated Native Push Alert) */}
            {notifications.length > 0 && (
              <div className="p-3">
                <div
                  className={`p-3.5 rounded-2xl border shadow-lg transition-all animate-in slide-in-from-top duration-300 ${
                    notifications[0].type === "WARNING"
                      ? "bg-rose-950/90 border-rose-700/80 text-rose-100"
                      : "bg-indigo-950/90 border-indigo-700/80 text-indigo-100"
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <div
                      className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                        notifications[0].type === "WARNING"
                          ? "bg-rose-500/20 text-rose-300"
                          : "bg-indigo-500/20 text-indigo-300"
                      }`}
                    >
                      {notifications[0].type === "WARNING" ? (
                        <AlertTriangle className="w-4 h-4" />
                      ) : (
                        <Bell className="w-4 h-4" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-bold truncate">
                          {notifications[0].title}
                        </p>
                        <span className="text-[10px] text-slate-400 font-mono">Vừa xong</span>
                      </div>
                      <p className="text-xs text-slate-300 mt-0.5 leading-snug">
                        {notifications[0].body}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Quick Door Control Inside Mobile App */}
            <div className="px-4 py-2">
              <div className="p-3.5 rounded-2xl bg-slate-800/80 border border-slate-700/80">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-400 font-medium">Khóa cửa:</span>
                  <span
                    className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                      lockState.isLocked
                        ? "bg-slate-700 text-slate-300"
                        : "bg-emerald-900 text-emerald-300"
                    }`}
                  >
                    {lockState.isLocked
                      ? "ĐANG KHÓA"
                      : `ĐANG MỞ (${lockState.remainingRelockSeconds}s)`}
                  </span>
                </div>

                <button
                  id="btn-mobile-remote-unlock"
                  disabled={isUnlocking}
                  onClick={handleRemoteMobileUnlock}
                  className={`w-full py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer ${
                    lockState.isLocked
                      ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-900/30"
                      : "bg-slate-700 text-slate-300 cursor-default"
                  }`}
                >
                  {lockState.isLocked ? (
                    <>
                      <Unlock className="w-3.5 h-3.5" />
                      <span>Mở Cửa Từ Xa (Remote API)</span>
                    </>
                  ) : (
                    <>
                      <Lock className="w-3.5 h-3.5" />
                      <span>Cửa Đang Mở - Sẽ Tự Khóa</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Notifications Feed Header & Filter Tabs */}
            <div className="px-4 pt-3 pb-1 flex items-center justify-between">
              <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                Thông Báo Thời Gian Thực
              </span>
              <div className="flex gap-1 bg-slate-800 p-0.5 rounded-lg text-[10px]">
                <button
                  onClick={() => setFilter("ALL")}
                  className={`px-2 py-0.5 rounded ${
                    filter === "ALL" ? "bg-indigo-600 text-white font-bold" : "text-slate-400"
                  }`}
                >
                  Tất cả
                </button>
                <button
                  onClick={() => setFilter("SUCCESS")}
                  className={`px-2 py-0.5 rounded ${
                    filter === "SUCCESS" ? "bg-emerald-600 text-white font-bold" : "text-slate-400"
                  }`}
                >
                  Vào ra
                </button>
                <button
                  onClick={() => setFilter("WARNING")}
                  className={`px-2 py-0.5 rounded ${
                    filter === "WARNING" ? "bg-rose-600 text-white font-bold" : "text-slate-400"
                  }`}
                >
                  Cảnh báo
                </button>
              </div>
            </div>

            {/* Notification Stream List */}
            <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2.5">
              {filteredNotifications.length === 0 ? (
                <div className="py-12 text-center text-slate-500">
                  <Bell className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p className="text-xs">Không có thông báo mới nào</p>
                </div>
              ) : (
                filteredNotifications.map((notif) => {
                  const notifTime = new Date(notif.timestamp).toLocaleTimeString(
                    "vi-VN",
                    {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    }
                  );

                  return (
                    <div
                      key={notif.id}
                      className="p-3 rounded-xl bg-slate-800/60 border border-slate-700/60 hover:bg-slate-800 transition"
                    >
                      <div className="flex items-start gap-2.5">
                        <div
                          className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                            notif.type === "SUCCESS"
                              ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
                              : notif.type === "WARNING"
                              ? "bg-rose-950 text-rose-400 border border-rose-800"
                              : "bg-blue-950 text-blue-400 border border-blue-800"
                          }`}
                        >
                          {notif.type === "SUCCESS" ? (
                            <CheckCircle2 className="w-3.5 h-3.5" />
                          ) : notif.type === "WARNING" ? (
                            <ShieldAlert className="w-3.5 h-3.5" />
                          ) : (
                            <Info className="w-3.5 h-3.5" />
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between">
                            <h4 className="text-xs font-bold text-slate-100 truncate">
                              {notif.title}
                            </h4>
                            <span className="text-[10px] text-slate-400 font-mono">
                              {notifTime}
                            </span>
                          </div>
                          <p className="text-xs text-slate-300 mt-0.5 leading-snug">
                            {notif.body}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Bottom Home Indicator */}
            <div className="py-2 flex justify-center">
              <div className="w-32 h-1 bg-slate-700 rounded-full" />
            </div>
          </div>
        </div>
      </div>

      {/* Right Column: Architecture & Notification Explained */}
      <div className="lg:col-span-6 space-y-5">
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
              <Radio className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900 text-sm">
                Cơ Chế Bắn Thông Báo Di Động Thời Gian Thực
              </h3>
              <p className="text-xs text-slate-500">
                Server-Sent Events (SSE) &amp; Web Push Architecture
              </p>
            </div>
          </div>

          <p className="text-xs text-slate-600 leading-relaxed mb-4">
            Mỗi khi nhân viên quét khuôn mặt tại camera cửa hoặc bất kỳ sự kiện mở khóa nào diễn ra, máy chủ AI sẽ phát đi một gói tin qua kết nối thời gian thực <strong>(SSE Stream)</strong> đến các thiết bị di động của nhân viên và ban quản trị mà không cần tải lại trang.
          </p>

          <div className="space-y-3">
            <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100">
              <div className="w-6 h-6 rounded-md bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0 text-xs font-bold">
                1
              </div>
              <div className="text-xs">
                <strong className="text-slate-800">Điểm danh &amp; Ra Vào:</strong>
                <p className="text-slate-500 mt-0.5">
                  Gửi thông báo xác nhận thành công tới điện thoại của nhân viên ngay khi bước qua cửa (&lt; 200ms).
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100">
              <div className="w-6 h-6 rounded-md bg-rose-100 text-rose-700 flex items-center justify-center shrink-0 text-xs font-bold">
                2
              </div>
              <div className="text-xs">
                <strong className="text-slate-800">Cảnh Báo An Ninh:</strong>
                <p className="text-slate-500 mt-0.5">
                  Phát chuông báo động đỏ tới điện thoại bảo vệ khi có khuôn mặt lạ hoặc nỗ lực truy cập ngoài giờ phép.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100">
              <div className="w-6 h-6 rounded-md bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0 text-xs font-bold">
                3
              </div>
              <div className="text-xs">
                <strong className="text-slate-800">Mở Cửa Từ Xa (Mobile Remote):</strong>
                <p className="text-slate-500 mt-0.5">
                  Quản lý có thể ấn nút mở khóa ngay từ giao diện ứng dụng di động để tiếp khách mà không cần ra tận cửa.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Real-time Status Card */}
        <div className="bg-slate-900 text-white rounded-2xl p-6 border border-slate-800">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  sseConnected ? "bg-emerald-400 animate-ping" : "bg-amber-400"
                }`}
              />
              <span className="text-xs font-bold uppercase tracking-wider font-mono">
                SSE Pipeline Status: {sseConnected ? "LIVE STREAMING" : "CONNECTING"}
              </span>
            </div>
            <span className="text-xs font-mono text-slate-400">
              {notifications.length} Thông báo đã ghi nhận
            </span>
          </div>

          <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 font-mono text-xs text-indigo-300">
            <code>
              event: notification
              <br />
              data: {JSON.stringify(notifications[0] || { status: "ready" }, null, 2)}
            </code>
          </div>
        </div>
      </div>
    </div>
  );
};
