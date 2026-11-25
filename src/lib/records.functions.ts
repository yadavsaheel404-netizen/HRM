// Server functions for Employee Records Master Register (/records).
// Strict RBAC enforcement:
// - HR & Super Admin: full view, create, update, bulk import, Drive link mapping, sync, full export.
// - Founder: strictly read-only, confidential fields (Drive URL, personal email, phone, address, raw KYC files) stripped server-side.
// - Admin, Manager, Lead, Employee: denied.
// - Protected Super Admin accounts: strictly excluded.

import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { loadActor, requirePermission, rethrowDbError } from "./actor.server";
import { writeAudit } from "./audit.server";
import { neutralizeFormula } from "./csv";
import {
  canExportEmployeeRecords,
  canManageEmployeeRecords,
  canViewRecordConfidentialFields,
} from "./permissions";
import { isMissingSchemaResourceError } from "./schema-compat.server";
import { todayIso } from "./timezone";
import { loadProtectedAccountIds } from "./work-type.server";
import {
  buildDisplayName,
  classifyEmploymentStatus,
  matchDriveFolderLinks,
  matchImportRowsAgainstDirectory,
  normalizeCategoryInput,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeWorkTypeInput,
  splitDisplayName,
  type DirectoryRecordEntry,
  type DirectoryWorkforceEntry,
} from "./records/matcher";
import {
  computeDocumentAvailability,
  computeDocumentSource,
  computeRecordCompleteness,
  redactRecordForViewer,
  validateGoogleDriveFolderUrl,
  type DriveFolderMappingRow,
  type DriveMappingPreviewRow,
  type EmployeeRecordDetail,
  type EmployeeRecordItem,
  type EmploymentHistoryPeriod,
  type ImportPreviewRow,
  type KycSummarySnapshot,
  type ListEmployeeRecordsResponse,
  type RecordEmploymentCategory,
  type RecordEmploymentStatus,
  type RecordsKpiStats,
  type RecordsListFilters,
  type RecordWorkType,
  type SerializableMap,
  type SourceColumnMapping,
} from "./records/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const looseDb = (client: unknown) => client as SupabaseClient<any>;

