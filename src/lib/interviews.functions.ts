import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ForbiddenError, loadActor, requirePermission, rethrowDbError } from "./actor.server";
import { notify } from "./daily-queries.server";
import { canSubmitInterviewFeedback } from "./permissions";
import { loadProfileNames, nameOf } from "./profile-names.server";
import {
  formatInterviewIstSlot,
  INTERVIEW_MODES,
  INTERVIEW_RECOMMENDATIONS,
  INTERVIEW_RECOMMENDATION_LABELS,
  type InterviewMode,
  type InterviewRecommendation,
} from "./recruitment/pipeline";
import { isMissingSchemaResourceError } from "./schema-compat.server";
import { ORG_TIMEZONE } from "./timezone";

export { formatInterviewIstSlot };

const PENDING_SCHEMA_MSG =
  "Phase P2 Interview tables are not yet deployed to this database. Apply migration 20261112000000_p2_recruitment_interviews_and_email_center.sql after approval.";

export const listInterviews = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const actor = await loadActor(supabase, userId);

    const canReadAll = actor.permissions.includes("interviews:read:all");
    const canFeedbackAssigned = actor.permissions.includes("interviews:feedback:assigned");

    if (!canReadAll && !canFeedbackAssigned) {
      throw new ForbiddenError("interviews:feedback:assigned");
    }

    const canManage = actor.permissions.includes("interviews:manage:all");

    let ivQuery = supabase
      .from("interviews")
      .select("*")
      .order("scheduled_start_at", { ascending: true })
      .limit(300);

    if (!canReadAll) {
      ivQuery = ivQuery.contains("interviewer_ids", [userId]);
    }

    const [
      interviewsRes,
      feedbackRes,
      candidatesRes,
      { data: offices },
      { data: departments },
      { data: roleRows },
      { data: activeProfiles },
    ] = await Promise.all([
      ivQuery,
      canReadAll
        ? supabase
            .from("interview_feedback")
            .select("*")
            .order("submitted_at", { ascending: false })
        : supabase
            .from("interview_feedback")
            .select("*")
            .eq("interviewer_id", userId)
            .order("submitted_at", { ascending: false }),
      canManage || canReadAll
        ? supabase
            .from("candidates")
            .select("id, candidate_code, full_name, email, designation, department_id, status, resume_path, resume_file_name")
            .order("created_at", { ascending: false })
            .limit(300)
        : supabase
            .from("candidates")
            .select("id, candidate_code, full_name, email, designation, department_id, status, resume_path, resume_file_name"),
      supabase
        .from("office_locations")
        .select("id, name, address, is_active")
        .eq("is_active", true)
        .order("name"),
      supabase.from("departments").select("id, name").order("name"),
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

    if (interviewsRes.error) {
      if (isMissingSchemaResourceError(interviewsRes.error)) {
        return {
          schemaReady: false,
          accessScope: canReadAll ? ("all" as const) : ("assigned" as const),
          canManage,
          interviews: [],
          candidatesForScheduling: [],
          interviewerOptions: [],
          officeLocations: offices ?? [],
        };
      }
      rethrowDbError("Loading interviews failed", interviewsRes.error);
    }

    const rawInterviews = (interviewsRes.data ?? []).filter((iv) =>
      canReadAll ? true : (iv.interviewer_ids ?? []).includes(userId),
    );
    const feedbackList = feedbackRes.error ? [] : (feedbackRes.data ?? []);
    const candidateRows = candidatesRes.error ? [] : (candidatesRes.data ?? []);

    const deptMap = new Map((departments ?? []).map((d) => [d.id, d.name]));
    const officeMap = new Map((offices ?? []).map((o) => [o.id, o]));
    const candidateMap = new Map(candidateRows.map((c) => [c.id, c]));

    const userIds = new Set<string>();
    for (const iv of rawInterviews) {
      for (const id of iv.interviewer_ids ?? []) userIds.add(id);
      if (iv.scheduled_by) userIds.add(iv.scheduled_by);
    }
    for (const fb of feedbackList) userIds.add(fb.interviewer_id);
    const namesMap = await loadProfileNames(supabase, Array.from(userIds));

    const feedbackByInterview = new Map<
      string,
      (typeof feedbackList[number] & { interviewerName: string })[]
    >();
    for (const fb of feedbackList) {
      const arr = feedbackByInterview.get(fb.interview_id) ?? [];
      arr.push({ ...fb, interviewerName: nameOf(namesMap, fb.interviewer_id) });
      feedbackByInterview.set(fb.interview_id, arr);
    }

    const rolesByUser = new Map<string, Set<string>>();
    for (const r of roleRows ?? []) {
      const s = rolesByUser.get(r.user_id) ?? new Set<string>();
      s.add(r.role);
      rolesByUser.set(r.user_id, s);
    }

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

    const interviews = rawInterviews.map((iv) => {
      const cand = candidateMap.get(iv.candidate_id);
      const office = iv.office_location_id ? officeMap.get(iv.office_location_id) : null;
      const slot = formatInterviewIstSlot(iv.scheduled_start_at, iv.scheduled_end_at);
      const fbs = feedbackByInterview.get(iv.id) ?? [];
      const myFeedback = fbs.find((f) => f.interviewer_id === userId) ?? null;

      return {
        ...iv,
        istDateLabel: slot.dateLabel,
        istTimeRangeLabel: slot.timeRangeLabel,
        candidateName: cand?.full_name ?? "Candidate",
        candidateCode: cand?.candidate_code ?? "—",
        candidateEmail: cand?.email ?? "",
        candidateDesignation: cand?.designation ?? null,
        candidateDepartmentName: cand?.department_id
          ? (deptMap.get(cand.department_id) ?? null)
          : null,
        candidateStatus: cand?.status ?? "applied",
        hasResume: Boolean(cand?.resume_path),
        officeName: office?.name ?? null,
        officeAddress: office?.address ?? null,
        interviewers: (iv.interviewer_ids ?? []).map((id) => ({
          id,
          name: nameOf(namesMap, id),
        })),
        isAssignedToMe: (iv.interviewer_ids ?? []).includes(userId),
        canSubmitFeedback: canSubmitInterviewFeedback(
          userId,
          actor.permissions,
          iv.interviewer_ids ?? [],
        ),
        myFeedback,
        feedbacks: fbs,
      };
    });

    const schedulableCandidates = canManage
      ? candidateRows
          .filter(
            (c) =>
              c.status !== "rejected" &&
              c.status !== "withdrawn" &&
              c.status !== "onboarding",
          )
          .map((c) => ({
            id: c.id,
            candidateCode: c.candidate_code,
            fullName: c.full_name,
            email: c.email,
            designation: c.designation,
            status: c.status,
          }))
      : [];

    return {
      schemaReady: true,
      accessScope: canReadAll ? ("all" as const) : ("assigned" as const),
      canManage,
      interviews,
      candidatesForScheduling: schedulableCandidates,
      interviewerOptions,
      officeLocations: offices ?? [],
    };
  });

