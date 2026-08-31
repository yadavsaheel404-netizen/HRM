import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, UserPlus } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { errorToAccessScreen } from "@/components/access-denied";
import { getProject } from "@/lib/projects.functions";
import { createAllocation, endAllocation, getAllocationLoad } from "@/lib/allocations.functions";
import { getOrgReference } from "@/lib/workforce.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  const actor = useActor();
  const queryClient = useQueryClient();
  const canManageAllocations = actor.can("allocations:manage:all");

  const { data } = useSuspenseQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: { id: projectId } }),
  });
  const { data: reference } = useSuspenseQuery({
    queryKey: ["org-reference"],
    queryFn: () => getOrgReference(),
  });

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<OverAllocation | null>(null);
  const [load, setLoad] = useState<{ usedPct: number } | null>(null);
  const [form, setForm] = useState({
    userId: "",
    reportingLeadId: "",
    roleInProject: "",
    startDate: new Date().toISOString().slice(0, 10),
    endDate: "",
    hoursPerDay: "8",
    allocationPct: "100",
    dailyTaskTarget: "",
    qualityTargetPct: "",
    maxRejectionRatePct: "",
  });

  const project = data.project;
  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  async function pickPerson(userId: string) {
    setForm((f) => ({ ...f, userId }));
    setWarning(null);
    try {
      const result = await getAllocationLoad({ data: { userId } });
      setLoad({ usedPct: result.usedPct });
    } catch {
      setLoad(null);
    }
  }

  async function submit(override: boolean) {
    setBusy(true);
    try {
      const result = await createAllocation({
        data: {
          projectId,
          userId: form.userId,
          reportingLeadId: form.reportingLeadId || null,
          roleInProject: form.roleInProject || null,
          startDate: form.startDate || null,
          endDate: form.endDate || null,
          hoursPerDay: Number(form.hoursPerDay || 8),
          allocationPct: Number(form.allocationPct || 100),
          dailyTaskTarget: num(form.dailyTaskTarget),
          qualityTargetPct: num(form.qualityTargetPct),
          maxRejectionRatePct: num(form.maxRejectionRatePct),
          overAllocationOverride: override,
        },
      });
      toast.success(
        result.overAllocated
          ? `Allocated at ${result.totalPct}% total — this person is over-allocated.`
          : "Allocated. Waiting on their acknowledgment.",
      );
      setWarning(null);
      setOpen(false);
      setForm((f) => ({ ...f, userId: "", roleInProject: "" }));
      setLoad(null);
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    } catch (error) {
      const over = parseOverAllocation(error);
      if (over) {
        setWarning(over);
      } else {
        toast.error(error instanceof Error ? error.message : "Could not allocate.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function end(id: string) {
    try {
      await endAllocation({ data: { id } });
      toast.success("Allocation ended.");
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not end the allocation.");
    }
  }

  return (
    <AppShell
      title={project.name}
      description={`${project.code}${project.client_name ? ` · ${project.client_name}` : ""}`}
      actions={
        canManageAllocations ? (
          <Button size="sm" onClick={() => setOpen((v) => !v)}>
            <UserPlus className="size-4" />
            {open ? "Close" : "Allocate someone"}
          </Button>
        ) : null
      }
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Terms</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Status" value={project.status.replace("_", " ")} />
            <Row label="Work mode" value={project.work_mode} />
            <Row label="Shift" value={project.shift ?? "—"} />
            <Row label="Task unit" value={project.task_unit} />
            <Row label="Hourly target" value={project.hourly_task_target ?? "—"} />
            <Row label="Daily target" value={project.daily_task_target ?? "—"} />
            <Row label="Quality target" value={project.quality_target_pct ? `${project.quality_target_pct}%` : "—"} />
            <Row label="Max rejection" value={project.max_rejection_rate_pct ? `${project.max_rejection_rate_pct}%` : "—"} />
            <Row label="Headcount" value={`${data.allocations.filter((a) => a.status !== "ended").length}/${project.required_headcount}`} />
            <Row label="Dates" value={`${project.start_date ?? "—"} → ${project.end_date ?? "open"}`} />
            <Row label="Project lead" value={data.projectLead?.full_name ?? "—"} />
            <Row
              label="Team leads"
              value={data.teamLeads.length ? data.teamLeads.map((l) => l.full_name).join(", ") : "—"}
            />
          </CardContent>
        </Card>

        <div className="space-y-4 lg:col-span-2">
          {canManageAllocations && open ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Allocate someone</CardTitle>
                <CardDescription>
                  They must acknowledge the assignment before they can log any work against it.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Person</Label>
                    <Select value={form.userId} onValueChange={pickPerson}>
                      <SelectTrigger><SelectValue placeholder="Select a person" /></SelectTrigger>
                      <SelectContent>
                        {reference.people.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.full_name}
                            {p.designation ? ` — ${p.designation}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {load ? (
                      <p className="text-xs text-muted-foreground">
                        Currently allocated {load.usedPct}% across live projects.
                      </p>
                    ) : null}
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Reporting lead on this project</Label>
                    <Select value={form.reportingLeadId} onValueChange={(v) => setForm({ ...form, reportingLeadId: v })}>
                      <SelectTrigger><SelectValue placeholder="Select a lead" /></SelectTrigger>
                      <SelectContent>
                        {reference.people.map((p) => (
                          <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <LabelledInput label="Role in project" value={form.roleInProject} onChange={(v) => setForm({ ...form, roleInProject: v })} />
                  <LabelledInput label="Allocation %" type="number" value={form.allocationPct} onChange={(v) => setForm({ ...form, allocationPct: v })} />
                  <LabelledInput label="Hours / day" type="number" value={form.hoursPerDay} onChange={(v) => setForm({ ...form, hoursPerDay: v })} />
                  <LabelledInput label="Start date" type="date" value={form.startDate} onChange={(v) => setForm({ ...form, startDate: v })} />
                  <LabelledInput label="End date" type="date" value={form.endDate} onChange={(v) => setForm({ ...form, endDate: v })} />
                  <LabelledInput label="Daily task target" type="number" value={form.dailyTaskTarget} onChange={(v) => setForm({ ...form, dailyTaskTarget: v })} />
                  <LabelledInput label="Quality target %" type="number" value={form.qualityTargetPct} onChange={(v) => setForm({ ...form, qualityTargetPct: v })} />
                  <LabelledInput label="Max rejection %" type="number" value={form.maxRejectionRatePct} onChange={(v) => setForm({ ...form, maxRejectionRatePct: v })} />
                </div>

                {warning ? (
                  <div
                    role="alert"
                    data-testid="over-allocation-warning"
                    className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
                  >
                    <p className="flex items-center gap-2 font-semibold">
                      <AlertTriangle className="size-4" />
                      Over-allocation: this would put them at {warning.total}%
                    </p>
                    <p className="mt-1">
                      Already allocated {warning.usedPct}% ({warning.conflicts.join(", ")}); adding{" "}
                      {warning.newPct}% exceeds 100% of their capacity.
                    </p>
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => setWarning(null)} disabled={busy}>
                        Cancel
                      </Button>
                      <Button size="sm" onClick={() => submit(true)} disabled={busy}>
                        Allocate anyway
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button onClick={() => submit(false)} disabled={busy || !form.userId}>
                    Allocate
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Team</CardTitle>
              <CardDescription>Acknowledgment is recorded per person with a timestamp.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {data.allocations.length === 0 ? (
                <p className="px-6 py-8 text-center text-sm text-muted-foreground">
                  Nobody is allocated to this project yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Person</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead className="text-right">Alloc</TableHead>
                      <TableHead>Acknowledged</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.allocations.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>
                          <div className="font-medium">{a.person?.full_name ?? "Unknown"}</div>
                          <div className="text-xs text-muted-foreground">
                            Lead: {a.reportingLead?.full_name ?? "—"}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {a.role_in_project ?? "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{a.allocation_pct}%</TableCell>
                        <TableCell>
                          {a.acknowledged_at ? (
                            <Badge variant="secondary" className="bg-emerald-100 text-emerald-800">
                              {new Date(a.acknowledged_at).toLocaleString()}
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="bg-amber-100 text-amber-900">
                              Pending
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {canManageAllocations && a.status !== "ended" ? (
                            <Button size="sm" variant="ghost" onClick={() => end(a.id)}>
                              End
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
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
  const id = `alloc-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