function mapRecordRow(row: any): EmployeeRecordItem {
  const driveUrl = row.drive_folder_url ? String(row.drive_folder_url) : null;
  const kycSummary = (row.kyc_summary ?? null) as KycSummarySnapshot | null;
  return {
    id: row.id,
    historicalRecordCode: row.historical_record_code,
    profileId: row.profile_id ?? null,
    tasEmployeeCode: row.tas_employee_code ?? null,
    firstName: row.first_name,
    lastName: row.last_name ?? null,
    displayName: row.display_name,
    personalEmail: row.personal_email ?? null,
    organizationEmail: row.organization_email ?? null,
    phoneNumber: row.phone_number ?? null,
    address: row.address ?? null,
    joiningDate: row.joining_date ?? null,
    lastWorkingDate: row.last_working_date ?? null,
    employmentStatus: row.employment_status ?? "inactive",
    statusNeedsReview: Boolean(row.status_needs_review),
    statusSource: row.status_source ?? "needs_review",
    employmentCategory: row.employment_category ?? "unknown",
    workType: row.work_type ?? "unknown",
    departmentId: row.department_id ?? null,
    departmentName: row.department_name ?? null,
    designation: row.designation ?? null,
    reportingManagerId: row.reporting_manager_id ?? null,
    reportingManagerName: row.reporting_manager_name ?? null,
    legalEmployer: row.legal_employer ?? null,
    driveFolderUrl: driveUrl,
    driveFolderName: row.drive_folder_name ?? null,
    driveFolderId: row.drive_folder_id ?? null,
    driveMatchStatus: row.drive_match_status ?? "unmatched",
    driveMatchedAt: row.drive_matched_at ?? null,
    hasDriveFolder: Boolean(driveUrl || row.has_drive_folder),
    documentSource: row.document_source ?? "NONE",
    documentAvailabilityStatus: row.document_availability_status ?? "missing",
    kycSummary,
    sourceType: row.source_type ?? "manual_entry",
    sourceImportBatchId: row.source_import_batch_id ?? null,
    lastSyncedAt: row.last_synced_at ?? null,
    lastUpdatedBy: row.last_updated_by ?? null,
    recordCompleteness: Number(row.record_completeness ?? 0),
    missingFields: Array.isArray(row.missing_fields) ? row.missing_fields : [],
    matchConfidence: row.match_confidence ?? "exact",
    duplicateReviewStatus: row.duplicate_review_status ?? "clear",
    needsReview: Boolean(row.needs_review),
    reviewReasons: Array.isArray(row.review_reasons) ? row.review_reasons : [],
    notes: row.notes ?? null,
    rawSourceSnapshot: (row.raw_source_snapshot ?? null) as SerializableMap | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHistoryRow(row: any): EmploymentHistoryPeriod {
  return {
    id: row.id,
    recordId: row.record_id,
    startDate: row.start_date ?? null,
    endDate: row.end_date ?? null,
    designation: row.designation ?? null,
    employmentCategory: row.employment_category ?? "unknown",
    workType: row.work_type ?? "unknown",
    departmentId: row.department_id ?? null,
    departmentName: row.department_name ?? null,
    reportingManagerName: row.reporting_manager_name ?? null,
    legalEmployer: row.legal_employer ?? null,
    status: row.status ?? "active",
    source: row.source ?? "manual_entry",
    isCurrent: Boolean(row.is_current),
    notes: row.notes ?? null,
    createdAt: row.created_at,
  };
}

async function assertRecordsReadAccess(supabase: any, userId: string) {
  await requirePermission(supabase, userId, "records:read:all");
  const actor = await loadActor(supabase, userId);
  const allowedRole =
    actor.roles.includes("super_admin") ||
    actor.roles.includes("hr") ||
    actor.roles.includes("founder");
  if (!allowedRole) {
    throw new Error("Forbidden: Employee Records access is limited to HR, Founder, and Super Admin.");
  }
  return actor;
}

async function assertRecordsManageAccess(supabase: any, userId: string) {
  await requirePermission(supabase, userId, "records:manage:all");
  const actor = await loadActor(supabase, userId);
  if (!canManageEmployeeRecords(actor.roles, actor.permissions)) {
    throw new Error("Forbidden: Only authorized HR or Super Admin can modify Employee Records.");
  }
  return actor;
}

function emptyListResponse(
  canManage: boolean,
  canViewConfidential: boolean,
  canExport: boolean,
): ListEmployeeRecordsResponse {
  return {
    schemaReady: false,
    records: [],
    total: 0,
    page: 1,
    pageSize: 25,
    kpis: {
      totalRecords: 0,
      activeCount: 0,
      inactiveCount: 0,
      missingInfoCount: 0,
      linkedWorkforceCount: 0,
      historicalDocsAvailableCount: 0,
      needsReviewCount: 0,
      lastSyncedAt: null,
    },
    departments: [],
    canManage,
    canViewConfidential,
    canExport,
  };
}

function applyRecordFiltersToQuery(query: any, filters: RecordsListFilters) {
  let q = query;

  const search = (filters.search ?? "").trim();
  if (search) {
    const safe = search.replace(/[%_,]/g, " ").trim();
    if (safe) {
      q = q.or(
        `display_name.ilike.%${safe}%,organization_email.ilike.%${safe}%,personal_email.ilike.%${safe}%,historical_record_code.ilike.%${safe}%,tas_employee_code.ilike.%${safe}%,designation.ilike.%${safe}%,phone_number.ilike.%${safe}%`,
      );
    }
  }

  if (filters.employmentStatus && filters.employmentStatus !== "all") {
    q = q.eq("employment_status", filters.employmentStatus);
  }
  if (filters.workType && filters.workType !== "all") {
    q = q.eq("work_type", filters.workType);
  }
  if (filters.employmentCategory && filters.employmentCategory !== "all") {
    q = q.eq("employment_category", filters.employmentCategory);
  }
  if (filters.departmentId && filters.departmentId !== "all") {
    q = q.eq("department_id", filters.departmentId);
  }
  if (filters.joiningDateFrom) {
    q = q.gte("joining_date", filters.joiningDateFrom);
  }
  if (filters.joiningDateTo) {
    q = q.lte("joining_date", filters.joiningDateTo);
  }
  if (filters.lwdFrom) {
    q = q.gte("last_working_date", filters.lwdFrom);
  }
  if (filters.lwdTo) {
    q = q.lte("last_working_date", filters.lwdTo);
  }
  if (filters.workforceLink === "linked") {
    q = q.not("profile_id", "is", null);
  } else if (filters.workforceLink === "historical_only") {
    q = q.is("profile_id", null);
  }
  if (filters.documentFilter === "has_drive") {
    q = q.in("document_source", ["HISTORICAL_GOOGLE_DRIVE", "BOTH"]);
  } else if (filters.documentFilter === "has_kyc") {
    q = q.in("document_source", ["HRM_KYC", "BOTH"]);
  } else if (filters.documentFilter === "has_both") {
    q = q.eq("document_source", "BOTH");
  } else if (filters.documentFilter === "missing_docs") {
    q = q.eq("document_source", "NONE");
  }
  if (filters.missingFieldsOnly) {
    q = q.lt("record_completeness", 100);
  }
  if (filters.needsReviewOnly) {
    q = q.or("needs_review.eq.true,status_needs_review.eq.true");
  }

  return q;
}

/**
 * Lists master Employee Records with server-side filtering, search, pagination,
 * live KPI aggregates, and strict Founder redaction.
 */
export const listEmployeeRecords = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input?: RecordsListFilters) => input ?? {})
  .handler(async ({ data, context }): Promise<ListEmployeeRecordsResponse> => {
    const actor = await assertRecordsReadAccess(context.supabase, context.userId);
    const canManage = canManageEmployeeRecords(actor.roles, actor.permissions);
    const canViewConfidential = canViewRecordConfidentialFields(actor.roles, actor.permissions);
    const canExport = canExportEmployeeRecords(actor.roles, actor.permissions);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);
    const protectedIds = await loadProtectedAccountIds(context.supabase);

    const page = Math.max(1, Number(data.page ?? 1));
    const pageSize = Math.min(100, Math.max(10, Number(data.pageSize ?? 25)));
    const fromIdx = (page - 1) * pageSize;
    const toIdx = fromIdx + pageSize - 1;

    const sortCol = data.sortBy ?? "updated_at";
    const sortAsc = data.sortDir === "asc";

    // Select safe columns only for confidential-restricted viewers (never even pull drive_folder_url for Founder)
    const selectCols = canViewConfidential
      ? "*"
      : "id, historical_record_code, profile_id, tas_employee_code, first_name, last_name, display_name, organization_email, joining_date, last_working_date, employment_status, status_needs_review, status_source, employment_category, work_type, department_id, department_name, designation, reporting_manager_id, reporting_manager_name, legal_employer, drive_match_status, drive_matched_at, document_source, document_availability_status, kyc_summary, source_type, source_import_batch_id, last_synced_at, last_updated_by, record_completeness, missing_fields, match_confidence, duplicate_review_status, needs_review, review_reasons, notes, created_at, updated_at";

    let listQuery = applyRecordFiltersToQuery(
      db.from("employee_records").select(selectCols, { count: "exact" }),
      data,
    )
      .order(sortCol, { ascending: sortAsc, nullsFirst: false })
      .range(fromIdx, toIdx);

    if (protectedIds.size > 0) {
      const excluded = `(${[...protectedIds].join(",")})`;
      listQuery = listQuery.or(`profile_id.is.null,profile_id.not.in.${excluded}`);
    }

    const [listRes, kpiRes, deptRes] = await Promise.all([
      listQuery,
      db
        .from("employee_records")
        .select(
          "id, profile_id, employment_status, record_completeness, document_source, needs_review, status_needs_review, last_synced_at",
        ),
      context.supabase.from("departments").select("id, name").order("name"),
    ]);

    if (listRes.error) {
      if (isMissingSchemaResourceError(listRes.error)) {
        return emptyListResponse(canManage, canViewConfidential, canExport);
      }
      rethrowDbError("Loading Employee Records failed", listRes.error);
    }

    const kpiRows = ((kpiRes.data ?? []) as any[]).filter(
      (r) => !r.profile_id || !protectedIds.has(r.profile_id),
    );

    let lastSyncedAt: string | null = null;
    for (const r of kpiRows) {
      if (r.last_synced_at && (!lastSyncedAt || r.last_synced_at > lastSyncedAt)) {
        lastSyncedAt = r.last_synced_at;
      }
    }

    const kpis: RecordsKpiStats = {
      totalRecords: kpiRows.length,
      activeCount: kpiRows.filter((r) => r.employment_status === "active").length,
      inactiveCount: kpiRows.filter((r) => r.employment_status === "inactive").length,
      missingInfoCount: kpiRows.filter((r) => Number(r.record_completeness ?? 0) < 100).length,
      linkedWorkforceCount: kpiRows.filter((r) => Boolean(r.profile_id)).length,
      historicalDocsAvailableCount: kpiRows.filter(
        (r) => r.document_source === "HISTORICAL_GOOGLE_DRIVE" || r.document_source === "BOTH",
      ).length,
      needsReviewCount: kpiRows.filter((r) => r.needs_review || r.status_needs_review).length,
      lastSyncedAt,
    };

    // If Founder is querying by personal email/phone in raw search, those columns are stripped anyway;
    // ensure every returned row passes redactRecordForViewer.
    const rows = ((listRes.data ?? []) as any[]).map((raw) => {
      const mapped = mapRecordRow(raw);
      if (kpiRows.length > 0 && !canViewConfidential) {
        // Compute hasDriveFolder reliably from document_source when drive_folder_url wasn't selected
        mapped.hasDriveFolder =
          mapped.documentSource === "HISTORICAL_GOOGLE_DRIVE" || mapped.documentSource === "BOTH";
      }
      return redactRecordForViewer(mapped, canViewConfidential);
    });

    return {
      schemaReady: true,
      records: rows,
      total: Number(listRes.count ?? rows.length),
      page,
      pageSize,
      kpis,
      departments: (deptRes.data ?? []).map((d) => ({ id: d.id, name: d.name })),
      canManage,
      canViewConfidential,
      canExport,
    };
  });

/**
 * Loads full detail for a single Employee Record: personal details, multi-tenure
 * employment history, linked Workforce status, Drive & HRM KYC summary, and audit history.
 */
