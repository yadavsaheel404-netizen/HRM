import { createServerFn } from "@tanstack/react-start";
import { isProjectShift, isTaskUnit, type ProjectShiftValue } from "@/lib/enums";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "./actor.server";
import { writeAudit } from "./audit.server";
import { loadProfileNames } from "./profile-names.server";


const PROJECT_SELECT =
  "id, code, client_name, name, description, start_date, end_date, project_lead_id, work_mode, shift, task_unit, hourly_task_target, daily_task_target, quality_target_pct, max_rejection_rate_pct, required_headcount, status, created_at";

export type ProjectDraft = {
  code: string;
  name: string;
  clientName?: string | null;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  projectLeadId?: string | null;
  teamLeadIds?: string[];
  workMode?: string;
  shift?: string | null;
  taskUnit?: string;
  hourlyTaskTarget?: number | null;
  dailyTaskTarget?: number | null;
  qualityTargetPct?: number | null;
  maxRejectionRatePct?: number | null;
  requiredHeadcount?: number;
  status?: string;
};

/** RLS decides the row set: read:all sees every project, a lead sees the ones
 *  they lead, an employee sees only projects they are allocated to. */
export const listProjects = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [{ data: projects, error }, { data: allocations }] = await Promise.all([
      context.supabase.from("projects").select(PROJECT_SELECT).order("created_at", { ascending: false }),
      context.supabase
        .from("project_allocations")
        .select("id, project_id, user_id, status, allocation_pct, acknowledged_at"),
    ]);
    if (error) throw error;

    return (projects ?? []).map((project) => {
      const rows = (allocations ?? []).filter(
        (a) => a.project_id === project.id && a.status !== "ended",
      );
      return {
        ...project,
        allocated_count: rows.length,
        pending_ack_count: rows.filter((r) => r.acknowledged_at === null).length,
      };
    });
  });

export const getProject = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => {
    if (!input?.id) throw new Error("A project id is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { data: project, error } = await context.supabase
      .from("projects")
      .select(PROJECT_SELECT)
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!project) throw new Error("This project is not visible to you.");

    const [{ data: leads }, { data: allocations }, { data: people }] = await Promise.all([
      context.supabase.from("project_team_leads").select("id, lead_id").eq("project_id", data.id),
      context.supabase
        .from("project_allocations")
        .select(
          "id, user_id, reporting_lead_id, role_in_project, start_date, end_date, hours_per_day, allocation_pct, daily_task_target, quality_target_pct, max_rejection_rate_pct, status, acknowledged_at, acknowledgment_note, over_allocation_override, created_at",
        )
        .eq("project_id", data.id)
        .order("created_at"),
      context.supabase.from("profiles").select("id, full_name, work_email, designation"),
    ]);

    // The profiles read above is RLS-scoped, so a viewer may be missing rows for
    // people on this project. profile_names() fills in name + designation so the
    // roster never renders blank; work_email stays RLS-scoped on purpose.
    const fallback = await loadProfileNames(context.supabase, [
      project.project_lead_id,
      ...(leads ?? []).map((l) => l.lead_id),
      ...(allocations ?? []).flatMap((a) => [a.user_id, a.reporting_lead_id]),
    ]);

    const direct = new Map((people ?? []).map((p) => [p.id, p]));
    const personOf = (id: string | null | undefined) => {
      if (!id) return null;
      const row = direct.get(id);
      if (row?.full_name) return row;
      const named = fallback.get(id);
      if (!named) return row ?? null;
      return {
        id,
        full_name: named.fullName,
        work_email: row?.work_email ?? "",
        designation: named.designation,
      };
    };

    return {
      project,
      projectLead: personOf(project.project_lead_id),
      teamLeads: (leads ?? []).map((l) => ({
        rowId: l.id,
        ...(personOf(l.lead_id) ?? {
          id: l.lead_id,
          full_name: "Unknown",
          work_email: "",
          designation: null,
        }),
      })),
      allocations: (allocations ?? []).map((a) => ({
        ...a,
        person: personOf(a.user_id),
        reportingLead: personOf(a.reporting_lead_id),
      })),
    };
  });


export const createProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: ProjectDraft) => {
    if (!input?.code?.trim()) throw new Error("A project code is required.");
    if (!input?.name?.trim()) throw new Error("A project name is required.");
    if (input.startDate && input.endDate && input.endDate < input.startDate) {
      throw new Error("The end date cannot be before the start date.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "projects:manage:all");

    const { data: created, error } = await context.supabase
      .from("projects")
      .insert({
        code: data.code.trim().toUpperCase(),
        name: data.name.trim(),
        client_name: data.clientName?.trim() || null,
        description: data.description?.trim() || null,
        start_date: data.startDate || null,
        end_date: data.endDate || null,
        project_lead_id: data.projectLeadId || null,
        work_mode: (data.workMode ?? "remote") as "onsite" | "remote" | "hybrid",
        shift: isProjectShift(data.shift?.trim()) ? (data.shift!.trim() as ProjectShiftValue) : null,
        task_unit: isTaskUnit(data.taskUnit?.trim()) ? data.taskUnit!.trim() : "task",
        hourly_task_target: data.hourlyTaskTarget ?? null,
        daily_task_target: data.dailyTaskTarget ?? null,
        quality_target_pct: data.qualityTargetPct ?? null,
        max_rejection_rate_pct: data.maxRejectionRatePct ?? null,
        required_headcount: data.requiredHeadcount ?? 0,
        status: (data.status ?? "active") as "draft" | "active" | "on_hold" | "completed" | "archived",
        created_by: context.userId,
      })
      .select("id, code, name")
      .single();

    if (error) {
      if (error.code === "23505") throw new Error("That project code is already in use.");
      throw error;
    }

    const teamLeadIds = (data.teamLeadIds ?? []).filter(Boolean);
    if (teamLeadIds.length) {
      const { error: leadError } = await context.supabase
        .from("project_team_leads")
        .insert(teamLeadIds.map((leadId) => ({ project_id: created.id, lead_id: leadId })));
      if (leadError) throw leadError;
    }

    await writeAudit(context.supabase, {
      actorId: context.userId,
      action: "project.created",
      entityType: "project",
      entityId: created.id,
      detail: { code: created.code, name: created.name },
    });

    return created;
  });

export const updateProjectStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string; status: string }) => {
    if (!input?.id || !input?.status) throw new Error("A project and status are required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "projects:manage:all");
    const { error } = await context.supabase
      .from("projects")
      .update({ status: data.status as "draft" | "active" | "on_hold" | "completed" | "archived" })
      .eq("id", data.id);
    if (error) throw error;
    await writeAudit(context.supabase, {
      actorId: context.userId,
      action: "project.status_changed",
      entityType: "project",
      entityId: data.id,
      detail: { status: data.status },
    });
    return { ok: true };
  });
