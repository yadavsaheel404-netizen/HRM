import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileCheck,
  FileText,
  Mail,
  MapPin,
  Send,
  Shield,
  ShieldAlert,
  User,
  UserCheck,
  UserX,
  Users,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  CATEGORY_LABELS,
  DOCUMENT_TYPE_LABELS,
  REQUIRED_DOCUMENT_TYPES,
  ROLE_LABELS,
  type AppRole,
  type DocumentType,
  type UserCategory,
} from "@/lib/permissions";
import { WORK_TYPE_LABELS, type WorkType } from "@/lib/work-type";
import {
  getWorkforceMember,
  reviewProfile,
} from "@/lib/workforce.functions";
import { sendAccountSetupEmails } from "@/lib/onboarding.functions";
import { reviewDocument } from "@/lib/documents.functions";

export type EmployeeDetailDrawerProps = {
  personId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canManageWorkforce: boolean;
  isSuperAdmin: boolean;
  isHr: boolean;
  onDeactivate: (person: { id: string; fullName: string; employeeCode: string | null; workEmail: string; role: string; departmentName: string | null }) => void;
  onDelete: (person: { id: string; fullName: string; employeeCode: string | null; workEmail: string }) => void;
};

export function EmployeeDetailDrawer({
  personId,
  open,
  onOpenChange,
  canManageWorkforce,
  isSuperAdmin,
  isHr,
  onDeactivate,
  onDelete,
}: EmployeeDetailDrawerProps) {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("overview");

  // Profile review form state
  const [reviewNote, setReviewNote] = useState("");
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);

  // Setup email sending state
  const [isSendingSetupEmail, setIsSendingSetupEmail] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["workforce-member", personId],
    queryFn: () => getWorkforceMember({ data: { id: personId! } }),
    enabled: Boolean(open && personId),
  });

  if (!open || !personId) return null;

  const profile = data?.profile;
  const roles = (data?.roles as AppRole[]) ?? [];
  const primaryRole = roles[0] ?? "employee";
  const docs = data?.documents ?? [];
  const requests = (data as { requests?: any[] })?.requests ?? [];

  async function handleSendSetupEmail() {
    if (!personId || !profile?.work_email) return;
    setIsSendingSetupEmail(true);
    try {
      const res = await sendAccountSetupEmails({
        data: { userIds: [personId], confirmed: true, resend: true },
      });
      if (res.results[0]?.outcome === "smtp_accepted") {
        toast.success(`Account setup email dispatched to ${profile.work_email}.`);
        queryClient.invalidateQueries({ queryKey: ["workforce"] });
        queryClient.invalidateQueries({ queryKey: ["workforce-member", personId] });
      } else {
        toast.error(res.results[0]?.reason ?? "Failed to send setup email.");
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Error dispatching setup email.");
    } finally {
      setIsSendingSetupEmail(false);
    }
  }

  async function handleReviewProfile(approve: boolean) {
    if (!personId) return;
    if (!approve && !reviewNote.trim()) {
      toast.error("Please explain what requires correction before sending the profile back.");
      return;
    }
    setIsSubmittingReview(true);
    try {
      await reviewProfile({
        data: {
          userId: personId,
          approve,
          ...(reviewNote.trim() ? { note: reviewNote.trim() } : {}),
        },
      });
      toast.success(approve ? "Profile verified successfully." : "Profile returned for corrections.");
      setReviewNote("");
      queryClient.invalidateQueries({ queryKey: ["workforce"] });
      queryClient.invalidateQueries({ queryKey: ["workforce-member", personId] });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Profile review failed.");
    } finally {
      setIsSubmittingReview(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl p-0 flex flex-col h-full bg-background border-l border-border/80 shadow-2xl"
      >
        {isLoading || !profile ? (
          <div className="flex-1 p-6 flex flex-col items-center justify-center gap-3 text-muted-foreground animate-pulse">
            <User className="size-8 text-muted-foreground/60" />
            <p className="text-sm">Loading employee details…</p>
          </div>
        ) : (
          <>
            {/* Header Identity Card */}
            <SheetHeader className="p-5 pb-4 border-b border-border/70 bg-muted/20 text-left">
              <div className="flex items-start gap-3.5">
                <Avatar className="size-14 border border-border/80 shadow-xs">
                  <AvatarImage src={profile.photo_url ?? undefined} alt={profile.full_name} />
                  <AvatarFallback className="bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300 font-bold text-base">
                    {profile.full_name
                      .split(" ")
                      .map((n) => n[0])
                      .slice(0, 2)
                      .join("")
                      .toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <SheetTitle className="text-lg font-bold text-foreground truncate">
                      {profile.full_name}
                    </SheetTitle>
                    {profile.employee_code && (
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold text-muted-foreground">
                        {profile.employee_code}
                      </span>
                    )}
                    <Badge
                      variant={
                        (profile.employment_status as any) === "relieved"
                          ? "outline"
                          : profile.employment_status === "inactive"
                          ? "neutral"
                          : profile.account_status === "active"
                          ? "success"
                          : profile.account_status === "under_verification"
                          ? "warning"
                          : "info"
                      }
                      className={`text-[10px] capitalize ${
                        (profile.employment_status as any) === "relieved"
                          ? "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 font-bold"
                          : ""
                      }`}
                    >
                      {(profile.employment_status as any) === "relieved"
                        ? "Relieved"
                        : profile.employment_status === "inactive"
                        ? "Deactivated"
                        : profile.account_status.replace(/_/g, " ")}
                    </Badge>
                  </div>

                  <p className="text-xs text-muted-foreground truncate mt-0.5">{profile.work_email}</p>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                    {roles.map((r) => (
                      <span key={r} className="rounded-md bg-secondary/80 px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
                        {ROLE_LABELS[r] ?? r}
                      </span>
                    ))}
                    {profile.category && (
                      <span className="text-[11px] text-muted-foreground">
                        · {CATEGORY_LABELS[profile.category as UserCategory] ?? profile.category}
                      </span>
                    )}
                    {data?.workType?.value && (
                      <Badge variant="outline" className="text-[11px] text-primary border-primary/30">
                        {WORK_TYPE_LABELS[data.workType.value as WorkType] ?? data.workType.value}
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            </SheetHeader>

            {/* Navigation Tabs */}
            <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
              <div className="border-b border-border/70 px-4 bg-background">
                <TabsList className="h-10 bg-transparent p-0 gap-4">
                  <TabsTrigger
                    value="overview"
                    className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:bg-transparent rounded-none px-1 text-xs"
                  >
                    Overview
                  </TabsTrigger>
                  <TabsTrigger
                    value="onboarding"
                    className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:bg-transparent rounded-none px-1 text-xs"
                  >
                    Onboarding
                  </TabsTrigger>
                  <TabsTrigger
                    value="kyc"
                    className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:bg-transparent rounded-none px-1 text-xs"
                  >
                    KYC ({docs.filter((d) => d.status === "verified").length}/5)
                  </TabsTrigger>
                  <TabsTrigger
                    value="requests"
                    className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:bg-transparent rounded-none px-1 text-xs"
                  >
                    Requests ({requests.length})
                  </TabsTrigger>
                </TabsList>
              </div>

              {/* Scrollable Tab Body */}
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                {/* 1. OVERVIEW TAB */}
                <TabsContent value="overview" className="m-0 space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-border/70 bg-card p-3 space-y-1">
                      <div className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
                        <Building2 className="size-3.5" /> Department
                      </div>
                      <div className="text-xs font-semibold text-foreground">
                        {data?.department?.name ?? "Unassigned"}
                      </div>
                    </div>

                    <div className="rounded-lg border border-border/70 bg-card p-3 space-y-1">
                      <div className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
                        <UserCheck className="size-3.5" /> Reporting Lead / Manager
                      </div>
                      <div className="text-xs font-semibold text-foreground">
                        {data?.reportingLead?.fullName ? (
                          <span className="text-primary">{data.reportingLead.fullName}</span>
                        ) : (
                          <span className="text-amber-600 dark:text-amber-400 font-normal">Unassigned</span>
                        )}
                      </div>
                    </div>

                    <div className="rounded-lg border border-border/70 bg-card p-3 space-y-1">
                      <div className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
                        <Calendar className="size-3.5" /> Joining Date
                      </div>
                      <div className="text-xs text-foreground font-mono">
                        {profile.joining_date ?? "Not recorded"}
                      </div>
                    </div>

                    <div className="rounded-lg border border-border/70 bg-card p-3 space-y-1">
                      <div className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
                        <MapPin className="size-3.5" /> Work Location
                      </div>
                      <div className="text-xs text-foreground capitalize">
                        {profile.work_location ?? "Remote / Unspecified"}
                      </div>
                    </div>
                  </div>

                  {/* Contact & Sensitive Info (PII protected) */}
                  <div className="rounded-lg border border-border/70 bg-card p-4 space-y-2.5">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Contact Information
                    </h3>
                    <div className="grid gap-2 text-xs">
                      <div className="flex justify-between py-1 border-b border-border/40">
                        <span className="text-muted-foreground">Work Email</span>
                        <span className="font-mono text-foreground">{profile.work_email}</span>
                      </div>
                      {profile.personal_email && (
                        <div className="flex justify-between py-1 border-b border-border/40">
                          <span className="text-muted-foreground">Personal Email</span>
                          <span className="font-mono text-foreground">{profile.personal_email}</span>
                        </div>
                      )}
                      {profile.mobile && (
                        <div className="flex justify-between py-1 border-b border-border/40">
                          <span className="text-muted-foreground">Mobile</span>
                          <span className="font-mono text-foreground">{profile.mobile}</span>
                        </div>
                      )}
                      {profile.emergency_contact_name && (
                        <div className="flex justify-between py-1">
                          <span className="text-muted-foreground">Emergency Contact</span>
                          <span className="text-foreground">
                            {profile.emergency_contact_name} ({profile.emergency_contact_phone ?? "—"})
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Skills / Notes */}
                  {profile.skills && profile.skills.length > 0 && (
                    <div className="rounded-lg border border-border/70 bg-card p-4 space-y-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Skills</h3>
                      <div className="flex flex-wrap gap-1.5">
                        {profile.skills.map((s) => (
                          <span key={s} className="rounded bg-muted px-2 py-0.5 text-xs text-foreground font-medium">
                            {s}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </TabsContent>

                {/* 2. ONBOARDING TAB */}
                <TabsContent value="onboarding" className="m-0 space-y-4">
                  <div className="rounded-lg border border-border/70 bg-card p-4 space-y-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Lifecycle Progress
                    </h3>

                    <div className="space-y-3 text-xs">
                      {/* Step 1: Created */}
                      <div className="flex items-start gap-3">
                        <div className="size-6 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0 mt-0.5">
                          <CheckCircle2 className="size-3.5" />
                        </div>
                        <div>
                          <div className="font-semibold text-foreground">Account Created</div>
                          <div className="text-[11px] text-muted-foreground">
                            Profile provisioned on {new Date(profile.created_at).toLocaleDateString()}
                          </div>
                        </div>
                      </div>

                      {/* Step 2: Setup Email */}
                      <div className="flex items-start gap-3">
                        <div
                          className={`size-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                            profile.welcome_email_sent_at
                              ? "bg-emerald-100 text-emerald-600"
                              : "bg-amber-100 text-amber-600"
                          }`}
                        >
                          {profile.welcome_email_sent_at ? (
                            <CheckCircle2 className="size-3.5" />
                          ) : (
                            <Clock className="size-3.5" />
                          )}
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <div className="font-semibold text-foreground">
                              {profile.welcome_email_sent_at ? "Setup Email Dispatched" : "Setup Email Pending"}
                            </div>
                            {canManageWorkforce && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={isSendingSetupEmail}
                                onClick={handleSendSetupEmail}
                                className="h-6 px-2 text-[10px] gap-1"
                              >
                                <Send className="size-2.5" />
                                <span>{profile.welcome_email_sent_at ? "Resend Setup" : "Send Setup"}</span>
                              </Button>
                            )}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {profile.welcome_email_sent_at
                              ? `Sent on ${new Date(profile.welcome_email_sent_at).toLocaleDateString()}`
                              : "Employee has not yet received account setup instructions"}
                          </div>
                        </div>
                      </div>

                      {/* Step 3: Password / Activation */}
                      <div className="flex items-start gap-3">
                        <div
                          className={`size-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                            !profile.must_change_password
                              ? "bg-emerald-100 text-emerald-600"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {!profile.must_change_password ? (
                            <CheckCircle2 className="size-3.5" />
                          ) : (
                            <Clock className="size-3.5" />
                          )}
                        </div>
                        <div>
                          <div className="font-semibold text-foreground">
                            {!profile.must_change_password ? "Password Set & Activated" : "Awaiting Password Setup"}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {!profile.must_change_password
                              ? "First-time password successfully configured"
                              : "Employee must change temporary password on initial sign-in"}
                          </div>
                        </div>
                      </div>

                      {/* Step 4: Profile Submission */}
                      <div className="flex items-start gap-3">
                        <div
                          className={`size-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                            profile.profile_submitted_at
                              ? "bg-emerald-100 text-emerald-600"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {profile.profile_submitted_at ? (
                            <CheckCircle2 className="size-3.5" />
                          ) : (
                            <Clock className="size-3.5" />
                          )}
                        </div>
                        <div>
                          <div className="font-semibold text-foreground">
                            {profile.profile_submitted_at ? "Submitted for HR Review" : "Profile Submission Pending"}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {profile.profile_submitted_at
                              ? `Submitted on ${new Date(profile.profile_submitted_at).toLocaleDateString()}`
                              : "Employee has not yet completed and locked their onboarding profile"}
                          </div>
                        </div>
                      </div>

                      {/* Step 5: Verification */}
                      <div className="flex items-start gap-3">
                        <div
                          className={`size-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                            profile.profile_verified_at
                              ? "bg-emerald-100 text-emerald-600"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {profile.profile_verified_at ? (
                            <CheckCircle2 className="size-3.5" />
                          ) : (
                            <Clock className="size-3.5" />
                          )}
                        </div>
                        <div>
                          <div className="font-semibold text-foreground">
                            {profile.profile_verified_at ? "Profile Verified by HR" : "HR Verification Pending"}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {profile.profile_verified_at
                              ? `Verified on ${new Date(profile.profile_verified_at).toLocaleDateString()}`
                              : "Requires HR approval before full activation"}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* In-Drawer HR Review Form */}
                  {profile.account_status === "under_verification" && (isHr || isSuperAdmin) && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-900/60 dark:bg-amber-950/30 space-y-3">
                      <div className="flex items-center gap-2 text-xs font-semibold text-amber-900 dark:text-amber-300">
                        <FileCheck className="size-4" />
                        <span>Action Required: Review Submitted Profile</span>
                      </div>
                      <p className="text-[11px] text-amber-800 dark:text-amber-400">
                        The employee submitted their profile and uploaded documents for verification.
                      </p>

                      <div className="space-y-1.5">
                        <Textarea
                          placeholder="If returning with correction notes, explain what needs fixing…"
                          value={reviewNote}
                          onChange={(e) => setReviewNote(e.target.value)}
                          className="h-16 text-xs bg-background"
                        />
                      </div>

                      <div className="flex items-center gap-2 pt-1">
                        <Button
                          type="button"
                          size="sm"
                          disabled={isSubmittingReview}
                          onClick={() => handleReviewProfile(true)}
                          className="h-8 bg-emerald-600 text-white hover:bg-emerald-700 text-xs gap-1.5"
                        >
                          <CheckCircle2 className="size-3.5" />
                          <span>Approve & Activate Profile</span>
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={isSubmittingReview}
                          onClick={() => handleReviewProfile(false)}
                          className="h-8 border-amber-300 text-amber-800 dark:text-amber-300 hover:bg-amber-100 text-xs"
                        >
                          Request Correction
                        </Button>
                      </div>
                    </div>
                  )}
                </TabsContent>

                {/* 3. KYC TAB */}
                <TabsContent value="kyc" className="m-0 space-y-4">
                  {/* Progress Header */}
                  <div className="rounded-lg border border-border/70 bg-card p-3.5 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-foreground">KYC Verification Progress</span>
                      <span className="font-mono text-xs text-primary font-semibold">
                        {docs.filter((d) => d.status === "verified").length} of {REQUIRED_DOCUMENT_TYPES.length} Verified
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all duration-300 rounded-full"
                        style={{
                          width: `${Math.round(
                            (docs.filter((d) => d.status === "verified").length / REQUIRED_DOCUMENT_TYPES.length) * 100,
                          )}%`,
                        }}
                      />
                    </div>
                  </div>

                  {/* Checklist of 5 Required Documents */}
                  <div className="space-y-2">
                    {REQUIRED_DOCUMENT_TYPES.map((docType) => {
                      const doc = docs.find((d) => d.doc_type === docType);
                      const isVerified = doc?.status === "verified";
                      const isRejected = doc?.status === "rejected";
                      const isPending = doc?.status === "pending";

                      return (
                        <div
                          key={docType}
                          className="flex items-start justify-between gap-3 rounded-lg border border-border/70 bg-card p-3 text-xs"
                        >
                          <div className="space-y-1 min-w-0">
                            <div className="font-semibold text-foreground">
                              {DOCUMENT_TYPE_LABELS[docType] ?? docType}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {doc ? (
                                <span>Uploaded · Rev {doc.revision ?? 1}</span>
                              ) : (
                                <span className="text-amber-600 dark:text-amber-400">Not uploaded</span>
                              )}
                            </div>
                            {isRejected && doc?.review_note && (
                              <div className="rounded bg-red-50 p-2 text-[11px] text-red-700 dark:bg-red-950/40 dark:text-red-300">
                                <strong>Correction note:</strong> {doc.review_note}
                              </div>
                            )}
                          </div>

                          <Badge
                            variant={
                              isVerified ? "success" : isRejected ? "destructive" : isPending ? "warning" : "neutral"
                            }
                            className="text-[10px] shrink-0"
                          >
                            {isVerified
                              ? "Verified"
                              : isRejected
                              ? "Correction Required"
                              : isPending
                              ? "Under Review"
                              : "Missing"}
                          </Badge>
                        </div>
                      );
                    })}
                  </div>

                  {data?.canSeeDocuments && (
                    <Button asChild variant="outline" size="sm" className="w-full text-xs gap-1.5">
                      <Link to="/workforce/$personId" params={{ personId }}>
                        <ExternalLink className="size-3.5" />
                        <span>Open Document Review Workspace</span>
                      </Link>
                    </Button>
                  )}
                </TabsContent>

                {/* 4. REQUESTS TAB */}
                <TabsContent value="requests" className="m-0 space-y-3">
                  {requests.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border/80 p-8 text-center text-xs text-muted-foreground">
                      No requests recorded for this employee.
                    </div>
                  ) : (
                    requests.map((req) => (
                      <div
                        key={req.id}
                        className="rounded-lg border border-border/70 bg-card p-3 text-xs space-y-1.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-foreground capitalize">
                            {req.request_type.replace(/_/g, " ")}
                          </span>
                          <Badge
                            variant={
                              req.status === "approved"
                                ? "success"
                                : req.status === "rejected"
                                ? "destructive"
                                : req.status === "pending"
                                ? "warning"
                                : "neutral"
                            }
                            className="text-[10px] capitalize"
                          >
                            {req.status}
                          </Badge>
                        </div>
                        <div className="text-muted-foreground text-[11px]">
                          {req.start_date} {req.end_date && req.end_date !== req.start_date ? `to ${req.end_date}` : ""}
                        </div>
                        {req.reason && (
                          <div className="text-[11px] text-foreground bg-muted/40 p-1.5 rounded">
                            {req.reason}
                          </div>
                        )}
                      </div>
                    ))
                  )}

                  <Button asChild variant="outline" size="sm" className="w-full text-xs gap-1.5 mt-2">
                    <Link to="/requests">
                      <ExternalLink className="size-3.5" />
                      <span>View All Organization Requests</span>
                    </Link>
                  </Button>
                </TabsContent>
              </div>
            </Tabs>

            {/* Bottom Actions Bar */}
            <div className="border-t border-border/70 p-4 bg-muted/20 flex flex-wrap items-center justify-between gap-2">
              <Button asChild size="sm" className="bg-red-600 hover:bg-red-700 text-white text-xs gap-1.5">
                <Link to="/workforce/$personId" params={{ personId }}>
                  <ExternalLink className="size-3.5" />
                  <span>View Full Profile</span>
                </Link>
              </Button>

              <div className="flex items-center gap-2">
                {canManageWorkforce && (profile.employment_status as any) !== "relieved" && (
                  <Button asChild size="sm" variant="outline" className="h-8 text-xs gap-1">
                    <Link to={"/employee-relieving" as any}>
                      <FileCheck className="size-3.5 mr-1 text-red-600" />
                      <span>Initiate Relieving</span>
                    </Link>
                  </Button>
                )}

                {(profile.employment_status as any) === "relieved" && (
                  <Button asChild size="sm" variant="outline" className="h-8 text-xs gap-1 border-purple-200 text-purple-700 hover:bg-purple-50">
                    <Link to={"/employee-relieving" as any}>
                      <FileCheck className="size-3.5 mr-1" />
                      <span>Relieving Record</span>
                    </Link>
                  </Button>
                )}

                {canManageWorkforce && profile.employment_status === "active" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      onDeactivate({
                        id: personId,
                        fullName: profile.full_name,
                        employeeCode: profile.employee_code ?? null,
                        workEmail: profile.work_email,
                        role: primaryRole,
                        departmentName: data?.department?.name ?? null,
                      });
                    }}
                    className="h-8 text-xs text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/40"
                  >
                    <UserX className="size-3.5 mr-1" />
                    <span>Deactivate</span>
                  </Button>
                )}

                {canManageWorkforce && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      onDelete({
                        id: personId,
                        fullName: profile.full_name,
                        employeeCode: profile.employee_code ?? null,
                        workEmail: profile.work_email,
                      });
                    }}
                    className="h-8 text-xs text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40"
                  >
                    Delete Account
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
