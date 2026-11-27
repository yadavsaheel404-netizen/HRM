// Server-only shared helper to load the unified Workforce + Employee Records dataset
// along with linked department metadata and relieving case summaries.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { rethrowDbError } from "../actor.server";
import { isMissingSchemaResourceError } from "../schema-compat.server";
import { todayIso } from "../timezone";
import { loadProtectedAccountIds } from "../work-type.server";
import { mergeWorkforceAndRecords, type UnifiedWorkforceProfileInput } from "./matcher";
import { loadKycSummaryMap } from "./sync.server";
import type {
  EmployeeRecordItem,
  KycSummarySnapshot,
  SerializableMap,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const looseDb = (client: unknown) => client as SupabaseClient<any>;

export interface UnifiedRelievingCaseSummary {
  id: string;
  userId: string;
  status: string;
  employeeName: string;
  employeeCode: string | null;
  workEmail: string | null;
  designation: string | null;
  legalEmployer: string | null;
  joiningDate: string | null;
  lastWorkingDay: string | null;
  relievingEffectiveDate: string | null;
  letterIssueDate: string | null;
  contributedProjects: string | null;
  performanceStatement: string | null;
  signatoryName: string | null;
  signatoryTitle: string | null;
  signatoryDesignation: string | null;
  companyContact: string | null;
  companyAddress: string | null;
  projectClearance: boolean;
  assetClearance: boolean;
  checklistHandover: boolean;
  checklistAssets: boolean;
  checklistAccessRevocation: boolean;
  checklistDuesCleared: boolean;
  letterPdfPath: string | null;
  emailStatus: string;
  emailSentAt: string | null;
  updatedAt: string;
}

export function mapEmployeeRecordRow(row: any): EmployeeRecordItem {
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

const RELIEVING_STATUS_RANK: Record<string, number> = {
  relieved: 6,
  approved: 5,
  pending_approval: 4,
  draft: 3,
  rejected: 2,
  cancelled: 1,
};

export async function loadUnifiedEmployeeDataset(supabase: any): Promise<{
  schemaReady: boolean;
  unified: EmployeeRecordItem[];
  departments: { id: string; name: string }[];
  relievingCasesByUserId: Map<string, UnifiedRelievingCaseSummary>;
}> {
  const db = looseDb(supabaseAdmin);
  const protectedIds = await loadProtectedAccountIds(supabase);

  const [profilesRes, deptsRes, relievingRes, recsRes] = await Promise.all([
    db
      .from("profiles")
      .select(
        "id, employee_code, full_name, work_email, personal_email, mobile, current_address, permanent_address, joining_date, last_working_day, employment_status, category, work_type, department_id, designation, reporting_lead_id, created_at",
      )
      .order("full_name"),
    supabaseAdmin.from("departments").select("id, name").order("name"),
    db
      .from("relieving_cases")
      .select("*")
      .order("updated_at", { ascending: false }),
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
  const relievingCasesByUserId = new Map<string, UnifiedRelievingCaseSummary>();

  if (!relievingRes.error) {
    for (const r of (relievingRes.data ?? []) as any[]) {
      if (!r.user_id || protectedIds.has(r.user_id)) continue;

      if (r.status === "relieved" && !relievedMap.has(r.user_id)) {
        relievedMap.set(r.user_id, {
          relievingEffectiveDate: r.relieving_effective_date ?? r.last_working_day ?? null,
          legalEmployer: r.legal_employer ?? null,
        });
      }

      const candidate: UnifiedRelievingCaseSummary = {
        id: r.id,
        userId: r.user_id,
        status: r.status ?? "draft",
        employeeName: r.employee_name ?? "",
        employeeCode: r.employee_code ?? null,
        workEmail: r.work_email ?? null,
        designation: r.designation ?? null,
        legalEmployer: r.legal_employer ?? null,
        joiningDate: r.joining_date ?? null,
        lastWorkingDay: r.last_working_day ?? null,
        relievingEffectiveDate: r.relieving_effective_date ?? null,
        letterIssueDate: r.letter_issue_date ?? null,
        contributedProjects: r.contributed_projects ?? null,
        performanceStatement: r.performance_statement ?? null,
        signatoryName: r.signatory_name ?? null,
        signatoryTitle: r.signatory_title ?? null,
        signatoryDesignation: r.signatory_designation ?? null,
        companyContact: r.company_contact ?? null,
        companyAddress: r.company_address ?? null,
        projectClearance: Boolean(r.project_clearance),
        assetClearance: Boolean(r.asset_clearance),
        checklistHandover: Boolean(r.checklist_handover),
        checklistAssets: Boolean(r.checklist_assets),
        checklistAccessRevocation: Boolean(r.checklist_access_revocation),
        checklistDuesCleared: Boolean(r.checklist_dues_cleared),
        letterPdfPath: r.letter_pdf_path ?? null,
        emailStatus: r.email_status ?? "not_sent",
        emailSentAt: r.email_sent_at ?? null,
        updatedAt: r.updated_at ?? r.created_at ?? "",
      };

      const existing = relievingCasesByUserId.get(r.user_id);
      if (!existing) {
        relievingCasesByUserId.set(r.user_id, candidate);
      } else {
        const existingRank = RELIEVING_STATUS_RANK[existing.status] ?? 0;
        const nextRank = RELIEVING_STATUS_RANK[candidate.status] ?? 0;
        if (nextRank > existingRank) {
          relievingCasesByUserId.set(r.user_id, candidate);
        }
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
        .map(mapEmployeeRecordRow)
    : [];

  const unified = mergeWorkforceAndRecords({
    workforce: workforceInputs,
    records: existingRecords,
    kycSummaries,
    todayIso: todayIso(),
  });

  return { schemaReady, unified, departments: deptList, relievingCasesByUserId };
}
