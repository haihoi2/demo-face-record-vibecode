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
  KeyRound,
  Video,
  Camera,
  Users,
  Building2,
} from "lucide-react";
import { SmartLockState } from "../types";
import type { OperatorRole, OperatorSessionInfo } from "../utils/api";
import { hasRole, useOperatorSession } from "../utils/session";
import { UserMenu } from "./UserMenu";

export type NavTabType =
  | "scanner"
  | "manual"
  | "register"
  | "logs"
  | "mobile"
  | "webhook"
  | "door"
  | "cameras"
  | "config"
  | "users"
  | "catalog";

/**
 * The least role that sees each tab. Hiding a tab is a courtesy - the server
 * refuses the underlying calls regardless - but it keeps people from landing
 * on screens where every button would be refused.
 */
export const TAB_MIN_ROLE: Record<NavTabType, OperatorRole> = {
  scanner: "viewer",
  manual: "operator",
  register: "operator",
  logs: "viewer",
  mobile: "viewer",
  webhook: "admin",
  door: "admin",
  cameras: "viewer",
  config: "admin",
  users: "admin",
  catalog: "operator",
};

/** Signed out, only the viewer-level tabs show; every call behind them asks to sign in. */
export const canSeeTab = (session: OperatorSessionInfo | null, tab: NavTabType): boolean =>
  TAB_MIN_ROLE[tab] === "viewer" || hasRole(session, TAB_MIN_ROLE[tab]);

const INDIGO = "bg-indigo-50 text-indigo-700 border-indigo-100";

