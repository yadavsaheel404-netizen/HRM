// Server functions for:
// 1. Paginated Workforce + Employee Records recipient search & filtering (500+ scale)
// 2. Individual & bulk-approved ZIP Relieving / Experience Letter PDF generation
// 3. Private Custom Email Templates (DOCX/PDF upload, validation, versioning, preview)
// 4. Durable chunked Bulk Dispatch Queue via Hostinger SMTP (`hr@theaischool.co`)

import crypto from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { loadActor, rethrowDbError } from "./actor.server";
import { writeAudit } from "./audit.server";
import {
  CUSTOM_TEMPLATES_BUCKET,
  DISPATCH_CHUNK_SIZE,
  OFFICIAL_SENDER_DISPLAY,
  type CustomEmailTemplateRecord,
  type CustomEmailTemplateVersionRecord,
  type EmailCenterAccessPolicy,
  type EmailCenterRecipientItem,
  type EmailDispatchBatchRecord,
  type EmailDispatchItemRecord,
  type RecipientEmailMode,
  type RecipientSearchFilters,
  type RecipientSearchResponse,
} from "./email-center/types";
import {
  buildApprovedLettersZip,
  buildRecipientPlaceholderVariables,
  deduplicateRecipientDispatches,
  evaluateCustomTemplateRecipientReadiness,
  evaluateRelievingRecipientReadiness,
  extractDocxPlaceholders,
  extractTemplatePlaceholdersFromStrings,
  inspectPdfTemplate,
  personalizeDocxBuffer,
  personalizeFillablePdf,
  renderCustomEmailContent,
  resolveEmailCenterAccessPolicy,
  resolveRecipientEmailSelection,
  validateUploadedTemplateFile,
} from "./email-center/custom-templates";
import { DEFAULT_EMAIL_TEMPLATES, renderEmailTemplate } from "./recruitment/email-templates";
import {
  containsHeaderInjection,
  createHostingerSmtpTransport,
  inspectEmailProviderConfig,
  resolveEmailPortalUrl,
  SMTP_BULK_PACING_MS,
  SMTP_MAX_RETRY_ATTEMPTS,
} from "./recruitment/email-transport.server";
import { generateRelievingLetterPdf } from "./relieving/pdf-generator.server";
import { formatLetterDate, type RelievingLetterData } from "./relieving/types";
import { loadUnifiedEmployeeDataset, type UnifiedRelievingCaseSummary } from "./records/unified.server";
import { isMissingSchemaResourceError } from "./schema-compat.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const looseDb = (client: unknown) => client as SupabaseClient<any>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRelievingCaseSnapshot(rc: UnifiedRelievingCaseSummary | undefined) {
  if (!rc) return null;
  return {
    id: rc.id,
    status: rc.status,
    designation: rc.designation,
    legalEmployer: rc.legalEmployer,
    joiningDate: rc.joiningDate,
    lastWorkingDay: rc.lastWorkingDay,
    relievingEffectiveDate: rc.relievingEffectiveDate,
    letterIssueDate: rc.letterIssueDate,
    contributedProjects: rc.contributedProjects,
    performanceStatement: rc.performanceStatement,
    signatoryName: rc.signatoryName,
    signatoryTitle: rc.signatoryTitle,
    signatoryDesignation: rc.signatoryDesignation,
    companyContact: rc.companyContact,
    companyAddress: rc.companyAddress,
    projectClearance: rc.projectClearance,
    assetClearance: rc.assetClearance,
    checklistHandover: rc.checklistHandover,
    letterPdfPath: rc.letterPdfPath,
    emailStatus: rc.emailStatus,
    emailSentAt: rc.emailSentAt,
  };
}

function mapUnifiedToRecipientItem(
  rec: any,
  rc: UnifiedRelievingCaseSummary | undefined,
  canViewPersonalEmails: boolean,
): EmailCenterRecipientItem {
  const workEmail = rec.organizationEmail ? String(rec.organizationEmail).trim() : null;
  const personalEmailRaw = rec.personalEmail ? String(rec.personalEmail).trim() : null;
  const isFormer =
    rec.employmentStatus === "inactive" ||
    rc?.status === "relieved" ||
    Boolean(rec.lastWorkingDate && rc?.status === "approved");

  return {
    recordId: rec.id,
    profileId: rec.profileId ?? null,
    employeeCode: rec.tasEmployeeCode ?? null,
    historicalRecordId: rec.historicalRecordCode,
    fullName: rec.displayName,
    designation: rc?.designation ?? rec.designation ?? null,
    departmentId: rec.departmentId ?? null,
    departmentName: rec.departmentName ?? null,
    employmentCategory: rec.employmentCategory ?? "unknown",
    workType: rec.workType ?? "unknown",
    employmentStatus: rec.employmentStatus ?? "inactive",
    isFormer,
    isHistoricalOnly: !rec.profileId,
    joiningDate: rc?.joiningDate ?? rec.joiningDate ?? null,
    lastWorkingDate: rc?.lastWorkingDay ?? rec.lastWorkingDate ?? null,
    relievingEffectiveDate: rc?.relievingEffectiveDate ?? rec.lastWorkingDate ?? null,
    legalEmployer: rc?.legalEmployer ?? rec.legalEmployer ?? null,
    workEmail,
    personalEmail: canViewPersonalEmails ? personalEmailRaw : null,
    workEmailAvailable: Boolean(workEmail),
    personalEmailAvailable: Boolean(personalEmailRaw),
    relievingCase: buildRelievingCaseSnapshot(rc),
  };
}

async function loadRecipientPoolForActor(
  supabase: any,
  access: EmailCenterAccessPolicy,
): Promise<{
  pool: EmailCenterRecipientItem[];
  rawPersonalEmailMap: Map<string, string | null>;
  departments: string[];
  workTypes: string[];
}> {
  const dataset = await loadUnifiedEmployeeDataset(supabase);
  const deptSet = new Set<string>();
  const workTypeSet = new Set<string>();
  const rawPersonalEmailMap = new Map<string, string | null>();

  const pool: EmailCenterRecipientItem[] = dataset.unified.map((rec) => {
    const rc = rec.profileId ? dataset.relievingCasesByUserId.get(rec.profileId) : undefined;
    if (rec.departmentName) deptSet.add(rec.departmentName);
    if (rec.workType && rec.workType !== "unknown") workTypeSet.add(rec.workType);
    rawPersonalEmailMap.set(rec.id, rec.personalEmail ?? null);
    return mapUnifiedToRecipientItem(rec, rc, access.canViewPersonalEmails);
  });

  return {
    pool,
    rawPersonalEmailMap,
    departments: [...deptSet].sort((a, b) => a.localeCompare(b)),
    workTypes: [...workTypeSet].sort((a, b) => a.localeCompare(b)),
  };
}

