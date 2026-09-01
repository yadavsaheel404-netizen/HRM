import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, requireSelfOrPermission, rethrowDbError } from "./actor.server";
import { needsReportingLead } from "./request-routing";


const PROFILE_SELECT =
  "id, full_name, work_email, personal_email, mobile, category, designation, department_id, reporting_lead_id, joining_date, work_location, account_status, employment_status, employee_code, photo_url, date_of_birth, current_address, permanent_address, emergency_contact_name, emergency_contact_phone, skills, experience_years, institution, internship_start, internship_end, available_hours_per_day, profile_submitted_at, profile_verified_at, needs_assignment, created_at";

export type ProfileDraft = {
  fullName?: string;
  personalEmail?: string | null;
  mobile?: string | null;
  dateOfBirth?: string | null;
  currentAddress?: string | null;
  permanentAddress?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  skills?: string[] | null;
  experienceYears?: number | null;
  institution?: string | null;
  internshipStart?: string | null;
  internshipEnd?: string | null;
  availableHoursPerDay?: number | null;
  photoUrl?: string | null;
};

/** Reference data used by every form in the portal. */
export const getOrgReference = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [{ data: departments }, { data: leads }] = await Promise.all([
      context.supabase.from("departments").select("id, name, code").order("name"),
      context.supabase
        .from("profiles")
        .select("id, full_name, designation")
        .eq("employment_status", "active")
        .order("full_name"),
    ]);
    return { departments: departments ?? [], people: leads ?? [] };
  });

export const getMyProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("profiles")
      .select(PROFILE_SELECT)
      .eq("id", context.userId)
      .maybeSingle();
    if (error) rethrowDbError("Loading your profile failed", error);
    return data;
  });

/**
 * RLS decides the row set here — Founder/HR see the whole org, a Lead sees
 * their reports plus themselves, an Employee sees only themselves.
 */
export const listWorkforce = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [{ data: profiles, error }, { data: roles }] = await Promise.all([
      context.supabase.from("profiles").select(PROFILE_SELECT).order("full_name"),
      context.supabase.from("user_roles").select("user_id, role"),
    ]);
    if (error) throw error;

    const roleMap = new Map<string, string[]>();
    for (const row of roles ?? []) {
      roleMap.set(row.user_id, [...(roleMap.get(row.user_id) ?? []), row.role]);
    }
    return (profiles ?? []).map((profile) => {
      const personRoles = roleMap.get(profile.id) ?? [];
      return {
        ...profile,
        roles: personRoles,
        // Staff with no reporting lead cannot submit leave / WFH requests at all —
        // the dual-tier approval has nobody to route to. Surfaced so HR can fix it
        // before the person hits the block.
        missingReportingLead: needsReportingLead({
          roles: personRoles,
          employmentStatus: profile.employment_status,
          reportingLeadId: profile.reporting_lead_id,
        }),
      };
    });

  });

export const getWorkforceMember = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => {
    if (!input?.id) throw new Error("A person id is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const [{ data: profile, error }, { data: roles }, { data: documents }] = await Promise.all([
      context.supabase.from("profiles").select(PROFILE_SELECT).eq("id", data.id).maybeSingle(),
      context.supabase.from("user_roles").select("role").eq("user_id", data.id),
      context.supabase
        .from("documents")
        .select("id, doc_type, file_name, file_path, status, review_note, reviewed_at, created_at")
        .eq("user_id", data.id)
        .order("created_at", { ascending: false }),
    ]);
    if (error) throw error;
    if (!profile) throw new Error("This person is not visible to you.");
    return {
      profile,
      roles: (roles ?? []).map((r) => r.role),
      documents: documents ?? [],
    };
  });