/** The tabs in menu order. Ids stay `nav-tab-<id>`; who sees a tab is TAB_MIN_ROLE. */
const NAV_ITEMS: Array<{ id: NavTabType; label: string; title?: string; Icon: React.ComponentType<{ className?: string }>; iconClass?: string; active: string }> = [
  { id: "scanner", label: "Quét Cửa AI", title: "Giám sát trực tiếp các luồng camera và nhận diện tự động", Icon: ScanFace, active: INDIGO },
  { id: "manual", label: "Nhận diện thủ công", title: "Nhận diện thủ công qua webcam hoặc tải ảnh", Icon: Camera, iconClass: "text-indigo-600", active: INDIGO },
  { id: "register", label: "Đăng Ký Khuôn Mặt", Icon: UserPlus, active: INDIGO },
  { id: "catalog", label: "Phòng ban & Chức vụ", title: "Danh mục phòng ban và chức vụ dùng khi đăng ký nhân viên", Icon: Building2, iconClass: "text-indigo-600", active: INDIGO },
  { id: "logs", label: "Nhật Ký Vào Ra", Icon: ClipboardList, active: INDIGO },
  { id: "mobile", label: "App Di Động", Icon: Smartphone, active: INDIGO },
  { id: "webhook", label: "Webhook Eton", Icon: Send, iconClass: "text-indigo-600", active: INDIGO },
  { id: "door", label: "API Mở Cửa", Icon: KeyRound, iconClass: "text-emerald-600", active: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  { id: "cameras", label: "Luồng Camera", Icon: Video, iconClass: "text-blue-600", active: "bg-blue-50 text-blue-700 border-blue-200" },
  { id: "config", label: "Cấu Hình AI", Icon: Sliders, iconClass: "text-indigo-600", active: INDIGO },
  { id: "users", label: "Tài khoản", title: "Tạo và quản lý tài khoản đăng nhập, phân quyền", Icon: Users, iconClass: "text-indigo-600", active: INDIGO },
];

interface NavbarProps {
  activeTab: NavTabType;
  setActiveTab: (tab: NavTabType) => void;
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
  const session = useOperatorSession();
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

  const tabClass = (tab: NavTabType, active: string) =>
    `relative flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[13px] font-medium whitespace-nowrap shrink-0 transition-all ${
      activeTab === tab ? `${active} shadow-xs border font-semibold` : "text-slate-600 border border-transparent hover:text-slate-900 hover:bg-slate-100"
    }`;

  return (
    <header className="border-b border-slate-200 bg-white/95 backdrop-blur-md sticky top-0 z-30 shadow-xs">
      <div className="max-w-7xl 2xl:max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Row 1: brand, then live status and the signed-in user */}
        <div className="flex items-center justify-between gap-3 h-14">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center text-white shadow-sm shadow-indigo-200 shrink-0">
              <ScanFace className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-bold text-base sm:text-lg tracking-tight text-slate-900 whitespace-nowrap truncate">SmartFace Access</span>
                <span className="hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 whitespace-nowrap">
                  <ShieldCheck className="w-3 h-3" /> AI Vision
                </span>
              </div>
              <p className="text-xs text-slate-600 hidden lg:block truncate">
                Hệ thống nhận diện khuôn mặt &amp; mở khóa cửa tự động qua API
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {onOpenStrangers && (
              <button
                id="nav-btn-strangers"
                onClick={onOpenStrangers}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap bg-amber-50 text-amber-900 border border-amber-300 hover:bg-amber-100 transition-colors shadow-2xs cursor-pointer"
                title="Quản lý cụm ảnh người lạ và khai báo nhanh nhân viên"
              >
                <UserX className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                <span className="hidden sm:inline">Cụm Người Lạ</span>
                <span className="px-1.5 rounded-full bg-amber-600 text-white font-mono text-[10px] font-bold">
                  {strangerCount !== undefined ? strangerCount : 0}
                </span>
              </button>
            )}

            <div className="hidden lg:flex items-center gap-1.5 text-xs font-mono text-slate-500 bg-slate-50 px-2.5 py-1.5 rounded-lg border border-slate-200 whitespace-nowrap">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              <span>{currentTime}</span>
            </div>

            <div
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-slate-600 whitespace-nowrap"
              title={sseConnected ? "SSE Real-time đang kết nối" : "Đang kết nối lại..."}
            >
              <Radio className={`w-3.5 h-3.5 ${sseConnected ? "text-emerald-500 animate-pulse" : "text-amber-500"}`} />
              <span className="hidden xl:inline">{sseConnected ? "Real-time" : "Đang kết nối..."}</span>
            </div>

            <div
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold border whitespace-nowrap transition-all ${
                lockState.isLocked
                  ? "bg-slate-100 text-slate-700 border-slate-300"
                  : "bg-emerald-100 text-emerald-800 border-emerald-300 shadow-xs shadow-emerald-200"
              }`}
            >
              {lockState.isLocked ? (
                <>
                  <Lock className="w-3.5 h-3.5 text-slate-600" />
                  <span className="hidden sm:inline">ĐÃ KHÓA</span>
                </>
              ) : (
                <>
                  <Unlock className="w-3.5 h-3.5 text-emerald-600 animate-bounce" />
                  <span>ĐANG MỞ ({lockState.remainingRelockSeconds}s)</span>
                </>
              )}
            </div>

            {/* Signed-in user: role, change password, sign out */}
            <UserMenu />
          </div>
        </div>

        {/* Row 2: one line of tabs; scrolls sideways on narrow screens instead of wrapping */}
        <nav aria-label="Trang chính" className="flex items-center gap-0.5 -mx-1 px-1 pb-2 overflow-x-auto [scrollbar-width:thin]">
          {NAV_ITEMS.filter((item) => canSeeTab(session, item.id)).map(({ id, label, title, Icon, iconClass, active }) => (
            <button
              key={id}
              id={`nav-tab-${id}`}
              onClick={() => setActiveTab(id)}
              className={tabClass(id, active)}
              title={title}
              aria-current={activeTab === id ? "page" : undefined}
            >
              {/* Icons only where the row has room for them (all 11 tabs fit as text from ~1200 px) */}
              <Icon className={`hidden 2xl:block w-4 h-4 shrink-0 ${iconClass || ""}`} />
              <span>{label}</span>
              {id === "mobile" && unreadCount > 0 && (
                <span className="inline-flex items-center justify-center px-1.5 py-0.5 text-xs font-bold leading-none text-white bg-rose-500 rounded-full">
                  {unreadCount}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>
    </header>
  );
};
