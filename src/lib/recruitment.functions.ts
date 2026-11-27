import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { loadActor, requirePermission, rethrowDbError } from "./actor.server";
import {
  APP_ROLES,
  canAccessCandidateRecord,
  canAssignRole,
  USER_CATEGORIES,
  type AppRole,
  type UserCategory,
} from "./permissions";
import { loadProfileNames, nameOf } from "./profile-names.server";
import {
  summariseCandidateImport,
  validateCandidateImport,
  type CandidateColumnMapping,
  type CandidateImportRawRow,
} from "./recruitment/candidate-import";
import { inspectEmailProviderConfig } from "./recruitment/email-transport.server";
import {
  calculateRecruitmentKpis,
  canConvertCandidateToEmployee,
  CANDIDATE_SOURCES,
  createEmptyRecruitmentKpis,
  isCandidateStatus,
  validateCandidateTransition,
  type CandidateSource,
  type CandidateStatus,
} from "./recruitment/pipeline";
import { isMissingSchemaResourceError } from "./schema-compat.server";

const PENDING_SCHEMA_MSG =
  "Phase P2 Recruitment tables are not yet deployed to this database. Apply migration 20261112000000_p2_recruitment_interviews_and_email_center.sql after approval.";

export const listCandidates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "recruitment:read:all");

    const [
      candidatesRes,
      interviewsRes,
      { data: departments },
      { data: roleRows },
      { data: profiles },
    ] = await Promise.all([
      supabase
        .from("candidates")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500),
      supabase
        .from("interviews")
        .select("id, candidate_id, status, scheduled_start_at")
        .in("status", ["scheduled", "rescheduled"]),
      supabase.from("departments").select("id, name, code").order("name"),
      supabase
        .from("user_roles")
        .select("user_id, role")
        .in("role", ["super_admin", "hr", "admin", "manager", "lead"]),
      supabase
        .from("profiles")
        .select("id, full_name, work_email, designation, employment_status")
        .eq("employment_status", "active")
        .order("full_name"),
    ]);

    const rolesByUser = new Map<string, Set<string>>();
    for (const r of roleRows ?? []) {
      const set = rolesByUser.get(r.user_id) ?? new Set<string>();
      set.add(r.role);
      rolesByUser.set(r.user_id, set);
    }

    const hrUsers = (profiles ?? [])
      // Protected system-owner accounts never appear in workforce selectors.
      .filter((p) => !rolesByUser.get(p.id)?.has("super_admin"))
      .filter((p) => {
        const s = rolesByUser.get(p.id);
        return s?.has("hr") || s?.has("super_admin");
      })
      .map((p) => ({ id: p.id, fullName: p.full_name, email: p.work_email }));

    const leadAndInterviewerUsers = (profiles ?? [])
      // Protected system-owner accounts never appear in workforce selectors.
      .filter((p) => !rolesByUser.get(p.id)?.has("super_admin"))
      .filter((p) => rolesByUser.has(p.id))
      .map((p) => ({
        id: p.id,
        fullName: p.full_name,
        email: p.work_email,
        designation: p.designation,
      }));

    if (candidatesRes.error) {
      if (isMissingSchemaResourceError(candidatesRes.error)) {
        return {
          schemaReady: false,
          emailProvider: inspectEmailProviderConfig(),
          kpis: createEmptyRecruitmentKpis(),
          candidates: [],
          departments: departments ?? [],
          hrUsers,
          leadUsers: leadAndInterviewerUsers,
        };
      }
      rethrowDbError("Failed to load candidates", candidatesRes.error);
    }

    const activeInterviews = interviewsRes.error ? [] : (interviewsRes.data ?? []);
    const interviewCountByCandidate = new Map<string, number>();
    for (const iv of activeInterviews) {
      interviewCountByCandidate.set(
        iv.candidate_id,
        (interviewCountByCandidate.get(iv.candidate_id) ?? 0) + 1,
      );
    }

    const deptMap = new Map((departments ?? []).map((d) => [d.id, d.name]));
    const hrNameMap = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));

    const candidates = (candidatesRes.data ?? []).map((c) => ({
      ...c,
      departmentName: c.department_id ? (deptMap.get(c.department_id) ?? null) : null,
      assignedHrName: c.assigned_hr_id ? (hrNameMap.get(c.assigned_hr_id) ?? null) : null,
      upcomingInterviewsCount: interviewCountByCandidate.get(c.id) ?? 0,
    }));

    const kpis = calculateRecruitmentKpis(candidates, activeInterviews.length);

    return {
      schemaReady: true,
      emailProvider: inspectEmailProviderConfig(),
      kpis,
      candidates,
      departments: departments ?? [],
      hrUsers,
      leadUsers: leadAndInterviewerUsers,
    };
  });

