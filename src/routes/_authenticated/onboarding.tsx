import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import {
  EmploymentDetailsSection,
  PersonalInfoSection,
  ProfileIdentityHeader,
  ReportingStructureSection,
  SelfDocumentsSection,
  SelfSecuritySection,
  WorkAssignmentsSection,
  type PersonalFormValues,
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
import { Badge } from "@/components/ui/badge";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { useNotificationFocus } from "@/hooks/use-notification-focus";
import { supabase } from "@/integrations/supabase/client";
import {
  createDocumentUploadUrl,
  listMyDocuments,
  registerDocument,
} from "@/lib/documents.functions";
import {
  ACCOUNT_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
  type DocumentType,
} from "@/lib/permissions";
import {
  changeMyPassword,
  getMyUnifiedProfile,
  submitProfileForVerification,
  updateMyProfile,
} from "@/lib/workforce.functions";

export const Route = createFileRoute("/_authenticated/onboarding")({
  head: () => ({
    meta: [
      { title: "My Profile | The AI School HRM" },
      {
        name: "description",
        content:
          "Unified employee profile, reporting hierarchy, assignments, onboarding documents, and security settings.",
      },
      { property: "og:title", content: "My Profile | The AI School HRM" },
      { property: "og:description", content: "Unified profile and onboarding workspace." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: OnboardingPage,
});

function buildPersonalForm(profile: {
  full_name: string | null;
  personal_email: string | null;
  mobile: string | null;
  date_of_birth: string | null;
  current_address: string | null;
  permanent_address: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  skills: string[] | null;
  institution: string | null;
  experience_years: number | null;
}): PersonalFormValues {
  return {
    fullName: profile.full_name ?? "",
    personalEmail: profile.personal_email ?? "",
    mobile: profile.mobile ?? "",
    dateOfBirth: profile.date_of_birth ?? "",
    currentAddress: profile.current_address ?? "",
    permanentAddress: profile.permanent_address ?? "",
    emergencyContactName: profile.emergency_contact_name ?? "",
    emergencyContactPhone: profile.emergency_contact_phone ?? "",
    skills: (profile.skills ?? []).join(", "),
    institution: profile.institution ?? "",
    experienceYears: profile.experience_years?.toString() ?? "",
  };
}

function OnboardingPage() {
  const actor = useActor();
  const search = useSearch({ strict: false }) as { section?: string; filter?: string; docId?: string };
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery({
    queryKey: ["my-unified-profile", actor.userId],
    queryFn: () => getMyUnifiedProfile(),
  });

  const profile = data.profile;
  const canEditSelf = actor.can("workforce:update:self");
  const canUploadSelf = actor.can("documents:upload:self") && !data.isExecutiveGovernance;
  const isFounderOnly =
    actor.roles.includes("founder") && !actor.roles.some((r) => r !== "founder");
  const locked = actor.accountStatus === "under_verification" || !canEditSelf;

  const docsQuery = useQuery({
    queryKey: ["my-documents"],
    queryFn: () => listMyDocuments(),
    enabled: canUploadSelf,
  });

  useNotificationFocus(
    search.docId ||
      (search.filter === "rejected"
        ? "doc-rejected"
        : search.section
          ? `section-${search.section}`
          : null),
    { ready: !canUploadSelf || !docsQuery.isPending },
  );

  const [savingPersonal, setSavingPersonal] = useState(false);
  const [submittingVerification, setSubmittingVerification] = useState(false);
  const [confirmSubmitOpen, setConfirmSubmitOpen] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [uploadingDoc, setUploadingDoc] = useState<string | null>(null);

  const [form, setForm] = useState<PersonalFormValues>(() => buildPersonalForm(profile));
  const savedSnapshot = buildPersonalForm(profile);
  const hasUnsavedChanges = (Object.keys(form) as (keyof PersonalFormValues)[]).some(
    (k) => form[k] !== savedSnapshot[k],
  );

  function handleFormChange(key: keyof PersonalFormValues, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function savePersonal(e: React.FormEvent) {
    e.preventDefault();
    setSavingPersonal(true);
    try {
      await updateMyProfile({
        data: {
          fullName: form.fullName,
          personalEmail: form.personalEmail || null,
          mobile: form.mobile || null,
          dateOfBirth: form.dateOfBirth || null,
          currentAddress: form.currentAddress || null,
          permanentAddress: form.permanentAddress || null,
          emergencyContactName: form.emergencyContactName || null,
          emergencyContactPhone: form.emergencyContactPhone || null,
          skills: form.skills
            ? form.skills
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
          institution: form.institution || null,
          experienceYears: form.experienceYears ? Number(form.experienceYears) : null,
        },
      });
      toast.success("Personal details saved.");
      await queryClient.invalidateQueries({ queryKey: ["my-unified-profile", actor.userId] });
      await queryClient.invalidateQueries({ queryKey: ["actor"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save your profile.");
    } finally {
      setSavingPersonal(false);
    }
  }

  async function submitVerification() {
    setSubmittingVerification(true);
    try {
      const result = await submitProfileForVerification();
      if (!result.ok) {
        toast.error(`Still missing: ${result.missing.join(", ")}`);
        return;
      }
      setConfirmSubmitOpen(false);
      toast.success("Profile submitted to HR for verification.");
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not submit your profile.");
    } finally {
      setSubmittingVerification(false);
    }
  }

  async function handleUploadDocument(docType: DocumentType, file: File) {
    setUploadingDoc(docType);
    try {
      const { path, token } = await createDocumentUploadUrl({
        data: { docType, fileName: file.name },
      });
      const { error } = await supabase.storage
        .from("employee-documents")
        .uploadToSignedUrl(path, token, file);
      if (error) throw error;
      await registerDocument({ data: { docType, path, fileName: file.name } });
      toast.success(`${DOCUMENT_TYPE_LABELS[docType]} uploaded.`);
      await queryClient.invalidateQueries({ queryKey: ["my-documents"] });
      await queryClient.invalidateQueries({ queryKey: ["role-dashboard", actor.userId] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setUploadingDoc(null);
    }
  }

  async function handleChangePassword(newPassword: string): Promise<boolean> {
    setChangingPassword(true);
    try {
      await changeMyPassword({ data: { newPassword } });
      toast.success("Your password has been updated.");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update password.");
      return false;
    } finally {
      setChangingPassword(false);
    }
  }

  return (
    <AppShell
      title="My Profile"
      description="Unified personal details, employment classification, reporting line, work assignments, documents, and security."
      actions={
        !data.isExecutiveGovernance ? (
          <Badge variant={actor.accountStatus === "active" ? "success" : "warning"}>
            {ACCOUNT_STATUS_LABELS[actor.accountStatus]}
          </Badge>
        ) : undefined
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

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-6">
            <PersonalInfoSection
              mode="self"
              profile={profile}
              canEditSelf={canEditSelf}
              locked={locked}
              saving={savingPersonal}
              submittingVerification={submittingVerification}
              isExecutiveGovernance={data.isExecutiveGovernance}
              form={form}
              onFormChange={handleFormChange}
              onSave={savePersonal}
              onSubmitForVerification={() => setConfirmSubmitOpen(true)}
            />

            <EmploymentDetailsSection
              profile={profile}
              departmentName={data.department?.name ?? null}
              roles={data.roles}
            />

            <ReportingStructureSection
              department={data.department}
              reportingLead={data.reportingLead}
              managedDepartments={data.managedDepartments}
              directReportsCount={data.directReportsCount}
              missingReportingLead={data.missingReportingLead}
              canLinkProfiles={
                actor.can("workforce:read:all") || actor.can("workforce:read:team")
              }
            />

            <WorkAssignmentsSection
              allocations={data.allocations}
              isExecutiveGovernance={data.isExecutiveGovernance}
              isSelf
            />
          </div>

          <div className="space-y-6">
            {canUploadSelf && (
              <SelfDocumentsSection
                documents={docsQuery.data ?? []}
                locked={locked}
                uploadingDocType={uploadingDoc}
                isLoading={docsQuery.isPending}
                isError={docsQuery.isError}
                onRetry={() => void docsQuery.refetch()}
                onUploadFile={handleUploadDocument}
              />
            )}

            <SelfSecuritySection
              workEmail={profile.work_email}
              readOnlyExecutive={isFounderOnly}
              busy={changingPassword}
              onChangePassword={handleChangePassword}
            />
          </div>
        </div>
      </div>

      <AlertDialog open={confirmSubmitOpen} onOpenChange={setConfirmSubmitOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Submit profile for HR verification?</AlertDialogTitle>
            <AlertDialogDescription>
              {hasUnsavedChanges
                ? "You have unsaved edits in your Personal Information form. Please click 'Save personal details' first before submitting, otherwise only previously saved fields will be verified."
                : "Submitting locks your personal details and KYC document uploads while HR reviews your onboarding submission."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submittingVerification}>Cancel</AlertDialogCancel>
            {!hasUnsavedChanges && (
              <AlertDialogAction
                disabled={submittingVerification}
                onClick={(e) => {
                  e.preventDefault();
                  void submitVerification();
                }}
              >
                {submittingVerification ? "Submitting…" : "Submit & lock profile"}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}
