import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useActor } from "@/hooks/use-actor";
import { resolveNotificationDestinationServer } from "@/lib/daily.functions";
import {
  resolveNotificationLink,
  UNAVAILABLE_TARGET_MESSAGE,
  type NotificationRow,
} from "@/lib/notifications/navigation";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  Briefcase,
  CalendarClock,
  CheckCircle2,
  Clock,
  FolderKanban,
  Inbox,
  RefreshCw,
  ShieldAlert,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  DashboardFeedItem,
  DashboardProjectItem,
  DashboardQueueItem,
  DashboardTeamMemberRow,
  DashboardTrendPoint,
} from "@/lib/dashboard.functions";
import type { RecruitmentKpiSummary } from "@/lib/recruitment/pipeline";
import { CANDIDATE_PIPELINE_STAGES, CANDIDATE_STATUS_LABELS } from "@/lib/recruitment/pipeline";
import { ROLE_LABELS, type AppRole } from "@/lib/permissions";
import { cn } from "@/lib/utils";

export type KpiTone = "default" | "primary" | "success" | "warning" | "danger" | "info";

const TONE_ICON_STYLES: Record<KpiTone, string> = {
  default: "bg-muted text-muted-foreground",
  primary: "bg-primary/12 text-primary",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-destructive/12 text-destructive",
  info: "bg-info/15 text-info",
};

const TONE_BADGE_STYLES: Record<KpiTone, string> = {
  default: "bg-muted text-muted-foreground border-border",
  primary: "bg-primary/12 text-primary border-primary/25",
  success: "bg-success/15 text-success border-success/25",
  warning: "bg-warning/15 text-warning border-warning/25",
  danger: "bg-destructive/12 text-destructive border-destructive/25",
  info: "bg-info/15 text-info border-info/25",
};

function formatIstShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(5, 10);
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
  }).format(d);
}

export function KpiGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{children}</div>;
}

export function KpiCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
  href,
}: {
  label: string;
  value: string | number;
  hint?: string | undefined;
  icon?: LucideIcon | undefined;
  tone?: KpiTone | undefined;
  href?: string | undefined;
}) {
  const inner = (
    <Card
      className={cn(
        "h-full transition-colors",
        href && "hover:border-primary/40 hover:bg-muted/20",
      )}
    >
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
        <CardDescription className="text-xs font-medium uppercase tracking-wider">
          {label}
        </CardDescription>
        {Icon && (
          <span
            aria-hidden="true"
            className={cn(
              "inline-flex size-8 shrink-0 items-center justify-center rounded-md",
              TONE_ICON_STYLES[tone],
            )}
          >
            <Icon className="size-4" />
          </span>
        )}
      </CardHeader>
      <CardContent>
        <p className="font-display text-2xl font-bold tracking-tight text-foreground">
          {value}
        </p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );

  if (href) {
    return (
      <Link
        to={href as never}
        className="block h-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      >
        {inner}
      </Link>
    );
  }
  return inner;
}

export type QuickActionItem = {
  label: string;
  description?: string | undefined;
  to: string;
  icon: LucideIcon;
  tone?: KpiTone | undefined;
};

