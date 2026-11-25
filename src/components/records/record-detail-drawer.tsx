import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Building2,
  Calendar,
  CheckCircle2,
  Database,
  ExternalLink,
  FileCheck,
  FolderOpen,
  History,
  Link2,
  Lock,
  Plus,
  Save,
  ShieldCheck,
  User,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { describeUnknownError } from "@/lib/describe-error";
import {
  addEmploymentHistoryPeriod,
  getEmployeeRecordDetail,
  linkRecordToWorkforce,
  searchWorkforceForRecordLink,
  updateEmployeeRecord,
} from "@/lib/records.functions";
import {
  MISSING_FIELD_LABELS,
  RECORD_CATEGORY_LABELS,
  RECORD_DOCUMENT_SOURCE_LABELS,
  RECORD_EMPLOYMENT_CATEGORIES,
  RECORD_SOURCE_TYPE_LABELS,
  RECORD_WORK_TYPES,
  RECORD_WORK_TYPE_LABELS,
  type RecordEmploymentCategory,
  type RecordEmploymentStatus,
  type RecordWorkType,
} from "@/lib/records/types";

export function RecordDetailDrawer({
  recordId,
  open,
  onOpenChange,
  departments,
  onUpdated,
}: {
  recordId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  departments: { id: string; name: string }[];
  onUpdated: () => void;
}) {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("personal");

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["employee-record-detail", recordId],
    queryFn: () => getEmployeeRecordDetail({ data: { recordId: recordId! } }),
    enabled: Boolean(open && recordId),
  });

  const { data: linkCandidates } = useQuery({
    queryKey: ["records-workforce-link-candidates"],
    queryFn: () => searchWorkforceForRecordLink(),
    enabled: Boolean(open && data?.canManage && !data?.record.profileId),
  });

  // Editable form state for HR / Super Admin
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [personalEmail, setPersonalEmail] = useState("");
  const [organizationEmail, setOrganizationEmail] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [address, setAddress] = useState("");
  const [joiningDate, setJoiningDate] = useState("");
  const [lastWorkingDate, setLastWorkingDate] = useState("");
  const [employmentStatus, setEmploymentStatus] = useState<RecordEmploymentStatus>("inactive");
  const [employmentCategory, setEmploymentCategory] =
    useState<RecordEmploymentCategory>("unknown");
  const [workType, setWorkType] = useState<RecordWorkType>("unknown");
  const [departmentId, setDepartmentId] = useState("");
  const [designation, setDesignation] = useState("");
  const [driveFolderUrl, setDriveFolderUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // Add History period state
  const [showAddHistory, setShowAddHistory] = useState(false);
  const [histStart, setHistStart] = useState("");
  const [histEnd, setHistEnd] = useState("");
  const [histDesig, setHistDesig] = useState("");
  const [histCategory, setHistCategory] = useState<RecordEmploymentCategory>("full_time");
  const [histWorkType, setHistWorkType] = useState<RecordWorkType>("annotation");
  const [histDept, setHistDept] = useState("");
  const [histStatus, setHistStatus] = useState<"active" | "completed" | "relieved" | "inactive" | "transferred">("completed");
  const [histIsCurrent, setHistIsCurrent] = useState(false);

  // Workforce link selection
  const [linkProfileId, setLinkProfileId] = useState("");
  const [driveAccessWarning, setDriveAccessWarning] = useState(false);

  useEffect(() => {
    if (!data?.record) return;
    const r = data.record;
    setFirstName(r.firstName);
    setLastName(r.lastName ?? "");
    setPersonalEmail(r.personalEmail ?? "");
    setOrganizationEmail(r.organizationEmail ?? "");
    setPhoneNumber(r.phoneNumber ?? "");
    setAddress(r.address ?? "");
    setJoiningDate(r.joiningDate ?? "");
    setLastWorkingDate(r.lastWorkingDate ?? "");
    setEmploymentStatus(r.employmentStatus);
    setEmploymentCategory(r.employmentCategory);
    setWorkType(r.workType);
    setDepartmentId(r.departmentId ?? "");
    setDesignation(r.designation ?? "");
    setDriveFolderUrl(r.driveFolderUrl ?? "");
    setNotes(r.notes ?? "");
    setDriveAccessWarning(false);
  }, [data?.record]);

  if (!open || !recordId) return null;

  const rec = data?.record;
  const canManage = Boolean(data?.canManage);
  const canViewConfidential = Boolean(data?.canViewConfidential);

  async function handleSaveChanges(resolveReview = false) {
    if (!recordId) return;
    try {
      setSaving(true);
      await updateEmployeeRecord({
        data: {
          recordId,
          firstName,
          lastName: lastName || null,
          personalEmail: personalEmail || null,
          organizationEmail: organizationEmail || null,
          phoneNumber: phoneNumber || null,
          address: address || null,
          joiningDate: joiningDate || null,
          lastWorkingDate: lastWorkingDate || null,
          employmentStatus,
          employmentCategory,
          workType,
          departmentId: departmentId || null,
          designation: designation || null,
          driveFolderUrl: driveFolderUrl || null,
          notes: notes || null,
          resolveReview,
        },
      });
      toast.success(resolveReview ? "Record updated and marked verified." : "Record updated.");
      await refetch();
      await queryClient.invalidateQueries({ queryKey: ["employee-records"] });
      onUpdated();
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleAddHistory(e: React.FormEvent) {
    e.preventDefault();
    if (!recordId) return;
    try {
      setSaving(true);
      await addEmploymentHistoryPeriod({
        data: {
          recordId,
          startDate: histStart || null,
          endDate: histEnd || null,
          designation: histDesig || null,
          employmentCategory: histCategory,
          workType: histWorkType,
          departmentName: histDept || null,
          status: histStatus,
          isCurrent: histIsCurrent,
        },
      });
      toast.success("Employment period added to history.");
      setShowAddHistory(false);
      setHistStart("");
      setHistEnd("");
      setHistDesig("");
      await refetch();
      onUpdated();
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleLinkWorkforce() {
    if (!recordId || !linkProfileId) return;
    try {
      setSaving(true);
      await linkRecordToWorkforce({
        data: { recordId, profileId: linkProfileId },
      });
      toast.success("Historical record linked to verified Workforce profile.");
      setLinkProfileId("");
      await refetch();
      await queryClient.invalidateQueries({ queryKey: ["employee-records"] });
      onUpdated();
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto p-5 sm:p-6">
        {isLoading || !rec ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Loading employee master record...
          </div>
        ) : (
          <div className="space-y-5">
            <SheetHeader className="border-b border-border pb-4 space-y-2">
              <div className="flex flex-wrap items-start justify-between gap-2 pr-6">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <SheetTitle className="text-xl font-bold text-zinc-900 dark:text-zinc-50">
                      {rec.displayName}
                    </SheetTitle>
                    <Badge
                      className={
                        rec.employmentStatus === "active"
                          ? "bg-emerald-600 text-white"
                          : "bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
                      }
                    >
                      {rec.employmentStatus === "active" ? "ACTIVE" : "INACTIVE"}
                    </Badge>
                    {!canManage && (
                      <Badge variant="outline" className="text-[11px] border-zinc-400">
                        <Lock className="mr-1 size-3" /> Read-Only
                      </Badge>
                    )}
                  </div>
                  <SheetDescription className="text-xs mt-1 flex flex-wrap items-center gap-2">
                    <code className="font-mono font-semibold text-red-700 dark:text-red-400">
                      {rec.historicalRecordCode}
                    </code>
                    {rec.tasEmployeeCode && (
                      <code className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                        Workforce ID: {rec.tasEmployeeCode}
                      </code>
                    )}
                    <span>•</span>
                    <span>{RECORD_SOURCE_TYPE_LABELS[rec.sourceType]}</span>
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>

            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
              <TabsList className="grid grid-cols-3 sm:grid-cols-6 h-auto gap-1 p-1">
                <TabsTrigger value="personal" className="text-[11px] py-1.5">
                  Personal
                </TabsTrigger>
                <TabsTrigger value="history" className="text-[11px] py-1.5">
                  History
                </TabsTrigger>
                <TabsTrigger value="workforce" className="text-[11px] py-1.5">
                  Workforce
                </TabsTrigger>
                <TabsTrigger value="documents" className="text-[11px] py-1.5">
                  Documents
                </TabsTrigger>
                <TabsTrigger value="meta" className="text-[11px] py-1.5">
                  Status
                </TabsTrigger>
                <TabsTrigger value="audit" className="text-[11px] py-1.5">
                  Audit
                </TabsTrigger>
              </TabsList>

              {/* SECTION 1: PERSONAL INFORMATION */}
              <TabsContent value="personal" className="space-y-4 pt-3">
                {!canViewConfidential && (
                  <div className="rounded-md border border-zinc-200 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
                    <Lock className="size-3.5 shrink-0" />
                    Personal email, phone number, home address, and confidential folder URLs are hidden under Executive Read-Only privacy rules.
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">First Name</Label>
                    {canManage ? (
                      <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                    ) : (
                      <p className="text-sm font-medium">{rec.firstName}</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Last Name</Label>
                    {canManage ? (
                      <Input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="—" />
                    ) : (
                      <p className="text-sm font-medium">{rec.lastName || "—"}</p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Organization Email (TAS Mail)</Label>
                    {canManage ? (
                      <Input
                        value={organizationEmail}
                        onChange={(e) => setOrganizationEmail(e.target.value)}
                        placeholder="—"
                      />
                    ) : (
                      <p className="text-sm font-medium">{rec.organizationEmail || "—"}</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Personal Email</Label>
                    {canViewConfidential ? (
                      canManage ? (
                        <Input
                          value={personalEmail}
                          onChange={(e) => setPersonalEmail(e.target.value)}
                          placeholder="—"
                        />
                      ) : (
                        <p className="text-sm font-medium">{rec.personalEmail || "—"}</p>
                      )
                    ) : (
                      <p className="text-xs italic text-muted-foreground">Restricted</p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Phone Number</Label>
                    {canViewConfidential ? (
                      canManage ? (
                        <Input
                          value={phoneNumber}
                          onChange={(e) => setPhoneNumber(e.target.value)}
                          placeholder="—"
                        />
                      ) : (
                        <p className="text-sm font-medium">{rec.phoneNumber || "—"}</p>
                      )
                    ) : (
                      <p className="text-xs italic text-muted-foreground">Restricted</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Employment Status</Label>
                    {canManage ? (
                      <select
                        value={employmentStatus}
                        onChange={(e) => setEmploymentStatus(e.target.value as RecordEmploymentStatus)}
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                      >
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                      </select>
                    ) : (
                      <p className="text-sm font-semibold uppercase">{rec.employmentStatus}</p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Joining Date (DOJ)</Label>
                    {canManage ? (
                      <Input type="date" value={joiningDate} onChange={(e) => setJoiningDate(e.target.value)} />
                    ) : (
                      <p className="text-sm font-medium">{rec.joiningDate || "—"}</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Last Working Date (LWD)</Label>
                    {canManage ? (
                      <Input type="date" value={lastWorkingDate} onChange={(e) => setLastWorkingDate(e.target.value)} />
                    ) : (
                      <p className="text-sm font-medium">{rec.lastWorkingDate || "—"}</p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Employment Category</Label>
                    {canManage ? (
                      <select
                        value={employmentCategory}
                        onChange={(e) => setEmploymentCategory(e.target.value as RecordEmploymentCategory)}
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                      >
                        {RECORD_EMPLOYMENT_CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {RECORD_CATEGORY_LABELS[c]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="text-sm font-medium">{RECORD_CATEGORY_LABELS[rec.employmentCategory]}</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Work Type</Label>
                    {canManage ? (
                      <select
                        value={workType}
                        onChange={(e) => setWorkType(e.target.value as RecordWorkType)}
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                      >
                        {RECORD_WORK_TYPES.map((w) => (
                          <option key={w} value={w}>
                            {RECORD_WORK_TYPE_LABELS[w]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="text-sm font-medium">{RECORD_WORK_TYPE_LABELS[rec.workType]}</p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Department</Label>
                    {canManage ? (
                      <select
                        value={departmentId}
                        onChange={(e) => setDepartmentId(e.target.value)}
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                      >
                        <option value="">Unknown / Unassigned</option>
                        {departments.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="text-sm font-medium">{rec.departmentName || "—"}</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Designation</Label>
                    {canManage ? (
                      <Input value={designation} onChange={(e) => setDesignation(e.target.value)} placeholder="—" />
                    ) : (
                      <p className="text-sm font-medium">{rec.designation || "—"}</p>
                    )}
                  </div>
                </div>

                {canViewConfidential && (
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Address</Label>
                    {canManage ? (
                      <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="—" />
                    ) : (
                      <p className="text-sm font-medium">{rec.address || "—"}</p>
                    )}
                  </div>
                )}

                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Notes</Label>
                  {canManage ? (
                    <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
                  ) : (
                    <p className="text-sm">{rec.notes || "—"}</p>
                  )}
                </div>

                {canManage && (
                  <div className="flex justify-end gap-2 pt-2 border-t border-border">
                    {(rec.needsReview || rec.statusNeedsReview) && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleSaveChanges(true)}
                        disabled={saving}
                      >
                        <CheckCircle2 className="mr-1.5 size-3.5 text-emerald-600" />
                        Save &amp; Mark Verified
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => handleSaveChanges(false)}
                      disabled={saving}
                      className="bg-zinc-900 hover:bg-zinc-800 text-white"
                    >
                      <Save className="mr-1.5 size-3.5" />
                      {saving ? "Saving..." : "Save Changes"}
                    </Button>
                  </div>
                )}
              </TabsContent>

              {/* SECTION 2: EMPLOYMENT HISTORY */}
              <TabsContent value="history" className="space-y-4 pt-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-sm font-semibold">Employment Periods &amp; Role Transitions</h4>
                    <p className="text-xs text-muted-foreground">
                      Previous tenures are never overwritten when an employee changes roles or rejoins.
                    </p>
                  </div>
                  {canManage && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setShowAddHistory((v) => !v)}
                    >
                      <Plus className="mr-1.5 size-3.5" /> Add Tenure Period
                    </Button>
                  )}
                </div>

                {showAddHistory && canManage && (
                  <Card className="p-3 space-y-3 border-zinc-300">
                    <form onSubmit={handleAddHistory} className="space-y-3">
                      <div className="grid grid-cols-2 gap-2.5">
                        <div>
                          <Label className="text-[11px]">Start Date</Label>
                          <Input type="date" value={histStart} onChange={(e) => setHistStart(e.target.value)} />
                        </div>
                        <div>
                          <Label className="text-[11px]">End Date</Label>
                          <Input type="date" value={histEnd} onChange={(e) => setHistEnd(e.target.value)} />
                        </div>
                        <div>
                          <Label className="text-[11px]">Designation</Label>
                          <Input value={histDesig} onChange={(e) => setHistDesig(e.target.value)} placeholder="e.g. Senior Annotator" />
                        </div>
                        <div>
                          <Label className="text-[11px]">Department</Label>
                          <Input value={histDept} onChange={(e) => setHistDept(e.target.value)} placeholder="e.g. Annotation" />
                        </div>
                        <div>
                          <Label className="text-[11px]">Category</Label>
                          <select
                            value={histCategory}
                            onChange={(e) => setHistCategory(e.target.value as RecordEmploymentCategory)}
                            className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                          >
                            {RECORD_EMPLOYMENT_CATEGORIES.map((c) => (
                              <option key={c} value={c}>{RECORD_CATEGORY_LABELS[c]}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <Label className="text-[11px]">Work Type</Label>
                          <select
                            value={histWorkType}
                            onChange={(e) => setHistWorkType(e.target.value as RecordWorkType)}
                            className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                          >
                            {RECORD_WORK_TYPES.map((w) => (
                              <option key={w} value={w}>{RECORD_WORK_TYPE_LABELS[w]}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <Label className="text-[11px]">Period Status</Label>
                          <select
                            value={histStatus}
                            onChange={(e) => setHistStatus(e.target.value as typeof histStatus)}
                            className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                          >
                            <option value="completed">Completed</option>
                            <option value="relieved">Relieved</option>
                            <option value="transferred">Transferred</option>
                            <option value="inactive">Inactive</option>
                            <option value="active">Active</option>
                          </select>
                        </div>
                        <div className="flex items-end pb-2">
                          <label className="flex items-center gap-2 text-xs cursor-pointer">
                            <input
                              type="checkbox"
                              checked={histIsCurrent}
                              onChange={(e) => setHistIsCurrent(e.target.checked)}
                            />
                            Mark as Current Tenure
                          </label>
                        </div>
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button type="button" size="sm" variant="ghost" onClick={() => setShowAddHistory(false)}>
                          Cancel
                        </Button>
                        <Button type="submit" size="sm" disabled={saving}>
                          Save Period
                        </Button>
                      </div>
                    </form>
                  </Card>
                )}

                <div className="space-y-2.5">
                  {data.employmentHistory.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-4 text-center border border-dashed rounded">
                      No separate tenure entries logged yet.
                    </p>
                  ) : (
                    data.employmentHistory.map((p) => (
                      <Card key={p.id} className="p-3 space-y-1.5 border-border">
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-semibold text-sm flex items-center gap-2">
                            <span>{p.designation || "Role Unspecified"}</span>
                            {p.isCurrent && (
                              <Badge className="bg-red-600 text-white text-[10px]">Current</Badge>
                            )}
                          </div>
                          <Badge variant="outline" className="text-[10px] uppercase">
                            {p.status}
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-3">
                          <span className="flex items-center gap-1">
                            <Calendar className="size-3" />
                            {p.startDate || "Unknown"} → {p.endDate || "Present / Open"}
                          </span>
                          <span>• {RECORD_CATEGORY_LABELS[p.employmentCategory]}</span>
                          <span>• {RECORD_WORK_TYPE_LABELS[p.workType]}</span>
                          {p.departmentName && (
                            <span className="flex items-center gap-1">
                              <Building2 className="size-3" /> {p.departmentName}
                            </span>
                          )}
                        </div>
                      </Card>
                    ))
                  )}
                </div>
              </TabsContent>

              {/* SECTION 3: CURRENT WORKFORCE LINK */}
              <TabsContent value="workforce" className="space-y-4 pt-3">
                {data.workforceProfile ? (
                  <Card className="p-4 space-y-3 border-emerald-200 bg-emerald-50/40 dark:bg-emerald-950/20">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="size-4 text-emerald-600" />
                        <span className="font-semibold text-sm">Linked to Verified HRM Workforce</span>
                      </div>
                      <Badge variant="outline" className="font-mono text-xs">
                        {data.workforceProfile.employeeCode || "No Code"}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-muted-foreground">Name:</span>{" "}
                        <span className="font-medium">{data.workforceProfile.fullName}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Work Email:</span>{" "}
                        <span className="font-medium">{data.workforceProfile.workEmail}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Account Status:</span>{" "}
                        <span className="font-medium uppercase">{data.workforceProfile.accountStatus}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Employment Status:</span>{" "}
                        <span className="font-medium uppercase">{data.workforceProfile.employmentStatus}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Department:</span>{" "}
                        <span className="font-medium">{data.workforceProfile.departmentName || "—"}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Designation:</span>{" "}
                        <span className="font-medium">{data.workforceProfile.designation || "—"}</span>
                      </div>
                    </div>
                    <div className="pt-1">
                      <Link
                        to="/workforce"
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 hover:underline"
                      >
                        <User className="size-3.5" /> Open Workforce Directory
                      </Link>
                    </div>
                  </Card>
                ) : (
                  <Card className="p-4 space-y-3">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <Database className="size-4 text-zinc-600" />
                      Historical / Archival Record Only
                    </div>
                    <p className="text-xs text-muted-foreground">
                      This employee does not have an HRM login account. Archival records do not generate Auth credentials or setup emails.
                    </p>
                    {canManage && (
                      <div className="space-y-2 pt-2 border-t border-border">
                        <Label className="text-xs">Match &amp; Link to Existing Workforce Employee</Label>
                        <div className="flex gap-2">
                          <select
                            value={linkProfileId}
                            onChange={(e) => setLinkProfileId(e.target.value)}
                            className="flex h-9 flex-1 rounded-md border border-input bg-background px-2 text-xs"
                          >
                            <option value="">Select Workforce employee to link...</option>
                            {(linkCandidates?.profiles ?? []).map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.fullName} ({p.employeeCode || "No ID"}) — {p.workEmail}
                              </option>
                            ))}
                          </select>
                          <Button
                            type="button"
                            size="sm"
                            disabled={!linkProfileId || saving}
                            onClick={handleLinkWorkforce}
                          >
                            <Link2 className="mr-1.5 size-3.5" /> Link
                          </Button>
                        </div>
                      </div>
                    )}
                  </Card>
                )}
              </TabsContent>

              {/* SECTION 4: DOCUMENTS (GOOGLE DRIVE + HRM KYC) */}
              <TabsContent value="documents" className="space-y-4 pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 bg-muted/30">
                  <div>
                    <div className="text-xs font-semibold text-foreground">Document Source Classification</div>
                    <div className="text-[11px] text-muted-foreground">
                      Historical Google Drive folders and verified HRM KYC records are stored separately and never overwrite each other.
                    </div>
                  </div>
                  <Badge variant="outline" className="font-mono text-xs">
                    {RECORD_DOCUMENT_SOURCE_LABELS[rec.documentSource]}
                  </Badge>
                </div>

                {/* Historical Google Drive Folder Section */}
                <Card className="p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold text-sm flex items-center gap-2">
                      <FolderOpen className="size-4 text-red-600" />
                      Documents Folder (Historical Google Drive)
                    </div>
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {rec.driveMatchStatus}
                    </Badge>
                  </div>

                  {!canViewConfidential ? (
                    <div className="rounded border border-zinc-200 bg-zinc-50 dark:bg-zinc-900 p-3 text-xs text-muted-foreground space-y-1">
                      <div className="font-medium text-foreground">
                        Availability Status: {rec.hasDriveFolder ? "Historical Drive Folder Linked" : "No Historical Folder Linked"}
                      </div>
                      <p>
                        Raw Google Drive folder links are restricted to authorized HR and Super Admin to protect confidential KYC &amp; banking files.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {rec.driveFolderUrl ? (
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-muted/20 p-2.5">
                            <span className="text-xs font-mono truncate max-w-[360px]">
                              {rec.driveFolderUrl}
                            </span>
                            <a
                              href={rec.driveFolderUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={() => setDriveAccessWarning(true)}
                            >
                              <Button type="button" size="sm" className="bg-zinc-900 hover:bg-zinc-800 text-white h-7 text-xs">
                                <ExternalLink className="mr-1.5 size-3" /> Open Historical Documents
                              </Button>
                            </a>
                          </div>
                          {driveAccessWarning && (
                            <div className="rounded border border-amber-200 bg-amber-50/70 px-3 py-2 text-[11px] text-amber-900 flex items-start gap-2">
                              <AlertTriangle className="size-3.5 shrink-0 mt-0.5 text-amber-600" />
                              <span>
                                Opened with your signed-in Google account. If Google Drive displays &ldquo;You need access&rdquo;, request folder permission on{" "}
                                <strong>TAS &lt;&gt; EMP &lt;&gt; RECORD</strong> from your Drive administrator — HRM never alters Drive sharing permissions.
                              </span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          No historical Google Drive folder URL stored for this employee.
                        </p>
                      )}

                      {canManage && (
                        <div className="flex gap-2 pt-2 border-t border-border">
                          <Input
                            value={driveFolderUrl}
                            onChange={(e) => setDriveFolderUrl(e.target.value)}
                            placeholder="https://drive.google.com/drive/folders/..."
                            className="text-xs h-8"
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => handleSaveChanges(false)}
                            disabled={saving}
                            className="h-8 text-xs shrink-0"
                          >
                            Save Link
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </Card>

                {/* HRM KYC Section */}
                <Card className="p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold text-sm flex items-center gap-2">
                      <FileCheck className="size-4 text-emerald-600" />
                      HRM Onboarding KYC Documents
                    </div>
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {rec.kycSummary?.status ?? (rec.profileId ? "not_started" : "historical_only")}
                    </Badge>
                  </div>

                  {rec.profileId ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-5 gap-2 text-center">
                        <div className="rounded border p-2">
                          <div className="text-sm font-bold">{rec.kycSummary?.requiredCount ?? 5}</div>
                          <div className="text-[10px] text-muted-foreground">Required</div>
                        </div>
                        <div className="rounded border p-2">
                          <div className="text-sm font-bold">{rec.kycSummary?.uploadedCount ?? 0}</div>
                          <div className="text-[10px] text-muted-foreground">Uploaded</div>
                        </div>
                        <div className="rounded border p-2">
                          <div className="text-sm font-bold text-amber-600">{rec.kycSummary?.pendingCount ?? 0}</div>
                          <div className="text-[10px] text-muted-foreground">Pending</div>
                        </div>
                        <div className="rounded border p-2">
                          <div className="text-sm font-bold text-emerald-600">{rec.kycSummary?.verifiedCount ?? 0}</div>
                          <div className="text-[10px] text-muted-foreground">Verified</div>
                        </div>
                        <div className="rounded border p-2">
                          <div className="text-sm font-bold text-red-600">{rec.kycSummary?.rejectedCount ?? 0}</div>
                          <div className="text-[10px] text-muted-foreground">Rejected</div>
                        </div>
                      </div>

                      {canViewConfidential && data.kycDocuments.length > 0 && (
                        <div className="space-y-1 text-xs">
                          <div className="font-medium text-muted-foreground">Uploaded KYC Documents:</div>
                          {data.kycDocuments.map((d) => (
                            <div key={d.id} className="flex items-center justify-between border rounded px-2.5 py-1.5">
                              <span>{d.docType} — <span className="text-muted-foreground">{d.fileName}</span></span>
                              <Badge variant="outline" className="text-[10px] uppercase">{d.status}</Badge>
                            </div>
                          ))}
                        </div>
                      )}

                      {canManage && (
                        <div className="flex justify-end">
                          <Link
                            to="/workforce"
                            className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 hover:underline"
                          >
                            Review &amp; Verify KYC in Workforce →
                          </Link>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      This archival record is not linked to an HRM Workforce account. Historical Google Drive folders are tracked as archival availability and are never automatically marked KYC-verified.
                    </p>
                  )}
                </Card>
              </TabsContent>

              {/* SECTION 5: SOURCE, COMPLETENESS & REVIEW */}
              <TabsContent value="meta" className="space-y-4 pt-3">
                <Card className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold flex items-center gap-2">
                      <ShieldCheck className="size-4 text-zinc-700" />
                      Completeness &amp; Verification Status
                    </span>
                    <Badge variant="outline" className="font-mono">
                      {rec.recordCompleteness}% Complete
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-muted-foreground">Source Type:</span>{" "}
                      <span className="font-medium">{RECORD_SOURCE_TYPE_LABELS[rec.sourceType]}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Match Confidence:</span>{" "}
                      <span className="font-medium uppercase">{rec.matchConfidence}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Status Source:</span>{" "}
                      <span className="font-medium">{rec.statusSource}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Last Synced:</span>{" "}
                      <span className="font-medium">
                        {rec.lastSyncedAt ? new Date(rec.lastSyncedAt).toLocaleString() : "—"}
                      </span>
                    </div>
                  </div>
                  {rec.missingFields.length > 0 && (
                    <div className="space-y-1.5 pt-2 border-t border-border">
                      <div className="text-xs font-medium text-amber-700">Missing Fields:</div>
                      <div className="flex flex-wrap gap-1.5">
                        {rec.missingFields.map((f) => (
                          <Badge key={f} variant="outline" className="text-[10px] border-amber-300 text-amber-800">
                            {MISSING_FIELD_LABELS[f] ?? f}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {rec.reviewReasons.length > 0 && (
                    <div className="space-y-1 pt-2 border-t border-border">
                      <div className="text-xs font-medium text-red-700">Review Notes:</div>
                      <ul className="list-disc pl-4 text-xs text-red-700 space-y-0.5">
                        {rec.reviewReasons.map((reason, i) => (
                          <li key={i}>{reason}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </Card>
              </TabsContent>

              {/* SECTION 6: AUDIT HISTORY */}
              <TabsContent value="audit" className="space-y-3 pt-3">
                {!canManage ? (
                  <p className="text-xs text-muted-foreground">
                    Detailed change audit logs are restricted to HR and Super Admin governance.
                  </p>
                ) : data.auditHistory.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-6 text-center border border-dashed rounded">
                    No audit entries recorded for this record yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {data.auditHistory.map((a) => (
                      <div key={a.id} className="rounded border border-border p-2.5 text-xs space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold flex items-center gap-1.5">
                            <History className="size-3 text-muted-foreground" /> {a.action}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {new Date(a.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          Actor: {a.actorEmail || "System"}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
