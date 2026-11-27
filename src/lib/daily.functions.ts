import { createServerFn } from "@tanstack/react-start";
import {
  isBlockerCategory,
  isBlockerSeverity,
  type BlockerCategoryValue,
  type BlockerSeverityValue,
} from "@/lib/enums";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  evaluateWfhAuthorization,
  evaluateWfoGeofence,
  requiresLocation,
} from "@/lib/geo";
import { requirePermission } from "./actor.server";
import { writeAudit } from "./audit.server";
import { loadActiveOffices } from "./locations.server";
import { computeTargetAchievement, validateEodSubmission } from "./daily.server";
import { evalCanReviewOrEscalateSafe } from "./schema-compat.server";
import { eodModeFor, evaluateAnnotationLogging, requiresAllocationForCheckIn } from "./work-type";
import {
  assertCanLogAnnotationWork,
  loadAnnotationContext,
  loadProfileWorkTypeAssignment,
} from "./work-type.server";
import {
  ENTRY_SELECT,
  loadDay,
  loadMetrics,
  loadStatus,
  loadWorkableAllocations,
  notify,
  resolveWorkLead,
  todayIso,
} from "./daily-queries.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type CheckInInput = {
  workMode: "wfo" | "wfh" | "hybrid" | "client_location" | "field_work";
  lateReason?: string | null;
  device?: Record<string, unknown> | null;
  /** Device reading, captured by the browser for on-site work modes. */
  location?: { latitude: number; longitude: number; accuracy?: number | null } | null;
};

function aggregateAllocationTargets(
  allocations: Awaited<ReturnType<typeof loadWorkableAllocations>>,
) {
  const primary = allocations[0];
  const primaryProject = primary?.projects as
    | {
        hourly_task_target?: number | null;
        daily_task_target?: number | null;
        quality_target_pct?: number | null;
        max_rejection_rate_pct?: number | null;
      }
    | null;

  let dailySum = 0;
  let hasDaily = false;
  for (const alloc of allocations) {
    const proj = alloc.projects as { daily_task_target?: number | null } | null;
    const t = alloc.daily_task_target ?? proj?.daily_task_target ?? null;
    if (t != null && Number(t) > 0) {
      dailySum += Number(t);
      hasDaily = true;
    }
  }

  return {
    hourlyTarget: primaryProject?.hourly_task_target ?? null,
    dailyTarget: hasDaily
      ? dailySum
      : (primary?.daily_task_target ?? primaryProject?.daily_task_target ?? null),
    qualityTargetPct:
      primary?.quality_target_pct ?? primaryProject?.quality_target_pct ?? null,
    maxRejectionRatePct:
      primary?.max_rejection_rate_pct ?? primaryProject?.max_rejection_rate_pct ?? null,
  };
}

/** Everything the "My Day" screen needs, all derived server-side. */
export const getMyDay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { date?: string } | undefined) => input ?? {})
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const workDate = data.date ?? todayIso();
    const day = await loadDay(supabase, userId, workDate);
    const allocations = await loadWorkableAllocations(supabase, userId);
    const annotation = await loadAnnotationContext(supabase, userId, todayIso());
    const hourlyLogging = {
      eligible: annotation.logging.eligible,
      code: annotation.logging.code,
      reason: annotation.logging.reason,
      workType: annotation.profile.workType ?? null,
      eodMode: eodModeFor(annotation.profile),
      /** Allocation IDs that may receive hourly annotation logs today. */
      allocationIds: annotation.allocations
        .filter((a) => evaluateAnnotationLogging(annotation.profile, a, todayIso()).eligible)
        .map((a) => a.allocationId),
    };

    if (!day) {
      return {
        workDate,
        day: null,
        status: "absent",
        metrics: null,
        entries: [],
        breaks: [],
        blockers: [],
        eod: null,
        allocations,
        achievement: null,
        hourlyLogging,
        breakRequests: [],
      };
    }

    // Auto-reconcile scheduled breaks for today's active check-in
    if (day.check_in_at && !day.check_out_at && workDate === todayIso()) {
      try {
        const { reconcileScheduledBreaksInternal } = await import("./breaks.functions");
        await reconcileScheduledBreaksInternal(userId);
      } catch {
        // Non-blocking fallback
      }
    }

    const [
      { data: entries },
      { data: breaks },
      { data: blockers },
      { data: eod },
      breakRequestsResult,
    ] = await Promise.all([
      supabase
        .from("task_entries")
        .select(`${ENTRY_SELECT}, projects(code, name, task_unit)`)
        .eq("day_id", day.id)
        .order("started_at"),
      supabase.from("break_logs").select("*").eq("day_id", day.id).order("started_at"),
      supabase
        .from("blockers")
        .select("*, projects(code, name)")
        .eq("day_id", day.id)
        .order("started_at"),
      supabase.from("eod_reports").select("*").eq("day_id", day.id).maybeSingle(),
      (supabaseAdmin as any)
        .from("break_requests")
        .select("*")
        .eq("user_id", userId)
        .eq("work_date", workDate)
        .order("created_at", { ascending: false }),
    ]);
    const breakRequests = (breakRequestsResult as any)?.data || [];

    const metrics = await loadMetrics(supabase, day.id);
    const status = await loadStatus(supabase, day.id);

    const approved = (entries ?? []).reduce((sum: number, e: any) => sum + Number(e.units_approved ?? 0), 0);
    const rejected = (entries ?? []).reduce((sum: number, e: any) => sum + Number(e.units_rejected ?? 0), 0);

    const achievement = computeTargetAchievement({
      taskMinutes: metrics.taskMinutes,
      unitsCompleted: metrics.unitsCompleted,
      unitsApproved: approved || null,
      unitsRejected: rejected || null,
      targets: aggregateAllocationTargets(allocations),
    });

    return {
      workDate,
      day,
      status,
      metrics,
      entries: entries ?? [],
      breaks: breaks ?? [],
      blockers: await (async () => {
        // Lead names via profile_names(): an employee cannot read their lead's
        // profile row directly, which would blank the "notified" name.
        const { loadProfileNames, nameOf } = await import("./profile-names.server");
        const leadNames = await loadProfileNames(
          supabase,
          (blockers ?? []).map((b: any) => b.notified_lead_id),
        );
        return (blockers ?? []).map((b: any) => ({
          ...b,
          profiles: b.notified_lead_id
            ? { full_name: nameOf(leadNames, b.notified_lead_id) }
            : null,
        }));
      })(),

      eod,
      allocations,
      achievement: hourlyLogging.eodMode === "annotation" ? achievement : null,
      hourlyLogging,
      breakRequests,
    };
  });