export const getCandidateDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { candidateId: string }) => {
    if (!input?.candidateId) throw new Error("Candidate ID is required.");
    return { candidateId: String(input.candidateId).trim() };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const actor = await loadActor(supabase, userId);

    const interviewsRes = await supabase
      .from("interviews")
      .select("*")
      .eq("candidate_id", data.candidateId)
      .order("round_number", { ascending: true })
      .order("scheduled_start_at", { ascending: true });

    if (interviewsRes.error) {
      if (isMissingSchemaResourceError(interviewsRes.error)) {
        throw new Error(PENDING_SCHEMA_MSG);
      }
      rethrowDbError("Failed to load candidate interviews", interviewsRes.error);
    }

    const candidateInterviews = interviewsRes.data ?? [];
    const assignedInterviewerIds = Array.from(
      new Set(candidateInterviews.flatMap((iv) => iv.interviewer_ids ?? [])),
    );

    if (!canAccessCandidateRecord(userId, actor.permissions, assignedInterviewerIds)) {
      throw new Error(
        "Forbidden: you can only view candidate records when authorized for HR recruitment or assigned as an interviewer.",
      );
    }

    const hasFullRecruitmentRead = actor.permissions.includes("recruitment:read:all");
    const hasFullInterviewsRead = actor.permissions.includes("interviews:read:all");
    const hasEmailsRead = actor.permissions.includes("emails:read:all");

    const [
      { data: candidate, error: candError },
      { data: activities },
      { data: feedbackRows },
      emailsRes,
      { data: departments },
      { data: offices },
      { data: roleRows },
      { data: activeProfiles },
      invitationRes,
    ] = await Promise.all([
      supabase.from("candidates").select("*").eq("id", data.candidateId).maybeSingle(),
      supabase
        .from("candidate_activities")
        .select("*")
        .eq("candidate_id", data.candidateId)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("interview_feedback")
        .select("*")
        .eq("candidate_id", data.candidateId)
        .order("submitted_at", { ascending: false }),
      hasEmailsRead
        ? supabase
            .from("email_messages")
            .select("*")
            .eq("candidate_id", data.candidateId)
            .order("created_at", { ascending: false })
            .limit(40)
        : Promise.resolve({ data: [], error: null }),
      supabase.from("departments").select("id, name, code").order("name"),
      supabase
        .from("office_locations")
        .select("id, name, address, is_active")
        .eq("is_active", true)
        .order("name"),
      supabase
        .from("user_roles")
        .select("user_id, role")
        .in("role", ["super_admin", "hr", "admin", "manager", "lead"]),
      supabase
        .from("profiles")
        .select("id, full_name, work_email, designation, employment_status")
        .eq("employment_status", "active")
        .order("full_name"),
      actor.permissions.includes("invitations:read:all")
        ? supabase
            .from("invitations")
            .select("id, status, sent_at, accepted_at, invited_user_id")
            .order("created_at", { ascending: false })
            .limit(300)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (candError) rethrowDbError("Failed to load candidate", candError);
    if (!candidate) throw new Error("Candidate not found.");

    const visibleInterviews = hasFullInterviewsRead
      ? candidateInterviews
      : candidateInterviews.filter((iv) => (iv.interviewer_ids ?? []).includes(userId));

    const visibleFeedback = hasFullInterviewsRead
      ? (feedbackRows ?? [])
      : (feedbackRows ?? []).filter((fb) => fb.interviewer_id === userId);

    const profileIdsToResolve = new Set<string>();
    if (candidate.assigned_hr_id) profileIdsToResolve.add(candidate.assigned_hr_id);
    if (candidate.created_by) profileIdsToResolve.add(candidate.created_by);
    for (const a of activities ?? []) if (a.actor_id) profileIdsToResolve.add(a.actor_id);
    for (const iv of visibleInterviews) {
      for (const id of iv.interviewer_ids ?? []) profileIdsToResolve.add(id);
    }
    for (const fb of visibleFeedback) profileIdsToResolve.add(fb.interviewer_id);

    const namesMap = await loadProfileNames(supabase, Array.from(profileIdsToResolve));
    const deptMap = new Map((departments ?? []).map((d) => [d.id, d.name]));
    const officeMap = new Map((offices ?? []).map((o) => [o.id, o.name]));

    const rolesByUser = new Map<string, Set<string>>();
    for (const r of roleRows ?? []) {
      const s = rolesByUser.get(r.user_id) ?? new Set<string>();
      s.add(r.role);
      rolesByUser.set(r.user_id, s);
    }

    const hrUsers = (activeProfiles ?? [])
      // Protected system-owner accounts never appear in workforce selectors.
      .filter((p) => !rolesByUser.get(p.id)?.has("super_admin"))
      .filter((p) => {
        const s = rolesByUser.get(p.id);
        return s?.has("hr") || s?.has("super_admin");
      })
      .map((p) => ({ id: p.id, fullName: p.full_name, email: p.work_email }));

    const interviewerOptions = (activeProfiles ?? [])
      // Protected system-owner accounts never appear in workforce selectors.
      .filter((p) => !rolesByUser.get(p.id)?.has("super_admin"))
      .filter((p) => rolesByUser.has(p.id))
      .map((p) => ({
        id: p.id,
        fullName: p.full_name,
        email: p.work_email,
        designation: p.designation,
      }));

    const linkedInvitation = candidate.converted_invitation_id
      ? ((invitationRes.data ?? []).find((i) => i.id === candidate.converted_invitation_id) ?? null)
      : null;

    return {
      accessMode: hasFullRecruitmentRead ? ("full" as const) : ("assigned_interviewer" as const),
      emailProvider: inspectEmailProviderConfig(),
      candidate: {
        ...candidate,
        // Redact compensation expectations for non-HR assigned interviewers
        expected_ctc: hasFullRecruitmentRead ? candidate.expected_ctc : null,
        departmentName: candidate.department_id
          ? (deptMap.get(candidate.department_id) ?? null)
          : null,
        assignedHrName: candidate.assigned_hr_id
          ? nameOf(namesMap, candidate.assigned_hr_id)
          : null,
      },
      linkedInvitation,
      activities: (activities ?? []).map((a) => ({
        ...a,
        actorName: a.actor_id ? nameOf(namesMap, a.actor_id) : "System",
      })),
      interviews: visibleInterviews.map((iv) => ({
        ...iv,
        officeName: iv.office_location_id ? (officeMap.get(iv.office_location_id) ?? null) : null,
        interviewerNames: (iv.interviewer_ids ?? []).map((id) => ({
          id,
          name: nameOf(namesMap, id),
        })),
      })),
      feedback: visibleFeedback.map((fb) => ({
        ...fb,
        interviewerName: nameOf(namesMap, fb.interviewer_id),
      })),
      emails: emailsRes.error ? [] : (emailsRes.data ?? []),
      departments: departments ?? [],
      offices: offices ?? [],
      hrUsers,
      interviewerOptions,
    };
  });

export type UpsertCandidateInput = {
  id?: string | undefined;
  fullName: string;
  email: string;
  phone?: string | null | undefined;
  location?: string | null | undefined;
  departmentId?: string | null | undefined;
  designation?: string | null | undefined;
  appliedCategory?: UserCategory | undefined;
  source?: CandidateSource | undefined;
  experienceYears?: number | null | undefined;
  currentCompany?: string | null | undefined;
  expectedCtc?: string | null | undefined;
  noticePeriodDays?: number | null | undefined;
  availableJoiningDate?: string | null | undefined;
  skills?: string[] | undefined;
  portfolioUrl?: string | null | undefined;
  linkedinUrl?: string | null | undefined;
  notesSummary?: string | null | undefined;
  assignedHrId?: string | null | undefined;
};

export const upsertCandidate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: UpsertCandidateInput) => {
    const fullName = String(input?.fullName ?? "").trim();
    if (fullName.length < 2) throw new Error("Candidate full name is required.");
    const email = String(input?.email ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("A valid candidate email address is required.");
    }
    const cat = input.appliedCategory ?? "full_time";
    if (!(USER_CATEGORIES as readonly string[]).includes(cat)) {
      throw new Error("Invalid candidate category.");
    }
    const src = input.source ?? "direct";
    if (!(CANDIDATE_SOURCES as readonly string[]).includes(src)) {
      throw new Error("Invalid application source.");
    }
    return { ...input, fullName, email, appliedCategory: cat, source: src };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "recruitment:manage:all");

    // Duplicate email guard against existing candidates and workforce
    const [{ data: existingCand, error: dupErr }, { data: existingEmp }] = await Promise.all([
      supabase.from("candidates").select("id, email").ilike("email", data.email),
      supabase.from("profiles").select("id, work_email").ilike("work_email", data.email),
    ]);

    if (dupErr) {
      if (isMissingSchemaResourceError(dupErr)) throw new Error(PENDING_SCHEMA_MSG);
      rethrowDbError("Failed checking candidate duplicates", dupErr);
    }

    const otherCand = (existingCand ?? []).find((c) => c.id !== data.id);
    if (otherCand) {
      throw new Error(`A candidate with email ${data.email} already exists in Recruitment.`);
    }
    if (!data.id && (existingEmp ?? []).length > 0) {
      throw new Error(`An employee profile with work email ${data.email} already exists.`);
    }

    const payload = {
      full_name: data.fullName,
      email: data.email,
      phone: data.phone?.trim() || null,
      location: data.location?.trim() || null,
      department_id: data.departmentId || null,
      designation: data.designation?.trim() || null,
      applied_category: data.appliedCategory,
      source: data.source,
      experience_years:
        data.experienceYears != null && Number.isFinite(data.experienceYears)
          ? data.experienceYears
          : null,
      current_company: data.currentCompany?.trim() || null,
      expected_ctc: data.expectedCtc?.trim() || null,
      notice_period_days:
        data.noticePeriodDays != null && Number.isInteger(data.noticePeriodDays)
          ? data.noticePeriodDays
          : null,
      available_joining_date: data.availableJoiningDate || null,
      skills: (data.skills ?? []).map((s) => s.trim()).filter(Boolean),
      portfolio_url: data.portfolioUrl?.trim() || null,
      linkedin_url: data.linkedinUrl?.trim() || null,
      notes_summary: data.notesSummary?.trim() || null,
      assigned_hr_id: data.assignedHrId || userId,
    };

    const { writeAudit } = await import("./audit.server");

    if (data.id) {
      const { data: updated, error } = await supabase
        .from("candidates")
        .update(payload)
        .eq("id", data.id)
        .select("id, candidate_code")
        .single();
      if (error) rethrowDbError("Updating candidate failed", error);

      await writeAudit(supabase, {
        actorId: userId,
        action: "candidate.updated",
        entityType: "candidate",
        entityId: updated.id,
        detail: { email: data.email, candidateCode: updated.candidate_code },
      });
      return { id: updated.id, candidateCode: updated.candidate_code };
    }

    const { data: created, error } = await supabase
      .from("candidates")
      .insert({
        ...payload,
        status: "applied",
        created_by: userId,
      })
      .select("id, candidate_code")
      .single();
    if (error) rethrowDbError("Creating candidate failed", error);

    await supabase.from("candidate_activities").insert({
      candidate_id: created.id,
      actor_id: userId,
      activity_type: "created",
      to_status: "applied",
      body: `Candidate profile created (${data.source}).`,
    });

    await writeAudit(supabase, {
      actorId: userId,
      action: "candidate.created",
      entityType: "candidate",
      entityId: created.id,
      detail: { email: data.email, candidateCode: created.candidate_code },
    });

    return { id: created.id, candidateCode: created.candidate_code };
  });

