import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowRight, CheckCircle2, ClipboardCheck } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { useNotificationFocus } from "@/hooks/use-notification-focus";
import { errorToAccessScreen } from "@/components/access-denied";
import { acknowledgeAllocation, listMyAllocations } from "@/lib/allocations.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_authenticated/my-projects")({
  head: () => ({
    meta: [
      { title: "My assignments | The AI School HRM" },
      {
        name: "description",
        content:
          "Your project assignments at The AI School, their delivery targets, and the acknowledgment you must record before logging work.",
      },
      { property: "og:title", content: "My assignments | The AI School HRM" },
      {
        property: "og:description",
        content: "Your project assignments, targets and acknowledgment status.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: MyProjectsPage,
  errorComponent: ({ error }) => errorToAccessScreen(error),
});

function MyProjectsPage() {
  const actor = useActor();
  const search = useSearch({ strict: false }) as { allocationId?: string };
  const canAcknowledge = actor.can("allocations:acknowledge:self");
  const queryClient = useQueryClient();
  const { data: allocations } = useSuspenseQuery({
    queryKey: ["my-allocations"],
    queryFn: () => listMyAllocations(),
  });
  useNotificationFocus(search.allocationId);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function acknowledge(id: string) {
    setBusy(id);
    try {
      const result = await acknowledgeAllocation({ data: { id, note: notes[id] ?? null } });
      toast.success(
        result.alreadyAcknowledged
          ? "You had already acknowledged this assignment."
          : "Assignment acknowledged — you can now log work against it.",
      );
      await queryClient.invalidateQueries({ queryKey: ["my-allocations"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not record the acknowledgment.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppShell
      title="My assignments"
      description="Acknowledge each assignment before logging work against it."
      actions={
        <Button asChild variant="outline" size="sm">
          <Link to="/my-day">
            Go to My day
            <ArrowRight className="ml-1.5 size-4" />
          </Link>
        </Button>
      }
    >
      {allocations.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
            <ClipboardCheck className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">You have no active project assignments.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {allocations.map((a) => {
            const project = a.projects as {
              code?: string;
              name?: string;
              client_name?: string | null;
              task_unit?: string;
              work_mode?: string;
              shift?: string | null;
            } | null;
            const acknowledged = Boolean(a.acknowledged_at);
            return (
              <Card key={a.id} data-focus-id={a.id} data-testid="assignment-card">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="text-base">{project?.name ?? "Project"}</CardTitle>
                      <CardDescription>
                        {project?.code}
                        {project?.client_name ? ` · ${project.client_name}` : ""}
                      </CardDescription>
                    </div>
                    {acknowledged ? (
                      <Badge variant="success">Acknowledged</Badge>
                    ) : (
                      <Badge variant="warning">Action needed</Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="grid grid-cols-2 gap-y-1.5 text-muted-foreground">
                    <span>Role</span>
                    <span className="text-right font-medium text-foreground">{a.role_in_project ?? "—"}</span>
                    <span>Allocation</span>
                    <span className="text-right font-medium text-foreground tabular-nums">{a.allocation_pct}%</span>
                    <span>Hours / day</span>
                    <span className="text-right font-medium text-foreground tabular-nums">{a.hours_per_day}</span>
                    <span>Daily target</span>
                    <span className="text-right font-medium text-foreground">
                      {a.daily_task_target ?? "—"} {a.daily_task_target ? (project?.task_unit ?? "") : ""}
                    </span>
                    <span>Shift</span>
                    <span className="text-right font-medium text-foreground">{project?.shift ?? "—"}</span>
                    <span>Dates</span>
                    <span className="text-right font-medium text-foreground">
                      {a.start_date} → {a.end_date ?? "open"}
                    </span>
                  </div>

                  {acknowledged ? (
                    <p className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 p-3 text-xs text-foreground">
                      <CheckCircle2 className="size-4 shrink-0 text-success" />
                      <span>
                        Acknowledged on{" "}
                        {new Date(a.acknowledged_at as string).toLocaleString("en-IN", {
                          timeZone: "Asia/Kolkata",
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}{" "}
                        IST
                      </span>
                    </p>
                  ) : canAcknowledge ? (
                    <div className="space-y-2.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                      <p className="text-xs text-amber-900 dark:text-amber-200">
                        Confirm you have read the targets above. This records a timestamped
                        acknowledgment and unlocks work logging for this project.
                      </p>
                      <div className="space-y-1">
                        <Label htmlFor={`ack-note-${a.id}`} className="text-xs">
                          Note to lead (optional)
                        </Label>
                        <Textarea
                          id={`ack-note-${a.id}`}
                          rows={2}
                          placeholder="Optional note back to your lead"
                          value={notes[a.id] ?? ""}
                          onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })}
                          className="bg-background"
                        />
                      </div>
                      <Button
                        size="sm"
                        data-testid="acknowledge-button"
                        disabled={busy === a.id}
                        onClick={() => acknowledge(a.id)}
                      >
                        {busy === a.id ? "Acknowledging..." : "Acknowledge assignment"}
                      </Button>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
