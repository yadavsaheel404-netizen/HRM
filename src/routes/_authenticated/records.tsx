import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Download,
  ExternalLink,
  Eye,
  FileCheck,
  FileSpreadsheet,
  FolderOpen,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Users,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AccessDenied, errorToAccessScreen } from "@/components/access-denied";
import { AppShell } from "@/components/app-shell";
import { AddRecordDialog } from "@/components/records/add-record-dialog";
import { BulkImportDialog } from "@/components/records/bulk-import-dialog";
import { DriveMappingDialog } from "@/components/records/drive-mapping-dialog";
import { RecordDetailDrawer } from "@/components/records/record-detail-drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { downloadCsv, toCsv } from "@/lib/csv";
import { describeUnknownError } from "@/lib/describe-error";
import { actorCan } from "@/lib/permissions";
import {
  exportEmployeeRecords,
  listEmployeeRecords,
  syncWorkforceRecords,
} from "@/lib/records.functions";
import {
  RECORD_CATEGORY_LABELS,
  RECORD_DOCUMENT_SOURCE_LABELS,
  RECORD_EMPLOYMENT_CATEGORIES,
  RECORD_WORK_TYPES,
  RECORD_WORK_TYPE_LABELS,
  type RecordsListFilters,
} from "@/lib/records/types";
import { downloadXlsx } from "@/lib/xlsx-export";