function mapCustomTemplateRow(
  row: any,
  canViewAttachmentPath: boolean,
): CustomEmailTemplateRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    purposeCategory: row.purpose_category ?? "general",
    subjectTemplate: row.subject_template,
    bodyHtmlTemplate: row.body_html_template,
    bodyTextTemplate: row.body_text_template ?? null,
    attachmentPath: canViewAttachmentPath ? (row.attachment_path ?? null) : null,
    attachmentFilename: row.attachment_filename ?? null,
    attachmentFormat: (row.attachment_format ?? "none") as CustomEmailTemplateRecord["attachmentFormat"],
    attachmentMime: row.attachment_mime ?? null,
    attachmentSizeBytes: row.attachment_size_bytes ?? null,
    attachmentSha256: row.attachment_sha256 ?? null,
    pdfMode: row.pdf_mode ?? null,
    detectedPlaceholders: Array.isArray(row.detected_placeholders) ? row.detected_placeholders : [],
    recipientType: row.recipient_type ?? "all_records",
    defaultEmailMode: (row.default_email_mode ?? "personal") as RecipientEmailMode,
    senderDisplay: row.sender_display ?? OFFICIAL_SENDER_DISPLAY,
    status: row.status ?? "draft",
    requiresElevatedApproval: Boolean(row.requires_elevated_approval),
    version: Number(row.version ?? 1),
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    approvedBy: row.approved_by ?? null,
    approvedAt: row.approved_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBatchRow(row: any): EmailDispatchBatchRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    dispatchKind: row.dispatch_kind,
    templateSlug: row.template_slug ?? null,
    customTemplateId: row.custom_template_id ?? null,
    templateName: row.template_name,
    templateVersion: row.template_version ?? null,
    subjectTemplate: row.subject_template,
    defaultEmailMode: row.default_email_mode ?? "personal",
    attachmentFilename: row.attachment_filename ?? null,
    attachmentFormat: row.attachment_format ?? null,
    status: row.status,
    totalCount: Number(row.total_count ?? 0),
    queuedCount: Number(row.queued_count ?? 0),
    acceptedCount: Number(row.accepted_count ?? 0),
    failedCount: Number(row.failed_count ?? 0),
    canceledCount: Number(row.canceled_count ?? 0),
    skippedCount: Number(row.skipped_count ?? 0),
    personalEmailCount: Number(row.personal_email_count ?? 0),
    workEmailCount: Number(row.work_email_count ?? 0),
    createdBy: row.created_by ?? null,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBatchItemRow(row: any, canViewPersonalEmails: boolean): EmailDispatchItemRecord {
  const emailMode = (row.email_mode ?? "work") as RecipientEmailMode;
  const hideEmail = !canViewPersonalEmails && emailMode === "personal";
  return {
    id: row.id,
    batchId: row.batch_id,
    idempotencyKey: row.idempotency_key,
    recipientRecordId: row.recipient_record_id,
    profileId: row.profile_id ?? null,
    relievingCaseId: row.relieving_case_id ?? null,
    employeeCode: row.employee_code ?? null,
    recipientName: row.recipient_name,
    emailMode,
    recipientEmail: hideEmail ? "[REDACTED CONFIDENTIAL]" : row.recipient_email,
    resolvedSubject: row.resolved_subject,
    attachmentName: row.attachment_name ?? null,
    status: row.status,
    attempts: Number(row.attempts ?? 0),
    provider: row.provider ?? "hostinger_smtp",
    providerMessageId: row.provider_message_id ?? null,
    smtpResponse: row.smtp_response ?? null,
    errorMessage: row.error_message ?? null,
    sentAt: row.sent_at ?? null,
    createdAt: row.created_at,
  };
}

async function recalculateBatchCounts(db: SupabaseClient<any>, batchId: string) {
  const { data: rows, error } = await db
    .from("email_dispatch_items")
    .select("status")
    .eq("batch_id", batchId);

  if (error) rethrowDbError("Recalculating dispatch batch counters failed", error);

  let queued = 0;
  let sending = 0;
  let accepted = 0;
  let failed = 0;
  let canceled = 0;
  let skipped = 0;

  for (const r of (rows ?? []) as any[]) {
    if (r.status === "queued") queued++;
    else if (r.status === "sending") sending++;
    else if (r.status === "accepted_by_smtp" || r.status === "delivered") accepted++;
    else if (r.status === "failed") failed++;
    else if (r.status === "canceled") canceled++;
    else if (r.status === "skipped") skipped++;
  }

  const pending = queued + sending;
  let nextStatus: EmailDispatchBatchRecord["status"] = "processing";
  if (pending > 0) {
    nextStatus = sending > 0 || accepted > 0 || failed > 0 ? "processing" : "queued";
  } else if (canceled > 0 && accepted === 0 && failed === 0) {
    nextStatus = "canceled";
  } else if (failed > 0 && accepted > 0) {
    nextStatus = "partial_failure";
  } else if (failed > 0 && accepted === 0) {
    nextStatus = "failed";
  } else {
    nextStatus = "completed";
  }

  const updatePayload: Record<string, unknown> = {
    queued_count: pending,
    accepted_count: accepted,
    failed_count: failed,
    canceled_count: canceled,
    skipped_count: skipped,
    status: nextStatus,
  };
  if (pending === 0) {
    updatePayload["completed_at"] = new Date().toISOString();
  }

  const { data: updated, error: upErr } = await db
    .from("email_dispatch_batches")
    .update(updatePayload)
    .eq("id", batchId)
    .select("*")
    .single();

  if (upErr) rethrowDbError("Updating batch status failed", upErr);
  return mapBatchRow(updated);
}

/**
 * 1. Search & filter unified Workforce + Employee Records recipients (500+ pagination).
 */
export const searchEmailCenterRecipients = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input?: RecipientSearchFilters) => input ?? {})
  .handler(async ({ data, context }): Promise<RecipientSearchResponse> => {
    const actor = await loadActor(context.supabase, context.userId);
    const access = resolveEmailCenterAccessPolicy(actor.roles, actor.permissions);

    if (!access.canReadEmailCenter) {
      throw new Error("Forbidden: You do not have permission to access Email Center recipients.");
    }
    if (data.context === "custom" && !access.canManageCustomTemplates && !access.isFounder) {
      throw new Error("Forbidden: Custom Template recipient access is restricted to HR, Super Admin, or read-only Founder oversight.");
    }

    const { pool, departments, workTypes } = await loadRecipientPoolForActor(
      context.supabase,
      access,
    );

    const q = (data.query ?? "").trim().toLowerCase();
    const statusFilter = data.status ?? "all";
    const deptFilter = (data.department ?? "all").trim();
    const workTypeFilter = (data.workType ?? "all").trim();
    const categoryFilter = (data.employmentCategory ?? "all").trim();
    const emailMode = data.emailMode ?? "personal";

    const filtered = pool.filter((item) => {
      if (q) {
        const hay = [
          item.fullName,
          item.employeeCode ?? "",
          item.historicalRecordId,
          item.workEmail ?? "",
          access.canViewPersonalEmails ? (item.personalEmail ?? "") : "",
          item.designation ?? "",
          item.departmentName ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }

      if (statusFilter === "active" && (item.employmentStatus !== "active" || item.isFormer)) {
        return false;
      }
      if (statusFilter === "inactive_relieved" && item.employmentStatus === "active" && !item.isFormer) {
        return false;
      }
      if (deptFilter !== "all" && item.departmentName !== deptFilter) {
        return false;
      }
      if (workTypeFilter !== "all" && item.workType !== workTypeFilter) {
        return false;
      }
      if (categoryFilter !== "all" && item.employmentCategory !== categoryFilter) {
        return false;
      }
      if (data.hasApprovedRelievingCase) {
        const st = item.relievingCase?.status?.toLowerCase();
        if (st !== "approved" && st !== "relieved") return false;
      }
      if (data.missingRequiredDetails) {
        const val = evaluateRelievingRecipientReadiness(item, emailMode);
        if (val.status !== "missing_details" && val.status !== "approval_pending") {
          return false;
        }
      }
      if (data.emailAvailable === "personal" && !item.personalEmailAvailable) return false;
      if (data.emailAvailable === "work" && !item.workEmailAvailable) return false;
      if (
        data.emailAvailable === "any" &&
        !item.personalEmailAvailable &&
        !item.workEmailAvailable
      ) {
        return false;
      }
      return true;
    });

    const pageSize = Math.min(100, Math.max(10, Number(data.pageSize ?? 25)));
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(totalPages, Math.max(1, Number(data.page ?? 1)));
    const startIdx = (page - 1) * pageSize;
    const items = filtered.slice(startIdx, startIdx + pageSize);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages,
      departments,
      workTypes,
      allMatchingIds: data.includeAllMatchingIds ? filtered.slice(0, 2000).map((r) => r.recordId) : undefined,
      access,
    };
  });

/**
 * 2. Generates a single individualized Relieving / Experience Letter PDF preview for review.
 * Unapproved relieving cases ALWAYS render as watermarked DRAFT without official signature.
 */
