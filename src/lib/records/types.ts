// Client-safe domain types, labels, completeness scoring, Drive URL validation,
// and Founder-safe redaction helpers for Employee Records (/records).

export const RECORD_EMPLOYMENT_STATUSES = ["active", "inactive"] as const;
export type RecordEmploymentStatus = (typeof RECORD_EMPLOYMENT_STATUSES)[number];

export const RECORD_EMPLOYMENT_STATUS_LABELS: Record<RecordEmploymentStatus, string> = {
  active: "Active",
  inactive: "Inactive",
};

export const RECORD_EMPLOYMENT_CATEGORIES = [
  "full_time",
  "intern",
  "freelancer",
  "trainer",
  "unknown",
] as const;
export type RecordEmploymentCategory = (typeof RECORD_EMPLOYMENT_CATEGORIES)[number];

export const RECORD_CATEGORY_LABELS: Record<RecordEmploymentCategory, string> = {
  full_time: "Full-Time",
  intern: "Intern",
  freelancer: "Freelancer",
  trainer: "Trainer",
  unknown: "Other / Unknown",
};

export const RECORD_WORK_TYPES = [
  "annotation",
  "engineering",
  "operations",
  "hr",
  "training",
  "other",
  "unknown",
] as const;
export type RecordWorkType = (typeof RECORD_WORK_TYPES)[number];

export const RECORD_WORK_TYPE_LABELS: Record<RecordWorkType, string> = {
  annotation: "Annotation",
  engineering: "Engineering",
  operations: "Operations",
  hr: "HR",
  training: "Training",
  other: "Other",
  unknown: "Other / Unknown",
};

export const RECORD_DOCUMENT_SOURCES = [
  "HISTORICAL_GOOGLE_DRIVE",
  "HRM_KYC",
  "BOTH",
  "NONE",
] as const;
export type RecordDocumentSource = (typeof RECORD_DOCUMENT_SOURCES)[number];

export const RECORD_DOCUMENT_SOURCE_LABELS: Record<RecordDocumentSource, string> = {
  HISTORICAL_GOOGLE_DRIVE: "Historical Google Drive",
  HRM_KYC: "HRM KYC",
  BOTH: "Drive + HRM KYC",
  NONE: "None",
};

export const RECORD_SOURCE_TYPES = [
  "historical_excel",
  "workforce_sync",
  "manual_entry",
] as const;
export type RecordSourceType = (typeof RECORD_SOURCE_TYPES)[number];

export const RECORD_SOURCE_TYPE_LABELS: Record<RecordSourceType, string> = {
  historical_excel: "Historical Excel",
  workforce_sync: "Workforce Sync",
  manual_entry: "Manual Entry",
};

export const RECORD_STATUS_SOURCES = [
  "workforce_verified",
  "relieving_record",
  "hr_historical",
  "hr_manual",
  "needs_review",
] as const;
export type RecordStatusSource = (typeof RECORD_STATUS_SOURCES)[number];

export const DRIVE_MATCH_STATUSES = [
  "unmatched",
  "proposed",
  "verified",
  "ambiguous",
] as const;
export type DriveMatchStatus = (typeof DRIVE_MATCH_STATUSES)[number];

export type KycSummarySnapshot = {
  status?: string | null;
  requiredCount?: number;
  uploadedCount?: number;
  verifiedCount?: number;
  pendingCount?: number;
  rejectedCount?: number;
  missingCount?: number;
  completedAt?: string | null;
};

export type SerializableScalar = string | number | boolean | null;
export type SerializableMap = Record<string, SerializableScalar | SerializableScalar[] | null>;

export type EmployeeRecordItem = {
  id: string;
  historicalRecordCode: string;
  profileId: string | null;
  tasEmployeeCode: string | null;
  firstName: string;
  lastName: string | null;
  displayName: string;
  personalEmail: string | null;
  organizationEmail: string | null;
  phoneNumber: string | null;
  address: string | null;
  joiningDate: string | null;
  lastWorkingDate: string | null;
  employmentStatus: RecordEmploymentStatus;
  statusNeedsReview: boolean;
  statusSource: RecordStatusSource;
  employmentCategory: RecordEmploymentCategory;
  workType: RecordWorkType;
  departmentId: string | null;
  departmentName: string | null;
  designation: string | null;
  reportingManagerId: string | null;
  reportingManagerName: string | null;
  legalEmployer: string | null;
  driveFolderUrl: string | null;
  driveFolderName: string | null;
  driveFolderId: string | null;
  driveMatchStatus: DriveMatchStatus;
  driveMatchedAt: string | null;
  hasDriveFolder: boolean;
  documentSource: RecordDocumentSource;
  documentAvailabilityStatus: "available" | "partial" | "missing";
  kycSummary: KycSummarySnapshot | null;
  sourceType: RecordSourceType;
  sourceImportBatchId: string | null;
  lastSyncedAt: string | null;
  lastUpdatedBy: string | null;
  recordCompleteness: number;
  missingFields: string[];
  matchConfidence: "exact" | "high" | "needs_review" | "unmatched";
  duplicateReviewStatus: "clear" | "needs_review" | "resolved";
  needsReview: boolean;
  reviewReasons: string[];
  notes: string | null;
  rawSourceSnapshot?: SerializableMap | null | undefined;
  createdAt: string;
  updatedAt: string;
};

