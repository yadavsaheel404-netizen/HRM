import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { loadActor, requirePermission } from "./actor.server";
import { writeAudit } from "./audit.server";
import { notify } from "./daily-queries.server";
import { isReviewAction, type ReviewActionValue } from "./enums";
import { loadOversightRows, summariseRows, type OversightFilter } from "./oversight.server";
import { loadProfileNames, nameOf } from "./profile-names.server";
import { evalCanReviewOrEscalateSafe, resolveSupervisorScope } from "./schema-compat.server";
import { daysAgoIso, todayIso } from "./timezone";

function defaultRange(input?: Partial<OversightFilter>): OversightFilter {
  const now = new Date();
  const to = input?.to ?? todayIso(now);
  const from = input?.from ?? daysAgoIso(13, now);
  return { from, to, userId: input?.userId ?? null, projectId: input?.projectId ?? null };
}

/**
 * One source of truth for the lead / admin / founder dashboards AND for the
 * CSV export — both call this, so they can never disagree.
 */
export const getOversight = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: Partial<OversightFilter> | undefined) => input ?? {})
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "attendance:read:team");
    const actor = await loadActor(supabase, userId);
    const filter = defaultRange(data);
    const allRows = await loadOversightRows(supabase, filter);
    const scope = actor.permissions.includes("attendance:read:all")
      ? null
      : await resolveSupervisorScope(supabase, userId, actor.roles);
    const rows = scope ? allRows.filter((r) => scope.scopedUserIds.has(r.userId)) : allRows;
    return { filter, rows, summary: summariseRows(rows) };
  });

/** Consolidated EOD list for reviewers. */
export const listTeamEods = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { from?: string; to?: string } | undefined) => input ?? {})
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "eod:read:team");
    const actor = await loadActor(supabase, userId);
    const scope = actor.permissions.includes("eod:read:all")
      ? null
      : await resolveSupervisorScope(supabase, userId, actor.roles);
    const filter = defaultRange(data);
    const { data: rawRows, error } = await supabase
      .from("eod_reports")
      .select(
        "id, day_id, user_id, work_date, highlights, challenges, tomorrow_plan, support_needed, metrics, status, submitted_at, reviewed_by, reviewed_at, review_note",
      )
      .gte("work_date", filter.from)
      .lte("work_date", filter.to)
      .neq("user_id", userId)
      .order("work_date", { ascending: false })
      .limit(200);
    if (error) throw error;
    const rows = scope
      ? (rawRows ?? []).filter((r) => scope.scopedUserIds.has(r.user_id))
      : (rawRows ?? []);

    const ids = (rows ?? []).map((r) => r.id);
    type EodEvent = {
      id: string;
      entity_id: string;
      action: string;
      note: string | null;
      reviewer_id: string;
      created_at: string;
      profiles: { full_name?: string } | null;
    };

    const { data: events } = ids.length
      ? await supabase
          .from("review_events")
          .select("id, entity_id, action, note, reviewer_id, created_at")
          .eq("entity_type", "eod_report")
          .in("entity_id", ids)
          .order("created_at", { ascending: false })
      : { data: [] as unknown[] };

    // profile_names() keeps author and reviewer names visible even when the
    // viewer has no direct RLS access to those profile rows.
    const names = await loadProfileNames(supabase, [
      ...(rows ?? []).map((r) => r.user_id),
      ...((events ?? []) as { reviewer_id: string }[]).map((e) => e.reviewer_id),
    ]);

    const grouped: Record<string, EodEvent[]> = {};
    for (const event of (events ?? []) as Omit<EodEvent, "profiles">[]) {
      (grouped[event.entity_id] ??= []).push({
        ...event,
        profiles: { full_name: nameOf(names, event.reviewer_id) },
      });
    }

    return {
      filter,
      reports: (rows ?? []).map((r) => ({
        ...r,
        profiles: { full_name: nameOf(names, r.user_id) },
        events: grouped[r.id] ?? [],
      })),
    };
  });


const ACTION_TO_STATUS: Record<ReviewActionValue, string> = {
  approved: "approved",
  approved_with_comment: "approved",
  revision_requested: "revision_required",
  escalated: "escalated",
  performance_concern: "performance_concern",
};

export const reviewEodReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { id: string; action: string; note?: string | null }) => {
    if (!input?.id) throw new Error("An EOD report is required.");
    if (!isReviewAction(input?.action)) throw new Error("Pick a valid review action.");
    if (
      (input.action === "approved_with_comment" ||
        input.action === "revision_requested" ||
        input.action === "escalated" ||
        input.action === "performance_concern") &&
      !input.note?.trim()
    )
      throw new Error("This action needs a comment so the person knows why.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "eod:review:team");

    const { data: target, error: findErr } = await supabase
      .from("eod_reports")
      .select("id, user_id")
      .eq("id", data.id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!target) throw new Error("EOD report not found or not visible to you.");
    if (target.user_id === userId) {
      throw new Error("Forbidden: you cannot review your own EOD report.");
    }
    const canReview = await evalCanReviewOrEscalateSafe(supabase, target.user_id, userId);
    if (!canReview) {
      throw new Error("Forbidden: you can only review EOD reports for your assigned scope or escalations.");
    }

    const action = data.action as ReviewActionValue;
    const now = new Date().toISOString();

    const { data: report, error } = await supabase
      .from("eod_reports")
      .update({
        status: ACTION_TO_STATUS[action] as never,
        reviewed_by: userId,
        reviewed_at: now,
        review_note: data.note?.trim() || null,
      })
      .eq("id", data.id)
      .select("id, user_id, work_date, status, reviewed_by, reviewed_at, review_note")
      .single();
    if (error) throw error;

    const { error: eventError } = await supabase.from("review_events").insert({
      entity_type: "eod_report",
      entity_id: report.id,
      subject_user_id: report.user_id,
      action,
      note: data.note?.trim() || null,
      reviewer_id: userId,
    });
    if (eventError) throw eventError;

    const { data: me } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", userId)
      .maybeSingle();

    const notified = await notify(supabase, {
      userId: report.user_id,
      actorId: userId,
      type: `eod.${action}`,
      title: `${me?.full_name ?? "Your lead"} reviewed your ${report.work_date} EOD report`,
      body: `${action.replace(/_/g, " ")}${data.note?.trim() ? `: ${data.note.trim()}` : ""}`,
      entityType: "eod_report",
      entityId: report.id,
      section: "eod",
      actionLabel: "Open EOD",
      actionUrl: `/my-day?section=eod&eodId=${report.id}`,
      metadata: { workDate: report.work_date, action },
    });

    await writeAudit(supabase, {
      actorId: userId,
      action: `eod.${action}`,
      entityType: "eod_report",
      entityId: report.id,
      detail: { note: data.note ?? null, notified },
    });

    return { report, notified };
  });

