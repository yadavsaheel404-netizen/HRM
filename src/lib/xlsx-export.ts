// Client-safe workbook writer for the attendance exports.
// Frozen header row, auto-fitted columns, alternating row shading.
import { neutralizeFormula } from "./csv";

export type SheetRow = Record<string, string | number | null>;

const HEADER_FILL = "1F2937";
const SHADE_FILL = "F3F4F6";

export async function downloadXlsx(filename: string, sheetName: string, rows: SheetRow[]) {
  const XLSX = (await import("xlsx-js-style")).default ?? (await import("xlsx-js-style"));
  const headers = Object.keys(rows[0] ?? { Empty: "" });

  const safeRows: SheetRow[] = rows.map((row) => {
    const next: SheetRow = {};
    for (const [key, value] of Object.entries(row)) next[key] = neutralizeFormula(value);
    return next;
  });

  const sheet = XLSX.utils.json_to_sheet(safeRows.length ? safeRows : [{ Empty: "" }], {
    header: headers,
  });

  // Column widths from the longest cell in each column.
  sheet["!cols"] = headers.map((header) => {
    const longest = rows.reduce(
      (max, row) => Math.max(max, String(row[header] ?? "").length),
      header.length,
    );
    return { wch: Math.min(Math.max(longest + 2, 10), 42) };
  });
  // Frozen header row: SheetJS writes panes from the sheet view descriptor.
  sheet["!freeze"] = "A2";
  (sheet as unknown as { "!views"?: unknown[] })["!views"] = [
    { state: "frozen", ySplit: 1, xSplit: 0, topLeftCell: "A2", activePane: "bottomLeft" },
  ];

  const range = XLSX.utils.decode_range(sheet["!ref"] as string);
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const address = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[address];
      if (!cell) continue;
      if (r === 0) {
        cell.s = {
          font: { bold: true, color: { rgb: "FFFFFF" }, name: "Arial", sz: 10 },
          fill: { patternType: "solid", fgColor: { rgb: HEADER_FILL } },
          alignment: { vertical: "center", horizontal: "left" },
        };
      } else {
        cell.s = {
          font: { name: "Arial", sz: 10 },
          ...(r % 2 === 0
            ? { fill: { patternType: "solid", fgColor: { rgb: SHADE_FILL } } }
            : {}),
        };
      }
    }
  }

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName.slice(0, 31));
  const buffer = XLSX.write(book, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  const bytes = await freezeHeaderRow(buffer);
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * SheetJS community builds ignore pane settings, so the frozen header row is
 * written straight into the sheet XML after the workbook is generated.
 */
async function freezeHeaderRow(buffer: ArrayBuffer): Promise<Uint8Array> {
  const { unzipSync, zipSync } = await import("fflate");
  const files = unzipSync(new Uint8Array(buffer));
  const target = Object.keys(files).find((name) =>
    /^xl\/worksheets\/sheet1\.xml$/.test(name),
  );
  if (!target) return new Uint8Array(buffer);

  const decoder = new TextDecoder();
  let xml = decoder.decode(files[target]!);
  const views =
    '<sheetViews><sheetView workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
    "</sheetView></sheetViews>";
  if (xml.includes("<sheetViews>")) {
    xml = xml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, views);
  } else if (xml.includes("<sheetData")) {
    xml = xml.replace("<sheetData", `${views}<sheetData`);
  }
  files[target] = new TextEncoder().encode(xml);
  return zipSync(files);
}


/** Filenames like employee_attendance_2026-08-01_to_2026-08-31_generated_20260825 */
export function reportFileName(prefix: string, from: string, to: string, ext: string) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${prefix}_${from}_to_${to}_generated_${stamp}.${ext}`;
}