export const checkIn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: CheckInInput) => {
    if (!input?.workMode) throw new Error("Pick a work mode before checking in.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "attendance:log:self");

    const { loadActor } = await import("./actor.server");
    const actor = await loadActor(supabase, userId);
    const { workType } = await loadProfileWorkTypeAssignment(supabase, userId);

    // Personal attendance is separate from annotation logging: management roles
    // and staff explicitly classified outside Annotation check in without an
    // allocation. Annotation / unclassified employees keep the existing gate.
    const allocations = await loadWorkableAllocations(supabase, userId);
    if (requiresAllocationForCheckIn({ roles: actor.roles, workType })) {
      if (allocations.length === 0) {
        throw new Error(
          "You have no active, acknowledged project assignment today, so work logging is closed. Acknowledge your assignment first.",
        );
      }
      // Second, authoritative gate: the same can_log_work() the RLS policy uses.
      const gated = await Promise.all(
        allocations.map(async (a) => {
          const { data: ok } = await supabase.rpc("can_log_work", {
            _user_id: userId,
            _project_id: a.project_id,
          });
          return ok === true;
        }),
      );
      if (!gated.some(Boolean)) {
        throw new Error("Work logging is blocked until an assignment is active and acknowledged.");
      }
    }

    const workDate = todayIso();
    const existing = await loadDay(supabase, userId, workDate);
    if (existing?.check_in_at) throw new Error("You are already checked in for today.");

    const requiredMinutes =
      allocations.length > 0
        ? Math.round(
            allocations.reduce((sum, a) => sum + Number(a.hours_per_day ?? 0), 0) * 60,
          )
        : 480;

    // Location & WFH authorization gates
    let location = {
      location_status: "not_required" as string,
      location_latitude: null as number | null,
      location_longitude: null as number | null,
      location_accuracy_m: null as number | null,
      location_distance_m: null as number | null,
      office_location_id: null as string | null,
    };

    if (requiresLocation(data.workMode)) {
      const offices = await loadActiveOffices(supabase);
      location = evaluateWfoGeofence(data.location, offices);
    } else if (data.workMode === "wfh") {
      const [{ data: wfhRequests }, { data: profileRow }] = await Promise.all([
        supabase
          .from("requests")
          .select("id")
          .eq("user_id", userId)
          .eq("request_type", "wfh")
          .eq("status", "approved")
          .lte("start_date", workDate)
          .gte("end_date", workDate)
          .limit(1),
        supabase
          .from("profiles")
          .select("work_location")
          .eq("id", userId)
          .maybeSingle(),
      ]);

      const projectWorkModes = allocations.map(
        (a) => (a.projects as { work_mode?: string | null } | null)?.work_mode ?? null,
      );
      const isRemoteProfile =
        profileRow?.work_location === "remote" || profileRow?.work_location === "hybrid";

      evaluateWfhAuthorization({
        projectWorkModes,
        hasApprovedWfhToday: (wfhRequests ?? []).length > 0,
        isAuthorizedRemoteRole: isRemoteProfile,
      });
    }

    const payload = {
      user_id: userId,
      work_date: workDate,
      work_mode: data.workMode,
      check_in_at: new Date().toISOString(),
      late_reason: data.lateReason?.trim() || null,
      check_in_device: (data.device ?? {}) as never,
      required_minutes: requiredMinutes > 0 ? requiredMinutes : 480,
      ...location,
    };


    const { data: row, error } = existing
      ? await supabase
          .from("attendance_days")
          .update(payload)
          .eq("id", existing.id)
          .select("*")
          .single()
      : await supabase.from("attendance_days").insert(payload).select("*").single();
    if (error) throw error;

    await writeAudit(supabase, {
      actorId: userId,
      action: "attendance.checked_in",
      entityType: "attendance_day",
      entityId: row.id,
      detail: {
        work_mode: data.workMode,
        required_minutes: row.required_minutes,
        location_status: row.location_status,
        location_distance_m: row.location_distance_m,
        office_location_id: row.office_location_id,
      },
    });

    return { day: row };
  });