export const getEmployeeRecordDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input: { recordId: string }) => {
    if (!input?.recordId) throw new Error("A record ID is required.");
    return { recordId: String(input.recordId) };
  })
  .handler(async ({ data, context }): Promise<EmployeeRecordDetail> => {
    const actor = await assertRecordsReadAccess(context.supabase, context.userId);
    const canManage = canManageEmployeeRecords(actor.roles, actor.permissions);
    const canViewConfidential = canViewRecordConfidentialFields(actor.roles, actor.permissions);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);
    const protectedIds = await loadProtectedAccountIds(context.supabase);

    const { data: recRow, error: recErr } = await db
      .from("employee_records")
      .select("*")
      .eq("id", data.recordId)
      .maybeSingle();

    if (recErr) rethrowDbError("Loading record details failed", recErr);
    if (!recRow) throw new Error("Employee record not found.");
    if (recRow.profile_id && protectedIds.has(recRow.profile_id)) {
      throw new Error("Employee record not found.");
    }

    const [histRes, auditRes, wfRes, docsRes] = await Promise.all([
      db
        .from("employee_employment_history")
        .select("*")
        .eq("record_id", data.recordId)
        .order("is_current", { ascending: false })
        .order("start_date", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false }),
      canManage
        ? supabaseAdmin
            .from("audit_logs")
            .select("id, action, actor_email, detail, created_at")
            .eq("entity_type", "employee_record")
            .eq("entity_id", data.recordId)
            .order("created_at", { ascending: false })
            .limit(40)
        : Promise.resolve({ data: [] as any[] }),
      recRow.profile_id
        ? db
            .from("profiles")
            .select(
              "id, full_name, work_email, employee_code, account_status, employment_status, category, work_type, designation, department_id, joining_date, last_working_day",
            )
            .eq("id", recRow.profile_id)
            .maybeSingle()
        : Promise.resolve({ data: null as any }),
      recRow.profile_id && canViewConfidential
        ? supabaseAdmin
            .from("documents")
            .select("id, doc_type, status, file_name, reviewed_at")
            .eq("user_id", recRow.profile_id)
            .order("doc_type")
        : Promise.resolve({ data: [] as any[] }),
    ]);

    let deptName: string | null = null;
    if (wfRes.data?.department_id) {
      const { data: d } = await supabaseAdmin
        .from("departments")
        .select("name")
        .eq("id", wfRes.data.department_id)
        .maybeSingle();
      deptName = d?.name ?? null;
    }

    const mappedRecord = redactRecordForViewer(mapRecordRow(recRow), canViewConfidential);
    if (!canViewConfidential) {
      mappedRecord.hasDriveFolder =
        mappedRecord.documentSource === "HISTORICAL_GOOGLE_DRIVE" ||
        mappedRecord.documentSource === "BOTH";
    }

    return {
      record: mappedRecord,
      employmentHistory: ((histRes.data ?? []) as any[]).map(mapHistoryRow),
      workforceProfile: wfRes.data
        ? {
            id: wfRes.data.id,
            fullName: wfRes.data.full_name,
            workEmail: wfRes.data.work_email,
            employeeCode: wfRes.data.employee_code ?? null,
            accountStatus: wfRes.data.account_status,
            employmentStatus: wfRes.data.employment_status,
            category: wfRes.data.category,
            workType: (wfRes.data as any).work_type ?? null,
            designation: wfRes.data.designation ?? null,
            departmentName: deptName,
            joiningDate: wfRes.data.joining_date ?? null,
            lastWorkingDay: (wfRes.data as any).last_working_day ?? null,
          }
        : null,
      kycDocuments: ((docsRes.data ?? []) as any[]).map((d) => ({
        id: d.id,
        docType: d.doc_type,
        status: d.status,
        fileName: d.file_name,
        reviewedAt: d.reviewed_at ?? null,
      })),
      auditHistory: ((auditRes.data ?? []) as any[]).map((a) => ({
        id: a.id,
        action: a.action,
        actorEmail: a.actor_email ?? null,
        detail: (a.detail ?? {}) as SerializableMap,
        createdAt: a.created_at,
      })),
      canViewConfidential,
      canManage,
    };
  });

/** Pre-creation duplicate check across Employee Records and non-protected Workforce profiles. */
export const checkRecordDuplicates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: {
    firstName?: string;
    lastName?: string | null;
    personalEmail?: string | null;
    organizationEmail?: string | null;
    phoneNumber?: string | null;
  }) => input ?? {})
  .handler(async ({ data, context }) => {
    await assertRecordsManageAccess(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);
    const protectedIds = await loadProtectedAccountIds(context.supabase);

    const orgEmail = normalizeEmail(data.organizationEmail);
    const persEmail = normalizeEmail(data.personalEmail);
    const normPhone = normalizePhone(data.phoneNumber);
    const normName = normalizeName(buildDisplayName(data.firstName ?? "", data.lastName));

    const [{ data: recs }, { data: profs }] = await Promise.all([
      db
        .from("employee_records")
        .select(
          "id, historical_record_code, profile_id, tas_employee_code, display_name, organization_email, personal_email, phone_number, employment_status",
        ),
      supabaseAdmin
        .from("profiles")
        .select("id, employee_code, full_name, work_email, personal_email, mobile, employment_status"),
    ]);

    const matches: {
      source: "records" | "workforce";
      id: string;
      code: string | null;
      displayName: string;
      organizationEmail: string | null;
      personalEmail: string | null;
      phoneNumber: string | null;
      employmentStatus: string;
      reason: string;
    }[] = [];

    for (const r of (recs ?? []) as any[]) {
      if (r.profile_id && protectedIds.has(r.profile_id)) continue;
      const reasons: string[] = [];
      if (orgEmail && normalizeEmail(r.organization_email) === orgEmail) reasons.push("Same Org Email");
      if (persEmail && normalizeEmail(r.personal_email) === persEmail) reasons.push("Same Personal Email");
      if (normPhone && normalizePhone(r.phone_number) === normPhone) reasons.push("Same Phone");
      if (normName && normalizeName(r.display_name) === normName) reasons.push("Same Full Name");
      if (reasons.length > 0) {
        matches.push({
          source: "records",
          id: r.id,
          code: r.historical_record_code,
          displayName: r.display_name,
          organizationEmail: r.organization_email,
          personalEmail: r.personal_email,
          phoneNumber: r.phone_number,
          employmentStatus: r.employment_status,
          reason: reasons.join(" + "),
        });
      }
    }

    for (const p of (profs ?? []) as any[]) {
      if (protectedIds.has(p.id)) continue;
      const reasons: string[] = [];
      if (orgEmail && normalizeEmail(p.work_email) === orgEmail) reasons.push("Same Workforce Email");
      if (persEmail && normalizeEmail(p.personal_email) === persEmail) reasons.push("Same Personal Email");
      if (normPhone && normalizePhone(p.mobile) === normPhone) reasons.push("Same Phone");
      if (normName && normalizeName(p.full_name) === normName) reasons.push("Same Full Name");
      if (reasons.length > 0) {
        matches.push({
          source: "workforce",
          id: p.id,
          code: p.employee_code,
          displayName: p.full_name,
          organizationEmail: p.work_email,
          personalEmail: p.personal_email,
          phoneNumber: p.mobile,
          employmentStatus: p.employment_status,
          reason: reasons.join(" + "),
        });
      }
    }

    return { matches };
  });

/** Creates a single manual historical employee record (NEVER creates Auth accounts or TAS IDs). */
export const createEmployeeRecord = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: {
    firstName: string;
    lastName?: string | null;
    personalEmail?: string | null;
    organizationEmail?: string | null;
    phoneNumber?: string | null;
    address?: string | null;
    joiningDate?: string | null;
    lastWorkingDate?: string | null;
    employmentCategory?: string;
    workType?: string;
    departmentId?: string | null;
    departmentName?: string | null;
    designation?: string | null;
    employmentStatus?: string;
    driveFolderUrl?: string | null;
    notes?: string | null;
  }) => {
    const firstName = String(input?.firstName ?? "").trim();
    if (!firstName) throw new Error("First Name is required.");
    return { ...input, firstName };
  })
  .handler(async ({ data, context }) => {
    await assertRecordsManageAccess(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);

    const driveCheck = validateGoogleDriveFolderUrl(data.driveFolderUrl ?? "");
    if (!driveCheck.valid) {
      throw new Error(driveCheck.error ?? "Invalid Google Drive folder URL.");
    }

    const lastName = data.lastName?.trim() || null;
    const displayName = buildDisplayName(data.firstName, lastName);
    const category = normalizeCategoryInput(data.employmentCategory);
    const workType = normalizeWorkTypeInput(data.workType);
    const statusInfo = classifyEmploymentStatus({
      explicitOverrideStatus: data.employmentStatus ?? null,
      parsedLastWorkingDate: data.lastWorkingDate || null,
      todayIso: todayIso(),
    });

    let resolvedDeptName = data.departmentName?.trim() || null;
    if (data.departmentId && !resolvedDeptName) {
      const { data: d } = await supabaseAdmin
        .from("departments")
        .select("name")
        .eq("id", data.departmentId)
        .maybeSingle();
      resolvedDeptName = d?.name ?? null;
    }

    const hasDrive = Boolean(driveCheck.normalizedUrl);
    const docSource = computeDocumentSource(hasDrive, false);
    const docAvail = computeDocumentAvailability(hasDrive, null);
    const comp = computeRecordCompleteness({
      lastName,
      personalEmail: data.personalEmail,
      organizationEmail: data.organizationEmail,
      phoneNumber: data.phoneNumber,
      address: data.address,
      joiningDate: data.joiningDate,
      employmentCategory: category,
      workType,
      departmentId: data.departmentId,
      departmentName: resolvedDeptName,
      designation: data.designation,
      documentSource: docSource,
    });

    const { data: inserted, error } = await db
      .from("employee_records")
      .insert({
        first_name: data.firstName,
        last_name: lastName,
        display_name: displayName,
        personal_email: normalizeEmail(data.personalEmail),
        organization_email: normalizeEmail(data.organizationEmail),
        phone_number: data.phoneNumber?.trim() || null,
        address: data.address?.trim() || null,
        joining_date: data.joiningDate || null,
        last_working_date: data.lastWorkingDate || null,
        employment_status: statusInfo.employmentStatus,
        status_needs_review: statusInfo.statusNeedsReview,
        status_source: statusInfo.statusSource,
        employment_category: category,
        work_type: workType,
        department_id: data.departmentId || null,
        department_name: resolvedDeptName,
        designation: data.designation?.trim() || null,
        drive_folder_url: driveCheck.normalizedUrl,
        drive_folder_id: driveCheck.folderId,
        drive_match_status: hasDrive ? "verified" : "unmatched",
        drive_matched_by: hasDrive ? context.userId : null,
        drive_matched_at: hasDrive ? new Date().toISOString() : null,
        document_source: docSource,
        document_availability_status: docAvail,
        source_type: "manual_entry",
        last_updated_by: context.userId,
        record_completeness: comp.score,
        missing_fields: comp.missingFields,
        needs_review: statusInfo.statusNeedsReview,
        review_reasons: statusInfo.statusNeedsReview
          ? ["Employment status requires manual verification."]
          : [],
        notes: data.notes?.trim() || null,
      })
      .select("id, historical_record_code")
      .single();

    if (error) rethrowDbError("Creating Employee Record failed", error);

    await db.from("employee_employment_history").insert({
      record_id: inserted.id,
      start_date: data.joiningDate || null,
      end_date: data.lastWorkingDate || null,
      designation: data.designation?.trim() || null,
      employment_category: category,
      work_type: workType,
      department_id: data.departmentId || null,
      department_name: resolvedDeptName,
      status: statusInfo.employmentStatus === "active" ? "active" : "inactive",
      source: "manual_entry",
      is_current: true,
      created_by: context.userId,
    });

    await writeAudit(supabaseAdmin, {
      actorId: context.userId,
      action: "employee_record.created",
      entityType: "employee_record",
      entityId: inserted.id,
      detail: {
        historicalRecordCode: inserted.historical_record_code,
        displayName,
        employmentStatus: statusInfo.employmentStatus,
        sourceType: "manual_entry",
      },
    });

    return { ok: true, id: inserted.id, historicalRecordCode: inserted.historical_record_code };
  });

