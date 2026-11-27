import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  AlignLeft,
  CheckCircle2,
  Download,
  Eye,
  FileCode2,
  FileText,
  Mail,
  Monitor,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  ShieldAlert,
  Smartphone,
  Sparkles,
  Users,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AccessDenied, errorToAccessScreen } from "@/components/access-denied";
import { AppShell } from "@/components/app-shell";
import {
  CustomTemplatesWorkspace,
  type CustomWorkspaceSubTab,
} from "@/components/email-center/custom-templates-workspace";
import { MultiRelievingPanel } from "@/components/email-center/multi-relieving-panel";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { describeUnknownError } from "@/lib/describe-error";
import {
  cancelEmailMessage,
  getEmailCenterData,
  resetEmailTemplateToDefault,
  retryFailedEmail,
  saveEmailDraft,
  saveEmailTemplate,
  sendBulkRecruitmentEmails,
  sendRecruitmentEmail,
  verifyEmailProviderConnection,
} from "@/lib/email-center.functions";
import {
  EMAIL_VARIABLE_DESCRIPTIONS,
  renderEmailTemplate,
  SAMPLE_EMAIL_VARIABLES,
  SUPPORTED_EMAIL_VARIABLES,
  validateTemplateVariables,
  type EmailVariableKey,
} from "@/lib/recruitment/email-templates";
import { previewRelievingLetter } from "@/lib/relieving.functions";
import { formatLetterDate, type RelievingLetterData } from "@/lib/relieving/types";
import {
  cancelQueuedBatchItems,
  listCustomEmailTemplates,
  listDispatchBatches,
  processBulkDispatchChunk,
  retryFailedBatchItems,
} from "@/lib/email-center-bulk.functions";
import { resolveEmailCenterAccessPolicy } from "@/lib/email-center/custom-templates";
import type { EmailCenterRecipientItem } from "@/lib/email-center/types";

export const Route = createFileRoute("/_authenticated/email-center")({
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: EmailCenterPage,
});

const TEMPLATE_CATEGORIES: { id: string; label: string; slugs: string[] }[] = [
  {
    id: "recruitment",
    label: "Recruitment",
    slugs: [
      "application_received",
      "candidate_shortlisted",
      "interview_invitation",
      "interview_rescheduled",
      "interview_reminder",
      "candidate_rejection",
      "candidate_selection",
    ],
  },
  {
    id: "offers",
    label: "Offers & Contracts",
    slugs: ["offer_letter", "offer_acceptance"],
  },
  {
    id: "onboarding",
    label: "Onboarding & KYC",
    slugs: [
      "onboarding_invitation",
      "document_reminder",
      "employee_welcome",
      "document_correction_request",
    ],
  },
  {
    id: "communications",
    label: "Communications",
    slugs: ["hr_announcement", "work_notice"],
  },
  {
    id: "relieving",
    label: "Relieving & Experience Letters",
    slugs: ["employee_relieving_letter"],
  },
];

function formatDisplayDate(dateStr?: string | null): string {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const day = String(d.getDate()).padStart(2, "0");
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
    ];
    return `${day} ${months[d.getMonth()]} ${d.getFullYear()}`;
  } catch {
    return dateStr;
  }
}

type ComposeMode = "individual" | "bulk" | "test";
type LogFilter =
  | "all"
  | "accepted_by_smtp"
  | "delivered"
  | "failed"
  | "draft"
  | "canceled";
type PreviewMode = "desktop" | "mobile" | "text";

function statusBadgeVariant(
  status: string,
): "success" | "info" | "destructive" | "neutral" | "outline" {
  if (status === "delivered") return "success";
  if (status === "accepted_by_smtp" || status === "sent") return "info";
  if (status === "failed") return "destructive";
  if (status === "draft" || status === "canceled") return "neutral";
  return "outline";
}

function statusDisplayLabel(status: string): string {
  switch (status) {
    case "accepted_by_smtp":
      return "Accepted by SMTP";
    case "sent":
      return "Accepted (Legacy)";
    case "queued":
      return "Queued";
    case "sending":
      return "Sending";
    case "delivered":
      return "Delivered (Confirmed)";
    case "failed":
      return "Failed";
    case "draft":
      return "Draft";
    case "canceled":
      return "Canceled";
    default:
      return status;
  }
}

