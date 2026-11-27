import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { hasPermission, requirePermission } from "./actor.server";
import { writeAudit } from "./audit.server";
import {
  fetchProjectAllocationCandidates,
  lookupTargetProfiles,
  type AllocatableCandidate,
  type CandidateEligibilityStatus,
  type LoadCandidatesInput,
} from "./project-staffing.server";
import { evalCanManageProjectSafe } from "./schema-compat.server";
import { todayIso } from "./timezone";
import {
  evaluateAnnotationContributor,
  evaluateAnnotationLogging,
} from "./work-type";
import {
  assertCanLogAnnotationWork,
  isProtectedAccountId,
  loadProfileWorkTypes,
  loadProjectWorkTypes,
  loadProtectedAccountIds,
} from "./work-type.server";

async function requireAllocationManage(
  supabase: Parameters<typeof requirePermission>[0],
  userId: string,
  projectId: string,
) {
  if (await hasPermission(supabase, userId, "allocations:manage:all")) return;

  await requirePermission(supabase, userId, "allocations:manage:team");
  const canScoped = await evalCanManageProjectSafe(supabase, projectId, userId);
  if (!canScoped) {
    throw new Error("Forbidden: you can only manage allocations on projects within your assigned scope.");
  }
}

const ALLOCATION_SELECT =
  "id, project_id, user_id, reporting_lead_id, role_in_project, start_date, end_date, hours_per_day, allocation_pct, daily_task_target, quality_target_pct, max_rejection_rate_pct, status, acknowledged_at, acknowledged_by, acknowledgment_note, over_allocation_override, created_at";

export type AllocationDraft = {
  projectId: string;
  userId: string;
  reportingLeadId?: string | null;
  roleInProject?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  hoursPerDay?: number;
  allocationPct?: number;
  dailyTaskTarget?: number | null;
  qualityTargetPct?: number | null;
  maxRejectionRatePct?: number | null;
  /** Set after the allocator confirms the over-allocation warning. */
  overAllocationOverride?: boolean;
};

export type AllocatableEmployee = AllocatableCandidate;
export type { CandidateEligibilityStatus };

export type GetAllocatableEmployeesInput = {
  projectId: string;
  search?: string;
  departmentId?: string;
  workType?: string;
  role?: string;
  category?: string;
  capacityFilter?: "all" | "available" | "full";
  assignedFilter?: "all" | "unallocated" | "allocated";
  limit?: number;
  offset?: number;
};

/**
 * Returns all eligible, non-protected employees across the entire organization for project allocation.
 * Enriched with home department, work type, role, current allocation %, and project membership.
 * Uses the security-definer RPC / server candidate discovery to bypass manager HR reporting-tree restrictions.
 */
export const getAllocatableEmployees = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: GetAllocatableEmployeesInput) => {
    if (!input?.projectId) throw new Error("A project ID is required.");
    return input;
  })
  .handler(async ({ data, context }): Promise<{
    employees: AllocatableEmployee[];
    totalCount: number;
    projectWorkType: string | null;
    availableLeads: Array<{ id: string; fullName: string; designation: string | null }>;
    departments: Array<{ id: string; name: string }>;
  }> => {
    // Viewer must have permission to manage or view allocations on the project
    await requireAllocationManage(context.supabase, context.userId, data.projectId);

    const result = await fetchProjectAllocationCandidates(context.supabase, data);

    return {
      employees: result.candidates,
      totalCount: result.totalCount,
      projectWorkType: result.projectWorkType,
      availableLeads: result.availableLeads,
      departments: result.departments,
    };
  });

/** Live allocation load for one person, used by the allocate form. */
export const getAllocationLoad = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { userId: string }) => {
    if (!input?.userId) throw new Error("A person is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { data: used, error } = await context.supabase.rpc("allocation_pct_used", {
      _user_id: data.userId,
    });
    if (error) throw error;

    const { data: rows } = await context.supabase
      .from("project_allocations")
      .select("id, allocation_pct, status, project_id, projects(code, name)")
      .eq("user_id", data.userId)
      .neq("status", "ended");

    return {
      usedPct: Number(used ?? 0),
      allocations: (rows ?? []).map((r) => ({
        id: r.id,
        pct: Number(r.allocation_pct),
        status: r.status,
        projectCode: (r.projects as { code?: string } | null)?.code ?? "",
        projectName: (r.projects as { name?: string } | null)?.name ?? "",
      })),
    };
  });