/** Updates an existing Employee Record (HR & Super Admin only). */
export const updateEmployeeRecord = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: {
    recordId: string;
    firstName?: string;
    lastName?: string | null;
    personalEmail?: string | null;
    organizationEmail?: string | null;
    phoneNumber?: string | null;
    address?: string | null;
    joiningDate?: string | null;
    lastWorkingDate?: string | null;
    employmentStatus?: RecordEmploymentStatus;
    employmentCategory?: RecordEmploymentCategory;
    workType?: RecordWorkType;
    departmentId?: string | null;
    departmentName?: string | null;
    designation?: string | null;
    reportingManagerName?: string | null;
    legalEmployer?: string | null;
    driveFolderUrl?: string | null;
    notes?: string | null;
    resolveReview?: boolean;
  }) => {
    if (!input?.recordId) throw new Error("A record ID is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    await assertRecordsManageAccess(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);

    const { data: existing, error: fetchErr } = await db
      .from("employee_records")
      .select("*")
      .eq("id", data.recordId)
      .maybeSingle();
    if (fetchErr) rethrowDbError("Loading record for edit failed", fetchErr);
    if (!existing) throw new Error("Employee record not found.");

    const protectedIds = await loadProtectedAccountIds(context.supabase);
    if (existing.profile_id && protectedIds.has(existing.profile_id)) {
      throw new Error("Employee record not found.");
    }

    let nextDriveUrl = existing.drive_folder_url as string | null;
    let nextDriveId = existing.drive_folder_id as string | null;
    let nextDriveStatus = existing.drive_match_status as string;
    let nextDriveMatchedBy = existing.drive_matched_by as string | null;
    let nextDriveMatchedAt = existing.drive_matched_at as string | null;

    if (data.driveFolderUrl !== undefined) {
      const check = validateGoogleDriveFolderUrl(data.driveFolderUrl ?? "");
      if (!check.valid) throw new Error(check.error ?? "Invalid Google Drive folder URL.");
      nextDriveUrl = check.normalizedUrl;
      nextDriveId = check.folderId;
      nextDriveStatus = check.normalizedUrl ? "verified" : "unmatched";
      nextDriveMatchedBy = check.normalizedUrl ? context.userId : null;
      nextDriveMatchedAt = check.normalizedUrl ? new Date().toISOString() : null;
    }

    const firstName = (data.firstName !== undefined ? data.firstName : existing.first_name).trim();
    const lastName =
      data.lastName !== undefined ? (data.lastName?.trim() || null) : existing.last_name;
    const displayName = buildDisplayName(firstName, lastName);
    const personalEmail =
      data.personalEmail !== undefined
        ? normalizeEmail(data.personalEmail)
        : existing.personal_email;
    const organizationEmail =
      data.organizationEmail !== undefined
        ? normalizeEmail(data.organizationEmail)
        : existing.organization_email;
    const phoneNumber =
      data.phoneNumber !== undefined
        ? (data.phoneNumber?.trim() || null)
        : existing.phone_number;
    const address =
      data.address !== undefined ? (data.address?.trim() || null) : existing.address;
    const joiningDate =
      data.joiningDate !== undefined ? (data.joiningDate || null) : existing.joining_date;
    const lastWorkingDate =
      data.lastWorkingDate !== undefined ? (data.lastWorkingDate || null) : existing.last_working_date;
    const category =
      data.employmentCategory !== undefined
        ? normalizeCategoryInput(data.employmentCategory)
        : existing.employment_category;
    const workType =
      data.workType !== undefined ? normalizeWorkTypeInput(data.workType) : existing.work_type;
    const designation =
      data.designation !== undefined ? (data.designation?.trim() || null) : existing.designation;
    const departmentId =
      data.departmentId !== undefined ? (data.departmentId || null) : existing.department_id;
    let departmentName =
      data.departmentName !== undefined
        ? (data.departmentName?.trim() || null)
        : existing.department_name;

    if (departmentId && data.departmentId !== existing.department_id) {
      const { data: d } = await supabaseAdmin
        .from("departments")
        .select("name")
        .eq("id", departmentId)
        .maybeSingle();
      departmentName = d?.name ?? departmentName;
    }

    const empStatus = data.employmentStatus ?? existing.employment_status;
    const statusChanged = data.employmentStatus !== undefined;

    const kycSummary = (existing.kyc_summary ?? null) as KycSummarySnapshot | null;
    const hasKyc =
      Boolean(kycSummary && ((kycSummary.uploadedCount ?? 0) > 0 || (kycSummary.verifiedCount ?? 0) > 0));
    const hasDrive = Boolean(nextDriveUrl);
    const docSource = computeDocumentSource(hasDrive, hasKyc);
    const docAvail = computeDocumentAvailability(hasDrive, kycSummary);

    const comp = computeRecordCompleteness({
      lastName,
      personalEmail,
      organizationEmail,
      phoneNumber,
      address,
      joiningDate,
      employmentCategory: category,
      workType,
      departmentId,
      departmentName,
      designation,
      documentSource: docSource,
    });

    const patch: Record<string, unknown> = {
      first_name: firstName,
      last_name: lastName,
      display_name: displayName,
      personal_email: personalEmail,
      organization_email: organizationEmail,
      phone_number: phoneNumber,
      address,
      joining_date: joiningDate,
      last_working_date: lastWorkingDate,
      employment_status: empStatus,
      status_needs_review: statusChanged ? false : Boolean(existing.status_needs_review),
      status_source: statusChanged ? "hr_manual" : existing.status_source,
      employment_category: category,
      work_type: workType,
      department_id: departmentId,
      department_name: departmentName,
      designation,
      reporting_manager_name:
        data.reportingManagerName !== undefined
          ? (data.reportingManagerName?.trim() || null)
          : existing.reporting_manager_name,
      legal_employer:
        data.legalEmployer !== undefined
          ? (data.legalEmployer?.trim() || null)
          : existing.legal_employer,
      drive_folder_url: nextDriveUrl,
      drive_folder_id: nextDriveId,
      drive_match_status: nextDriveStatus,
      drive_matched_by: nextDriveMatchedBy,
      drive_matched_at: nextDriveMatchedAt,
      document_source: docSource,
      document_availability_status: docAvail,
      record_completeness: comp.score,
      missing_fields: comp.missingFields,
      notes: data.notes !== undefined ? (data.notes?.trim() || null) : existing.notes,
      last_updated_by: context.userId,
    };

    if (data.resolveReview) {
      patch["needs_review"] = false;
      patch["status_needs_review"] = false;
      patch["duplicate_review_status"] = "resolved";
      patch["review_reasons"] = [];
    }

    const { error: updErr } = await db
      .from("employee_records")
      .update(patch)
      .eq("id", data.recordId);
    if (updErr) rethrowDbError("Updating Employee Record failed", updErr);

    await writeAudit(supabaseAdmin, {
      actorId: context.userId,
      action: "employee_record.updated",
      entityType: "employee_record",
      entityId: data.recordId,
      detail: {
        updatedKeys: Object.keys(data).filter((k) => k !== "recordId"),
      },
    });

    return { ok: true };
  });

