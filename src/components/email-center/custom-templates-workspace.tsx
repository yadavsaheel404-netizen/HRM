import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Eye,
  FileText,
  Filter,
  History,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
  Upload,
  Users,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  cancelQueuedBatchItems,
  createBulkDispatchBatch,
  getDispatchBatchDetail,
  inspectStoredCustomTemplate,
  listCustomEmailTemplates,
  listDispatchBatches,
  previewCustomEmailTemplate,
  processBulkDispatchChunk,
  retryFailedBatchItems,
  uploadAndSaveCustomTemplate,
} from "@/lib/email-center-bulk.functions";
import {
  buildPersonalizedAttachmentFilename,
  deduplicateRecipientDispatches,
  evaluateCustomTemplateRecipientReadiness,
  extractDocxPlaceholders,
  inspectPdfTemplate,
  isRelievingStyleCustomTemplate,
  validateUploadedTemplateFile,
} from "@/lib/email-center/custom-templates";
import {
  CUSTOM_TEMPLATE_PLACEHOLDERS,
  OFFICIAL_SENDER_DISPLAY,
  STATIC_PDF_WARNING_MESSAGE,
  type CustomDocumentMode,
  type CustomEmailTemplateRecord,
  type CustomTemplateRecipientType,
  type CustomTemplateStatus,
  type DocxFieldMappingRule,
  type EmailCenterRecipientItem,
  type EmailDispatchBatchRecord,
  type EmailDispatchItemRecord,
  type RecipientEmailMode,
} from "@/lib/email-center/types";
import { formatLetterDate } from "@/lib/relieving/types";
import { RecordsRecipientPicker } from "./records-recipient-picker";

export type CustomWorkspaceSubTab =
  | "library"
  | "compose"
  | "recipients"
  | "preview"
  | "send"
  | "history";

