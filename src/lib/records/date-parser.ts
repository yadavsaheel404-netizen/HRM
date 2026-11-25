// Pure Excel / CSV date parser and ambiguity detector for Employee Records.
// Supports Excel serial dates (both 1900 and 1904 date systems), weekday-prefixed
// text dates, ISO dates, named months, and MM-DD-YYYY / DD-MM-YYYY detection.
// Never guesses ambiguous dates silently and never invents blank dates.

import type { ParsedDateResult } from "./types";

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const EMPTY_SENTINELS = new Set([
  "",
  "-",
  "--",
  "—",
  "na",
  "n/a",
  "none",
  "null",
  "nil",
  "tbd",
  "active",
  "present",
  "working",
  "still working",
  "currently working",
  "continuing",
]);

const WEEKDAY_PREFIX_RE =
  /^(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?),?\s+/i;

const pad2 = (n: number) => String(n).padStart(2, "0");

function buildValidIso(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (year < 1990 || year > 2040 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const iso = `${year}-${pad2(month)}-${pad2(day)}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (
    Number.isNaN(d.getTime()) ||
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() + 1 !== month ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return iso;
}

/**
 * Decodes an Excel serial date number respecting 1900 vs 1904 workbook settings.
 * In Excel's 1900 system, serial 1 = 1900-01-01 and Lotus 1-2-3 erroneously treated
 * 1900 as a leap year (serial 60), so epoch base is 1899-12-30 UTC for serials >= 60.
 */
export function decodeExcelSerialDate(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 25000 || serial > 65000) return null;
  const wholeDays = Math.floor(serial);
  const baseMs = date1904
    ? Date.UTC(1904, 0, 1)
    : Date.UTC(1899, 11, wholeDays >= 60 ? 30 : 31);
  const d = new Date(baseMs + wholeDays * 86_400_000);
  return buildValidIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export type DateParseOptions = {
  /** Workbook uses the 1904 macOS Excel epoch instead of standard 1900 epoch. */
  date1904?: boolean;
  /** How to resolve ambiguous numeric dates (e.g. 05-08-2025). Default: "auto" -> needs_review. */
  numericPreference?: "auto" | "mdy" | "dmy";
};

export function parseExcelRecordDate(
  input: unknown,
  options: DateParseOptions = {},
): ParsedDateResult {
  const date1904 = Boolean(options.date1904);
  const numericPreference = options.numericPreference ?? "auto";

  if (input === null || input === undefined) {
    return { iso: null, status: "empty", rawValue: "", detectedFormat: null };
  }

  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) {
      return {
        iso: null,
        status: "needs_review",
        rawValue: String(input),
        detectedFormat: "invalid_date",
        reason: "Unreadable JavaScript Date value.",
      };
    }
    const iso = buildValidIso(input.getFullYear(), input.getMonth() + 1, input.getDate());
    return iso
      ? { iso, status: "parsed", rawValue: iso, detectedFormat: "js_date" }
      : {
          iso: null,
          status: "needs_review",
          rawValue: input.toISOString(),
          detectedFormat: "out_of_range",
          reason: "Date is outside the expected organizational range (1990–2040).",
        };
  }

  if (typeof input === "number") {
    const rawValue = String(input);
    const iso = decodeExcelSerialDate(input, date1904);
    if (iso) {
      return {
        iso,
        status: "parsed",
        rawValue,
        detectedFormat: date1904 ? "excel_serial_1904" : "excel_serial_1900",
      };
    }
    return {
      iso: null,
      status: "needs_review",
      rawValue,
      detectedFormat: "numeric_unrecognized",
      reason: `Numeric value "${rawValue}" could not be decoded as a valid Excel serial date.`,
    };
  }

  const rawValue = String(input).trim();
  const normalizedLower = rawValue.toLowerCase();
  if (EMPTY_SENTINELS.has(normalizedLower)) {
    return { iso: null, status: "empty", rawValue, detectedFormat: null };
  }

  // Excel serial passed as numeric string (e.g. "45292" or "45292.0")
  if (/^\d{5}(?:\.\d+)?$/.test(rawValue)) {
    const iso = decodeExcelSerialDate(Number(rawValue), date1904);
    if (iso) {
      return {
        iso,
        status: "parsed",
        rawValue,
        detectedFormat: date1904 ? "excel_serial_1904" : "excel_serial_1900",
      };
    }
  }

  // Strip optional weekday prefix and trailing JS timezone suffix (e.g., "Fri Jan 10 2025 00:00:00 GMT+0530 ...")
  let cleaned = rawValue.replace(/\s+\d{2}:\d{2}:\d{2}\s+GMT[^\s]*(?:\s*\([^)]*\))?$/i, "").trim();
  const hadWeekday = WEEKDAY_PREFIX_RE.test(cleaned);
  if (hadWeekday) {
    cleaned = cleaned.replace(WEEKDAY_PREFIX_RE, "").trim();
  }

  // 1. ISO YYYY-MM-DD (or YYYY/MM/DD)
  let m = cleaned.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:T.*)?$/);
  if (m) {
    const iso = buildValidIso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (iso) {
      return { iso, status: "parsed", rawValue, detectedFormat: "iso_ymd" };
    }
  }

  // 2. Named month: "15 Jan 2024", "15-Jan-2024", "15th January, 2024", "2 Jul 26"
  m = cleaned.match(
    /^(\d{1,2})(?:st|nd|rd|th)?[\s\-/,]+([A-Za-z]+)[\s\-/,]+(\d{2,4})$/,
  );
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    const yearNum = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const iso = month ? buildValidIso(yearNum, month, Number(m[1])) : null;
    if (iso) {
      return {
        iso,
        status: "parsed",
        rawValue,
        detectedFormat: hadWeekday ? "weekday_dmy_text" : "dmy_month_name",
      };
    }
  }

  // 3. Named month first: "Jan 15, 2024", "January 15 2024", "Oct 14 2025"
  m = cleaned.match(
    /^([A-Za-z]+)[\s\-/]+(\d{1,2})(?:st|nd|rd|th)?(?:,|\s|[-/])+?\s*(\d{2,4})$/,
  );
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase()];
    const yearNum = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const iso = month ? buildValidIso(yearNum, month, Number(m[2])) : null;
    if (iso) {
      return {
        iso,
        status: "parsed",
        rawValue,
        detectedFormat: hadWeekday ? "weekday_mdy_text" : "mdy_month_name",
      };
    }
  }

  // 4. Numeric slashed/dashed/dotted: A/B/YYYY or A-B-YYYY or A.B.YYYY (or 2-digit YY)
  m = cleaned.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);

    const asDmy = buildValidIso(y, b, a);
    const asMdy = buildValidIso(y, a, b);

    // First number > 12 -> strictly DD-MM-YYYY
    if (a > 12 && b <= 12 && asDmy) {
      return {
        iso: asDmy,
        status: "parsed",
        rawValue,
        detectedFormat: "dmy_numeric_unambiguous",
      };
    }
    // Second number > 12 -> strictly MM-DD-YYYY
    if (b > 12 && a <= 12 && asMdy) {
      return {
        iso: asMdy,
        status: "parsed",
        rawValue,
        detectedFormat: "mdy_numeric_unambiguous",
      };
    }
    // Same day & month (e.g. 05-05-2025) -> unambiguous
    if (a === b && asMdy) {
      return {
        iso: asMdy,
        status: "parsed",
        rawValue,
        detectedFormat: "numeric_symmetric",
      };
    }
    // Both <= 12 and unequal -> ambiguous unless preference explicitly set
    if (asMdy && asDmy) {
      if (numericPreference === "mdy") {
        return { iso: asMdy, status: "parsed", rawValue, detectedFormat: "mdy_numeric" };
      }
      if (numericPreference === "dmy") {
        return { iso: asDmy, status: "parsed", rawValue, detectedFormat: "dmy_numeric" };
      }
      return {
        iso: null,
        status: "needs_review",
        rawValue,
        detectedFormat: "ambiguous_numeric",
        suggestedIso: asMdy,
        alternateIso: asDmy,
        reason: `Ambiguous numeric date "${rawValue}" (MM-DD-YYYY: ${asMdy} vs DD-MM-YYYY: ${asDmy}).`,
      };
    }
    if (asMdy) {
      return { iso: asMdy, status: "parsed", rawValue, detectedFormat: "mdy_numeric" };
    }
    if (asDmy) {
      return { iso: asDmy, status: "parsed", rawValue, detectedFormat: "dmy_numeric" };
    }
  }

  return {
    iso: null,
    status: "needs_review",
    rawValue,
    detectedFormat: null,
    reason: `Could not parse date "${rawValue}" cleanly — requires manual review.`,
  };
}
