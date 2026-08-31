import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "./actor.server";
import { writeAudit } from "./audit.server";
import { notify } from "./daily-queries.server";
import { isReviewAction, type ReviewActionValue } from "./enums";
import { loadOversightRows, summariseRows, type OversightFilter } from "./oversight.server";
import { loadProfileNames, nameOf } from "./profile-names.server";


function defaultRange(input?: Partial<OversightFilter>): OversightFilter {
  const to = input?.to ?? new Date().toISOString().slice(0, 10);
  const from =
    input?.from ?? new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);
  return { from, to, userId: input?.userId ?? null, projectId: input?.projectId ?? null };
}

/**
 * One source of truth for the lead / admin / founder dashboards AND for the
 * CSV export — both call this, so they can never disagree.
 */
export const getOversight = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: Partial<OversightFilter> | undefined) => input ?? {})
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "attendance:read:team");
    const filter = defaultRange(data);
    const rows = await loadOversightRows(supabase, filter);
    return { filter, rows, summary: summariseRows(rows) };
  });

/** Consolidated EOD list for reviewers. */
export const listTeamEods = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { from?: string; to?: string } | undefined) => input ?? {})
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "eod:read:team");
    const filter = defaultRange(data);
    const { data: rows, error } = await supabase
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
  .inputValidator((input: { id: string; action: string; note?: string | null }) => {
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
  .inputValidator((input: { userId: string }) => {
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
  .inputValidator((input: { title: string; body: string }) => {
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
