import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock,
  BarChart3,
  Bot,
  Briefcase,
  Building2,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  FolderKanban,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Mail,
  MailPlus,
  Menu,
  UserCircle2,
  Users,
  UsersRound,
  Video,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Logo } from "@/components/brand/logo";
import { NotificationBell } from "@/components/notification-bell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useActor } from "@/hooks/use-actor";
import { supabase } from "@/integrations/supabase/client";
import { getActiveBreak } from "@/lib/breaks.functions";
import { GlobalBreakOverlay } from "@/components/breaks/global-break-overlay";
import {
  buildRoleNavigation,
  isNavItemActive,
  type NavIconKey,
} from "@/lib/navigation";
import {
  isExecutiveGovernanceOnly,
  ROLE_LABELS,
  type AppRole,
} from "@/lib/permissions";
import { cn } from "@/lib/utils";

const NAV_ICONS: Record<NavIconKey, LucideIcon> = {
  dashboard: LayoutDashboard,
  my_day: AlarmClock,
  my_work: ClipboardCheck,
  profile: UserCircle2,
  workforce: Users,
  invitations: MailPlus,
  candidates: Briefcase,
  interviews: Video,
  emails: Mail,
  projects: FolderKanban,
  oversight: UsersRound,
  reviews: ListChecks,
  requests: CalendarClock,
  reports: BarChart3,
  org: Building2,
  automation: Bot,
};

export function AppShell({
  title,
  description,
  actions,
  children,
  activeBreak: propActiveBreak,
}: {
  title: string;
  description?: string | undefined;
  actions?: ReactNode | undefined;
  children: ReactNode;
  activeBreak?: import("@/lib/breaks.functions").ActiveBreakState | null | undefined;
}) {
  const actor = useActor();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  // Active break query with 5s polling and focus refetch
  const { data: activeBreakData } = useQuery({
    queryKey: ["current-active-break"],
    queryFn: () => getActiveBreak(),
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });

  const activeBreak = propActiveBreak || (activeBreakData?.activeBreak ?? null);

  const navGroups = buildRoleNavigation(actor);
  const execOnly = isExecutiveGovernanceOnly(actor.roles);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/auth" });
  }

  function isGroupOpen(groupId: string, collapsible?: boolean, hasActiveChild?: boolean) {
    if (!collapsible) return true;
    if (groupId in expandedGroups) return expandedGroups[groupId]!;
    return Boolean(hasActiveChild);
  }

  function toggleGroup(groupId: string, currentlyOpen: boolean) {
    setExpandedGroups((prev) => ({ ...prev, [groupId]: !currentlyOpen }));
  }

  const nav = (
    <nav
      aria-label="Primary navigation"
      className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-3"
    >
      {navGroups.map((group) => {
        const hasActiveChild = group.items.some((item) => isNavItemActive(pathname, item));
        const open = isGroupOpen(group.id, group.collapsible, hasActiveChild);
        return (
          <div key={group.id} className="space-y-0.5">
            {group.collapsible ? (
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggleGroup(group.id, open)}
                className="flex min-h-7 w-full cursor-pointer items-center justify-between rounded px-3 py-1 text-[11px] font-semibold tracking-wider text-sidebar-foreground/75 uppercase transition-colors hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              >
                <span>{group.label}</span>
                {open ? (
                  <ChevronDown className="size-3.5" aria-hidden="true" />
                ) : (
                  <ChevronRight className="size-3.5" aria-hidden="true" />
                )}
              </button>
            ) : (
              <p className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-sidebar-foreground/70 uppercase">
                {group.label}
              </p>
            )}
            {open &&
              group.items.map((item) => {
                const active = isNavItemActive(pathname, item);
                const Icon = NAV_ICONS[item.iconKey];
                return (
                  <Link
                    key={item.to}
                    to={item.to as never}
                    aria-current={active ? "page" : undefined}
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      "flex min-h-9 items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                      active
                        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              })}
          </div>
        );
      })}
    </nav>
  );

  const sidebarFooter = (
    <div className="mt-auto border-t border-sidebar-border px-3 pt-3">
      <div className="px-2 pb-2">
        <p className="truncate text-sm font-medium text-sidebar-foreground">
          {actor.fullName || actor.workEmail}
        </p>
        <p className="truncate text-xs text-sidebar-foreground/70">
          {actor.roles.map((r) => ROLE_LABELS[r as AppRole] ?? r).join(", ") || "No role"}
        </p>
      </div>
      <button
        type="button"
        onClick={signOut}
        className="flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <LogOut className="size-4" aria-hidden="true" />
        Sign out
      </button>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-background">
      {activeBreak ? (
        <GlobalBreakOverlay
          activeBreak={activeBreak}
          onBreakEnded={async () => {
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ["current-active-break"] }),
              queryClient.invalidateQueries({ queryKey: ["my-day"] }),
            ]);
          }}
        />
      ) : null}

      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-md focus:outline-none"
      >
        Skip to main content
      </a>

      <aside className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar py-4 lg:flex">
        <div className="mb-6 flex items-center gap-2.5 px-5">
          <Logo variant="light" className="h-7" />
          <span className="font-display text-sm font-semibold text-sidebar-foreground">HRM</span>
        </div>
        {nav}
        {sidebarFooter}
      </aside>

      {mobileOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          className="fixed inset-0 z-50 lg:hidden"
        >
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative flex h-full w-[min(17rem,calc(100vw-2.5rem))] flex-col bg-sidebar py-4 shadow-xl">
            <div className="mb-6 flex items-center justify-between gap-2 px-5">
              <div className="flex items-center gap-2.5">
                <Logo variant="light" className="h-7" />
                <span className="font-display text-sm font-semibold text-sidebar-foreground">
                  HRM
                </span>
              </div>
              <button
                type="button"
                aria-label="Close navigation menu"
                onClick={() => setMobileOpen(false)}
                className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            {nav}
            {sidebarFooter}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-border bg-card/90 px-4 py-3 backdrop-blur sm:px-6">
          <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation menu"
            >
              <Menu className="size-5" aria-hidden="true" />
            </Button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">
                {title}
              </h1>
              {description ? (
                <p className="text-xs text-muted-foreground sm:text-sm">
                  {description}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!execOnly && actor.accountStatus !== "active" ? (
                <Badge variant="warning" className="hidden min-[420px]:inline-flex">
                  Onboarding in progress
                </Badge>
              ) : null}
              <NotificationBell />
            </div>
            {actions ? (
              <div className="flex w-full flex-wrap items-center justify-end gap-2 pt-1 sm:w-auto sm:pt-0">
                {actions}
              </div>
            ) : null}
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="flex-1 px-4 py-5 outline-none sm:px-6 sm:py-6">
          {children}
        </main>
      </div>
    </div>
  );
}