export const previewIndividualRelievingPdf = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      recipientRecordId: string;
      customLetterOverrides?: Partial<RelievingLetterData>;
      forceDraft?: boolean;
    }) => {
      if (!input?.recipientRecordId) {
        throw new Error("Recipient record ID is required.");
      }
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const actor = await loadActor(context.supabase, context.userId);
    const access = resolveEmailCenterAccessPolicy(actor.roles, actor.permissions);
    if (!access.canReadEmailCenter) {
      throw new Error("Forbidden: You do not have permission to preview relieving letters.");
    }

    const { pool } = await loadRecipientPoolForActor(context.supabase, access);
    const recipient = pool.find(
      (r) => r.recordId === data.recipientRecordId || r.profileId === data.recipientRecordId,
    );
    if (!recipient) {
      throw new Error("Authorized employee record not found.");
    }

    const validation = evaluateRelievingRecipientReadiness(recipient, "personal");
    const rc = recipient.relievingCase;
    const isOfficialApproved = validation.canOfficialIssue && !data.forceDraft;

    const todayStr = new Date().toISOString().slice(0, 10);
    const letterData: RelievingLetterData = {
      employeeName:
        data.customLetterOverrides?.employeeName?.trim() || recipient.fullName,
      designation:
        data.customLetterOverrides?.designation?.trim() ||
        rc?.designation ||
        recipient.designation ||
        "Team Member",
      legalEmployer:
        data.customLetterOverrides?.legalEmployer?.trim() ||
        rc?.legalEmployer ||
        recipient.legalEmployer ||
        "Learning Paths Technologies LLP",
      joiningDate:
        data.customLetterOverrides?.joiningDate?.trim() ||
        rc?.joiningDate ||
        recipient.joiningDate ||
        "",
      lastWorkingDay:
        data.customLetterOverrides?.lastWorkingDay?.trim() ||
        rc?.lastWorkingDay ||
        recipient.lastWorkingDate ||
        "",
      relievingEffectiveDate:
        data.customLetterOverrides?.relievingEffectiveDate?.trim() ||
        rc?.relievingEffectiveDate ||
        rc?.lastWorkingDay ||
        recipient.lastWorkingDate ||
        "",
      letterIssueDate:
        data.customLetterOverrides?.letterIssueDate?.trim() ||
        rc?.letterIssueDate ||
        todayStr,
      contributedProjects:
        data.customLetterOverrides?.contributedProjects?.trim() ||
        rc?.contributedProjects ||
        `${rc?.designation || recipient.designation || "Organizational"} initiatives and core projects`,
      performanceStatement:
        data.customLetterOverrides?.performanceStatement?.trim() ||
        rc?.performanceStatement ||
        "satisfactory",
      signatoryName:
        data.customLetterOverrides?.signatoryName?.trim() ||
        rc?.signatoryName ||
        "K. Spandana",
      signatoryTitle:
        data.customLetterOverrides?.signatoryTitle?.trim() ||
        rc?.signatoryTitle ||
        "HR - Director",
      signatoryDesignation:
        data.customLetterOverrides?.signatoryDesignation?.trim() ||
        rc?.signatoryDesignation ||
        "Director",
      companyContact: rc?.companyContact || "+91 92468 18843",
      companyAddress:
        rc?.companyAddress || "T-hub 2.0, Knowledge City, Hyderabad, Telangana",
      // CRITICAL: Unapproved relieving cases NEVER receive an unwatermarked official signed PDF
      isDraft: !isOfficialApproved,
      includeSignature: isOfficialApproved,
    };

    const pdfBytes = await generateRelievingLetterPdf(letterData);
    const safeName = letterData.employeeName.replace(/[^a-zA-Z0-9_-]+/g, "_");
    const safeId = (recipient.employeeCode || recipient.historicalRecordId).replace(
      /[^a-zA-Z0-9_-]+/g,
      "_",
    );

    return {
      pdfBase64: Buffer.from(pdfBytes).toString("base64"),
      fileName: `${isOfficialApproved ? "Experience_Letter" : "DRAFT_Experience_Letter"}_${safeId}_${safeName}.pdf`,
      validation,
      isOfficialApproved,
    };
  });

/**
 * 3. Packages separate individualized approved Relieving PDFs into a ZIP bundle.
 * Strictly blocks unapproved or incomplete cases from inclusion.
 */
export const downloadApprovedRelievingZip = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { recipientRecordIds: string[] }) => {
    if (!Array.isArray(input?.recipientRecordIds) || input.recipientRecordIds.length === 0) {
      throw new Error("Select at least one approved employee to package.");
    }
    if (input.recipientRecordIds.length > 200) {
      throw new Error("ZIP download supports up to 200 individualized PDFs per archive.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const actor = await loadActor(context.supabase, context.userId);
    const access = resolveEmailCenterAccessPolicy(actor.roles, actor.permissions);
    if (!access.canSendEmails) {
      throw new Error("Forbidden: Only HR or Super Admin can download bulk official relieving letters.");
    }

    const { pool } = await loadRecipientPoolForActor(context.supabase, access);
    const byId = new Map(pool.map((r) => [r.recordId, r]));

    const files: { fileName: string; pdfBytes: Uint8Array }[] = [];
    const skipped: { recordId: string; fullName: string; reason: string }[] = [];

    for (const id of data.recipientRecordIds) {
      const recipient = byId.get(id);
      if (!recipient) {
        skipped.push({ recordId: id, fullName: id, reason: "Employee record not found." });
        continue;
      }

      const validation = evaluateRelievingRecipientReadiness(recipient, "personal");
      if (!validation.canOfficialIssue || !recipient.relievingCase) {
        skipped.push({
          recordId: id,
          fullName: recipient.fullName,
          reason: validation.reasons[0] ?? validation.statusLabel,
        });
        continue;
      }

      const rc = recipient.relievingCase;
      const pdfBytes = await generateRelievingLetterPdf({
        employeeName: recipient.fullName,
        designation: rc.designation || recipient.designation || "Associate",
        legalEmployer: rc.legalEmployer || recipient.legalEmployer || "Learning Paths Technologies LLP",
        joiningDate: rc.joiningDate || recipient.joiningDate || "",
        lastWorkingDay: rc.lastWorkingDay || recipient.lastWorkingDate || "",
        relievingEffectiveDate:
          rc.relievingEffectiveDate || rc.lastWorkingDay || recipient.lastWorkingDate || "",
        letterIssueDate: rc.letterIssueDate || new Date().toISOString().slice(0, 10),
        contributedProjects:
          rc.contributedProjects ||
          `${rc.designation || recipient.designation || "Organizational"} initiatives and core projects`,
        performanceStatement: rc.performanceStatement || "satisfactory",
        signatoryName: rc.signatoryName || "K. Spandana",
        signatoryTitle: rc.signatoryTitle || "HR - Director",
        signatoryDesignation: rc.signatoryDesignation || "Director",
        companyContact: rc.companyContact || "+91 92468 18843",
        companyAddress:
          rc.companyAddress || "T-hub 2.0, Knowledge City, Hyderabad, Telangana",
        isDraft: false,
        includeSignature: true,
      });

      const codePart = (recipient.employeeCode || recipient.historicalRecordId).replace(
        /[^a-zA-Z0-9_-]+/g,
        "_",
      );
      const namePart = recipient.fullName.replace(/[^a-zA-Z0-9_-]+/g, "_");
      files.push({
        fileName: `Experience_Letter_${codePart}_${namePart}.pdf`,
        pdfBytes,
      });
    }

    if (files.length === 0) {
      throw new Error("None of the selected employees have formally approved, complete relieving letters ready to issue.");
    }

    const zipBytes = buildApprovedLettersZip(files);
    await writeAudit(context.supabase, {
      actorId: context.userId,
      action: "relieving.bulk_zip_downloaded",
      entityType: "relieving_batch",
      entityId: context.userId,
      detail: { includedCount: files.length, skippedCount: skipped.length },
    });

    return {
      zipBase64: Buffer.from(zipBytes).toString("base64"),
      fileName: `Relieving_Letters_${new Date().toISOString().slice(0, 10)}.zip`,
      includedCount: files.length,
      skipped,
    };
  });

/**
 * 4. Lists saved Custom Email Templates & recent version history.
 */
export const listCustomEmailTemplates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const actor = await loadActor(context.supabase, context.userId);
    const access = resolveEmailCenterAccessPolicy(actor.roles, actor.permissions);
    if (!access.canReadEmailCenter) {
      throw new Error("Forbidden: You do not have permission to view Email Center templates.");
    }
    if (!access.canManageCustomTemplates && !access.isFounder) {
      throw new Error(
        "Forbidden: Custom Email Templates are restricted to HR, Super Admin, and read-only Founder oversight.",
      );
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);

    const [tplRes, verRes] = await Promise.all([
      db.from("custom_email_templates").select("*").order("updated_at", { ascending: false }),
      db
        .from("custom_email_template_versions")
        .select("*")
        .order("version", { ascending: false })
        .limit(300),
    ]);

    if (tplRes.error && isMissingSchemaResourceError(tplRes.error)) {
      return {
        schemaReady: false,
        templates: [] as CustomEmailTemplateRecord[],
        versionsByTemplateId: {} as Record<string, CustomEmailTemplateVersionRecord[]>,
        access,
      };
    }
    if (tplRes.error) rethrowDbError("Loading custom email templates failed", tplRes.error);

    const templates = (tplRes.data ?? []).map((row: any) =>
      mapCustomTemplateRow(row, access.canAccessPrivateTemplateFiles),
    );

    const versionsByTemplateId: Record<string, CustomEmailTemplateVersionRecord[]> = {};
    if (!verRes.error) {
      for (const v of (verRes.data ?? []) as any[]) {
        const arr = versionsByTemplateId[v.template_id] ?? [];
        arr.push({
          id: v.id,
          templateId: v.template_id,
          version: Number(v.version ?? 1),
          name: v.name,
          subjectTemplate: v.subject_template,
          attachmentFilename: v.attachment_filename ?? null,
          attachmentFormat: v.attachment_format ?? "none",
          detectedPlaceholders: Array.isArray(v.detected_placeholders) ? v.detected_placeholders : [],
          status: v.status,
          changedBy: v.changed_by ?? null,
          createdAt: v.created_at,
        });
        versionsByTemplateId[v.template_id] = arr;
      }
    }

    return {
      schemaReady: true,
      templates,
      versionsByTemplateId,
      access,
    };
  });

