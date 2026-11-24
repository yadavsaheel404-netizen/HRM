// Server functions for the dedicated Employee Relieving & Experience Letter module

import crypto from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { loadActor, requirePermission, rethrowDbError } from "./actor.server";
import { writeAudit } from "./audit.server";
import type { RelievingCase, RelievingLetterData, RelievingStatus } from "./relieving/types";
import { generateRelievingLetterPdf } from "./relieving/pdf-generator.server";
import { createHostingerSmtpTransport, validateRecipientEmail } from "./recruitment/email-transport.server";

// Dynamic table helper to keep queries type-safe without depending on generated Supabase schema
function fromRelievingCases(supabase: any) {
  return supabase.from("relieving_cases");
}

// Helper to map DB snake_case row to RelievingCase model
function mapDbRowToRelievingCase(row: any): RelievingCase {
  return {
    id: row.id,
    userId: row.user_id,
    createdBy: row.created_by,
    status: row.status,
    employeeName: row.employee_name,
    employeeCode: row.employee_code ?? null,
    workEmail: row.work_email,
    designation: row.designation,
    departmentId: row.department_id ?? null,
    departmentName: row.department_name ?? null,
    employmentCategory: row.employment_category ?? "intern",
    legalEmployer: row.legal_employer ?? "Learning Paths Technologies LLP",
    joiningDate: row.joining_date,
    lastWorkingDay: row.last_working_day,
    relievingEffectiveDate: row.relieving_effective_date,
    letterIssueDate: row.letter_issue_date,
    relievingReason: row.relieving_reason ?? "Tenure completion",
    contributedProjects: row.contributed_projects ?? "Core projects and initiatives",
    performanceStatement: row.performance_statement ?? "satisfactory",
    handoverStatus: row.handover_status ?? "completed",
    projectClearance: Boolean(row.project_clearance),
    assetClearance: Boolean(row.asset_clearance),
    signatoryName: row.signatory_name ?? "K. Spandana",
    signatoryTitle: row.signatory_title ?? "HR - Director",
    signatoryDesignation: row.signatory_designation ?? "Director",
    companyContact: row.company_contact ?? "+91 92468 18843",
    companyAddress: row.company_address ?? "T-hub 2.0, Knowledge City, Hyderabad, Telangana",
    hrNotes: row.hr_notes ?? null,
    checklistHandover: Boolean(row.checklist_handover),
    checklistAssets: Boolean(row.checklist_assets),
    checklistAccessRevocation: Boolean(row.checklist_access_revocation),
    checklistDuesCleared: Boolean(row.checklist_dues_cleared),
    approvedBy: row.approved_by ?? null,
    approvedAt: row.approved_at ?? null,
    relievedBy: row.relieved_by ?? null,
    relievedAt: row.relieved_at ?? null,
    letterPdfPath: row.letter_pdf_path ?? null,
    letterPdfHash: row.letter_pdf_hash ?? null,
    emailStatus: row.email_status ?? "not_sent",
    emailSentAt: row.email_sent_at ?? null,
    emailMessageId: row.email_message_id ?? null,
    emailError: row.email_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Lists relieving cases with status counts and search/tab filtering.
 */
export const listRelievingCases = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input?: { tab?: string; query?: string }) => ({
    tab: input?.tab || "all",
    query: (input?.query || "").trim(),
  }))
  .handler(async ({ data, context }) => {
    const actor = await loadActor(context.supabase, context.userId);
    const hasOrgAccess = actor.permissions.includes("relieving:read:all");
    const hasSelfAccess = actor.permissions.includes("relieving:read:self");

    if (!hasOrgAccess && !hasSelfAccess) {
      throw new Error("Forbidden: You do not have permission to view relieving cases.");
    }

    let query = fromRelievingCases(context.supabase)
      .select("*")
      .order("created_at", { ascending: false });

    // If non-admin/HR employee, only show their own approved/relieved case
    if (!hasOrgAccess) {
      query = query
        .eq("user_id", context.userId)
        .in("status", ["approved", "relieved"]);
    }

    const { data: rows, error } = await query;
    if (error) rethrowDbError("Listing relieving cases failed", error);

    const allCases: RelievingCase[] = (rows || []).map(mapDbRowToRelievingCase);

    // Filter by tab
    let filteredCases = allCases;
    if (data.tab === "drafts") {
      filteredCases = allCases.filter((c) => c.status === "draft");
    } else if (data.tab === "pending_approval") {
      filteredCases = allCases.filter((c) => c.status === "pending_approval");
    } else if (data.tab === "ready_to_relieve") {
      filteredCases = allCases.filter((c) => c.status === "approved");
    } else if (data.tab === "relieved") {
      filteredCases = allCases.filter((c) => c.status === "relieved");
    } else if (data.tab === "letter_sent") {
      filteredCases = allCases.filter(
        (c) => c.emailStatus === "accepted_by_smtp" || c.emailStatus === "delivered"
      );
    } else if (data.tab === "needs_attention") {
      filteredCases = allCases.filter(
        (c) => c.emailStatus === "failed" || !c.checklistHandover || !c.checklistAssets
      );
    }

    // Filter by search query
    if (data.query) {
      const q = data.query.toLowerCase();
      filteredCases = filteredCases.filter(
        (c) =>
          c.employeeName.toLowerCase().includes(q) ||
          c.workEmail.toLowerCase().includes(q) ||
          (c.employeeCode && c.employeeCode.toLowerCase().includes(q)) ||
          c.designation.toLowerCase().includes(q) ||
          (c.departmentName && c.departmentName.toLowerCase().includes(q))
      );
    }

    // Calculate metrics
    const metrics = {
      total: allCases.length,
      drafts: allCases.filter((c) => c.status === "draft").length,
      pendingApproval: allCases.filter((c) => c.status === "pending_approval").length,
      readyToRelieve: allCases.filter((c) => c.status === "approved").length,
      relieved: allCases.filter((c) => c.status === "relieved").length,
      letterSent: allCases.filter(
        (c) => c.emailStatus === "accepted_by_smtp" || c.emailStatus === "delivered"
      ).length,
      needsAttention: allCases.filter(
        (c) => c.emailStatus === "failed" || !c.checklistHandover || !c.checklistAssets
      ).length,
    };

    return {
      cases: filteredCases,
      metrics,
      canManage: actor.permissions.includes("relieving:manage:all"),
      canApprove: actor.permissions.includes("relieving:approve:all"),
      canSend: actor.permissions.includes("relieving:send:all"),
    };
  });