export const scheduleInterview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      candidateId: string;
      roundNumber?: number | undefined;
      roundName: string;
      mode: InterviewMode;
      scheduledStartAt: string;
      scheduledEndAt: string;
      meetingLink?: string | null | undefined;
      officeLocationId?: string | null | undefined;
      locationDetails?: string | null | undefined;
      interviewerIds: string[];
      instructions?: string | null | undefined;
    }) => {
      if (!input?.candidateId) throw new Error("Choose a candidate.");
      const roundName = String(input.roundName ?? "").trim();
      if (!roundName) throw new Error("Enter the interview round name (e.g. Technical Round 1).");
      if (!(INTERVIEW_MODES as readonly string[]).includes(input.mode)) {
        throw new Error("Interview mode must be online or offline.");
      }
      const startMs = Date.parse(input.scheduledStartAt);
      const endMs = Date.parse(input.scheduledEndAt);
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
        throw new Error("Valid interview start and end date/times are required.");
      }
      if (endMs <= startMs) {
        throw new Error("Interview end time must be after the start time.");
      }
      if (input.mode === "online" && !String(input.meetingLink ?? "").trim()) {
        throw new Error("Provide a meeting link for online interviews.");
      }
      if (
        input.mode === "offline" &&
        !input.officeLocationId &&
        !String(input.locationDetails ?? "").trim()
      ) {
        throw new Error("Select an office location or enter address details for offline interviews.");
      }
      const interviewerIds = Array.from(
        new Set((input.interviewerIds ?? []).map((id) => id.trim()).filter(Boolean)),
      );
      if (interviewerIds.length === 0) {
        throw new Error("Assign at least one interviewer.");
      }
      return {
        ...input,
        roundName,
        roundNumber: Math.max(1, Math.trunc(input.roundNumber ?? 1)),
        interviewerIds,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "interviews:manage:all");

    const { data: candidate, error: candErr } = await supabase
      .from("candidates")
      .select("id, full_name, designation, status")
      .eq("id", data.candidateId)
      .maybeSingle();

    if (candErr) {
      if (isMissingSchemaResourceError(candErr)) throw new Error(PENDING_SCHEMA_MSG);
      rethrowDbError("Loading candidate failed", candErr);
    }
    if (!candidate) throw new Error("Candidate not found.");

    const { data: created, error: insErr } = await supabase
      .from("interviews")
      .insert({
        candidate_id: data.candidateId,
        round_number: data.roundNumber,
        round_name: data.roundName,
        mode: data.mode,
        scheduled_start_at: new Date(data.scheduledStartAt).toISOString(),
        scheduled_end_at: new Date(data.scheduledEndAt).toISOString(),
        timezone: ORG_TIMEZONE,
        meeting_link: data.mode === "online" ? (data.meetingLink?.trim() || null) : null,
        office_location_id: data.mode === "offline" ? (data.officeLocationId || null) : null,
        location_details: data.locationDetails?.trim() || null,
        status: "scheduled",
        interviewer_ids: data.interviewerIds,
        lead_interviewer_id: data.interviewerIds[0] ?? null,
        instructions: data.instructions?.trim() || null,
        scheduled_by: userId,
      })
      .select("id, scheduled_start_at, scheduled_end_at")
      .single();

    if (insErr || !created) rethrowDbError("Scheduling interview failed", insErr);

    // Auto-progress early-stage candidates into `interview_scheduled`
    if (["applied", "screening", "shortlisted"].includes(candidate.status)) {
      await supabase
        .from("candidates")
        .update({ status: "interview_scheduled" })
        .eq("id", candidate.id);
    }

    const slot = formatInterviewIstSlot(created.scheduled_start_at, created.scheduled_end_at);

    await supabase.from("candidate_activities").insert({
      candidate_id: candidate.id,
      actor_id: userId,
      activity_type: "interview_scheduled",
      from_status: candidate.status,
      to_status: ["applied", "screening", "shortlisted"].includes(candidate.status)
        ? "interview_scheduled"
        : candidate.status,
      body: `Scheduled ${data.roundName} (${data.mode.toUpperCase()}) on ${slot.dateLabel} · ${slot.timeRangeLabel}`,
      metadata: { interviewId: created.id, roundNumber: data.roundNumber },
    });

    // Notify assigned interviewers in-app
    await Promise.all(
      data.interviewerIds
        .filter((id) => id !== userId)
        .map((interviewerId) =>
          notify(supabase, {
            userId: interviewerId,
            actorId: userId,
            type: "interview.assigned",
            title: `Interview assigned: ${candidate.full_name}`,
            body: `${data.roundName} (${candidate.designation ?? "Candidate"}) on ${slot.dateLabel} · ${slot.timeRangeLabel}`,
            entityType: "interview",
            entityId: created.id,
            actionLabel: "Open Interview",
            actionUrl: `/interviews?interviewId=${created.id}`,
            metadata: { candidateId: candidate.id },
          }),
        ),
    );

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: "interview.scheduled",
      entityType: "interview",
      entityId: created.id,
      detail: {
        candidateId: candidate.id,
        roundName: data.roundName,
        mode: data.mode,
        interviewerIds: data.interviewerIds,
      },
    });

    return { ok: true, interviewId: created.id };
  });

