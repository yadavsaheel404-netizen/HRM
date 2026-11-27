import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Briefcase,
  Building2,
  Check,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  FileText,
  KeyRound,
  Mail,
  Network,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Upload,
  UserCircle2,
  XCircle,
} from "lucide-react";
import { useId, useState } from "react";
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
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { evaluatePasswordPolicy } from "@/lib/password-policy";
import {
  ACCOUNT_STATUS_LABELS,
  APP_ROLES,
  CATEGORY_LABELS,
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  EMPLOYMENT_STATUSES,
  REQUIRED_DOCUMENT_TYPES,
  ROLE_LABELS,
  USER_CATEGORIES,
  type AccountStatus,
  type AppRole,
  type DocumentType,
  type EmploymentStatus,
  type UserCategory,
} from "@/lib/permissions";

export type UnifiedAllocationItem = {
  id: string;
  project_id: string;
  role_in_project: string | null;
  start_date: string;
  end_date: string | null;
  hours_per_day: number | null;
  allocation_pct: number;
  daily_task_target: number | null;
  status: string;
  acknowledged_at: string | null;
  projects: unknown;
};

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function DetailItem({
  label,
  value,
  mono = false,
  redacted = false,
  className = "",
}: {
  label: string;
  value?: string | number | null | undefined;
  mono?: boolean | undefined;
  redacted?: boolean | undefined;
  className?: string | undefined;
}) {
  return (
    <div className={`min-w-0 space-y-1 ${className}`}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {redacted ? (
        <p className="inline-flex items-center gap-1 text-xs italic text-muted-foreground">
          <EyeOff className="size-3 shrink-0" aria-hidden="true" /> Restricted to HR &amp; Super
          Admin
        </p>
      ) : (
        <p
          className={`break-words text-sm font-medium text-foreground ${mono ? "font-mono" : ""}`}
        >
          {value !== null && value !== undefined && String(value).trim() !== ""
            ? value
            : "—"}
        </p>
      )}
    </div>
  );
}

/* ============================================================================
 * 0. UNIFIED PROFILE IDENTITY HEADER
 * ========================================================================== */
