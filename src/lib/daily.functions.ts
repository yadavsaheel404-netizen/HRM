import { createServerFn } from "@tanstack/react-start";
import {
  isBlockerCategory,
  isBlockerSeverity,
  type BlockerCategoryValue,
  type BlockerSeverityValue,
} from "@/lib/enums";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { nearestOffice, requiresLocation } from "@/lib/geo";
import { requirePermission } from "./actor.server";
import { writeAudit } from "./audit.server";
import { loadActiveOffices } from "./locations.server";
import { computeTargetAchievement, validateEodSubmission } from "./daily.server";
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

export type CheckInInput = {
  workMode: "wfo" | "wfh" | "hybrid" | "client_location" | "field_work";
  lateReason?: string | null;
  device?: Record<string, unknown> | null;
  /** Device reading, captured by the browser for on-site work modes. */
  location?: { latitude: number; longitude: number; accuracy?: number | null } | null;
};

/** Everything the "My Day" screen needs, all derived server-side. */
export const getMyDay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { date?: string } | undefined) => input ?? {})
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const workDate = data.date ?? todayIso();
    const day = await loadDay(supabase, userId, workDate);
    const allocations = await loadWorkableAllocations(supabase, userId);

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
      };
    }

    const [{ data: entries }, { data: breaks }, { data: blockers }, { data: eod }] =
      await Promise.all([
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
      ]);

    const metrics = await loadMetrics(supabase, day.id);
    const status = await loadStatus(supabase, day.id);

    const primary = allocations[0];
    const project = primary?.projects as
      | {
          hourly_task_target?: number | null;
          daily_task_target?: number | null;
          quality_target_pct?: number | null;
          max_rejection_rate_pct?: number | null;
        }
      | null;

    const approved = (entries ?? []).reduce((sum, e) => sum + Number(e.units_approved ?? 0), 0);
    const rejected = (entries ?? []).reduce((sum, e) => sum + Number(e.units_rejected ?? 0), 0);

    const achievement = computeTargetAchievement({
      taskMinutes: metrics.taskMinutes,
      unitsCompleted: metrics.unitsCompleted,
      unitsApproved: approved || null,
      unitsRejected: rejected || null,
      targets: {
        hourlyTarget: project?.hourly_task_target ?? null,
        dailyTarget: primary?.daily_task_target ?? project?.daily_task_target ?? null,
        qualityTargetPct: primary?.quality_target_pct ?? project?.quality_target_pct ?? null,
        maxRejectionRatePct:
          primary?.max_rejection_rate_pct ?? project?.max_rejection_rate_pct ?? null,
      },
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
          (blockers ?? []).map((b) => b.notified_lead_id),
        );
        return (blockers ?? []).map((b) => ({
          ...b,
          profiles: b.notified_lead_id
            ? { full_name: nameOf(leadNames, b.notified_lead_id) }
            : null,
        }));
      })(),

      eod,
      allocations,
      achievement,
    };
  });

