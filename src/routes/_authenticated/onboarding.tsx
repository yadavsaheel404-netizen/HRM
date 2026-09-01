import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Upload, XCircle, Clock } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { getMyProfile, submitProfileForVerification, updateMyProfile } from "@/lib/workforce.functions";
import {
  createDocumentUploadUrl,
  listMyDocuments,
  registerDocument,
} from "@/lib/documents.functions";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ACCOUNT_STATUS_LABELS,
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  REQUIRED_DOCUMENT_TYPES,
  type DocumentType,
} from "@/lib/permissions";

export const Route = createFileRoute("/_authenticated/onboarding")({
  head: () => ({
    meta: [
      { title: "My Profile | The AI School HRM" },
      {
        name: "description",
        content:
          "Complete your employee profile and upload onboarding documents for HR verification.",
      },
      { property: "og:title", content: "My Profile | The AI School HRM" },
      { property: "og:description", content: "Employee onboarding and document upload." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: OnboardingPage,
});

function OnboardingPage() {
  const actor = useActor();
  const queryClient = useQueryClient();
  const { data: profile } = useSuspenseQuery({
    queryKey: ["my-profile"],
    queryFn: () => getMyProfile(),
  });

  const locked = actor.accountStatus === "under_verification";
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    fullName: profile?.full_name ?? "",
    personalEmail: profile?.personal_email ?? "",
    mobile: profile?.mobile ?? "",
    dateOfBirth: profile?.date_of_birth ?? "",
    currentAddress: profile?.current_address ?? "",
    permanentAddress: profile?.permanent_address ?? "",
    emergencyContactName: profile?.emergency_contact_name ?? "",
    emergencyContactPhone: profile?.emergency_contact_phone ?? "",
    skills: (profile?.skills ?? []).join(", "),
    institution: profile?.institution ?? "",
    experienceYears: profile?.experience_years?.toString() ?? "",
    availableHoursPerDay: profile?.available_hours_per_day?.toString() ?? "",
  });

  function set(key: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
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
            ? form.skills.split(",").map((s) => s.trim()).filter(Boolean)
            : [],
          institution: form.institution || null,
          experienceYears: form.experienceYears ? Number(form.experienceYears) : null,
          availableHoursPerDay: form.availableHoursPerDay
            ? Number(form.availableHoursPerDay)
            : null,
        },
      });
      toast.success("Profile saved.");
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save your profile.");
    } finally {
      setSaving(false);
    }
  }

  async function submit() {
    setSaving(true);
    try {
      const result = await submitProfileForVerification();
      if (!result.ok) {
        toast.error(`Still missing: ${result.missing.join(", ")}`);
        return;
      }
      toast.success("Sent to HR for verification.");
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not submit your profile.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell
      title="My profile"
      description="Employee record and onboarding documents"
      actions={<Badge variant="outline">{ACCOUNT_STATUS_LABELS[actor.accountStatus]}</Badge>}
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Personal details</CardTitle>
            <CardDescription>
              {locked
                ? "Your profile is locked while HR verifies it."
                : "HR verifies these details, so keep them accurate."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
              <Field label="Full name" required>
                <Input
                  value={form.fullName}
                  disabled={locked}
                  onChange={(e) => set("fullName", e.target.value)}
                  required
                />
              </Field>
              <Field label="Work email">
                <Input value={profile?.work_email ?? ""} disabled />
              </Field>
              <Field label="Employee ID">
                <Input
                  value={profile?.employee_code || "Assigned when your account is provisioned"}
                  disabled
                  className="font-mono font-medium"
                />
              </Field>
              <Field label="Personal email" required>
                <Input
                  type="email"
                  value={form.personalEmail}
                  disabled={locked}
                  onChange={(e) => set("personalEmail", e.target.value)}
                />
              </Field>
              <Field label="Mobile" required>
                <Input
                  value={form.mobile}
                  disabled={locked}
                  onChange={(e) => set("mobile", e.target.value)}
                />
              </Field>
              <Field label="Date of birth">
                <Input
                  type="date"
                  value={form.dateOfBirth}
                  disabled={locked}
                  onChange={(e) => set("dateOfBirth", e.target.value)}
                />
              </Field>
              <Field label="Institution / College">
                <Input
                  value={form.institution}
                  disabled={locked}
                  onChange={(e) => set("institution", e.target.value)}
                />
              </Field>
              <Field label="Years of experience">
                <Input
                  type="number"
                  min="0"
                  step="0.5"
                  value={form.experienceYears}
                  disabled={locked}
                  onChange={(e) => set("experienceYears", e.target.value)}
                />
              </Field>
              <Field label="Available hours per day">
                <Input
                  type="number"
                  min="1"
                  max="24"
                  value={form.availableHoursPerDay}
                  disabled={locked}
                  onChange={(e) => set("availableHoursPerDay", e.target.value)}
                />
              </Field>
              <Field label="Skills (comma separated)" className="sm:col-span-2">
                <Input
                  value={form.skills}
                  disabled={locked}
                  onChange={(e) => set("skills", e.target.value)}
                  placeholder="Python, Prompt engineering, Curriculum design"
                />
              </Field>
              <Field label="Current address" className="sm:col-span-2">
                <Textarea
                  rows={2}
                  value={form.currentAddress}
                  disabled={locked}
                  onChange={(e) => set("currentAddress", e.target.value)}
                />
              </Field>
              <Field label="Permanent address" className="sm:col-span-2">
                <Textarea
                  rows={2}
                  value={form.permanentAddress}
                  disabled={locked}
                  onChange={(e) => set("permanentAddress", e.target.value)}
                />
              </Field>
              <Field label="Emergency contact name">
                <Input
                  value={form.emergencyContactName}
                  disabled={locked}
                  onChange={(e) => set("emergencyContactName", e.target.value)}
                />
              </Field>
              <Field label="Emergency contact phone">
                <Input
                  value={form.emergencyContactPhone}
                  disabled={locked}
                  onChange={(e) => set("emergencyContactPhone", e.target.value)}
                />
              </Field>
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" disabled={saving || locked}>
                  Save details
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving || locked || actor.accountStatus === "active"}
                  onClick={submit}
                >
                  Submit for verification
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <DocumentsPanel locked={locked} />
      </div>
    </AppShell>
  );
}

