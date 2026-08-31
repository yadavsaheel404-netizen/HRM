// Client-safe CSV helpers. The server produces the rows; this only formats.
export type CsvColumn<T> = { key: string; header: string; value: (row: T) => unknown };

/**
 * Spreadsheet apps evaluate any cell starting with = + - @ (or a leading tab /
 * carriage return) as a formula. Free-text fields such as names, reasons and
 * task notes are employee-controlled, so neutralise them before export.
 */
export function neutralizeFormula<T>(value: T): T | string {
  if (typeof value !== "string") return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = neutralizeFormula(String(value));
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => escapeCell(c.header)).join(",");
  const body = rows.map((row) => columns.map((c) => escapeCell(c.value(row))).join(","));
  return [head, ...body].join("\r\n");
}

/** Downloads a CSV. Excel opens this directly; the BOM keeps accents intact. */
export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
