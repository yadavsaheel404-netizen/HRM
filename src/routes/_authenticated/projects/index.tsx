import {
  PROJECT_SHIFT_LABELS,
  PROJECT_WORK_MODE_LABELS,
  TASK_UNIT_LABELS,
  optionsOf,
} from "@/lib/enums";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { FolderKanban, Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { errorToAccessScreen } from "@/components/access-denied";
import { createProject, listProjects } from "@/lib/projects.functions";
import { getOrgReference } from "@/lib/workforce.functions";
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

const PROJECT_WORK_MODES = optionsOf(PROJECT_WORK_MODE_LABELS);
const PROJECT_SHIFTS = optionsOf(PROJECT_SHIFT_LABELS);
const TASK_UNIT_OPTIONS = optionsOf(TASK_UNIT_LABELS);

export const Route = createFileRoute("/_authenticated/projects/")({
  head: () => ({
    meta: [
      { title: "Projects | The AI School HRM" },
      {
        name: "description",
        content:
          "Client projects, delivery targets and staffing for The AI School — headcount, allocation and acknowledgment at a glance.",
      },
      { property: "og:title", content: "Projects | The AI School HRM" },
      {
        property: "og:description",
        content: "Client projects, delivery targets and staffing for The AI School.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: ProjectsPage,
  errorComponent: ({ error }) => errorToAccessScreen(error),
});

const STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  active: "bg-emerald-100 text-emerald-800",
  on_hold: "bg-amber-100 text-amber-900",
  completed: "bg-sky-100 text-sky-900",
  archived: "bg-muted text-muted-foreground",
};

function ProjectsPage() {
  const actor = useActor();
  const queryClient = useQueryClient();
  const canManage = actor.can("projects:manage:all");
  const { data: projects } = useSuspenseQuery({
    queryKey: ["projects"],
    queryFn: () => listProjects(),
  });
  const { data: reference } = useSuspenseQuery({
    queryKey: ["org-reference"],
    queryFn: () => getOrgReference(),
  });

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    code: "",
    name: "",
    clientName: "",
    description: "",
    startDate: "",
    endDate: "",
    projectLeadId: "",
    workMode: "remote",
    shift: "",
    taskUnit: "task",
    hourlyTaskTarget: "",
    dailyTaskTarget: "",
    qualityTargetPct: "",
    maxRejectionRatePct: "",
    requiredHeadcount: "1",
    status: "active",
  });

  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await createProject({
        data: {
          code: form.code,
          name: form.name,
          clientName: form.clientName || null,
          description: form.description || null,
          startDate: form.startDate || null,
          endDate: form.endDate || null,
          projectLeadId: form.projectLeadId || null,
          workMode: form.workMode,
          shift: form.shift || null,
          taskUnit: form.taskUnit,
          hourlyTaskTarget: num(form.hourlyTaskTarget),
          dailyTaskTarget: num(form.dailyTaskTarget),
          qualityTargetPct: num(form.qualityTargetPct),
          maxRejectionRatePct: num(form.maxRejectionRatePct),
          requiredHeadcount: Number(form.requiredHeadcount || 0),
          status: form.status,
        },
      });
      toast.success("Project created.");
      setOpen(false);
      setForm({ ...form, code: "", name: "", clientName: "", description: "" });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the project.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell
      title="Projects"
      description="Client delivery work, its targets and who is staffed on it."
      actions={
        canManage ? (
          <Button size="sm" onClick={() => setOpen((v) => !v)}>
            <Plus className="size-4" />
            {open ? "Close" : "New project"}
          </Button>
        ) : null
      }
    >
      {canManage && open ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">New project</CardTitle>
            <CardDescription>Targets set here become the default for everyone allocated to it.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="grid gap-4 md:grid-cols-3">
              <Field label="Project code">
                <Input id="code" required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
              </Field>
              <Field label="Project name">
                <Input id="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label="Client">
                <Input id="clientName" value={form.clientName} onChange={(e) => setForm({ ...form, clientName: e.target.value })} />
              </Field>
              <div className="md:col-span-3">
                <Field label="Description">
                  <Textarea id="description" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </Field>
              </div>
              <Field label="Start date">
                <Input id="startDate" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
              </Field>
              <Field label="End date">
                <Input id="endDate" type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
              </Field>
              <Field label="Project lead">
                <Select value={form.projectLeadId} onValueChange={(v) => setForm({ ...form, projectLeadId: v })}>
                  <SelectTrigger><SelectValue placeholder="Select a lead" /></SelectTrigger>
                  <SelectContent>
                    {reference.people.map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Work mode">
                <Select value={form.workMode} onValueChange={(v) => setForm({ ...form, workMode: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PROJECT_WORK_MODES.map((m) => (
                      <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Shift">
                <Select value={form.shift} onValueChange={(v) => setForm({ ...form, shift: v })}>
                  <SelectTrigger id="shift"><SelectValue placeholder="Select shift" /></SelectTrigger>
                  <SelectContent>
                    {PROJECT_SHIFTS.map((sh) => (
                      <SelectItem key={sh.value} value={sh.value}>{sh.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Task unit">
                <Select value={form.taskUnit} onValueChange={(v) => setForm({ ...form, taskUnit: v })}>
                  <SelectTrigger id="taskUnit"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TASK_UNIT_OPTIONS.map((u) => (
                      <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Hourly task target">
                <Input id="hourlyTaskTarget" type="number" step="0.01" value={form.hourlyTaskTarget} onChange={(e) => setForm({ ...form, hourlyTaskTarget: e.target.value })} />
              </Field>
              <Field label="Daily task target">
                <Input id="dailyTaskTarget" type="number" step="0.01" value={form.dailyTaskTarget} onChange={(e) => setForm({ ...form, dailyTaskTarget: e.target.value })} />
              </Field>
              <Field label="Quality target %">
                <Input id="qualityTargetPct" type="number" step="0.01" value={form.qualityTargetPct} onChange={(e) => setForm({ ...form, qualityTargetPct: e.target.value })} />
              </Field>
              <Field label="Max rejection rate %">
                <Input id="maxRejectionRatePct" type="number" step="0.01" value={form.maxRejectionRatePct} onChange={(e) => setForm({ ...form, maxRejectionRatePct: e.target.value })} />
              </Field>
              <Field label="Required headcount">
                <Input id="requiredHeadcount" type="number" value={form.requiredHeadcount} onChange={(e) => setForm({ ...form, requiredHeadcount: e.target.value })} />
              </Field>
              <div className="md:col-span-3">
                <Button type="submit" disabled={busy}>Create project</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {projects.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
            <FolderKanban className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {canManage ? "No projects yet. Create the first one." : "You are not on any project yet."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <Link key={project.id} to="/projects/$projectId" params={{ projectId: project.id }}>
              <Card className="h-full transition-colors hover:border-primary/40">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-base">{project.name}</CardTitle>
                      <CardDescription>
                        {project.code}
                        {project.client_name ? ` · ${project.client_name}` : ""}
                      </CardDescription>
                    </div>
                    <Badge className={STATUS_TONE[project.status] ?? ""} variant="secondary">
                      {project.status.replace("_", " ")}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-1.5 text-sm text-muted-foreground">
                  <p>
                    Staffed{" "}
                    <span className="font-medium text-foreground tabular-nums">
                      {project.allocated_count}/{project.required_headcount}
                    </span>
                  </p>
                  {project.daily_task_target ? (
                    <p>
                      Daily target{" "}
                      <span className="font-medium text-foreground tabular-nums">
                        {project.daily_task_target} {project.task_unit}
                      </span>
                    </p>
                  ) : null}
                  {project.pending_ack_count > 0 ? (
                    <p className="text-amber-700">
                      {project.pending_ack_count} awaiting acknowledgment
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </AppShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
