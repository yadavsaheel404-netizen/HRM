import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "./actor.server";
import {
  summariseRoster,
  validateRoster,
  type RosterRaw,
  type RosterRow,
} from "./roster-import";

/** Roster import is HR / Admin / Super Admin only — both permissions are held by exactly those roles. */
async function requireRosterAdmin(
  supabase: Parameters<typeof requirePermission>[0],
  userId: string,
) {
  await requirePermission(supabase, userId, "workforce:create:all");
  await requirePermission(supabase, userId, "invitations:create:all");
}

async function buildLookups(supabase: Parameters<typeof requirePermission>[0]) {
  const [{ data: departments }, { data: profiles }, { data: invitations }] = await Promise.all([
    supabase.from("departments").select("id, name"),
    supabase.from("profiles").select("id, work_email"),
    supabase.from("invitations").select("email, status"),
  ]);

  return {
    departments: new Map(
      (departments ?? []).map((d: { id: string; name: string }) => [d.name.toLowerCase(), d.id]),
    ),
    accountsByEmail: new Map(
      (profiles ?? []).map((p: { id: string; work_email: string }) => [
        (p.work_email ?? "").toLowerCase(),
        p.id,
      ]),
    ),
    invitedEmails: new Set(
      (invitations ?? [])
        .filter((i: { status: string }) =>
          ["queued", "sending", "sent", "accepted"].includes(i.status),
        )
        .map((i: { email: string }) => i.email.toLowerCase()),
    ),
  };
}

/** Validates an uploaded roster against live data. Writes nothing. */
export const validateRosterUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { fileName: string; rows: RosterRaw[] }) => {
    if (!Array.isArray(input?.rows) || input.rows.length === 0) {
      throw new Error("That file has no data rows.");
    }
    if (input.rows.length > 500) {
      throw new Error("Roster imports are capped at 500 rows per file.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireRosterAdmin(supabase, userId);
    const rows = validateRoster(data.rows, await buildLookups(supabase));
    return { fileName: data.fileName, rows, summary: summariseRoster(rows) };
  });

export type RosterCommitResult = {
  rowNumber: number;
  fullName: string;
  email: string;
  outcome: "created" | "skipped" | "failed";
  reason: string;
};

/**
 * Re-validates server-side (never trusts the preview the browser sent back),
 * then queues one invitation per importable row. Rows are inserted one at a
 * time so a single bad row cannot roll back the rest of the batch.
 */
export const commitRosterImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { fileName: string; rows: RosterRaw[] }) => {
    if (!Array.isArray(input?.rows) || input.rows.length === 0) {
      throw new Error("Nothing to import.");
    }
    if (input.rows.length > 500) {
      throw new Error("Roster imports are capped at 500 rows per file.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireRosterAdmin(supabase, userId);

    const validated = validateRoster(data.rows, await buildLookups(supabase));

    const batchId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const results: RosterCommitResult[] = [];

    for (const row of validated as RosterRow[]) {
      if (row.severity === "error") {
        results.push({
          rowNumber: row.rowNumber,
          fullName: row.fullName,
          email: row.email,
          outcome: "skipped",
          reason: row.errors.join(" "),
        });
        continue;
      }

      const { error } = await supabase.from("invitations").insert({
        email: row.email,
        full_name: row.fullName,
        role: "employee" as never,
        category: row.category as never,
        designation: row.designation,
        department_id: row.departmentId,
        reporting_lead_id: row.reportingLeadId,
        status: "queued" as const,
        source: "bulk_roster_import",
        batch_id: batchId,
        created_by: userId,
        expires_at: expiresAt,
        metadata: {
          mobile: row.phone,
          joiningDate: row.joiningDate,
          lastWorkingDay: row.lastWorkingDate,
        } as never,
      });

      results.push({
        rowNumber: row.rowNumber,
        fullName: row.fullName,
        email: row.email,
        outcome: error ? "failed" : "created",
        reason: error ? error.message : row.warnings.join(" "),
      });
    }

    const created = results.filter((r) => r.outcome === "created").length;
    const skipped = results.filter((r) => r.outcome === "skipped").length;
    const failed = results.filter((r) => r.outcome === "failed").length;

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: "roster.imported",
      entityType: "invitation_batch",
      entityId: batchId,
      detail: { fileName: data.fileName, created, skipped, failed },
    });

    return { batchId, created, skipped, failed, results };
  });
