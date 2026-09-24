import React, { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, LogOut, ShieldCheck, ShieldAlert, Eye } from "lucide-react";
import {
  OperatorSessionInfo,
  closeOperatorSession,
  openOperatorSession,
  readOperatorSession,
  setOperatorTokenResolver,
} from "../utils/api";

/**
 * Operator sign-in for the protected API.
 *
 * The bootstrap token is exchanged for a short-lived HttpOnly cookie and is
 * never written to browser storage - this component holds it only for the
 * duration of the submit. It also registers itself as the resolver for a 401
 * raised anywhere in the app, so an expired session reopens this dialog and
 * the original request is retried once the operator signs back in.
 */
export const OperatorSessionBar: React.FC = () => {
  const [session, setSession] = useState<OperatorSessionInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Resolves the promise handed to a 401 caller once the operator submits.
  const pending = useRef<((token: string | null) => void) | null>(null);

  useEffect(() => {
    void readOperatorSession().then(setSession);
  }, []);

  useEffect(() => {
    setOperatorTokenResolver(
      () =>
        new Promise<string | null>((resolve) => {
          pending.current = resolve;
          setError("Phiên vận hành đã hết hạn hoặc chưa đăng nhập.");
          setOpen(true);
        })
    );
    return () => setOperatorTokenResolver(null);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const settle = useCallback((value: string | null) => {
    const resolve = pending.current;
    pending.current = null;
    resolve?.(value);
  }, []);

  const dismiss = useCallback(() => {
    setOpen(false);
    setToken("");
    setError(null);
    settle(null);
  }, [settle]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const supplied = token.trim();
    if (!supplied || busy) return;
    setBusy(true);
    setError(null);
    try {
      // A 401-driven prompt hands the token back to the caller, which retries
      // the original request; a direct sign-in exchanges it here.
      const info = pending.current ? null : await openOperatorSession(supplied);
      settle(supplied);
      setSession(info ?? (await readOperatorSession()));
      setOpen(false);
      setToken("");
    } catch (err: any) {
      setError(err?.message || "Xác thực vận hành thất bại");
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await closeOperatorSession();
      setSession(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="fixed bottom-4 right-4 z-40">
        {session ? (
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white/95 backdrop-blur px-3 py-2 shadow-lg">
            {session.role === "operator" ? (
              <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
            ) : (
              <Eye className="w-4 h-4 text-indigo-600 shrink-0" />
            )}
            <div className="min-w-0 leading-tight">
              <div className="text-xs font-bold text-slate-900 truncate max-w-[12rem]">{session.actor}</div>
              <div className="text-[11px] text-slate-500">
                {session.role === "operator" ? "Toàn quyền vận hành" : "Chỉ xem"}
              </div>
            </div>
            <button
              type="button"
              onClick={signOut}
              disabled={busy}
              data-testid="btn-operator-sign-out"
              title="Kết thúc phiên vận hành"
              className="ml-1 p-1.5 rounded-lg text-slate-500 hover:text-rose-600 hover:bg-rose-50 transition disabled:opacity-50"
            >
              <LogOut className="w-4 h-4" />
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
            Đăng nhập vận hành
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
                <h2 className="font-bold text-slate-900 text-sm">Phiên vận hành</h2>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Ảnh sinh trắc học, nhật ký ra vào và thao tác mở cửa yêu cầu phiên vận hành.
                </p>
              </div>
            </div>

            <div>
              <label htmlFor="operator-token" className="block text-[11px] font-semibold text-slate-600 mb-1">
                Mã phiên vận hành
              </label>
              <input
                id="operator-token"
                ref={inputRef}
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                data-testid="input-operator-token"
                className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm font-mono focus:ring-2 focus:ring-slate-900 outline-none"
              />
              <p className="text-[11px] text-slate-500 mt-1.5">
                Mã được đổi lấy cookie phiên và không được lưu trong trình duyệt.
              </p>
            </div>

            {error && (
              <p role="alert" className="text-[11px] font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-2">
                {error}
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={dismiss}
                className="px-3 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 transition"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={busy || !token.trim()}
                data-testid="btn-operator-submit"
                className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition disabled:opacity-50"
              >
                {busy ? "Đang xác thực..." : "Đăng nhập"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
};
