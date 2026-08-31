import { createFileRoute } from "@tanstack/react-router";

/**
 * Throttled invitation drain, called on a schedule. Authenticated with a
 * dedicated, server-only scheduler secret (never shipped to the browser); it
 * performs no read of user data and returns only aggregate counters.
 */
export const Route = createFileRoute("/api/public/hooks/dispatch-invitations")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const provided =
          request.headers.get("x-scheduler-secret") ??
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
          "";
        const expected = process.env["SCHEDULER_HOOK_SECRET"] ?? "";

        if (!expected || provided.length !== expected.length || provided !== expected) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }


        try {
          const { dispatchInvitationBatch } = await import("@/lib/invitations.server");
          const result = await dispatchInvitationBatch({
            redirectTo: `${new URL(request.url).origin}/auth/callback`,
          });
          return new Response(JSON.stringify(result), {
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          });
        } catch (error) {
          console.error("[dispatch-invitations]", error);
          return new Response(JSON.stringify({ error: "Dispatch failed" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
