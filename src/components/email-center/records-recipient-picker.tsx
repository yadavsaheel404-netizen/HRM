import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Mail,
  RefreshCw,
  Search,
  Square,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { searchEmailCenterRecipients } from "@/lib/email-center-bulk.functions";
import { resolveRecipientEmailSelection } from "@/lib/email-center/custom-templates";
import type { EmailCenterRecipientItem, RecipientEmailMode } from "@/lib/email-center/types";

interface RecordsRecipientPickerProps {
  context: "relieving" | "custom";
  selectedIds: string[];
  recipientCache: Map<string, EmailCenterRecipientItem>;
  onChangeSelection: (
    nextIds: string[],
    nextCache: Map<string, EmailCenterRecipientItem>,
  ) => void;
  defaultEmailMode: RecipientEmailMode;
  onChangeEmailMode: (mode: RecipientEmailMode) => void;
  showRelievingColumns?: boolean;
  canViewPersonalEmails: boolean;
}

export function RecordsRecipientPicker({
  context,
  selectedIds,
  recipientCache,
  onChangeSelection,
  defaultEmailMode,
  onChangeEmailMode,
  showRelievingColumns = false,
  canViewPersonalEmails,
}: RecordsRecipientPickerProps) {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive_relieved">("all");
  const [departmentFilter, setDepartmentFilter] = useState("all");
  const [workTypeFilter, setWorkTypeFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [emailAvailFilter, setEmailAvailFilter] = useState<"all" | "any" | "personal" | "work">("all");
  const [onlyApprovedRelieving, setOnlyApprovedRelieving] = useState(false);
  const [onlyMissingDetails, setOnlyMissingDetails] = useState(false);
  const [page, setPage] = useState(1);
  const [confirmAllMatchingOpen, setConfirmAllMatchingOpen] = useState(false);
  const [selectingAllMatching, setSelectingAllMatching] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQuery(searchInput);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const queryRes = useQuery({
    queryKey: [
      "email-center-recipients",
      context,
      debouncedQuery,
      statusFilter,
      departmentFilter,
      workTypeFilter,
      categoryFilter,
      emailAvailFilter,
      onlyApprovedRelieving,
      onlyMissingDetails,
      defaultEmailMode,
      page,
    ],
    queryFn: () =>
      searchEmailCenterRecipients({
        data: {
          context,
          query: debouncedQuery,
          status: statusFilter,
          department: departmentFilter,
          workType: workTypeFilter,
          employmentCategory: categoryFilter,
          emailAvailable: emailAvailFilter,
          hasApprovedRelievingCase: onlyApprovedRelieving,
          missingRequiredDetails: onlyMissingDetails,
          emailMode: defaultEmailMode,
          page,
          pageSize: 25,
        },
      }),
  });

  const rows = queryRes.data?.items ?? [];
  const total = queryRes.data?.total ?? 0;
  const totalPages = queryRes.data?.totalPages ?? 1;
  const departments = queryRes.data?.departments ?? [];
  const workTypes = queryRes.data?.workTypes ?? [];

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const mergeCache = (items: EmailCenterRecipientItem[]) => {
    const next = new Map(recipientCache);
    for (const item of items) {
      next.set(item.recordId, item);
    }
    return next;
  };

  const toggleRow = (item: EmailCenterRecipientItem) => {
    const nextCache = mergeCache([item]);
    if (selectedSet.has(item.recordId)) {
      onChangeSelection(
        selectedIds.filter((id) => id !== item.recordId),
        nextCache,
      );
    } else {
      onChangeSelection([...selectedIds, item.recordId], nextCache);
    }
  };

  const handleSelectCurrentPage = () => {
    const nextCache = mergeCache(rows);
    const merged = new Set(selectedIds);
    for (const r of rows) merged.add(r.recordId);
    onChangeSelection([...merged], nextCache);
    toast.success(`Selected ${rows.length} employee(s) on page ${page}.`);
  };

  const handleSelectAllMatching = async () => {
    setSelectingAllMatching(true);
    try {
      const res = await searchEmailCenterRecipients({
        data: {
          context,
          query: debouncedQuery,
          status: statusFilter,
          department: departmentFilter,
          workType: workTypeFilter,
          employmentCategory: categoryFilter,
          emailAvailable: emailAvailFilter,
          hasApprovedRelievingCase: onlyApprovedRelieving,
          missingRequiredDetails: onlyMissingDetails,
          emailMode: defaultEmailMode,
          page: 1,
          pageSize: 100,
          includeAllMatchingIds: true,
        },
      });
      const allIds = res.allMatchingIds ?? res.items.map((i) => i.recordId);
      const nextCache = mergeCache(res.items);

      // Hydrate any remaining selected records beyond page 1 in chunks of 100 if needed
      if (allIds.length > res.items.length) {
        const neededPages = Math.min(20, Math.ceil(allIds.length / 100));
        for (let p = 2; p <= neededPages; p++) {
          const extra = await searchEmailCenterRecipients({
            data: {
              context,
              query: debouncedQuery,
              status: statusFilter,
              department: departmentFilter,
              workType: workTypeFilter,
              employmentCategory: categoryFilter,
              emailAvailable: emailAvailFilter,
              hasApprovedRelievingCase: onlyApprovedRelieving,
              missingRequiredDetails: onlyMissingDetails,
              emailMode: defaultEmailMode,
              page: p,
              pageSize: 100,
            },
          });
          for (const item of extra.items) {
            nextCache.set(item.recordId, item);
          }
        }
      }

      onChangeSelection(allIds, nextCache);
      toast.success(`Selected all ${allIds.length} matching employee record(s).`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to select all matching records.");
    } finally {
      setSelectingAllMatching(false);
      setConfirmAllMatchingOpen(false);
    }
  };

  const handleClearSelection = () => {
    onChangeSelection([], recipientCache);
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3.5">
      {/* Header Row: Selected Counter + Personal / Work Email Switch */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Users className="size-4 text-primary" />
          <span className="text-xs font-semibold text-foreground">
            Employee Records &amp; Workforce Selector
          </span>
          <Badge variant={selectedIds.length > 0 ? "default" : "secondary"} className="text-[11px]">
            {selectedIds.length} {selectedIds.length === 1 ? "employee" : "employees"} selected
          </Badge>
        </div>

        {/* Essential Target Email Selector */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">Target Email:</span>
          <div
            className="inline-flex rounded-md border border-border bg-muted/40 p-0.5"
            role="group"
            aria-label="Recipient email type selector"
          >
            <Button
              type="button"
              size="sm"
              variant={defaultEmailMode === "personal" ? "default" : "ghost"}
              className="h-7 px-2.5 text-[11px] font-semibold"
              onClick={() => onChangeEmailMode("personal")}
            >
              PERSONAL EMAIL
            </Button>
            <Button
              type="button"
              size="sm"
              variant={defaultEmailMode === "work" ? "default" : "ghost"}
              className="h-7 px-2.5 text-[11px] font-semibold"
              onClick={() => onChangeEmailMode("work")}
            >
              WORK EMAIL
            </Button>
          </div>
        </div>
      </div>

      {/* Former Employee Work Email Notice in Relieving Context */}
      {context === "relieving" && defaultEmailMode === "work" ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          <span>
            <strong>Heads up:</strong> Work email is selected. Former or relieved employees may no longer have access to their organization mailbox — consider <strong>PERSONAL EMAIL</strong> or overriding per row.
          </span>
        </div>
      ) : null}

      {/* Search + Compact Filters */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
        <div className="relative lg:col-span-2">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
          <Input
            aria-label="Search employee name, TAS ID, record ID, work email, or personal email"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search name, TAS ID, Record ID, or email..."
            className="h-8 pl-8 text-xs"
          />
        </div>

        <select
          aria-label="Filter by employment status"
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value as "all" | "active" | "inactive_relieved");
            setPage(1);
          }}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="all">All Employees</option>
          <option value="active">Active Only</option>
          <option value="inactive_relieved">Inactive / Relieved</option>
        </select>

        <select
          aria-label="Filter by department"
          value={departmentFilter}
          onChange={(e) => {
            setDepartmentFilter(e.target.value);
            setPage(1);
          }}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="all">All Departments</option>
          {departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>

        <select
          aria-label="Filter by employment category"
          value={categoryFilter}
          onChange={(e) => {
            setCategoryFilter(e.target.value);
            setPage(1);
          }}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="all">All Categories</option>
          <option value="full_time">Full-Time</option>
          <option value="intern">Intern</option>
          <option value="freelancer">Freelancer</option>
          <option value="trainer">Trainer</option>
        </select>

        <select
          aria-label="Filter by email availability"
          value={emailAvailFilter}
          onChange={(e) => {
            setEmailAvailFilter(e.target.value as "all" | "any" | "personal" | "work");
            setPage(1);
          }}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="all">Email Available (Any / Missing)</option>
          <option value="any">Has Any Email</option>
          <option value="personal">Has Personal Email</option>
          <option value="work">Has Work Email</option>
        </select>
      </div>

      {/* Extra Secondary Filters + Selection Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Filter by work type"
            value={workTypeFilter}
            onChange={(e) => {
              setWorkTypeFilter(e.target.value);
              setPage(1);
            }}
            className="h-7 rounded-md border border-input bg-background px-2 text-[11px]"
          >
            <option value="all">All Work Types</option>
            {workTypes.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>

          {showRelievingColumns ? (
            <>
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px]">
                <Checkbox
                  checked={onlyApprovedRelieving}
                  onCheckedChange={(v) => {
                    setOnlyApprovedRelieving(Boolean(v));
                    setPage(1);
                  }}
                />
                <span>Has Approved Relieving Case</span>
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px]">
                <Checkbox
                  checked={onlyMissingDetails}
                  onCheckedChange={(v) => {
                    setOnlyMissingDetails(Boolean(v));
                    setPage(1);
                  }}
                />
                <span>Missing / Pending Details</span>
              </label>
            </>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={rows.length === 0}
            onClick={handleSelectCurrentPage}
          >
            <CheckSquare className="mr-1 size-3" />
            Select page ({rows.length})
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={total === 0 || selectingAllMatching}
            onClick={() => setConfirmAllMatchingOpen(true)}
          >
            Select all matching ({total})
          </Button>
          {selectedIds.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              onClick={handleClearSelection}
            >
              <Square className="mr-1 size-3" />
              Deselect all
            </Button>
          ) : null}
        </div>
      </div>

      {/* Table */}
      <div className="max-h-[320px] overflow-auto rounded-md border border-border">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 z-10 border-b border-border bg-muted/90 text-[11px] text-muted-foreground backdrop-blur">
            <tr>
              <th className="w-9 px-2.5 py-2 font-medium">Pick</th>
              <th className="px-2.5 py-2 font-medium">Employee &amp; ID</th>
              <th className="px-2.5 py-2 font-medium">Role / Category / Work Type</th>
              <th className="px-2.5 py-2 font-medium">Employment</th>
              <th className="px-2.5 py-2 font-medium">Email Availability &amp; Target</th>
              {showRelievingColumns ? (
                <th className="px-2.5 py-2 font-medium">Relieving Case</th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {queryRes.isLoading ? (
              <tr>
                <td
                  colSpan={showRelievingColumns ? 6 : 5}
                  className="py-8 text-center text-xs text-muted-foreground"
                >
                  <RefreshCw className="mx-auto mb-1.5 size-4 animate-spin" />
                  Loading Employee Records...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  colSpan={showRelievingColumns ? 6 : 5}
                  className="py-8 text-center text-xs text-muted-foreground"
                >
                  No Employee Records match your current search/filters.
                </td>
              </tr>
            ) : (
              rows.map((item) => {
                const checked = selectedSet.has(item.recordId);
                const resolution = resolveRecipientEmailSelection(item, defaultEmailMode, undefined, {
                  isRelievingWorkflow: showRelievingColumns,
                });

                return (
                  <tr
                    key={item.recordId}
                    className={`cursor-pointer transition-colors hover:bg-muted/40 ${
                      checked ? "bg-primary/5" : ""
                    }`}
                    onClick={() => toggleRow(item)}
                  >
                    <td className="px-2.5 py-2" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleRow(item)}
                        aria-label={`Select ${item.fullName}`}
                      />
                    </td>
                    <td className="px-2.5 py-2">
                      <div className="font-medium text-foreground">{item.fullName}</div>
                      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                        <span>{item.employeeCode ?? item.historicalRecordId}</span>
                        {item.isHistoricalOnly ? (
                          <Badge variant="outline" className="px-1 py-0 text-[9px]">
                            Records Only
                          </Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-2.5 py-2">
                      <div className="truncate text-foreground">
                        {item.designation || "—"}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {item.employmentCategory} • {item.workType}
                        {item.departmentName ? ` • ${item.departmentName}` : ""}
                      </div>
                    </td>
                    <td className="px-2.5 py-2">
                      <Badge
                        variant={
                          item.employmentStatus === "active" && !item.isFormer
                            ? "success"
                            : "neutral"
                        }
                        className="text-[10px] capitalize"
                      >
                        {item.isFormer ? "Former / Relieved" : item.employmentStatus}
                      </Badge>
                    </td>
                    <td className="px-2.5 py-2">
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge
                          variant={item.workEmailAvailable ? "outline" : "neutral"}
                          className="text-[9px]"
                        >
                          Work: {item.workEmailAvailable ? "Yes" : "No"}
                        </Badge>
                        <Badge
                          variant={item.personalEmailAvailable ? "outline" : "neutral"}
                          className="text-[9px]"
                        >
                          Personal: {item.personalEmailAvailable ? "Yes" : "No"}
                        </Badge>
                      </div>
                      <div className="mt-1 flex items-center gap-1 text-[10px]">
                        <Mail className="size-3 shrink-0 text-muted-foreground" />
                        {resolution.resolvedEmail ? (
                          <span className="truncate font-mono text-foreground">
                            {canViewPersonalEmails || defaultEmailMode === "work"
                              ? resolution.resolvedEmail
                              : "Personal email verified (restricted)"}
                          </span>
                        ) : (
                          <span className="font-medium text-destructive">
                            {resolution.statusLabel}
                          </span>
                        )}
                      </div>
                    </td>
                    {showRelievingColumns ? (
                      <td className="px-2.5 py-2">
                        {item.relievingCase ? (
                          <Badge
                            variant={
                              item.relievingCase.status === "approved" ||
                              item.relievingCase.status === "relieved"
                                ? "success"
                                : "outline"
                            }
                            className="text-[10px] capitalize"
                          >
                            {item.relievingCase.status.replace(/_/g, " ")}
                          </Badge>
                        ) : (
                          <Badge variant="neutral" className="text-[10px]">
                            No Case
                          </Badge>
                        )}
                      </td>
                    ) : null}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Showing {rows.length} of <strong>{total}</strong> employee records (Page {page} of{" "}
          {totalPages})
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Cross-page "Select All Matching" Confirmation Dialog */}
      <AlertDialog open={confirmAllMatchingOpen} onOpenChange={setConfirmAllMatchingOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Select All {total} Matching Employee Records?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This selects <strong>{total}</strong> matching employees across all filtered pages
              (not just the {rows.length} currently visible rows). Selecting employees does NOT
              change employment status or send any emails.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={selectingAllMatching}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={selectingAllMatching}
              onClick={() => void handleSelectAllMatching()}
            >
              {selectingAllMatching ? "Selecting..." : `Select All (${total})`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