export const updateCandidateStage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: { candidateId: string; toStatus: string; note?: string | undefined }) => {
      if (!input?.candidateId) throw new Error("Candidate ID is required.");
      if (!isCandidateStatus(input?.toStatus)) throw new Error("Invalid target stage.");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "recruitment:manage:all");

    const { data: current, error: loadErr } = await supabase
      .from("candidates")
      .select("id, full_name, status, assigned_hr_id, converted_invitation_id, converted_user_id")
      .eq("id", data.candidateId)
      .maybeSingle();

    if (loadErr) {
      if (isMissingSchemaResourceError(loadErr)) throw new Error(PENDING_SCHEMA_MSG);
      rethrowDbError("Loading candidate failed", loadErr);
    }
    if (!current) throw new Error("Candidate not found.");

    const check = validateCandidateTransition({
      fromStatus: current.status as CandidateStatus,
      toStatus: data.toStatus,
      alreadyConverted: Boolean(current.converted_invitation_id || current.converted_user_id),
    });
    if (!check.ok) throw new Error(check.reason);

    const { error: updErr } = await supabase
      .from("candidates")
      .update({ status: check.toStatus })
      .eq("id", data.candidateId);
    if (updErr) rethrowDbError("Stage update failed", updErr);

    await supabase.from("candidate_activities").insert({
      candidate_id: data.candidateId,
      actor_id: userId,
      activity_type: "status_change",
      from_status: current.status,
      to_status: check.toStatus,
      body: data.note?.trim() || null,
    });

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: "candidate.stage_changed",
      entityType: "candidate",
      entityId: data.candidateId,
      detail: { from: current.status, to: check.toStatus, note: data.note ?? null },
    });

    if (current.assigned_hr_id && current.assigned_hr_id !== userId) {
      try {
        const { notify } = await import("./daily-queries.server");
        await notify(supabase, {
          userId: current.assigned_hr_id,
          actorId: userId,
          type: "candidate.status_changed",
          title: `Candidate moved to ${check.toStatus.replace(/_/g, " ")}: ${current.full_name}`,
          body: data.note?.trim() || null,
          entityType: "candidate",
          entityId: data.candidateId,
          section: "timeline",
          actionLabel: "View Candidate",
          actionUrl: `/candidates/${data.candidateId}?section=timeline`,
          metadata: { status: check.toStatus },
        });
      } catch {
        // Non-fatal
      }
    }

    return { ok: true, status: check.toStatus };
  });

