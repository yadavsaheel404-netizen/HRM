import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { actorQueryOptions } from "@/hooks/use-actor";
import { errorToAccessScreen } from "@/components/access-denied";
import { listTeamEntries, reviewTaskEntry } from "@/lib/daily.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_authenticated/reviews")({
  head: () => ({
    meta: [
      { title: "Task reviews | The AI School HRM" },
      {
        name: "description",
        content:
          "Review the hourly task entries your team submitted today, approve output, or send entries back for revision.",
      },
      { property: "og:title", content: "Task reviews | The AI School HRM" },
      {
        property: "og:description",
        content: "Approve or return submitted hourly task entries for your team.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: ReviewsPage,
  errorComponent: ({ error }) => errorToAccessScreen(error),
});

function ReviewsPage() {
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery({
    queryKey: ["team-entries"],
    queryFn: () => listTeamEntries({ data: {} }),
  });
  const [draft, setDraft] = useState<Record<string, { approved: string; rejected: string; note: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(id: string, decision: "approved" | "revision_required") {
    setBusy(id);
    try {
      const d = draft[id] ?? { approved: "", rejected: "", note: "" };
      await reviewTaskEntry({
        data: {
          id,
          decision,
          unitsApproved: d.approved === "" ? null : Number(d.approved),
          unitsRejected: d.rejected === "" ? null : Number(d.rejected),
          note: d.note || null,
        },
      });
      toast.success(decision === "approved" ? "Entry approved." : "Sent back for revision.");
      await queryClient.invalidateQueries({ queryKey: ["team-entries"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not record the review.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppShell title="Task reviews" description={`Submitted entries for ${data.workDate}.`}>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Team entries</CardTitle>
          <CardDescription>Approving an entry locks it for the employee.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.entries.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing submitted by your team today.</p>
          )}
          {data.entries.map((entry) => {
            const person = entry.profiles as { full_name?: string } | null;
            const project = entry.projects as { code?: string; task_unit?: string } | null;
            const d = draft[entry.id] ?? { approved: "", rejected: "", note: "" };
            return (
              <div key={entry.id} className="space-y-2 rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    {person?.full_name} · {project?.code} · {entry.units_completed}{" "}
                    {project?.task_unit ?? "units"}
                  </p>
                  <Badge variant={entry.status === "approved" ? "default" : "secondary"}>
                    {entry.status.replace("_", " ")}
                  </Badge>
                </div>
                <p className="text-muted-foreground">{entry.task_description}</p>
                {entry.status !== "approved" && (
                  <div className="flex flex-wrap items-end gap-2">
                    <Input
                      className="w-28"
                      type="number"
                      min={0}
                      placeholder="Approved"
                      value={d.approved}
                      onChange={(e) => setDraft({ ...draft, [entry.id]: { ...d, approved: e.target.value } })}
                    />
                    <Input
                      className="w-28"
                      type="number"
                      min={0}
                      placeholder="Rejected"
                      value={d.rejected}
                      onChange={(e) => setDraft({ ...draft, [entry.id]: { ...d, rejected: e.target.value } })}
                    />
                    <Input
                      className="min-w-48 flex-1"
                      placeholder="Review note"
                      value={d.note}
                      onChange={(e) => setDraft({ ...draft, [entry.id]: { ...d, note: e.target.value } })}
                    />
                    <Button size="sm" disabled={busy === entry.id} onClick={() => decide(entry.id, "approved")}>
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy === entry.id}
                      onClick={() => decide(entry.id, "revision_required")}
                    >
                      Needs revision
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </AppShell>
  );
}
