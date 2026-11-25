import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  Eye,
  FileSpreadsheet,
  FolderOpen,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AccessDenied, errorToAccessScreen } from "@/components/access-denied";
import { AppShell } from "@/components/app-shell";
import { AddRecordDialog } from "@/components/records/add-record-dialog";
import { BulkImportDialog } from "@/components/records/bulk-import-dialog";
import { DriveMappingDialog } from "@/components/records/drive-mapping-dialog";
import { RecordDetailDrawer } from "@/components/records/record-detail-drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
          "Permanent employee records of current and former staff synced automatically with Workforce.",
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
  sortBy: "display_name",
  sortDir: "asc",
  page: 1,
  pageSize: 25,
};

function EmployeeRecordsPage() {
  const actor = useActor();
  const queryClient = useQueryClient();
  const allowed = actorCan(actor, "records:read:all");

  const [filters, setFilters] = useState<RecordsListFilters>(INITIAL_FILTERS);
  const [searchInput, setSearchInput] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
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

  const activeAdvancedCount = useMemo(() => {
    let count = 0;
    if (filters.workType && filters.workType !== "all") count += 1;
    if (filters.employmentCategory && filters.employmentCategory !== "all") count += 1;
    if (filters.departmentId && filters.departmentId !== "all") count += 1;
    if (filters.workforceLink && filters.workforceLink !== "all") count += 1;
    if (filters.documentFilter && filters.documentFilter !== "all") count += 1;
    if (filters.joiningDateFrom || filters.joiningDateTo) count += 1;
    if (filters.lwdFrom || filters.lwdTo) count += 1;
    if (filters.missingFieldsOnly) count += 1;
    if (filters.needsReviewOnly) count += 1;
    return count;
  }, [filters]);

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
        toast.error("Apply pending database migrations first before syncing.");
        return;
      }
      toast.success(`Synchronized ${res.synced} Workforce employee(s) into Employee Records.`);
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
      const filename = `employee_records_${fullReport ? "all" : "filtered"}_${dateTag}.${format}`;
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
      toast.success(`Exported ${res.rows.length} employee record(s) as ${format.toUpperCase()}.`);
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

  function resetAllFilters() {
    setSearchInput("");
    setFilters(INITIAL_FILTERS);
  }

  return (
    <AppShell
      title="Employee Records"
      description="Permanent directory of current and former employees."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {!canManage && (
            <Badge variant="outline" className="border-zinc-400 text-xs">
              <Lock className="mr-1 size-3" /> Read-Only View
            </Badge>
          )}
          {canManage && (
            <>
              <Button
                size="sm"
                onClick={() => setAddOpen(true)}
                className="bg-zinc-900 hover:bg-zinc-800 text-white"
              >
                <Plus className="mr-1.5 size-3.5" /> Add Employee
              </Button>
              <Button size="sm" variant="outline" onClick={() => setBulkOpen(true)}>
                <FileSpreadsheet className="mr-1.5 size-3.5 text-red-600" /> Import Employees
              </Button>
            </>
          )}
          {canExport && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" disabled={exporting}>
                  <Download className="mr-1.5 size-3.5" />
                  Export
                  <ChevronDown className="ml-1 size-3.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void handleExport("xlsx", false)}>
                  Export Current View (.xlsx)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void handleExport("csv", false)}>
                  Export Current View (.csv)
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void handleExport("xlsx", true)}>
                  Export All Employees (.xlsx)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {canManage && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" aria-label="More actions">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setDriveOpen(true)}>
                  <FolderOpen className="mr-2 size-3.5 text-red-600" /> Link Drive Folders
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void handleSyncWorkforce()} disabled={syncing}>
                  <RefreshCw className={`mr-2 size-3.5 ${syncing ? "animate-spin" : ""}`} />
                  {syncing ? "Syncing Workforce..." : "Sync Workforce to Storage"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {/* Schema Notice when migrations are pending */}
        {data && !data.schemaReady && (
          <Card className="border-amber-300 bg-amber-50/70 dark:bg-amber-950/30 p-3 flex items-start gap-2.5 text-xs">
            <AlertTriangle className="size-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-amber-900 dark:text-amber-200">
                Showing live Workforce employees.{" "}
              </span>
              <span className="text-amber-800 dark:text-amber-300">
                Apply <code className="font-mono">20261125150000_employee_records_unique_guards_and_backfill.sql</code> to backfill archival storage.
              </span>
            </div>
          </Card>
        )}

        {/* Search, Status Filter & Collapsible Advanced Filters */}
        <Card className="p-4 space-y-3">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <form onSubmit={applySearch} className="flex gap-2 flex-1 max-w-md">
              <div className="relative flex-1">
                <Search className="size-4 text-muted-foreground absolute left-3 top-2.5" />
                <Input
                  value={searchInput}
                  onChange={(e) => {
                    const nextVal = e.target.value;
                    setSearchInput(nextVal);
                    if (nextVal === "" && filters.search) {
                      setFilters((p) => ({ ...p, search: "", page: 1 }));
                    }
                  }}
                  placeholder="Search by name, employee ID, email, or department..."
                  className="pl-9 h-9 text-xs"
                />
              </div>
              <Button type="submit" size="sm" variant="outline" className="h-9">
                Search
              </Button>
            </form>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <div className="inline-flex rounded-md border border-input p-0.5 bg-muted/30">
                {(["all", "active", "inactive"] as const).map((st) => {
                  const active = (filters.employmentStatus ?? "all") === st;
                  const count =
                    st === "all"
                      ? kpis?.totalRecords
                      : st === "active"
                        ? kpis?.activeCount
                        : kpis?.inactiveCount;
                  return (
                    <button
                      key={st}
                      type="button"
                      onClick={() => setFilters((p) => ({ ...p, employmentStatus: st, page: 1 }))}
                      className={`px-3 py-1 rounded-sm text-xs font-medium transition ${
                        active
                          ? "bg-zinc-900 text-white shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {st === "all" ? "All" : st === "active" ? "Active" : "Inactive"}
                      {typeof count === "number" ? ` (${count})` : ""}
                    </button>
                  );
                })}
              </div>

              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => setShowAdvanced((v) => !v)}
              >
                <SlidersHorizontal className="mr-1.5 size-3.5" />
                Advanced Filters
                {activeAdvancedCount > 0 && (
                  <Badge className="ml-1.5 h-4 px-1.5 bg-red-600 text-white text-[10px]">
                    {activeAdvancedCount}
                  </Badge>
                )}
                {showAdvanced ? (
                  <ChevronUp className="ml-1 size-3.5 opacity-70" />
                ) : (
                  <ChevronDown className="ml-1 size-3.5 opacity-70" />
                )}
              </Button>

              {(filters.search ||
                (filters.employmentStatus && filters.employmentStatus !== "all") ||
                activeAdvancedCount > 0) && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs"
                  onClick={resetAllFilters}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>

          {/* Collapsible Advanced Filters */}
          {showAdvanced && (
            <div className="pt-3 border-t border-border space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2">
                <select
                  value={filters.departmentId ?? "all"}
                  onChange={(e) =>
                    setFilters((p) => ({ ...p, departmentId: e.target.value, page: 1 }))
                  }
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="all">All Departments</option>
                  {(data?.departments ?? []).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
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
                    <option key={c} value={c}>
                      {RECORD_CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>

                <select
                  value={filters.workType ?? "all"}
                  onChange={(e) =>
                    setFilters((p) => ({ ...p, workType: e.target.value, page: 1 }))
                  }
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="all">All Work Types</option>
                  {RECORD_WORK_TYPES.map((w) => (
                    <option key={w} value={w}>
                      {RECORD_WORK_TYPE_LABELS[w]}
                    </option>
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
                  <option value="all">All Sources</option>
                  <option value="linked">Workforce Linked</option>
                  <option value="historical_only">Historical / Imported Only</option>
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
                  <option value="has_both">Has Drive &amp; KYC</option>
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
                  <option value="display_name:asc">Name (A → Z)</option>
                  <option value="updated_at:desc">Recently Updated</option>
                  <option value="joining_date:desc">Newest Joining Date</option>
                  <option value="joining_date:asc">Oldest Joining Date</option>
                  <option value="last_working_date:desc">Latest Last Working Date</option>
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <span>Joining Date:</span>
                  <Input
                    type="date"
                    value={filters.joiningDateFrom ?? ""}
                    onChange={(e) =>
                      setFilters((p) => ({ ...p, joiningDateFrom: e.target.value, page: 1 }))
                    }
                    className="h-7 w-32 text-[11px]"
                  />
                  <span>to</span>
                  <Input
                    type="date"
                    value={filters.joiningDateTo ?? ""}
                    onChange={(e) =>
                      setFilters((p) => ({ ...p, joiningDateTo: e.target.value, page: 1 }))
                    }
                    className="h-7 w-32 text-[11px]"
                  />
                </div>

                <div className="flex items-center gap-1.5">
                  <span>Last Working Date:</span>
                  <Input
                    type="date"
                    value={filters.lwdFrom ?? ""}
                    onChange={(e) =>
                      setFilters((p) => ({ ...p, lwdFrom: e.target.value, page: 1 }))
                    }
                    className="h-7 w-32 text-[11px]"
                  />
                  <span>to</span>
                  <Input
                    type="date"
                    value={filters.lwdTo ?? ""}
                    onChange={(e) =>
                      setFilters((p) => ({ ...p, lwdTo: e.target.value, page: 1 }))
                    }
                    className="h-7 w-32 text-[11px]"
                  />
                </div>

                <Button
                  type="button"
                  size="sm"
                  variant={filters.needsReviewOnly ? "default" : "outline"}
                  className={`h-7 text-[11px] ${filters.needsReviewOnly ? "bg-amber-600 text-white" : ""}`}
                  onClick={() =>
                    setFilters((p) => ({ ...p, needsReviewOnly: !p.needsReviewOnly, page: 1 }))
                  }
                >
                  Needs Review ({kpis?.needsReviewCount ?? 0})
                </Button>

                <Button
                  type="button"
                  size="sm"
                  variant={filters.missingFieldsOnly ? "default" : "outline"}
                  className={`h-7 text-[11px] ${filters.missingFieldsOnly ? "bg-zinc-900 text-white" : ""}`}
                  onClick={() =>
                    setFilters((p) => ({ ...p, missingFieldsOnly: !p.missingFieldsOnly, page: 1 }))
                  }
                >
                  Incomplete Profile ({kpis?.missingInfoCount ?? 0})
                </Button>
              </div>
            </div>
          )}
        </Card>

        {/* Simple Employee Table */}
        <Card className="overflow-hidden border-border">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-900 text-white uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="py-3 px-4">Employee Name</th>
                  <th className="py-3 px-3">Employee ID</th>
                  <th className="py-3 px-3">Department</th>
                  <th className="py-3 px-3">Designation</th>
                  <th className="py-3 px-3">Joining Date</th>
                  <th className="py-3 px-3">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recordsQuery.isLoading ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-muted-foreground">
                      Loading employee records...
                    </td>
                  </tr>
                ) : records.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-muted-foreground space-y-2">
                      <Archive className="size-8 mx-auto text-zinc-400" />
                      <div>No employee records match your current search or filter.</div>
                    </td>
                  </tr>
                ) : (
                  records.map((rec) => {
                    const primaryId = rec.tasEmployeeCode || rec.historicalRecordCode;
                    const secondaryId =
                      rec.tasEmployeeCode && rec.historicalRecordCode !== rec.tasEmployeeCode
                        ? rec.historicalRecordCode
                        : null;
                    return (
                      <tr
                        key={rec.id}
                        onClick={() => setSelectedRecordId(rec.id)}
                        className="hover:bg-muted/40 cursor-pointer transition-colors"
                      >
                        <td className="py-2.5 px-4">
                          <div className="font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                            {rec.displayName}
                            {(rec.needsReview || rec.statusNeedsReview) && (
                              <AlertTriangle
                                className="size-3.5 text-amber-500 shrink-0"
                                aria-label="Needs review"
                              />
                            )}
                          </div>
                          {rec.organizationEmail && (
                            <div className="text-[11px] text-muted-foreground truncate max-w-[240px]">
                              {rec.organizationEmail}
                            </div>
                          )}
                        </td>

                        <td className="py-2.5 px-3 font-mono text-[11px]">
                          <div className="font-medium text-zinc-900 dark:text-zinc-100">
                            {primaryId}
                          </div>
                          {secondaryId && (
                            <div className="text-[10px] text-muted-foreground">{secondaryId}</div>
                          )}
                        </td>

                        <td className="py-2.5 px-3 text-xs">
                          {rec.departmentName || "—"}
                        </td>

                        <td className="py-2.5 px-3 text-xs">
                          {rec.designation || "—"}
                        </td>

                        <td className="py-2.5 px-3 font-mono text-[11px]">
                          {rec.joiningDate || "—"}
                        </td>

                        <td className="py-2.5 px-3">
                          <Badge
                            className={
                              rec.employmentStatus === "active"
                                ? "bg-emerald-600 text-white text-[10px]"
                                : "bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200 text-[10px]"
                            }
                          >
                            {rec.employmentStatus === "active" ? "Active" : "Inactive"}
                          </Badge>
                        </td>

                        <td
                          className="py-2.5 px-4 text-right whitespace-nowrap space-x-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {canViewConfidential && rec.driveFolderUrl && (
                            <a
                              href={rec.driveFolderUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Open Documents Folder"
                            >
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                              >
                                <ExternalLink className="size-3.5 text-red-600" />
                              </Button>
                            </a>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 px-2.5 text-xs"
                            onClick={() => setSelectedRecordId(rec.id)}
                          >
                            {canManage ? (
                              <>
                                <Pencil className="mr-1 size-3" /> View / Edit
                              </>
                            ) : (
                              <>
                                <Eye className="mr-1 size-3" /> View
                              </>
                            )}
                          </Button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Footer */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-border bg-muted/20 text-xs">
            <div className="text-muted-foreground flex items-center gap-2">
              <Users className="size-3.5" />
              Showing {records.length} of {total} employee(s) • Page {page} of {totalPages}
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
                onClick={() =>
                  setFilters((p) => ({ ...p, page: Math.min(totalPages, (p.page ?? 1) + 1) }))
                }
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
