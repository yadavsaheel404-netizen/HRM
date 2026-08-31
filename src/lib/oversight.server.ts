// Server-only oversight helpers. Every dashboard number and every export row
// is produced HERE, from the same Phase 3 primitives (attendance_day_metrics,
// derive_attendance_status, computeTargetAchievement) — so an export can never
// disagree with what a dashboard shows.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { computeTargetAchievement, type TargetAchievement } from "./daily.server";
import { loadMetrics, loadStatus } from "./daily-queries.server";
import { loadProfileNames, nameOf } from "./profile-names.server";

import type { DayMetrics } from "./daily.server";

type Client = SupabaseClient<Database>;

export type OversightRow = {
  dayId: string;
  userId: string;
  fullName: string;
  workDate: string;
  workMode: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  requiredMinutes: number;
  status: string;
  metrics: DayMetrics;
  achievement: TargetAchievement;
  projectCode: string | null;
  eodStatus: string | null;
  locationStatus: string;
  locationDistanceM: number | null;
  locationAccuracyM: number | null;
  locationLatitude: number | null;
  locationLongitude: number | null;
  officeName: string | null;
};

export type OversightFilter = {
  from: string;
  to: string;
  userId?: string | null;
  projectId?: string | null;
};

/**
 * Loads attendance days visible to the caller (RLS decides the scope) and
 * decorates each one with the derived status, metrics and target maths.
 */
export async function loadOversightRows(
  supabase: Client,
  filter: OversightFilter,
): Promise<OversightRow[]> {
  let query = supabase
    .from("attendance_days")
    .select(
      "id, user_id, work_date, work_mode, check_in_at, check_out_at, required_minutes, location_status, location_distance_m, location_accuracy_m, location_latitude, location_longitude, office_locations(name)",
    )
    .gte("work_date", filter.from)
    .lte("work_date", filter.to)
    .order("work_date", { ascending: false })
    .limit(500);
  if (filter.userId) query = query.eq("user_id", filter.userId);

  const { data: days, error } = await query;
  if (error) throw error;

  // Names via profile_names(): an embedded profiles join returns NULL when the
  // reviewer has no direct RLS access to that profile, silently blanking the
  // dashboard and the CSV export instead of failing.
  const names = await loadProfileNames(supabase, (days ?? []).map((d) => d.user_id));


  const rows: OversightRow[] = [];
  for (const day of days ?? []) {
    const [metrics, status] = await Promise.all([
      loadMetrics(supabase, day.id),
      loadStatus(supabase, day.id),
    ]);

    const { data: entries } = await supabase
      .from("task_entries")
      .select("project_id, units_completed, units_approved, units_rejected")
      .eq("day_id", day.id);

    const scoped = (entries ?? []).filter(
      (e) => !filter.projectId || e.project_id === filter.projectId,
    );
    if (filter.projectId && scoped.length === 0) continue;

    // Targets come from a security-definer helper, not from an embedded
    // projects join: a reviewer may not hold read access to the project row,
    // and a missing join would silently blank out the achievement maths.
    const { data: targetRows } = await supabase.rpc("day_targets", { _day_id: day.id });
    const project = ((targetRows ?? [])[0] ?? null) as {
      project_code?: string | null;
      hourly_task_target?: number | null;
      daily_task_target?: number | null;
      quality_target_pct?: number | null;
      max_rejection_rate_pct?: number | null;
    } | null;

    const unitsApproved = scoped.reduce((sum, e) => sum + (e.units_approved ?? 0), 0);
    const unitsRejected = scoped.reduce((sum, e) => sum + (e.units_rejected ?? 0), 0);
    const unitsCompleted = filter.projectId
      ? scoped.reduce((sum, e) => sum + Number(e.units_completed ?? 0), 0)
      : metrics.unitsCompleted;

    const { data: eod } = await supabase
      .from("eod_reports")
      .select("status")
      .eq("day_id", day.id)
      .maybeSingle();

    rows.push({
      dayId: day.id,
      userId: day.user_id,
      fullName: nameOf(names, day.user_id),
      workDate: day.work_date,
      workMode: day.work_mode,
      checkInAt: day.check_in_at,
      checkOutAt: day.check_out_at,
      requiredMinutes: day.required_minutes,
      status,
      metrics,
      achievement: computeTargetAchievement({
        taskMinutes: metrics.taskMinutes,
        unitsCompleted,
        unitsApproved: unitsApproved || null,
        unitsRejected: unitsRejected || null,
        targets: {
          hourlyTarget: project?.hourly_task_target ?? null,
          dailyTarget: project?.daily_task_target ?? null,
          qualityTargetPct: project?.quality_target_pct ?? null,
          maxRejectionRatePct: project?.max_rejection_rate_pct ?? null,
        },
      }),
      projectCode: project?.project_code ?? null,
      eodStatus: eod?.status ?? null,
      locationStatus: day.location_status ?? "not_required",
      locationDistanceM: day.location_distance_m == null ? null : Number(day.location_distance_m),
      locationAccuracyM: day.location_accuracy_m == null ? null : Number(day.location_accuracy_m),
      locationLatitude: day.location_latitude == null ? null : Number(day.location_latitude),
      locationLongitude: day.location_longitude == null ? null : Number(day.location_longitude),
      officeName: (day.office_locations as { name?: string } | null)?.name ?? null,
    });
  }
  return rows;
}

/** Roll-up used by the lead / admin / founder summary cards. */
export function summariseRows(rows: OversightRow[]) {
  const people = new Set(rows.map((r) => r.userId));
  const workedMinutes = rows.reduce((s, r) => s + r.metrics.workedMinutes, 0);
  const uncovered = rows.reduce((s, r) => s + r.metrics.uncoveredMinutes, 0);
  const units = rows.reduce((s, r) => s + r.achievement.unitsCompleted, 0);
  const withPct = rows.filter((r) => r.achievement.dailyAchievementPct != null);
  const avgAchievement =
    withPct.length > 0
      ? Math.round(
          (withPct.reduce((s, r) => s + (r.achievement.dailyAchievementPct ?? 0), 0) /
            withPct.length) *
            10,
        ) / 10
      : null;

  const byStatus: Record<string, number> = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;

  return {
    days: rows.length,
    people: people.size,
    workedHours: Math.round((workedMinutes / 60) * 10) / 10,
    uncoveredMinutes: uncovered,
    unitsCompleted: units,
    avgAchievementPct: avgAchievement,
    byStatus,
    problemDays: rows.filter(
      (r) =>
        r.status === "review_required" ||
        r.status === "missed_check_out" ||
        r.status === "half_day" ||
        r.status === "present_hours_incomplete",
    ).length,
  };
}
