import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "./actor.server";
import { writeAudit } from "./audit.server";
import { loadProfileNames, nameOf } from "./profile-names.server";

export const getAutomationOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "automation:run:all");

    const [settings, runs, flags] = await Promise.all([
      supabase.from("automation_settings").select("*").eq("id", "default").maybeSingle(),
      supabase.from("automation_runs").select("*").order("started_at", { ascending: false }).limit(15),
      supabase
        .from("automation_flags")
        .select("id, rule, user_id, work_date, severity, message, detail, created_at, resolved_at")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    const names = await loadProfileNames(supabase, (flags.data ?? []).map((f) => f.user_id));
    return {
      settings: settings.data,
      runs: runs.data ?? [],
      flags: (flags.data ?? []).map((f) => ({ ...f, userName: nameOf(names, f.user_id) })),
    };
  });

export const updateAutomationSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: Record<string, number | string | boolean>) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "automation:run:all");
    const { error } = await supabase
      .from("automation_settings")
      .update(data as never)
      .eq("id", "default");
    if (error) throw error;
    await writeAudit(supabase, {
      actorId: userId,
      action: "automation.settings.update",
      entityType: "automation_settings",
      entityId: "default",
      detail: data,
    });
    return { ok: true };
  });

/** Manual "run now", identical code path to the cron. */
export const triggerAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "automation:run:all");
    const { runAutomation } = await import("./automation.server");
    const result = await runAutomation("manual");
    await writeAudit(supabase, {
      actorId: userId,
      action: "automation.run",
      entityType: "automation_run",
      entityId: result.runId ?? "skipped",
      detail: result as unknown as Record<string, unknown>,
    });
    return result;
  });

/** Flags visible to the caller (RLS already scopes self / team / all). */
export const listMyFlags = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { from?: string } | undefined) => input ?? {})
  .handler(async ({ data, context }) => {
    const from = data.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const { data: rows, error } = await context.supabase
      .from("automation_flags")
      .select("id, rule, user_id, work_date, severity, message, created_at")
      .gte("work_date", from)
      .order("work_date", { ascending: false })
      .limit(100);
    if (error) throw error;
    return rows ?? [];
  });
