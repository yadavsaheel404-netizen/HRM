import { createFileRoute, Link } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlarmClock,
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
import { AppShell } from "@/components/app-shell";
import { actorQueryOptions } from "@/hooks/use-actor";
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
  iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";

const hhmm = (minutes: number) =>
  `${Math.floor(minutes / 60)}h ${String(Math.round(minutes % 60)).padStart(2, "0")}m`;

function localInput(date: Date) {
  const off = date.getTimezoneOffset();
  return new Date(date.getTime() - off * 60_000).toISOString().slice(0, 16);
}

function MyDayPage() {
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
  const [eodForm, setEodForm] = useState({
    highlights: "",
    challenges: "",
    tomorrowPlan: "",
    supportNeeded: "",
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["my-day"] });

  async function run(key: string, fn: () => Promise<unknown>, success: string) {
    setBusy(key);
    try {
      await fn();
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



  return (
    <AppShell
      title="My day"
      description={`${new Date(day.workDate).toDateString()} — attendance, hourly tasks, breaks, blockers and EOD.`}
      actions={
        <Badge variant={day.status === "present_complete" ? "default" : "secondary"}>
          {ATTENDANCE_STATUS_LABELS[day.status] ?? day.status}
        </Badge>
      }
    >
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlarmClock className="size-4" /> Attendance
            </CardTitle>
            <CardDescription>
              Check-in is only open for assignments you have acknowledged.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {allocations.length === 0 && (
              <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                No active, acknowledged assignment today — work logging is closed. Acknowledge an
                assignment on{" "}
                <Link to="/my-projects" className="font-medium underline underline-offset-2">
                  My assignments
                </Link>{" "}
                to unlock check-in.
              </p>
            )}
            {!checkedIn ? (
              <div className="space-y-3">
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
                  className="w-full"
                  disabled={busy === "check-in" || allocations.length === 0}
                  onClick={doCheckIn}
                >
                  <LogIn className="size-4" /> Check in
                </Button>
              </div>
            ) : (
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Checked in</span>
                  <span className="font-medium">{timeOf(day.day!.check_in_at)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Checked out</span>
                  <span className="font-medium">{timeOf(day.day!.check_out_at)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Required</span>
                  <span className="font-medium">{hhmm(day.day!.required_minutes ?? 0)}</span>
                </div>
                {metrics && (
                  <>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Attended</span>
                      <span className="font-medium">{hhmm(metrics.workedMinutes)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Task time</span>
                      <span className="font-medium">{hhmm(metrics.taskMinutes)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Breaks</span>
                      <span className="font-medium">{hhmm(metrics.breakMinutes)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Blocked</span>
                      <span className="font-medium">{hhmm(metrics.blockerMinutes)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Uncovered</span>
                      <span
                        className={
                          metrics.uncoveredMinutes > 60 ? "font-semibold text-destructive" : "font-medium"
                        }
                      >
                        {hhmm(metrics.uncoveredMinutes)}
                      </span>
                    </div>
                  </>
                )}
                {!checkedOut && (
                  <Button
                    variant="secondary"
                    className="w-full"
                    disabled={busy === "check-out"}
                    onClick={() =>
                      run("check-out", () => checkOut({ data: { device: deviceInfo() } }), "Checked out.")
                    }
                  >
                    <LogOut className="size-4" /> Check out
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Hourly task entries</CardTitle>
            <CardDescription>
              One row per hour of the working day (9:00–6:00). Fill the slots you worked;
              breaks and blockers are logged separately. Approved slots lock.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-hidden rounded-lg border">
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
                    <div className="grid grid-cols-2 items-center gap-2 px-3 py-2 text-sm sm:grid-cols-[7.5rem_5.5rem_5.5rem_1fr_auto]">
                      <span className="font-medium">{slot.label}</span>
                      <Input
                        aria-label={`Tasks assigned ${slot.label}`}
                        className="h-8"
                        type="number"
                        min={0}
                        disabled={locked || !checkedIn}
                        value={draft.assigned}
                        onChange={(e) => setDraft({ assigned: e.target.value })}
                      />
                      <Input
                        aria-label={`Tasks completed ${slot.label}`}
                        className="h-8"
                        type="number"
                        min={0}
                        disabled={locked || !checkedIn}
                        value={draft.completed}
                        onChange={(e) => setDraft({ completed: e.target.value })}
                      />
                      <div className="min-w-0">
                        {entry ? (
                          <Badge variant={entry.status === "approved" ? "default" : "secondary"}>
                            {entry.status.replace("_", " ")}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">Not logged</span>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Details for ${slot.label}`}
                        onClick={() => setExpandedSlot(open ? null : slot.key)}
                      >
                        {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                      </Button>
                    </div>

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

            <div className="rounded-lg border">
              <button
                type="button"
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
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">
                        {entry.units_assigned != null ? `${entry.units_assigned} assigned · ` : ""}
                        {entry.units_completed} {project?.task_unit ?? "units"}
                      </span>
                      <Badge variant={entry.status === "approved" ? "default" : "secondary"}>
                        {entry.status.replace("_", " ")}
                      </Badge>
                      {entry.status === "draft" && (
                        <Button
                          size="sm"
                          variant="ghost"
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


        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Coffee className="size-4" /> Breaks
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {openBreak ? (
              <Button
                className="w-full"
                variant="secondary"
                disabled={busy === "break"}
                onClick={() =>
                  run("break", () => endBreak({ data: { id: openBreak.id } }), "Break ended.")
                }
              >
                End {openBreak.category.replace("_", " ")} break
              </Button>
            ) : (
              <div className="flex gap-2">
                <select
                  aria-label="Break type"
                  className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
                  value={breakCategory}
                  onChange={(e) => setBreakCategory(e.target.value as BreakCategoryValue)}
                >
                  {BREAK_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <Button
                  disabled={busy === "break" || !checkedIn}
                  onClick={() =>
                    run(
                      "break",
                      () => startBreak({ data: { category: breakCategory } }),
                      "Break started.",
                    )
                  }
                >
                  Start
                </Button>
              </div>
            )}
            <ul className="space-y-1 text-sm text-muted-foreground">
              {day.breaks.map((b) => (
                <li key={b.id}>
                  {b.category.replace("_", " ")}: {timeOf(b.started_at)}–{timeOf(b.ended_at)}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
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
              <select
                aria-label="Blocker project"
                className="h-9 rounded-md border bg-background px-3 text-sm"
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
              <select
                aria-label="Blocker category"
                className="h-9 rounded-md border bg-background px-3 text-sm"
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
              <select
                aria-label="Blocker severity"
                className="h-9 rounded-md border bg-background px-3 text-sm"
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
            <Textarea
              aria-label="Blocker description"
              rows={2}
              placeholder="What is blocking you?"
              value={blockerForm.description}
              onChange={(e) => setBlockerForm({ ...blockerForm, description: e.target.value })}
            />
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
                      <Badge variant={b.status === "resolved" ? "default" : "secondary"}>
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

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">End-of-day report</CardTitle>
            <CardDescription>
              Attendance and task figures are pulled from today's real records; you add the narrative.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {day.eod?.status === "submitted" ? (
              <p className="rounded-md border bg-muted/40 p-3 text-sm">
                Submitted at {timeOf(day.eod.submitted_at)}. {day.eod.highlights}
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
            <div className="flex gap-2">
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
    </AppShell>
  );
}
