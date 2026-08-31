import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { errorToAccessScreen } from "@/components/access-denied";
import { actorQueryOptions } from "@/hooks/use-actor";
import { OVERSIGHT_CSV_COLUMNS, OversightTable } from "@/components/oversight-table";
import { getOversight, listReviewEvents, listTeamEods, reviewEodReport } from "@/lib/oversight.functions";
import type { OversightRow } from "@/lib/oversight.server";
import { downloadCsv, toCsv } from "@/lib/csv";
import { REVIEW_ACTION_LABELS, optionsOf } from "@/lib/enums";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/_authenticated/team")({
  head: () => ({
    meta: [
      { title: "Team review | The AI School HRM" },
      {
        name: "description",
        content:
          "Lead view of team attendance, productivity against real project targets, and EOD review actions.",
      },
      { property: "og:title", content: "Team review | The AI School HRM" },
      {
        property: "og:description",
        content: "Review your team's day, approve EOD reports and export the same numbers.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: TeamPage,
  errorComponent: ({ error }) => errorToAccessScreen(error),
});

const ACTION_OPTIONS = optionsOf(REVIEW_ACTION_LABELS);

function TeamPage() {
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery({
    queryKey: ["oversight", "team"],
    queryFn: () => getOversight({ data: {} }),
  });
  const { data: eods } = useSuspenseQuery({
    queryKey: ["team-eods"],
    queryFn: () => listTeamEods({ data: {} }),
  });
  const [selected, setSelected] = useState<OversightRow | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { action: string; note: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const { data: events = [] } = useQuery({
    queryKey: ["review-events", selected?.userId],
    queryFn: () => listReviewEvents({ data: { userId: selected!.userId } }),
    enabled: !!selected,
  });

  async function review(id: string) {
    const draft = drafts[id] ?? { action: "approved", note: "" };
    setBusy(id);
    try {
      await reviewEodReport({ data: { id, action: draft.action, note: draft.note || null } });
      toast.success(`Recorded: ${REVIEW_ACTION_LABELS[draft.action as never] ?? draft.action}.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["team-eods"] }),
        queryClient.invalidateQueries({ queryKey: ["oversight", "team"] }),
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not record the review.");
    } finally {
      setBusy(null);
    }
  }

  function exportCsv() {
    downloadCsv(
      `team-attendance-${data.filter.from}-to-${data.filter.to}.csv`,
      toCsv(data.rows, OVERSIGHT_CSV_COLUMNS),
    );
  }

  return (
    <AppShell
      title="Team review"
      description={`${data.filter.from} → ${data.filter.to} · ${data.summary.people} people · ${data.summary.days} days`}
      actions={
        <Button size="sm" variant="outline" onClick={exportCsv}>
          <Download className="mr-1.5 size-4" /> Export CSV
        </Button>
      }
    >
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Worked hours" value={`${data.summary.workedHours}h`} />
          <Stat label="Units completed" value={data.summary.unitsCompleted} />
          <Stat
            label="Avg target achievement"
            value={
              data.summary.avgAchievementPct != null ? `${data.summary.avgAchievementPct}%` : "—"
            }
          />
          <Stat label="Days needing attention" value={data.summary.problemDays} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Team days</CardTitle>
            <CardDescription>
              Click a row to drill into that person's review history. Every figure comes from the
              same derivation used by the export.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OversightTable rows={data.rows} onSelect={setSelected} />
          </CardContent>
        </Card>

        {selected ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{selected.fullName} — review history</CardTitle>
              <CardDescription>
                {selected.workDate} · {selected.status} · {selected.achievement.unitsCompleted}{" "}
                units ·{" "}
                {selected.achievement.dailyAchievementPct != null
                  ? `${selected.achievement.dailyAchievementPct}% of target`
                  : "no target set"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {events.length === 0 ? (
                <p className="text-muted-foreground">No review actions recorded yet.</p>
              ) : null}
              {events.map((event) => (
                <div key={event.id} className="rounded-md border p-2">
                  <p className="font-medium">
                    {REVIEW_ACTION_LABELS[event.action as never] ?? event.action} ·{" "}
                    {event.entity_type.replace("_", " ")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {(event.profiles as { full_name?: string } | null)?.full_name ?? "Reviewer"} ·{" "}
                    {new Date(event.created_at).toLocaleString()}
                    {event.note ? ` · “${event.note}”` : ""}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">EOD reports</CardTitle>
            <CardDescription>
              Approve, approve with comment, request revision, escalate or flag a performance
              concern — each action records you and the time.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {eods.reports.length === 0 ? (
              <p className="text-sm text-muted-foreground">No EOD reports in this range.</p>
            ) : null}
            {eods.reports.map((report) => {
              const draft = drafts[report.id] ?? { action: "approved", note: "" };
              const person = report.profiles as { full_name?: string } | null;
              return (
                <div key={report.id} className="space-y-2 rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">
                      {person?.full_name} · {report.work_date}
                    </p>
                    <Badge variant={report.status === "approved" ? "default" : "secondary"}>
                      {report.status.replace(/_/g, " ")}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground">{report.highlights}</p>
                  {report.reviewed_at ? (
                    <p className="text-xs text-muted-foreground">
                      Last reviewed {new Date(report.reviewed_at).toLocaleString()}
                      {report.review_note ? ` · “${report.review_note}”` : ""}
                    </p>
                  ) : null}
                  {report.events.length > 0 ? (
                    <ul className="space-y-0.5 text-xs text-muted-foreground">
                      {report.events.map((event) => (
                        <li key={event.id}>
                          {REVIEW_ACTION_LABELS[event.action as never] ?? event.action} ·{" "}
                          {(event.profiles as { full_name?: string } | null)?.full_name ?? "—"} ·{" "}
                          {new Date(event.created_at).toLocaleString()}
                          {event.note ? ` · “${event.note}”` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="flex flex-wrap items-end gap-2">
                    <select
                      aria-label="Review action"
                      className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                      value={draft.action}
                      onChange={(e) =>
                        setDrafts({ ...drafts, [report.id]: { ...draft, action: e.target.value } })
                      }
                    >
                      {ACTION_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <Input
                      className="min-w-48 flex-1"
                      placeholder="Comment"
                      value={draft.note}
                      onChange={(e) =>
                        setDrafts({ ...drafts, [report.id]: { ...draft, note: e.target.value } })
                      }
                    />
                    <Button size="sm" disabled={busy === report.id} onClick={() => review(report.id)}>
                      Record action
                    </Button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}