export const addCandidateNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { candidateId: string; note: string }) => {
    const note = String(input?.note ?? "").trim();
    if (!input?.candidateId) throw new Error("Candidate ID is required.");
    if (!note) throw new Error("Note cannot be empty.");
    return { candidateId: input.candidateId, note };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "recruitment:manage:all");

    const { error } = await supabase.from("candidate_activities").insert({
      candidate_id: data.candidateId,
      actor_id: userId,
      activity_type: "note",
      body: data.note,
    });
    if (error) {
      if (isMissingSchemaResourceError(error)) throw new Error(PENDING_SCHEMA_MSG);
      rethrowDbError("Adding candidate note failed", error);
    }

    return { ok: true };
  });

export const bulkUpdateCandidates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      candidateIds: string[];
      toStatus?: string | undefined;
      assignedHrId?: string | null | undefined;
      note?: string | undefined;
    }) => {
      if (!Array.isArray(input?.candidateIds) || input.candidateIds.length === 0) {
        throw new Error("Select at least one candidate.");
      }
      if (input.candidateIds.length > 200) {
        throw new Error("Bulk actions are capped at 200 candidates at a time.");
      }
      if (input.toStatus && !isCandidateStatus(input.toStatus)) {
        throw new Error("Invalid target stage.");
      }
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "recruitment:manage:all");

    const { data: rows, error } = await supabase
      .from("candidates")
      .select("id, status, converted_invitation_id, converted_user_id")
      .in("id", data.candidateIds);

    if (error) {
      if (isMissingSchemaResourceError(error)) throw new Error(PENDING_SCHEMA_MSG);
      rethrowDbError("Loading candidates for bulk update failed", error);
    }

    let updatedCount = 0;
    const skippedReasons: { id: string; reason: string }[] = [];

    for (const row of rows ?? []) {
      const patch: import("@/integrations/supabase/types").Database["public"]["Tables"]["candidates"]["Update"] = {};
      if (data.assignedHrId !== undefined) {
        patch.assigned_hr_id = data.assignedHrId || null;
      }
      if (data.toStatus) {
        const check = validateCandidateTransition({
          fromStatus: row.status as CandidateStatus,
          toStatus: data.toStatus,
          alreadyConverted: Boolean(row.converted_invitation_id || row.converted_user_id),
        });
        if (!check.ok) {
          skippedReasons.push({ id: row.id, reason: check.reason });
          continue;
        }
        patch.status = check.toStatus;
      }

      if (Object.keys(patch).length === 0) continue;

      const { error: updErr } = await supabase
        .from("candidates")
        .update(patch)
        .eq("id", row.id);
      if (updErr) {
        skippedReasons.push({ id: row.id, reason: updErr.message });
        continue;
      }

      updatedCount += 1;
      if (data.toStatus) {
        await supabase.from("candidate_activities").insert({
          candidate_id: row.id,
          actor_id: userId,
          activity_type: "status_change",
          from_status: row.status,
          to_status: data.toStatus,
          body: data.note?.trim() || "Bulk stage update",
        });
      }
    }

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: "candidate.bulk_updated",
      entityType: "candidate_batch",
      detail: {
        requested: data.candidateIds.length,
        updatedCount,
        skippedCount: skippedReasons.length,
        toStatus: data.toStatus ?? null,
        assignedHrId: data.assignedHrId ?? null,
      },
    });

    return { updatedCount, skippedCount: skippedReasons.length, skippedReasons };
  });