export const updateMyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: ProfileDraft) => {
    if (input.fullName !== undefined && String(input.fullName).trim().length < 2) {
      throw new Error("Full name is required.");
    }
    if (input.mobile && !/^[+0-9\-\s()]{7,20}$/.test(input.mobile)) {
      throw new Error("Enter a valid mobile number.");
    }
    if (
      input.availableHoursPerDay != null &&
      (input.availableHoursPerDay < 1 || input.availableHoursPerDay > 24)
    ) {
      throw new Error("Available hours per day must be between 1 and 24.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const patch: Record<string, unknown> = {};
    if (data.fullName !== undefined) patch["full_name"] = data.fullName.trim();
    if (data.personalEmail !== undefined) patch["personal_email"] = data.personalEmail || null;
    if (data.mobile !== undefined) patch["mobile"] = data.mobile || null;
    if (data.dateOfBirth !== undefined) patch["date_of_birth"] = data.dateOfBirth || null;
    if (data.currentAddress !== undefined) patch["current_address"] = data.currentAddress || null;
    if (data.permanentAddress !== undefined)
      patch["permanent_address"] = data.permanentAddress || null;
    if (data.emergencyContactName !== undefined)
      patch["emergency_contact_name"] = data.emergencyContactName || null;
    if (data.emergencyContactPhone !== undefined)
      patch["emergency_contact_phone"] = data.emergencyContactPhone || null;
    if (data.skills !== undefined) patch["skills"] = data.skills ?? [];
    if (data.experienceYears !== undefined) patch["experience_years"] = data.experienceYears;
    if (data.institution !== undefined) patch["institution"] = data.institution || null;
    if (data.internshipStart !== undefined) patch["internship_start"] = data.internshipStart || null;
    if (data.internshipEnd !== undefined) patch["internship_end"] = data.internshipEnd || null;
    if (data.availableHoursPerDay !== undefined)
      patch["available_hours_per_day"] = data.availableHoursPerDay;
    if (data.photoUrl !== undefined) patch["photo_url"] = data.photoUrl || null;

    const { error } = await context.supabase
      .from("profiles")
      .update(patch as never)
      .eq("id", context.userId);
    if (error) throw error;

    await context.supabase
      .from("profiles")
      .update({ account_status: "profile_pending" })
      .eq("id", context.userId)
      .eq("account_status", "activated");

    return { ok: true };
  });

/** Employee action: lock the profile and hand it to HR for verification. */
export const submitProfileForVerification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const [{ data: profile }, { data: documents }] = await Promise.all([
      supabase
        .from("profiles")
        .select("full_name, mobile, personal_email, category, account_status")
        .eq("id", userId)
        .maybeSingle(),
      supabase.from("documents").select("doc_type").eq("user_id", userId),
    ]);

    if (!profile) throw new Error("Profile not found.");

    const missing: string[] = [];
    if (!profile.full_name?.trim()) missing.push("Full name");
    if (!profile.mobile?.trim()) missing.push("Mobile number");
    if (!profile.personal_email?.trim()) missing.push("Personal email");

    const { REQUIRED_DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS } = await import("./permissions");
    const uploaded = new Set((documents ?? []).map((d) => d.doc_type));
    for (const docType of REQUIRED_DOCUMENT_TYPES) {
      if (!uploaded.has(docType)) missing.push(DOCUMENT_TYPE_LABELS[docType]);
    }

    if (missing.length > 0) {
      return { ok: false as const, missing };
    }

    const { error } = await supabase
      .from("profiles")
      .update({
        account_status: "under_verification",
        profile_submitted_at: new Date().toISOString(),
      })
      .eq("id", userId);
    if (error) throw error;

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: "profile.submitted",
      entityType: "profile",
      entityId: userId,
    });

    return { ok: true as const, missing: [] as string[] };
  });

/** HR/Admin action: verify or send back a submitted profile. */
export const reviewProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string; approve: boolean; note?: string }) => {
    if (!input?.userId) throw new Error("A person id is required.");
    if (!input.approve && !input.note?.trim()) {
      throw new Error("Explain what needs fixing when sending a profile back.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "documents:verify:all");

    const { error } = await supabase
      .from("profiles")
      .update(
        data.approve
          ? {
              account_status: "active",
              employment_status: "active",
              profile_verified_at: new Date().toISOString(),
              profile_verified_by: userId,
              needs_assignment: true,
            }
          : { account_status: "profile_pending", profile_submitted_at: null },
      )
      .eq("id", data.userId);
    if (error) throw error;

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: data.approve ? "profile.verified" : "profile.returned",
      entityType: "profile",
      entityId: data.userId,
      detail: { note: data.note ?? null },
    });

    return { ok: true };
  });

