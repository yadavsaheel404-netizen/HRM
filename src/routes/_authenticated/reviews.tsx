import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { HubSubNav, OVERSIGHT_HUB_TABS } from "@/components/hub-subnav";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { useNotificationFocus } from "@/hooks/use-notification-focus";
import { errorToAccessScreen } from "@/components/access-denied";
import { listTeamEntries, reviewTaskEntry } from "@/lib/daily.functions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

function entryBadgeVariant(status: string): "success" | "info" | "warning" | "neutral" {
  if (status === "approved") return "success";
  if (status === "submitted") return "info";
  if (status === "reviewed" || status === "revision_required") return "warning";
  return "neutral";
}

function ReviewsPage() {
  const actor = useActor();
  const search = useSearch({ strict: false }) as {
    date?: string;
    entryId?: string;
    employeeId?: string;
  };
  const canReview = actor.can("tasks:review:team");
  const queryClient = useQueryClient();
  const [selectedDate, setSelectedDate] = useState<string>(search.date ?? "");
  useEffect(() => {
    if (search.date) setSelectedDate(search.date);
  }, [search.date]);
  const { data } = useSuspenseQuery({
    queryKey: ["team-entries", selectedDate || "today"],
    queryFn: () => listTeamEntries({ data: selectedDate ? { date: selectedDate } : {} }),
  });
  useNotificationFocus(search.entryId);
  const [draft, setDraft] = useState<Record<string, { approved: string; rejected: string; note: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRevision, setConfirmRevision] = useState<{
    id: string;
    personName: string;
    projectCode: string;
    note: string;
  } | null>(null);

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
      setConfirmRevision(null);
      await queryClient.invalidateQueries({ queryKey: ["team-entries"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not record the review.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppShell
      title="Task reviews"
      description={`Submitted entries for ${data.workDate}.`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="reviews-work-date" className="sr-only">
            Work date
          </Label>
          <Input
            id="reviews-work-date"
            type="date"
            aria-label="Work date"
            className="h-9 w-40"
            value={selectedDate || data.workDate}
            onChange={(e) => setSelectedDate(e.target.value)}
          />
          {selectedDate ? (
            <Button size="sm" variant="ghost" onClick={() => setSelectedDate("")}>
              Today
            </Button>
          ) : null}
        </div>
      }
    >
      <HubSubNav tabs={OVERSIGHT_HUB_TABS} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Team entries</CardTitle>
          <CardDescription>Approving an entry locks it for the employee.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.entries.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing submitted by your team for {data.workDate}.
            </p>
          )}
          {data.entries.map((entry) => {
            const person = entry.profiles as { full_name?: string } | null;
            const project = entry.projects as { code?: string; task_unit?: string } | null;
            const d = draft[entry.id] ?? { approved: "", rejected: "", note: "" };
            return (
              <div
                key={entry.id}
                data-focus-id={entry.id}
                className="space-y-2.5 rounded-md border p-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    {person?.full_name ?? "Team member"} · {project?.code ?? "—"} ·{" "}
                    <span className="tabular-nums">{entry.units_completed}</span>{" "}
                    {project?.task_unit ?? "units"}
                  </p>
                  <Badge variant={entryBadgeVariant(entry.status)} className="capitalize">
                    {entry.status.replace(/_/g, " ")}
                  </Badge>
                </div>
                <p className="text-muted-foreground">{entry.task_description}</p>
                {entry.review_note ? (
                  <p className="text-xs text-muted-foreground">
                    Previous note: “{entry.review_note}”
                  </p>
                ) : null}
                {canReview && entry.status !== "approved" && (
                  <div className="grid grid-cols-2 gap-2 pt-1 sm:flex sm:flex-wrap sm:items-end">
                    <div className="space-y-1 sm:w-28">
                      <Label
                        htmlFor={`approved-${entry.id}`}
                        className="text-xs text-muted-foreground"
                      >
                        Approved
                      </Label>
                      <Input
                        id={`approved-${entry.id}`}
                        type="number"
                        min={0}
                        placeholder={String(entry.units_completed ?? 0)}
                        value={d.approved}
                        onChange={(e) =>
                          setDraft({ ...draft, [entry.id]: { ...d, approved: e.target.value } })
                        }
                      />
                    </div>
                    <div className="space-y-1 sm:w-28">
                      <Label
                        htmlFor={`rejected-${entry.id}`}
                        className="text-xs text-muted-foreground"
                      >
                        Rejected
                      </Label>
                      <Input
                        id={`rejected-${entry.id}`}
                        type="number"
                        min={0}
                        placeholder="0"
                        value={d.rejected}
                        onChange={(e) =>
                          setDraft({ ...draft, [entry.id]: { ...d, rejected: e.target.value } })
                        }
                      />
                    </div>
                    <div className="col-span-2 space-y-1 sm:min-w-48 sm:flex-1">
                      <Label
                        htmlFor={`note-${entry.id}`}
                        className="text-xs text-muted-foreground"
                      >
                        Review note
                      </Label>
                      <Input
                        id={`note-${entry.id}`}
                        placeholder="Feedback for the employee"
                        value={d.note}
                        onChange={(e) =>
                          setDraft({ ...draft, [entry.id]: { ...d, note: e.target.value } })
                        }
                      />
                    </div>
                    <div className="col-span-2 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={busy === entry.id}
                        onClick={() => decide(entry.id, "approved")}
                      >
                        {busy === entry.id ? "Saving…" : "Approve"}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy === entry.id}
                        onClick={() =>
                          setConfirmRevision({
                            id: entry.id,
                            personName: person?.full_name ?? "this employee",
                            projectCode: project?.code ?? "project",
                            note: d.note,
                          })
                        }
                      >
                        Needs revision
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <AlertDialog
        open={Boolean(confirmRevision)}
        onOpenChange={(o) => !o && setConfirmRevision(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send task entry back for revision?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-foreground">{confirmRevision?.personName}</span>{" "}
              will be asked to revise and resubmit their{" "}
              <span className="font-medium text-foreground">{confirmRevision?.projectCode}</span>{" "}
              hourly entry.
              {!confirmRevision?.note.trim() ? (
                <span className="mt-2 block font-medium text-warning">
                  Tip: You haven&apos;t added a review note explaining what needs revision.
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busy)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={Boolean(busy)}
              onClick={(e) => {
                e.preventDefault();
                if (confirmRevision) void decide(confirmRevision.id, "revision_required");
              }}
            >
              {busy ? "Sending…" : "Send for revision"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}
