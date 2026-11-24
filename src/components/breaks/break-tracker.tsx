import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { reconcileScheduledBreaks } from "@/lib/breaks.functions";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Coffee,
  Hourglass,
  Play,
  Sparkles,
  Utensils,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import {
  BREAK_CATEGORY_DISPLAY,
  evaluateBreakWindow,
  formatDurationHms,
  formatDurationHuman,
  formatOvertimeHms,
  formatTimeWithSecondsIst,
  type ValidBreakCategory,
} from "@/lib/breaks/break-management";
import {
  isAlarmMuted,
  startOvertimeAlarm,
  stopOvertimeAlarm,
  toggleAlarmMute,
} from "@/lib/breaks/audio-alarm";
import {
  cancelPersonalizedBreak,
  endBreak,
  requestPersonalizedBreak,
  startBreak,
} from "@/lib/daily.functions";

export type BreakLogItem = {
  id: string;
  category: string;
  started_at: string;
  ended_at: string | null;
  expected_end_at?: string | null;
  allowed_minutes?: number | null;
  overtime_seconds?: number | null;
  return_status?: string | null;
  note?: string | null;
  is_legacy?: boolean | null;
};

export type BreakRequestItem = {
  id: string;
  user_id: string;
  work_date: string;
  requested_minutes: number;
  reason: string;
  status: "pending" | "approved" | "rejected" | "consumed" | "cancelled";
  approved_minutes: number | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  consumed_break_id: string | null;
  created_at: string;
};

interface BreakTrackerProps {
  breaks: BreakLogItem[];
  breakRequests?: BreakRequestItem[];
  checkedIn: boolean;
  checkedOut: boolean;
  workDate: string;
  onRefresh: () => void | Promise<void>;
}

