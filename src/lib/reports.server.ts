// Server-only builders for the enhanced attendance exports.
//
// Both exports sit on top of loadOversightRows(), which is the same function
// the lead / admin / founder dashboards use. The numbers therefore cannot
// drift from what the dashboards show.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { ATTENDANCE_STATUS_LABELS } from "./daily.server";
import { ATTENDANCE_WORK_MODE_LABELS } from "./enums";
import { loadOversightRows, type OversightRow } from "./oversight.server";
import { CATEGORY_LABELS, type UserCategory } from "./permissions";

type Client = SupabaseClient<Database>;

export type ReportFilter = {
  from: string;
  to: string;
  projectIds?: string[] | null;
  departmentIds?: string[] | null;
  categories?: string[] | null;
  userIds?: string[] | null;
  workModes?: string[] | null;
};

export type EmployeeReportRow = Record<string, string | number | null>;

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const round2 = (n: number) => Math.round(n * 100) / 100;

function fmtTs(value: string | null): string {
  if (!value) return "";
  // Displayed in IST, the operating timezone of the org.
  return new Date(value).toLocaleString("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function locationVerified(row: OversightRow): string {
  if (row.workMode !== "wfo") return "N/A";
  return row.locationStatus === "verified" ? "Yes" : "No";
}

type ProfileLite = {
  id: string;
  full_name: string;
  work_email: string;
  category: string;
  designation: string | null;
  department_id: string | null;
  employee_code: string | null;
};

export type ReportContext = {
  profiles: Map<string, ProfileLite>;
  departments: Map<string, string>;
};

export async function loadReportContext(supabase: Client): Promise<ReportContext> {
  const [{ data: profiles }, { data: departments }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name, work_email, category, designation, department_id, employee_code"),
    supabase.from("departments").select("id, name"),
  ]);
  return {
    profiles: new Map((profiles ?? []).map((p) => [p.id, p as ProfileLite])),
    departments: new Map((departments ?? []).map((d) => [d.id, d.name])),
  };
}

type DayExtras = {
  unitsAssigned: number;
  blockerCount: number;
  flags: string;
  eodSubmitted: string;
};

async function loadDayExtras(supabase: Client, dayIds: string[]): Promise<Map<string, DayExtras>> {
  const out = new Map<string, DayExtras>();
  if (dayIds.length === 0) return out;

  const [{ data: tasks }, { data: blockers }, { data: flags }, { data: eods }] = await Promise.all([
    supabase.from("task_entries").select("day_id, units_assigned").in("day_id", dayIds),
    supabase.from("blockers").select("day_id").in("day_id", dayIds),
    supabase.from("automation_flags").select("day_id, rule").in("day_id", dayIds),
    supabase.from("eod_reports").select("day_id, submitted_at").in("day_id", dayIds),
  ]);

  const ensure = (id: string) =>
    out.get(id) ??
    (out.set(id, { unitsAssigned: 0, blockerCount: 0, flags: "", eodSubmitted: "No" }),
    out.get(id)!);

  for (const t of tasks ?? []) ensure(t.day_id).unitsAssigned += Number(t.units_assigned ?? 0);
  for (const b of blockers ?? []) ensure(b.day_id).blockerCount += 1;
  for (const f of flags ?? []) {
    if (!f.day_id) continue;
    const row = ensure(f.day_id);
    row.flags = row.flags ? `${row.flags}; ${f.rule}` : f.rule;
  }
  for (const e of eods ?? []) ensure(e.day_id).eodSubmitted = e.submitted_at ? "Yes" : "No";

  return out;
}

function passesFilter(
  row: OversightRow,
  profile: ProfileLite | undefined,
  filter: ReportFilter,
): boolean {
  if (filter.userIds?.length && !filter.userIds.includes(row.userId)) return false;
  if (filter.workModes?.length && !filter.workModes.includes(row.workMode)) return false;
  if (filter.categories?.length && !filter.categories.includes(profile?.category ?? "")) return false;
  if (
    filter.departmentIds?.length &&
    !filter.departmentIds.includes(profile?.department_id ?? "")
  )
    return false;
  return true;
}

