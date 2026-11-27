import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { errorToAccessScreen } from "@/components/access-denied";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { useNotificationFocus } from "@/hooks/use-notification-focus";
import {
  cancelRequest,
  decideRequest,
  listMyRequests,
  listRequestQueue,
  previewRequestRouting,
  submitRequest,
} from "@/lib/requests.functions";
import { REQUEST_STATUS_LABELS, REQUEST_TYPE_LABELS, optionsOf } from "@/lib/enums";
import { todayIso } from "@/lib/timezone";
import { PersonalizedBreakApprovalPanel } from "@/components/breaks/personalized-break-approval-panel";
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

function requestBadgeVariant(
  status: string,
): "success" | "destructive" | "warning" | "neutral" {
  if (status === "approved") return "success";
  if (status === "rejected") return "destructive";
  if (status === "cancelled" || status === "withdrawn") return "neutral";
  return "warning";
}

function formatIst(iso: string | null): string {
  if (!iso) return "—";
  return `${new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  })} IST`;
}

function ApprovalTrail({ approvals }: { approvals: ApprovalRow[] }) {
  const ordered = [...approvals].sort((a, b) => (a.tier === "lead" ? -1 : b.tier === "lead" ? 1 : 0));
  const rejectedWithNote = ordered.find((a) => a.decision === "rejected" && a.note?.trim());

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {ordered.map((a, index) => (
          <div key={a.id} className="flex items-center gap-1.5">
            {index > 0 ? <ArrowRight className="size-3.5 text-muted-foreground" /> : null}
            <Badge
              variant={
                a.decision === "approved"
                  ? "success"
                  : a.decision === "rejected"
                    ? "destructive"
                    : "warning"
              }
              className="font-normal"
            >
              {index + 1}. {a.tier.toUpperCase()} ·{" "}
              {a.decision === "pending"
                ? `Awaiting ${a.approver?.full_name ?? (a.tier === "hr" ? "HR" : "Lead")}`
                : `${a.decision} (${a.decider?.full_name ?? "—"})`}
            </Badge>
          </div>
        ))}
      </div>

      <ul className="space-y-1 text-xs text-muted-foreground">
        {ordered.map((a) => (
          <li key={a.id}>
            <span className="font-medium uppercase">{a.tier}</span> —{" "}
            {a.decision === "pending"
              ? `awaiting ${a.approver?.full_name ?? (a.tier === "hr" ? "HR" : "lead")}`
              : `${a.decision} by ${a.decider?.full_name ?? "—"} on ${formatIst(a.decided_at)}`}
            {a.note ? ` · “${a.note}”` : ""}
          </li>
        ))}
      </ul>

      {rejectedWithNote ? (
        <div
          role="note"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span className="font-semibold">
            Rejection reason ({rejectedWithNote.tier.toUpperCase()}):
          </span>{" "}
          {rejectedWithNote.note}
        </div>
      ) : null}
    </div>
  );
}

