import { CheckCircle2, Download, FolderOpen, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { downloadCsv, toCsv } from "@/lib/csv";
import { describeUnknownError } from "@/lib/describe-error";
import {
  commitDriveFolderLinks,
  previewDriveFolderImport,
} from "@/lib/records.functions";
import type {
  DriveFolderMappingRow,
  DriveMappingPreviewRow,
} from "@/lib/records/types";

export function DriveMappingDialog({
  open,
  onOpenChange,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: () => void;
}) {
  const [pasteText, setPasteText] = useState("");
  const [fileName, setFileName] = useState("manual_paste.csv");
  const [previewRows, setPreviewRows] = useState<DriveMappingPreviewRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  function downloadTemplate() {
    const csv = toCsv(
      [
        {
          "Employee Name": "Vattikonda Sreeja",
          "Employee Email": "sreeja@theaischool.co",
          "Historical Record ID": "TAS-REC-0001",
          "Google Drive Folder URL": "https://drive.google.com/drive/folders/1ExampleFolderId12345",
        },
      ],
      [
        { key: "name", header: "Employee Name", value: (r) => r["Employee Name"] },
        { key: "email", header: "Employee Email", value: (r) => r["Employee Email"] },
        { key: "code", header: "Historical Record ID", value: (r) => r["Historical Record ID"] },
        { key: "url", header: "Google Drive Folder URL", value: (r) => r["Google Drive Folder URL"] },
      ],
    );
    downloadCsv("google_drive_folder_mapping_template.csv", csv);
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setLoading(true);
      const XLSX = (await import("xlsx")).default ?? (await import("xlsx"));
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]!]!;
      const jsonRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });

      const mappingRows: DriveFolderMappingRow[] = jsonRows.map((r, i) => ({
        rowNumber: i + 2,
        employeeName: String(r["Employee Name"] ?? r["Name"] ?? "").trim(),
        employeeEmail: String(r["Employee Email"] ?? r["Email"] ?? "").trim() || null,
        historicalRecordCode: String(r["Historical Record ID"] ?? r["Record ID"] ?? "").trim() || null,
        driveFolderUrl: String(r["Google Drive Folder URL"] ?? r["Folder URL"] ?? "").trim(),
      }));

      setFileName(file.name);
      const res = await previewDriveFolderImport({ data: { rows: mappingRows } });
      setPreviewRows(res.rows);
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleParsePaste() {
    const lines = pasteText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      toast.error("Paste at least one CSV/tab-delimited row.");
      return;
    }

    const mappingRows: DriveFolderMappingRow[] = lines
      .filter((l) => !/^employee name/i.test(l))
      .map((line, idx) => {
        const parts = line.includes("\t") ? line.split("\t") : line.split(",");
        return {
          rowNumber: idx + 1,
          employeeName: (parts[0] ?? "").trim(),
          employeeEmail: (parts[1] ?? "").trim() || null,
          historicalRecordCode: (parts[2] ?? "").trim() || null,
          driveFolderUrl: (parts[3] ?? parts[1] ?? "").trim(),
        };
      });

    try {
      setLoading(true);
      setFileName("pasted_drive_links.csv");
      const res = await previewDriveFolderImport({ data: { rows: mappingRows } });
      setPreviewRows(res.rows);
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleCommit() {
    if (!previewRows) return;
    try {
      setLoading(true);
      const res = await commitDriveFolderLinks({
        data: {
          batchKey: `drv_${Date.now()}`,
          fileName,
          rows: previewRows,
        },
      });
      toast.success(`Linked ${res.linkedCount} Drive folder(s) (${res.skippedCount} skipped/unconfirmed).`);
      setPreviewRows(null);
      setPasteText("");
      onOpenChange(false);
      onCompleted();
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setPreviewRows(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <FolderOpen className="size-4 text-red-600" />
            Controlled Google Drive Folder-Link Mapping (TAS &lt;&gt; EMP &lt;&gt; RECORD)
          </DialogTitle>
          <DialogDescription className="text-xs">
            Store main employee Google Drive folder URLs against matching Records entries. Ambiguous names always require HR confirmation. Drive permissions are never modified.
          </DialogDescription>
        </DialogHeader>

        {!previewRows ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded border p-3 bg-muted/20">
              <div className="text-xs space-y-0.5">
                <div className="font-semibold">Upload Mapping CSV / XLSX</div>
                <div className="text-muted-foreground">
                  Columns: Employee Name, Employee Email, Historical Record ID, Google Drive Folder URL
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={downloadTemplate}>
                  <Download className="mr-1.5 size-3.5" /> CSV Template
                </Button>
                <label className="cursor-pointer inline-flex items-center gap-1.5 rounded-md bg-zinc-900 text-white px-3 py-1.5 text-xs font-medium">
                  <Upload className="size-3.5" /> Upload Sheet
                  <input
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-xs font-medium">Or Paste Mapping Rows (CSV or Tab-separated)</div>
              <Textarea
                rows={5}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="Vattikonda Sreeja, sreeja@theaischool.co, TAS-REC-0001, https://drive.google.com/drive/folders/..."
                className="font-mono text-xs"
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={loading || !pasteText.trim()} onClick={handleParsePaste}>
                Preview Folder Matches
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="border rounded overflow-x-auto max-h-[380px]">
              <table className="w-full text-xs text-left">
                <thead className="bg-muted/60 border-b sticky top-0">
                  <tr>
                    <th className="p-2">Approve</th>
                    <th className="p-2">Source Folder Name</th>
                    <th className="p-2">Matched Employee Record</th>
                    <th className="p-2">Status</th>
                    <th className="p-2">Drive Folder URL</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {previewRows.map((row, idx) => (
                    <tr key={row.rowNumber}>
                      <td className="p-2">
                        <Checkbox
                          checked={row.confirmed}
                          disabled={!row.urlValid || !row.matchedRecordId}
                          onCheckedChange={(v) => {
                            setPreviewRows((prev) =>
                              (prev ?? []).map((r, i) =>
                                i === idx ? { ...r, confirmed: Boolean(v) } : r,
                              ),
                            );
                          }}
                        />
                      </td>
                      <td className="p-2 font-medium">
                        {row.employeeName}
                        {row.employeeEmail && (
                          <div className="text-[11px] text-muted-foreground">{row.employeeEmail}</div>
                        )}
                      </td>
                      <td className="p-2">
                        {row.candidates.length > 1 ? (
                          <select
                            value={row.matchedRecordId ?? ""}
                            onChange={(e) => {
                              const recId = e.target.value;
                              const cand = row.candidates.find((c) => c.recordId === recId);
                              setPreviewRows((prev) =>
                                (prev ?? []).map((r, i) =>
                                  i === idx
                                    ? {
                                        ...r,
                                        matchedRecordId: cand?.recordId ?? null,
                                        matchedDisplayName: cand?.displayName ?? null,
                                        matchedHistoricalCode: cand?.historicalRecordCode ?? null,
                                        confirmed: Boolean(cand),
                                      }
                                    : r,
                                ),
                              );
                            }}
                            className="h-7 rounded border border-amber-300 bg-background px-1.5 text-xs w-full"
                          >
                            <option value="">Select matching record...</option>
                            {row.candidates.map((c) => (
                              <option key={c.recordId} value={c.recordId}>
                                {c.displayName} ({c.historicalRecordCode})
                              </option>
                            ))}
                          </select>
                        ) : row.matchedDisplayName ? (
                          <span>
                            {row.matchedDisplayName}{" "}
                            <code className="font-mono text-[11px] text-muted-foreground">
                              ({row.matchedHistoricalCode})
                            </code>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">No Match</span>
                        )}
                      </td>
                      <td className="p-2">
                        <Badge
                          variant="outline"
                          className={
                            row.matchStatus === "exact"
                              ? "border-emerald-500 text-emerald-700 text-[10px]"
                              : row.matchStatus === "proposed"
                                ? "border-blue-500 text-blue-700 text-[10px]"
                                : row.matchStatus === "ambiguous"
                                  ? "border-amber-500 text-amber-700 text-[10px]"
                                  : "border-red-500 text-red-700 text-[10px]"
                          }
                        >
                          {row.matchStatus}
                        </Badge>
                      </td>
                      <td className="p-2 max-w-[220px] truncate">
                        {row.urlValid ? (
                          <span className="font-mono text-[11px]">{row.driveFolderUrl}</span>
                        ) : (
                          <span className="text-red-600">{row.urlError}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPreviewRows(null)}>
                Back
              </Button>
              <Button
                type="button"
                disabled={loading || !previewRows.some((r) => r.confirmed && r.matchedRecordId)}
                onClick={handleCommit}
                className="bg-zinc-900 hover:bg-zinc-800 text-white"
              >
                <CheckCircle2 className="mr-1.5 size-3.5" />
                Save Confirmed Drive Links ({previewRows.filter((r) => r.confirmed).length})
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