export const checkOut = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { device?: Record<string, unknown> | null } | undefined) => input ?? {})
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const day = await loadDay(supabase, userId, todayIso());
    if (!day?.check_in_at) throw new Error("You have not checked in today.");
    if (day.check_out_at) throw new Error("You already checked out today.");

    const { data: openBreak } = await supabase
      .from("break_logs")
      .select("id")
      .eq("day_id", day.id)
      .is("ended_at", null)
      .maybeSingle();
    if (openBreak) throw new Error("End your open break before checking out.");

    const { data: row, error } = await supabase
      .from("attendance_days")
      .update({
        check_out_at: new Date().toISOString(),
        check_out_device: (data.device ?? {}) as never,
      })
      .eq("id", day.id)
      .select("*")
      .single();
    if (error) throw error;

    const status = await loadStatus(supabase, day.id);
    await writeAudit(supabase, {
      actorId: userId,
      action: "attendance.checked_out",
      entityType: "attendance_day",
      entityId: day.id,
      detail: { derived_status: status },
    });
    return { day: row, status };
  });

export type TaskEntryInput = {
  id?: string | undefined;
  allocationId: string;
  slotType: "fixed" | "flexible";
  startedAt: string;
  endedAt: string;
  taskDescription: string;
  unitsCompleted: number;
  /** Tasks assigned for this slot, captured alongside completion. */
  unitsAssigned?: number | null;
  submit?: boolean;
};

export const saveTaskEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: TaskEntryInput) => {
    if (!input?.allocationId) throw new Error("Pick the project you worked on.");
    if (!input.startedAt || !input.endedAt) throw new Error("Give the entry a start and end time.");
    if (new Date(input.endedAt) <= new Date(input.startedAt))
      throw new Error("The entry must end after it starts.");
    if (!input.taskDescription?.trim()) throw new Error("Describe what you worked on.");
    if (Number(input.unitsCompleted) < 0) throw new Error("Units cannot be negative.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "tasks:log:self");

    const day = await loadDay(supabase, userId, todayIso());
    if (!day?.check_in_at) throw new Error("Check in before logging work.");

    const allocations = await loadWorkableAllocations(supabase, userId);
    const allocation = allocations.find((a) => a.id === data.allocationId);
    if (!allocation)
      throw new Error("That assignment is not active and acknowledged, so you cannot log to it.");

    // One authoritative policy: role = employee, work type = annotation, verified &
    // active, full-time/intern, active acknowledged allocation on an active
    // annotation project. RLS + trigger enforce the same rule in the database.
    await assertCanLogAnnotationWork(supabase, userId, allocation.project_id, todayIso());

    const payload = {
      day_id: day.id,
      user_id: userId,
      project_id: allocation.project_id,
      allocation_id: allocation.id,
      slot_type: data.slotType,
      started_at: data.startedAt,
      ended_at: data.endedAt,
      task_description: data.taskDescription.trim(),
      units_completed: Number(data.unitsCompleted) || 0,
      units_assigned:
        data.unitsAssigned == null || data.unitsAssigned === ("" as unknown as number)
          ? null
          : Number(data.unitsAssigned),
      status: (data.submit ? "submitted" : "draft") as "submitted" | "draft",
    };

    const { data: row, error } = data.id
      ? await supabase
          .from("task_entries")
          .update(payload)
          .eq("id", data.id)
          .select(ENTRY_SELECT)
          .single()
      : await supabase.from("task_entries").insert(payload).select(ENTRY_SELECT).single();
    if (error) throw error;

    await writeAudit(supabase, {
      actorId: userId,
      action: data.id ? "task_entry.updated" : "task_entry.created",
      entityType: "task_entry",
      entityId: row.id,
      detail: { status: row.status, units: row.units_completed, project_id: row.project_id },
    });

    if (row.status === "submitted") {
      try {
        const { leadId } = await resolveWorkLead(supabase, userId, allocation.id, allocation.project_id);
        if (leadId && leadId !== userId) {
          const { data: me } = await supabase
            .from("profiles")
            .select("full_name")
            .eq("id", userId)
            .maybeSingle();
          const workDate = todayIso();
          await notify(supabase, {
            userId: leadId,
            actorId: userId,
            type: "task_entry.submitted",
            title: `${me?.full_name ?? "A team member"} submitted a task entry`,
            body: `${row.units_completed ?? 0} units logged for review.`,
            entityType: "task_entry",
            entityId: row.id,
            actionLabel: "Review Task",
            actionUrl: `/reviews?entryId=${row.id}&date=${workDate}&employeeId=${userId}`,
            metadata: { workDate, employeeId: userId },
          });
        }
      } catch {
        // Non-fatal
      }
    }

    return { entry: row };
  });

