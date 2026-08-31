// Server-only maths for the daily cycle. Everything here works from real
// timestamps — nothing is defaulted to "present" or to a nominal 8 hours.
export type DayMetrics = {
  workedMinutes: number;
  taskMinutes: number;
  breakMinutes: number;
  blockerMinutes: number;
  coveredMinutes: number;
  uncoveredMinutes: number;
  unitsCompleted: number;
  entryCount: number;
  unsubmittedEntries: number;
};

export const EMPTY_METRICS: DayMetrics = {
  workedMinutes: 0,
  taskMinutes: 0,
  breakMinutes: 0,
  blockerMinutes: 0,
  coveredMinutes: 0,
  uncoveredMinutes: 0,
  unitsCompleted: 0,
  entryCount: 0,
  unsubmittedEntries: 0,
};

export function normaliseMetrics(row: Record<string, unknown> | null | undefined): DayMetrics {
  if (!row) return EMPTY_METRICS;
  const n = (key: string) => Number(row[key] ?? 0);
  return {
    workedMinutes: n("worked_minutes"),
    taskMinutes: n("task_minutes"),
    breakMinutes: n("break_minutes"),
    blockerMinutes: n("blocker_minutes"),
    coveredMinutes: n("covered_minutes"),
    uncoveredMinutes: n("uncovered_minutes"),
    unitsCompleted: n("units_completed"),
    entryCount: n("entry_count"),
    unsubmittedEntries: n("unsubmitted_entries"),
  };
}

export type TargetInput = {
  /** Units expected per productive hour, from the project. */
  hourlyTarget: number | null;
  /** Units expected across the day — allocation target wins over the project one. */
  dailyTarget: number | null;
  qualityTargetPct: number | null;
  maxRejectionRatePct: number | null;
};

export type TargetAchievement = {
  unitsCompleted: number;
  taskHours: number;
  hourlyTarget: number | null;
  dailyTarget: number | null;
  /** What the hourly target implies for the hours actually spent on tasks. */
  expectedForHoursWorked: number | null;
  /** units / daily target. */
  dailyAchievementPct: number | null;
  /** units / (hourly target x task hours). */
  paceAchievementPct: number | null;
  unitsPerHour: number | null;
  qualityPct: number | null;
  rejectionPct: number | null;
  qualityTargetPct: number | null;
  maxRejectionRatePct: number | null;
  meetsDailyTarget: boolean | null;
  meetsQuality: boolean | null;
};

const round = (value: number, dp = 1) => Math.round(value * 10 ** dp) / 10 ** dp;

export function computeTargetAchievement(args: {
  taskMinutes: number;
  unitsCompleted: number;
  unitsApproved: number | null;
  unitsRejected: number | null;
  targets: TargetInput;
}): TargetAchievement {
  const { taskMinutes, unitsCompleted, unitsApproved, unitsRejected, targets } = args;
  const taskHours = round(taskMinutes / 60, 2);
  const expectedForHoursWorked =
    targets.hourlyTarget != null ? round(targets.hourlyTarget * taskHours) : null;
  const dailyAchievementPct =
    targets.dailyTarget && targets.dailyTarget > 0
      ? round((unitsCompleted / targets.dailyTarget) * 100)
      : null;
  const paceAchievementPct =
    expectedForHoursWorked && expectedForHoursWorked > 0
      ? round((unitsCompleted / expectedForHoursWorked) * 100)
      : null;
  const reviewed = (unitsApproved ?? 0) + (unitsRejected ?? 0);
  const qualityPct = reviewed > 0 ? round(((unitsApproved ?? 0) / reviewed) * 100) : null;
  const rejectionPct = reviewed > 0 ? round(((unitsRejected ?? 0) / reviewed) * 100) : null;

  return {
    unitsCompleted,
    taskHours,
    hourlyTarget: targets.hourlyTarget,
    dailyTarget: targets.dailyTarget,
    expectedForHoursWorked,
    dailyAchievementPct,
    paceAchievementPct,
    unitsPerHour: taskHours > 0 ? round(unitsCompleted / taskHours, 2) : null,
    qualityPct,
    rejectionPct,
    qualityTargetPct: targets.qualityTargetPct,
    maxRejectionRatePct: targets.maxRejectionRatePct,
    meetsDailyTarget: targets.dailyTarget ? unitsCompleted >= targets.dailyTarget : null,
    meetsQuality:
      qualityPct != null && targets.qualityTargetPct != null
        ? qualityPct >= targets.qualityTargetPct
        : null,
  };
}

export const ATTENDANCE_STATUS_LABELS: Record<string, string> = {
  present_complete: "Present — Complete",
  present_hours_incomplete: "Present — Hours Incomplete",
  present_eod_pending: "Present — EOD Pending",
  half_day: "Half Day",
  missed_check_out: "Missed Check-Out",
  absent: "Absent",
  on_leave: "On Leave",
  holiday: "Holiday",
  weekly_off: "Weekly Off",
  review_required: "Review Required",
};

/** Pre-submit validation for the EOD report, per the daily-cycle spec. */
export function validateEodSubmission(args: {
  checkedIn: boolean;
  checkedOut: boolean;
  metrics: DayMetrics;
  hasOpenBreak: boolean;
  highlights: string;
  tomorrowPlan: string;
  openBlockers: number;
}): string[] {
  const problems: string[] = [];
  if (!args.checkedIn) problems.push("You have not checked in today.");
  if (!args.checkedOut) problems.push("Check out before submitting the EOD report.");
  if (args.hasOpenBreak) problems.push("End your open break before submitting.");
  if (args.metrics.entryCount === 0) problems.push("Log at least one task entry for the day.");
  if (args.metrics.unsubmittedEntries > 0)
    problems.push(
      `${args.metrics.unsubmittedEntries} task entr${args.metrics.unsubmittedEntries === 1 ? "y is" : "ies are"} still in draft — submit them first.`,
    );
  if (args.metrics.uncoveredMinutes > 60)
    problems.push(
      `${args.metrics.uncoveredMinutes} minutes of your attended time are not accounted for by entries, breaks or blockers.`,
    );
  if (!args.highlights.trim()) problems.push("Add what you completed today.");
  if (!args.tomorrowPlan.trim()) problems.push("Add your plan for tomorrow.");
  return problems;
}
