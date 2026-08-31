import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { AccessDenied, errorToAccessScreen } from "@/components/access-denied";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { downloadCsv, toCsv } from "@/lib/csv";
import { downloadXlsx, reportFileName } from "@/lib/xlsx-export";
import { ATTENDANCE_WORK_MODE_LABELS } from "@/lib/enums";
import { buildAttendanceReport, getReportFilterOptions } from "@/lib/reports.functions";

export const Route = createFileRoute("/_authenticated/reports")({
  head: () => ({
    meta: [
      { title: "Attendance Reports | The AI School HRM" },
      {
        name: "description",
        content:
          "Employee-wise and project-wise attendance exports with productive hours, targets and geofence status.",
      },
      { property: "og:title", content: "Attendance Reports | The AI School HRM" },
      {
        property: "og:description",
        content: "Filtered CSV and Excel attendance exports built from live daily-cycle metrics.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: ReportsPage,
  errorComponent: ({ error }) => errorToAccessScreen(error),
});

const ALL = "__all__";
const CATEGORIES = [
  ["full_time", "Full time"],
  ["intern", "Intern"],
  ["freelancer", "Freelancer"],
  ["trainer", "Trainer"],
] as const;

function monthStart() {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

function ReportsPage() {
  useSuspenseQuery(actorQueryOptions);
  const actor = useActor();
  const allowed =
    actor.can("attendance:read:all") &&
    actor.roles.some((r) => ["super_admin", "admin", "hr"].includes(r));

  const [type, setType] = useState<"employee" | "project">("employee");
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [projectId, setProjectId] = useState(ALL);
  const [departmentId, setDepartmentId] = useState(ALL);
  const [category, setCategory] = useState(ALL);
  const [userId, setUserId] = useState(ALL);
  const [workMode, setWorkMode] = useState(ALL);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Record<string, string | number | null>[] | null>(null);

  const { data: options } = useQuery({
    queryKey: ["report-options"],
    queryFn: () => getReportFilterOptions(),
    enabled: allowed,
  });

  if (!allowed) {
    return (
      <AccessDenied
        kind="forbidden"
        detail="Attendance exports are available to Super Admin, Admin and HR only."
      />
    );
  }

  const filter = {
    from,
    to,
    projectIds: projectId === ALL ? null : [projectId],
    departmentIds: departmentId === ALL ? null : [departmentId],
    categories: category === ALL ? null : [category],
    userIds: userId === ALL ? null : [userId],
    workModes: workMode === ALL ? null : [workMode],
  };

  async function generate(): Promise<Record<string, string | number | null>[] | null> {
    setBusy(true);
    try {
      const result = await buildAttendanceReport({ data: { type, filter } });
      setPreview(result.rows);
      if (result.rows.length === 0) toast.info("No attendance rows matched those filters.");
      return result.rows;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The export could not be generated.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  const prefix = type === "employee" ? "employee_attendance" : "project_attendance";

  async function exportCsv() {
    const rows = preview ?? (await generate());
    if (!rows?.length) return;
    const columns = Object.keys(rows[0]!).map((key) => ({
      key,
      header: key,
      value: (row: Record<string, string | number | null>) => row[key],
    }));
    downloadCsv(reportFileName(prefix, from, to, "csv"), toCsv(rows, columns));
  }

  async function exportXlsx() {
    const rows = preview ?? (await generate());
    if (!rows?.length) return;
    await downloadXlsx(
      reportFileName(prefix, from, to, "xlsx"),
      type === "employee" ? "Employee Attendance" : "Project Attendance",
      rows,
    );
  }

  const headers = preview?.[0] ? Object.keys(preview[0]) : [];

  return (
    <AppShell
      title="Attendance reports"
      description="Employee-wise and project-wise exports built from the same metrics the dashboards use."
    >
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Export options</CardTitle>
            <CardDescription>
              The date range is required; every other filter is optional.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Export type</Label>
              <Select value={type} onValueChange={(v) => { setType(v as typeof type); setPreview(null); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="employee">Employee-wise attendance</SelectItem>
                  <SelectItem value="project">Project-wise attendance</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="from">From</Label>
              <Input id="from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPreview(null); }} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="to">To</Label>
              <Input id="to" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPreview(null); }} />
            </div>

            <div className="space-y-1.5">
              <Label>Project</Label>
              <Select value={projectId} onValueChange={(v) => { setProjectId(v); setPreview(null); }}>
                <SelectTrigger><SelectValue placeholder="All projects" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All projects</SelectItem>
                  {(options?.projects ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.code} — {p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Department</Label>
              <Select value={departmentId} onValueChange={(v) => { setDepartmentId(v); setPreview(null); }}>
                <SelectTrigger><SelectValue placeholder="All departments" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All departments</SelectItem>
                  {(options?.departments ?? []).map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Employment type</Label>
              <Select value={category} onValueChange={(v) => { setCategory(v); setPreview(null); }}>
                <SelectTrigger><SelectValue placeholder="All types" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All types</SelectItem>
                  {CATEGORIES.map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Employee</Label>
              <Select value={userId} onValueChange={(v) => { setUserId(v); setPreview(null); }}>
                <SelectTrigger><SelectValue placeholder="Everyone" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Everyone</SelectItem>
                  {(options?.people ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Work mode</Label>
              <Select value={workMode} onValueChange={(v) => { setWorkMode(v); setPreview(null); }}>
                <SelectTrigger><SelectValue placeholder="All modes" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All modes</SelectItem>
                  {Object.entries(ATTENDANCE_WORK_MODE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-2">
              <Button onClick={() => void generate()} disabled={busy}>Generate preview</Button>
            </div>
          </CardContent>
        </Card>

        {preview ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{preview.length} rows</CardTitle>
              <CardDescription>Showing the first 25 rows; the export contains all of them.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void exportCsv()} disabled={busy || preview.length === 0}>
                  <Download className="mr-1.5 size-4" /> Download CSV
                </Button>
                <Button size="sm" variant="outline" onClick={() => void exportXlsx()} disabled={busy || preview.length === 0}>
                  <Download className="mr-1.5 size-4" /> Download Excel
                </Button>
              </div>
              <div className="max-h-[28rem] overflow-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted text-left uppercase tracking-wide">
                    <tr>{headers.map((h) => <th key={h} className="whitespace-nowrap px-2 py-2">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {preview.slice(0, 25).map((row, i) => (
                      <tr key={i} className={i % 2 ? "bg-muted/40" : undefined}>
                        {headers.map((h) => (
                          <td key={h} className="whitespace-nowrap px-2 py-1.5">{row[h] ?? ""}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </AppShell>
  );
}