/** HR/Admin action: employment details that the person may not edit themselves. */
export const updateEmploymentDetails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      userId: string;
      designation?: string | null;
      departmentId?: string | null;
      reportingLeadId?: string | null;
      joiningDate?: string | null;
      workLocation?: string | null;
      employeeCode?: string | null;
      category?: string;
      employmentStatus?: string;
    }) => {
      if (!input?.userId) throw new Error("A person id is required.");
      if (input.reportingLeadId && input.reportingLeadId === input.userId) {
        throw new Error("A person cannot report to themselves.");
      }
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "workforce:update:all");

    const patch: Record<string, unknown> = {};
    if (data.designation !== undefined) patch["designation"] = data.designation || null;
    if (data.departmentId !== undefined) patch["department_id"] = data.departmentId || null;
    if (data.reportingLeadId !== undefined) {
      patch["reporting_lead_id"] = data.reportingLeadId || null;
      // Keep the "needs a reporting lead" surface honest in both directions.
      patch["needs_assignment"] = !data.reportingLeadId;
    }
    if (data.joiningDate !== undefined) patch["joining_date"] = data.joiningDate || null;
    if (data.workLocation !== undefined) patch["work_location"] = data.workLocation || null;
    if (data.employeeCode !== undefined) patch["employee_code"] = data.employeeCode || null;
    if (data.category !== undefined) patch["category"] = data.category;
    if (data.employmentStatus !== undefined) patch["employment_status"] = data.employmentStatus;

    const { error } = await supabase
      .from("profiles")
      .update(patch as never)
      .eq("id", data.userId);
    if (error) throw error;

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: "profile.employment_updated",
      entityType: "profile",
      entityId: data.userId,
      detail: patch,
    });
    return { ok: true };
  });

export const getProfileDocuments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string }) => {
    if (!input?.userId) throw new Error("A person id is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    await requireSelfOrPermission(
      context.supabase,
      context.userId,
      data.userId,
      "documents:read:all",
    );
    const { data: documents, error } = await context.supabase
      .from("documents")
      .select("id, doc_type, file_name, file_path, status, review_note, reviewed_at, created_at")
      .eq("user_id", data.userId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return documents ?? [];
  });

/** Option A: Send Supabase built-in password reset email (Super Admin, Admin, HR). */
export const sendEmployeePasswordResetEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string }) => {
    if (!input?.userId) throw new Error("User ID is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "workforce:update:all");

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id, work_email, full_name")
      .eq("id", data.userId)
      .maybeSingle();

    if (profileError || !profile?.work_email) {
      throw new Error("Could not find employee profile or email.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error: resetError } = await supabaseAdmin.auth.resetPasswordForEmail(
      profile.work_email,
      {
        redirectTo: `${process.env['SITE_URL'] || process.env['VITE_SITE_URL'] || "https://hrm.theaischool.co"}/auth`,
      },
    );

    if (resetError) {
      throw new Error(`Failed to dispatch reset email: ${resetError.message}`);
    }

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: "password.reset_email_sent",
      entityType: "user",
      entityId: data.userId,
      detail: { email: profile.work_email, method: "email_reset_link" },
    });

    return { ok: true, email: profile.work_email };
  });

/** Option B: Set temporary password directly (Super Admin ONLY). Never logged. */
export const setEmployeeTemporaryPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string; temporaryPassword?: string }) => {
    if (!input?.userId) throw new Error("User ID is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Strict security check: Super Admin only
    const { data: actorRoles } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId);

    const isSuperAdmin = (actorRoles ?? []).some((r) => r.role === "super_admin");
    if (!isSuperAdmin) {
      throw new Error("Forbidden: Setting direct temporary passwords is restricted to Super Admin.");
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id, work_email, full_name")
      .eq("id", data.userId)
      .maybeSingle();

    if (profileError || !profile?.work_email) {
      throw new Error("Could not find employee profile.");
    }

    const tempPassword =
      data.temporaryPassword?.trim() || `TAS-Temp-${crypto.randomUUID().slice(0, 8)}`;

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      password: tempPassword,
    });

    if (updateError) {
      throw new Error(`Failed to update password: ${updateError.message}`);
    }

    // Flag that the user must change password on their next login
    await supabaseAdmin
      .from("profiles")
      .update({ must_change_password: true } as never)
      .eq("id", data.userId);

    // Write audit log WITHOUT recording the password value
    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: "password.temporary_password_set",
      entityType: "user",
      entityId: data.userId,
      detail: { email: profile.work_email, method: "temporary_password_admin_override" },
    });

    return { ok: true, temporaryPassword: tempPassword, email: profile.work_email };
  });

/** Enforced password change when must_change_password is true. */
export const changeMustChangePassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { newPassword: string }) => {
    if (!input?.newPassword || input.newPassword.length < 6) {
      throw new Error("New password must be at least 6 characters.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      password: data.newPassword,
    });
    if (error) throw new Error(error.message);

    await supabaseAdmin
      .from("profiles")
      .update({ must_change_password: false } as never)
      .eq("id", userId);

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: "password.changed_by_user",
      entityType: "user",
      entityId: userId,
      detail: { reason: "must_change_password_cleared" },
    });

    return { ok: true };
  });