interface CustomTemplatesWorkspaceProps {
  selectedTemplateId: string | null;
  onSelectTemplateId: (id: string | null) => void;
  subTab: CustomWorkspaceSubTab;
  onChangeSubTab: (tab: CustomWorkspaceSubTab) => void;
  providerConfigured: boolean;
  initialFileToUpload?: File | null | undefined;
  onConsumedInitialFile?: (() => void) | undefined;
  onBatchUpdated?: (batch: EmailDispatchBatchRecord) => void;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function CustomTemplatesWorkspace({
  selectedTemplateId,
  onSelectTemplateId,
  subTab,
  onChangeSubTab,
  providerConfigured,
  initialFileToUpload,
  onConsumedInitialFile,
  onBatchUpdated,
}: CustomTemplatesWorkspaceProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const tplQuery = useQuery({
    queryKey: ["custom-email-templates"],
    queryFn: () => listCustomEmailTemplates(),
  });

  const batchesQuery = useQuery({
    queryKey: ["email-dispatch-batches"],
    queryFn: () => listDispatchBatches(),
  });

  const access = tplQuery.data?.access;
  const canManage = Boolean(access?.canManageCustomTemplates);
  const canSend = Boolean(access?.canSendEmails);
  const canViewPersonalEmails = Boolean(access?.canViewPersonalEmails);
  const templates = tplQuery.data?.templates ?? [];
  const versionsByTemplateId = tplQuery.data?.versionsByTemplateId ?? {};

  const activeTemplate: CustomEmailTemplateRecord | null = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId],
  );

  // Compose / Upload form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [purposeCategory, setPurposeCategory] = useState("hr_notice");
  const [subjectTemplate, setSubjectTemplate] = useState(
    "Important HR Communication — {{employee_name}}",
  );
  const [bodyHtmlTemplate, setBodyHtmlTemplate] = useState(
    `<div style="font-family:Inter,Arial,sans-serif;color:#111827;line-height:1.6;">\n  <p>Dear {{employee_name}},</p>\n  <p>Please find attached your official communication document from The AI School HR team.</p>\n  <p>Employee ID: <strong>{{employee_id}}</strong><br/>Designation: <strong>{{designation}}</strong></p>\n  <p>Warm regards,<br/>The AI School HR</p>\n</div>`,
  );
  const [bodyTextTemplate, setBodyTextTemplate] = useState("");
  const [recipientType, setRecipientType] =
    useState<CustomTemplateRecipientType>("all_records");
  const [defaultEmailMode, setDefaultEmailMode] =
    useState<RecipientEmailMode>("personal");
  const [templateStatus, setTemplateStatus] = useState<CustomTemplateStatus>("draft");
  const [requiresElevatedApproval, setRequiresElevatedApproval] = useState(false);
  const [documentMode, setDocumentMode] = useState<CustomDocumentMode>("personalized");
  const [fieldMappings, setFieldMappings] = useState<DocxFieldMappingRule[]>([]);
  const [requiresRelievingApproval, setRequiresRelievingApproval] = useState(false);
  const [inspectingStored, setInspectingStored] = useState(false);

  const [pendingUpload, setPendingUpload] = useState<{
    fileName: string;
    mimeType: string;
    base64Data: string;
    format: "docx" | "pdf";
    detectedPlaceholders: string[];
    pdfMode: "static" | "fillable" | null;
    warning: string | null;
    hasImages?: boolean;
    hasTables?: boolean;
    hasHeaderOrFooter?: boolean;
  } | null>(null);
  const [clearAttachment, setClearAttachment] = useState(false);
  const [saving, setSaving] = useState(false);

  // Recipient selection state
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [recipientCache, setRecipientCache] = useState<
    Map<string, EmailCenterRecipientItem>
  >(() => new Map());
  const [perRecipientOverrides, setPerRecipientOverrides] = useState<
    Record<string, RecipientEmailMode>
  >({});

  // Live preview state
  const [sampleRecipientId, setSampleRecipientId] = useState<string>("");
  const [previewMode, setPreviewMode] = useState<"html" | "text" | "document">("document");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewResult, setPreviewResult] = useState<{
    subject: string;
    bodyHtml: string;
    bodyText: string;
    detectedPlaceholders: string[];
    missingPlaceholders: string[];
    unresolvedPlaceholders: string[];
    remainingBlankFields: string[];
    isVerifiedClean: boolean;
    resolvedAttachmentFilename: string | null;
    pdfMode: "static" | "fillable" | null;
    pdfWarning: string | null;
    docxParagraphs: string[];
    personalizedAttachmentBase64: string | null;
  } | null>(null);

  // Per-recipient actual document preview modal state
  const [docModal, setDocModal] = useState<{
    open: boolean;
    loading: boolean;
    recipientName: string;
    attachmentFilename: string;
    mimeType: string;
    isVerifiedClean: boolean;
    missingPlaceholders: string[];
    unresolvedPlaceholders: string[];
    remainingBlankFields: string[];
    pdfWarning: string | null;
    docxParagraphs: string[];
    base64Data: string | null;
  }>({
    open: false,
    loading: false,
    recipientName: "",
    attachmentFilename: "",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    isVerifiedClean: true,
    missingPlaceholders: [],
    unresolvedPlaceholders: [],
    remainingBlankFields: [],
    pdfWarning: null,
    docxParagraphs: [],
    base64Data: null,
  });

  // Dispatch state
  const [confirmSendOpen, setConfirmSendOpen] = useState(false);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [activeBatch, setActiveBatch] = useState<EmailDispatchBatchRecord | null>(null);
  const cancelRef = useRef(false);

  // History drilldown state
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailBatch, setDetailBatch] = useState<EmailDispatchBatchRecord | null>(null);
  const [detailItems, setDetailItems] = useState<EmailDispatchItemRecord[]>([]);

  useEffect(() => {
    if (activeTemplate) {
      setName(activeTemplate.name);
      setDescription(activeTemplate.description);
      setPurposeCategory(activeTemplate.purposeCategory);
      setSubjectTemplate(activeTemplate.subjectTemplate);
      setBodyHtmlTemplate(activeTemplate.bodyHtmlTemplate);
      setBodyTextTemplate(activeTemplate.bodyTextTemplate ?? "");
      setRecipientType(activeTemplate.recipientType);
      setDefaultEmailMode(activeTemplate.defaultEmailMode);
      setTemplateStatus(activeTemplate.status);
      setRequiresElevatedApproval(activeTemplate.requiresElevatedApproval);
      setDocumentMode(activeTemplate.documentMode ?? "personalized");
      setFieldMappings(activeTemplate.fieldMappings ?? []);
      setRequiresRelievingApproval(Boolean(activeTemplate.requiresRelievingApproval));
      setPendingUpload(null);
      setClearAttachment(false);
      setPreviewResult(null);
    }
  }, [activeTemplate]);

  const startNewTemplate = () => {
    onSelectTemplateId(null);
    setName("");
    setDescription("");
    setPurposeCategory("hr_notice");
    setSubjectTemplate("HR Notice — {{employee_name}}");
    setBodyHtmlTemplate(
      `<div style="font-family:Inter,Arial,sans-serif;color:#111827;line-height:1.6;">\n  <p>Dear {{employee_name}},</p>\n  <p>Please review the attached official document from The AI School HR.</p>\n  <p>Warm regards,<br/>The AI School HR</p>\n</div>`,
    );
    setBodyTextTemplate("");
    setRecipientType("all_records");
    setDefaultEmailMode("personal");
    setTemplateStatus("draft");
    setRequiresElevatedApproval(false);
    setDocumentMode("personalized");
    setFieldMappings([]);
    setRequiresRelievingApproval(false);
    setPendingUpload(null);
    setClearAttachment(false);
    setPreviewResult(null);
    onChangeSubTab("compose");
  };

  const handleFilePicked = async (file: File | null) => {
    if (!file) return;
    try {
      const ab = await file.arrayBuffer();
      const bytes = new Uint8Array(ab);
      const validation = validateUploadedTemplateFile({
        fileName: file.name,
        mimeType: file.type,
        bytes,
      });
      if (!validation.valid) {
        toast.error(validation.error);
        return;
      }

      if (validation.format === "docx") {
        const info = extractDocxPlaceholders(bytes);
        const suggested = info.blankDetection.suggestedMappings;
        if (suggested.length > 0) {
          setFieldMappings(suggested);
        }
        const isRelievingDoc =
          info.blankDetection.isLikelyRelievingTemplate ||
          isRelievingStyleCustomTemplate({
            templateName: name || validation.safeFileName,
            attachmentFilename: validation.safeFileName,
            purposeCategory,
          });
        if (isRelievingDoc) {
          setDocumentMode("personalized");
          setRequiresRelievingApproval(true);
        }

        const mergedPlaceholders = [
          ...new Set([
            ...info.detectedPlaceholders,
            ...suggested.filter((m) => m.enabled).map((m) => m.placeholder),
          ]),
        ];

        setPendingUpload({
          fileName: validation.safeFileName,
          mimeType: validation.normalizedMime,
          base64Data: arrayBufferToBase64(ab),
          format: "docx",
          detectedPlaceholders: mergedPlaceholders,
          pdfMode: null,
          warning:
            info.blankDetection.hasUnmappedBlanks && suggested.length > 0
              ? `Detected ${suggested.filter((m) => m.enabled).length} blank template field(s) mapped automatically for personalization.`
              : info.unsupportedPlaceholders.length > 0
                ? `Unsupported placeholders detected: ${info.unsupportedPlaceholders.join(", ")}`
                : null,
          hasImages: info.hasImages,
          hasTables: info.hasTables,
          hasHeaderOrFooter: info.hasHeaderOrFooter,
        });
        toast.success(
          `Word template verified (${mergedPlaceholders.length} personalized field(s) mapped).`,
        );
      } else {
        const pdfInfo = await inspectPdfTemplate(bytes);
        setFieldMappings([]);
        if (pdfInfo.mode === "static") {
          setDocumentMode("static");
        } else {
          setDocumentMode("personalized");
        }
        setPendingUpload({
          fileName: validation.safeFileName,
          mimeType: validation.normalizedMime,
          base64Data: arrayBufferToBase64(ab),
          format: "pdf",
          detectedPlaceholders: pdfInfo.detectedPlaceholders,
          pdfMode: pdfInfo.mode,
          warning: pdfInfo.warning,
        });
        toast.success(
          pdfInfo.mode === "fillable"
            ? `Fillable PDF verified (${pdfInfo.detectedPlaceholders.length} matching field(s)).`
            : STATIC_PDF_WARNING_MESSAGE,
        );
      }
      if (!activeTemplate && !name.trim()) {
        const derivedName = validation.safeFileName
          .replace(/\.[^.]+$/, "")
          .replace(/[_-]+/g, " ")
          .trim();
        if (derivedName) {
          setName(derivedName);
        }
      }
      setClearAttachment(false);
      onChangeSubTab("compose");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed inspecting uploaded file.");
    }
  };

  useEffect(() => {
    if (!initialFileToUpload) return;
    void handleFilePicked(initialFileToUpload);
    onConsumedInitialFile?.();
  }, [initialFileToUpload]);

  const handleInspectStoredTemplate = async () => {
    if (!activeTemplate) return;
    setInspectingStored(true);
    try {
      const res = await inspectStoredCustomTemplate({
        data: { templateId: activeTemplate.id },
      });
      setFieldMappings(res.suggestedMappings);
      if (res.isLikelyRelievingTemplate) {
        setDocumentMode("personalized");
        setRequiresRelievingApproval(true);
      }
      toast.success(
        res.suggestedMappings.length > 0
          ? `Detected ${res.suggestedMappings.filter((m) => m.enabled).length} field mapping(s) in stored template. Save/Publish to apply.`
          : "Inspected stored document: all explicit placeholders are listed.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed inspecting stored template.");
    } finally {
      setInspectingStored(false);
    }
  };

  const handleSaveTemplate = async (overrideStatus?: CustomTemplateStatus) => {
    setSaving(true);
    try {
      const res = await uploadAndSaveCustomTemplate({
        data: {
          id: activeTemplate?.id ?? null,
          name,
          description,
          purposeCategory,
          subjectTemplate,
          bodyHtmlTemplate,
          bodyTextTemplate: bodyTextTemplate.trim() || null,
          recipientType,
          defaultEmailMode,
          status: overrideStatus ?? templateStatus,
          documentMode,
          fieldMappings,
          requiresRelievingApproval,
          requiresElevatedApproval,
          clearAttachment,
          file: pendingUpload
            ? {
                fileName: pendingUpload.fileName,
                mimeType: pendingUpload.mimeType,
                base64Data: pendingUpload.base64Data,
              }
            : null,
        },
      });
      await queryClient.invalidateQueries({ queryKey: ["custom-email-templates"] });
      onSelectTemplateId(res.template.id);
      setFieldMappings(res.template.fieldMappings ?? res.suggestedMappings ?? []);
      setDocumentMode(res.template.documentMode);
      setRequiresRelievingApproval(res.template.requiresRelievingApproval);
      setPendingUpload(null);
      setClearAttachment(false);
      toast.success(
        `Saved "${res.template.name}" (v${res.template.version}, ${res.template.status}).`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Saving custom template failed.");
    } finally {
      setSaving(false);
    }
  };

  const selectedRecipients = useMemo(
    () =>
      selectedIds
        .map((id) => recipientCache.get(id))
        .filter((x): x is EmailCenterRecipientItem => Boolean(x)),
    [selectedIds, recipientCache],
  );

  const effectiveTemplateForValidation = useMemo(() => {
    if (!activeTemplate) return null;
    const activeMappings =
      fieldMappings.length > 0 ? fieldMappings : activeTemplate.fieldMappings;
    return {
      ...activeTemplate,
      documentMode,
      fieldMappings: activeMappings,
      requiresRelievingApproval,
    };
  }, [activeTemplate, fieldMappings, documentMode, requiresRelievingApproval]);

  const evaluatedRecipients = useMemo(() => {
    if (!effectiveTemplateForValidation) return [];
    return selectedRecipients.map((recipient) => ({
      recipient,
      evalRes: evaluateCustomTemplateRecipientReadiness({
        template: effectiveTemplateForValidation,
        recipient,
        defaultEmailMode,
        overrideMode: perRecipientOverrides[recipient.recordId],
      }),
    }));
  }, [effectiveTemplateForValidation, selectedRecipients, defaultEmailMode, perRecipientOverrides]);

  const readyRecipients = useMemo(
    () => evaluatedRecipients.filter((r) => r.evalRes.ready),
    [evaluatedRecipients],
  );

  const dedupSummary = useMemo(
    () =>
      deduplicateRecipientDispatches(
        readyRecipients.map((r) => ({
          recipientRecordId: r.recipient.recordId,
          resolvedEmail: r.evalRes.emailResolution.resolvedEmail,
        })),
      ),
    [readyRecipients],
  );

  const downloadBase64Attachment = (
    base64Data: string,
    fileName: string,
    mimeType: string,
  ) => {
    const bytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const handleRunLivePreview = async () => {
    if (!activeTemplate) {
      toast.error("Save the template as Draft or Approved before previewing.");
      return;
    }
    setPreviewBusy(true);
    try {
      const res = await previewCustomEmailTemplate({
        data: {
          templateId: activeTemplate.id,
          sampleRecipientRecordId:
            sampleRecipientId || selectedRecipients[0]?.recordId || null,
          overrideFieldMappings: fieldMappings.length > 0 ? fieldMappings : undefined,
          overrideDocumentMode: documentMode,
        },
      });
      if (fieldMappings.length === 0 && res.suggestedMappings.length > 0) {
        setFieldMappings(res.suggestedMappings);
      }
      setPreviewResult({
        subject: res.subject,
        bodyHtml: res.bodyHtml,
        bodyText: res.bodyText,
        detectedPlaceholders: res.detectedPlaceholders,
        missingPlaceholders: res.missingPlaceholders,
        unresolvedPlaceholders: res.unresolvedPlaceholders,
        remainingBlankFields: res.remainingBlankFields,
        isVerifiedClean: res.isVerifiedClean,
        resolvedAttachmentFilename: res.resolvedAttachmentFilename,
        pdfMode: res.pdfMode,
        pdfWarning: res.pdfWarning,
        docxParagraphs: res.docxParagraphs,
        personalizedAttachmentBase64: res.personalizedAttachmentBase64,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Preview generation failed.");
    } finally {
      setPreviewBusy(false);
    }
  };

  const handlePreviewRecipientDocument = async (recipient: EmailCenterRecipientItem) => {
    if (!activeTemplate) {
      toast.error("Save the template before previewing personalized attachments.");
      return;
    }
    const format = activeTemplate.attachmentFormat === "pdf" ? "pdf" : "docx";
    const expectedFilename = buildPersonalizedAttachmentFilename({
      employeeFullName: recipient.fullName,
      templateDisplayName: activeTemplate.name,
      format,
      documentMode:
        isRelievingStyleCustomTemplate({
          templateName: activeTemplate.name,
          attachmentFilename: activeTemplate.attachmentFilename,
          purposeCategory: activeTemplate.purposeCategory,
          requiresRelievingApproval,
        })
          ? "personalized"
          : documentMode,
      staticOriginalFilename: activeTemplate.attachmentFilename,
    });
    const mimeType =
      format === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    setDocModal({
      open: true,
      loading: true,
      recipientName: recipient.fullName,
      attachmentFilename: expectedFilename,
      mimeType,
      isVerifiedClean: false,
      missingPlaceholders: [],
      unresolvedPlaceholders: [],
      remainingBlankFields: [],
      pdfWarning: null,
      docxParagraphs: [],
      base64Data: null,
    });

    try {
      const res = await previewCustomEmailTemplate({
        data: {
          templateId: activeTemplate.id,
          sampleRecipientRecordId: recipient.recordId,
          overrideFieldMappings: fieldMappings.length > 0 ? fieldMappings : undefined,
          overrideDocumentMode: documentMode,
        },
      });
      setDocModal({
        open: true,
        loading: false,
        recipientName: recipient.fullName,
        attachmentFilename: res.resolvedAttachmentFilename ?? expectedFilename,
        mimeType,
        isVerifiedClean: res.isVerifiedClean,
        missingPlaceholders: res.missingPlaceholders,
        unresolvedPlaceholders: res.unresolvedPlaceholders,
        remainingBlankFields: res.remainingBlankFields,
        pdfWarning: res.pdfWarning,
        docxParagraphs: res.docxParagraphs,
        base64Data: res.personalizedAttachmentBase64,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not generate document preview.");
      setDocModal((prev) => ({ ...prev, open: false, loading: false }));
    }
  };

  const handleConfirmSend = async () => {
    if (!activeTemplate) return;
    setConfirmSendOpen(false);
    setDispatchBusy(true);
    cancelRef.current = false;

    try {
      const created = await createBulkDispatchBatch({
        data: {
          dispatchKind: "custom_template_bulk",
          idempotencyKey: `custom-${activeTemplate.id}-${crypto.randomUUID()}`,
          customTemplateId: activeTemplate.id,
          recipientRecordIds: readyRecipients.map((r) => r.recipient.recordId),
          defaultEmailMode,
          perRecipientEmailOverrides: perRecipientOverrides,
          confirmApproved: true,
        },
      });

      let batch = created.batch;
      setActiveBatch(batch);
      onBatchUpdated?.(batch);

      while (batch.queuedCount > 0 && !cancelRef.current) {
        const res = await processBulkDispatchChunk({
          data: { batchId: batch.id, chunkSize: 10 },
        });
        batch = res.batch;
        setActiveBatch(batch);
        onBatchUpdated?.(batch);
      }

      if (cancelRef.current && batch.queuedCount > 0) {
        const canceled = await cancelQueuedBatchItems({ data: { batchId: batch.id } });
        setActiveBatch(canceled.batch);
        onBatchUpdated?.(canceled.batch);
        toast.info("Remaining unsent queued emails were canceled.");
      } else {
        toast.success(
          `Custom dispatch complete: ${batch.acceptedCount} accepted by Hostinger SMTP, ${batch.failedCount} failed.`,
        );
      }
      await queryClient.invalidateQueries({ queryKey: ["email-dispatch-batches"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Custom template dispatch failed.");
    } finally {
      setDispatchBusy(false);
    }
  };

  const openBatchDetails = async (batchId: string) => {
    setDetailModalOpen(true);
    setDetailLoading(true);
    try {
      const res = await getDispatchBatchDetail({ data: { batchId } });
      setDetailBatch(res.batch);
      setDetailItems(res.items);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load batch details.");
      setDetailModalOpen(false);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleRetryFailedInBatch = async (batchId: string) => {
    try {
      const res = await retryFailedBatchItems({ data: { batchId } });
      if (res.requeuedCount === 0) {
        toast.info("No eligible failed items remain to retry.");
        return;
      }
      toast.success(`Re-queued ${res.requeuedCount} failed item(s). Resuming via Hostinger...`);
      let batch = res.batch;
      while (batch.queuedCount > 0) {
        const chunk = await processBulkDispatchChunk({
          data: { batchId: batch.id, chunkSize: 10 },
        });
        batch = chunk.batch;
      }
      await queryClient.invalidateQueries({ queryKey: ["email-dispatch-batches"] });
      await openBatchDetails(batchId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Retry failed.");
    }
  };

  if (tplQuery.data && !tplQuery.data.schemaReady) {
    return (
      <Card className="border-amber-500/40 bg-amber-500/10">
        <CardContent className="pt-5 text-xs text-amber-800 dark:text-amber-200 space-y-2">
          <div className="flex items-center gap-2 font-semibold text-sm">
            <AlertTriangle className="size-4" />
            <span>Custom Email Templates Schema Pending Migration</span>
          </div>
          <p>
            Apply{" "}
            <code>supabase/migrations/20261127150000_custom_email_templates_and_bulk_dispatch.sql</code>{" "}
            after approval to enable private DOCX/PDF template uploads and durable bulk dispatch batches.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="size-4 text-primary" />
              Custom Email Templates (Word DOCX / PDF + Employee Records)
            </CardTitle>
            <CardDescription className="text-xs">
              Private custom HR communications with dynamic Employee Records integration,{" "}
              <strong>Personal / Work Email</strong> routing, and Hostinger SMTP bulk queue.
            </CardDescription>
          </div>
          {canManage ? (
            <Button type="button" size="sm" onClick={startNewTemplate}>
              <Plus className="mr-1.5 size-3.5" />
              Create Custom Template
            </Button>
          ) : (
            <Badge variant="outline">Read-Only Oversight</Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <input
          ref={fileInputRef}
          type="file"
          accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="sr-only"
          onChange={(e) => {
            void handleFilePicked(e.target.files?.[0] ?? null);
            e.target.value = "";
          }}
        />
        <Tabs value={subTab} onValueChange={(v) => onChangeSubTab(v as CustomWorkspaceSubTab)}>
          <TabsList className="flex flex-wrap h-auto">
            <TabsTrigger value="library" className="text-xs">
              Template Library ({templates.length})
            </TabsTrigger>
            <TabsTrigger value="compose" className="text-xs">
              Upload &amp; Compose
            </TabsTrigger>
            <TabsTrigger value="recipients" className="text-xs">
              Recipients ({selectedIds.length})
            </TabsTrigger>
            <TabsTrigger value="preview" className="text-xs">
              Preview
            </TabsTrigger>
            <TabsTrigger value="send" className="text-xs">
              Send ({dedupSummary.uniqueItems.length})
            </TabsTrigger>
            <TabsTrigger value="history" className="text-xs">
              Dispatch History
            </TabsTrigger>
          </TabsList>

          {/* 1. TEMPLATE LIBRARY */}
          <TabsContent value="library" className="pt-3 space-y-3">
            {templates.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-8 text-center text-xs text-muted-foreground space-y-2.5">
                <p>No custom Word/PDF email templates saved yet.</p>
                {canManage ? (
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        onSelectTemplateId(null);
                        fileInputRef.current?.click();
                      }}
                    >
                      <Upload className="mr-1.5 size-3.5 text-primary" />
                      Upload First DOCX / PDF Template
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {templates.map((t) => (
                  <div
                    key={t.id}
                    className={`rounded-lg border p-3.5 text-xs space-y-2 cursor-pointer transition-colors ${
                      activeTemplate?.id === t.id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/30"
                    }`}
                    onClick={() => {
                      onSelectTemplateId(t.id);
                      onChangeSubTab("compose");
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold text-sm text-foreground">{t.name}</p>
                        <p className="text-[11px] text-muted-foreground">{t.description || t.purposeCategory}</p>
                      </div>
                      <Badge
                        variant={
                          t.status === "approved"
                            ? "success"
                            : t.status === "archived"
                              ? "neutral"
                              : "outline"
                        }
                        className="text-[10px] uppercase"
                      >
                        {t.status} • v{t.version}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="text-[10px] uppercase">
                        {t.attachmentFormat === "none"
                          ? "Email Body Only"
                          : `${t.attachmentFormat}${t.pdfMode ? ` (${t.pdfMode})` : ""}`}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] uppercase">
                        Default: {t.defaultEmailMode}
                      </Badge>
                      {t.attachmentFilename ? (
                        <span className="truncate font-mono text-[10px] text-muted-foreground">
                          {t.attachmentFilename}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* 2. UPLOAD & COMPOSE */}
          <TabsContent value="compose" className="pt-3 space-y-4">
            {/* Private DOCX / PDF Attachment Upload (Primary Dropzone + File Picker at top) */}
            <div
              onDragOver={(e) => {
                if (!canManage) return;
                e.preventDefault();
                setIsDragOver(true);
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={(e) => {
                if (!canManage) return;
                e.preventDefault();
                setIsDragOver(false);
                const dropped = e.dataTransfer.files?.[0] ?? null;
                void handleFilePicked(dropped);
              }}
              className={`rounded-lg border-2 border-dashed p-3.5 space-y-2.5 text-xs transition-colors ${
                isDragOver
                  ? "border-primary bg-primary/10"
                  : "border-border bg-muted/20"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-foreground">
                    Attachment Template Upload (.docx Word or .pdf — max 10 MB, Private Bucket)
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Drag &amp; drop a file here or click Choose File. Word documents preserve logos, headers/footers, tables &amp; placeholders; PDFs are verified for fillable vs static mode.
                  </p>
                </div>
                {canManage ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="mr-1.5 size-3.5 text-primary" />
                    Choose .docx or .pdf File
                  </Button>
                ) : null}
              </div>

              {pendingUpload ? (
                <div className="rounded border border-primary/40 bg-primary/5 p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      Ready to upload: <code>{pendingUpload.fileName}</code> (
                      {pendingUpload.format.toUpperCase()})
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => setPendingUpload(null)}
                    >
                      Discard
                    </Button>
                  </div>
                  {pendingUpload.warning ? (
                    <div className="flex items-start gap-1.5 text-amber-800 dark:text-amber-200">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                      <span>{pendingUpload.warning}</span>
                    </div>
                  ) : null}
                  {pendingUpload.detectedPlaceholders.length > 0 ? (
                    <div className="text-[11px]">
                      Detected document placeholders:{" "}
                      {pendingUpload.detectedPlaceholders.map((p) => (
                        <code key={p} className="mr-1 rounded bg-background px-1 py-0.5">
                          {`{{${p}}}`}
                        </code>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : activeTemplate?.attachmentFilename && !clearAttachment ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-background p-2.5">
                  <div className="space-y-1">
                    <div>
                      Stored attachment: <code>{activeTemplate.attachmentFilename}</code> (
                      {activeTemplate.attachmentFormat.toUpperCase()}
                      {activeTemplate.pdfMode ? ` • ${activeTemplate.pdfMode}` : ""})
                    </div>
                    {activeTemplate.attachmentFormat === "pdf" &&
                    activeTemplate.pdfMode === "static" ? (
                      <div className="flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="size-3.5 shrink-0" />
                        <span>{STATIC_PDF_WARNING_MESSAGE}</span>
                      </div>
                    ) : null}
                  </div>
                  {canManage ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[11px] text-destructive"
                      onClick={() => setClearAttachment(true)}
                    >
                      Remove Attachment
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-xs">
              <div className="space-y-1">
                <Label htmlFor="ct-name">Template Name *</Label>
                <Input
                  id="ct-name"
                  value={name}
                  disabled={!canManage}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Appraisal Revised Letter"
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ct-cat">Purpose / Category</Label>
                <Input
                  id="ct-cat"
                  value={purposeCategory}
                  disabled={!canManage}
                  onChange={(e) => setPurposeCategory(e.target.value)}
                  placeholder="e.g. hr_notice, experience, revision"
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ct-rec-type">Target Audience Type</Label>
                <select
                  id="ct-rec-type"
                  value={recipientType}
                  disabled={!canManage}
                  onChange={(e) =>
                    setRecipientType(e.target.value as CustomTemplateRecipientType)
                  }
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="all_records">All Employee Records</option>
                  <option value="active_employees">Active Employees</option>
                  <option value="former_employees">Former / Relieved Staff</option>
                  <option value="interns_trainers">Interns &amp; Trainers</option>
                  <option value="custom">Custom Selection</option>
                </select>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 text-xs">
              <div className="space-y-1">
                <Label htmlFor="ct-desc">Description</Label>
                <Input
                  id="ct-desc"
                  value={description}
                  disabled={!canManage}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Internal HR description of purpose and audience"
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label>Sender Identity (Hostinger SMTP)</Label>
                <Input value={OFFICIAL_SENDER_DISPLAY} disabled className="h-8 font-mono text-xs" />
              </div>
            </div>

            <div className="space-y-1 text-xs">
              <Label htmlFor="ct-subject">Email Subject *</Label>
              <Input
                id="ct-subject"
                value={subjectTemplate}
                disabled={!canManage}
                onChange={(e) => setSubjectTemplate(e.target.value)}
                className="h-8 text-xs"
              />
            </div>

            <div className="grid gap-3 lg:grid-cols-2 text-xs">
              <div className="space-y-1">
                <Label htmlFor="ct-body-html">Email Body (HTML / Personalizable) *</Label>
                <Textarea
                  id="ct-body-html"
                  rows={8}
                  value={bodyHtmlTemplate}
                  disabled={!canManage}
                  onChange={(e) => setBodyHtmlTemplate(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ct-body-text">Plain-Text Fallback (Optional)</Label>
                <Textarea
                  id="ct-body-text"
                  rows={8}
                  value={bodyTextTemplate}
                  disabled={!canManage}
                  onChange={(e) => setBodyTextTemplate(e.target.value)}
                  placeholder="Optional plain-text version..."
                  className="font-mono text-xs"
                />
              </div>
            </div>

            {/* Supported Placeholders Cheat-sheet */}
            <div className="rounded-md border border-border bg-muted/30 p-2.5 text-[11px]">
              <span className="font-semibold">Supported Employee Placeholders: </span>
              <span className="flex flex-wrap gap-1 mt-1">
                {CUSTOM_TEMPLATE_PLACEHOLDERS.map((p) => (
                  <code
                    key={p}
                    className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px]"
                  >
                    {`{{${p}}}`}
                  </code>
                ))}
              </span>
            </div>

            {/* Controlled Document Mode + DOCX Field Mapping Panel */}
            <div className="rounded-lg border border-border bg-muted/20 p-3.5 space-y-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-foreground">
                    Document Personalization &amp; Attachment Naming
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Output filename:{" "}
                    <code>
                      Employee Full Name - {name.trim() || "Template Display Name"}.
                      {pendingUpload?.format ??
                        (activeTemplate?.attachmentFormat === "pdf" ? "pdf" : "docx")}
                    </code>
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <div
                    className="inline-flex rounded-md border border-border bg-background p-0.5"
                    role="group"
                    aria-label="Document personalization mode"
                  >
                    <Button
                      type="button"
                      size="sm"
                      disabled={!canManage}
                      variant={documentMode === "personalized" ? "default" : "ghost"}
                      className="h-7 px-2.5 text-[11px] font-semibold"
                      onClick={() => setDocumentMode("personalized")}
                    >
                      PERSONALIZED DOCUMENT
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={!canManage || requiresRelievingApproval}
                      variant={documentMode === "static" ? "default" : "ghost"}
                      className="h-7 px-2.5 text-[11px] font-semibold"
                      onClick={() => setDocumentMode("static")}
                    >
                      STATIC DOCUMENT
                    </Button>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px]">
                  <Checkbox
                    checked={requiresRelievingApproval}
                    disabled={!canManage}
                    onCheckedChange={(v) => {
                      const next = Boolean(v);
                      setRequiresRelievingApproval(next);
                      if (next) setDocumentMode("personalized");
                    }}
                  />
                  <span>
                    Official Relieving / Experience Template (requires approved relieving case &amp; verified dates)
                  </span>
                </label>

                {canManage && activeTemplate?.attachmentFilename ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    disabled={inspectingStored}
                    onClick={() => void handleInspectStoredTemplate()}
                  >
                    <RefreshCw
                      className={`mr-1 size-3 ${inspectingStored ? "animate-spin" : ""}`}
                    />
                    {inspectingStored ? "Inspecting..." : "Inspect Stored DOCX & Detect Blank Fields"}
                  </Button>
                ) : null}
              </div>

              {fieldMappings.length > 0 ? (
                <div className="space-y-1.5 rounded border border-border bg-background p-2.5">
                  <p className="font-semibold text-[11px] text-foreground">
                    Controlled Word Field Mappings ({fieldMappings.filter((m) => m.enabled).length} active):
                  </p>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {fieldMappings.map((rule) => (
                      <label
                        key={rule.id}
                        className="flex cursor-pointer items-center justify-between gap-2 rounded border border-border/60 px-2 py-1 text-[11px]"
                      >
                        <span className="flex items-center gap-1.5 min-w-0">
                          <Checkbox
                            checked={rule.enabled}
                            disabled={!canManage}
                            onCheckedChange={(v) =>
                              setFieldMappings((prev) =>
                                prev.map((m) =>
                                  m.id === rule.id ? { ...m, enabled: Boolean(v) } : m,
                                ),
                              )
                            }
                          />
                          <span className="truncate">{rule.label}</span>
                        </span>
                        <code className="shrink-0 text-[10px] text-primary">
                          {`{{${rule.placeholder}}}`}
                        </code>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            {/* Settings + Save Actions */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-xs">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <Label htmlFor="ct-default-email">Default Email:</Label>
                  <select
                    id="ct-default-email"
                    value={defaultEmailMode}
                    disabled={!canManage}
                    onChange={(e) => setDefaultEmailMode(e.target.value as RecipientEmailMode)}
                    className="h-8 rounded border border-input bg-background px-2 text-xs"
                  >
                    <option value="personal">PERSONAL EMAIL</option>
                    <option value="work">WORK EMAIL</option>
                  </select>
                </div>

                <label className="flex items-center gap-1.5 cursor-pointer">
                  <Checkbox
                    checked={requiresElevatedApproval}
                    disabled={!canManage}
                    onCheckedChange={(v) => setRequiresElevatedApproval(Boolean(v))}
                  />
                  <span>Sensitive HR Communication (Requires Approved Status)</span>
                </label>
              </div>

              {canManage ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={saving}
                    onClick={() => void handleSaveTemplate("draft")}
                  >
                    <Save className="mr-1.5 size-3.5" />
                    Save Draft
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={saving}
                    onClick={() => void handleSaveTemplate("approved")}
                  >
                    <ShieldCheck className="mr-1.5 size-3.5" />
                    {saving ? "Saving..." : "Publish / Approve"}
                  </Button>
                </div>
              ) : null}
            </div>

            {/* Version History */}
            {activeTemplate && (versionsByTemplateId[activeTemplate.id]?.length ?? 0) > 0 ? (
              <div className="rounded-md border border-border p-3 text-xs space-y-1.5">
                <div className="flex items-center gap-1.5 font-semibold">
                  <History className="size-3.5 text-muted-foreground" />
                  <span>Version History</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {versionsByTemplateId[activeTemplate.id]!.slice(0, 6).map((v) => (
                    <Badge key={v.id} variant="outline" className="text-[10px]">
                      v{v.version} ({v.status}) • {new Date(v.createdAt).toLocaleDateString("en-IN")}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
          </TabsContent>

          {/* 3. RECIPIENTS (EMPLOYEE RECORDS) */}
          <TabsContent value="recipients" className="pt-3 space-y-3">
            <RecordsRecipientPicker
              context="custom"
              selectedIds={selectedIds}
              recipientCache={recipientCache}
              onChangeSelection={(ids, cache) => {
                setSelectedIds(ids);
                setRecipientCache(cache);
              }}
              defaultEmailMode={defaultEmailMode}
              onChangeEmailMode={setDefaultEmailMode}
              canViewPersonalEmails={canViewPersonalEmails}
            />

            {evaluatedRecipients.length > 0 ? (
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-foreground">
                    Pre-Send Validation &amp; Per-Recipient Attachment Review ({readyRecipients.length} Ready / {evaluatedRecipients.length} Selected)
                  </span>
                  {evaluatedRecipients.length > readyRecipients.length ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px]"
                      onClick={() => {
                        setSelectedIds(readyRecipients.map((r) => r.recipient.recordId));
                        toast.info(`Kept ${readyRecipients.length} verified ready recipient(s).`);
                      }}
                    >
                      <Filter className="mr-1 size-3" />
                      Exclude Invalid ({evaluatedRecipients.length - readyRecipients.length})
                    </Button>
                  ) : null}
                </div>

                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-border bg-muted/50 text-[11px] text-muted-foreground">
                        <th className="px-2 py-2">Employee &amp; ID</th>
                        <th className="px-2 py-2">Email Type &amp; Target</th>
                        <th className="px-2 py-2">Issue Date</th>
                        <th className="px-2 py-2">Joining Date</th>
                        <th className="px-2 py-2">Last Working</th>
                        <th className="px-2 py-2">Relieving Date</th>
                        <th className="px-2 py-2">Designation</th>
                        <th className="px-2 py-2">Document Preview</th>
                        <th className="px-2 py-2">Validation Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {evaluatedRecipients.map(({ recipient, evalRes }) => {
                        const override =
                          perRecipientOverrides[recipient.recordId] ?? defaultEmailMode;
                        const vars = evalRes.resolvedVariables;
                        return (
                          <tr key={recipient.recordId} className="align-top">
                            <td className="px-2 py-2">
                              <div className="font-medium text-foreground">{recipient.fullName}</div>
                              <div className="font-mono text-[10px] text-muted-foreground">
                                {recipient.employeeCode ?? recipient.historicalRecordId}
                              </div>
                            </td>
                            <td className="px-2 py-2">
                              <div className="flex flex-col gap-1">
                                <select
                                  aria-label={`Override email mode for ${recipient.fullName}`}
                                  value={override}
                                  onChange={(e) =>
                                    setPerRecipientOverrides((prev) => ({
                                      ...prev,
                                      [recipient.recordId]: e.target.value as RecipientEmailMode,
                                    }))
                                  }
                                  className="h-6 rounded border border-input bg-background px-1 text-[10px]"
                                >
                                  <option value="personal">PERSONAL EMAIL</option>
                                  <option value="work">WORK EMAIL</option>
                                </select>
                                <span className="truncate max-w-[160px] font-mono text-[10px]">
                                  {evalRes.emailResolution.resolvedEmail ? (
                                    canViewPersonalEmails || override === "work" ? (
                                      evalRes.emailResolution.resolvedEmail
                                    ) : (
                                      "Verified Personal Email"
                                    )
                                  ) : (
                                    <span className="text-destructive">
                                      {evalRes.emailResolution.statusLabel}
                                    </span>
                                  )}
                                </span>
                              </div>
                            </td>
                            <td className="px-2 py-2 font-mono text-[11px]">
                              {vars["issue_date"] || <span className="text-destructive">Missing</span>}
                            </td>
                            <td className="px-2 py-2 font-mono text-[11px]">
                              {vars["joining_date"] || <span className="text-destructive">Missing</span>}
                            </td>
                            <td className="px-2 py-2 font-mono text-[11px]">
                              {vars["last_working_date"] || <span className="text-destructive">Missing</span>}
                            </td>
                            <td className="px-2 py-2 font-mono text-[11px]">
                              {vars["relieving_date"] || <span className="text-destructive">Missing</span>}
                            </td>
                            <td className="px-2 py-2 text-[11px]">
                              {vars["designation"] || <span className="text-destructive">Missing</span>}
                            </td>
                            <td className="px-2 py-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-[10px]"
                                onClick={() => void handlePreviewRecipientDocument(recipient)}
                              >
                                <Eye className="mr-1 size-3" />
                                Preview This Employee&apos;s Document
                              </Button>
                              {evalRes.resolvedFilename ? (
                                <p className="mt-1 max-w-[180px] truncate font-mono text-[9px] text-muted-foreground">
                                  {evalRes.resolvedFilename}
                                </p>
                              ) : null}
                            </td>
                            <td className="px-2 py-2">
                              <Badge
                                variant={
                                  evalRes.validationStatus === "ready"
                                    ? "success"
                                    : evalRes.validationStatus === "approval_pending"
                                      ? "outline"
                                      : "destructive"
                                }
                                className="text-[10px]"
                              >
                                {evalRes.statusLabel}
                              </Badge>
                              {evalRes.reason ? (
                                <p className="mt-1 max-w-[190px] text-[10px] text-muted-foreground">
                                  {evalRes.reason}
                                </p>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </TabsContent>

          {/* 4. LIVE TEMPLATE & ATTACHMENT PREVIEW */}
          <TabsContent value="preview" className="pt-3 space-y-3">
            {!activeTemplate ? (
              <p className="text-xs text-muted-foreground">
                Select or save a custom template first to inspect its live preview.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/20 p-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Label htmlFor="ct-sample-emp">Sample Employee:</Label>
                    <select
                      id="ct-sample-emp"
                      value={sampleRecipientId}
                      onChange={(e) => setSampleRecipientId(e.target.value)}
                      className="h-8 rounded border border-input bg-background px-2 text-xs"
                    >
                      <option value="">Default Sample Values</option>
                      {selectedRecipients.map((r) => (
                        <option key={r.recordId} value={r.recordId}>
                          {r.fullName} ({r.employeeCode ?? r.historicalRecordId})
                        </option>
                      ))}
                    </select>
                    <Button
                      type="button"
                      size="sm"
                      disabled={previewBusy}
                      onClick={() => void handleRunLivePreview()}
                    >
                      <Eye className="mr-1.5 size-3.5" />
                      {previewBusy ? "Rendering..." : "Generate Preview"}
                    </Button>
                  </div>

                  <div className="flex gap-1">
                    {(["html", "text", "document"] as const).map((m) => (
                      <Button
                        key={m}
                        type="button"
                        size="sm"
                        variant={previewMode === m ? "default" : "outline"}
                        className="h-7 text-[11px] capitalize"
                        onClick={() => setPreviewMode(m)}
                      >
                        {m === "html" ? "Email HTML" : m === "text" ? "Plain Text" : "Document"}
                      </Button>
                    ))}
                  </div>
                </div>

                {previewResult ? (
                  <div className="space-y-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span>
                          <strong>Generated Attachment:</strong>{" "}
                          <code>
                            {previewResult.resolvedAttachmentFilename ??
                              activeTemplate.attachmentFilename ??
                              "None"}
                          </code>{" "}
                          ({activeTemplate.attachmentFormat.toUpperCase()})
                        </span>
                        <span>•</span>
                        <span>
                          <strong>Subject:</strong> {previewResult.subject}
                        </span>
                        <Badge
                          variant={previewResult.isVerifiedClean ? "success" : "destructive"}
                          className="text-[10px]"
                        >
                          {previewResult.isVerifiedClean
                            ? "Verified Populated"
                            : "Blocked — Missing / Unfilled Fields"}
                        </Badge>
                      </div>
                      {previewResult.personalizedAttachmentBase64 &&
                      previewResult.resolvedAttachmentFilename ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-[11px]"
                          onClick={() =>
                            downloadBase64Attachment(
                              previewResult.personalizedAttachmentBase64!,
                              previewResult.resolvedAttachmentFilename!,
                              activeTemplate.attachmentFormat === "pdf"
                                ? "application/pdf"
                                : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                            )
                          }
                        >
                          <Download className="mr-1 size-3" />
                          Download Preview
                        </Button>
                      ) : null}
                    </div>

                    {previewResult.pdfWarning ? (
                      <div className="flex items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2.5 text-amber-800 dark:text-amber-200">
                        <AlertTriangle className="size-4 shrink-0" />
                        <span>{previewResult.pdfWarning}</span>
                      </div>
                    ) : null}

                    {previewResult.missingPlaceholders.length > 0 ||
                    previewResult.unresolvedPlaceholders.length > 0 ||
                    previewResult.remainingBlankFields.length > 0 ? (
                      <div className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 p-2.5 text-destructive">
                        <XCircle className="mt-0.5 size-4 shrink-0" />
                        <div className="space-y-0.5">
                          {previewResult.missingPlaceholders.length > 0 ? (
                            <p>
                              Missing employee values:{" "}
                              {previewResult.missingPlaceholders.map((p) => `{{${p}}}`).join(", ")}
                            </p>
                          ) : null}
                          {previewResult.remainingBlankFields.length > 0 ? (
                            <p>
                              Unfilled blank fields detected in document:{" "}
                              {previewResult.remainingBlankFields.join(", ")}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    ) : null}

                    {previewMode === "html" ? (
                      <iframe
                        title="Custom Email HTML Preview"
                        sandbox="allow-same-origin"
                        srcDoc={previewResult.bodyHtml}
                        className="h-[380px] w-full rounded border border-border bg-white"
                      />
                    ) : previewMode === "text" ? (
                      <pre className="h-[340px] overflow-auto whitespace-pre-wrap rounded border border-border bg-muted/30 p-3 font-mono text-xs">
                        {previewResult.bodyText}
                      </pre>
                    ) : (
                      <div className="rounded border border-border bg-muted/20 p-4 space-y-2">
                        {activeTemplate.attachmentFormat === "docx" ? (
                          previewResult.docxParagraphs.length > 0 ? (
                            <div className="space-y-2 rounded border border-border bg-white p-4 text-zinc-900">
                              <p className="text-[11px] font-semibold text-muted-foreground">
                                Resolved Word (.docx) Content Preview:
                              </p>
                              {previewResult.docxParagraphs.map((p, idx) => (
                                <p key={idx} className="text-xs leading-relaxed">
                                  {p}
                                </p>
                              ))}
                            </div>
                          ) : (
                            <p className="text-muted-foreground">
                              DOCX document ready (no extractable body paragraphs).
                            </p>
                          )
                        ) : activeTemplate.attachmentFormat === "pdf" &&
                          previewResult.personalizedAttachmentBase64 ? (
                          <iframe
                            src={`data:application/pdf;base64,${previewResult.personalizedAttachmentBase64}#toolbar=1&navpanes=0`}
                            title="Custom PDF Attachment Preview"
                            className="h-[460px] w-full rounded border border-border bg-white"
                          />
                        ) : (
                          <p className="text-muted-foreground">No attachment configured for this template.</p>
                        )}
                      </div>
                    )}
                  </div>
                ) : null}
              </>
            )}
          </TabsContent>

          {/* 5. SEND & PROGRESS */}
          <TabsContent value="send" className="pt-3 space-y-3 text-xs">
            {!activeTemplate ? (
              <p className="text-muted-foreground">Select or save a custom template first.</p>
            ) : (
              <Card>
                <CardContent className="pt-4 space-y-3">
                  <div className="grid gap-3 sm:grid-cols-4">
                    <div className="rounded border p-2.5">
                      <p className="text-muted-foreground">Template</p>
                      <p className="font-semibold">
                        {activeTemplate.name} ({activeTemplate.status})
                      </p>
                    </div>
                    <div className="rounded border p-2.5">
                      <p className="text-muted-foreground">Selected</p>
                      <p className="font-semibold">{selectedIds.length} recipient(s)</p>
                    </div>
                    <div className="rounded border p-2.5">
                      <p className="text-muted-foreground">Ready &amp; Deduplicated</p>
                      <p className="font-semibold text-emerald-700 dark:text-emerald-300">
                        {dedupSummary.uniqueItems.length} message(s)
                      </p>
                    </div>
                    <div className="rounded border p-2.5">
                      <p className="text-muted-foreground">Blocked / Missing</p>
                      <p className="font-semibold text-destructive">
                        {evaluatedRecipients.length - readyRecipients.length}
                      </p>
                    </div>
                  </div>

                  {activeTemplate.status !== "approved" ? (
                    <div className="flex items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2.5 text-amber-800 dark:text-amber-200">
                      <AlertTriangle className="size-4 shrink-0" />
                      <span>
                        Template status is <strong>{activeTemplate.status}</strong>. Publish/Approve the template in <strong>Upload &amp; Compose</strong> before dispatching.
                      </span>
                    </div>
                  ) : null}

                  {activeBatch ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded border bg-muted/40 p-2.5">
                      <div className="flex items-center gap-2">
                        {dispatchBusy ? <Loader2 className="size-3.5 animate-spin text-primary" /> : null}
                        <span>
                          Status: <strong className="capitalize">{activeBatch.status.replace(/_/g, " ")}</strong> • Accepted by SMTP:{" "}
                          <strong>{activeBatch.acceptedCount}</strong> • Queued:{" "}
                          <strong>{activeBatch.queuedCount}</strong> • Failed:{" "}
                          <strong className="text-destructive">{activeBatch.failedCount}</strong>
                        </span>
                      </div>
                      {dispatchBusy && activeBatch.queuedCount > 0 ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            cancelRef.current = true;
                          }}
                        >
                          Cancel Unsent
                        </Button>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      disabled={
                        !canSend ||
                        !providerConfigured ||
                        dispatchBusy ||
                        activeTemplate.status !== "approved" ||
                        dedupSummary.uniqueItems.length === 0
                      }
                      onClick={() => setConfirmSendOpen(true)}
                    >
                      <Send className="mr-1.5 size-3.5" />
                      {dispatchBusy
                        ? "Dispatching via Hostinger..."
                        : `Send Individual Emails (${dedupSummary.uniqueItems.length})`}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* 6. DISPATCH HISTORY */}
          <TabsContent value="history" className="pt-3 space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold">Recent Bulk Dispatch Batches</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void batchesQuery.refetch()}
              >
                <RefreshCw className="mr-1.5 size-3.5" />
                Refresh
              </Button>
            </div>
            {(batchesQuery.data?.batches ?? []).length === 0 ? (
              <p className="py-6 text-center text-muted-foreground">No bulk batches queued yet.</p>
            ) : (
              <div className="overflow-x-auto rounded border border-border">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b bg-muted/50 text-[11px] text-muted-foreground">
                      <th className="px-2.5 py-2">Template</th>
                      <th className="px-2.5 py-2">Status</th>
                      <th className="px-2.5 py-2">Accepted / Total</th>
                      <th className="px-2.5 py-2">Failed</th>
                      <th className="px-2.5 py-2">Email Breakdown</th>
                      <th className="px-2.5 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {(batchesQuery.data?.batches ?? []).map((b) => (
                      <tr key={b.id}>
                        <td className="px-2.5 py-2">
                          <div className="font-medium">{b.templateName}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {new Date(b.createdAt).toLocaleString("en-IN")}
                          </div>
                        </td>
                        <td className="px-2.5 py-2 capitalize">{b.status.replace(/_/g, " ")}</td>
                        <td className="px-2.5 py-2 font-mono">
                          {b.acceptedCount} / {b.totalCount}
                        </td>
                        <td className="px-2.5 py-2 font-mono text-destructive">{b.failedCount}</td>
                        <td className="px-2.5 py-2 text-[11px]">
                          {b.personalEmailCount} Personal • {b.workEmailCount} Work
                        </td>
                        <td className="px-2.5 py-2 text-right">
                          <div className="flex justify-end gap-1.5">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-[11px]"
                              onClick={() => void openBatchDetails(b.id)}
                            >
                              Details
                            </Button>
                            {canSend && b.failedCount > 0 ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-[11px]"
                                onClick={() => void handleRetryFailedInBatch(b.id)}
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
            )}
          </TabsContent>
        </Tabs>
      </CardContent>

      {/* Explicit Confirmation Modal Before Custom Bulk Dispatch */}
      <AlertDialog open={confirmSendOpen} onOpenChange={setConfirmSendOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Confirm Custom Email Dispatch ({dedupSummary.uniqueItems.length} Recipient(s))
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-xs">
                <ul className="list-disc pl-4 space-y-1">
                  <li>
                    <strong>Template:</strong> {activeTemplate?.name} (v{activeTemplate?.version})
                  </li>
                  <li>
                    <strong>Subject:</strong> {activeTemplate?.subjectTemplate}
                  </li>
                  <li>
                    <strong>Sender:</strong> {OFFICIAL_SENDER_DISPLAY}
                  </li>
                  <li>
                    <strong>Attachment:</strong>{" "}
                    {activeTemplate?.attachmentFilename
                      ? `${activeTemplate.attachmentFilename} (${activeTemplate.attachmentFormat.toUpperCase()})`
                      : "None (email body only)"}
                  </li>
                  <li>
                    <strong>Personal vs Work Email:</strong>{" "}
                    {readyRecipients.filter((r) => r.evalRes.emailResolution.emailMode === "personal").length}{" "}
                    Personal •{" "}
                    {readyRecipients.filter((r) => r.evalRes.emailResolution.emailMode === "work").length}{" "}
                    Work
                  </li>
                  <li>
                    <strong>Skipped (Missing / Invalid / Duplicate):</strong>{" "}
                    {evaluatedRecipients.length - dedupSummary.uniqueItems.length}
                  </li>
                </ul>
                <p>
                  Messages are sent individually in rate-limited Hostinger SMTP chunks with no CC list exposed.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dispatchBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={dispatchBusy} onClick={() => void handleConfirmSend()}>
              Confirm &amp; Queue Dispatch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Batch Detail Modal */}
      <Dialog open={detailModalOpen} onOpenChange={setDetailModalOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Batch Delivery Log — {detailBatch?.templateName}</DialogTitle>
            <DialogDescription>
              Per-recipient Hostinger SMTP status (`accepted_by_smtp` reflects relay acceptance only).
            </DialogDescription>
          </DialogHeader>
          {detailLoading ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              <Loader2 className="mx-auto mb-2 size-5 animate-spin" />
              Loading recipient dispatch items...
            </div>
          ) : (
            <div className="max-h-[420px] overflow-auto rounded border border-border">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b bg-muted/50 text-[11px]">
                    <th className="px-2.5 py-2">Recipient</th>
                    <th className="px-2.5 py-2">Email</th>
                    <th className="px-2.5 py-2">Status</th>
                    <th className="px-2.5 py-2">Error / Message ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {detailItems.map((it) => (
                    <tr key={it.id}>
                      <td className="px-2.5 py-2 font-medium">{it.recipientName}</td>
                      <td className="px-2.5 py-2 font-mono text-[11px]">
                        {it.recipientEmail} ({it.emailMode})
                      </td>
                      <td className="px-2.5 py-2">
                        <Badge variant="outline" className="text-[10px]">
                          {it.status}
                        </Badge>
                      </td>
                      <td className="px-2.5 py-2 font-mono text-[10px] text-muted-foreground">
                        {it.errorMessage || it.providerMessageId || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Actual Per-Recipient Personalized Document Preview Modal */}
      <Dialog
        open={docModal.open}
        onOpenChange={(open) => setDocModal((prev) => ({ ...prev, open }))}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Personalized Attachment Preview — {docModal.recipientName}
            </DialogTitle>
            <DialogDescription>
              Actual generated recipient attachment:{" "}
              <code className="font-mono text-foreground">{docModal.attachmentFilename}</code>
            </DialogDescription>
          </DialogHeader>

          {docModal.loading ? (
            <div className="py-12 text-center text-xs text-muted-foreground">
              <Loader2 className="mx-auto mb-2 size-5 animate-spin text-primary" />
              Generating personalized document for {docModal.recipientName}...
            </div>
          ) : (
            <div className="space-y-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2.5">
                <div className="flex items-center gap-2">
                  {docModal.isVerifiedClean && docModal.missingPlaceholders.length === 0 ? (
                    <Badge variant="success" className="text-[10px]">
                      Verified: Zero Unresolved Placeholders
                    </Badge>
                  ) : (
                    <Badge variant="destructive" className="text-[10px]">
                      Blocked: Incomplete / Unfilled Fields
                    </Badge>
                  )}
                </div>
                {docModal.base64Data ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() =>
                      downloadBase64Attachment(
                        docModal.base64Data!,
                        docModal.attachmentFilename,
                        docModal.mimeType,
                      )
                    }
                  >
                    <Download className="mr-1.5 size-3.5" />
                    Download Preview
                  </Button>
                ) : null}
              </div>

              {docModal.missingPlaceholders.length > 0 ||
              docModal.remainingBlankFields.length > 0 ? (
                <div className="rounded border border-destructive/40 bg-destructive/10 p-2.5 text-destructive space-y-1">
                  {docModal.missingPlaceholders.length > 0 ? (
                    <p>
                      Missing employee values:{" "}
                      {docModal.missingPlaceholders.map((p) => `{{${p}}}`).join(", ")}
                    </p>
                  ) : null}
                  {docModal.remainingBlankFields.length > 0 ? (
                    <p>
                      Remaining blank fields in document:{" "}
                      {docModal.remainingBlankFields.join(", ")}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {docModal.mimeType === "application/pdf" && docModal.base64Data ? (
                <iframe
                  src={`data:application/pdf;base64,${docModal.base64Data}#toolbar=1&navpanes=0`}
                  title={`Personalized PDF for ${docModal.recipientName}`}
                  className="h-[460px] w-full rounded border border-border bg-white"
                />
              ) : (
                <div className="max-h-[420px] overflow-auto rounded border border-border bg-white p-5 text-zinc-900 space-y-2">
                  {docModal.docxParagraphs.map((p, idx) => (
                    <p key={idx} className="text-xs leading-relaxed">
                      {p}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
