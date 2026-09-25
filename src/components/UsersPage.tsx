import React, { useCallback, useEffect, useState } from "react";
import { Users, UserPlus, KeyRound, Lock, Unlock, Trash2, RefreshCw, Wand2, Copy, Check } from "lucide-react";
import { operatorJsonFetch, OperatorRole } from "../utils/api";
import { ROLE_BADGE, useOperatorSession } from "../utils/session";

interface AccountRow {
  id: string;
  username: string;
  displayName: string;
  role: OperatorRole;
  disabled: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  createdBy: string | null;
}

const ROLE_HELP: Record<OperatorRole, string> = {
  admin: "Toàn quyền: mở cửa thủ công, cấu hình cửa/webhook/AI, xóa dữ liệu, quản lý tài khoản",
  operator: "Xem lịch sử, thêm/sửa luồng camera, duyệt thêm nhân viên, đăng ký khuôn mặt",
  viewer: "Chỉ xem toàn bộ lịch sử ra vào",
};

/** A readable random password: 4 groups of 4 from an unambiguous alphabet. */
function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

const formatWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" }) : "—";

export const UsersPage: React.FC = () => {
  const me = useOperatorSession();
  const [users, setUsers] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [newUsername, setNewUsername] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRole, setNewRole] = useState<OperatorRole>("operator");
  const [newPassword, setNewPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [shownPassword, setShownPassword] = useState<{ username: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await operatorJsonFetch<{ success: boolean; users: AccountRow[]; error?: string }>("/api/users");
    if (res.ok && res.data?.success) setUsers(res.data.users);
    else setError((res.data as any)?.error || res.error || `Không tải được danh sách (HTTP ${res.status})`);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (id: string, method: "PUT" | "DELETE", body: object | undefined, success: string) => {
    setBusyId(id);
    setError(null);
    setNotice(null);
    const res = await operatorJsonFetch<any>(`/api/users/${encodeURIComponent(id)}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : "{}",
    });
    setBusyId(null);
    if (!res.ok || !res.data?.success) {
      setError(res.data?.error || res.error || `Thao tác thất bại (HTTP ${res.status})`);
      return false;
    }
    setNotice(success);
    await load();
    return true;
  };

  const createAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setError(null);
    setNotice(null);
    const username = newUsername.trim().toLowerCase();
    const res = await operatorJsonFetch<any>("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, displayName: newDisplayName.trim() || username, role: newRole, password: newPassword }),
    });
    setCreating(false);
    if (!res.ok || !res.data?.success) {
      setError(res.data?.error || res.error || `Tạo tài khoản thất bại (HTTP ${res.status})`);
      return;
    }
    setShownPassword({ username, password: newPassword });
    setCopied(false);
    setNewUsername("");
    setNewDisplayName("");
    setNewPassword("");
    setNotice(`Đã tạo tài khoản ${username}.`);
    await load();
  };

  const resetPassword = async (row: AccountRow) => {
    if (!window.confirm(`Đặt lại mật khẩu cho ${row.username}? Mọi phiên đăng nhập của tài khoản này sẽ bị đăng xuất.`)) return;
    const password = generatePassword();
    if (await mutate(row.id, "PUT", { password }, `Đã đặt lại mật khẩu cho ${row.username}.`)) {
      setShownPassword({ username: row.username, password });
      setCopied(false);
    }
  };

  const copyPassword = async () => {
    if (!shownPassword) return;
    try {
      await navigator.clipboard.writeText(shownPassword.password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-slate-900 text-white flex items-center justify-center">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900">Tài khoản</h1>
            <p className="text-xs text-slate-500">Mỗi người một tài khoản — nhật ký thao tác ghi đúng người thực hiện.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-slate-600 border border-slate-200 bg-white hover:bg-slate-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Làm mới
        </button>
      </div>

      {error && (
        <p role="alert" className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{error}</p>
      )}
      {notice && !error && (
        <p className="text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">{notice}</p>
      )}

      {shownPassword && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 space-y-2">
          <p className="text-xs font-bold text-amber-900">
            Mật khẩu của <span className="font-mono">{shownPassword.username}</span> — chỉ hiển thị một lần
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-sm bg-white border border-amber-200 rounded-lg px-3 py-2 select-all">
              {shownPassword.password}
            </code>
            <button type="button" onClick={copyPassword} className="flex items-center gap-1 px-3 py-2 rounded-lg text-xs font-semibold bg-white border border-amber-300 hover:bg-amber-100">
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied ? "Đã chép" : "Chép"}
            </button>
            <button type="button" onClick={() => setShownPassword(null)} className="px-3 py-2 rounded-lg text-xs font-semibold text-amber-900 hover:bg-amber-100">
              Ẩn
            </button>
          </div>
          <p className="text-[11px] text-amber-800">
            Gửi mật khẩu này trực tiếp cho người dùng. Họ nên đổi mật khẩu sau lần đăng nhập đầu tiên (menu góc dưới phải → Đổi mật khẩu).
          </p>
        </div>
      )}

      <form onSubmit={createAccount} className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
        <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <UserPlus className="w-4 h-4" /> Tạo tài khoản
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-[11px] font-semibold text-slate-600">
            Tên đăng nhập
            <input
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              autoCapitalize="none"
              spellCheck={false}
              placeholder="vd: huy.nguyen"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-normal focus:ring-2 focus:ring-slate-900 outline-none"
            />
          </label>
          <label className="text-[11px] font-semibold text-slate-600">
            Tên hiển thị
            <input
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              placeholder="vd: Nguyễn Huy"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-normal focus:ring-2 focus:ring-slate-900 outline-none"
            />
          </label>
          <label className="text-[11px] font-semibold text-slate-600">
            Vai trò
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as OperatorRole)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-normal bg-white focus:ring-2 focus:ring-slate-900 outline-none"
            >
              <option value="viewer">Chỉ xem</option>
              <option value="operator">Vận hành</option>
              <option value="admin">Quản trị</option>
            </select>
            <span className="block mt-1 font-normal text-slate-500">{ROLE_HELP[newRole]}</span>
          </label>
          <label className="text-[11px] font-semibold text-slate-600">
            Mật khẩu ban đầu (ít nhất 10 ký tự)
            <div className="mt-1 flex gap-2">
              <input
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                type="text"
                autoComplete="new-password"
                spellCheck={false}
                className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono font-normal focus:ring-2 focus:ring-slate-900 outline-none"
              />
              <button
                type="button"
                onClick={() => setNewPassword(generatePassword())}
                title="Tạo mật khẩu ngẫu nhiên"
                className="flex items-center gap-1 px-3 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                <Wand2 className="w-3.5 h-3.5" /> Tạo
              </button>
            </div>
          </label>
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={creating || !newUsername.trim() || newPassword.length < 10}
            className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 disabled:opacity-50"
          >
            {creating ? "Đang tạo..." : "Tạo tài khoản"}
          </button>
        </div>
      </form>

      <div className="rounded-2xl border border-slate-200 bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="text-left px-4 py-3 font-semibold">Tài khoản</th>
              <th className="text-left px-4 py-3 font-semibold">Vai trò</th>
              <th className="text-left px-4 py-3 font-semibold">Trạng thái</th>
              <th className="text-left px-4 py-3 font-semibold">Đăng nhập gần nhất</th>
              <th className="text-right px-4 py-3 font-semibold">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!loading && users.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-xs text-slate-500">
                  Chưa có tài khoản nào. Tạo tài khoản đầu tiên ở trên — sau đó mọi người đăng nhập bằng tài khoản riêng thay vì mã khởi tạo.
                </td>
              </tr>
            )}
            {users.map((u) => {
              const isMe = me?.username === u.username;
              const busy = busyId === u.id;
              return (
                <tr key={u.id} className={u.disabled ? "bg-slate-50/70 text-slate-400" : ""}>
                  <td className="px-4 py-3">
                    <div className="font-semibold text-slate-900">
                      {u.displayName} {isMe && <span className="text-[10px] font-bold text-indigo-600">(bạn)</span>}
                    </div>
                    <div className="font-mono text-xs text-slate-500">{u.username}</div>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={u.role}
                      disabled={busy || isMe}
                      title={isMe ? "Không thể tự đổi vai trò của chính mình" : ROLE_HELP[u.role]}
                      onChange={(e) => void mutate(u.id, "PUT", { role: e.target.value }, `Đã đổi vai trò của ${u.username}.`)}
                      className={`px-2 py-1 rounded-md border text-xs font-bold ${ROLE_BADGE[u.role].className} disabled:opacity-70`}
                    >
                      <option value="viewer">Chỉ xem</option>
                      <option value="operator">Vận hành</option>
                      <option value="admin">Quản trị</option>
                    </select>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {u.disabled ? (
                      <span className="font-semibold text-slate-500">Đã vô hiệu hóa</span>
                    ) : u.locked ? (
                      <span className="font-semibold text-amber-700">Tạm khóa (sai mật khẩu)</span>
                    ) : (
                      <span className="font-semibold text-emerald-700">Hoạt động</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs tabular-nums text-slate-600">{formatWhen(u.lastLoginAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      {u.locked && !u.disabled && (
                        <button type="button" disabled={busy} onClick={() => void mutate(u.id, "PUT", { unlock: true }, `Đã mở khóa ${u.username}.`)}
                          title="Mở khóa đăng nhập" className="p-2 rounded-lg text-amber-700 hover:bg-amber-50 disabled:opacity-40">
                          <Unlock className="w-4 h-4" />
                        </button>
                      )}
                      <button type="button" disabled={busy} onClick={() => void resetPassword(u)}
                        title="Đặt lại mật khẩu" className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-40">
                        <KeyRound className="w-4 h-4" />
                      </button>
                      <button type="button" disabled={busy || isMe}
                        onClick={() => void mutate(u.id, "PUT", { disabled: !u.disabled }, u.disabled ? `Đã kích hoạt lại ${u.username}.` : `Đã vô hiệu hóa ${u.username}.`)}
                        title={isMe ? "Không thể tự vô hiệu hóa" : u.disabled ? "Kích hoạt lại" : "Vô hiệu hóa (đăng xuất ngay)"}
                        className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-40">
                        {u.disabled ? <Unlock className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
                      </button>
                      <button type="button" disabled={busy || isMe}
                        onClick={() => {
                          if (window.confirm(`Xóa vĩnh viễn tài khoản ${u.username}?`)) void mutate(u.id, "DELETE", undefined, `Đã xóa ${u.username}.`);
                        }}
                        title={isMe ? "Không thể tự xóa" : "Xóa tài khoản"}
                        className="p-2 rounded-lg text-rose-600 hover:bg-rose-50 disabled:opacity-40">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
