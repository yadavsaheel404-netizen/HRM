// Append-only audit trail. Never let a logging failure break the operation
// that is being logged — audit writes are best effort and always swallowed.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Client = SupabaseClient<Database>;

export type AuditEntry = {
  actorId: string | null;
  actorEmail?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
};

export async function writeAudit(supabase: Client, entry: AuditEntry): Promise<void> {
  try {
    let actorEmail = entry.actorEmail ?? null;
    if (!actorEmail && entry.actorId) {
      const { data } = await supabase
        .from("profiles")
        .select("work_email")
        .eq("id", entry.actorId)
        .maybeSingle();
      actorEmail = data?.work_email ?? null;
    }
    await supabase.from("audit_logs").insert({
      actor_id: entry.actorId,
      actor_email: actorEmail,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      detail: (entry.detail ?? {}) as never,
    });
  } catch (error) {
    console.error("[audit] failed to record entry", entry.action, error);
  }
}
