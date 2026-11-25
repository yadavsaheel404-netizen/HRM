// Pure 6-tier Workforce matching, duplicate detection, status classification,
// and Google Drive folder-link matching logic for Employee Records (/records).

import { parseExcelRecordDate, type DateParseOptions } from "./date-parser";
import {
  RECORD_EMPLOYMENT_CATEGORIES,
  RECORD_WORK_TYPES,
  computeRecordCompleteness,
  validateGoogleDriveFolderUrl,
  type DriveFolderMappingRow,
  type DriveMappingPreviewRow,
  type EmployeeRecordItem,
  type ImportCandidateMatch,
  type ImportPreviewRow,
  type ImportPreviewSummary,
  type MissingWorkforceEntry,
  type RecordEmploymentCategory,
  type RecordEmploymentStatus,
  type RecordStatusSource,
  type RecordWorkType,
  type RecordsListFilters,
  type SourceColumnMapping,
} from "./types";

export const CONSOLIDATED_EXCEL_HEADERS = [
  "First Name",
  "Last Name",
  "Phone Number",
  "DOJ",
  "LWD",
  "E-Mail ID",
  "TAS Mail",
] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(val: unknown): string | null {
  const s = String(val ?? "").trim().toLowerCase();
  if (!s) return null;
  return s;
}

export function isValidEmail(val: string | null | undefined): boolean {
  if (!val) return false;
  return EMAIL_RE.test(val.trim());
}

/** Normalizes Indian & international phone numbers to last 10 significant digits when >= 10 digits. */
export function normalizePhone(val: unknown): string | null {
  const raw = String(val ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  if (digits.length < 7) return null;
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

export function formatPhoneDisplay(val: unknown): string | null {
  const raw = String(val ?? "").trim();
  if (!raw || raw === "-" || /^n\/?a$/i.test(raw)) return null;
  return raw;
}

export function normalizeName(val: unknown): string {
  return String(val ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildDisplayName(firstName: string, lastName?: string | null): string {
  const f = firstName.trim();
  const l = (lastName ?? "").trim();
  return l ? `${f} ${l}` : f;
}

export function splitDisplayName(fullName: string): { firstName: string; lastName: string | null } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: null };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: null };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}

function normalizeHeaderKey(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

const COLUMN_ALIASES: Record<keyof SourceColumnMapping, string[]> = {
  firstName: ["first name", "firstname", "fname", "given name", "name", "employee name"],
  lastName: ["last name", "lastname", "lname", "surname"],
  phoneNumber: ["phone number", "phone", "mobile", "mobile number", "contact", "contact number"],
  joiningDate: ["doj", "date of joining", "joining date", "start date"],
  lastWorkingDate: ["lwd", "last working date", "last working day", "end date", "relieving date"],
  personalEmail: ["e mail id", "email id", "personal email", "personal mail", "e mail"],
  organizationEmail: ["tas mail", "tas email", "work email", "official email", "organization email", "org email"],
  address: ["address", "residential address", "current address"],
  employmentCategory: ["employment category", "category", "employment type", "type"],
  workType: ["work type", "worktype", "workstream"],
  department: ["department", "dept"],
  designation: ["designation", "role title", "title", "position"],
  driveFolderUrl: ["google drive folder url", "drive folder url", "drive url", "documents folder", "folder link"],
  tasEmployeeCode: ["tas employee id", "employee id", "employee code", "tas id", "emp id"],
  employmentStatus: ["employment status", "status"],
};

export function detectSourceColumnMapping(headers: readonly string[]): SourceColumnMapping {
  const normToRaw = new Map<string, string>();
  for (const h of headers) {
    const clean = String(h ?? "").trim();
    if (!clean) continue;
    const norm = normalizeHeaderKey(clean);
    if (!normToRaw.has(norm)) normToRaw.set(norm, clean);
  }

  const pick = (field: keyof SourceColumnMapping): string | null => {
    for (const alias of COLUMN_ALIASES[field]) {
      const hit = normToRaw.get(alias);
      if (hit) return hit;
    }
    return null;
  };

  return {
    firstName: pick("firstName"),
    lastName: pick("lastName"),
    phoneNumber: pick("phoneNumber"),
    joiningDate: pick("joiningDate"),
    lastWorkingDate: pick("lastWorkingDate"),
    personalEmail: pick("personalEmail"),
    organizationEmail: pick("organizationEmail"),
    address: pick("address"),
    employmentCategory: pick("employmentCategory"),
    workType: pick("workType"),
    department: pick("department"),
    designation: pick("designation"),
    driveFolderUrl: pick("driveFolderUrl"),
    tasEmployeeCode: pick("tasEmployeeCode"),
    employmentStatus: pick("employmentStatus"),
  };
}

export function normalizeCategoryInput(raw: unknown): RecordEmploymentCategory {
  const s = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!s) return "unknown";
  if (s === "fulltime" || s === "ft" || s === "full_time_employee") return "full_time";
  if ((RECORD_EMPLOYMENT_CATEGORIES as readonly string[]).includes(s)) {
    return s as RecordEmploymentCategory;
  }
  return "unknown";
}

export function normalizeWorkTypeInput(raw: unknown): RecordWorkType {
  const s = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!s) return "unknown";
  if (s === "human_resources") return "hr";
  if ((RECORD_WORK_TYPES as readonly string[]).includes(s)) {
    return s as RecordWorkType;
  }
  return "unknown";
}

export function classifyEmploymentStatus(input: {
  workforceEmploymentStatus?: string | null;
  hasRelievedCase?: boolean;
  explicitOverrideStatus?: string | null;
  parsedLastWorkingDate?: string | null;
  todayIso: string;
}): {
  employmentStatus: RecordEmploymentStatus;
  statusNeedsReview: boolean;
  statusSource: RecordStatusSource;
} {
  if (input.hasRelievedCase) {
    return {
      employmentStatus: "inactive",
      statusNeedsReview: false,
      statusSource: "relieving_record",
    };
  }

  const wf = input.workforceEmploymentStatus?.trim().toLowerCase();
  if (wf) {
    if (wf === "active") {
      return {
        employmentStatus: "active",
        statusNeedsReview: false,
        statusSource: "workforce_verified",
      };
    }
    return {
      employmentStatus: "inactive",
      statusNeedsReview: false,
      statusSource: "workforce_verified",
    };
  }

  const explicit = input.explicitOverrideStatus?.trim().toLowerCase();
  if (explicit === "active" || explicit === "inactive") {
    return {
      employmentStatus: explicit,
      statusNeedsReview: false,
      statusSource: "hr_manual",
    };
  }

  if (input.parsedLastWorkingDate) {
    const isPastOrToday = input.parsedLastWorkingDate <= input.todayIso;
    return {
      employmentStatus: isPastOrToday ? "inactive" : "active",
      statusNeedsReview: !isPastOrToday,
      statusSource: isPastOrToday ? "hr_historical" : "needs_review",
    };
  }

  // Blank LWD with no active Workforce link NEVER assumes Active automatically
  return {
    employmentStatus: "inactive",
    statusNeedsReview: true,
    statusSource: "needs_review",
  };
}

