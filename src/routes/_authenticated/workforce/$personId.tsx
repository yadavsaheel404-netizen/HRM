import { createFileRoute, Link, useParams, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ArrowLeft, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import {
  DirectoryDocumentsSection,
  DirectorySecuritySection,
  EmploymentDetailsSection,
  PersonalInfoSection,
  ProfileIdentityHeader,
  ReportingStructureSection,
  WorkAssignmentsSection,
  type EmploymentFormValues,
} from "@/components/profile/unified-profile-sections";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { useNotificationFocus } from "@/hooks/use-notification-focus";
import { getDocumentDownloadUrl, reviewDocument } from "@/lib/documents.functions";
import { KycNotificationPanel } from "@/components/profile/kyc-notification-panel";
import {
  assignableRolesFor,
  canModifyUserRoles,
  type AppRole,
  type EmploymentStatus,
  type UserCategory,
} from "@/lib/permissions";
import { setUserRoles } from "@/lib/rbac.functions";
import {
  getOrgReference,
  getWorkforceMember,
  reviewProfile,
  sendEmployeePasswordResetEmail,
  setEmployeeTemporaryPassword,
  setEmployeeWorkType,
  updateEmploymentDetails,
} from "@/lib/workforce.functions";
import { WorkTypeSection } from "@/components/profile/work-type-section";
import type { WorkType } from "@/lib/work-type";

export const Route = createFileRoute("/_authenticated/workforce/$personId")({
  head: () => ({
    meta: [
      { title: "Employee Profile | The AI School HRM" },
      {
        name: "description",
        content: "Unified employee profile, reporting hierarchy, assignments, KYC, and security.",
      },
      { property: "og:title", content: "Employee Profile | The AI School HRM" },
      { property: "og:description", content: "Unified employee profile and governance." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: PersonPage,
});

type WorkforceMemberResult = Awaited<ReturnType<typeof getWorkforceMember>>;

function PersonPage() {
  const { personId } = useParams({ from: "/_authenticated/workforce/$personId" });
  const search = useSearch({ strict: false }) as { section?: string; docId?: string };
  const { data } = useSuspenseQuery({
    queryKey: ["workforce-member", personId],
    queryFn: () => getWorkforceMember({ data: { id: personId } }),
  });

  useNotificationFocus(
    search.docId || (search.section ? `section-${search.section}` : null),
  );

  // Keying by personId guarantees fresh form, role, and dialog state when navigating
  // between employee profiles (e.g. clicking a Reporting Lead link).
  return <PersonProfileContent key={personId} personId={personId} data={data} />;
}

function PersonProfileContent({
  personId,
  data,
}: {
  personId: string;
  data: WorkforceMemberResult;
}) {
  const actor = useActor();
  const queryClient = useQueryClient();
  const [verificationNote, setVerificationNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [openingDocId, setOpeningDocId] = useState<string | null>(null);

  // Password reset dialog state
  const [showResetEmailDialog, setShowResetEmailDialog] = useState(false);
  const [showTempPassDialog, setShowTempPassDialog] = useState(false);
  const [customTempPass, setCustomTempPass] = useState("");
  const [generatedTempPass, setGeneratedTempPass] = useState<string | null>(null);

  const profile = data.profile;
  const canVerify =
    actor.can("documents:verify:all") &&
    (actor.roles.includes("hr") || actor.roles.includes("super_admin"));
  const canUpdateWorkforce = actor.can("workforce:update:all");
  const canAssignRbac = actor.can("rbac:assign:all");
  const canResetPassword = canUpdateWorkforce;
  const isSuperAdmin = actor.roles.includes("super_admin");
  const isFounderViewer =
    actor.roles.includes("founder") && !actor.roles.some((r) => r !== "founder");
  const showKycStatusBadgeOnly =
    !data.canSeeDocuments &&
    (actor.roles.includes("admin") || actor.roles.includes("founder"));

  const orgRefQuery = useQuery({
    queryKey: ["org-reference"],
    queryFn: () => getOrgReference(),
    enabled: canUpdateWorkforce,
  });
  const orgRef = orgRefQuery.data;

  const [employmentForm, setEmploymentForm] = useState<EmploymentFormValues>(() => ({
    designation: profile.designation ?? "",
    category: (profile.category as UserCategory) ?? "full_time",
    departmentId: profile.department_id ?? "",
    reportingLeadId: profile.reporting_lead_id ?? "",
    employmentStatus: (profile.employment_status as EmploymentStatus) ?? "active",
    joiningDate: profile.joining_date ?? "",
    workLocation: profile.work_location ?? "",
    availableHoursPerDay: profile.available_hours_per_day?.toString() ?? "8",
    internshipStart: profile.internship_start ?? "",
    internshipEnd: profile.internship_end ?? "",
  }));

  const [selectedRoles, setSelectedRoles] = useState<AppRole[]>(
    () => ((data.roles as AppRole[]) ?? ["employee"]).filter((r) => r !== "super_admin"),
  );

  const allowedRolesToAssign = assignableRolesFor(actor.roles).filter((r) => r !== "super_admin");
  const canEditTargetRoles =
    canAssignRbac &&
    actor.userId !== personId &&
    canModifyUserRoles(actor.roles, data.roles);

  function handleEmploymentFormChange(patch: Partial<EmploymentFormValues>) {
    setEmploymentForm((prev) => ({ ...prev, ...patch }));
  }

  function handleToggleRole(role: AppRole, checked: boolean) {
    if (role === "super_admin") return;
    setSelectedRoles((prev) =>
      checked ? [...new Set([...prev, role])] : prev.filter((r) => r !== role),
    );
  }

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
      await queryClient.invalidateQueries({ queryKey: ["workforce-member", personId] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to set temporary password.");
    } finally {
      setBusy(false);
    }
  }

  async function decideProfile(approve: boolean) {
    setBusy(true);
    try {
      await reviewProfile({
        data: verificationNote
          ? { userId: personId, approve, note: verificationNote }
          : { userId: personId, approve },
      });
      toast.success(approve ? "Profile verified." : "Sent back for changes.");
      setVerificationNote("");
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save that decision.");
    } finally {
      setBusy(false);
    }
  }

  async function openDocument(documentId: string) {
    setOpeningDocId(documentId);
    try {
      const { url } = await getDocumentDownloadUrl({ data: { documentId } });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open that document.");
    } finally {
      setOpeningDocId(null);
    }
  }

  async function decideDocument(documentId: string, approve: boolean, rejectReason?: string) {
    setBusy(true);
    try {
      const cleanNote = rejectReason?.trim();
      await reviewDocument({
        data: cleanNote ? { documentId, approve, note: cleanNote } : { documentId, approve },
      });
      toast.success(approve ? "Document approved." : "Document rejected.");
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not review that document.");
    } finally {
      setBusy(false);
    }
  }

  async function saveEmployment(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await updateEmploymentDetails({
        data: {
          userId: personId,
          designation: employmentForm.designation.trim() || null,
          category: employmentForm.category,
          departmentId: employmentForm.departmentId || null,
          reportingLeadId: employmentForm.reportingLeadId || null,
          employmentStatus: employmentForm.employmentStatus,
          joiningDate: employmentForm.joiningDate || null,
          workLocation: employmentForm.workLocation.trim() || null,
          availableHoursPerDay: employmentForm.availableHoursPerDay
            ? Number(employmentForm.availableHoursPerDay)
            : null,
          internshipStart:
            employmentForm.category === "intern"
              ? employmentForm.internshipStart || null
              : null,
          internshipEnd:
            employmentForm.category === "intern" ? employmentForm.internshipEnd || null : null,
        },
      });
      toast.success("Employment details updated.");
      await queryClient.invalidateQueries({ queryKey: ["workforce-member", personId] });
      await queryClient.invalidateQueries({ queryKey: ["workforce"] });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not update employment details.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveWorkType(next: WorkType | null, reason: string) {
    setBusy(true);
    try {
      const res = await setEmployeeWorkType({
        data: { userId: personId, workType: next, reason: reason.trim() || null },
      });
      toast.success(res.unchanged ? "Work type unchanged." : "Work type updated and audited.");
      await queryClient.invalidateQueries({ queryKey: ["workforce-member", personId] });
      await queryClient.invalidateQueries({ queryKey: ["workforce"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the work type.");
    } finally {
      setBusy(false);
    }
  }

  async function saveRoles() {
    if (selectedRoles.length === 0) {
      toast.error("At least one role is required.");
      return;
    }
    setBusy(true);
    try {
      const rolesToSave = selectedRoles.filter((r) => r !== "super_admin");
      if (rolesToSave.length === 0) {
        toast.error("At least one role is required.");
        return;
      }
      await setUserRoles({
        data: {
          userId: personId,
          roles: rolesToSave,
        },
      });
      toast.success("Authorization roles updated and recorded in audit trail.");
      await queryClient.invalidateQueries({ queryKey: ["workforce-member", personId] });
      await queryClient.invalidateQueries({ queryKey: ["workforce"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update roles.");
    } finally {
      setBusy(false);
    }
  }

  const hasRightColumn =
    data.canSeeDocuments || showKycStatusBadgeOnly || canResetPassword;

  return (
    <AppShell
      title={profile.full_name}
      description={profile.work_email}
      actions={
        <Button asChild variant="outline" size="sm">
          <Link to="/workforce">
            <ArrowLeft className="mr-1.5 size-3.5" aria-hidden="true" />
            Directory
          </Link>
        </Button>
      }
    >
      <div className="space-y-6">
        <ProfileIdentityHeader
          fullName={profile.full_name}
          workEmail={profile.work_email}
          employeeCode={profile.employee_code}
          photoUrl={profile.photo_url}
          designation={profile.designation}
          departmentName={data.department?.name ?? null}
          category={profile.category}
          accountStatus={profile.account_status}
          employmentStatus={profile.employment_status}
          roles={data.roles}
          isExecutiveGovernance={data.isExecutiveGovernance}
        />

        <div
          className={
            hasRightColumn
              ? "grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]"
              : "space-y-6"
          }
        >
          <div className="space-y-6">
            <PersonalInfoSection
              mode="directory"
              profile={profile}
              canSeeSensitivePii={data.canSeeSensitivePii}
              isFounderViewer={isFounderViewer}
            />

            <EmploymentDetailsSection
              profile={profile}
              departmentName={data.department?.name ?? null}
              roles={data.roles}
              canUpdateWorkforce={canUpdateWorkforce}
              canEditTargetRoles={canEditTargetRoles}
              allowedRolesToAssign={allowedRolesToAssign}
              busy={busy}
              orgRefLoading={orgRefQuery.isLoading}
              departments={orgRef?.departments ?? []}
              people={orgRef?.people ?? []}
              personId={personId}
              employmentForm={employmentForm}
              onEmploymentFormChange={handleEmploymentFormChange}
              onSaveEmployment={saveEmployment}
              selectedRoles={selectedRoles}
              onToggleRole={handleToggleRole}
              onSaveRoles={saveRoles}
            />

            <ReportingStructureSection
              department={data.department}
              reportingLead={data.reportingLead}
              managedDepartments={data.managedDepartments}
              directReportsCount={data.directReportsCount}
              missingReportingLead={data.missingReportingLead}
              canLinkProfiles
            />

            {!data.isExecutiveGovernance ? (
              <WorkTypeSection
                workType={data.workType}
                annotation={data.annotation}
                reportingLeadName={data.reportingLead?.fullName ?? null}
                busy={busy}
                onSave={saveWorkType}
              />
            ) : null}

            <WorkAssignmentsSection
              allocations={data.allocations as never}
              isExecutiveGovernance={data.isExecutiveGovernance}
            />
          </div>

          {hasRightColumn ? (
            <div className="space-y-6">
              <DirectoryDocumentsSection
                canSeeDocuments={data.canSeeDocuments}
                showKycStatusBadgeOnly={showKycStatusBadgeOnly}
                accountStatus={profile.account_status}
                documents={data.documents}
                canVerify={canVerify}
                busy={busy}
                openingDocId={openingDocId}
                onOpenDocument={openDocument}
                onDecideDocument={decideDocument}
                verificationNote={verificationNote}
                onVerificationNoteChange={setVerificationNote}
                onDecideProfile={decideProfile}
              />

              {canVerify && data.canSeeDocuments && actor.userId !== personId ? (
                <KycNotificationPanel userId={personId} />
              ) : null}

              <DirectorySecuritySection
                workEmail={profile.work_email}
                canResetPassword={canResetPassword}
                isSuperAdmin={isSuperAdmin}
                busy={busy}
                onOpenResetEmailDialog={() => setShowResetEmailDialog(true)}
                onOpenTempPasswordDialog={() => {
                  setGeneratedTempPass(null);
                  setShowTempPassDialog(true);
                }}
              />
            </div>
          ) : null}
        </div>
      </div>

      <AlertDialog open={showResetEmailDialog} onOpenChange={setShowResetEmailDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send password reset link?</AlertDialogTitle>
            <AlertDialogDescription>
              A password reset link will be sent to <strong>{profile.work_email}</strong>. The
              employee will use it to choose their own new password.
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
                    aria-label="Copy temporary password"
                    onClick={() => {
                      void navigator.clipboard.writeText(generatedTempPass);
                      toast.success("Copied temporary password to clipboard.");
                    }}
                  >
                    <Copy className="size-4" aria-hidden="true" />
                  </Button>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Share this password with the employee offline. They must change it on their next
                  login. This value is never stored or logged.
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
                  placeholder="Leave empty to auto-generate a secure password"
                />
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