export const checkIn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CheckInInput) => {
    if (!input?.workMode) throw new Error("Pick a work mode before checking in.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "attendance:log:self");

    const allocations = await loadWorkableAllocations(supabase, userId);
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

    const workDate = todayIso();
    const existing = await loadDay(supabase, userId, workDate);
    if (existing?.check_in_at) throw new Error("You are already checked in for today.");

    const requiredMinutes = Math.round(
      allocations.reduce((sum, a) => sum + Number(a.hours_per_day ?? 0), 0) * 60,
    );

    // Location gate — on-site work modes only. Everything else is unrestricted.
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
      if (offices.length === 0) {
        location.location_status = "not_provided";
      } else {
        const reading = data.location;
        if (
          !reading ||
          !Number.isFinite(Number(reading.latitude)) ||
          !Number.isFinite(Number(reading.longitude))
        ) {
          throw new Error(
            "Location access is required to check in as Work from office. Allow location access, or pick a different work mode if you are not on-site.",
          );
        }
        const coords = {
          latitude: Number(reading.latitude),
          longitude: Number(reading.longitude),
          accuracy: reading.accuracy == null ? null : Number(reading.accuracy),
        };
        const match = nearestOffice(coords, offices);
        if (!match || !match.withinRadius) {
          throw new Error(
            `You appear to be outside the office (about ${Math.round(match?.distance ?? 0)} m from ${match?.office.name ?? "the office"}, allowed ${match?.office.radius_meters ?? 0} m). Please select a different work mode if you're not on-site, or contact your admin if this is incorrect.`,
          );
        }
        location = {
          location_status: "verified",
          location_latitude: coords.latitude,
          location_longitude: coords.longitude,
          location_accuracy_m: coords.accuracy,
          location_distance_m: Math.round(match.distance * 10) / 10,
          office_location_id: match.office.id,
        };
      }
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
  .inputValidator((input: { device?: Record<string, unknown> | null } | undefined) => input ?? {})
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
  .inputValidator((input: TaskEntryInput) => {
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

    const { data: canLog } = await supabase.rpc("can_log_work", {
      _user_id: userId,
      _project_id: allocation.project_id,
    });
    if (canLog !== true) throw new Error("Work logging is blocked for that project.");

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
    return { entry: row };
  });

export const submitTaskEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => {
    if (!input?.id) throw new Error("An entry is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
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
    return { entry: row };
  });

export const deleteTaskEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => {
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
  .inputValidator((input: { category: string; note?: string | null }) => {
    if (!input?.category) throw new Error("Pick a break type.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const day = await loadDay(supabase, userId, todayIso());
    if (!day?.check_in_at) throw new Error("Check in before taking a break.");
    const { data: open } = await supabase
      .from("break_logs")
      .select("id")
      .eq("day_id", day.id)
      .is("ended_at", null)
      .maybeSingle();
    if (open) throw new Error("You already have a break running.");

    const { data: row, error } = await supabase
      .from("break_logs")
      .insert({
        day_id: day.id,
        user_id: userId,
        category: data.category as never,
        started_at: new Date().toISOString(),
        note: data.note?.trim() || null,
      })
      .select("*")
      .single();
    if (error) throw error;
    return { break: row };
  });

export const endBreak = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => {
    if (!input?.id) throw new Error("A break is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("break_logs")
      .update({ ended_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("*")
      .single();
    if (error) throw error;
    return { break: row };
  });

export const raiseBlocker = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
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
  .inputValidator((input: { id: string; note?: string | null }) => {
    if (!input?.id) throw new Error("A blocker is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
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
    return { blocker: row };
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
  .inputValidator((input: EodInput) => input ?? ({} as EodInput))
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
    const project = primary?.projects as
      | {
          hourly_task_target?: number | null;
          daily_task_target?: number | null;
          quality_target_pct?: number | null;
          max_rejection_rate_pct?: number | null;
        }
      | null;

    const achievement = computeTargetAchievement({
      taskMinutes: metrics.taskMinutes,
      unitsCompleted: metrics.unitsCompleted,
      unitsApproved:
        (entries ?? []).reduce((s, e) => s + Number(e.units_approved ?? 0), 0) || null,
      unitsRejected:
        (entries ?? []).reduce((s, e) => s + Number(e.units_rejected ?? 0), 0) || null,
      targets: {
        hourlyTarget: project?.hourly_task_target ?? null,
        dailyTarget: primary?.daily_task_target ?? project?.daily_task_target ?? null,
        qualityTargetPct: primary?.quality_target_pct ?? project?.quality_target_pct ?? null,
        maxRejectionRatePct:
          primary?.max_rejection_rate_pct ?? project?.max_rejection_rate_pct ?? null,
      },
    });

    const problems = data.submit
      ? validateEodSubmission({
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

    const payload = {
      day_id: day.id,
      user_id: userId,
      work_date: workDate,
      highlights: data.highlights?.trim() || null,
      challenges: data.challenges?.trim() || null,
      tomorrow_plan: data.tomorrowPlan?.trim() || null,
      support_needed: data.supportNeeded?.trim() || null,
      metrics: { ...metrics, achievement, open_blockers: (openBlockers ?? []).length } as never,
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
        await notify(supabase, {
          userId: leadId,
          actorId: userId,
          type: "eod.submitted",
          title: `${me?.full_name ?? "A team member"} submitted their EOD report`,
          body: `${metrics.unitsCompleted} units over ${(metrics.taskMinutes / 60).toFixed(2)}h of task time.`,
          entityType: "eod_report",
          entityId: row.id,
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
  .inputValidator((input: { date?: string } | undefined) => input ?? {})
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
  .inputValidator(
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
    const { data, error } = await context.supabase
      .from("notifications")
      .select("*")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    return data ?? [];
  });

export const markNotificationRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => {
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
