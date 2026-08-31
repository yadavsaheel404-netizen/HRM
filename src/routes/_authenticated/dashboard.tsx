import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, FileWarning, Users } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { useActor } from "@/hooks/use-actor";
import { actorQueryOptions } from "@/hooks/use-actor";
import { listWorkforce } from "@/lib/workforce.functions";
import { getInvitationStats } from "@/lib/invitations.functions";
import { listMyDocuments } from "@/lib/documents.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  ACCOUNT_STATUS_LABELS,
  REQUIRED_DOCUMENT_TYPES,
  type AccountStatus,
} from "@/lib/permissions";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard | The AI School HRM" },
      {
        name: "description",
        content: "Your onboarding progress, team status and pending actions at The AI School.",
      },
      { property: "og:title", content: "Dashboard | The AI School HRM" },
      { property: "og:description", content: "Workforce overview and pending actions." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: DashboardPage,
});

function DashboardPage() {
  const actor = useActor();
  const canSeeTeam = actor.can("workforce:read:team") || actor.can("workforce:read:all");

  return (
    <AppShell
      title={`Good to see you, ${actor.fullName?.split(" ")[0] || "there"}`}
      description="Everything waiting on you today."
    >
      <div className="space-y-6">
        <OnboardingCard status={actor.accountStatus} />
        {canSeeTeam ? <TeamSnapshot showInvites={actor.can("invitations:read:all")} /> : null}
      </div>
    </AppShell>
  );
}

function OnboardingCard({ status }: { status: AccountStatus }) {
  const { data: documents } = useSuspenseQuery({
    queryKey: ["my-documents"],
    queryFn: () => listMyDocuments(),
  });

  const uploaded = new Set(documents.map((d) => d.doc_type));
  const done = REQUIRED_DOCUMENT_TYPES.filter((t) => uploaded.has(t)).length;
  const pct = Math.round((done / REQUIRED_DOCUMENT_TYPES.length) * 100);

  if (status === "active") {
    return (
      <Card>
        <CardHeader className="flex-row items-center gap-3 space-y-0">
          <CheckCircle2 className="size-5 text-success" />
          <div>
            <CardTitle className="text-base">Your profile is verified</CardTitle>
            <CardDescription>
              You are cleared for project allocation and daily reporting.
            </CardDescription>
          </div>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="border-warning/40">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Clock className="size-4 text-warning" />
          <CardTitle className="text-base">Finish your onboarding</CardTitle>
          <Badge variant="outline">{ACCOUNT_STATUS_LABELS[status]}</Badge>
        </div>
        <CardDescription>
          {status === "under_verification"
            ? "Your profile is with HR for verification. You will be notified once it is approved."
            : "Complete your profile and upload the required documents to get verified."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Required documents</span>
            <span className="font-medium">
              {done} of {REQUIRED_DOCUMENT_TYPES.length}
            </span>
          </div>
          <Progress value={pct} />
        </div>
        {status !== "under_verification" ? (
          <Button asChild size="sm">
            <Link to="/onboarding">Continue onboarding</Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TeamSnapshot({ showInvites }: { showInvites: boolean }) {
  const { data: people } = useSuspenseQuery({
    queryKey: ["workforce"],
    queryFn: () => listWorkforce(),
  });

  const pendingVerification = people.filter((p) => p.account_status === "under_verification");
  const notOnboarded = people.filter(
    (p) => p.account_status !== "active" && p.account_status !== "under_verification",
  );
  const needsAssignment = people.filter((p) => p.needs_assignment);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Users} label="People visible to you" value={people.length} />
        <StatCard
          icon={FileWarning}
          label="Awaiting your verification"
          value={pendingVerification.length}
          tone={pendingVerification.length > 0 ? "warning" : "muted"}
        />
        <StatCard
          icon={AlertTriangle}
          label="Onboarding incomplete"
          value={notOnboarded.length}
          tone={notOnboarded.length > 0 ? "warning" : "muted"}
        />
        <StatCard icon={CheckCircle2} label="Awaiting allocation" value={needsAssignment.length} />
      </div>

      {showInvites ? <InviteStats /> : null}

      {pendingVerification.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Profiles waiting on verification</CardTitle>
            <CardDescription>Review documents and approve to activate the account.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y divide-border">
            {pendingVerification.slice(0, 6).map((person) => (
              <Link
                key={person.id}
                to="/workforce/$personId"
                params={{ personId: person.id }}
                className="flex items-center justify-between py-2.5 text-sm hover:text-primary"
              >
                <span className="font-medium">{person.full_name}</span>
                <span className="text-muted-foreground">{person.designation ?? "—"}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function InviteStats() {
  const { data } = useSuspenseQuery({
    queryKey: ["invitation-stats"],
    queryFn: () => getInvitationStats(),
  });

  const queued = data.counts["queued"] ?? 0;
  const failed = data.counts["failed"] ?? 0;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Invitation queue</CardTitle>
          <CardDescription>
            {queued} waiting to send · {data.counts["sent"] ?? 0} sent ·{" "}
            {data.counts["accepted"] ?? 0} accepted
            {failed > 0 ? ` · ${failed} failed` : ""}
          </CardDescription>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link to="/invitations">Open queue</Link>
        </Button>
      </CardHeader>
    </Card>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone = "muted",
}: {
  icon: typeof Users;
  label: string;
  value: number;
  tone?: "muted" | "warning";
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 pt-6">
        <div
          className={
            tone === "warning"
              ? "rounded-md bg-warning/15 p-2 text-warning"
              : "rounded-md bg-muted p-2 text-muted-foreground"
          }
        >
          <Icon className="size-4" />
        </div>
        <div>
          <p className="text-2xl font-semibold tabular-nums">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}