export const createAllocation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: AllocationDraft) => {
    if (!input?.projectId) throw new Error("A project is required.");
    if (!input?.userId) throw new Error("A person is required.");
    const pct = input.allocationPct ?? 100;
    if (pct <= 0 || pct > 100) throw new Error("Allocation percentage must be between 1 and 100.");
    const hours = input.hoursPerDay ?? 8;
    if (hours <= 0 || hours > 24) throw new Error("Hours per day must be between 1 and 24.");
    if (input.startDate && input.endDate && input.endDate < input.startDate) {
      throw new Error("The allocation end date cannot be before its start date.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    await requireAllocationManage(context.supabase, context.userId, data.projectId);

    // Protected system-owner accounts are never allocatable.
    const { map: targetMap, protectedIds } = await lookupTargetProfiles([data.userId]);
    if (protectedIds.has(data.userId)) {
      throw new Error("That person cannot be allocated to projects.");
    }

    // Target employee must be an active account.
    const target = targetMap.get(data.userId);
    if (!target || target.employment_status !== "active") {
      throw new Error("Only active employees can be allocated to projects.");
    }

    const projectTypes = await loadProjectWorkTypes(context.supabase, [data.projectId]);
    const isAnnotationProject = projectTypes.map.get(data.projectId) === "annotation";
    const isAnnotationMember = target.work_type === "annotation";
    const applyTargets = isAnnotationProject && isAnnotationMember;

    const pct = data.allocationPct ?? 100;
    const { data: used, error: loadError } = await context.supabase.rpc("allocation_pct_used", {
      _user_id: data.userId,
    });
    if (loadError) throw loadError;

    const usedPct = Number(used ?? 0);
    const total = usedPct + pct;
    if (total > 100 && !data.overAllocationOverride) {
      const { data: rows } = await context.supabase
        .from("project_allocations")
        .select("allocation_pct, projects(code, name)")
        .eq("user_id", data.userId)
        .neq("status", "ended");
      const conflicts = (rows ?? []).map(
        (r) =>
          `${(r.projects as { code?: string } | null)?.code ?? "?"} (${Number(r.allocation_pct)}%)`,
      );
      throw new Error(
        `OVER_ALLOCATION::${JSON.stringify({ usedPct, newPct: pct, total, conflicts })}`,
      );
    }

    const { data: created, error } = await context.supabase
      .from("project_allocations")
      .insert({
        project_id: data.projectId,
        user_id: data.userId,
        reporting_lead_id: data.reportingLeadId || null,
        role_in_project: data.roleInProject?.trim() || null,
        start_date: data.startDate || todayIso(),
        end_date: data.endDate || null,
        hours_per_day: data.hoursPerDay ?? 8,
        allocation_pct: pct,
        daily_task_target: applyTargets ? data.dailyTaskTarget ?? null : null,
        quality_target_pct: applyTargets ? data.qualityTargetPct ?? null : null,
        max_rejection_rate_pct: applyTargets ? data.maxRejectionRatePct ?? null : null,
        over_allocation_override: total > 100,
        allocated_by: context.userId,
      })
      .select(ALLOCATION_SELECT)
      .single();

    if (error) {
      if (error.code === "23505") throw new Error("That person is already allocated to this project.");
      throw error;
    }

    await writeAudit(context.supabase, {
      actorId: context.userId,
      action: "allocation.created",
      entityType: "project_allocation",
      entityId: created.id,
      detail: {
        project_id: data.projectId,
        user_id: data.userId,
        allocation_pct: pct,
        total_after: total,
        over_allocated: total > 100,
      },
    });

    if (data.userId !== context.userId) {
      try {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { notify } = await import("./daily-queries.server");
        const { data: projRow } = await supabaseAdmin
          .from("projects")
          .select("name, code")
          .eq("id", data.projectId)
          .maybeSingle();
        const projLabel = projRow ? `${projRow.code} · ${projRow.name}` : "a project";
        await notify(supabaseAdmin, {
          userId: data.userId,
          actorId: context.userId,
          type: "allocation.assigned",
          title: `Assigned to ${projLabel}`,
          body: `Open My Assignments to acknowledge this allocation (${pct}%).`,
          entityType: "project_allocation",
          entityId: created.id,
          actionLabel: "View Assignment",
          actionUrl: `/my-projects?allocationId=${created.id}`,
          metadata: { projectId: data.projectId, allocationId: created.id },
        });
      } catch {
        // Non-fatal
      }
    }

    return { allocation: created, totalPct: total, overAllocated: total > 100 };
  });

export const updateAllocation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      id: string;
      reportingLeadId?: string | null;
      roleInProject?: string | null;
      startDate?: string | null;
      endDate?: string | null;
      hoursPerDay?: number;
      allocationPct?: number;
      dailyTaskTarget?: number | null;
      qualityTargetPct?: number | null;
      maxRejectionRatePct?: number | null;
      overAllocationOverride?: boolean;
    }) => {
      if (!input?.id) throw new Error("An allocation ID is required.");
      const pct = input.allocationPct ?? 100;
      if (pct <= 0 || pct > 100) throw new Error("Allocation percentage must be between 1 and 100.");
      const hours = input.hoursPerDay ?? 8;
      if (hours <= 0 || hours > 24) throw new Error("Hours per day must be between 1 and 24.");
      if (input.startDate && input.endDate && input.endDate < input.startDate) {
        throw new Error("The allocation end date cannot be before its start date.");
      }
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { data: existing, error: findErr } = await context.supabase
      .from("project_allocations")
      .select("id, project_id, user_id, allocation_pct, status")
      .eq("id", data.id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!existing) throw new Error("Allocation not found.");

    await requireAllocationManage(context.supabase, context.userId, existing.project_id);

    const pct = data.allocationPct ?? Number(existing.allocation_pct);
    const { data: used, error: loadError } = await context.supabase.rpc("allocation_pct_used", {
      _user_id: existing.user_id,
    });
    if (loadError) throw loadError;

    const usedWithoutCurrent = Math.max(0, Number(used ?? 0) - Number(existing.allocation_pct));
    const total = usedWithoutCurrent + pct;
    if (total > 100 && !data.overAllocationOverride) {
      throw new Error(
        `OVER_ALLOCATION::${JSON.stringify({ usedPct: usedWithoutCurrent, newPct: pct, total, conflicts: [] })}`,
      );
    }

    const [targetWorkTypes, projectTypes] = await Promise.all([
      loadProfileWorkTypes(context.supabase, [existing.user_id]),
      loadProjectWorkTypes(context.supabase, [existing.project_id]),
    ]);
    const isAnnotationProject = projectTypes.map.get(existing.project_id) === "annotation";
    const isAnnotationMember = targetWorkTypes.map.get(existing.user_id) === "annotation";
    const applyTargets = isAnnotationProject && isAnnotationMember;

    const { data: updated, error } = await context.supabase
      .from("project_allocations")
      .update({
        reporting_lead_id: data.reportingLeadId || null,
        role_in_project: data.roleInProject?.trim() || null,
        start_date: data.startDate || todayIso(),
        end_date: data.endDate || null,
        hours_per_day: data.hoursPerDay ?? 8,
        allocation_pct: pct,
        daily_task_target: applyTargets ? data.dailyTaskTarget ?? null : null,
        quality_target_pct: applyTargets ? data.qualityTargetPct ?? null : null,
        max_rejection_rate_pct: applyTargets ? data.maxRejectionRatePct ?? null : null,
        over_allocation_override: total > 100,
      })
      .eq("id", data.id)
      .select(ALLOCATION_SELECT)
      .single();

    if (error) throw error;

    await writeAudit(context.supabase, {
      actorId: context.userId,
      action: "allocation.updated",
      entityType: "project_allocation",
      entityId: data.id,
      detail: { project_id: existing.project_id, user_id: existing.user_id, allocation_pct: pct },
    });

    return { allocation: updated };
  });