export type DirectoryWorkforceEntry = {
  profileId: string;
  employeeCode: string | null;
  fullName: string;
  workEmail: string;
  personalEmail: string | null;
  mobile: string | null;
  employmentStatus: string;
  category: string;
  workType: string | null;
  designation: string | null;
  departmentName: string | null;
  joiningDate: string | null;
  lastWorkingDay: string | null;
  hasRelievedCase: boolean;
};

export type DirectoryRecordEntry = {
  id: string;
  historicalRecordCode: string;
  profileId: string | null;
  tasEmployeeCode: string | null;
  displayName: string;
  organizationEmail: string | null;
  personalEmail: string | null;
  phoneNumber: string | null;
  joiningDate: string | null;
  employmentStatus: string;
  designation: string | null;
  departmentName: string | null;
};

export type MatchDirectoryInput = {
  workforce: DirectoryWorkforceEntry[];
  records: DirectoryRecordEntry[];
  todayIso: string;
};

export type RawExcelRowInput = Record<string, string | number | null | undefined>;

export type MatchOptions = {
  mapping: SourceColumnMapping;
  dateOptions?: DateParseOptions | undefined;
  overridesByRow?: Record<number, Partial<ImportPreviewRow>> | undefined;
};

export function matchImportRowsAgainstDirectory(
  rawRows: readonly RawExcelRowInput[],
  directory: MatchDirectoryInput,
  options: MatchOptions,
): {
  rows: ImportPreviewRow[];
  summary: ImportPreviewSummary;
  missingWorkforceProfiles: MissingWorkforceEntry[];
} {
  const { mapping, dateOptions, overridesByRow } = options;

  // Build O(1) indexes across Workforce + Existing Records for 5,000+ row scalability
  const wfById = new Map<string, DirectoryWorkforceEntry>();
  const wfByWorkEmail = new Map<string, DirectoryWorkforceEntry[]>();
  const wfByPersonalEmail = new Map<string, DirectoryWorkforceEntry[]>();
  const wfByCode = new Map<string, DirectoryWorkforceEntry[]>();
  const wfByPhone = new Map<string, DirectoryWorkforceEntry[]>();
  const wfByName = new Map<string, DirectoryWorkforceEntry[]>();

  const pushMap = <K, V>(map: Map<K, V[]>, key: K | null | undefined, val: V) => {
    if (!key) return;
    const arr = map.get(key);
    if (arr) arr.push(val);
    else map.set(key, [val]);
  };

  for (const w of directory.workforce) {
    wfById.set(w.profileId, w);
    pushMap(wfByWorkEmail, normalizeEmail(w.workEmail), w);
    pushMap(wfByPersonalEmail, normalizeEmail(w.personalEmail), w);
    pushMap(wfByCode, w.employeeCode?.trim().toUpperCase(), w);
    pushMap(wfByPhone, normalizePhone(w.mobile), w);
    pushMap(wfByName, normalizeName(w.fullName), w);
  }

  const recByProfileId = new Map<string, DirectoryRecordEntry>();
  const recByOrgEmail = new Map<string, DirectoryRecordEntry[]>();
  const recByPersonalEmail = new Map<string, DirectoryRecordEntry[]>();
  const recByCode = new Map<string, DirectoryRecordEntry[]>();
  const recByPhone = new Map<string, DirectoryRecordEntry[]>();
  const recByName = new Map<string, DirectoryRecordEntry[]>();

  for (const r of directory.records) {
    if (r.profileId) recByProfileId.set(r.profileId, r);
    pushMap(recByOrgEmail, normalizeEmail(r.organizationEmail), r);
    pushMap(recByPersonalEmail, normalizeEmail(r.personalEmail), r);
    pushMap(recByCode, r.tasEmployeeCode?.trim().toUpperCase(), r);
    pushMap(recByPhone, normalizePhone(r.phoneNumber), r);
    pushMap(recByName, normalizeName(r.displayName), r);
  }

  const toCandidateFromWf = (w: DirectoryWorkforceEntry, signal: string): ImportCandidateMatch => ({
    source: "workforce",
    recordId: recByProfileId.get(w.profileId)?.id ?? null,
    profileId: w.profileId,
    tasEmployeeCode: w.employeeCode,
    historicalRecordCode: recByProfileId.get(w.profileId)?.historicalRecordCode ?? null,
    displayName: w.fullName,
    organizationEmail: w.workEmail,
    personalEmail: w.personalEmail,
    phoneNumber: w.mobile,
    joiningDate: w.joiningDate,
    employmentStatus: w.employmentStatus,
    designation: w.designation,
    departmentName: w.departmentName,
    matchSignal: signal,
  });

  const toCandidateFromRec = (r: DirectoryRecordEntry, signal: string): ImportCandidateMatch => ({
    source: "records",
    recordId: r.id,
    profileId: r.profileId,
    tasEmployeeCode: r.tasEmployeeCode,
    historicalRecordCode: r.historicalRecordCode,
    displayName: r.displayName,
    organizationEmail: r.organizationEmail,
    personalEmail: r.personalEmail,
    phoneNumber: r.phoneNumber,
    joiningDate: r.joiningDate,
    employmentStatus: r.employmentStatus,
    designation: r.designation,
    departmentName: r.departmentName,
    matchSignal: signal,
  });

  // Pass 1: Extract & parse fields, track intra-file identity keys for duplicate detection
  const fileOrgEmails = new Map<string, number[]>();
  const filePersonalEmails = new Map<string, number[]>();
  const filePhones = new Map<string, number[]>();
  const fileNames = new Map<string, number[]>();

  const readCell = (raw: RawExcelRowInput, col: string | null | undefined): string => {
    if (!col) return "";
    const v = raw[col];
    return v === null || v === undefined ? "" : String(v).trim();
  };

  const preliminary = rawRows.map((raw, idx) => {
    const rowNumber = idx + 2; // 1-based worksheet row accounting for header row 1
    const ov = overridesByRow?.[rowNumber];

    const firstName = (ov?.firstName ?? readCell(raw, mapping.firstName)).trim();
    const rawLastName = ov?.lastName !== undefined ? (ov.lastName ?? "") : readCell(raw, mapping.lastName);
    const lastName = rawLastName.trim() || null;
    const displayName = buildDisplayName(firstName, lastName);

    const rawPhone = ov?.phoneNumber !== undefined ? (ov.phoneNumber ?? "") : readCell(raw, mapping.phoneNumber);
    const phoneDisplay = formatPhoneDisplay(rawPhone);
    const normPhone = normalizePhone(phoneDisplay);

    const rawPersonalEmail =
      ov?.personalEmail !== undefined ? (ov.personalEmail ?? "") : readCell(raw, mapping.personalEmail);
    const personalEmail = normalizeEmail(rawPersonalEmail);

    const rawOrgEmail =
      ov?.organizationEmail !== undefined ? (ov.organizationEmail ?? "") : readCell(raw, mapping.organizationEmail);
    const organizationEmail = normalizeEmail(rawOrgEmail);

    const rawTasCode =
      ov?.matchedTasCode !== undefined
        ? (ov.matchedTasCode ?? "")
        : readCell(raw, mapping.tasEmployeeCode);
    const tasCode = rawTasCode.trim().toUpperCase() || null;

    const dojCell = ov?.joiningDate !== undefined ? ov.joiningDate : raw[mapping.joiningDate ?? ""];
    const dojParsed = ov?.joiningDate
      ? parseExcelRecordDate(ov.joiningDate, dateOptions)
      : parseExcelRecordDate(dojCell, dateOptions);

    const lwdCell = ov?.lastWorkingDate !== undefined ? ov.lastWorkingDate : raw[mapping.lastWorkingDate ?? ""];
    const lwdParsed = ov?.lastWorkingDate
      ? parseExcelRecordDate(ov.lastWorkingDate, dateOptions)
      : parseExcelRecordDate(lwdCell, dateOptions);

    if (organizationEmail) pushMap(fileOrgEmails, organizationEmail, rowNumber);
    if (personalEmail) pushMap(filePersonalEmails, personalEmail, rowNumber);
    if (normPhone) pushMap(filePhones, normPhone, rowNumber);
    const normName = normalizeName(displayName);
    if (normName) pushMap(fileNames, normName, rowNumber);

    const cleanRaw: Record<string, string | number | null> = {};
    for (const [k, v] of Object.entries(raw)) {
      cleanRaw[k] = v === undefined ? null : (v as string | number | null);
    }

    return {
      rowNumber,
      raw: cleanRaw,
      ov,
      firstName,
      lastName,
      displayName,
      normName,
      phoneDisplay,
      normPhone,
      personalEmail,
      organizationEmail,
      tasCode,
      dojParsed,
      lwdParsed,
      address: (ov?.address ?? readCell(raw, mapping.address)).trim() || null,
      employmentCategory: ov?.employmentCategory ?? normalizeCategoryInput(readCell(raw, mapping.employmentCategory)),
      workType: ov?.workType ?? normalizeWorkTypeInput(readCell(raw, mapping.workType)),
      departmentName: (ov?.departmentName ?? readCell(raw, mapping.department)).trim() || null,
      designation: (ov?.designation ?? readCell(raw, mapping.designation)).trim() || null,
      driveFolderUrl: (ov?.driveFolderUrl ?? readCell(raw, mapping.driveFolderUrl)).trim() || null,
      explicitStatus: ov?.employmentStatus ?? (readCell(raw, mapping.employmentStatus) || null),
    };
  });

  const matchedProfileIds = new Set<string>();

  // Sequential intra-file tracking so the FIRST valid occurrence imports and
  // any SUBSEQUENT repeated row in the same file is rejected as duplicate_in_file.
  const seenFileTasCodes = new Map<string, number>();
  const seenFileOrgEmails = new Map<string, number>();
  const seenFilePersonalEmails = new Map<string, { rowNumber: number; normName: string; tasCode: string | null; orgEmail: string | null }>();
  const seenFilePhoneName = new Map<string, number>();
  const seenFileExactNameNoContact = new Map<string, number>();

  // Pass 2: Validate, detect DB duplicates (Workforce + Records), and reject intra-file repeats
  const rows: ImportPreviewRow[] = preliminary.map((item) => {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!item.firstName || item.firstName.length < 1) {
      errors.push("First Name is required.");
    }
    if (item.personalEmail && !isValidEmail(item.personalEmail)) {
      errors.push(`Personal Email "${item.personalEmail}" is invalid.`);
    }
    if (item.organizationEmail && !isValidEmail(item.organizationEmail)) {
      errors.push(`TAS / Organization Email "${item.organizationEmail}" is invalid.`);
    }
    if (item.dojParsed.status === "needs_review") {
      warnings.push(item.dojParsed.reason ?? `DOJ "${item.dojParsed.rawValue}" requires review.`);
    }
    if (item.lwdParsed.status === "needs_review") {
      warnings.push(item.lwdParsed.reason ?? `LWD "${item.lwdParsed.rawValue}" requires review.`);
    }
    if (item.dojParsed.iso && item.lwdParsed.iso && item.lwdParsed.iso < item.dojParsed.iso) {
      warnings.push(
        `LWD (${item.lwdParsed.iso}) is earlier than DOJ (${item.dojParsed.iso}) — requires verification.`,
      );
    }
    if (item.driveFolderUrl) {
      const driveCheck = validateGoogleDriveFolderUrl(item.driveFolderUrl);
      if (!driveCheck.valid) {
        errors.push(driveCheck.error ?? "Invalid Google Drive folder URL.");
      }
    }

    const candidates: ImportCandidateMatch[] = [];
    const seenCandidateKey = new Set<string>();
    const pushCand = (c: ImportCandidateMatch) => {
      const k = c.profileId ? `p:${c.profileId}` : `r:${c.recordId}`;
      if (!seenCandidateKey.has(k)) {
        seenCandidateKey.add(k);
        candidates.push(c);
      }
    };

    let matchedProfileId: string | null = item.ov?.matchedProfileId ?? null;
    let matchedRecordId: string | null = item.ov?.matchedRecordId ?? null;
    let matchedTasCode: string | null = item.tasCode;
    let matchSignal: string | null = null;
    let matchConfidence: ImportPreviewRow["matchConfidence"] = "unmatched";
    let duplicateReason: string | null = null;
    const duplicateWithRowNumbers: number[] = [];

    // 1. Check existing Workforce + Employee Records by stable identifiers:
    //    (a) TAS Employee ID, (b) Organization Email, (c) Personal Email (when identity matches or lacks distinct ID),
    //    (d) Phone + Full Name together (never reject distinct people solely for sharing a phone!).
    if (item.tasCode) {
      for (const w of wfByCode.get(item.tasCode) ?? []) {
        pushCand(toCandidateFromWf(w, `Existing Workforce ID ${item.tasCode}`));
      }
      for (const r of recByCode.get(item.tasCode) ?? []) {
        pushCand(toCandidateFromRec(r, `Existing Employee ID ${item.tasCode}`));
      }
    }
    if (item.organizationEmail) {
      for (const w of wfByWorkEmail.get(item.organizationEmail) ?? []) {
        pushCand(toCandidateFromWf(w, `Existing Work Email (${item.organizationEmail})`));
      }
      for (const r of recByOrgEmail.get(item.organizationEmail) ?? []) {
        pushCand(toCandidateFromRec(r, `Existing Organization Email (${item.organizationEmail})`));
      }
    }
    if (item.personalEmail) {
      const pHits: ImportCandidateMatch[] = [
        ...(wfByPersonalEmail.get(item.personalEmail) ?? []).map((w) =>
          toCandidateFromWf(w, `Matching Personal Email (${item.personalEmail})`),
        ),
        ...(recByPersonalEmail.get(item.personalEmail) ?? []).map((r) =>
          toCandidateFromRec(r, `Matching Personal Email (${item.personalEmail})`),
        ),
      ];
      for (const c of pHits) {
        const sameName = normalizeName(c.displayName) === item.normName;
        const distinctByStrongId = Boolean(item.tasCode && c.tasEmployeeCode && item.tasCode !== c.tasEmployeeCode.toUpperCase());
        if (!distinctByStrongId && (sameName || !item.tasCode || !item.organizationEmail)) {
          pushCand(c);
        } else {
          warnings.push(`Shares personal email ${item.personalEmail} with ${c.displayName} (different ID/name — allowed as distinct person).`);
        }
      }
    }
    if (candidates.length === 0 && item.normPhone) {
      const phoneHits: ImportCandidateMatch[] = [
        ...(wfByPhone.get(item.normPhone) ?? []).map((w) =>
          toCandidateFromWf(w, "Matching Phone + Full Name"),
        ),
        ...(recByPhone.get(item.normPhone) ?? []).map((r) =>
          toCandidateFromRec(r, "Matching Phone + Full Name"),
        ),
      ];
      for (const c of phoneHits) {
        if (item.normName && normalizeName(c.displayName) === item.normName) {
          pushCand(c);
        } else {
          warnings.push(`Phone ${item.phoneDisplay} is also listed for ${c.displayName} (distinct employee — not rejected).`);
        }
      }
    }

    let isDuplicateExisting = false;
    let isDuplicateInFile = false;

    if (candidates.length > 0) {
      const win = candidates[0]!;
      matchedProfileId = win.profileId;
      matchedRecordId = win.recordId;
      matchedTasCode = win.tasEmployeeCode ?? item.tasCode;
      matchSignal = win.matchSignal;
      matchConfidence = "exact";
      isDuplicateExisting = true;
      duplicateReason = `Already exists in ${win.source === "workforce" ? "Workforce" : "Employee Records"}: ${win.displayName}${win.tasEmployeeCode ? ` (${win.tasEmployeeCode})` : ""} — ${win.matchSignal}.`;
    }

    // Name-only review candidates (when no DB duplicate triggered yet, and no distinct email/ID)
    if (!isDuplicateExisting && item.normName && !item.organizationEmail && !item.tasCode) {
      for (const w of wfByName.get(item.normName) ?? []) {
        pushCand(toCandidateFromWf(w, "Same full name (no email/ID to disambiguate)"));
      }
      for (const r of recByName.get(item.normName) ?? []) {
        pushCand(toCandidateFromRec(r, "Same full name (no email/ID to disambiguate)"));
      }
      if (candidates.length > 0) {
        matchConfidence = "needs_review";
        matchSignal = "name_only_review_candidate";
        warnings.push(
          `Name "${item.displayName}" matches an existing person without a unique ID or email — review required.`,
        );
      }
    }

    // 2. Check intra-file duplicates against earlier rows in this same file
    if (!isDuplicateExisting && errors.length === 0) {
      let dupRowNum: number | null = null;
      let dupWhy = "";

      if (item.tasCode && seenFileTasCodes.has(item.tasCode)) {
        dupRowNum = seenFileTasCodes.get(item.tasCode)!;
        dupWhy = `same Employee ID (${item.tasCode})`;
      } else if (item.organizationEmail && seenFileOrgEmails.has(item.organizationEmail)) {
        dupRowNum = seenFileOrgEmails.get(item.organizationEmail)!;
        dupWhy = `same Organization Email (${item.organizationEmail})`;
      } else if (item.personalEmail && seenFilePersonalEmails.has(item.personalEmail)) {
        const prev = seenFilePersonalEmails.get(item.personalEmail)!;
        const sameName = prev.normName === item.normName;
        const distinctIds = Boolean(item.tasCode && prev.tasCode && item.tasCode !== prev.tasCode);
        if (!distinctIds && (sameName || !item.tasCode || !item.organizationEmail)) {
          dupRowNum = prev.rowNumber;
          dupWhy = `same Personal Email (${item.personalEmail})`;
        } else {
          warnings.push(`Shares personal email ${item.personalEmail} with row #${prev.rowNumber} (distinct ID/name — allowed).`);
        }
      } else if (item.normPhone && item.normName && seenFilePhoneName.has(`${item.normPhone}|${item.normName}`)) {
        dupRowNum = seenFilePhoneName.get(`${item.normPhone}|${item.normName}`)!;
        dupWhy = `same Name and Phone (${item.phoneDisplay})`;
      } else if (
        !item.tasCode &&
        !item.organizationEmail &&
        !item.personalEmail &&
        !item.normPhone &&
        item.normName &&
        seenFileExactNameNoContact.has(item.normName)
      ) {
        dupRowNum = seenFileExactNameNoContact.get(item.normName)!;
        dupWhy = `repeated name "${item.displayName}" with no unique identifier`;
      }

      if (dupRowNum !== null) {
        isDuplicateInFile = true;
        duplicateWithRowNumbers.push(dupRowNum);
        duplicateReason = `Duplicate of row #${dupRowNum} in this import file (${dupWhy}).`;
      } else {
        // Register first valid occurrence in seenFile maps
        if (item.tasCode) seenFileTasCodes.set(item.tasCode, item.rowNumber);
        if (item.organizationEmail) seenFileOrgEmails.set(item.organizationEmail, item.rowNumber);
        if (item.personalEmail && !seenFilePersonalEmails.has(item.personalEmail)) {
          seenFilePersonalEmails.set(item.personalEmail, {
            rowNumber: item.rowNumber,
            normName: item.normName,
            tasCode: item.tasCode,
            orgEmail: item.organizationEmail,
          });
        }
        if (item.normPhone && item.normName) {
          seenFilePhoneName.set(`${item.normPhone}|${item.normName}`, item.rowNumber);
        }
        if (!item.tasCode && !item.organizationEmail && !item.personalEmail && !item.normPhone && item.normName) {
          seenFileExactNameNoContact.set(item.normName, item.rowNumber);
        }
      }
    }

    if (matchedProfileId) {
      matchedProfileIds.add(matchedProfileId);
    }

    const linkedWf = matchedProfileId ? wfById.get(matchedProfileId) : undefined;
    const statusInfo = classifyEmploymentStatus({
      workforceEmploymentStatus: linkedWf?.employmentStatus ?? null,
      hasRelievedCase: linkedWf?.hasRelievedCase ?? false,
      explicitOverrideStatus: item.explicitStatus,
      parsedLastWorkingDate: item.lwdParsed.iso,
      todayIso: directory.todayIso,
    });

    const { missingFields } = computeRecordCompleteness({
      lastName: item.lastName,
      personalEmail: item.personalEmail ?? linkedWf?.personalEmail ?? null,
      organizationEmail: item.organizationEmail ?? linkedWf?.workEmail ?? null,
      phoneNumber: item.phoneDisplay ?? linkedWf?.mobile ?? null,
      address: item.address,
      joiningDate: item.dojParsed.iso ?? linkedWf?.joiningDate ?? null,
      employmentCategory:
        item.employmentCategory !== "unknown"
          ? item.employmentCategory
          : (linkedWf?.category ?? "unknown"),
      workType:
        item.workType !== "unknown" ? item.workType : (linkedWf?.workType ?? "unknown"),
      departmentName: item.departmentName ?? linkedWf?.departmentName ?? null,
      designation: item.designation ?? linkedWf?.designation ?? null,
      documentSource: item.driveFolderUrl ? "HISTORICAL_GOOGLE_DRIVE" : "NONE",
    });

    const hasAmbiguousDates =
      item.dojParsed.status === "needs_review" ||
      item.lwdParsed.status === "needs_review" ||
      Boolean(item.dojParsed.iso && item.lwdParsed.iso && item.lwdParsed.iso < item.dojParsed.iso);

    let category: ImportPreviewRow["category"];
    if (errors.length > 0) {
      category = "invalid";
    } else if (isDuplicateExisting) {
      category = "duplicate_existing";
    } else if (isDuplicateInFile) {
      category = "duplicate_in_file";
    } else if (matchConfidence === "needs_review") {
      category = "possible_duplicate";
    } else if (hasAmbiguousDates) {
      category = "needs_information";
    } else {
      category = "new_historical";
    }

    const excluded = Boolean(item.ov?.excluded);
    const readyToImport =
      !excluded &&
      errors.length === 0 &&
      category === "new_historical";

    return {
      rowNumber: item.rowNumber,
      raw: item.raw,
      firstName: item.firstName,
      lastName: item.lastName,
      displayName: item.displayName,
      phoneNumber: item.phoneDisplay,
      personalEmail: item.personalEmail,
      organizationEmail: item.organizationEmail,
      address: item.address,
      joiningDate: item.dojParsed.iso,
      joiningDateStatus: item.dojParsed.status,
      joiningDateRaw: item.dojParsed.rawValue,
      joiningDateReason: item.dojParsed.reason,
      joiningDateAlternateIso: item.dojParsed.alternateIso ?? null,
      lastWorkingDate: item.lwdParsed.iso,
      lastWorkingDateStatus: item.lwdParsed.status,
      lastWorkingDateRaw: item.lwdParsed.rawValue,
      lastWorkingDateReason: item.lwdParsed.reason,
      lastWorkingDateAlternateIso: item.lwdParsed.alternateIso ?? null,
      employmentStatus: statusInfo.employmentStatus,
      statusNeedsReview: statusInfo.statusNeedsReview,
      statusSource: statusInfo.statusSource,
      employmentCategory: item.employmentCategory,
      workType: item.workType,
      departmentName: item.departmentName,
      designation: item.designation,
      driveFolderUrl: item.driveFolderUrl,
      category,
      matchConfidence,
      matchSignal,
      matchedProfileId,
      matchedRecordId,
      matchedTasCode,
      candidates,
      duplicateWithRowNumbers,
      duplicateReason,
      missingFields,
      warnings,
      errors,
      excluded,
      readyToImport,
    };
  });

  // Outcome C: Workforce employees completely absent from the uploaded Excel sheet
  const missingWorkforceProfiles: MissingWorkforceEntry[] = directory.workforce
    .filter((w) => !matchedProfileIds.has(w.profileId))
    .map((w) => ({
      profileId: w.profileId,
      tasEmployeeCode: w.employeeCode,
      fullName: w.fullName,
      workEmail: w.workEmail,
      employmentStatus: w.employmentStatus,
      category: w.category,
      workType: w.workType,
      designation: w.designation,
      departmentName: w.departmentName,
      joiningDate: w.joiningDate,
    }));

  const duplicateExistingCount = rows.filter((r) => r.category === "duplicate_existing").length;
  const duplicateInFileCount = rows.filter((r) => r.category === "duplicate_in_file").length;

  const summary: ImportPreviewSummary = {
    totalRows: rows.length,
    matchedWorkforceCount: duplicateExistingCount,
    newHistoricalCount: rows.filter((r) => r.category === "new_historical").length,
    existingHistoricalCount: 0,
    missingWorkforceCount: missingWorkforceProfiles.length,
    duplicateExistingCount,
    duplicateInFileCount,
    duplicateCount: duplicateExistingCount + duplicateInFileCount,
    possibleDuplicatesCount: rows.filter((r) => r.category === "possible_duplicate").length,
    needsInformationCount: rows.filter((r) => r.category === "needs_information").length,
    invalidCount: rows.filter((r) => r.category === "invalid").length,
    excludedCount: rows.filter((r) => r.excluded).length,
    readyToImportCount: rows.filter((r) => r.readyToImport).length,
    dateNeedsReviewCount: rows.filter(
      (r) => r.joiningDateStatus === "needs_review" || r.lastWorkingDateStatus === "needs_review",
    ).length,
    statusNeedsReviewCount: rows.filter((r) => r.statusNeedsReview).length,
  };

  return { rows, summary, missingWorkforceProfiles };
}

