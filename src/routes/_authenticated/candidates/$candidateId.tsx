import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  CalendarPlus,
  CheckCircle2,
  Download,
  FileText,
  Mail,
  MessageSquarePlus,
  Star,
  Upload,
  UserCheck,
} from "lucide-react";
import { useState } from "react";
import { useNotificationFocus } from "@/hooks/use-notification-focus";
import { toast } from "sonner";
import { errorToAccessScreen } from "@/components/access-denied";
import { AppShell } from "@/components/app-shell";
import { HubSubNav, RECRUITMENT_HUB_TABS } from "@/components/hub-subnav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Textarea } from "@/components/ui/textarea";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { supabase } from "@/integrations/supabase/client";
import { sendRecruitmentEmail } from "@/lib/email-center.functions";
import { scheduleInterview, submitInterviewFeedback } from "@/lib/interviews.functions";
import {
  assignableRolesFor,
  CATEGORY_LABELS,
  ROLE_LABELS,
  USER_CATEGORIES,
  type AppRole,
  type UserCategory,
} from "@/lib/permissions";
import {
  DEFAULT_EMAIL_TEMPLATES,
  renderEmailTemplate,
} from "@/lib/recruitment/email-templates";
import {
  CANDIDATE_PIPELINE_STAGES,
  CANDIDATE_SIDE_STATUSES,
  CANDIDATE_SOURCE_LABELS,
  CANDIDATE_STATUS_LABELS,
  formatInterviewIstSlot,
  INTERVIEW_RECOMMENDATIONS,
  INTERVIEW_RECOMMENDATION_LABELS,
  validateCandidateTransition,
  type CandidateSource,
  type CandidateStatus,
  type InterviewMode,
  type InterviewRecommendation,
} from "@/lib/recruitment/pipeline";
import { todayIso } from "@/lib/timezone";
import {
  addCandidateNote,
  convertCandidateToEmployee,
  createCandidateResumeUploadUrl,
  getCandidateDetail,
  getCandidateResumeDownloadUrl,
  registerCandidateResume,
  updateCandidateStage,
  upsertCandidate,
} from "@/lib/recruitment.functions";

