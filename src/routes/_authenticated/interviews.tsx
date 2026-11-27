import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  ExternalLink,
  Plus,
  RefreshCw,
  Search,
  Star,
  UserCheck,
  Video,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useNotificationFocus } from "@/hooks/use-notification-focus";
import { AccessDenied, errorToAccessScreen } from "@/components/access-denied";
import { AppShell } from "@/components/app-shell";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { describeUnknownError } from "@/lib/describe-error";
import {
  listInterviews,
  scheduleInterview,
  submitInterviewFeedback,
  updateInterviewLifecycle,
} from "@/lib/interviews.functions";
import {
  CANDIDATE_STATUS_LABELS,
  formatInterviewIstSlot,
  INTERVIEW_RECOMMENDATIONS,
  INTERVIEW_RECOMMENDATION_LABELS,
  INTERVIEW_STATUS_LABELS,
  type CandidateStatus,
  type InterviewMode,
  type InterviewRecommendation,
  type InterviewStatus,
} from "@/lib/recruitment/pipeline";
import { todayIso } from "@/lib/timezone";

export const Route = createFileRoute("/_authenticated/interviews")({
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: InterviewsWorkspacePage,
});

type FilterTab = "upcoming" | "needs_scorecard" | "completed" | "cancelled" | "all";

function toIstDateAndTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return { date: todayIso(), time: "11:00" };
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hh = get("hour") === "24" ? "00" : get("hour");
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${hh}:${get("minute")}`,
  };
}

function buildIstIso(dateStr: string, timeStr: string): string {
  return new Date(`${dateStr}T${timeStr}:00+05:30`).toISOString();
}

function buildIstSlotPreview(dateStr: string, startStr: string, endStr: string) {
  if (!dateStr || !startStr || !endStr) return null;
  const s = new Date(`${dateStr}T${startStr}:00+05:30`);
  const e = new Date(`${dateStr}T${endStr}:00+05:30`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
  const diffMins = Math.round((e.getTime() - s.getTime()) / 60000);
  if (diffMins <= 0) {
    return { valid: false as const, message: "End time (IST) must be after start time (IST)." };
  }
  const fmt = formatInterviewIstSlot(s.toISOString(), e.toISOString());
  return {
    valid: true as const,
    message: `${fmt.dateLabel} · ${fmt.timeRangeLabel} (${diffMins} mins)`,
  };
}

function interviewStatusVariant(
  status: string,
): "success" | "warning" | "info" | "destructive" | "outline" {
  if (status === "completed") return "success";
  if (status === "cancelled" || status === "no_show") return "destructive";
  if (status === "rescheduled") return "warning";
  if (status === "scheduled") return "info";
  return "outline";
}

function recommendationBadgeClass(rec: InterviewRecommendation): string {
  switch (rec) {
    case "strong_hire":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "hire":
      return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "hold":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "no_hire":
      return "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  }
}

function InterviewsWorkspacePage() {
  useSuspenseQuery(actorQueryOptions);
  const searchParams = useSearch({ strict: false }) as { interviewId?: string; action?: string };
  const actor = useActor();
  const queryClient = useQueryClient();

  const allowed =
    actor.can("interviews:read:all") || actor.can("interviews:feedback:assigned");

  const interviewsQuery = useQuery({
    queryKey: ["recruitment", "interviews"],
    queryFn: () => listInterviews(),
    enabled: allowed,
  });

  const [activeTab, setActiveTab] = useState<FilterTab>(
    searchParams.interviewId ? "all" : "upcoming",
  );
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (searchParams.interviewId) {
      setActiveTab("all");
    } else if (searchParams.action === "scorecard") {
      setActiveTab("needs_scorecard");
    }
  }, [searchParams.interviewId, searchParams.action]);

  useNotificationFocus(searchParams.interviewId, { ready: !interviewsQuery.isLoading });

  // Schedule dialog state
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [schedCandidateId, setSchedCandidateId] = useState("");
  const [schedRoundNumber, setSchedRoundNumber] = useState(1);
  const [schedRoundName, setSchedRoundName] = useState("Technical Round 1");
  const [schedMode, setSchedMode] = useState<InterviewMode>("online");
  const [schedDate, setSchedDate] = useState(() => todayIso());
  const [schedStartTime, setSchedStartTime] = useState("11:00");
  const [schedEndTime, setSchedEndTime] = useState("11:45");
  const [schedMeetingLink, setSchedMeetingLink] = useState("");
  const [schedOfficeId, setSchedOfficeId] = useState("");
  const [schedLocationDetails, setSchedLocationDetails] = useState("");
  const [schedInterviewerIds, setSchedInterviewerIds] = useState<string[]>([]);
  const [schedInstructions, setSchedInstructions] = useState("");
  const [schedulingBusy, setSchedulingBusy] = useState(false);

  // Reschedule dialog state
  const [rescheduleTargetId, setRescheduleTargetId] = useState<string | null>(null);
  const [reschedDate, setReschedDate] = useState(() => todayIso());
  const [reschedStartTime, setReschedStartTime] = useState("14:00");
  const [reschedEndTime, setReschedEndTime] = useState("14:45");
  const [reschedMode, setReschedMode] = useState<InterviewMode>("online");
  const [reschedMeetingLink, setReschedMeetingLink] = useState("");
  const [reschedOfficeId, setReschedOfficeId] = useState("");
  const [reschedLocationDetails, setReschedLocationDetails] = useState("");
  const [reschedInterviewerIds, setReschedInterviewerIds] = useState<string[]>([]);
  const [reschedReason, setReschedReason] = useState("");
  const [lifecycleBusy, setLifecycleBusy] = useState(false);

  // Cancel / No-show dialog state
  const [cancelTarget, setCancelTarget] = useState<{
    interviewId: string;
    candidateName: string;
    roundName: string;
    action: "cancel" | "no_show";
  } | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  // Complete confirmation dialog state
  const [completeTarget, setCompleteTarget] = useState<{
    interviewId: string;
    candidateName: string;
    roundName: string;
    scorecardCount: number;
  } | null>(null);

  // Scorecard feedback dialog state
  const [scorecardTarget, setScorecardTarget] = useState<{
    interviewId: string;
    candidateName: string;
    roundName: string;
  } | null>(null);
  const [fbRating, setFbRating] = useState(4);
  const [fbTechRating, setFbTechRating] = useState<string>("4");
  const [fbCommRating, setFbCommRating] = useState<string>("4");
  const [fbRecommendation, setFbRecommendation] =
    useState<InterviewRecommendation>("hire");
  const [fbStrengths, setFbStrengths] = useState("");
  const [fbConcerns, setFbConcerns] = useState("");
  const [fbNotes, setFbNotes] = useState("");
  const [feedbackBusy, setFeedbackBusy] = useState(false);

  if (!allowed) {
    return (
      <AccessDenied
        kind="forbidden"
        detail="Required permission: interviews:read:all or interviews:feedback:assigned"
      />
    );
  }

  if (interviewsQuery.isError) {
    return errorToAccessScreen(interviewsQuery.error);
  }

  const data = interviewsQuery.data;
  const allInterviews = data?.interviews ?? [];
  const canManage = Boolean(data?.canManage);

  const counts = useMemo(() => {
    const upcoming = allInterviews.filter(
      (iv) => iv.status === "scheduled" || iv.status === "rescheduled",
    ).length;
    const needsScorecard = allInterviews.filter(
      (iv) =>
        iv.canSubmitFeedback &&
        !iv.myFeedback &&
        iv.status !== "cancelled" &&
        iv.status !== "no_show",
    ).length;
    const completed = allInterviews.filter((iv) => iv.status === "completed").length;
    const cancelled = allInterviews.filter(
      (iv) => iv.status === "cancelled" || iv.status === "no_show",
    ).length;
    return { upcoming, needsScorecard, completed, cancelled, total: allInterviews.length };
  }, [allInterviews]);

  const filteredInterviews = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allInterviews.filter((iv) => {
      if (
        activeTab === "upcoming" &&
        iv.status !== "scheduled" &&
        iv.status !== "rescheduled"
      ) {
        return false;
      }
      if (
        activeTab === "needs_scorecard" &&
        (!iv.canSubmitFeedback ||
          Boolean(iv.myFeedback) ||
          iv.status === "cancelled" ||
          iv.status === "no_show")
      ) {
        return false;
      }
      if (activeTab === "completed" && iv.status !== "completed") return false;
      if (
        activeTab === "cancelled" &&
        iv.status !== "cancelled" &&
        iv.status !== "no_show"
      ) {
        return false;
      }

      if (!q) return true;
      const haystack = [
        iv.candidateName,
        iv.candidateCode,
        iv.candidateEmail,
        iv.candidateDesignation ?? "",
        iv.round_name,
        ...iv.interviewers.map((p) => p.name),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [allInterviews, activeTab, search]);

  async function refreshAll() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["recruitment"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
    ]);
  }

  function openScheduleDialog() {
    const firstCand = data?.candidatesForScheduling[0]?.id ?? "";
    setSchedCandidateId(firstCand);
    setSchedRoundNumber(1);
    setSchedRoundName("Technical Round 1");
    setSchedMode("online");
    setSchedDate(todayIso());
    setSchedStartTime("11:00");
    setSchedEndTime("11:45");
    setSchedMeetingLink("");
    setSchedOfficeId(data?.officeLocations[0]?.id ?? "");
    setSchedLocationDetails("");
    setSchedInterviewerIds([]);
    setSchedInstructions("");
    setScheduleOpen(true);
  }

  function toggleInterviewer(
    list: string[],
    setter: (next: string[]) => void,
    id: string,
  ) {
    if (list.includes(id)) {
      setter(list.filter((x) => x !== id));
    } else {
      setter([...list, id]);
    }
  }

  async function handleScheduleSubmit() {
    try {
      setSchedulingBusy(true);
      await scheduleInterview({
        data: {
          candidateId: schedCandidateId,
          roundNumber: schedRoundNumber,
          roundName: schedRoundName,
          mode: schedMode,
          scheduledStartAt: buildIstIso(schedDate, schedStartTime),
          scheduledEndAt: buildIstIso(schedDate, schedEndTime),
          meetingLink: schedMode === "online" ? schedMeetingLink : null,
          officeLocationId: schedMode === "offline" ? schedOfficeId || null : null,
          locationDetails: schedLocationDetails || null,
          interviewerIds: schedInterviewerIds,
          instructions: schedInstructions || null,
        },
      });
      toast.success("Interview scheduled and panel notified.");
      setScheduleOpen(false);
      await refreshAll();
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setSchedulingBusy(false);
    }
  }

  function openRescheduleDialog(iv: (typeof allInterviews)[number]) {
    const start = toIstDateAndTime(iv.scheduled_start_at);
    const end = toIstDateAndTime(iv.scheduled_end_at);
    setRescheduleTargetId(iv.id);
    setReschedDate(start.date);
    setReschedStartTime(start.time);
    setReschedEndTime(end.time);
    setReschedMode((iv.mode as InterviewMode) || "online");
    setReschedMeetingLink(iv.meeting_link ?? "");
    setReschedOfficeId(iv.office_location_id ?? "");
    setReschedLocationDetails(iv.location_details ?? "");
    setReschedInterviewerIds([...(iv.interviewer_ids ?? [])]);
    setReschedReason("");
  }

  async function handleRescheduleSubmit() {
    if (!rescheduleTargetId) return;
    try {
      setLifecycleBusy(true);
      await updateInterviewLifecycle({
        data: {
          interviewId: rescheduleTargetId,
          action: "reschedule",
          scheduledStartAt: buildIstIso(reschedDate, reschedStartTime),
          scheduledEndAt: buildIstIso(reschedDate, reschedEndTime),
          mode: reschedMode,
          meetingLink: reschedMode === "online" ? reschedMeetingLink : null,
          officeLocationId: reschedMode === "offline" ? reschedOfficeId || null : null,
          locationDetails: reschedLocationDetails || null,
          interviewerIds: reschedInterviewerIds,
          reason: reschedReason || null,
        },
      });
      toast.success("Interview rescheduled in IST.");
      setRescheduleTargetId(null);
      await refreshAll();
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setLifecycleBusy(false);
    }
  }

  async function handleQuickComplete(interviewId: string) {
    try {
      setLifecycleBusy(true);
      await updateInterviewLifecycle({
        data: {
          interviewId,
          action: "complete",
        },
      });
      toast.success("Interview marked completed.");
      await refreshAll();
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setLifecycleBusy(false);
    }
  }

  async function handleCancelOrNoShowSubmit() {
    if (!cancelTarget) return;
    try {
      setLifecycleBusy(true);
      await updateInterviewLifecycle({
        data: {
          interviewId: cancelTarget.interviewId,
          action: cancelTarget.action,
          reason: cancelReason || null,
        },
      });
      toast.success(
        cancelTarget.action === "cancel"
          ? "Interview cancelled."
          : "Candidate marked as no-show.",
      );
      setCancelTarget(null);
      setCancelReason("");
      await refreshAll();
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setLifecycleBusy(false);
    }
  }

  function openScorecardDialog(iv: (typeof allInterviews)[number]) {
    setScorecardTarget({
      interviewId: iv.id,
      candidateName: iv.candidateName,
      roundName: iv.round_name,
    });
    if (iv.myFeedback) {
      setFbRating(iv.myFeedback.rating);
      setFbTechRating(
        iv.myFeedback.technical_rating != null
          ? String(iv.myFeedback.technical_rating)
          : "",
      );
      setFbCommRating(
        iv.myFeedback.communication_rating != null
          ? String(iv.myFeedback.communication_rating)
          : "",
      );
      setFbRecommendation(iv.myFeedback.recommendation as InterviewRecommendation);
      setFbStrengths(iv.myFeedback.strengths ?? "");
      setFbConcerns(iv.myFeedback.concerns ?? "");
      setFbNotes(iv.myFeedback.notes ?? "");
    } else {
      setFbRating(4);
      setFbTechRating("4");
      setFbCommRating("4");
      setFbRecommendation("hire");
      setFbStrengths("");
      setFbConcerns("");
      setFbNotes("");
    }
  }

  async function handleScorecardSubmit() {
    if (!scorecardTarget) return;
    try {
      setFeedbackBusy(true);
      await submitInterviewFeedback({
        data: {
          interviewId: scorecardTarget.interviewId,
          rating: fbRating,
          technicalRating: fbTechRating ? Number(fbTechRating) : null,
          communicationRating: fbCommRating ? Number(fbCommRating) : null,
          recommendation: fbRecommendation,
          strengths: fbStrengths || null,
          concerns: fbConcerns || null,
          notes: fbNotes || null,
        },
      });
      toast.success("Structured interview scorecard saved.");
      setScorecardTarget(null);
      await refreshAll();
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setFeedbackBusy(false);
    }
  }

  return (
    <AppShell
      title={
        data?.accessScope === "assigned"
          ? "Assigned Interviews"
          : "Interviews & Scorecards"
      }
      description="Coordinate interview rounds in Asia/Kolkata (IST), manage online links & office rooms, and record structured hiring scorecards."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => interviewsQuery.refetch()}
            disabled={interviewsQuery.isFetching}
          >
            <RefreshCw className="mr-1.5 size-3.5" />
            Refresh
          </Button>
          {canManage ? (
            <Button
              size="sm"
              onClick={openScheduleDialog}
              disabled={!data?.schemaReady}
            >
              <Plus className="mr-1.5 size-4" />
              Schedule Interview
            </Button>
          ) : null}
        </div>
      }
    >
      {data && !data.schemaReady ? (
        <Card className="mb-6 border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-start gap-3 pt-6">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
            <div className="space-y-1 text-sm">
              <p className="font-semibold text-foreground">
                Phase P2 Database Migration Pending Approval
              </p>
              <p className="text-muted-foreground">
                Interview scheduling and scorecard tables (
                <code className="text-xs">interviews</code>,{" "}
                <code className="text-xs">interview_feedback</code>) will become active
                once{" "}
                <code className="text-xs">
                  20261112000000_p2_recruitment_interviews_and_email_center.sql
                </code>{" "}
                is deployed.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {data?.accessScope === "assigned" ? (
        <div className="mb-5 flex items-center justify-between gap-3 rounded-lg border border-sky-500/30 bg-sky-500/5 px-4 py-2.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <UserCheck className="size-4 text-sky-600" />
            <span>
              <strong className="text-foreground">Assigned Interviewer View</strong> —
              Showing only interview rounds where you are assigned to the panel.
            </span>
          </div>
          <Badge variant="outline">IST (Asia/Kolkata)</Badge>
        </div>
      ) : !canManage ? (
        <div className="mb-5 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
          <span>
            <strong className="text-foreground">Read-Only Interview Oversight</strong> —
            Viewing organization-wide interview schedules and scorecards.
          </span>
          <Badge variant="outline">Read-Only</Badge>
        </div>
      ) : null}

      {/* Summary KPIs */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          {
            label: "Upcoming Rounds",
            value: counts.upcoming,
            icon: CalendarClock,
            detail: "Scheduled slots (IST)",
            iconColor: "text-muted-foreground",
          },
          {
            label: "Needs My Scorecard",
            value: counts.needsScorecard,
            icon: ClipboardCheck,
            detail: "Awaiting your evaluation",
            iconColor: "text-amber-600 dark:text-amber-400",
          },
          {
            label: "Completed Rounds",
            value: counts.completed,
            icon: CheckCircle2,
            detail: "Completed across pipeline",
            iconColor: "text-emerald-600 dark:text-emerald-400",
          },
          {
            label: "Cancelled / No-Show",
            value: counts.cancelled,
            icon: XCircle,
            detail: "Cancelled or non-attendance",
            iconColor: "text-rose-600 dark:text-rose-400",
          },
        ].map((item) => (
          <div
            key={item.label}
            className="flex flex-col justify-between rounded-lg border border-border bg-card p-3.5 shadow-xs"
          >
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="truncate text-[11px] font-semibold uppercase tracking-wider">
                {item.label}
              </span>
              <item.icon className={`size-4 shrink-0 ${item.iconColor}`} />
            </div>
            <div className="mt-2">
              <p className="font-mono text-2xl font-bold text-foreground">{item.value}</p>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{item.detail}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Filters & Search */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              { id: "upcoming", label: `Upcoming (${counts.upcoming})` },
              {
                id: "needs_scorecard",
                label: `Needs My Scorecard (${counts.needsScorecard})`,
              },
              { id: "completed", label: `Completed (${counts.completed})` },
              { id: "cancelled", label: `Cancelled / No-Show (${counts.cancelled})` },
              { id: "all", label: `All (${counts.total})` },
            ] as const
          ).map((t) => (
            <Button
              key={t.id}
              size="sm"
              aria-pressed={activeTab === t.id}
              variant={activeTab === t.id ? "default" : "outline"}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </Button>
          ))}
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Search interviews"
            placeholder="Search candidate, round, panel..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      {/* Interview List */}
      {interviewsQuery.isLoading ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Loading interviews...
          </CardContent>
        </Card>
      ) : filteredInterviews.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <CalendarClock className="size-8 text-muted-foreground/60" />
            <p className="mt-2 font-medium text-foreground">No interviews match this view</p>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              {canManage
                ? "Schedule a round with an online meeting link or an active office location."
                : "Assigned interviews will appear here automatically when HR schedules you on a panel."}
            </p>
            {canManage && (
              <Button
                size="sm"
                className="mt-4 gap-1.5"
                onClick={openScheduleDialog}
                disabled={!data?.schemaReady}
              >
                <Plus className="size-4" />
                Schedule Interview
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredInterviews.map((iv) => {
            const isActiveSlot =
              iv.status === "scheduled" || iv.status === "rescheduled";
            return (
              <Card key={iv.id} data-focus-id={iv.id}>
                <CardContent className="pt-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">Round {iv.round_number}</Badge>
                        <span className="font-semibold text-foreground">
                          {iv.round_name}
                        </span>
                        <Badge variant={interviewStatusVariant(iv.status)}>
                          {INTERVIEW_STATUS_LABELS[iv.status as InterviewStatus] ??
                            iv.status}
                        </Badge>
                        <Badge variant="outline">
                          {iv.mode === "online" ? (
                            <span className="inline-flex items-center gap-1">
                              <Video className="size-3" /> Online
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <Building2 className="size-3" /> Offline
                            </span>
                          )}
                        </Badge>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <Link
                          to="/candidates/$candidateId"
                          params={{ candidateId: iv.candidate_id }}
                          className="font-medium text-primary hover:underline"
                        >
                          {iv.candidateName} ({iv.candidateCode})
                        </Link>
                        {iv.candidateDesignation ? (
                          <span className="text-muted-foreground">
                            · {iv.candidateDesignation}
                          </span>
                        ) : null}
                        {iv.candidateDepartmentName ? (
                          <span className="text-muted-foreground">
                            · {iv.candidateDepartmentName}
                          </span>
                        ) : null}
                        <Badge variant="outline" className="text-[11px]">
                          Stage:{" "}
                          {CANDIDATE_STATUS_LABELS[
                            iv.candidateStatus as CandidateStatus
                          ] ?? iv.candidateStatus}
                        </Badge>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1 font-medium text-foreground">
                          <Clock className="size-3.5 text-muted-foreground" />
                          {iv.istDateLabel} · {iv.istTimeRangeLabel}
                        </span>

                        {iv.mode === "online" && iv.meeting_link ? (
                          <a
                            href={iv.meeting_link}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                          >
                            Join Meeting <ExternalLink className="size-3" />
                          </a>
                        ) : null}

                        {iv.mode === "offline" ? (
                          <span>
                            Location:{" "}
                            <strong className="text-foreground">
                              {iv.officeName ?? "In-Person"}
                            </strong>
                            {iv.location_details ? ` (${iv.location_details})` : ""}
                          </span>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs">
                        <span className="text-muted-foreground">Panel:</span>
                        {iv.interviewers.map((panelist) => (
                          <Badge
                            key={panelist.id}
                            variant={panelist.id === actor.userId ? "default" : "outline"}
                            className="text-[11px]"
                          >
                            {panelist.name}
                            {panelist.id === actor.userId ? " (You)" : ""}
                          </Badge>
                        ))}
                      </div>

                      {iv.instructions ? (
                        <p className="rounded-md bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                          <strong className="text-foreground">Instructions:</strong>{" "}
                          {iv.instructions}
                        </p>
                      ) : null}

                      {iv.cancel_or_reschedule_reason ? (
                        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-xs text-muted-foreground">
                          <strong className="text-foreground">Reason:</strong>{" "}
                          {iv.cancel_or_reschedule_reason}
                        </p>
                      ) : null}
                    </div>

                    {/* Right actions */}
                    <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                      {iv.canSubmitFeedback &&
                      iv.status !== "cancelled" &&
                      iv.status !== "no_show" ? (
                        <Button
                          size="sm"
                          variant={iv.myFeedback ? "outline" : "default"}
                          onClick={() => openScorecardDialog(iv)}
                        >
                          <Star className="mr-1.5 size-3.5" />
                          {iv.myFeedback ? "Update Scorecard" : "Submit Scorecard"}
                        </Button>
                      ) : null}

                      {canManage && isActiveSlot ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={lifecycleBusy}
                            onClick={() => openRescheduleDialog(iv)}
                          >
                            Reschedule
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={lifecycleBusy}
                            onClick={() =>
                              setCompleteTarget({
                                interviewId: iv.id,
                                candidateName: iv.candidateName,
                                roundName: iv.round_name,
                                scorecardCount: iv.feedbacks.length,
                              })
                            }
                          >
                            Mark Completed
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={lifecycleBusy}
                            onClick={() => {
                              setCancelTarget({
                                interviewId: iv.id,
                                candidateName: iv.candidateName,
                                roundName: iv.round_name,
                                action: "no_show",
                              });
                              setCancelReason("");
                            }}
                          >
                            No-Show
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={lifecycleBusy}
                            onClick={() => {
                              setCancelTarget({
                                interviewId: iv.id,
                                candidateName: iv.candidateName,
                                roundName: iv.round_name,
                                action: "cancel",
                              });
                              setCancelReason("");
                            }}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>

                  {/* Submitted Scorecards Section */}
                  {iv.feedbacks.length > 0 ? (
                    <div className="mt-4 border-t border-border pt-3">
                      <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                        Submitted Scorecards ({iv.feedbacks.length})
                      </p>
                      <div className="grid gap-2 md:grid-cols-2">
                        {iv.feedbacks.map((fb) => (
                          <div
                            key={fb.id}
                            className="rounded-lg border border-border/80 bg-muted/20 p-3 text-xs"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-semibold text-foreground">
                                {fb.interviewerName}
                              </span>
                              <div className="flex items-center gap-1.5">
                                <Badge variant="secondary">
                                  Overall {fb.rating}/5
                                </Badge>
                                <span
                                  className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${recommendationBadgeClass(
                                    fb.recommendation as InterviewRecommendation,
                                  )}`}
                                >
                                  {INTERVIEW_RECOMMENDATION_LABELS[
                                    fb.recommendation as InterviewRecommendation
                                  ] ?? fb.recommendation}
                                </span>
                              </div>
                            </div>
                            <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                              {fb.technical_rating != null ? (
                                <span>Technical: {fb.technical_rating}/5</span>
                              ) : null}
                              {fb.communication_rating != null ? (
                                <span>Communication: {fb.communication_rating}/5</span>
                              ) : null}
                            </div>
                            {fb.strengths ? (
                              <p className="mt-1.5 text-muted-foreground">
                                <strong className="text-foreground">Strengths:</strong>{" "}
                                {fb.strengths}
                              </p>
                            ) : null}
                            {fb.concerns ? (
                              <p className="mt-1 text-muted-foreground">
                                <strong className="text-foreground">Concerns:</strong>{" "}
                                {fb.concerns}
                              </p>
                            ) : null}
                            {fb.notes ? (
                              <p className="mt-1 text-muted-foreground">{fb.notes}</p>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Schedule Interview Dialog */}
      <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Schedule Interview Round</DialogTitle>
            <DialogDescription>
              All interview times are scheduled in{" "}
              <strong>Asia/Kolkata (IST)</strong> and stored in UTC. Assigned
              interviewers receive an immediate in-app notification.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="sched-candidate">Candidate</Label>
              <select
                id="sched-candidate"
                value={schedCandidateId}
                onChange={(e) => setSchedCandidateId(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              >
                <option value="">Select candidate...</option>
                {(data?.candidatesForScheduling ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.fullName} ({c.candidateCode}) — {c.designation ?? c.email}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="sched-round-no">Round #</Label>
                <Input
                  id="sched-round-no"
                  type="number"
                  min={1}
                  max={10}
                  value={schedRoundNumber}
                  onChange={(e) => setSchedRoundNumber(Number(e.target.value) || 1)}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="sched-round-name">Round Name</Label>
                <Input
                  id="sched-round-name"
                  value={schedRoundName}
                  onChange={(e) => setSchedRoundName(e.target.value)}
                  placeholder="e.g. Technical Round 1 / Culture Fit"
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="sched-date">Date (IST)</Label>
                <Input
                  id="sched-date"
                  type="date"
                  value={schedDate}
                  onChange={(e) => setSchedDate(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sched-start">Start Time (IST)</Label>
                <Input
                  id="sched-start"
                  type="time"
                  value={schedStartTime}
                  onChange={(e) => setSchedStartTime(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sched-end">End Time (IST)</Label>
                <Input
                  id="sched-end"
                  type="time"
                  value={schedEndTime}
                  onChange={(e) => setSchedEndTime(e.target.value)}
                />
              </div>
            </div>

            {(() => {
              const preview = buildIstSlotPreview(schedDate, schedStartTime, schedEndTime);
              if (!preview) return null;
              return (
                <div
                  role={preview.valid ? "status" : "alert"}
                  className={`rounded-md border px-3 py-2 text-xs ${
                    preview.valid
                      ? "border-info/40 bg-info/10 text-foreground"
                      : "border-destructive/40 bg-destructive/10 text-destructive"
                  }`}
                >
                  <span className="font-semibold">
                    {preview.valid ? "IST Slot: " : "Invalid Time Range: "}
                  </span>
                  {preview.message}
                </div>
              );
            })()}

            <div className="space-y-1.5">
              <Label>Interview Mode</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={schedMode === "online" ? "default" : "outline"}
                  onClick={() => setSchedMode("online")}
                >
                  <Video className="mr-1.5 size-3.5" />
                  Online (Video Link)
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={schedMode === "offline" ? "default" : "outline"}
                  onClick={() => setSchedMode("offline")}
                >
                  <Building2 className="mr-1.5 size-3.5" />
                  Offline (In-Office)
                </Button>
              </div>
            </div>

            {schedMode === "online" ? (
              <div className="space-y-1.5">
                <Label htmlFor="sched-link">Meeting Link</Label>
                <Input
                  id="sched-link"
                  type="url"
                  value={schedMeetingLink}
                  onChange={(e) => setSchedMeetingLink(e.target.value)}
                  placeholder="https://meet.google.com/... or Zoom/Teams URL"
                />
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="sched-office">Office Location</Label>
                  <select
                    id="sched-office"
                    value={schedOfficeId}
                    onChange={(e) => setSchedOfficeId(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                  >
                    <option value="">Select office...</option>
                    {(data?.officeLocations ?? []).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sched-room">Room / Floor Details</Label>
                  <Input
                    id="sched-room"
                    value={schedLocationDetails}
                    onChange={(e) => setSchedLocationDetails(e.target.value)}
                    placeholder="e.g. Floor 2, Boardroom A"
                  />
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label>
                Assign Panel Interviewers ({schedInterviewerIds.length} selected)
              </Label>
              <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-md border border-border p-2.5">
                {(data?.interviewerOptions ?? []).map((person) => {
                  const checked = schedInterviewerIds.includes(person.id);
                  return (
                    <label
                      key={person.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() =>
                          toggleInterviewer(
                            schedInterviewerIds,
                            setSchedInterviewerIds,
                            person.id,
                          )
                        }
                      />
                      <span className="font-medium text-foreground">
                        {person.fullName}
                      </span>
                      {person.designation ? (
                        <span className="text-muted-foreground">
                          · {person.designation}
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sched-instructions">
                Panel / Candidate Instructions (Optional)
              </Label>
              <Textarea
                id="sched-instructions"
                rows={2}
                value={schedInstructions}
                onChange={(e) => setSchedInstructions(e.target.value)}
                placeholder="Topics to assess, live coding link, or arrival instructions..."
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setScheduleOpen(false)}
              disabled={schedulingBusy}
            >
              Cancel
            </Button>
            <Button onClick={handleScheduleSubmit} disabled={schedulingBusy}>
              {schedulingBusy ? "Scheduling..." : "Schedule Interview"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reschedule Interview Dialog */}
      <Dialog
        open={Boolean(rescheduleTargetId)}
        onOpenChange={(open) => {
          if (!open) setRescheduleTargetId(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Reschedule Interview (IST)</DialogTitle>
            <DialogDescription>
              Update the IST slot, mode, or panel members. Assigned interviewers will be
              notified.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="resched-date">New Date (IST)</Label>
                <Input
                  id="resched-date"
                  type="date"
                  value={reschedDate}
                  onChange={(e) => setReschedDate(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="resched-start">Start (IST)</Label>
                <Input
                  id="resched-start"
                  type="time"
                  value={reschedStartTime}
                  onChange={(e) => setReschedStartTime(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="resched-end">End (IST)</Label>
                <Input
                  id="resched-end"
                  type="time"
                  value={reschedEndTime}
                  onChange={(e) => setReschedEndTime(e.target.value)}
                />
              </div>
            </div>

            {(() => {
              const preview = buildIstSlotPreview(reschedDate, reschedStartTime, reschedEndTime);
              if (!preview) return null;
              return (
                <div
                  role={preview.valid ? "status" : "alert"}
                  className={`rounded-md border px-3 py-2 text-xs ${
                    preview.valid
                      ? "border-info/40 bg-info/10 text-foreground"
                      : "border-destructive/40 bg-destructive/10 text-destructive"
                  }`}
                >
                  <span className="font-semibold">
                    {preview.valid ? "New IST Slot: " : "Invalid Time Range: "}
                  </span>
                  {preview.message}
                </div>
              );
            })()}

            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={reschedMode === "online" ? "default" : "outline"}
                onClick={() => setReschedMode("online")}
              >
                Online
              </Button>
              <Button
                type="button"
                size="sm"
                variant={reschedMode === "offline" ? "default" : "outline"}
                onClick={() => setReschedMode("offline")}
              >
                Offline
              </Button>
            </div>

            {reschedMode === "online" ? (
              <div className="space-y-1.5">
                <Label htmlFor="resched-link">Meeting Link</Label>
                <Input
                  id="resched-link"
                  value={reschedMeetingLink}
                  onChange={(e) => setReschedMeetingLink(e.target.value)}
                />
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="resched-office">Office Location</Label>
                  <select
                    id="resched-office"
                    value={reschedOfficeId}
                    onChange={(e) => setReschedOfficeId(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                  >
                    <option value="">Select office...</option>
                    {(data?.officeLocations ?? []).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="resched-room">Room / Details</Label>
                  <Input
                    id="resched-room"
                    value={reschedLocationDetails}
                    onChange={(e) => setReschedLocationDetails(e.target.value)}
                  />
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Panel Interviewers ({reschedInterviewerIds.length})</Label>
              <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                {(data?.interviewerOptions ?? []).map((person) => (
                  <label
                    key={person.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={reschedInterviewerIds.includes(person.id)}
                      onCheckedChange={() =>
                        toggleInterviewer(
                          reschedInterviewerIds,
                          setReschedInterviewerIds,
                          person.id,
                        )
                      }
                    />
                    <span>{person.fullName}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="resched-reason">Reschedule Reason</Label>
              <Input
                id="resched-reason"
                value={reschedReason}
                onChange={(e) => setReschedReason(e.target.value)}
                placeholder="e.g. Candidate requested evening slot"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRescheduleTargetId(null)}
              disabled={lifecycleBusy}
            >
              Close
            </Button>
            <Button onClick={handleRescheduleSubmit} disabled={lifecycleBusy}>
              {lifecycleBusy ? "Saving..." : "Confirm Reschedule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel / No-Show Dialog */}
      <Dialog
        open={Boolean(cancelTarget)}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {cancelTarget?.action === "cancel"
                ? "Cancel Interview Round"
                : "Record Candidate No-Show"}
            </DialogTitle>
            <DialogDescription>
              {cancelTarget?.candidateName} · {cancelTarget?.roundName}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-2">
            <Label htmlFor="cancel-reason">
              {cancelTarget?.action === "cancel"
                ? "Cancellation Reason (Required)"
                : "Notes (Optional)"}
            </Label>
            <Textarea
              id="cancel-reason"
              rows={3}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder={
                cancelTarget?.action === "cancel"
                  ? "Explain why this interview is being cancelled..."
                  : "e.g. Waited 15 minutes on link; candidate unreachable."
              }
            />
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCancelTarget(null)}
              disabled={lifecycleBusy}
            >
              Back
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancelOrNoShowSubmit}
              disabled={lifecycleBusy}
            >
              {lifecycleBusy
                ? "Saving..."
                : cancelTarget?.action === "cancel"
                  ? "Cancel Interview"
                  : "Confirm No-Show"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Structured Interview Scorecard Dialog */}
      <Dialog
        open={Boolean(scorecardTarget)}
        onOpenChange={(open) => {
          if (!open) setScorecardTarget(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Interview Evaluation Scorecard</DialogTitle>
            <DialogDescription>
              {scorecardTarget?.candidateName} · {scorecardTarget?.roundName}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="fb-overall">Overall (1–5)</Label>
                <select
                  id="fb-overall"
                  value={fbRating}
                  onChange={(e) => setFbRating(Number(e.target.value))}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                >
                  {[5, 4, 3, 2, 1].map((n) => (
                    <option key={n} value={n}>
                      {n} / 5
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="fb-tech">Technical (1–5)</Label>
                <select
                  id="fb-tech"
                  value={fbTechRating}
                  onChange={(e) => setFbTechRating(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                >
                  <option value="">N/A</option>
                  {[5, 4, 3, 2, 1].map((n) => (
                    <option key={n} value={String(n)}>
                      {n} / 5
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="fb-comm">Communication (1–5)</Label>
                <select
                  id="fb-comm"
                  value={fbCommRating}
                  onChange={(e) => setFbCommRating(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                >
                  <option value="">N/A</option>
                  {[5, 4, 3, 2, 1].map((n) => (
                    <option key={n} value={String(n)}>
                      {n} / 5
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Hiring Recommendation</Label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {INTERVIEW_RECOMMENDATIONS.map((rec) => (
                  <Button
                    key={rec}
                    type="button"
                    size="sm"
                    aria-pressed={fbRecommendation === rec}
                    variant={fbRecommendation === rec ? "default" : "outline"}
                    className="h-auto min-h-9 whitespace-normal py-1.5 text-center leading-tight"
                    onClick={() => setFbRecommendation(rec)}
                  >
                    {INTERVIEW_RECOMMENDATION_LABELS[rec]}
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="fb-strengths">Key Strengths</Label>
              <Textarea
                id="fb-strengths"
                rows={2}
                value={fbStrengths}
                onChange={(e) => setFbStrengths(e.target.value)}
                placeholder="Domain depth, clarity of thought, problem-solving..."
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="fb-concerns">Concerns / Gaps</Label>
              <Textarea
                id="fb-concerns"
                rows={2}
                value={fbConcerns}
                onChange={(e) => setFbConcerns(e.target.value)}
                placeholder="Areas needing follow-up or onboarding mentorship..."
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="fb-notes">Summary Notes for HR</Label>
              <Textarea
                id="fb-notes"
                rows={3}
                value={fbNotes}
                onChange={(e) => setFbNotes(e.target.value)}
                placeholder="Overall assessment and suggested role level..."
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setScorecardTarget(null)}
              disabled={feedbackBusy}
            >
              Cancel
            </Button>
            <Button onClick={handleScorecardSubmit} disabled={feedbackBusy}>
              {feedbackBusy ? "Submitting..." : "Save Scorecard"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mark Completed Confirmation Dialog */}
      <AlertDialog
        open={Boolean(completeTarget)}
        onOpenChange={(open) => {
          if (!open) setCompleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark Interview Round Completed?</AlertDialogTitle>
            <AlertDialogDescription>
              Marks <strong>{completeTarget?.roundName}</strong> for{" "}
              <strong>{completeTarget?.candidateName}</strong> as completed.
              {completeTarget?.scorecardCount === 0
                ? " Note: No interviewer scorecards have been submitted yet — panelists can still submit scorecards after completion."
                : ` (${completeTarget?.scorecardCount} scorecard(s) recorded.)`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={lifecycleBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={lifecycleBusy}
              onClick={() => {
                const targetId = completeTarget?.interviewId;
                setCompleteTarget(null);
                if (targetId) void handleQuickComplete(targetId);
              }}
            >
              Confirm Completed
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}
