/**
 * Employee avatar in lists (merge picker, 2026-10-07): JSON never carries
 * photoUrl (the server strips it), so a list loads the protected
 * GET /api/employees/:id/photo when the server says a photo exists, and shows
 * initials otherwise.
 */
export function employeeAvatarSrc(e: { id: string; photoUrl?: string | null; hasPhoto?: boolean | null }): string {
  if (e.photoUrl) return e.photoUrl;
  return e.hasPhoto ? `/api/employees/${encodeURIComponent(e.id)}/photo` : "";
}

/** Up to two initials from the last words of a Vietnamese name ("Đặng Thị Bảo Linh" -> "BL"). */
export function employeeInitials(name: string | null | undefined): string {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const picked = words.length === 1 ? words : words.slice(-2);
  return picked.map((w) => w.charAt(0).toLocaleUpperCase("vi-VN")).join("");
}

/** Lower-case, accents removed, đ -> d: "Đặng Thị Bích" matches "dang thi bich". */
export function foldVietnamese(text: string | null | undefined): string {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

/** Quick filter of the employee list: every typed word must appear in name, code, department or position. */
export function employeeMatchesQuery(
  e: { name?: string; employeeCode?: string; department?: string; position?: string },
  query: string,
): boolean {
  const words = foldVietnamese(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = foldVietnamese([e.name, e.employeeCode, e.department, e.position].filter(Boolean).join(" "));
  return words.every((w) => hay.includes(w));
}