/** Review-action trail for a single person — used by the drill-down view. */
export const listReviewEvents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { userId: string }) => {
    if (!input?.userId) throw new Error("A person is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("review_events")
      .select("id, entity_type, entity_id, action, note, reviewer_id, created_at")
      .eq("subject_user_id", data.userId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    const names = await loadProfileNames(
      context.supabase,
      (rows ?? []).map((r) => r.reviewer_id),
    );
    return (rows ?? []).map((r) => ({
      ...r,
      profiles: { full_name: nameOf(names, r.reviewer_id) },
    }));

  });

export const listAnnouncements = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("announcements")
      .select("id, title, body, audience, published, published_at, created_by")
      .order("published_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    return data ?? [];
  });

export const publishAnnouncement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { title: string; body: string }) => {
    if (!input?.title?.trim()) throw new Error("Give the announcement a title.");
    if (!input?.body?.trim()) throw new Error("Write the announcement body.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "announcements:manage:all");
    const { data: row, error } = await supabase
      .from("announcements")
      .insert({ title: data.title.trim(), body: data.body.trim(), created_by: userId })
      .select("*")
      .single();
    if (error) throw error;
    await writeAudit(supabase, {
      actorId: userId,
      action: "announcement.published",
      entityType: "announcement",
      entityId: row.id,
    });
    return { announcement: row };
  });

export const listAuditLog = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "audit:read:all");
    const { data, error } = await supabase
      .from("audit_logs")
      .select("id, actor_email, action, entity_type, entity_id, detail, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return data ?? [];
  });

export const listCalendarDays = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("org_calendar_days")
      .select("id, calendar_date, kind, label, project_id, source, created_at")
      .order("calendar_date", { ascending: false })
      .limit(200);
    if (error) throw error;
    return data ?? [];
  });

export const upsertCalendarDay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { calendarDate: string; kind: "holiday" | "weekly_off"; label?: string | null }) => {
    if (!input?.calendarDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.calendarDate)) {
      throw new Error("A valid date (YYYY-MM-DD) is required.");
    }
    if (input.kind !== "holiday" && input.kind !== "weekly_off") {
      throw new Error("Calendar day kind must be holiday or weekly_off.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const [{ data: canOrg }, { data: canImport }] = await Promise.all([
      supabase.rpc("has_permission", { _user_id: userId, _permission: "org:manage:all" }),
      supabase.rpc("has_permission", { _user_id: userId, _permission: "import:manage:all" }),
    ]);
    if (canOrg !== true && canImport !== true) {
      await requirePermission(supabase, userId, "org:manage:all");
    }

    const { data: existing } = await supabase
      .from("org_calendar_days")
      .select("id")
      .eq("calendar_date", data.calendarDate)
      .is("project_id", null)
      .maybeSingle();

    const payload = {
      calendar_date: data.calendarDate,
      kind: data.kind,
      label: data.label?.trim() || (data.kind === "holiday" ? "Holiday" : "Weekly Off"),
      project_id: null,
      source: "manual",
    };

    const { data: row, error } = existing
      ? await supabase
          .from("org_calendar_days")
          .update(payload)
          .eq("id", existing.id)
          .select("*")
          .single()
      : await supabase.from("org_calendar_days").insert(payload).select("*").single();
    if (error) throw error;

    await writeAudit(supabase, {
      actorId: userId,
      action: "calendar.day_saved",
      entityType: "org_calendar_day",
      entityId: row.id,
      detail: { calendar_date: data.calendarDate, kind: data.kind, label: payload.label },
    });

    return { day: row };
  });

export const deleteCalendarDay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { id: string }) => {
    if (!input?.id) throw new Error("A calendar day id is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const [{ data: canOrg }, { data: canImport }] = await Promise.all([
      supabase.rpc("has_permission", { _user_id: userId, _permission: "org:manage:all" }),
      supabase.rpc("has_permission", { _user_id: userId, _permission: "import:manage:all" }),
    ]);
    if (canOrg !== true && canImport !== true) {
      await requirePermission(supabase, userId, "org:manage:all");
    }

    const { error } = await supabase.from("org_calendar_days").delete().eq("id", data.id);
    if (error) throw error;

    await writeAudit(supabase, {
      actorId: userId,
      action: "calendar.day_deleted",
      entityType: "org_calendar_day",
      entityId: data.id,
    });
    return { ok: true };
  });