export type EmploymentHistoryPeriod = {
  id: string;
  recordId: string;
  startDate: string | null;
  endDate: string | null;
  designation: string | null;
  employmentCategory: RecordEmploymentCategory;
  workType: RecordWorkType;
  departmentId: string | null;
  departmentName: string | null;
  reportingManagerName: string | null;
  legalEmployer: string | null;
  status: "active" | "completed" | "relieved" | "inactive" | "transferred";
  source: "historical_excel" | "workforce_sync" | "relieving_event" | "manual_entry";
  isCurrent: boolean;
  notes: string | null;
  createdAt: string;
};

export type RecordKycDocumentRef = {
  id: string;
  docType: string;
  status: string;
  fileName: string;
  reviewedAt: string | null;
};

export type RecordAuditEntry = {
  id: string;
  action: string;
  actorEmail: string | null;
  detail: SerializableMap;
  createdAt: string;
};

export type EmployeeRecordDetail = {
  record: EmployeeRecordItem;
  employmentHistory: EmploymentHistoryPeriod[];
  workforceProfile: {
    id: string;
    fullName: string;
    workEmail: string;
    employeeCode: string | null;
    accountStatus: string;
    employmentStatus: string;
    category: string;
    workType: string | null;
    designation: string | null;
    departmentName: string | null;
    joiningDate: string | null;
    lastWorkingDay: string | null;
  } | null;
  kycDocuments: RecordKycDocumentRef[];
  auditHistory: RecordAuditEntry[];
  canViewConfidential: boolean;
  canManage: boolean;
};

export type RecordsKpiStats = {
  totalRecords: number;
  activeCount: number;
  inactiveCount: number;
  missingInfoCount: number;
  linkedWorkforceCount: number;
  historicalDocsAvailableCount: number;
  needsReviewCount: number;
  lastSyncedAt: string | null;
};

export type RecordsListFilters = {
  search?: string | undefined;
  employmentStatus?: "all" | "active" | "inactive" | undefined;
  workType?: string | undefined;
  employmentCategory?: string | undefined;
  departmentId?: string | undefined;
  joiningDateFrom?: string | undefined;
  joiningDateTo?: string | undefined;
  lwdFrom?: string | undefined;
  lwdTo?: string | undefined;
  workforceLink?: "all" | "linked" | "historical_only" | undefined;
  documentFilter?: "all" | "has_drive" | "has_kyc" | "has_both" | "missing_docs" | undefined;
  missingFieldsOnly?: boolean | undefined;
  needsReviewOnly?: boolean | undefined;
  sortBy?:
    | "display_name"
    | "joining_date"
    | "last_working_date"
    | "updated_at"
    | "record_completeness"
    | undefined;
  sortDir?: "asc" | "desc" | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
};

export type ListEmployeeRecordsResponse = {
  schemaReady: boolean;
  records: EmployeeRecordItem[];
  total: number;
  page: number;
  pageSize: number;
  kpis: RecordsKpiStats;
  departments: { id: string; name: string }[];
  canManage: boolean;
  canViewConfidential: boolean;
  canExport: boolean;
};

export type SourceColumnMapping = {
  firstName: string | null;
  lastName: string | null;
  phoneNumber: string | null;
  joiningDate: string | null;
  lastWorkingDate: string | null;
  personalEmail: string | null;
  organizationEmail: string | null;
  address?: string | null;
  employmentCategory?: string | null;
  workType?: string | null;
  department?: string | null;
  designation?: string | null;
  driveFolderUrl?: string | null;
  tasEmployeeCode?: string | null;
  employmentStatus?: string | null;
};

export type ParsedDateResult = {
  iso: string | null;
  status: "empty" | "parsed" | "needs_review";
  rawValue: string;
  detectedFormat: string | null;
  suggestedIso?: string | null;
  alternateIso?: string | null;
  reason?: string;
};