/** Adds a separate tenure/role period to `employee_employment_history` without overwriting prior periods. */
export const addEmploymentHistoryPeriod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: {
    recordId: string;
    startDate?: string | null;
    endDate?: string | null;
    designation?: string | null;
    employmentCategory?: string;
    workType?: string;
    departmentName?: string | null;
    reportingManagerName?: string | null;
    legalEmployer?: string | null;
    status?: "active" | "completed" | "relieved" | "inactive" | "transferred";
    isCurrent?: boolean;
    notes?: string | null;
  }) => {
    if (!input?.recordId) throw new Error("Record ID is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    await assertRecordsManageAccess(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);

    if (data.isCurrent) {
      await db
        .from("employee_employment_history")
        .update({ is_current: false })
        .eq("record_id", data.recordId)
        .eq("is_current", true);
    }

    const { error } = await db.from("employee_employment_history").insert({
      record_id: data.recordId,
      start_date: data.startDate || null,
      end_date: data.endDate || null,
      designation: data.designation?.trim() || null,
      employment_category: normalizeCategoryInput(data.employmentCategory),
      work_type: normalizeWorkTypeInput(data.workType),
      department_name: data.departmentName?.trim() || null,
      reporting_manager_name: data.reportingManagerName?.trim() || null,
      legal_employer: data.legalEmployer?.trim() || null,
      status: data.status ?? "completed",
      source: "manual_entry",
      is_current: Boolean(data.isCurrent),
      notes: data.notes?.trim() || null,
      created_by: context.userId,
    });
    if (error) rethrowDbError("Adding employment history period failed", error);

    await writeAudit(supabaseAdmin, {
      actorId: context.userId,
      action: "employee_record.history_added",
      entityType: "employee_record",
      entityId: data.recordId,
      detail: {
        designation: data.designation ?? null,
        startDate: data.startDate ?? null,
        endDate: data.endDate ?? null,
        status: data.status ?? "completed",
      },
    });

    return { ok: true };
  });

/** Returns active/non-protected Workforce profiles for linking an archival record. */
export const searchWorkforceForRecordLink = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertRecordsManageAccess(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const protectedIds = await loadProtectedAccountIds(context.supabase);

    const { data: profiles, error } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, work_email, employee_code, designation, employment_status")
      .order("full_name");
    if (error) rethrowDbError("Loading Workforce directory failed", error);

    return {
      profiles: (profiles ?? [])
        .filter((p) => !protectedIds.has(p.id))
        .map((p) => ({
          id: p.id,
          fullName: p.full_name,
          workEmail: p.work_email,
          employeeCode: p.employee_code ?? null,
          designation: p.designation ?? null,
          employmentStatus: p.employment_status,
        })),
    };
  });

/** Links a historical record to a verified Workforce profile without losing archival fields. */
export const linkRecordToWorkforce = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { recordId: string; profileId: string }) => {
    if (!input?.recordId || !input?.profileId) {
      throw new Error("Both record ID and Workforce profile ID are required.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    await assertRecordsManageAccess(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);
    const protectedIds = await loadProtectedAccountIds(context.supabase);
    if (protectedIds.has(data.profileId)) {
      throw new Error("Protected accounts cannot be linked into Employee Records.");
    }

    const { data: conflict } = await db
      .from("employee_records")
      .select("id, historical_record_code, display_name")
      .eq("profile_id", data.profileId)
      .neq("id", data.recordId)
      .maybeSingle();

    if (conflict) {
      throw new Error(
        `That Workforce employee is already linked to ${conflict.historical_record_code} (${conflict.display_name}).`,
      );
    }

    const { error: updErr } = await db
      .from("employee_records")
      .update({
        profile_id: data.profileId,
        match_confidence: "exact",
        duplicate_review_status: "resolved",
        needs_review: false,
        last_updated_by: context.userId,
      })
      .eq("id", data.recordId);
    if (updErr) rethrowDbError("Linking Workforce profile failed", updErr);

    const { syncProfileToEmployeeRecordSafe } = await import("./records/sync.server");
    await syncProfileToEmployeeRecordSafe(data.profileId, context.userId);

    await writeAudit(supabaseAdmin, {
      actorId: context.userId,
      action: "employee_record.linked_workforce",
      entityType: "employee_record",
      entityId: data.recordId,
      detail: { profileId: data.profileId },
    });

    return { ok: true };
  });

/** Manual HR/Super Admin trigger to synchronize all non-protected Workforce members into Records. */
export const syncWorkforceRecords = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertRecordsManageAccess(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { syncAllWorkforceToRecords } = await import("./records/sync.server");
    const result = await syncAllWorkforceToRecords(context.userId);

    await writeAudit(supabaseAdmin, {
      actorId: context.userId,
      action: "employee_record.workforce_synced",
      entityType: "employee_record",
      detail: result,
    });

    return result;
  });

async function loadMatchingDirectory(supabase: any): Promise<{
  workforce: DirectoryWorkforceEntry[];
  records: DirectoryRecordEntry[];
  today: string;
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = looseDb(supabaseAdmin);
  const protectedIds = await loadProtectedAccountIds(supabase);

  const [{ data: profiles }, { data: depts }, { data: relieved }, recRes] = await Promise.all([
    db
      .from("profiles")
      .select(
        "id, employee_code, full_name, work_email, personal_email, mobile, employment_status, category, work_type, designation, department_id, joining_date, last_working_day",
      ),
    supabaseAdmin.from("departments").select("id, name"),
    db.from("relieving_cases").select("user_id, status").eq("status", "relieved"),
    db
      .from("employee_records")
      .select(
        "id, historical_record_code, profile_id, tas_employee_code, display_name, organization_email, personal_email, phone_number, joining_date, employment_status, designation, department_name",
      ),
  ]);

  const deptMap = new Map((depts ?? []).map((d) => [d.id, d.name]));
  const relievedSet = new Set(((relieved ?? []) as { user_id: string }[]).map((r) => r.user_id));

  const workforce: DirectoryWorkforceEntry[] = ((profiles ?? []) as any[])
    .filter((p) => !protectedIds.has(p.id))
    .map((p) => ({
      profileId: p.id,
      employeeCode: p.employee_code ?? null,
      fullName: p.full_name,
      workEmail: p.work_email,
      personalEmail: p.personal_email ?? null,
      mobile: p.mobile ?? null,
      employmentStatus: p.employment_status,
      category: p.category,
      workType: p.work_type ?? null,
      designation: p.designation ?? null,
      departmentName: p.department_id ? (deptMap.get(p.department_id) ?? null) : null,
      joiningDate: p.joining_date ?? null,
      lastWorkingDay: p.last_working_day ?? null,
      hasRelievedCase: relievedSet.has(p.id),
    }));

  const records: DirectoryRecordEntry[] =
    recRes.error && isMissingSchemaResourceError(recRes.error)
      ? []
      : ((recRes.data ?? []) as any[])
          .filter((r) => !r.profile_id || !protectedIds.has(r.profile_id))
          .map((r) => ({
            id: r.id,
            historicalRecordCode: r.historical_record_code,
            profileId: r.profile_id ?? null,
            tasEmployeeCode: r.tas_employee_code ?? null,
            displayName: r.display_name,
            organizationEmail: r.organization_email ?? null,
            personalEmail: r.personal_email ?? null,
            phoneNumber: r.phone_number ?? null,
            joiningDate: r.joining_date ?? null,
            employmentStatus: r.employment_status,
            designation: r.designation ?? null,
            departmentName: r.department_name ?? null,
          }));

  return { workforce, records, today: todayIso() };
}

