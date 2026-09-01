import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "./actor.server";

export type InviteDraft = {
  email: string;
  fullName: string;
  role: string;
  category: string;
  designation?: string | null;
  departmentId?: string | null;
  reportingLeadId?: string | null;
  /** Extra joining details captured at import time; applied on acceptance. */
  metadata?: {
    mobile?: string | null;
    joiningDate?: string | null;
    lastWorkingDay?: string | null;
    employeeCode?: string | null;
  } | null;
};

export const listInvitations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePermission(context.supabase, context.userId, "invitations:read:all");
    const { data, error } = await context.supabase
      .from("invitations")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    return data;
  });

export const getInvitationStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePermission(context.supabase, context.userId, "invitations:read:all");
    const { data, error } = await context.supabase.from("invitations").select("status");
    if (error) throw error;
    const counts: Record<string, number> = {};
    for (const row of data ?? []) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return { total: data?.length ?? 0, counts };
  });

/**
 * Enqueue one or many invitations. Nothing is emailed here — rows land as
 * `queued` and the throttled worker drains them, so a 150-row import behaves
 * exactly like a single invite.
 */
export const enqueueInvitations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { invites: InviteDraft[]; source?: string }) => {
    if (!Array.isArray(input.invites) || input.invites.length === 0) {
      throw new Error("At least one invitation is required.");
    }
    if (input.invites.length > 500) {
      throw new Error("Import batches are capped at 500 invitations at a time.");
    }
    const seen = new Set<string>();
    const invites = input.invites.map((invite) => {
      const email = String(invite.email ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error(`"${invite.email}" is not a valid email address.`);
      }
      if (seen.has(email)) throw new Error(`Duplicate email in this batch: ${email}`);
      seen.add(email);
      const fullName = String(invite.fullName ?? "").trim();
      if (fullName.length < 2) throw new Error(`A full name is required for ${email}.`);
      return {
        email,
        fullName,
        role: invite.role || "employee",
        category: invite.category || "full_time",
        designation: invite.designation?.trim() || null,
        departmentId: invite.departmentId || null,
        reportingLeadId: invite.reportingLeadId || null,
        metadata: invite.metadata ?? null,
      };
    });
    return { invites, source: input.source ?? "manual" };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "invitations:create:all");

    const emails = data.invites.map((i) => i.email);
    const { data: existing } = await supabase
      .from("invitations")
      .select("email, status")
      .in("email", emails)
      .in("status", ["queued", "sending", "sent", "accepted"]);

    const blocked = new Set((existing ?? []).map((row) => row.email.toLowerCase()));
    const fresh = data.invites.filter((invite) => !blocked.has(invite.email));

    const batchId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

    let inserted: { id: string; email: string; status: string }[] = [];
    if (fresh.length > 0) {
      const { data: rows, error } = await supabase
        .from("invitations")
        .insert(
          fresh.map((invite) => ({
            email: invite.email,
            full_name: invite.fullName,
            role: invite.role as never,
            category: invite.category as never,
            designation: invite.designation,
            department_id: invite.departmentId,
            reporting_lead_id: invite.reportingLeadId,
            status: "queued" as const,
            source: data.source,
            batch_id: batchId,
            created_by: userId,
            expires_at: expiresAt,
            metadata: (invite.metadata ?? {}) as never,
          })),
        )
        .select("id, email, status");
      if (error) throw error;
      inserted = rows ?? [];
    }

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: "invitation.enqueued",
      entityType: "invitation_batch",
      entityId: batchId,
      detail: { queued: inserted.length, skipped: data.invites.length - inserted.length },
    });

    return {
      batchId,
      queued: inserted.length,
      skipped: data.invites.length - inserted.length,
      skippedEmails: [...blocked],
    };
  });

export const requeueInvitation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => {
    if (!input?.id) throw new Error("Invitation id is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "invitations:create:all");
    const { error } = await context.supabase
      .from("invitations")
      .update({
        status: "queued",
        attempts: 0,
        last_error: null,
        next_attempt_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .eq("id", data.id)
      .in("status", ["failed", "revoked", "sent"]);
    if (error) throw error;
    return { ok: true };
  });

export const revokeInvitation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => {
    if (!input?.id) throw new Error("Invitation id is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "invitations:create:all");
    const { error } = await context.supabase
      .from("invitations")
      .update({ status: "revoked" })
      .eq("id", data.id)
      .in("status", ["queued", "sending", "sent", "failed"]);
    if (error) throw error;
    return { ok: true };
  });

/** Manual drain, for when an admin does not want to wait for the next tick. */
export const runInvitationDispatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePermission(context.supabase, context.userId, "invitations:create:all");
    const { dispatchInvitationBatch } = await import("./invitations.server");
    return dispatchInvitationBatch();
  });

/** Read-only preview of the next incremental employee ID for the invitation form. */
export const getNextEmployeeIdPreview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePermission(context.supabase, context.userId, "invitations:create:all");
    const { data, error } = await context.supabase.rpc("peek_next_employee_id");
    if (error) {
      console.warn("[invitations] Failed to peek next employee id:", error);
      return "TAS-001";
    }
    return (data as string) || "TAS-001";
  });

