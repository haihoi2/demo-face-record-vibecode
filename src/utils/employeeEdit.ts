/**
 * Admin profile correction (2026-10-07): only the fields that changed are sent.
 * PATCH /api/employees/:id { name?, department?, position?, photo? } (admin).
 */
export interface EmployeeEditForm {
  name: string;
  department: string;
  position: string;
  /** New photo (data URL) or "" for no change. */
  photo: string;
}

export function employeeEditPatch(
  original: { name: string; department: string; position: string },
  form: EmployeeEditForm,
): Record<string, string> {
  const patch: Record<string, string> = {};
  const name = form.name.trim().replace(/\s+/g, " ");
  if (name !== original.name) patch.name = name;
  if (form.department !== original.department) patch.department = form.department;
  if (form.position !== original.position) patch.position = form.position;
  if (form.photo) patch.photo = form.photo;
  return patch;
}

export function employeeEditRequest(id: string, patch: Record<string, string>): { url: string; init: RequestInit } {
  return {
    url: `/api/employees/${encodeURIComponent(id)}`,
    init: { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) },
  };
}

/** Client check before sending (the server checks again). */
export function employeeEditError(form: EmployeeEditForm): string | null {
  const name = form.name.trim();
  if (!name) return "Cần nhập họ tên";
  if (name.length > 100) return "Họ tên dài tối đa 100 ký tự";
  if (!form.department) return "Cần chọn bộ phận";
  if (!form.position) return "Cần chọn chức vụ";
  return null;
}
