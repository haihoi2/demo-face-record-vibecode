import React, { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, LogOut, ShieldCheck, ShieldAlert, Eye, UserCog, ChevronUp } from "lucide-react";
import {
  OperatorCredentials,
  changeOwnPassword,
  closeOperatorSession,
  openOperatorSession,
  readOperatorSession,
  setOperatorLoginResolver,
} from "../utils/api";
import { ROLE_BADGE, setOperatorSession, useOperatorSession } from "../utils/session";

/**
 * Sign-in, role display, password change and sign-out.
 *
 * Everyday login is a named account (username + password). The bootstrap code
 * from the server environment is still accepted behind "Dùng mã khởi tạo" - it
 * signs in as admin and is the recovery path if every admin account is lost.
 * Neither secret is written to browser storage: the server answers with an
 * HttpOnly cookie. This component also answers a 401 raised anywhere in the
 * app, so an expired session reopens the dialog and the failed request is
 * retried once the person signs back in.
 */
export const OperatorSessionBar: React.FC = () => {
  const session = useOperatorSession();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"account" | "token">("account");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNext, setPwNext] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);
  const firstField = useRef<HTMLInputElement | null>(null);
  // Resolves the promise handed to a 401 caller once the person signs in (or cancels).
  const pending = useRef<((signedIn: boolean) => void) | null>(null);

  useEffect(() => {
    void readOperatorSession().then(setOperatorSession);
  }, []);

  useEffect(() => {
    setOperatorLoginResolver(
      () =>
        new Promise<boolean>((resolve) => {
          pending.current = resolve;
          setOperatorSession(null);
          setError("Phiên đăng nhập đã hết hạn hoặc chưa đăng nhập.");
          setOpen(true);
        })
    );
    return () => setOperatorLoginResolver(null);
  }, []);

  useEffect(() => {
    if (open) firstField.current?.focus();
  }, [open, mode]);

  const settle = useCallback((signedIn: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    resolve?.(signedIn);
  }, []);

  const resetForm = () => {
    setUsername("");
    setPassword("");
    setToken("");
    setError(null);
  };

  const dismiss = useCallback(() => {
    setOpen(false);
    resetForm();
    settle(false);
  }, [settle]);

  const canSubmit = mode === "account" ? username.trim() !== "" && password !== "" : token.trim() !== "";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      const credentials: OperatorCredentials =
        mode === "account" ? { username: username.trim(), password } : { token: token.trim() };
      const info = await openOperatorSession(credentials);
      setOperatorSession(info);
      setOpen(false);
      resetForm();
      settle(true);
    } catch (err: any) {
      setError(err?.message || "Đăng nhập thất bại");
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setMenuOpen(false);
    setBusy(true);
    try {
      await closeOperatorSession();
    } finally {
      setOperatorSession(null);
      setBusy(false);
    }
  };

  const openPasswordDialog = () => {
    setMenuOpen(false);
    setPwCurrent("");
    setPwNext("");
    setPwConfirm("");
    setPwError(null);
    setPwDone(false);
    setPwOpen(true);
  };

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pwNext !== pwConfirm) {
      setPwError("Mật khẩu nhập lại không khớp");
      return;
    }
    setBusy(true);
    setPwError(null);
    try {
      setOperatorSession(await changeOwnPassword(pwCurrent, pwNext));
      setPwDone(true);
      setPwCurrent("");
      setPwNext("");
      setPwConfirm("");
    } catch (err: any) {
      setPwError(err?.message || "Đổi mật khẩu thất bại");
    } finally {
      setBusy(false);
    }
  };

  const badge = session ? ROLE_BADGE[session.role] : null;
  const RoleIcon = session?.role === "admin" ? ShieldCheck : session?.role === "operator" ? UserCog : Eye;

  return (
    <>
      <div className="fixed bottom-4 right-4 z-40">
        {session && badge ? (
          <div className="relative">
            {menuOpen && (
              <div className="absolute bottom-full right-0 mb-2 w-56 rounded-xl border border-slate-200 bg-white shadow-xl p-1.5">
                {session.authMethod === "account" && (
                  <button
                    type="button"
                    onClick={openPasswordDialog}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    <KeyRound className="w-4 h-4" /> Đổi mật khẩu
                  </button>
                )}
                <button
                  type="button"
                  onClick={signOut}
                  data-testid="btn-operator-sign-out"
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-rose-700 hover:bg-rose-50"
                >
                  <LogOut className="w-4 h-4" /> Đăng xuất
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              disabled={busy}
              aria-expanded={menuOpen}
              className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white/95 backdrop-blur px-3 py-2 shadow-lg hover:border-slate-300 transition focus-visible:outline-2 focus-visible:outline-slate-900"
            >
              <RoleIcon className="w-4 h-4 text-slate-600 shrink-0" />
              <div className="min-w-0 leading-tight text-left">
                <div className="text-xs font-bold text-slate-900 truncate max-w-[12rem]">{session.displayName}</div>
                <span className={`inline-block mt-0.5 px-1.5 py-px rounded border text-[10px] font-bold ${badge.className}`}>
                  {badge.label}
                  {session.authMethod === "token" ? " · mã khởi tạo" : ""}
                </span>
              </div>
              <ChevronUp className={`w-3.5 h-3.5 text-slate-400 transition ${menuOpen ? "" : "rotate-180"}`} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            data-testid="btn-operator-sign-in"
            className="flex items-center gap-2 rounded-xl bg-slate-900 text-white px-3.5 py-2.5 text-xs font-bold shadow-lg hover:bg-slate-800 transition"
          >
            <ShieldAlert className="w-4 h-4" />
            Đăng nhập
          </button>
        )}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <form
            onSubmit={submit}
            className="w-full max-w-sm rounded-2xl bg-white shadow-2xl border border-slate-200 p-5 space-y-4"
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-slate-900 text-white flex items-center justify-center shrink-0">
                <KeyRound className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-bold text-slate-900 text-sm">Đăng nhập hệ thống</h2>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Nhật ký ra vào, ảnh sinh trắc học và thao tác vận hành yêu cầu đăng nhập.
                </p>
              </div>
            </div>

            {mode === "account" ? (
              <div className="space-y-3">
                <div>
                  <label htmlFor="login-username" className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Tên đăng nhập
                  </label>
                  <input
                    id="login-username"
                    ref={firstField}
                    type="text"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    data-testid="input-login-username"
                    className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm focus:ring-2 focus:ring-slate-900 outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="login-password" className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Mật khẩu
                  </label>
                  <input
                    id="login-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    data-testid="input-login-password"
                    className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm focus:ring-2 focus:ring-slate-900 outline-none"
                  />
                </div>
              </div>
            ) : (
              <div>
                <label htmlFor="operator-token" className="block text-[11px] font-semibold text-slate-600 mb-1">
                  Mã khởi tạo (quản trị)
                </label>
                <input
                  id="operator-token"
                  ref={firstField}
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  data-testid="input-operator-token"
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm font-mono focus:ring-2 focus:ring-slate-900 outline-none"
                />
                <p className="text-[11px] text-slate-500 mt-1.5">
                  Mã nằm trong tệp <code className="font-mono">.env</code> của máy chủ. Dùng để tạo tài khoản đầu tiên hoặc khôi phục quyền quản trị.
                </p>
              </div>
            )}

            {error && (
              <p role="alert" className="text-[11px] font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-2">
                {error}
              </p>
            )}

            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => {
                  setMode(mode === "account" ? "token" : "account");
                  setError(null);
                }}
                className="text-[11px] font-semibold text-slate-500 hover:text-slate-800 underline underline-offset-2"
              >
                {mode === "account" ? "Dùng mã khởi tạo" : "Dùng tài khoản"}
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={dismiss}
                  className="px-3 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 transition"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={busy || !canSubmit}
                  data-testid="btn-operator-submit"
                  className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition disabled:opacity-50"
                >
                  {busy ? "Đang xác thực..." : "Đăng nhập"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {pwOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <form
            onSubmit={submitPassword}
            className="w-full max-w-sm rounded-2xl bg-white shadow-2xl border border-slate-200 p-5 space-y-3"
          >
            <h2 className="font-bold text-slate-900 text-sm">Đổi mật khẩu</h2>
            {pwDone ? (
              <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                Đã đổi mật khẩu. Các phiên đăng nhập khác của tài khoản này đã bị đăng xuất.
              </p>
            ) : (
              <>
                {[
                  { id: "pw-current", label: "Mật khẩu hiện tại", value: pwCurrent, set: setPwCurrent, auto: "current-password" },
                  { id: "pw-next", label: "Mật khẩu mới (ít nhất 10 ký tự)", value: pwNext, set: setPwNext, auto: "new-password" },
                  { id: "pw-confirm", label: "Nhập lại mật khẩu mới", value: pwConfirm, set: setPwConfirm, auto: "new-password" },
                ].map((f) => (
                  <div key={f.id}>
                    <label htmlFor={f.id} className="block text-[11px] font-semibold text-slate-600 mb-1">{f.label}</label>
                    <input
                      id={f.id}
                      type="password"
                      autoComplete={f.auto}
                      value={f.value}
                      onChange={(e) => f.set(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:ring-2 focus:ring-slate-900 outline-none"
                    />
                  </div>
                ))}
                {pwError && (
                  <p role="alert" className="text-[11px] font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-2">
                    {pwError}
                  </p>
                )}
              </>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setPwOpen(false)}
                className="px-3 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 transition"
              >
                {pwDone ? "Đóng" : "Hủy"}
              </button>
              {!pwDone && (
                <button
                  type="submit"
                  disabled={busy || !pwCurrent || !pwNext || !pwConfirm}
                  className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition disabled:opacity-50"
                >
                  Đổi mật khẩu
                </button>
              )}
            </div>
          </form>
        </div>
      )}
    </>
  );
};