export const updateInterviewLifecycle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      interviewId: string;
      action: "reschedule" | "cancel" | "complete" | "no_show";
      scheduledStartAt?: string | undefined;
      scheduledEndAt?: string | undefined;
      mode?: InterviewMode | undefined;
      meetingLink?: string | null | undefined;
      officeLocationId?: string | null | undefined;
      locationDetails?: string | null | undefined;
      interviewerIds?: string[] | undefined;
      reason?: string | null | undefined;
    }) => {
      if (!input?.interviewId) throw new Error("Interview ID is required.");
      if (!["reschedule", "cancel", "complete", "no_show"].includes(input.action)) {
        throw new Error("Invalid interview action.");
      }
      if (input.action === "reschedule") {
        const s = Date.parse(input.scheduledStartAt ?? "");
        const e = Date.parse(input.scheduledEndAt ?? "");
        if (Number.isNaN(s) || Number.isNaN(e) || e <= s) {
          throw new Error("Valid rescheduled start and end times are required.");
        }
      }
      if (input.action === "cancel" && !String(input.reason ?? "").trim()) {
        throw new Error("Provide a reason when cancelling an interview.");
      }
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "interviews:manage:all");

    const { data: existing, error: loadErr } = await supabase
      .from("interviews")
      .select("*, candidates(id, full_name, status)")
      .eq("id", data.interviewId)
      .maybeSingle();

    if (loadErr) {
      if (isMissingSchemaResourceError(loadErr)) throw new Error(PENDING_SCHEMA_MSG);
      rethrowDbError("Loading interview failed", loadErr);
    }
    if (!existing) throw new Error("Interview not found.");

    const candidateInfo = existing.candidates as {
      id: string;
      full_name: string;
      status: string;
    } | null;

    const patch: import("@/integrations/supabase/types").Database["public"]["Tables"]["interviews"]["Update"] = {};
    let nextStatus = existing.status;

    if (data.action === "reschedule") {
      nextStatus = "rescheduled";
      patch.status = "rescheduled";
      patch.scheduled_start_at = new Date(data.scheduledStartAt!).toISOString();
      patch.scheduled_end_at = new Date(data.scheduledEndAt!).toISOString();
      if (data.mode) patch.mode = data.mode;
      if (data.meetingLink !== undefined) patch.meeting_link = data.meetingLink?.trim() || null;
      if (data.officeLocationId !== undefined)
        patch.office_location_id = data.officeLocationId || null;
      if (data.locationDetails !== undefined)
        patch.location_details = data.locationDetails?.trim() || null;
      if (data.interviewerIds && data.interviewerIds.length > 0) {
        patch.interviewer_ids = data.interviewerIds;
        patch.lead_interviewer_id = data.interviewerIds[0] ?? null;
      }
      patch.cancel_or_reschedule_reason = data.reason?.trim() || null;
    } else if (data.action === "cancel") {
      nextStatus = "cancelled";
      patch.status = "cancelled";
      patch.cancel_or_reschedule_reason = data.reason?.trim() || null;
    } else if (data.action === "complete") {
      nextStatus = "completed";
      patch.status = "completed";
    } else if (data.action === "no_show") {
      nextStatus = "no_show";
      patch.status = "no_show";
      patch.cancel_or_reschedule_reason = data.reason?.trim() || "Candidate did not attend";
    }

    const { error: updErr } = await supabase
      .from("interviews")
      .update(patch)
      .eq("id", existing.id);
    if (updErr) rethrowDbError("Updating interview failed", updErr);

    if (data.action === "complete" && candidateInfo?.status === "interview_scheduled") {
      await supabase
        .from("candidates")
        .update({ status: "interviewed" })
        .eq("id", existing.candidate_id);
    }

    await supabase.from("candidate_activities").insert({
      candidate_id: existing.candidate_id,
      actor_id: userId,
      activity_type: "interview_updated",
      body: `Interview "${existing.round_name}" marked ${nextStatus}${data.reason ? ` — ${data.reason}` : ""}`,
      metadata: { interviewId: existing.id, action: data.action },
    });

    if (data.action === "reschedule" || data.action === "cancel") {
      const notifyIds = (data.interviewerIds ?? existing.interviewer_ids ?? []).filter(
        (id) => id !== userId,
      );
      await Promise.all(
        notifyIds.map((interviewerId) =>
          notify(supabase, {
            userId: interviewerId,
            actorId: userId,
            type: `interview.${data.action}d`,
            title: `Interview ${data.action}d: ${candidateInfo?.full_name ?? "Candidate"}`,
            body: `${existing.round_name}${data.reason ? ` — ${data.reason}` : ""}`,
            entityType: "interview",
            entityId: existing.id,
            actionLabel: "Open Interview",
            actionUrl: `/interviews?interviewId=${existing.id}`,
            metadata: { candidateId: existing.candidate_id },
          }),
        ),
      );
    }

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: `interview.${data.action}`,
      entityType: "interview",
      entityId: existing.id,
      detail: { candidateId: existing.candidate_id, nextStatus, reason: data.reason ?? null },
    });

    return { ok: true, status: nextStatus };
  });