/** Controlled Google Drive folder-link matching against master Employee Records. */
export function matchDriveFolderLinks(
  rows: readonly DriveFolderMappingRow[],
  existingRecords: readonly DirectoryRecordEntry[],
): DriveMappingPreviewRow[] {
  const byHistCode = new Map<string, DirectoryRecordEntry>();
  const byEmail = new Map<string, DirectoryRecordEntry[]>();
  const byName = new Map<string, DirectoryRecordEntry[]>();

  const pushMap = (map: Map<string, DirectoryRecordEntry[]>, key: string | null, rec: DirectoryRecordEntry) => {
    if (!key) return;
    const arr = map.get(key);
    if (arr) arr.push(rec);
    else map.set(key, [rec]);
  };

  for (const r of existingRecords) {
    byHistCode.set(r.historicalRecordCode.toUpperCase(), r);
    pushMap(byEmail, normalizeEmail(r.organizationEmail), r);
    pushMap(byEmail, normalizeEmail(r.personalEmail), r);
    pushMap(byName, normalizeName(r.displayName), r);
  }

  return rows.map((row) => {
    const urlCheck = validateGoogleDriveFolderUrl(row.driveFolderUrl);
    if (!urlCheck.valid || !urlCheck.folderId || !urlCheck.normalizedUrl) {
      return {
        rowNumber: row.rowNumber,
        employeeName: row.employeeName,
        employeeEmail: row.employeeEmail,
        historicalRecordCode: row.historicalRecordCode,
        driveFolderUrl: row.driveFolderUrl,
        folderId: null,
        urlValid: false,
        urlError: urlCheck.error ?? "Valid Google Drive folder URL is required.",
        matchStatus: "invalid",
        matchedRecordId: null,
        matchedDisplayName: null,
        matchedHistoricalCode: null,
        candidates: [],
        confirmed: false,
      };
    }

    const toMiniCand = (r: DirectoryRecordEntry) => ({
      recordId: r.id,
      historicalRecordCode: r.historicalRecordCode,
      displayName: r.displayName,
      organizationEmail: r.organizationEmail,
      personalEmail: r.personalEmail,
    });

    // 1. Historical Record Code (exact)
    if (row.historicalRecordCode) {
      const hit = byHistCode.get(row.historicalRecordCode.trim().toUpperCase());
      if (hit) {
        return {
          rowNumber: row.rowNumber,
          employeeName: row.employeeName,
          employeeEmail: row.employeeEmail,
          historicalRecordCode: row.historicalRecordCode,
          driveFolderUrl: urlCheck.normalizedUrl,
          folderId: urlCheck.folderId,
          urlValid: true,
          urlError: null,
          matchStatus: "exact",
          matchedRecordId: hit.id,
          matchedDisplayName: hit.displayName,
          matchedHistoricalCode: hit.historicalRecordCode,
          candidates: [toMiniCand(hit)],
          confirmed: true,
        };
      }
    }

    // 2. Exact Email
    const normEmail = normalizeEmail(row.employeeEmail);
    if (normEmail) {
      const emailHits = byEmail.get(normEmail) ?? [];
      if (emailHits.length === 1) {
        const hit = emailHits[0]!;
        return {
          rowNumber: row.rowNumber,
          employeeName: row.employeeName,
          employeeEmail: row.employeeEmail,
          historicalRecordCode: row.historicalRecordCode,
          driveFolderUrl: urlCheck.normalizedUrl,
          folderId: urlCheck.folderId,
          urlValid: true,
          urlError: null,
          matchStatus: "exact",
          matchedRecordId: hit.id,
          matchedDisplayName: hit.displayName,
          matchedHistoricalCode: hit.historicalRecordCode,
          candidates: [toMiniCand(hit)],
          confirmed: true,
        };
      }
      if (emailHits.length > 1) {
        return {
          rowNumber: row.rowNumber,
          employeeName: row.employeeName,
          employeeEmail: row.employeeEmail,
          historicalRecordCode: row.historicalRecordCode,
          driveFolderUrl: urlCheck.normalizedUrl,
          folderId: urlCheck.folderId,
          urlValid: true,
          urlError: null,
          matchStatus: "ambiguous",
          matchedRecordId: null,
          matchedDisplayName: null,
          matchedHistoricalCode: null,
          candidates: emailHits.map(toMiniCand),
          confirmed: false,
        };
      }
    }

    // 3. Name matching (proposed only if unique; ambiguous if >= 2; never auto-confirmed without review)
    const normName = normalizeName(row.employeeName);
    const nameHits = normName ? (byName.get(normName) ?? []) : [];
    if (nameHits.length === 1) {
      const hit = nameHits[0]!;
      return {
        rowNumber: row.rowNumber,
        employeeName: row.employeeName,
        employeeEmail: row.employeeEmail,
        historicalRecordCode: row.historicalRecordCode,
        driveFolderUrl: urlCheck.normalizedUrl,
        folderId: urlCheck.folderId,
        urlValid: true,
        urlError: null,
        matchStatus: "proposed",
        matchedRecordId: hit.id,
        matchedDisplayName: hit.displayName,
        matchedHistoricalCode: hit.historicalRecordCode,
        candidates: [toMiniCand(hit)],
        confirmed: false,
      };
    }

    if (nameHits.length > 1) {
      return {
        rowNumber: row.rowNumber,
        employeeName: row.employeeName,
        employeeEmail: row.employeeEmail,
        historicalRecordCode: row.historicalRecordCode,
        driveFolderUrl: urlCheck.normalizedUrl,
        folderId: urlCheck.folderId,
        urlValid: true,
        urlError: null,
        matchStatus: "ambiguous",
        matchedRecordId: null,
        matchedDisplayName: null,
        matchedHistoricalCode: null,
        candidates: nameHits.map(toMiniCand),
        confirmed: false,
      };
    }

    return {
      rowNumber: row.rowNumber,
      employeeName: row.employeeName,
      employeeEmail: row.employeeEmail,
      historicalRecordCode: row.historicalRecordCode,
      driveFolderUrl: urlCheck.normalizedUrl,
      folderId: urlCheck.folderId,
      urlValid: true,
      urlError: null,
      matchStatus: "unmatched",
      matchedRecordId: null,
      matchedDisplayName: null,
      matchedHistoricalCode: null,
      candidates: [],
      confirmed: false,
    };
  });
}

