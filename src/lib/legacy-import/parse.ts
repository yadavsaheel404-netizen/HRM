/** Pure, dependency-free parsers for the legacy attendance workbooks.
 *
 *  Everything in this file is deliberately side-effect free so the exact
 *  real-world quirks (a typo'd ordinal, a curly apostrophe, a bare `31` in an
 *  attendance cell) can be unit tested without a database or a browser.
 *
 *  Hard rule throughout: anything the parser cannot resolve *confidently* is
 *  returned as an issue for a human to resolve. Nothing is ever guessed.
 */

/** Curly apostrophes, non-breaking spaces and stray whitespace, normalised. */
export function normaliseText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/[\u2018\u2019\u02BC\u00B4`]/g, "'")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export type DateParse =
  | { ok: true; date: string; format: string }
  | { ok: false; issue: string };

function iso(y: number, m: number, d: number): DateParse | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { ok: true, date: dt.toISOString().slice(0, 10), format: "" };
}

function withFormat(parsed: DateParse | null, format: string): DateParse | null {
  return parsed && parsed.ok ? { ...parsed, format } : parsed;
}

/**
 * Resolves the messy DOJ / LWD strings seen in the real sheets:
 *   `8th SEP 2025`, `22dn SEP 2025` (typo), `2nd Feb'2026`, `2nd Feb’2026`,
 *   `19/01/2026`, `27/2/2026`, `2026-01-19T00:00:00.000Z`, Excel serials.
 * Ambiguous slash dates (both parts <= 12) are refused, never guessed.
 */
export function parseLooseDate(input: unknown): DateParse {
  const raw = normaliseText(input);
  if (!raw) return { ok: false, issue: "empty" };

  // Excel serial number (days since 1899-12-30).
  if (/^\d{5}(\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    const ms = Math.round((serial - 25569) * 86_400_000);
    return { ok: true, date: new Date(ms).toISOString().slice(0, 10), format: "excel-serial" };
  }

  // Already-parsed ISO date or datetime.
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (isoMatch) {
    const parsed = withFormat(
      iso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3])),
      "iso",
    );
    return parsed ?? { ok: false, issue: `not a real calendar date: "${raw}"` };
  }

  // `8th SEP 2025` / `22dn SEP 2025` / `2nd Feb'2026` / `2 September 2025`.
  const ordinal = raw.match(/^(\d{1,2})\s*([a-zA-Z]{0,3})?\s*[-\s']*([a-zA-Z]{3,9})\s*['\-\s]*(\d{2,4})$/);
  if (ordinal) {
    const day = Number(ordinal[1]);
    const suffix = (ordinal[2] ?? "").toLowerCase();
    const month = MONTHS[(ordinal[3] ?? "").toLowerCase().slice(0, 4)] ??
      MONTHS[(ordinal[3] ?? "").toLowerCase().slice(0, 3)];
    let year = Number(ordinal[4]);
    if (year < 100) year += 2000;
    if (!month) return { ok: false, issue: `unrecognised month in "${raw}"` };
    // Suffix may be a valid ordinal (st/nd/rd/th) or the observed typo (dn);
    // either way it carries no information, so it is ignored rather than
    // rejected — but anything longer is suspicious.
    if (suffix && suffix.length > 3) return { ok: false, issue: `unrecognised day suffix in "${raw}"` };
    const parsed = withFormat(iso(year, month, day), suffix ? "ordinal-month-year" : "day-month-year");
    return parsed ?? { ok: false, issue: `not a real calendar date: "${raw}"` };
  }

  // Slash / dash separated numerics.
  const slash = raw.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    let year = Number(slash[3]);
    if (year < 100) year += 2000;
    if (a > 12 && b <= 12) {
      const parsed = withFormat(iso(year, b, a), "day-first");
      return parsed ?? { ok: false, issue: `not a real calendar date: "${raw}"` };
    }
    if (b > 12 && a <= 12) {
      const parsed = withFormat(iso(year, a, b), "month-first");
      return parsed ?? { ok: false, issue: `not a real calendar date: "${raw}"` };
    }
    if (a <= 12 && b <= 12) {
      return {
        ok: false,
        issue: `ambiguous date "${raw}" — could be ${a}/${b} or ${b}/${a}, needs manual entry`,
      };
    }
    return { ok: false, issue: `not a real calendar date: "${raw}"` };
  }

  return { ok: false, issue: `unrecognised date format: "${raw}"` };
}

