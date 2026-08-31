import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Search } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { actorQueryOptions } from "@/hooks/use-actor";
import { listWorkforce } from "@/lib/workforce.functions";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  ACCOUNT_STATUS_LABELS,
  CATEGORY_LABELS,
  ROLE_LABELS,
  type AccountStatus,
  type AppRole,
  type UserCategory,
} from "@/lib/permissions";

export const Route = createFileRoute("/_authenticated/workforce/")({
  head: () => ({
    meta: [
      { title: "Workforce | The AI School HRM" },
      {
        name: "description",
        content: "Directory of staff and leads with onboarding and verification status.",
      },
      { property: "og:title", content: "Workforce | The AI School HRM" },
      { property: "og:description", content: "Staff directory and verification status." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: WorkforcePage,
});

const STATUS_TONE: Record<AccountStatus, string> = {
  invited: "bg-muted text-muted-foreground",
  activated: "bg-info/15 text-info",
  profile_pending: "bg-warning/15 text-warning",
  under_verification: "bg-warning/15 text-warning",
  active: "bg-success/15 text-success",
};

function WorkforcePage() {
  const { data: people } = useSuspenseQuery({
    queryKey: ["workforce"],
    queryFn: () => listWorkforce(),
  });
  const [query, setQuery] = useState("");

  const term = query.trim().toLowerCase();
  const filtered = term
    ? people.filter((p) =>
        [p.full_name, p.work_email, p.designation].some((v) =>
          (v ?? "").toLowerCase().includes(term),
        ),
      )
    : people;
  const unassigned = people.filter((p) => p.missingReportingLead);


  return (
    <AppShell
      title="Workforce"
      description={`${people.length} ${people.length === 1 ? "person" : "people"} visible to you`}
    >
      <div className="space-y-4">
        {unassigned.length > 0 ? (
          <Card className="border-warning/40 bg-warning/10 p-4">
            <p className="text-sm font-medium text-warning">
              {unassigned.length} {unassigned.length === 1 ? "person has" : "people have"} no
              reporting lead
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              They cannot submit leave, WFH or attendance-correction requests until a reporting
              lead is assigned — the lead approval step has nobody to route to.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {unassigned.map((person) => (
                <Link
                  key={person.id}
                  to="/workforce/$personId"
                  params={{ personId: person.id }}
                  className="rounded-md border border-warning/40 bg-background px-2.5 py-1 text-xs font-medium hover:text-primary"
                >
                  {person.full_name}
                </Link>
              ))}
            </div>
          </Card>
        ) : null}

        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, email or designation"
            className="pl-9"
          />
        </div>


        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 font-medium">Designation</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((person) => (
                  <tr key={person.id} className="hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <Link
                        to="/workforce/$personId"
                        params={{ personId: person.id }}
                        className="font-medium hover:text-primary"
                      >
                        {person.full_name}
                      </Link>
                      <p className="text-xs text-muted-foreground">{person.work_email}</p>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {person.roles
                        .map((r) => ROLE_LABELS[r as AppRole] ?? r)
                        .join(", ") || "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {CATEGORY_LABELS[person.category as UserCategory] ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {person.designation ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant="outline"
                        className={STATUS_TONE[person.account_status as AccountStatus]}
                      >
                        {ACCOUNT_STATUS_LABELS[person.account_status as AccountStatus]}
                      </Badge>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                      No one matches that search.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
