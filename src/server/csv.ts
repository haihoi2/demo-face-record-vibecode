/**
 * One CSV cell, safe to open in a spreadsheet: always quoted, embedded quotes
 * doubled, and a leading = + - @ tab or carriage return neutralised with an
 * apostrophe so the cell is read as text, never as a formula.
 */
export function csvCell(value: unknown): string {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** yyyy-mm-dd of an instant in the site's calendar. */
function siteDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/**
 * Download name for an access-history export, dated in the site's calendar.
 * Slicing the UTC instant named a "today" export (from = local midnight,
 * 17:00 UTC the day before) with the previous day. `to` is exclusive (the
 * start of the day after the last one), so the name uses the last day included.
 */
export function accessLogExportName(from: string | undefined, to: string | undefined, timeZone: string): string {
  const fromMs = from ? Date.parse(from) : NaN;
  const toMs = to ? Date.parse(to) : NaN;
  const fromDay = Number.isFinite(fromMs) ? `_tu_${siteDay(fromMs, timeZone)}` : "";
  const toDay = Number.isFinite(toMs) ? `_den_${siteDay(toMs - 1, timeZone)}` : "";
  return `nhat_ky_vao_ra${fromDay}${toDay}.csv`;
}
