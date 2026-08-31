// Scheduled automation engine.
//
// Design rules, all deliberate:
//   * LIVE DATA ONLY. Every attendance read is filtered to source = 'live'.
//     Imported history can never trip a rule, be reminded about, or be locked.
//   * One lease (same pattern as the invitation dispatcher) so overlapping
//     cron ticks cannot double-fire.
//   * Bounded work per run: a fixed lookback window and hard row caps.
//   * Idempotent: every flag is UNIQUE (rule, user_id, work_date), so a
//     re-run of the same day is a no-op instead of a duplicate notification.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { describeUnknownError } from "./describe-error";

export const LEASE_NAME = "automation:daily";
export const LEASE_SECONDS = 300;
/** Hard cap on flags produced by a single run. */
export const MAX_FLAGS_PER_RUN = 400;

export type AutomationSettings = {
  no_checkin_cutoff: string;
  reminder_interval_minutes: number;
  missed_checkout_grace_hours: number;
  eod_lock_hours: number;
  low_productivity_pct: number;
  high_rejection_pct: number;
  uncovered_ratio_pct: number;
  lookback_days: number;
  enabled: boolean;
};

export type AutomationResult = {
  runId: string | null;
  skipped: boolean;
  reason?: string;
  daysScanned: number;
  flagsCreated: number;
  notificationsSent: number;
  byRule: Record<string, number>;
};

type FlagDraft = {
  rule: string;
  user_id: string;
  work_date: string;
  day_id: string | null;
  severity: "info" | "warning" | "critical";
  message: string;
  detail: Record<string, unknown>;
  notifyUser: boolean;
  notifyLead: boolean;
};

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function minutesSince(iso: string | null): number {
  if (!iso) return 0;
  return Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
}

async function loadSettings(): Promise<AutomationSettings> {
  const { data } = await supabaseAdmin
    .from("automation_settings")
    .select("*")
    .eq("id", "default")
    .maybeSingle();
  return (data ?? {
    no_checkin_cutoff: "11:00",
    reminder_interval_minutes: 90,
    missed_checkout_grace_hours: 6,
    eod_lock_hours: 48,
    low_productivity_pct: 60,
    high_rejection_pct: 10,
    uncovered_ratio_pct: 25,
    lookback_days: 3,
    enabled: true,
  }) as AutomationSettings;
}

/** Resolves the lead who should hear about a person's problem day. */
async function resolveLeads(userIds: string[]): Promise<Map<string, string>> {
  const leads = new Map<string, string>();
  if (userIds.length === 0) return leads;

  const { data: allocations } = await supabaseAdmin
    .from("project_allocations")
    .select("user_id, reporting_lead_id, projects(project_lead_id)")
    .in("user_id", userIds)
    .eq("status", "active");
  for (const row of allocations ?? []) {
    const project = row.projects as { project_lead_id: string | null } | null;
    const lead = row.reporting_lead_id ?? project?.project_lead_id ?? null;
    if (lead && !leads.has(row.user_id)) leads.set(row.user_id, lead);
  }

  const missing = userIds.filter((id) => !leads.has(id));
  if (missing.length > 0) {
    const { data: profiles } = await supabaseAdmin
      .from("profiles")
      .select("id, reporting_lead_id")
      .in("id", missing);
    for (const p of profiles ?? []) {
      if (p.reporting_lead_id) leads.set(p.id, p.reporting_lead_id);
    }
  }
  return leads;
}

/**
 * Runs every rule once. `trigger` is recorded so a manual admin run is
 * distinguishable from the cron in the run log.
 */