/**
 * Dry-run preview of up to 1,000 uploaded Excel/CSV rows against live Workforce
 * and existing Records. Performs ZERO database writes.
 */
export const previewEmployeeRecordsImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: {
    rows: Record<string, string | number | null>[];
    mapping: SourceColumnMapping;
    date1904?: boolean;
    numericPreference?: "auto" | "mdy" | "dmy";
    overridesByRow?: Record<number, Partial<ImportPreviewRow>>;
  }) => {
    if (!Array.isArray(input?.rows) || input.rows.length === 0) {
      throw new Error("No rows were found in the uploaded file.");
    }
    if (input.rows.length > 1000) {
      throw new Error("Upload at most 1,000 rows per batch.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    await assertRecordsManageAccess(context.supabase, context.userId);
    const directory = await loadMatchingDirectory(context.supabase);

    return matchImportRowsAgainstDirectory(data.rows, {
      workforce: directory.workforce,
      records: directory.records,
      todayIso: directory.today,
    }, {
      mapping: data.mapping,
      dateOptions: {
        date1904: Boolean(data.date1904),
        numericPreference: data.numericPreference ?? "auto",
      },
      ...(data.overridesByRow ? { overridesByRow: data.overridesByRow } : {}),
    });
  });

/**
 * Executes an approved, idempotent bulk import batch of Employee Records.
 * Never creates Auth users, never sends setup emails, never assigns TAS IDs
 * to archival-only rows, and never overwrites verified Workforce data.
 */
export const commitEmployeeRecordsImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: {
    batchKey: string;
    fileName: string;
    fileType: string;
    rows: ImportPreviewRow[];
    syncMissingWorkforce: boolean;
    confirmed: boolean;
  }) => {
    if (!input?.confirmed) {
      throw new Error("Explicit HR confirmation is required before writing import rows.");
    }
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(String(input.batchKey ?? ""))) {
      throw new Error("A valid batch key is required.");
    }
    if (!Array.isArray(input.rows)) {
      throw new Error("Invalid import payload.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    await assertRecordsManageAccess(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);

    // Idempotent replay check
    const { data: existingBatch, error: batchCheckErr } = await db
      .from("employee_record_import_batches")
      .select("*")
      .eq("batch_key", data.batchKey)
      .maybeSingle();

    if (batchCheckErr) {
      if (isMissingSchemaResourceError(batchCheckErr)) {
        throw new Error(
          "Employee Records schema is not deployed yet. Apply migration 20261125120000_employee_records_master_register.sql first.",
        );
      }
      rethrowDbError("Checking import batch failed", batchCheckErr);
    }

    if (existingBatch) {
      return {
        replayed: true,
        batchId: existingBatch.id,
        batchKey: existingBatch.batch_key,
        matchedWorkforceCount: existingBatch.matched_workforce_count,
        newHistoricalCount: existingBatch.new_historical_count,
        updatedCount: existingBatch.updated_count,
        skippedCount: existingBatch.skipped_count,
        needsReviewCount: existingBatch.needs_review_count,
        errorCount: existingBatch.error_count,
        workforceSyncedCount: Number(existingBatch.summary?.workforceSyncedCount ?? 0),
      };
    }

    const { data: deptRows } = await supabaseAdmin.from("departments").select("id, name");
    const deptByName = new Map(
      (deptRows ?? []).map((d) => [d.name.trim().toLowerCase(), { id: d.id, name: d.name }]),
    );

    const { data: batchRow, error: batchCreateErr } = await db
      .from("employee_record_import_batches")
      .insert({
        batch_key: data.batchKey,
        import_kind: "employee_records",
        file_name: data.fileName.slice(0, 200),
        file_type: data.fileType.slice(0, 40),
        total_rows: data.rows.length,
        status: "processing",
        imported_by: context.userId,
      })
      .select("id")
      .single();

    if (batchCreateErr) rethrowDbError("Creating import batch failed", batchCreateErr);
    const batchId = batchRow.id as string;

    let matchedWorkforceCount = 0;
    let newHistoricalCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let needsReviewCount = 0;
    let errorCount = 0;

    const auditRows: any[] = [];
    const { syncProfileToEmployeeRecordSafe } = await import("./records/sync.server");

    for (const row of data.rows) {
      if (row.excluded) {
        skippedCount += 1;
        auditRows.push({
          batch_id: batchId,
          row_number: row.rowNumber,
          raw_payload: row.raw,
          normalized_payload: { displayName: row.displayName, status: row.employmentStatus },
          outcome: "excluded",
          match_signal: row.matchSignal,
          warnings: row.warnings,
          errors: row.errors,
        });
        continue;
      }

      if (!row.readyToImport || row.errors.length > 0) {
        const isReview =
          row.category === "possible_duplicate" || row.category === "needs_information";
        if (isReview) needsReviewCount += 1;
        else errorCount += 1;
        auditRows.push({
          batch_id: batchId,
          row_number: row.rowNumber,
          raw_payload: row.raw,
          normalized_payload: { displayName: row.displayName },
          outcome: isReview ? "needs_review" : "error",
          match_signal: row.matchSignal,
          warnings: row.warnings,
          errors: row.errors,
        });
        continue;
      }

      try {
        const { firstName, lastName } = splitDisplayName(row.displayName);
        const driveCheck = validateGoogleDriveFolderUrl(row.driveFolderUrl ?? "");
        const hasDrive = Boolean(driveCheck.valid && driveCheck.normalizedUrl);
        const deptHit = row.departmentName
          ? deptByName.get(row.departmentName.trim().toLowerCase())
          : undefined;

        if (row.matchedProfileId) {
          // Outcome A: Already in Workforce -> sync Workforce canonical first, then enrich blanks only
          const syncedRecId = await syncProfileToEmployeeRecordSafe(
            row.matchedProfileId,
            context.userId,
          );
          if (syncedRecId) {
            const { data: curRec } = await db
              .from("employee_records")
              .select("*")
              .eq("id", syncedRecId)
              .single();

            if (curRec) {
              const mergedLastName = curRec.last_name || lastName || row.lastName;
              const mergedPersonalEmail = curRec.personal_email || row.personalEmail;
              const mergedPhone = curRec.phone_number || row.phoneNumber;
              const mergedAddress = curRec.address || row.address;
              const mergedJoining = curRec.joining_date || row.joiningDate;
              const mergedLwd = curRec.last_working_date || row.lastWorkingDate;
              const mergedDriveUrl =
                curRec.drive_folder_url || (hasDrive ? driveCheck.normalizedUrl : null);
              const mergedDriveId =
                curRec.drive_folder_id || (hasDrive ? driveCheck.folderId : null);
              const hasKyc =
                curRec.document_source === "HRM_KYC" || curRec.document_source === "BOTH";
              const docSource = computeDocumentSource(Boolean(mergedDriveUrl), hasKyc);
              const docAvail = computeDocumentAvailability(
                Boolean(mergedDriveUrl),
                curRec.kyc_summary,
              );

              const comp = computeRecordCompleteness({
                lastName: mergedLastName,
                personalEmail: mergedPersonalEmail,
                organizationEmail: curRec.organization_email,
                phoneNumber: mergedPhone,
                address: mergedAddress,
                joiningDate: mergedJoining,
                employmentCategory: curRec.employment_category,
                workType: curRec.work_type,
                departmentId: curRec.department_id,
                departmentName: curRec.department_name,
                designation: curRec.designation,
                documentSource: docSource,
              });

              await db
                .from("employee_records")
                .update({
                  last_name: mergedLastName,
                  personal_email: mergedPersonalEmail,
                  phone_number: mergedPhone,
                  address: mergedAddress,
                  joining_date: mergedJoining,
                  last_working_date: mergedLwd,
                  drive_folder_url: mergedDriveUrl,
                  drive_folder_id: mergedDriveId,
                  drive_match_status: mergedDriveUrl ? "verified" : curRec.drive_match_status,
                  document_source: docSource,
                  document_availability_status: docAvail,
                  record_completeness: comp.score,
                  missing_fields: comp.missingFields,
                  source_import_batch_id: batchId,
                  raw_source_snapshot: row.raw,
                  last_updated_by: context.userId,
                })
                .eq("id", syncedRecId);
            }
          }

          matchedWorkforceCount += 1;
          auditRows.push({
            batch_id: batchId,
            row_number: row.rowNumber,
            raw_payload: row.raw,
            normalized_payload: { displayName: row.displayName, matchedProfileId: row.matchedProfileId },
            outcome: "linked_workforce",
            record_id: syncedRecId,
            matched_profile_id: row.matchedProfileId,
            match_signal: row.matchSignal,
            warnings: row.warnings,
            errors: [],
          });
        } else if (row.matchedRecordId) {
          // Existing historical record update
          const { data: curRec } = await db
            .from("employee_records")
            .select("*")
            .eq("id", row.matchedRecordId)
            .single();

          if (curRec) {
            const docSource = computeDocumentSource(
              Boolean(curRec.drive_folder_url || (hasDrive ? driveCheck.normalizedUrl : null)),
              curRec.document_source === "HRM_KYC" || curRec.document_source === "BOTH",
            );
            const comp = computeRecordCompleteness({
              lastName: curRec.last_name || lastName || row.lastName,
              personalEmail: curRec.personal_email || row.personalEmail,
              organizationEmail: curRec.organization_email || row.organizationEmail,
              phoneNumber: curRec.phone_number || row.phoneNumber,
              address: curRec.address || row.address,
              joiningDate: curRec.joining_date || row.joiningDate,
              employmentCategory:
                curRec.employment_category !== "unknown"
                  ? curRec.employment_category
                  : row.employmentCategory,
              workType: curRec.work_type !== "unknown" ? curRec.work_type : row.workType,
              departmentId: curRec.department_id || deptHit?.id || null,
              departmentName: curRec.department_name || deptHit?.name || row.departmentName,
              designation: curRec.designation || row.designation,
              documentSource: docSource,
            });

            await db
              .from("employee_records")
              .update({
                last_name: curRec.last_name || lastName || row.lastName,
                personal_email: curRec.personal_email || row.personalEmail,
                organization_email: curRec.organization_email || row.organizationEmail,
                phone_number: curRec.phone_number || row.phoneNumber,
                address: curRec.address || row.address,
                joining_date: curRec.joining_date || row.joiningDate,
                last_working_date: curRec.last_working_date || row.lastWorkingDate,
                employment_category:
                  curRec.employment_category !== "unknown"
                    ? curRec.employment_category
                    : row.employmentCategory,
                work_type: curRec.work_type !== "unknown" ? curRec.work_type : row.workType,
                department_id: curRec.department_id || deptHit?.id || null,
                department_name: curRec.department_name || deptHit?.name || row.departmentName,
                designation: curRec.designation || row.designation,
                drive_folder_url:
                  curRec.drive_folder_url || (hasDrive ? driveCheck.normalizedUrl : null),
                drive_folder_id: curRec.drive_folder_id || (hasDrive ? driveCheck.folderId : null),
                document_source: docSource,
                record_completeness: comp.score,
                missing_fields: comp.missingFields,
                source_import_batch_id: batchId,
                raw_source_snapshot: row.raw,
                last_updated_by: context.userId,
              })
              .eq("id", row.matchedRecordId);
          }
          updatedCount += 1;
          auditRows.push({
            batch_id: batchId,
            row_number: row.rowNumber,
            raw_payload: row.raw,
            normalized_payload: { displayName: row.displayName },
            outcome: "updated_historical",
            record_id: row.matchedRecordId,
            match_signal: row.matchSignal,
            warnings: row.warnings,
            errors: [],
          });
        } else {
          // Outcome B: Historical-only record creation (NO Auth account, NO TAS employee ID, NO emails sent)
          const docSource = computeDocumentSource(hasDrive, false);
          const docAvail = computeDocumentAvailability(hasDrive, null);
          const comp = computeRecordCompleteness({
            lastName: row.lastName ?? lastName,
            personalEmail: row.personalEmail,
            organizationEmail: row.organizationEmail,
            phoneNumber: row.phoneNumber,
            address: row.address,
            joiningDate: row.joiningDate,
            employmentCategory: row.employmentCategory,
            workType: row.workType,
            departmentId: deptHit?.id ?? null,
            departmentName: deptHit?.name ?? row.departmentName,
            designation: row.designation,
            documentSource: docSource,
          });

          const { data: created, error: insErr } = await db
            .from("employee_records")
            .insert({
              first_name: row.firstName || firstName,
              last_name: row.lastName ?? lastName,
              display_name: row.displayName,
              personal_email: row.personalEmail,
              organization_email: row.organizationEmail,
              phone_number: row.phoneNumber,
              address: row.address,
              joining_date: row.joiningDate,
              last_working_date: row.lastWorkingDate,
              employment_status: row.employmentStatus,
              status_needs_review: row.statusNeedsReview,
              status_source: row.statusSource,
              employment_category: row.employmentCategory,
              work_type: row.workType,
              department_id: deptHit?.id ?? null,
              department_name: deptHit?.name ?? row.departmentName,
              designation: row.designation,
              drive_folder_url: hasDrive ? driveCheck.normalizedUrl : null,
              drive_folder_id: hasDrive ? driveCheck.folderId : null,
              drive_match_status: hasDrive ? "verified" : "unmatched",
              drive_matched_by: hasDrive ? context.userId : null,
              drive_matched_at: hasDrive ? new Date().toISOString() : null,
              document_source: docSource,
              document_availability_status: docAvail,
              source_type: "historical_excel",
              source_import_batch_id: batchId,
              last_updated_by: context.userId,
              record_completeness: comp.score,
              missing_fields: comp.missingFields,
              match_confidence: "unmatched",
              duplicate_review_status: "clear",
              needs_review: row.statusNeedsReview,
              review_reasons: row.warnings,
              raw_source_snapshot: row.raw,
            })
            .select("id")
            .single();

          if (insErr) throw insErr;

          await db.from("employee_employment_history").insert({
            record_id: created.id,
            start_date: row.joiningDate,
            end_date: row.lastWorkingDate,
            designation: row.designation,
            employment_category: row.employmentCategory,
            work_type: row.workType,
            department_id: deptHit?.id ?? null,
            department_name: deptHit?.name ?? row.departmentName,
            status: row.employmentStatus === "active" ? "active" : "completed",
            source: "historical_excel",
            is_current: true,
            created_by: context.userId,
          });

          newHistoricalCount += 1;
          auditRows.push({
            batch_id: batchId,
            row_number: row.rowNumber,
            raw_payload: row.raw,
            normalized_payload: { displayName: row.displayName, status: row.employmentStatus },
            outcome: "created_historical",
            record_id: created.id,
            match_signal: "new_historical",
            warnings: row.warnings,
            errors: [],
          });
        }
      } catch (err) {
        errorCount += 1;
        auditRows.push({
          batch_id: batchId,
          row_number: row.rowNumber,
          raw_payload: row.raw,
          normalized_payload: { displayName: row.displayName },
          outcome: "error",
          match_signal: row.matchSignal,
          warnings: row.warnings,
          errors: [err instanceof Error ? err.message : "Failed to save row."],
        });
      }
    }

    if (auditRows.length > 0) {
      // Insert in chunks of 200 to handle 500–5,000 rows cleanly
      for (let i = 0; i < auditRows.length; i += 200) {
        await db.from("employee_record_import_rows").insert(auditRows.slice(i, i + 200));
      }
    }

    // Outcome C: Sync Workforce-only employees missing from Excel
    let workforceSyncedCount = 0;
    if (data.syncMissingWorkforce) {
      const { syncAllWorkforceToRecords } = await import("./records/sync.server");
      const syncRes = await syncAllWorkforceToRecords(context.userId);
      workforceSyncedCount = syncRes.synced;
    }

    await db
      .from("employee_record_import_batches")
      .update({
        matched_workforce_count: matchedWorkforceCount,
        new_historical_count: newHistoricalCount,
        updated_count: updatedCount,
        skipped_count: skippedCount,
        needs_review_count: needsReviewCount,
        error_count: errorCount,
        status: errorCount > 0 ? "partial" : "completed",
        summary: { workforceSyncedCount },
        completed_at: new Date().toISOString(),
      })
      .eq("id", batchId);

    await writeAudit(supabaseAdmin, {
      actorId: context.userId,
      action: "employee_record.bulk_imported",
      entityType: "employee_record_import_batch",
      entityId: batchId,
      detail: {
        batchKey: data.batchKey,
        fileName: data.fileName,
        totalRows: data.rows.length,
        matchedWorkforceCount,
        newHistoricalCount,
        updatedCount,
        skippedCount,
        needsReviewCount,
        errorCount,
        workforceSyncedCount,
      },
    });

    return {
      replayed: false,
      batchId,
      batchKey: data.batchKey,
      matchedWorkforceCount,
      newHistoricalCount,
      updatedCount,
      skippedCount,
      needsReviewCount,
      errorCount,
      workforceSyncedCount,
    };
  });

