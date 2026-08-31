import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Users,
  MailPlus,
  MapPin,
  UserCircle2,
  LogOut,
  Menu,
  ClipboardCheck,
  FolderKanban,
  AlarmClock,
  ListChecks,
  CalendarClock,
  Building2,
  UsersRound,
  Bot,
  FileSpreadsheet,
  UserPlus,
  BarChart3,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActor } from "@/hooks/use-actor";
import { Logo } from "@/components/brand/logo";
import { NotificationBell } from "@/components/notification-bell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ROLE_LABELS, type AppRole, type PermissionKey } from "@/lib/permissions";
import { cn } from "@/lib/utils";

type NavItem = {
  to: string;
  label: string;
  icon: typeof Users;
  permission?: PermissionKey;
  /** Extra role gate for surfaces narrower than any single permission. */
  roles?: AppRole[];
};

const NAV: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/onboarding", label: "My Profile", icon: UserCircle2 },
  { to: "/my-day", label: "My Day", icon: AlarmClock },
  { to: "/my-projects", label: "My Assignments", icon: ClipboardCheck },
  { to: "/requests", label: "Requests", icon: CalendarClock },
  { to: "/reviews", label: "Task Reviews", icon: ListChecks, permission: "tasks:review:team" },
  { to: "/team", label: "Team Review", icon: UsersRound, permission: "attendance:read:team" },
  { to: "/org", label: "Organisation", icon: Building2, permission: "analytics:read:all" },
  { to: "/projects", label: "Projects", icon: FolderKanban },
  { to: "/workforce", label: "Workforce", icon: Users, permission: "workforce:read:team" },
  { to: "/invitations", label: "Invitations", icon: MailPlus, permission: "invitations:read:all" },
  { to: "/automation", label: "Automation", icon: Bot, permission: "automation:run:all" },
  {
    to: "/office-locations",
    label: "Office Locations",
    icon: MapPin,
    permission: "org:manage:all",
  },
  {
    to: "/roster-import",
    label: "Roster Import",
    icon: UserPlus,
    permission: "workforce:create:all",
  },
  {
    to: "/reports",
    label: "Reports",
    icon: BarChart3,
    permission: "attendance:read:all",
    // Founder also holds attendance:read:all, but exports are HR/Admin-only.
    roles: ["super_admin", "admin", "hr"],
  },
  { to: "/import", label: "Legacy Import", icon: FileSpreadsheet, permission: "import:manage:all" },
];

export function AppShell({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const actor = useActor();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [mobileOpen, setMobileOpen] = useState(false);

  const items = NAV.filter(
    (item) =>
      (!item.permission || actor.can(item.permission)) &&
      (!item.roles || actor.roles.some((role) => item.roles!.includes(role as AppRole))),
  );

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/auth" });
  }

  const nav = (
    <nav className="flex flex-1 flex-col gap-0.5 px-3">
      {items.map((item) => {
        const active = pathname === item.to || pathname.startsWith(`${item.to}/`);
        return (
          <Link
            key={item.to}
            to={item.to}
            onClick={() => setMobileOpen(false)}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
            )}
          >
            <item.icon className="size-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar py-4 lg:flex">
        <div className="mb-6 flex items-center gap-2.5 px-5">
          <Logo variant="light" className="h-7" />
          <span className="font-display text-sm font-semibold text-sidebar-foreground">HRM</span>
        </div>
        {nav}
        <div className="mt-auto border-t border-sidebar-border px-3 pt-3">
          <div className="px-2 pb-2">
            <p className="truncate text-sm font-medium text-sidebar-foreground">
              {actor.fullName || actor.workEmail}
            </p>
            <p className="truncate text-xs text-sidebar-foreground/60">
              {actor.roles.map((r) => ROLE_LABELS[r as AppRole] ?? r).join(", ") || "No role"}
            </p>
          </div>
          <button
            onClick={signOut}
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
          >
            <LogOut className="size-4" />
            Sign out
          </button>
        </div>
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            aria-label="Close menu"
            className="absolute inset-0 bg-foreground/40"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative flex h-full w-64 flex-col bg-sidebar py-4">
            <div className="mb-6 flex items-center gap-2.5 px-5">
              <Logo variant="light" className="h-7" />
            </div>
            {nav}
            <div className="mt-auto px-3">
              <button
                onClick={signOut}
                className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-sidebar-foreground/75"
              >
                <LogOut className="size-4" /> Sign out
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b border-border bg-card/85 px-4 py-3 backdrop-blur sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="size-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
            {description ? (
              <p className="truncate text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actor.accountStatus !== "active" ? (
            <Badge variant="outline" className="border-warning text-warning">
              Onboarding in progress
            </Badge>
          ) : null}
          <NotificationBell />
          {actions}
        </header>
        <main className="flex-1 px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