/**
 * 5. Creates/updates a Custom Email Template with optional private DOCX/PDF upload & version tracking.
 */
export const uploadAndSaveCustomTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      id?: string | null;
      name: string;
      description?: string;
      purposeCategory?: string;
      subjectTemplate: string;
      bodyHtmlTemplate: string;
      bodyTextTemplate?: string | null;
      recipientType?: CustomEmailTemplateRecord["recipientType"];
      defaultEmailMode?: RecipientEmailMode;
      status?: CustomEmailTemplateRecord["status"];
      requiresElevatedApproval?: boolean;
      clearAttachment?: boolean;
      file?: {
        fileName: string;
        mimeType: string;
        base64Data: string;
      } | null;
    }) => {
      if (!input?.name?.trim()) throw new Error("Template Name is required.");
      if (!input?.subjectTemplate?.trim()) throw new Error("Email Subject is required.");
      if (containsHeaderInjection(input.subjectTemplate)) {
        throw new Error("Email Subject cannot contain line breaks.");
      }
      if (!input?.bodyHtmlTemplate?.trim()) throw new Error("Email Body is required.");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const actor = await loadActor(context.supabase, context.userId);
    const access = resolveEmailCenterAccessPolicy(actor.roles, actor.permissions);
    if (!access.canManageCustomTemplates) {
      throw new Error("Forbidden: Only HR or Super Admin can create or modify custom email templates.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);

    let existing: any = null;
    if (data.id) {
      const { data: found, error: fErr } = await db
        .from("custom_email_templates")
        .select("*")
        .eq("id", data.id)
        .maybeSingle();
      if (fErr) rethrowDbError("Loading existing custom template failed", fErr);
      if (!found) throw new Error("Custom template not found.");
      existing = found;
    }

    const templateId = existing?.id ?? crypto.randomUUID();
    const nextVersion = existing ? Number(existing.version ?? 1) + 1 : 1;

    let attachmentPath: string | null = data.clearAttachment
      ? null
      : (existing?.attachment_path ?? null);
    let attachmentFilename: string | null = data.clearAttachment
      ? null
      : (existing?.attachment_filename ?? null);
    let attachmentFormat: "none" | "docx" | "pdf" = data.clearAttachment
      ? "none"
      : (existing?.attachment_format ?? "none");
    let attachmentMime: string | null = data.clearAttachment
      ? null
      : (existing?.attachment_mime ?? null);
    let attachmentSizeBytes: number | null = data.clearAttachment
      ? null
      : (existing?.attachment_size_bytes ?? null);
    let attachmentSha256: string | null = data.clearAttachment
      ? null
      : (existing?.attachment_sha256 ?? null);
    let pdfMode: "static" | "fillable" | null = data.clearAttachment
      ? null
      : (existing?.pdf_mode ?? null);
    let attachmentPlaceholders: string[] = data.clearAttachment
      ? []
      : Array.isArray(existing?.detected_placeholders)
        ? existing.detected_placeholders
        : [];
    let pdfWarning: string | null = null;

    if (data.file) {
      const bytes = new Uint8Array(Buffer.from(data.file.base64Data, "base64"));
      const validation = validateUploadedTemplateFile({
        fileName: data.file.fileName,
        mimeType: data.file.mimeType,
        bytes,
      });
      if (!validation.valid) {
        throw new Error(validation.error);
      }

      if (validation.format === "docx") {
        const docInfo = extractDocxPlaceholders(bytes);
        attachmentPlaceholders = docInfo.detectedPlaceholders;
        pdfMode = null;
      } else {
        const pdfInfo = await inspectPdfTemplate(bytes);
        attachmentPlaceholders = pdfInfo.detectedPlaceholders;
        pdfMode = pdfInfo.mode;
        pdfWarning = pdfInfo.warning;
      }

      const storagePath = `${templateId}/v${nextVersion}/${validation.safeFileName}`;
      const uploadRes = await supabaseAdmin.storage
        .from(CUSTOM_TEMPLATES_BUCKET)
        .upload(storagePath, bytes, {
          contentType: validation.normalizedMime,
          upsert: true,
        });

      if (uploadRes.error) {
        throw new Error(`Private template upload failed: ${uploadRes.error.message}`);
      }

      attachmentPath = storagePath;
      attachmentFilename = validation.safeFileName;
      attachmentFormat = validation.format;
      attachmentMime = validation.normalizedMime;
      attachmentSizeBytes = bytes.byteLength;
      attachmentSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    }

    const bodyPlaceholders = extractTemplatePlaceholdersFromStrings([
      data.subjectTemplate,
      data.bodyHtmlTemplate,
      data.bodyTextTemplate ?? "",
    ]);
    const detectedPlaceholders = [...new Set([...bodyPlaceholders, ...attachmentPlaceholders])];
    const nextStatus = data.status ?? existing?.status ?? "draft";
    const nowIso = new Date().toISOString();

    const rowPayload = {
      id: templateId,
      name: data.name.trim(),
      description: (data.description ?? "").trim(),
      purpose_category: (data.purposeCategory ?? "general").trim(),
      subject_template: data.subjectTemplate.trim(),
      body_html_template: data.bodyHtmlTemplate,
      body_text_template: data.bodyTextTemplate ?? null,
      attachment_path: attachmentPath,
      attachment_filename: attachmentFilename,
      attachment_format: attachmentFormat,
      attachment_mime: attachmentMime,
      attachment_size_bytes: attachmentSizeBytes,
      attachment_sha256: attachmentSha256,
      pdf_mode: pdfMode,
      detected_placeholders: detectedPlaceholders,
      recipient_type: data.recipientType ?? existing?.recipient_type ?? "all_records",
      default_email_mode: data.defaultEmailMode ?? existing?.default_email_mode ?? "personal",
      sender_display: OFFICIAL_SENDER_DISPLAY,
      status: nextStatus,
      requires_elevated_approval: Boolean(data.requiresElevatedApproval),
      version: nextVersion,
      created_by: existing?.created_by ?? context.userId,
      updated_by: context.userId,
      approved_by:
        nextStatus === "approved" ? (existing?.approved_by ?? context.userId) : existing?.approved_by ?? null,
      approved_at: nextStatus === "approved" ? (existing?.approved_at ?? nowIso) : existing?.approved_at ?? null,
    };

    const { data: saved, error: saveErr } = await db
      .from("custom_email_templates")
      .upsert(rowPayload, { onConflict: "id" })
      .select("*")
      .single();

    if (saveErr) rethrowDbError("Saving custom email template failed", saveErr);

    await db.from("custom_email_template_versions").insert({
      template_id: templateId,
      version: nextVersion,
      name: rowPayload.name,
      subject_template: rowPayload.subject_template,
      body_html_template: rowPayload.body_html_template,
      body_text_template: rowPayload.body_text_template,
      attachment_path: rowPayload.attachment_path,
      attachment_filename: rowPayload.attachment_filename,
      attachment_format: rowPayload.attachment_format,
      attachment_sha256: rowPayload.attachment_sha256,
      detected_placeholders: rowPayload.detected_placeholders,
      status: rowPayload.status,
      changed_by: context.userId,
    });

    await writeAudit(context.supabase, {
      actorId: context.userId,
      action: "custom_email_template.saved",
      entityType: "custom_email_template",
      entityId: templateId,
      detail: {
        name: rowPayload.name,
        version: nextVersion,
        status: nextStatus,
        attachmentFormat,
        pdfMode,
        detectedPlaceholders,
      },
    });

    return {
      template: mapCustomTemplateRow(saved, true),
      pdfWarning,
    };
  });

/**
 * 6. Previews a Custom Email Template (subject, HTML, text, DOCX paragraphs / PDF attachment)
 * against a selected authorized employee WITHOUT sending any email.
 */
export const previewCustomEmailTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { templateId: string; sampleRecipientRecordId?: string | null }) => {
    if (!input?.templateId) throw new Error("Custom template ID is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const actor = await loadActor(context.supabase, context.userId);
    const access = resolveEmailCenterAccessPolicy(actor.roles, actor.permissions);
    if (!access.canReadEmailCenter || (!access.canManageCustomTemplates && !access.isFounder)) {
      throw new Error("Forbidden: You do not have permission to preview this custom email template.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);

    const { data: tplRow, error: tplErr } = await db
      .from("custom_email_templates")
      .select("*")
      .eq("id", data.templateId)
      .maybeSingle();

    if (tplErr) rethrowDbError("Loading custom template failed", tplErr);
    if (!tplRow) throw new Error("Custom email template not found.");

    const template = mapCustomTemplateRow(tplRow, access.canAccessPrivateTemplateFiles);
    let variables: Record<string, string> = {
      employee_name: "Sample Employee",
      employee_id: "TAS-REC-0001",
      designation: "AI Data Associate",
      joining_date: "2 Jul 2026",
      last_working_date: "30 Oct 2026",
      work_type: "full_time",
      employment_category: "full_time",
      company_name: "Learning Paths Technologies LLP",
      issue_date: formatLetterDate(new Date().toISOString().slice(0, 10)),
    };

    if (access.canAccessPrivateTemplateFiles && data.sampleRecipientRecordId) {
      const { pool } = await loadRecipientPoolForActor(context.supabase, access);
      const match = pool.find((r) => r.recordId === data.sampleRecipientRecordId);
      if (match) {
        variables = buildRecipientPlaceholderVariables(match);
      }
    }

    const renderedEmail = renderCustomEmailContent({
      subjectTemplate: template.subjectTemplate,
      bodyHtmlTemplate: template.bodyHtmlTemplate,
      bodyTextTemplate: template.bodyTextTemplate,
      variables,
    });

    const missingSet = new Set<string>(renderedEmail.missingPlaceholders);
    let docxParagraphs: string[] = [];
    let personalizedAttachmentBase64: string | null = null;
    let pdfWarning: string | null = null;

    if (access.canAccessPrivateTemplateFiles && tplRow.attachment_path) {
      const dl = await supabaseAdmin.storage
        .from(CUSTOM_TEMPLATES_BUCKET)
        .download(tplRow.attachment_path);

      if (!dl.error && dl.data) {
        const rawBytes = new Uint8Array(await dl.data.arrayBuffer());
        if (template.attachmentFormat === "docx") {
          const personalized = personalizeDocxBuffer(rawBytes, variables);
          for (const m of personalized.missingPlaceholders) missingSet.add(m);
          docxParagraphs = personalized.previewParagraphs;
          personalizedAttachmentBase64 = Buffer.from(personalized.buffer).toString("base64");
        } else if (template.attachmentFormat === "pdf") {
          const info = await inspectPdfTemplate(rawBytes);
          pdfWarning = info.warning;
          if (info.mode === "fillable") {
            const filled = await personalizeFillablePdf(rawBytes, variables);
            for (const m of filled.missingPlaceholders) missingSet.add(m);
            personalizedAttachmentBase64 = Buffer.from(filled.buffer).toString("base64");
          } else {
            personalizedAttachmentBase64 = Buffer.from(rawBytes).toString("base64");
          }
        }
      }
    }

    return {
      template,
      subject: renderedEmail.subject,
      bodyHtml: renderedEmail.bodyHtml,
      bodyText: renderedEmail.bodyText,
      detectedPlaceholders: template.detectedPlaceholders,
      missingPlaceholders: [...missingSet],
      pdfMode: template.pdfMode,
      pdfWarning,
      docxParagraphs,
      personalizedAttachmentBase64,
    };
  });

/**
 * 7. Creates a durable idempotent Bulk Dispatch Batch (supports 500+ recipients)
 * with strict pre-dispatch validation, deduplication, and explicit approval checks.
 */
export const createBulkDispatchBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      dispatchKind: "relieving_bulk" | "custom_template_bulk";
      idempotencyKey: string;
      customTemplateId?: string | null;
      recipientRecordIds: string[];
      defaultEmailMode: RecipientEmailMode;
      perRecipientEmailOverrides?: Record<string, RecipientEmailMode>;
      confirmApproved: boolean;
    }) => {
      if (!input?.confirmApproved) {
        throw new Error("Explicit confirmation is required before queuing bulk emails.");
      }
      if (!input?.idempotencyKey?.trim()) {
        throw new Error("Idempotency key is required.");
      }
      if (!Array.isArray(input?.recipientRecordIds) || input.recipientRecordIds.length === 0) {
        throw new Error("Select at least one verified recipient.");
      }
      if (input.recipientRecordIds.length > 1000) {
        throw new Error("Maximum 1,000 recipients allowed per dispatch batch.");
      }
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const actor = await loadActor(context.supabase, context.userId);
    const access = resolveEmailCenterAccessPolicy(actor.roles, actor.permissions);
    if (!access.canSendEmails) {
      throw new Error("Forbidden: Only HR or Super Admin can queue bulk email dispatches.");
    }

    const providerStatus = inspectEmailProviderConfig();
    if (!providerStatus.configured) {
      throw new Error(
        `Bulk dispatch blocked until Hostinger SMTP is configured: ${providerStatus.issues.join(" ")}`,
      );
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);

    // Idempotent duplicate check
    const { data: existingBatch } = await db
      .from("email_dispatch_batches")
      .select("*")
      .eq("idempotency_key", data.idempotencyKey.trim())
      .maybeSingle();

    if (existingBatch) {
      return {
        deduplicated: true,
        batch: mapBatchRow(existingBatch),
        skipped: [] as { recordId: string; fullName: string; reason: string }[],
      };
    }

    const { pool } = await loadRecipientPoolForActor(context.supabase, access);
    const byId = new Map(pool.map((r) => [r.recordId, r]));

    let templateName = "Relieving & Experience Letter";
    let templateSlug: string | null =
      data.dispatchKind === "relieving_bulk" ? "employee_relieving_letter" : null;
    let customTemplate: CustomEmailTemplateRecord | null = null;
    let attachmentPlaceholders: string[] = [];

    if (data.dispatchKind === "custom_template_bulk") {
      if (!data.customTemplateId) {
        throw new Error("A custom email template must be selected.");
      }
      const { data: tplRow, error: tplErr } = await db
        .from("custom_email_templates")
        .select("*")
        .eq("id", data.customTemplateId)
        .maybeSingle();
      if (tplErr) rethrowDbError("Loading custom template failed", tplErr);
      if (!tplRow) throw new Error("Custom template not found.");
      if (tplRow.status !== "approved") {
        throw new Error(
          `Template "${tplRow.name}" is "${tplRow.status}". Approve/publish the template before bulk sending.`,
        );
      }
      customTemplate = mapCustomTemplateRow(tplRow, true);
      templateName = customTemplate.name;
      attachmentPlaceholders = customTemplate.detectedPlaceholders;
    }

    interface PreparedItem {
      recipientRecordId: string;
      profileId: string | null;
      relievingCaseId: string | null;
      employeeCode: string | null;
      recipientName: string;
      emailMode: RecipientEmailMode;
      resolvedEmail: string;
      resolvedSubject: string;
      resolvedVariables: Record<string, string>;
      attachmentName: string | null;
    }

    const candidatesToQueue: PreparedItem[] = [];
    const skipped: { recordId: string; fullName: string; reason: string }[] = [];

    const relievingCoverDef = DEFAULT_EMAIL_TEMPLATES.find(
      (t) => t.slug === "employee_relieving_letter",
    );

    for (const recordId of [...new Set(data.recipientRecordIds)]) {
      const recipient = byId.get(recordId);
      if (!recipient) {
        skipped.push({ recordId, fullName: recordId, reason: "Employee record not found." });
        continue;
      }

      const overrideMode = data.perRecipientEmailOverrides?.[recordId];

      if (data.dispatchKind === "relieving_bulk") {
        const val = evaluateRelievingRecipientReadiness(
          recipient,
          data.defaultEmailMode,
          overrideMode,
        );
        if (!val.canSendOfficial || !val.emailResolution.resolvedEmail || !recipient.relievingCase) {
          skipped.push({
            recordId,
            fullName: recipient.fullName,
            reason: val.reasons[0] ?? val.emailResolution.statusLabel ?? val.statusLabel,
          });
          continue;
        }

        const rc = recipient.relievingCase;
        const codePart = (recipient.employeeCode || recipient.historicalRecordId).replace(
          /[^a-zA-Z0-9_-]+/g,
          "_",
        );
        const namePart = recipient.fullName.replace(/[^a-zA-Z0-9_-]+/g, "_");
        const vars: Record<string, string> = {
          employee_name: recipient.fullName,
          employee_id: recipient.employeeCode || recipient.historicalRecordId,
          designation: rc.designation || recipient.designation || "Associate",
          department_name: recipient.departmentName || "",
          legal_employer: rc.legalEmployer || recipient.legalEmployer || "Learning Paths Technologies LLP",
          employment_start_date: formatLetterDate(rc.joiningDate || recipient.joiningDate),
          employment_end_date: formatLetterDate(rc.lastWorkingDay || recipient.lastWorkingDate),
          relieving_date: formatLetterDate(
            rc.relievingEffectiveDate || rc.lastWorkingDay || recipient.lastWorkingDate,
          ),
          issue_date: formatLetterDate(rc.letterIssueDate || new Date().toISOString().slice(0, 10)),
          signatory_name: rc.signatoryName || "K. Spandana",
          signatory_title: rc.signatoryTitle || "HR - Director",
          company_name: rc.legalEmployer || "The AI School",
        };

        const rendered = renderEmailTemplate({
          subjectTemplate:
            relievingCoverDef?.subjectTemplate ??
            "Official Relieving & Experience Letter — {{employee_name}}",
          bodyHtmlTemplate:
            relievingCoverDef?.bodyHtmlTemplate ??
            "<p>Dear {{employee_name}},</p><p>Please find attached your official Relieving &amp; Experience Letter.</p>",
          bodyTextTemplate: relievingCoverDef?.bodyTextTemplate ?? undefined,
          variables: vars,
        });

        candidatesToQueue.push({
          recipientRecordId: recipient.recordId,
          profileId: recipient.profileId,
          relievingCaseId: rc.id,
          employeeCode: recipient.employeeCode || recipient.historicalRecordId,
          recipientName: recipient.fullName,
          emailMode: val.emailResolution.emailMode,
          resolvedEmail: val.emailResolution.resolvedEmail,
          resolvedSubject: rendered.subject,
          resolvedVariables: vars,
          attachmentName: `Experience_Letter_${codePart}_${namePart}.pdf`,
        });
      } else if (customTemplate) {
        const evalRes = evaluateCustomTemplateRecipientReadiness({
          template: customTemplate,
          recipient,
          defaultEmailMode: data.defaultEmailMode,
          overrideMode,
          attachmentPlaceholders,
        });

        if (!evalRes.ready || !evalRes.emailResolution.resolvedEmail) {
          skipped.push({
            recordId,
            fullName: recipient.fullName,
            reason: evalRes.reason ?? "Recipient failed placeholder or email validation.",
          });
          continue;
        }

        const vars = buildRecipientPlaceholderVariables(recipient);
        const rendered = renderCustomEmailContent({
          subjectTemplate: customTemplate.subjectTemplate,
          bodyHtmlTemplate: customTemplate.bodyHtmlTemplate,
          bodyTextTemplate: customTemplate.bodyTextTemplate,
          variables: vars,
        });

        const safeName = recipient.fullName.replace(/[^a-zA-Z0-9_-]+/g, "_");
        const attName = customTemplate.attachmentFilename
          ? `${customTemplate.attachmentFilename.replace(/\.[^.]+$/, "")}_${safeName}.${customTemplate.attachmentFormat}`
          : null;

        candidatesToQueue.push({
          recipientRecordId: recipient.recordId,
          profileId: recipient.profileId,
          relievingCaseId: null,
          employeeCode: recipient.employeeCode || recipient.historicalRecordId,
          recipientName: recipient.fullName,
          emailMode: evalRes.emailResolution.emailMode,
          resolvedEmail: evalRes.emailResolution.resolvedEmail,
          resolvedSubject: rendered.subject,
          resolvedVariables: vars,
          attachmentName: attName,
        });
      }
    }

    // Deduplicate identical email addresses (prevents duplicate dispatch if personal & work match)
    const { uniqueItems, duplicateItems } = deduplicateRecipientDispatches(candidatesToQueue);
    for (const dup of duplicateItems) {
      skipped.push({
        recordId: dup.recipientRecordId,
        fullName: dup.recipientName,
        reason: `Skipped duplicate target email (${dup.resolvedEmail}).`,
      });
    }

    if (uniqueItems.length === 0) {
      throw new Error(
        skipped[0]?.reason ?? "No eligible recipients remain after validation and deduplication.",
      );
    }

    const personalEmailCount = uniqueItems.filter((i) => i.emailMode === "personal").length;
    const workEmailCount = uniqueItems.filter((i) => i.emailMode === "work").length;

    const batchId = crypto.randomUUID();
    const { data: createdBatch, error: batchErr } = await db
      .from("email_dispatch_batches")
      .insert({
        id: batchId,
        idempotency_key: data.idempotencyKey.trim(),
        dispatch_kind: data.dispatchKind,
        template_slug: templateSlug,
        custom_template_id: customTemplate?.id ?? null,
        template_name: templateName,
        template_version: customTemplate?.version ?? null,
        subject_template:
          customTemplate?.subjectTemplate ??
          relievingCoverDef?.subjectTemplate ??
          "Official Relieving & Experience Letter — {{employee_name}}",
        default_email_mode: data.defaultEmailMode,
        attachment_filename:
          customTemplate?.attachmentFilename ??
          (data.dispatchKind === "relieving_bulk" ? "Experience_Letter_<Employee>.pdf" : null),
        attachment_format:
          customTemplate?.attachmentFormat ??
          (data.dispatchKind === "relieving_bulk" ? "pdf" : null),
        status: "queued",
        total_count: uniqueItems.length,
        queued_count: uniqueItems.length,
        accepted_count: 0,
        failed_count: 0,
        canceled_count: 0,
        skipped_count: skipped.length,
        personal_email_count: personalEmailCount,
        work_email_count: workEmailCount,
        created_by: context.userId,
      })
      .select("*")
      .single();

    if (batchErr) rethrowDbError("Creating bulk dispatch batch failed", batchErr);

    const itemRows = uniqueItems.map((item) => ({
      batch_id: batchId,
      idempotency_key: `${batchId}:${item.recipientRecordId}:${item.resolvedEmail}`,
      recipient_record_id: item.recipientRecordId,
      profile_id: item.profileId,
      relieving_case_id: item.relievingCaseId,
      employee_code: item.employeeCode,
      recipient_name: item.recipientName,
      email_mode: item.emailMode,
      recipient_email: item.resolvedEmail,
      resolved_subject: item.resolvedSubject,
      resolved_variables: item.resolvedVariables,
      attachment_name: item.attachmentName,
      status: "queued",
      attempts: 0,
      provider: "hostinger_smtp",
    }));

    for (let i = 0; i < itemRows.length; i += 200) {
      const slice = itemRows.slice(i, i + 200);
      const { error: itemErr } = await db.from("email_dispatch_items").insert(slice);
      if (itemErr) rethrowDbError("Queuing bulk dispatch recipients failed", itemErr);
    }

    await writeAudit(context.supabase, {
      actorId: context.userId,
      action: "email_center.bulk_batch_created",
      entityType: "email_dispatch_batch",
      entityId: batchId,
      detail: {
        dispatchKind: data.dispatchKind,
        templateName,
        totalQueued: uniqueItems.length,
        skippedCount: skipped.length,
        personalEmailCount,
        workEmailCount,
      },
    });

    return {
      deduplicated: false,
      batch: mapBatchRow(createdBatch),
      skipped,
    };
  });

