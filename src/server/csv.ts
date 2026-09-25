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