export const bulkCreateAllocations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      projectId: string;
      allocations: Array<{
        userId: string;
        roleInProject?: string | null;
        reportingLeadId?: string | null;
        allocationPct?: number;
        hoursPerDay?: number;
        startDate?: string | null;
        endDate?: string | null;
        dailyTaskTarget?: number | null;
        qualityTargetPct?: number | null;
        maxRejectionRatePct?: number | null;
        overAllocationOverride?: boolean;
      }>;
    }) => {
      if (!input?.projectId) throw new Error("A project ID is required.");
      if (!Array.isArray(input?.allocations) || input.allocations.length === 0) {
        throw new Error("At least one allocation is required.");
      }
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    await requireAllocationManage(context.supabase, context.userId, data.projectId);

    const { data: project } = await context.supabase
      .from("projects")
      .select("id, status, work_type")
      .eq("id", data.projectId)
      .single();
    if (!project) throw new Error("Project not found.");

    // Load active allocations for duplicate check
    const { data: existingAllocs } = await context.supabase
      .from("project_allocations")
      .select("user_id")
      .eq("project_id", data.projectId)
      .neq("status", "ended");
    const existingUserIds = new Set((existingAllocs ?? []).map((a) => a.user_id));

    // Load target profiles and project work type via server helper (bypassing manager RLS)
    const userIds = [...new Set(data.allocations.map((a) => a.userId).filter(Boolean))];
    const [{ map: profileMap, protectedIds }, projectTypes] = await Promise.all([
      lookupTargetProfiles(userIds),
      loadProjectWorkTypes(context.supabase, [data.projectId]),
    ]);
    const isAnnotationProject = projectTypes.map.get(data.projectId) === "annotation";

    const results: Array<{
      userId: string;
      status: "created" | "failed";
      error?: string;
      id?: string;
    }> = [];

    const toInsert: any[] = [];
    const seenBatch = new Set<string>();

    for (const item of data.allocations) {
      if (!item.userId) {
        results.push({ userId: "", status: "failed", error: "Missing user ID" });
        continue;
      }
      if (seenBatch.has(item.userId)) {
        results.push({ userId: item.userId, status: "failed", error: "Duplicate in batch" });
        continue;
      }
      seenBatch.add(item.userId);

      if (protectedIds.has(item.userId)) {
        results.push({
          userId: item.userId,
          status: "failed",
          error: "Protected account cannot be allocated",
        });
        continue;
      }
      if (existingUserIds.has(item.userId)) {
        results.push({
          userId: item.userId,
          status: "failed",
          error: "Already allocated to this project",
        });
        continue;
      }

      const prof = profileMap.get(item.userId);
      if (!prof || prof.employment_status !== "active") {
        results.push({
          userId: item.userId,
          status: "failed",
          error: "Employee is not active or not found",
        });
        continue;
      }

      const pct = Math.min(100, Math.max(1, Number(item.allocationPct) || 100));
      const hours = Math.min(24, Math.max(1, Number(item.hoursPerDay) || 8));
      const isAnnotationMember = prof.work_type === "annotation";
      const applyTargets = isAnnotationProject && isAnnotationMember;

      toInsert.push({
        project_id: data.projectId,
        user_id: item.userId,
        reporting_lead_id: item.reportingLeadId || null,
        role_in_project: item.roleInProject?.trim() || null,
        start_date: item.startDate || todayIso(),
        end_date: item.endDate || null,
        hours_per_day: hours,
        allocation_pct: pct,
        daily_task_target: applyTargets && item.dailyTaskTarget != null ? Number(item.dailyTaskTarget) : null,
        quality_target_pct: applyTargets && item.qualityTargetPct != null ? Number(item.qualityTargetPct) : null,
        max_rejection_rate_pct: applyTargets && item.maxRejectionRatePct != null ? Number(item.maxRejectionRatePct) : null,
        over_allocation_override: item.overAllocationOverride ?? false,
        allocated_by: context.userId,
      });
    }

    if (toInsert.length > 0) {
      const { data: inserted, error: insertError } = await context.supabase
        .from("project_allocations")
        .insert(toInsert)
        .select("id, user_id");

      if (insertError) {
        throw new Error(`Bulk allocation insert failed: ${insertError.message}`);
      }

      for (const row of inserted ?? []) {
        results.push({ userId: row.user_id, status: "created", id: row.id });
      }

      await writeAudit(context.supabase, {
        actorId: context.userId,
        action: "allocation.bulk_created",
        entityType: "project",
        entityId: data.projectId,
        detail: {
          count: inserted?.length ?? 0,
          project_id: data.projectId,
        },
      });
    }

    return {
      total: data.allocations.length,
      createdCount: results.filter((r) => r.status === "created").length,
      failedCount: results.filter((r) => r.status === "failed").length,
      results,
    };
  });

