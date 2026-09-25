import React, { useState } from "react";
import { Building2, BadgeCheck, Plus, Pencil, Trash2, Check, X, EyeOff, Eye, RefreshCw } from "lucide-react";
import { operatorJsonFetch } from "../utils/api";
import { hasRole, useOperatorSession } from "../utils/session";
import { ORG_KIND_LABEL, OrgEntry, OrgKind, useOrgCatalog } from "../utils/orgCatalog";

interface OrgCatalogPageProps {
  /** Renaming an entry renames it on every employee; reload the roster afterwards. */
  onEmployeesChanged?: () => void;
}

const KIND_ICON: Record<OrgKind, React.ElementType> = { departments: Building2, positions: BadgeCheck };
const KIND_PLACEHOLDER: Record<OrgKind, string> = {
  departments: "vd: Phòng Kế Toán",
  positions: "vd: Trưởng ca bảo vệ",
};

/**
 * Departments (phòng ban) and positions (chức vụ) that employees are assigned
 * from. Operator and admin manage the lists; a viewer sees them read-only.
 */
export const OrgCatalogPage: React.FC<OrgCatalogPageProps> = ({ onEmployeesChanged }) => {
  const session = useOperatorSession();
  const canEdit = hasRole(session, "operator");
  const catalog = useOrgCatalog();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call = async (method: "POST" | "PUT" | "DELETE", url: string, body?: object) => {
    setError(null);
    setNotice(null);
    const res = await operatorJsonFetch<any>(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok || !res.data?.success) {
      setError(res.data?.error || res.error || `Thao tác thất bại (HTTP ${res.status})`);
      return null;
    }
    await catalog.reload();
    return res.data;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-slate-900">Phòng ban &amp; Chức vụ</h1>
          <p className="text-xs text-slate-500 max-w-2xl">
            Danh sách dùng khi đăng ký nhân viên mới. Đổi tên sẽ cập nhật cho mọi nhân viên đang dùng mục đó;
            mục đang có nhân viên thì không xóa được — hãy ngừng sử dụng thay vì xóa.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void catalog.reload()}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-slate-600 border border-slate-200 bg-white hover:bg-slate-50 shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${catalog.loading ? "animate-spin" : ""}`} /> Làm mới
        </button>
      </div>

      {!canEdit && (
        <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          Bạn đang xem ở chế độ chỉ đọc. Thêm, sửa, xóa cần quyền Vận hành hoặc Quản trị.
        </p>
      )}
      {(error || catalog.error) && (
        <p role="alert" className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
          {error || catalog.error}
        </p>
      )}
      {notice && !error && (
        <p className="text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">{notice}</p>
      )}

      <div className="grid gap-6 lg:grid-cols-2 items-start">
        {(["departments", "positions"] as OrgKind[]).map((kind) => (
          <OrgList
            key={kind}
            kind={kind}
            entries={kind === "departments" ? catalog.departments : catalog.positions}
            loading={catalog.loading}
            canEdit={canEdit}
            onCreate={async (name) => {
              const data = await call("POST", `/api/org/${kind}`, { name });
              if (data) setNotice(`Đã thêm ${ORG_KIND_LABEL[kind].toLowerCase()} "${name}".`);
              return Boolean(data);
            }}
            onRename={async (entry, name) => {
              const data = await call("PUT", `/api/org/${kind}/${encodeURIComponent(entry.id)}`, { name });
              if (!data) return false;
              const moved = Number(data.renamedEmployees || 0);
              setNotice(
                `Đã đổi "${entry.name}" thành "${name}"` +
                  (moved > 0 ? ` và cập nhật ${moved} nhân viên.` : ".")
              );
              if (moved > 0) onEmployeesChanged?.();
              return true;
            }}
            onToggleActive={async (entry) => {
              const data = await call("PUT", `/api/org/${kind}/${encodeURIComponent(entry.id)}`, { active: !entry.active });
              if (data) setNotice(entry.active ? `Đã ngừng sử dụng "${entry.name}".` : `Đã dùng lại "${entry.name}".`);
            }}
            onDelete={async (entry) => {
              if (!window.confirm(`Xóa ${ORG_KIND_LABEL[kind].toLowerCase()} "${entry.name}"?`)) return;
              const data = await call("DELETE", `/api/org/${kind}/${encodeURIComponent(entry.id)}`);
              if (data) setNotice(`Đã xóa "${entry.name}".`);
            }}
          />
        ))}
      </div>
    </div>
  );
};

interface OrgListProps {
  kind: OrgKind;
  entries: OrgEntry[];
  loading: boolean;
  canEdit: boolean;
  onCreate: (name: string) => Promise<boolean>;
  onRename: (entry: OrgEntry, name: string) => Promise<boolean>;
  onToggleActive: (entry: OrgEntry) => Promise<void>;
  onDelete: (entry: OrgEntry) => Promise<void>;
}

const OrgList: React.FC<OrgListProps> = ({ kind, entries, loading, canEdit, onCreate, onRename, onToggleActive, onDelete }) => {
  const Icon = KIND_ICON[kind];
  const label = ORG_KIND_LABEL[kind];
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);
  const activeCount = entries.filter((e) => e.active).length;

  const submitNew = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    if (await onCreate(name)) setNewName("");
    setBusy(false);
  };

  const submitRename = async (entry: OrgEntry) => {
    const name = editName.trim();
    if (!name || name === entry.name) {
      setEditingId(null);
      return;
    }
    setBusy(true);
    if (await onRename(entry, name)) setEditingId(null);
    setBusy(false);
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
      <header className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
        <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <Icon className="w-4 h-4 text-indigo-600" /> {label}
        </h2>
        <span className="text-[11px] text-slate-500 tabular-nums">
          {activeCount} đang dùng · {entries.length} tổng
        </span>
      </header>

      {canEdit && (
        <form onSubmit={submitNew} className="flex gap-2 px-5 py-3 border-b border-slate-100 bg-slate-50/60">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={KIND_PLACEHOLDER[kind]}
            maxLength={120}
            aria-label={`Tên ${label.toLowerCase()} mới`}
            className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 outline-none"
          />
          <button
            type="submit"
            disabled={busy || !newName.trim()}
            className="flex items-center gap-1 px-3 py-2 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" /> Thêm
          </button>
        </form>
      )}

      <ul className="divide-y divide-slate-100">
        {!loading && entries.length === 0 && (
          <li className="px-5 py-6 text-center text-xs text-slate-500">Chưa có {label.toLowerCase()} nào.</li>
        )}
        {entries.map((entry) => {
          const editing = editingId === entry.id;
          return (
            <li key={entry.id} className={`flex items-center gap-3 px-5 py-2.5 ${entry.active ? "" : "bg-slate-50/70"}`}>
              <div className="flex-1 min-w-0">
                {editing ? (
                  <input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submitRename(entry);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    maxLength={120}
                    aria-label={`Tên mới cho ${entry.name}`}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-indigo-400 text-sm focus:ring-2 focus:ring-indigo-500/30 outline-none"
                  />
                ) : (
                  <div className={`text-sm font-medium truncate ${entry.active ? "text-slate-900" : "text-slate-400 line-through"}`}>
                    {entry.name}
                  </div>
                )}
                <div className="text-[11px] text-slate-500">
                  {entry.employeeCount > 0 ? `${entry.employeeCount} nhân viên` : "Chưa có nhân viên"}
                  {!entry.active && " · ngừng sử dụng"}
                </div>
              </div>

              {canEdit && (
                <div className="flex items-center gap-0.5 shrink-0">
                  {editing ? (
                    <>
                      <button type="button" disabled={busy} onClick={() => void submitRename(entry)} title="Lưu"
                        className="p-2 rounded-lg text-emerald-700 hover:bg-emerald-50 disabled:opacity-40">
                        <Check className="w-4 h-4" />
                      </button>
                      <button type="button" onClick={() => setEditingId(null)} title="Hủy"
                        className="p-2 rounded-lg text-slate-500 hover:bg-slate-100">
                        <X className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" disabled={busy}
                        onClick={() => { setEditingId(entry.id); setEditName(entry.name); }}
                        title={entry.employeeCount > 0 ? `Đổi tên (cập nhật ${entry.employeeCount} nhân viên)` : "Đổi tên"}
                        className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-40">
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button type="button" disabled={busy} onClick={() => void onToggleActive(entry)}
                        title={entry.active ? "Ngừng sử dụng (ẩn khỏi form đăng ký)" : "Dùng lại"}
                        className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-40">
                        {entry.active ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                      <button type="button" disabled={busy || entry.employeeCount > 0} onClick={() => void onDelete(entry)}
                        title={entry.employeeCount > 0 ? `Không xóa được: ${entry.employeeCount} nhân viên đang dùng` : "Xóa"}
                        className="p-2 rounded-lg text-rose-600 hover:bg-rose-50 disabled:opacity-30 disabled:hover:bg-transparent">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