/**
 * Searches workforce employees eligible for relieving.
 * Excludes Super Admin and self.
 */
export const searchRelievingEligibleEmployees = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input?: { query?: string }) => ({
    query: (input?.query || "").trim(),
  }))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "relieving:manage:all");

    // Fetch active/registered workforce profiles
    const { data: profiles, error: pError } = await context.supabase
      .from("profiles")
      .select(
        "id, full_name, work_email, personal_email, employee_code, designation, department_id, category, joining_date, employment_status"
      )
      .neq("employment_status" as any, "relieved")
      .neq("id", context.userId)
      .order("full_name");

    if (pError) rethrowDbError("Searching eligible employees failed", pError);

    // Fetch Super Admin roles to strictly exclude Super Admin from relieving
    const { data: superAdmins } = await context.supabase
      .from("user_roles")
      .select("user_id")
      .eq("role", "super_admin");

    const superAdminIds = new Set((superAdmins || []).map((r) => r.user_id));

    // Fetch departments for friendly names
    const { data: depts } = await context.supabase
      .from("departments")
      .select("id, name");
    const deptMap = new Map((depts || []).map((d) => [d.id, d.name]));

    const eligible = (profiles || [])
      .filter((p) => !superAdminIds.has(p.id))
      .filter((p) => {
        if (!data.query) return true;
        const q = data.query.toLowerCase();
        return (
          p.full_name.toLowerCase().includes(q) ||
          p.work_email.toLowerCase().includes(q) ||
          (p.employee_code && p.employee_code.toLowerCase().includes(q))
        );
      })
      .map((p) => ({
        id: p.id,
        fullName: p.full_name,
        workEmail: p.work_email,
        personalEmail: p.personal_email,
        employeeCode: p.employee_code,
        designation: p.designation || "AI Data Associate Intern",
        departmentId: p.department_id,
        departmentName: p.department_id ? deptMap.get(p.department_id) || null : null,
        category: p.category || "intern",
        joiningDate: p.joining_date || new Date().toISOString().slice(0, 10),
        employmentStatus: p.employment_status,
      }));

    return { employees: eligible };
  });

