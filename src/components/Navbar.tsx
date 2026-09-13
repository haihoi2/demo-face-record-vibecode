import React, { useState, useEffect } from "react";
import {
  ScanFace,
  Lock,
  Unlock,
  Smartphone,
  ClipboardList,
  UserPlus,
  Radio,
  Clock,
  ShieldCheck,
  Send,
  Sliders,
  UserX,
} from "lucide-react";
import { SmartLockState } from "../types";

interface NavbarProps {
  activeTab: "scanner" | "register" | "logs" | "mobile" | "webhook" | "config";
  setActiveTab: (tab: "scanner" | "register" | "logs" | "mobile" | "webhook" | "config") => void;
  lockState: SmartLockState;
  unreadCount: number;
  sseConnected: boolean;
  onOpenStrangers?: () => void;
  strangerCount?: number;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  lockState,
  unreadCount,
  sseConnected,
  onOpenStrangers,
  strangerCount,
}) => {
  const [currentTime, setCurrentTime] = useState<string>("");

  useEffect(() => {
    const update = () => {
      const now = new Date();
      setCurrentTime(
        now.toLocaleTimeString("vi-VN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
      );
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <header className="border-b border-slate-200 bg-white/95 backdrop-blur-md sticky top-0 z-30 shadow-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo & Brand */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center text-white shadow-sm shadow-indigo-200">
              <ScanFace className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-lg tracking-tight text-slate-900">
                  SmartFace Access
                </span>
                <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                  <ShieldCheck className="w-3 h-3" /> AI Vision
                </span>
              </div>
              <p className="text-xs text-slate-700 hidden md:block">
                Hệ thống nhận diện khuôn mặt &amp; mở khóa cửa tự động qua API
              </p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <nav className="flex items-center gap-1 sm:gap-2">
            <button
              id="nav-tab-scanner"
              onClick={() => setActiveTab("scanner")}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === "scanner"
                  ? "bg-indigo-50 text-indigo-700 shadow-xs border border-indigo-100"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
              }`}
            >
              <ScanFace className="w-4 h-4" />
              <span className="hidden sm:inline">Quét Cửa AI</span>
            </button>

            <button
              id="nav-tab-register"
              onClick={() => setActiveTab("register")}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === "register"
                  ? "bg-indigo-50 text-indigo-700 shadow-xs border border-indigo-100"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
              }`}
            >
              <UserPlus className="w-4 h-4" />
              <span className="hidden sm:inline">Đăng Ký Khuôn Mặt</span>
            </button>

            <button
              id="nav-tab-logs"
              onClick={() => setActiveTab("logs")}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === "logs"
                  ? "bg-indigo-50 text-indigo-700 shadow-xs border border-indigo-100"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
              }`}
            >
              <ClipboardList className="w-4 h-4" />
              <span className="hidden sm:inline">Nhật Ký Vào Ra</span>
            </button>

            <button
              id="nav-tab-mobile"
              onClick={() => setActiveTab("mobile")}
              className={`relative flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === "mobile"
                  ? "bg-indigo-50 text-indigo-700 shadow-xs border border-indigo-100"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
              }`}
            >
              <Smartphone className="w-4 h-4" />
              <span className="hidden sm:inline">App Di Động</span>
              {unreadCount > 0 && (
                <span className="inline-flex items-center justify-center px-1.5 py-0.5 text-xs font-bold leading-none text-white bg-rose-500 rounded-full animate-pulse">
                  {unreadCount}
                </span>
              )}
            </button>

            <button
              id="nav-tab-webhook"
              onClick={() => setActiveTab("webhook")}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === "webhook"
                  ? "bg-indigo-50 text-indigo-700 shadow-xs border border-indigo-100"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
              }`}
            >
              <Send className="w-4 h-4 text-indigo-600" />
              <span className="hidden sm:inline">Webhook Eton</span>
            </button>

            <button
              id="nav-tab-config"
              onClick={() => setActiveTab("config")}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === "config"
                  ? "bg-indigo-50 text-indigo-700 shadow-xs border border-indigo-100"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
              }`}
            >
              <Sliders className="w-4 h-4 text-indigo-600" />
              <span className="hidden sm:inline">Cấu Hình AI</span>
            </button>
          </nav>

          {/* Real-time status & Door lock widget badge */}
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Quick Stranger Clusters Button */}
            {onOpenStrangers && (
              <button
                id="nav-btn-strangers"
                onClick={onOpenStrangers}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-50 text-amber-900 border border-amber-300 hover:bg-amber-100 transition-colors shadow-2xs cursor-pointer"
                title="Quản lý cụm ảnh người lạ và khai báo nhanh nhân viên"
              >
                <UserX className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                <span className="hidden sm:inline">Cụm Người Lạ</span>
                <span className="px-1.5 py-0.2 rounded-full bg-amber-600 text-white font-mono text-[10px] font-bold">
                  {strangerCount !== undefined ? strangerCount : 2}
                </span>
              </button>
            )}

            {/* Live Clock */}
            <div className="hidden lg:flex items-center gap-1.5 text-xs font-mono text-slate-500 bg-slate-50 px-2.5 py-1.5 rounded-lg border border-slate-200">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              <span>{currentTime}</span>
            </div>

            {/* SSE Live Status */}
            <div
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-slate-600"
              title={sseConnected ? "SSE Real-time đang kết nối" : "Đang kết nối lại..."}
            >
              <Radio
                className={`w-3.5 h-3.5 ${
                  sseConnected ? "text-emerald-500 animate-pulse" : "text-amber-500"
                }`}
              />
              <span className="hidden xl:inline">
                {sseConnected ? "Real-time SSE" : "Đang kết nối..."}
              </span>
            </div>

            {/* Lock State Pill */}
            <div
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                lockState.isLocked
                  ? "bg-slate-100 text-slate-700 border-slate-300"
                  : "bg-emerald-100 text-emerald-800 border-emerald-300 shadow-xs shadow-emerald-200"
              }`}
            >
              {lockState.isLocked ? (
                <>
                  <Lock className="w-3.5 h-3.5 text-slate-600" />
                  <span>ĐÃ KHÓA</span>
                </>
              ) : (
                <>
                  <Unlock className="w-3.5 h-3.5 text-emerald-600 animate-bounce" />
                  <span>ĐANG MỞ ({lockState.remainingRelockSeconds}s)</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};
