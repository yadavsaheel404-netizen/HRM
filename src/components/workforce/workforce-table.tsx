import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowUpDown,
  Building2,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Eye,
  FileCheck2,
  FileText,
  Mail,
  MoreHorizontal,
  Send,
  Shield,
  Trash2,
  UserCheck,
  UserX,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CATEGORY_LABELS,
  ROLE_LABELS,
  type AppRole,
  type UserCategory,
} from "@/lib/permissions";
import { WORK_TYPE_LABELS, type WorkType } from "@/lib/work-type";
import type { listWorkforce } from "@/lib/workforce.functions";

type WorkforceMember = Awaited<ReturnType<typeof listWorkforce>>[number];

export type WorkforceTableProps = {
  people: WorkforceMember[];
  onSelectEmployee: (id: string) => void;
  canManageWorkforce: boolean;
  isSuperAdmin: boolean;
  onDeactivate: (person: { id: string; fullName: string; employeeCode: string | null; workEmail: string; role: string; departmentName: string | null }) => void;
  onReactivate: (userId: string) => void;
  onDelete: (person: { id: string; fullName: string; employeeCode: string | null; workEmail: string }) => void;
  onSendSetupEmail: (userId: string, email: string) => void;
};

type SortField = "name" | "code" | "department" | "role" | "onboarding" | "kyc";
type SortDir = "asc" | "desc";

