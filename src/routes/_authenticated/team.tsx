import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState, useMemo, useEffect } from "react";
import {
  Download,
  RefreshCw,
  Search,
  Filter,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Coffee,
  UserCheck,
  UserX,
  Users,
  LogOut,
  ChevronDown,
  X,
  FileSpreadsheet,
} from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { errorToAccessScreen } from "@/components/access-denied";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { AttendanceMonitoringTable } from "@/components/attendance/attendance-monitoring-table";
import { EmployeeAttendanceDrawer } from "@/components/attendance/employee-attendance-drawer";
import {
  exportAttendanceCsv,
  exportAttendanceXlsx,
} from "@/lib/attendance/attendance-export";
import { getOversight, listReviewEvents, reviewEodReport } from "@/lib/oversight.functions";
import { resolveBlocker } from "@/lib/daily.functions";
import type { OversightRow } from "@/lib/oversight.server";
import { todayIso, daysAgoIso } from "@/lib/timezone";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export const Route = createFileRoute("/_authenticated/team")({
  head: () => ({
    meta: [
      { title: "Attendance & Break Monitoring | The AI School HRM" },
      {
        name: "description",
        content:
          "Track daily check-ins, punctuality, breaks, late returns and attendance compliance.",
      },
      { property: "og:title", content: "Attendance & Break Monitoring | The AI School HRM" },
      {
        property: "og:description",
        content:
          "Track daily check-ins, punctuality, breaks, late returns and attendance compliance.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: TeamAttendanceMonitoringPage,
  errorComponent: ({ error }) => errorToAccessScreen(error),
});

type DatePreset = "today" | "yesterday" | "last_7_days" | "last_14_days" | "custom";

function TeamAttendanceMonitoringPage() {
  const actor = useActor();
  const searchParams = useSearch({ strict: false }) as {
    employeeId?: string;
    date?: string;
    section?: string;
    eodId?: string;
    blockerId?: string;
  };
  const queryClient = useQueryClient();
  const canReviewEod = actor.can("eod:review:team");
  const canManageBlockers = actor.can("blockers:manage:team");

  // Date range state
  const todayStr = useMemo(() => todayIso(new Date()), []);
  const [preset, setPreset] = useState<DatePreset>(searchParams.date ? "custom" : "today");
  const [range, setRange] = useState<{ from: string; to: string }>({
    from: searchParams.date || todayStr,
    to: searchParams.date || todayStr,
  });

  useEffect(() => {
    if (searchParams.date) {
      setPreset("custom");
      setRange({ from: searchParams.date, to: searchParams.date });
    }
  }, [searchParams.date]);

  function applyPreset(p: DatePreset) {
    setPreset(p);
    const now = new Date();
    if (p === "today") {
      setRange({ from: todayIso(now), to: todayIso(now) });
    } else if (p === "yesterday") {
      const y = daysAgoIso(1, now);
      setRange({ from: y, to: y });
    } else if (p === "last_7_days") {
      setRange({ from: daysAgoIso(6, now), to: todayIso(now) });
    } else if (p === "last_14_days") {
      setRange({ from: daysAgoIso(13, now), to: todayIso(now) });
    }
  }

  const activeRange = useMemo(() => {
    return range.from && range.to ? { from: range.from, to: range.to } : {};
  }, [range.from, range.to]);

  // Query oversight data
  const { data, refetch, isFetching } = useSuspenseQuery({
    queryKey: ["oversight", "monitoring", range.from, range.to],
    queryFn: () => getOversight({ data: activeRange }),
  });

  // Selected employee for Slide-over detail drawer
  const [selectedRow, setSelectedRow] = useState<OversightRow | null>(null);

  useEffect(() => {
    if (!searchParams.employeeId) return;
    const hit = data.rows.find((r) => r.userId === searchParams.employeeId);
    if (hit) setSelectedRow(hit);
  }, [searchParams.employeeId, data.rows]);

  // Filter state
  const [search, setSearch] = useState<string>("");
  const [departmentFilter, setDepartmentFilter] = useState<string>("all");
  const [quickStatusFilter, setQuickStatusFilter] = useState<string>("all");
  const [showAdvancedFilters, setShowAdvancedFilters] = useState<boolean>(false);
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [workTypeFilter, setWorkTypeFilter] = useState<string>("all");
  const [breakFilter, setBreakFilter] = useState<string>("all");

  // Review events for the selected employee
  const { data: reviewEvents = [], isLoading: eventsLoading } = useQuery({
    queryKey: ["review-events", selectedRow?.userId],
    queryFn: () => listReviewEvents({ data: { userId: selectedRow!.userId } }),
    enabled: Boolean(selectedRow?.userId),
  });

  // Distinct departments for filter dropdown
  const departmentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of data.rows) {
      if (r.departmentName) set.add(r.departmentName);
    }
    return Array.from(set).sort();
  }, [data.rows]);

  // Filtered rows matching search & all filter dropdowns
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.rows.filter((row) => {
      // Search match
      if (q) {
        const nameMatch = row.fullName.toLowerCase().includes(q);
        const codeMatch = row.employeeCode?.toLowerCase().includes(q);
        const emailMatch = row.workEmail?.toLowerCase().includes(q);
        if (!nameMatch && !codeMatch && !emailMatch) return false;
      }

      // Department filter
      if (departmentFilter !== "all" && row.departmentName !== departmentFilter) {
        return false;
      }

      // Quick Attendance status filter
      if (quickStatusFilter === "on_time" && row.arrivalStatus !== "on_time") return false;
      if (quickStatusFilter === "late" && row.arrivalStatus !== "late") return false;
      if (quickStatusFilter === "on_break" && !row.hasActiveBreak) return false;
      if (quickStatusFilter === "checked_out" && !row.checkOutAt) return false;
      if (quickStatusFilter === "missing_check_in" && row.arrivalStatus !== "missing_check_in")
        return false;

      // Role filter
      if (roleFilter !== "all" && row.role !== roleFilter) return false;

      // Work type filter
      if (workTypeFilter !== "all" && row.workType !== workTypeFilter) return false;

      // Break status filter
      if (breakFilter === "lunch" && row.breakStatus !== "on_lunch") return false;
      if (breakFilter === "short" && row.breakStatus !== "on_short_break") return false;
      if (breakFilter === "late_return" && row.breakStatus !== "late_return") return false;
      if (breakFilter === "overdue" && row.breakStatus !== "overdue" && row.breakOvertimeMinutes === 0)
        return false;

      return true;
    });
  }, [
    data.rows,
    search,
    departmentFilter,
    quickStatusFilter,
    roleFilter,
    workTypeFilter,
    breakFilter,
  ]);

  const hasActiveFilters =
    search.trim() !== "" ||
    departmentFilter !== "all" ||
    quickStatusFilter !== "all" ||
    roleFilter !== "all" ||
    workTypeFilter !== "all" ||
    breakFilter !== "all";

  function clearFilters() {
    setSearch("");
    setDepartmentFilter("all");
    setQuickStatusFilter("all");
    setRoleFilter("all");
    setWorkTypeFilter("all");
    setBreakFilter("all");
  }

  // EOD Review Handler
  async function handleReviewEod(id: string, action: string, note: string) {
    try {
      await reviewEodReport({ data: { id, action, note: note || null } });
      toast.success("Review decision recorded successfully.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["oversight"] }),
        queryClient.invalidateQueries({ queryKey: ["review-events"] }),
      ]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to record review decision.");
      throw err;
    }
  }

  // Blocker Resolve Handler
  async function handleResolveBlocker(id: string, note: string) {
    try {
      await resolveBlocker({ data: { id, note: note || null } });
      toast.success("Blocker resolved.");
      await queryClient.invalidateQueries({ queryKey: ["oversight"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to resolve blocker.");
      throw err;
    }
  }

  const { summary } = data;

  return (
    <AppShell
      title="Attendance & Break Monitoring"
      description="Track daily check-ins, working hours, breaks and attendance compliance."
      actions={
        <div className="flex items-center gap-2">
          {/* Refresh */}
          <Button
            size="sm"
            variant="outline"
            className="h-9 gap-1.5 text-xs"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={`size-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>

          {/* Export Dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="h-9 gap-1.5 text-xs">
                <Download className="size-3.5" />
                Export
                <ChevronDown className="size-3.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                onClick={() => exportAttendanceCsv(filteredRows, range.from, range.to)}
              >
                <Download className="mr-2 size-4" />
                Export CSV ({filteredRows.length})
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => exportAttendanceXlsx(filteredRows, range.from, range.to)}
              >
                <FileSpreadsheet className="mr-2 size-4" />
                Export Excel (.xlsx)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    >
      <div className="space-y-5">
        {/* Date presets and Custom Range bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3 shadow-2xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-muted-foreground mr-1">Period:</span>
            <Button
              size="sm"
              variant={preset === "today" ? "default" : "ghost"}
              className="h-7 text-xs px-2.5"
              onClick={() => applyPreset("today")}
            >
              Today
            </Button>
            <Button
              size="sm"
              variant={preset === "yesterday" ? "default" : "ghost"}
              className="h-7 text-xs px-2.5"
              onClick={() => applyPreset("yesterday")}
            >
              Yesterday
            </Button>
            <Button
              size="sm"
              variant={preset === "last_7_days" ? "default" : "ghost"}
              className="h-7 text-xs px-2.5"
              onClick={() => applyPreset("last_7_days")}
            >
              Last 7 Days
            </Button>
            <Button
              size="sm"
              variant={preset === "last_14_days" ? "default" : "ghost"}
              className="h-7 text-xs px-2.5"
              onClick={() => applyPreset("last_14_days")}
            >
              Last 14 Days
            </Button>
            <Button
              size="sm"
              variant={preset === "custom" ? "default" : "ghost"}
              className="h-7 text-xs px-2.5"
              onClick={() => setPreset("custom")}
            >
              Custom
            </Button>
          </div>

          {preset === "custom" && (
            <div className="flex items-center gap-2">
              <Input
                type="date"
                className="h-8 w-36 text-xs"
                value={range.from}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="date"
                className="h-8 w-36 text-xs"
                value={range.to}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              />
            </div>
          )}
        </div>

        {/* COMPACT 8-CARD WORKFORCE KPI STRIP */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5">
          {/* 1. Total Expected */}
          <div className="rounded-lg border bg-card p-3 shadow-2xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-[11px] font-medium uppercase tracking-wider">Expected</span>
              <Users className="size-3.5 text-muted-foreground/70" />
            </div>
            <p className="text-xl font-bold tracking-tight text-foreground mt-2">
              {summary.expectedTotal}
            </p>
            <span className="text-[10px] text-muted-foreground mt-0.5">Active Workforce</span>
          </div>

          {/* 2. Checked In */}
          <div className="rounded-lg border bg-card p-3 shadow-2xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-[11px] font-medium uppercase tracking-wider">Checked In</span>
              <UserCheck className="size-3.5 text-blue-600" />
            </div>
            <p className="text-xl font-bold tracking-tight text-foreground mt-2">
              {summary.checkedInCount}
            </p>
            <span className="text-[10px] text-muted-foreground mt-0.5">
              {summary.expectedTotal > 0
                ? `${Math.round((summary.checkedInCount / summary.expectedTotal) * 100)}% attendance`
                : "0%"}
            </span>
          </div>

          {/* 3. On-Time Arrivals */}
          <div className="rounded-lg border border-emerald-200/60 bg-emerald-50/20 dark:border-emerald-900/40 dark:bg-emerald-950/20 p-3 shadow-2xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-emerald-700 dark:text-emerald-400">
              <span className="text-[11px] font-medium uppercase tracking-wider">On-Time</span>
              <CheckCircle2 className="size-3.5 text-emerald-600" />
            </div>
            <p className="text-xl font-bold tracking-tight text-emerald-700 dark:text-emerald-400 mt-2">
              {summary.onTimeArrivals}
            </p>
            <span className="text-[10px] text-emerald-600/80 dark:text-emerald-400/80 mt-0.5">
              ≤ 10:00 AM IST
            </span>
          </div>

          {/* 4. Late Arrivals */}
          <div className="rounded-lg border border-amber-200/60 bg-amber-50/20 dark:border-amber-900/40 dark:bg-amber-950/20 p-3 shadow-2xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-amber-700 dark:text-amber-400">
              <span className="text-[11px] font-medium uppercase tracking-wider">Late</span>
              <AlertTriangle className="size-3.5 text-amber-600" />
            </div>
            <p className="text-xl font-bold tracking-tight text-amber-700 dark:text-amber-400 mt-2">
              {summary.lateArrivals}
            </p>
            <span className="text-[10px] text-amber-600/80 dark:text-amber-400/80 mt-0.5">
              &gt; 10:00 AM IST
            </span>
          </div>

          {/* 5. Currently On Break */}
          <div className="rounded-lg border bg-card p-3 shadow-2xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-[11px] font-medium uppercase tracking-wider">On Break</span>
              <Coffee className="size-3.5 text-blue-600" />
            </div>
            <p className="text-xl font-bold tracking-tight text-blue-600 mt-2">
              {summary.currentlyOnBreak}
            </p>
            <span className="text-[10px] text-muted-foreground mt-0.5">Live Open Breaks</span>
          </div>

          {/* 6. Overdue / Late Breaks */}
          <div className="rounded-lg border border-rose-200/60 bg-rose-50/20 dark:border-rose-900/40 dark:bg-rose-950/20 p-3 shadow-2xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-rose-700 dark:text-rose-400">
              <span className="text-[11px] font-medium uppercase tracking-wider">Overdue</span>
              <AlertTriangle className="size-3.5 text-rose-600" />
            </div>
            <p className="text-xl font-bold tracking-tight text-rose-700 dark:text-rose-400 mt-2">
              {summary.overdueBreaks}
            </p>
            <span className="text-[10px] text-rose-600/80 dark:text-rose-400/80 mt-0.5">
              Break Violations
            </span>
          </div>

          {/* 7. Checked Out */}
          <div className="rounded-lg border bg-card p-3 shadow-2xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-[11px] font-medium uppercase tracking-wider">Checked Out</span>
              <LogOut className="size-3.5 text-muted-foreground/70" />
            </div>
            <p className="text-xl font-bold tracking-tight text-foreground mt-2">
              {summary.checkedOutCount}
            </p>
            <span className="text-[10px] text-muted-foreground mt-0.5">Completed Shifts</span>
          </div>

          {/* 8. Missing Check-Ins */}
          <div className="rounded-lg border bg-card p-3 shadow-2xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-[11px] font-medium uppercase tracking-wider">Missing</span>
              <UserX className="size-3.5 text-muted-foreground/70" />
            </div>
            <p className="text-xl font-bold tracking-tight text-foreground mt-2">
              {summary.missingCheckIns}
            </p>
            <span className="text-[10px] text-muted-foreground mt-0.5">Unrecorded</span>
          </div>
        </div>

        {/* PRIMARY SEARCH & FILTER BAR */}
        <div className="space-y-3 rounded-lg border bg-card p-4 shadow-2xs">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            {/* Search Input */}
            <div className="relative flex-1 min-w-[240px]">
              <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <Input
                placeholder="Search by employee name, TAS ID, or email..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 pl-9 text-xs"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>

            {/* Quick Department & Quick Status Filters */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Department Dropdown */}
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-xs text-foreground focus:ring-1 focus:ring-primary"
                value={departmentFilter}
                onChange={(e) => setDepartmentFilter(e.target.value)}
              >
                <option value="all">All Departments</option>
                {departmentOptions.map((dept) => (
                  <option key={dept} value={dept}>
                    {dept}
                  </option>
                ))}
              </select>

              {/* Quick Attendance Status */}
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-xs text-foreground focus:ring-1 focus:ring-primary"
                value={quickStatusFilter}
                onChange={(e) => setQuickStatusFilter(e.target.value)}
              >
                <option value="all">All Attendance</option>
                <option value="on_time">On-Time Arrival</option>
                <option value="late">Late Arrival</option>
                <option value="on_break">Currently On Break</option>
                <option value="checked_out">Checked Out</option>
                <option value="missing_check_in">Missing Check-In</option>
              </select>

              {/* Advanced Filters Toggle */}
              <Button
                size="sm"
                variant={showAdvancedFilters ? "secondary" : "outline"}
                className="h-9 gap-1.5 text-xs"
                onClick={() => setShowAdvancedFilters((v) => !v)}
              >
                <Filter className="size-3.5" />
                Filters
                {hasActiveFilters && (
                  <span className="size-1.5 rounded-full bg-primary" />
                )}
              </Button>

              {/* Clear filters button */}
              {hasActiveFilters && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-9 text-xs text-muted-foreground hover:text-foreground"
                  onClick={clearFilters}
                >
                  Reset
                </Button>
              )}
            </div>
          </div>

          {/* COLLAPSIBLE ADVANCED FILTERS */}
          {showAdvancedFilters && (
            <div className="pt-3 border-t grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <Label className="text-[11px] text-muted-foreground block mb-1">Workforce Role</Label>
                <select
                  className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground"
                  value={roleFilter}
                  onChange={(e) => setRoleFilter(e.target.value)}
                >
                  <option value="all">All Roles</option>
                  <option value="employee">Employee</option>
                  <option value="lead">Team Lead</option>
                  <option value="manager">Manager</option>
                  <option value="hr">HR</option>
                  <option value="admin">Admin</option>
                </select>
              </div>

              <div>
                <Label className="text-[11px] text-muted-foreground block mb-1">Work Type</Label>
                <select
                  className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground"
                  value={workTypeFilter}
                  onChange={(e) => setWorkTypeFilter(e.target.value)}
                >
                  <option value="all">All Work Types</option>
                  <option value="annotation">Annotation Staff</option>
                  <option value="operations">General Operations</option>
                </select>
              </div>

              <div>
                <Label className="text-[11px] text-muted-foreground block mb-1">Break Compliance</Label>
                <select
                  className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground"
                  value={breakFilter}
                  onChange={(e) => setBreakFilter(e.target.value)}
                >
                  <option value="all">All Break Statuses</option>
                  <option value="lunch">On Lunch Break</option>
                  <option value="short">On Short Break</option>
                  <option value="late_return">Late Returns</option>
                  <option value="overdue">Overdue Breaks</option>
                </select>
              </div>
            </div>
          )}
        </div>

        {/* MAIN ATTENDANCE MONITORING TABLE */}
        <AttendanceMonitoringTable
          rows={filteredRows}
          onSelectEmployee={(row) => setSelectedRow(row)}
          selectedDayId={selectedRow?.dayId ?? null}
          onReviewEod={(row) => setSelectedRow(row)}
        />

        {/* SLIDE-OVER EMPLOYEE DETAIL DRAWER */}
        <EmployeeAttendanceDrawer
          row={selectedRow}
          isOpen={Boolean(selectedRow)}
          onClose={() => setSelectedRow(null)}
          canReviewEod={canReviewEod}
          canManageBlockers={canManageBlockers}
          onReviewEodReport={handleReviewEod}
          onResolveBlocker={handleResolveBlocker}
          reviewEvents={reviewEvents}
          isEventsLoading={eventsLoading}
        />
      </div>
    </AppShell>
  );
}
