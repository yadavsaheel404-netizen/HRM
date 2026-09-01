import { createFileRoute, useParams } from "@tanstack/react-router";
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Copy, KeyRound, Mail, ShieldAlert } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import {
  getWorkforceMember,
  reviewProfile,
  sendEmployeePasswordResetEmail,
  setEmployeeTemporaryPassword,
} from "@/lib/workforce.functions";
import { getDocumentDownloadUrl, reviewDocument } from "@/lib/documents.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  ACCOUNT_STATUS_LABELS,
  CATEGORY_LABELS,
  DOCUMENT_TYPE_LABELS,
  ROLE_LABELS,
  type AccountStatus,
  type AppRole,
  type DocumentType,
  type UserCategory,
} from "@/lib/permissions";

export const Route = createFileRoute("/_authenticated/workforce/$personId")({
  head: () => ({
    meta: [
      { title: "Employee record | The AI School HRM" },
      {
        name: "description",
        content: "Employee profile, documents and HR verification actions.",
      },
      { property: "og:title", content: "Employee record | The AI School HRM" },
      { property: "og:description", content: "Profile details and document verification." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: PersonPage,
});

function PersonPage() {
  const { personId } = useParams({ from: "/_authenticated/workforce/$personId" });
  const actor = useActor();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // Password reset dialog state
  const [showResetEmailDialog, setShowResetEmailDialog] = useState(false);
  const [showTempPassDialog, setShowTempPassDialog] = useState(false);
  const [customTempPass, setCustomTempPass] = useState("");
  const [generatedTempPass, setGeneratedTempPass] = useState<string | null>(null);

  const { data } = useSuspenseQuery({
    queryKey: ["workforce-member", personId],
    queryFn: () => getWorkforceMember({ data: { id: personId } }),
  });

  const canVerify = actor.can("documents:verify:all");
  const canResetPassword = actor.can("workforce:update:all");
  const isSuperAdmin = actor.roles.includes("super_admin");
  const profile = data.profile;

  async function handleSendResetEmail() {
    setBusy(true);
    try {
      const res = await sendEmployeePasswordResetEmail({ data: { userId: personId } });
      toast.success(`Password reset email sent to ${res.email}.`);
      setShowResetEmailDialog(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send reset email.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSetTemporaryPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await setEmployeeTemporaryPassword({
        data: { userId: personId, temporaryPassword: customTempPass.trim() || undefined },
      });
      setGeneratedTempPass(res.temporaryPassword);
      setCustomTempPass("");
      toast.success("Temporary password set successfully.");
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to set temporary password.");
    } finally {
      setBusy(false);
    }
  }

  async function decide(approve: boolean) {
    setBusy(true);
    try {
      await reviewProfile({
        data: note ? { userId: personId, approve, note } : { userId: personId, approve },
      });
      toast.success(approve ? "Profile verified." : "Sent back for changes.");
      setNote("");
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save that decision.");
    } finally {
      setBusy(false);
    }
  }

  async function openDocument(documentId: string) {
    try {
      const { url } = await getDocumentDownloadUrl({ data: { documentId } });
      window.open(url, "_blank", "noopener");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open that document.");
    }
  }

  async function decideDocument(documentId: string, approve: boolean) {
    try {
      await reviewDocument({ data: { documentId, approve } });
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not review that document.");
    }
  }

  return (
    <AppShell
      title={profile.full_name}
      description={profile.work_email}
      actions={
        <Badge variant="outline">
          {ACCOUNT_STATUS_LABELS[profile.account_status as AccountStatus]}
        </Badge>
      }
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Profile</CardTitle>
            <CardDescription>
              {data.roles.map((r) => ROLE_LABELS[r as AppRole] ?? r).join(", ") || "No role"} ·{" "}
              {CATEGORY_LABELS[profile.category as UserCategory] ?? "—"}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Detail
              label="Employee ID"
              value={profile.employee_code ?? "Pending Assignment"}
              className="font-mono"
            />
            <Detail label="Designation" value={profile.designation} />
            <Detail label="Personal email" value={profile.personal_email} />
            <Detail label="Mobile" value={profile.mobile} />
            <Detail label="Date of birth" value={profile.date_of_birth} />
            <Detail label="Institution" value={profile.institution} />
            <Detail
              label="Experience"
              value={profile.experience_years ? `${profile.experience_years} yrs` : null}
            />
            <Detail
              label="Available hours / day"
              value={profile.available_hours_per_day?.toString() ?? null}
            />
            <Detail label="Emergency contact" value={profile.emergency_contact_name} />
            <Detail label="Emergency phone" value={profile.emergency_contact_phone} />
            <Detail
              label="Skills"
              value={(profile.skills ?? []).join(", ") || null}
              className="sm:col-span-2"
            />
            <Detail
              label="Current address"
              value={profile.current_address}
              className="sm:col-span-2"
            />
          </CardContent>
        </Card>

        <div className="space-y-6">
          {/* Password & Security Card */}
          {canResetPassword ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <KeyRound className="size-4 text-primary" /> Password &amp; Security
                </CardTitle>
                <CardDescription>Manage password recovery and access credentials.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Option A: HR / Admin / Super Admin */}
                <div className="rounded-md border p-3">
                  <p className="text-sm font-medium">Option A · Reset link email</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Sends a secure reset link to {profile.work_email}. Employee sets their own
                    password.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3 w-full"
                    disabled={busy}
                    onClick={() => setShowResetEmailDialog(true)}
                  >
                    <Mail className="mr-1.5 size-3.5" /> Send reset email
                  </Button>
                </div>

                {/* Option B: Super Admin Only */}
                {isSuperAdmin ? (
                  <div className="rounded-md border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-900/40 dark:bg-amber-950/20">
                    <p className="flex items-center gap-1.5 text-sm font-medium text-amber-900 dark:text-amber-200">
                      <ShieldAlert className="size-4 text-amber-600 dark:text-amber-400" /> Option B · Set temporary password
                    </p>
                    <p className="mt-0.5 text-xs text-amber-800/80 dark:text-amber-300/70">
                      Super Admin override. Employee will be forced to change it on next login.
                    </p>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-3 w-full"
                      disabled={busy}
                      onClick={() => {
                        setGeneratedTempPass(null);
                        setShowTempPassDialog(true);
                      }}
                    >
                      <KeyRound className="mr-1.5 size-3.5" /> Set temporary password
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Documents</CardTitle>
              <CardDescription>{data.documents.length} uploaded</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.documents.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing uploaded yet.</p>
              ) : null}
              {data.documents.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {DOCUMENT_TYPE_LABELS[doc.doc_type as DocumentType] ?? doc.doc_type}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{doc.status}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openDocument(doc.id)}>
                      Open
                    </Button>
                    {canVerify ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => decideDocument(doc.id, true)}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => decideDocument(doc.id, false)}
                        >
                          Reject
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {canVerify ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Verification decision</CardTitle>
                <CardDescription>
                  Approving activates the account for project allocation.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional note shown to the employee"
                />
                <div className="flex gap-2">
                  <Button disabled={busy} onClick={() => decide(true)}>
                    Verify &amp; activate
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => decide(false)}>
                    Send back
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      {/* Confirmation Dialog: Send Password Reset Email */}
      <AlertDialog open={showResetEmailDialog} onOpenChange={setShowResetEmailDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send password reset link?</AlertDialogTitle>
            <AlertDialogDescription>
              A password reset link will be sent to <strong>{profile.work_email}</strong> via
              Supabase Auth. The employee will click the link to choose their own new password.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={handleSendResetEmail}>
              {busy ? "Sending…" : "Send reset email"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Dialog: Set Temporary Password (Super Admin) */}
      <Dialog open={showTempPassDialog} onOpenChange={setShowTempPassDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set temporary password</DialogTitle>
            <DialogDescription>
              Override credentials for <strong>{profile.full_name}</strong> ({profile.work_email}).
            </DialogDescription>
          </DialogHeader>

          {generatedTempPass ? (
            <div className="space-y-4 pt-2">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-4 dark:border-emerald-900/40 dark:bg-emerald-950/20">
                <p className="text-xs font-semibold uppercase text-emerald-800 dark:text-emerald-300">
                  Temporary password assigned
                </p>
                <div className="mt-2 flex items-center justify-between rounded border bg-background px-3 py-2">
                  <code className="font-mono text-base font-bold text-foreground">
                    {generatedTempPass}
                  </code>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      navigator.clipboard.writeText(generatedTempPass);
                      toast.success("Copied temporary password to clipboard.");
                    }}
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Share this password with the employee. They will be forced to change it on their
                  next login. For security, this value is never stored or logged.
                </p>
              </div>
              <DialogFooter>
                <Button onClick={() => setShowTempPassDialog(false)}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={handleSetTemporaryPassword} className="space-y-4 pt-2">
              <div className="space-y-1.5">
                <Label htmlFor="custom-temp" className="text-xs">
                  Custom temporary password (optional)
                </Label>
                <Input
                  id="custom-temp"
                  value={customTempPass}
                  onChange={(e) => setCustomTempPass(e.target.value)}
                  placeholder="Leave empty to auto-generate secure code"
                />
                <p className="text-[11px] text-muted-foreground">
                  If left empty, a secure code like <code>TAS-Temp-XXXX</code> will be generated.
                </p>
              </div>

              <DialogFooter className="gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setShowTempPassDialog(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Applying…" : "Set password & enforce change"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

function Detail({
  label,
  value,
  className,
}: {
  label: string;
  value?: string | null;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value || "—"}</p>
    </div>
  );
}
