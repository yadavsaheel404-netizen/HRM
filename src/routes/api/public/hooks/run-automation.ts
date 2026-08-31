import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled automation tick. Authenticated with a dedicated, server-only
 * scheduler secret (never shipped to the browser); returns aggregate counters
 * only, never user data.
 */
export const Route = createFileRoute("/api/public/hooks/run-automation")({
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
          const { runAutomation } = await import("@/lib/automation.server");
          const result = await runAutomation("cron");
          return new Response(JSON.stringify(result), {
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          });
        } catch (error) {
          console.error("[run-automation]", error);
          return new Response(JSON.stringify({ error: "Automation run failed" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
