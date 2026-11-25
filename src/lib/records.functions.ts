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
  filterAndSortUnifiedRecords,
  matchDriveFolderLinks,
  matchImportRowsAgainstDirectory,
  mergeWorkforceAndRecords,
  normalizeCategoryInput,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeWorkTypeInput,
  splitDisplayName,
  type DirectoryRecordEntry,
  type DirectoryWorkforceEntry,
  type UnifiedWorkforceProfileInput,
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
  type ImportCommitRowResult,
  type ImportCommitSummary,
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

async function loadUnifiedDataset(supabase: any): Promise<{
  schemaReady: boolean;
  unified: EmployeeRecordItem[];
  departments: { id: string; name: string }[];
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { loadKycSummaryMap } = await import("./records/sync.server");
  const db = looseDb(supabaseAdmin);
  const protectedIds = await loadProtectedAccountIds(supabase);

  const [profilesRes, deptsRes, relievedRes, recsRes] = await Promise.all([
    db
      .from("profiles")
      .select(
        "id, employee_code, full_name, work_email, personal_email, mobile, current_address, permanent_address, joining_date, last_working_day, employment_status, category, work_type, department_id, designation, reporting_lead_id, created_at",
      )
      .order("full_name"),
    supabaseAdmin.from("departments").select("id, name").order("name"),
    db
      .from("relieving_cases")
      .select("user_id, status, relieving_effective_date, last_working_day, legal_employer")
      .eq("status", "relieved"),
    db.from("employee_records").select("*").order("updated_at", { ascending: false }),
  ]);

  if (profilesRes.error) rethrowDbError("Loading Workforce directory failed", profilesRes.error);

  const schemaReady = !(recsRes.error && isMissingSchemaResourceError(recsRes.error));
  if (recsRes.error && !isMissingSchemaResourceError(recsRes.error)) {
    rethrowDbError("Loading Employee Records failed", recsRes.error);
  }

  const deptList = (deptsRes.data ?? []).map((d) => ({ id: d.id, name: d.name }));
  const deptMap = new Map(deptList.map((d) => [d.id, d.name]));
  const nameById = new Map<string, string>();
  for (const p of (profilesRes.data ?? []) as any[]) {
    if (p.id && p.full_name) nameById.set(p.id, p.full_name);
  }

  const relievedMap = new Map<
    string,
    { relievingEffectiveDate: string | null; legalEmployer: string | null }
  >();
  if (!relievedRes.error) {
    for (const r of (relievedRes.data ?? []) as any[]) {
      if (r.user_id && !relievedMap.has(r.user_id)) {
        relievedMap.set(r.user_id, {
          relievingEffectiveDate: r.relieving_effective_date ?? r.last_working_day ?? null,
          legalEmployer: r.legal_employer ?? null,
        });
      }
    }
  }

  const nonProtectedProfiles = ((profilesRes.data ?? []) as any[]).filter(
    (p) => !protectedIds.has(p.id),
  );
  const kycSummaries = await loadKycSummaryMap(nonProtectedProfiles.map((p) => p.id));

  const workforceInputs: UnifiedWorkforceProfileInput[] = nonProtectedProfiles.map((p) => {
    const rel = relievedMap.get(p.id);
    return {
      id: p.id,
      employeeCode: p.employee_code ?? null,
      fullName: p.full_name ?? p.work_email ?? "Employee",
      workEmail: p.work_email ?? "",
      personalEmail: p.personal_email ?? null,
      mobile: p.mobile ?? null,
      address: p.current_address || p.permanent_address || null,
      joiningDate: p.joining_date ?? null,
      lastWorkingDay: p.last_working_day ?? null,
      employmentStatus: p.employment_status ?? "active",
      category: p.category ?? "full_time",
      workType: p.work_type ?? null,
      departmentId: p.department_id ?? null,
      departmentName: p.department_id ? (deptMap.get(p.department_id) ?? null) : null,
      designation: p.designation ?? null,
      reportingLeadId: p.reporting_lead_id ?? null,
      reportingLeadName: p.reporting_lead_id ? (nameById.get(p.reporting_lead_id) ?? null) : null,
      hasRelievedCase: Boolean(rel),
      relievingEffectiveDate: rel?.relievingEffectiveDate ?? null,
      legalEmployer: rel?.legalEmployer ?? null,
      createdAt: p.created_at,
    };
  });

  const existingRecords: EmployeeRecordItem[] = schemaReady
    ? ((recsRes.data ?? []) as any[])
        .filter((r) => !r.profile_id || !protectedIds.has(r.profile_id))
        .map(mapRecordRow)
    : [];

  const unified = mergeWorkforceAndRecords({
    workforce: workforceInputs,
    records: existingRecords,
    kycSummaries,
    todayIso: todayIso(),
  });

  return { schemaReady, unified, departments: deptList };
}

