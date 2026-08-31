import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "./actor.server";
import { writeAudit } from "./audit.server";

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

/** Live allocation load for one person, used by the allocate form. */
export const getAllocationLoad = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string }) => {
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
  .inputValidator((input: AllocationDraft) => {
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
    await requirePermission(context.supabase, context.userId, "allocations:manage:all");

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
        start_date: data.startDate || new Date().toISOString().slice(0, 10),
        end_date: data.endDate || null,
        hours_per_day: data.hoursPerDay ?? 8,
        allocation_pct: pct,
        daily_task_target: data.dailyTaskTarget ?? null,
        quality_target_pct: data.qualityTargetPct ?? null,
        max_rejection_rate_pct: data.maxRejectionRatePct ?? null,
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

    return { allocation: created, totalPct: total, overAllocated: total > 100 };
  });

export const endAllocation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => {
    if (!input?.id) throw new Error("An allocation is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "allocations:manage:all");
    const { error } = await context.supabase
      .from("project_allocations")
      .update({ status: "ended", end_date: new Date().toISOString().slice(0, 10) })
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
  .inputValidator((input: { id: string; note?: string | null }) => {
    if (!input?.id) throw new Error("An allocation is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { data: existing, error: readError } = await context.supabase
      .from("project_allocations")
      .select("id, user_id, status, acknowledged_at")
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

    return { alreadyAcknowledged: false, allocation: updated };
  });

/** Phase 3 will call this before accepting any work log. */
export const canLogWork = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { projectId: string }) => {
    if (!input?.projectId) throw new Error("A project is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { data: allowed, error } = await context.supabase.rpc("can_log_work", {
      _user_id: context.userId,
      _project_id: data.projectId,
    });
    if (error) throw error;
    return { allowed: allowed === true };
  });