function EmailCenterPage() {
  useSuspenseQuery(actorQueryOptions);
  const actor = useActor();
  const queryClient = useQueryClient();

  const allowed = actor.can("emails:read:all");
  const customAccess = useMemo(
    () =>
      resolveEmailCenterAccessPolicy(
        actor.roles ?? [],
        actor.permissions ?? [],
      ),
    [actor.roles, actor.permissions],
  );
  const canViewCustomTemplates =
    customAccess.canManageCustomTemplates || customAccess.isFounder;

  const centerQuery = useQuery({
    queryKey: ["recruitment", "email-center"],
    queryFn: () => getEmailCenterData(),
    enabled: allowed,
  });

  const customTemplatesQuery = useQuery({
    queryKey: ["custom-email-templates"],
    queryFn: () => listCustomEmailTemplates(),
    enabled: allowed && canViewCustomTemplates,
  });

  const dispatchBatchesQuery = useQuery({
    queryKey: ["email-dispatch-batches"],
    queryFn: () => listDispatchBatches(),
    enabled: allowed,
  });

  // Custom Email Templates workspace navigation state
  const [customModeActive, setCustomModeActive] = useState(false);
  const [selectedCustomTemplateId, setSelectedCustomTemplateId] = useState<string | null>(null);
  const [customWorkspaceSubTab, setCustomWorkspaceSubTab] =
    useState<CustomWorkspaceSubTab>("library");
  const [pendingSidebarUploadFile, setPendingSidebarUploadFile] = useState<File | null>(null);

  // Template editor state
  const [selectedSlug, setSelectedSlug] = useState<string>("application_received");
  const [tplName, setTplName] = useState("");
  const [tplCategory, setTplCategory] = useState("screening");
  const [tplSubject, setTplSubject] = useState("");
  const [tplBodyHtml, setTplBodyHtml] = useState("");
  const [tplBodyText, setTplBodyText] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);

  // Compose & Bulk state
  const [composeMode, setComposeMode] = useState<ComposeMode>("individual");
  const [composeSlug, setComposeSlug] = useState<string>("interview_invitation");
  const [composeCandidateId, setComposeCandidateId] = useState<string>("");
  const [composeEmployeeId, setComposeEmployeeId] = useState<string>("");
  const [composeRecipientEmail, setComposeRecipientEmail] = useState<string>("");
  const [composeRecipientName, setComposeRecipientName] = useState<string>("");
  const [composeSubjectTpl, setComposeSubjectTpl] = useState<string>("");
  const [composeBodyHtmlTpl, setComposeBodyHtmlTpl] = useState<string>("");
  const [composeBodyTextTpl, setComposeBodyTextTpl] = useState<string>("");
  const [composeVars, setComposeVars] = useState<Record<EmailVariableKey, string>>(() => ({
    ...SAMPLE_EMAIL_VARIABLES,
  }));
  const [bulkCandidateIds, setBulkCandidateIds] = useState<string[]>([]);
  const [bulkSearch, setBulkSearch] = useState<string>("");
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("desktop");
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);

  // Main Tabs navigation state
  const [activeTab, setActiveTab] = useState<string>("templates");

  // PDF Preview modal state
  const [pdfPreviewOpen, setPdfPreviewOpen] = useState(false);
  const [pdfPreviewBlobUrl, setPdfPreviewBlobUrl] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);

  // Dedicated Relieving Letter state (Primary View)
  const [relievingSubTab, setRelievingSubTab] = useState<"official_letter" | "email_message">("official_letter");
  const [composePreviewSubTab, setComposePreviewSubTab] = useState<"official_letter" | "email_message">("official_letter");
  const [letterViewMode, setLetterViewMode] = useState<"pdf" | "document">("pdf");
  const [isDraftMode, setIsDraftMode] = useState(false);
  const [letterPdfBlobUrl, setLetterPdfBlobUrl] = useState<string | null>(null);
  const [letterSignatureDataUri, setLetterSignatureDataUri] = useState<string | null>(null);
  const [letterPdfLoading, setLetterPdfLoading] = useState(false);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>("");

  const [letterData, setLetterData] = useState<RelievingLetterData>({
    employeeName: "B.Yaswanth",
    designation: "AI Data Annotation Analyst – Intern",
    legalEmployer: "Learning Paths Technologies LLP",
    joiningDate: "2026-07-02",
    lastWorkingDay: "2026-10-30",
    relievingEffectiveDate: "2026-10-30",
    letterIssueDate: "2026-10-30",
    contributedProjects: "various AI Data Associate Intern and related projects",
    performanceStatement: "found to be satisfactory",
    signatoryName: "K. Spandana",
    signatoryTitle: "HR - Director",
    signatoryDesignation: "Director",
    companyContact: "+91 92468 18843",
    companyAddress: "T-hub 2.0, Knowledge City, Hyderabad, Telangana",
    isDraft: false,
  });

  // Delivery history & verification state
  const [logFilter, setLogFilter] = useState<LogFilter>("all");
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [verifyingSmtp, setVerifyingSmtp] = useState(false);
  const [editorTab, setEditorTab] = useState<"visual" | "code">("visual");
  const [selectedMsgForDetails, setSelectedMsgForDetails] = useState<any | null>(null);

  const data = centerQuery.data;
  const templates = data?.templates ?? [];

  const activeTemplate = useMemo(
    () => templates.find((t) => t.slug === selectedSlug) ?? templates[0] ?? null,
    [templates, selectedSlug],
  );

  // Sync editor inputs when active template changes
  useEffect(() => {
    if (!activeTemplate) return;
    setTplName(activeTemplate.name);
    setTplCategory(activeTemplate.category);
    setTplSubject(activeTemplate.subjectTemplate);
    setTplBodyHtml(activeTemplate.bodyHtmlTemplate);
    setTplBodyText(activeTemplate.bodyTextTemplate ?? "");
  }, [activeTemplate]);

  // Sync compose template when composeSlug or templates load
  useEffect(() => {
    const found = templates.find((t) => t.slug === composeSlug);
    if (!found) return;
    setComposeSubjectTpl(found.subjectTemplate);
    setComposeBodyHtmlTpl(found.bodyHtmlTemplate);
    setComposeBodyTextTpl(found.bodyTextTemplate ?? "");
  }, [composeSlug, templates]);

  // Sync HR contact default when data loads
  useEffect(() => {
    if (!data?.actorContact) return;
    setComposeVars((prev) => ({
      ...prev,
      hr_contact: data.actorContact,
    }));
  }, [data?.actorContact]);

  if (!allowed) {
    return (
      <AccessDenied
        kind="forbidden"
        detail="Required permission: emails:read:all"
      />
    );
  }

  if (centerQuery.isError) {
    return errorToAccessScreen(centerQuery.error);
  }

  const canManageTemplates = Boolean(data?.canManageTemplates);
  const canSendEmails = Boolean(data?.canSendEmails);
  const providerConfigured = Boolean(data?.providerStatus.configured);

  const editorValidation = validateTemplateVariables({
    subjectTemplate: tplSubject,
    bodyHtmlTemplate: tplBodyHtml,
    bodyTextTemplate: tplBodyText || null,
  });

  const editorPreview = renderEmailTemplate({
    subjectTemplate: tplSubject || "(Subject)",
    bodyHtmlTemplate: tplBodyHtml || "<p>(Body)</p>",
    bodyTextTemplate: tplBodyText || null,
    variables: {
      ...SAMPLE_EMAIL_VARIABLES,
      hr_contact: data?.actorContact ?? SAMPLE_EMAIL_VARIABLES.hr_contact,
    },
  });

  const composePreview = renderEmailTemplate({
    subjectTemplate: composeSubjectTpl || "(Subject)",
    bodyHtmlTemplate: composeBodyHtmlTpl || "<p>(Body)</p>",
    bodyTextTemplate: composeBodyTextTpl || null,
    variables: composeVars,
  });

  const filteredMessages = (data?.messages ?? []).filter((m) => {
    if (logFilter === "all") return true;
    if (logFilter === "accepted_by_smtp") {
      return m.status === "accepted_by_smtp" || m.status === "sent";
    }
    return m.status === logFilter;
  });

  async function refreshCenter() {
    await queryClient.invalidateQueries({ queryKey: ["recruitment", "email-center"] });
  }

  function insertVariableIntoHtml(varKey: EmailVariableKey) {
    if (!canManageTemplates) return;
    setTplBodyHtml((prev) => `${prev}{{${varKey}}}`);
  }

  function handleSelectComposeCandidate(candidateId: string) {
    setComposeCandidateId(candidateId);
    const cand = data?.candidates.find((c) => c.id === candidateId);
    if (!cand) return;
    setComposeRecipientEmail(cand.email);
    setComposeRecipientName(cand.fullName);
    setComposeVars((prev) => ({
      ...prev,
      candidate_name: cand.fullName,
      designation: cand.designation ?? "Team Member",
      department: cand.departmentName ?? "General",
      joining_date: cand.joiningDate ?? prev.joining_date,
    }));
  }

  function handleSelectComposeEmployee(employeeId: string) {
    setComposeEmployeeId(employeeId);
    const emp = (data?.employees ?? []).find((e: any) => e.id === employeeId);
    if (!emp) return;

    setComposeRecipientEmail(emp.workEmail);
    setComposeRecipientName(emp.fullName);

    const joiningFormatted = emp.joiningDate ? formatDisplayDate(emp.joiningDate) : "02 Jul 2026";
    const todayFormatted = formatDisplayDate(new Date().toISOString());

    setComposeVars((prev) => ({
      ...prev,
      employee_name: emp.fullName,
      candidate_name: emp.fullName,
      employee_id: emp.employeeCode,
      designation: emp.designation || "AI Data Associate Intern",
      department: emp.departmentName || "General",
      employment_start_date: joiningFormatted,
      employment_end_date: todayFormatted,
      relieving_date: todayFormatted,
      issue_date: todayFormatted,
      legal_employer: "Learning Paths Technologies LLP",
      signatory_name: "K. Spandana",
      signatory_title: "HR - Director",
      company_address: "T-hub 2.0, Knowledge City, Hyderabad, Telangana",
      company_contact: "+91 92468 18843",
    }));
  }

  async function refreshLetterPdf(customData?: RelievingLetterData, draft?: boolean) {
    try {
      setLetterPdfLoading(true);
      const dataToRender = customData || letterData;
      const isDraft = draft !== undefined ? draft : isDraftMode;
      const res = await previewRelievingLetter({
        data: {
          letterData: {
            ...dataToRender,
            isDraft,
          },
          isDraft,
        },
      });

      const binaryString = atob(res.base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      setLetterPdfBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      if (res.signatureDataUri) {
        setLetterSignatureDataUri(res.signatureDataUri);
      }
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setLetterPdfLoading(false);
    }
  }

  async function handlePreviewPdf(source: "editor" | "compose") {
    try {
      setPdfLoading(true);
      setPdfPreviewOpen(true);

      const vars = source === "compose" ? composeVars : SAMPLE_EMAIL_VARIABLES;
      const dataToRender: RelievingLetterData = source === "compose" ? {
        employeeName: vars.employee_name || composeRecipientName || "B.Yaswanth",
        designation: vars.designation || "AI Data Annotation Analyst – Intern",
        legalEmployer: vars.legal_employer || "Learning Paths Technologies LLP",
        joiningDate: vars.employment_start_date || "2026-07-02",
        lastWorkingDay: vars.employment_end_date || "2026-10-30",
        relievingEffectiveDate: vars.relieving_date || "2026-10-30",
        letterIssueDate: vars.issue_date || "2026-10-30",
        contributedProjects: "various AI Data Associate Intern and related projects",
        performanceStatement: "found to be satisfactory",
        signatoryName: vars.signatory_name || "K. Spandana",
        signatoryTitle: vars.signatory_title || "HR - Director",
        signatoryDesignation: "Director",
        companyContact: vars.company_contact || "+91 92468 18843",
        companyAddress: vars.company_address || "T-hub 2.0, Knowledge City, Hyderabad, Telangana",
        isDraft: false,
      } : letterData;

      const res = await previewRelievingLetter({
        data: {
          letterData: dataToRender,
          isDraft: false,
        },
      });

      const binaryString = atob(res.base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      setPdfPreviewBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      if (res.signatureDataUri) {
        setLetterSignatureDataUri(res.signatureDataUri);
      }
    } catch (err) {
      toast.error(describeUnknownError(err));
      setPdfPreviewOpen(false);
    } finally {
      setPdfLoading(false);
    }
  }

  useEffect(() => {
    if (activeTemplate?.slug === "employee_relieving_letter" && !letterPdfBlobUrl) {
      void refreshLetterPdf(letterData, isDraftMode);
    }
  }, [activeTemplate?.slug]);

  function handleSelectWorkforceEmployee(empId: string) {
    setSelectedEmployeeId(empId);
    const emp = (data?.employees ?? []).find((e: any) => e.id === empId);
    if (!emp) return;

    const joiningFormatted = emp.joiningDate || "2026-07-02";
    const todayFormatted = "2026-10-30";

    const updated: RelievingLetterData = {
      ...letterData,
      employeeName: emp.fullName,
      designation: emp.designation || "AI Data Annotation Analyst – Intern",
      joiningDate: joiningFormatted,
      lastWorkingDay: todayFormatted,
      relievingEffectiveDate: todayFormatted,
      letterIssueDate: todayFormatted,
    };
    setLetterData(updated);
    void refreshLetterPdf(updated, isDraftMode);

    // Sync to compose state as well
    setComposeEmployeeId(emp.id);
    setComposeRecipientEmail(emp.workEmail);
    setComposeRecipientName(emp.fullName);
    setComposeVars((prev) => ({
      ...prev,
      employee_name: emp.fullName,
      candidate_name: emp.fullName,
      employee_id: emp.employeeCode,
      designation: emp.designation || "AI Data Annotation Analyst – Intern",
      employment_start_date: formatLetterDate(joiningFormatted),
      employment_end_date: formatLetterDate(todayFormatted),
      relieving_date: formatLetterDate(todayFormatted),
      issue_date: formatLetterDate(todayFormatted),
      legal_employer: "Learning Paths Technologies LLP",
      signatory_name: "K. Spandana",
      signatory_title: "HR - Director",
      company_address: "T-hub 2.0, Knowledge City, Hyderabad, Telangana",
      company_contact: "+91 92468 18843",
    }));
  }

  function handleSelectFromUnifiedRecipient(rec: EmailCenterRecipientItem) {
    const rc = rec.relievingCase;
    const joiningFormatted = rc?.joiningDate || rec.joiningDate || "2026-07-02";
    const lastWorkingFormatted =
      rc?.lastWorkingDay || rec.lastWorkingDate || new Date().toISOString().slice(0, 10);
    const relievingFormatted =
      rc?.relievingEffectiveDate || rc?.lastWorkingDay || lastWorkingFormatted;
    const issueFormatted = rc?.letterIssueDate || lastWorkingFormatted;
    const caseApproved =
      rc?.status === "approved" || rc?.status === "relieved";

    const updated: RelievingLetterData = {
      ...letterData,
      employeeName: rec.fullName,
      designation: rc?.designation || rec.designation || "AI Data Annotation Analyst – Intern",
      legalEmployer:
        rc?.legalEmployer || rec.legalEmployer || "Learning Paths Technologies LLP",
      joiningDate: joiningFormatted,
      lastWorkingDay: lastWorkingFormatted,
      relievingEffectiveDate: relievingFormatted,
      letterIssueDate: issueFormatted,
      contributedProjects:
        rc?.contributedProjects ||
        `various ${rc?.designation || rec.designation || "Organizational"} and related projects`,
      performanceStatement: rc?.performanceStatement || "found to be satisfactory",
      signatoryName: rc?.signatoryName || "K. Spandana",
      signatoryTitle: rc?.signatoryTitle || "HR - Director",
      signatoryDesignation: rc?.signatoryDesignation || "Director",
      companyContact: rc?.companyContact || "+91 92468 18843",
      companyAddress:
        rc?.companyAddress || "T-hub 2.0, Knowledge City, Hyderabad, Telangana",
      isDraft: !caseApproved ? true : isDraftMode,
      includeSignature: caseApproved ? true : false,
    };

    if (!caseApproved && !isDraftMode) {
      setIsDraftMode(true);
    }
    setSelectedEmployeeId(rec.profileId || rec.recordId);
    setLetterData(updated);
    void refreshLetterPdf(updated, !caseApproved ? true : isDraftMode);

    // Sync compose fields for single recipient
    setComposeEmployeeId(rec.profileId || rec.recordId);
    setComposeRecipientEmail(rec.personalEmail || rec.workEmail || "");
    setComposeRecipientName(rec.fullName);
    setComposeVars((prev) => ({
      ...prev,
      employee_name: rec.fullName,
      candidate_name: rec.fullName,
      employee_id: rec.employeeCode || rec.historicalRecordId,
      designation: updated.designation,
      employment_start_date: formatLetterDate(joiningFormatted),
      employment_end_date: formatLetterDate(lastWorkingFormatted),
      relieving_date: formatLetterDate(relievingFormatted),
      issue_date: formatLetterDate(issueFormatted),
      legal_employer: updated.legalEmployer,
      signatory_name: updated.signatoryName,
      signatory_title: updated.signatoryTitle,
      company_address: updated.companyAddress || "T-hub 2.0, Knowledge City, Hyderabad, Telangana",
      company_contact: updated.companyContact || "+91 92468 18843",
    }));
  }

  async function handleDownloadLetterDirect(draft: boolean) {
    try {
      setLetterPdfLoading(true);
      const res = await previewRelievingLetter({
        data: {
          letterData: {
            ...letterData,
            isDraft: draft,
          },
          isDraft: draft,
        },
      });

      const link = document.createElement("a");
      link.href = `data:application/pdf;base64,${res.base64}`;
      const safeName = (letterData.employeeName || "Official").replace(/[^a-zA-Z0-9_-]/g, "_");
      link.download = draft
        ? `Draft_Experience_Letter_${safeName}.pdf`
        : `Experience_Letter_${safeName}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      toast.success(
        `Downloaded ${draft ? "draft (watermarked)" : "official (certified)"} letter PDF for ${letterData.employeeName}.`
      );
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setLetterPdfLoading(false);
    }
  }

  const activeComposeTemplate = templates.find((t) => t.slug === composeSlug);
  const visibleVars: EmailVariableKey[] = useMemo(() => {
    if (composeSlug === "employee_relieving_letter") {
      return [
        "employee_name",
        "employee_id",
        "designation",
        "employment_start_date",
        "employment_end_date",
        "relieving_date",
        "issue_date",
        "legal_employer",
        "signatory_name",
        "signatory_title",
        "company_address",
        "company_contact",
      ];
    }
    return activeComposeTemplate?.variables?.length
      ? (activeComposeTemplate.variables as EmailVariableKey[])
      : [
        "candidate_name",
        "designation",
        "department",
        "interview_date",
        "interview_time",
        "meeting_link",
        "joining_date",
        "employee_id",
        "hr_contact",
      ];
  }, [composeSlug, activeComposeTemplate]);

  function toggleBulkCandidate(id: string) {
    setBulkCandidateIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function handleSaveTemplate() {
    if (!activeTemplate) return;
    try {
      setSavingTemplate(true);
      await saveEmailTemplate({
        data: {
          slug: activeTemplate.slug,
          name: tplName,
          category: tplCategory,
          subjectTemplate: tplSubject,
          bodyHtmlTemplate: tplBodyHtml,
          bodyTextTemplate: tplBodyText || null,
        },
      });
      toast.success(`Saved template "${tplName}".`);
      await refreshCenter();
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setSavingTemplate(false);
    }
  }

  async function handleResetTemplate() {
    if (!activeTemplate) return;
    try {
      setSavingTemplate(true);
      await resetEmailTemplateToDefault({
        data: { slug: activeTemplate.slug },
      });
      toast.success(`Reset "${activeTemplate.name}" to standard default.`);
      await refreshCenter();
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setSavingTemplate(false);
    }
  }

  async function handleSaveDraft() {
    try {
      setDispatchBusy(true);
      await saveEmailDraft({
        data: {
          templateSlug: composeSlug,
          candidateId: composeCandidateId || null,
          recipientEmail: composeRecipientEmail,
          recipientName: composeRecipientName || null,
          subject: composePreview.subject,
          bodyHtml: composePreview.bodyHtml,
          bodyText: composePreview.bodyText,
          variables: composeVars,
        },
      });
      toast.success("Email draft saved to Delivery & Audit History.");
      await refreshCenter();
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setDispatchBusy(false);
    }
  }

  async function handleSendIndividualOrTest(isTest: boolean) {
    try {
      setDispatchBusy(true);
      const res = await sendRecruitmentEmail({
        data: {
          templateSlug: composeSlug,
          candidateId: isTest ? null : composeCandidateId || null,
          recipientEmail: composeRecipientEmail,
          recipientName: composeRecipientName || null,
          subjectTemplate: composeSubjectTpl,
          bodyHtmlTemplate: composeBodyHtmlTpl,
          bodyTextTemplate: composeBodyTextTpl || null,
          variables: composeVars,
          isTest,
        },
      });
      toast.success(
        res.deduplicated
          ? "Duplicate send prevented (already accepted within this window)."
          : `${isTest ? "Test email" : "Email"} accepted by provider (status: ${res.status}).`,
      );
      await refreshCenter();
    } catch (err) {
      toast.error(describeUnknownError(err));
      await refreshCenter();
    } finally {
      setDispatchBusy(false);
    }
  }

  async function handleSendBulk() {
    try {
      setDispatchBusy(true);
      const res = await sendBulkRecruitmentEmails({
        data: {
          candidateIds: bulkCandidateIds,
          templateSlug: composeSlug,
          sharedVariables: composeVars,
        },
      });
      toast.success(
        `Bulk dispatch complete: ${res.sentCount} sent, ${res.skippedDuplicateCount} skipped (duplicate), ${res.failedCount} failed.`,
      );
      setBulkCandidateIds([]);
      await refreshCenter();
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setDispatchBusy(false);
    }
  }

  async function handleRetryMessage(messageId: string) {
    try {
      setRetryingId(messageId);
      const res = await retryFailedEmail({ data: { messageId } });
      toast.success(`Retry accepted by SMTP — status updated to "${res.status}".`);
      await refreshCenter();
    } catch (err) {
      toast.error(describeUnknownError(err));
      await refreshCenter();
    } finally {
      setRetryingId(null);
    }
  }

  async function handleCancelMessage(messageId: string) {
    try {
      setCancelingId(messageId);
      await cancelEmailMessage({ data: { messageId } });
      toast.success("Queued/draft email marked as canceled.");
      await refreshCenter();
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setCancelingId(null);
    }
  }

  async function handleVerifySmtp() {
    try {
      setVerifyingSmtp(true);
      const res = await verifyEmailProviderConnection();
      if (res.ok) {
        toast.success(res.message);
      } else {
        toast.error(res.message);
      }
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setVerifyingSmtp(false);
    }
  }

  return (
    <AppShell
      title="HR Email & Communication Center"
      description="Manage standardized recruitment, onboarding & HR communication templates, validate dynamic placeholders, preview branded layouts, and dispatch via Hostinger SMTP."
      actions={
        <Button
          size="sm"
          variant="outline"
          onClick={() => centerQuery.refetch()}
          disabled={centerQuery.isFetching}
        >
          <RefreshCw className="mr-1.5 size-3.5" />
          Refresh
        </Button>
      }
    >
      {/* Schema Readiness Notice */}
      {data && !data.schemaReady ? (
        <Card className="mb-4 border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-start gap-3 pt-5">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
            <div className="space-y-1 text-sm">
              <p className="font-semibold text-foreground">
                Phase P2 Email Tables Pending Migration Approval
              </p>
              <p className="text-muted-foreground">
                All 15 default HR templates are loaded for live variable validation and
                preview. Persistent template edits, drafts, and audit logs will activate
                once{" "}
                <code className="text-xs">
                  20261112000000_p2_recruitment_interviews_and_email_center.sql
                </code>{" "}
                is deployed.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Email Provider Readiness Indicator */}
      {data ? (
        providerConfigured ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-2.5 text-xs shadow-xs">
            <div className="flex items-center gap-2">
              <span className="flex size-2 rounded-full bg-emerald-500 ring-2 ring-emerald-500/20" />
              <span className="font-semibold text-foreground">Email Service Connected</span>
              <span className="hidden text-muted-foreground sm:inline">
                · Hostinger SMTP ({data.providerStatus.senderDisplay})
              </span>
            </div>
            <div className="flex items-center gap-2">
              {canSendEmails ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => void handleVerifySmtp()}
                  disabled={verifyingSmtp}
                >
                  <RefreshCw className="mr-1 size-3" />
                  {verifyingSmtp ? "Verifying..." : "Verify Connection"}
                </Button>
              ) : null}
              <details className="relative text-[11px] text-muted-foreground">
                <summary className="cursor-pointer font-medium hover:text-foreground">
                  Server Details
                </summary>
                <div className="absolute right-0 z-20 mt-2 w-72 rounded-md border bg-popover p-2.5 text-xs shadow-md">
                  <p className="mb-1 font-semibold text-foreground">Hostinger SMTP Settings</p>
                  <p className="text-muted-foreground">
                    Host:{" "}
                    <code className="font-mono text-foreground">
                      {data.providerStatus.smtpHost}:{data.providerStatus.smtpPort}
                    </code>
                  </p>
                  <p className="text-muted-foreground">
                    Security:{" "}
                    <code className="font-mono text-foreground">
                      {data.providerStatus.smtpSecure ? "SSL/TLS" : "STARTTLS"}
                    </code>
                  </p>
                  <p className="text-muted-foreground">
                    From:{" "}
                    <code className="font-mono text-foreground">
                      {data.providerStatus.senderDisplay}
                    </code>
                  </p>
                </div>
              </details>
            </div>
          </div>
        ) : (
          <Card className="mb-5 border-amber-500/40 bg-amber-500/5">
            <CardContent className="flex items-start gap-3 pt-5">
              <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-600" />
              <div className="space-y-1.5 text-xs">
                <p className="text-sm font-semibold text-foreground">
                  Live Email Sending Locked — Hostinger SMTP Configuration Required
                </p>
                <p className="text-muted-foreground">
                  Template editing, variable validation, branded HTML preview, and saving
                  drafts are fully available. Live sending unlocks automatically once
                  Hostinger SMTP environment variables (<code>SMTP_HOST</code>,{" "}
                  <code>SMTP_PORT</code>, <code>SMTP_SECURE</code>, <code>SMTP_USER</code>,{" "}
                  <code>SMTP_PASS</code>, <code>EMAIL_FROM</code>) are configured on the server:
                </p>
                <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                  {data.providerStatus.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            </CardContent>
          </Card>
        )
      ) : null}

      {!canManageTemplates && !canSendEmails ? (
        <div className="mb-5 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
          <span>
            <strong className="text-foreground">Read-Only Email Center View</strong> —
            Inspect standardized HR templates, variable previews, and communication audit
            logs.
          </span>
          <Badge variant="outline">Read-Only</Badge>
        </div>
      ) : null}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-5">
        <TabsList>
          <TabsTrigger value="templates">
            <FileCode2 className="mr-1.5 size-3.5" />
            HR Templates ({templates.length})
          </TabsTrigger>
          <TabsTrigger value="compose">
            <Send className="mr-1.5 size-3.5" />
            Compose, Bulk &amp; Test Send
          </TabsTrigger>
          <TabsTrigger value="logs">
            <Mail className="mr-1.5 size-3.5" />
            Delivery Status &amp; Retry ({data?.stats.total ?? 0})
          </TabsTrigger>
        </TabsList>

        {/* TAB 1: 16 EDITABLE TEMPLATES GROUPED BY CATEGORY */}
        <TabsContent value="templates" className="space-y-4">
          <div className="grid gap-5 lg:grid-cols-12">
            {/* Left Template Selector Grouped by Category */}
            <Card className="lg:col-span-4">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Standard HR Templates</CardTitle>
                <CardDescription>
                  16 standardized templates organized by lifecycle stage.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {TEMPLATE_CATEGORIES.map((cat) => {
                  const catTemplates = templates.filter((t) => cat.slugs.includes(t.slug));
                  if (catTemplates.length === 0) return null;
                  return (
                    <div key={cat.id} className="space-y-1.5">
                      <p className="px-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                        {cat.label} ({catTemplates.length})
                      </p>
                      <div className="space-y-1">
                        {catTemplates.map((tpl) => {
                          const selected = !customModeActive && tpl.slug === activeTemplate?.slug;
                          return (
                            <button
                              key={tpl.slug}
                              type="button"
                              onClick={() => {
                                setCustomModeActive(false);
                                setSelectedSlug(tpl.slug);
                              }}
                              className={`flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${selected
                                ? "border-primary bg-primary/10 font-semibold text-primary"
                                : "border-border/60 bg-card text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                                }`}
                            >
                              <span className="truncate pr-1.5">{tpl.name}</span>
                              <code className="shrink-0 font-mono text-[10px] text-muted-foreground">
                                {tpl.slug}
                              </code>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {/* CUSTOM EMAIL TEMPLATES — Directly below Relieving & Experience Letters */}
                {canViewCustomTemplates ? (
                  <div className="space-y-2 border-t border-border pt-3">
                    <div className="flex items-center justify-between px-1">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-primary">
                        Custom Email Templates ({customTemplatesQuery.data?.templates.length ?? 0})
                      </p>
                      <Badge variant="outline" className="text-[9px]">
                        DOCX / PDF
                      </Badge>
                    </div>
                    <div className="grid gap-1">
                      {customAccess.canManageCustomTemplates ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setCustomModeActive(true);
                              setSelectedCustomTemplateId(null);
                              setCustomWorkspaceSubTab("compose");
                            }}
                            className="flex w-full items-center justify-between rounded-md border border-border/80 bg-card px-2.5 py-1.5 text-left text-xs font-medium text-foreground transition-colors hover:border-primary hover:bg-primary/5"
                          >
                            <span>+ Create Custom Template</span>
                            <Badge variant="outline" className="text-[9px]">New</Badge>
                          </button>
                          <label className="flex w-full cursor-pointer items-center justify-between rounded-md border border-border/80 bg-card px-2.5 py-1.5 text-left text-xs font-medium text-foreground transition-colors hover:border-primary hover:bg-primary/5">
                            <span>Upload Word / PDF</span>
                            <Badge variant="outline" className="text-[9px]">Private</Badge>
                            <input
                              type="file"
                              accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                              className="sr-only"
                              onChange={(e) => {
                                const file = e.target.files?.[0] ?? null;
                                e.target.value = "";
                                if (!file) return;
                                setCustomModeActive(true);
                                setSelectedCustomTemplateId(null);
                                setCustomWorkspaceSubTab("compose");
                                setPendingSidebarUploadFile(file);
                              }}
                            />
                          </label>
                        </>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          setCustomModeActive(true);
                          setCustomWorkspaceSubTab("library");
                        }}
                        className={`flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${customModeActive && !selectedCustomTemplateId
                          ? "border-primary bg-primary/10 font-semibold text-primary"
                          : "border-border/60 bg-card text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                          }`}
                      >
                        <span>Manage Templates</span>
                        <span className="font-mono text-[10px]">
                          {customTemplatesQuery.data?.templates.length ?? 0}
                        </span>
                      </button>
                      {(customTemplatesQuery.data?.templates ?? []).map((ct) => {
                        const isSelected = customModeActive && selectedCustomTemplateId === ct.id;
                        return (
                          <button
                            key={ct.id}
                            type="button"
                            onClick={() => {
                              setCustomModeActive(true);
                              setSelectedCustomTemplateId(ct.id);
                              setCustomWorkspaceSubTab("compose");
                            }}
                            className={`flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${isSelected
                              ? "border-primary bg-primary/10 font-semibold text-primary"
                              : "border-border/60 bg-card text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                              }`}
                          >
                            <span className="truncate pr-1.5">{ct.name}</span>
                            <Badge variant="outline" className="shrink-0 text-[9px] uppercase">
                              {ct.attachmentFormat === "none" ? ct.status : ct.attachmentFormat}
                            </Badge>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {/* Right Editor + Live Branded Preview */}
            <div className="space-y-4 lg:col-span-8">
              {customModeActive && canViewCustomTemplates ? (
                <CustomTemplatesWorkspace
                  selectedTemplateId={selectedCustomTemplateId}
                  onSelectTemplateId={setSelectedCustomTemplateId}
                  subTab={customWorkspaceSubTab}
                  onChangeSubTab={setCustomWorkspaceSubTab}
                  providerConfigured={providerConfigured}
                  initialFileToUpload={pendingSidebarUploadFile}
                  onConsumedInitialFile={() => setPendingSidebarUploadFile(null)}
                  onBatchUpdated={() => {
                    void dispatchBatchesQuery.refetch();
                    void refreshCenter();
                  }}
                />
              ) : activeTemplate?.slug === "employee_relieving_letter" ? (
                /* OFFICIAL LETTER (PDF) as PRIMARY + EMAIL MESSAGE as SECONDARY */
                <Tabs
                  value={relievingSubTab}
                  onValueChange={(v) => setRelievingSubTab(v as any)}
                  className="space-y-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-2.5 shadow-xs">
                    <TabsList className="bg-muted">
                      <TabsTrigger
                        value="official_letter"
                        className="gap-2 text-xs font-semibold data-[state=active]:bg-background data-[state=active]:text-primary"
                      >
                        <FileText className="size-3.5 text-primary" />
                        OFFICIAL LETTER (PDF)
                      </TabsTrigger>
                      <TabsTrigger
                        value="email_message"
                        className="gap-2 text-xs font-semibold data-[state=active]:bg-background"
                      >
                        <Mail className="size-3.5" />
                        EMAIL MESSAGE (COVER)
                      </TabsTrigger>
                    </TabsList>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="border-primary/40 bg-primary/5 text-primary text-[11px] font-medium">
                        Authoritative Template: Macharla Chantii.docx
                      </Badge>
                    </div>
                  </div>

                  {/* SUB-TAB 1: OFFICIAL LETTER (PDF) - PRIMARY VIEW */}
                  <TabsContent value="official_letter" className="space-y-4 m-0">
                    {/* Controls Card */}
                    <Card className="border-border">
                      <CardHeader className="pb-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <CardTitle className="text-base flex items-center gap-2">
                              <FileText className="size-4 text-primary" />
                              Official Experience &amp; Relieving Letter Generator
                            </CardTitle>
                            <CardDescription className="text-xs">
                              Populate verified employee tenure details to generate the authoritative single-page A4 document.
                            </CardDescription>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void handleDownloadLetterDirect(true)}
                              disabled={letterPdfLoading}
                            >
                              <Download className="mr-1.5 size-3.5 text-amber-600" />
                              Download Draft
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => void handleDownloadLetterDirect(false)}
                              disabled={letterPdfLoading}
                            >
                              <Download className="mr-1.5 size-3.5" />
                              Download Official PDF
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setComposeSlug("employee_relieving_letter");
                                setActiveTab("compose");
                              }}
                            >
                              <Send className="mr-1.5 size-3.5" />
                              Dispatch via Email
                            </Button>
                          </div>
                        </div>
                      </CardHeader>

                      <CardContent className="space-y-4">
                        {/* Searchable Single & Multi-Employee Selector (Workforce + Employee Records) */}
                        <MultiRelievingPanel
                          canSendEmails={canSendEmails}
                          canViewPersonalEmails={customAccess.canViewPersonalEmails}
                          providerConfigured={providerConfigured}
                          onSelectSingleEmployee={handleSelectFromUnifiedRecipient}
                          onBatchUpdated={() => {
                            void dispatchBatchesQuery.refetch();
                            void refreshCenter();
                          }}
                        />

                        {/* Editable Form Inputs Grid */}
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-xs">
                          <div className="space-y-1">
                            <Label htmlFor="let-emp-name" className="text-[11px] font-medium">Employee Full Name</Label>
                            <Input
                              id="let-emp-name"
                              value={letterData.employeeName}
                              onChange={(e) => setLetterData((prev) => ({ ...prev, employeeName: e.target.value }))}
                              className="h-8 text-xs font-medium"
                            />
                          </div>

                          <div className="space-y-1">
                            <Label htmlFor="let-desig" className="text-[11px] font-medium">Designation</Label>
                            <Input
                              id="let-desig"
                              value={letterData.designation}
                              onChange={(e) => setLetterData((prev) => ({ ...prev, designation: e.target.value }))}
                              className="h-8 text-xs"
                            />
                          </div>

                          <div className="space-y-1">
                            <Label htmlFor="let-legal-emp" className="text-[11px] font-medium">Legal Employer</Label>
                            <Input
                              id="let-legal-emp"
                              value={letterData.legalEmployer}
                              onChange={(e) => setLetterData((prev) => ({ ...prev, legalEmployer: e.target.value }))}
                              className="h-8 text-xs"
                            />
                          </div>

                          <div className="space-y-1">
                            <Label htmlFor="let-join-date" className="text-[11px] font-medium">Joining Date</Label>
                            <Input
                              id="let-join-date"
                              value={letterData.joiningDate}
                              onChange={(e) => setLetterData((prev) => ({ ...prev, joiningDate: e.target.value }))}
                              className="h-8 text-xs font-mono"
                              placeholder="YYYY-MM-DD or 2 Jul 2026"
                            />
                          </div>

                          <div className="space-y-1">
                            <Label htmlFor="let-last-day" className="text-[11px] font-medium">Last Working Day</Label>
                            <Input
                              id="let-last-day"
                              value={letterData.lastWorkingDay}
                              onChange={(e) => setLetterData((prev) => ({ ...prev, lastWorkingDay: e.target.value }))}
                              className="h-8 text-xs font-mono"
                              placeholder="YYYY-MM-DD or 30 Oct 2026"
                            />
                          </div>

                          <div className="space-y-1">
                            <Label htmlFor="let-rel-date" className="text-[11px] font-medium">Relieving Effective Date</Label>
                            <Input
                              id="let-rel-date"
                              value={letterData.relievingEffectiveDate}
                              onChange={(e) => setLetterData((prev) => ({ ...prev, relievingEffectiveDate: e.target.value }))}
                              className="h-8 text-xs font-mono"
                              placeholder="YYYY-MM-DD or 30 Oct 2026"
                            />
                          </div>

                          <div className="space-y-1">
                            <Label htmlFor="let-issue-date" className="text-[11px] font-medium">Letter Issue Date</Label>
                            <Input
                              id="let-issue-date"
                              value={letterData.letterIssueDate}
                              onChange={(e) => setLetterData((prev) => ({ ...prev, letterIssueDate: e.target.value }))}
                              className="h-8 text-xs font-mono"
                              placeholder="YYYY-MM-DD or 30 Oct 2026"
                            />
                          </div>

                          <div className="space-y-1">
                            <Label htmlFor="let-sig-name" className="text-[11px] font-medium">Approved Signatory Name</Label>
                            <Input
                              id="let-sig-name"
                              value={letterData.signatoryName}
                              onChange={(e) => setLetterData((prev) => ({ ...prev, signatoryName: e.target.value }))}
                              className="h-8 text-xs"
                            />
                          </div>

                          <div className="space-y-1">
                            <Label htmlFor="let-sig-title" className="text-[11px] font-medium">Approved Signatory Title</Label>
                            <Input
                              id="let-sig-title"
                              value={letterData.signatoryTitle}
                              onChange={(e) => setLetterData((prev) => ({ ...prev, signatoryTitle: e.target.value }))}
                              className="h-8 text-xs"
                            />
                          </div>
                        </div>

                        {/* Bottom toolbar */}
                        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-border">
                          <label className="flex items-center gap-2 cursor-pointer text-xs">
                            <Checkbox
                              checked={isDraftMode}
                              onCheckedChange={(checked) => {
                                const val = Boolean(checked);
                                setIsDraftMode(val);
                                void refreshLetterPdf(letterData, val);
                              }}
                            />
                            <span className="font-medium text-muted-foreground">
                              Include "DRAFT — FOR REVIEW ONLY" watermark
                            </span>
                          </label>

                          <div className="flex items-center gap-2">
                            <div className="flex rounded-md border border-input p-0.5 bg-muted/40">
                              <Button
                                type="button"
                                size="sm"
                                variant={letterViewMode === "pdf" ? "default" : "ghost"}
                                className="h-7 text-xs px-2.5"
                                onClick={() => setLetterViewMode("pdf")}
                              >
                                PDF Renderer
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant={letterViewMode === "document" ? "default" : "ghost"}
                                className="h-7 text-xs px-2.5"
                                onClick={() => setLetterViewMode("document")}
                              >
                                Document View
                              </Button>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void refreshLetterPdf(letterData, isDraftMode)}
                              disabled={letterPdfLoading}
                            >
                              <RefreshCw className={`mr-1.5 size-3.5 ${letterPdfLoading ? "animate-spin" : ""}`} />
                              Update Preview
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>

                    {/* Live A4 Document Preview Card */}
                    <Card className="border-border">
                      <CardHeader className="pb-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <CardTitle className="text-base flex items-center gap-2">
                              <Eye className="size-4 text-muted-foreground" />
                              Primary A4 Document Preview
                            </CardTitle>
                            <CardDescription className="text-xs">
                              Exact reproduction of <strong>Macharla Chantii.docx</strong> with official branding, geometry, and authorized stamp.
                            </CardDescription>
                          </div>
                          <Badge variant="outline" className="font-mono text-[10px]">
                            A4 (595 × 842 pt)
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent>
                        {letterViewMode === "pdf" ? (
                          <div className="w-full flex flex-col items-center justify-center bg-zinc-200/50 dark:bg-zinc-900/60 p-3 sm:p-5 rounded-lg border border-border">
                            {letterPdfLoading ? (
                              <div className="h-[750px] w-full flex flex-col items-center justify-center gap-3 text-muted-foreground">
                                <RefreshCw className="size-8 animate-spin text-primary" />
                                <p className="text-sm font-medium">Generating official letter PDF...</p>
                              </div>
                            ) : letterPdfBlobUrl ? (
                              <iframe
                                key={letterPdfBlobUrl}
                                src={`${letterPdfBlobUrl}#toolbar=0&navpanes=0`}
                                title="Official Experience & Relieving Letter A4"
                                className="w-full h-[760px] sm:h-[820px] rounded border border-zinc-300 shadow-lg bg-white"
                              />
                            ) : (
                              <div className="h-[400px] flex items-center justify-center text-muted-foreground">
                                No PDF preview available. Click "Update Preview".
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="w-full flex justify-center bg-zinc-200/50 dark:bg-zinc-900/60 p-4 sm:p-6 rounded-lg border border-border overflow-x-auto">
                            <div className="w-full max-w-[620px] bg-white text-zinc-900 shadow-xl rounded-sm border border-zinc-200 overflow-hidden relative font-sans text-xs select-text">
                              {isDraftMode && (
                                <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
                                  <span className="text-rose-500/25 text-5xl font-black rotate-[-35deg] tracking-widest select-none">
                                    DRAFT — FOR REVIEW ONLY
                                  </span>
                                </div>
                              )}
                              {/* Top Header Banner */}
                              <img
                                src="/branding/relieving/header-banner.png"
                                alt="The AI School & Learning Paths Technologies LLP Header"
                                className="w-full block"
                              />

                              {/* Body Content matching Macharla Chantii.docx */}
                              <div className="px-8 py-6 space-y-3.5 leading-relaxed text-zinc-800">
                                <p className="font-bold text-zinc-900">Private &amp; Confidential</p>
                                <p className="font-bold text-zinc-900">Date: {formatLetterDate(letterData.letterIssueDate)}</p>
                                <p className="font-bold text-zinc-900 underline">Subject:  Experience Letter.</p>
                                <p className="font-bold text-zinc-900 pt-1">Dear {letterData.employeeName},</p>

                                <p className="pt-1">
                                  This is to certify that you were associated with{" "}
                                  <strong className="text-zinc-900">{letterData.legalEmployer}</strong> as an{" "}
                                  <strong className="text-zinc-900">{letterData.designation}</strong> from{" "}
                                  <strong className="text-zinc-900">
                                    {formatLetterDate(letterData.joiningDate)} to {formatLetterDate(letterData.lastWorkingDay)}
                                  </strong>
                                </p>

                                <p>
                                  During your tenure, you contributed to various {letterData.contributedProjects}. Your conduct
                                  and performance during this period were found to be {letterData.performanceStatement}.
                                </p>

                                <p>
                                  As you have completed your tenure with us and duly handed over all assigned responsibilities,
                                  we hereby relieve you from your duties effective close of business on{" "}
                                  <strong className="text-zinc-900">{formatLetterDate(letterData.relievingEffectiveDate)}</strong>
                                </p>

                                <p>
                                  We wish you continued success in your future academic and professional endeavors.
                                </p>

                                {/* Dedicated Signatory Block matching PDF coordinates & Word layout */}
                                <div className="pt-6 space-y-1">
                                  <p className="text-zinc-800">Yours truly,</p>
                                  <p className="font-bold text-zinc-900">{letterData.legalEmployer}</p>
                                </div>

                                {/* Dedicated Signature & Stamp Container with fixed margin, min-height, and no absolute overlap */}
                                <div className="my-3 min-h-[96px] flex items-center">
                                  {letterSignatureDataUri ? (
                                    <img
                                      src={letterSignatureDataUri}
                                      alt="Authorized Learning Paths Technologies LLP Signature and Seal"
                                      className="h-24 w-auto object-contain select-none"
                                    />
                                  ) : (
                                    <div className="w-40 h-20 border border-dashed border-zinc-300 rounded-md bg-zinc-50 flex flex-col items-center justify-center text-[10px] text-zinc-600 font-mono p-2 text-center">
                                      <span className="font-semibold text-zinc-700">Authorized Signature Pending</span>
                                      <span className="text-[9px] text-zinc-500">Click Update Preview to load</span>
                                    </div>
                                  )}
                                </div>

                                <div className="space-y-0.5">
                                  <p className="font-bold text-zinc-900">{letterData.signatoryName} HR -</p>
                                  <p className="text-zinc-700">{letterData.signatoryDesignation || letterData.signatoryTitle}</p>
                                </div>
                              </div>

                              {/* Bottom Footer Banner */}
                              <img
                                src="/branding/relieving/footer-banner.png"
                                alt="The AI School Contact & Address Footer"
                                className="w-full block"
                              />
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </TabsContent>

                  {/* SUB-TAB 2: EMAIL MESSAGE (COVER) */}
                  <TabsContent value="email_message" className="space-y-4 m-0">
                    <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3 text-xs text-blue-800 dark:text-blue-200">
                      <p className="font-semibold text-blue-900 dark:text-blue-100 flex items-center gap-1.5">
                        <Mail className="size-3.5 text-blue-600" />
                        Accompanying Cover Email Template
                      </p>
                      <p className="mt-0.5 text-blue-700 dark:text-blue-300">
                        This email message is sent via Hostinger SMTP (<code>hr@theaischool.co</code>) to deliver the official A4
                        Experience &amp; Relieving Letter PDF attachment to the employee.
                      </p>
                    </div>

                    <Card>
                      <CardHeader className="pb-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <CardTitle className="text-base">Cover Email Template</CardTitle>
                            <CardDescription>
                              Slug: <code className="font-mono">{activeTemplate?.slug}</code>
                            </CardDescription>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {canManageTemplates ? (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setResetConfirmOpen(true)}
                                  disabled={savingTemplate || !data?.schemaReady}
                                >
                                  <RotateCcw className="mr-1.5 size-3.5" />
                                  Reset Default
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={handleSaveTemplate}
                                  disabled={
                                    savingTemplate ||
                                    !editorValidation.valid ||
                                    !data?.schemaReady
                                  }
                                >
                                  <Save className="mr-1.5 size-3.5" />
                                  {savingTemplate ? "Saving..." : "Save Template"}
                                </Button>
                              </>
                            ) : null}
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label htmlFor="rel-tpl-name">Email Display Name</Label>
                            <Input
                              id="rel-tpl-name"
                              value={tplName}
                              disabled={!canManageTemplates}
                              onChange={(e) => setTplName(e.target.value)}
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="rel-tpl-subject">Email Subject Line Template</Label>
                            <Input
                              id="rel-tpl-subject"
                              value={tplSubject}
                              disabled={!canManageTemplates}
                              onChange={(e) => setTplSubject(e.target.value)}
                            />
                          </div>
                        </div>

                        <Tabs
                          value={editorTab}
                          onValueChange={(v) => setEditorTab(v as any)}
                          className="w-full"
                        >
                          <TabsList className="grid w-full grid-cols-2">
                            <TabsTrigger value="visual">HTML Body Template</TabsTrigger>
                            <TabsTrigger value="code">Plain-Text Fallback</TabsTrigger>
                          </TabsList>

                          <TabsContent value="visual" className="space-y-2 pt-2">
                            <div className="space-y-1.5">
                              <Label htmlFor="rel-tpl-html" className="text-xs">
                                HTML Body (Formatted message that accompanies the PDF)
                              </Label>
                              <Textarea
                                id="rel-tpl-html"
                                rows={6}
                                value={tplBodyHtml}
                                disabled={!canManageTemplates}
                                onChange={(e) => setTplBodyHtml(e.target.value)}
                                className="font-mono text-xs"
                              />
                            </div>
                          </TabsContent>

                          <TabsContent value="code" className="space-y-2 pt-2">
                            <div className="space-y-1.5">
                              <Label htmlFor="rel-tpl-text" className="text-xs">
                                Plain-Text Fallback Template
                              </Label>
                              <Textarea
                                id="rel-tpl-text"
                                rows={6}
                                value={tplBodyText}
                                disabled={!canManageTemplates}
                                onChange={(e) => setTplBodyText(e.target.value)}
                                className="font-mono text-xs"
                              />
                            </div>
                          </TabsContent>
                        </Tabs>
                      </CardContent>
                    </Card>

                    {/* Live Branded HTML Email Preview */}
                    <Card>
                      <CardHeader className="pb-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <CardTitle className="flex items-center gap-2 text-base">
                            <Eye className="size-4 text-muted-foreground" />
                            Live Branded Email Preview
                          </CardTitle>
                          <div className="flex flex-wrap gap-1" role="group" aria-label="Email preview mode">
                            <Button
                              type="button"
                              size="sm"
                              aria-pressed={previewMode === "desktop"}
                              variant={previewMode === "desktop" ? "default" : "outline"}
                              onClick={() => setPreviewMode("desktop")}
                            >
                              <Monitor className="mr-1 size-3.5" />
                              Desktop
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              aria-pressed={previewMode === "mobile"}
                              variant={previewMode === "mobile" ? "default" : "outline"}
                              onClick={() => setPreviewMode("mobile")}
                            >
                              <Smartphone className="mr-1 size-3.5" />
                              Mobile
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              aria-pressed={previewMode === "text"}
                              variant={previewMode === "text" ? "default" : "outline"}
                              onClick={() => setPreviewMode("text")}
                            >
                              <AlignLeft className="mr-1 size-3.5" />
                              Text
                            </Button>
                          </div>
                        </div>
                        <CardDescription>
                          Subject: <strong>{editorPreview.subject}</strong>
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {previewMode === "text" ? (
                          <pre className="h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-4 font-mono text-xs text-foreground">
                            {editorPreview.bodyText}
                          </pre>
                        ) : (
                          <div className={previewMode === "mobile" ? "mx-auto max-w-[375px]" : ""}>
                            <iframe
                              title="Branded HR Email Preview"
                              sandbox="allow-same-origin"
                              srcDoc={editorPreview.bodyHtml}
                              className="h-64 w-full rounded-md border border-border bg-zinc-100"
                            />
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </TabsContent>
                </Tabs>
              ) : (
                /* Standard Template Editor for all other 15 templates */
                <>
                  <Card>
                    <CardHeader className="pb-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <CardTitle className="text-base">
                            {activeTemplate?.name ?? "Template Editor"}
                          </CardTitle>
                          <CardDescription>
                            Slug: <code className="font-mono">{activeTemplate?.slug}</code>
                          </CardDescription>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {canManageTemplates ? (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setResetConfirmOpen(true)}
                                disabled={savingTemplate || !data?.schemaReady}
                              >
                                <RotateCcw className="mr-1.5 size-3.5" />
                                Reset Default
                              </Button>
                              <Button
                                size="sm"
                                onClick={handleSaveTemplate}
                                disabled={
                                  savingTemplate ||
                                  !editorValidation.valid ||
                                  !data?.schemaReady
                                }
                              >
                                <Save className="mr-1.5 size-3.5" />
                                {savingTemplate ? "Saving..." : "Save Template"}
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {/* Clean Dynamic Variables Toolbar */}
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Sparkles className="size-3.5 text-primary" />
                          <span className="font-medium text-foreground">Dynamic Placeholders</span>
                        </div>
                        {canManageTemplates && (
                          <select
                            aria-label="Insert dynamic variable"
                            value=""
                            onChange={(e) => {
                              if (e.target.value) {
                                insertVariableIntoHtml(e.target.value as EmailVariableKey);
                              }
                            }}
                            className="h-8 rounded-md border border-input bg-background px-2.5 font-medium text-xs text-foreground"
                          >
                            <option value="">+ Insert Variable into HTML...</option>
                            {SUPPORTED_EMAIL_VARIABLES.map((v) => (
                              <option key={v} value={v}>
                                {`{{${v}}}`} — {EMAIL_VARIABLE_DESCRIPTIONS[v]}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>

                      {!editorValidation.valid ? (
                        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                          Unsupported placeholder(s):{" "}
                          <strong>
                            {editorValidation.unknownVariables
                              .map((v) => `{{${v}}}`)
                              .join(", ")}
                          </strong>
                          . Use only supported placeholders.
                        </div>
                      ) : null}

                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label htmlFor="tpl-name">Template Display Name</Label>
                          <Input
                            id="tpl-name"
                            value={tplName}
                            disabled={!canManageTemplates}
                            onChange={(e) => setTplName(e.target.value)}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="tpl-subject">Subject Line Template</Label>
                          <Input
                            id="tpl-subject"
                            value={tplSubject}
                            disabled={!canManageTemplates}
                            onChange={(e) => setTplSubject(e.target.value)}
                          />
                        </div>
                      </div>

                      <Tabs
                        value={editorTab}
                        onValueChange={(v) => setEditorTab(v as any)}
                        className="w-full"
                      >
                        <TabsList className="grid w-full grid-cols-2">
                          <TabsTrigger value="visual">HTML Body Template</TabsTrigger>
                          <TabsTrigger value="code">Plain-Text Fallback</TabsTrigger>
                        </TabsList>

                        <TabsContent value="visual" className="space-y-2 pt-2">
                          <div className="space-y-1.5">
                            <Label htmlFor="tpl-html" className="text-xs">
                              HTML Body (Formatted layout)
                            </Label>
                            <Textarea
                              id="tpl-html"
                              rows={6}
                              value={tplBodyHtml}
                              disabled={!canManageTemplates}
                              onChange={(e) => setTplBodyHtml(e.target.value)}
                              className="font-mono text-xs"
                            />
                          </div>
                        </TabsContent>

                        <TabsContent value="code" className="space-y-2 pt-2">
                          <div className="space-y-1.5">
                            <Label htmlFor="tpl-text" className="text-xs">
                              Plain-Text Fallback Template (Used by non-HTML email clients)
                            </Label>
                            <Textarea
                              id="tpl-text"
                              rows={6}
                              value={tplBodyText}
                              disabled={!canManageTemplates}
                              onChange={(e) => setTplBodyText(e.target.value)}
                              className="font-mono text-xs"
                            />
                          </div>
                        </TabsContent>
                      </Tabs>
                    </CardContent>
                  </Card>

                  {/* Live Branded HTML Preview */}
                  <Card>
                    <CardHeader className="pb-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <CardTitle className="flex items-center gap-2 text-base">
                          <Eye className="size-4 text-muted-foreground" />
                          Live Branded Preview (Sample Candidate Context)
                        </CardTitle>
                        <div className="flex flex-wrap gap-1" role="group" aria-label="Email preview mode">
                          <Button
                            type="button"
                            size="sm"
                            aria-pressed={previewMode === "desktop"}
                            variant={previewMode === "desktop" ? "default" : "outline"}
                            onClick={() => setPreviewMode("desktop")}
                          >
                            <Monitor className="mr-1 size-3.5" />
                            Desktop HTML
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            aria-pressed={previewMode === "mobile"}
                            variant={previewMode === "mobile" ? "default" : "outline"}
                            onClick={() => setPreviewMode("mobile")}
                          >
                            <Smartphone className="mr-1 size-3.5" />
                            Mobile 375px
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            aria-pressed={previewMode === "text"}
                            variant={previewMode === "text" ? "default" : "outline"}
                            onClick={() => setPreviewMode("text")}
                          >
                            <AlignLeft className="mr-1 size-3.5" />
                            Plain Text
                          </Button>
                        </div>
                      </div>
                      <CardDescription>
                        Rendered Subject: <strong>{editorPreview.subject}</strong>
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {previewMode === "text" ? (
                        <pre className="h-80 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-4 font-mono text-xs text-foreground">
                          {editorPreview.bodyText}
                        </pre>
                      ) : (
                        <div className={previewMode === "mobile" ? "mx-auto max-w-[375px]" : ""}>
                          <iframe
                            title="Branded HR Email Preview"
                            sandbox="allow-same-origin"
                            srcDoc={editorPreview.bodyHtml}
                            className="h-80 w-full rounded-md border border-border bg-zinc-100"
                          />
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </>
              )}
            </div>
          </div>
        </TabsContent>

        {/* TAB 2: COMPOSE, BULK SEND & TEST EMAIL */}
        <TabsContent value="compose" className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={composeMode === "individual" ? "default" : "outline"}
              onClick={() => setComposeMode("individual")}
            >
              <Mail className="mr-1.5 size-3.5" />
              Individual Candidate
            </Button>
            <Button
              size="sm"
              variant={composeMode === "bulk" ? "default" : "outline"}
              onClick={() => setComposeMode("bulk")}
            >
              <Users className="mr-1.5 size-3.5" />
              Bulk Candidates
            </Button>
            <Button
              size="sm"
              variant={composeMode === "test" ? "default" : "outline"}
              onClick={() => setComposeMode("test")}
            >
              <Sparkles className="mr-1.5 size-3.5" />
              Send Test Email
            </Button>
          </div>

          <div className="grid gap-5 lg:grid-cols-12">
            <Card className="lg:col-span-7">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  {composeMode === "individual"
                    ? "Compose Candidate Communication"
                    : composeMode === "bulk"
                      ? "Bulk Templated Candidate Dispatch"
                      : "Send [TEST] Verification Email"}
                </CardTitle>
                <CardDescription>
                  {composeMode === "bulk"
                    ? "Select candidates and a template. Each candidate's name, designation, department, and next IST interview slot are interpolated automatically."
                    : "Choose any HR template, review dynamic variables, save a draft, or dispatch via verified sender."}
                </CardDescription>
              </CardHeader>

              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="compose-tpl">Email Template</Label>
                  <select
                    id="compose-tpl"
                    value={composeSlug}
                    onChange={(e) => setComposeSlug(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                  >
                    {templates.map((t) => (
                      <option key={t.slug} value={t.slug}>
                        {t.name} ({t.category})
                      </option>
                    ))}
                  </select>
                </div>

                {composeMode === "individual" ? (
                  composeSlug === "employee_relieving_letter" ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="compose-emp">Select Workforce Employee (Auto-Fill)</Label>
                        <select
                          id="compose-emp"
                          value={composeEmployeeId}
                          onChange={(e) => handleSelectComposeEmployee(e.target.value)}
                          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm font-medium"
                        >
                          <option value="">Select workforce employee...</option>
                          {(data?.employees ?? []).map((emp: any) => (
                            <option key={emp.id} value={emp.id}>
                              {emp.fullName} ({emp.employeeCode}) — {emp.workEmail}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="compose-email">Recipient Work Email</Label>
                        <Input
                          id="compose-email"
                          type="email"
                          value={composeRecipientEmail}
                          onChange={(e) => setComposeRecipientEmail(e.target.value)}
                          placeholder="employee@theaischool.co"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="compose-cand">Select Candidate (Auto-Fill)</Label>
                        <select
                          id="compose-cand"
                          value={composeCandidateId}
                          onChange={(e) => handleSelectComposeCandidate(e.target.value)}
                          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                        >
                          <option value="">Custom recipient / select candidate...</option>
                          {(data?.candidates ?? []).map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.fullName} ({c.candidateCode}) — {c.email}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="compose-email">Recipient Email</Label>
                        <Input
                          id="compose-email"
                          type="email"
                          value={composeRecipientEmail}
                          onChange={(e) => setComposeRecipientEmail(e.target.value)}
                          placeholder="candidate@example.com"
                        />
                      </div>
                    </div>
                  )
                ) : null}

                {composeMode === "test" ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="test-email">
                      Test Recipient Email (Prefixed with [TEST])
                    </Label>
                    <Input
                      id="test-email"
                      type="email"
                      value={composeRecipientEmail}
                      onChange={(e) => setComposeRecipientEmail(e.target.value)}
                      placeholder="hr@theaischool.co"
                    />
                  </div>
                ) : null}

                {composeMode === "bulk" ? (
                  composeSlug === "employee_relieving_letter" ? (
                    <div className="space-y-3">
                      <MultiRelievingPanel
                        canSendEmails={canSendEmails}
                        canViewPersonalEmails={customAccess.canViewPersonalEmails}
                        providerConfigured={providerConfigured}
                        onSelectSingleEmployee={handleSelectFromUnifiedRecipient}
                        onBatchUpdated={() => {
                          void dispatchBatchesQuery.refetch();
                          void refreshCenter();
                        }}
                      />
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Label>
                          Select Candidates ({bulkCandidateIds.length} selected)
                        </Label>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setBulkCandidateIds(
                                (data?.candidates ?? [])
                                  .filter((c) => {
                                    const q = bulkSearch.trim().toLowerCase();
                                    if (!q) return true;
                                    return (
                                      c.fullName.toLowerCase().includes(q) ||
                                      c.email.toLowerCase().includes(q) ||
                                      c.status.toLowerCase().includes(q)
                                    );
                                  })
                                  .slice(0, 100)
                                  .map((c) => c.id),
                              )
                            }
                          >
                            Select Filtered
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setBulkCandidateIds([])}
                          >
                            Clear
                          </Button>
                        </div>
                      </div>
                      <div className="relative">
                        <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
                        <Input
                          aria-label="Filter bulk candidates"
                          value={bulkSearch}
                          onChange={(e) => setBulkSearch(e.target.value)}
                          placeholder="Filter candidates by name, email, or stage..."
                          className="h-8 pl-8 text-xs"
                        />
                      </div>
                      <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2.5">
                        {(data?.candidates ?? []).length === 0 ? (
                          <p className="py-4 text-center text-xs text-muted-foreground">
                            No candidates available yet.
                          </p>
                        ) : (
                          (data?.candidates ?? [])
                            .filter((c) => {
                              const q = bulkSearch.trim().toLowerCase();
                              if (!q) return true;
                              return (
                                c.fullName.toLowerCase().includes(q) ||
                                c.email.toLowerCase().includes(q) ||
                                c.status.toLowerCase().includes(q)
                              );
                            })
                            .map((c) => (
                              <label
                                key={c.id}
                                className="flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50"
                              >
                                <span className="flex min-w-0 items-center gap-2">
                                  <Checkbox
                                    checked={bulkCandidateIds.includes(c.id)}
                                    onCheckedChange={() => toggleBulkCandidate(c.id)}
                                  />
                                  <span className="truncate font-medium text-foreground">
                                    {c.fullName}
                                  </span>
                                  <span className="truncate text-muted-foreground">({c.email})</span>
                                </span>
                                <Badge variant="outline" className="shrink-0 text-[10px]">
                                  {c.status}
                                </Badge>
                              </label>
                            ))
                        )}
                      </div>
                    </div>
                  )
                ) : null}

                {/* Variable Values Grid */}
                <div className="space-y-2 rounded-lg border border-border p-3">
                  <p className="text-xs font-semibold text-foreground">
                    {composeMode === "bulk"
                      ? "Shared Fallback Variables (Used when candidate/interview field is blank)"
                      : composeSlug === "employee_relieving_letter"
                        ? "Official Relieving & Experience Letter Variables"
                        : "Dynamic Variable Values"}
                  </p>
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    {visibleVars.map((key) => (
                      <div key={key} className="space-y-1">
                        <Label htmlFor={`var-${key}`} className="font-mono text-[11px]">
                          {`{{${key}}}`}
                        </Label>
                        <Input
                          id={`var-${key}`}
                          value={composeVars[key] ?? ""}
                          onChange={(e) =>
                            setComposeVars((prev) => ({
                              ...prev,
                              [key]: e.target.value,
                            }))
                          }
                          className="h-8 text-xs"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {composePreview.missingVariables.length > 0 && composeMode !== "bulk" ? (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                    Missing values for:{" "}
                    <strong>
                      {composePreview.missingVariables
                        .map((v) => `{{${v}}}`)
                        .join(", ")}
                    </strong>
                  </div>
                ) : null}

                {/* Action Buttons */}
                <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                  {composeSlug === "employee_relieving_letter" ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handlePreviewPdf("compose")}
                      disabled={pdfLoading}
                    >
                      <FileText className="mr-1.5 size-3.5 text-primary" />
                      {pdfLoading ? "Generating PDF..." : "Preview Letter PDF"}
                    </Button>
                  ) : null}

                  {composeMode === "individual" && canSendEmails ? (
                    <Button
                      variant="outline"
                      onClick={handleSaveDraft}
                      disabled={dispatchBusy || !data?.schemaReady}
                    >
                      <Save className="mr-1.5 size-3.5" />
                      Save Draft
                    </Button>
                  ) : null}

                  {composeMode === "individual" ? (
                    <Button
                      onClick={() => handleSendIndividualOrTest(false)}
                      disabled={
                        !canSendEmails ||
                        !providerConfigured ||
                        dispatchBusy ||
                        !data?.schemaReady ||
                        !composeRecipientEmail
                      }
                    >
                      <Send className="mr-1.5 size-3.5" />
                      {dispatchBusy ? "Sending..." : "Send Email"}
                    </Button>
                  ) : null}

                  {composeMode === "test" ? (
                    <Button
                      onClick={() => handleSendIndividualOrTest(true)}
                      disabled={
                        !canSendEmails ||
                        !providerConfigured ||
                        dispatchBusy ||
                        !data?.schemaReady
                      }
                    >
                      <Send className="mr-1.5 size-3.5" />
                      {dispatchBusy ? "Sending..." : "Send [TEST] Email"}
                    </Button>
                  ) : null}

                  {composeMode === "bulk" ? (
                    <Button
                      onClick={() => setBulkConfirmOpen(true)}
                      disabled={
                        !canSendEmails ||
                        !providerConfigured ||
                        bulkCandidateIds.length === 0 ||
                        composeSlug === "employee_relieving_letter" ||
                        dispatchBusy ||
                        !data?.schemaReady
                      }
                    >
                      <Send className="mr-1.5 size-3.5" />
                      {dispatchBusy
                        ? "Dispatching Batch..."
                        : `Send Bulk (${bulkCandidateIds.length})`}
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>

            {/* Right Live Rendered Preview */}
            <Card className="lg:col-span-5">
              <CardHeader className="pb-2">
                {composeSlug === "employee_relieving_letter" ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex rounded-md border border-input p-0.5 bg-muted/40">
                      <Button
                        type="button"
                        size="sm"
                        variant={composePreviewSubTab === "official_letter" ? "default" : "ghost"}
                        className="h-7 text-xs px-2.5 font-semibold"
                        onClick={() => setComposePreviewSubTab("official_letter")}
                      >
                        <FileText className="mr-1 size-3 text-primary" />
                        OFFICIAL LETTER (PDF)
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={composePreviewSubTab === "email_message" ? "default" : "ghost"}
                        className="h-7 text-xs px-2.5"
                        onClick={() => setComposePreviewSubTab("email_message")}
                      >
                        <Mail className="mr-1 size-3" />
                        COVER EMAIL
                      </Button>
                    </div>
                    <Badge variant="outline" className="text-[10px] border-primary/30 text-primary">
                      Primary Attachment
                    </Badge>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base">Rendered Message Preview</CardTitle>
                    <div className="flex flex-wrap gap-1" role="group" aria-label="Compose preview mode">
                      <Button
                        type="button"
                        size="sm"
                        aria-pressed={previewMode === "desktop"}
                        variant={previewMode === "desktop" ? "default" : "outline"}
                        onClick={() => setPreviewMode("desktop")}
                      >
                        Desktop
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        aria-pressed={previewMode === "mobile"}
                        variant={previewMode === "mobile" ? "default" : "outline"}
                        onClick={() => setPreviewMode("mobile")}
                      >
                        375px
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        aria-pressed={previewMode === "text"}
                        variant={previewMode === "text" ? "default" : "outline"}
                        onClick={() => setPreviewMode("text")}
                      >
                        Text
                      </Button>
                    </div>
                  </div>
                )}
                {composeSlug !== "employee_relieving_letter" || composePreviewSubTab === "email_message" ? (
                  <CardDescription>
                    Subject: <strong>{composePreview.subject}</strong>
                  </CardDescription>
                ) : null}
              </CardHeader>
              <CardContent>
                {composeSlug === "employee_relieving_letter" && composePreviewSubTab === "official_letter" ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs">
                      <span className="truncate">
                        <strong>Attachment: </strong>
                        <code>Experience_Letter_{(composeVars.employee_name || "Employee").replace(/\s+/g, "_")}.pdf</code>
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 text-xs text-primary"
                        onClick={() => void handlePreviewPdf("compose")}
                      >
                        <Eye className="mr-1 size-3" />
                        Fullscreen Modal
                      </Button>
                    </div>
                    {letterPdfBlobUrl ? (
                      <iframe
                        key={`compose-preview-${letterPdfBlobUrl}`}
                        src={`${letterPdfBlobUrl}#toolbar=0&navpanes=0`}
                        title="Attached Official Relieving Letter"
                        className="w-full h-[540px] rounded border border-border bg-white shadow-xs"
                      />
                    ) : (
                      <div className="h-[460px] flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground border rounded-md">
                        <RefreshCw className="size-5 animate-spin text-primary" />
                        <span>Rendering official letter attachment...</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    {composeSlug === "employee_relieving_letter" ? (
                      <div className="mb-3 flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText className="size-4 text-primary shrink-0" />
                          <span className="truncate">
                            <strong>Attached: </strong>
                            <code>
                              Experience_Letter_{(composeVars.employee_name || "Employee").replace(/\s+/g, "_")}.pdf
                            </code>
                          </span>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 shrink-0 text-xs text-primary font-medium"
                          onClick={() => void handlePreviewPdf("compose")}
                        >
                          Preview PDF
                        </Button>
                      </div>
                    ) : null}
                    {previewMode === "text" ? (
                      <pre className="h-[460px] overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-4 font-mono text-xs text-foreground">
                        {composePreview.bodyText}
                      </pre>
                    ) : (
                      <div className={previewMode === "mobile" ? "mx-auto max-w-[375px]" : ""}>
                        <iframe
                          title="Compose Email Preview"
                          sandbox="allow-same-origin"
                          srcDoc={composePreview.bodyHtml}
                          className="h-[460px] w-full rounded-md border border-border bg-zinc-100"
                        />
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* TAB 3: DELIVERY STATUS, FAILURE LOGS & RETRY */}
        <TabsContent value="logs" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Drafts</CardDescription>
                <CardTitle className="text-2xl">{data?.stats.draft ?? 0}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                Saved drafts awaiting dispatch
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Accepted by SMTP</CardDescription>
                <CardTitle className="text-2xl">{data?.stats.sent ?? 0}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                Accepted by Hostinger SMTP relay (not proof of inbox delivery)
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Delivered (Confirmed)</CardDescription>
                <CardTitle className="text-2xl">{data?.stats.delivered ?? 0}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                Marked delivered only with trustworthy delivery evidence
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center justify-between">
                  <span>Failed Dispatches</span>
                  <XCircle className="size-4 text-rose-600" />
                </CardDescription>
                <CardTitle className="text-2xl">{data?.stats.failed ?? 0}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                Logged errors eligible for safe retry
              </CardContent>
            </Card>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  { id: "all", label: "All" },
                  { id: "accepted_by_smtp", label: "Accepted by SMTP" },
                  { id: "delivered", label: "Delivered" },
                  { id: "failed", label: "Failed" },
                  { id: "draft", label: "Draft" },
                  { id: "canceled", label: "Canceled" },
                ] as const
              ).map((f) => (
                <Button
                  key={f.id}
                  size="sm"
                  aria-pressed={logFilter === f.id}
                  variant={logFilter === f.id ? "default" : "outline"}
                  onClick={() => setLogFilter(f.id)}
                >
                  {f.label}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Honest SMTP Policy: 250 OK marks <code>accepted_by_smtp</code>, never{" "}
              <code>delivered</code>, unless verified delivery evidence exists.
            </p>
          </div>

          {(dispatchBatchesQuery.data?.batches?.length ?? 0) > 0 ? (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="text-sm">Bulk Dispatch Queue Batches</CardTitle>
                    <CardDescription className="text-xs">
                      Controlled Hostinger SMTP batches (Relieving Letters &amp; Custom Email Templates).
                    </CardDescription>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void dispatchBatchesQuery.refetch()}
                  >
                    <RefreshCw className="mr-1.5 size-3" />
                    Refresh Batches
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="pb-2 pr-3 font-medium">Template</th>
                        <th className="pb-2 pr-3 font-medium">Kind</th>
                        <th className="pb-2 pr-3 font-medium">Status</th>
                        <th className="pb-2 pr-3 font-medium">Accepted / Total</th>
                        <th className="pb-2 pr-3 font-medium">Queued / Failed / Canceled</th>
                        <th className="pb-2 pr-3 font-medium">Personal / Work</th>
                        <th className="pb-2 text-right font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {(dispatchBatchesQuery.data?.batches ?? []).map((b) => (
                        <tr key={b.id}>
                          <td className="py-2.5 pr-3 font-medium">{b.templateName}</td>
                          <td className="py-2.5 pr-3 font-mono text-[11px]">{b.dispatchKind}</td>
                          <td className="py-2.5 pr-3 capitalize">{b.status.replace(/_/g, " ")}</td>
                          <td className="py-2.5 pr-3 font-mono">
                            {b.acceptedCount} / {b.totalCount}
                          </td>
                          <td className="py-2.5 pr-3 font-mono">
                            {b.queuedCount} / {b.failedCount} / {b.canceledCount}
                          </td>
                          <td className="py-2.5 pr-3 text-[11px]">
                            {b.personalEmailCount} Personal • {b.workEmailCount} Work
                          </td>
                          <td className="py-2.5 text-right">
                            <div className="flex justify-end gap-1.5">
                              {canSendEmails && b.queuedCount > 0 ? (
                                <>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-[11px]"
                                    onClick={async () => {
                                      try {
                                        await processBulkDispatchChunk({
                                          data: { batchId: b.id, chunkSize: 10 },
                                        });
                                        await dispatchBatchesQuery.refetch();
                                        toast.success("Processed next queued chunk.");
                                      } catch (e) {
                                        toast.error(describeUnknownError(e));
                                      }
                                    }}
                                  >
                                    Resume Chunk
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 text-[11px]"
                                    onClick={async () => {
                                      try {
                                        await cancelQueuedBatchItems({ data: { batchId: b.id } });
                                        await dispatchBatchesQuery.refetch();
                                        toast.info("Canceled unsent queued items.");
                                      } catch (e) {
                                        toast.error(describeUnknownError(e));
                                      }
                                    }}
                                  >
                                    Cancel Unsent
                                  </Button>
                                </>
                              ) : null}
                              {canSendEmails && b.failedCount > 0 ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-[11px]"
                                  onClick={async () => {
                                    try {
                                      const res = await retryFailedBatchItems({
                                        data: { batchId: b.id },
                                      });
                                      if (res.requeuedCount > 0) {
                                        await processBulkDispatchChunk({
                                          data: { batchId: b.id, chunkSize: 10 },
                                        });
                                      }
                                      await dispatchBatchesQuery.refetch();
                                      toast.success(
                                        `Retried ${res.requeuedCount} failed item(s).`,
                                      );
                                    } catch (e) {
                                      toast.error(describeUnknownError(e));
                                    }
                                  }}
                                >
                                  <RotateCcw className="mr-1 size-3" />
                                  Retry Failed
                                </Button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardContent className="pt-5">
              {filteredMessages.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No email records match this filter.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th scope="col" className="pb-2.5 pr-3 font-medium">Recipient</th>
                        <th scope="col" className="pb-2.5 pr-3 font-medium">Subject &amp; Template</th>
                        <th scope="col" className="pb-2.5 pr-3 font-medium">Status</th>
                        <th scope="col" className="pb-2.5 pr-3 font-medium">Attempts</th>
                        <th scope="col" className="pb-2.5 pr-3 font-medium">Provider / Error Detail</th>
                        <th scope="col" className="pb-2.5 pr-3 font-medium">Timestamp</th>
                        <th scope="col" className="pb-2.5 text-right font-medium">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {filteredMessages.map((msg) => (
                        <tr key={msg.id} className="align-top">
                          <td className="py-3 pr-3">
                            <div className="font-medium text-foreground">
                              {msg.recipient_name ?? msg.recipient_email}
                            </div>
                            <div className="text-muted-foreground">
                              {msg.recipient_email}
                            </div>
                          </td>
                          <td className="py-3 pr-3">
                            <div className="font-medium text-foreground">
                              {msg.subject}
                            </div>
                            {msg.template_slug ? (
                              <code className="text-[11px] text-muted-foreground">
                                {msg.template_slug}
                              </code>
                            ) : null}
                          </td>
                          <td className="py-3 pr-3">
                            <Badge variant={statusBadgeVariant(msg.status)}>
                              {statusDisplayLabel(msg.status)}
                            </Badge>
                          </td>
                          <td className="py-3 pr-3 font-mono">{msg.attempts}</td>
                          <td className="max-w-[200px] py-3 pr-3">
                            {msg.error_message ? (
                              <button
                                type="button"
                                onClick={() => setSelectedMsgForDetails(msg)}
                                className="block max-w-[180px] truncate text-left font-mono text-destructive hover:underline"
                                title="Click to view full error"
                              >
                                {msg.error_message}
                              </button>
                            ) : msg.provider_message_id ? (
                              <button
                                type="button"
                                onClick={() => setSelectedMsgForDetails(msg)}
                                className="block max-w-[180px] truncate text-left font-mono text-muted-foreground hover:text-foreground hover:underline"
                                title="Click to view message ID"
                              >
                                {msg.provider_message_id}
                              </button>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap py-3 pr-3 font-mono text-muted-foreground">
                            {new Date(msg.sent_at ?? msg.created_at).toLocaleString(
                              "en-IN",
                              { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short" },
                            )}
                          </td>
                          <td className="py-3 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                onClick={() => setSelectedMsgForDetails(msg)}
                              >
                                Details
                              </Button>
                              {canSendEmails &&
                                (msg.status === "failed" || msg.status === "draft") ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-xs"
                                  disabled={!providerConfigured || retryingId === msg.id}
                                  onClick={() => handleRetryMessage(msg.id)}
                                >
                                  {msg.status === "draft" ? (
                                    <Send className="mr-1 size-3" />
                                  ) : (
                                    <RotateCcw className="mr-1 size-3" />
                                  )}
                                  {retryingId === msg.id
                                    ? msg.status === "draft"
                                      ? "Sending..."
                                      : "Retrying..."
                                    : msg.status === "draft"
                                      ? "Send"
                                      : "Retry"}
                                </Button>
                              ) : null}
                              {canSendEmails &&
                                (msg.status === "draft" || msg.status === "queued") ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs text-muted-foreground"
                                  disabled={cancelingId === msg.id}
                                  onClick={() => handleCancelMessage(msg.id)}
                                >
                                  {cancelingId === msg.id ? "..." : "Cancel"}
                                </Button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Reset Template Default Confirmation */}
      <AlertDialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Reset &ldquo;{activeTemplate?.name}&rdquo; to Standard Default?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Replaces any custom subject, HTML body, and plain-text overrides for{" "}
              <code className="font-mono">{activeTemplate?.slug}</code> with The AI School standard
              template.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={savingTemplate}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={savingTemplate}
              onClick={() => {
                setResetConfirmOpen(false);
                void handleResetTemplate();
              }}
            >
              Reset Template
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Email Dispatch Confirmation */}
      <AlertDialog open={bulkConfirmOpen} onOpenChange={setBulkConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Send Bulk Email to {bulkCandidateIds.length} Candidate(s)?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Dispatches template{" "}
              <strong>
                {templates.find((t) => t.slug === composeSlug)?.name ?? composeSlug}
              </strong>{" "}
              via Hostinger SMTP (<code>hr@theaischool.co</code>) with rate pacing,
              per-recipient variable interpolation, and duplicate protection.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dispatchBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={dispatchBusy}
              onClick={() => {
                setBulkConfirmOpen(false);
                void handleSendBulk();
              }}
            >
              Confirm Bulk Send
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* Email Message Technical Details Modal */}
      <Dialog
        open={Boolean(selectedMsgForDetails)}
        onOpenChange={(open) => !open && setSelectedMsgForDetails(null)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Email Dispatch Details</DialogTitle>
            <DialogDescription>
              Technical delivery metadata recorded by The AI School SMTP relay.
            </DialogDescription>
          </DialogHeader>
          {selectedMsgForDetails && (
            <div className="space-y-3 text-xs">
              <div className="space-y-1.5 rounded-md border bg-muted/20 p-3 font-mono">
                <div>
                  <span className="text-muted-foreground">Recipient: </span>
                  <span className="font-semibold text-foreground">
                    {selectedMsgForDetails.recipient_name} &lt;
                    {selectedMsgForDetails.recipient_email}&gt;
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Subject: </span>
                  <span className="text-foreground">{selectedMsgForDetails.subject}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Template: </span>
                  <span className="text-foreground">
                    {selectedMsgForDetails.template_slug || "Custom"}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Status: </span>
                  <Badge
                    variant={statusBadgeVariant(selectedMsgForDetails.status)}
                    className="ml-1"
                  >
                    {statusDisplayLabel(selectedMsgForDetails.status)}
                  </Badge>
                </div>
                <div>
                  <span className="text-muted-foreground">Attempts: </span>
                  <span className="text-foreground">{selectedMsgForDetails.attempts}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Recorded At: </span>
                  <span className="text-foreground">
                    {new Date(selectedMsgForDetails.created_at).toLocaleString("en-IN", {
                      timeZone: "Asia/Kolkata",
                    })}
                  </span>
                </div>
                {selectedMsgForDetails.provider_message_id && (
                  <div>
                    <span className="text-muted-foreground">SMTP Message ID: </span>
                    <span className="break-all text-foreground">
                      {selectedMsgForDetails.provider_message_id}
                    </span>
                  </div>
                )}
              </div>

              {selectedMsgForDetails.error_message && (
                <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3">
                  <p className="font-semibold text-destructive">Error Diagnostic</p>
                  <pre className="whitespace-pre-wrap font-mono text-[11px] text-destructive">
                    {selectedMsgForDetails.error_message}
                  </pre>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setSelectedMsgForDetails(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Relieving & Experience Letter PDF Preview Modal */}
      <Dialog open={pdfPreviewOpen} onOpenChange={setPdfPreviewOpen}>
        <DialogContent className="max-w-4xl h-[85vh] flex flex-col p-4 sm:p-6">
          <DialogHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2 pr-6">
              <div>
                <DialogTitle className="flex items-center gap-2 text-base">
                  <FileText className="size-4 text-primary" />
                  Official Experience &amp; Relieving Letter Preview (A4)
                </DialogTitle>
                <DialogDescription className="text-xs">
                  Exact standard format corresponding to Word reference document (A4 single-page layout).
                </DialogDescription>
              </div>
              {pdfPreviewBlobUrl && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const link = document.createElement("a");
                    link.href = pdfPreviewBlobUrl;
                    link.download = `Experience_Letter_${(composeVars.employee_name || "Official").replace(/\s+/g, "_")}.pdf`;
                    link.click();
                  }}
                >
                  <Download className="mr-1.5 size-3.5" />
                  Download PDF
                </Button>
              )}
            </div>
          </DialogHeader>

          <div className="flex-1 w-full bg-muted/40 rounded-lg overflow-hidden border border-border flex items-center justify-center min-h-[400px]">
            {pdfLoading ? (
              <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
                <RefreshCw className="size-6 animate-spin text-primary" />
                <span>Generating official letter PDF...</span>
              </div>
            ) : pdfPreviewBlobUrl ? (
              <iframe
                key={pdfPreviewBlobUrl}
                title="Relieving Letter PDF Preview"
                src={`${pdfPreviewBlobUrl}#toolbar=0&navpanes=0`}
                className="w-full h-full border-0"
              />
            ) : (
              <p className="text-sm text-muted-foreground">Failed to generate PDF preview.</p>
            )}
          </div>

          <DialogFooter className="pt-2">
            <Button variant="outline" size="sm" onClick={() => setPdfPreviewOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
