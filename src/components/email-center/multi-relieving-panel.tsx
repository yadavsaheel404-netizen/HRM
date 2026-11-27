import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Download,
  Eye,
  Filter,
  Loader2,
  Send,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  cancelQueuedBatchItems,
  createBulkDispatchBatch,
  downloadApprovedRelievingZip,
  previewIndividualRelievingPdf,
  processBulkDispatchChunk,
} from "@/lib/email-center-bulk.functions";
import {
  deduplicateRecipientDispatches,
  evaluateRelievingRecipientReadiness,
} from "@/lib/email-center/custom-templates";
import type {
  EmailCenterRecipientItem,
  EmailDispatchBatchRecord,
  RecipientEmailMode,
  RelievingValidationStatus,
} from "@/lib/email-center/types";
import { formatLetterDate } from "@/lib/relieving/types";
import { RecordsRecipientPicker } from "./records-recipient-picker";

interface MultiRelievingPanelProps {
  canSendEmails: boolean;
  canViewPersonalEmails: boolean;
  providerConfigured: boolean;
  onSelectSingleEmployee: (recipient: EmailCenterRecipientItem) => void;
  onBatchUpdated?: (batch: EmailDispatchBatchRecord) => void;
}

function validationBadgeVariant(
  status: RelievingValidationStatus,
): "success" | "info" | "destructive" | "neutral" | "outline" {
  if (status === "ready") return "success";
  if (status === "already_issued" || status === "already_sent") return "info";
  if (status === "blocked") return "destructive";
  return "outline";
}