export function ProfileIdentityHeader({
  fullName,
  workEmail,
  employeeCode,
  photoUrl,
  designation,
  departmentName,
  category,
  accountStatus,
  employmentStatus,
  roles,
  isExecutiveGovernance,
}: {
  fullName: string;
  workEmail: string;
  employeeCode: string | null;
  photoUrl?: string | null | undefined;
  designation?: string | null | undefined;
  departmentName?: string | null | undefined;
  category: string;
  accountStatus: string;
  employmentStatus: string;
  roles: readonly string[];
  isExecutiveGovernance: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col justify-between gap-4 py-5 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-start gap-4 sm:items-center">
          {photoUrl ? (
            <img
              src={photoUrl}
              alt={fullName}
              className="size-14 shrink-0 rounded-full border border-border object-cover"
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary/12 font-display text-lg font-bold text-primary"
            >
              {initialsOf(fullName) || "AI"}
            </div>
          )}
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-xl font-bold tracking-tight text-foreground">
                {fullName}
              </h2>
              <Badge variant="outline" className="font-mono text-xs">
                {employeeCode ?? "ID Pending"}
              </Badge>
            </div>
            <p className="break-words text-sm text-muted-foreground">
              {designation || (isExecutiveGovernance ? "Executive Governance" : "Team Member")}
              {departmentName ? ` · ${departmentName}` : ""} · {workEmail}
            </p>
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {roles
                .filter((r) => r !== "super_admin")
                .map((r) => (
                  <Badge key={r} variant="default" className="text-[11px]">
                    {ROLE_LABELS[r as AppRole] ?? r}
                  </Badge>
                ))}
              {!isExecutiveGovernance && (
                <Badge variant="secondary" className="text-[11px]">
                  {CATEGORY_LABELS[category as UserCategory] ?? category}
                </Badge>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!isExecutiveGovernance && (
            <Badge
              variant={
                accountStatus === "active"
                  ? "success"
                  : accountStatus === "under_verification" || accountStatus === "profile_pending"
                    ? "warning"
                    : "info"
              }
            >
              {ACCOUNT_STATUS_LABELS[accountStatus as AccountStatus] ?? accountStatus}
            </Badge>
          )}
          <Badge variant={employmentStatus === "active" ? "success" : "warning"}>
            {employmentStatus.replace(/_/g, " ").toUpperCase()}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}

/* ============================================================================
 * SECTION 1 — PERSONAL INFORMATION
 * ========================================================================== */
export type PersonalFormValues = {
  fullName: string;
  personalEmail: string;
  mobile: string;
  dateOfBirth: string;
  currentAddress: string;
  permanentAddress: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  skills: string;
  institution: string;
  experienceYears: string;
};

export function PersonalInfoSection({
  mode,
  profile,
  canEditSelf = false,
  locked = false,
  saving = false,
  submittingVerification = false,
  isExecutiveGovernance = false,
  canSeeSensitivePii = true,
  isFounderViewer = false,
  form,
  onFormChange,
  onSave,
  onSubmitForVerification,
}: {
  mode: "self" | "directory";
  profile: {
    full_name: string;
    work_email: string;
    employee_code: string | null;
    personal_email: string | null;
    mobile: string | null;
    date_of_birth: string | null;
    institution: string | null;
    experience_years: number | null;
    skills: string[] | null;
    current_address: string | null;
    permanent_address: string | null;
    emergency_contact_name: string | null;
    emergency_contact_phone: string | null;
    account_status: string;
  };
  canEditSelf?: boolean | undefined;
  locked?: boolean | undefined;
  saving?: boolean | undefined;
  submittingVerification?: boolean | undefined;
  isExecutiveGovernance?: boolean | undefined;
  canSeeSensitivePii?: boolean | undefined;
  isFounderViewer?: boolean | undefined;
  form?: PersonalFormValues | undefined;
  onFormChange?: ((key: keyof PersonalFormValues, value: string) => void) | undefined;
  onSave?: ((e: React.FormEvent) => void) | undefined;
  onSubmitForVerification?: (() => void) | undefined;
}) {
  const uid = useId();
  const isBusy = saving || submittingVerification;

  if (mode === "self" && canEditSelf && form && onFormChange && onSave) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 font-display text-base">
            <UserCircle2 className="size-4 text-primary" aria-hidden="true" /> 1. Personal
            Information
          </CardTitle>
          <CardDescription>
            {locked
              ? "Your profile is currently locked while HR reviews your verification submission."
              : "Keep your contact details, background, and emergency contact information accurate."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSave} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-fullName`} className="text-xs text-muted-foreground">
                Full name <span className="text-primary">*</span>
              </Label>
              <Input
                id={`${uid}-fullName`}
                value={form.fullName}
                disabled={locked || isBusy}
                required
                onChange={(e) => onFormChange("fullName", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-workEmail`} className="text-xs text-muted-foreground">
                Work email
              </Label>
              <Input id={`${uid}-workEmail`} value={profile.work_email} disabled />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-personalEmail`} className="text-xs text-muted-foreground">
                Personal email
              </Label>
              <Input
                id={`${uid}-personalEmail`}
                type="email"
                value={form.personalEmail}
                disabled={locked || isBusy}
                onChange={(e) => onFormChange("personalEmail", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-mobile`} className="text-xs text-muted-foreground">
                Mobile phone
              </Label>
              <Input
                id={`${uid}-mobile`}
                value={form.mobile}
                disabled={locked || isBusy}
                onChange={(e) => onFormChange("mobile", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-dob`} className="text-xs text-muted-foreground">
                Date of birth
              </Label>
              <Input
                id={`${uid}-dob`}
                type="date"
                value={form.dateOfBirth}
                disabled={locked || isBusy}
                onChange={(e) => onFormChange("dateOfBirth", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-inst`} className="text-xs text-muted-foreground">
                Institution / University
              </Label>
              <Input
                id={`${uid}-inst`}
                value={form.institution}
                disabled={locked || isBusy}
                onChange={(e) => onFormChange("institution", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-exp`} className="text-xs text-muted-foreground">
                Years of experience
              </Label>
              <Input
                id={`${uid}-exp`}
                type="number"
                min="0"
                step="0.5"
                value={form.experienceYears}
                disabled={locked || isBusy}
                onChange={(e) => onFormChange("experienceYears", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-skills`} className="text-xs text-muted-foreground">
                Skills (comma separated)
              </Label>
              <Input
                id={`${uid}-skills`}
                value={form.skills}
                disabled={locked || isBusy}
                placeholder="Python, AI Evaluation, Operations"
                onChange={(e) => onFormChange("skills", e.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${uid}-currAddr`} className="text-xs text-muted-foreground">
                Current address
              </Label>
              <Textarea
                id={`${uid}-currAddr`}
                rows={2}
                value={form.currentAddress}
                disabled={locked || isBusy}
                onChange={(e) => onFormChange("currentAddress", e.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${uid}-permAddr`} className="text-xs text-muted-foreground">
                Permanent address
              </Label>
              <Textarea
                id={`${uid}-permAddr`}
                rows={2}
                value={form.permanentAddress}
                disabled={locked || isBusy}
                onChange={(e) => onFormChange("permanentAddress", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-emgName`} className="text-xs text-muted-foreground">
                Emergency contact name
              </Label>
              <Input
                id={`${uid}-emgName`}
                value={form.emergencyContactName}
                disabled={locked || isBusy}
                onChange={(e) => onFormChange("emergencyContactName", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-emgPhone`} className="text-xs text-muted-foreground">
                Emergency contact phone
              </Label>
              <Input
                id={`${uid}-emgPhone`}
                value={form.emergencyContactPhone}
                disabled={locked || isBusy}
                onChange={(e) => onFormChange("emergencyContactPhone", e.target.value)}
              />
            </div>

            <div className="flex flex-wrap gap-2 pt-1 sm:col-span-2">
              <Button type="submit" size="sm" disabled={isBusy || locked}>
                {saving ? "Saving…" : "Save personal details"}
              </Button>
              {!isExecutiveGovernance &&
                profile.account_status !== "active" &&
                onSubmitForVerification && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={isBusy || locked}
                    onClick={onSubmitForVerification}
                  >
                    {submittingVerification
                      ? "Submitting…"
                      : "Submit profile for HR verification"}
                  </Button>
                )}
            </div>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <UserCircle2 className="size-4 text-primary" aria-hidden="true" /> 1. Personal
          Information
        </CardTitle>
        <CardDescription>
          {mode === "self"
            ? "Read-only executive profile details."
            : canSeeSensitivePii
              ? "Verified identity and contact details."
              : "Work contact details (private residential & personal PII restricted to HR & Super Admin)."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <DetailItem label="Full name" value={profile.full_name} />
        <DetailItem label="Work email" value={profile.work_email} />
        <DetailItem label="Mobile phone" value={profile.mobile} />
        <DetailItem
          label="Personal email"
          value={profile.personal_email}
          redacted={!canSeeSensitivePii}
        />
        <DetailItem
          label="Date of birth"
          value={profile.date_of_birth}
          redacted={!canSeeSensitivePii}
        />
        <DetailItem label="Institution" value={profile.institution} />
        <DetailItem
          label="Experience"
          value={profile.experience_years != null ? `${profile.experience_years} yrs` : null}
        />
        <DetailItem label="Skills" value={(profile.skills ?? []).join(", ") || null} />
        <DetailItem
          label="Emergency contact"
          value={profile.emergency_contact_name}
          redacted={isFounderViewer}
        />
        <DetailItem
          label="Emergency phone"
          value={profile.emergency_contact_phone}
          redacted={isFounderViewer}
        />
        <DetailItem
          label="Current address"
          value={profile.current_address}
          redacted={!canSeeSensitivePii}
          className="sm:col-span-2"
        />
        <DetailItem
          label="Permanent address"
          value={profile.permanent_address}
          redacted={!canSeeSensitivePii}
          className="sm:col-span-2"
        />
      </CardContent>
    </Card>
  );
}

/* ============================================================================
 * SECTION 2 — EMPLOYMENT DETAILS & ROLE GOVERNANCE
 * ========================================================================== */
export type EmploymentFormValues = {
  designation: string;
  category: UserCategory;
  departmentId: string;
  reportingLeadId: string;
  employmentStatus: EmploymentStatus;
  joiningDate: string;
  workLocation: string;
  availableHoursPerDay: string;
  internshipStart: string;
  internshipEnd: string;
};

export function EmploymentDetailsSection({
  profile,
  departmentName,
  roles,
  canUpdateWorkforce = false,
  canEditTargetRoles = false,
  allowedRolesToAssign = [],
  busy = false,
  orgRefLoading = false,
  departments = [],
  people = [],
  personId,
  employmentForm,
  onEmploymentFormChange,
  onSaveEmployment,
  selectedRoles = [],
  onToggleRole,
  onSaveRoles,
}: {
  profile: {
    employee_code: string | null;
    designation: string | null;
    category: string;
    employment_status: string;
    account_status: string;
    joining_date: string | null;
    work_location: string | null;
    available_hours_per_day: number | null;
    internship_start: string | null;
    internship_end: string | null;
  };
  departmentName?: string | null | undefined;
  roles: readonly string[];
  canUpdateWorkforce?: boolean | undefined;
  canEditTargetRoles?: boolean | undefined;
  allowedRolesToAssign?: AppRole[] | undefined;
  busy?: boolean | undefined;
  orgRefLoading?: boolean | undefined;
  departments?: { id: string; name: string }[] | undefined;
  people?: { id: string; full_name: string; designation: string | null }[] | undefined;
  personId?: string | undefined;
  employmentForm?: EmploymentFormValues | undefined;
  onEmploymentFormChange?: ((patch: Partial<EmploymentFormValues>) => void) | undefined;
  onSaveEmployment?: ((e: React.FormEvent) => void) | undefined;
  selectedRoles?: AppRole[] | undefined;
  onToggleRole?: ((role: AppRole, checked: boolean) => void) | undefined;
  onSaveRoles?: (() => void) | undefined;
}) {
  const uid = useId();
  const [confirmRoleSaveOpen, setConfirmRoleSaveOpen] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <Briefcase className="size-4 text-primary" aria-hidden="true" /> 2. Employment Details
        </CardTitle>
        <CardDescription>
          {canUpdateWorkforce || canEditTargetRoles
            ? "Manage designation, employment category, lifecycle status, and system authorization roles."
            : "Official employment classification, joining record, and daily capacity."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {canUpdateWorkforce && employmentForm && onEmploymentFormChange && onSaveEmployment ? (
          <form onSubmit={onSaveEmployment} className="grid gap-3.5 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`${uid}-empId`} className="text-xs">
                Employee ID
              </Label>
              <Input
                id={`${uid}-empId`}
                value={profile.employee_code ?? "Assigned automatically"}
                disabled
                className="font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${uid}-desig`} className="text-xs">
                Designation
              </Label>
              <Input
                id={`${uid}-desig`}
                disabled={busy}
                value={employmentForm.designation}
                onChange={(e) => onEmploymentFormChange({ designation: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${uid}-cat`} className="text-xs">
                Employment category (separate from Role)
              </Label>
              <select
                id={`${uid}-cat`}
                disabled={busy}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={employmentForm.category}
                onChange={(e) =>
                  onEmploymentFormChange({ category: e.target.value as UserCategory })
                }
              >
                {USER_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {CATEGORY_LABELS[cat]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${uid}-empStatus`} className="text-xs">
                Employment status
              </Label>
              <select
                id={`${uid}-empStatus`}
                disabled={busy}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={employmentForm.employmentStatus}
                onChange={(e) =>
                  onEmploymentFormChange({
                    employmentStatus: e.target.value as EmploymentStatus,
                  })
                }
              >
                {EMPLOYMENT_STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {st.replace(/_/g, " ").toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${uid}-dept`} className="text-xs">
                Department
              </Label>
              <select
                id={`${uid}-dept`}
                disabled={busy || orgRefLoading}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={employmentForm.departmentId}
                onChange={(e) => onEmploymentFormChange({ departmentId: e.target.value })}
              >
                <option value="">{orgRefLoading ? "Loading departments…" : "Unassigned"}</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${uid}-lead`} className="text-xs">
                Reporting lead
              </Label>
              <select
                id={`${uid}-lead`}
                disabled={busy || orgRefLoading}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={employmentForm.reportingLeadId}
                onChange={(e) => onEmploymentFormChange({ reportingLeadId: e.target.value })}
              >
                <option value="">
                  {orgRefLoading ? "Loading directory…" : "No reporting lead"}
                </option>
                {people
                  .filter((p) => p.id !== personId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.full_name}
                      {p.designation ? ` — ${p.designation}` : ""}
                    </option>
                  ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${uid}-joinDate`} className="text-xs">
                Joining date
              </Label>
              <Input
                id={`${uid}-joinDate`}
                type="date"
                disabled={busy}
                value={employmentForm.joiningDate}
                onChange={(e) => onEmploymentFormChange({ joiningDate: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${uid}-workLoc`} className="text-xs">
                Work location
              </Label>
              <Input
                id={`${uid}-workLoc`}
                disabled={busy}
                value={employmentForm.workLocation}
                onChange={(e) => onEmploymentFormChange({ workLocation: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${uid}-availHrs`} className="text-xs">
                Available hours / day
              </Label>
              <Input
                id={`${uid}-availHrs`}
                type="number"
                min={1}
                max={24}
                step="0.5"
                disabled={busy}
                value={employmentForm.availableHoursPerDay}
                onChange={(e) =>
                  onEmploymentFormChange({ availableHoursPerDay: e.target.value })
                }
              />
            </div>
            {employmentForm.category === "intern" && (
              <>
                <div className="space-y-1">
                  <Label htmlFor={`${uid}-internStart`} className="text-xs">
                    Internship start
                  </Label>
                  <Input
                    id={`${uid}-internStart`}
                    type="date"
                    disabled={busy}
                    value={employmentForm.internshipStart}
                    onChange={(e) =>
                      onEmploymentFormChange({ internshipStart: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${uid}-internEnd`} className="text-xs">
                    Internship end
                  </Label>
                  <Input
                    id={`${uid}-internEnd`}
                    type="date"
                    disabled={busy}
                    value={employmentForm.internshipEnd}
                    onChange={(e) =>
                      onEmploymentFormChange({ internshipEnd: e.target.value })
                    }
                  />
                </div>
              </>
            )}
            <div className="pt-1 sm:col-span-2">
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? "Saving…" : "Save employment details"}
              </Button>
            </div>
          </form>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <DetailItem
              label="Employee ID"
              value={profile.employee_code ?? "Pending Assignment"}
              mono
            />
            <DetailItem label="Designation" value={profile.designation} />
            <DetailItem
              label="Employment category"
              value={CATEGORY_LABELS[profile.category as UserCategory] ?? profile.category}
            />
            <DetailItem label="Department" value={departmentName} />
            <DetailItem
              label="Authorization roles"
              value={
                roles
                  .filter((r) => r !== "super_admin")
                  .map((r) => ROLE_LABELS[r as AppRole] ?? r)
                  .join(", ") || "Employee"
              }
            />
            <DetailItem
              label="Employment status"
              value={profile.employment_status.replace(/_/g, " ").toUpperCase()}
            />
            <DetailItem label="Joining date" value={profile.joining_date} mono />
            <DetailItem label="Work location" value={profile.work_location} />
            <DetailItem
              label="Available hours / day"
              value={
                profile.available_hours_per_day != null
                  ? `${profile.available_hours_per_day}h`
                  : null
              }
              mono
            />
            {profile.category === "intern" && (
              <>
                <DetailItem label="Internship start" value={profile.internship_start} mono />
                <DetailItem label="Internship end" value={profile.internship_end} mono />
              </>
            )}
          </div>
        )}

        {canEditTargetRoles && onToggleRole && onSaveRoles && (
          <div className="space-y-3 border-t border-border pt-4">
            <div>
              <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <ShieldCheck className="size-4 text-primary" aria-hidden="true" /> System
                Authorization Roles
              </p>
              <p className="text-xs text-muted-foreground">
                HR can grant/revoke Admin, Manager, Lead &amp; Employee; Admin can grant/revoke
                Manager, Lead &amp; Employee. Every change is written to the audit log.
              </p>
            </div>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Authorization roles">
              {APP_ROLES.filter((role) => role !== "super_admin").map((role) => {
                const checked = selectedRoles.includes(role);
                const canToggle = allowedRolesToAssign.includes(role);
                return (
                  <label
                    key={role}
                    className={`flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors focus-within:ring-2 focus-within:ring-ring ${
                      canToggle
                        ? "cursor-pointer border-border bg-card hover:border-primary/40"
                        : "cursor-not-allowed border-border/50 opacity-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      disabled={!canToggle || busy}
                      checked={checked}
                      onChange={(e) => onToggleRole(role, e.target.checked)}
                    />
                    <span>{ROLE_LABELS[role]}</span>
                  </label>
                );
              })}
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy || selectedRoles.length === 0}
              onClick={() => setConfirmRoleSaveOpen(true)}
            >
              Save authorization roles
            </Button>

            <AlertDialog open={confirmRoleSaveOpen} onOpenChange={setConfirmRoleSaveOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Update authorization roles?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Assigned roles will be updated to:{" "}
                    <strong>
                      {selectedRoles
                        .filter((r) => r !== "super_admin")
                        .map((r) => ROLE_LABELS[r])
                        .join(", ") || "None"}
                    </strong>
                    . This takes effect immediately on the server and is recorded in the audit log.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={busy}
                    onClick={() => {
                      setConfirmRoleSaveOpen(false);
                      onSaveRoles();
                    }}
                  >
                    Confirm role update
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================================================================
 * SECTION 3 — REPORTING STRUCTURE
 * ========================================================================== */
export function ReportingStructureSection({
  department,
  reportingLead,
  managedDepartments,
  directReportsCount,
  missingReportingLead,
  canLinkProfiles = false,
}: {
  department: { id: string; name: string; code: string } | null;
  reportingLead: { id: string; fullName: string; designation: string | null } | null;
  managedDepartments: { id: string; name: string; code: string }[];
  directReportsCount: number;
  missingReportingLead: boolean;
  canLinkProfiles?: boolean | undefined;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <Network className="size-4 text-primary" aria-hidden="true" /> 3. Reporting Structure
        </CardTitle>
        <CardDescription>
          Organizational department placement, supervisory line, and managed teams.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <DetailItem
            label="Assigned Department"
            value={department ? `${department.name} (${department.code})` : "Unassigned"}
          />
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Reporting Lead</p>
            {reportingLead ? (
              canLinkProfiles ? (
                <Link
                  to="/workforce/$personId"
                  params={{ personId: reportingLead.id }}
                  className="break-words text-sm font-medium text-primary hover:underline"
                >
                  {reportingLead.fullName}
                  {reportingLead.designation ? ` (${reportingLead.designation})` : ""}
                </Link>
              ) : (
                <p className="break-words text-sm font-medium text-foreground">
                  {reportingLead.fullName}
                  {reportingLead.designation ? ` (${reportingLead.designation})` : ""}
                </p>
              )
            ) : (
              <p className="text-sm font-medium text-muted-foreground">
                Direct to HR / Executive Tier
              </p>
            )}
          </div>
          <DetailItem
            label="Active Direct Reports"
            value={directReportsCount}
            mono
          />
        </div>

        {managedDepartments.length > 0 && (
          <div className="rounded-md border border-border bg-muted/20 p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Building2 className="size-3.5 text-primary" aria-hidden="true" /> Managed
              Departments (Manager Scope)
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {managedDepartments.map((d) => (
                <Badge key={d.id} variant="secondary">
                  {d.name} ({d.code})
                </Badge>
              ))}
            </div>
          </div>
        )}

        {missingReportingLead && (
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <span>
              No Reporting Lead is assigned yet. Leave, WFH, and attendance correction requests
              require an assigned Lead before submission.
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================================================================
 * SECTION 4 — WORK ASSIGNMENTS
 * ========================================================================== */
export function WorkAssignmentsSection({
  allocations,
  isExecutiveGovernance,
  isSelf = false,
}: {
  allocations: UnifiedAllocationItem[];
  isExecutiveGovernance: boolean;
  isSelf?: boolean | undefined;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 font-display text-base">
              <Briefcase className="size-4 text-primary" aria-hidden="true" /> 4. Work Assignments
            </CardTitle>
            <CardDescription>
              Active project allocations, capacity percentages, and daily output targets.
            </CardDescription>
          </div>
          {isSelf && !isExecutiveGovernance && (
            <Button asChild variant="outline" size="sm">
              <Link to="/my-projects">Open My Assignments</Link>
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isExecutiveGovernance && allocations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Executive governance account — not subject to operational project allocation quotas.
          </p>
        ) : allocations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active or pending project allocations assigned.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {allocations.map((a) => {
              const proj = a.projects as {
                id?: string;
                code?: string;
                name?: string;
                work_mode?: string;
                task_unit?: string;
              } | null;
              return (
                <div
                  key={a.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-foreground">
                      <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                        {proj?.code ?? "PROJ"}
                      </span>
                      {proj?.name ?? "Project"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {a.role_in_project ?? "Contributor"} ·{" "}
                      {(proj?.work_mode ?? "wfo").toUpperCase()}
                      {a.daily_task_target != null
                        ? ` · Target: ${a.daily_task_target} ${proj?.task_unit ?? "units"}/day`
                        : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="font-mono text-xs">
                      {a.allocation_pct}%
                    </Badge>
                    <Badge variant={a.acknowledged_at ? "success" : "warning"}>
                      {a.acknowledged_at ? "Acknowledged" : "Pending Ack"}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================================================================
 * SECTION 5 — DOCUMENTS (STRICT KYC PRIVACY: SELF, HR, SUPER ADMIN ONLY)
 * ========================================================================== */
function DocStatusBadge({ status }: { status: string }) {
  if (status === "verified") {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 className="size-3" aria-hidden="true" />
        Verified
      </Badge>
    );
  }
  if (status === "rejected") {
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="size-3" aria-hidden="true" />
        Rejected
      </Badge>
    );
  }
  return (
    <Badge variant="info" className="gap-1">
      <Clock className="size-3" aria-hidden="true" />
      Uploaded
    </Badge>
  );
}

export function SelfDocumentsSection({
  documents,
  locked,
  uploadingDocType,
  isLoading = false,
  isError = false,
  onRetry,
  onUploadFile,
}: {
  documents: {
    id: string;
    doc_type: string;
    file_name: string;
    status: string;
    review_note: string | null;
  }[];
  locked: boolean;
  uploadingDocType: string | null;
  isLoading?: boolean | undefined;
  isError?: boolean | undefined;
  onRetry?: (() => void) | undefined;
  onUploadFile: (docType: DocumentType, file: File) => void;
}) {
  const byType = new Map(documents.map((d) => [d.doc_type, d]));

  return (
    <Card data-focus-id="section-documents">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <FileText className="size-4 text-primary" aria-hidden="true" /> 5. Documents &amp; KYC
          Vault
        </CardTitle>
        <CardDescription>
          Stored in a private bucket. Only you, HR, and Super Admin can access these files.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
          >
            <span>Could not load your uploaded documents.</span>
            {onRetry && (
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                <RefreshCw className="mr-1 size-3" aria-hidden="true" /> Retry
              </Button>
            )}
          </div>
        ) : isLoading ? (
          <div role="status" className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-12 animate-pulse rounded-md border border-border bg-muted/30"
              />
            ))}
          </div>
        ) : (
          DOCUMENT_TYPES.map((docType) => {
            const doc = byType.get(docType);
            const required = REQUIRED_DOCUMENT_TYPES.includes(docType);
            const isUploadingThis = uploadingDocType === docType;
            const anyUploading = uploadingDocType !== null;
            return (
              <div
                key={docType}
                id={doc?.status === "rejected" ? "doc-rejected" : undefined}
                data-focus-id={doc?.id}
                className="flex flex-wrap items-start justify-between gap-2.5 rounded-md border border-border px-3 py-2.5"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-sm font-medium text-foreground">
                    {DOCUMENT_TYPE_LABELS[docType]}
                    {required && <span className="ml-1 text-primary">*</span>}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {doc ? doc.file_name : required ? "Required · Not uploaded" : "Optional · Not uploaded"}
                  </p>
                  {doc?.status === "rejected" && doc.review_note && (
                    <p className="break-words pt-0.5 text-xs font-medium text-destructive">
                      Revision needed: {doc.review_note}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {doc && <DocStatusBadge status={doc.status} />}
                  {!locked && (
                    <label
                      className={
                        anyUploading ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                      }
                    >
                      <input
                        type="file"
                        disabled={locked || anyUploading}
                        aria-label={`Upload ${DOCUMENT_TYPE_LABELS[docType]}`}
                        className="peer sr-only"
                        accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) onUploadFile(docType, file);
                          e.target.value = "";
                        }}
                      />
                      <span className="inline-flex min-h-7 items-center gap-1 rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1">
                        <Upload className="size-3" aria-hidden="true" />
                        {isUploadingThis ? "Uploading…" : doc ? "Replace" : "Upload"}
                      </span>
                    </label>
                  )}
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

export function DirectoryDocumentsSection({
  canSeeDocuments,
  showKycStatusBadgeOnly,
  accountStatus,
  documents,
  canVerify,
  busy,
  openingDocId,
  onOpenDocument,
  onDecideDocument,
  verificationNote,
  onVerificationNoteChange,
  onDecideProfile,
}: {
  canSeeDocuments: boolean;
  showKycStatusBadgeOnly: boolean;
  accountStatus: string;
  documents: {
    id: string;
    doc_type: string;
    file_name: string;
    status: string;
    review_note: string | null;
  }[];
  canVerify: boolean;
  busy: boolean;
  openingDocId?: string | null | undefined;
  onOpenDocument: (documentId: string) => void;
  onDecideDocument: (documentId: string, approve: boolean, rejectReason?: string) => void;
  verificationNote: string;
  onVerificationNoteChange: (note: string) => void;
  onDecideProfile: (approve: boolean) => void;
}) {
  const uid = useId();
  const [rejectingDocId, setRejectingDocId] = useState<string | null>(null);
  const [docRejectNote, setDocRejectNote] = useState("");
  const [pendingProfileAction, setPendingProfileAction] = useState<"approve" | "reject" | null>(
    null,
  );

  if (!canSeeDocuments) {
    if (!showKycStatusBadgeOnly) return null;
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 font-display text-base">
            <FileText className="size-4 text-primary" aria-hidden="true" /> 5. Onboarding &amp; KYC
            Status
          </CardTitle>
          <CardDescription>
            Sensitive identity, PAN, and banking files are strictly restricted to HR and Super
            Admin.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">Verification status</span>
          <Badge variant={accountStatus === "active" ? "success" : "warning"}>
            {ACCOUNT_STATUS_LABELS[accountStatus as AccountStatus] ?? accountStatus}
          </Badge>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6" data-focus-id="section-documents">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 font-display text-base">
            <FileText className="size-4 text-primary" aria-hidden="true" /> 5. Documents (
            {documents.length})
          </CardTitle>
          <CardDescription>
            Private employee KYC &amp; onboarding files visible only to HR and Super Admin.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {documents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No documents uploaded yet.</p>
          ) : (
            documents.map((doc) => {
              const docLabel = DOCUMENT_TYPE_LABELS[doc.doc_type as DocumentType] ?? doc.doc_type;
              return (
                <div
                  key={doc.id}
                  data-focus-id={doc.id}
                  className="space-y-2 rounded-md border border-border px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="text-sm font-medium text-foreground">{docLabel}</p>
                        <DocStatusBadge status={doc.status} />
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{doc.file_name}</p>
                      {doc.review_note && (
                        <p className="break-words text-xs text-muted-foreground">
                          Note: “{doc.review_note}”
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={openingDocId === doc.id}
                        aria-label={`Open ${docLabel}`}
                        onClick={() => onOpenDocument(doc.id)}
                      >
                        {openingDocId === doc.id ? "Opening…" : "Open"}
                      </Button>
                      {canVerify && (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            aria-label={`Approve ${docLabel}`}
                            onClick={() => onDecideDocument(doc.id, true)}
                          >
                            Approve
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            aria-label={`Reject ${docLabel}`}
                            onClick={() => {
                              setRejectingDocId(doc.id);
                              setDocRejectNote("");
                            }}
                          >
                            Reject
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  {rejectingDocId === doc.id && (
                    <div className="space-y-2 border-t border-border/70 pt-2">
                      <Label htmlFor={`${uid}-reject-${doc.id}`} className="text-xs">
                        Reason for rejecting {docLabel}
                      </Label>
                      <Input
                        id={`${uid}-reject-${doc.id}`}
                        className="h-8 text-xs"
                        placeholder="Enter clear guidance so the employee can re-upload"
                        value={docRejectNote}
                        onChange={(e) => setDocRejectNote(e.target.value)}
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={busy || !docRejectNote.trim()}
                          onClick={() => {
                            onDecideDocument(doc.id, false, docRejectNote);
                            setRejectingDocId(null);
                            setDocRejectNote("");
                          }}
                        >
                          Confirm rejection
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setRejectingDocId(null);
                            setDocRejectNote("");
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {canVerify && (
        <Card data-focus-id="section-verification">
          <CardHeader>
            <CardTitle className="font-display text-base">Verification Decision</CardTitle>
            <CardDescription>
              Approving verifies the employee profile and activates full workspace access.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-verifNote`} className="text-xs">
                Verification / revision note (optional)
              </Label>
              <Textarea
                id={`${uid}-verifNote`}
                rows={2}
                disabled={busy}
                value={verificationNote}
                onChange={(e) => onVerificationNoteChange(e.target.value)}
                placeholder="Optional verification or revision note for the employee"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => setPendingProfileAction("approve")}
              >
                Verify &amp; activate
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setPendingProfileAction("reject")}
              >
                Send back for changes
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog
        open={pendingProfileAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingProfileAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingProfileAction === "approve"
                ? "Verify and activate employee profile?"
                : "Send profile back for changes?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingProfileAction === "approve"
                ? "This marks the onboarding profile as verified active, assigns an employee code if pending, and unlocks full workspace access."
                : "The profile will be unlocked and returned to the employee so they can update details or re-upload documents."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                const approve = pendingProfileAction === "approve";
                setPendingProfileAction(null);
                onDecideProfile(approve);
              }}
            >
              {pendingProfileAction === "approve" ? "Verify & activate" : "Send back"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ============================================================================
 * SECTION 6 — SECURITY SETTINGS
 * ========================================================================== */
export function SelfSecuritySection({
  workEmail,
  readOnlyExecutive = false,
  busy = false,
  onChangePassword,
}: {
  workEmail: string;
  readOnlyExecutive?: boolean | undefined;
  busy?: boolean | undefined;
  onChangePassword?: ((newPassword: string) => Promise<boolean>) | undefined;
}) {
  const uid = useId();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const policy = evaluatePasswordPolicy(newPassword, confirmPassword);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (!policy.isValid) {
      setLocalError(policy.errorMessage ?? "Enter a valid password.");
      return;
    }
    if (onChangePassword) {
      const ok = await onChangePassword(newPassword);
      if (ok) {
        setNewPassword("");
        setConfirmPassword("");
      }
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <KeyRound className="size-4 text-primary" aria-hidden="true" /> 6. Security Settings
        </CardTitle>
        <CardDescription className="break-words">
          Authenticated session identity ({workEmail}) and password protection.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {readOnlyExecutive ? (
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>
              Executive read-only session active. Password recovery links can be requested anytime
              from the authentication screen.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            {localError && (
              <p
                role="alert"
                className="break-words rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {localError}
              </p>
            )}
            <div className="space-y-1">
              <Label htmlFor={`${uid}-newPwd`} className="text-xs">
                New password
              </Label>
              <div className="relative">
                <Input
                  id={`${uid}-newPwd`}
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  disabled={busy}
                  minLength={8}
                  className="pr-10"
                  placeholder="At least 8 chars, letter + number/symbol"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
                <button
                  type="button"
                  disabled={busy}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  {showPassword ? (
                    <EyeOff className="size-4" aria-hidden="true" />
                  ) : (
                    <Eye className="size-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${uid}-confirmPwd`} className="text-xs">
                Confirm new password
              </Label>
              <Input
                id={`${uid}-confirmPwd`}
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                disabled={busy}
                minLength={8}
                placeholder="Re-enter new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            {newPassword.length > 0 && (
              <ul
                aria-label="Password requirements"
                className="space-y-1 rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 text-[11px] text-muted-foreground"
              >
                <li className="flex items-center gap-1.5">
                  <Check
                    aria-hidden="true"
                    className={`size-3 shrink-0 ${policy.minLengthMet ? "text-emerald-600 dark:text-emerald-400" : "opacity-35"}`}
                  />
                  <span>8+ characters</span>
                </li>
                <li className="flex items-center gap-1.5">
                  <Check
                    aria-hidden="true"
                    className={`size-3 shrink-0 ${policy.hasLetter ? "text-emerald-600 dark:text-emerald-400" : "opacity-35"}`}
                  />
                  <span>At least one letter</span>
                </li>
                <li className="flex items-center gap-1.5">
                  <Check
                    aria-hidden="true"
                    className={`size-3 shrink-0 ${policy.hasNumberOrSymbol ? "text-emerald-600 dark:text-emerald-400" : "opacity-35"}`}
                  />
                  <span>At least one number or symbol</span>
                </li>
              </ul>
            )}
            <Button type="submit" size="sm" variant="outline" disabled={busy || !newPassword}>
              {busy ? "Updating…" : "Update password"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export function DirectorySecuritySection({
  workEmail,
  canResetPassword,
  isSuperAdmin,
  busy,
  onOpenResetEmailDialog,
  onOpenTempPasswordDialog,
}: {
  workEmail: string;
  canResetPassword: boolean;
  isSuperAdmin: boolean;
  busy: boolean;
  onOpenResetEmailDialog: () => void;
  onOpenTempPasswordDialog: () => void;
}) {
  if (!canResetPassword) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <KeyRound className="size-4 text-primary" aria-hidden="true" /> 6. Security Settings
        </CardTitle>
        <CardDescription className="break-words">
          Credential recovery and password governance for {workEmail}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border border-border p-3">
          <p className="text-sm font-medium">Option A · Password reset email</p>
          <p className="mt-0.5 break-words text-xs text-muted-foreground">
            Dispatches a secure recovery link to {workEmail} so the user sets their own password.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3 w-full"
            disabled={busy}
            onClick={onOpenResetEmailDialog}
          >
            <Mail className="mr-1.5 size-3.5" aria-hidden="true" /> Send reset email
          </Button>
        </div>

        {isSuperAdmin && (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3">
            <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden="true" /> Option B ·
              Temporary password override
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Super Admin only. Forces mandatory password rotation on next login.
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="mt-3 w-full"
              disabled={busy}
              onClick={onOpenTempPasswordDialog}
            >
              <KeyRound className="mr-1.5 size-3.5" aria-hidden="true" /> Set temporary password
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
