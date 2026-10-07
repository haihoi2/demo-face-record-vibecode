import React, { useState } from "react";
import { X, Upload, RefreshCw } from "lucide-react";
import type { Employee } from "../types";
import { compressImage, operatorJsonFetch } from "../utils/api";
import { orgOptions, useOrgCatalog } from "../utils/orgCatalog";
import { employeeEditError, employeeEditPatch, employeeEditRequest } from "../utils/employeeEdit";
import { employeeAvatarSrc } from "../utils/employeeAvatar";
import { templateRejectReason } from "../utils/templateReject";
import { ProtectedImage } from "./ProtectedImage";

/**
 * Admin: correct an employee's name, department and position, or upload a new
 * registration photo (it also becomes a face template). The employee code and
 * past access events are not changed.
 */
export const EmployeeEditDialog: React.FC<{
  employee: Employee & { hasPhoto?: boolean };
  onClose: () => void;
  onSaved: (employee: Employee, note: string) => void;
}> = ({ employee, onClose, onSaved }) => {
  const catalog = useOrgCatalog();
  const departments = orgOptions(catalog.departments);
  const positions = orgOptions(catalog.positions);
  const [name, setName] = useState(employee.name);
  const [department, setDepartment] = useState(employee.department);
  const [position, setPosition] = useState(employee.position);
  const [photo, setPhoto] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A value no longer in the catalog still shows (and is only replaced if the admin picks another).
  const withCurrent = (list: string[], current: string) => (current && !list.includes(current) ? [current, ...list] : list);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setPhoto(await compressImage(file, 640, 640, 0.82));
      setError(null);
    } catch {
      setError("Không xử lý được ảnh này; hãy chọn ảnh khác.");
    }
  };

  const save = async () => {
    const form = { name, department, position, photo };
    const invalid = employeeEditError(form);
    if (invalid) return setError(invalid);
    const patch = employeeEditPatch(employee, form);
    if (!Object.keys(patch).length) return onClose();
    setSaving(true);
    setError(null);
    try {
      const { url, init } = employeeEditRequest(employee.id, patch);
      const res = await operatorJsonFetch<any>(url, init);
      if (!res.ok || !res.data?.success) throw new Error(res.data?.error || `HTTP ${res.status}`);
      const rejected = res.data.faceTemplateRejected;
      const note = rejected
        ? `Đã lưu hồ sơ. Ảnh mới chưa tạo được mẫu nhận diện: ${templateRejectReason(rejected)}`
        : res.data.faceTemplate
          ? "Đã lưu hồ sơ và tạo mẫu nhận diện từ ảnh mới."
          : "Đã lưu hồ sơ.";
      onSaved(res.data.employee, note);
    } catch (err: any) {
      setError(err?.message || "Lỗi máy chủ");
    } finally {
      setSaving(false);
    }
  };

  const currentPhoto = photo || employeeAvatarSrc(employee);

  return (
    <div className="fixed inset-0 z-[60] overflow-y-auto bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6">
      <div role="dialog" aria-modal="true" aria-labelledby="employee-edit-title" className="w-full max-w-md bg-white rounded-3xl shadow-xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="employee-edit-title" className="text-base font-bold text-slate-900">Sửa hồ sơ nhân viên</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Mã {employee.employeeCode}. Nhật ký ra vào cũ giữ nguyên tên lúc ghi nhận.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Đóng" className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-3">
          <div className="w-20 h-20 rounded-xl overflow-hidden bg-slate-200 shrink-0">
            {currentPhoto ? <ProtectedImage src={currentPhoto} alt={`Ảnh đăng ký của ${employee.name}`} className="w-full h-full object-cover" /> : null}
          </div>
          <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer focus-within:ring-2 focus-within:ring-indigo-500">
            <Upload className="w-3.5 h-3.5" />
            {photo ? "Đổi ảnh khác" : employee.hasPhoto ? "Thay ảnh đăng ký" : "Thêm ảnh đăng ký"}
            <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={onFile} />
          </label>
        </div>
        {photo && <p className="text-[11px] text-slate-500">Ảnh mới sẽ thành ảnh đăng ký và một mẫu nhận diện (chỉ một khuôn mặt, nhìn thẳng).</p>}

        <div className="space-y-3">
          <label className="block text-xs font-semibold text-slate-700">
            Họ tên
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} className="mt-1 w-full px-3 py-2 rounded-xl border border-slate-200 text-sm font-normal focus:outline-hidden focus:ring-2 focus:ring-indigo-500" />
          </label>
          <label className="block text-xs font-semibold text-slate-700">
            Bộ phận
            <select value={department} onChange={(e) => setDepartment(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-xl border border-slate-200 text-sm font-normal bg-white focus:outline-hidden focus:ring-2 focus:ring-indigo-500">
              {withCurrent(departments, employee.department).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <label className="block text-xs font-semibold text-slate-700">
            Chức vụ
            <select value={position} onChange={(e) => setPosition(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-xl border border-slate-200 text-sm font-normal bg-white focus:outline-hidden focus:ring-2 focus:ring-indigo-500">
              {withCurrent(positions, employee.position).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
        </div>

        {error && <p role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-2">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100">Hủy</button>
          <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
            {saving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />} Lưu
          </button>
        </div>
      </div>
    </div>
  );
};

export default EmployeeEditDialog;
