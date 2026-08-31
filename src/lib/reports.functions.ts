import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "./actor.server";
import type { ReportFilter } from "./reports.server";

const ALLOWED_ROLES = ["super_admin", "admin", "hr"] as const;

/**
 * Exports are Super Admin / Admin / HR only. Permission alone is not enough
 * here: Founder also holds attendance:read:all, so the role is checked too.
 * This runs server-side, so a hand-crafted request from a Lead still fails.
 */
async function requireExporter(
  supabase: Parameters<typeof requirePermission>[0],
  userId: string,
) {
  await requirePermission(supabase, userId, "attendance:read:all");
  for (const role of ALLOWED_ROLES) {
    const { data } = await supabase.rpc("has_role", { _user_id: userId, _role: role as never });
    if (data === true) return;
  }
  throw new Error("Forbidden: attendance exports are limited to Super Admin, Admin and HR.");
}

function normaliseFilter(input: Partial<ReportFilter> | undefined): ReportFilter {
  const today = new Date();
  const to = input?.to ?? today.toISOString().slice(0, 10);
  const from =
    input?.from ?? `${today.toISOString().slice(0, 7)}-01`;
  if (from > to) throw new Error("The start date must be before the end date.");
  return {
    from,
    to,
    projectIds: input?.projectIds?.filter(Boolean) ?? null,
    departmentIds: input?.departmentIds?.filter(Boolean) ?? null,
    categories: input?.categories?.filter(Boolean) ?? null,
    userIds: input?.userIds?.filter(Boolean) ?? null,
    workModes: input?.workModes?.filter(Boolean) ?? null,
  };
}

/** Reference lists that populate the export filter controls. */
export const getReportFilterOptions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await requireExporter(supabase, userId);
    const [{ data: projects }, { data: departments }, { data: people }] = await Promise.all([
      supabase.from("projects").select("id, code, name").order("code"),
      supabase.from("departments").select("id, name").order("name"),
      supabase
        .from("profiles")
        .select("id, full_name, category")
        .order("full_name"),
    ]);
    return {
      projects: projects ?? [],
      departments: departments ?? [],
      people: people ?? [],
    };
  });

export const buildAttendanceReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { type: "employee" | "project"; filter?: Partial<ReportFilter> }) => {
      if (input?.type !== "employee" && input?.type !== "project") {
        throw new Error("Pick an export type.");
      }
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireExporter(supabase, userId);
    const filter = normaliseFilter(data.filter);
    const { buildEmployeeReport, buildProjectReport } = await import("./reports.server");
    const rows =
      data.type === "employee"
        ? await buildEmployeeReport(supabase, filter)
        : await buildProjectReport(supabase, filter);

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: "attendance.exported",
      entityType: "report",
      entityId: data.type,
      detail: { ...filter, rows: rows.length },
    });

    return { type: data.type, filter, rows };
  });
