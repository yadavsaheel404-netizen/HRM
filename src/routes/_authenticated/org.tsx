import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { errorToAccessScreen } from "@/components/access-denied";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { OVERSIGHT_CSV_COLUMNS, OversightTable } from "@/components/oversight-table";
import {
  getOversight,
  listAnnouncements,
  listAuditLog,
  listTeamEods,
  publishAnnouncement,
} from "@/lib/oversight.functions";
import { downloadCsv, toCsv } from "@/lib/csv";
import { ATTENDANCE_STATUS_LABELS } from "@/lib/daily.server";
import { listWorkforce } from "@/lib/workforce.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/_authenticated/org")({
  head: () => ({
    meta: [
      { title: "Organisation console | The AI School HRM" },
      {
        name: "description",
        content:
          "Organisation-wide attendance, productivity trends, consolidated EOD reports, announcements and the audit trail.",
      },
      { property: "og:title", content: "Organisation console | The AI School HRM" },
      {
        property: "og:description",
        content: "Org metrics, consolidated EODs, announcements and audit history.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: OrgPage,
  errorComponent: ({ error }) => errorToAccessScreen(error),
});

function OrgPage() {
  const actor = useActor();
  const queryClient = useQueryClient();
  const [range, setRange] = useState({
    from: new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
  });

  const { data } = useSuspenseQuery({
    queryKey: ["oversight", "org", range.from, range.to],
    queryFn: () => getOversight({ data: range }),
  });
  const { data: eods } = useQuery({
    queryKey: ["org-eods", range.from, range.to],
    queryFn: () => listTeamEods({ data: range }),
  });
  const { data: announcements = [] } = useQuery({
    queryKey: ["announcements"],
    queryFn: () => listAnnouncements(),
  });
  const { data: workforce = [] } = useQuery({
    queryKey: ["workforce"],
    queryFn: () => listWorkforce(),
  });
  const unassigned = workforce.filter((p) => p.missingReportingLead);

  const canAudit = actor.can("audit:read:all");
  const { data: audit = [] } = useQuery({
    queryKey: ["audit-log"],
    queryFn: () => listAuditLog(),
    enabled: canAudit,
  });

  const canAnnounce = actor.can("announcements:manage:all");
  const [draft, setDraft] = useState({ title: "", body: "" });
  const [busy, setBusy] = useState(false);

  async function publish() {
    setBusy(true);
    try {
      await publishAnnouncement({ data: draft });
      setDraft({ title: "", body: "" });
      await queryClient.invalidateQueries({ queryKey: ["announcements"] });
      toast.success("Announcement published.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not publish.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell
      title="Organisation console"
      description={`${data.summary.people} people · ${data.summary.days} attendance days · ${range.from} → ${range.to}`}
      actions={
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            downloadCsv(
              `org-attendance-${range.from}-to-${range.to}.csv`,
              toCsv(data.rows, OVERSIGHT_CSV_COLUMNS),
            )
          }
        >
          <Download className="mr-1.5 size-4" /> Export CSV
        </Button>
      }
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-end gap-2">
          <Input
            type="date"
            className="w-40"
            aria-label="From date"
            value={range.from}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
          />
          <Input
            type="date"
            className="w-40"
            aria-label="To date"
            value={range.to}
            onChange={(e) => setRange({ ...range, to: e.target.value })}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <Stat label="People with activity" value={data.summary.people} />
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

        {unassigned.length > 0 ? (
          <Card className="border-warning/40 bg-warning/10">
            <CardHeader>
              <CardTitle className="text-base text-warning">
                {unassigned.length} {unassigned.length === 1 ? "person has" : "people have"} no
                reporting lead
              </CardTitle>
              <CardDescription>
                Their leave / WFH requests are blocked until a lead is assigned — the lead approval
                tier has nobody to route to.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2 text-sm">
              {unassigned.map((p) => (
                <span key={p.id} className="rounded-md border bg-background px-2.5 py-1 text-xs">
                  {p.full_name}
                </span>
              ))}
            </CardContent>
          </Card>
        ) : null}

        <Card>

          <CardHeader>
            <CardTitle className="text-base">Attendance status mix</CardTitle>
            <CardDescription>Derived statuses, never manually set.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3 text-sm">
            {Object.entries(data.summary.byStatus).map(([status, count]) => (
              <div key={status} className="rounded-md border px-3 py-2">
                <p className="text-lg font-semibold tabular-nums">{count}</p>
                <p className="text-xs text-muted-foreground">
                  {ATTENDANCE_STATUS_LABELS[status] ?? status}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Attendance & productivity</CardTitle>
            <CardDescription>
              Org-level drill-down. People management lives on{" "}
              <Link to="/workforce" className="underline underline-offset-2">
                Workforce
              </Link>{" "}
              — accounts are deactivated, never deleted.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OversightTable rows={data.rows} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Consolidated EOD reports</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {(eods?.reports ?? []).length === 0 ? (
              <p className="text-muted-foreground">No EOD reports in this range.</p>
            ) : null}
            {(eods?.reports ?? []).slice(0, 30).map((report) => (
              <div key={report.id} className="rounded-md border p-2">
                <p className="font-medium">
                  {(report.profiles as { full_name?: string } | null)?.full_name} ·{" "}
                  {report.work_date} · {report.status.replace(/_/g, " ")}
                </p>
                <p className="text-xs text-muted-foreground">{report.highlights}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Announcements</CardTitle>
            <CardDescription>Org-wide notices.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {canAnnounce ? (
              <div className="space-y-2 rounded-md border p-3">
                <Input
                  placeholder="Title"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
                <Textarea
                  rows={3}
                  placeholder="What do you want everyone to know?"
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                />
                <Button
                  size="sm"
                  disabled={busy || !draft.title.trim() || !draft.body.trim()}
                  onClick={publish}
                >
                  Publish
                </Button>
              </div>
            ) : null}
            {announcements.length === 0 ? (
              <p className="text-muted-foreground">No announcements yet.</p>
            ) : null}
            {announcements.map((a) => (
              <div key={a.id} className="rounded-md border p-2">
                <p className="font-medium">{a.title}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(a.published_at).toLocaleString()}
                </p>
                <p className="text-muted-foreground">{a.body}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        {canAudit ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Audit trail</CardTitle>
              <CardDescription>Latest 100 recorded actions.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 text-xs">
              {audit.map((entry) => (
                <p key={entry.id} className="text-muted-foreground">
                  <span className="font-mono">{new Date(entry.created_at).toLocaleString()}</span> ·{" "}
                  <span className="font-medium text-foreground">{entry.action}</span> ·{" "}
                  {entry.entity_type} · {entry.actor_email ?? "system"}
                </p>
              ))}
            </CardContent>
          </Card>
        ) : null}
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