/** Dry-run preview for mapping Google Drive employee folders (`TAS <> EMP <> RECORD`). */
export const previewDriveFolderImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { rows: DriveFolderMappingRow[] }) => {
    if (!Array.isArray(input?.rows) || input.rows.length === 0) {
      throw new Error("Provide at least one Google Drive folder mapping row.");
    }
    if (input.rows.length > 1000) {
      throw new Error("Process at most 1,000 folder rows per batch.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    await assertRecordsManageAccess(context.supabase, context.userId);
    const directory = await loadMatchingDirectory(context.supabase);
    return {
      rows: matchDriveFolderLinks(data.rows, directory.records),
    };
  });

/** Commits HR-confirmed Google Drive folder links onto Employee Records (does not touch KYC verification). */
export const commitDriveFolderLinks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { batchKey: string; fileName: string; rows: DriveMappingPreviewRow[] }) => {
    if (!Array.isArray(input?.rows)) throw new Error("Mapping rows are required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    await assertRecordsManageAccess(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);

    let linkedCount = 0;
    let skippedCount = 0;

    for (const row of data.rows) {
      if (!row.confirmed || !row.matchedRecordId || !row.urlValid) {
        skippedCount += 1;
        continue;
      }
      const check = validateGoogleDriveFolderUrl(row.driveFolderUrl);
      if (!check.valid || !check.normalizedUrl || !check.folderId) {
        skippedCount += 1;
        continue;
      }

      const { data: rec } = await db
        .from("employee_records")
        .select("*")
        .eq("id", row.matchedRecordId)
        .maybeSingle();

      if (!rec) {
        skippedCount += 1;
        continue;
      }

      const hasKyc =
        rec.document_source === "HRM_KYC" || rec.document_source === "BOTH";
      const docSource = computeDocumentSource(true, hasKyc);
      const docAvail = computeDocumentAvailability(true, rec.kyc_summary);
      const comp = computeRecordCompleteness({
        lastName: rec.last_name,
        personalEmail: rec.personal_email,
        organizationEmail: rec.organization_email,
        phoneNumber: rec.phone_number,
        address: rec.address,
        joiningDate: rec.joining_date,
        employmentCategory: rec.employment_category,
        workType: rec.work_type,
        departmentId: rec.department_id,
        departmentName: rec.department_name,
        designation: rec.designation,
        documentSource: docSource,
      });

      await db
        .from("employee_records")
        .update({
          drive_folder_url: check.normalizedUrl,
          drive_folder_id: check.folderId,
          drive_folder_name: row.employeeName,
          drive_match_status: "verified",
          drive_matched_by: context.userId,
          drive_matched_at: new Date().toISOString(),
          document_source: docSource,
          document_availability_status: docAvail,
          record_completeness: comp.score,
          missing_fields: comp.missingFields,
          last_updated_by: context.userId,
        })
        .eq("id", row.matchedRecordId);

      linkedCount += 1;
    }

    await writeAudit(supabaseAdmin, {
      actorId: context.userId,
      action: "employee_record.drive_folders_linked",
      entityType: "employee_record",
      detail: {
        batchKey: data.batchKey,
        fileName: data.fileName,
        linkedCount,
        skippedCount,
      },
    });

    return { ok: true, linkedCount, skippedCount };
  });

