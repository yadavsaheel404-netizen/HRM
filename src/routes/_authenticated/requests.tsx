import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { errorToAccessScreen } from "@/components/access-denied";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import {
  cancelRequest,
  decideRequest,
  listMyRequests,
  listRequestQueue,
  previewRequestRouting,
  submitRequest,

} from "@/lib/requests.functions";
import { REQUEST_STATUS_LABELS, REQUEST_TYPE_LABELS, optionsOf } from "@/lib/enums";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/_authenticated/requests")({
  head: () => ({
    meta: [
      { title: "Leave & WFH requests | The AI School HRM" },
      {
        name: "description",
        content:
          "Raise leave, work-from-home and attendance-correction requests and follow every approval decision.",
      },
      { property: "og:title", content: "Leave & WFH requests | The AI School HRM" },
      {
        property: "og:description",
        content: "Submit requests and track the lead and HR decisions on each one.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: RequestsPage,
  errorComponent: ({ error }) => errorToAccessScreen(error),
});

const TYPE_OPTIONS = optionsOf(REQUEST_TYPE_LABELS);

type ApprovalRow = {
  id: string;
  tier: string;
  decision: string;
  approver_id: string | null;
  decided_at: string | null;
  note: string | null;
  approver?: { full_name?: string } | null;
  decider?: { full_name?: string } | null;
};

function ApprovalTrail({ approvals }: { approvals: ApprovalRow[] }) {
  return (
    <ul className="space-y-1 text-xs text-muted-foreground">
      {approvals.map((a) => (
        <li key={a.id}>
          <span className="font-medium uppercase">{a.tier}</span> —{" "}
          {a.decision === "pending"
            ? `awaiting ${a.approver?.full_name ?? (a.tier === "hr" ? "HR" : "lead")}`
            : `${a.decision} by ${a.decider?.full_name ?? "—"} on ${
                a.decided_at ? new Date(a.decided_at).toLocaleString() : "—"
              }`}
          {a.note ? ` · “${a.note}”` : ""}
        </li>
      ))}
    </ul>
  );
}

function RequestsPage() {
  const actor = useActor();
  const queryClient = useQueryClient();
  const { data: mine } = useSuspenseQuery({
    queryKey: ["my-requests"],
    queryFn: () => listMyRequests(),
  });
  const canApprove =
    actor.can("requests:approve:lead") ||
    actor.can("requests:approve:hr") ||
    actor.can("requests:read:all");
  const { data: queue } = useQuery({
    queryKey: ["request-queue"],
    queryFn: () => listRequestQueue(),
    enabled: canApprove,
  });
  const { data: routing } = useQuery({
    queryKey: ["request-routing"],
    queryFn: () => previewRequestRouting(),
  });


  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    requestType: "leave",
    startDate: today,
    endDate: today,
    reason: "",
  });
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["my-requests"] }),
      queryClient.invalidateQueries({ queryKey: ["request-queue"] }),
      queryClient.invalidateQueries({ queryKey: ["my-notifications"] }),
    ]);
  }

  async function submit() {
    setBusy(true);
    try {
      const result = await submitRequest({ data: form });
      toast.success(`Request submitted. ${result.routingReason}`);
      setForm({ ...form, reason: "" });
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not submit the request.");
    } finally {
      setBusy(false);
    }
  }

  async function decide(
    requestId: string,
    tier: "lead" | "hr",
    decision: "approved" | "rejected",
  ) {
    setBusy(true);
    try {
      const result = await decideRequest({
        data: { requestId, tier, decision, note: notes[`${requestId}-${tier}`] ?? null },
      });
      toast.success(
        result.overall === "pending"
          ? `${tier.toUpperCase()} decision recorded — still waiting on the other approver.`
          : `Request ${result.overall}.`,
      );
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not record the decision.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell
      title="Requests"
      description="Leave, work-from-home and attendance corrections — with the full decision history."
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">My requests</CardTitle>
              <CardDescription>
                Every decision is recorded with the approver and timestamp.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {mine.length === 0 ? (
                <p className="text-sm text-muted-foreground">You have not raised any requests.</p>
              ) : null}
              {mine.map((request) => (
                <div key={request.id} className="space-y-2 rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">
                      {REQUEST_TYPE_LABELS[request.request_type]} · {request.start_date} →{" "}
                      {request.end_date}
                    </p>
                    <Badge variant={request.status === "approved" ? "default" : "secondary"}>
                      {REQUEST_STATUS_LABELS[request.status]}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground">{request.reason}</p>
                  <p className="text-xs text-muted-foreground">{request.routing_reason}</p>
                  <ApprovalTrail approvals={request.approvals as unknown as ApprovalRow[]} />
                  {request.status === "pending" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={async () => {
                        await cancelRequest({ data: { requestId: request.id } });
                        await refresh();
                      }}
                    >
                      Cancel
                    </Button>
                  ) : null}
                </div>
              ))}
            </CardContent>
          </Card>

          {canApprove ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Approval queue</CardTitle>
                <CardDescription>
                  Lead and HR decisions are independent — both are required for staff requests.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {(queue?.requests ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing waiting on you.</p>
                ) : null}
                {(queue?.requests ?? []).map((request) => {
                  const approvals = request.approvals as unknown as ApprovalRow[];
                  const person = request.profiles as { full_name?: string } | null;
                  const myTiers = approvals.filter(
                    (a) =>
                      a.decision === "pending" &&
                      ((a.tier === "lead" && queue?.canLead && a.approver_id === actor.userId) ||
                        (a.tier === "hr" && queue?.canHr)),
                  );
                  return (
                    <div key={request.id} className="space-y-2 rounded-md border p-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium">
                          {person?.full_name} · {REQUEST_TYPE_LABELS[request.request_type]} ·{" "}
                          {request.start_date} → {request.end_date}
                        </p>
                        <Badge variant="outline">{REQUEST_STATUS_LABELS[request.status]}</Badge>
                      </div>
                      <p className="text-muted-foreground">{request.reason}</p>
                      <ApprovalTrail approvals={approvals} />
                      {myTiers.map((tier) => (
                        <div key={tier.id} className="flex flex-wrap items-end gap-2">
                          <Input
                            className="min-w-48 flex-1"
                            placeholder={`${tier.tier.toUpperCase()} note (optional)`}
                            value={notes[`${request.id}-${tier.tier}`] ?? ""}
                            onChange={(e) =>
                              setNotes({
                                ...notes,
                                [`${request.id}-${tier.tier}`]: e.target.value,
                              })
                            }
                          />
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              decide(request.id, tier.tier as "lead" | "hr", "approved")
                            }
                          >
                            Approve as {tier.tier.toUpperCase()}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() =>
                              decide(request.id, tier.tier as "lead" | "hr", "rejected")
                            }
                          >
                            Reject
                          </Button>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">New request</CardTitle>
            <CardDescription>
              Staff requests go to the reporting lead and HR; lead requests go to HR only.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {routing?.blocked ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                {routing.blockedReason}
              </p>
            ) : routing ? (
              <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                Approvers: {routing.leadName ? `${routing.leadName} (lead) + HR` : "HR"}
              </p>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="request-type">Type</Label>
              <select
                id="request-type"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={form.requestType}
                onChange={(e) => setForm({ ...form, requestType: e.target.value })}
              >
                {TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="start-date">From</Label>
                <Input
                  id="start-date"
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="end-date">To</Label>
                <Input
                  id="end-date"
                  type="date"
                  value={form.endDate}
                  onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reason">Reason</Label>
              <Textarea
                id="reason"
                rows={4}
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder="Why do you need this?"
              />
            </div>
            <Button
              className="w-full"
              disabled={busy || !form.reason.trim() || routing?.blocked === true}
              onClick={submit}
            >

              Submit request
            </Button>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