/**
 * Lists unified Workforce + Historical Employee Records with server-side filtering,
 * search, pagination, live KPI aggregates, and strict Founder redaction.
 */
export const listEmployeeRecords = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input?: RecordsListFilters) => input ?? {})
  .handler(async ({ data, context }): Promise<ListEmployeeRecordsResponse> => {
    const actor = await assertRecordsReadAccess(context.supabase, context.userId);
    const canManage = canManageEmployeeRecords(actor.roles, actor.permissions);
    const canViewConfidential = canViewRecordConfidentialFields(actor.roles, actor.permissions);
    const canExport = canExportEmployeeRecords(actor.roles, actor.permissions);

    const { schemaReady, unified, departments } = await loadUnifiedDataset(context.supabase);

    let lastSyncedAt: string | null = null;
    for (const r of unified) {
      if (r.lastSyncedAt && (!lastSyncedAt || r.lastSyncedAt > lastSyncedAt)) {
        lastSyncedAt = r.lastSyncedAt;
      }
    }

    const kpis: RecordsKpiStats = {
      totalRecords: unified.length,
      activeCount: unified.filter((r) => r.employmentStatus === "active").length,
      inactiveCount: unified.filter((r) => r.employmentStatus === "inactive").length,
      missingInfoCount: unified.filter((r) => r.recordCompleteness < 100).length,
      linkedWorkforceCount: unified.filter((r) => Boolean(r.profileId)).length,
      historicalDocsAvailableCount: unified.filter(
        (r) => r.documentSource === "HISTORICAL_GOOGLE_DRIVE" || r.documentSource === "BOTH",
      ).length,
      needsReviewCount: unified.filter((r) => r.needsReview || r.statusNeedsReview).length,
      lastSyncedAt,
    };

    // For confidential-restricted viewers (Founder), filter on redacted records so search cannot probe hidden PII
    const viewerSafePool = unified.map((r) => redactRecordForViewer(r, canViewConfidential));
    const { pageItems, total, page, pageSize } = filterAndSortUnifiedRecords(viewerSafePool, data);

    return {
      schemaReady,
      records: pageItems,
      total,
      page,
      pageSize,
      kpis,
      departments,
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

    let recRow: any = null;
    if (data.recordId.startsWith("wf:")) {
      const wfProfileId = data.recordId.slice(3);
      if (protectedIds.has(wfProfileId)) throw new Error("Employee record not found.");
      // Check if an employee_records row was synced in the meantime
      const { data: linked } = await db
        .from("employee_records")
        .select("*")
        .eq("profile_id", wfProfileId)
        .maybeSingle();
      if (linked) {
        recRow = linked;
      } else {
        const { unified } = await loadUnifiedDataset(context.supabase);
        const match = unified.find((u) => u.profileId === wfProfileId);
        if (!match) throw new Error("Employee record not found.");
        const [wfRes, docsRes] = await Promise.all([
          db
            .from("profiles")
            .select(
              "id, full_name, work_email, employee_code, account_status, employment_status, category, work_type, designation, department_id, joining_date, last_working_day",
            )
            .eq("id", wfProfileId)
            .maybeSingle(),
          canViewConfidential
            ? supabaseAdmin
                .from("documents")
                .select("id, doc_type, status, file_name, reviewed_at")
                .eq("user_id", wfProfileId)
                .order("doc_type")
            : Promise.resolve({ data: [] as any[] }),
        ]);
        return {
          record: redactRecordForViewer(match, canViewConfidential),
          employmentHistory: [
            {
              id: `wf-hist:${wfProfileId}`,
              recordId: match.id,
              startDate: match.joiningDate,
              endDate: match.lastWorkingDate,
              designation: match.designation,
              employmentCategory: match.employmentCategory,
              workType: match.workType,
              departmentId: match.departmentId,
              departmentName: match.departmentName,
              reportingManagerName: match.reportingManagerName,
              legalEmployer: match.legalEmployer,
              status: match.employmentStatus === "active" ? "active" : "inactive",
              source: "workforce_sync",
              isCurrent: true,
              notes: null,
              createdAt: match.createdAt,
            },
          ],
          workforceProfile: wfRes.data
            ? {
                id: wfRes.data.id,
                fullName: wfRes.data.full_name,
                workEmail: wfRes.data.work_email,
                employeeCode: wfRes.data.employee_code ?? null,
                accountStatus: wfRes.data.account_status,
                employmentStatus: wfRes.data.employment_status,
                category: wfRes.data.category,
                workType: wfRes.data.work_type ?? null,
                designation: wfRes.data.designation ?? null,
                departmentName: match.departmentName,
                joiningDate: wfRes.data.joining_date ?? null,
                lastWorkingDay: wfRes.data.last_working_day ?? null,
              }
            : null,
          kycDocuments: ((docsRes.data ?? []) as any[]).map((d) => ({
            id: d.id,
            docType: d.doc_type,
            status: d.status,
            fileName: d.file_name,
            reviewedAt: d.reviewed_at ?? null,
          })),
          auditHistory: [],
          canViewConfidential,
          canManage,
        };
      }
    } else {
      const { data: loadedRow, error: recErr } = await db
        .from("employee_records")
        .select("*")
        .eq("id", data.recordId)
        .maybeSingle();

      if (recErr) rethrowDbError("Loading record details failed", recErr);
      if (!loadedRow) throw new Error("Employee record not found.");
      if (loadedRow.profile_id && protectedIds.has(loadedRow.profile_id)) {
        throw new Error("Employee record not found.");
      }
      recRow = loadedRow;
    }

    const actualRecordId = recRow.id as string;

    const [histRes, auditRes, wfRes, docsRes] = await Promise.all([
      db
        .from("employee_employment_history")
        .select("*")
        .eq("record_id", actualRecordId)
        .order("is_current", { ascending: false })
        .order("start_date", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false }),
      canManage
        ? supabaseAdmin
            .from("audit_logs")
            .select("id, action, actor_email, detail, created_at")
            .eq("entity_type", "employee_record")
            .eq("entity_id", actualRecordId)
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

    const normalizedOrgEmail = normalizeEmail(data.organizationEmail);
    if (normalizedOrgEmail) {
      const [{ data: wfHit }, { data: recHit }] = await Promise.all([
        db
          .from("profiles")
          .select("id, full_name, employee_code")
          .ilike("work_email", normalizedOrgEmail)
          .limit(1)
          .maybeSingle(),
        db
          .from("employee_records")
          .select("id, display_name, historical_record_code")
          .ilike("organization_email", normalizedOrgEmail)
          .limit(1)
          .maybeSingle(),
      ]);
      if (wfHit || recHit) {
        throw new Error(
          `An employee with organization email ${normalizedOrgEmail} already exists in Workforce or Employee Records.`,
        );
      }
    }

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

    // If editing an unsynced Workforce row ("wf:<profileId>"), materialize its 1-to-1 linked record first
    let targetRecordId = data.recordId;
    if (targetRecordId.startsWith("wf:")) {
      const wfProfileId = targetRecordId.slice(3);
      const { syncProfileToEmployeeRecordSafe } = await import("./records/sync.server");
      const syncedId = await syncProfileToEmployeeRecordSafe(wfProfileId, context.userId);
      if (!syncedId) throw new Error("Failed to link Workforce profile into Employee Records.");
      targetRecordId = syncedId;
    }

    const { data: existing, error: fetchErr } = await db
      .from("employee_records")
      .select("*")
      .eq("id", targetRecordId)
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
      .eq("id", targetRecordId);
    if (updErr) rethrowDbError("Updating Employee Record failed", updErr);

    await writeAudit(supabaseAdmin, {
      actorId: context.userId,
      action: "employee_record.updated",
      entityType: "employee_record",
      entityId: targetRecordId,
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

    let targetRecordId = data.recordId;
    if (targetRecordId.startsWith("wf:")) {
      const wfProfileId = targetRecordId.slice(3);
      const { syncProfileToEmployeeRecordSafe } = await import("./records/sync.server");
      const syncedId = await syncProfileToEmployeeRecordSafe(wfProfileId, context.userId);
      if (!syncedId) throw new Error("Failed to link Workforce profile into Employee Records.");
      targetRecordId = syncedId;
    }

    if (data.isCurrent) {
      await db
        .from("employee_employment_history")
        .update({ is_current: false })
        .eq("record_id", targetRecordId)
        .eq("is_current", true);
    }

    const { error } = await db.from("employee_employment_history").insert({
      record_id: targetRecordId,
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
      entityId: targetRecordId,
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
        totalRows: existingBatch.total_rows ?? data.rows.length,
        importedCount: Number(existingBatch.summary?.importedCount ?? existingBatch.new_historical_count ?? 0),
        duplicateCount: Number(existingBatch.summary?.duplicateCount ?? existingBatch.skipped_count ?? 0),
        invalidCount: Number(existingBatch.summary?.invalidCount ?? existingBatch.needs_review_count ?? 0),
        failedCount: Number(existingBatch.summary?.failedCount ?? existingBatch.error_count ?? 0),
        rowResults: Array.isArray(existingBatch.summary?.rowResults)
          ? (existingBatch.summary.rowResults as ImportCommitRowResult[])
          : [],
      } satisfies ImportCommitSummary;
    }

    const [{ data: deptRows }, directory] = await Promise.all([
      supabaseAdmin.from("departments").select("id, name"),
      loadMatchingDirectory(context.supabase),
    ]);
    const deptByName = new Map(
      (deptRows ?? []).map((d) => [d.name.trim().toLowerCase(), { id: d.id, name: d.name }]),
    );

    // Live Workforce + Employee Records duplicate guard sets (never overwrite existing employees)
    const dbTasCodes = new Set<string>();
    const dbOrgEmails = new Set<string>();
    const dbPersonalEmails = new Map<string, { normName: string; tasCode: string | null }[]>();
    const dbPhoneNames = new Set<string>();

    for (const w of directory.workforce) {
      if (w.employeeCode) dbTasCodes.add(w.employeeCode.trim().toUpperCase());
      const workEm = normalizeEmail(w.workEmail);
      if (workEm) dbOrgEmails.add(workEm);
      const persEm = normalizeEmail(w.personalEmail);
      const wName = normalizeName(w.fullName);
      if (persEm) {
        const list = dbPersonalEmails.get(persEm) ?? [];
        list.push({ normName: wName, tasCode: w.employeeCode ? w.employeeCode.trim().toUpperCase() : null });
        dbPersonalEmails.set(persEm, list);
      }
      const wPhone = normalizePhone(w.mobile);
      if (wPhone && wName) dbPhoneNames.add(`${wPhone}|${wName}`);
    }

    for (const r of directory.records) {
      if (r.tasEmployeeCode) dbTasCodes.add(r.tasEmployeeCode.trim().toUpperCase());
      dbTasCodes.add(r.historicalRecordCode.trim().toUpperCase());
      const orgEm = normalizeEmail(r.organizationEmail);
      if (orgEm) dbOrgEmails.add(orgEm);
      const persEm = normalizeEmail(r.personalEmail);
      const rName = normalizeName(r.displayName);
      if (persEm) {
        const list = dbPersonalEmails.get(persEm) ?? [];
        list.push({ normName: rName, tasCode: r.tasEmployeeCode ? r.tasEmployeeCode.trim().toUpperCase() : null });
        dbPersonalEmails.set(persEm, list);
      }
      const rPhone = normalizePhone(r.phoneNumber);
      if (rPhone && rName) dbPhoneNames.add(`${rPhone}|${rName}`);
    }

    const seenBatchTasCodes = new Set<string>();
    const seenBatchOrgEmails = new Set<string>();
    const seenBatchPersonalEmails = new Map<string, { rowNumber: number; normName: string; tasCode: string | null }>();
    const seenBatchPhoneNames = new Set<string>();

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

    let importedCount = 0;
    let duplicateCount = 0;
    let invalidCount = 0;
    let failedCount = 0;

    const auditRows: any[] = [];
    const rowResults: ImportCommitRowResult[] = [];

    for (const row of data.rows) {
      const tasCode = row.matchedTasCode ? row.matchedTasCode.trim().toUpperCase() : null;
      const orgEmail = normalizeEmail(row.organizationEmail);
      const persEmail = normalizeEmail(row.personalEmail);
      const normPhone = normalizePhone(row.phoneNumber);
      const normName = normalizeName(row.displayName);

      // 1. Check strict duplicate signals FIRST (existing Workforce/Records OR intra-file repeat)
      let dupReason: string | null = row.duplicateReason ?? null;

      if (
        row.category === "duplicate_existing" ||
        row.category === "duplicate_in_file" ||
        row.category === "matched_workforce" ||
        row.category === "existing_historical" ||
        Boolean(row.matchedProfileId) ||
        Boolean(row.matchedRecordId)
      ) {
        dupReason =
          dupReason ||
          (row.matchedProfileId
            ? `Matches existing Workforce employee${tasCode ? ` (${tasCode})` : ""}. Existing records are never overwritten.`
            : "Duplicate employee record rejected.");
      } else if (row.errors.length === 0 && !row.excluded) {
        if (tasCode && dbTasCodes.has(tasCode)) {
          dupReason = `Employee ID ${tasCode} already exists in Workforce or Employee Records.`;
        } else if (orgEmail && dbOrgEmails.has(orgEmail)) {
          dupReason = `Organization email ${orgEmail} already exists in Workforce or Employee Records.`;
        } else if (persEmail && dbPersonalEmails.has(persEmail)) {
          const hits = dbPersonalEmails.get(persEmail)!;
          const hit = hits.find((h) => {
            const distinctId = Boolean(tasCode && h.tasCode && tasCode !== h.tasCode);
            return !distinctId && (h.normName === normName || !tasCode || !orgEmail);
          });
          if (hit) {
            dupReason = `Personal email ${persEmail} matches an existing employee in Workforce or Employee Records.`;
          }
        } else if (normPhone && normName && dbPhoneNames.has(`${normPhone}|${normName}`)) {
          dupReason = `Phone and full name (${row.displayName}) match an existing employee.`;
        } else if (tasCode && seenBatchTasCodes.has(tasCode)) {
          dupReason = `Duplicate Employee ID ${tasCode} in the same import file.`;
        } else if (orgEmail && seenBatchOrgEmails.has(orgEmail)) {
          dupReason = `Duplicate Organization Email ${orgEmail} in the same import file.`;
        } else if (persEmail && seenBatchPersonalEmails.has(persEmail)) {
          const prev = seenBatchPersonalEmails.get(persEmail)!;
          const distinctId = Boolean(tasCode && prev.tasCode && tasCode !== prev.tasCode);
          if (!distinctId && (prev.normName === normName || !tasCode || !orgEmail)) {
            dupReason = `Duplicate Personal Email ${persEmail} of row #${prev.rowNumber} in the same import file.`;
          }
        } else if (normPhone && normName && seenBatchPhoneNames.has(`${normPhone}|${normName}`)) {
          dupReason = `Duplicate Name + Phone (${row.displayName}) in the same import file.`;
        }
      }

      if (dupReason) {
        duplicateCount += 1;
        rowResults.push({
          rowNumber: row.rowNumber,
          displayName: row.displayName,
          tasEmployeeCode: tasCode,
          status: "duplicate",
          reason: dupReason,
        });
        auditRows.push({
          batch_id: batchId,
          row_number: row.rowNumber,
          raw_payload: row.raw,
          normalized_payload: {
            displayName: row.displayName,
            organizationEmail: orgEmail,
            tasEmployeeCode: tasCode,
          },
          outcome: "skipped",
          match_signal: "duplicate_rejected",
          matched_profile_id: row.matchedProfileId ?? null,
          record_id: row.matchedRecordId ?? null,
          warnings: row.warnings,
          errors: [dupReason],
        });
        continue;
      }

      // 2. Skip excluded, invalid, or incomplete rows
      if (row.excluded || !row.readyToImport || row.errors.length > 0) {
        invalidCount += 1;
        const invalidReason = row.excluded
          ? "Excluded by HR in preview."
          : row.errors.join("; ") || "Row requires manual review before import.";
        const isReview =
          row.category === "possible_duplicate" || row.category === "needs_information";
        rowResults.push({
          rowNumber: row.rowNumber,
          displayName: row.displayName,
          tasEmployeeCode: tasCode,
          status: "invalid",
          reason: invalidReason,
        });
        auditRows.push({
          batch_id: batchId,
          row_number: row.rowNumber,
          raw_payload: row.raw,
          normalized_payload: { displayName: row.displayName },
          outcome: row.excluded ? "excluded" : isReview ? "needs_review" : "error",
          match_signal: row.matchSignal,
          warnings: row.warnings,
          errors: row.errors,
        });
        continue;
      }

      // 3. Insert genuinely new historical employee record
      try {
        const { firstName, lastName } = splitDisplayName(row.displayName);
        const driveCheck = validateGoogleDriveFolderUrl(row.driveFolderUrl ?? "");
        const hasDrive = Boolean(driveCheck.valid && driveCheck.normalizedUrl);
        const deptHit = row.departmentName
          ? deptByName.get(row.departmentName.trim().toLowerCase())
          : undefined;

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
            tas_employee_code: tasCode,
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

        // Register in seen & live sets to block any subsequent duplicate in the batch
        if (tasCode) {
          seenBatchTasCodes.add(tasCode);
          dbTasCodes.add(tasCode);
        }
        if (orgEmail) {
          seenBatchOrgEmails.add(orgEmail);
          dbOrgEmails.add(orgEmail);
        }
        if (persEmail) {
          if (!seenBatchPersonalEmails.has(persEmail)) {
            seenBatchPersonalEmails.set(persEmail, { rowNumber: row.rowNumber, normName, tasCode });
          }
          const list = dbPersonalEmails.get(persEmail) ?? [];
          list.push({ normName, tasCode });
          dbPersonalEmails.set(persEmail, list);
        }
        if (normPhone && normName) {
          seenBatchPhoneNames.add(`${normPhone}|${normName}`);
          dbPhoneNames.add(`${normPhone}|${normName}`);
        }

        importedCount += 1;
        rowResults.push({
          rowNumber: row.rowNumber,
          displayName: row.displayName,
          tasEmployeeCode: tasCode,
          status: "imported",
          reason: "Imported as new historical record.",
        });
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
      } catch (err: any) {
        if (err?.code === "23505") {
          const msg = "Unique constraint rejected duplicate Employee ID or Email.";
          duplicateCount += 1;
          rowResults.push({
            rowNumber: row.rowNumber,
            displayName: row.displayName,
            tasEmployeeCode: tasCode,
            status: "duplicate",
            reason: msg,
          });
          auditRows.push({
            batch_id: batchId,
            row_number: row.rowNumber,
            raw_payload: row.raw,
            normalized_payload: { displayName: row.displayName },
            outcome: "skipped",
            match_signal: "db_unique_rejected",
            warnings: row.warnings,
            errors: [msg],
          });
        } else {
          const msg = err instanceof Error ? err.message : "Failed to save row.";
          failedCount += 1;
          rowResults.push({
            rowNumber: row.rowNumber,
            displayName: row.displayName,
            tasEmployeeCode: tasCode,
            status: "failed",
            reason: msg,
          });
          auditRows.push({
            batch_id: batchId,
            row_number: row.rowNumber,
            raw_payload: row.raw,
            normalized_payload: { displayName: row.displayName },
            outcome: "error",
            match_signal: row.matchSignal,
            warnings: row.warnings,
            errors: [msg],
          });
        }
      }
    }

    if (auditRows.length > 0) {
      for (let i = 0; i < auditRows.length; i += 200) {
        await db.from("employee_record_import_rows").insert(auditRows.slice(i, i + 200));
      }
    }

    // Backfill Workforce-only employees into employee_records when requested
    let workforceSyncedCount = 0;
    if (data.syncMissingWorkforce) {
      const { syncAllWorkforceToRecords } = await import("./records/sync.server");
      const syncRes = await syncAllWorkforceToRecords(context.userId);
      workforceSyncedCount = syncRes.synced;
    }

    await db
      .from("employee_record_import_batches")
      .update({
        matched_workforce_count: 0,
        new_historical_count: importedCount,
        updated_count: 0,
        skipped_count: duplicateCount,
        needs_review_count: invalidCount,
        error_count: failedCount,
        status: failedCount > 0 ? "partial" : "completed",
        summary: {
          workforceSyncedCount,
          importedCount,
          duplicateCount,
          invalidCount,
          failedCount,
          rowResults: rowResults.slice(0, 1000),
        },
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
        importedCount,
        duplicateCount,
        invalidCount,
        failedCount,
        workforceSyncedCount,
      },
    });

    return {
      replayed: false,
      batchId,
      batchKey: data.batchKey,
      totalRows: data.rows.length,
      importedCount,
      duplicateCount,
      invalidCount,
      failedCount,
      rowResults,
    } satisfies ImportCommitSummary;
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

    const { schemaReady, unified } = await loadUnifiedDataset(context.supabase);
    if (!schemaReady && unified.length === 0) {
      throw new Error("Employee Records data is not available yet.");
    }

    const filtered =
      !data.fullReport && data.filters
        ? filterAndSortUnifiedRecords(unified, data.filters).filtered
        : unified;

    const cleanRows = filtered.map((rec) => {
      const mapped = redactRecordForViewer(rec, canViewConfidential);
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

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
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