export const createCandidateResumeUploadUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { candidateId: string; fileName: string }) => {
    if (!input?.candidateId) throw new Error("Candidate ID is required.");
    const fileName = String(input.fileName ?? "").trim();
    if (!fileName) throw new Error("File name is required.");
    if (!/\.(pdf|docx?|rtf)$/i.test(fileName)) {
      throw new Error("Only PDF, DOC, DOCX, or RTF resume files are accepted.");
    }
    return { candidateId: input.candidateId, fileName };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "recruitment:manage:all");

    const safeName = data.fileName.replace(/[^\w.\-]+/g, "_");
    const path = `${data.candidateId}/${Date.now()}_${safeName}`;
    const { data: signed, error } = await supabase.storage
      .from("candidate-resumes")
      .createSignedUploadUrl(path);
    if (error) rethrowDbError("Could not create resume upload URL", error);
    return { path, token: signed.token };
  });

export const registerCandidateResume = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { candidateId: string; path: string; fileName: string }) => {
    if (!input?.candidateId || !input?.path || !input?.fileName) {
      throw new Error("Candidate ID, storage path, and file name are required.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "recruitment:manage:all");

    if (!data.path.startsWith(`${data.candidateId}/`)) {
      throw new Error("Invalid resume storage path for this candidate.");
    }

    const { data: existing } = await supabase
      .from("candidates")
      .select("resume_path")
      .eq("id", data.candidateId)
      .maybeSingle();

    if (existing?.resume_path && existing.resume_path !== data.path) {
      await supabase.storage.from("candidate-resumes").remove([existing.resume_path]);
    }

    const { error } = await supabase
      .from("candidates")
      .update({
        resume_path: data.path,
        resume_file_name: data.fileName,
      })
      .eq("id", data.candidateId);
    if (error) rethrowDbError("Saving candidate resume failed", error);

    await supabase.from("candidate_activities").insert({
      candidate_id: data.candidateId,
      actor_id: userId,
      activity_type: "resume_uploaded",
      body: `Uploaded resume: ${data.fileName}`,
    });

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: "candidate.resume_uploaded",
      entityType: "candidate",
      entityId: data.candidateId,
      detail: { fileName: data.fileName },
    });

    return { ok: true };
  });

export const getCandidateResumeDownloadUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { candidateId: string }) => {
    if (!input?.candidateId) throw new Error("Candidate ID is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const actor = await loadActor(supabase, userId);

    const [{ data: candidate, error }, { data: ivs }] = await Promise.all([
      supabase
        .from("candidates")
        .select("id, resume_path, resume_file_name")
        .eq("id", data.candidateId)
        .maybeSingle(),
      supabase
        .from("interviews")
        .select("interviewer_ids")
        .eq("candidate_id", data.candidateId),
    ]);

    if (error) rethrowDbError("Loading candidate resume failed", error);
    if (!candidate?.resume_path) throw new Error("No resume uploaded for this candidate.");

    const assignedIds = Array.from(
      new Set((ivs ?? []).flatMap((iv) => iv.interviewer_ids ?? [])),
    );
    if (!canAccessCandidateRecord(userId, actor.permissions, assignedIds)) {
      throw new Error("Forbidden: you do not have access to this candidate's resume.");
    }

    const { data: signed, error: signErr } = await supabase.storage
      .from("candidate-resumes")
      .createSignedUrl(candidate.resume_path, 120);
    if (signErr) rethrowDbError("Generating signed resume link failed", signErr);

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: "candidate.resume_downloaded",
      entityType: "candidate",
      entityId: candidate.id,
      detail: { fileName: candidate.resume_file_name },
    });

    return { url: signed.signedUrl, fileName: candidate.resume_file_name };
  });

