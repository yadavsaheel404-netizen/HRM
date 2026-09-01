import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { errorToAccessScreen } from "@/components/access-denied";
import {
  enqueueInvitations,
  getNextEmployeeIdPreview,
  listInvitations,
  requeueInvitation,
  revokeInvitation,
  runInvitationDispatch,
} from "@/lib/invitations.functions";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { APP_ROLES, CATEGORY_LABELS, ROLE_LABELS, USER_CATEGORIES } from "@/lib/permissions";

export const Route = createFileRoute("/_authenticated/invitations")({
  head: () => ({
    meta: [
      { title: "Invitations | The AI School HRM" },
      {
        name: "description",
        content: "Queue, throttle and track staff invitations sent from The AI School HRM portal.",
      },
      { property: "og:title", content: "Invitations | The AI School HRM" },
      { property: "og:description", content: "Throttled invitation queue for staff onboarding." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: InvitationsPage,
  errorComponent: ({ error }) => errorToAccessScreen(error),
});

function InvitationsPage() {
  const queryClient = useQueryClient();
  const actor = useActor();
  const canCreate = actor.can("invitations:create:all");
  const { data: invitations } = useSuspenseQuery({
    queryKey: ["invitations"],
    queryFn: () => listInvitations(),
  });
  const { data: nextIdPreview } = useQuery({
    queryKey: ["next-employee-id-preview"],
    queryFn: () => getNextEmployeeIdPreview(),
    enabled: canCreate,
  });
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    email: "",
    fullName: "",
    role: "employee",
    category: "full_time",
    designation: "",
  });

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await enqueueInvitations({
        data: {
          invites: [
            {
              email: form.email.trim(),
              fullName: form.fullName.trim(),
              role: form.role,
              category: form.category,
              designation: form.designation || null,
            },
          ],
          source: "manual",
        },
      });
      toast.success("Queued. The worker will send it shortly.");
      setForm({ ...form, email: "", fullName: "", designation: "" });
      await queryClient.invalidateQueries();
    } catch (error: any) {
      console.error("[invitations] handleSingleSubmit error:", error);
      const msg = error?.message || error?.error || (typeof error === "string" ? error : JSON.stringify(error)) || "Could not queue that invitation.";
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  async function dispatchNow() {
    setBusy(true);
    try {
      const result = await runInvitationDispatch();
      toast.success(
        result.skipped
          ? "Another dispatch run is already in progress."
          : `Sent ${result.sent}, requeued ${result.requeued}, failed ${result.failed}.`,
      );
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Dispatch failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell
      title="Invitations"
      description="Every invite is queued and drained in throttled batches, so a 150-person import behaves like one invite."
      actions={
        canCreate ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={dispatchNow}>
            Send queued now
          </Button>
        ) : null
      }
    >
      <div
        className={
          canCreate
            ? "grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]"
            : "grid gap-6"
        }
      >
        {canCreate ? (
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Invite someone</CardTitle>
            <CardDescription>They receive a link to set a password.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={invite} className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Work email</Label>
                <Input
                  type="email"
                  required
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Full name</Label>
                <Input
                  required
                  value={form.fullName}
                  onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Role</Label>
                <Select
                  value={form.role}
                  onValueChange={(value) => setForm({ ...form, role: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {APP_ROLES.map((role) => (
                      <SelectItem key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Category</Label>
                <Select
                  value={form.category}
                  onValueChange={(value) => setForm({ ...form, category: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {USER_CATEGORIES.map((category) => (
                      <SelectItem key={category} value={category}>
                        {CATEGORY_LABELS[category]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Designation</Label>
                <Input
                  value={form.designation}
                  onChange={(e) => setForm({ ...form, designation: e.target.value })}
                />
              </div>
              <div className="rounded-md border border-border/80 bg-muted/40 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Employee ID</span>
                  <Badge variant="secondary" className="font-mono text-xs font-semibold">
                    {nextIdPreview ?? "TAS-001"}
                  </Badge>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Preview only · Assigned automatically in sequence on account provisioning.
                </p>
              </div>
              <Button type="submit" disabled={busy} className="w-full">
                Add to queue
              </Button>
            </form>
          </CardContent>
        </Card>
        ) : null}

        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Invitee</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Attempts</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {invitations.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-3">
                      <p className="font-medium">{row.full_name ?? row.email}</p>
                      <p className="text-xs text-muted-foreground">{row.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline">{row.status}</Badge>
                      {row.last_error ? (
                        <p className="mt-1 max-w-[220px] truncate text-xs text-destructive">
                          {row.last_error}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground tabular-nums">
                      {row.attempts ?? 0}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {row.status === "failed" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            await requeueInvitation({ data: { id: row.id } });
                            await queryClient.invalidateQueries();
                          }}
                        >
                          Retry
                        </Button>
                      ) : null}
                      {row.status === "queued" || row.status === "sent" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            await revokeInvitation({ data: { id: row.id } });
                            await queryClient.invalidateQueries();
                          }}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {invitations.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-10 text-center text-muted-foreground">
                      No invitations yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