/**
 * Gets a single relieving case by ID.
 */
export const getRelievingCase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { id: string }) => {
    if (!input?.id) throw new Error("A relieving case ID is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const actor = await loadActor(context.supabase, context.userId);
    const hasOrgAccess = actor.permissions.includes("relieving:read:all");

    const { data: row, error } = await fromRelievingCases(context.supabase)
      .select("*")
      .eq("id", data.id)
      .maybeSingle();

    if (error) rethrowDbError("Fetching relieving case failed", error);
    if (!row) throw new Error("Relieving case not found.");

    if (!hasOrgAccess && row.user_id !== context.userId) {
      throw new Error("Forbidden: You do not have access to this relieving record.");
    }

    return {
      caseItem: mapDbRowToRelievingCase(row),
      canManage: actor.permissions.includes("relieving:manage:all"),
      canApprove: actor.permissions.includes("relieving:approve:all"),
      canSend: actor.permissions.includes("relieving:send:all"),
    };
  });

/**
 * Saves a relieving case draft or submits it for approval.
 */
export const saveRelievingCase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: {
    id?: string | undefined;
    userId: string;
    status?: "draft" | "pending_approval";
    employeeName: string;
    employeeCode?: string;
    workEmail: string;
    designation: string;
    departmentId?: string | null;
    departmentName?: string | null;
    employmentCategory?: string;
    legalEmployer?: string;
    joiningDate: string;
    lastWorkingDay: string;
    relievingEffectiveDate: string;
    letterIssueDate?: string;
    relievingReason?: string;
    contributedProjects: string;
    performanceStatement?: string;
    handoverStatus?: "pending" | "in_progress" | "completed" | "waived";
    projectClearance?: boolean;
    assetClearance?: boolean;
    signatoryName?: string;
    signatoryTitle?: string;
    signatoryDesignation?: string;
    companyContact?: string;
    companyAddress?: string;
    hrNotes?: string;
    checklistHandover?: boolean;
    checklistAssets?: boolean;
    checklistAccessRevocation?: boolean;
    checklistDuesCleared?: boolean;
  }) => {
    if (!input.userId) throw new Error("An employee must be selected.");
    if (!input.employeeName) throw new Error("Employee name is required.");
    if (!input.workEmail) throw new Error("Employee work email is required.");
    if (!input.designation) throw new Error("Designation is required.");
    if (!input.joiningDate) throw new Error("Joining date is required.");
    if (!input.lastWorkingDay) throw new Error("Last working day is required.");
    if (!input.relievingEffectiveDate) throw new Error("Relieving effective date is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "relieving:manage:all");

    // Guardrail: Never relieve Super Admin
    const { data: targetRoles } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", data.userId);
    if ((targetRoles || []).some((r) => r.role === "super_admin")) {
      throw new Error("Security Violation: Super Admin accounts cannot be relieved.");
    }

    // Guardrail: Never relieve self
    if (data.userId === context.userId) {
      throw new Error("Security Violation: Self-relieving is strictly prohibited.");
    }

    const payload = {
      user_id: data.userId,
      created_by: context.userId,
      status: data.status || "draft",
      employee_name: data.employeeName.trim(),
      employee_code: data.employeeCode?.trim() || null,
      work_email: data.workEmail.trim(),
      designation: data.designation.trim(),
      department_id: data.departmentId || null,
      department_name: data.departmentName || null,
      employment_category: data.employmentCategory || "intern",
      legal_employer: data.legalEmployer || "Learning Paths Technologies LLP",
      joining_date: data.joiningDate,
      last_working_day: data.lastWorkingDay,
      relieving_effective_date: data.relievingEffectiveDate,
      letter_issue_date: data.letterIssueDate || new Date().toISOString().slice(0, 10),
      relieving_reason: data.relievingReason || "Tenure completion",
      contributed_projects: data.contributedProjects.trim(),
      performance_statement: data.performanceStatement || "satisfactory",
      handover_status: data.handoverStatus || "completed",
      project_clearance: data.projectClearance ?? true,
      asset_clearance: data.assetClearance ?? true,
      signatory_name: data.signatoryName || "K. Spandana",
      signatory_title: data.signatoryTitle || "HR - Director",
      signatory_designation: data.signatoryDesignation || "Director",
      company_contact: data.companyContact || "+91 92468 18843",
      company_address: data.companyAddress || "T-hub 2.0, Knowledge City, Hyderabad, Telangana",
      hr_notes: data.hrNotes || null,
      checklist_handover: data.checklistHandover ?? true,
      checklist_assets: data.checklistAssets ?? true,
      checklist_access_revocation: data.checklistAccessRevocation ?? true,
      checklist_dues_cleared: data.checklistDuesCleared ?? true,
    };

    let resultId = data.id;

    if (data.id) {
      const { error } = await fromRelievingCases(context.supabase)
        .update(payload)
        .eq("id", data.id);
      if (error) rethrowDbError("Updating relieving case draft failed", error);
    } else {
      const { data: inserted, error } = await fromRelievingCases(context.supabase)
        .insert(payload)
        .select("id")
        .single();
      if (error) rethrowDbError("Creating relieving case draft failed", error);
      resultId = inserted.id;
    }

    await writeAudit(context.supabase, {
      actorId: context.userId,
      action: data.id ? "relieving.case_updated" : "relieving.case_created",
      entityType: "relieving_case",
      entityId: resultId!,
      detail: {
        employeeName: data.employeeName,
        status: payload.status,
      },
    });

    return { id: resultId };
  });