export const submitTaskEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { id: string }) => {
    if (!input?.id) throw new Error("An entry is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { data: existingEntry } = await context.supabase
      .from("task_entries")
      .select("project_id, allocation_id")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!existingEntry) throw new Error("That entry is not yours or no longer exists.");
    await assertCanLogAnnotationWork(
      context.supabase,
      context.userId,
      existingEntry.project_id,
      todayIso(),
    );

    const { data: row, error } = await context.supabase
      .from("task_entries")
      .update({ status: "submitted" })
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select(ENTRY_SELECT)
      .single();
    if (error) throw error;
    await writeAudit(context.supabase, {
      actorId: context.userId,
      action: "task_entry.submitted",
      entityType: "task_entry",
      entityId: data.id,
      detail: { units: row.units_completed },
    });

    try {
      const { leadId } = await resolveWorkLead(
        context.supabase,
        context.userId,
        existingEntry.allocation_id,
        existingEntry.project_id,
      );
      if (leadId && leadId !== context.userId) {
        const { data: me } = await context.supabase
          .from("profiles")
          .select("full_name")
          .eq("id", context.userId)
          .maybeSingle();
        const workDate = todayIso();
        await notify(context.supabase, {
          userId: leadId,
          actorId: context.userId,
          type: "task_entry.submitted",
          title: `${me?.full_name ?? "A team member"} submitted a task entry`,
          body: `${row.units_completed ?? 0} units logged for review.`,
          entityType: "task_entry",
          entityId: row.id,
          actionLabel: "Review Task",
          actionUrl: `/reviews?entryId=${row.id}&date=${workDate}&employeeId=${context.userId}`,
          metadata: { workDate, employeeId: context.userId },
        });
      }
    } catch {
      // Non-fatal
    }

    return { entry: row };
  });

export const deleteTaskEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { id: string }) => {
    if (!input?.id) throw new Error("An entry is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("task_entries")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw error;
    return { ok: true };
  });

export const startBreak = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      category: string;
      note?: string | null;
      requestId?: string | null;
    }) => {
      if (!input?.category) throw new Error("Pick a break type.");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { startBreakStrict } = await import("./breaks.functions");
    return await startBreakStrict({
      data: {
        category: data.category as any,
        requestId: data.requestId,
      },
      context,
    } as any);
  });

export const endBreak = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { id: string }) => {
    if (!input?.id) throw new Error("A break is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { endBreakStrict } = await import("./breaks.functions");
    return await endBreakStrict({ data, context } as any);
  });

