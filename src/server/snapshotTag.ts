/**
 * Employee name tag on stored snapshots (2026-10-11: "nếu đã xác nhận nhân viên
 * thì khung hình mẫu cho hiện thêm tag tên của nhân viên"). Pure helpers; the
 * drawing is FFmpeg drawtext in server.ts annotateSnapshotWithBoxes.
 */

/** Debian fonts-dejavu-core (in the runner and tester images); covers Vietnamese. */
export const SNAPSHOT_TAG_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

/** "Huê · NV-4143" for a recognised employee's face, else null (strangers keep the plain box). */
export function snapshotNameTag(f: { recognized?: boolean; employeeId?: string; employeeName?: string; employeeCode?: string }): string | null {
  if (!f.recognized || !f.employeeId || !f.employeeName) return null;
  const clean = (v: unknown, n: number) => String(v || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, n);
  const name = clean(f.employeeName, 60);
  const code = clean(f.employeeCode, 20);
  return name ? (code ? `${name} · ${code}` : name) : null;
}

/**
 * drawtext filter for a tag above the box (below it when the box touches the
 * top), white on green. `x`, `y`, `h` are the box in 0-1 of the picture. The
 * text comes from `textFile`, never from the filter string.
 */
export function snapshotTagFilter(font: string, textFile: string, box: { x: number; y: number; h: number }): string {
  const tx = `max(0\\,min(w-tw\\,w*${box.x.toFixed(4)}))`;
  const ty = box.y > 0.06 ? `max(0\\,h*${box.y.toFixed(4)}-th-14)` : `min(h-th\\,h*${(box.y + box.h).toFixed(4)}+14)`;
  return `drawtext=fontfile=${font}:textfile=${textFile}:fontsize=max(20\\,h/45):fontcolor=white:box=1:boxcolor=0x00A000@0.9:boxborderw=8:x=${tx}:y=${ty}`;
}