export function WorkforceTable({
  people,
  onSelectEmployee,
  canManageWorkforce,
  isSuperAdmin,
  onDeactivate,
  onReactivate,
  onDelete,
  onSendSetupEmail,
}: WorkforceTableProps) {
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  const sorted = [...people].sort((a, b) => {
    let cmp = 0;
    if (sortField === "name") {
      cmp = a.full_name.localeCompare(b.full_name);
    } else if (sortField === "code") {
      cmp = (a.employee_code ?? "").localeCompare(b.employee_code ?? "");
    } else if (sortField === "department") {
      cmp = (a.department_name ?? "").localeCompare(b.department_name ?? "");
    } else if (sortField === "role") {
      cmp = (a.roles[0] ?? "").localeCompare(b.roles[0] ?? "");
    } else if (sortField === "onboarding") {
      cmp = a.account_status.localeCompare(b.account_status);
    } else if (sortField === "kyc") {
      cmp = a.kyc_status.localeCompare(b.kyc_status);
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  const totalPages = Math.ceil(sorted.length / pageSize) || 1;
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const paginated = sorted.slice(startIndex, startIndex + pageSize);

  return (
    <div className="space-y-3">
      {/* Mobile Stacked Cards (<768px) */}
      <div className="space-y-2.5 md:hidden">
        {paginated.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            No workforce members match your filters.
          </Card>
        ) : (
          paginated.map((person) => {
            const primaryRole = (person.roles[0] as AppRole) ?? "employee";
            return (
              <div
                key={person.id}
                onClick={() => onSelectEmployee(person.id)}
                className="rounded-xl border border-border/80 bg-card p-3.5 shadow-2xs hover:border-primary/40 transition-colors cursor-pointer"
              >
                <div className="flex items-start justify-between gap-2.5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Avatar className="size-9 border border-border/70 shrink-0">
                      <AvatarImage src={person.photo_url ?? undefined} alt={person.full_name} />
                      <AvatarFallback className="bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300 font-bold text-xs">
                        {person.full_name
                          .split(" ")
                          .map((n) => n[0])
                          .slice(0, 2)
                          .join("")
                          .toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="font-semibold text-xs text-foreground truncate">{person.full_name}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{person.work_email}</div>
                    </div>
                  </div>

                  <span className="font-mono text-[11px] font-semibold text-muted-foreground shrink-0">
                    {person.employee_code ?? "—"}
                  </span>
                </div>

                <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="rounded bg-secondary/80 px-2 py-0.5 text-[10px] font-medium text-secondary-foreground">
                    {ROLE_LABELS[primaryRole] ?? primaryRole}
                  </span>
                  {person.category && (
                    <span className="text-[11px] text-muted-foreground">
                      · {CATEGORY_LABELS[person.category as UserCategory] ?? person.category}
                    </span>
                  )}
                  {person.department_name && (
                    <span className="text-[11px] text-foreground font-medium">· {person.department_name}</span>
                  )}
                  {person.work_type && (
                    <Badge variant="outline" className="text-[10px] border-primary/30 text-primary">
                      {WORK_TYPE_LABELS[person.work_type as WorkType] ?? person.work_type}
                    </Badge>
                  )}
                </div>

                <div className="mt-2 flex items-center justify-between border-t border-border/50 pt-2 text-[11px]">
                  <Badge
                    variant={
                      person.employment_status === "inactive"
                        ? "neutral"
                        : person.account_status === "active"
                        ? "success"
                        : person.account_status === "under_verification"
                        ? "warning"
                        : "info"
                    }
                    className="text-[10px]"
                  >
                    {person.onboarding_lifecycle_status}
                  </Badge>

                  <Badge
                    variant={
                      person.kyc_status === "verified"
                        ? "success"
                        : person.kyc_status === "correction_required"
                        ? "destructive"
                        : person.kyc_status === "under_review"
                        ? "warning"
                        : "neutral"
                    }
                    className="text-[10px]"
                  >
                    KYC: {person.kyc_verified_count}/5
                  </Badge>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Tablet & Desktop Table (>=768px) */}
      <Card className="hidden overflow-hidden p-0 md:block border-border/80 shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead className="border-b border-border/80 bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">
                  <button
                    type="button"
                    onClick={() => handleSort("name")}
                    className="inline-flex items-center gap-1.5 hover:text-foreground font-semibold"
                  >
                    <span>Employee</span>
                    <ArrowUpDown className="size-3" />
                  </button>
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  <button
                    type="button"
                    onClick={() => handleSort("code")}
                    className="inline-flex items-center gap-1.5 hover:text-foreground font-semibold"
                  >
                    <span>Employee ID</span>
                    <ArrowUpDown className="size-3" />
                  </button>
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  <button
                    type="button"
                    onClick={() => handleSort("department")}
                    className="inline-flex items-center gap-1.5 hover:text-foreground font-semibold"
                  >
                    <span>Department / Work Type</span>
                    <ArrowUpDown className="size-3" />
                  </button>
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  <button
                    type="button"
                    onClick={() => handleSort("role")}
                    className="inline-flex items-center gap-1.5 hover:text-foreground font-semibold"
                  >
                    <span>Role & Category</span>
                    <ArrowUpDown className="size-3" />
                  </button>
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  <button
                    type="button"
                    onClick={() => handleSort("onboarding")}
                    className="inline-flex items-center gap-1.5 hover:text-foreground font-semibold"
                  >
                    <span>Onboarding Lifecycle</span>
                    <ArrowUpDown className="size-3" />
                  </button>
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  <button
                    type="button"
                    onClick={() => handleSort("kyc")}
                    className="inline-flex items-center gap-1.5 hover:text-foreground font-semibold"
                  >
                    <span>KYC Verification</span>
                    <ArrowUpDown className="size-3" />
                  </button>
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Pending Actions
                </th>
                <th scope="col" className="px-3 py-3 text-right font-semibold">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {paginated.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-sm text-muted-foreground">
                    No workforce members match your filters.
                  </td>
                </tr>
              ) : (
                paginated.map((person) => {
                  const primaryRole = (person.roles[0] as AppRole) ?? "employee";
                  const isInactive = person.employment_status === "inactive";
                  const isRelieved = (person.employment_status as any) === "relieved";

                  return (
                    <tr
                      key={person.id}
                      className="group transition-colors hover:bg-muted/30 cursor-pointer"
                      onClick={() => onSelectEmployee(person.id)}
                    >
                      {/* Employee Info */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <Avatar className="size-8 border border-border/70 shrink-0">
                            <AvatarImage src={person.photo_url ?? undefined} alt={person.full_name} />
                            <AvatarFallback className="bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300 font-bold text-[11px]">
                              {person.full_name
                                .split(" ")
                                .map((n) => n[0])
                                .slice(0, 2)
                                .join("")
                                .toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <div className="font-semibold text-foreground hover:text-primary transition-colors truncate">
                              {person.full_name}
                            </div>
                            <div className="text-[11px] text-muted-foreground truncate">{person.work_email}</div>
                            {person.designation && (
                              <div className="text-[10px] text-muted-foreground/80 truncate">{person.designation}</div>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Employee ID */}
                      <td className="px-3 py-3 font-mono font-medium text-foreground">
                        {person.employee_code ?? <span className="text-muted-foreground">—</span>}
                      </td>

                      {/* Department / Work Type */}
                      <td className="px-3 py-3">
                        <div className="space-y-1">
                          <div className="font-medium text-foreground">
                            {person.department_name ?? <span className="text-muted-foreground">Unassigned</span>}
                          </div>
                          {person.work_type ? (
                            <Badge variant="outline" className="text-[10px] border-primary/30 text-primary">
                              {WORK_TYPE_LABELS[person.work_type as WorkType] ?? person.work_type}
                            </Badge>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">No Work Type</span>
                          )}
                        </div>
                      </td>

                      {/* Role & Category */}
                      <td className="px-3 py-3">
                        <div className="space-y-0.5">
                          <div className="font-medium text-foreground">
                            {ROLE_LABELS[primaryRole] ?? primaryRole}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {CATEGORY_LABELS[person.category as UserCategory] ?? person.category}
                          </div>
                        </div>
                      </td>

                      {/* Onboarding Lifecycle */}
                      <td className="px-3 py-3">
                        <Badge
                          variant={
                            isRelieved
                              ? "outline"
                              : isInactive
                              ? "neutral"
                              : person.account_status === "active"
                              ? "success"
                              : person.account_status === "under_verification"
                              ? "warning"
                              : "info"
                          }
                          className={`text-[11px] ${
                            isRelieved
                              ? "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 font-semibold"
                              : ""
                          }`}
                        >
                          {isRelieved ? "Relieved" : person.onboarding_lifecycle_status}
                        </Badge>
                      </td>

                      {/* KYC Verification */}
                      <td className="px-3 py-3">
                        <div className="space-y-1">
                          <Badge
                            variant={
                              person.kyc_status === "verified"
                                ? "success"
                                : person.kyc_status === "correction_required"
                                ? "destructive"
                                : person.kyc_status === "under_review"
                                ? "warning"
                                : "neutral"
                            }
                            className="text-[11px]"
                          >
                            {person.kyc_status === "verified"
                              ? "Fully Verified"
                              : person.kyc_status === "correction_required"
                              ? `${person.kyc_rejected_count} Correction Needed`
                              : person.kyc_status === "under_review"
                              ? "Under Review"
                              : person.kyc_status === "not_started"
                              ? "Not Started"
                              : "Incomplete"}
                          </Badge>
                          <div className="text-[10px] font-mono text-muted-foreground">
                            {person.kyc_verified_count} of 5 verified
                          </div>
                        </div>
                      </td>

                      {/* Pending Actions */}
                      <td className="px-3 py-3">
                        {person.pending_actions && person.pending_actions.length > 0 ? (
                          <div className="space-y-1">
                            <span className="inline-flex items-center gap-1 rounded-full bg-red-50 dark:bg-red-950/40 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300">
                              <span className="size-1.5 rounded-full bg-red-500 animate-pulse" />
                              {person.pending_actions.length} action{person.pending_actions.length > 1 ? "s" : ""}
                            </span>
                            <div className="text-[10px] text-muted-foreground line-clamp-1">
                              {person.pending_actions[0]}
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>

                      {/* More Actions */}
                      <td className="px-3 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="size-8 p-0 text-muted-foreground hover:text-foreground"
                            >
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48 text-xs">
                            <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                              Actions
                            </DropdownMenuLabel>
                            <DropdownMenuItem onClick={() => onSelectEmployee(person.id)}>
                              <Eye className="size-3.5 mr-2" />
                              <span>View Quick Details</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                              <Link to="/workforce/$personId" params={{ personId: person.id }}>
                                <ExternalLink className="size-3.5 mr-2" />
                                <span>Full Profile Page</span>
                              </Link>
                            </DropdownMenuItem>

                            {person.account_status === "invited" && canManageWorkforce && (
                              <DropdownMenuItem
                                onClick={() => onSendSetupEmail(person.id, person.work_email)}
                              >
                                <Send className="size-3.5 mr-2" />
                                <span>Send Setup Email</span>
                              </DropdownMenuItem>
                            )}

                            {canManageWorkforce && !isRelieved && primaryRole !== "super_admin" && (
                              <DropdownMenuItem asChild>
                                <Link to={"/employee-relieving" as any} className="flex items-center cursor-pointer">
                                  <FileCheck2 className="size-3.5 mr-2 text-red-600" />
                                  <span>Initiate Relieving</span>
                                </Link>
                              </DropdownMenuItem>
                            )}
                            {isRelieved && (
                              <DropdownMenuItem asChild>
                                <Link to={"/employee-relieving" as any} className="flex items-center cursor-pointer">
                                  <FileCheck2 className="size-3.5 mr-2 text-purple-600" />
                                  <span>Relieving Letter</span>
                                </Link>
                              </DropdownMenuItem>
                            )}

                            {canManageWorkforce && (
                              <>
                                <DropdownMenuSeparator />
                                {isInactive ? (
                                  <DropdownMenuItem onClick={() => onReactivate(person.id)}>
                                    <UserCheck className="size-3.5 mr-2 text-emerald-600" />
                                    <span>Reactivate Account</span>
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem
                                    onClick={() =>
                                      onDeactivate({
                                        id: person.id,
                                        fullName: person.full_name,
                                        employeeCode: person.employee_code ?? null,
                                        workEmail: person.work_email,
                                        role: primaryRole,
                                        departmentName: person.department_name ?? null,
                                      })
                                    }
                                    className="text-amber-600 focus:text-amber-700 dark:text-amber-400"
                                  >
                                    <UserX className="size-3.5 mr-2" />
                                    <span>Deactivate Employee</span>
                                  </DropdownMenuItem>
                                )}

                                <DropdownMenuItem
                                  onClick={() =>
                                    onDelete({
                                      id: person.id,
                                      fullName: person.full_name,
                                      employeeCode: person.employee_code ?? null,
                                      workEmail: person.work_email,
                                    })
                                  }
                                  className="text-red-600 focus:text-red-700 dark:text-red-400"
                                >
                                  <Trash2 className="size-3.5 mr-2" />
                                  <span>Permanently Delete</span>
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Pagination Footer */}
      {sorted.length > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground pt-1">
          <div className="flex items-center gap-2">
            <span>Rows per page:</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
              className="h-7 rounded border border-input bg-background px-2 text-xs"
            >
              <option value="10">10</option>
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
            <span>
              Showing {startIndex + 1}–{Math.min(startIndex + pageSize, sorted.length)} of {sorted.length}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={currentPage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="h-8 w-8 p-0"
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="px-2 font-medium">
              Page {currentPage} of {totalPages}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={currentPage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="h-8 w-8 p-0"
              aria-label="Next page"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
