import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlarmClock,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Coffee,
  LogIn,
  LogOut,
  MapPin,
  OctagonAlert,
  Plus,
  Send,
  Trash2,
} from "lucide-react";
import { DAY_SLOTS, slotKeyOf, slotRange, type DaySlot } from "@/lib/slots";
import { readBrowserPosition, requiresLocation } from "@/lib/geo";
import { requiresAllocationForCheckIn } from "@/lib/work-type";
import { AppShell } from "@/components/app-shell";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { useNotificationFocus } from "@/hooks/use-notification-focus";
import { errorToAccessScreen } from "@/components/access-denied";
import { ATTENDANCE_STATUS_LABELS } from "@/lib/daily.server";
import {
  ATTENDANCE_WORK_MODE_LABELS,
  BLOCKER_CATEGORY_LABELS,
  BLOCKER_SEVERITY_LABELS,
  BREAK_CATEGORY_LABELS,
  TASK_SLOT_TYPE_LABELS,
  optionsOf,
  type BlockerCategoryValue,
  type BlockerSeverityValue,
  type BreakCategoryValue,
  type TaskSlotTypeValue,
  type WorkModeValue,
} from "@/lib/enums";
import {
  checkIn,
  checkOut,
  deleteTaskEntry,
  endBreak,
  getMyDay,
  raiseBlocker,
  resolveBlocker,
  saveEodReport,
  saveTaskEntry,
  startBreak,
  submitTaskEntry,
} from "@/lib/daily.functions";
import { BreakTracker } from "@/components/breaks/break-tracker";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const Route = createFileRoute("/_authenticated/my-day")({
  head: () => ({
    meta: [
      { title: "My day | The AI School HRM" },
      {
        name: "description",
        content:
          "Check in, log hourly task entries against your project, record breaks and blockers, and submit your end-of-day report.",
      },
      { property: "og:title", content: "My day | The AI School HRM" },
      {
        property: "og:description",
        content: "Attendance, hourly tasks, breaks, blockers and the EOD report for today.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: MyDayPage,
  errorComponent: ({ error }) => errorToAccessScreen(error),
});

const WORK_MODES = optionsOf(ATTENDANCE_WORK_MODE_LABELS);
const BREAK_CATEGORIES = optionsOf(BREAK_CATEGORY_LABELS);
const BLOCKER_CATEGORIES = optionsOf(BLOCKER_CATEGORY_LABELS);
const BLOCKER_SEVERITIES = optionsOf(BLOCKER_SEVERITY_LABELS);
const SLOT_TYPES = optionsOf(TASK_SLOT_TYPE_LABELS);

const timeOf = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

const formatWorkDateIst = (workDateIso: string) =>
  new Date(`${workDateIso}T00:00:00+05:30`).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

function entryBadgeVariant(
  status: string,
): "success" | "info" | "warning" | "destructive" | "neutral" | "secondary" {
  if (status === "approved") return "success";
  if (status === "submitted") return "info";
  if (status === "revision_required") return "warning";
  if (status === "rejected") return "destructive";
  if (status === "draft") return "neutral";
  return "secondary";
}

function dayStatusBadgeVariant(
  status: string,
): "success" | "info" | "warning" | "destructive" | "secondary" {
  if (status === "present_complete") return "success";
  if (status === "present_in_progress") return "info";
  if (status === "absent") return "destructive";
  if (status === "present_incomplete") return "warning";
  return "secondary";
}

const hhmm = (minutes: number) =>
  `${Math.floor(minutes / 60)}h ${String(Math.round(minutes % 60)).padStart(2, "0")}m`;

function localInput(date: Date) {
  const off = date.getTimezoneOffset();
  return new Date(date.getTime() - off * 60_000).toISOString().slice(0, 16);
}

function MyDayPage() {
  const actor = useActor();
  const search = useSearch({ strict: false }) as {
    section?: string;
    date?: string;
    entryId?: string;
    breakRequestId?: string;
    eodId?: string;
    blockerId?: string;
  };
  useNotificationFocus(
    search.section ? `section-${search.section}` : null,
  );
  const isManagementRole = actor.roles.some(
    (r) => r === "manager" || r === "admin" || r === "super_admin" || r === "hr",
  );
  const queryClient = useQueryClient();
  const { data: day } = useSuspenseQuery({
    queryKey: ["my-day"],
    queryFn: () => getMyDay({ data: {} }),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [workMode, setWorkMode] = useState<WorkModeValue>("wfo");
  const [lateReason, setLateReason] = useState("");
  const [breakCategory, setBreakCategory] = useState<BreakCategoryValue>("short_break");
  const [entryForm, setEntryForm] = useState(() => ({
    allocationId: "",
    slotType: "flexible" as TaskSlotTypeValue,
    startedAt: "",
    endedAt: "",
    taskDescription: "",
    unitsCompleted: "0",
    unitsAssigned: "",
  }));
  type SlotDraft = {
    allocationId: string;
    assigned: string;
    completed: string;
    description: string;
  };
  const [slotDraft, setSlotDraft] = useState<Record<string, SlotDraft>>({});
  const [expandedSlot, setExpandedSlot] = useState<string | null>(null);
  const [showFlexible, setShowFlexible] = useState(false);
  const [blockerForm, setBlockerForm] = useState({
    allocationId: "",
    category: "data_quality" as BlockerCategoryValue,
    severity: "medium" as BlockerSeverityValue,
    description: "",
  });
  const [eodForm, setEodForm] = useState(() => ({
    highlights: day.eod?.highlights ?? "",
    challenges: day.eod?.challenges ?? "",
    tomorrowPlan: day.eod?.tomorrow_plan ?? "",
    supportNeeded: day.eod?.support_needed ?? "",
  }));
  const [eodErrors, setEodErrors] = useState<string[]>([]);
  const [checkoutConfirmOpen, setCheckoutConfirmOpen] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["my-day"] });

  async function run(key: string, fn: () => Promise<unknown>, success: string) {
    setBusy(key);
    try {
      await fn();
      if (key === "eod" || key === "eod-draft") {
        setEodErrors([]);
      }
      toast.success(success);
      await refresh();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error && "message" in error
            ? String((error as { message: unknown }).message)
            : "Something went wrong.";
      if (message.startsWith("EOD_INVALID::")) {
        const problems = JSON.parse(message.replace("EOD_INVALID::", "")) as string[];
        setEodErrors(problems);
        toast.error("EOD report not submitted", { description: problems.join(" ") });
      } else {
        toast.error(message);
      }
    } finally {
      setBusy(null);
    }
  }

  const openBreak = day.breaks.find((b) => !b.ended_at);
  const metrics = day.metrics;
  const achievement = day.achievement;
  const checkedIn = Boolean(day.day?.check_in_at);
  const checkedOut = Boolean(day.day?.check_out_at);
  const allocations = day.allocations;
  const hourly = day.hourlyLogging;
  const canLogHourly = hourly.eligible;
  /** Personal attendance never depends on annotation assignment for non-annotation staff. */
  const checkInFree = !requiresAllocationForCheckIn({ roles: actor.roles, workType: hourly.workType });
  const deviceInfo = () => ({
    user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    platform: typeof navigator !== "undefined" ? navigator.platform : null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  /** Saves one fixed hourly slot as its own task_entries row. */
  function saveSlot(
    slot: DaySlot,
    draft: { allocationId: string; assigned: string; completed: string; description: string },
    entryId: string | undefined,
    submit: boolean,
  ) {
    const { start, end } = slotRange(day.workDate, slot);
    return run(
      `slot-${slot.key}`,
      () =>
        saveTaskEntry({
          data: {
            id: entryId,
            allocationId: draft.allocationId,
            slotType: "fixed",
            startedAt: start.toISOString(),
            endedAt: end.toISOString(),
            taskDescription: draft.description,
            unitsCompleted: Number(draft.completed) || 0,
            unitsAssigned: draft.assigned === "" ? null : Number(draft.assigned),
            submit,
          },
        }),
      submit ? `${slot.label} submitted.` : `${slot.label} saved as draft.`,
    );
  }

  /** WFO check-in must prove the person is at a configured office. */
  async function doCheckIn() {
    let location: { latitude: number; longitude: number; accuracy?: number | null } | null = null;
    if (requiresLocation(workMode)) {
      setBusy("check-in");
      try {
        location = await readBrowserPosition();
      } catch (error) {
        setBusy(null);
        toast.error(error instanceof Error ? error.message : "Location unavailable.");
        return;
      }
    }
    await run(
      "check-in",
      () => checkIn({ data: { workMode, lateReason, device: deviceInfo(), location } }),
      "Checked in.",
    );
  }



  const submittedEntriesCount = day.entries.filter(
    (e) => e.status === "submitted" || e.status === "approved",
  ).length;
  const draftOrRevisionEntriesCount = day.entries.filter(
    (e) => e.status === "draft" || e.status === "revision_required",
  ).length;
  const openBlockersCount = day.blockers.filter((b) => b.status !== "resolved").length;
  const eodSubmitted = day.eod?.status === "submitted";

  return (
    <AppShell
      title="My day"
      description={`${formatWorkDateIst(day.workDate)} (IST) — attendance, hourly tasks, breaks, blockers and EOD.`}
      actions={
        <Badge variant={dayStatusBadgeVariant(day.status)}>
          {ATTENDANCE_STATUS_LABELS[day.status] ?? day.status}
        </Badge>
      }
      activeBreak={
        openBreak
          ? ({
              id: openBreak.id,
              category: openBreak.category,
              started_at: openBreak.started_at,
              expected_end_at: (openBreak as any).expected_end_at ?? null,
              allowed_minutes: (openBreak as any).allowed_minutes ?? 15,
              return_status: (openBreak as any).return_status ?? null,
              overtime_seconds: (openBreak as any).overtime_seconds ?? 0,
              break_request_id: (openBreak as any).break_request_id ?? null,
              note: openBreak.note,
              work_date: day.workDate,
            } as any)
          : null
      }
    >

      {/* 4-Step Daily Workflow Progress Strip */}
      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Daily workflow steps">
        {[
          {
            step: "1. Check In",
            done: checkedIn,
            detail: checkedIn ? `${timeOf(day.day!.check_in_at)} IST` : "Pending",
          },
          {
            step: "2. Log Hourly Tasks",
            done: submittedEntriesCount > 0,
            detail: `${submittedEntriesCount} submitted${draftOrRevisionEntriesCount > 0 ? ` · ${draftOrRevisionEntriesCount} draft/rev` : ""}`,
          },
          {
            step: "3. Submit EOD",
            done: eodSubmitted,
            detail: eodSubmitted ? "Submitted" : "Pending narrative",
          },
          {
            step: "4. Check Out",
            done: checkedOut,
            detail: checkedOut ? `${timeOf(day.day!.check_out_at)} IST` : "End of shift",
          },
        ].map((item) => (
          <div
            key={item.step}
            className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-xs ${
              item.done
                ? "border-success/35 bg-success/5 text-foreground"
                : "border-border bg-card text-muted-foreground"
            }`}
          >
            <CheckCircle2
              className={`size-4 shrink-0 ${item.done ? "text-success" : "text-muted-foreground/50"}`}
            />
            <div className="min-w-0">
              <p className="truncate font-semibold text-foreground">{item.step}</p>
              <p className="truncate text-[11px] text-muted-foreground">{item.detail}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-6">
        {/* 1. Daily Attendance & Hourly Activity Logging */}
        <div className="grid gap-5 lg:grid-cols-3">
          <Card
            data-focus-id="section-attendance"
            className={canLogHourly || day.entries.length > 0 ? "lg:col-span-1" : "lg:col-span-3"}
          >
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <AlarmClock className="size-4" /> Attendance
              </CardTitle>
              {(!canLogHourly && day.entries.length === 0) && (
                <Badge variant={dayStatusBadgeVariant(day.status)}>
                  {checkedOut ? "Shift Completed" : (ATTENDANCE_STATUS_LABELS[day.status] ?? day.status)}
                </Badge>
              )}
            </div>
            <CardDescription>
              {checkInFree
                ? "Personal workday attendance, hours and break tracking."
                : "Check-in is only open for assignments you have acknowledged."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {allocations.length === 0 && !checkInFree && (
              <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                No active, acknowledged assignment today — work logging is closed. Acknowledge an
                assignment on{" "}
                <Link to="/my-projects" className="font-medium underline underline-offset-2">
                  My assignments
                </Link>{" "}
                to unlock check-in.
              </p>
            )}
            {allocations.length === 0 && checkInFree && (
              <div className="rounded-md border border-dashed p-2.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Personal Attendance Mode:</span> Personal
                presence tracking. Project task targets are not required for personal check-in.
              </div>
            )}
            {!checkedIn ? (
              <div className="space-y-3 max-w-xl">
                <div className="space-y-1.5">
                  <Label htmlFor="work-mode">Work mode</Label>
                  <select
                    id="work-mode"
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={workMode}
                    onChange={(e) => setWorkMode(e.target.value as typeof workMode)}
                  >
                    {WORK_MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
                {requiresLocation(workMode) && (
                  <p className="flex gap-2 rounded-md border border-dashed p-2.5 text-xs text-muted-foreground">
                    <MapPin className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      Work from office checks your location. Your device will ask for permission
                      and you must be within the office radius. Other work modes do not need
                      location.
                    </span>
                  </p>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="late-reason">Late reason (if applicable)</Label>
                  <Input
                    id="late-reason"
                    value={lateReason}
                    onChange={(e) => setLateReason(e.target.value)}
                    placeholder="Optional"
                  />
                </div>
                <Button
                  className="w-full sm:w-auto font-medium"
                  disabled={busy === "check-in" || (allocations.length === 0 && !checkInFree)}
                  onClick={doCheckIn}
                >
                  <LogIn className="mr-1.5 size-4" /> Check in
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className={`grid gap-3 rounded-lg border border-border/70 bg-muted/20 p-3.5 text-xs ${canLogHourly || day.entries.length > 0 ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4"}`}>
                  <div>
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Checked In</span>
                    <p className="font-semibold text-sm text-foreground">{timeOf(day.day!.check_in_at)}</p>
                  </div>
                  <div>
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Checked Out</span>
                    <p className="font-semibold text-sm text-foreground">{checkedOut ? timeOf(day.day!.check_out_at) : "In progress"}</p>
                  </div>
                  <div>
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Attended</span>
                    <p className="font-semibold text-sm text-foreground">{metrics ? hhmm(metrics.workedMinutes) : "0h 00m"}</p>
                  </div>
                  <div>
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Required</span>
                    <p className="font-semibold text-sm text-foreground">{hhmm(day.day!.required_minutes ?? 0)}</p>
                  </div>
                  {metrics && (
                    <>
                      <div>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Breaks</span>
                        <p className="font-semibold text-sm text-foreground">{hhmm(metrics.breakMinutes)}</p>
                      </div>
                      <div>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Task Time</span>
                        <p className="font-semibold text-sm text-foreground">{hhmm(metrics.taskMinutes)}</p>
                      </div>
                      <div>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Blocked</span>
                        <p className="font-semibold text-sm text-foreground">{hhmm(metrics.blockerMinutes)}</p>
                      </div>
                      <div>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Uncovered</span>
                        <p className={`font-semibold text-sm ${metrics.uncoveredMinutes > 60 ? "text-destructive font-bold" : "text-foreground"}`}>
                          {hhmm(metrics.uncoveredMinutes)}
                        </p>
                      </div>
                    </>
                  )}
                </div>

                {checkedOut ? (
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-800 dark:text-emerald-300 flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <CheckCircle2 className="size-4 text-emerald-600 shrink-0" />
                      <span className="font-medium">Shift completed at {timeOf(day.day!.check_out_at)} IST</span>
                    </div>
                    <span className="font-semibold">{metrics ? hhmm(metrics.workedMinutes) : ""} attended</span>
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    className="w-full sm:w-auto font-semibold"
                    disabled={busy === "check-out"}
                    onClick={() => setCheckoutConfirmOpen(true)}
                  >
                    <LogOut className="mr-1.5 size-4" /> Check out
                  </Button>
                )}

                {(!canLogHourly && day.entries.length === 0) && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1.5 pt-1">
                    <span className="inline-block size-1.5 rounded-full bg-muted-foreground/60" />
                    Hourly production logging is only required for Annotation team members.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {(canLogHourly || day.entries.length > 0) && (
          <Card data-focus-id="section-tasks" className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Hourly annotation logs</CardTitle>
            <CardDescription>
              {!canLogHourly
                ? "Hourly production logging is limited to Annotation employees with an active, acknowledged annotation project allocation."
                : "One row per hour of the working day (9:00–6:00). Fill the slots you worked; breaks and blockers are logged separately. Approved slots lock."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!canLogHourly ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                <p className="font-medium text-foreground">
                  {hourly.workType === "annotation" || hourly.workType == null
                    ? "Hourly annotation logging unavailable"
                    : "No hourly annotation logging for your role"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{hourly.reason}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Your attendance and breaks are tracked above, and your end-of-day report is below.
                </p>
              </div>
            ) : (            <div className="overflow-hidden rounded-lg border">
              <div className="hidden grid-cols-[7.5rem_5.5rem_5.5rem_1fr_auto] gap-2 border-b bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground sm:grid">
                <span>Time slot</span>
                <span>Assigned</span>
                <span>Completed</span>
                <span>Status</span>
                <span />
              </div>
              {DAY_SLOTS.map((slot) => {
                const entry = day.entries.find(
                  (e) => slotKeyOf(e.started_at, e.ended_at) === slot.key,
                );
                const locked = entry?.status === "approved";
                const draft = slotDraft[slot.key] ?? {
                  allocationId: entry?.allocation_id ?? allocations[0]?.id ?? "",
                  assigned: entry?.units_assigned != null ? String(entry.units_assigned) : "",
                  completed: entry ? String(entry.units_completed) : "",
                  description: entry?.task_description ?? "",
                };
                const setDraft = (patch: Partial<typeof draft>) => {
                  setSlotDraft((prev) => ({ ...prev, [slot.key]: { ...draft, ...patch } }));
                  // Typing in the row opens its detail panel so the save
                  // buttons are always reachable from where you are working.
                  setExpandedSlot(slot.key);
                };
                const open = expandedSlot === slot.key;

                return (
                  <div key={slot.key} className="border-b last:border-b-0">
                    <div className="space-y-2 px-3 py-2.5 text-sm sm:grid sm:grid-cols-[7.5rem_5.5rem_5.5rem_1fr_auto] sm:items-center sm:gap-2 sm:space-y-0 sm:py-2">
                      <div className="flex items-center justify-between gap-2 sm:contents">
                        <span className="font-medium text-foreground">{slot.label}</span>
                        <div className="hidden min-w-0 sm:col-start-4 sm:row-start-1 sm:block">
                          {entry ? (
                            <Badge variant={entryBadgeVariant(entry.status)}>
                              {entry.status.replace("_", " ")}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">Not logged</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 sm:col-start-5 sm:row-start-1">
                          <span className="sm:hidden">
                            {entry ? (
                              <Badge variant={entryBadgeVariant(entry.status)}>
                                {entry.status.replace("_", " ")}
                              </Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">Not logged</span>
                            )}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-expanded={open}
                            aria-label={`Details for ${slot.label}`}
                            onClick={() => setExpandedSlot(open ? null : slot.key)}
                          >
                            {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                          </Button>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:contents">
                        <div className="space-y-1 sm:col-start-2 sm:row-start-1 sm:space-y-0">
                          <span className="block text-[11px] text-muted-foreground sm:sr-only">
                            Assigned
                          </span>
                          <Input
                            aria-label={`Tasks assigned ${slot.label}`}
                            className="h-8"
                            type="number"
                            min={0}
                            disabled={locked || !checkedIn}
                            value={draft.assigned}
                            onChange={(e) => setDraft({ assigned: e.target.value })}
                          />
                        </div>
                        <div className="space-y-1 sm:col-start-3 sm:row-start-1 sm:space-y-0">
                          <span className="block text-[11px] text-muted-foreground sm:sr-only">
                            Completed
                          </span>
                          <Input
                            aria-label={`Tasks completed ${slot.label}`}
                            className="h-8"
                            type="number"
                            min={0}
                            disabled={locked || !checkedIn}
                            value={draft.completed}
                            onChange={(e) => setDraft({ completed: e.target.value })}
                          />
                        </div>
                      </div>
                    </div>

                    {!open &&
                      entry?.review_note &&
                      (entry.status === "revision_required" || entry.status === "reviewed") && (
                        <div className="border-t border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-foreground">
                          <strong className="text-warning">Reviewer note:</strong>{" "}
                          {entry.review_note}
                        </div>
                      )}

                    {open && (
                      <div className="grid gap-3 border-t bg-muted/30 px-3 py-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label htmlFor={`slot-alloc-${slot.key}`}>Project</Label>
                          <select
                            id={`slot-alloc-${slot.key}`}
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                            disabled={locked}
                            value={draft.allocationId}
                            onChange={(e) => setDraft({ allocationId: e.target.value })}
                          >
                            <option value="">Select assignment</option>
                            {allocations.map((a) => {
                              const p = a.projects as { code?: string; name?: string } | null;
                              return (
                                <option key={a.id} value={a.id}>
                                  {p?.code} — {p?.name}
                                </option>
                              );
                            })}
                          </select>
                        </div>
                        <div className="space-y-1.5 sm:col-span-2">
                          <Label htmlFor={`slot-desc-${slot.key}`}>
                            What did you work on in this hour?
                          </Label>
                          <Textarea
                            id={`slot-desc-${slot.key}`}
                            rows={2}
                            disabled={locked}
                            value={draft.description}
                            onChange={(e) => setDraft({ description: e.target.value })}
                          />
                        </div>
                        {entry?.review_note ? (
                          <p className="text-sm text-muted-foreground sm:col-span-2">
                            Reviewer note: {entry.review_note}
                          </p>
                        ) : null}
                        <div className="flex flex-wrap gap-2 sm:col-span-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={locked || !checkedIn || busy === `slot-${slot.key}`}
                            onClick={() => saveSlot(slot, draft, entry?.id, false)}
                          >
                            Save draft
                          </Button>
                          <Button
                            size="sm"
                            disabled={locked || !checkedIn || busy === `slot-${slot.key}`}
                            onClick={() => saveSlot(slot, draft, entry?.id, true)}
                          >
                            <Send className="size-4" /> Submit slot
                          </Button>
                          {entry && (entry.status === "draft" || entry.status === "revision_required") && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                run("delete", () => deleteTaskEntry({ data: { id: entry.id } }), "Deleted.")
                              }
                            >
                              <Trash2 className="size-4" /> Clear slot
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            )}

            {canLogHourly && (
            <div className="rounded-lg border">
              <button
                type="button"
                aria-expanded={showFlexible}
                className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
                onClick={() => setShowFlexible((v) => !v)}
              >
                <span>Advanced: flexible range entry</span>
                {showFlexible ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
              </button>
              {showFlexible && (
                <div className="grid gap-3 border-t p-3 sm:grid-cols-2">
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    For work that genuinely does not fit a fixed hour. Overlaps with a logged
                    slot are rejected.
                  </p>
                  <div className="space-y-1.5 sm:col-span-1">
                    <Label htmlFor="entry-alloc">Project</Label>
                    <select
                      id="entry-alloc"
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                      value={entryForm.allocationId}
                      onChange={(e) => setEntryForm({ ...entryForm, allocationId: e.target.value })}
                    >
                      <option value="">Select assignment</option>
                      {allocations.map((a) => {
                        const p = a.projects as { code?: string; name?: string } | null;
                        return (
                          <option key={a.id} value={a.id}>
                            {p?.code} — {p?.name}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="entry-slot">Slot type</Label>
                    <select
                      id="entry-slot"
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                      value={entryForm.slotType}
                      onChange={(e) =>
                        setEntryForm({ ...entryForm, slotType: e.target.value as TaskSlotTypeValue })
                      }
                    >
                      {SLOT_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="entry-start">Start</Label>
                    <Input
                      id="entry-start"
                      type="datetime-local"
                      value={entryForm.startedAt || localInput(new Date())}
                      onChange={(e) => setEntryForm({ ...entryForm, startedAt: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="entry-end">End</Label>
                    <Input
                      id="entry-end"
                      type="datetime-local"
                      value={entryForm.endedAt || localInput(new Date())}
                      onChange={(e) => setEntryForm({ ...entryForm, endedAt: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="entry-desc">What did you work on?</Label>
                    <Textarea
                      id="entry-desc"
                      rows={2}
                      value={entryForm.taskDescription}
                      onChange={(e) => setEntryForm({ ...entryForm, taskDescription: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="entry-assigned">Tasks assigned</Label>
                    <Input
                      id="entry-assigned"
                      type="number"
                      min={0}
                      value={entryForm.unitsAssigned}
                      onChange={(e) => setEntryForm({ ...entryForm, unitsAssigned: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="entry-units">Tasks completed</Label>
                    <Input
                      id="entry-units"
                      type="number"
                      min={0}
                      value={entryForm.unitsCompleted}
                      onChange={(e) => setEntryForm({ ...entryForm, unitsCompleted: e.target.value })}
                    />
                  </div>
                  <div className="flex items-end gap-2 sm:col-span-2">
                    <Button
                      disabled={busy === "entry" || !checkedIn}
                      onClick={() =>
                        run(
                          "entry",
                          () =>
                            saveTaskEntry({
                              data: {
                                allocationId: entryForm.allocationId,
                                slotType: entryForm.slotType,
                                startedAt: new Date(
                                  entryForm.startedAt || localInput(new Date()),
                                ).toISOString(),
                                endedAt: new Date(
                                  entryForm.endedAt || localInput(new Date()),
                                ).toISOString(),
                                taskDescription: entryForm.taskDescription,
                                unitsCompleted: Number(entryForm.unitsCompleted) || 0,
                                unitsAssigned:
                                  entryForm.unitsAssigned === ""
                                    ? null
                                    : Number(entryForm.unitsAssigned),
                                submit: true,
                              },
                            }).then(() =>
                              setEntryForm({
                                ...entryForm,
                                taskDescription: "",
                                unitsCompleted: "0",
                                unitsAssigned: "",
                              }),
                            ),
                          "Task entry submitted.",
                        )
                      }
                    >
                      <Plus className="size-4" /> Add & submit
                    </Button>
                  </div>
                </div>
              )}
            </div>
            )}

            {(canLogHourly || day.entries.length > 0) && (
            <div className="space-y-2">
              {day.entries.length === 0 && (
                <p className="text-sm text-muted-foreground">No entries logged yet today.</p>
              )}
              {day.entries.map((entry) => {
                const project = entry.projects as { code?: string; task_unit?: string } | null;
                return (
                  <div
                    key={entry.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="font-medium">
                        {timeOf(entry.started_at)}–{timeOf(entry.ended_at)} · {project?.code}
                      </p>
                      <p className="truncate text-muted-foreground">{entry.task_description}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-muted-foreground">
                        {entry.units_assigned != null ? `${entry.units_assigned} assigned · ` : ""}
                        {entry.units_completed} {project?.task_unit ?? "units"}
                      </span>
                      <Badge variant={entryBadgeVariant(entry.status)}>
                        {entry.status.replace("_", " ")}
                      </Badge>
                      {entry.status === "draft" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Submit task entry ${timeOf(entry.started_at)}`}
                          onClick={() =>
                            run("submit", () => submitTaskEntry({ data: { id: entry.id } }), "Submitted.")
                          }
                        >
                          <Send className="size-4" />
                        </Button>
                      )}
                      {(entry.status === "draft" || entry.status === "revision_required") && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Delete task entry ${timeOf(entry.started_at)}`}
                          onClick={() =>
                            run("delete", () => deleteTaskEntry({ data: { id: entry.id } }), "Deleted.")
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            )}

            {achievement && (
              <div className="grid gap-3 rounded-lg border bg-muted/40 p-3 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-muted-foreground">Units today</p>
                  <p className="text-lg font-semibold">{achievement.unitsCompleted}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">
                    Daily target {achievement.dailyTarget ?? "—"}
                  </p>
                  <p className="text-lg font-semibold">
                    {achievement.dailyAchievementPct != null
                      ? `${achievement.dailyAchievementPct}%`
                      : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">
                    Pace vs {achievement.hourlyTarget ?? "—"}/hr
                  </p>
                  <p className="text-lg font-semibold">
                    {achievement.paceAchievementPct != null
                      ? `${achievement.paceAchievementPct}%`
                      : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Expected for {achievement.taskHours}h</p>
                  <p className="text-lg font-semibold">
                    {achievement.expectedForHoursWorked ?? "—"}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        )}
      </div>

      {/* 2. Daily Breaks Section — Full Width Approved Component */}
      <div data-focus-id="section-breaks">
        <BreakTracker
          breaks={day.breaks as any}
          breakRequests={(day as any).breakRequests ?? []}
          checkedIn={checkedIn}
          checkedOut={checkedOut}
          workDate={day.workDate}
          onRefresh={refresh}
        />
      </div>

      {/* 3. Blockers Section */}
      <Card data-focus-id="section-blockers" className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <OctagonAlert className="size-4" /> Blockers
          </CardTitle>
          <CardDescription>
            Raising a blocker notifies the reporting lead recorded on that allocation.
          </CardDescription>
        </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="blocker-alloc" className="text-xs">
                  Assignment
                </Label>
                <select
                  id="blocker-alloc"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={blockerForm.allocationId}
                  onChange={(e) => setBlockerForm({ ...blockerForm, allocationId: e.target.value })}
                >
                  <option value="">Primary assignment</option>
                  {allocations.map((a) => {
                    const p = a.projects as { code?: string } | null;
                    return (
                      <option key={a.id} value={a.id}>
                        {p?.code}
                      </option>
                    );
                  })}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="blocker-category" className="text-xs">
                  Category
                </Label>
                <select
                  id="blocker-category"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={blockerForm.category}
                  onChange={(e) =>
                    setBlockerForm({ ...blockerForm, category: e.target.value as BlockerCategoryValue })
                  }
                >
                  {BLOCKER_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="blocker-severity" className="text-xs">
                  Severity
                </Label>
                <select
                  id="blocker-severity"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={blockerForm.severity}
                  onChange={(e) =>
                    setBlockerForm({ ...blockerForm, severity: e.target.value as BlockerSeverityValue })
                  }
                >
                  {BLOCKER_SEVERITIES.map((sv) => (
                    <option key={sv.value} value={sv.value}>
                      {sv.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="blocker-desc" className="text-xs">
                Blocker details
              </Label>
              <Textarea
                id="blocker-desc"
                rows={2}
                placeholder="What is blocking you?"
                value={blockerForm.description}
                onChange={(e) => setBlockerForm({ ...blockerForm, description: e.target.value })}
              />
            </div>
            <Button
              disabled={busy === "blocker" || !checkedIn}
              onClick={() =>
                run(
                  "blocker",
                  () =>
                    raiseBlocker({
                      data: {
                        allocationId: blockerForm.allocationId || null,
                        category: blockerForm.category,
                        severity: blockerForm.severity,
                        description: blockerForm.description,
                      },
                    }).then(() => setBlockerForm({ ...blockerForm, description: "" })),
                  "Blocker raised and your lead was notified.",
                )
              }
            >
              Raise blocker
            </Button>
            <div className="space-y-2">
              {day.blockers.map((b) => {
                const lead = b.profiles as { full_name?: string } | null;
                return (
                  <div
                    key={b.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <div>
                      <p className="font-medium">
                        {b.category.replace("_", " ")} · {b.severity}
                      </p>
                      <p className="text-muted-foreground">{b.description}</p>
                      <p className="text-xs text-muted-foreground">
                        Notified: {lead?.full_name ?? "no lead on record"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={b.status === "resolved" ? "success" : "warning"}>
                        {b.status}
                      </Badge>
                      {b.status !== "resolved" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            run("resolve", () => resolveBlocker({ data: { id: b.id } }), "Resolved.")
                          }
                        >
                          Resolve
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

      {/* 4. End of Day Report */}
      <Card data-focus-id="section-eod" className="w-full">
          <CardHeader>
            <CardTitle className="text-base">End-of-day report</CardTitle>
            <CardDescription>
              Attendance and task figures are pulled from today's real records; you add the narrative.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Today's Rollup Summary Bar */}
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs sm:grid-cols-5">
              <div>
                <p className="text-muted-foreground">Attended</p>
                <p className="font-mono text-sm font-semibold text-foreground">
                  {metrics ? hhmm(metrics.workedMinutes) : "0h 00m"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Task Time</p>
                <p className="font-mono text-sm font-semibold text-foreground">
                  {metrics ? hhmm(metrics.taskMinutes) : "0h 00m"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Submitted Slots</p>
                <p className="font-mono text-sm font-semibold text-foreground">
                  {submittedEntriesCount}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Units Completed</p>
                <p className="font-mono text-sm font-semibold text-foreground">
                  {achievement?.unitsCompleted ?? 0}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Open Blockers</p>
                <p
                  className={`font-mono text-sm font-semibold ${
                    openBlockersCount > 0 ? "text-warning" : "text-foreground"
                  }`}
                >
                  {openBlockersCount}
                </p>
              </div>
            </div>

            {eodErrors.length > 0 && (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
              >
                <p className="font-semibold">Please resolve before submitting EOD:</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {eodErrors.map((err) => (
                    <li key={err}>{err}</li>
                  ))}
                </ul>
              </div>
            )}

            {day.eod?.status === "submitted" ? (
              <p className="rounded-md border border-success/30 bg-success/10 p-3 text-sm text-foreground">
                Submitted at {timeOf(day.eod.submitted_at)} IST. {day.eod.highlights}
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="eod-highlights">What you completed</Label>
                <Textarea
                  id="eod-highlights"
                  rows={3}
                  value={eodForm.highlights}
                  onChange={(e) => setEodForm({ ...eodForm, highlights: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="eod-plan">Plan for tomorrow</Label>
                <Textarea
                  id="eod-plan"
                  rows={3}
                  value={eodForm.tomorrowPlan}
                  onChange={(e) => setEodForm({ ...eodForm, tomorrowPlan: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="eod-challenges">Challenges</Label>
                <Textarea
                  id="eod-challenges"
                  rows={2}
                  value={eodForm.challenges}
                  onChange={(e) => setEodForm({ ...eodForm, challenges: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="eod-support">Support needed</Label>
                <Textarea
                  id="eod-support"
                  rows={2}
                  value={eodForm.supportNeeded}
                  onChange={(e) => setEodForm({ ...eodForm, supportNeeded: e.target.value })}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={busy === "eod-draft"}
                onClick={() =>
                  run(
                    "eod-draft",
                    () => saveEodReport({ data: { ...eodForm, submit: false } }),
                    "Draft saved.",
                  )
                }
              >
                Save draft
              </Button>
              <Button
                disabled={busy === "eod"}
                onClick={() =>
                  run("eod", () => saveEodReport({ data: { ...eodForm, submit: true } }), "EOD submitted.")
                }
              >
                <Send className="size-4" /> Submit EOD
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Check-Out Confirmation Dialog */}
      <AlertDialog open={checkoutConfirmOpen} onOpenChange={setCheckoutConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm End-of-Shift Check Out?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  Records your official shift check-out time in IST for{" "}
                  <strong className="text-foreground">{formatWorkDateIst(day.workDate)}</strong>.
                </p>
                {(openBreak || draftOrRevisionEntriesCount > 0 || !eodSubmitted) && (
                  <ul className="list-disc space-y-1 rounded-md border border-warning/40 bg-warning/10 p-3 pl-7 text-xs text-foreground">
                    {openBreak && (
                      <li>
                        You currently have an <strong>active break</strong> running — consider
                        ending it before checking out.
                      </li>
                    )}
                    {draftOrRevisionEntriesCount > 0 && (
                      <li>
                        You have <strong>{draftOrRevisionEntriesCount}</strong> unsubmitted draft or
                        revision-required task slot(s).
                      </li>
                    )}
                    {!eodSubmitted && (
                      <li>
                        Your <strong>End-of-Day (EOD) report</strong> has not been submitted yet.
                      </li>
                    )}
                  </ul>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "check-out"}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === "check-out"}
              onClick={() => {
                setCheckoutConfirmOpen(false);
                void run(
                  "check-out",
                  () => checkOut({ data: { device: deviceInfo() } }),
                  "Checked out.",
                );
              }}
            >
              Confirm Check Out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}