export const raiseBlocker = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      allocationId?: string | null;
      category: string;
      severity: string;
      description: string;
    }) => {
      if (!isBlockerCategory(input?.category)) throw new Error("Pick a blocker category.");
      if (input?.severity && !isBlockerSeverity(input.severity))
        throw new Error("Pick a valid blocker severity.");
      if (!input?.description?.trim()) throw new Error("Describe the blocker.");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "blockers:raise:self");
    const day = await loadDay(supabase, userId, todayIso());
    if (!day?.check_in_at) throw new Error("Check in before raising a blocker.");

    const allocations = await loadWorkableAllocations(supabase, userId);
    const allocation = allocations.find((a) => a.id === data.allocationId) ?? allocations[0] ?? null;

    const { leadId, source } = await resolveWorkLead(
      supabase,
      userId,
      allocation?.id ?? null,
      allocation?.project_id ?? null,
    );

    const { data: row, error } = await supabase
      .from("blockers")
      .insert({
        day_id: day.id,
        user_id: userId,
        project_id: allocation?.project_id ?? null,
        allocation_id: allocation?.id ?? null,
        category: data.category as BlockerCategoryValue,
        severity: (data.severity || "medium") as BlockerSeverityValue,
        description: data.description.trim(),
        started_at: new Date().toISOString(),
        notified_lead_id: leadId,
        notified_at: leadId ? new Date().toISOString() : null,
      })
      .select("*")
      .single();
    if (error) throw error;

    let notified = false;
    if (leadId) {
      const { data: me } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", userId)
        .maybeSingle();
      notified = await notify(supabase, {
        userId: leadId,
        actorId: userId,
        type: "blocker.raised",
        title: `${me?.full_name ?? "A team member"} raised a ${data.category.replace("_", " ")} blocker`,
        body: data.description.trim(),
        entityType: "blocker",
        entityId: row.id,
        section: "blockers",
        actionLabel: "Review Blocker",
        actionUrl: `/team?employeeId=${userId}&blockerId=${row.id}&section=blockers`,
        metadata: { employeeId: userId },
      });
    }

    await writeAudit(supabase, {
      actorId: userId,
      action: "blocker.raised",
      entityType: "blocker",
      entityId: row.id,
      detail: {
        category: data.category,
        severity: data.severity,
        notified_lead_id: leadId,
        lead_source: source,
        notification_created: notified,
      },
    });

    return { blocker: row, leadId, leadSource: source, notified };
  });

export const resolveBlocker = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { id: string; note?: string | null }) => {
    if (!input?.id) throw new Error("A blocker is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: existing, error: findErr } = await supabase
      .from("blockers")
      .select("id, user_id, notified_lead_id")
      .eq("id", data.id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!existing) throw new Error("Blocker not found or not visible to you.");

    if (existing.user_id === userId) {
      await requirePermission(supabase, userId, "blockers:raise:self");
    } else {
      await requirePermission(supabase, userId, "blockers:manage:team");
      if (existing.notified_lead_id !== userId) {
        const canReview = await evalCanReviewOrEscalateSafe(supabase, existing.user_id, userId);
        if (!canReview) {
          throw new Error("Forbidden: you can only resolve blockers for your assigned team or escalations.");
        }
      }
    }

    const { data: row, error } = await supabase
      .from("blockers")
      .update({
        status: "resolved",
        resolved_at: new Date().toISOString(),
        resolution_note: data.note?.trim() || null,
      })
      .eq("id", data.id)
      .select("*")
      .single();
    if (error) throw error;

    if (row.user_id !== userId) {
      await notify(supabase, {
        userId: row.user_id,
        actorId: userId,
        type: "blocker.resolved",
        title: "Your blocker was marked resolved",
        body: data.note?.trim() || row.description,
        entityType: "blocker",
        entityId: row.id,
        section: "blockers",
        actionLabel: "View Blocker",
        actionUrl: `/my-day?section=blockers&blockerId=${row.id}`,
      });
    }

    await writeAudit(supabase, {
      actorId: userId,
      action: "blocker.resolved",
      entityType: "blocker",
      entityId: row.id,
      detail: { note: data.note?.trim() || null, owner_id: row.user_id },
    });

    return { blocker: row };
  });

export const listTeamBlockers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "blockers:manage:team");
    const { data: rows, error } = await supabase
      .from("blockers")
      .select("*, projects(code, name), attendance_days(work_date)")
      .neq("user_id", userId)
      .order("started_at", { ascending: false })
      .limit(100);
    if (error) throw error;

    const { loadProfileNames, nameOf } = await import("./profile-names.server");
    const names = await loadProfileNames(
      supabase,
      (rows ?? []).flatMap((b) => [b.user_id, b.notified_lead_id]),
    );
    return (rows ?? []).map((b) => ({
      ...b,
      authorName: nameOf(names, b.user_id),
      leadName: b.notified_lead_id ? nameOf(names, b.notified_lead_id) : null,
    }));
  });

export type EodInput = {
  highlights: string;
  challenges?: string | null;
  tomorrowPlan: string;
  supportNeeded?: string | null;
  submit?: boolean;
};

