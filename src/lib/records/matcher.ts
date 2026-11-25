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
  type ImportCandidateMatch,
  type ImportPreviewRow,
  type ImportPreviewSummary,
  type MissingWorkforceEntry,
  type RecordEmploymentCategory,
  type RecordEmploymentStatus,
  type RecordStatusSource,
  type RecordWorkType,
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

  // Pass 2: Run 6-tier matching + duplicate detection + validation
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

    // Intra-file duplicates
    const dupRowSet = new Set<number>();
    const addDupRows = (arr: number[] | undefined, reason: string) => {
      if (!arr || arr.length <= 1) return;
      for (const r of arr) {
        if (r !== item.rowNumber) dupRowSet.add(r);
      }
      warnings.push(reason);
    };
    addDupRows(
      item.organizationEmail ? fileOrgEmails.get(item.organizationEmail) : undefined,
      `Duplicate TAS Mail (${item.organizationEmail}) in uploaded file.`,
    );
    addDupRows(
      item.personalEmail ? filePersonalEmails.get(item.personalEmail) : undefined,
      `Duplicate personal E-Mail ID (${item.personalEmail}) in uploaded file.`,
    );
    addDupRows(
      item.normPhone ? filePhones.get(item.normPhone) : undefined,
      `Shared phone number (${item.phoneDisplay}) appears on multiple rows in uploaded file.`,
    );
    addDupRows(
      item.normName ? fileNames.get(item.normName) : undefined,
      `Duplicate full name "${item.displayName}" appears multiple times in uploaded file.`,
    );
    const duplicateWithRowNumbers = [...dupRowSet].sort((a, b) => a - b);

    // 6-Tier Matching Resolution (unless HR manually pinned matchedProfileId / matchedRecordId)
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
    let matchedTasCode: string | null = null;
    let matchSignal: string | null = null;
    let matchConfidence: ImportPreviewRow["matchConfidence"] = "unmatched";

    // Tier 1: Explicit HR override / existing verified linkage
    if (matchedProfileId && wfById.has(matchedProfileId)) {
      const w = wfById.get(matchedProfileId)!;
      matchedRecordId = recByProfileId.get(w.profileId)?.id ?? matchedRecordId;
      matchedTasCode = w.employeeCode;
      matchSignal = "hr_verified_link";
      matchConfidence = "exact";
      pushCand(toCandidateFromWf(w, "HR verified linkage"));
    } else if (matchedRecordId) {
      const rec = directory.records.find((r) => r.id === matchedRecordId);
      if (rec) {
        matchedProfileId = rec.profileId;
        matchedTasCode = rec.tasEmployeeCode;
        matchSignal = "hr_verified_record_link";
        matchConfidence = "exact";
        pushCand(toCandidateFromRec(rec, "HR selected existing record"));
      }
    }

    // Gather all potential candidates across tiers 2..6 when not manually resolved
    if (!matchSignal) {
      // Tier 2: Exact normalized organization email
      if (item.organizationEmail) {
        for (const w of wfByWorkEmail.get(item.organizationEmail) ?? []) {
          pushCand(toCandidateFromWf(w, "Exact organization email (TAS Mail)"));
        }
        for (const r of recByOrgEmail.get(item.organizationEmail) ?? []) {
          pushCand(toCandidateFromRec(r, "Exact organization email (TAS Mail)"));
        }
      }
      // Tier 3: Exact normalized personal email
      if (item.personalEmail) {
        for (const w of wfByPersonalEmail.get(item.personalEmail) ?? []) {
          pushCand(toCandidateFromWf(w, "Exact personal email (E-Mail ID)"));
        }
        for (const r of recByPersonalEmail.get(item.personalEmail) ?? []) {
          pushCand(toCandidateFromRec(r, "Exact personal email (E-Mail ID)"));
        }
      }
      // Tier 4: Verified TAS Employee ID
      if (item.tasCode) {
        for (const w of wfByCode.get(item.tasCode) ?? []) {
          pushCand(toCandidateFromWf(w, "Verified TAS Employee ID"));
        }
        for (const r of recByCode.get(item.tasCode) ?? []) {
          pushCand(toCandidateFromRec(r, "Verified TAS Employee ID"));
        }
      }

      // Auto-resolve ONLY if Tiers 2-4 identify a single unambiguous identity
      const strongCandidates = [...candidates];
      if (strongCandidates.length === 1 && duplicateWithRowNumbers.length === 0) {
        const win = strongCandidates[0]!;
        matchedProfileId = win.profileId;
        matchedRecordId = win.recordId;
        matchedTasCode = win.tasEmployeeCode;
        matchSignal = win.matchSignal;
        matchConfidence = "exact";
      } else if (strongCandidates.length > 1) {
        matchConfidence = "needs_review";
        matchSignal = "multiple_email_or_id_matches";
        warnings.push("Multiple possible Workforce/Record matches found — requires manual review.");
      }

      // Tier 5: Phone number (supporting signal only)
      if (!matchSignal && item.normPhone) {
        for (const w of wfByPhone.get(item.normPhone) ?? []) {
          pushCand(toCandidateFromWf(w, "Supporting phone number match"));
        }
        for (const r of recByPhone.get(item.normPhone) ?? []) {
          pushCand(toCandidateFromRec(r, "Supporting phone number match"));
        }
        if (candidates.length > 0) {
          // Only promote to high confidence if phone AND normalized full name both match uniquely
          const phoneAndName = candidates.filter(
            (c) => normalizeName(c.displayName) === item.normName,
          );
          if (
            candidates.length === 1 &&
            phoneAndName.length === 1 &&
            duplicateWithRowNumbers.length === 0
          ) {
            const win = phoneAndName[0]!;
            matchedProfileId = win.profileId;
            matchedRecordId = win.recordId;
            matchedTasCode = win.tasEmployeeCode;
            matchSignal = "Phone + exact full name";
            matchConfidence = "high";
            warnings.push("Matched via Phone + Name (no email match) — please confirm.");
          } else {
            matchConfidence = "needs_review";
            matchSignal = "phone_requires_review";
            warnings.push(
              "Matched by phone number without exact email — do not merge automatically without HR review.",
            );
          }
        }
      }

      // Tier 6: Normalized full name as review candidate ONLY (never auto-merged!)
      if (!matchSignal && item.normName) {
        for (const w of wfByName.get(item.normName) ?? []) {
          pushCand(toCandidateFromWf(w, "Full name similarity (review candidate only)"));
        }
        for (const r of recByName.get(item.normName) ?? []) {
          pushCand(toCandidateFromRec(r, "Full name similarity (review candidate only)"));
        }
        if (candidates.length > 0) {
          matchConfidence = "needs_review";
          matchSignal = "name_only_review_candidate";
          warnings.push(
            `Name "${item.displayName}" matches existing person — review before linking (never auto-merged on name alone).`,
          );
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

    if (statusInfo.statusNeedsReview) {
      warnings.push("Employment status cannot be verified from Workforce or LWD — marked for review.");
    }

    // Completeness computation (on missing fields)
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

    const hasAmbiguousMatch =
      matchConfidence === "needs_review" || duplicateWithRowNumbers.length > 0;

    let category: ImportPreviewRow["category"];
    if (errors.length > 0) {
      category = "invalid";
    } else if (hasAmbiguousMatch) {
      category = "possible_duplicate";
    } else if (hasAmbiguousDates) {
      category = "needs_information";
    } else if (matchedProfileId) {
      category = "matched_workforce";
    } else if (matchedRecordId) {
      category = "existing_historical";
    } else {
      category = "new_historical";
    }

    const excluded = Boolean(item.ov?.excluded);
    const readyToImport =
      !excluded &&
      errors.length === 0 &&
      category !== "possible_duplicate" &&
      !hasAmbiguousDates;

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

  const summary: ImportPreviewSummary = {
    totalRows: rows.length,
    matchedWorkforceCount: rows.filter((r) => r.category === "matched_workforce").length,
    newHistoricalCount: rows.filter((r) => r.category === "new_historical").length,
    existingHistoricalCount: rows.filter((r) => r.category === "existing_historical").length,
    missingWorkforceCount: missingWorkforceProfiles.length,
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
