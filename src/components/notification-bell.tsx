import { useState } from "react";
import { Bell } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listMyNotifications, markNotificationRead } from "@/lib/daily.functions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function NotificationBell() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: notifications = [] } = useQuery({
    queryKey: ["my-notifications"],
    queryFn: () => listMyNotifications(),
    refetchInterval: 60_000,
  });

  const unread = notifications.filter((n) => !n.read_at);

  async function read(id: string) {
    await markNotificationRead({ data: { id } });
    await queryClient.invalidateQueries({ queryKey: ["my-notifications"] });
  }

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Notifications${unread.length ? `, ${unread.length} unread` : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Bell className="size-5" />
        {unread.length > 0 ? (
          <span className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground">
            {unread.length > 9 ? "9+" : unread.length}
          </span>
        ) : null}
      </Button>

      {open ? (
        <>
          <button
            aria-label="Close notifications"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-50 mt-2 max-h-96 w-80 overflow-y-auto rounded-md border border-border bg-popover p-2 shadow-lg">
            <p className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Notifications
            </p>
            {notifications.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">Nothing yet.</p>
            ) : null}
            {notifications.slice(0, 25).map((n) => (
              <button
                key={n.id}
                onClick={() => read(n.id)}
                className={cn(
                  "block w-full rounded-md px-2 py-2 text-left text-sm hover:bg-accent",
                  !n.read_at && "bg-accent/50",
                )}
              >
                <span className="block font-medium">{n.title}</span>
                {n.body ? (
                  <span className="block truncate text-xs text-muted-foreground">{n.body}</span>
                ) : null}
                <span className="block text-[11px] text-muted-foreground">
                  {new Date(n.created_at).toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