async function loadCandidateImportLookups(
  supabase: Parameters<typeof requirePermission>[0],
) {
  const [candRes, { data: departments }, { data: profiles }, { data: invites }] =
    await Promise.all([
      supabase.from("candidates").select("email"),
      supabase.from("departments").select("id, name"),
      supabase.from("profiles").select("work_email"),
      supabase
        .from("invitations")
        .select("email, status")
        .in("status", ["queued", "sending", "sent", "accepted"]),
    ]);

  const schemaReady = !candRes.error || !isMissingSchemaResourceError(candRes.error);
  if (candRes.error && schemaReady) {
    rethrowDbError("Failed loading existing candidates for import", candRes.error);
  }

  return {
    schemaReady,
    lookups: {
      departmentsByName: new Map(
        (departments ?? []).map((d) => [d.name.trim().toLowerCase(), d.id]),
      ),
      existingCandidateEmails: new Set(
        (candRes.data ?? []).map((c) => c.email.trim().toLowerCase()),
      ),
      existingEmployeeEmails: new Set(
        (profiles ?? []).map((p) => p.work_email.trim().toLowerCase()),
      ),
      pendingInvitationEmails: new Set(
        (invites ?? []).map((i) => i.email.trim().toLowerCase()),
      ),
    },
  };
}

export const validateCandidateImportUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      fileName: string;
      rows: CandidateImportRawRow[];
      columnMapping?: CandidateColumnMapping | undefined;
    }) => {
      if (!Array.isArray(input?.rows) || input.rows.length === 0) {
        throw new Error("The uploaded file contains no candidate rows.");
      }
      if (input.rows.length > 1000) {
        throw new Error("Candidate imports are capped at 1,000 rows per file.");
      }
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "recruitment:manage:all");

    const { schemaReady, lookups } = await loadCandidateImportLookups(supabase);
    const validated = validateCandidateImport(data.rows, lookups);
    const summary = summariseCandidateImport(validated);

    return {
      schemaReady,
      fileName: data.fileName,
      rows: validated,
      summary,
    };
  });

export type CandidateImportRowOutcome = {
  rowNumber: number;
  fullName: string;
  email: string;
  status: "imported" | "duplicate" | "invalid" | "failed";
  candidateId?: string;
  candidateCode?: string;
  reason?: string;
  raw?: CandidateImportRawRow;
};

export const commitCandidateImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      fileName: string;
      rows: CandidateImportRawRow[];
      columnMapping?: CandidateColumnMapping | undefined;
      assignedHrId?: string | null | undefined;
    }) => {
      if (!Array.isArray(input?.rows) || input.rows.length === 0) {
        throw new Error("No rows to import.");
      }
      if (input.rows.length > 1000) {
        throw new Error("Candidate imports are capped at 1,000 rows per file.");
      }
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "recruitment:manage:all");

    const { schemaReady, lookups } = await loadCandidateImportLookups(supabase);
    if (!schemaReady) throw new Error(PENDING_SCHEMA_MSG);

    const validated = validateCandidateImport(data.rows, lookups);

    const { data: batch, error: batchErr } = await supabase
      .from("candidate_import_batches")
      .insert({
        file_name: data.fileName || "candidates_import.csv",
        total_rows: validated.length,
        column_mapping: (data.columnMapping ?? {}) as never,
        created_by: userId,
      })
      .select("id")
      .single();

    if (batchErr) rethrowDbError("Creating candidate import batch failed", batchErr);

    const outcomes: CandidateImportRowOutcome[] = [];
    let importedCount = 0;
    let duplicateCount = 0;
    let invalidCount = 0;
    let failedCount = 0;

    for (const row of validated) {
      if (row.severity === "duplicate") {
        duplicateCount += 1;
        outcomes.push({
          rowNumber: row.rowNumber,
          fullName: row.fullName,
          email: row.email,
          status: "duplicate",
          reason: row.errors.join(" "),
        });
        continue;
      }
      if (row.severity === "error") {
        invalidCount += 1;
        outcomes.push({
          rowNumber: row.rowNumber,
          fullName: row.fullName,
          email: row.email,
          status: "invalid",
          reason: row.errors.join(" "),
        });
        continue;
      }

      const { data: created, error: insErr } = await supabase
        .from("candidates")
        .insert({
          full_name: row.fullName,
          email: row.email,
          phone: row.phone,
          location: row.location,
          department_id: row.departmentId,
          designation: row.designation,
          applied_category: row.appliedCategory,
          source: row.source,
          status: "applied",
          experience_years: row.experienceYears,
          current_company: row.currentCompany,
          expected_ctc: row.expectedCtc,
          notice_period_days: row.noticePeriodDays,
          available_joining_date: row.availableJoiningDate,
          skills: row.skills,
          linkedin_url: row.linkedinUrl,
          notes_summary: row.notes,
          assigned_hr_id: data.assignedHrId || userId,
          import_batch_id: batch.id,
          created_by: userId,
        })
        .select("id, candidate_code")
        .single();

      if (insErr || !created) {
        failedCount += 1;
        outcomes.push({
          rowNumber: row.rowNumber,
          fullName: row.fullName,
          email: row.email,
          status: "failed",
          reason: insErr?.message ?? "Database insert error.",
          raw: row.raw,
        });
        continue;
      }

      importedCount += 1;
      await supabase.from("candidate_activities").insert({
        candidate_id: created.id,
        actor_id: userId,
        activity_type: "imported",
        to_status: "applied",
        body: `Imported from ${data.fileName}`,
      });

      outcomes.push({
        rowNumber: row.rowNumber,
        fullName: row.fullName,
        email: row.email,
        status: "imported",
        candidateId: created.id,
        candidateCode: created.candidate_code,
      });
    }

    await supabase
      .from("candidate_import_batches")
      .update({
        imported_count: importedCount,
        duplicate_count: duplicateCount,
        invalid_count: invalidCount,
        failed_count: failedCount,
        row_results: outcomes as never,
      })
      .eq("id", batch.id);

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: "candidate.import_committed",
      entityType: "candidate_import_batch",
      entityId: batch.id,
      detail: {
        fileName: data.fileName,
        totalRows: validated.length,
        importedCount,
        duplicateCount,
        invalidCount,
        failedCount,
      },
    });

    return {
      batchId: batch.id,
      totalRows: validated.length,
      importedCount,
      duplicateCount,
      invalidCount,
      failedCount,
      outcomes,
    };
  });

