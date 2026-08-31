import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { loadActor } from "./actor.server";

/**
 * Resolves the signed-in person, and advances their account lifecycle on
 * first authenticated visit: an `invited` account becomes `activated`, and
 * the matching invitation row is marked `accepted`.
 */
export const getSessionActor = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    let actor = await loadActor(supabase, userId);

    if (actor.accountStatus === "invited") {
      // Best effort: the lifecycle promotion must never blank the first screen
      // a newly invited employee sees. If it fails we log it and carry on with
      // the actor we already resolved.
      try {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const now = new Date().toISOString();

        await supabaseAdmin
          .from("invitations")
          .update({ status: "accepted", accepted_at: now })
          .eq("invited_user_id", userId)
          .in("status", ["sent", "queued", "sending"]);

        await supabaseAdmin
          .from("profiles")
          .update({ account_status: "activated" })
          .eq("id", userId)
          .eq("account_status", "invited");

        const { writeAudit } = await import("./audit.server");
        await writeAudit(supabaseAdmin, {
          actorId: userId,
          actorEmail: actor.workEmail,
          action: "invitation.accepted",
          entityType: "profile",
          entityId: userId,
        });

        actor = await loadActor(supabase, userId);
      } catch (error) {
        console.error("[session] invited-account promotion failed", error);
      }
    }


    return actor;
  });
