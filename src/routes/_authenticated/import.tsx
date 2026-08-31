import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { actorQueryOptions } from "@/hooks/use-actor";
import { errorToAccessScreen } from "@/components/access-denied";
import { supabase } from "@/integrations/supabase/client";
import {
  commitImport,
  getImportBatch,
  inviteImportedPeople,
  listImportBatches,
  resolveImportRow,
  stageImportBatch,
  type SheetPayload,
} from "@/lib/import.functions";
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

export const Route = createFileRoute("/_authenticated/import")({
  head: () => ({
    meta: [
      { title: "Legacy Import | The AI School HRM" },
      {
        name: "description",
        content:
          "Import historical attendance workbooks: preview every parsed cell, map unmatched people by hand, then commit.",
      },
      { property: "og:title", content: "Legacy Import | The AI School HRM" },
      {
        property: "og:description",
        content: "Staged, reviewable import of legacy attendance spreadsheets.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: ImportPage,
  errorComponent: ({ error }) => errorToAccessScreen(error),
});

type SheetDraft = { name: string; grid: (string | number | null)[][]; projectId: string | null };

function ImportPage() {
  const queryClient = useQueryClient();
  const { data: batches } = useSuspenseQuery({
    queryKey: ["import-batches"],
    queryFn: () => listImportBatches(),
  });
  const [fileName, setFileName] = useState("");
  const [sheets, setSheets] = useState<SheetDraft[]>([]);
  const [activeBatch, setActiveBatch] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: projects } = useQuery({
    queryKey: ["import-projects"],
    queryFn: async () => {
      const { data } = await supabase.from("projects").select("id, code, name").order("code");
      return data ?? [];
    },
  });
  const { data: people } = useQuery({
    queryKey: ["import-people"],
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name, work_email")
        .order("full_name");
      return data ?? [];
    },
  });
  const { data: batch } = useQuery({
    queryKey: ["import-batch", activeBatch],
    queryFn: () => getImportBatch({ data: { batchId: activeBatch! } }),
    enabled: Boolean(activeBatch),
  });

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(await file.arrayBuffer(), { cellDates: false });
      const drafts: SheetDraft[] = workbook.SheetNames.map((name) => ({
        name,
        grid: XLSX.utils.sheet_to_json(workbook.Sheets[name]!, {
          header: 1,
          raw: false,
          defval: "",
        }) as (string | number | null)[][],
        projectId: null,
      }));
      setFileName(file.name);
      setSheets(drafts);
      toast.success(`Read ${drafts.length} sheet(s) from ${file.name}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read that workbook.");
    } finally {
      setBusy(false);
    }
  }

  async function stage() {
    setBusy(true);
    try {
      const payload: SheetPayload[] = sheets.map((s) => ({
        name: s.name,
        grid: s.grid,
        projectId: s.projectId,
      }));
      const result = await stageImportBatch({ data: { fileName, sheets: payload } });
      toast.success(
        `Staged ${result.people} people — ${result.matched} auto-matched, ${result.needsMapping} need manual mapping.`,
      );
      setActiveBatch(result.batchId);
      setSheets([]);
      await queryClient.invalidateQueries({ queryKey: ["import-batches"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Staging failed.");
    } finally {
      setBusy(false);
    }
  }

  async function resolve(rowId: string, resolution: "mapped" | "create_new" | "skipped", userId?: string) {
    try {
      await resolveImportRow({ data: { rowId, resolution, matchedUserId: userId ?? null } });
      await queryClient.invalidateQueries({ queryKey: ["import-batch", activeBatch] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save that mapping.");
    }
  }

  async function invite() {
    setBusy(true);
    try {
      const result = await inviteImportedPeople({ data: { batchId: activeBatch! } });
      toast.success(`${result.queued} invitation(s) queued for throttled sending.`);
      await queryClient.invalidateQueries({ queryKey: ["import-batch", activeBatch] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not queue invitations.");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    try {
      const result = await commitImport({ data: { batchId: activeBatch! } });
      toast.success(
        `Committed ${result.attendanceRows} attendance row(s) and ${result.calendarRows} calendar entr(ies).`,
      );
      if (result.notes.length > 0) toast.message(result.notes.join(" "));
      await queryClient.invalidateQueries({ queryKey: ["import-batch", activeBatch] });
      await queryClient.invalidateQueries({ queryKey: ["import-batches"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Commit failed.");
    } finally {
      setBusy(false);
    }
  }

  const rows = batch?.rows ?? [];
  const unmapped = rows.filter((r) => r.resolution === "pending");

  return (
    <AppShell
      title="Legacy import"
      description="Historical attendance lands with source = import: it is visible in history but never triggers a live automation rule."
    >
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1 · Upload a workbook</CardTitle>
            <CardDescription>
              One sheet per project, one row per person, one column per date.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="workbook">Excel or CSV file</Label>
              <Input id="workbook" type="file" accept=".xlsx,.xls,.csv" onChange={onFile} />
            </div>

            {sheets.length > 0 && (
              <div className="space-y-3">
                <p className="text-sm font-medium">2 · Map each sheet to a project</p>
                {sheets.map((sheet, index) => (
                  <div key={sheet.name} className="flex flex-wrap items-center gap-3">
                    <span className="min-w-40 text-sm">{sheet.name}</span>
                    <Select
                      value={sheet.projectId ?? "none"}
                      onValueChange={(value) =>
                        setSheets((current) =>
                          current.map((s, i) =>
                            i === index ? { ...s, projectId: value === "none" ? null : value } : s,
                          ),
                        )
                      }
                    >
                      <SelectTrigger className="w-72">
                        <SelectValue placeholder="Project" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No project</SelectItem>
                        {(projects ?? []).map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.code} — {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
                <Button onClick={stage} disabled={busy}>
                  {busy ? "Parsing…" : "Parse and preview"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Batches</CardTitle>
            <CardDescription>Select a batch to review or commit it.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {batches.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing imported yet.</p>
            ) : (
              batches.map((b) => (
                <button
                  key={b.id}
                  onClick={() => setActiveBatch(b.id)}
                  className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-left text-sm ${
                    activeBatch === b.id ? "border-primary" : ""
                  }`}
                >
                  <span className="font-medium">{b.file_name}</span>
                  <span className="text-xs text-muted-foreground">
                    {b.date_from ?? "—"} → {b.date_to ?? "—"}
                  </span>
                  <Badge variant={b.status === "committed" ? "secondary" : "outline"}>{b.status}</Badge>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        {batch?.batch && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>3 · Preview</CardTitle>
                <CardDescription>
                  {rows.length} people ·{" "}
                  {Object.entries(batch.cellCounts)
                    .map(([kind, count]) => `${count} ${kind}`)
                    .join(" · ")}
                </CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="p-2">Person</th>
                      <th className="p-2">Identifier</th>
                      <th className="p-2">DOJ / LWD</th>
                      <th className="p-2">Cells</th>
                      <th className="p-2">Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 100).map((row) => {
                      const cells = batch.cells.filter((c) => c.row_id === row.id);
                      const invalid = cells.filter((c) => c.mapped_kind === "invalid").length;
                      const issues = row.date_issues as Record<string, string>;
                      return (
                        <tr key={row.id} className="border-b align-top">
                          <td className="p-2 font-medium">{row.raw_name || "—"}</td>
                          <td className="p-2 text-muted-foreground">{row.raw_identifier || "—"}</td>
                          <td className="p-2 text-xs">
                            {row.parsed_doj ?? row.raw_doj ?? "—"} / {row.parsed_lwd ?? row.raw_lwd ?? "—"}
                            {Object.values(issues ?? {}).map((issue) => (
                              <p key={issue} className="text-destructive">
                                {issue}
                              </p>
                            ))}
                          </td>
                          <td className="p-2 text-xs">
                            {cells.length} parsed
                            {invalid > 0 && (
                              <span className="text-destructive"> · {invalid} unreadable</span>
                            )}
                          </td>
                          <td className="p-2">
                            <Badge
                              variant={row.resolution === "pending" ? "destructive" : "secondary"}
                            >
                              {row.resolution}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>4 · Manual mapping queue</CardTitle>
                <CardDescription>
                  {unmapped.length} row(s) could not be matched automatically. Nothing commits for
                  them until you decide.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {unmapped.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Every row is resolved.</p>
                ) : (
                  unmapped.map((row) => (
                    <div key={row.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
                      <div className="min-w-48">
                        <p className="text-sm font-medium">{row.raw_name || "Unnamed"}</p>
                        <p className="text-xs text-muted-foreground">
                          {row.raw_identifier || "no identifier"} — {row.match_reason}
                        </p>
                      </div>
                      <Select onValueChange={(value) => resolve(row.id, "mapped", value)}>
                        <SelectTrigger className="w-72">
                          <SelectValue placeholder="Map to an existing account" />
                        </SelectTrigger>
                        <SelectContent>
                          {(people ?? []).map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.full_name} — {p.work_email}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button size="sm" variant="secondary" onClick={() => resolve(row.id, "create_new")}>
                        Invite as new
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => resolve(row.id, "skipped")}>
                        Skip
                      </Button>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>5 · Invite and commit</CardTitle>
                <CardDescription>
                  New people go through the normal throttled invitation queue and appear in Workforce
                  with an unassigned reporting lead.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-3">
                <Button variant="secondary" onClick={invite} disabled={busy}>
                  Queue invitations
                </Button>
                <Button onClick={commit} disabled={busy}>
                  {busy ? "Working…" : "Commit batch"}
                </Button>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
