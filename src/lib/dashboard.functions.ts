import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { loadActor } from "./actor.server";
import { computeTargetAchievement, EMPTY_METRICS } from "./daily.server";
import { loadOversightRows, summariseRows, type OversightRow } from "./oversight.server";
import {
  canExportReports,
  isExecutiveGovernanceOnly,
  REQUIRED_DOCUMENT_TYPES,
  resolvePrimaryRole,
  type AppRole,
  type DocumentType,
} from "./permissions";
import { loadProfileNames, nameOf } from "./profile-names.server";
import { inspectEmailProviderConfig } from "./recruitment/email-transport.server";
import {
  calculateRecruitmentKpis,
  createEmptyRecruitmentKpis,
} from "./recruitment/pipeline";
import { needsReportingLead } from "./request-routing";
import {
  isMissingSchemaResourceError,
  resolveSupervisorScope,
  selectDepartmentManagersSafe,
  selectProjectsSafe,
} from "./schema-compat.server";
import { daysAgoIso, todayIso } from "./timezone";
import { excludeProtectedAccounts } from "./work-type";
import { loadProtectedAccountIds } from "./work-type.server";

export type DashboardQueueItem = {
  id: string;
  category:
    | "kyc"
    | "request_hr"
    | "request_lead"
    | "task_review"
    | "eod_review"
    | "escalation"
    | "blocker"
    | "assignment"
    | "compliance";
  title: string;
  subtitle: string;
  badge?: string;
  tone: "primary" | "warning" | "danger" | "info" | "neutral";
  href: string;
  createdAt?: string | null;
};

export type DashboardProjectItem = {
  id: string;
  code: string;
  name: string;
  clientName: string | null;
  status: string;
  workMode: string;
  departmentName: string | null;
  requiredHeadcount: number;
  allocatedHeadcount: number;
  totalUnits14d: number;
  avgAchievementPct: number | null;
};

export type DashboardTeamMemberRow = {
  userId: string;
  fullName: string;
  designation: string | null;
  departmentName: string | null;
  roleLabel: string;
  todayStatus: string;
  todayWorkMode: string | null;
  checkInAt: string | null;
  workedHours14d: number;
  unitsCompleted14d: number;
  avgAchievementPct14d: number | null;
  problemDays14d: number;
};

export type DashboardTrendPoint = {
  date: string;
  presentCount: number;
  wfoCount: number;
  wfhCount: number;
  avgAchievementPct: number | null;
};

export type DashboardFeedItem = {
  id: string;
  kind: "audit" | "review" | "announcement" | "holiday";
  title: string;
  subtitle: string;
  timestamp: string | null;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
};

function daysAheadIso(days: number, now: Date = new Date()): string {
  return todayIso(new Date(now.getTime() + days * 86_400_000));
}