export type ImportCandidateMatch = {
  source: "workforce" | "records";
  recordId: string | null;
  profileId: string | null;
  tasEmployeeCode: string | null;
  historicalRecordCode: string | null;
  displayName: string;
  organizationEmail: string | null;
  personalEmail: string | null;
  phoneNumber: string | null;
  joiningDate: string | null;
  employmentStatus: string | null;
  designation: string | null;
  departmentName: string | null;
  matchSignal: string;
};

export type ImportRowCategory =
  | "matched_workforce"
  | "new_historical"
  | "existing_historical"
  | "possible_duplicate"
  | "needs_information"
  | "invalid";

export type ImportPreviewRow = {
  rowNumber: number;
  raw: Record<string, string | number | null>;
  firstName: string;
  lastName: string | null;
  displayName: string;
  phoneNumber: string | null;
  personalEmail: string | null;
  organizationEmail: string | null;
  address: string | null;
  joiningDate: string | null;
  joiningDateStatus: "empty" | "parsed" | "needs_review";
  joiningDateRaw: string;
  joiningDateReason?: string | undefined;
  joiningDateAlternateIso?: string | null | undefined;
  lastWorkingDate: string | null;
  lastWorkingDateStatus: "empty" | "parsed" | "needs_review";
  lastWorkingDateRaw: string;
  lastWorkingDateReason?: string | undefined;
  lastWorkingDateAlternateIso?: string | null | undefined;
  employmentStatus: RecordEmploymentStatus;
  statusNeedsReview: boolean;
  statusSource: RecordStatusSource;
  employmentCategory: RecordEmploymentCategory;
  workType: RecordWorkType;
  departmentName: string | null;
  designation: string | null;
  driveFolderUrl: string | null;
  category: ImportRowCategory;
  matchConfidence: "exact" | "high" | "needs_review" | "unmatched";
  matchSignal: string | null;
  matchedProfileId: string | null;
  matchedRecordId: string | null;
  matchedTasCode: string | null;
  candidates: ImportCandidateMatch[];
  duplicateWithRowNumbers: number[];
  missingFields: string[];
  warnings: string[];
  errors: string[];
  excluded: boolean;
  readyToImport: boolean;
};

export type MissingWorkforceEntry = {
  profileId: string;
  tasEmployeeCode: string | null;
  fullName: string;
  workEmail: string;
  employmentStatus: string;
  category: string;
  workType: string | null;
  designation: string | null;
  departmentName: string | null;
  joiningDate: string | null;
};

export type ImportPreviewSummary = {
  totalRows: number;
  matchedWorkforceCount: number;
  newHistoricalCount: number;
  existingHistoricalCount: number;
  missingWorkforceCount: number;
  possibleDuplicatesCount: number;
  needsInformationCount: number;
  invalidCount: number;
  excludedCount: number;
  readyToImportCount: number;
  dateNeedsReviewCount: number;
  statusNeedsReviewCount: number;
};

export type DriveFolderMappingRow = {
  rowNumber: number;
  employeeName: string;
  employeeEmail: string | null;
  historicalRecordCode: string | null;
  driveFolderUrl: string;
};

export type DriveMappingPreviewRow = {
  rowNumber: number;
  employeeName: string;
  employeeEmail: string | null;
  historicalRecordCode: string | null;
  driveFolderUrl: string;
  folderId: string | null;
  urlValid: boolean;
  urlError: string | null;
  matchStatus: "exact" | "proposed" | "ambiguous" | "unmatched" | "invalid";
  matchedRecordId: string | null;
  matchedDisplayName: string | null;
  matchedHistoricalCode: string | null;
  candidates: {
    recordId: string;
    historicalRecordCode: string;
    displayName: string;
    organizationEmail: string | null;
    personalEmail: string | null;
  }[];
  confirmed: boolean;
};

/** Computes the combined Document Source classification without dropping either reference. */
export function computeDocumentSource(
  hasDriveFolder: boolean,
  hasKycDocuments: boolean,
): RecordDocumentSource {
  if (hasDriveFolder && hasKycDocuments) return "BOTH";
  if (hasDriveFolder) return "HISTORICAL_GOOGLE_DRIVE";
  if (hasKycDocuments) return "HRM_KYC";
  return "NONE";
}