export function QuickActionsBar({
  title = "Quick actions",
  actions,
}: {
  title?: string | undefined;
  actions: QuickActionItem[];
}) {
  if (actions.length === 0) return null;
  return (
    <section className="space-y-2.5">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {actions.map((act) => {
          const Icon = act.icon;
          return (
            <Link
              key={`${act.to}-${act.label}`}
              to={act.to as never}
              className="group flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3.5 transition-colors hover:border-primary/40 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-flex size-9 shrink-0 items-center justify-center rounded-md",
                    TONE_ICON_STYLES[act.tone ?? "primary"],
                  )}
                >
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {act.label}
                  </p>
                  {act.description && (
                    <p className="truncate text-xs text-muted-foreground">
                      {act.description}
                    </p>
                  )}
                </div>
              </div>
              <ArrowRight
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
              />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export function AttendanceSummaryPanel({
  title = "Attendance & 14-day trend",
  subtitle,
  expectedActiveCount,
  checkedInToday,
  wfoToday,
  wfhToday,
  hybridOrFieldToday,
  onLeaveToday,
  uncheckedInToday,
  avgAchievementPct14d,
  problemDays14d,
  trend14d,
}: {
  title?: string | undefined;
  subtitle?: string | undefined;
  expectedActiveCount: number;
  checkedInToday: number;
  wfoToday: number;
  wfhToday: number;
  hybridOrFieldToday: number;
  onLeaveToday: number;
  uncheckedInToday: number;
  avgAchievementPct14d: number | null;
  problemDays14d: number;
  trend14d: DashboardTrendPoint[];
}) {
  const denom = Math.max(expectedActiveCount, 1);
  const wfoPct = Math.min(100, Math.round((wfoToday / denom) * 100));
  const wfhPct = Math.min(100, Math.round((wfhToday / denom) * 100));
  const otherPresentPct = Math.min(100, Math.round((hybridOrFieldToday / denom) * 100));
  const leavePct = Math.min(100, Math.round((onLeaveToday / denom) * 100));
  const maxTrend = Math.max(1, ...trend14d.map((p) => p.presentCount));

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="font-display text-base font-semibold">{title}</CardTitle>
            <CardDescription>
              {subtitle ??
                `${checkedInToday} of ${expectedActiveCount} active people checked in today (IST)`}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-md border border-border bg-muted/50 px-2.5 py-1 font-mono">
              14d Avg Target:{" "}
              <strong>
                {avgAchievementPct14d != null ? `${avgAchievementPct14d}%` : "—"}
              </strong>
            </span>
            {problemDays14d > 0 && (
              <span className="rounded-md border border-warning/30 bg-warning/15 px-2.5 py-1 font-mono text-warning">
                {problemDays14d} exception day{problemDays14d === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Today's work-mode split bar */}
        <div className="space-y-2">
          <div
            role="img"
            aria-label={`Today's attendance breakdown: ${wfoToday} WFO, ${wfhToday} WFH, ${hybridOrFieldToday} Hybrid or Field, ${onLeaveToday} On Leave, ${uncheckedInToday} Unchecked-in`}
            className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
          >
            {wfoPct > 0 && (
              <div
                className="bg-primary transition-all"
                style={{ width: `${wfoPct}%` }}
                title={`WFO: ${wfoToday}`}
              />
            )}
            {wfhPct > 0 && (
              <div
                className="bg-info transition-all"
                style={{ width: `${wfhPct}%` }}
                title={`WFH: ${wfhToday}`}
              />
            )}
            {otherPresentPct > 0 && (
              <div
                className="bg-success transition-all"
                style={{ width: `${otherPresentPct}%` }}
                title={`Hybrid / Client / Field: ${hybridOrFieldToday}`}
              />
            )}
            {leavePct > 0 && (
              <div
                className="bg-warning transition-all"
                style={{ width: `${leavePct}%` }}
                title={`On Leave: ${onLeaveToday}`}
              />
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 xl:grid-cols-5">
            <div className="flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-primary" />
              <span className="text-muted-foreground">WFO:</span>
              <strong className="font-mono">{wfoToday}</strong>
            </div>
            <div className="flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-info" />
              <span className="text-muted-foreground">WFH:</span>
              <strong className="font-mono">{wfhToday}</strong>
            </div>
            <div className="flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-success" />
              <span className="text-muted-foreground">Hybrid/Field:</span>
              <strong className="font-mono">{hybridOrFieldToday}</strong>
            </div>
            <div className="flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-warning" />
              <span className="text-muted-foreground">On Leave:</span>
              <strong className="font-mono">{onLeaveToday}</strong>
            </div>
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full bg-muted-foreground/40"
              />
              <span className="text-muted-foreground">Unchecked-in:</span>
              <strong className="font-mono">{uncheckedInToday}</strong>
            </div>
          </div>
        </div>

        {/* 14-day attendance bar strip */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Last 14 calendar days (IST)</span>
            <span className="font-mono">Peak: {maxTrend} present</span>
          </div>
          <div
            role="list"
            aria-label="14-day attendance history"
            className="grid h-20 items-end gap-1 rounded-md border border-border/60 bg-muted/20 p-2"
            style={{ gridTemplateColumns: "repeat(14, minmax(0, 1fr))" }}
          >
            {trend14d.map((pt) => {
              const heightPct =
                pt.presentCount > 0 ? Math.max(14, Math.round((pt.presentCount / maxTrend) * 100)) : 6;
              const summaryText = `${pt.date}: ${pt.presentCount} present (${pt.wfoCount} WFO, ${pt.wfhCount} WFH)${pt.avgAchievementPct != null ? ` · ${pt.avgAchievementPct}% target` : ""}`;
              return (
                <div
                  key={pt.date}
                  role="listitem"
                  tabIndex={0}
                  aria-label={summaryText}
                  title={summaryText}
                  className="group relative flex h-full flex-col items-center justify-end rounded-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div
                    className={cn(
                      "w-full rounded-sm transition-colors",
                      pt.presentCount > 0
                        ? "bg-primary/80 group-hover:bg-primary group-focus-visible:bg-primary"
                        : "bg-border",
                    )}
                    style={{ height: `${heightPct}%` }}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
            <span>{trend14d[0]?.date.slice(5)}</span>
            <span>{trend14d[trend14d.length - 1]?.date.slice(5)} (Today)</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const QUEUE_TONE_TO_KPI: Record<DashboardQueueItem["tone"], KpiTone> = {
  primary: "primary",
  warning: "warning",
  danger: "danger",
  info: "info",
  neutral: "default",
};

export function PendingActionQueue({
  title = "Pending action queue",
  description = "Items awaiting your review or decision",
  items,
  emptyMessage = "All caught up — zero pending items in your queue.",
}: {
  title?: string | undefined;
  description?: string | undefined;
  items: DashboardQueueItem[];
  emptyMessage?: string | undefined;
}) {
  const [filter, setFilter] = useState<string>("all");
  const categories = Array.from(new Set(items.map((i) => i.badge ?? i.category)));
  const filtered =
    filter === "all" ? items : items.filter((i) => (i.badge ?? i.category) === filter);
  const visibleItems = filtered.slice(0, 10);

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="font-display text-base font-semibold">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <Badge variant={items.length > 0 ? "warning" : "outline"} className="font-mono">
            {items.length} pending
          </Badge>
        </div>
        {categories.length > 1 && (
          <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Filter queue items">
            <button
              type="button"
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
              className={cn(
                "min-h-7 rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                filter === "all"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              All ({items.length})
            </button>
            {categories.map((cat) => {
              const count = items.filter((i) => (i.badge ?? i.category) === cat).length;
              return (
                <button
                  key={cat}
                  type="button"
                  aria-pressed={filter === cat}
                  onClick={() => setFilter(cat)}
                  className={cn(
                    "min-h-7 rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    filter === cat
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:text-foreground",
                  )}
                >
                  {cat} ({count})
                </button>
              );
            })}
          </div>
        )}
      </CardHeader>
      <CardContent className="flex-1 space-y-3">
        {filtered.length === 0 ? (
          <DashboardEmptyState
            icon={CheckCircle2}
            title="Queue clear"
            description={emptyMessage}
            compact
          />
        ) : (
          <>
            <ul className="divide-y divide-border">
              {visibleItems.map((item) => {
                const tone = QUEUE_TONE_TO_KPI[item.tone];
                return (
                  <li key={item.id} className="py-2.5 first:pt-0 last:pb-0">
                    <Link
                      to={item.href as never}
                      className="group -m-1.5 flex items-start justify-between gap-3 rounded-md p-1.5 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <p className="truncate text-sm font-medium text-foreground group-hover:text-primary">
                          {item.title}
                        </p>
                        <p className="line-clamp-1 text-xs text-muted-foreground">
                          {item.subtitle}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {item.badge && (
                          <span
                            className={cn(
                              "rounded border px-2 py-0.5 text-[11px] font-medium",
                              TONE_BADGE_STYLES[tone],
                            )}
                          >
                            {item.badge}
                          </span>
                        )}
                        <ArrowRight
                          aria-hidden="true"
                          className="size-3.5 text-muted-foreground group-hover:text-primary"
                        />
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {filtered.length > visibleItems.length && (
              <p className="border-t border-border pt-2 text-xs text-muted-foreground">
                Showing first {visibleItems.length} of {filtered.length} items. Open the linked
                workspace to view all.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function ProjectPerformanceCard({
  title = "Project portfolio & capacity",
  description = "Headcount coverage and 14-day output across visible projects",
  projects,
  unallocatedActiveStaff,
  overAllocatedStaff,
  readOnly = false,
}: {
  title?: string | undefined;
  description?: string | undefined;
  projects: DashboardProjectItem[];
  unallocatedActiveStaff?: number | undefined;
  overAllocatedStaff?: number | undefined;
  readOnly?: boolean | undefined;
}) {
  const visibleProjects = projects.slice(0, 8);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="font-display text-base font-semibold">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {unallocatedActiveStaff != null && (
              <span className="rounded-md border border-border bg-muted/50 px-2.5 py-1 font-mono">
                Unallocated: <strong>{unallocatedActiveStaff}</strong>
              </span>
            )}
            {overAllocatedStaff != null && overAllocatedStaff > 0 && (
              <span className="rounded-md border border-warning/30 bg-warning/15 px-2.5 py-1 font-mono text-warning">
                Over-allocated (&gt;100%): <strong>{overAllocatedStaff}</strong>
              </span>
            )}
            <Button asChild variant="outline" size="sm">
              <Link to="/projects">{readOnly ? "Inspect projects" : "Open projects"}</Link>
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {projects.length === 0 ? (
          <DashboardEmptyState
            icon={FolderKanban}
            title="No projects in scope"
            description="No active or assigned projects match your current scope."
            compact
          />
        ) : (
          <>
            {/* Mobile stacked project cards (<640px) */}
            <div className="space-y-2.5 sm:hidden">
              {visibleProjects.map((p) => {
                const understaffed =
                  p.status === "active" && p.allocatedHeadcount < p.requiredHeadcount;
                return (
                  <Link
                    key={p.id}
                    to="/projects/$projectId"
                    params={{ projectId: p.id }}
                    className="block rounded-lg border border-border/80 bg-muted/15 p-3 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">
                          <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                            {p.code}
                          </span>
                          {p.name}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          <span className="uppercase">{p.workMode}</span>
                          {p.departmentName ? ` · ${p.departmentName}` : ""}
                        </p>
                      </div>
                      {p.avgAchievementPct != null && (
                        <span
                          className={cn(
                            "shrink-0 rounded px-1.5 py-0.5 font-mono text-xs font-medium",
                            p.avgAchievementPct >= 90
                              ? "bg-success/15 text-success"
                              : p.avgAchievementPct >= 70
                                ? "bg-warning/15 text-warning"
                                : "bg-destructive/12 text-destructive",
                          )}
                        >
                          {p.avgAchievementPct}%
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-xs text-muted-foreground">
                      <span className={understaffed ? "font-semibold text-warning" : "text-foreground"}>
                        Staff: {p.allocatedHeadcount}/{p.requiredHeadcount}
                      </span>
                      <span>14d Units: {p.totalUnits14d.toLocaleString()}</span>
                    </div>
                  </Link>
                );
              })}
            </div>

            {/* Tablet & Desktop table (>=640px) */}
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[540px] text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th scope="col" className="pb-2.5 pr-4">
                      Project
                    </th>
                    <th scope="col" className="pb-2.5 pr-4">
                      Mode / Dept
                    </th>
                    <th scope="col" className="pb-2.5 pr-4">
                      Headcount
                    </th>
                    <th scope="col" className="pb-2.5 pr-4">
                      14d Units
                    </th>
                    <th scope="col" className="pb-2.5">
                      Avg Target
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {visibleProjects.map((p) => {
                    const understaffed =
                      p.status === "active" && p.allocatedHeadcount < p.requiredHeadcount;
                    return (
                      <tr key={p.id} className="hover:bg-muted/30">
                        <td className="py-2.5 pr-4">
                          <Link
                            to="/projects/$projectId"
                            params={{ projectId: p.id }}
                            className="rounded-xs font-medium text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                              {p.code}
                            </span>
                            {p.name}
                          </Link>
                        </td>
                        <td className="py-2.5 pr-4 text-xs text-muted-foreground">
                          <span className="uppercase">{p.workMode}</span>
                          {p.departmentName ? ` · ${p.departmentName}` : ""}
                        </td>
                        <td className="py-2.5 pr-4 font-mono text-xs">
                          <span
                            className={cn(
                              understaffed ? "font-semibold text-warning" : "text-foreground",
                            )}
                          >
                            {p.allocatedHeadcount} / {p.requiredHeadcount}
                          </span>
                        </td>
                        <td className="py-2.5 pr-4 font-mono text-xs">
                          {p.totalUnits14d.toLocaleString()}
                        </td>
                        <td className="py-2.5 font-mono text-xs">
                          {p.avgAchievementPct != null ? (
                            <span
                              className={cn(
                                "rounded px-1.5 py-0.5 font-medium",
                                p.avgAchievementPct >= 90
                                  ? "bg-success/15 text-success"
                                  : p.avgAchievementPct >= 70
                                    ? "bg-warning/15 text-warning"
                                    : "bg-destructive/12 text-destructive",
                              )}
                            >
                              {p.avgAchievementPct}%
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {projects.length > visibleProjects.length && (
              <p className="border-t border-border pt-2 text-xs text-muted-foreground">
                Showing {visibleProjects.length} of {projects.length} projects.{" "}
                <Link to="/projects" className="font-medium text-primary hover:underline">
                  View all projects
                </Link>
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

const TODAY_STATUS_BADGE: Record<string, { label: string; tone: KpiTone }> = {
  present_complete: { label: "Complete", tone: "success" },
  present_eod_pending: { label: "Checked In", tone: "primary" },
  present_hours_incomplete: { label: "Short Hours", tone: "warning" },
  half_day: { label: "Half Day", tone: "warning" },
  missed_check_out: { label: "Missed Out", tone: "danger" },
  review_required: { label: "Needs Review", tone: "danger" },
  on_leave: { label: "On Leave", tone: "info" },
  holiday: { label: "Holiday", tone: "default" },
  weekly_off: { label: "Weekly Off", tone: "default" },
  absent: { label: "Absent", tone: "default" },
  unchecked_in: { label: "Not Checked In", tone: "default" },
};

export function TeamProductivityCard({
  title = "Team attendance & productivity",
  description = "Live check-in status today and 14-day output across visible team members",
  members,
  showDirectoryLink = true,
}: {
  title?: string | undefined;
  description?: string | undefined;
  members: DashboardTeamMemberRow[];
  showDirectoryLink?: boolean | undefined;
}) {
  const visibleMembers = members.slice(0, 10);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="font-display text-base font-semibold">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {showDirectoryLink && (
            <Button asChild variant="outline" size="sm">
              <Link to="/team">Open oversight</Link>
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {members.length === 0 ? (
          <DashboardEmptyState
            icon={Users}
            title="No team members in scope"
            description="Assign direct reports, departments, or project allocations to populate team metrics."
            compact
          />
        ) : (
          <>
            {/* Mobile stacked member cards (<640px) */}
            <div className="space-y-2.5 sm:hidden">
              {visibleMembers.map((m) => {
                const statusMeta = TODAY_STATUS_BADGE[m.todayStatus] ?? {
                  label: m.todayStatus,
                  tone: "default" as KpiTone,
                };
                return (
                  <Link
                    key={m.userId}
                    to="/workforce/$personId"
                    params={{ personId: m.userId }}
                    className="block rounded-lg border border-border/80 bg-muted/15 p-3 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">
                          {m.fullName}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {m.designation ?? ROLE_LABELS[m.roleLabel as AppRole] ?? m.roleLabel}
                          {m.departmentName ? ` · ${m.departmentName}` : ""}
                        </p>
                      </div>
                      <span
                        className={cn(
                          "shrink-0 rounded border px-2 py-0.5 text-[11px] font-medium",
                          TONE_BADGE_STYLES[statusMeta.tone],
                        )}
                      >
                        {statusMeta.label}
                        {m.todayWorkMode ? ` · ${m.todayWorkMode.toUpperCase()}` : ""}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-xs text-muted-foreground">
                      <span>14d: {m.workedHours14d}h</span>
                      <span>Units: {m.unitsCompleted14d.toLocaleString()}</span>
                      <span>
                        Target: {m.avgAchievementPct14d != null ? `${m.avgAchievementPct14d}%` : "—"}
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>

            {/* Tablet & Desktop table (>=640px) */}
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[540px] text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th scope="col" className="pb-2.5 pr-4">
                      Member
                    </th>
                    <th scope="col" className="pb-2.5 pr-4">
                      Today
                    </th>
                    <th scope="col" className="pb-2.5 pr-4">
                      14d Hours
                    </th>
                    <th scope="col" className="pb-2.5 pr-4">
                      14d Units
                    </th>
                    <th scope="col" className="pb-2.5">
                      14d Target
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {visibleMembers.map((m) => {
                    const statusMeta = TODAY_STATUS_BADGE[m.todayStatus] ?? {
                      label: m.todayStatus,
                      tone: "default" as KpiTone,
                    };
                    return (
                      <tr key={m.userId} className="hover:bg-muted/30">
                        <td className="py-2.5 pr-4">
                          <Link
                            to="/workforce/$personId"
                            params={{ personId: m.userId }}
                            className="rounded-xs font-medium text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {m.fullName}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {m.designation ?? ROLE_LABELS[m.roleLabel as AppRole] ?? m.roleLabel}
                            {m.departmentName ? ` · ${m.departmentName}` : ""}
                          </p>
                        </td>
                        <td className="py-2.5 pr-4">
                          <span
                            className={cn(
                              "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium",
                              TONE_BADGE_STYLES[statusMeta.tone],
                            )}
                          >
                            {statusMeta.label}
                            {m.todayWorkMode ? ` · ${m.todayWorkMode.toUpperCase()}` : ""}
                          </span>
                        </td>
                        <td className="py-2.5 pr-4 font-mono text-xs">{m.workedHours14d}h</td>
                        <td className="py-2.5 pr-4 font-mono text-xs">
                          {m.unitsCompleted14d.toLocaleString()}
                        </td>
                        <td className="py-2.5 font-mono text-xs">
                          {m.avgAchievementPct14d != null ? `${m.avgAchievementPct14d}%` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {members.length > visibleMembers.length && (
              <p className="border-t border-border pt-2 text-xs text-muted-foreground">
                Showing {visibleMembers.length} of {members.length} team members.{" "}
                <Link to="/workforce" className="font-medium text-primary hover:underline">
                  View directory
                </Link>
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function ActivityFeedCard({
  title,
  description,
  items,
  emptyTitle = "No recent activity",
  emptyDescription = "Updates will appear here as events are recorded.",
}: {
  title: string;
  description?: string | undefined;
  items: DashboardFeedItem[];
  emptyTitle?: string | undefined;
  emptyDescription?: string | undefined;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="font-display text-base font-semibold">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <DashboardEmptyState
            icon={Clock}
            title={emptyTitle}
            description={emptyDescription}
            compact
          />
        ) : (
          <ul className="space-y-3">
            {items.map((ev) => {
              const tone: KpiTone =
                ev.tone === "success"
                  ? "success"
                  : ev.tone === "warning"
                    ? "warning"
                    : ev.tone === "danger"
                      ? "danger"
                      : ev.tone === "info"
                        ? "info"
                        : "default";
              return (
                <li
                  key={ev.id}
                  className="flex items-start justify-between gap-3 rounded-md border border-border/70 bg-muted/15 p-3"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          tone === "success"
                            ? "bg-success"
                            : tone === "warning"
                              ? "bg-warning"
                              : tone === "danger"
                                ? "bg-destructive"
                                : tone === "info"
                                  ? "bg-info"
                                  : "bg-muted-foreground",
                        )}
                      />
                      <p className="truncate text-sm font-medium text-foreground">{ev.title}</p>
                    </div>
                    <p className="line-clamp-2 pl-4 text-xs text-muted-foreground">
                      {ev.subtitle}
                    </p>
                  </div>
                  {ev.timestamp && (
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {ev.timestamp.slice(0, 10)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Real database-backed HR Recruitment KPI Grid & Stage Pipeline Panel (Phase P2).
 */
export function RecruitmentPipelinePanel({
  schemaReady,
  emailProviderConfigured,
  kpis,
  invitationCounts,
  readOnly = false,
  canViewInvitations,
}: {
  schemaReady: boolean;
  emailProviderConfigured: boolean;
  kpis: RecruitmentKpiSummary;
  invitationCounts: Record<string, number>;
  readOnly?: boolean | undefined;
  canViewInvitations?: boolean | undefined;
}) {
  const queuedOrSending = (invitationCounts["queued"] ?? 0) + (invitationCounts["sending"] ?? 0);
  const sent = invitationCounts["sent"] ?? 0;
  const accepted = invitationCounts["accepted"] ?? 0;
  const allowInvitationsLink = canViewInvitations ?? !readOnly;
  const pendingOnboardingHref = allowInvitationsLink ? "/invitations" : "/workforce";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Briefcase className="size-4 text-primary" aria-hidden="true" />
            <CardTitle className="font-display text-base font-semibold">
              HR Recruitment &amp; Talent Pipeline
            </CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {!schemaReady && (
              <Badge variant="warning">P2 SQL Migration Pending Approval</Badge>
            )}
            <Badge variant={emailProviderConfigured ? "success" : "outline"}>
              {emailProviderConfigured ? "Email Sender Verified" : "Email Sender Unconfigured"}
            </Badge>
          </div>
        </div>
        <CardDescription>
          Live recruitment funnel from Applied through Offer Accepted &amp; Onboarding conversion
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
          <Link
            to="/candidates"
            className="rounded-md border border-border/80 bg-muted/15 p-3 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Total Candidates
            </p>
            <p className="mt-1 font-mono text-xl font-bold text-foreground">
              {kpis.totalCandidates}
            </p>
          </Link>
          <Link
            to="/candidates"
            className="rounded-md border border-border/80 bg-muted/15 p-3 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              New Applications
            </p>
            <p className="mt-1 font-mono text-xl font-bold text-primary">
              {kpis.newApplications}
            </p>
          </Link>
          <Link
            to="/candidates"
            className="rounded-md border border-border/80 bg-muted/15 p-3 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Shortlisted Candidates
            </p>
            <p className="mt-1 font-mono text-xl font-bold text-info">
              {kpis.shortlistedCandidates}
            </p>
          </Link>
          <Link
            to="/interviews"
            className="rounded-md border border-border/80 bg-muted/15 p-3 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Interviews Scheduled
            </p>
            <p className="mt-1 font-mono text-xl font-bold text-warning">
              {kpis.interviewsScheduled}
            </p>
          </Link>
          <Link
            to="/candidates"
            className="rounded-md border border-border/80 bg-muted/15 p-3 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Selected Candidates
            </p>
            <p className="mt-1 font-mono text-xl font-bold text-success">
              {kpis.selectedCandidates}
            </p>
          </Link>
          <Link
            to="/candidates"
            className="rounded-md border border-border/80 bg-muted/15 p-3 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Offers Sent
            </p>
            <p className="mt-1 font-mono text-xl font-bold text-foreground">{kpis.offersSent}</p>
          </Link>
          <Link
            to={pendingOnboardingHref}
            className="rounded-md border border-border/80 bg-muted/15 p-3 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Pending Onboarding
            </p>
            <p className="mt-1 font-mono text-xl font-bold text-primary">
              {kpis.pendingOnboarding}
            </p>
          </Link>
          <div className="rounded-md border border-border/80 bg-muted/15 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Recruitment Conversion Rate
            </p>
            <p className="mt-1 font-mono text-xl font-bold text-success">
              {kpis.conversionRatePct}%
            </p>
          </div>
        </div>

        <div className="rounded-md border border-border/70 bg-card p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Pipeline Stage Distribution
          </p>
          <div className="flex flex-wrap gap-1.5 text-xs">
            {CANDIDATE_PIPELINE_STAGES.map((st) => (
              <span
                key={st}
                className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1"
              >
                <span className="text-muted-foreground">{CANDIDATE_STATUS_LABELS[st]}</span>
                <strong className="font-mono text-foreground">{kpis.stageCounts[st]}</strong>
              </span>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
          <span>
            Employee Invites Queue: <strong className="font-mono">{queuedOrSending}</strong> queued ·{" "}
            <strong className="font-mono">{sent}</strong> sent ·{" "}
            <strong className="font-mono">{accepted}</strong> accepted
          </span>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant={readOnly ? "outline" : "default"}>
              <Link to="/candidates">{readOnly ? "View Candidates" : "Open Candidates"}</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/interviews">Interviews</Link>
            </Button>
            {!readOnly && (
              <Button asChild variant="outline" size="sm">
                <Link to="/email-center">Email Center</Link>
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function NotificationsSummaryCard({
  unreadCount,
  items,
  markingNotificationId,
  onMarkRead,
}: {
  unreadCount: number;
  items: ({
    id: string;
    title: string;
    body: string | null;
    read_at: string | null;
    created_at: string;
  } & Partial<NotificationRow>)[];
  markingNotificationId?: string | null | undefined;
  onMarkRead?: ((id: string) => void) | undefined;
}) {
  const actor = useActor();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function handleOpen(raw: (typeof items)[number]) {
    const row: NotificationRow = {
      user_id: actor.userId,
      type: raw.type ?? "",
      ...raw,
    };
    const localResolved = resolveNotificationLink(row, actor);
    try {
      const serverRes = await resolveNotificationDestinationServer({
        data: { id: raw.id, markRead: !raw.read_at },
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["my-notifications"] }),
        queryClient.invalidateQueries({ queryKey: ["role-dashboard"] }),
      ]);
      if (serverRes.unavailable) {
        toast.info(serverRes.unavailableMessage || UNAVAILABLE_TARGET_MESSAGE);
        await navigate({ to: (serverRes.fallbackTo || "/dashboard") as never });
        return;
      }
      await navigate({ to: serverRes.to as never, search: serverRes.search as never });
    } catch {
      if (!raw.read_at && onMarkRead) onMarkRead(raw.id);
      if (localResolved.unavailable) {
        toast.info(localResolved.unavailableMessage || UNAVAILABLE_TARGET_MESSAGE);
        await navigate({ to: (localResolved.fallbackTo || "/dashboard") as never });
      } else {
        await navigate({ to: localResolved.to as never, search: localResolved.search as never });
      }
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Bell className="size-4 text-primary" aria-hidden="true" />
            <CardTitle className="font-display text-base font-semibold">Notifications</CardTitle>
          </div>
          <Badge variant={unreadCount > 0 ? "info" : "outline"} className="font-mono">
            {unreadCount} unread
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <DashboardEmptyState
            icon={Inbox}
            title="Inbox clear"
            description="You have no recent notifications."
            compact
          />
        ) : (
          <ul className="divide-y divide-border">
            {items.slice(0, 6).map((n) => {
              const isMarking = markingNotificationId === n.id;
              const resolved = resolveNotificationLink(
                { user_id: actor.userId, type: n.type ?? "", ...n },
                actor,
              );
              return (
                <li
                  key={n.id}
                  className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                >
                  <button
                    type="button"
                    onClick={() => void handleOpen(n)}
                    className="min-w-0 flex-1 space-y-0.5 text-left rounded-sm hover:bg-accent/50 p-1 -m-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="flex items-center gap-1.5">
                      {!n.read_at && (
                        <span
                          aria-hidden="true"
                          className="size-2 shrink-0 rounded-full bg-primary"
                        />
                      )}
                      <p
                        className={cn(
                          "truncate text-sm",
                          !n.read_at
                            ? "font-semibold text-foreground"
                            : "font-medium text-muted-foreground",
                        )}
                      >
                        {n.title}
                      </p>
                    </div>
                    {n.body && (
                      <p className="line-clamp-1 text-xs text-muted-foreground">{n.body}</p>
                    )}
                    <p className="text-[11px] font-medium text-primary">{resolved.label} →</p>
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {formatIstShortDate(n.created_at)}
                    </span>
                    {!n.read_at && onMarkRead && (
                      <button
                        type="button"
                        disabled={isMarking}
                        aria-label={`Mark "${n.title}" as read`}
                        onClick={() => onMarkRead(n.id)}
                        className="rounded-sm px-1 py-0.5 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      >
                        {isMarking ? "Saving…" : "Mark read"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardEmptyState({
  icon: Icon = Briefcase,
  title,
  description,
  action,
  compact = false,
}: {
  icon?: LucideIcon | undefined;
  title: string;
  description: string;
  action?: ReactNode | undefined;
  compact?: boolean | undefined;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/15 text-center",
        compact ? "px-4 py-6" : "px-4 py-10 sm:px-6",
      )}
    >
      <Icon className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="mt-2 text-sm font-semibold text-foreground">{title}</p>
      <p className="mt-1 max-w-md text-xs text-muted-foreground">{description}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function DashboardErrorState({
  message,
  isRetrying = false,
  onRetry,
}: {
  message: string;
  isRetrying?: boolean | undefined;
  onRetry: () => void;
}) {
  return (
    <Card role="alert" className="border-destructive/40 bg-destructive/5">
      <CardContent className="flex flex-col items-start justify-between gap-4 py-6 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-start gap-3">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-display text-sm font-semibold text-foreground">
              Unable to load dashboard metrics
            </p>
            <p className="mt-0.5 break-words text-xs text-muted-foreground">{message}</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={isRetrying}
          onClick={onRetry}
          className="w-full shrink-0 sm:w-auto"
        >
          <RefreshCw
            aria-hidden="true"
            className={cn("mr-1.5 size-3.5", isRetrying && "animate-spin")}
          />
          {isRetrying ? "Retrying…" : "Retry"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function DashboardLoadingSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading dashboard"
      className="space-y-6"
    >
      <span className="sr-only">Loading dashboard metrics…</span>
      <div className="space-y-2">
        <div className="h-4 w-36 max-w-full animate-pulse rounded bg-muted" />
        <div className="h-8 w-64 max-w-full animate-pulse rounded bg-muted" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[1, 2, 3, 4].map((n) => (
          <div key={n} className="h-28 animate-pulse rounded-lg border border-border bg-card p-4">
            <div className="h-3 w-24 rounded bg-muted" />
            <div className="mt-4 h-7 w-16 rounded bg-muted" />
          </div>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="h-64 animate-pulse rounded-lg border border-border bg-card" />
        <div className="h-64 animate-pulse rounded-lg border border-border bg-card" />
      </div>
    </div>
  );
}

export function WorkforceDistributionCard({
  title = "Workforce distribution",
  totalActive,
  categoryBreakdown,
  departmentBreakdown,
  upcomingInternshipEndings,
  missingReportingLeadCount,
  readOnly = false,
}: {
  title?: string | undefined;
  totalActive: number;
  categoryBreakdown: Record<string, number>;
  departmentBreakdown: { name: string; count: number }[];
  upcomingInternshipEndings?:
    | {
        id: string;
        fullName: string;
        internshipEnd: string;
        designation: string | null;
      }[]
    | undefined;
  missingReportingLeadCount?: number | undefined;
  readOnly?: boolean | undefined;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="font-display text-base font-semibold">{title}</CardTitle>
            <CardDescription>{totalActive} active workforce profiles</CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/workforce">Directory</Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 text-xs xl:grid-cols-4">
          <div className="rounded-md border border-border/70 bg-muted/20 p-2.5">
            <span className="text-muted-foreground">Full-Time</span>
            <p className="mt-0.5 font-mono text-base font-semibold">
              {categoryBreakdown["full_time"] ?? 0}
            </p>
          </div>
          <div className="rounded-md border border-border/70 bg-muted/20 p-2.5">
            <span className="text-muted-foreground">Interns</span>
            <p className="mt-0.5 font-mono text-base font-semibold">
              {categoryBreakdown["intern"] ?? 0}
            </p>
          </div>
          <div className="rounded-md border border-border/70 bg-muted/20 p-2.5">
            <span className="text-muted-foreground">Freelancers</span>
            <p className="mt-0.5 font-mono text-base font-semibold">
              {categoryBreakdown["freelancer"] ?? 0}
            </p>
          </div>
          <div className="rounded-md border border-border/70 bg-muted/20 p-2.5">
            <span className="text-muted-foreground">Trainers</span>
            <p className="mt-0.5 font-mono text-base font-semibold">
              {categoryBreakdown["trainer"] ?? 0}
            </p>
          </div>
        </div>

        {departmentBreakdown.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              By department
            </p>
            <div className="flex flex-wrap gap-1.5">
              {departmentBreakdown.slice(0, 8).map((d) => (
                <span
                  key={d.name}
                  className="rounded-md border border-border bg-card px-2.5 py-1 text-xs"
                >
                  {d.name}: <strong className="font-mono">{d.count}</strong>
                </span>
              ))}
            </div>
          </div>
        )}

        {(missingReportingLeadCount ?? 0) > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/35 bg-warning/10 px-3 py-2 text-xs">
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              <AlertTriangle className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
              <span>{missingReportingLeadCount} active staff missing a Reporting Lead</span>
            </span>
            <Link to="/workforce" className="font-semibold text-primary hover:underline">
              {readOnly ? "View directory" : "Assign"}
            </Link>
          </div>
        )}

        {upcomingInternshipEndings && upcomingInternshipEndings.length > 0 && (
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <CalendarClock className="size-3.5 text-info" aria-hidden="true" />
              Internships ending within 14 days
            </p>
            <ul className="space-y-1 text-xs">
              {upcomingInternshipEndings.map((i) => (
                <li
                  key={i.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/70 px-2.5 py-1.5"
                >
                  <Link
                    to="/workforce/$personId"
                    params={{ personId: i.id }}
                    className="font-medium hover:text-primary hover:underline"
                  >
                    {i.fullName}
                  </Link>
                  <span className="font-mono text-muted-foreground">{i.internshipEnd}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
