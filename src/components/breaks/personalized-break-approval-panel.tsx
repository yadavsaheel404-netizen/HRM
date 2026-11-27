import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Clock, Filter, ShieldAlert, Sparkles, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useActor } from "@/hooks/use-actor";
import {
  decidePersonalizedBreak,
  listPersonalizedBreakRequests,
  type BreakRequestRow,
} from "@/lib/breaks.functions";
import { formatDurationHuman } from "@/lib/breaks/break-management";
import { todayIso } from "@/lib/timezone";

export function PersonalizedBreakApprovalPanel({
  focusBreakRequestId,
}: {
  focusBreakRequestId?: string | null | undefined;
}) {
  const actor = useActor();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("pending");
  const [approvedMinutesMap, setApprovedMinutesMap] = useState<Record<string, number>>({});
  const [notesMap, setNotesMap] = useState<Record<string, string>>({});

  useEffect(() => {
    if (focusBreakRequestId) setFilter("all");
  }, [focusBreakRequestId]);

  const isHrOrAdmin = actor.roles.some((r) => ["hr", "admin", "super_admin"].includes(r));

  const { data, isLoading } = useQuery({
    queryKey: ["personalized-break-requests", todayIso()],
    queryFn: () => listPersonalizedBreakRequests({ data: { workDate: todayIso() } }),
    refetchInterval: 15_000,
  });

  if (!isHrOrAdmin) return null;

  const requests: BreakRequestRow[] = data?.requests ?? [];

  const visibleRequests = requests.filter((r) => {
    if (filter === "all") return true;
    return r.status === filter;
  });

  async function handleDecide(
    requestId: string,
    decision: "approved" | "rejected",
    defaultMinutes: number,
  ) {
    setBusyId(requestId);
    try {
      const minutesToApprove = approvedMinutesMap[requestId] ?? defaultMinutes;
      const note = notesMap[requestId] ?? null;

      await decidePersonalizedBreak({
        data: {
          requestId,
          decision,
          approvedMinutes: decision === "approved" ? minutesToApprove : null,
          note,
        },
      });

      toast.success(
        `Personalized break request ${decision === "approved" ? "approved" : "rejected"}.`,
      );
      await queryClient.invalidateQueries({ queryKey: ["personalized-break-requests"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to record decision.");
    } finally {
      setBusyId(null);
    }
  }

  const pendingCount = requests.filter((r) => r.status === "pending").length;

  return (
    <Card className="border-border" data-focus-id="section-breaks">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              Personalized Break Approvals (HR Queue)
            </CardTitle>
            <CardDescription>
              Review and approve custom break requests for today ({todayIso()}). Reasons are confidential to HR.
            </CardDescription>
          </div>
          {pendingCount > 0 && (
            <Badge variant="warning" className="animate-pulse">
              {pendingCount} Pending Review
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Filter Pills */}
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground mr-1 flex items-center gap-1">
            <Filter className="size-3" /> Filter:
          </span>
          {[
            { id: "pending", label: `Pending (${requests.filter((r) => r.status === "pending").length})` },
            { id: "approved", label: `Approved (${requests.filter((r) => r.status === "approved").length})` },
            { id: "consumed", label: `Started (${requests.filter((r) => r.status === "consumed").length})` },
            { id: "rejected", label: `Rejected (${requests.filter((r) => r.status === "rejected").length})` },
            { id: "all", label: `All (${requests.length})` },
          ].map((tab) => (
            <Button
              key={tab.id}
              type="button"
              size="sm"
              variant={filter === tab.id ? "default" : "outline"}
              className="h-7 text-xs px-2.5"
              onClick={() => setFilter(tab.id)}
            >
              {tab.label}
            </Button>
          ))}
        </div>

        {/* Requests List */}
        {isLoading ? (
          <p className="text-xs text-muted-foreground py-4 text-center">Loading requests…</p>
        ) : visibleRequests.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
            No personalized break requests matching this filter for today.
          </div>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border overflow-hidden">
            {visibleRequests.map((req) => {
              const isSelf = req.userId === actor.userId;
              const defaultMins = req.approvedMinutes ?? req.requestedMinutes;
              const currentMins = approvedMinutesMap[req.id] ?? defaultMins;

              return (
                <div
                  key={req.id}
                  data-focus-id={req.id}
                  className="p-3.5 space-y-2.5 bg-card hover:bg-muted/10 transition-colors text-xs"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-foreground">{req.fullName}</span>
                        <span className="text-muted-foreground font-mono">({req.workEmail})</span>
                        <Badge
                          variant={
                            req.status === "approved"
                              ? "success"
                              : req.status === "consumed"
                                ? "info"
                                : req.status === "rejected"
                                  ? "destructive"
                                  : "warning"
                          }
                          className="capitalize text-[10px] px-1.5"
                        >
                          {req.status === "consumed" ? "Break Started" : req.status}
                        </Badge>
                      </div>
                      <div className="text-muted-foreground flex items-center gap-2">
                        <span>Requested: <strong>{formatDurationHuman(req.requestedMinutes * 60)}</strong></span>
                        {req.approvedMinutes && req.approvedMinutes !== req.requestedMinutes && (
                          <span>· Approved: <strong>{formatDurationHuman(req.approvedMinutes * 60)}</strong></span>
                        )}
                        <span>· Submitted at {new Date(req.createdAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true })}</span>
                      </div>
                    </div>
                  </div>

                  {/* Private Reason (Visible only to HR/Admin) */}
                  <div className="rounded-md bg-muted/40 p-2 border border-border/60 text-foreground">
                    <span className="font-medium text-muted-foreground block text-[11px] mb-0.5">Confidential Reason:</span>
                    <p className="italic">&ldquo;{req.reason}&rdquo;</p>
                  </div>

                  {/* Decision Controls (when pending) */}
                  {req.status === "pending" && (
                    <div className="pt-1.5">
                      {isSelf ? (
                        <div className="flex items-center gap-1.5 text-xs text-amber-600 font-medium bg-amber-500/10 p-2 rounded-md border border-amber-500/20">
                          <ShieldAlert className="size-4 shrink-0" />
                          <span>Self-Approval Prevention: You cannot approve your own request. Another HR or Administrator must decide.</span>
                        </div>
                      ) : (
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 bg-background p-2.5 rounded-md border border-border">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="flex items-center gap-1.5">
                              <Label htmlFor={`mins-${req.id}`} className="text-[11px] text-muted-foreground">Approve mins:</Label>
                              <Input
                                id={`mins-${req.id}`}
                                type="number"
                                min={1}
                                max={240}
                                className="w-20 h-7 text-xs"
                                value={currentMins}
                                onChange={(e) =>
                                  setApprovedMinutesMap((prev) => ({
                                    ...prev,
                                    [req.id]: Math.max(1, Math.min(240, parseInt(e.target.value) || defaultMins)),
                                  }))
                                }
                              />
                            </div>
                            <div className="flex items-center gap-1.5 flex-1 min-w-44">
                              <Input
                                placeholder="Decision note (optional)..."
                                className="h-7 text-xs"
                                value={notesMap[req.id] ?? ""}
                                onChange={(e) =>
                                  setNotesMap((prev) => ({ ...prev, [req.id]: e.target.value }))
                                }
                              />
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                              disabled={busyId === req.id}
                              onClick={() => handleDecide(req.id, "approved", req.requestedMinutes)}
                            >
                              <CheckCircle2 className="size-3.5 mr-1" /> Approve
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              className="h-7 text-xs"
                              disabled={busyId === req.id}
                              onClick={() => handleDecide(req.id, "rejected", req.requestedMinutes)}
                            >
                              <XCircle className="size-3.5 mr-1" /> Reject
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {req.decisionNote && (
                    <p className="text-[11px] text-muted-foreground">
                      Decision Note: &ldquo;{req.decisionNote}&rdquo;
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
