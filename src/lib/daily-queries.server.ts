// Server-only data helpers shared by the daily-cycle server functions.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { normaliseMetrics, type DayMetrics } from "./daily.server";

type Client = SupabaseClient<Database>;

export const ENTRY_SELECT =
  "id, day_id, project_id, allocation_id, slot_type, started_at, ended_at, task_description, units_completed, units_assigned, units_approved, units_rejected, status, reviewer_id, reviewed_at, review_note";

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function loadMetrics(supabase: Client, dayId: string): Promise<DayMetrics> {
  const { data, error } = await supabase.rpc("attendance_day_metrics", { _day_id: dayId });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return normaliseMetrics(row as Record<string, unknown> | null);
}

export async function loadStatus(supabase: Client, dayId: string): Promise<string> {
  const { data, error } = await supabase.rpc("derive_attendance_status", { _day_id: dayId });
  if (error) throw error;
  return (data as string) ?? "absent";
}

/** Active, acknowledged allocations the person may log work against today. */
export async function loadWorkableAllocations(supabase: Client, userId: string) {
  const { data, error } = await supabase
    .from("project_allocations")
    .select(
      "id, project_id, reporting_lead_id, hours_per_day, daily_task_target, quality_target_pct, max_rejection_rate_pct, status, acknowledged_at, start_date, end_date, projects(id, code, name, client_name, task_unit, hourly_task_target, daily_task_target, quality_target_pct, max_rejection_rate_pct, project_lead_id)",
    )
    .eq("user_id", userId)
    .eq("status", "active")
    .not("acknowledged_at", "is", null);
  if (error) throw error;
  const today = todayIso();
  return (data ?? []).filter(
    (a) => (a.start_date ?? today) <= today && (!a.end_date || a.end_date >= today),
  );
}

/**
 * The real reporting lead for this piece of work: the allocation's lead first,
 * then the project lead, then the person's org reporting lead. Never a guess.
 */
export async function resolveWorkLead(
  supabase: Client,
  userId: string,
  allocationId: string | null,
  projectId: string | null,
): Promise<{ leadId: string | null; source: string }> {
  if (allocationId) {
    const { data } = await supabase
      .from("project_allocations")
      .select("reporting_lead_id, project_id, projects(project_lead_id)")
      .eq("id", allocationId)
      .maybeSingle();
    if (data?.reporting_lead_id) return { leadId: data.reporting_lead_id, source: "allocation" };
    const projectLead = (data?.projects as { project_lead_id?: string | null } | null)
      ?.project_lead_id;
    if (projectLead) return { leadId: projectLead, source: "project_lead" };
  }
  if (projectId) {
    const { data } = await supabase
      .from("projects")
      .select("project_lead_id")
      .eq("id", projectId)
      .maybeSingle();
    if (data?.project_lead_id) return { leadId: data.project_lead_id, source: "project_lead" };
  }
  const { data: profile } = await supabase
    .from("profiles")
    .select("reporting_lead_id")
    .eq("id", userId)
    .maybeSingle();
  if (profile?.reporting_lead_id)
    return { leadId: profile.reporting_lead_id, source: "profile_reporting_lead" };
  return { leadId: null, source: "none" };
}

export async function notify(
  supabase: Client,
  entry: {
    userId: string;
    actorId: string;
    type: string;
    title: string;
    body?: string | null;
    entityType?: string | null;
    entityId?: string | null;
  },
): Promise<boolean> {
  const { error } = await supabase.from("notifications").insert({
    user_id: entry.userId,
    actor_id: entry.actorId,
    type: entry.type,
    title: entry.title,
    body: entry.body ?? null,
    entity_type: entry.entityType ?? null,
    entity_id: entry.entityId ?? null,
  });
  if (error) {
    console.error("[notify] failed", entry.type, error.message);
    return false;
  }
  return true;
}

export async function loadDay(supabase: Client, userId: string, workDate: string) {
  const { data, error } = await supabase
    .from("attendance_days")
    .select("*")
    .eq("user_id", userId)
    .eq("work_date", workDate)
    .maybeSingle();
  if (error) throw error;
  return data;
}