export const endAllocation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { id: string }) => {
    if (!input?.id) throw new Error("An allocation is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { data: existing, error: findErr } = await context.supabase
      .from("project_allocations")
      .select("id, project_id")
      .eq("id", data.id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!existing) throw new Error("Allocation not found.");

    await requireAllocationManage(context.supabase, context.userId, existing.project_id);
    const { error } = await context.supabase
      .from("project_allocations")
      .update({ status: "ended", end_date: todayIso() })
      .eq("id", data.id);
    if (error) throw error;
    await writeAudit(context.supabase, {
      actorId: context.userId,
      action: "allocation.ended",
      entityType: "project_allocation",
      entityId: data.id,
      detail: {},
    });
    return { ok: true };
  });

/** Everything the signed-in person is assigned to, with the project terms. */
export const listMyAllocations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("project_allocations")
      .select(
        `${ALLOCATION_SELECT}, projects(id, code, name, client_name, task_unit, work_mode, shift, hourly_task_target, daily_task_target, quality_target_pct, max_rejection_rate_pct, status)`,
      )
      .eq("user_id", context.userId)
      .neq("status", "ended")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data ?? [];
  });

/**
 * The acknowledgment. Only ever writes the caller's own row — and the
 * database trigger rejects it too if the row is not theirs.
 */