function RequestsPage() {
  const actor = useActor();
  const search = useSearch({ strict: false }) as {
    section?: string;
    requestId?: string;
    breakRequestId?: string;
  };
  const queryClient = useQueryClient();
  const canSubmit = actor.can("requests:submit:self");
  const { data: mine } = useSuspenseQuery({
    queryKey: ["my-requests"],
    queryFn: () => listMyRequests(),
  });
  const canViewQueue =
    actor.can("requests:approve:lead") ||
    actor.can("requests:approve:hr") ||
    actor.can("requests:read:team") ||
    actor.can("requests:read:all");
  const { data: queue } = useQuery({
    queryKey: ["request-queue"],
    queryFn: () => listRequestQueue(),
    enabled: canViewQueue,
  });

  useNotificationFocus(
    search.breakRequestId ||
      search.requestId ||
      (search.section ? `section-${search.section}` : null),
  );
  const { data: routing } = useQuery({
    queryKey: ["request-routing"],
    queryFn: () => previewRequestRouting(),
    enabled: canSubmit,
  });

  const today = todayIso();
  const [form, setForm] = useState({
    requestType: "leave",
    startDate: today,
    endDate: today,
    reason: "",
  });
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirmCancel, setConfirmCancel] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [confirmReject, setConfirmReject] = useState<{
    requestId: string;
    tier: "lead" | "hr";
    personName: string;
    label: string;
  } | null>(null);

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

  async function handleCancel(requestId: string) {
    setBusy(true);
    try {
      await cancelRequest({ data: { requestId } });
      toast.success("Request withdrawn.");
      setConfirmCancel(null);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not cancel the request.");
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
      setConfirmReject(null);
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
      <div className={canSubmit ? "grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]" : "space-y-6"}>
        <div className="space-y-6">
          {canSubmit ? (
            <Card data-focus-id="section-mine">
              <CardHeader>
                <CardTitle className="text-base">My requests</CardTitle>
                <CardDescription>
                  Every decision is recorded with the approver and timestamp in IST.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {mine.length === 0 ? (
                  <p className="text-sm text-muted-foreground">You have not raised any requests.</p>
                ) : null}
                {mine.map((request) => {
                  const typeLabel =
                    REQUEST_TYPE_LABELS[request.request_type] ?? request.request_type;
                  return (
                    <div
                      key={request.id}
                      data-focus-id={request.id}
                      className="space-y-2.5 rounded-md border p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium">
                          {typeLabel} ·{" "}
                          <span className="tabular-nums">
                            {request.start_date} → {request.end_date}
                          </span>
                        </p>
                        <Badge variant={requestBadgeVariant(request.status)}>
                          {REQUEST_STATUS_LABELS[request.status] ?? request.status}
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
                          onClick={() =>
                            setConfirmCancel({
                              id: request.id,
                              label: `${typeLabel} (${request.start_date} → ${request.end_date})`,
                            })
                          }
                        >
                          Withdraw request
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : null}

          {/* HR Personalized Break Approval Queue */}
          <PersonalizedBreakApprovalPanel focusBreakRequestId={search.breakRequestId} />

          {canViewQueue ? (
            <Card data-focus-id="section-approvals">
              <CardHeader>
                <CardTitle className="text-base">
                  {actor.can("requests:approve:lead") || actor.can("requests:approve:hr")
                    ? "Approval queue"
                    : "Organisation requests (read-only)"}
                </CardTitle>
                <CardDescription>
                  Lead and HR decisions are independent — both are required for staff requests.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {(queue?.requests ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No requests in your visible scope.</p>
                ) : null}
                {(queue?.requests ?? []).map((request) => {
                  const approvals = request.approvals as unknown as ApprovalRow[];
                  const person = request.profiles as { full_name?: string } | null;
                  const typeLabel =
                    REQUEST_TYPE_LABELS[request.request_type] ?? request.request_type;
                  const myTiers = approvals.filter(
                    (a) =>
                      a.decision === "pending" &&
                      ((a.tier === "lead" &&
                        queue?.canLead &&
                        (a.approver_id === actor.userId || queue?.canEscalateLead)) ||
                        (a.tier === "hr" && queue?.canHr)),
                  );
                  return (
                    <div
                      key={request.id}
                      data-focus-id={request.id}
                      className="space-y-2.5 rounded-md border p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium">
                          {person?.full_name ?? "Employee"} · {typeLabel} ·{" "}
                          <span className="tabular-nums">
                            {request.start_date} → {request.end_date}
                          </span>
                        </p>
                        <Badge variant={requestBadgeVariant(request.status)}>
                          {REQUEST_STATUS_LABELS[request.status] ?? request.status}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground">{request.reason}</p>
                      <ApprovalTrail approvals={approvals} />
                      {myTiers.map((tier) => {
                        const isEscalation =
                          tier.tier === "lead" &&
                          tier.approver_id !== actor.userId &&
                          Boolean(queue?.canEscalateLead);
                        const noteKey = `${request.id}-${tier.tier}`;
                        return (
                          <div
                            key={tier.id}
                            className="space-y-2 rounded-md bg-muted/30 p-2.5 pt-2"
                          >
                            {isEscalation ? (
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Badge variant="info">Escalation authority</Badge>
                                <span>
                                  Assigned lead: {tier.approver?.full_name ?? "Unassigned"}
                                </span>
                              </div>
                            ) : null}
                            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
                              <div className="space-y-1 sm:min-w-48 sm:flex-1">
                                <Label
                                  htmlFor={`req-note-${noteKey}`}
                                  className="text-xs text-muted-foreground"
                                >
                                  {tier.tier.toUpperCase()} decision note
                                </Label>
                                <Input
                                  id={`req-note-${noteKey}`}
                                  placeholder={`${tier.tier.toUpperCase()} note (recommended if rejecting)`}
                                  value={notes[noteKey] ?? ""}
                                  onChange={(e) =>
                                    setNotes({
                                      ...notes,
                                      [noteKey]: e.target.value,
                                    })
                                  }
                                />
                              </div>
                              <div className="flex flex-wrap gap-2">
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
                                  variant="destructive"
                                  disabled={busy}
                                  onClick={() =>
                                    setConfirmReject({
                                      requestId: request.id,
                                      tier: tier.tier as "lead" | "hr",
                                      personName: person?.full_name ?? "this employee",
                                      label: `${typeLabel} (${request.start_date} → ${request.end_date})`,
                                    })
                                  }
                                >
                                  Reject
                                </Button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : null}
        </div>

        {canSubmit ? (
          <Card className="h-fit">
            <CardHeader>
              <CardTitle className="text-base">New request</CardTitle>
              <CardDescription>
                Staff requests go to the reporting lead and HR; lead requests go to HR only.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {routing?.blocked ? (
                <p
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
                >
                  {routing.blockedReason}
                </p>
              ) : routing ? (
                <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                  Approval path:{" "}
                  <span className="font-medium text-foreground">
                    {routing.leadName ? `1. ${routing.leadName} (Lead) → 2. HR` : "1. HR"}
                  </span>
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
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
                {busy ? "Submitting…" : "Submit request"}
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <AlertDialog
        open={Boolean(confirmCancel)}
        onOpenChange={(o) => !o && setConfirmCancel(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw pending request?</AlertDialogTitle>
            <AlertDialogDescription>
              This will withdraw your{" "}
              <span className="font-medium text-foreground">{confirmCancel?.label}</span> request
              and remove it from the active approval queue.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep request</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                if (confirmCancel) void handleCancel(confirmCancel.id);
              }}
            >
              {busy ? "Withdrawing…" : "Withdraw request"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(confirmReject)}
        onOpenChange={(o) => !o && setConfirmReject(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Reject request as {confirmReject?.tier.toUpperCase()}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              You are rejecting{" "}
              <span className="font-medium text-foreground">{confirmReject?.personName}</span>&apos;s{" "}
              <span className="font-medium text-foreground">{confirmReject?.label}</span> request.
              Rejecting at either tier immediately marks the overall request as rejected and notifies
              the employee.
              {confirmReject &&
              !(notes[`${confirmReject.requestId}-${confirmReject.tier}`] ?? "").trim() ? (
                <span className="mt-2 block font-medium text-warning">
                  Note: You haven&apos;t entered a rejection reason yet. Adding a note helps the
                  employee understand why.
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                if (confirmReject) {
                  void decide(confirmReject.requestId, confirmReject.tier, "rejected");
                }
              }}
            >
              {busy ? "Rejecting…" : "Reject request"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}