/**
 * 8. Processes the next bounded chunk of a durable bulk dispatch batch via Hostinger SMTP.
 */
export const processBulkDispatchChunk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { batchId: string; chunkSize?: number }) => {
    if (!input?.batchId) throw new Error("Batch ID is required.");
    return {
      batchId: input.batchId,
      chunkSize: Math.min(DISPATCH_CHUNK_SIZE, Math.max(1, Number(input.chunkSize ?? 10))),
    };
  })
  .handler(async ({ data, context }) => {
    const actor = await loadActor(context.supabase, context.userId);
    const access = resolveEmailCenterAccessPolicy(actor.roles, actor.permissions);
    if (!access.canSendEmails) {
      throw new Error("Forbidden: Only HR or Super Admin can dispatch email batches.");
    }

    const providerStatus = inspectEmailProviderConfig();
    if (!providerStatus.configured) {
      throw new Error(`Hostinger SMTP unavailable: ${providerStatus.issues.join(" ")}`);
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);

    const { data: batchRow, error: bErr } = await db
      .from("email_dispatch_batches")
      .select("*")
      .eq("id", data.batchId)
      .maybeSingle();

    if (bErr) rethrowDbError("Loading dispatch batch failed", bErr);
    if (!batchRow) throw new Error("Dispatch batch not found.");
    if (batchRow.status === "canceled") {
      return {
        batch: mapBatchRow(batchRow),
        processedInChunk: 0,
        remainingQueued: 0,
      };
    }

    if (!batchRow.started_at) {
      await db
        .from("email_dispatch_batches")
        .update({ status: "processing", started_at: new Date().toISOString() })
        .eq("id", batchRow.id);
    }

    const { data: queuedItems, error: qErr } = await db
      .from("email_dispatch_items")
      .select("*")
      .eq("batch_id", batchRow.id)
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(data.chunkSize);

    if (qErr) rethrowDbError("Claiming dispatch chunk failed", qErr);

    const items = (queuedItems ?? []) as any[];
    if (items.length === 0) {
      const updatedBatch = await recalculateBatchCounts(db, batchRow.id);
      return {
        batch: updatedBatch,
        processedInChunk: 0,
        remainingQueued: updatedBatch.queuedCount,
      };
    }

    let customTemplateRow: any = null;
    let customAttachmentBytes: Uint8Array | null = null;
    if (batchRow.dispatch_kind === "custom_template_bulk" && batchRow.custom_template_id) {
      const { data: tplRow } = await db
        .from("custom_email_templates")
        .select("*")
        .eq("id", batchRow.custom_template_id)
        .maybeSingle();
      customTemplateRow = tplRow;

      if (tplRow?.attachment_path) {
        const dl = await supabaseAdmin.storage
          .from(CUSTOM_TEMPLATES_BUCKET)
          .download(tplRow.attachment_path);
        if (!dl.error && dl.data) {
          customAttachmentBytes = new Uint8Array(await dl.data.arrayBuffer());
        }
      }
    }

    const portalUrl = resolveEmailPortalUrl();
    const relievingCoverDef = DEFAULT_EMAIL_TEMPLATES.find(
      (t) => t.slug === "employee_relieving_letter",
    );
    const transport = createHostingerSmtpTransport();

    // Load relieving cases for items in this chunk when relieving_bulk
    const relievingCaseIds = items
      .map((it) => it.relieving_case_id)
      .filter((v): v is string => Boolean(v));
    const rcMap = new Map<string, any>();
    if (relievingCaseIds.length > 0) {
      const { data: rcRows } = await db
        .from("relieving_cases")
        .select("*")
        .in("id", relievingCaseIds);
      for (const r of (rcRows ?? []) as any[]) {
        rcMap.set(r.id, r);
      }
    }

    let processedCount = 0;

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx]!;
      const vars = (item.resolved_variables ?? {}) as Record<string, string>;

      try {
        let subject = item.resolved_subject;
        let bodyHtml = "";
        let bodyText = "";
        const attachments: { filename: string; content: Buffer; contentType: string }[] = [];

        if (batchRow.dispatch_kind === "relieving_bulk") {
          const rc = item.relieving_case_id ? rcMap.get(item.relieving_case_id) : null;
          if (!rc || (rc.status !== "approved" && rc.status !== "relieved")) {
            throw new Error("Relieving case is no longer formally approved.");
          }
          const pdfBytes = await generateRelievingLetterPdf({
            employeeName: item.recipient_name,
            designation: rc.designation || vars["designation"] || "Associate",
            legalEmployer: rc.legal_employer || vars["legal_employer"] || "Learning Paths Technologies LLP",
            joiningDate: rc.joining_date || "",
            lastWorkingDay: rc.last_working_day || "",
            relievingEffectiveDate: rc.relieving_effective_date || rc.last_working_day || "",
            letterIssueDate: rc.letter_issue_date || new Date().toISOString().slice(0, 10),
            contributedProjects:
              rc.contributed_projects ||
              `${rc.designation || "Organizational"} initiatives and core projects`,
            performanceStatement: rc.performance_statement || "satisfactory",
            signatoryName: rc.signatory_name || "K. Spandana",
            signatoryTitle: rc.signatory_title || "HR - Director",
            signatoryDesignation: rc.signatory_designation || "Director",
            companyContact: rc.company_contact || "+91 92468 18843",
            companyAddress:
              rc.company_address || "T-hub 2.0, Knowledge City, Hyderabad, Telangana",
            isDraft: false,
            includeSignature: true,
          });
          attachments.push({
            filename: item.attachment_name || "Experience_Letter.pdf",
            content: Buffer.from(pdfBytes),
            contentType: "application/pdf",
          });

          const renderedCover = renderEmailTemplate({
            subjectTemplate:
              relievingCoverDef?.subjectTemplate ??
              "Official Relieving & Experience Letter — {{employee_name}}",
            bodyHtmlTemplate:
              relievingCoverDef?.bodyHtmlTemplate ??
              "<p>Dear {{employee_name}},</p><p>Please find attached your official Relieving &amp; Experience Letter.</p>",
            bodyTextTemplate: relievingCoverDef?.bodyTextTemplate ?? undefined,
            variables: { ...vars, portal_url: portalUrl },
          });
          subject = renderedCover.subject;
          bodyHtml = renderedCover.bodyHtml;
          bodyText = renderedCover.bodyText;
        } else {
          if (!customTemplateRow) {
            throw new Error("Custom template record is missing.");
          }
          const renderedCustom = renderCustomEmailContent({
            subjectTemplate: customTemplateRow.subject_template,
            bodyHtmlTemplate: customTemplateRow.body_html_template,
            bodyTextTemplate: customTemplateRow.body_text_template,
            variables: vars,
          });
          if (renderedCustom.missingPlaceholders.length > 0) {
            throw new Error(
              `Missing required placeholder values: ${renderedCustom.missingPlaceholders.join(", ")}`,
            );
          }
          subject = renderedCustom.subject;
          bodyHtml = renderedCustom.bodyHtml;
          bodyText = renderedCustom.bodyText;

          if (customAttachmentBytes) {
            if (customTemplateRow.attachment_format === "docx") {
              const personalized = personalizeDocxBuffer(customAttachmentBytes, vars);
              if (personalized.missingPlaceholders.length > 0) {
                throw new Error(
                  `Missing DOCX placeholder values: ${personalized.missingPlaceholders.join(", ")}`,
                );
              }
              attachments.push({
                filename: item.attachment_name || customTemplateRow.attachment_filename || "Document.docx",
                content: Buffer.from(personalized.buffer),
                contentType:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              });
            } else if (customTemplateRow.attachment_format === "pdf") {
              if (customTemplateRow.pdf_mode === "fillable") {
                const filled = await personalizeFillablePdf(customAttachmentBytes, vars);
                if (filled.missingPlaceholders.length > 0) {
                  throw new Error(
                    `Missing PDF field values: ${filled.missingPlaceholders.join(", ")}`,
                  );
                }
                attachments.push({
                  filename: item.attachment_name || customTemplateRow.attachment_filename || "Document.pdf",
                  content: Buffer.from(filled.buffer),
                  contentType: "application/pdf",
                });
              } else {
                attachments.push({
                  filename: customTemplateRow.attachment_filename || "Attachment.pdf",
                  content: Buffer.from(customAttachmentBytes),
                  contentType: "application/pdf",
                });
              }
            }
          }
        }

        // Send strictly ONE individualized email per employee (NO CC / NO BCC list)
        const sendResult = await transport.send({
          to: item.recipient_email,
          subject,
          html: bodyHtml,
          text: bodyText,
          idempotencyKey: item.idempotency_key,
          attachments: attachments.length > 0 ? attachments : undefined,
        });

        const nowIso = new Date().toISOString();
        const { data: logMsg } = await db
          .from("email_messages")
          .upsert(
            {
              idempotency_key: item.idempotency_key,
              template_slug:
                batchRow.dispatch_kind === "relieving_bulk"
                  ? "employee_relieving_letter"
                  : `custom:${customTemplateRow?.id ?? "template"}`,
              recipient_email: item.recipient_email,
              recipient_name: item.recipient_name,
              subject,
              body_html: bodyHtml,
              body_text: bodyText,
              variables_payload: vars,
              is_test: false,
              status: sendResult.status,
              provider: sendResult.provider,
              provider_message_id: sendResult.ok ? sendResult.providerMessageId : null,
              smtp_response: sendResult.ok ? sendResult.smtpResponse : null,
              attempts: Math.max(1, Number(item.attempts ?? 0) + sendResult.attemptsUsed),
              error_message: sendResult.ok ? null : sendResult.errorMessage,
              sent_by: context.userId,
              sent_at: sendResult.ok ? nowIso : null,
            },
            { onConflict: "idempotency_key" },
          )
          .select("id")
          .maybeSingle();

        await db
          .from("email_dispatch_items")
          .update({
            status: sendResult.status,
            attempts: Number(item.attempts ?? 0) + Math.max(1, sendResult.attemptsUsed),
            provider_message_id: sendResult.ok ? sendResult.providerMessageId : null,
            smtp_response: sendResult.ok ? sendResult.smtpResponse : null,
            error_message: sendResult.ok ? null : sendResult.errorMessage,
            email_message_id: logMsg?.id ?? null,
            sent_at: sendResult.ok ? nowIso : null,
          })
          .eq("id", item.id);

        if (sendResult.ok && item.relieving_case_id) {
          // NEVER alter relieving_cases.status or profiles.employment_status — track email status only!
          await db
            .from("relieving_cases")
            .update({
              email_status: "accepted_by_smtp",
              email_sent_at: nowIso,
              email_message_id: sendResult.providerMessageId,
              email_error: null,
            })
            .eq("id", item.relieving_case_id);
        } else if (!sendResult.ok && item.relieving_case_id) {
          await db
            .from("relieving_cases")
            .update({
              email_status: "failed",
              email_error: sendResult.errorMessage,
            })
            .eq("id", item.relieving_case_id);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed sending recipient email.";
        await db
          .from("email_dispatch_items")
          .update({
            status: "failed",
            attempts: Number(item.attempts ?? 0) + 1,
            error_message: msg,
          })
          .eq("id", item.id);
      }

      processedCount++;
      if (idx < items.length - 1) {
        await sleep(SMTP_BULK_PACING_MS);
      }
    }

    const updatedBatch = await recalculateBatchCounts(db, batchRow.id);
    return {
      batch: updatedBatch,
      processedInChunk: processedCount,
      remainingQueued: updatedBatch.queuedCount,
    };
  });