/**
 * Authorized CSV/XLSX export of Employee Records with automatic permission redaction
 * (Founder never receives Drive URLs, personal emails, phone numbers, or home addresses)
 * and spreadsheet formula neutralization on every cell.
 */
export const exportEmployeeRecords = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { filters?: RecordsListFilters; fullReport?: boolean }) => input ?? {})
  .handler(async ({ data, context }) => {
    const actor = await assertRecordsReadAccess(context.supabase, context.userId);
    if (!canExportEmployeeRecords(actor.roles, actor.permissions)) {
      throw new Error("Forbidden: You do not have permission to export Employee Records.");
    }
    const canViewConfidential = canViewRecordConfidentialFields(actor.roles, actor.permissions);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);
    const protectedIds = await loadProtectedAccountIds(context.supabase);

    let query = db
      .from("employee_records")
      .select(
        canViewConfidential
          ? "*"
          : "id, historical_record_code, profile_id, tas_employee_code, first_name, last_name, display_name, organization_email, joining_date, last_working_date, employment_status, employment_category, work_type, department_name, designation, reporting_manager_name, document_source, document_availability_status, source_type, record_completeness, last_synced_at, updated_at",
      )
      .order("display_name", { ascending: true });

    if (!data.fullReport && data.filters) {
      query = applyRecordFiltersToQuery(query, data.filters);
    }

    const { data: rawRows, error } = await query;
    if (error) {
      if (isMissingSchemaResourceError(error)) {
        throw new Error("Employee Records table is not deployed yet.");
      }
      rethrowDbError("Exporting Employee Records failed", error);
    }

    const cleanRows = ((rawRows ?? []) as any[])
      .filter((r) => !r.profile_id || !protectedIds.has(r.profile_id))
      .map((r) => {
        const mapped = redactRecordForViewer(mapRecordRow(r), canViewConfidential);
        const base: Record<string, string | number | null> = {
          "Record ID": mapped.historicalRecordCode,
          "TAS Employee ID": mapped.tasEmployeeCode ?? "",
          "Display Name": String(neutralizeFormula(mapped.displayName)),
          "First Name": String(neutralizeFormula(mapped.firstName)),
          "Last Name": String(neutralizeFormula(mapped.lastName ?? "")),
          "Organization Email": String(neutralizeFormula(mapped.organizationEmail ?? "")),
          "Joining Date": mapped.joiningDate ?? "",
          "Last Working Date": mapped.lastWorkingDate ?? "",
          "Employment Status": mapped.employmentStatus.toUpperCase(),
          "Employment Category": mapped.employmentCategory,
          "Work Type": mapped.workType,
          Department: String(neutralizeFormula(mapped.departmentName ?? "")),
          Designation: String(neutralizeFormula(mapped.designation ?? "")),
          "Workforce Linked": mapped.profileId ? "Yes" : "No",
          "Document Source": mapped.documentSource,
          "Documents Availability": mapped.documentAvailabilityStatus,
          "Source Type": mapped.sourceType,
          "Completeness %": mapped.recordCompleteness,
          "Last Synced At": mapped.lastSyncedAt ?? "",
          "Last Updated At": mapped.updatedAt,
        };

        if (canViewConfidential) {
          base["Personal Email"] = String(neutralizeFormula(mapped.personalEmail ?? ""));
          base["Phone Number"] = String(neutralizeFormula(mapped.phoneNumber ?? ""));
          base["Address"] = String(neutralizeFormula(mapped.address ?? ""));
          base["Google Drive Folder URL"] = mapped.driveFolderUrl ?? "";
        }

        return base;
      });

    await writeAudit(supabaseAdmin, {
      actorId: context.userId,
      action: "employee_record.exported",
      entityType: "employee_record",
      detail: {
        rowCount: cleanRows.length,
        fullReport: Boolean(data.fullReport),
        confidentialIncluded: canViewConfidential,
      },
    });

    return { rows: cleanRows, confidentialIncluded: canViewConfidential };
  });