/** Export A — one row per employee per day. */
export async function buildEmployeeReport(
  supabase: Client,
  filter: ReportFilter,
): Promise<EmployeeReportRow[]> {
  const ctx = await loadReportContext(supabase);
  const projectId = filter.projectIds?.length === 1 ? filter.projectIds[0]! : null;
  const all = await loadOversightRows(supabase, { from: filter.from, to: filter.to, projectId });
  const extras = await loadDayExtras(
    supabase,
    all.map((r) => r.dayId),
  );

  return all
    .filter((row) => passesFilter(row, ctx.profiles.get(row.userId), filter))
    .sort((a, b) => a.fullName.localeCompare(b.fullName) || a.workDate.localeCompare(b.workDate))
    .map((row) => {
      const profile = ctx.profiles.get(row.userId);
      const extra = extras.get(row.dayId);
      return {
        "Employee Name": row.fullName,
        "Work Email": profile?.work_email ?? "",
        "Employee ID": profile?.employee_code ?? "",
        "Employment Type": CATEGORY_LABELS[profile?.category as UserCategory] ?? profile?.category ?? "",
        Department: profile?.department_id
          ? (ctx.departments.get(profile.department_id) ?? "")
          : "",
        Designation: profile?.designation ?? "",
        Date: row.workDate,
        Day: DAY_NAMES[new Date(`${row.workDate}T00:00:00Z`).getUTCDay()] ?? "",
        "Check-In": fmtTs(row.checkInAt),
        "Check-Out": fmtTs(row.checkOutAt),
        "Work Mode": ATTENDANCE_WORK_MODE_LABELS[row.workMode as keyof typeof ATTENDANCE_WORK_MODE_LABELS] ?? row.workMode,
        "WFO Location Verified": locationVerified(row),
        "Distance From Office (m)": row.locationDistanceM ?? "",
        // Without a check-out the elapsed clock keeps running, so an open day
        // reports no gross hours rather than a nonsense multi-day figure.
        "Gross Hours": row.checkOutAt ? round2(row.metrics.workedMinutes / 60) : "",

        "Break Hours": round2(row.metrics.breakMinutes / 60),
        "Productive Hours": round2(row.metrics.taskMinutes / 60),
        "Uncovered Minutes": row.metrics.uncoveredMinutes,
        "Tasks Assigned": extra?.unitsAssigned ?? 0,
        "Tasks Completed": row.achievement.unitsCompleted,
        "Target Achievement %": row.achievement.dailyAchievementPct ?? "",
        "Attendance Status": ATTENDANCE_STATUS_LABELS[row.status] ?? row.status,
        "EOD Submitted": extra?.eodSubmitted ?? "No",
        "EOD Status": row.eodStatus ?? "",
        Blockers: extra?.blockerCount ?? 0,
        "Automation Flags": extra?.flags ?? "",
      } satisfies EmployeeReportRow;
    });
}

/** Export B — same day rows, grouped and enriched per project allocation. */
export async function buildProjectReport(
  supabase: Client,
  filter: ReportFilter,
): Promise<EmployeeReportRow[]> {
  const base = await buildEmployeeReport(supabase, filter);
  const ctx = await loadReportContext(supabase);

  let allocationQuery = supabase
    .from("project_allocations")
    .select(
      "user_id, role_in_project, allocation_pct, hours_per_day, daily_task_target, start_date, end_date, project_id, projects(id, code, name, client_name, daily_task_target, quality_target_pct)",
    )
    .neq("status", "ended");
  if (filter.projectIds?.length) allocationQuery = allocationQuery.in("project_id", filter.projectIds);
  const { data: allocations } = await allocationQuery;

  const emailToId = new Map(
    [...ctx.profiles.values()].map((p) => [p.work_email.toLowerCase(), p.id]),
  );

  const rows: EmployeeReportRow[] = [];
  for (const dayRow of base) {
    const userId = emailToId.get(String(dayRow["Work Email"] ?? "").toLowerCase());
    const date = String(dayRow["Date"]);
    const matches = (allocations ?? []).filter(
      (a) =>
        a.user_id === userId &&
        a.start_date <= date &&
        (!a.end_date || a.end_date >= date),
    );
    if (matches.length === 0) continue;

    for (const allocation of matches) {
      const project = allocation.projects as unknown as {
        code?: string;
        name?: string;
        client_name?: string | null;
        daily_task_target?: number | null;
        quality_target_pct?: number | null;
      } | null;
      const dailyTarget =
        allocation.daily_task_target ?? project?.daily_task_target ?? null;
      const completed = Number(dayRow["Tasks Completed"] ?? 0);
      rows.push({
        "Project Code": project?.code ?? "",
        "Project Name": project?.name ?? "",
        Client: project?.client_name ?? "",
        "Role On Project": allocation.role_in_project ?? "",
        "Allocation %": allocation.allocation_pct ?? "",
        "Allocated Hours/Day": allocation.hours_per_day ?? "",
        ...dayRow,
        "Project Daily Target": dailyTarget ?? "",
        "Tasks vs Target": dailyTarget == null ? "" : round2(completed - Number(dailyTarget)),
        "Tasks vs Target %":
          dailyTarget == null || Number(dailyTarget) === 0
            ? ""
            : round2((completed / Number(dailyTarget)) * 100),
        "Project Quality Target %": project?.quality_target_pct ?? "",
      });
    }
  }

  return rows.sort(
    (a, b) =>
      String(a["Project Code"]).localeCompare(String(b["Project Code"])) ||
      String(a["Employee Name"]).localeCompare(String(b["Employee Name"])) ||
      String(a["Date"]).localeCompare(String(b["Date"])),
  );
}