/* ------------------------------------------------------------------ */
/* Attendance cell values                                              */
/* ------------------------------------------------------------------ */

export type CellMapping =
  | { kind: "blank" }
  | {
      kind: "attendance";
      workMode: "wfo" | "wfh";
      exceptionType: "none" | "leave";
      halfDay: boolean;
      label: string;
    }
  | { kind: "calendar"; calendarKind: "weekly_off" | "holiday"; label: string }
  | { kind: "signal"; signalType: "exit" | "reassignment"; label: string }
  | { kind: "invalid"; issue: string };

/**
 * Maps one raw attendance cell. Only the statuses confirmed in the real data
 * are recognised; everything else (including the stray `0`/`1`/`31` numerics)
 * comes back as `invalid` for manual admin resolution.
 */
export function mapCellValue(input: unknown): CellMapping {
  const raw = normaliseText(input);
  if (!raw) return { kind: "blank" };

  const key = raw.toLowerCase().replace(/[\s_-]+/g, "");

  switch (key) {
    case "present":
    case "p":
      return { kind: "attendance", workMode: "wfo", exceptionType: "none", halfDay: false, label: "Present" };
    case "remote":
    case "wfh":
      return { kind: "attendance", workMode: "wfh", exceptionType: "none", halfDay: false, label: "Remote" };
    case "leave":
    case "onleave":
      return { kind: "attendance", workMode: "wfo", exceptionType: "leave", halfDay: false, label: "Leave" };
    case "halfday":
      return { kind: "attendance", workMode: "wfo", exceptionType: "none", halfDay: true, label: "Half day" };
    case "weekoff":
    case "weeklyoff":
      return { kind: "calendar", calendarKind: "weekly_off", label: "Week off" };
    case "holiday":
      return { kind: "calendar", calendarKind: "holiday", label: "Holiday" };
    case "dropout":
      return { kind: "signal", signalType: "exit", label: "Drop out" };
    case "moved":
      return { kind: "signal", signalType: "reassignment", label: "Moved" };
    default:
      return {
        kind: "invalid",
        issue: /^\d+(\.\d+)?$/.test(raw)
          ? `stray numeric value "${raw}" is not an attendance status`
          : `unrecognised status "${raw}"`,
      };
  }
}

/* ------------------------------------------------------------------ */
/* Identifier classification                                           */
/* ------------------------------------------------------------------ */

export type IdentifierClass = {
  /** Lower-cased email when the cell genuinely holds one. */
  email: string | null;
  /** `org_email` | `personal_email` | `gigwork_email` | `numeric_id` | `placeholder` | `missing` | `unparseable` */
  kind: string;
  /** True only for a real, unambiguous organisation email. */
  autoMatchable: boolean;
  note: string;
};

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PLACEHOLDERS = new Set(["buffer", "na", "n/a", "-", "tbd", "none", "test"]);

/**
 * Classifies the "Working ID / Email" column. Only a real email address is
 * ever considered auto-matchable — a name is NEVER matched to an account.
 */
export function classifyIdentifier(input: unknown, gigworkHint = false): IdentifierClass {
  const raw = normaliseText(input);
  if (!raw) return { email: null, kind: "missing", autoMatchable: false, note: "no identifier in the sheet" };

  const lower = raw.toLowerCase();
  if (PLACEHOLDERS.has(lower)) {
    return { email: null, kind: "placeholder", autoMatchable: false, note: `placeholder value "${raw}"` };
  }

  const isGig = gigworkHint || /^gigwork\b/i.test(lower);
  const match = lower.match(EMAIL_RE);
  if (match) {
    const email = match[0];
    if (email.endsWith(".theaischool.co.in") || email.endsWith("@theaischool.co.in")) {
      return { email, kind: "org_email", autoMatchable: true, note: "organisation email" };
    }
    return {
      email,
      kind: isGig ? "gigwork_email" : "personal_email",
      autoMatchable: false,
      note: isGig
        ? "gig-work personal email — confirm before matching"
        : "personal email — confirm before matching",
    };
  }

  if (/^\d+$/.test(lower)) {
    return { email: null, kind: "numeric_id", autoMatchable: false, note: `bare numeric ID "${raw}"` };
  }

  return { email: null, kind: "unparseable", autoMatchable: false, note: `not an email: "${raw}"` };
}
