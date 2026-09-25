import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, KeyRound, LogIn, LogOut } from "lucide-react";
import { closeOperatorSession } from "../utils/api";
import { ROLE_BADGE, requestSessionUi, setOperatorSession, useOperatorSession } from "../utils/session";

/** Up to two initials from a display name: "Nguyễn Huy" -> "NH". */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

/**
 * The signed-in person, top right of the navbar: who, which role, and the
 * account actions (change password, sign out). Signed out, it is the way in.
 */
export const UserMenu: React.FC = () => {
  const session = useOperatorSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!session) {
    return (
      <button
        type="button"
        onClick={() => requestSessionUi("login")}
        data-testid="btn-operator-sign-in"
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition shadow-2xs"
      >
        <LogIn className="w-3.5 h-3.5" />
        <span>Đăng nhập</span>
      </button>
    );
  }

  const badge = ROLE_BADGE[session.role];

  const signOut = async () => {
    setOpen(false);
    setBusy(true);
    try {
      await closeOperatorSession();
    } finally {
      setOperatorSession(null);
      setBusy(false);
    }
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="btn-user-menu"
        className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 transition focus-visible:outline-2 focus-visible:outline-slate-900"
        title={`${session.displayName} — ${badge.label}`}
      >
        <span className="w-7 h-7 rounded-md bg-slate-900 text-white text-[11px] font-bold flex items-center justify-center shrink-0">
          {initialsOf(session.displayName)}
        </span>
        <span className="hidden md:flex flex-col items-start leading-tight min-w-0">
          <span className="text-xs font-bold text-slate-900 truncate max-w-[9rem]">{session.displayName}</span>
          <span className={`mt-0.5 px-1.5 py-px rounded border text-[10px] font-bold ${badge.className}`}>{badge.label}</span>
        </span>
        <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 w-64 rounded-xl border border-slate-200 bg-white shadow-xl z-50 overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-slate-100">
            <div className="text-sm font-bold text-slate-900 truncate">{session.displayName}</div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
              {session.username ? <span className="font-mono truncate">{session.username}</span> : <span>Mã khởi tạo</span>}
              <span className={`px-1.5 py-px rounded border font-bold ${badge.className}`}>{badge.label}</span>
            </div>
          </div>
          <div className="p-1.5">
            {session.authMethod === "account" && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  requestSessionUi("password");
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                <KeyRound className="w-4 h-4" /> Đổi mật khẩu
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={signOut}
              data-testid="btn-operator-sign-out"
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-rose-700 hover:bg-rose-50"
            >
              <LogOut className="w-4 h-4" /> Đăng xuất
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
