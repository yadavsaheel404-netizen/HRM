import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, Pencil, UserPlus, Users } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { useNotificationFocus } from "@/hooks/use-notification-focus";
import { errorToAccessScreen } from "@/components/access-denied";
import { PROJECT_SHIFT_LABELS, optionsOf } from "@/lib/enums";
import { getProject, updateProject } from "@/lib/projects.functions";
import { getAllocatableEmployees } from "@/lib/allocations.functions";
import { getOrgReference } from "@/lib/workforce.functions";
import { ProjectAllocationTabs } from "@/components/projects/project-allocation-tabs";
import { TeamAllocationsTable } from "@/components/projects/team-allocations-table";
import {
  projectUsesProductionTargets,
  WORK_TYPE_LABELS,
  WORK_TYPES,
  workTypeLabel,
} from "@/lib/work-type";
import { todayIso } from "@/lib/timezone";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/projects/$projectId")({
  head: () => ({
    meta: [
      { title: "Project detail | The AI School HRM" },
      {
        name: "description",
        content:
          "Project terms, delivery targets, staffing and assignment acknowledgment status for a single AI School project.",
      },
      { property: "og:title", content: "Project detail | The AI School HRM" },
      {
        property: "og:description",
        content: "Project terms, targets, staffing and acknowledgment status.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: ProjectDetailPage,
  errorComponent: ({ error }) => errorToAccessScreen(error),
});

type OverAllocation = {
  usedPct: number;
  newPct: number;
  total: number;
  conflicts: string[];
};

function parseOverAllocation(error: unknown): OverAllocation | null {
  const message = error instanceof Error ? error.message : "";
  const marker = message.indexOf("OVER_ALLOCATION::");
  if (marker === -1) return null;
  try {
    return JSON.parse(message.slice(marker + "OVER_ALLOCATION::".length)) as OverAllocation;
  } catch {
    return null;
  }
}

function ProjectDetailPage() {
  const { projectId } = Route.useParams();
  const search = useSearch({ strict: false }) as { section?: string; allocationId?: string };
  const actor = useActor();
  const queryClient = useQueryClient();
  useNotificationFocus(
    search.allocationId || (search.section ? `section-${search.section}` : null),
  );

  const { data } = useSuspenseQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: { id: projectId } }),
  });
  const { data: reference } = useSuspenseQuery({
    queryKey: ["org-reference"],
    queryFn: () => getOrgReference(),
  });

  const isScopedManager =
    data.project.project_manager_id === actor.userId ||
    (data.project as { created_by?: string | null }).created_by === actor.userId ||
    Boolean(
      data.project.department_id &&
        reference.departmentManagers.some(
          (dm) => dm.department_id === data.project.department_id && dm.manager_id === actor.userId,
        ),
    );

  const canManageAllocations =
    actor.can("allocations:manage:all") ||
    (actor.can("allocations:manage:team") && isScopedManager);
  const canManageProject =
    actor.can("projects:manage:all") ||
    (actor.can("projects:manage:team") && isScopedManager);

  const { data: allocatableData } = useQuery({
    queryKey: ["allocatable-employees", projectId],
    queryFn: () => getAllocatableEmployees({ data: { projectId } }),
    enabled: Boolean(canManageAllocations),
  });

  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editForm, setEditForm] = useState(() => ({
    name: data.project.name,
    clientName: data.project.client_name ?? "",
    description: data.project.description ?? "",
    startDate: data.project.start_date ?? "",
    endDate: data.project.end_date ?? "",
    departmentId: data.project.department_id ?? "",
    projectManagerId: data.project.project_manager_id ?? "",
    status: data.project.status,
    workMode: data.project.work_mode,
    shift: data.project.shift ?? "",
    taskUnit: data.project.task_unit,
    hourlyTaskTarget: data.project.hourly_task_target?.toString() ?? "",
    dailyTaskTarget: data.project.daily_task_target?.toString() ?? "",
    qualityTargetPct: data.project.quality_target_pct?.toString() ?? "",
    maxRejectionRatePct: data.project.max_rejection_rate_pct?.toString() ?? "",
    requiredHeadcount: data.project.required_headcount?.toString() ?? "1",
    projectLeadId: data.project.project_lead_id ?? "",
    teamLeadIds: data.teamLeads.map((l) => l.id),
    workType: (data.project.work_type as string | null) ?? "",
  }));

  useEffect(() => {
    setEditForm({
      name: data.project.name,
      clientName: data.project.client_name ?? "",
      description: data.project.description ?? "",
      startDate: data.project.start_date ?? "",
      endDate: data.project.end_date ?? "",
      departmentId: data.project.department_id ?? "",
      projectManagerId: data.project.project_manager_id ?? "",
      status: data.project.status,
      workMode: data.project.work_mode,
      shift: data.project.shift ?? "",
      taskUnit: data.project.task_unit,
      hourlyTaskTarget: data.project.hourly_task_target?.toString() ?? "",
      dailyTaskTarget: data.project.daily_task_target?.toString() ?? "",
      qualityTargetPct: data.project.quality_target_pct?.toString() ?? "",
      maxRejectionRatePct: data.project.max_rejection_rate_pct?.toString() ?? "",
      requiredHeadcount: data.project.required_headcount?.toString() ?? "1",
      projectLeadId: data.project.project_lead_id ?? "",
      teamLeadIds: data.teamLeads.map((l) => l.id),
      workType: (data.project.work_type as string | null) ?? "",
    });
  }, [data.project, data.teamLeads]);

  const project = data.project;
  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  async function saveProjectEdits() {
    const editTargets = !editForm.workType || projectUsesProductionTargets(editForm.workType);
    setBusy(true);
    try {
      await updateProject({
        data: {
          id: projectId,
          name: editForm.name,
          clientName: editForm.clientName || null,
          description: editForm.description || null,
          startDate: editForm.startDate || null,
          endDate: editForm.endDate || null,
          departmentId: editForm.departmentId || null,
          projectManagerId: editForm.projectManagerId || null,
          status: editForm.status,
          workMode: editForm.workMode,
          shift: editForm.shift || null,
          taskUnit: editForm.taskUnit,
          hourlyTaskTarget: editTargets ? num(editForm.hourlyTaskTarget) : null,
          dailyTaskTarget: editTargets ? num(editForm.dailyTaskTarget) : null,
          qualityTargetPct: editTargets ? num(editForm.qualityTargetPct) : null,
          maxRejectionRatePct: editTargets ? num(editForm.maxRejectionRatePct) : null,
          requiredHeadcount: Number(editForm.requiredHeadcount || 1),
          projectLeadId: editForm.projectLeadId || null,
          teamLeadIds: editForm.teamLeadIds,
          workType: editForm.workType || null,
        },
      });
      toast.success("Project terms and leads updated.");
      setEditOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update project.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell
      title={project.name}
      description={`${project.code}${project.client_name ? ` · ${project.client_name}` : ""}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="ghost">
            <Link to="/projects">
              <ArrowLeft className="mr-1.5 size-4" />
              Projects
            </Link>
          </Button>
          {canManageProject ? (
            <Button size="sm" variant="outline" onClick={() => setEditOpen((v) => !v)}>
              <Pencil className="mr-1.5 size-3.5" />
              {editOpen ? "Close edit" : "Edit project"}
            </Button>
          ) : null}
          {canManageAllocations ? (
            <Button size="sm" onClick={() => setOpen((v) => !v)}>
              <UserPlus className="size-4" />
              {open ? "Close allocation" : "Allocate team members"}
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="space-y-6">
        <Card className="border-border/80 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="text-base font-semibold">Project Terms &amp; Settings</CardTitle>
                <CardDescription className="text-xs">
                  Operational mode, staffing requirements, targets, and delivery leads.
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
                  Headcount: {data.allocations.filter((a) => a.status !== "ended").length}/{project.required_headcount}
                </span>
                <Badge variant="outline" className="capitalize text-xs">
                  {project.status.replace("_", " ")}
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {project.description ? (
              <p className="mb-4 rounded-md bg-muted/40 p-2.5 text-xs text-muted-foreground">
                {project.description}
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 text-xs">
              <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                <span className="block text-muted-foreground">Work Mode</span>
                <span className="font-semibold text-foreground capitalize">{project.work_mode}</span>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                <span className="block text-muted-foreground">Shift</span>
                <span className="font-semibold text-foreground">{project.shift ?? "No fixed shift"}</span>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                <span className="block text-muted-foreground">Work Type</span>
                <span className="font-semibold text-foreground">{workTypeLabel(project.work_type as string | null)}</span>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                <span className="block text-muted-foreground">Department</span>
                <span className="font-semibold text-foreground">
                  {reference.departments.find((d) => d.id === project.department_id)?.name ?? "—"}
                </span>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                <span className="block text-muted-foreground">Project Manager</span>
                <span className="font-semibold text-foreground">{data.projectManager?.full_name ?? "—"}</span>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                <span className="block text-muted-foreground">Project Lead</span>
                <span className="font-semibold text-foreground">{data.projectLead?.full_name ?? "—"}</span>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                <span className="block text-muted-foreground">Team Leads</span>
                <span className="font-semibold text-foreground">
                  {data.teamLeads.length ? data.teamLeads.map((l) => l.full_name).join(", ") : "—"}
                </span>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                <span className="block text-muted-foreground">Timeline</span>
                <span className="font-semibold text-foreground font-mono">{project.start_date ?? "—"} → {project.end_date ?? "open"}</span>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                <span className="block text-muted-foreground">Task Unit</span>
                <span className="font-semibold text-foreground">{project.task_unit}</span>
              </div>
              {!project.work_type || projectUsesProductionTargets(project.work_type as string) ? (
                <>
                  <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                    <span className="block text-muted-foreground">Hourly Target</span>
                    <span className="font-semibold text-foreground font-mono">{project.hourly_task_target ?? "—"}</span>
                  </div>
                  <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                    <span className="block text-muted-foreground">Daily Target</span>
                    <span className="font-semibold text-foreground font-mono">{project.daily_task_target ?? "—"}</span>
                  </div>
                  <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                    <span className="block text-muted-foreground">Quality Target</span>
                    <span className="font-semibold text-foreground font-mono">{project.quality_target_pct ? `${project.quality_target_pct}%` : "—"}</span>
                  </div>
                  <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                    <span className="block text-muted-foreground">Max Rejection</span>
                    <span className="font-semibold text-foreground font-mono">{project.max_rejection_rate_pct ? `${project.max_rejection_rate_pct}%` : "—"}</span>
                  </div>
                </>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {canManageProject && editOpen ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Edit project &amp; leads</CardTitle>
                <CardDescription>
                  Update project targets, work mode, primary project lead and assigned team leads.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <LabelledInput
                    label="Project name"
                    value={editForm.name}
                    onChange={(v) => setEditForm({ ...editForm, name: v })}
                  />
                  <LabelledInput
                    label="Client name"
                    value={editForm.clientName}
                    onChange={(v) => setEditForm({ ...editForm, clientName: v })}
                  />
                  <div className="space-y-1.5 md:col-span-2">
                    <Label htmlFor="edit-proj-desc" className="text-xs text-muted-foreground">
                      Description
                    </Label>
                    <Textarea
                      id="edit-proj-desc"
                      rows={2}
                      value={editForm.description}
                      onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                    />
                  </div>
                  <LabelledInput
                    label="Start date"
                    type="date"
                    value={editForm.startDate}
                    onChange={(v) => setEditForm({ ...editForm, startDate: v })}
                  />
                  <LabelledInput
                    label="End date"
                    type="date"
                    value={editForm.endDate}
                    onChange={(v) => setEditForm({ ...editForm, endDate: v })}
                  />
                  <div className="space-y-1.5">
                    <Label htmlFor="edit-proj-worktype" className="text-xs text-muted-foreground">
                      Work type
                    </Label>
                    <select
                      id="edit-proj-worktype"
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={editForm.workType}
                      onChange={(e) => setEditForm({ ...editForm, workType: e.target.value })}
                    >
                      <option value="" disabled={Boolean(project.work_type)}>
                        Unclassified
                      </option>
                      {WORK_TYPES.map((wt) => (
                        <option key={wt} value={wt}>
                          {WORK_TYPE_LABELS[wt]}
                        </option>
                      ))}
                    </select>
                  </div>                  <div className="space-y-1.5">
                    <Label htmlFor="edit-proj-status" className="text-xs text-muted-foreground">
                      Status
                    </Label>
                    <select
                      id="edit-proj-status"
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={editForm.status}
                      onChange={(e) =>
                        setEditForm({
                          ...editForm,
                          status: e.target.value as
                            | "draft"
                            | "active"
                            | "on_hold"
                            | "completed"
                            | "archived",
                        })
                      }
                    >
                      <option value="draft">Draft</option>
                      <option value="active">Active</option>
                      <option value="on_hold">On hold</option>
                      <option value="completed">Completed</option>
                      <option value="archived">Archived</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="edit-proj-workmode" className="text-xs text-muted-foreground">
                      Work mode
                    </Label>
                    <select
                      id="edit-proj-workmode"
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={editForm.workMode}
                      onChange={(e) =>
                        setEditForm({
                          ...editForm,
                          workMode: e.target.value as "onsite" | "remote" | "hybrid",
                        })
                      }
                    >
                      <option value="onsite">Onsite</option>
                      <option value="remote">Remote</option>
                      <option value="hybrid">Hybrid</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="edit-proj-shift" className="text-xs text-muted-foreground">
                      Shift
                    </Label>
                    <select
                      id="edit-proj-shift"
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={editForm.shift}
                      onChange={(e) => setEditForm({ ...editForm, shift: e.target.value })}
                    >
                      <option value="">No fixed shift</option>
                      {optionsOf(PROJECT_SHIFT_LABELS).map((sh) => (
                        <option key={sh.value} value={sh.value}>
                          {sh.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <LabelledInput
                    label="Task unit"
                    value={editForm.taskUnit}
                    onChange={(v) => setEditForm({ ...editForm, taskUnit: v })}
                  />
                  <LabelledInput
                    label="Required headcount"
                    type="number"
                    value={editForm.requiredHeadcount}
                    onChange={(v) => setEditForm({ ...editForm, requiredHeadcount: v })}
                  />
                  {!editForm.workType || projectUsesProductionTargets(editForm.workType) ? (
                    <>
                  <LabelledInput
                    label="Hourly target"
                    type="number"
                    value={editForm.hourlyTaskTarget}
                    onChange={(v) => setEditForm({ ...editForm, hourlyTaskTarget: v })}
                  />
                  <LabelledInput
                    label="Daily target"
                    type="number"
                    value={editForm.dailyTaskTarget}
                    onChange={(v) => setEditForm({ ...editForm, dailyTaskTarget: v })}
                  />
                  <LabelledInput
                    label="Quality target %"
                    type="number"
                    value={editForm.qualityTargetPct}
                    onChange={(v) => setEditForm({ ...editForm, qualityTargetPct: v })}
                  />
                  <LabelledInput
                    label="Max rejection %"
                    type="number"
                    value={editForm.maxRejectionRatePct}
                    onChange={(v) => setEditForm({ ...editForm, maxRejectionRatePct: v })}
                  />
                    </>
                  ) : null}
                  <div className="space-y-1.5">
                    <Label htmlFor="edit-proj-department" className="text-xs text-muted-foreground">
                      Department
                    </Label>
                    <select
                      id="edit-proj-department"
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={editForm.departmentId}
                      onChange={(e) => setEditForm({ ...editForm, departmentId: e.target.value })}
                    >
                      <option value="">No department</option>
                      {reference.departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="edit-proj-manager" className="text-xs text-muted-foreground">
                      Project manager
                    </Label>
                    <select
                      id="edit-proj-manager"
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={editForm.projectManagerId}
                      onChange={(e) =>
                        setEditForm({ ...editForm, projectManagerId: e.target.value })
                      }
                    >
                      <option value="">No project manager</option>
                      {reference.people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.full_name}
                          {p.designation ? ` — ${p.designation}` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5 md:col-span-2">
                    <Label htmlFor="edit-proj-lead" className="text-xs text-muted-foreground">
                      Project lead
                    </Label>
                    <select
                      id="edit-proj-lead"
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={editForm.projectLeadId}
                      onChange={(e) => setEditForm({ ...editForm, projectLeadId: e.target.value })}
                    >
                      <option value="">No project lead</option>
                      {reference.people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.full_name}
                          {p.designation ? ` — ${p.designation}` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5 md:col-span-2">
                    <span className="block text-xs font-medium text-muted-foreground">
                      Team leads on this project
                    </span>
                    <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto rounded-md border p-2.5">
                      {reference.people.map((p) => {
                        const checked = editForm.teamLeadIds.includes(p.id);
                        return (
                          <label
                            key={p.id}
                            className="flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1 text-xs hover:bg-muted/40"
                          >
                            <input
                              type="checkbox"
                              className="accent-primary"
                              checked={checked}
                              onChange={(e) => {
                                const next = e.target.checked
                                  ? [...editForm.teamLeadIds, p.id]
                                  : editForm.teamLeadIds.filter((id) => id !== p.id);
                                setEditForm({ ...editForm, teamLeadIds: next });
                              }}
                            />
                            <span>{p.full_name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <Button onClick={saveProjectEdits} disabled={busy || !editForm.name.trim()}>
                  Save project changes
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {canManageAllocations && open ? (
            <ProjectAllocationTabs
              projectId={projectId}
              projectName={project.name}
              projectWorkType={project.work_type}
              employees={allocatableData?.employees ?? []}
              availableLeads={allocatableData?.availableLeads ?? []}
              departments={allocatableData?.departments ?? []}
              onClose={() => setOpen(false)}
              onRefresh={async () => {
                await Promise.all([
                  queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
                  queryClient.invalidateQueries({ queryKey: ["allocatable-employees", projectId] }),
                  queryClient.invalidateQueries({ queryKey: ["org-reference"] }),
                ]);
              }}
            />
          ) : null}

          <div data-focus-id="section-allocations">
            <TeamAllocationsTable
              projectId={projectId}
              projectName={project.name}
              projectDepartmentId={project.department_id}
              projectDepartmentName={
                reference.departments.find((d) => d.id === project.department_id)?.name ?? null
              }
              projectWorkType={project.work_type}
              allocations={data.allocations as any}
              availableLeads={allocatableData?.availableLeads ?? []}
              canManage={canManageAllocations}
              onRefresh={async () => {
                await Promise.all([
                  queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
                  queryClient.invalidateQueries({ queryKey: ["allocatable-employees", projectId] }),
                  queryClient.invalidateQueries({ queryKey: ["org-reference"] }),
                ]);
              }}
            />
          </div>
      </div>
    </AppShell>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right font-medium capitalize">{value}</span>
    </div>
  );
}

function LabelledInput({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
