/** Wide-to-long transform for the legacy attendance sheets.
 *
 *  Each sheet is one project: one row per person, one column per calendar
 *  date, with a two-row header (day-of-week above, real date below). This
 *  module turns that grid into per-person / per-date records, keeping every
 *  unresolved value as an explicit issue.
 */
import { classifyIdentifier, mapCellValue, normaliseText, parseLooseDate } from "./parse";
import type { CellMapping, IdentifierClass } from "./parse";

export type Grid = (string | number | null | undefined)[][];

export type SheetInspection = {
  sheetName: string;
  headerRowIndex: number;
  dayNameRowIndex: number | null;
  columns: {
    name: number | null;
    identifier: number | null;
    doj: number | null;
    lwd: number | null;
    clientEmail: number | null;
    uuid: number | null;
  };
  detectedHeaders: string[];
  dateColumns: { column: number; date: string; dayName: string | null }[];
  dateFrom: string | null;
  dateTo: string | null;
  firstDataRow: number;
  rowCount: number;
  unparsedDateHeaders: { column: number; raw: string }[];
};

const LABELS: Record<keyof SheetInspection["columns"], RegExp> = {
  name: /^(full\s*name|name|employee\s*name|candidate\s*name)$/i,
  identifier: /^(working\s*id|work\s*id|email|email\s*id|official\s*email|work\s*email|id)$/i,
  doj: /^(doj|date\s*of\s*joining|joining\s*date)$/i,
  lwd: /^(lwd|last\s*working\s*day|exit\s*date)$/i,
  clientEmail: /^(client\s*email|client\s*mail|secondary\s*email)$/i,
  uuid: /^(uuid|guid|unique\s*id)$/i,
};

function cell(grid: Grid, r: number, c: number): string {
  return normaliseText(grid[r]?.[c]);
}

/** Finds the header rows, the meta columns and every real date column. */
export function inspectSheet(sheetName: string, grid: Grid): SheetInspection {
  let headerRowIndex = -1;
  let best = 0;
  const scanDepth = Math.min(grid.length, 10);
  for (let r = 0; r < scanDepth; r += 1) {
    const row = grid[r] ?? [];
    let hits = 0;
    for (let c = 0; c < row.length; c += 1) {
      if (parseLooseDate(row[c]).ok) hits += 1;
    }
    if (hits > best) {
      best = hits;
      headerRowIndex = r;
    }
  }
  if (headerRowIndex < 0) headerRowIndex = 0;

  const dayNameRowIndex = headerRowIndex > 0 ? headerRowIndex - 1 : null;
  const width = Math.max(...grid.slice(0, headerRowIndex + 3).map((r) => r?.length ?? 0), 0);

  const columns: SheetInspection["columns"] = {
    name: null, identifier: null, doj: null, lwd: null, clientEmail: null, uuid: null,
  };
  const detectedHeaders: string[] = [];
  const candidateRows = [headerRowIndex, dayNameRowIndex].filter((r): r is number => r !== null);

  for (let c = 0; c < width; c += 1) {
    for (const r of candidateRows) {
      const text = cell(grid, r, c);
      if (!text) continue;
      if (!detectedHeaders[c]) detectedHeaders[c] = text;
      for (const key of Object.keys(LABELS) as (keyof typeof LABELS)[]) {
        if (columns[key] === null && LABELS[key].test(text)) columns[key] = c;
      }
    }
  }

  // An unlabelled first text column is the name column in one real variant.
  if (columns.name === null) {
    for (let c = 0; c < width; c += 1) {
      if (c === columns.identifier || c === columns.doj || c === columns.lwd) continue;
      if (parseLooseDate(grid[headerRowIndex]?.[c]).ok) continue;
      columns.name = c;
      break;
    }
  }

  const dateColumns: SheetInspection["dateColumns"] = [];
  const unparsedDateHeaders: SheetInspection["unparsedDateHeaders"] = [];
  const metaColumns = new Set(Object.values(columns).filter((v): v is number => v !== null));
  const headerRow = grid[headerRowIndex] ?? [];
  for (let c = 0; c < headerRow.length; c += 1) {
    if (metaColumns.has(c)) continue;
    const raw = cell(grid, headerRowIndex, c);
    if (!raw) continue;
    const parsed = parseLooseDate(raw);
    if (parsed.ok) {
      dateColumns.push({
        column: c,
        date: parsed.date,
        dayName: dayNameRowIndex === null ? null : cell(grid, dayNameRowIndex, c) || null,
      });
    } else {
      unparsedDateHeaders.push({ column: c, raw });
    }
  }

  const dates = dateColumns.map((d) => d.date).sort();
  const firstDataRow = headerRowIndex + 1;
  let rowCount = 0;
  for (let r = firstDataRow; r < grid.length; r += 1) {
    const nameCell = columns.name === null ? "" : cell(grid, r, columns.name);
    const idCell = columns.identifier === null ? "" : cell(grid, r, columns.identifier);
    if (nameCell || idCell) rowCount += 1;
  }

  return {
    sheetName,
    headerRowIndex,
    dayNameRowIndex,
    columns,
    detectedHeaders: detectedHeaders.map((h) => h ?? ""),
    dateColumns,
    dateFrom: dates[0] ?? null,
    dateTo: dates[dates.length - 1] ?? null,
    firstDataRow,
    rowCount,
    unparsedDateHeaders,
  };
}