export const getRoleDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const now = new Date();
    const today = todayIso(now);
    const from14d = daysAgoIso(13, now);
    const next14d = daysAheadIso(14, now);

    const actor = await loadActor(supabase, userId);
    const primaryRole = resolvePrimaryRole(actor.roles);
    const executiveGovernanceOnly = isExecutiveGovernanceOnly(actor.roles);
    const canExport = canExportReports(actor.roles, actor.permissions);

    const hasAttendanceScope =
      actor.permissions.includes("attendance:read:all") ||
      actor.permissions.includes("attendance:read:team");
    const hasOrgWideAttendance = actor.permissions.includes("attendance:read:all");
    const hasWorkforceScope =
      actor.permissions.includes("workforce:read:all") ||
      actor.permissions.includes("workforce:read:team");
    const hasOrgWideWorkforce = actor.permissions.includes("workforce:read:all");
    const hasProjectScope =
      actor.permissions.includes("projects:read:all") ||
      actor.permissions.includes("projects:read:team");

    // 1. Resolve supervisor scope when needed (Manager / Lead) or check P0 schema readiness
    const supervisorScope = await resolveSupervisorScope(supabase, userId, actor.roles);

    // 2. Batched parallel core queries — strictly gated by actor permissions
    const [
      { data: myProfile },
      { data: myDocs },
      { data: myDayRow },
      { data: myAllocs },
      { data: myRequests },
      { data: myReviewEvents },
      { data: notifications },
      { data: announcements },
      { data: upcomingHolidays },
      { data: departments },
      deptMgrRes,
      projectsRes,
      oversightRowsRaw,
      { data: workforceProfilesAll },
      { data: userRoleRows },
      { data: activeAllocsRaw },
      { data: pendingDocsAll },
      { data: actionableRequestsAll },
      { data: pendingTasksAll },
      { data: pendingEodsAll },
      { data: openBlockersAll },
      { data: invitationsRaw },
      { data: officesRaw },
      { data: automationRunsRaw },
      { data: automationFlagsAll },
      { data: auditLogsRaw },
    ] = await Promise.all([
      // Personal profile & onboarding state
      supabase
        .from("profiles")
        .select(
          "id, full_name, employee_code, designation, department_id, reporting_lead_id, account_status, employment_status, category, must_change_password",
        )
        .eq("id", userId)
        .maybeSingle(),
      executiveGovernanceOnly
        ? Promise.resolve({ data: [] as { doc_type: string; status: string }[] })
        : supabase
            .from("documents")
            .select("doc_type, status")
            .eq("user_id", userId),
      executiveGovernanceOnly
        ? Promise.resolve({ data: null })
        : supabase
            .from("attendance_days")
            .select(
              "id, work_date, work_mode, check_in_at, check_out_at, required_minutes, exception_type, location_status",
            )
            .eq("user_id", userId)
            .eq("work_date", today)
            .maybeSingle(),
      executiveGovernanceOnly
        ? Promise.resolve({ data: [] as never[] })
        : supabase
            .from("project_allocations")
            .select(
              "id, project_id, role_in_project, start_date, end_date, hours_per_day, allocation_pct, daily_task_target, quality_target_pct, max_rejection_rate_pct, status, acknowledged_at, projects(id, code, name, work_mode, task_unit, hourly_task_target, daily_task_target, status)",
            )
            .eq("user_id", userId)
            .neq("status", "ended")
            .order("created_at", { ascending: false }),
      executiveGovernanceOnly
        ? Promise.resolve({ data: [] as never[] })
        : supabase
            .from("requests")
            .select("id, request_type, start_date, end_date, status, created_at")
            .eq("user_id", userId)
            .order("created_at", { ascending: false })
            .limit(8),
      executiveGovernanceOnly
        ? Promise.resolve({ data: [] as never[] })
        : supabase
            .from("review_events")
            .select("id, entity_type, action, note, reviewer_id, created_at")
            .eq("subject_user_id", userId)
            .order("created_at", { ascending: false })
            .limit(6),
      supabase
        .from("notifications")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("announcements")
        .select("id, title, body, published_at")
        .eq("published", true)
        .order("published_at", { ascending: false })
        .limit(4),
      supabase
        .from("org_calendar_days")
        .select("id, calendar_date, kind, label")
        .gte("calendar_date", today)
        .order("calendar_date", { ascending: true })
        .limit(4),
      supabase.from("departments").select("id, name, code").order("name"),
      selectDepartmentManagersSafe(supabase),
      hasProjectScope
        ? selectProjectsSafe(supabase)
        : Promise.resolve({ rows: [], hasScopedColumns: supervisorScope.p0SchemaReady }),
      hasAttendanceScope
        ? loadOversightRows(supabase, { from: from14d, to: today })
        : Promise.resolve([] as OversightRow[]),
      hasWorkforceScope
        ? supabase
            .from("profiles")
            .select(
              "id, full_name, employee_code, designation, department_id, reporting_lead_id, category, account_status, employment_status, internship_end, must_change_password",
            )
            .order("full_name")
        : Promise.resolve({ data: [] as never[] }),
      hasWorkforceScope
        ? supabase.from("user_roles").select("user_id, role")
        : Promise.resolve({ data: [] as { user_id: string; role: string }[] }),
      hasProjectScope
        ? supabase
            .from("project_allocations")
            .select("id, project_id, user_id, allocation_pct, hours_per_day, status")
            .eq("status", "active")
        : Promise.resolve({ data: [] as never[] }),
      actor.permissions.includes("documents:verify:all")
        ? supabase
            .from("documents")
            .select("id, user_id, doc_type, status, created_at")
            .eq("status", "pending")
            .order("created_at", { ascending: true })
            .limit(100)
        : Promise.resolve({ data: [] as never[] }),
      actor.permissions.includes("requests:approve:hr") ||
      actor.permissions.includes("requests:approve:lead")
        ? supabase
            .from("requests")
            .select(
              "id, user_id, request_type, start_date, end_date, status, created_at, request_approvals(tier, approver_id, decision)",
            )
            .eq("status", "pending")
            .neq("user_id", userId)
            .order("created_at", { ascending: true })
            .limit(80)
        : Promise.resolve({ data: [] as never[] }),
      actor.permissions.includes("tasks:review:team")
        ? supabase
            .from("task_entries")
            .select("id, user_id, task_description, units_completed, status, created_at, projects(code)")
            .eq("status", "submitted")
            .neq("user_id", userId)
            .order("created_at", { ascending: true })
            .limit(80)
        : Promise.resolve({ data: [] as never[] }),
      actor.permissions.includes("eod:review:team") || actor.permissions.includes("eod:read:team")
        ? supabase
            .from("eod_reports")
            .select("id, user_id, work_date, status, submitted_at")
            .in("status", ["submitted", "escalated", "performance_concern"])
            .neq("user_id", userId)
            .gte("work_date", from14d)
            .order("work_date", { ascending: false })
            .limit(80)
        : Promise.resolve({ data: [] as never[] }),
      actor.permissions.includes("blockers:manage:team")
        ? supabase
            .from("blockers")
            .select("id, user_id, category, severity, description, status, started_at, projects(code)")
            .neq("status", "resolved")
            .neq("user_id", userId)
            .order("started_at", { ascending: false })
            .limit(50)
        : Promise.resolve({ data: [] as never[] }),
      actor.permissions.includes("invitations:read:all")
        ? supabase.from("invitations").select("id, status")
        : Promise.resolve({ data: [] as { id: string; status: string }[] }),
      actor.permissions.includes("org:manage:all") ||
      actor.roles.includes("admin") ||
      actor.roles.includes("super_admin")
        ? supabase.from("office_locations").select("id, name, is_active, radius_meters")
        : Promise.resolve({ data: [] as never[] }),
      actor.permissions.includes("automation:run:all")
        ? supabase
            .from("automation_runs")
            .select(
              "id, trigger_source, skipped, reason, days_scanned, flags_created, started_at, finished_at",
            )
            .order("started_at", { ascending: false })
            .limit(1)
        : Promise.resolve({ data: [] as never[] }),
      actor.permissions.includes("automation:run:all") ||
      actor.roles.includes("admin") ||
      actor.roles.includes("super_admin")
        ? supabase
            .from("automation_flags")
            .select("id, rule, user_id, work_date, severity, message, resolved_at, created_at")
            .is("resolved_at", null)
            .order("created_at", { ascending: false })
            .limit(60)
        : Promise.resolve({ data: [] as never[] }),
      actor.permissions.includes("audit:read:all")
        ? supabase
            .from("audit_logs")
            .select("id, actor_email, action, entity_type, created_at")
            .order("created_at", { ascending: false })
            .limit(8)
        : Promise.resolve({ data: [] as never[] }),
    ]);

    // Protected system-owner accounts are excluded from every workforce total,
    // queue and list on every dashboard (HR, Manager, Lead, Founder, Admin, SA).
    const protectedIds = await loadProtectedAccountIds(supabase);
    const workforceProfilesRaw = excludeProtectedAccounts(workforceProfilesAll ?? [], protectedIds);
    const pendingDocsRaw = excludeProtectedAccounts(pendingDocsAll ?? [], protectedIds);
    const actionableRequestsRaw = excludeProtectedAccounts(actionableRequestsAll ?? [], protectedIds);
    const pendingTasksRaw = excludeProtectedAccounts(pendingTasksAll ?? [], protectedIds);
    const pendingEodsRaw = excludeProtectedAccounts(pendingEodsAll ?? [], protectedIds);
    const openBlockersRaw = excludeProtectedAccounts(openBlockersAll ?? [], protectedIds);
    const automationFlagsRaw = excludeProtectedAccounts(automationFlagsAll ?? [], protectedIds);

    // 3. Personal day details (when the actor has a day row today or is operational staff)
    let myTaskEntriesToday: {
      id: string;
      status: string;
      units_completed: number;
      started_at: string;
      ended_at: string;
    }[] = [];
    let myBreaksToday: { id: string; started_at: string; ended_at: string | null }[] = [];
    let myBlockersToday: {
      id: string;
      status: string;
      severity: string;
      description: string;
      started_at: string;
      resolved_at: string | null;
    }[] = [];
    let myEodToday: { id: string; status: string; review_note: string | null } | null = null;

    if (myDayRow?.id) {
      const [{ data: entries }, { data: breaks }, { data: blockers }, { data: eod }] =
        await Promise.all([
          supabase
            .from("task_entries")
            .select("id, status, units_completed, started_at, ended_at")
            .eq("day_id", myDayRow.id),
          supabase
            .from("break_logs")
            .select("id, started_at, ended_at")
            .eq("day_id", myDayRow.id),
          supabase
            .from("blockers")
            .select("id, status, severity, description, started_at, resolved_at")
            .eq("day_id", myDayRow.id),
          supabase
            .from("eod_reports")
            .select("id, status, review_note")
            .eq("day_id", myDayRow.id)
            .maybeSingle(),
        ]);
      myTaskEntriesToday = entries ?? [];
      myBreaksToday = breaks ?? [];
      myBlockersToday = blockers ?? [];
      myEodToday = eod ?? null;
    }

    // Compute personal metrics cleanly in memory
    let personalWorkedMinutes = 0;
    let personalTaskMinutes = 0;
    let personalBreakMinutes = 0;
    let personalUnitsCompleted = 0;
    if (myDayRow?.check_in_at) {
      const startMs = new Date(myDayRow.check_in_at).getTime();
      const endMs = myDayRow.check_out_at
        ? new Date(myDayRow.check_out_at).getTime()
        : Math.max(startMs, now.getTime());
      personalWorkedMinutes = Math.max(0, Math.trunc((endMs - startMs) / 60_000));
      for (const e of myTaskEntriesToday) {
        personalUnitsCompleted += Number(e.units_completed ?? 0);
        const st = Math.max(new Date(e.started_at).getTime(), startMs);
        const en = Math.min(new Date(e.ended_at).getTime(), endMs);
        if (en > st) personalTaskMinutes += Math.trunc((en - st) / 60_000);
      }
      for (const b of myBreaksToday) {
        const st = Math.max(new Date(b.started_at).getTime(), startMs);
        const en = Math.min(b.ended_at ? new Date(b.ended_at).getTime() : endMs, endMs);
        if (en > st) personalBreakMinutes += Math.trunc((en - st) / 60_000);
      }
    }

    const activePersonalAllocs = (myAllocs ?? []).filter(
      (a) =>
        a.status === "active" &&
        a.start_date <= today &&
        (!a.end_date || a.end_date >= today),
    );
    const unacknowledgedAllocsCount = (myAllocs ?? []).filter(
      (a) => a.status === "active" && !a.acknowledged_at,
    ).length;

    const firstAlloc = activePersonalAllocs[0];
    const firstProj = firstAlloc?.projects as {
      hourly_task_target?: number | null;
      daily_task_target?: number | null;
    } | null;
    const personalDailyTarget = activePersonalAllocs.reduce((sum, a) => {
      const p = a.projects as { daily_task_target?: number | null } | null;
      const t = a.daily_task_target ?? p?.daily_task_target ?? 0;
      return sum + Number(t || 0);
    }, 0);

    const personalAchievement = computeTargetAchievement({
      taskMinutes: personalTaskMinutes || EMPTY_METRICS.taskMinutes,
      unitsCompleted: personalUnitsCompleted,
      unitsApproved: null,
      unitsRejected: null,
      targets: {
        hourlyTarget: firstProj?.hourly_task_target ?? null,
        dailyTarget: personalDailyTarget > 0 ? personalDailyTarget : null,
        qualityTargetPct: null,
        maxRejectionRatePct: null,
      },
    });

    const uploadedDocSet = new Set((myDocs ?? []).map((d) => d.doc_type as DocumentType));
    const missingRequiredDocs = executiveGovernanceOnly
      ? []
      : REQUIRED_DOCUMENT_TYPES.filter((dt) => !uploadedDocSet.has(dt));

    // 4. Strictly enforce Manager / Lead server-side scoping on all team/org collections
    const deptMap = new Map((departments ?? []).map((d) => [d.id, d]));

    const rolesByUser = new Map<string, AppRole[]>();
    for (const r of userRoleRows ?? []) {
      const list = rolesByUser.get(r.user_id) ?? [];
      list.push(r.role as AppRole);
      rolesByUser.set(r.user_id, list);
    }

    const scopedProfiles = (workforceProfilesRaw ?? []).filter((p) =>
      hasOrgWideWorkforce ? true : supervisorScope.scopedUserIds.has(p.id),
    );
    const subordinateProfiles = scopedProfiles.filter((p) => p.id !== userId);
    const activeScopedProfiles = (
      primaryRole === "lead" || primaryRole === "manager" ? subordinateProfiles : scopedProfiles
    ).filter((p) => p.employment_status === "active");

    const scopedOversightRows = oversightRowsRaw.filter((r) => {
      if (hasOrgWideAttendance) return true;
      if (!supervisorScope.scopedUserIds.has(r.userId)) return false;
      if (primaryRole === "lead" || primaryRole === "manager") {
        return r.userId !== userId;
      }
      return true;
    });

    const oversightSummary14d = summariseRows(scopedOversightRows);

    // Today's attendance breakdown across scoped active staff
    const todayRows = scopedOversightRows.filter((r) => r.workDate === today);
    const todayByUser = new Map<string, OversightRow>();
    for (const r of todayRows) todayByUser.set(r.userId, r);

    let wfoToday = 0;
    let wfhToday = 0;
    let hybridOrFieldToday = 0;
    let onLeaveToday = 0;
    let holidayOrOffToday = 0;
    let checkedInToday = 0;
    let geofenceMismatchToday = 0;

    for (const r of todayRows) {
      if (r.status === "on_leave") {
        onLeaveToday += 1;
      } else if (r.status === "holiday" || r.status === "weekly_off") {
        holidayOrOffToday += 1;
      } else if (r.checkInAt) {
        checkedInToday += 1;
        if (r.workMode === "wfo") wfoToday += 1;
        else if (r.workMode === "wfh") wfhToday += 1;
        else hybridOrFieldToday += 1;
      }
      if (r.locationStatus === "outside_geofence" || r.locationStatus === "unverified") {
        geofenceMismatchToday += 1;
      }
    }

    const expectedActiveCount = activeScopedProfiles.length;
    const uncheckedInToday = Math.max(
      0,
      expectedActiveCount - checkedInToday - onLeaveToday - holidayOrOffToday,
    );

    // 14-day attendance & achievement trend points
    const trendByDate = new Map<
      string,
      { present: number; wfo: number; wfh: number; achSum: number; achCount: number }
    >();
    for (let i = 13; i >= 0; i -= 1) {
      trendByDate.set(daysAgoIso(i, now), {
        present: 0,
        wfo: 0,
        wfh: 0,
        achSum: 0,
        achCount: 0,
      });
    }
    for (const r of scopedOversightRows) {
      const bucket = trendByDate.get(r.workDate);
      if (!bucket) continue;
      if (r.checkInAt) {
        bucket.present += 1;
        if (r.workMode === "wfo") bucket.wfo += 1;
        if (r.workMode === "wfh") bucket.wfh += 1;
      }
      if (r.achievement.dailyAchievementPct != null) {
        bucket.achSum += r.achievement.dailyAchievementPct;
        bucket.achCount += 1;
      }
    }
    const attendanceTrend14d: DashboardTrendPoint[] = Array.from(trendByDate.entries()).map(
      ([date, b]) => ({
        date,
        presentCount: b.present,
        wfoCount: b.wfo,
        wfhCount: b.wfh,
        avgAchievementPct:
          b.achCount > 0 ? Math.round((b.achSum / b.achCount) * 10) / 10 : null,
      }),
    );

    // Workforce lifecycle & category distribution
    const categoryBreakdown: Record<string, number> = {
      full_time: 0,
      intern: 0,
      freelancer: 0,
      trainer: 0,
    };
    const statusBreakdown: Record<string, number> = {
      invited: 0,
      activated: 0,
      profile_pending: 0,
      under_verification: 0,
      active: 0,
    };
    const departmentBreakdownMap = new Map<string, { name: string; count: number }>();
    let missingReportingLeadCount = 0;
    let mustChangePasswordCount = 0;
    const upcomingInternshipEndings: {
      id: string;
      fullName: string;
      internshipEnd: string;
      designation: string | null;
    }[] = [];
    const underVerificationProfiles: {
      id: string;
      fullName: string;
      designation: string | null;
    }[] = [];

    for (const p of scopedProfiles) {
      categoryBreakdown[p.category] = (categoryBreakdown[p.category] ?? 0) + 1;
      statusBreakdown[p.account_status] = (statusBreakdown[p.account_status] ?? 0) + 1;
      if (p.employment_status === "active") {
        const dName = p.department_id
          ? (deptMap.get(p.department_id)?.name ?? "Unassigned")
          : "Unassigned";
        const cur = departmentBreakdownMap.get(dName) ?? { name: dName, count: 0 };
        cur.count += 1;
        departmentBreakdownMap.set(dName, cur);
      }
      const pRoles = rolesByUser.get(p.id) ?? [];
      if (
        needsReportingLead({
          roles: pRoles,
          employmentStatus: p.employment_status,
          reportingLeadId: p.reporting_lead_id,
        })
      ) {
        missingReportingLeadCount += 1;
      }
      if (p.must_change_password) {
        mustChangePasswordCount += 1;
      }
      if (p.account_status === "under_verification") {
        underVerificationProfiles.push({
          id: p.id,
          fullName: p.full_name,
          designation: p.designation,
        });
      }
      if (
        p.employment_status === "active" &&
        p.internship_end &&
        p.internship_end >= today &&
        p.internship_end <= next14d
      ) {
        upcomingInternshipEndings.push({
          id: p.id,
          fullName: p.full_name,
          internshipEnd: p.internship_end,
          designation: p.designation,
        });
      }
    }

    // 5. Projects & Capacity metrics (strictly scoped)
    const visibleProjects = projectsRes.rows.filter((p) =>
      actor.permissions.includes("projects:read:all")
        ? true
        : supervisorScope.scopedProjectIds.has(p.id),
    );

    const allocCountByProject = new Map<string, Set<string>>();
    const allocPctByUser = new Map<string, number>();
    for (const a of activeAllocsRaw ?? []) {
      let set = allocCountByProject.get(a.project_id);
      if (!set) {
        set = new Set();
        allocCountByProject.set(a.project_id, set);
      }
      set.add(a.user_id);
      allocPctByUser.set(a.user_id, (allocPctByUser.get(a.user_id) ?? 0) + Number(a.allocation_pct ?? 0));
    }

    const projectMetricsByCode = new Map<
      string,
      { units: number; achSum: number; achCount: number }
    >();
    for (const r of scopedOversightRows) {
      if (!r.projectCode) continue;
      const cur = projectMetricsByCode.get(r.projectCode) ?? {
        units: 0,
        achSum: 0,
        achCount: 0,
      };
      cur.units += r.achievement.unitsCompleted;
      if (r.achievement.dailyAchievementPct != null) {
        cur.achSum += r.achievement.dailyAchievementPct;
        cur.achCount += 1;
      }
      projectMetricsByCode.set(r.projectCode, cur);
    }

    const projectPortfolio: DashboardProjectItem[] = visibleProjects.map((p) => {
      const m = projectMetricsByCode.get(p.code);
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        clientName: p.client_name,
        status: p.status,
        workMode: p.work_mode,
        departmentName: p.department_id ? (deptMap.get(p.department_id)?.name ?? null) : null,
        requiredHeadcount: p.required_headcount,
        allocatedHeadcount: allocCountByProject.get(p.id)?.size ?? 0,
        totalUnits14d: m?.units ?? 0,
        avgAchievementPct:
          m && m.achCount > 0 ? Math.round((m.achSum / m.achCount) * 10) / 10 : null,
      };
    });

    let unallocatedActiveStaff = 0;
    let overAllocatedStaff = 0;
    for (const p of activeScopedProfiles) {
      if (isExecutiveGovernanceOnly(rolesByUser.get(p.id) ?? [])) continue;
      const pct = allocPctByUser.get(p.id) ?? 0;
      if (pct === 0) unallocatedActiveStaff += 1;
      if (pct > 100) overAllocatedStaff += 1;
    }

    // 6. Team / Subordinate productivity rows (for Lead, Manager, Admin, Founder, Super Admin)
    const rowsByMember = new Map<string, OversightRow[]>();
    for (const r of scopedOversightRows) {
      const list = rowsByMember.get(r.userId) ?? [];
      list.push(r);
      rowsByMember.set(r.userId, list);
    }

    const teamProductivity: DashboardTeamMemberRow[] = activeScopedProfiles
      .slice(0, 30)
      .map((p) => {
        const memberRows = rowsByMember.get(p.id) ?? [];
        const sub = summariseRows(memberRows);
        const tRow = todayByUser.get(p.id);
        const pRoles = rolesByUser.get(p.id) ?? ["employee"];
        const topRole = resolvePrimaryRole(pRoles);
        return {
          userId: p.id,
          fullName: p.full_name,
          designation: p.designation,
          departmentName: p.department_id ? (deptMap.get(p.department_id)?.name ?? null) : null,
          roleLabel: topRole,
          todayStatus: tRow?.status ?? "unchecked_in",
          todayWorkMode: tRow?.workMode ?? null,
          checkInAt: tRow?.checkInAt ?? null,
          workedHours14d: sub.workedHours,
          unitsCompleted14d: sub.unitsCompleted,
          avgAchievementPct14d: sub.avgAchievementPct,
          problemDays14d: sub.problemDays,
        };
      });

    // 7. Resolve display names for pending queues & build strictly-authorized PendingActionQueue
    const scopedTasks = (pendingTasksRaw ?? []).filter((t) =>
      supervisorScope.isOrgWide ? true : supervisorScope.scopedUserIds.has(t.user_id),
    );
    const scopedEods = (pendingEodsRaw ?? []).filter((e) =>
      supervisorScope.isOrgWide ? true : supervisorScope.scopedUserIds.has(e.user_id),
    );
    const scopedBlockers = (openBlockersRaw ?? []).filter((b) =>
      supervisorScope.isOrgWide ? true : supervisorScope.scopedUserIds.has(b.user_id),
    );
    const scopedRequests: (NonNullable<typeof actionableRequestsRaw>[number] & {
      actionableTier: "lead" | "hr";
    })[] = [];
    for (const req of actionableRequestsRaw ?? []) {
      const approvals = (req.request_approvals ?? []) as {
        tier: string;
        approver_id: string | null;
        decision: string;
      }[];
      const hasPendingLead = approvals.some(
        (a) => a.tier === "lead" && a.decision === "pending",
      );
      const hasPendingHr = approvals.some(
        (a) => a.tier === "hr" && a.decision === "pending",
      );

      if (
        hasPendingLead &&
        actor.permissions.includes("requests:approve:lead") &&
        (supervisorScope.isOrgWide || supervisorScope.scopedUserIds.has(req.user_id))
      ) {
        scopedRequests.push({ ...req, actionableTier: "lead" });
      } else if (hasPendingHr && actor.permissions.includes("requests:approve:hr")) {
        scopedRequests.push({ ...req, actionableTier: "hr" });
      }
    }

    const referencedIds = [
      ...(pendingDocsRaw ?? []).map((d) => d.user_id),
      ...scopedRequests.map((r) => r.user_id),
      ...scopedTasks.map((t) => t.user_id),
      ...scopedEods.map((e) => e.user_id),
      ...scopedBlockers.map((b) => b.user_id),
      ...(myReviewEvents ?? []).map((ev) => ev.reviewer_id),
      ...(automationFlagsRaw ?? []).map((f) => f.user_id),
    ];
    const resolvedNames = referencedIds.length > 0 ? await loadProfileNames(supabase, referencedIds) : new Map();

    const pendingActions: DashboardQueueItem[] = [];

    // Founder NEVER receives actionable write queues
    if (primaryRole !== "founder") {
      // Unacknowledged personal project assignments
      for (const alloc of (myAllocs ?? []).filter((a) => a.status === "active" && !a.acknowledged_at)) {
        const proj = alloc.projects as { code?: string; name?: string } | null;
        pendingActions.push({
          id: `alloc-${alloc.id}`,
          category: "assignment",
          title: `Acknowledge project assignment: ${proj?.code ?? "Project"}`,
          subtitle: proj?.name ?? "Review targets & confirm your allocation",
          badge: "Assignment",
          tone: "primary",
          href: "/my-projects",
        });
      }

      // HR / Super Admin KYC verification queue
      if (actor.permissions.includes("documents:verify:all")) {
        const docsByPerson = new Map<string, number>();
        for (const d of pendingDocsRaw ?? []) {
          docsByPerson.set(d.user_id, (docsByPerson.get(d.user_id) ?? 0) + 1);
        }
        for (const [personId, count] of docsByPerson.entries()) {
          pendingActions.push({
            id: `kyc-${personId}`,
            category: "kyc",
            title: `${nameOf(resolvedNames, personId)} — ${count} pending KYC document${count > 1 ? "s" : ""}`,
            subtitle: "Review & verify uploaded employee documents",
            badge: "KYC Verify",
            tone: "warning",
            href: `/workforce/${personId}`,
          });
        }
      }

      // Requests queue (Lead tier vs HR tier)
      for (const req of scopedRequests.slice(0, 15)) {
        const isHrStage = req.actionableTier === "hr";
        pendingActions.push({
          id: `req-${req.id}`,
          category: isHrStage ? "request_hr" : "request_lead",
          title: `${nameOf(resolvedNames, req.user_id)} — ${req.request_type.replace(/_/g, " ").toUpperCase()}`,
          subtitle: `${req.start_date}${req.end_date !== req.start_date ? ` → ${req.end_date}` : ""}`,
          badge: isHrStage ? "HR Approval" : "Lead Approval",
          tone: "info",
          href: "/requests",
          createdAt: req.created_at,
        });
      }

      // Open blockers
      for (const blk of scopedBlockers.slice(0, 12)) {
        const pCode = (blk.projects as { code?: string } | null)?.code;
        pendingActions.push({
          id: `blk-${blk.id}`,
          category: "blocker",
          title: `${nameOf(resolvedNames, blk.user_id)} raised a ${blk.severity} blocker`,
          subtitle: `${pCode ? `[${pCode}] ` : ""}${blk.description}`,
          badge: "Blocker",
          tone: blk.severity === "critical" || blk.severity === "high" ? "danger" : "warning",
          href: "/team",
          createdAt: blk.started_at,
        });
      }

      // Escalated / submitted EODs
      for (const eod of scopedEods.slice(0, 15)) {
        const isEscalation =
          eod.status === "escalated" || eod.status === "performance_concern";
        if (!isEscalation && !actor.permissions.includes("eod:review:team")) continue;
        pendingActions.push({
          id: `eod-${eod.id}`,
          category: isEscalation ? "escalation" : "eod_review",
          title: `${nameOf(resolvedNames, eod.user_id)} — ${eod.work_date} EOD`,
          subtitle: isEscalation
            ? `Escalated (${eod.status.replace(/_/g, " ")})`
            : "Submitted and awaiting EOD review",
          badge: isEscalation ? "Escalation" : "EOD Review",
          tone: isEscalation ? "danger" : "primary",
          href: "/team",
          createdAt: eod.submitted_at,
        });
      }

      // Submitted hourly task entries
      for (const task of scopedTasks.slice(0, 15)) {
        const pCode = (task.projects as { code?: string } | null)?.code;
        pendingActions.push({
          id: `task-${task.id}`,
          category: "task_review",
          title: `${nameOf(resolvedNames, task.user_id)} — ${task.task_description || "Task entry"}`,
          subtitle: `${pCode ? `[${pCode}] ` : ""}${task.units_completed} units submitted`,
          badge: "Task Review",
          tone: "neutral",
          href: "/reviews",
          createdAt: task.created_at,
        });
      }
    }

    // 8. Activity feeds (audit trail, personal review feedback, announcements & holidays)
    const auditFeed: DashboardFeedItem[] = (auditLogsRaw ?? []).map((log) => ({
      id: log.id,
      kind: "audit",
      title: log.action,
      subtitle: `${log.actor_email ?? "System"} · ${log.entity_type}`,
      timestamp: log.created_at,
      tone: log.action.includes("password") || log.action.includes("role") ? "warning" : "neutral",
    }));

    const personalFeedbackFeed: DashboardFeedItem[] = (myReviewEvents ?? []).map((ev) => ({
      id: ev.id,
      kind: "review",
      title: `${nameOf(resolvedNames, ev.reviewer_id)} · ${ev.action.replace(/_/g, " ")}`,
      subtitle: ev.note ?? `${ev.entity_type.replace(/_/g, " ")} reviewed`,
      timestamp: ev.created_at,
      tone:
        ev.action === "approved" || ev.action === "approved_with_comment"
          ? "success"
          : ev.action === "revision_requested"
            ? "warning"
            : "danger",
    }));

    const orgUpdatesFeed: DashboardFeedItem[] = [
      ...(announcements ?? []).map((a) => ({
        id: `ann-${a.id}`,
        kind: "announcement" as const,
        title: a.title,
        subtitle: a.body,
        timestamp: a.published_at,
        tone: "info" as const,
      })),
      ...(upcomingHolidays ?? []).map((h) => ({
        id: `hol-${h.id}`,
        kind: "holiday" as const,
        title: `${h.label} (${h.kind === "holiday" ? "Holiday" : "Weekly Off"})`,
        subtitle: `Scheduled on ${h.calendar_date}`,
        timestamp: h.calendar_date,
        tone: "neutral" as const,
      })),
    ];

    // 9. Invitations, Geofence & Automation rollups
    const invitationCounts: Record<string, number> = {
      queued: 0,
      sending: 0,
      sent: 0,
      accepted: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const inv of invitationsRaw ?? []) {
      invitationCounts[inv.status] = (invitationCounts[inv.status] ?? 0) + 1;
    }

    const activeOfficesCount = (officesRaw ?? []).filter((o) => o.is_active).length;
    const totalOfficesCount = (officesRaw ?? []).length;

    const latestAutomationRun = (automationRunsRaw ?? [])[0] ?? null;
    const unresolvedFlagsBySeverity = {
      critical: 0,
      warning: 0,
      info: 0,
    };
    for (const f of automationFlagsRaw ?? []) {
      if (f.severity === "critical") unresolvedFlagsBySeverity.critical += 1;
      else if (f.severity === "warning") unresolvedFlagsBySeverity.warning += 1;
      else unresolvedFlagsBySeverity.info += 1;
    }

    const managedDepartmentsList = Array.from(supervisorScope.managedDepartmentIds)
      .map((id) => deptMap.get(id))
      .filter((d): d is NonNullable<typeof d> => Boolean(d));

    // 10. Phase P2 Recruitment KPIs & Assigned Interviews (real DB queries with safe schema check)
    let recruitmentSchemaReady = true;
    let recruitmentKpis = createEmptyRecruitmentKpis();
    let assignedUpcomingInterviewsCount = 0;

    if (actor.permissions.includes("recruitment:read:all")) {
      const [candRes, ivRes] = await Promise.all([
        supabase.from("candidates").select("status, converted_user_id"),
        supabase
          .from("interviews")
          .select("id, interviewer_ids")
          .in("status", ["scheduled", "rescheduled"]),
      ]);
      if (candRes.error && isMissingSchemaResourceError(candRes.error)) {
        recruitmentSchemaReady = false;
      } else if (!candRes.error) {
        const activeIvs = ivRes.error ? [] : (ivRes.data ?? []);
        recruitmentKpis = calculateRecruitmentKpis(candRes.data ?? [], activeIvs.length);
        assignedUpcomingInterviewsCount = activeIvs.filter((iv) =>
          (iv.interviewer_ids ?? []).includes(userId),
        ).length;
      }
    } else if (actor.permissions.includes("interviews:feedback:assigned")) {
      const ivRes = await supabase
        .from("interviews")
        .select("id")
        .contains("interviewer_ids", [userId])
        .in("status", ["scheduled", "rescheduled"]);
      if (ivRes.error && isMissingSchemaResourceError(ivRes.error)) {
        recruitmentSchemaReady = false;
      } else if (!ivRes.error) {
        assignedUpcomingInterviewsCount = (ivRes.data ?? []).length;
      }
    }

    const emailProviderStatus = inspectEmailProviderConfig();

    return {
      today,
      from14d,
      actor: {
        userId: actor.userId,
        fullName: actor.fullName,
        workEmail: actor.workEmail,
        roles: actor.roles,
        primaryRole,
        category: actor.category,
        accountStatus: actor.accountStatus,
        executiveGovernanceOnly,
        canExport,
      },
      scope: {
        isOrgWide: supervisorScope.isOrgWide,
        p0SchemaReady: supervisorScope.p0SchemaReady && deptMgrRes.tableExists,
        managedDepartments: managedDepartmentsList,
        scopedHeadcount: activeScopedProfiles.length,
        scopedProjectsCount: visibleProjects.length,
      },
      personal: {
        employeeCode: myProfile?.employee_code ?? null,
        designation: myProfile?.designation ?? null,
        accountStatus: myProfile?.account_status ?? actor.accountStatus,
        uploadedRequiredDocsCount: REQUIRED_DOCUMENT_TYPES.length - missingRequiredDocs.length,
        totalRequiredDocsCount: REQUIRED_DOCUMENT_TYPES.length,
        missingRequiredDocs,
        checkedIn: Boolean(myDayRow?.check_in_at),
        checkedOut: Boolean(myDayRow?.check_out_at),
        checkInAt: myDayRow?.check_in_at ?? null,
        checkOutAt: myDayRow?.check_out_at ?? null,
        workMode: myDayRow?.work_mode ?? null,
        locationStatus: myDayRow?.location_status ?? null,
        workedMinutes: personalWorkedMinutes,
        taskMinutes: personalTaskMinutes,
        breakMinutes: personalBreakMinutes,
        hasOpenBreak: myBreaksToday.some((b) => !b.ended_at),
        unitsCompleted: personalUnitsCompleted,
        dailyAchievementPct: personalAchievement.dailyAchievementPct,
        dailyTarget: personalDailyTarget > 0 ? personalDailyTarget : null,
        taskCounts: {
          total: myTaskEntriesToday.length,
          draft: myTaskEntriesToday.filter((t) => t.status === "draft").length,
          submitted: myTaskEntriesToday.filter((t) => t.status === "submitted").length,
          approved: myTaskEntriesToday.filter((t) => t.status === "approved").length,
          rework: myTaskEntriesToday.filter((t) => t.status === "rework").length,
        },
        openBlockersCount: myBlockersToday.filter((b) => b.status !== "resolved").length,
        eodStatus: myEodToday?.status ?? null,
        eodReviewNote: myEodToday?.review_note ?? null,
        activeAllocations: (myAllocs ?? []).map((a) => {
          const p = a.projects as {
            code?: string;
            name?: string;
            work_mode?: string;
            task_unit?: string;
          } | null;
          return {
            id: a.id,
            projectCode: p?.code ?? "—",
            projectName: p?.name ?? "Project",
            roleInProject: a.role_in_project,
            workMode: p?.work_mode ?? "wfo",
            taskUnit: p?.task_unit ?? "units",
            dailyTarget: a.daily_task_target,
            allocationPct: a.allocation_pct,
            acknowledged: Boolean(a.acknowledged_at),
          };
        }),
        unacknowledgedAllocsCount,
        recentRequests: myRequests ?? [],
        feedbackFeed: personalFeedbackFeed,
      },
      attendance: {
        expectedActiveCount,
        checkedInToday,
        wfoToday,
        wfhToday,
        hybridOrFieldToday,
        onLeaveToday,
        holidayOrOffToday,
        uncheckedInToday,
        geofenceMismatchToday,
        summary14d: oversightSummary14d,
        trend14d: attendanceTrend14d,
      },
      workforce: {
        totalVisible: scopedProfiles.length,
        activeCount: activeScopedProfiles.length,
        categoryBreakdown,
        statusBreakdown,
        departmentBreakdown: Array.from(departmentBreakdownMap.values()).sort(
          (a, b) => b.count - a.count,
        ),
        missingReportingLeadCount,
        mustChangePasswordCount,
        pendingKycDocumentsCount: (pendingDocsRaw ?? []).length,
        underVerificationProfiles: underVerificationProfiles.slice(0, 8),
        upcomingInternshipEndings: upcomingInternshipEndings.slice(0, 8),
      },
      projects: {
        totalVisible: projectPortfolio.length,
        activeCount: projectPortfolio.filter((p) => p.status === "active").length,
        unallocatedActiveStaff,
        overAllocatedStaff,
        portfolio: projectPortfolio.slice(0, 12),
      },
      queues: {
        totalPending: pendingActions.length,
        pendingTasksCount: scopedTasks.length,
        pendingEodsCount: scopedEods.filter((e) => e.status === "submitted").length,
        escalatedEodsCount: scopedEods.filter(
          (e) => e.status === "escalated" || e.status === "performance_concern",
        ).length,
        openBlockersCount: scopedBlockers.length,
        pendingHrRequestsCount: scopedRequests.filter((r) => r.actionableTier === "hr").length,
        pendingLeadRequestsCount: scopedRequests.filter((r) => r.actionableTier === "lead").length,
        items: pendingActions,
      },
      teamProductivity,
      governance: {
        invitationsTotal: (invitationsRaw ?? []).length,
        invitationCounts,
        activeOfficesCount,
        totalOfficesCount,
        latestAutomationRun,
        unresolvedFlagsBySeverity,
        unresolvedFlagsSample: (automationFlagsRaw ?? []).slice(0, 6).map((f) => ({
          id: f.id,
          rule: f.rule,
          severity: f.severity,
          workDate: f.work_date,
          message: f.message,
          userName: nameOf(resolvedNames, f.user_id),
        })),
        auditFeed,
      },
      notifications: {
        unreadCount: (notifications ?? []).filter((n) => !n.read_at).length,
        items: notifications ?? [],
      },
      orgUpdatesFeed,
      recruitment: {
        schemaReady: recruitmentSchemaReady,
        emailProviderConfigured: emailProviderStatus.configured,
        kpis: recruitmentKpis,
        assignedUpcomingInterviewsCount,
      },
    };
  });

export type RoleDashboardData = Awaited<ReturnType<typeof getRoleDashboard>>;