export type UnifiedWorkforceProfileInput = {
  id: string;
  employeeCode: string | null;
  fullName: string;
  workEmail: string;
  personalEmail: string | null;
  mobile: string | null;
  address: string | null;
  joiningDate: string | null;
  lastWorkingDay: string | null;
  employmentStatus: string;
  category: string;
  workType: string | null;
  departmentId: string | null;
  departmentName: string | null;
  designation: string | null;
  reportingLeadId: string | null;
  reportingLeadName: string | null;
  hasRelievedCase: boolean;
  relievingEffectiveDate: string | null;
  legalEmployer: string | null;
  createdAt: string;
};

/**
 * Merges live non-protected Workforce profiles with existing `employee_records`
 * into one unified, duplicate-free register keyed by canonical employee identity.
 */
export function mergeWorkforceAndRecords(args: {
  workforce: readonly UnifiedWorkforceProfileInput[];
  records: readonly EmployeeRecordItem[];
  kycSummaries: ReadonlyMap<string, import("./types").KycSummarySnapshot>;
  todayIso: string;
}): EmployeeRecordItem[] {
  const recByProfileId = new Map<string, EmployeeRecordItem>();
  for (const r of args.records) {
    if (r.profileId) recByProfileId.set(r.profileId, r);
  }

  const unified: EmployeeRecordItem[] = [];

  for (const p of args.workforce) {
    const existing = recByProfileId.get(p.id);
    const kyc = args.kycSummaries.get(p.id) ?? existing?.kycSummary ?? null;
    const hasKyc = Boolean(
      kyc && ((kyc.uploadedCount ?? 0) > 0 || (kyc.verifiedCount ?? 0) > 0 || (kyc.pendingCount ?? 0) > 0),
    );
    const hasDrive = Boolean(existing?.hasDriveFolder || existing?.driveFolderUrl);

    const statusInfo = classifyEmploymentStatus({
      workforceEmploymentStatus: p.employmentStatus,
      hasRelievedCase: p.hasRelievedCase,
      todayIso: args.todayIso,
    });
    const parts = splitDisplayName(p.fullName || p.workEmail.split("@")[0] || "Employee");
    const cat = normalizeCategoryInput(p.category);
    const wt = normalizeWorkTypeInput(p.workType);
    const docSource =
      hasDrive && hasKyc
        ? "BOTH"
        : hasDrive
          ? "HISTORICAL_GOOGLE_DRIVE"
          : hasKyc
            ? "HRM_KYC"
            : "NONE";
    const docAvail =
      hasDrive || ((kyc?.verifiedCount ?? 0) > 0 && (kyc?.verifiedCount ?? 0) >= (kyc?.requiredCount ?? 5))
        ? "available"
        : hasKyc
          ? "partial"
          : "missing";

    const mergedDisplayName = p.fullName.trim() || existing?.displayName || p.workEmail;
    const mergedFirstName = parts.firstName || existing?.firstName || mergedDisplayName;
    const mergedLastName = parts.lastName ?? existing?.lastName ?? null;
    const mergedPersonalEmail = p.personalEmail || existing?.personalEmail || null;
    const mergedOrgEmail = p.workEmail || existing?.organizationEmail || null;
    const mergedPhone = p.mobile || existing?.phoneNumber || null;
    const mergedAddress = p.address || existing?.address || null;
    const mergedJoining = p.joiningDate || existing?.joiningDate || null;
    const mergedLwd = p.relievingEffectiveDate || p.lastWorkingDay || existing?.lastWorkingDate || null;
    const mergedDeptId = p.departmentId || existing?.departmentId || null;
    const mergedDeptName = p.departmentName || existing?.departmentName || null;
    const mergedDesig = p.designation || existing?.designation || null;
    const comp = computeRecordCompleteness({
      lastName: mergedLastName,
      personalEmail: mergedPersonalEmail,
      organizationEmail: mergedOrgEmail,
      phoneNumber: mergedPhone,
      address: mergedAddress,
      joiningDate: mergedJoining,
      employmentCategory: cat !== "unknown" ? cat : existing?.employmentCategory,
      workType: wt !== "unknown" ? wt : existing?.workType,
      departmentId: mergedDeptId,
      departmentName: mergedDeptName,
      designation: mergedDesig,
      documentSource: docSource,
    });

    unified.push({
      id: existing?.id ?? `wf:${p.id}`,
      historicalRecordCode:
        existing?.historicalRecordCode ??
        p.employeeCode ??
        `WF-${p.id.slice(0, 6).toUpperCase()}`,
      profileId: p.id,
      tasEmployeeCode: p.employeeCode ?? existing?.tasEmployeeCode ?? null,
      firstName: mergedFirstName,
      lastName: mergedLastName,
      displayName: mergedDisplayName,
      personalEmail: mergedPersonalEmail,
      organizationEmail: mergedOrgEmail,
      phoneNumber: mergedPhone,
      address: mergedAddress,
      joiningDate: mergedJoining,
      lastWorkingDate: mergedLwd,
      employmentStatus: statusInfo.employmentStatus,
      statusNeedsReview: false,
      statusSource: statusInfo.statusSource,
      employmentCategory: cat !== "unknown" ? cat : (existing?.employmentCategory ?? "unknown"),
      workType: wt !== "unknown" ? wt : (existing?.workType ?? "unknown"),
      departmentId: mergedDeptId,
      departmentName: mergedDeptName,
      designation: mergedDesig,
      reportingManagerId: p.reportingLeadId ?? existing?.reportingManagerId ?? null,
      reportingManagerName: p.reportingLeadName ?? existing?.reportingManagerName ?? null,
      legalEmployer: p.legalEmployer ?? existing?.legalEmployer ?? "Learning Paths Technologies LLP",
      driveFolderUrl: existing?.driveFolderUrl ?? null,
      driveFolderName: existing?.driveFolderName ?? null,
      driveFolderId: existing?.driveFolderId ?? null,
      driveMatchStatus: existing?.driveMatchStatus ?? "unmatched",
      driveMatchedAt: existing?.driveMatchedAt ?? null,
      hasDriveFolder: hasDrive,
      documentSource: docSource,
      documentAvailabilityStatus: docAvail,
      kycSummary: kyc,
      sourceType: existing?.sourceType ?? "workforce_sync",
      sourceImportBatchId: existing?.sourceImportBatchId ?? null,
      lastSyncedAt: existing?.lastSyncedAt ?? p.createdAt,
      lastUpdatedBy: existing?.lastUpdatedBy ?? null,
      recordCompleteness: comp.score,
      missingFields: comp.missingFields,
      matchConfidence: "exact",
      duplicateReviewStatus: existing?.duplicateReviewStatus ?? "clear",
      needsReview: existing?.needsReview ?? false,
      reviewReasons: existing?.reviewReasons ?? [],
      notes: existing?.notes ?? null,
      rawSourceSnapshot: existing?.rawSourceSnapshot ?? null,
      createdAt: existing?.createdAt ?? p.createdAt,
      updatedAt: existing?.updatedAt ?? p.createdAt,
    });
  }

  for (const r of args.records) {
    if (!r.profileId) {
      unified.push(r);
    }
  }

  return unified;
}