export const listCandidateImportBatches = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "recruitment:read:all");

    const { data, error } = await supabase
      .from("candidate_import_batches")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(25);

    if (error) {
      if (isMissingSchemaResourceError(error)) return [];
      rethrowDbError("Loading candidate import history failed", error);
    }
    return data ?? [];
  });

export const retryFailedCandidateImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { batchId: string }) => {
    if (!input?.batchId) throw new Error("Batch ID is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "recruitment:manage:all");

    const { data: batch, error } = await supabase
      .from("candidate_import_batches")
      .select("*")
      .eq("id", data.batchId)
      .maybeSingle();
    if (error) rethrowDbError("Loading import batch failed", error);
    if (!batch) throw new Error("Import batch not found.");

    const existingResults = Array.isArray(batch.row_results)
      ? (batch.row_results as unknown as CandidateImportRowOutcome[])
      : [];
    const retryableRaw = existingResults
      .filter((r) => r.status === "failed" && r.raw)
      .map((r) => r.raw!);

    if (retryableRaw.length === 0) {
      throw new Error("This import batch has no retryable failed rows.");
    }

    const { lookups } = await loadCandidateImportLookups(supabase);
    const revalidated = validateCandidateImport(retryableRaw, lookups);

    let recovered = 0;
    for (const row of revalidated) {
      if (row.severity === "error" || row.severity === "duplicate") continue;
      const { data: created, error: insErr } = await supabase
        .from("candidates")
        .insert({
          full_name: row.fullName,
          email: row.email,
          phone: row.phone,
          location: row.location,
          department_id: row.departmentId,
          designation: row.designation,
          applied_category: row.appliedCategory,
          source: row.source,
          status: "applied",
          experience_years: row.experienceYears,
          current_company: row.currentCompany,
          expected_ctc: row.expectedCtc,
          notice_period_days: row.noticePeriodDays,
          available_joining_date: row.availableJoiningDate,
          skills: row.skills,
          linkedin_url: row.linkedinUrl,
          notes_summary: row.notes,
          assigned_hr_id: userId,
          import_batch_id: batch.id,
          created_by: userId,
        })
        .select("id, candidate_code")
        .single();

      if (!insErr && created) {
        recovered += 1;
        const matchIdx = existingResults.findIndex(
          (r) => r.status === "failed" && r.email.toLowerCase() === row.email,
        );
        if (matchIdx >= 0) {
          existingResults[matchIdx] = {
            rowNumber: existingResults[matchIdx]!.rowNumber,
            fullName: row.fullName,
            email: row.email,
            status: "imported",
            candidateId: created.id,
            candidateCode: created.candidate_code,
          };
        }
      }
    }

    const remainingFailed = existingResults.filter((r) => r.status === "failed").length;
    await supabase
      .from("candidate_import_batches")
      .update({
        imported_count: batch.imported_count + recovered,
        failed_count: remainingFailed,
        row_results: existingResults as never,
      })
      .eq("id", batch.id);

    return { recovered, remainingFailed };
  });

