// Pure parse + validate for the bulk employee roster import.
//
// Deliberately free of Supabase / DOM references so the same code runs in the
// browser preview, on the server before any write, and in unit tests.

export const ROSTER_COLUMNS = [
  "Full Name",
  "Work Email",
  "Phone Number",
  "Employment Type",
  "Designation",
  "Department",
  "Joining Date",
  "Last Working Date",
  "Reporting Lead Email",
] as const;

export type RosterColumn = (typeof ROSTER_COLUMNS)[number];

export const EMPLOYMENT_TYPES = ["FULL_TIME", "INTERN", "FREELANCER", "TRAINER"] as const;
export type EmploymentTypeInput = (typeof EMPLOYMENT_TYPES)[number];

/** Template employment type -> database user_category value. */
export const EMPLOYMENT_TYPE_TO_CATEGORY: Record<EmploymentTypeInput, string> = {
  FULL_TIME: "full_time",
  INTERN: "intern",
  FREELANCER: "freelancer",
  TRAINER: "trainer",
};

export const TEMPLATE_SAMPLE_ROWS: string[][] = [
  [
    "Aarav Sharma",
    "aarav.sharma@example.com",
    "+91 98765 43210",
    "FULL_TIME",
    "Program Lead",
    "Operations",
    "2026-09-01",
    "",
    "",
  ],
  [
    "Diya Menon",
    "diya.menon@example.com",
    "9876543211",
    "INTERN",
    "AI Intern",
    "",
    "01/09/2026",
    "",
    "aarav.sharma@example.com",
  ],
  [
    "Rohit Verma",
    "rohit.verma@example.com",
    "",
    "FREELANCER",
    "Annotation Specialist",
    "Delivery",
    "15th Sep 2026",
    "",
    "",
  ],
];

export type RosterRaw = Record<string, string>;

export type RosterSeverity = "valid" | "warning" | "error";

export type RosterRow = {
  /** 1-based row number as it appears in the uploaded file (header excluded). */
  rowNumber: number;
  raw: RosterRaw;
  fullName: string;
  email: string;
  phone: string | null;
  employmentType: EmploymentTypeInput | null;
  category: string | null;
  designation: string;
  departmentName: string | null;
  departmentId: string | null;
  joiningDate: string | null;
  lastWorkingDate: string | null;
  reportingLeadEmail: string | null;
  reportingLeadId: string | null;
  errors: string[];
  warnings: string[];
  severity: RosterSeverity;
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");

function build(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCDate() !== d) return null;
  return iso;
}

/**
 * Accepts 2026-08-20, 20/08/2026, 20-08-2026, 20.08.2026, "20th Aug 2026",
 * "Aug 20 2026" and Excel serial numbers. Day-first for ambiguous slashed
 * dates (matches the rest of the portal and the sample workbooks).
 */
export function parseRosterDate(input: string | number | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const value = String(input).trim();
  if (!value) return null;

  // Excel serial date
  if (/^\d{5}$/.test(value)) {
    const serial = Number(value);
    const ms = Date.UTC(1899, 11, 30) + serial * 86_400_000;
    const d = new Date(ms);
    return build(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  let m = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]));

  m = value.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (m) return build(Number(m[3]), Number(m[2]), Number(m[1]));

  m = value.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})$/);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    return month ? build(Number(m[3]), month, Number(m[1])) : null;
  }

  m = value.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase()];
    return month ? build(Number(m[3]), month, Number(m[2])) : null;
  }

  return null;
}

export function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

const HEADER_ALIASES: Record<string, RosterColumn> = {
  "full name": "Full Name",
  name: "Full Name",
  "work email": "Work Email",
  email: "Work Email",
  "phone number": "Phone Number",
  phone: "Phone Number",
  mobile: "Phone Number",
  "employment type": "Employment Type",
  designation: "Designation",
  department: "Department",
  "joining date": "Joining Date",
  "last working date": "Last Working Date",
  "reporting lead email": "Reporting Lead Email",
};

/** Turns a raw grid (first row = headers) into keyed rows. */
export function gridToRosterRaw(grid: (string | number | null)[][]): RosterRaw[] {
  const [headerRow, ...body] = grid;
  if (!headerRow) return [];
  const keys = headerRow.map((cell) => HEADER_ALIASES[normaliseHeader(String(cell ?? ""))] ?? null);

  return body
    .filter((row) => (row ?? []).some((cell) => String(cell ?? "").trim() !== ""))
    .map((row) => {
      const out: RosterRaw = {};
      keys.forEach((key, index) => {
        if (!key) return;
        out[key] = String(row?.[index] ?? "").trim();
      });
      return out;
    });
}