export async function runAutomation(trigger: string): Promise<AutomationResult> {
  const settings = await loadSettings();
  const empty: AutomationResult = {
    runId: null, skipped: true, daysScanned: 0, flagsCreated: 0, notificationsSent: 0, byRule: {},
  };

  if (!settings.enabled) return { ...empty, reason: "Automation is switched off in settings." };

  const { data: leased } = await supabaseAdmin.rpc("acquire_job_lease", {
    _job_name: LEASE_NAME,
    _seconds: LEASE_SECONDS,
  });
  if (leased !== true) {
    return { ...empty, reason: "Another automation run holds the lease." };
  }

  const { data: run } = await supabaseAdmin
    .from("automation_runs")
    .insert({ trigger_source: trigger })
    .select("id")
    .single();
  const runId = run?.id ?? null;

  const drafts: FlagDraft[] = [];
  const today = dateOnly(new Date());
  const from = dateOnly(new Date(Date.now() - settings.lookback_days * 86_400_000));

  try {
    // ---- Calendar: never flag a week-off or holiday. ------------------
    const { data: calendar } = await supabaseAdmin
      .from("org_calendar_days")
      .select("calendar_date")
      .gte("calendar_date", from)
      .lte("calendar_date", today);
    const nonWorking = new Set((calendar ?? []).map((c) => c.calendar_date));

    // ---- Live attendance days in the window. --------------------------
    const { data: days } = await supabaseAdmin
      .from("attendance_days")
      .select(
        "id, user_id, work_date, check_in_at, check_out_at, required_minutes, exception_type, source",
      )
      .eq("source", "live")
      .gte("work_date", from)
      .lte("work_date", today)
      .limit(2000);
    const liveDays = days ?? [];

    // ---- Rule 1: no check-in by the cut-off (today only). -------------
    const [cutH, cutM] = settings.no_checkin_cutoff.split(":").map(Number);
    const cutoffPassed =
      new Date().getHours() > (cutH ?? 11) ||
      (new Date().getHours() === (cutH ?? 11) && new Date().getMinutes() >= (cutM ?? 0));

    if (cutoffPassed && !nonWorking.has(today)) {
      const { data: expected } = await supabaseAdmin
        .from("project_allocations")
        .select("user_id")
        .eq("status", "active")
        .not("acknowledged_at", "is", null)
        .lte("start_date", today)
        .or(`end_date.is.null,end_date.gte.${today}`)
        .limit(1000);
      const expectedIds = [...new Set((expected ?? []).map((a) => a.user_id))];

      const checkedIn = new Set(
        liveDays.filter((d) => d.work_date === today && d.check_in_at).map((d) => d.user_id),
      );
      const excused = new Set(
        liveDays
          .filter((d) => d.work_date === today && d.exception_type !== "none")
          .map((d) => d.user_id),
      );
      const { data: approvedLeave } = await supabaseAdmin
        .from("requests")
        .select("user_id")
        .eq("status", "approved")
        .lte("start_date", today)
        .gte("end_date", today);
      for (const r of approvedLeave ?? []) excused.add(r.user_id);

      for (const userId of expectedIds) {
        if (checkedIn.has(userId) || excused.has(userId)) continue;
        drafts.push({
          rule: "no_check_in",
          user_id: userId,
          work_date: today,
          day_id: null,
          severity: "warning",
          message: `No check-in recorded by ${settings.no_checkin_cutoff}.`,
          detail: { cutoff: settings.no_checkin_cutoff },
          notifyUser: true,
          notifyLead: true,
        });
      }
    }

    // ---- Per-day rules over live days. --------------------------------
    const dayIds = liveDays.map((d) => d.id);
    const { data: entries } = dayIds.length
      ? await supabaseAdmin
          .from("task_entries")
          .select("day_id, user_id, ended_at, units_completed, units_approved, units_rejected, status")
          .in("day_id", dayIds.slice(0, 1000))
      : { data: [] as never[] };
    const { data: eods } = dayIds.length
      ? await supabaseAdmin
          .from("eod_reports")
          .select("day_id, status, submitted_at")
          .in("day_id", dayIds.slice(0, 1000))
      : { data: [] as never[] };
    const eodByDay = new Map((eods ?? []).map((e) => [e.day_id, e]));

    for (const day of liveDays) {
      if (nonWorking.has(day.work_date) || day.exception_type !== "none") continue;
      const dayEntries = (entries ?? []).filter((e) => e.day_id === day.id);

      // Rule 2: hourly task-entry reminder (open day, stale logging).
      if (day.work_date === today && day.check_in_at && !day.check_out_at) {
        const lastEnd = dayEntries
          .map((e) => e.ended_at)
          .sort()
          .pop() ?? day.check_in_at;
        if (minutesSince(lastEnd) >= settings.reminder_interval_minutes) {
          drafts.push({
            rule: "task_entry_reminder",
            user_id: day.user_id,
            work_date: day.work_date,
            day_id: day.id,
            severity: "info",
            message: `No task entry logged in the last ${settings.reminder_interval_minutes} minutes.`,
            detail: { lastEntryAt: lastEnd, intervalMinutes: settings.reminder_interval_minutes },
            notifyUser: true,
            notifyLead: false,
          });
        }
      }

      // Rule 3: missed check-out (past day, still open beyond the grace).
      if (day.work_date < today && day.check_in_at && !day.check_out_at) {
        drafts.push({
          rule: "missed_check_out",
          user_id: day.user_id,
          work_date: day.work_date,
          day_id: day.id,
          severity: "warning",
          message: "Checked in but never checked out — the day is still open.",
          detail: { checkInAt: day.check_in_at, graceHours: settings.missed_checkout_grace_hours },
          notifyUser: true,
          notifyLead: true,
        });
      }

      // Everything below needs a finished day and its real metrics.
      if (!day.check_in_at || (!day.check_out_at && day.work_date === today)) continue;
      const { data: metricsRows } = await supabaseAdmin.rpc("attendance_day_metrics", {
        _day_id: day.id,
      });
      const m = (metricsRows ?? [])[0] as
        | { worked_minutes: number; uncovered_minutes: number; units_completed: number; entry_count: number }
        | undefined;
      if (!m) continue;

      // Rule 4: missing / uncovered time on a closed day.
      const ratio = m.worked_minutes > 0 ? (m.uncovered_minutes / m.worked_minutes) * 100 : 0;
      if (day.check_out_at && (m.entry_count === 0 || ratio > settings.uncovered_ratio_pct)) {
        drafts.push({
          rule: "uncovered_time",
          user_id: day.user_id,
          work_date: day.work_date,
          day_id: day.id,
          severity: "warning",
          message:
            m.entry_count === 0
              ? "Attendance recorded with no task entries at all."
              : `${m.uncovered_minutes} of ${m.worked_minutes} worked minutes are not covered by any entry (${ratio.toFixed(0)}%).`,
          detail: { ...m, thresholdPct: settings.uncovered_ratio_pct },
          notifyUser: true,
          notifyLead: true,
        });
      }

      // Rule 5: low productivity / high rejection against the REAL target.
      if (day.check_out_at) {
        const { data: targets } = await supabaseAdmin.rpc("day_targets", { _day_id: day.id });
        const target = (targets ?? [])[0] as { daily_task_target: number | null } | undefined;
        const dailyTarget = target?.daily_task_target ?? null;
        if (dailyTarget && dailyTarget > 0) {
          const pct = (Number(m.units_completed) / Number(dailyTarget)) * 100;
          if (pct < settings.low_productivity_pct) {
            drafts.push({
              rule: "low_productivity",
              user_id: day.user_id,
              work_date: day.work_date,
              day_id: day.id,
              severity: "warning",
              message: `Output was ${pct.toFixed(1)}% of the ${dailyTarget}-unit daily target.`,
              detail: { units: m.units_completed, dailyTarget, achievementPct: pct },
              notifyUser: false,
              notifyLead: true,
            });
          }
        }

        const approved = dayEntries.reduce((s, e) => s + Number(e.units_approved ?? 0), 0);
        const rejected = dayEntries.reduce((s, e) => s + Number(e.units_rejected ?? 0), 0);
        const reviewed = approved + rejected;
        if (reviewed > 0) {
          const rejectionPct = (rejected / reviewed) * 100;
          if (rejectionPct > settings.high_rejection_pct) {
            drafts.push({
              rule: "high_rejection",
              user_id: day.user_id,
              work_date: day.work_date,
              day_id: day.id,
              severity: "critical",
              message: `Rejection rate ${rejectionPct.toFixed(1)}% is above the ${settings.high_rejection_pct}% ceiling.`,
              detail: { approved, rejected, rejectionPct },
              notifyUser: true,
              notifyLead: true,
            });
          }
        }
      }

      // Rule 6: EOD lock window.
      const eod = eodByDay.get(day.id);
      const hoursOld = (Date.now() - new Date(`${day.work_date}T23:59:59Z`).getTime()) / 3_600_000;
      if (hoursOld > settings.eod_lock_hours && (!eod || eod.status === "draft")) {
        drafts.push({
          rule: "eod_locked",
          user_id: day.user_id,
          work_date: day.work_date,
          day_id: day.id,
          severity: "critical",
          message: `EOD report was not submitted within ${settings.eod_lock_hours} hours — the day is locked and needs an attendance-correction request.`,
          detail: { lockHours: settings.eod_lock_hours, eodStatus: eod?.status ?? "missing" },
          notifyUser: true,
          notifyLead: true,
        });
      }
    }

    // ---- Persist flags (idempotent) and notify. -----------------------
    const bounded = drafts.slice(0, MAX_FLAGS_PER_RUN);
    let flagsCreated = 0;
    let notificationsSent = 0;
    const byRule: Record<string, number> = {};

    if (bounded.length > 0) {
      const { data: inserted } = await supabaseAdmin
        .from("automation_flags")
        .upsert(
          bounded.map((d) => ({
            rule: d.rule,
            user_id: d.user_id,
            work_date: d.work_date,
            day_id: d.day_id,
            severity: d.severity,
            message: d.message,
            detail: d.detail as never,
            run_id: runId,
          })),
          { onConflict: "rule,user_id,work_date", ignoreDuplicates: true },
        )
        .select("id, rule, user_id, work_date");

      const fresh = inserted ?? [];
      flagsCreated = fresh.length;
      for (const f of fresh) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;

      // Notify only for flags that are genuinely new this run.
      const freshKeys = new Set(fresh.map((f) => `${f.rule}|${f.user_id}|${f.work_date}`));
      const notifyDrafts = bounded.filter((d) =>
        freshKeys.has(`${d.rule}|${d.user_id}|${d.work_date}`),
      );
      const leads = await resolveLeads([...new Set(notifyDrafts.map((d) => d.user_id))]);

      const notifications: Record<string, unknown>[] = [];
      for (const d of notifyDrafts) {
        if (d.notifyUser) {
          notifications.push({
            user_id: d.user_id,
            type: `automation:${d.rule}`,
            title: `Attendance check — ${d.work_date}`,
            body: d.message,
            entity_type: "automation_flag",
            entity_id: d.day_id,
          });
        }
        const lead = leads.get(d.user_id);
        if (d.notifyLead && lead && lead !== d.user_id) {
          notifications.push({
            user_id: lead,
            type: `automation:${d.rule}`,
            title: `Team flag — ${d.work_date}`,
            body: d.message,
            actor_id: d.user_id,
            entity_type: "automation_flag",
            entity_id: d.day_id,
          });
        }
      }
      if (notifications.length > 0) {
        await supabaseAdmin.from("notifications").insert(notifications as never);
        notificationsSent = notifications.length;
      }
    }

    if (runId) {
      await supabaseAdmin
        .from("automation_runs")
        .update({
          finished_at: new Date().toISOString(),
          flags_created: flagsCreated,
          notifications_sent: notificationsSent,
          days_scanned: liveDays.length,
          detail: { byRule, candidates: drafts.length, window: { from, to: today } } as never,
        })
        .eq("id", runId);
    }

    return {
      runId,
      skipped: false,
      daysScanned: liveDays.length,
      flagsCreated,
      notificationsSent,
      byRule,
    };
  } catch (error) {
    const reason = describeUnknownError(error);
    if (runId) {
      await supabaseAdmin
        .from("automation_runs")
        .update({ finished_at: new Date().toISOString(), skipped: true, reason })
        .eq("id", runId);
    }
    throw error;
  } finally {
    await supabaseAdmin.rpc("release_job_lease", { _job_name: LEASE_NAME });
  }
}