export const convertCandidateToEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      candidateId: string;
      workEmail?: string | undefined;
      role?: AppRole | undefined;
      category?: UserCategory | undefined;
      departmentId?: string | null | undefined;
      designation?: string | null | undefined;
      reportingLeadId?: string | null | undefined;
      joiningDate?: string | null | undefined;
      dispatchImmediately?: boolean | undefined;
    }) => {
      if (!input?.candidateId) throw new Error("Candidate ID is required.");
      const role = input.role ?? "employee";
      if (!APP_ROLES.includes(role)) throw new Error("Invalid target role.");
      return { ...input, role };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "recruitment:manage:all");
    await requirePermission(supabase, userId, "invitations:create:all");

    const actor = await loadActor(supabase, userId);
    if (!canAssignRole(actor.roles, data.role)) {
      throw new Error(
        `Forbidden: your role cannot provision an onboarding account with role "${data.role}".`,
      );
    }

    const { data: candidate, error: candErr } = await supabase
      .from("candidates")
      .select("*")
      .eq("id", data.candidateId)
      .maybeSingle();

    if (candErr) {
      if (isMissingSchemaResourceError(candErr)) throw new Error(PENDING_SCHEMA_MSG);
      rethrowDbError("Loading candidate for conversion failed", candErr);
    }
    if (!candidate) throw new Error("Candidate not found.");

    const targetEmail = String(data.workEmail ?? candidate.email).trim().toLowerCase();

    const [{ data: existingProfiles }, { data: existingInvites }] = await Promise.all([
      supabase.from("profiles").select("work_email").ilike("work_email", targetEmail),
      supabase
        .from("invitations")
        .select("email, status")
        .ilike("email", targetEmail)
        .in("status", ["queued", "sending", "sent", "accepted"]),
    ]);

    const eligibility = canConvertCandidateToEmployee(
      {
        email: targetEmail,
        fullName: candidate.full_name,
        status: candidate.status,
        appliedCategory: candidate.applied_category,
        convertedInvitationId: candidate.converted_invitation_id,
        convertedUserId: candidate.converted_user_id,
      },
      {
        existingWorkEmails: new Set(
          (existingProfiles ?? []).map((p) => p.work_email.toLowerCase()),
        ),
        activeInvitationEmails: new Set(
          (existingInvites ?? []).map((i) => i.email.toLowerCase()),
        ),
      },
    );

    if (!eligibility.ok) {
      throw new Error(eligibility.reason);
    }

    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const category = data.category ?? candidate.applied_category ?? "full_time";
    const designation = data.designation?.trim() || candidate.designation || null;
    const departmentId =
      data.departmentId !== undefined ? data.departmentId : candidate.department_id;
    const joiningDate =
      data.joiningDate !== undefined ? data.joiningDate : candidate.available_joining_date;

    const { data: invitation, error: invErr } = await supabase
      .from("invitations")
      .insert({
        email: eligibility.normalizedEmail,
        full_name: candidate.full_name,
        role: data.role as never,
        category: category as never,
        designation,
        department_id: departmentId || null,
        reporting_lead_id: data.reportingLeadId || null,
        status: "queued" as const,
        source: "candidate_conversion",
        created_by: userId,
        expires_at: expiresAt,
        metadata: {
          candidateId: candidate.id,
          candidateCode: candidate.candidate_code,
          mobile: candidate.phone ?? null,
          joiningDate: joiningDate ?? null,
          location: candidate.location ?? null,
          skills: candidate.skills ?? [],
          experienceYears: candidate.experience_years ?? null,
        } as never,
      })
      .select("id, email, status")
      .single();

    if (invErr || !invitation) {
      rethrowDbError("Creating onboarding invitation from candidate failed", invErr);
    }

    const { error: updCandErr } = await supabase
      .from("candidates")
      .update({
        status: "onboarding",
        converted_invitation_id: invitation.id,
        converted_at: new Date().toISOString(),
      })
      .eq("id", candidate.id);

    if (updCandErr) {
      rethrowDbError("Linking candidate to onboarding invitation failed", updCandErr);
    }

    await supabase.from("candidate_activities").insert({
      candidate_id: candidate.id,
      actor_id: userId,
      activity_type: "converted_to_onboarding",
      from_status: candidate.status,
      to_status: "onboarding",
      body: `Converted to employee onboarding invitation (${eligibility.normalizedEmail}). Employee ID (TAS-XXX) is assigned upon invitation dispatch, and account activates only after HR KYC verification.`,
      metadata: {
        invitationId: invitation.id,
        workEmail: eligibility.normalizedEmail,
        role: data.role,
        category,
      },
    });

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: "candidate.converted_to_onboarding",
      entityType: "candidate",
      entityId: candidate.id,
      detail: {
        candidateCode: candidate.candidate_code,
        invitationId: invitation.id,
        workEmail: eligibility.normalizedEmail,
        role: data.role,
        category,
      },
    });

    let dispatchSummary: { sent: number; failed: number } | null = null;
    if (data.dispatchImmediately) {
      const { dispatchInvitationBatch } = await import("./invitations.server");
      const dispatched = await dispatchInvitationBatch({ limit: 5 });
      dispatchSummary = { sent: dispatched.sent, failed: dispatched.failed };
    }

    return {
      ok: true,
      invitationId: invitation.id,
      workEmail: eligibility.normalizedEmail,
      dispatchSummary,
    };
  });