export type ParsedCell = {
  workDate: string;
  raw: string;
  mapping: CellMapping;
};

export type ParsedPerson = {
  sheetName: string;
  rowIndex: number;
  rawName: string;
  rawIdentifier: string;
  identity: IdentifierClass;
  rawDoj: string;
  rawLwd: string;
  parsedDoj: string | null;
  parsedLwd: string | null;
  dateIssues: { doj?: string; lwd?: string };
  metadata: Record<string, string>;
  cells: ParsedCell[];
  /** First occurrence only, exactly as specified. */
  signals: { signalType: "exit" | "reassignment"; effectiveDate: string; raw: string }[];
};

/** Turns one inspected sheet into per-person records with mapped cells. */
export function transformSheet(grid: Grid, inspection: SheetInspection): ParsedPerson[] {
  const people: ParsedPerson[] = [];
  const { columns } = inspection;

  for (let r = inspection.firstDataRow; r < grid.length; r += 1) {
    const rawName = columns.name === null ? "" : cell(grid, r, columns.name);
    const rawIdentifier = columns.identifier === null ? "" : cell(grid, r, columns.identifier);
    if (!rawName && !rawIdentifier) continue;

    const rawDoj = columns.doj === null ? "" : cell(grid, r, columns.doj);
    const rawLwd = columns.lwd === null ? "" : cell(grid, r, columns.lwd);
    const dojParse = rawDoj ? parseLooseDate(rawDoj) : null;
    const lwdParse = rawLwd ? parseLooseDate(rawLwd) : null;

    const dateIssues: ParsedPerson["dateIssues"] = {};
    if (dojParse && !dojParse.ok) dateIssues.doj = dojParse.issue;
    if (lwdParse && !lwdParse.ok) dateIssues.lwd = lwdParse.issue;

    const metadata: Record<string, string> = {};
    if (columns.clientEmail !== null) metadata["client_email"] = cell(grid, r, columns.clientEmail);
    if (columns.uuid !== null) metadata["uuid"] = cell(grid, r, columns.uuid);

    const cells: ParsedCell[] = [];
    const signals: ParsedPerson["signals"] = [];
    const seenSignal = new Set<string>();

    for (const dateCol of inspection.dateColumns) {
      const raw = cell(grid, r, dateCol.column);
      const mapping = mapCellValue(raw);
      if (mapping.kind === "signal") {
        // First occurrence only: a repeated "Moved"/"Drop out" is noise.
        if (!seenSignal.has(mapping.signalType)) {
          seenSignal.add(mapping.signalType);
          signals.push({ signalType: mapping.signalType, effectiveDate: dateCol.date, raw });
        }
      }
      cells.push({ workDate: dateCol.date, raw, mapping });
    }

    people.push({
      sheetName: inspection.sheetName,
      rowIndex: r,
      rawName,
      rawIdentifier,
      identity: classifyIdentifier(rawIdentifier, /gigwork/i.test(rawIdentifier)),
      rawDoj,
      rawLwd,
      parsedDoj: dojParse && dojParse.ok ? dojParse.date : null,
      parsedLwd: lwdParse && lwdParse.ok ? lwdParse.date : null,
      dateIssues,
      metadata,
      cells,
      signals,
    });
  }

  return people;
}
