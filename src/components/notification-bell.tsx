import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Award,
  Bell,
  Briefcase,
  CalendarClock,
  CheckCheck,
  CheckSquare,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Coffee,
  FileText,
  OctagonAlert,
  ShieldCheck,
  UserCheck,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useActor } from "@/hooks/use-actor";
import {
  listMyNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  resolveNotificationDestinationServer,
} from "@/lib/daily.functions";
import {
  formatRelativeNotificationTime,
  resolveNotificationLink,
  UNAVAILABLE_TARGET_MESSAGE,
  type NotificationIconKind,
  type NotificationRow,
} from "@/lib/notifications/navigation";
import { ORG_TIMEZONE } from "@/lib/timezone";
import { cn } from "@/lib/utils";

function NotificationTypeIcon({ kind }: { kind: NotificationIconKind }) {
  const cls = "size-4 shrink-0";
  switch (kind) {
    case "kyc":
      return <ShieldCheck className={cn(cls, "text-emerald-600")} aria-hidden="true" />;
    case "profile":
      return <UserCheck className={cn(cls, "text-blue-600")} aria-hidden="true" />;
    case "request":
      return <ClipboardCheck className={cn(cls, "text-indigo-600")} aria-hidden="true" />;
    case "break":
      return <Coffee className={cn(cls, "text-amber-600")} aria-hidden="true" />;
    case "attendance":
      return <Clock className={cn(cls, "text-orange-600")} aria-hidden="true" />;
    case "project":
      return <Briefcase className={cn(cls, "text-cyan-600")} aria-hidden="true" />;
    case "task":
      return <CheckSquare className={cn(cls, "text-violet-600")} aria-hidden="true" />;
    case "eod":
      return <FileText className={cn(cls, "text-sky-600")} aria-hidden="true" />;
    case "blocker":
      return <OctagonAlert className={cn(cls, "text-destructive")} aria-hidden="true" />;
    case "interview":
      return <CalendarClock className={cn(cls, "text-purple-600")} aria-hidden="true" />;
    case "candidate":
      return <UserPlus className={cn(cls, "text-pink-600")} aria-hidden="true" />;
    case "relieving":
      return <Award className={cn(cls, "text-red-600")} aria-hidden="true" />;
    case "records":
      return <Archive className={cn(cls, "text-zinc-600")} aria-hidden="true" />;
    default:
      return <Bell className={cn(cls, "text-primary")} aria-hidden="true" />;
  }
}

export function NotificationBell() {
  const actor = useActor();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  const { data: notifications = [] } = useQuery({
    queryKey: ["my-notifications"],
    queryFn: () => listMyNotifications(),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const unread = notifications.filter((n) => !n.read_at);

  async function handleMarkAllRead() {
    if (markingAll || unread.length === 0) return;
    try {
      setMarkingAll(true);
      await markAllNotificationsRead();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["my-notifications"] }),
        queryClient.invalidateQueries({ queryKey: ["role-dashboard"] }),
      ]);
    } catch {
      toast.error("Could not mark all notifications as read.");
    } finally {
      setMarkingAll(false);
    }
  }

  async function handleNotificationClick(raw: NotificationRow) {
    if (busyId === raw.id) return;
    setBusyId(raw.id);

    const localResolved = resolveNotificationLink(raw, actor);

    try {
      const serverRes = await resolveNotificationDestinationServer({
        data: { id: raw.id, markRead: !raw.read_at },
      });

      setOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["my-notifications"] }),
        queryClient.invalidateQueries({ queryKey: ["role-dashboard"] }),
      ]);

      if (serverRes.unavailable) {
        toast.info(serverRes.unavailableMessage || UNAVAILABLE_TARGET_MESSAGE);
        await navigate({ to: (serverRes.fallbackTo || "/dashboard") as never });
        return;
      }

      await navigate({
        to: serverRes.to as never,
        search: serverRes.search as never,
      });
    } catch {
      // Transient backend failure must never swallow the user's navigation intent.
      setOpen(false);
      if (!raw.read_at) {
        void markNotificationRead({ data: { id: raw.id } })
          .then(() =>
            Promise.all([
              queryClient.invalidateQueries({ queryKey: ["my-notifications"] }),
              queryClient.invalidateQueries({ queryKey: ["role-dashboard"] }),
            ]),
          )
          .catch(() => {});
      }

      if (localResolved.unavailable) {
        toast.info(localResolved.unavailableMessage || UNAVAILABLE_TARGET_MESSAGE);
        await navigate({ to: (localResolved.fallbackTo || "/dashboard") as never });
      } else {
        await navigate({
          to: localResolved.to as never,
          search: localResolved.search as never,
        });
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Notifications${unread.length ? `, ${unread.length} unread` : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Bell className="size-5" aria-hidden="true" />
        {unread.length > 0 ? (
          <span className="absolute top-1 right-1 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground">
            {unread.length > 9 ? "9+" : unread.length}
          </span>
        ) : null}
      </Button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close notifications"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-label="Notifications"
            className="fixed right-3 z-50 mt-2 max-h-[min(28rem,calc(100dvh-5rem))] w-[min(23rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border border-border bg-popover p-2 shadow-lg sm:absolute sm:right-0"
          >
            <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2 pb-2 pt-1 mb-1">
              <div className="flex items-center gap-2">
                <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Notifications
                </p>
                {unread.length > 0 ? (
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                    {unread.length} unread
                  </span>
                ) : null}
              </div>
              {unread.length > 0 ? (
                <button
                  type="button"
                  disabled={markingAll}
                  onClick={() => void handleMarkAllRead()}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <CheckCheck className="size-3" aria-hidden="true" />
                  {markingAll ? "Saving…" : "Mark all read"}
                </button>
              ) : null}
            </div>

            {notifications.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                You're all caught up.
              </p>
            ) : null}

            <div className="space-y-1">
              {notifications.slice(0, 25).map((raw) => {
                const n = raw as NotificationRow;
                const resolved = resolveNotificationLink(n, actor);
                const isBusy = busyId === n.id;
                const relativeTime = formatRelativeNotificationTime(n.created_at);
                const exactIst = new Date(n.created_at).toLocaleString("en-IN", {
                  timeZone: ORG_TIMEZONE,
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                });

                return (
                  <button
                    key={n.id}
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleNotificationClick(n)}
                    className={cn(
                      "group flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                      !n.read_at && "bg-accent/55",
                    )}
                  >
                    <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-background border border-border/70">
                      <NotificationTypeIcon kind={resolved.icon} />
                    </div>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-start justify-between gap-2">
                        <span
                          className={cn(
                            "block break-words text-[13px] leading-snug",
                            !n.read_at ? "font-semibold text-foreground" : "font-medium text-foreground/85",
                          )}
                        >
                          {n.title}
                        </span>
                        {!n.read_at && (
                          <span
                            aria-label="Unread"
                            className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
                          />
                        )}
                      </div>
                      {n.body ? (
                        <span className="line-clamp-2 block break-words text-xs text-muted-foreground">
                          {n.body}
                        </span>
                      ) : null}
                      <div className="flex items-center justify-between gap-2 pt-1">
                        <span
                          title={`${exactIst} IST`}
                          className="text-[11px] text-muted-foreground"
                        >
                          {relativeTime || exactIst}
                        </span>
                        <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-primary group-hover:underline">
                          {isBusy ? "Opening…" : resolved.label}
                          <ChevronRight className="size-3" aria-hidden="true" />
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