export const acknowledgeAllocation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { id: string; note?: string | null }) => {
    if (!input?.id) throw new Error("An allocation is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "allocations:acknowledge:self");
    const { data: existing, error: readError } = await context.supabase
      .from("project_allocations")
      .select("id, user_id, project_id, allocated_by, status, acknowledged_at")
      .eq("id", data.id)
      .maybeSingle();
    if (readError) throw readError;
    if (!existing) throw new Error("That assignment is not visible to you.");
    if (existing.user_id !== context.userId) {
      throw new Error("Only the assigned person can acknowledge this allocation.");
    }
    if (existing.acknowledged_at) return { alreadyAcknowledged: true, allocation: existing };

    const { data: updated, error } = await context.supabase
      .from("project_allocations")
      .update({
        acknowledged_at: new Date().toISOString(),
        acknowledged_by: context.userId,
        acknowledgment_note: data.note?.trim() || null,
        status: "active",
      })
      .eq("id", data.id)
      .select(ALLOCATION_SELECT)
      .single();
    if (error) throw error;

    await writeAudit(context.supabase, {
      actorId: context.userId,
      action: "allocation.acknowledged",
      entityType: "project_allocation",
      entityId: data.id,
      detail: { project_id: updated.project_id, acknowledged_at: updated.acknowledged_at },
    });

    if (existing.allocated_by && existing.allocated_by !== context.userId) {
      try {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { notify } = await import("./daily-queries.server");
        const { data: empRow } = await supabaseAdmin
          .from("profiles")
          .select("full_name")
          .eq("id", context.userId)
          .maybeSingle();
        await notify(supabaseAdmin, {
          userId: existing.allocated_by,
          actorId: context.userId,
          type: "allocation.acknowledged",
          title: `${empRow?.full_name ?? "Team member"} acknowledged project assignment`,
          body: "Allocation is now active for work logging.",
          entityType: "project_allocation",
          entityId: updated.id,
          section: "allocations",
          actionLabel: "View Allocation",
          actionUrl: `/projects/${updated.project_id}?section=allocations&allocationId=${updated.id}`,
          metadata: { projectId: updated.project_id, allocationId: updated.id },
        });
      } catch {
        // Non-fatal
      }
    }

    return { alreadyAcknowledged: false, allocation: updated };
  });

/** Phase 3 will call this before accepting any work log. */
export const canLogWork = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { projectId: string }) => {
    if (!input?.projectId) throw new Error("A project is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { data: allowed, error } = await context.supabase.rpc("can_log_work", {
      _user_id: context.userId,
      _project_id: data.projectId,
    });
    if (error) throw error;
    if (allowed !== true) return { allowed: false };
    try {
      await assertCanLogAnnotationWork(context.supabase, context.userId, data.projectId, todayIso());
      return { allowed: true };
    } catch {
      return { allowed: false };
    }
  });
