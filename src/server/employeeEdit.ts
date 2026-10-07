/**
 * Admin correction of an employee's profile (2026-10-07: "cho quyền admin có
 * thể chỉnh sửa họ tên, bộ phận khi note sai"; "không thể thêm hình ảnh đăng
 * ký"). Name, department, position and the registration photo. The employee
 * code, access level and history are not edited here: past access events keep
 * the name they were recorded with.
 */

export interface EmployeeEdit {
  name?: string;
  department?: string;
  position?: string;
  /** New registration photo: data:image/(jpeg|png|webp);base64 only. */
  photo?: string;
}

const FIELDS = ["name", "department", "position", "photo"] as const;
export const MAX_EDIT_PHOTO_CHARS = 3_000_000;

export function parseEmployeeEdit(body: unknown): { ok: true; value: EmployeeEdit } | { ok: false; error: string; field?: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!(FIELDS as readonly string[]).includes(key)) return { ok: false, error: `Không sửa được trường "${key.slice(0, 40)}" ở đây`, field: key.slice(0, 40) };
  }
  const value: EmployeeEdit = {};
  if (b.name !== undefined) {
    if (typeof b.name !== "string") return { ok: false, error: "Họ tên phải là chuỗi", field: "name" };
    const name = b.name.trim().replace(/\s+/g, " ");
    if (name.length < 1 || name.length > 100) return { ok: false, error: "Họ tên dài 1-100 ký tự", field: "name" };
    value.name = name;
  }
  for (const f of ["department", "position"] as const) {
    if (b[f] === undefined) continue;
    if (typeof b[f] !== "string" || !(b[f] as string).trim()) return { ok: false, error: `${f === "department" ? "Bộ phận" : "Chức vụ"} không hợp lệ`, field: f };
    value[f] = (b[f] as string).trim();
  }
  if (b.photo !== undefined) {
    if (typeof b.photo !== "string" || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.photo)) {
      return { ok: false, error: "Ảnh phải là ảnh JPEG/PNG/WebP tải lên từ máy", field: "photo" };
    }
    if (b.photo.length > MAX_EDIT_PHOTO_CHARS) return { ok: false, error: "Ảnh quá lớn (tối đa khoảng 2 MB)", field: "photo" };
    value.photo = b.photo;
  }
  if (Object.keys(value).length === 0) return { ok: false, error: "Không có thay đổi nào" };
  return { ok: true, value };
}

/** "Họ tên: A → B; Bộ phận: X → Y; Ảnh đăng ký: ảnh mới" - for the audit notification (never the photo). */
export function describeEmployeeChanges(
  before: { name: string; department: string; position: string },
  after: { name: string; department: string; position: string },
  photoChanged: boolean,
): string[] {
  const out: string[] = [];
  if (before.name !== after.name) out.push(`Họ tên: ${before.name} → ${after.name}`);
  if (before.department !== after.department) out.push(`Bộ phận: ${before.department} → ${after.department}`);
  if (before.position !== after.position) out.push(`Chức vụ: ${before.position} → ${after.position}`);
  if (photoChanged) out.push("Ảnh đăng ký: ảnh mới");
  return out;
}