export const Route = createFileRoute("/_authenticated/records")({
  head: () => ({
    meta: [
      { title: "Employee Records | The AI School HRM" },
      {
        name: "description",
        content:
          "Permanent historical employee master register of current and former staff, Drive document folders, and Workforce synchronization.",
      },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: EmployeeRecordsPage,
  errorComponent: ({ error }) => errorToAccessScreen(error),
});

const INITIAL_FILTERS: RecordsListFilters = {
  search: "",
  employmentStatus: "all",
  workType: "all",
  employmentCategory: "all",
  departmentId: "all",
  joiningDateFrom: "",
  joiningDateTo: "",
  lwdFrom: "",
  lwdTo: "",
  workforceLink: "all",
  documentFilter: "all",
  missingFieldsOnly: false,
  needsReviewOnly: false,
  sortBy: "updated_at",
  sortDir: "desc",
  page: 1,
  pageSize: 25,
};

function EmployeeRecordsPage() {
  const actor = useActor();
  const queryClient = useQueryClient();
  const allowed = actorCan(actor, "records:read:all");

  const [filters, setFilters] = useState<RecordsListFilters>(INITIAL_FILTERS);
  const [searchInput, setSearchInput] = useState("");
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [exporting, setExporting] = useState(false);

  const recordsQuery = useQuery({
    queryKey: ["employee-records", filters],
    queryFn: () => listEmployeeRecords({ data: filters }),
    enabled: allowed,
  });

  if (!allowed) {
    return (
      <AccessDenied
        kind="forbidden"
        detail="Employee Records master register is restricted to HR, Founder, and Super Admin."
      />
    );
  }

  if (recordsQuery.isError) {
    return errorToAccessScreen(recordsQuery.error);
  }

  const data = recordsQuery.data;
  const canManage = Boolean(data?.canManage);
  const canViewConfidential = Boolean(data?.canViewConfidential);
  const canExport = Boolean(data?.canExport);
  const kpis = data?.kpis;
  const records = data?.records ?? [];
  const total = data?.total ?? 0;
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  async function refreshAll() {
    await queryClient.invalidateQueries({ queryKey: ["employee-records"] });
  }

  async function handleSyncWorkforce() {
    try {
      setSyncing(true);
      const res = await syncWorkforceRecords();
      if (!res.schemaReady) {
        toast.error("Apply database migration 20261125120000 first before syncing.");
        return;
      }
      toast.success(`Synchronized ${res.synced} Workforce profile(s) into Employee Records.`);
      await refreshAll();
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setSyncing(false);
    }
  }

  async function handleExport(format: "csv" | "xlsx", fullReport: boolean) {
    try {
      setExporting(true);
      const res = await exportEmployeeRecords({
        data: { filters, fullReport },
      });
      if (res.rows.length === 0) {
        toast.error("No records matched for export.");
        return;
      }
      const headers = Object.keys(res.rows[0]!);
      const dateTag = new Date().toISOString().slice(0, 10);
      const filename = `employee_records_${fullReport ? "full" : "filtered"}_${dateTag}.${format}`;
      if (format === "csv") {
        const csv = toCsv(
          res.rows,
          headers.map((h) => ({
            key: h,
            header: h,
            value: (row) => row[h] ?? "",
          })),
        );
        downloadCsv(filename, csv);
      } else {
        await downloadXlsx(filename, "Employee Records", res.rows);
      }
      toast.success(`Exported ${res.rows.length} record(s) as ${format.toUpperCase()}.`);
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setExporting(false);
    }
  }

  function applySearch(e: React.FormEvent) {
    e.preventDefault();
    setFilters((prev) => ({ ...prev, search: searchInput, page: 1 }));
  }

  return (
    <AppShell
      title="Employee Records"
      description="Permanent records of current and former employees."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {!canManage && (
            <Badge variant="outline" className="border-zinc-400 text-xs">
              <Lock className="mr-1 size-3" /> Read-Only Executive View
            </Badge>
          )}
          {canManage && (
            <>
              <Button
                size="sm"
                onClick={() => setAddOpen(true)}
                className="bg-zinc-900 hover:bg-zinc-800 text-white"
              >
                <Plus className="mr-1.5 size-3.5" /> Add Record
              </Button>
              <Button size="sm" variant="outline" onClick={() => setBulkOpen(true)}>
                <FileSpreadsheet className="mr-1.5 size-3.5 text-red-600" /> Bulk Import
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDriveOpen(true)}>
                <FolderOpen className="mr-1.5 size-3.5 text-red-600" /> Drive Links
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleSyncWorkforce}
                disabled={syncing}
              >
                <RefreshCw className={`mr-1.5 size-3.5 ${syncing ? "animate-spin" : ""}`} />
                Sync Workforce
              </Button>
            </>
          )}
          {canExport && (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled={exporting}
                onClick={() => handleExport("xlsx", false)}
              >
                <Download className="mr-1.5 size-3.5" /> Export XLSX
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={exporting}
                onClick={() => handleExport("csv", true)}
              >
                CSV
              </Button>
            </div>
          )}
        </div>
      }
    >
      <div className="space-y-5">
        {/* Schema Pending Alert */}
        {data && !data.schemaReady && (
          <Card className="border-amber-300 bg-amber-50/70 dark:bg-amber-950/30 p-4 flex items-start gap-3">
            <AlertTriangle className="size-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-xs space-y-1">
              <div className="font-semibold text-amber-900 dark:text-amber-200">
                Database Migration Required
              </div>
              <p className="text-amber-800 dark:text-amber-300">
                Apply <code className="font-mono">supabase/migrations/20261125120000_employee_records_master_register.sql</code> to initialize the <code className="font-mono">employee_records</code> master register, Workforce sync triggers, and RLS policies.
              </p>
            </div>
          </Card>
        )}

        {/* KPI Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Card
            className="cursor-pointer hover:border-zinc-900 transition"
            onClick={() => setFilters({ ...INITIAL_FILTERS })}
          >
            <CardContent className="p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Total Records
              </div>
              <div className="text-2xl font-bold mt-1">{kpis?.totalRecords ?? 0}</div>
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer hover:border-emerald-600 transition"
            onClick={() =>
              setFilters((p) => ({
                ...INITIAL_FILTERS,
                employmentStatus: p.employmentStatus === "active" ? "all" : "active",
              }))
            }
          >
            <CardContent className="p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700">
                Active
              </div>
              <div className="text-2xl font-bold text-emerald-700 mt-1">
                {kpis?.activeCount ?? 0}
              </div>
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer hover:border-zinc-700 transition"
            onClick={() =>
              setFilters((p) => ({
                ...INITIAL_FILTERS,
                employmentStatus: p.employmentStatus === "inactive" ? "all" : "inactive",
              }))
            }
          >
            <CardContent className="p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-600">
                Inactive / Former
              </div>
              <div className="text-2xl font-bold text-zinc-800 dark:text-zinc-200 mt-1">
                {kpis?.inactiveCount ?? 0}
              </div>
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer hover:border-amber-600 transition"
            onClick={() =>
              setFilters((p) => ({
                ...INITIAL_FILTERS,
                missingFieldsOnly: !p.missingFieldsOnly,
              }))
            }
          >
            <CardContent className="p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-700">
                Missing Info
              </div>
              <div className="text-2xl font-bold text-amber-700 mt-1">
                {kpis?.missingInfoCount ?? 0}
              </div>
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer hover:border-blue-600 transition"
            onClick={() =>
              setFilters((p) => ({
                ...INITIAL_FILTERS,
                workforceLink: p.workforceLink === "linked" ? "all" : "linked",
              }))
            }
          >
            <CardContent className="p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-blue-700">
                Linked Workforce
              </div>
              <div className="text-2xl font-bold text-blue-700 mt-1">
                {kpis?.linkedWorkforceCount ?? 0}
              </div>
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer hover:border-red-600 transition"
            onClick={() =>
              setFilters((p) => ({
                ...INITIAL_FILTERS,
                documentFilter: p.documentFilter === "has_drive" ? "all" : "has_drive",
              }))
            }
          >
            <CardContent className="p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-red-700">
                Historical Docs
              </div>
              <div className="text-2xl font-bold text-red-700 mt-1">
                {kpis?.historicalDocsAvailableCount ?? 0}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Search & Filters Toolbar */}
        <Card className="p-4 space-y-3">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <form onSubmit={applySearch} className="flex gap-2 flex-1 max-w-md">
              <div className="relative flex-1">
                <Search className="size-4 text-muted-foreground absolute left-3 top-2.5" />
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search name, TAS ID, TAS-REC ID, email, designation..."
                  className="pl-9 h-9 text-xs"
                />
              </div>
              <Button type="submit" size="sm" variant="outline" className="h-9">
                Search
              </Button>
            </form>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              {(["all", "active", "inactive"] as const).map((st) => (
                <Button
                  key={st}
                  type="button"
                  size="sm"
                  variant={filters.employmentStatus === st ? "default" : "outline"}
                  className={`h-8 text-xs capitalize ${filters.employmentStatus === st ? "bg-zinc-900 text-white" : ""}`}
                  onClick={() => setFilters((p) => ({ ...p, employmentStatus: st, page: 1 }))}
                >
                  {st === "all" ? "All Status" : st}
                </Button>
              ))}
              <Button
                type="button"
                size="sm"
                variant={filters.needsReviewOnly ? "default" : "outline"}
                className={`h-8 text-xs ${filters.needsReviewOnly ? "bg-red-600 text-white" : ""}`}
                onClick={() =>
                  setFilters((p) => ({ ...p, needsReviewOnly: !p.needsReviewOnly, page: 1 }))
                }
              >
                Needs Review ({kpis?.needsReviewCount ?? 0})
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 text-xs"
                onClick={() => {
                  setSearchInput("");
                  setFilters(INITIAL_FILTERS);
                }}
              >
                Reset
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 pt-1">
            <select
              value={filters.workType ?? "all"}
              onChange={(e) => setFilters((p) => ({ ...p, workType: e.target.value, page: 1 }))}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="all">All Work Types</option>
              {RECORD_WORK_TYPES.map((w) => (
                <option key={w} value={w}>{RECORD_WORK_TYPE_LABELS[w]}</option>
              ))}
            </select>

            <select
              value={filters.employmentCategory ?? "all"}
              onChange={(e) =>
                setFilters((p) => ({ ...p, employmentCategory: e.target.value, page: 1 }))
              }
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="all">All Categories</option>
              {RECORD_EMPLOYMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>{RECORD_CATEGORY_LABELS[c]}</option>
              ))}
            </select>

            <select
              value={filters.departmentId ?? "all"}
              onChange={(e) => setFilters((p) => ({ ...p, departmentId: e.target.value, page: 1 }))}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="all">All Departments</option>
              {(data?.departments ?? []).map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>

            <select
              value={filters.workforceLink ?? "all"}
              onChange={(e) =>
                setFilters((p) => ({
                  ...p,
                  workforceLink: e.target.value as NonNullable<RecordsListFilters["workforceLink"]>,
                  page: 1,
                }))
              }
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="all">All Link Types</option>
              <option value="linked">Workforce Linked</option>
              <option value="historical_only">Historical Only</option>
            </select>

            <select
              value={filters.documentFilter ?? "all"}
              onChange={(e) =>
                setFilters((p) => ({
                  ...p,
                  documentFilter: e.target.value as NonNullable<RecordsListFilters["documentFilter"]>,
                  page: 1,
                }))
              }
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="all">All Documents</option>
              <option value="has_drive">Has Drive Docs</option>
              <option value="has_kyc">Has HRM KYC</option>
              <option value="has_both">Has Both Drive &amp; KYC</option>
              <option value="missing_docs">Missing Documents</option>
            </select>

            <select
              value={`${filters.sortBy}:${filters.sortDir}`}
              onChange={(e) => {
                const [sortBy, sortDir] = e.target.value.split(":");
                setFilters((p) => ({
                  ...p,
                  sortBy: sortBy as NonNullable<RecordsListFilters["sortBy"]>,
                  sortDir: sortDir as NonNullable<RecordsListFilters["sortDir"]>,
                }));
              }}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="updated_at:desc">Recently Updated</option>
              <option value="display_name:asc">Name (A → Z)</option>
              <option value="joining_date:desc">Newest DOJ</option>
              <option value="joining_date:asc">Oldest DOJ</option>
              <option value="last_working_date:desc">Latest LWD</option>
              <option value="record_completeness:asc">Lowest Completeness</option>
            </select>
          </div>

          {/* Date Range Filters */}
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground pt-1">
            <div className="flex items-center gap-1.5">
              <span>DOJ:</span>
              <Input
                type="date"
                value={filters.joiningDateFrom ?? ""}
                onChange={(e) => setFilters((p) => ({ ...p, joiningDateFrom: e.target.value, page: 1 }))}
                className="h-7 w-32 text-[11px]"
              />
              <span>–</span>
              <Input
                type="date"
                value={filters.joiningDateTo ?? ""}
                onChange={(e) => setFilters((p) => ({ ...p, joiningDateTo: e.target.value, page: 1 }))}
                className="h-7 w-32 text-[11px]"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span>LWD:</span>
              <Input
                type="date"
                value={filters.lwdFrom ?? ""}
                onChange={(e) => setFilters((p) => ({ ...p, lwdFrom: e.target.value, page: 1 }))}
                className="h-7 w-32 text-[11px]"
              />
              <span>–</span>
              <Input
                type="date"
                value={filters.lwdTo ?? ""}
                onChange={(e) => setFilters((p) => ({ ...p, lwdTo: e.target.value, page: 1 }))}
                className="h-7 w-32 text-[11px]"
              />
            </div>
            {kpis?.lastSyncedAt && (
              <span className="ml-auto">
                Last Synced: {new Date(kpis.lastSyncedAt).toLocaleString()}
              </span>
            )}
          </div>
        </Card>

        {/* Master Records Table */}
        <Card className="overflow-hidden border-border">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-900 text-white uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="py-3 px-3.5">Employee</th>
                  <th className="py-3 px-3">ID / Record ID</th>
                  <th className="py-3 px-3">Contact</th>
                  <th className="py-3 px-3">Category</th>
                  <th className="py-3 px-3">Work Type</th>
                  <th className="py-3 px-3">Joining Date</th>
                  <th className="py-3 px-3">Last Working</th>
                  <th className="py-3 px-3">Status</th>
                  <th className="py-3 px-3">Documents</th>
                  <th className="py-3 px-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recordsQuery.isLoading ? (
                  <tr>
                    <td colSpan={10} className="py-12 text-center text-muted-foreground">
                      Loading master records...
                    </td>
                  </tr>
                ) : records.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-12 text-center text-muted-foreground space-y-2">
                      <Archive className="size-8 mx-auto text-zinc-400" />
                      <div>No employee records match your current filters.</div>
                    </td>
                  </tr>
                ) : (
                  records.map((rec) => (
                    <tr
                      key={rec.id}
                      onClick={() => setSelectedRecordId(rec.id)}
                      className="hover:bg-muted/40 cursor-pointer transition-colors"
                    >
                      <td className="py-2.5 px-3.5">
                        <div className="font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                          {rec.displayName}
                          {(rec.needsReview || rec.statusNeedsReview) && (
                            <AlertTriangle className="size-3.5 text-amber-500" />
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {rec.designation || rec.departmentName || "Role Unclassified"}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px]">
                        {rec.tasEmployeeCode ? (
                          <div className="font-semibold text-zinc-900 dark:text-zinc-100">
                            {rec.tasEmployeeCode}
                          </div>
                        ) : null}
                        <div className="text-muted-foreground">{rec.historicalRecordCode}</div>
                      </td>
                      <td className="py-2.5 px-3 text-[11px]">
                        <div className="truncate max-w-[190px]">
                          {rec.organizationEmail || "—"}
                        </div>
                        {canViewConfidential ? (
                          <div className="text-muted-foreground truncate max-w-[190px]">
                            {rec.personalEmail || rec.phoneNumber || "—"}
                          </div>
                        ) : (
                          <div className="text-[10px] text-muted-foreground italic">
                            Private PII redacted
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        <Badge variant="outline" className="text-[10px]">
                          {RECORD_CATEGORY_LABELS[rec.employmentCategory]}
                        </Badge>
                      </td>
                      <td className="py-2.5 px-3">
                        <span className="text-[11px]">
                          {RECORD_WORK_TYPE_LABELS[rec.workType]}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px]">
                        {rec.joiningDate || "—"}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px]">
                        {rec.lastWorkingDate || "—"}
                      </td>
                      <td className="py-2.5 px-3">
                        <Badge
                          className={
                            rec.employmentStatus === "active"
                              ? "bg-emerald-600 text-white text-[10px]"
                              : "bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200 text-[10px]"
                          }
                        >
                          {rec.employmentStatus.toUpperCase()}
                        </Badge>
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="flex flex-col gap-0.5">
                          <Badge variant="outline" className="text-[10px] w-fit">
                            {RECORD_DOCUMENT_SOURCE_LABELS[rec.documentSource]}
                          </Badge>
                          {rec.profileId && rec.kycSummary?.status && (
                            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                              <FileCheck className="size-3 text-emerald-600" />
                              KYC: {rec.kycSummary.verifiedCount ?? 0}/{rec.kycSummary.requiredCount ?? 5}
                            </span>
                          )}
                        </div>
                      </td>
                      <td
                        className="py-2.5 px-3.5 text-right whitespace-nowrap space-x-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {canViewConfidential && rec.driveFolderUrl && (
                          <a
                            href={rec.driveFolderUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Open Historical Documents"
                          >
                            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs">
                              <ExternalLink className="size-3.5 text-red-600" />
                            </Button>
                          </a>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          onClick={() => setSelectedRecordId(rec.id)}
                        >
                          <Eye className="mr-1 size-3" /> View
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Footer */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-border bg-muted/20 text-xs">
            <div className="text-muted-foreground flex items-center gap-2">
              <Users className="size-3.5" />
              Showing {records.length} of {total} record(s) (Page {page} of {totalPages})
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setFilters((p) => ({ ...p, page: Math.max(1, (p.page ?? 1) - 1) }))}
                className="h-7 text-xs"
              >
                Previous
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={page >= totalPages}
                onClick={() => setFilters((p) => ({ ...p, page: Math.min(totalPages, (p.page ?? 1) + 1) }))}
                className="h-7 text-xs"
              >
                Next
              </Button>
            </div>
          </div>
        </Card>
      </div>

      {/* Drawers & Modals */}
      <RecordDetailDrawer
        recordId={selectedRecordId}
        open={Boolean(selectedRecordId)}
        onOpenChange={(next) => {
          if (!next) setSelectedRecordId(null);
        }}
        departments={data?.departments ?? []}
        onUpdated={refreshAll}
      />

      {canManage && (
        <>
          <AddRecordDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            departments={data?.departments ?? []}
            onCreated={refreshAll}
          />
          <BulkImportDialog
            open={bulkOpen}
            onOpenChange={setBulkOpen}
            onImported={refreshAll}
          />
          <DriveMappingDialog
            open={driveOpen}
            onOpenChange={setDriveOpen}
            onCompleted={refreshAll}
          />
        </>
      )}
    </AppShell>
  );
}