/**
 * Approves a relieving case (HR or Super Admin approval).
 */
export const approveRelievingCase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { id: string }) => {
    if (!input?.id) throw new Error("A relieving case ID is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "relieving:approve:all");

    const now = new Date().toISOString();
    const { error } = await fromRelievingCases(context.supabase)
      .update({
        status: "approved",
        approved_by: context.userId,
        approved_at: now,
      })
      .eq("id", data.id);

    if (error) rethrowDbError("Approving relieving case failed", error);

    await writeAudit(context.supabase, {
      actorId: context.userId,
      action: "relieving.approved",
      entityType: "relieving_case",
      entityId: data.id,
      detail: { approvedAt: now },
    });

    return { ok: true };
  });

/**
 * Formally relieves the employee:
 * - Generates the official final PDF (isDraft: false).
 * - Stores it in the private `relieving-documents` bucket.
 * - Updates the case status to 'relieved'.
 * - Updates public.profiles employment_status to 'relieved'.
 * - Preserves all attendance records, projects, and KYC.
 */
export const finalizeAndRelieveEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { id: string }) => {
    if (!input?.id) throw new Error("A relieving case ID is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "relieving:manage:all");

    const { data: row, error } = await fromRelievingCases(context.supabase)
      .select("*")
      .eq("id", data.id)
      .single();

    if (error) rethrowDbError("Fetching case for finalization failed", error);
    if (!row) throw new Error("Relieving case not found.");

    if (row.status !== "approved" && row.status !== "relieved") {
      throw new Error("Case must be approved before formally relieving the employee.");
    }

    // 1. Generate official final PDF without draft watermark
    const letterData: RelievingLetterData = {
      employeeName: row.employee_name,
      designation: row.designation,
      legalEmployer: row.legal_employer,
      joiningDate: row.joining_date,
      lastWorkingDay: row.last_working_day,
      relievingEffectiveDate: row.relieving_effective_date,
      letterIssueDate: row.letter_issue_date,
      contributedProjects: row.contributed_projects,
      performanceStatement: row.performance_statement,
      signatoryName: row.signatory_name,
      signatoryTitle: row.signatory_title,
      signatoryDesignation: row.signatory_designation,
      companyContact: row.company_contact,
      companyAddress: row.company_address,
      isDraft: false,
    };

    const pdfBytes = await generateRelievingLetterPdf(letterData);
    const pdfBuffer = Buffer.from(pdfBytes);
    const pdfHash = crypto.createHash("sha256").update(pdfBuffer).digest("hex");
    const storagePath = `letters/${row.id}.pdf`;

    // 2. Upload to private relieving-documents bucket
    const { error: uploadErr } = await context.supabase.storage
      .from("relieving-documents")
      .upload(storagePath, pdfBuffer, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (uploadErr) {
      console.warn("Storage upload warning (proceeding):", uploadErr.message);
    }

    const now = new Date().toISOString();

    // 3. Mark case as relieved
    const { error: updCaseErr } = await fromRelievingCases(context.supabase)
      .update({
        status: "relieved",
        relieved_by: context.userId,
        relieved_at: now,
        letter_pdf_path: storagePath,
        letter_pdf_hash: pdfHash,
      })
      .eq("id", row.id);

    if (updCaseErr) rethrowDbError("Updating case status to relieved failed", updCaseErr);

    // 4. Update employee employment_status to 'relieved'
    const { error: profErr } = await context.supabase
      .from("profiles")
      .update({
        employment_status: "relieved" as any,
      })
      .eq("id", row.user_id);

    if (profErr) rethrowDbError("Updating employee profile to relieved failed", profErr);

    await writeAudit(context.supabase, {
      actorId: context.userId,
      action: "relieving.finalized",
      entityType: "relieving_case",
      entityId: row.id,
      detail: {
        userId: row.user_id,
        employeeName: row.employee_name,
        pdfHash,
      },
    });

    return { ok: true, storagePath };
  });

/**
 * Generates base64 PDF preview (draft or official).
 */
export const previewRelievingLetter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: {
    caseId?: string;
    letterData?: RelievingLetterData;
    isDraft?: boolean;
  }) => input)
  .handler(async ({ data, context }) => {
    let letterData = data.letterData;

    if (data.caseId) {
      const { data: row, error } = await fromRelievingCases(context.supabase)
        .select("*")
        .eq("id", data.caseId)
        .single();
      if (error) rethrowDbError("Fetching case for preview failed", error);

      letterData = {
        employeeName: row.employee_name,
        designation: row.designation,
        legalEmployer: row.legal_employer,
        joiningDate: row.joining_date,
        lastWorkingDay: row.last_working_day,
        relievingEffectiveDate: row.relieving_effective_date,
        letterIssueDate: row.letter_issue_date,
        contributedProjects: row.contributed_projects,
        performanceStatement: row.performance_statement,
        signatoryName: row.signatory_name,
        signatoryTitle: row.signatory_title,
        signatoryDesignation: row.signatory_designation,
        companyContact: row.company_contact,
        companyAddress: row.company_address,
        isDraft: data.isDraft ?? true,
      };
    }

    if (!letterData) {
      throw new Error("No letter data provided for preview.");
    }

    const isDraft = data.isDraft !== undefined ? data.isDraft : true;
    const pdfBytes = await generateRelievingLetterPdf({ ...letterData, isDraft });
    const base64 = Buffer.from(pdfBytes).toString("base64");

    return {
      base64,
      byteLength: pdfBytes.length,
      mimeType: "application/pdf",
    };
  });