/** Pure filtering, sorting, and pagination across unified Workforce + Historical Records. */
export function filterAndSortUnifiedRecords(
  records: readonly EmployeeRecordItem[],
  filters: RecordsListFilters,
): {
  filtered: EmployeeRecordItem[];
  pageItems: EmployeeRecordItem[];
  total: number;
  page: number;
  pageSize: number;
} {
  const search = (filters.search ?? "").trim().toLowerCase();

  const filtered = records.filter((r) => {
    if (search) {
      const hay = [
        r.displayName,
        r.tasEmployeeCode ?? "",
        r.historicalRecordCode,
        r.organizationEmail ?? "",
        r.personalEmail ?? "",
        r.departmentName ?? "",
        r.designation ?? "",
        r.phoneNumber ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(search)) return false;
    }

    if (filters.employmentStatus && filters.employmentStatus !== "all") {
      if (r.employmentStatus !== filters.employmentStatus) return false;
    }
    if (filters.workType && filters.workType !== "all") {
      if (r.workType !== filters.workType) return false;
    }
    if (filters.employmentCategory && filters.employmentCategory !== "all") {
      if (r.employmentCategory !== filters.employmentCategory) return false;
    }
    if (filters.departmentId && filters.departmentId !== "all") {
      if (r.departmentId !== filters.departmentId) return false;
    }
    if (filters.joiningDateFrom && (!r.joiningDate || r.joiningDate < filters.joiningDateFrom)) {
      return false;
    }
    if (filters.joiningDateTo && (!r.joiningDate || r.joiningDate > filters.joiningDateTo)) {
      return false;
    }
    if (filters.lwdFrom && (!r.lastWorkingDate || r.lastWorkingDate < filters.lwdFrom)) {
      return false;
    }
    if (filters.lwdTo && (!r.lastWorkingDate || r.lastWorkingDate > filters.lwdTo)) {
      return false;
    }
    if (filters.workforceLink === "linked" && !r.profileId) return false;
    if (filters.workforceLink === "historical_only" && r.profileId) return false;

    if (filters.documentFilter === "has_drive") {
      if (r.documentSource !== "HISTORICAL_GOOGLE_DRIVE" && r.documentSource !== "BOTH") return false;
    } else if (filters.documentFilter === "has_kyc") {
      if (r.documentSource !== "HRM_KYC" && r.documentSource !== "BOTH") return false;
    } else if (filters.documentFilter === "has_both") {
      if (r.documentSource !== "BOTH") return false;
    } else if (filters.documentFilter === "missing_docs") {
      if (r.documentSource !== "NONE") return false;
    }

    if (filters.missingFieldsOnly && r.recordCompleteness >= 100) return false;
    if (filters.needsReviewOnly && !r.needsReview && !r.statusNeedsReview) return false;

    return true;
  });

  const sortCol = filters.sortBy ?? "updated_at";
  const sortAsc = filters.sortDir === "asc";

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    if (sortCol === "display_name") {
      cmp = a.displayName.localeCompare(b.displayName);
    } else if (sortCol === "joining_date") {
      cmp = (a.joiningDate ?? "").localeCompare(b.joiningDate ?? "");
    } else if (sortCol === "last_working_date") {
      cmp = (a.lastWorkingDate ?? "").localeCompare(b.lastWorkingDate ?? "");
    } else if (sortCol === "record_completeness") {
      cmp = a.recordCompleteness - b.recordCompleteness;
    } else {
      cmp = (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "");
    }
    return sortAsc ? cmp : -cmp;
  });

  const page = Math.max(1, Number(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(10, Number(filters.pageSize ?? 25)));
  const start = (page - 1) * pageSize;
  return {
    filtered: sorted,
    pageItems: sorted.slice(start, start + pageSize),
    total: sorted.length,
    page,
    pageSize,
  };
}