/** Computes aggregate document availability summary (separate from HR KYC verification). */
export function computeDocumentAvailability(
  hasDriveFolder: boolean,
  kyc: KycSummarySnapshot | null | undefined,
): "available" | "partial" | "missing" {
  const verified = kyc?.verifiedCount ?? 0;
  const required = kyc?.requiredCount ?? 5;
  const uploaded = kyc?.uploadedCount ?? 0;
  if (hasDriveFolder || (verified > 0 && verified >= required)) return "available";
  if (uploaded > 0 || verified > 0 || (kyc?.pendingCount ?? 0) > 0) return "partial";
  return "missing";
}

export const MISSING_FIELD_LABELS: Record<string, string> = {
  last_name: "Last Name",
  personal_email: "Personal Email",
  organization_email: "Organization Email",
  phone_number: "Phone Number",
  address: "Address",
  joining_date: "Joining Date",
  employment_category: "Employment Category",
  work_type: "Work Type",
  department: "Department",
  designation: "Designation",
  documents: "Documents",
};

/** Evaluates master record completeness across 11 core archival & operational attributes. */
export function computeRecordCompleteness(input: {
  lastName?: string | null | undefined;
  personalEmail?: string | null | undefined;
  organizationEmail?: string | null | undefined;
  phoneNumber?: string | null | undefined;
  address?: string | null | undefined;
  joiningDate?: string | null | undefined;
  employmentCategory?: string | null | undefined;
  workType?: string | null | undefined;
  departmentId?: string | null | undefined;
  departmentName?: string | null | undefined;
  designation?: string | null | undefined;
  documentSource?: RecordDocumentSource | null | undefined;
}): { score: number; missingFields: string[] } {
  const missing: string[] = [];
  if (!input.lastName?.trim()) missing.push("last_name");
  if (!input.personalEmail?.trim()) missing.push("personal_email");
  if (!input.organizationEmail?.trim()) missing.push("organization_email");
  if (!input.phoneNumber?.trim()) missing.push("phone_number");
  if (!input.address?.trim()) missing.push("address");
  if (!input.joiningDate?.trim()) missing.push("joining_date");
  if (!input.employmentCategory || input.employmentCategory === "unknown") {
    missing.push("employment_category");
  }
  if (!input.workType || input.workType === "unknown") {
    missing.push("work_type");
  }
  if (!input.departmentId && !input.departmentName?.trim()) {
    missing.push("department");
  }
  if (!input.designation?.trim()) missing.push("designation");
  if (!input.documentSource || input.documentSource === "NONE") {
    missing.push("documents");
  }

  const total = 11;
  const score = Math.max(
    0,
    Math.min(100, Math.round(((total - missing.length) / total) * 100)),
  );
  return { score, missingFields: missing };
}

/**
 * Validates that a Google Drive link points to a Google Drive folder (not an
 * individual file or arbitrary domain) and extracts the folder ID cleanly.
 */
export function validateGoogleDriveFolderUrl(rawUrl: string): {
  valid: boolean;
  normalizedUrl: string | null;
  folderId: string | null;
  error: string | null;
} {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) {
    return { valid: true, normalizedUrl: null, folderId: null, error: null };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      normalizedUrl: null,
      folderId: null,
      error: "Enter a valid https://drive.google.com/drive/folders/... URL.",
    };
  }

  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "drive.google.com") {
    return {
      valid: false,
      normalizedUrl: null,
      folderId: null,
      error: "Only https://drive.google.com folder URLs are permitted.",
    };
  }

  if (/\/file\/d\//i.test(parsed.pathname)) {
    return {
      valid: false,
      normalizedUrl: null,
      folderId: null,
      error: "Store the main employee Google Drive folder URL, not an individual file link.",
    };
  }

  const folderMatch = parsed.pathname.match(/^\/drive(?:\/u\/\d+)?\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (!folderMatch) {
    return {
      valid: false,
      normalizedUrl: null,
      folderId: null,
      error: "URL must match https://drive.google.com/drive/folders/<folder-id>.",
    };
  }

  const folderId = folderMatch[1]!;
  return {
    valid: true,
    normalizedUrl: `https://drive.google.com/drive/folders/${folderId}`,
    folderId,
    error: null,
  };
}

/**
 * Strips confidential document links, personal email, phone number, residential
 * address, and raw Excel snapshots when the viewer lacks `records:documents:read`
 * (e.g., Founder read-only executive oversight).
 */
export function redactRecordForViewer<T extends Partial<EmployeeRecordItem>>(
  record: T,
  canViewConfidential: boolean,
): T {
  if (canViewConfidential) return record;
  return {
    ...record,
    driveFolderUrl: null,
    driveFolderId: null,
    driveFolderName: null,
    personalEmail: null,
    phoneNumber: null,
    address: null,
    rawSourceSnapshot: null,
  };
}