export const submitInterviewFeedback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      interviewId: string;
      rating: number;
      technicalRating?: number | null | undefined;
      communicationRating?: number | null | undefined;
      recommendation: InterviewRecommendation;
      strengths?: string | null | undefined;
      concerns?: string | null | undefined;
      notes?: string | null | undefined;
    }) => {
      if (!input?.interviewId) throw new Error("Interview ID is required.");
      const rating = Math.trunc(Number(input.rating));
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw new Error("Overall rating must be between 1 and 5.");
      }
      if (!(INTERVIEW_RECOMMENDATIONS as readonly string[]).includes(input.recommendation)) {
        throw new Error("Choose a valid hiring recommendation.");
      }
      const checkOptional = (v: number | null | undefined, label: string) => {
        if (v == null) return null;
        const n = Math.trunc(Number(v));
        if (!Number.isInteger(n) || n < 1 || n > 5) {
          throw new Error(`${label} must be between 1 and 5.`);
        }
        return n;
      };
      return {
        ...input,
        rating,
        technicalRating: checkOptional(input.technicalRating, "Technical rating"),
        communicationRating: checkOptional(input.communicationRating, "Communication rating"),
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const actor = await loadActor(supabase, userId);

    const { data: interview, error: ivErr } = await supabase
      .from("interviews")
      .select("id, candidate_id, round_name, interviewer_ids, scheduled_by, status")
      .eq("id", data.interviewId)
      .maybeSingle();

    if (ivErr) {
      if (isMissingSchemaResourceError(ivErr)) throw new Error(PENDING_SCHEMA_MSG);
      rethrowDbError("Loading interview for feedback failed", ivErr);
    }
    if (!interview) throw new Error("Interview not found or not assigned to you.");

    if (
      !canSubmitInterviewFeedback(
        userId,
        actor.permissions,
        interview.interviewer_ids ?? [],
      )
    ) {
      throw new Error(
        "Forbidden: only assigned interviewers or HR can submit feedback for this interview.",
      );
    }

    const { error: upsertErr } = await supabase.from("interview_feedback").upsert(
      {
        interview_id: interview.id,
        candidate_id: interview.candidate_id,
        interviewer_id: userId,
        rating: data.rating,
        technical_rating: data.technicalRating,
        communication_rating: data.communicationRating,
        recommendation: data.recommendation,
        strengths: data.strengths?.trim() || null,
        concerns: data.concerns?.trim() || null,
        notes: data.notes?.trim() || null,
        submitted_at: new Date().toISOString(),
      },
      { onConflict: "interview_id,interviewer_id" },
    );

    if (upsertErr) rethrowDbError("Saving interview feedback failed", upsertErr);

    await supabase.from("candidate_activities").insert({
      candidate_id: interview.candidate_id,
      actor_id: userId,
      activity_type: "interview_feedback",
      body: `Submitted scorecard for ${interview.round_name}: ${data.rating}/5 · ${INTERVIEW_RECOMMENDATION_LABELS[data.recommendation]}`,
      metadata: {
        interviewId: interview.id,
        rating: data.rating,
        recommendation: data.recommendation,
      },
    });

    if (interview.scheduled_by && interview.scheduled_by !== userId) {
      await notify(supabase, {
        userId: interview.scheduled_by,
        actorId: userId,
        type: "interview.feedback_submitted",
        title: `Scorecard submitted (${interview.round_name})`,
        body: `${actor.fullName} rated ${data.rating}/5 (${INTERVIEW_RECOMMENDATION_LABELS[data.recommendation]})`,
        entityType: "candidate",
        entityId: interview.candidate_id,
        section: "interviews",
        actionLabel: "View Scorecard",
        actionUrl: `/candidates/${interview.candidate_id}?section=interviews`,
        metadata: { candidateId: interview.candidate_id, interviewId: interview.id },
      });
    }

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: "interview.feedback_submitted",
      entityType: "interview",
      entityId: interview.id,
      detail: {
        candidateId: interview.candidate_id,
        rating: data.rating,
        recommendation: data.recommendation,
      },
    });

    return { ok: true };
  });