function Field({
  label,
  children,
  required,
  className,
}: {
  label: string;
  children: React.ReactNode;
  required?: boolean;
  className?: string;
}) {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label className="text-xs font-medium text-muted-foreground">
        {label}
        {required ? <span className="ml-0.5 text-primary">*</span> : null}
      </Label>
      {children}
    </div>
  );
}

function DocumentsPanel({ locked }: { locked: boolean }) {
  const queryClient = useQueryClient();
  const { data: documents } = useSuspenseQuery({
    queryKey: ["my-documents"],
    queryFn: () => listMyDocuments(),
  });
  const [uploading, setUploading] = useState<string | null>(null);

  const byType = new Map(documents.map((d) => [d.doc_type, d]));

  async function upload(docType: DocumentType, file: File) {
    setUploading(docType);
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
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setUploading(null);
    }
  }

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle className="text-base">Documents</CardTitle>
        <CardDescription>
          Stored privately. Only you and HR verifiers can open these files.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {DOCUMENT_TYPES.map((docType) => {
          const doc = byType.get(docType);
          const required = REQUIRED_DOCUMENT_TYPES.includes(docType);
          return (
            <div
              key={docType}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {DOCUMENT_TYPE_LABELS[docType]}
                  {required ? <span className="ml-1 text-primary">*</span> : null}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {doc ? doc.file_name : "Not uploaded"}
                </p>
                {doc?.status === "rejected" && doc.review_note ? (
                  <p className="truncate text-xs text-destructive">{doc.review_note}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {doc ? <StatusIcon status={doc.status} /> : null}
                {!locked ? (
                  <label className="cursor-pointer">
                    <input
                      type="file"
                      className="sr-only"
                      accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void upload(docType, file);
                        e.target.value = "";
                      }}
                    />
                    <span className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs hover:bg-accent">
                      <Upload className="size-3" />
                      {uploading === docType ? "…" : doc ? "Replace" : "Upload"}
                    </span>
                  </label>
                ) : null}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "verified") return <CheckCircle2 className="size-4 text-success" />;
  if (status === "rejected") return <XCircle className="size-4 text-destructive" />;
  return <Clock className="size-4 text-muted-foreground" />;
}
