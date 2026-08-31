import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, ClipboardCheck } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { actorQueryOptions } from "@/hooks/use-actor";
import { errorToAccessScreen } from "@/components/access-denied";
import { acknowledgeAllocation, listMyAllocations } from "@/lib/allocations.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  const queryClient = useQueryClient();
  const { data: allocations } = useSuspenseQuery({
    queryKey: ["my-allocations"],
    queryFn: () => listMyAllocations(),
  });
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
              <Card key={a.id} data-testid="assignment-card">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-base">{project?.name ?? "Project"}</CardTitle>
                      <CardDescription>
                        {project?.code}
                        {project?.client_name ? ` · ${project.client_name}` : ""}
                      </CardDescription>
                    </div>
                    {acknowledged ? (
                      <Badge variant="secondary" className="bg-emerald-100 text-emerald-800">
                        Acknowledged
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="bg-amber-100 text-amber-900">
                        Action needed
                      </Badge>
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
                    <p className="flex items-center gap-2 rounded-md bg-emerald-50 p-3 text-emerald-900">
                      <CheckCircle2 className="size-4" />
                      Acknowledged on {new Date(a.acknowledged_at as string).toLocaleString()}
                    </p>
                  ) : (
                    <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3">
                      <p className="text-amber-900">
                        Confirm you have read the targets above. This records a timestamped
                        acknowledgment and unlocks work logging for this project.
                      </p>
                      <Textarea
                        rows={2}
                        placeholder="Optional note back to your lead"
                        value={notes[a.id] ?? ""}
                        onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })}
                      />
                      <Button
                        size="sm"
                        data-testid="acknowledge-button"
                        disabled={busy === a.id}
                        onClick={() => acknowledge(a.id)}
                      >
                        Acknowledge assignment
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
