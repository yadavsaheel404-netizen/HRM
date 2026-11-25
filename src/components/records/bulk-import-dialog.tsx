import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { downloadCsv, toCsv } from "@/lib/csv";
import { describeUnknownError } from "@/lib/describe-error";
import {
  commitEmployeeRecordsImport,
  previewEmployeeRecordsImport,
} from "@/lib/records.functions";
import {
  CONSOLIDATED_EXCEL_HEADERS,
  detectSourceColumnMapping,
} from "@/lib/records/matcher";
import {
  RECORD_CATEGORY_LABELS,
  RECORD_EMPLOYMENT_CATEGORIES,
  RECORD_WORK_TYPES,
  RECORD_WORK_TYPE_LABELS,
  type ImportPreviewRow,
  type ImportPreviewSummary,
  type MissingWorkforceEntry,
  type RecordEmploymentCategory,
  type RecordWorkType,
  type SourceColumnMapping,
} from "@/lib/records/types";

type Step = "upload" | "mapping" | "preview" | "confirm" | "result";
type PreviewFilter =
  | "all"
  | "ready"
  | "matched_workforce"
  | "new_historical"
  | "possible_duplicate"
  | "needs_information"
  | "invalid"
  | "missing_workforce";

export function BulkImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [fileType, setFileType] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, string | number | null>[]>([]);
  const [date1904, setDate1904] = useState(false);
  const [numericPreference, setNumericPreference] = useState<"auto" | "mdy" | "dmy">("auto");
  const [mapping, setMapping] = useState<SourceColumnMapping>({
    firstName: null,
    lastName: null,
    phoneNumber: null,
    joiningDate: null,
    lastWorkingDate: null,
    personalEmail: null,
    organizationEmail: null,
  });

  const [previewRows, setPreviewRows] = useState<ImportPreviewRow[]>([]);
  const [summary, setSummary] = useState<ImportPreviewSummary | null>(null);
  const [missingWorkforce, setMissingWorkforce] = useState<MissingWorkforceEntry[]>([]);
  const [overridesByRow, setOverridesByRow] = useState<Record<number, Partial<ImportPreviewRow>>>({});
  const [previewFilter, setPreviewFilter] = useState<PreviewFilter>("all");
  const [syncMissingWorkforce, setSyncMissingWorkforce] = useState(true);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [batchKey, setBatchKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [editingRowNumber, setEditingRowNumber] = useState<number | null>(null);

  // Bulk apply controls
  const [bulkWorkType, setBulkWorkType] = useState<RecordWorkType | "">("");
  const [bulkCategory, setBulkCategory] = useState<RecordEmploymentCategory | "">("");
  const [bulkStatus, setBulkStatus] = useState<"active" | "inactive" | "">("");

  const [commitResult, setCommitResult] = useState<{
    replayed: boolean;
    batchId: string;
    batchKey: string;
    matchedWorkforceCount: number;
    newHistoricalCount: number;
    updatedCount: number;
    skippedCount: number;
    needsReviewCount: number;
    errorCount: number;
    workforceSyncedCount: number;
  } | null>(null);

  function resetAll() {
    setStep("upload");
    setFileName("");
    setFileType("");
    setHeaders([]);
    setRawRows([]);
    setDate1904(false);
    setNumericPreference("auto");
    setPreviewRows([]);
    setSummary(null);
    setMissingWorkforce([]);
    setOverridesByRow({});
    setPreviewFilter("all");
    setConfirmChecked(false);
    setBatchKey("");
    setCommitResult(null);
    setEditingRowNumber(null);
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setLoading(true);
      const XLSX = (await import("xlsx")).default ?? (await import("xlsx"));
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array", raw: true, cellDates: false });
      const firstSheetName = wb.SheetNames[0];
      if (!firstSheetName) {
        toast.error("No worksheet found inside this workbook.");
        return;
      }
      const ws = wb.Sheets[firstSheetName]!;
      const grid = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, {
        header: 1,
        defval: "",
        raw: true,
      });

      if (grid.length < 2) {
        toast.error("The uploaded file must contain a header row and at least 1 data row.");
        return;
      }

      const headerRow = (grid[0] ?? []).map((c) => String(c ?? "").trim());
      const nonEmptyRows = grid
        .slice(1)
        .filter((r) => (r ?? []).some((c) => String(c ?? "").trim() !== ""));

      if (nonEmptyRows.length > 1000) {
        toast.error(`File has ${nonEmptyRows.length} rows. Split into batches of up to 1,000 rows.`);
        return;
      }

      const parsedObjects: Record<string, string | number | null>[] = nonEmptyRows.map((row) => {
        const obj: Record<string, string | number | null> = {};
        headerRow.forEach((h, i) => {
          if (!h) return;
          const val = row[i];
          obj[h] = val === undefined ? null : val;
        });
        return obj;
      });

      const wbProps = (wb.Workbook as { WBProps?: { date1904?: boolean } } | undefined)?.WBProps;
      setDate1904(Boolean(wbProps?.date1904));
      setFileName(file.name);
      setFileType(file.name.split(".").pop()?.toLowerCase() ?? "xlsx");
      setHeaders(headerRow.filter(Boolean));
      setRawRows(parsedObjects);
      setMapping(detectSourceColumnMapping(headerRow));
      setOverridesByRow({});
      setBatchKey(`rec_imp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
      setStep("mapping");
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setLoading(false);
    }
  }

  async function runPreview(nextOverrides?: Record<number, Partial<ImportPreviewRow>>) {
    if (!mapping.firstName) {
      toast.error("Map at least the First Name column before previewing.");
      return;
    }
    try {
      setLoading(true);
      const ov = nextOverrides ?? overridesByRow;
      const res = await previewEmployeeRecordsImport({
        data: {
          rows: rawRows,
          mapping,
          date1904,
          numericPreference,
          overridesByRow: ov,
        },
      });
      setPreviewRows(res.rows);
      setSummary(res.summary);
      setMissingWorkforce(res.missingWorkforceProfiles);
      setStep("preview");
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setLoading(false);
    }
  }

  function updateRowOverride(rowNumber: number, patch: Partial<ImportPreviewRow>) {
    setOverridesByRow((prev) => ({
      ...prev,
      [rowNumber]: { ...(prev[rowNumber] ?? {}), ...patch },
    }));
  }

  async function applyBulkDefaults() {
    if (!bulkWorkType && !bulkCategory && !bulkStatus) {
      toast.error("Choose a Work Type, Category, or Status to bulk apply.");
      return;
    }
    const nextOverrides = { ...overridesByRow };
    for (const r of previewRows) {
      if (r.excluded) continue;
      const patch: Partial<ImportPreviewRow> = { ...(nextOverrides[r.rowNumber] ?? {}) };
      if (bulkWorkType && r.workType === "unknown") patch.workType = bulkWorkType;
      if (bulkCategory && r.employmentCategory === "unknown") patch.employmentCategory = bulkCategory;
      if (bulkStatus) patch.employmentStatus = bulkStatus;
      nextOverrides[r.rowNumber] = patch;
    }
    setOverridesByRow(nextOverrides);
    await runPreview(nextOverrides);
    toast.success("Bulk values applied and preview revalidated.");
  }

  async function handleCommitImport() {
    if (!confirmChecked) {
      toast.error("Please confirm the dry-run summary before importing.");
      return;
    }
    try {
      setLoading(true);
      const res = await commitEmployeeRecordsImport({
        data: {
          batchKey,
          fileName,
          fileType,
          rows: previewRows,
          syncMissingWorkforce,
          confirmed: true,
        },
      });
      setCommitResult(res);
      setStep("result");
      toast.success("Employee Records import batch completed.");
      onImported();
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setLoading(false);
    }
  }

  function downloadTemplate() {
    const csv = toCsv(
      [
        {
          "First Name": "Vattikonda",
          "Last Name": "Sreeja",
          "Phone Number": "+91 9876543210",
          DOJ: "2026-07-02",
          LWD: "2026-10-30",
          "E-Mail ID": "sreeja.personal@gmail.com",
          "TAS Mail": "sreeja@theaischool.co",
        },
      ],
      CONSOLIDATED_EXCEL_HEADERS.map((h) => ({
        key: h,
        header: h,
        value: (r: Record<string, string>) => r[h] ?? "",
      })),
    );
    downloadCsv("employee_records_import_template.csv", csv);
  }

  const filteredPreviewRows = previewRows.filter((r) => {
    if (previewFilter === "all") return true;
    if (previewFilter === "ready") return r.readyToImport;
    if (previewFilter === "matched_workforce") return r.category === "matched_workforce";
    if (previewFilter === "new_historical") return r.category === "new_historical" || r.category === "existing_historical";
    if (previewFilter === "possible_duplicate") return r.category === "possible_duplicate";
    if (previewFilter === "needs_information") return r.category === "needs_information";
    if (previewFilter === "invalid") return r.category === "invalid";
    return true;
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetAll();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-6xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <FileSpreadsheet className="size-4 text-red-600" />
            Import Employee Records (Bulk Historical Register)
          </DialogTitle>
          <DialogDescription className="text-xs">
            Supports up to 1,000 rows per upload (.xlsx / .csv). Zero database writes occur during preview. Never creates Auth accounts or sends setup emails.
          </DialogDescription>
        </DialogHeader>

        {/* STEP 1: UPLOAD */}
        {step === "upload" && (
          <div className="space-y-4 py-2">
            <div className="rounded-lg border-2 border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center space-y-3 bg-muted/20">
              <Upload className="size-8 mx-auto text-red-600" />
              <div className="space-y-1">
                <p className="text-sm font-semibold">Upload Consolidated IC&apos;s DB.xlsx or CSV</p>
                <p className="text-xs text-muted-foreground">
                  Expected source columns: First Name, Last Name, Phone Number, DOJ, LWD, E-Mail ID, TAS Mail
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2 pt-2">
                <label className="cursor-pointer inline-flex items-center gap-2 rounded-md bg-zinc-900 hover:bg-zinc-800 text-white px-4 py-2 text-xs font-medium">
                  <Upload className="size-3.5" />
                  {loading ? "Reading Workbook..." : "Select Excel / CSV File"}
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                </label>
                <Button type="button" variant="outline" size="sm" onClick={downloadTemplate}>
                  <Download className="mr-1.5 size-3.5" /> Download Source Template
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* STEP 2: COLUMN MAPPING & DATE NORMALIZATION */}
        {step === "mapping" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded border p-3 bg-muted/20 text-xs">
              <div>
                <strong>{fileName}</strong> — {rawRows.length} data row(s) detected • Epoch:{" "}
                <Badge variant="outline" className="text-[10px]">
                  {date1904 ? "Excel 1904 System" : "Excel 1900 System"}
                </Badge>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep("upload")}>
                Change File
              </Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {(
                [
                  ["firstName", "First Name *"],
                  ["lastName", "Last Name"],
                  ["phoneNumber", "Phone Number"],
                  ["joiningDate", "DOJ (Joining Date)"],
                  ["lastWorkingDate", "LWD (Last Working Date)"],
                  ["personalEmail", "E-Mail ID (Personal)"],
                  ["organizationEmail", "TAS Mail (Org Email)"],
                  ["department", "Department (Optional)"],
                  ["designation", "Designation (Optional)"],
                  ["employmentCategory", "Category (Optional)"],
                  ["workType", "Work Type (Optional)"],
                  ["driveFolderUrl", "Drive Folder URL (Optional)"],
                ] as const
              ).map(([field, label]) => (
                <div key={field} className="space-y-1">
                  <Label className="text-[11px]">{label}</Label>
                  <select
                    value={(mapping[field] ?? "") as string}
                    onChange={(e) =>
                      setMapping((prev) => ({
                        ...prev,
                        [field]: e.target.value || null,
                      }))
                    }
                    className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="">— Not Mapped —</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <Card className="p-3 space-y-2">
              <Label className="text-xs font-semibold">Mixed Date Parsing Policy</Label>
              <div className="flex flex-wrap gap-4 text-xs">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    checked={numericPreference === "auto"}
                    onChange={() => setNumericPreference("auto")}
                  />
                  Auto-flag ambiguous MM/DD vs DD/MM dates as &ldquo;Needs Review&rdquo; (Recommended)
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    checked={numericPreference === "mdy"}
                    onChange={() => setNumericPreference("mdy")}
                  />
                  Prefer MM-DD-YYYY
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    checked={numericPreference === "dmy"}
                    onChange={() => setNumericPreference("dmy")}
                  />
                  Prefer DD-MM-YYYY
                </label>
              </div>
            </Card>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setStep("upload")}>
                Back
              </Button>
              <Button
                type="button"
                disabled={loading}
                onClick={() => runPreview()}
                className="bg-zinc-900 hover:bg-zinc-800 text-white"
              >
                {loading ? "Matching against Workforce..." : "Preview & Match Workforce"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* STEP 3: PREVIEW WITH INLINE CORRECTIONS */}
        {step === "preview" && summary && (
          <div className="space-y-4">
            {/* Summary Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs">
              <button
                type="button"
                onClick={() => setPreviewFilter("matched_workforce")}
                className={`rounded border p-2.5 text-left transition ${previewFilter === "matched_workforce" ? "border-emerald-600 bg-emerald-50/50" : "hover:bg-muted/40"}`}
              >
                <div className="text-lg font-bold text-emerald-700">{summary.matchedWorkforceCount}</div>
                <div className="text-[11px] text-muted-foreground">Matched Workforce</div>
              </button>
              <button
                type="button"
                onClick={() => setPreviewFilter("new_historical")}
                className={`rounded border p-2.5 text-left transition ${previewFilter === "new_historical" ? "border-zinc-900 bg-zinc-50" : "hover:bg-muted/40"}`}
              >
                <div className="text-lg font-bold">{summary.newHistoricalCount + summary.existingHistoricalCount}</div>
                <div className="text-[11px] text-muted-foreground">Historical Records</div>
              </button>
              <button
                type="button"
                onClick={() => setPreviewFilter("missing_workforce")}
                className={`rounded border p-2.5 text-left transition ${previewFilter === "missing_workforce" ? "border-blue-600 bg-blue-50/50" : "hover:bg-muted/40"}`}
              >
                <div className="text-lg font-bold text-blue-700">{summary.missingWorkforceCount}</div>
                <div className="text-[11px] text-muted-foreground">Missing Workforce</div>
              </button>
              <button
                type="button"
                onClick={() => setPreviewFilter("possible_duplicate")}
                className={`rounded border p-2.5 text-left transition ${previewFilter === "possible_duplicate" ? "border-amber-600 bg-amber-50/50" : "hover:bg-muted/40"}`}
              >
                <div className="text-lg font-bold text-amber-700">{summary.possibleDuplicatesCount}</div>
                <div className="text-[11px] text-muted-foreground">Possible Duplicates</div>
              </button>
              <button
                type="button"
                onClick={() => setPreviewFilter("needs_information")}
                className={`rounded border p-2.5 text-left transition ${previewFilter === "needs_information" ? "border-red-600 bg-red-50/50" : "hover:bg-muted/40"}`}
              >
                <div className="text-lg font-bold text-red-700">{summary.needsInformationCount + summary.invalidCount}</div>
                <div className="text-[11px] text-muted-foreground">Needs Review / Invalid</div>
              </button>
              <button
                type="button"
                onClick={() => setPreviewFilter("ready")}
                className={`rounded border p-2.5 text-left transition ${previewFilter === "ready" ? "border-zinc-900 bg-zinc-100" : "hover:bg-muted/40"}`}
              >
                <div className="text-lg font-bold">{summary.readyToImportCount}</div>
                <div className="text-[11px] text-muted-foreground">Ready to Import</div>
              </button>
            </div>

            {/* Bulk Apply & Filter Bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded border bg-muted/20 p-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">Bulk Fill Blank Rows:</span>
                <select
                  value={bulkCategory}
                  onChange={(e) => setBulkCategory(e.target.value as RecordEmploymentCategory | "")}
                  className="h-7 rounded border border-input bg-background px-2 text-xs"
                >
                  <option value="">Category...</option>
                  {RECORD_EMPLOYMENT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{RECORD_CATEGORY_LABELS[c]}</option>
                  ))}
                </select>
                <select
                  value={bulkWorkType}
                  onChange={(e) => setBulkWorkType(e.target.value as RecordWorkType | "")}
                  className="h-7 rounded border border-input bg-background px-2 text-xs"
                >
                  <option value="">Work Type...</option>
                  {RECORD_WORK_TYPES.map((w) => (
                    <option key={w} value={w}>{RECORD_WORK_TYPE_LABELS[w]}</option>
                  ))}
                </select>
                <select
                  value={bulkStatus}
                  onChange={(e) => setBulkStatus(e.target.value as "active" | "inactive" | "")}
                  className="h-7 rounded border border-input bg-background px-2 text-xs"
                >
                  <option value="">Status...</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
                <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={applyBulkDefaults}>
                  Apply to Rows
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={previewFilter === "all" ? "default" : "outline"}
                  className="h-7 text-xs"
                  onClick={() => setPreviewFilter("all")}
                >
                  Show All ({summary.totalRows})
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => runPreview()}
                  disabled={loading}
                >
                  <RefreshCw className={`mr-1 size-3 ${loading ? "animate-spin" : ""}`} /> Revalidate
                </Button>
              </div>
            </div>

            {/* Missing Workforce View vs Source Rows Table */}
            {previewFilter === "missing_workforce" ? (
              <div className="border rounded overflow-x-auto max-h-[360px]">
                <table className="w-full text-xs text-left">
                  <thead className="bg-muted/60 border-b sticky top-0">
                    <tr>
                      <th className="p-2">Workforce Employee</th>
                      <th className="p-2">TAS ID</th>
                      <th className="p-2">Work Email</th>
                      <th className="p-2">Category / Work Type</th>
                      <th className="p-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {missingWorkforce.map((w) => (
                      <tr key={w.profileId}>
                        <td className="p-2 font-medium">{w.fullName}</td>
                        <td className="p-2 font-mono">{w.tasEmployeeCode || "—"}</td>
                        <td className="p-2">{w.workEmail}</td>
                        <td className="p-2">
                          {w.category} / {w.workType || "unclassified"}
                        </td>
                        <td className="p-2 uppercase">{w.employmentStatus}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="border rounded overflow-x-auto max-h-[380px]">
                <table className="w-full text-xs text-left">
                  <thead className="bg-muted/60 border-b sticky top-0 z-10">
                    <tr>
                      <th className="p-2">Row</th>
                      <th className="p-2">Name &amp; Contact</th>
                      <th className="p-2">DOJ / LWD</th>
                      <th className="p-2">Classification</th>
                      <th className="p-2">Workforce Match / Resolution</th>
                      <th className="p-2 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {filteredPreviewRows.map((row) => {
                      const isEditing = editingRowNumber === row.rowNumber;
                      return (
                        <tr
                          key={row.rowNumber}
                          className={row.excluded ? "opacity-50 bg-muted/20" : ""}
                        >
                          <td className="p-2 font-mono align-top">#{row.rowNumber}</td>
                          <td className="p-2 align-top space-y-1">
                            {isEditing ? (
                              <div className="space-y-1">
                                <Input
                                  className="h-7 text-xs"
                                  defaultValue={row.firstName}
                                  placeholder="First Name"
                                  onBlur={(e) =>
                                    updateRowOverride(row.rowNumber, { firstName: e.target.value })
                                  }
                                />
                                <Input
                                  className="h-7 text-xs"
                                  defaultValue={row.lastName ?? ""}
                                  placeholder="Last Name"
                                  onBlur={(e) =>
                                    updateRowOverride(row.rowNumber, { lastName: e.target.value || null })
                                  }
                                />
                                <Input
                                  className="h-7 text-xs"
                                  defaultValue={row.organizationEmail ?? ""}
                                  placeholder="TAS Mail"
                                  onBlur={(e) =>
                                    updateRowOverride(row.rowNumber, { organizationEmail: e.target.value || null })
                                  }
                                />
                                <Input
                                  className="h-7 text-xs"
                                  defaultValue={row.personalEmail ?? ""}
                                  placeholder="Personal Email"
                                  onBlur={(e) =>
                                    updateRowOverride(row.rowNumber, { personalEmail: e.target.value || null })
                                  }
                                />
                              </div>
                            ) : (
                              <>
                                <div className="font-semibold">{row.displayName || "(Missing Name)"}</div>
                                <div className="text-[11px] text-muted-foreground">
                                  {row.organizationEmail || "No TAS Mail"} • {row.personalEmail || "No Personal Email"}
                                </div>
                                {row.phoneNumber && (
                                  <div className="text-[11px] text-muted-foreground">{row.phoneNumber}</div>
                                )}
                              </>
                            )}
                          </td>
                          <td className="p-2 align-top space-y-1">
                            {isEditing ? (
                              <div className="space-y-1">
                                <Input
                                  type="date"
                                  className="h-7 text-xs"
                                  defaultValue={row.joiningDate ?? ""}
                                  onChange={(e) =>
                                    updateRowOverride(row.rowNumber, { joiningDate: e.target.value || null })
                                  }
                                />
                                <Input
                                  type="date"
                                  className="h-7 text-xs"
                                  defaultValue={row.lastWorkingDate ?? ""}
                                  onChange={(e) =>
                                    updateRowOverride(row.rowNumber, { lastWorkingDate: e.target.value || null })
                                  }
                                />
                              </div>
                            ) : (
                              <>
                                <div>
                                  DOJ:{" "}
                                  <span className={row.joiningDateStatus === "needs_review" ? "text-red-600 font-semibold" : ""}>
                                    {row.joiningDate || (row.joiningDateRaw ? `Needs Review (${row.joiningDateRaw})` : "—")}
                                  </span>
                                </div>
                                <div>
                                  LWD:{" "}
                                  <span className={row.lastWorkingDateStatus === "needs_review" ? "text-red-600 font-semibold" : ""}>
                                    {row.lastWorkingDate || (row.lastWorkingDateRaw ? `Needs Review (${row.lastWorkingDateRaw})` : "—")}
                                  </span>
                                </div>
                              </>
                            )}
                          </td>
                          <td className="p-2 align-top space-y-1">
                            <Badge variant="outline" className="text-[10px] uppercase">
                              {row.employmentStatus}
                            </Badge>
                            {row.statusNeedsReview && (
                              <Badge className="bg-amber-100 text-amber-800 text-[10px] ml-1">
                                Status Review
                              </Badge>
                            )}
                            <div className="text-[11px] text-muted-foreground">
                              {RECORD_CATEGORY_LABELS[row.employmentCategory]} / {RECORD_WORK_TYPE_LABELS[row.workType]}
                            </div>
                          </td>
                          <td className="p-2 align-top space-y-1">
                            {row.category === "matched_workforce" && (
                              <Badge className="bg-emerald-600 text-white text-[10px]">
                                Linked: {row.matchedTasCode || "Workforce"}
                              </Badge>
                            )}
                            {row.category === "new_historical" && (
                              <Badge variant="outline" className="text-[10px]">
                                New Historical (No Auth)
                              </Badge>
                            )}
                            {row.category === "possible_duplicate" && (
                              <div className="space-y-1">
                                <Badge className="bg-amber-500 text-white text-[10px]">
                                  Needs Manual Review
                                </Badge>
                                {row.candidates.length > 0 && (
                                  <select
                                    className="block w-full h-7 rounded border border-amber-300 bg-background px-1 text-[11px]"
                                    value={row.matchedProfileId ?? row.matchedRecordId ?? ""}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      const cand = row.candidates.find(
                                        (c) => (c.profileId ?? c.recordId) === val,
                                      );
                                      if (cand) {
                                        updateRowOverride(row.rowNumber, {
                                          matchedProfileId: cand.profileId,
                                          matchedRecordId: cand.recordId,
                                        });
                                        void runPreview({
                                          ...overridesByRow,
                                          [row.rowNumber]: {
                                            ...(overridesByRow[row.rowNumber] ?? {}),
                                            matchedProfileId: cand.profileId,
                                            matchedRecordId: cand.recordId,
                                          },
                                        });
                                      }
                                    }}
                                  >
                                    <option value="">Resolve candidate match...</option>
                                    {row.candidates.map((c, idx) => (
                                      <option key={idx} value={c.profileId ?? c.recordId ?? ""}>
                                        Link to {c.displayName} ({c.tasEmployeeCode ?? c.historicalRecordCode}) — {c.matchSignal}
                                      </option>
                                    ))}
                                  </select>
                                )}
                              </div>
                            )}
                            {row.errors.map((err, i) => (
                              <div key={i} className="text-[11px] text-red-600">{err}</div>
                            ))}
                            {row.warnings.slice(0, 2).map((w, i) => (
                              <div key={i} className="text-[11px] text-amber-700">{w}</div>
                            ))}
                          </td>
                          <td className="p-2 text-right align-top space-x-1 whitespace-nowrap">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              onClick={() => {
                                if (isEditing) {
                                  setEditingRowNumber(null);
                                  void runPreview();
                                } else {
                                  setEditingRowNumber(row.rowNumber);
                                }
                              }}
                            >
                              {isEditing ? "Apply" : "Edit"}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              onClick={() => {
                                const next = {
                                  ...overridesByRow,
                                  [row.rowNumber]: {
                                    ...(overridesByRow[row.rowNumber] ?? {}),
                                    excluded: !row.excluded,
                                  },
                                };
                                setOverridesByRow(next);
                                void runPreview(next);
                              }}
                              title={row.excluded ? "Restore Row" : "Exclude Row"}
                            >
                              {row.excluded ? (
                                <RotateCcw className="size-3.5 text-emerald-600" />
                              ) : (
                                <Trash2 className="size-3.5 text-red-600" />
                              )}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setStep("mapping")}>
                Back to Mapping
              </Button>
              <Button
                type="button"
                onClick={() => setStep("confirm")}
                disabled={summary.readyToImportCount === 0 && !syncMissingWorkforce}
                className="bg-zinc-900 hover:bg-zinc-800 text-white"
              >
                Continue to Confirmation ({summary.readyToImportCount} Ready)
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* STEP 4: CONFIRMATION DRY-RUN */}
        {step === "confirm" && summary && (
          <div className="space-y-4 py-2">
            <Card className="p-4 space-y-3 border-zinc-300">
              <h4 className="text-sm font-semibold">Dry-Run Safety Verification</h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div className="rounded border p-2.5">
                  <div className="text-lg font-bold text-emerald-700">{summary.matchedWorkforceCount}</div>
                  <div className="text-muted-foreground">Link Existing Workforce</div>
                </div>
                <div className="rounded border p-2.5">
                  <div className="text-lg font-bold">{summary.newHistoricalCount}</div>
                  <div className="text-muted-foreground">New Historical Records</div>
                </div>
                <div className="rounded border p-2.5">
                  <div className="text-lg font-bold text-amber-700">
                    {summary.possibleDuplicatesCount + summary.needsInformationCount + summary.excludedCount}
                  </div>
                  <div className="text-muted-foreground">Skipped / Held for Review</div>
                </div>
                <div className="rounded border p-2.5">
                  <div className="text-lg font-bold text-blue-700">
                    {syncMissingWorkforce ? summary.missingWorkforceCount : 0}
                  </div>
                  <div className="text-muted-foreground">Workforce Sync Records</div>
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs pt-2 cursor-pointer">
                <Checkbox
                  checked={syncMissingWorkforce}
                  onCheckedChange={(v) => setSyncMissingWorkforce(Boolean(v))}
                />
                <span>
                  Also synchronize {summary.missingWorkforceCount} existing Workforce employee(s) not listed in this spreadsheet (`Workforce Sync`)
                </span>
              </label>

              <div className="rounded bg-muted/40 p-3 text-xs space-y-1 text-muted-foreground">
                <p className="font-semibold text-foreground">Safety Guarantees Verified:</p>
                <p>• Zero Supabase Auth login accounts or invitations will be created.</p>
                <p>• Zero emails will be dispatched; zero project allocations will be changed.</p>
                <p>• Historical-only entries receive archival <code className="font-mono">TAS-REC-XXXX</code> IDs (no operational TAS IDs).</p>
                <p>• Unresolved duplicates &amp; ambiguous dates are automatically held out of insertion.</p>
              </div>

              <label className="flex items-center gap-2 text-xs font-semibold pt-1 cursor-pointer text-zinc-900 dark:text-zinc-100">
                <Checkbox
                  checked={confirmChecked}
                  onCheckedChange={(v) => setConfirmChecked(Boolean(v))}
                />
                <span>I have reviewed the dry-run summary and approve committing this batch ({batchKey}).</span>
              </label>
            </Card>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setStep("preview")}>
                Back to Preview
              </Button>
              <Button
                type="button"
                disabled={!confirmChecked || loading}
                onClick={handleCommitImport}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {loading ? "Committing Batch..." : "Commit Approved Records"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* STEP 5: AUDITABLE RESULT */}
        {step === "result" && commitResult && (
          <div className="space-y-4 py-2">
            <Card className="p-4 border-emerald-200 bg-emerald-50/40 space-y-3">
              <div className="flex items-center gap-2 text-emerald-800 font-semibold">
                <CheckCircle2 className="size-5 text-emerald-600" />
                Import Batch Complete {commitResult.replayed ? "(Idempotent Replay)" : ""}
              </div>
              <div className="text-xs text-muted-foreground">
                Batch ID: <code className="font-mono">{commitResult.batchId}</code>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                <div className="rounded bg-background border p-2">
                  Linked Workforce: <strong>{commitResult.matchedWorkforceCount}</strong>
                </div>
                <div className="rounded bg-background border p-2">
                  New Historical: <strong>{commitResult.newHistoricalCount}</strong>
                </div>
                <div className="rounded bg-background border p-2">
                  Updated Historical: <strong>{commitResult.updatedCount}</strong>
                </div>
                <div className="rounded bg-background border p-2">
                  Held for Review: <strong>{commitResult.needsReviewCount}</strong>
                </div>
                <div className="rounded bg-background border p-2">
                  Skipped / Excluded: <strong>{commitResult.skippedCount}</strong>
                </div>
                <div className="rounded bg-background border p-2">
                  Workforce Synced: <strong>{commitResult.workforceSyncedCount}</strong>
                </div>
              </div>
            </Card>

            <DialogFooter>
              <Button
                type="button"
                onClick={() => {
                  resetAll();
                  onOpenChange(false);
                }}
                className="bg-zinc-900 hover:bg-zinc-800 text-white"
              >
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