/**
 * 9. Lists Bulk Dispatch Batches for Delivery History & Retry.
 */
export const listDispatchBatches = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const actor = await loadActor(context.supabase, context.userId);
    const access = resolveEmailCenterAccessPolicy(actor.roles, actor.permissions);
    if (!access.canReadEmailCenter) {
      throw new Error("Forbidden: You do not have permission to view dispatch history.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);

    const { data: rows, error } = await db
      .from("email_dispatch_batches")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error && isMissingSchemaResourceError(error)) {
      return { schemaReady: false, batches: [] as EmailDispatchBatchRecord[] };
    }
    if (error) rethrowDbError("Listing dispatch batches failed", error);

    return {
      schemaReady: true,
      batches: (rows ?? []).map(mapBatchRow),
    };
  });

/**
 * 10. Loads per-recipient dispatch items inside a specific batch.
 */
export const getDispatchBatchDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { batchId: string }) => {
    if (!input?.batchId) throw new Error("Batch ID is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const actor = await loadActor(context.supabase, context.userId);
    const access = resolveEmailCenterAccessPolicy(actor.roles, actor.permissions);
    if (!access.canReadEmailCenter) {
      throw new Error("Forbidden: You do not have permission to view batch details.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);

    const [batchRes, itemsRes] = await Promise.all([
      db.from("email_dispatch_batches").select("*").eq("id", data.batchId).maybeSingle(),
      db
        .from("email_dispatch_items")
        .select("*")
        .eq("batch_id", data.batchId)
        .order("created_at", { ascending: true }),
    ]);

    if (batchRes.error) rethrowDbError("Loading batch detail failed", batchRes.error);
    if (!batchRes.data) throw new Error("Dispatch batch not found.");
    if (itemsRes.error) rethrowDbError("Loading batch items failed", itemsRes.error);

    return {
      batch: mapBatchRow(batchRes.data),
      items: (itemsRes.data ?? []).map((row: any) =>
        mapBatchItemRow(row, access.canViewPersonalEmails),
      ),
    };
  });

/**
 * 11. Cancels all remaining unsent queued items in a batch safely.
 */
export const cancelQueuedBatchItems = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { batchId: string }) => {
    if (!input?.batchId) throw new Error("Batch ID is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const actor = await loadActor(context.supabase, context.userId);
    const access = resolveEmailCenterAccessPolicy(actor.roles, actor.permissions);
    if (!access.canSendEmails) {
      throw new Error("Forbidden: Only HR or Super Admin can cancel queued email batches.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);

    await db
      .from("email_dispatch_items")
      .update({ status: "canceled", error_message: "Canceled by authorized HR user." })
      .eq("batch_id", data.batchId)
      .eq("status", "queued");

    const batch = await recalculateBatchCounts(db, data.batchId);
    await writeAudit(context.supabase, {
      actorId: context.userId,
      action: "email_center.bulk_batch_canceled",
      entityType: "email_dispatch_batch",
      entityId: data.batchId,
      detail: { canceledCount: batch.canceledCount, acceptedCount: batch.acceptedCount },
    });
    return { batch };
  });

/**
 * 12. Re-queues ONLY failed items (respecting retry limits) in a batch for safe resumption.
 */
export const retryFailedBatchItems = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { batchId: string }) => {
    if (!input?.batchId) throw new Error("Batch ID is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const actor = await loadActor(context.supabase, context.userId);
    const access = resolveEmailCenterAccessPolicy(actor.roles, actor.permissions);
    if (!access.canSendEmails) {
      throw new Error("Forbidden: Only HR or Super Admin can retry failed batch deliveries.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = looseDb(supabaseAdmin);

    const { data: requeued } = await db
      .from("email_dispatch_items")
      .update({ status: "queued" })
      .eq("batch_id", data.batchId)
      .eq("status", "failed")
      .lt("attempts", SMTP_MAX_RETRY_ATTEMPTS)
      .select("id");

    const batch = await recalculateBatchCounts(db, data.batchId);
    return {
      requeuedCount: (requeued ?? []).length,
      batch,
    };
  });