export function BreakTracker({
  breaks,
  breakRequests = [],
  checkedIn,
  checkedOut,
  workDate,
  onRefresh,
}: BreakTrackerProps) {
  // Live tick state updated every 1s for accurate live countdowns
  const [nowDate, setNowDate] = useState<Date>(() => new Date());
  const [busy, setBusy] = useState<string | null>(null);
  const [alarmMuted, setAlarmMuted] = useState<boolean>(() => isAlarmMuted());

  // Modal dialog state for requesting personalized break
  const [isRequestModalOpen, setIsRequestModalOpen] = useState<boolean>(false);
  const [customHours, setCustomHours] = useState<number>(0);
  const [customMinutes, setCustomMinutes] = useState<number>(30);
  const [customReason, setCustomReason] = useState<string>("");
  const [isHistoryExpanded, setIsHistoryExpanded] = useState<boolean>(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    const timer = setInterval(() => {
      setNowDate(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Find currently open break (if any)
  const openBreak = useMemo(() => {
    return breaks.find((b) => b.ended_at === null) ?? null;
  }, [breaks]);

  // Window evaluations for fixed breaks
  const lunchWindow = useMemo(() => {
    return evaluateBreakWindow("lunch", nowDate, workDate);
  }, [nowDate, workDate]);

  const shortBreakWindow = useMemo(() => {
    return evaluateBreakWindow("short_break", nowDate, workDate);
  }, [nowDate, workDate]);

  // Check if lunch or short break was already taken today
  const hasTakenLunchToday = useMemo(() => {
    return breaks.some((b) => b.category === "lunch" && b.is_legacy !== true);
  }, [breaks]);

  const hasTakenShortBreakToday = useMemo(() => {
    return breaks.some((b) => b.category === "short_break" && b.is_legacy !== true);
  }, [breaks]);

  // Proactively reconcile scheduled breaks when short break or lunch window is active
  useEffect(() => {
    if (shortBreakWindow.canStart && !hasTakenShortBreakToday && !openBreak && checkedIn && !checkedOut) {
      void reconcileScheduledBreaks().then((res) => {
        if (res?.activeBreak) {
          void queryClient.invalidateQueries({ queryKey: ["current-active-break"] });
          void onRefresh();
        }
      });
    }
  }, [shortBreakWindow.canStart, hasTakenShortBreakToday, openBreak, checkedIn, checkedOut, queryClient, onRefresh]);

  useEffect(() => {
    if (lunchWindow.canStart && !hasTakenLunchToday && !openBreak && checkedIn && !checkedOut) {
      void reconcileScheduledBreaks().then((res) => {
        if (res?.activeBreak) {
          void queryClient.invalidateQueries({ queryKey: ["current-active-break"] });
          void onRefresh();
        }
      });
    }
  }, [lunchWindow.canStart, hasTakenLunchToday, openBreak, checkedIn, checkedOut, queryClient, onRefresh]);

  // Latest personalized break request for today
  const latestPersonalRequest = useMemo(() => {
    const todayReqs = breakRequests.filter((r) => r.work_date === workDate);
    return todayReqs[0] ?? null;
  }, [breakRequests, workDate]);

  const hasApprovedPersonalRequest = useMemo(() => {
    return latestPersonalRequest?.status === "approved";
  }, [latestPersonalRequest]);

  // Active break countdown & overtime calculations
  const activeBreakStats = useMemo(() => {
    if (!openBreak) return null;
    const startMs = new Date(openBreak.started_at).getTime();
    const nowMs = nowDate.getTime();

    // Determine expected end
    let expectedMs: number;
    if (openBreak.expected_end_at) {
      expectedMs = new Date(openBreak.expected_end_at).getTime();
    } else if (openBreak.category === "lunch") {
      expectedMs = new Date(`${workDate}T14:30:00+05:30`).getTime();
    } else if (openBreak.category === "short_break") {
      expectedMs = new Date(`${workDate}T17:00:00+05:30`).getTime();
    } else {
      const allowedMins = openBreak.allowed_minutes || 15;
      expectedMs = startMs + allowedMins * 60_000;
    }

    const totalAllowedSeconds = Math.max(1, Math.round((expectedMs - startMs) / 1000));
    const elapsedSeconds = Math.max(0, Math.round((nowMs - startMs) / 1000));
    const isOvertime = nowMs > expectedMs;
    const remainingSeconds = isOvertime ? 0 : Math.max(0, Math.round((expectedMs - nowMs) / 1000));
    const overtimeSeconds = isOvertime ? Math.round((nowMs - expectedMs) / 1000) : 0;
    const progressPercent = Math.min(100, Math.round((elapsedSeconds / totalAllowedSeconds) * 100));

    return {
      startMs,
      expectedMs,
      isOvertime,
      remainingSeconds,
      overtimeSeconds,
      elapsedSeconds,
      progressPercent,
      expectedEndIso: new Date(expectedMs).toISOString(),
    };
  }, [openBreak, nowDate, workDate]);

  // Overtime audio alarm trigger & cleanup
  useEffect(() => {
    if (activeBreakStats?.isOvertime) {
      if (!alarmMuted) {
        startOvertimeAlarm();
      }
    } else {
      stopOvertimeAlarm();
    }
    return () => {
      stopOvertimeAlarm();
    };
  }, [activeBreakStats?.isOvertime, alarmMuted]);

  // Handlers
  async function handleStartFixedBreak(category: "lunch" | "short_break") {
    if (!checkedIn) {
      toast.error("You must check in before taking a break.");
      return;
    }
    if (checkedOut) {
      toast.error("Cannot take a break after checkout.");
      return;
    }
    setBusy(`start-${category}`);
    try {
      await startBreak({ data: { category } });
      toast.success(
        `${category === "lunch" ? "Lunch Break" : "Short Break"} started. Live timer running.`,
      );
      await onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start break.");
    } finally {
      setBusy(null);
    }
  }

  async function handleStartPersonalizedBreak() {
    if (!latestPersonalRequest || latestPersonalRequest.status !== "approved") {
      toast.error("Approved personalized break request not found.");
      return;
    }
    setBusy("start-personal");
    try {
      await startBreak({
        data: {
          category: "personal",
          requestId: latestPersonalRequest.id,
        },
      });
      toast.success("Personalized break started. Countdown running.");
      await onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start personalized break.");
    } finally {
      setBusy(null);
    }
  }

  async function handleEndBreak() {
    if (!openBreak) return;
    setBusy("end-break");
    try {
      stopOvertimeAlarm();
      const res = await endBreak({ data: { id: openBreak.id } });
      const b = (res as any)?.break;
      if (b?.return_status === "late_return" && b.overtime_seconds > 0) {
        toast.warning(
          `Break completed with ${formatDurationHuman(b.overtime_seconds)} overtime (Late Return).`,
        );
      } else {
        toast.success("Break completed on time. Welcome back!");
      }
      await onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to complete break.");
    } finally {
      setBusy(null);
    }
  }

  async function handleSubmitPersonalizedRequest() {
    const totalMinutes = customHours * 60 + customMinutes;
    if (totalMinutes <= 0) {
      toast.error("Please enter a duration greater than 0 minutes.");
      return;
    }
    if (!customReason.trim()) {
      toast.error("Please provide a reason for the personalized break.");
      return;
    }
    setBusy("request-personal");
    try {
      await requestPersonalizedBreak({
        data: {
          hours: customHours,
          minutes: customMinutes,
          reason: customReason,
        },
      });
      toast.success("Personalized break request submitted to HR for approval.");
      setIsRequestModalOpen(false);
      setCustomReason("");
      await onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to submit request.");
    } finally {
      setBusy(null);
    }
  }

  async function handleCancelRequest(requestId: string) {
    setBusy(`cancel-${requestId}`);
    try {
      await cancelPersonalizedBreak({ data: { requestId } });
      toast.success("Personalized break request cancelled.");
      await onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel request.");
    } finally {
      setBusy(null);
    }
  }

  function handleMuteToggle() {
    const muted = toggleAlarmMute();
    setAlarmMuted(muted);
    toast.info(muted ? "Overtime alarm muted." : "Overtime alarm sound enabled.");
  }

  const totalReqMinutes = customHours * 60 + customMinutes;

  return (
    <Card className="w-full border-border shadow-sm">
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-lg font-semibold tracking-tight">
              <Coffee className="size-5 text-primary" /> Daily Breaks
            </CardTitle>
            <CardDescription className="text-sm">
              Standardized daily schedule with server-authoritative timers and manual return confirmation.
            </CardDescription>
          </div>
          <Badge variant="outline" className="font-mono text-xs text-muted-foreground border-border/80">
            Asia/Kolkata (IST)
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* ============================================================== */}
        {/* DAILY BREAKS (Scheduled & Personalized)                        */}
        {/* ============================================================== */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Available Daily Breaks
            </h3>
            {openBreak && (
              <span className="text-xs text-amber-600 font-medium bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                Break in progress — Complete active break first
              </span>
            )}
          </div>

          <div
            className={`grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 ${
              openBreak ? "opacity-50 pointer-events-none" : ""
            }`}
          >
            {/* ------------------------------------------------------------ */}
            {/* CARD 1: LUNCH BREAK                                          */}
            {/* ------------------------------------------------------------ */}
            <div className="rounded-xl border border-border bg-card p-5 flex flex-col justify-between hover:border-border/80 hover:shadow-sm transition-all">
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-red-500/10 text-red-600 dark:bg-red-500/20">
                      <Utensils className="size-4" />
                    </div>
                    <div>
                      <h4 className="font-semibold text-base text-foreground leading-snug">
                        Lunch Break
                      </h4>
                      <p className="text-xs text-muted-foreground font-mono">
                        1:30 PM – 2:30 PM IST
                      </p>
                    </div>
                  </div>
                  {hasTakenLunchToday ? (
                    <Badge variant="outline" className="border-emerald-500/30 text-emerald-600 bg-emerald-500/5 text-xs font-medium">
                      Completed
                    </Badge>
                  ) : openBreak?.category === "lunch" ? (
                    <Badge variant="warning" className="text-xs font-medium animate-pulse">
                      Active
                    </Badge>
                  ) : !lunchWindow.canStart && lunchWindow.code === "after_window" ? (
                    <Badge variant="outline" className="text-xs text-muted-foreground">
                      Missed
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-primary/30 text-primary bg-primary/5 text-xs font-medium">
                      Scheduled
                    </Badge>
                  )}
                </div>

                <div className="space-y-1.5 text-xs">
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Standard duration:</span>
                    <span className="font-medium text-foreground">60 minutes max</span>
                  </div>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Return deadline:</span>
                    <span className="font-medium text-foreground">Fixed 2:30 PM IST</span>
                  </div>
                </div>

                {/* Helpful status indicator */}
                <div className="pt-2 border-t border-border/50 text-xs min-h-[38px] flex items-center">
                  {hasTakenLunchToday ? (
                    <span className="text-muted-foreground">Completed for today. Exactly 1 lunch allowed per day.</span>
                  ) : openBreak?.category === "lunch" ? (
                    <span className="text-primary font-medium flex items-center gap-1.5">
                      <Hourglass className="size-3.5 shrink-0" /> Full-screen timer active · End break to return.
                    </span>
                  ) : !lunchWindow.canStart ? (
                    <span className="text-muted-foreground flex items-center gap-1.5">
                      <Clock className="size-3.5 shrink-0" /> {lunchWindow.reason}
                    </span>
                  ) : (
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1.5">
                      <Hourglass className="size-3.5 shrink-0" /> Open now · {formatDurationHuman(lunchWindow.timeRemainingSeconds)} available
                    </span>
                  )}
                </div>
              </div>

              <div className="pt-4 mt-auto">
                <div className="rounded-lg border border-border/80 bg-muted/40 p-2.5 text-center text-xs">
                  {hasTakenLunchToday ? (
                    <span className="font-medium text-emerald-600 dark:text-emerald-400">
                      ✓ Lunch completed for today
                    </span>
                  ) : openBreak?.category === "lunch" ? (
                    <span className="font-semibold text-primary animate-pulse">
                      ● Active (Click End Break in timer)
                    </span>
                  ) : lunchWindow.canStart && checkedIn && !checkedOut ? (
                    <Button
                      size="sm"
                      className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold text-xs h-8"
                      onClick={async () => {
                        const res = await reconcileScheduledBreaks();
                        if (res?.activeBreak) {
                          await queryClient.invalidateQueries({ queryKey: ["current-active-break"] });
                          await onRefresh();
                        }
                      }}
                    >
                      Enter Full-Screen Lunch Break
                    </Button>
                  ) : (
                    <span className="text-muted-foreground">
                      Automatically starts at <strong className="text-foreground">1:30 PM IST</strong>
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* ------------------------------------------------------------ */}
            {/* CARD 2: SHORT BREAK                                          */}
            {/* ------------------------------------------------------------ */}
            <div className="rounded-xl border border-border bg-card p-5 flex flex-col justify-between hover:border-border/80 hover:shadow-sm transition-all">
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-neutral-500/10 text-foreground dark:bg-neutral-500/20">
                      <Coffee className="size-4" />
                    </div>
                    <div>
                      <h4 className="font-semibold text-base text-foreground leading-snug">
                        Short Break
                      </h4>
                      <p className="text-xs text-muted-foreground font-mono">
                        4:45 PM – 5:00 PM IST
                      </p>
                    </div>
                  </div>
                  {hasTakenShortBreakToday ? (
                    <Badge variant="outline" className="border-emerald-500/30 text-emerald-600 bg-emerald-500/5 text-xs font-medium">
                      Completed
                    </Badge>
                  ) : openBreak?.category === "short_break" ? (
                    <Badge variant="warning" className="text-xs font-medium animate-pulse">
                      Active
                    </Badge>
                  ) : !shortBreakWindow.canStart && shortBreakWindow.code === "after_window" ? (
                    <Badge variant="outline" className="text-xs text-muted-foreground">
                      Missed
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-primary/30 text-primary bg-primary/5 text-xs font-medium">
                      Scheduled
                    </Badge>
                  )}
                </div>

                <div className="space-y-1.5 text-xs">
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Standard duration:</span>
                    <span className="font-medium text-foreground">15 minutes max</span>
                  </div>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Return deadline:</span>
                    <span className="font-medium text-foreground">Fixed 5:00 PM IST</span>
                  </div>
                </div>

                {/* Helpful status indicator */}
                <div className="pt-2 border-t border-border/50 text-xs min-h-[38px] flex items-center">
                  {hasTakenShortBreakToday ? (
                    <span className="text-muted-foreground">Completed for today. Exactly 1 short break allowed per day.</span>
                  ) : openBreak?.category === "short_break" ? (
                    <span className="text-primary font-medium flex items-center gap-1.5">
                      <Hourglass className="size-3.5 shrink-0" /> Full-screen timer active · End break to return.
                    </span>
                  ) : !shortBreakWindow.canStart ? (
                    <span className="text-muted-foreground flex items-center gap-1.5">
                      <Clock className="size-3.5 shrink-0" /> {shortBreakWindow.reason}
                    </span>
                  ) : (
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1.5">
                      <Hourglass className="size-3.5 shrink-0" /> Open now · {formatDurationHuman(shortBreakWindow.timeRemainingSeconds)} available
                    </span>
                  )}
                </div>
              </div>

              <div className="pt-4 mt-auto">
                <div className="rounded-lg border border-border/80 bg-muted/40 p-2.5 text-center text-xs">
                  {hasTakenShortBreakToday ? (
                    <span className="font-medium text-emerald-600 dark:text-emerald-400">
                      ✓ Short break completed for today
                    </span>
                  ) : openBreak?.category === "short_break" ? (
                    <span className="font-semibold text-primary animate-pulse">
                      ● Active (Click End Break in timer)
                    </span>
                  ) : shortBreakWindow.canStart && checkedIn && !checkedOut ? (
                    <Button
                      size="sm"
                      className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold text-xs h-8"
                      onClick={async () => {
                        const res = await reconcileScheduledBreaks();
                        if (res?.activeBreak) {
                          await queryClient.invalidateQueries({ queryKey: ["current-active-break"] });
                          await onRefresh();
                        }
                      }}
                    >
                      Enter Full-Screen Short Break
                    </Button>
                  ) : (
                    <span className="text-muted-foreground">
                      Automatically starts at <strong className="text-foreground">4:45 PM IST</strong>
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* ------------------------------------------------------------ */}
            {/* CARD 3: PERSONALIZED BREAK                                   */}
            {/* ------------------------------------------------------------ */}
            <div className="rounded-xl border border-border bg-card p-5 flex flex-col justify-between hover:border-border/80 hover:shadow-sm transition-all">
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-amber-500/10 text-amber-600 dark:bg-amber-500/20">
                      <Sparkles className="size-4" />
                    </div>
                    <div>
                      <h4 className="font-semibold text-base text-foreground leading-snug">
                        Personalized Break
                      </h4>
                      <p className="text-xs text-muted-foreground">
                        Custom duration & reason
                      </p>
                    </div>
                  </div>
                  {latestPersonalRequest?.status === "pending" && (
                    <Badge variant="outline" className="border-amber-500/40 text-amber-600 bg-amber-500/10 text-xs">
                      Pending HR
                    </Badge>
                  )}
                  {latestPersonalRequest?.status === "approved" && (
                    <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 bg-emerald-500/10 text-xs font-semibold">
                      Approved ({latestPersonalRequest.approved_minutes}m)
                    </Badge>
                  )}
                  {latestPersonalRequest?.status === "rejected" && (
                    <Badge variant="outline" className="border-destructive/40 text-destructive bg-destructive/10 text-xs">
                      Rejected
                    </Badge>
                  )}
                </div>

                <div className="space-y-1.5 text-xs text-muted-foreground">
                  <p>Request a custom duration and reason. Requires prior review and approval by HR or Admin.</p>
                </div>

                {/* Helpful status indicator */}
                <div className="pt-2 border-t border-border/50 text-xs min-h-[38px] flex items-center">
                  {hasApprovedPersonalRequest ? (
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                      ✓ Ready to start · Approved for {latestPersonalRequest?.approved_minutes} mins.
                    </span>
                  ) : latestPersonalRequest?.status === "pending" ? (
                    <span className="text-amber-600 dark:text-amber-400">
                      Pending HR review for {latestPersonalRequest.requested_minutes} mins.
                    </span>
                  ) : latestPersonalRequest?.status === "rejected" ? (
                    <span className="text-destructive">
                      Rejected by HR{latestPersonalRequest.decision_note ? `: ${latestPersonalRequest.decision_note}` : ""}.
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      No active request. Submit a custom request to HR.
                    </span>
                  )}
                </div>
              </div>

              <div className="pt-4 mt-auto">
                {hasApprovedPersonalRequest ? (
                  <Button
                    type="button"
                    size="default"
                    disabled={!checkedIn || checkedOut || Boolean(openBreak) || busy === "start-personal"}
                    onClick={handleStartPersonalizedBreak}
                    className="w-full font-semibold h-10 bg-emerald-600 text-white hover:bg-emerald-700"
                  >
                    <Play className="mr-1.5 size-4" /> Start Personalized Break
                  </Button>
                ) : latestPersonalRequest?.status === "pending" ? (
                  <Button
                    type="button"
                    size="default"
                    variant="outline"
                    disabled={busy?.startsWith("cancel-")}
                    onClick={() => handleCancelRequest(latestPersonalRequest.id)}
                    className="w-full font-medium h-10 border-amber-500/30 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10"
                  >
                    Cancel Request
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="default"
                    variant="outline"
                    onClick={() => setIsRequestModalOpen(true)}
                    className="w-full font-semibold h-10"
                  >
                    Request Break
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ============================================================== */}
        {/* 3. COLLAPSIBLE TODAY'S BREAK LOG (Collapsed by default)        */}
        {/* ============================================================== */}
        <div className="pt-2 border-t border-border/60">
          <button
            type="button"
            onClick={() => setIsHistoryExpanded((prev) => !prev)}
            className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-muted/40 transition-colors text-left border border-border/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-expanded={isHistoryExpanded}
            aria-controls="break-history-panel"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-sm font-semibold text-foreground">
                Today&apos;s Break History
              </span>
              <Badge variant="secondary" className="text-xs px-2 py-0.5">
                {breaks.length}
              </Badge>
              {breaks.length > 0 && (
                <span className="hidden sm:inline text-xs text-muted-foreground">
                  ({breaks.filter((b) => b.return_status === "on_time").length} on time
                  {breaks.filter((b) => b.return_status === "late_return").length > 0
                    ? `, ${breaks.filter((b) => b.return_status === "late_return").length} late return`
                    : ""}
                  )
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
              <span>{isHistoryExpanded ? "Hide Details" : "View History"}</span>
              {isHistoryExpanded ? (
                <ChevronUp className="size-4 text-foreground" />
              ) : (
                <ChevronDown className="size-4 text-foreground" />
              )}
            </div>
          </button>

          {isHistoryExpanded && (
            <div id="break-history-panel" className="mt-3 space-y-2">
              {breaks.length === 0 ? (
                <div className="rounded-lg border border-border/60 bg-muted/20 p-6 text-center text-sm text-muted-foreground">
                  No breaks logged yet today.
                </div>
              ) : (
                <div className="rounded-lg border border-border/80 overflow-hidden shadow-sm">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-muted/50 border-b border-border/60 text-muted-foreground font-medium">
                        <tr>
                          <th className="py-2.5 px-3">Break Type</th>
                          <th className="py-2.5 px-3">Start Time</th>
                          <th className="py-2.5 px-3">End Time</th>
                          <th className="py-2.5 px-3">Duration</th>
                          <th className="py-2.5 px-3">Status</th>
                          <th className="py-2.5 px-3">Notes / Reason</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/50 bg-card">
                        {breaks.map((b) => {
                          const isOvertime = b.return_status === "late_return" && (b.overtime_seconds || 0) > 0;
                          const durationSeconds = b.ended_at
                            ? Math.max(0, Math.round((new Date(b.ended_at).getTime() - new Date(b.started_at).getTime()) / 1000))
                            : null;

                          return (
                            <tr key={b.id} className="hover:bg-muted/30 transition-colors">
                              <td className="py-2.5 px-3 font-medium text-foreground">
                                <div className="flex items-center gap-1.5">
                                  <span>{BREAK_CATEGORY_DISPLAY[b.category as ValidBreakCategory] || b.category.replace("_", " ")}</span>
                                  {b.is_legacy && (
                                    <Badge variant="outline" className="text-[10px] px-1 py-0 text-muted-foreground border-border">
                                      Legacy
                                    </Badge>
                                  )}
                                </div>
                              </td>
                              <td className="py-2.5 px-3 font-mono text-muted-foreground">
                                {formatTimeWithSecondsIst(b.started_at)}
                              </td>
                              <td className="py-2.5 px-3 font-mono text-muted-foreground">
                                {b.ended_at ? formatTimeWithSecondsIst(b.ended_at) : (
                                  <span className="text-primary font-semibold">Active now</span>
                                )}
                              </td>
                              <td className="py-2.5 px-3 font-medium text-foreground">
                                {durationSeconds !== null ? formatDurationHuman(durationSeconds) : "—"}
                              </td>
                              <td className="py-2.5 px-3">
                                {b.ended_at && !isOvertime && !b.is_legacy && (
                                  <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-500/30 bg-emerald-500/5">
                                    On Time
                                  </Badge>
                                )}
                                {isOvertime && (
                                  <Badge variant="destructive" className="text-[10px]">
                                    Late Return (+{formatDurationHuman(b.overtime_seconds!)})
                                  </Badge>
                                )}
                                {!b.ended_at && (
                                  <Badge variant="outline" className="text-[10px] border-primary/40 text-primary bg-primary/10">
                                    Running
                                  </Badge>
                                )}
                                {b.is_legacy && !isOvertime && (
                                  <span className="text-muted-foreground text-[11px]">—</span>
                                )}
                              </td>
                              <td className="py-2.5 px-3 text-muted-foreground italic max-w-xs truncate">
                                {b.note ? `“${b.note}”` : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>

      {/* ============================================================== */}
      {/* 4. CLEAN ACCESSIBLE DIALOG MODAL: REQUEST PERSONALIZED BREAK   */}
      {/* ============================================================== */}
      <Dialog open={isRequestModalOpen} onOpenChange={setIsRequestModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-5 text-amber-600" /> Request Personalized Break
            </DialogTitle>
            <DialogDescription>
              Submit a custom duration and reason for HR review. Once approved, your personalized break will become ready to start.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="modal-break-hours" className="text-xs font-medium">
                  Hours (0–4)
                </Label>
                <Input
                  id="modal-break-hours"
                  type="number"
                  min={0}
                  max={4}
                  value={customHours}
                  onChange={(e) => setCustomHours(Math.max(0, Math.min(4, parseInt(e.target.value) || 0)))}
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="modal-break-mins" className="text-xs font-medium">
                  Minutes (0–59)
                </Label>
                <Input
                  id="modal-break-mins"
                  type="number"
                  min={0}
                  max={59}
                  value={customMinutes}
                  onChange={(e) => setCustomMinutes(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                  className="h-9"
                />
              </div>
            </div>

            <div className="rounded-md bg-muted/40 p-2.5 text-xs flex items-center justify-between">
              <span className="text-muted-foreground">Total Requested Duration:</span>
              <span className={`font-semibold ${totalReqMinutes > 0 ? "text-foreground" : "text-destructive"}`}>
                {totalReqMinutes > 0 ? `${totalReqMinutes} minutes (${formatDurationHuman(totalReqMinutes * 60)})` : "Duration must be > 0"}
              </span>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="modal-break-reason" className="text-xs font-medium">
                Reason for Request <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="modal-break-reason"
                rows={3}
                placeholder="Explain the purpose of this break for HR review (e.g. Doctor appointment, bank visit, urgent family call)..."
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                className="resize-none text-sm"
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsRequestModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={totalReqMinutes <= 0 || !customReason.trim() || busy === "request-personal"}
              onClick={handleSubmitPersonalizedRequest}
            >
              {busy === "request-personal" ? "Submitting…" : "Submit for HR Approval"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