function downloadBase64File(base64: string, fileName: string, mimeType: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function MultiRelievingPanel({
  canSendEmails,
  canViewPersonalEmails,
  providerConfigured,
  onSelectSingleEmployee,
  onBatchUpdated,
}: MultiRelievingPanelProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [recipientCache, setRecipientCache] = useState<Map<string, EmailCenterRecipientItem>>(
    () => new Map(),
  );
  const [defaultEmailMode, setDefaultEmailMode] = useState<RecipientEmailMode>("personal");
  const [perRecipientOverrides, setPerRecipientOverrides] = useState<
    Record<string, RecipientEmailMode>
  >({});
  const [pdfModal, setPdfModal] = useState<{
    open: boolean;
    loading: boolean;
    employeeName: string;
    fileName: string;
    pdfUrl: string | null;
    isOfficialApproved: boolean;
    reasons: string[];
  }>({
    open: false,
    loading: false,
    employeeName: "",
    fileName: "",
    pdfUrl: null,
    isOfficialApproved: false,
    reasons: [],
  });
  const [zipBusy, setZipBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [activeBatch, setActiveBatch] = useState<EmailDispatchBatchRecord | null>(null);
  const cancelRequestedRef = useRef(false);

  const selectedItems = useMemo(
    () =>
      selectedIds
        .map((id) => recipientCache.get(id))
        .filter((x): x is EmailCenterRecipientItem => Boolean(x)),
    [selectedIds, recipientCache],
  );

  const evaluatedRows = useMemo(
    () =>
      selectedItems.map((recipient) => {
        const override = perRecipientOverrides[recipient.recordId];
        const validation = evaluateRelievingRecipientReadiness(
          recipient,
          defaultEmailMode,
          override,
        );
        return { recipient, validation };
      }),
    [selectedItems, defaultEmailMode, perRecipientOverrides],
  );

  const sendableRows = useMemo(
    () => evaluatedRows.filter((r) => r.validation.canSendOfficial),
    [evaluatedRows],
  );

  const officialIssueRows = useMemo(
    () => evaluatedRows.filter((r) => r.validation.canOfficialIssue),
    [evaluatedRows],
  );

  const dedupSummary = useMemo(
    () =>
      deduplicateRecipientDispatches(
        sendableRows.map((r) => ({
          recipientRecordId: r.recipient.recordId,
          resolvedEmail: r.validation.emailResolution.resolvedEmail,
        })),
      ),
    [sendableRows],
  );

  const emailBreakdown = useMemo(() => {
    let personal = 0;
    let work = 0;
    for (const row of sendableRows) {
      if (row.validation.emailResolution.emailMode === "personal") personal++;
      else work++;
    }
    return { personal, work };
  }, [sendableRows]);

  const handlePickerChange = (
    nextIds: string[],
    nextCache: Map<string, EmailCenterRecipientItem>,
  ) => {
    setSelectedIds(nextIds);
    setRecipientCache(nextCache);
    if (nextIds.length === 1) {
      const only = nextCache.get(nextIds[0]!);
      if (only) onSelectSingleEmployee(only);
    }
  };

  const handlePreviewRowPdf = async (recipient: EmailCenterRecipientItem) => {
    setPdfModal((prev) => {
      if (prev.pdfUrl) URL.revokeObjectURL(prev.pdfUrl);
      return {
        open: true,
        loading: true,
        employeeName: recipient.fullName,
        fileName: "",
        pdfUrl: null,
        isOfficialApproved: false,
        reasons: [],
      };
    });

    try {
      const res = await previewIndividualRelievingPdf({
        data: { recipientRecordId: recipient.recordId },
      });
      const bytes = Uint8Array.from(atob(res.pdfBase64), (c) => c.charCodeAt(0));
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      setPdfModal({
        open: true,
        loading: false,
        employeeName: recipient.fullName,
        fileName: res.fileName,
        pdfUrl: blobUrl,
        isOfficialApproved: res.isOfficialApproved,
        reasons: res.validation.reasons,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to render PDF preview.");
      setPdfModal((prev) => ({ ...prev, open: false, loading: false }));
    }
  };

  const handleDownloadRowPdf = async (recipient: EmailCenterRecipientItem) => {
    try {
      const res = await previewIndividualRelievingPdf({
        data: { recipientRecordId: recipient.recordId },
      });
      downloadBase64File(res.pdfBase64, res.fileName, "application/pdf");
      toast.success(
        res.isOfficialApproved
          ? `Downloaded official PDF for ${recipient.fullName}.`
          : `Downloaded DRAFT review PDF for ${recipient.fullName} (unapproved case).`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to download PDF.");
    }
  };

  const handleDownloadApprovedZip = async () => {
    setZipBusy(true);
    try {
      const res = await downloadApprovedRelievingZip({
        data: { recipientRecordIds: selectedIds },
      });
      downloadBase64File(res.zipBase64, res.fileName, "application/zip");
      toast.success(
        `Downloaded ZIP with ${res.includedCount} individualized approved PDF(s)` +
          (res.skipped.length > 0 ? ` (${res.skipped.length} unapproved/incomplete skipped).` : "."),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create approved ZIP archive.");
    } finally {
      setZipBusy(false);
    }
  };

  const handleExcludeInvalid = () => {
    const validIds = sendableRows.map((r) => r.recipient.recordId);
    setSelectedIds(validIds);
    toast.info(`Kept ${validIds.length} verified ready recipient(s).`);
  };

  const handleConfirmBatchDispatch = async () => {
    setConfirmOpen(false);
    setDispatchBusy(true);
    cancelRequestedRef.current = false;

    try {
      const idempotencyKey = `rel-bulk-${crypto.randomUUID()}`;
      const created = await createBulkDispatchBatch({
        data: {
          dispatchKind: "relieving_bulk",
          idempotencyKey,
          recipientRecordIds: sendableRows.map((r) => r.recipient.recordId),
          defaultEmailMode,
          perRecipientEmailOverrides: perRecipientOverrides,
          confirmApproved: true,
        },
      });

      let batch = created.batch;
      setActiveBatch(batch);
      onBatchUpdated?.(batch);

      // Process bounded chunks sequentially through Hostinger SMTP
      while (batch.queuedCount > 0 && !cancelRequestedRef.current) {
        const chunkRes = await processBulkDispatchChunk({
          data: { batchId: batch.id, chunkSize: 10 },
        });
        batch = chunkRes.batch;
        setActiveBatch(batch);
        onBatchUpdated?.(batch);
      }

      if (cancelRequestedRef.current && batch.queuedCount > 0) {
        const canceled = await cancelQueuedBatchItems({ data: { batchId: batch.id } });
        setActiveBatch(canceled.batch);
        onBatchUpdated?.(canceled.batch);
        toast.info("Remaining unsent relieving emails were canceled.");
      } else {
        toast.success(
          `Batch finished: ${batch.acceptedCount} accepted by Hostinger SMTP, ${batch.failedCount} failed.`,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk relieving dispatch failed.");
    } finally {
      setDispatchBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <RecordsRecipientPicker
        context="relieving"
        selectedIds={selectedIds}
        recipientCache={recipientCache}
        onChangeSelection={handlePickerChange}
        defaultEmailMode={defaultEmailMode}
        onChangeEmailMode={setDefaultEmailMode}
        showRelievingColumns={true}
        canViewPersonalEmails={canViewPersonalEmails}
      />

      {/* Selected Employees Bulk Review & Validation Table */}
      {evaluatedRows.length > 0 ? (
        <Card className="border-primary/30">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-sm flex items-center gap-2">
                  <CheckCircle2 className="size-4 text-primary" />
                  Selected Employees Review ({evaluatedRows.length})
                </CardTitle>
                <CardDescription className="text-xs">
                  Each employee receives their own separate individualized{" "}
                  <strong>Macharla Chantii.docx</strong> PDF. Selecting employees never auto-relieves them.
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {evaluatedRows.length > sendableRows.length ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handleExcludeInvalid}
                    disabled={dispatchBusy}
                  >
                    <Filter className="mr-1.5 size-3.5" />
                    Exclude Invalid ({evaluatedRows.length - sendableRows.length})
                  </Button>
                ) : null}
                {canSendEmails ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={zipBusy || officialIssueRows.length === 0 || dispatchBusy}
                    onClick={() => void handleDownloadApprovedZip()}
                  >
                    <Archive className="mr-1.5 size-3.5" />
                    {zipBusy
                      ? "Packaging ZIP..."
                      : `Download Approved ZIP (${officialIssueRows.length})`}
                  </Button>
                ) : null}
                {canSendEmails ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={
                      !providerConfigured ||
                      dispatchBusy ||
                      dedupSummary.uniqueItems.length === 0
                    }
                    onClick={() => setConfirmOpen(true)}
                  >
                    <Send className="mr-1.5 size-3.5" />
                    Send Approved ({dedupSummary.uniqueItems.length})
                  </Button>
                ) : null}
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-3">
            {/* Active Batch Progress Bar */}
            {activeBatch ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  {dispatchBusy ? <Loader2 className="size-3.5 animate-spin text-primary" /> : null}
                  <span>
                    <strong>Batch Status:</strong>{" "}
                    <span className="capitalize">{activeBatch.status.replace(/_/g, " ")}</span> •{" "}
                    Accepted by SMTP: <strong>{activeBatch.acceptedCount}</strong> • Queued:{" "}
                    <strong>{activeBatch.queuedCount}</strong> • Failed:{" "}
                    <strong className="text-destructive">{activeBatch.failedCount}</strong>
                  </span>
                </div>
                {dispatchBusy && activeBatch.queuedCount > 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    className="h-7 text-[11px]"
                    onClick={() => {
                      cancelRequestedRef.current = true;
                    }}
                  >
                    Stop &amp; Cancel Unsent
                  </Button>
                ) : null}
              </div>
            ) : null}

            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-[11px] text-muted-foreground">
                    <th className="px-2.5 py-2 font-medium">Employee</th>
                    <th className="px-2.5 py-2 font-medium">Employee ID</th>
                    <th className="px-2.5 py-2 font-medium">Relieving Date</th>
                    <th className="px-2.5 py-2 font-medium">PDF Preview</th>
                    <th className="px-2.5 py-2 font-medium">Recipient Email</th>
                    <th className="px-2.5 py-2 font-medium">Validation</th>
                    <th className="px-2.5 py-2 font-medium">Delivery Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {evaluatedRows.map(({ recipient, validation }) => {
                    const effectiveMode =
                      perRecipientOverrides[recipient.recordId] ?? defaultEmailMode;
                    return (
                      <tr key={recipient.recordId} className="align-top">
                        <td className="px-2.5 py-2">
                          <div className="font-medium text-foreground">{recipient.fullName}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {recipient.designation || "—"}
                          </div>
                        </td>
                        <td className="px-2.5 py-2 font-mono text-[11px]">
                          {recipient.employeeCode ?? recipient.historicalRecordId}
                        </td>
                        <td className="px-2.5 py-2 font-mono text-[11px]">
                          {recipient.relievingEffectiveDate
                            ? formatLetterDate(recipient.relievingEffectiveDate)
                            : "—"}
                        </td>
                        <td className="px-2.5 py-2">
                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-[11px]"
                              disabled={!validation.canPreviewDraft}
                              onClick={() => void handlePreviewRowPdf(recipient)}
                            >
                              <Eye className="mr-1 size-3" />
                              Preview
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-[11px]"
                              disabled={!validation.canPreviewDraft}
                              onClick={() => void handleDownloadRowPdf(recipient)}
                              title="Download individual PDF"
                            >
                              <Download className="size-3" />
                            </Button>
                          </div>
                        </td>
                        <td className="px-2.5 py-2">
                          <div className="flex items-center gap-1.5">
                            <select
                              aria-label={`Email mode for ${recipient.fullName}`}
                              value={effectiveMode}
                              onChange={(e) =>
                                setPerRecipientOverrides((prev) => ({
                                  ...prev,
                                  [recipient.recordId]: e.target.value as RecipientEmailMode,
                                }))
                              }
                              className="h-7 rounded border border-input bg-background px-1.5 text-[11px]"
                            >
                              <option value="personal">Personal</option>
                              <option value="work">Work</option>
                            </select>
                            <span className="truncate font-mono text-[11px]">
                              {validation.emailResolution.resolvedEmail ? (
                                canViewPersonalEmails || effectiveMode === "work" ? (
                                  validation.emailResolution.resolvedEmail
                                ) : (
                                  "Verified Personal Email"
                                )
                              ) : (
                                <span className="text-destructive">
                                  {validation.emailResolution.statusLabel}
                                </span>
                              )}
                            </span>
                          </div>
                          {validation.emailResolution.warning ? (
                            <p className="mt-1 flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-300">
                              <AlertTriangle className="size-3 shrink-0" />
                              {validation.emailResolution.warning}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-2.5 py-2">
                          <Badge
                            variant={validationBadgeVariant(validation.status)}
                            className="text-[10px]"
                          >
                            {validation.statusLabel}
                          </Badge>
                          {validation.reasons.length > 0 ? (
                            <p className="mt-1 max-w-[210px] text-[10px] text-muted-foreground">
                              {validation.reasons[0]}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-2.5 py-2">
                          <Badge variant="outline" className="text-[10px]">
                            {recipient.relievingCase?.emailStatus ?? "not_sent"}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Individual Relieving PDF Modal */}
      <Dialog
        open={pdfModal.open}
        onOpenChange={(open) => {
          if (!open) {
            if (pdfModal.pdfUrl) URL.revokeObjectURL(pdfModal.pdfUrl);
            setPdfModal((prev) => ({ ...prev, open: false, pdfUrl: null }));
          }
        }}
      >
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              Individual Letter Preview — {pdfModal.employeeName}
            </DialogTitle>
            <DialogDescription>
              {pdfModal.isOfficialApproved ? (
                <span className="text-emerald-700 dark:text-emerald-300">
                  Official Approved Letter ({pdfModal.fileName}) — ready for authorized issuance.
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
                  <ShieldAlert className="size-4 shrink-0" />
                  Draft Preview Only — official issuance blocked:{" "}
                  {pdfModal.reasons[0] ?? "Relieving approval pending."}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          {pdfModal.loading ? (
            <div className="flex h-[540px] items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="mr-2 size-5 animate-spin text-primary" />
              Rendering individualized Macharla Chantii.docx PDF...
            </div>
          ) : pdfModal.pdfUrl ? (
            <iframe
              src={`${pdfModal.pdfUrl}#toolbar=1&navpanes=0`}
              title={`Preview for ${pdfModal.employeeName}`}
              className="h-[580px] w-full rounded border border-border bg-white"
            />
          ) : (
            <div className="flex h-40 items-center justify-center text-xs text-destructive">
              <XCircle className="mr-1.5 size-4" /> Preview failed to load.
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Explicit Bulk Confirmation Dialog */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Dispatch {dedupSummary.uniqueItems.length} Individual Approved Relieving Letter(s)?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-xs">
                <p>
                  Each approved employee will receive an individual email from{" "}
                  <code>The AI School HR &lt;hr@theaischool.co&gt;</code> with{" "}
                  <strong>only their own</strong> approved Experience &amp; Relieving Letter PDF attached. No CC list is ever exposed.
                </p>
                <ul className="list-disc pl-4 space-y-1">
                  <li>
                    <strong>Ready &amp; unique recipients:</strong> {dedupSummary.uniqueItems.length}
                  </li>
                  <li>
                    <strong>Email breakdown:</strong> {emailBreakdown.personal} Personal •{" "}
                    {emailBreakdown.work} Work
                  </li>
                  <li>
                    <strong>Skipped (unapproved / invalid / duplicate email):</strong>{" "}
                    {evaluatedRows.length - dedupSummary.uniqueItems.length}
                  </li>
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dispatchBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={dispatchBusy}
              onClick={() => void handleConfirmBatchDispatch()}
            >
              Confirm &amp; Queue Dispatch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