/** Builds the report from the day's real data, then validates before submit. */
export const saveEodReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: EodInput) => input ?? ({} as EodInput))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "eod:submit:self");
    const workDate = todayIso();
    const day = await loadDay(supabase, userId, workDate);
    if (!day) throw new Error("There is no attendance record for today.");

    const metrics = await loadMetrics(supabase, day.id);
    const { data: entries } = await supabase
      .from("task_entries")
      .select("units_completed, units_approved, units_rejected, project_id, allocation_id")
      .eq("day_id", day.id);
    const { data: openBreak } = await supabase
      .from("break_logs")
      .select("id")
      .eq("day_id", day.id)
      .is("ended_at", null)
      .maybeSingle();
    const { data: openBlockers } = await supabase
      .from("blockers")
      .select("id")
      .eq("day_id", day.id)
      .neq("status", "resolved");

    const allocations = await loadWorkableAllocations(supabase, userId);
    const primary = allocations[0];
    const annotationCtx = await loadAnnotationContext(supabase, userId, workDate);
    const eodMode = eodModeFor(annotationCtx.profile);

    const achievement =
      eodMode === "annotation"
        ? computeTargetAchievement({
            taskMinutes: metrics.taskMinutes,
            unitsCompleted: metrics.unitsCompleted,
            unitsApproved:
              (entries ?? []).reduce((s, e) => s + Number(e.units_approved ?? 0), 0) || null,
            unitsRejected:
              (entries ?? []).reduce((s, e) => s + Number(e.units_rejected ?? 0), 0) || null,
            targets: aggregateAllocationTargets(allocations),
          })
        : null;

    const problems = data.submit
      ? validateEodSubmission({
          mode: eodMode,
          checkedIn: Boolean(day.check_in_at),
          checkedOut: Boolean(day.check_out_at),
          metrics,
          hasOpenBreak: Boolean(openBreak),
          highlights: data.highlights ?? "",
          tomorrowPlan: data.tomorrowPlan ?? "",
          openBlockers: (openBlockers ?? []).length,
        })
      : [];
    if (problems.length > 0) throw new Error(`EOD_INVALID::${JSON.stringify(problems)}`);

    const annotationSummary =
      eodMode === "annotation"
        ? {
            projects: annotationCtx.allocations
              .filter((a) => a.projectWorkType === "annotation")
              .map((a) => ({
                project_id: a.projectId,
                code: a.projectCode,
                name: a.projectName,
                units_submitted: (entries ?? [])
                  .filter((e) => e.project_id === a.projectId)
                  .reduce((s, e) => s + Number(e.units_completed ?? 0), 0),
                daily_target: a.dailyTarget,
                hourly_target: a.hourlyTarget,
              })),
            hours_worked: Math.round((metrics.taskMinutes / 60) * 100) / 100,
            units_submitted: metrics.unitsCompleted,
            entries_pending_review: (entries ?? []).length,
          }
        : null;

    const payload = {
      day_id: day.id,
      user_id: userId,
      work_date: workDate,
      highlights: data.highlights?.trim() || null,
      challenges: data.challenges?.trim() || null,
      tomorrow_plan: data.tomorrowPlan?.trim() || null,
      support_needed: data.supportNeeded?.trim() || null,
      metrics: {
        ...metrics,
        eod_mode: eodMode,
        achievement,
        annotation: annotationSummary,
        open_blockers: (openBlockers ?? []).length,
      } as never,
      status: (data.submit ? "submitted" : "draft") as "submitted" | "draft",
      submitted_at: data.submit ? new Date().toISOString() : null,
    };

    const { data: existing } = await supabase
      .from("eod_reports")
      .select("id")
      .eq("day_id", day.id)
      .maybeSingle();

    const { data: row, error } = existing
      ? await supabase
          .from("eod_reports")
          .update(payload)
          .eq("id", existing.id)
          .select("*")
          .single()
      : await supabase.from("eod_reports").insert(payload).select("*").single();
    if (error) throw error;

    const status = await loadStatus(supabase, day.id);

    if (data.submit) {
      const { leadId } = await resolveWorkLead(
        supabase,
        userId,
        primary?.id ?? null,
        primary?.project_id ?? null,
      );
      if (leadId) {
        const { data: me } = await supabase
          .from("profiles")
          .select("full_name")
          .eq("id", userId)
          .maybeSingle();
        const workDate = todayIso();
        await notify(supabase, {
          userId: leadId,
          actorId: userId,
          type: "eod.submitted",
          title: `${me?.full_name ?? "A team member"} submitted their EOD report`,
          body:
            eodMode === "annotation"
              ? `${metrics.unitsCompleted} units over ${(metrics.taskMinutes / 60).toFixed(2)}h of task time.`
              : "General EOD report submitted.",
          entityType: "eod_report",
          entityId: row.id,
          section: "eod",
          actionLabel: "Review EOD",
          actionUrl: `/team?employeeId=${userId}&eodId=${row.id}&section=eod&date=${workDate}`,
          metadata: { employeeId: userId, workDate },
        });
      }
      await writeAudit(supabase, {
        actorId: userId,
        action: "eod.submitted",
        entityType: "eod_report",
        entityId: row.id,
        detail: { metrics, achievement, derived_status: status },
      });
    }

    return { report: row, metrics, achievement, status };
  });