export const Route = createFileRoute("/_authenticated/candidates/$candidateId")({
  head: () => ({
    meta: [{ title: "Candidate Profile | The AI School HRM" }],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: CandidateDetailPage,
  errorComponent: ({ error }) => errorToAccessScreen(error),
});

function CandidateDetailPage() {
  useSuspenseQuery(actorQueryOptions);
  const { candidateId } = Route.useParams();
  const search = useSearch({ strict: false }) as { section?: string };
  const actor = useActor();
  const queryClient = useQueryClient();
  useNotificationFocus(search.section ? `section-${search.section}` : null);

  const canManage = actor.can("recruitment:manage:all");
  const canScheduleIv = actor.can("interviews:manage:all");
  const canSendEmail = actor.can("emails:send:all");
  const canConvert = canManage && actor.can("invitations:create:all");

  const detailQuery = useQuery({
    queryKey: ["recruitment", "candidate", candidateId],
    queryFn: () => getCandidateDetail({ data: { candidateId } }),
  });

  const [noteText, setNoteText] = useState("");
  const [busy, setBusy] = useState(false);

  // Stage transition dialog
  const [targetStage, setTargetStage] = useState<CandidateStatus | null>(null);
  const [stageNote, setStageNote] = useState("");

  // Edit profile dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editDraft, setEditDraft] = useState({
    fullName: "",
    email: "",
    phone: "",
    designation: "",
    departmentId: "",
    appliedCategory: "full_time" as UserCategory,
    assignedHrId: "",
    location: "",
    experienceYears: "",
    availableJoiningDate: "",
    skills: "",
  });

  // Schedule interview dialog (explicit Asia/Kolkata IST fields)
  const [ivOpen, setIvOpen] = useState(false);
  const [ivDraft, setIvDraft] = useState({
    roundNumber: 1,
    roundName: "Technical Round 1",
    mode: "online" as InterviewMode,
    date: todayIso(),
    startTime: "11:00",
    endTime: "11:45",
    meetingLink: "",
    officeLocationId: "",
    locationDetails: "",
    interviewerIds: [] as string[],
    instructions: "",
  });

  // Scorecard dialog (for assigned interviewers & HR)
  const [scorecardIvId, setScorecardIvId] = useState<string | null>(null);
  const [scorecard, setScorecard] = useState({
    rating: 4,
    technicalRating: 4,
    communicationRating: 4,
    recommendation: "hire" as InterviewRecommendation,
    strengths: "",
    concerns: "",
    notes: "",
  });

  // Send email dialog
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailSlug, setEmailSlug] = useState("candidate_shortlisted");

  // Convert to Employee Onboarding dialog
  const [convertOpen, setConvertOpen] = useState(false);
  const [convertDraft, setConvertDraft] = useState({
    workEmail: "",
    role: "employee" as AppRole,
    category: "full_time" as UserCategory,
    departmentId: "",
    designation: "",
    reportingLeadId: "",
    joiningDate: "",
    dispatchImmediately: false,
  });

  if (detailQuery.isLoading) {
    return (
      <AppShell title="Candidate Profile" description="Loading candidate record...">
        <div className="p-8 text-sm text-muted-foreground">Loading candidate details...</div>
      </AppShell>
    );
  }

  if (detailQuery.error || !detailQuery.data) {
    return errorToAccessScreen(detailQuery.error ?? new Error("Candidate not found."));
  }

  const detail = detailQuery.data;
  const cand = detail.candidate;
  const assignableRoles = assignableRolesFor(actor.roles);

  async function refreshAll() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["recruitment", "candidate", candidateId] }),
      queryClient.invalidateQueries({ queryKey: ["recruitment", "candidates"] }),
      queryClient.invalidateQueries({ queryKey: ["role-dashboard"] }),
    ]);
  }

  function openEditModal() {
    setEditDraft({
      fullName: cand.full_name,
      email: cand.email,
      phone: cand.phone ?? "",
      designation: cand.designation ?? "",
      departmentId: cand.department_id ?? "",
      appliedCategory: cand.applied_category,
      assignedHrId: cand.assigned_hr_id ?? "",
      location: cand.location ?? "",
      experienceYears: cand.experience_years != null ? String(cand.experience_years) : "",
      availableJoiningDate: cand.available_joining_date ?? "",
      skills: (cand.skills ?? []).join(", "),
    });
    setEditOpen(true);
  }

  function openConvertModal() {
    setConvertDraft({
      workEmail: cand.email,
      role: "employee",
      category: cand.applied_category,
      departmentId: cand.department_id ?? "",
      designation: cand.designation ?? "",
      reportingLeadId: "",
      joiningDate: cand.available_joining_date ?? "",
      dispatchImmediately: false,
    });
    setConvertOpen(true);
  }

  async function handleStageMove() {
    if (!targetStage) return;
    setBusy(true);
    try {
      await updateCandidateStage({
        data: {
          candidateId: cand.id,
          toStatus: targetStage,
          note: stageNote || undefined,
        },
      });
      toast.success(`Moved to ${CANDIDATE_STATUS_LABELS[targetStage]}`);
      setTargetStage(null);
      setStageNote("");
      await refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change stage.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await upsertCandidate({
        data: {
          id: cand.id,
          fullName: editDraft.fullName,
          email: editDraft.email,
          phone: editDraft.phone || null,
          designation: editDraft.designation || null,
          departmentId: editDraft.departmentId || null,
          appliedCategory: editDraft.appliedCategory,
          assignedHrId: editDraft.assignedHrId || null,
          location: editDraft.location || null,
          experienceYears: editDraft.experienceYears ? Number(editDraft.experienceYears) : null,
          availableJoiningDate: editDraft.availableJoiningDate || null,
          skills: editDraft.skills
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      toast.success("Candidate profile updated.");
      setEditOpen(false);
      await refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAddNote(e: React.FormEvent) {
    e.preventDefault();
    if (!noteText.trim()) return;
    setBusy(true);
    try {
      await addCandidateNote({ data: { candidateId: cand.id, note: noteText } });
      setNoteText("");
      toast.success("Note recorded.");
      await refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add note.");
    } finally {
      setBusy(false);
    }
  }

  async function handleResumeUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const { path, token } = await createCandidateResumeUploadUrl({
        data: { candidateId: cand.id, fileName: file.name },
      });
      const { error: upErr } = await supabase.storage
        .from("candidate-resumes")
        .uploadToSignedUrl(path, token, file);
      if (upErr) throw upErr;
      await registerCandidateResume({
        data: { candidateId: cand.id, path, fileName: file.name },
      });
      toast.success("Resume uploaded securely.");
      await refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Resume upload failed.");
    } finally {
      e.target.value = "";
      setBusy(false);
    }
  }

  async function handleResumeDownload() {
    try {
      const res = await getCandidateResumeDownloadUrl({ data: { candidateId: cand.id } });
      window.open(res.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open resume.");
    }
  }

  async function handleScheduleInterview(e: React.FormEvent) {
    e.preventDefault();
    const startIso = new Date(`${ivDraft.date}T${ivDraft.startTime}:00+05:30`).toISOString();
    const endIso = new Date(`${ivDraft.date}T${ivDraft.endTime}:00+05:30`).toISOString();
    if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
      toast.error("End time (IST) must be after start time (IST).");
      return;
    }
    setBusy(true);
    try {
      await scheduleInterview({
        data: {
          candidateId: cand.id,
          roundNumber: ivDraft.roundNumber,
          roundName: ivDraft.roundName,
          mode: ivDraft.mode,
          scheduledStartAt: startIso,
          scheduledEndAt: endIso,
          meetingLink: ivDraft.mode === "online" ? ivDraft.meetingLink || null : null,
          officeLocationId: ivDraft.mode === "offline" ? ivDraft.officeLocationId || null : null,
          locationDetails: ivDraft.locationDetails || null,
          interviewerIds: ivDraft.interviewerIds,
          instructions: ivDraft.instructions || null,
        },
      });
      toast.success("Interview scheduled in IST and interviewers notified.");
      setIvOpen(false);
      await refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Scheduling failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleScorecardSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!scorecardIvId) return;
    setBusy(true);
    try {
      await submitInterviewFeedback({
        data: {
          interviewId: scorecardIvId,
          rating: scorecard.rating,
          technicalRating: scorecard.technicalRating,
          communicationRating: scorecard.communicationRating,
          recommendation: scorecard.recommendation,
          strengths: scorecard.strengths || null,
          concerns: scorecard.concerns || null,
          notes: scorecard.notes || null,
        },
      });
      toast.success("Interview scorecard saved.");
      setScorecardIvId(null);
      await refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save scorecard.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSendEmail() {
    const tpl = DEFAULT_EMAIL_TEMPLATES.find((t) => t.slug === emailSlug);
    if (!tpl) return;
    setBusy(true);
    try {
      const nextIv = detail.interviews[detail.interviews.length - 1];
      await sendRecruitmentEmail({
        data: {
          templateSlug: tpl.slug,
          candidateId: cand.id,
          recipientEmail: cand.email,
          recipientName: cand.full_name,
          subjectTemplate: tpl.subjectTemplate,
          bodyHtmlTemplate: tpl.bodyHtmlTemplate,
          bodyTextTemplate: tpl.bodyTextTemplate,
          variables: {
            candidate_name: cand.full_name,
            designation: cand.designation || "Role at The AI School",
            department: cand.departmentName || "General",
            interview_date: nextIv
              ? new Date(nextIv.scheduled_start_at).toLocaleDateString("en-IN", {
                  timeZone: "Asia/Kolkata",
                })
              : "TBD",
            interview_time: nextIv
              ? `${new Date(nextIv.scheduled_start_at).toLocaleTimeString("en-IN", {
                  timeZone: "Asia/Kolkata",
                  hour: "2-digit",
                  minute: "2-digit",
                })} IST`
              : "TBD",
            meeting_link: nextIv?.meeting_link || nextIv?.officeName || "Details to follow",
            hr_contact: `${actor.fullName} (${actor.workEmail})`,
            joining_date: cand.available_joining_date || "TBD",
            employee_id: "Assigned on Onboarding",
          },
        },
      });
      toast.success("Email accepted by Hostinger SMTP.");
      setEmailOpen(false);
      await refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Email send failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleConvert(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await convertCandidateToEmployee({
        data: {
          candidateId: cand.id,
          workEmail: convertDraft.workEmail,
          role: convertDraft.role,
          category: convertDraft.category,
          departmentId: convertDraft.departmentId || null,
          designation: convertDraft.designation || null,
          reportingLeadId: convertDraft.reportingLeadId || null,
          joiningDate: convertDraft.joiningDate || null,
          dispatchImmediately: convertDraft.dispatchImmediately,
        },
      });
      toast.success(
        `Candidate converted to Onboarding (${res.workEmail}). Manage dispatch & KYC verification in Onboarding / Workforce.`,
      );
      setConvertOpen(false);
      await refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Conversion failed.");
    } finally {
      setBusy(false);
    }
  }

  const eligibleForConversion =
    canConvert &&
    (cand.status === "selected" || cand.status === "offer_accepted") &&
    !cand.converted_invitation_id &&
    !cand.converted_user_id;

  const alreadyConverted = Boolean(cand.converted_invitation_id || cand.converted_user_id);

  const selectedEmailTpl =
    DEFAULT_EMAIL_TEMPLATES.find((t) => t.slug === emailSlug) ?? DEFAULT_EMAIL_TEMPLATES[0];
  const nextIvForPreview = detail.interviews[detail.interviews.length - 1];
  const emailModalPreview = selectedEmailTpl
    ? renderEmailTemplate({
        subjectTemplate: selectedEmailTpl.subjectTemplate,
        bodyHtmlTemplate: selectedEmailTpl.bodyHtmlTemplate,
        bodyTextTemplate: selectedEmailTpl.bodyTextTemplate,
        variables: {
          candidate_name: cand.full_name,
          designation: cand.designation || "Role at The AI School",
          department: cand.departmentName || "General",
          interview_date: nextIvForPreview
            ? new Date(nextIvForPreview.scheduled_start_at).toLocaleDateString("en-IN", {
                timeZone: "Asia/Kolkata",
              })
            : "TBD",
          interview_time: nextIvForPreview
            ? `${new Date(nextIvForPreview.scheduled_start_at).toLocaleTimeString("en-IN", {
                timeZone: "Asia/Kolkata",
                hour: "2-digit",
                minute: "2-digit",
              })} IST`
            : "TBD",
          meeting_link:
            nextIvForPreview?.meeting_link || nextIvForPreview?.officeName || "Details to follow",
          hr_contact: `${actor.fullName} (${actor.workEmail})`,
          joining_date: cand.available_joining_date || "TBD",
          employee_id: "Assigned on Onboarding",
        },
      })
    : null;

  const ivSlotPreview = (() => {
    if (!ivDraft.date || !ivDraft.startTime || !ivDraft.endTime) return null;
    const s = new Date(`${ivDraft.date}T${ivDraft.startTime}:00+05:30`);
    const e = new Date(`${ivDraft.date}T${ivDraft.endTime}:00+05:30`);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
    const diffMins = Math.round((e.getTime() - s.getTime()) / 60000);
    if (diffMins <= 0) {
      return { valid: false as const, message: "End time (IST) must be after start time (IST)." };
    }
    const fmt = formatInterviewIstSlot(s.toISOString(), e.toISOString());
    return {
      valid: true as const,
      message: `${fmt.dateLabel} · ${fmt.timeRangeLabel} (${diffMins} mins)`,
    };
  })();

  return (
    <AppShell
      title={`${cand.full_name} (${cand.candidate_code})`}
      description={`${cand.designation ?? "Applicant"} · ${cand.departmentName ?? "Unassigned Dept"} · ${CANDIDATE_STATUS_LABELS[cand.status as CandidateStatus] ?? cand.status}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to={detail.accessMode === "full" ? "/candidates" : "/interviews"}>
              <ArrowLeft className="mr-1.5 size-4" />
              Back
            </Link>
          </Button>
          {canManage && (
            <Button variant="outline" size="sm" onClick={openEditModal}>
              Edit Profile
            </Button>
          )}
          {canScheduleIv && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setIvDraft((d) => ({
                  ...d,
                  roundNumber: detail.interviews.length + 1,
                  roundName: `Round ${detail.interviews.length + 1}`,
                  date: d.date || todayIso(),
                }));
                setIvOpen(true);
              }}
            >
              <CalendarPlus className="mr-1.5 size-4" />
              Schedule Interview
            </Button>
          )}
          {canSendEmail && (
            <Button variant="outline" size="sm" onClick={() => setEmailOpen(true)}>
              <Mail className="mr-1.5 size-4" />
              Send Email
            </Button>
          )}
          {eligibleForConversion && (
            <Button size="sm" onClick={openConvertModal}>
              <UserCheck className="mr-1.5 size-4" />
              Convert to Employee Onboarding
            </Button>
          )}
        </div>
      }
    >
      {/* Recruitment Hub Sub-Navigation + Pipeline Stage Bar */}
      {detail.accessMode === "full" && (
        <>
          <HubSubNav tabs={RECRUITMENT_HUB_TABS} />
          <Card className="mb-6">
            <CardContent className="space-y-3 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Recruitment Stage Progression
                </p>
                {canManage && (
                  <div className="flex flex-wrap gap-1.5">
                    {CANDIDATE_SIDE_STATUSES.map((side) => {
                      const check = validateCandidateTransition({
                        fromStatus: cand.status as CandidateStatus,
                        toStatus: side,
                        alreadyConverted,
                      });
                      return (
                        <Button
                          key={side}
                          size="sm"
                          variant={cand.status === side ? "default" : "outline"}
                          className="h-7 text-xs"
                          disabled={!check.ok}
                          title={!check.ok ? check.reason : `Move to ${CANDIDATE_STATUS_LABELS[side]}`}
                          onClick={() => setTargetStage(side)}
                        >
                          {CANDIDATE_STATUS_LABELS[side]}
                        </Button>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {CANDIDATE_PIPELINE_STAGES.map((st, idx) => {
                  const isCurrent = cand.status === st;
                  const check = validateCandidateTransition({
                    fromStatus: cand.status as CandidateStatus,
                    toStatus: st,
                    alreadyConverted,
                  });
                  const clickable = canManage && check.ok;
                  return (
                    <button
                      key={st}
                      type="button"
                      aria-current={isCurrent ? "step" : undefined}
                      disabled={!clickable}
                      title={
                        isCurrent
                          ? `Current stage: ${CANDIDATE_STATUS_LABELS[st]}`
                          : !canManage
                            ? "Read-only stage view"
                            : !check.ok
                              ? check.reason
                              : `Move to ${CANDIDATE_STATUS_LABELS[st]}`
                      }
                      onClick={() => setTargetStage(st)}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        isCurrent
                          ? "border-primary bg-primary text-primary-foreground"
                          : clickable
                            ? "border-border bg-card text-foreground hover:border-primary/50"
                            : "cursor-not-allowed border-border/60 bg-muted/30 text-muted-foreground opacity-70"
                      }`}
                    >
                      <span className="font-mono text-[10px] opacity-75">{idx + 1}.</span>
                      {CANDIDATE_STATUS_LABELS[st]}
                    </button>
                  );
                })}
              </div>
              {cand.converted_invitation_id && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs">
                  <span className="flex items-center gap-1.5 font-medium text-success">
                    <CheckCircle2 className="size-4" />
                    Converted to Employee Onboarding Invitation
                    {detail.linkedInvitation ? ` (${detail.linkedInvitation.status})` : ""}
                  </span>
                  <div className="flex gap-2">
                    <Button asChild size="sm" variant="outline" className="h-7 text-xs">
                      <Link to="/invitations">View Invitation Queue</Link>
                    </Button>
                    {cand.converted_user_id && (
                      <Button asChild size="sm" variant="outline" className="h-7 text-xs">
                        <Link
                          to="/workforce/$personId"
                          params={{ personId: cand.converted_user_id }}
                        >
                          Open Employee Profile
                        </Link>
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left Column: Candidate Summary & Resume */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="font-display text-base font-semibold">
                Applicant Profile
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-sm">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Email</span>
                <span className="font-medium">{cand.email}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Phone</span>
                <span>{cand.phone ?? "—"}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Category</span>
                <span>{CATEGORY_LABELS[cand.applied_category]}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Source</span>
                <span>
                  {CANDIDATE_SOURCE_LABELS[cand.source as CandidateSource] ?? cand.source}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Experience</span>
                <span>
                  {cand.experience_years != null ? `${cand.experience_years} yrs` : "—"}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Current Company</span>
                <span>{cand.current_company ?? "—"}</span>
              </div>
              {detail.accessMode === "full" && (
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Expected CTC</span>
                  <span>{cand.expected_ctc ?? "—"}</span>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Available Joining</span>
                <span className="font-mono text-xs">{cand.available_joining_date ?? "—"}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Assigned HR</span>
                <span>{cand.assignedHrName ?? "Unassigned"}</span>
              </div>
              {(cand.skills ?? []).length > 0 && (
                <div className="pt-2">
                  <p className="mb-1.5 text-xs text-muted-foreground">Skills</p>
                  <div className="flex flex-wrap gap-1">
                    {cand.skills.map((s) => (
                      <Badge key={s} variant="secondary" className="text-xs">
                        {s}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Resume Card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="font-display text-base font-semibold">
                Resume &amp; CV
              </CardTitle>
              <CardDescription>
                Stored in private bucket with short-lived signed download URLs
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {cand.resume_path ? (
                <div className="flex items-center justify-between gap-2 rounded-md border border-border p-3 text-sm">
                  <div className="flex min-w-0 items-center gap-2">
                    <FileText className="size-4 shrink-0 text-primary" />
                    <span className="truncate font-medium">
                      {cand.resume_file_name ?? "Resume"}
                    </span>
                  </div>
                  <Button size="sm" variant="outline" onClick={handleResumeDownload}>
                    <Download className="mr-1 size-3.5" />
                    Open
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No resume uploaded yet.</p>
              )}
              {canManage && (
                <div>
                  <Label htmlFor="cand-resume-upload" className="mb-1 block text-xs">
                    {cand.resume_path ? "Replace Resume (PDF/DOCX)" : "Upload Resume (PDF/DOCX)"}
                  </Label>
                  <Input
                    id="cand-resume-upload"
                    type="file"
                    accept=".pdf,.doc,.docx,.rtf"
                    disabled={busy}
                    onChange={handleResumeUpload}
                    className="cursor-pointer text-xs"
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right 2 Columns: Interviews & Scorecards + Activity & Email Timeline */}
        <div className="space-y-6 lg:col-span-2">
          {/* Interviews & Scorecards */}
          <Card data-focus-id="section-interviews">
            <CardHeader className="pb-3">
              <CardTitle className="font-display text-base font-semibold">
                Interviews &amp; Hiring Scorecards ({detail.interviews.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {detail.interviews.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No interview rounds scheduled yet.
                </p>
              ) : (
                detail.interviews.map((iv) => {
                  const ivFeedbacks = detail.feedback.filter((f) => f.interview_id === iv.id);
                  const canFeedbackThis =
                    actor.can("interviews:manage:all") ||
                    (actor.can("interviews:feedback:assigned") &&
                      (iv.interviewer_ids ?? []).includes(actor.userId));

                  return (
                    <div
                      key={iv.id}
                      className="space-y-2 rounded-lg border border-border p-3.5 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <span className="font-semibold">
                            Round {iv.round_number}: {iv.round_name}
                          </span>{" "}
                          <Badge variant="outline" className="ml-1 text-[11px]">
                            {iv.status}
                          </Badge>
                          <Badge variant="secondary" className="ml-1 text-[11px]">
                            {iv.mode.toUpperCase()}
                          </Badge>
                        </div>
                        {canFeedbackThis && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setScorecardIvId(iv.id)}
                          >
                            <Star className="mr-1 size-3.5" />
                            Submit Scorecard
                          </Button>
                        )}
                      </div>
                      <p className="font-mono text-xs text-muted-foreground">
                        {new Date(iv.scheduled_start_at).toLocaleString("en-IN", {
                          timeZone: "Asia/Kolkata",
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}{" "}
                        IST · Panel:{" "}
                        {iv.interviewerNames.map((n) => n.name).join(", ") || "None"}
                      </p>
                      {iv.meeting_link && (
                        <a
                          href={iv.meeting_link}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-block text-xs text-primary hover:underline"
                        >
                          Join Meeting Link
                        </a>
                      )}
                      {ivFeedbacks.length > 0 && (
                        <div className="mt-2 space-y-1.5 border-t border-border pt-2">
                          {ivFeedbacks.map((fb) => (
                            <div
                              key={fb.id}
                              className="rounded bg-muted/30 px-2.5 py-1.5 text-xs"
                            >
                              <div className="flex items-center justify-between">
                                <strong>{fb.interviewerName}</strong>
                                <span className="font-mono">
                                  Rating: {fb.rating}/5 ·{" "}
                                  {INTERVIEW_RECOMMENDATION_LABELS[
                                    fb.recommendation as InterviewRecommendation
                                  ] ?? fb.recommendation}
                                </span>
                              </div>
                              {fb.notes && (
                                <p className="mt-0.5 text-muted-foreground">{fb.notes}</p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          {/* Notes & Activity History */}
          {detail.accessMode === "full" && (
            <Card data-focus-id="section-timeline">
              <CardHeader className="pb-3">
                <CardTitle className="font-display text-base font-semibold">
                  Notes &amp; Activity History
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {canManage && (
                  <form onSubmit={handleAddNote} className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      aria-label="Candidate note"
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      placeholder="Add HR screening note, compensation remark, or call summary..."
                    />
                    <Button type="submit" size="sm" disabled={busy || !noteText.trim()}>
                      <MessageSquarePlus className="mr-1.5 size-4" />
                      Add Note
                    </Button>
                  </form>
                )}

                {detail.activities.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No activity recorded yet.</p>
                ) : (
                  <ul className="space-y-2.5 text-xs">
                    {detail.activities.map((act) => (
                      <li
                        key={act.id}
                        className="rounded-md border border-border/70 bg-muted/15 px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-foreground">
                            {act.actorName} ·{" "}
                            <span className="uppercase text-muted-foreground">
                              {act.activity_type.replace(/_/g, " ")}
                            </span>
                          </span>
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {act.created_at.slice(0, 16).replace("T", " ")}
                          </span>
                        </div>
                        {act.from_status && act.to_status && (
                          <p className="mt-0.5 text-primary">
                            {CANDIDATE_STATUS_LABELS[act.from_status as CandidateStatus] ??
                              act.from_status}{" "}
                            →{" "}
                            {CANDIDATE_STATUS_LABELS[act.to_status as CandidateStatus] ??
                              act.to_status}
                          </p>
                        )}
                        {act.body && <p className="mt-1 text-muted-foreground">{act.body}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Stage Transition Confirmation Modal */}
      <Dialog open={Boolean(targetStage)} onOpenChange={(o) => !o && setTargetStage(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Move Candidate to{" "}
              {targetStage ? CANDIDATE_STATUS_LABELS[targetStage] : ""}
            </DialogTitle>
            <DialogDescription>
              Every stage transition is validated and logged to the candidate's activity timeline.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="stage-transition-note">Transition Note (optional)</Label>
            <Textarea
              id="stage-transition-note"
              rows={2}
              value={stageNote}
              onChange={(e) => setStageNote(e.target.value)}
              placeholder="Reason or evaluation summary..."
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTargetStage(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={handleStageMove}>
              {busy ? "Updating..." : "Confirm Stage Move"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Candidate Modal */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Candidate Profile</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSaveEdit} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="edit-cand-name">Full Name</Label>
                <Input
                  id="edit-cand-name"
                  required
                  value={editDraft.fullName}
                  onChange={(e) => setEditDraft({ ...editDraft, fullName: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-cand-email">Email</Label>
                <Input
                  id="edit-cand-email"
                  required
                  type="email"
                  value={editDraft.email}
                  onChange={(e) => setEditDraft({ ...editDraft, email: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-cand-phone">Phone</Label>
                <Input
                  id="edit-cand-phone"
                  value={editDraft.phone}
                  onChange={(e) => setEditDraft({ ...editDraft, phone: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-cand-designation">Designation</Label>
                <Input
                  id="edit-cand-designation"
                  value={editDraft.designation}
                  onChange={(e) => setEditDraft({ ...editDraft, designation: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-cand-dept">Department</Label>
                <select
                  id="edit-cand-dept"
                  value={editDraft.departmentId}
                  onChange={(e) => setEditDraft({ ...editDraft, departmentId: e.target.value })}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Unassigned</option>
                  {detail.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-cand-hr">Assigned HR</Label>
                <select
                  id="edit-cand-hr"
                  value={editDraft.assignedHrId}
                  onChange={(e) => setEditDraft({ ...editDraft, assignedHrId: e.target.value })}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Unassigned</option>
                  {detail.hrUsers.map((hr) => (
                    <option key={hr.id} value={hr.id}>
                      {hr.fullName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-cand-joining">Available Joining Date</Label>
                <Input
                  id="edit-cand-joining"
                  type="date"
                  value={editDraft.availableJoiningDate}
                  onChange={(e) =>
                    setEditDraft({ ...editDraft, availableJoiningDate: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-cand-skills">Skills</Label>
                <Input
                  id="edit-cand-skills"
                  value={editDraft.skills}
                  onChange={(e) => setEditDraft({ ...editDraft, skills: e.target.value })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Schedule Interview Modal (Explicit Asia/Kolkata IST Fields) */}
      <Dialog open={ivOpen} onOpenChange={setIvOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Schedule Interview — {cand.full_name}</DialogTitle>
            <DialogDescription>
              All slots are scheduled in <strong>Asia/Kolkata (IST)</strong> and stored in UTC.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleScheduleInterview} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="cand-iv-round-no">Round Number</Label>
                <Input
                  id="cand-iv-round-no"
                  type="number"
                  min={1}
                  value={ivDraft.roundNumber}
                  onChange={(e) =>
                    setIvDraft({ ...ivDraft, roundNumber: Number(e.target.value) || 1 })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cand-iv-round-name">Round Name *</Label>
                <Input
                  id="cand-iv-round-name"
                  required
                  value={ivDraft.roundName}
                  onChange={(e) => setIvDraft({ ...ivDraft, roundName: e.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="cand-iv-date">Date (IST) *</Label>
                <Input
                  id="cand-iv-date"
                  required
                  type="date"
                  value={ivDraft.date}
                  onChange={(e) => setIvDraft({ ...ivDraft, date: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cand-iv-start">Start Time (IST) *</Label>
                <Input
                  id="cand-iv-start"
                  required
                  type="time"
                  value={ivDraft.startTime}
                  onChange={(e) => setIvDraft({ ...ivDraft, startTime: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cand-iv-end">End Time (IST) *</Label>
                <Input
                  id="cand-iv-end"
                  required
                  type="time"
                  value={ivDraft.endTime}
                  onChange={(e) => setIvDraft({ ...ivDraft, endTime: e.target.value })}
                />
              </div>
            </div>
            {ivSlotPreview && (
              <div
                role={ivSlotPreview.valid ? "status" : "alert"}
                className={`rounded-md border px-3 py-2 text-xs ${
                  ivSlotPreview.valid
                    ? "border-info/40 bg-info/10 text-foreground"
                    : "border-destructive/40 bg-destructive/10 text-destructive"
                }`}
              >
                <span className="font-semibold">
                  {ivSlotPreview.valid ? "IST Slot: " : "Invalid Time Range: "}
                </span>
                {ivSlotPreview.message}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="cand-iv-mode">Mode</Label>
                <select
                  id="cand-iv-mode"
                  value={ivDraft.mode}
                  onChange={(e) =>
                    setIvDraft({ ...ivDraft, mode: e.target.value as InterviewMode })
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="online">Online (Video Link)</option>
                  <option value="offline">Offline (In-Office)</option>
                </select>
              </div>
              {ivDraft.mode === "online" ? (
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="cand-iv-link">Meeting Link *</Label>
                  <Input
                    id="cand-iv-link"
                    required
                    type="url"
                    value={ivDraft.meetingLink}
                    onChange={(e) => setIvDraft({ ...ivDraft, meetingLink: e.target.value })}
                    placeholder="https://meet.google.com/..."
                  />
                </div>
              ) : (
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="cand-iv-office">Office Location</Label>
                  <select
                    id="cand-iv-office"
                    value={ivDraft.officeLocationId}
                    onChange={(e) =>
                      setIvDraft({ ...ivDraft, officeLocationId: e.target.value })
                    }
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">Select office...</option>
                    {detail.offices.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Assign Interviewers * ({ivDraft.interviewerIds.length} selected)</Label>
                <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-xs">
                  {detail.interviewerOptions.map((opt) => {
                    const checked = ivDraft.interviewerIds.includes(opt.id);
                    return (
                      <label key={opt.id} className="flex cursor-pointer items-center gap-2 py-0.5">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) => {
                            const next = v
                              ? [...ivDraft.interviewerIds, opt.id]
                              : ivDraft.interviewerIds.filter((x) => x !== opt.id);
                            setIvDraft({ ...ivDraft, interviewerIds: next });
                          }}
                        />
                        <span>
                          {opt.fullName}{" "}
                          <span className="text-muted-foreground">
                            ({opt.designation ?? opt.email})
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIvOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy || Boolean(ivSlotPreview && !ivSlotPreview.valid)}
              >
                Schedule Interview
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Scorecard Modal */}
      <Dialog open={Boolean(scorecardIvId)} onOpenChange={(o) => !o && setScorecardIvId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Submit Interview Scorecard</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleScorecardSubmit} className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label htmlFor="cand-sc-overall">Overall (1–5)</Label>
                <Input
                  id="cand-sc-overall"
                  type="number"
                  min={1}
                  max={5}
                  value={scorecard.rating}
                  onChange={(e) =>
                    setScorecard({ ...scorecard, rating: Number(e.target.value) })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cand-sc-tech">Technical (1–5)</Label>
                <Input
                  id="cand-sc-tech"
                  type="number"
                  min={1}
                  max={5}
                  value={scorecard.technicalRating}
                  onChange={(e) =>
                    setScorecard({ ...scorecard, technicalRating: Number(e.target.value) })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cand-sc-comm">Comm. (1–5)</Label>
                <Input
                  id="cand-sc-comm"
                  type="number"
                  min={1}
                  max={5}
                  value={scorecard.communicationRating}
                  onChange={(e) =>
                    setScorecard({
                      ...scorecard,
                      communicationRating: Number(e.target.value),
                    })
                  }
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cand-sc-rec">Recommendation</Label>
              <select
                id="cand-sc-rec"
                value={scorecard.recommendation}
                onChange={(e) =>
                  setScorecard({
                    ...scorecard,
                    recommendation: e.target.value as InterviewRecommendation,
                  })
                }
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {INTERVIEW_RECOMMENDATIONS.map((r) => (
                  <option key={r} value={r}>
                    {INTERVIEW_RECOMMENDATION_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cand-sc-notes">Strengths &amp; Evaluation Notes</Label>
              <Textarea
                id="cand-sc-notes"
                rows={3}
                value={scorecard.notes}
                onChange={(e) => setScorecard({ ...scorecard, notes: e.target.value })}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setScorecardIvId(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                Save Scorecard
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Send Templated Email Modal */}
      <Dialog open={emailOpen} onOpenChange={setEmailOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Send Email to {cand.full_name}</DialogTitle>
            <DialogDescription>Recipient: {cand.email}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {!detail.emailProvider.configured && (
              <div className="rounded-md border border-warning/50 bg-warning/10 p-3 text-xs text-warning">
                Email provider not yet configured ({detail.emailProvider.issues.join(" ")}).
                Configure Hostinger SMTP credentials to enable live sending, or compose a draft in{" "}
                <Link to="/email-center" className="underline">
                  Email Center
                </Link>
                .
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="cand-send-email-tpl">Template</Label>
              <select
                id="cand-send-email-tpl"
                value={emailSlug}
                onChange={(e) => setEmailSlug(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {DEFAULT_EMAIL_TEMPLATES.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            {emailModalPreview && (
              <div className="space-y-1.5 rounded-md border border-border bg-muted/25 p-3 text-xs">
                <p className="font-semibold text-foreground">
                  Subject: <span className="font-normal">{emailModalPreview.subject}</span>
                </p>
                <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap font-sans text-muted-foreground">
                  {emailModalPreview.bodyText}
                </pre>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEmailOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !detail.emailProvider.configured}
              onClick={handleSendEmail}
            >
              Send Email
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Convert to Employee Onboarding Modal */}
      <Dialog open={convertOpen} onOpenChange={setConvertOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Convert Candidate to Employee Onboarding</DialogTitle>
            <DialogDescription>
              Transitions <strong>{cand.full_name}</strong> into official HRM employee onboarding.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleConvert} className="space-y-3">
            <div className="rounded-md border border-info/40 bg-info/10 p-3 text-xs text-foreground">
              <p className="font-semibold">What happens on conversion:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                <li>
                  Candidate pipeline stage moves to <strong>Onboarding</strong> and preserves full
                  interview &amp; scorecard history.
                </li>
                <li>
                  Queues an official HRM invitation; sequential Employee ID (
                  <code className="font-mono">TAS-XXX</code>) is allocated on dispatch.
                </li>
                <li>
                  Employee account activates only after HR verifies mandatory KYC documents.
                </li>
              </ul>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="conv-work-email">Onboarding / Work Email *</Label>
                <Input
                  id="conv-work-email"
                  required
                  type="email"
                  value={convertDraft.workEmail}
                  onChange={(e) =>
                    setConvertDraft({ ...convertDraft, workEmail: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="conv-role">Authorization Role</Label>
                <select
                  id="conv-role"
                  value={convertDraft.role}
                  onChange={(e) =>
                    setConvertDraft({ ...convertDraft, role: e.target.value as AppRole })
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {assignableRoles.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="conv-category">Employment Category</Label>
                <select
                  id="conv-category"
                  value={convertDraft.category}
                  onChange={(e) =>
                    setConvertDraft({
                      ...convertDraft,
                      category: e.target.value as UserCategory,
                    })
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {USER_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="conv-dept">Department</Label>
                <select
                  id="conv-dept"
                  value={convertDraft.departmentId}
                  onChange={(e) =>
                    setConvertDraft({ ...convertDraft, departmentId: e.target.value })
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Unassigned</option>
                  {detail.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="conv-designation">Designation</Label>
                <Input
                  id="conv-designation"
                  value={convertDraft.designation}
                  onChange={(e) =>
                    setConvertDraft({ ...convertDraft, designation: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="conv-lead">Reporting Lead</Label>
                <select
                  id="conv-lead"
                  value={convertDraft.reportingLeadId}
                  onChange={(e) =>
                    setConvertDraft({ ...convertDraft, reportingLeadId: e.target.value })
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Assign later</option>
                  {detail.interviewerOptions.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.fullName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="conv-joining">Confirmed Joining Date</Label>
                <Input
                  id="conv-joining"
                  type="date"
                  value={convertDraft.joiningDate}
                  onChange={(e) =>
                    setConvertDraft({ ...convertDraft, joiningDate: e.target.value })
                  }
                />
              </div>
              <label className="flex cursor-pointer items-center gap-2 pt-2 text-xs sm:col-span-2">
                <Checkbox
                  checked={convertDraft.dispatchImmediately}
                  onCheckedChange={(v) =>
                    setConvertDraft({ ...convertDraft, dispatchImmediately: Boolean(v) })
                  }
                />
                <span>
                  Dispatch Supabase Auth onboarding invite email immediately (otherwise stays queued
                  in Onboarding)
                </span>
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConvertOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Converting..." : "Convert & Queue Onboarding"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