export type RosterLookups = {
  /** lowercase department name -> id */
  departments: Map<string, string>;
  /** lowercase work email -> profile id (existing accounts) */
  accountsByEmail: Map<string, string>;
  /** lowercase emails that already have a live invitation */
  invitedEmails: Set<string>;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Classifies every row. Errors exclude the row from import, warnings do not.
 * Duplicate emails inside the same file flag BOTH occurrences.
 */
export function validateRoster(rows: RosterRaw[], lookups: RosterLookups): RosterRow[] {
  const emailCounts = new Map<string, number>();
  for (const raw of rows) {
    const email = (raw["Work Email"] ?? "").trim().toLowerCase();
    if (email) emailCounts.set(email, (emailCounts.get(email) ?? 0) + 1);
  }

  return rows.map((raw, index) => {
    const errors: string[] = [];
    const warnings: string[] = [];

    const fullName = (raw["Full Name"] ?? "").trim();
    if (fullName.length < 2) errors.push("Full Name is required.");

    const email = (raw["Work Email"] ?? "").trim().toLowerCase();
    if (!email) errors.push("Work Email is required.");
    else if (!EMAIL_RE.test(email)) errors.push(`"${raw["Work Email"]}" is not a valid email.`);
    else {
      if ((emailCounts.get(email) ?? 0) > 1) errors.push("Duplicate email inside this file.");
      if (lookups.accountsByEmail.has(email)) errors.push("An account already exists with this email.");
      else if (lookups.invitedEmails.has(email)) errors.push("This email already has a pending invitation.");
    }

    const rawType = (raw["Employment Type"] ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
    let employmentType: EmploymentTypeInput | null = null;
    if (!rawType) errors.push("Employment Type is required.");
    else if ((EMPLOYMENT_TYPES as readonly string[]).includes(rawType))
      employmentType = rawType as EmploymentTypeInput;
    else errors.push(`Employment Type "${raw["Employment Type"]}" must be one of ${EMPLOYMENT_TYPES.join(", ")}.`);

    const designation = (raw["Designation"] ?? "").trim();
    if (!designation) errors.push("Designation is required.");

    const departmentName = (raw["Department"] ?? "").trim() || null;
    let departmentId: string | null = null;
    if (departmentName) {
      departmentId = lookups.departments.get(departmentName.toLowerCase()) ?? null;
      if (!departmentId) warnings.push(`Department "${departmentName}" was not found — left blank.`);
    }

    const rawJoining = (raw["Joining Date"] ?? "").trim();
    let joiningDate: string | null = null;
    if (!rawJoining) errors.push("Joining Date is required.");
    else {
      joiningDate = parseRosterDate(rawJoining);
      if (!joiningDate) errors.push(`Joining Date "${rawJoining}" could not be read.`);
    }

    const rawLwd = (raw["Last Working Date"] ?? "").trim();
    let lastWorkingDate: string | null = null;
    if (rawLwd) {
      lastWorkingDate = parseRosterDate(rawLwd);
      if (!lastWorkingDate) errors.push(`Last Working Date "${rawLwd}" could not be read.`);
      else if (joiningDate && lastWorkingDate < joiningDate)
        errors.push("Last Working Date is before the Joining Date.");
    }

    const leadEmailRaw = (raw["Reporting Lead Email"] ?? "").trim().toLowerCase();
    let reportingLeadId: string | null = null;
    if (leadEmailRaw) {
      reportingLeadId = lookups.accountsByEmail.get(leadEmailRaw) ?? null;
      if (!reportingLeadId)
        warnings.push(`Reporting lead "${leadEmailRaw}" has no account — left unassigned.`);
    } else {
      warnings.push("No reporting lead — the account will need one before requests can route.");
    }

    return {
      rowNumber: index + 1,
      raw,
      fullName,
      email,
      phone: (raw["Phone Number"] ?? "").trim() || null,
      employmentType,
      category: employmentType ? EMPLOYMENT_TYPE_TO_CATEGORY[employmentType] : null,
      designation,
      departmentName,
      departmentId,
      joiningDate,
      lastWorkingDate,
      reportingLeadEmail: leadEmailRaw || null,
      reportingLeadId,
      errors,
      warnings,
      severity: errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "valid",
    } satisfies RosterRow;
  });
}

export function summariseRoster(rows: RosterRow[]) {
  return {
    total: rows.length,
    valid: rows.filter((r) => r.severity === "valid").length,
    warning: rows.filter((r) => r.severity === "warning").length,
    error: rows.filter((r) => r.severity === "error").length,
    importable: rows.filter((r) => r.severity !== "error").length,
  };
}