/**
 * Sends official relieving and experience letter to employee via Hostinger SMTP.
 */
export const sendRelievingLetterEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { id: string }) => {
    if (!input?.id) throw new Error("A relieving case ID is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "relieving:send:all");

    const { data: row, error } = await fromRelievingCases(context.supabase)
      .select("*")
      .eq("id", data.id)
      .single();

    if (error) rethrowDbError("Fetching case for email dispatch failed", error);
    if (!row) throw new Error("Relieving case not found.");

    if (row.status !== "approved" && row.status !== "relieved") {
      throw new Error("Relieving letter must be approved before email dispatch.");
    }

    const checkRecip = validateRecipientEmail(row.work_email);
    if (!checkRecip.valid) {
      throw new Error(`Invalid employee work email: ${row.work_email}`);
    }

    // Generate official final PDF for attachment
    const letterData: RelievingLetterData = {
      employeeName: row.employee_name,
      designation: row.designation,
      legalEmployer: row.legal_employer,
      joiningDate: row.joining_date,
      lastWorkingDay: row.last_working_day,
      relievingEffectiveDate: row.relieving_effective_date,
      letterIssueDate: row.letter_issue_date,
      contributedProjects: row.contributed_projects,
      performanceStatement: row.performance_statement,
      signatoryName: row.signatory_name,
      signatoryTitle: row.signatory_title,
      signatoryDesignation: row.signatory_designation,
      companyContact: row.company_contact,
      companyAddress: row.company_address,
      isDraft: false,
    };

    const pdfBytes = await generateRelievingLetterPdf(letterData);
    const pdfBuffer = Buffer.from(pdfBytes);
    const safeName = row.employee_name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const attachmentFileName = `Experience_Letter_${safeName}.pdf`;

    const transport = createHostingerSmtpTransport();
    const idempotencyKey = `relieving-${row.id}-${Date.now()}`;

    const htmlBody = `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 620px; margin: 0 auto; padding: 24px; color: #1e293b; line-height: 1.6; background-color: #ffffff;">
        <div style="border-bottom: 2px solid #ef4444; padding-bottom: 16px; margin-bottom: 24px;">
          <h2 style="color: #0f172a; margin: 0; font-size: 20px;">The AI School</h2>
          <p style="color: #64748b; margin: 4px 0 0; font-size: 13px;">Learning Paths Technologies LLP</p>
        </div>

        <p style="font-size: 15px;">Dear <strong>${row.employee_name}</strong>,</p>

        <p style="font-size: 14px;">
          We would like to thank you for your contributions during your tenure as <strong>${row.designation}</strong> with <strong>${row.legal_employer}</strong>.
        </p>

        <p style="font-size: 14px;">
          Please find attached your official <strong>Experience & Relieving Letter</strong> effective close of business on <strong>${row.relieving_effective_date}</strong>.
        </p>

        <div style="background-color: #f8fafc; border-left: 4px solid #3b82f6; padding: 14px 16px; margin: 20px 0; border-radius: 4px;">
          <p style="margin: 0; font-size: 13px; color: #334155;">
            <strong>Document Issued:</strong> Official Experience Letter & Relieving Certification<br/>
            <strong>Designation:</strong> ${row.designation}<br/>
            <strong>Effective Relieving Date:</strong> ${row.relieving_effective_date}
          </p>
        </div>

        <p style="font-size: 14px;">
          We wish you the very best in your academic, professional, and future career endeavors.
        </p>

        <div style="margin-top: 32px; border-top: 1px solid #e2e8f0; padding-top: 16px;">
          <p style="margin: 0; font-size: 13px; font-weight: bold; color: #0f172a;">The AI School HR Team</p>
          <p style="margin: 2px 0 0; font-size: 12px; color: #64748b;">Learning Paths Technologies LLP</p>
          <p style="margin: 2px 0 0; font-size: 12px; color: #64748b;">T-hub 2.0, Knowledge City, Hyderabad, Telangana</p>
        </div>
      </div>
    `;

    const sendRes = await transport.send({
      to: row.work_email,
      subject: `Experience & Relieving Letter — ${row.employee_name}`,
      html: htmlBody,
      idempotencyKey,
      attachments: [
        {
          filename: attachmentFileName,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    });

    const now = new Date().toISOString();

    if (sendRes.ok) {
      await fromRelievingCases(context.supabase)
        .update({
          email_status: "accepted_by_smtp",
          email_sent_at: now,
          email_message_id: sendRes.providerMessageId,
          email_error: null,
        })
        .eq("id", row.id);

      await writeAudit(context.supabase, {
        actorId: context.userId,
        action: "relieving.email_sent",
        entityType: "relieving_case",
        entityId: row.id,
        detail: {
          recipient: row.work_email,
          providerMessageId: sendRes.providerMessageId,
        },
      });

      return { ok: true, status: "accepted_by_smtp", messageId: sendRes.providerMessageId };
    } else {
      await fromRelievingCases(context.supabase)
        .update({
          email_status: "failed",
          email_error: sendRes.errorMessage,
        })
        .eq("id", row.id);

      throw new Error(`Email delivery failed: ${sendRes.errorMessage}`);
    }
  });