/** Lead-side review of hourly entries. */
export const listTeamEntries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { date?: string } | undefined) => input ?? {})
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "tasks:read:team");
    const workDate = data.date ?? todayIso();
    const { data: rows, error } = await supabase
      .from("task_entries")
      .select(
        `${ENTRY_SELECT}, user_id, projects(code, name, task_unit), attendance_days!inner(work_date)`,
      )
      .eq("attendance_days.work_date", workDate)
      .neq("user_id", userId)
      .order("started_at");
    if (error) throw error;
    // profile_names() instead of an embedded profiles join: the reviewer may not
    // hold direct read access to the author's profile row, which would blank the name.
    const { loadProfileNames, nameOf } = await import("./profile-names.server");
    const names = await loadProfileNames(supabase, (rows ?? []).map((r) => r.user_id));
    return {
      workDate,
      entries: (rows ?? []).map((r) => ({
        ...r,
        profiles: { full_name: nameOf(names, r.user_id) },
      })),
    };

  });

export const reviewTaskEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      id: string;
      decision: "approved" | "revision_required" | "reviewed";
      unitsApproved?: number | null;
      unitsRejected?: number | null;
      note?: string | null;
    }) => {
      if (!input?.id) throw new Error("An entry is required.");
      if (!input?.decision) throw new Error("A decision is required.");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "tasks:review:team");

    const { data: target, error: findErr } = await supabase
      .from("task_entries")
      .select("id, user_id")
      .eq("id", data.id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!target) throw new Error("Task entry not found or not visible to you.");
    if (target.user_id === userId) {
      throw new Error("Forbidden: you cannot review your own task entry.");
    }
    const canReview = await evalCanReviewOrEscalateSafe(supabase, target.user_id, userId);
    if (!canReview) {
      throw new Error("Forbidden: you can only review task entries for your assigned scope or escalations.");
    }

    const { data: row, error } = await supabase
      .from("task_entries")
      .update({
        status: data.decision,
        units_approved: data.unitsApproved ?? null,
        units_rejected: data.unitsRejected ?? null,
        reviewer_id: userId,
        reviewed_at: new Date().toISOString(),
        review_note: data.note?.trim() || null,
      })
      .eq("id", data.id)
      .select(`${ENTRY_SELECT}, user_id`)
      .single();
    if (error) throw error;

    await notify(supabase, {
      userId: row.user_id,
      actorId: userId,
      type: `task_entry.${data.decision}`,
      title:
        data.decision === "approved"
          ? "A task entry was approved"
          : "A task entry needs revision",
      body: data.note?.trim() || null,
      entityType: "task_entry",
      entityId: row.id,
      section: "tasks",
      actionLabel: "View Task Log",
      actionUrl: `/my-day?section=tasks&entryId=${row.id}`,
    });
    await writeAudit(supabase, {
      actorId: userId,
      action: `task_entry.${data.decision}`,
      entityType: "task_entry",
      entityId: row.id,
      detail: { units_approved: data.unitsApproved, units_rejected: data.unitsRejected },
    });
    return { entry: row };
  });

export const listMyNotifications = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { loadActor } = await import("./actor.server");
    const { loadProtectedAccountIds } = await import("./work-type.server");
    const [actor, protectedIds, { data, error }] = await Promise.all([
      loadActor(context.supabase, context.userId),
      loadProtectedAccountIds(context.supabase),
      context.supabase
        .from("notifications")
        .select("*")
        .eq("user_id", context.userId)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    if (error) throw error;
    const isSuperAdmin = actor.roles.includes("super_admin");
    return (data ?? []).map((row: any) => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const empId = typeof meta["employeeId"] === "string" ? meta["employeeId"] : null;
      const isProtected =
        !isSuperAdmin &&
        ((row.actor_id && protectedIds.has(row.actor_id)) ||
          (empId && protectedIds.has(empId)) ||
          (row.entity_type === "profile" && row.entity_id && protectedIds.has(row.entity_id)));
      if (!isProtected) return row;
      return {
        ...row,
        actor_id: null,
        action_url: null,
        metadata: { ...meta, employeeId: null, protectedSubject: true },
      };
    });
  });

export const markNotificationRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { id: string }) => {
    if (!input?.id) throw new Error("A notification is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw error;
    return { ok: true };
  });

export const markAllNotificationsRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await context.supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("user_id", context.userId)
      .is("read_at", null);
    if (error) throw error;
    return { ok: true };
  });

export const resolveNotificationDestinationServer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { id: string; markRead?: boolean }) => {
    if (!input?.id) throw new Error("A notification id is required.");
    return { id: String(input.id), markRead: input.markRead !== false };
  })
  .handler(async ({ data, context }) => {
    const { loadActor } = await import("./actor.server");
    const { loadProtectedAccountIds } = await import("./work-type.server");
    const { resolveNotificationLink, UNAVAILABLE_TARGET_MESSAGE } = await import(
      "./notifications/navigation"
    );

    const [actor, protectedIds, { data: row, error }] = await Promise.all([
      loadActor(context.supabase, context.userId),
      loadProtectedAccountIds(context.supabase),
      context.supabase
        .from("notifications")
        .select("*")
        .eq("id", data.id)
        .eq("user_id", context.userId)
        .maybeSingle(),
    ]);

    if (error) throw error;
    if (!row) {
      return {
        ok: false as const,
        unavailable: true,
        unavailableMessage: UNAVAILABLE_TARGET_MESSAGE,
        to: "/dashboard",
        search: {} as Record<string, string>,
        fallbackTo: "/dashboard",
        markedRead: false,
      };
    }

    let markedRead = Boolean(row.read_at);
    if (data.markRead && !row.read_at) {
      const { error: readErr } = await context.supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq("user_id", context.userId);
      if (!readErr) markedRead = true;
    }

    const resolved = resolveNotificationLink(row as any, actor, { protectedIds });
    if (resolved.unavailable) {
      return {
        ok: true as const,
        unavailable: true,
        unavailableMessage: resolved.unavailableMessage ?? UNAVAILABLE_TARGET_MESSAGE,
        to: resolved.fallbackTo ?? "/dashboard",
        search: {} as Record<string, string>,
        fallbackTo: resolved.fallbackTo ?? "/dashboard",
        markedRead,
      };
    }

    // Live existence + RLS visibility verification for structured UUID entities
    const entityId = row.entity_id ?? null;
    const isUuid =
      typeof entityId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entityId);
    let targetExists = true;

    if (isUuid && !resolved.isHistoricalFallback) {
      const sb = context.supabase as any;
      if (resolved.to === "/requests") {
        const tbl = resolved.search["breakRequestId"] ? "break_requests" : "requests";
        const checkId = resolved.search["breakRequestId"] || resolved.search["requestId"] || entityId;
        if (tbl === "requests") {
          const { data: found } = await sb.from("requests").select("id").eq("id", checkId).maybeSingle();
          targetExists = Boolean(found);
        }
      } else if (resolved.to.startsWith("/workforce/")) {
        const personId = resolved.to.slice("/workforce/".length);
        const { data: found } = await sb.from("profiles").select("id").eq("id", personId).maybeSingle();
        targetExists = Boolean(found);
      } else if (resolved.to.startsWith("/projects/")) {
        const projectId = resolved.to.slice("/projects/".length);
        const { data: found } = await sb.from("projects").select("id").eq("id", projectId).maybeSingle();
        targetExists = Boolean(found);
      } else if (resolved.to === "/my-projects") {
        const allocId = resolved.search["allocationId"] || entityId;
        const { data: found } = await sb
          .from("project_allocations")
          .select("id")
          .eq("id", allocId)
          .maybeSingle();
        targetExists = Boolean(found);
      } else if (resolved.to === "/interviews" && resolved.search["interviewId"]) {
        const { data: found } = await sb
          .from("interviews")
          .select("id")
          .eq("id", resolved.search["interviewId"])
          .maybeSingle();
        targetExists = Boolean(found);
      } else if (resolved.to.startsWith("/candidates/")) {
        const candId = resolved.to.slice("/candidates/".length);
        const { data: found } = await sb.from("candidates").select("id").eq("id", candId).maybeSingle();
        targetExists = Boolean(found);
      } else if (resolved.to === "/records" && resolved.search["recordId"]) {
        const recordId = resolved.search["recordId"];
        if (!recordId.startsWith("wf:")) {
          const { data: found } = await sb
            .from("employee_records")
            .select("id")
            .eq("id", recordId)
            .maybeSingle();
          targetExists = Boolean(found);
        }
      }
    }

    if (!targetExists) {
      return {
        ok: true as const,
        unavailable: true,
        unavailableMessage: UNAVAILABLE_TARGET_MESSAGE,
        to: resolved.fallbackTo ?? "/dashboard",
        search: {} as Record<string, string>,
        fallbackTo: resolved.fallbackTo ?? "/dashboard",
        markedRead,
      };
    }

    return {
      ok: true as const,
      unavailable: false,
      unavailableMessage: null,
      to: resolved.to,
      search: resolved.search,
      fallbackTo: resolved.fallbackTo ?? resolved.to,
      markedRead,
    };
  });

export {
  requestPersonalizedBreak,
  cancelPersonalizedBreak,
  decidePersonalizedBreak,
  listPersonalizedBreakRequests,
} from "./breaks.functions";

