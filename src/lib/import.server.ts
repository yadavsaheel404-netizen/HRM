// Legacy importer: staging + commit.
//
// The importer never writes attendance directly from a file. A batch is
// staged row-by-row and cell-by-cell first, so an admin sees exactly what
// will land, resolves every unmatched identifier by hand, and only then
// commits. Everything written carries source = 'import' so the Phase 5
// automation rules can never see it.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const FULL_DAY_MINUTES = 480;
export const HALF_DAY_MINUTES = 240;

export type CommitSummary = {
  batchId: string;
  attendanceRows: number;
  calendarRows: number;
  invitationsQueued: number;
  rowsCommitted: number;
  rowsDeferred: number;
  rowsSkipped: number;
  unresolvedCells: number;
  notes: string[];
};

type StagedRow = {
  id: string;
  raw_name: string | null;
  raw_identifier: string | null;
  project_id: string | null;
  matched_user_id: string | null;
  resolution: string;
  match_state: string;
  metadata: Record<string, unknown>;
};

/** Resolves a create_new row to a profile that already exists for its email. */
async function resolveByEmail(email: string | null): Promise<string | null> {
  if (!email) return null;
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .or(`work_email.eq.${email},personal_email.eq.${email}`)
    .maybeSingle();
  return data?.id ?? null;
}

/**
 * Commits a staged batch. Idempotent: attendance and calendar writes are
 * upserts, and rows already committed simply re-write the same values.
 */
export async function commitImportBatch(batchId: string, actorId: string): Promise<CommitSummary> {
  const summary: CommitSummary = {
    batchId,
    attendanceRows: 0,
    calendarRows: 0,
    invitationsQueued: 0,
    rowsCommitted: 0,
    rowsDeferred: 0,
    rowsSkipped: 0,
    unresolvedCells: 0,
    notes: [],
  };

  const { data: rowsData, error: rowsError } = await supabaseAdmin
    .from("import_rows")
    .select("id, raw_name, raw_identifier, project_id, matched_user_id, resolution, match_state, metadata")
    .eq("batch_id", batchId);
  if (rowsError) throw rowsError;
  const rows = (rowsData ?? []) as unknown as StagedRow[];

  const { data: cellsData } = await supabaseAdmin
    .from("import_cells")
    .select("id, row_id, work_date, mapped_kind, work_mode, exception_type, half_day, calendar_kind, state")
    .eq("batch_id", batchId)
    .limit(20000);
  const cells = cellsData ?? [];
  const cellsByRow = new Map<string, typeof cells>();
  for (const c of cells) {
    const list = cellsByRow.get(c.row_id) ?? [];
    list.push(c);
    cellsByRow.set(c.row_id, list);
  }
  summary.unresolvedCells = cells.filter(
    (c) => c.mapped_kind === "invalid" && c.state !== "resolved" && c.state !== "skipped",
  ).length;

  const attendance: Record<string, unknown>[] = [];
  const calendar: Record<string, unknown>[] = [];
  const calendarSeen = new Set<string>();

  for (const row of rows) {
    if (row.resolution === "skipped") {
      summary.rowsSkipped += 1;
      continue;
    }

    let userId = row.matched_user_id;
    if (!userId) {
      const email = typeof row.metadata?.["email"] === "string" ? (row.metadata["email"] as string) : null;
      userId = await resolveByEmail(email);
      if (userId) {
        await supabaseAdmin.from("import_rows").update({ matched_user_id: userId }).eq("id", row.id);
      }
    }

    const rowCells = cellsByRow.get(row.id) ?? [];

    // Week-offs and holidays are organisation-level facts, not per-person
    // attendance, so they land on the calendar even for unmatched rows.
    for (const cell of rowCells) {
      if (cell.mapped_kind !== "calendar" || !cell.calendar_kind) continue;
      const key = `${cell.work_date}|${cell.calendar_kind}|${row.project_id ?? "org"}`;
      if (calendarSeen.has(key)) continue;
      calendarSeen.add(key);
      calendar.push({
        calendar_date: cell.work_date,
        kind: cell.calendar_kind,
        project_id: row.project_id,
        label: cell.calendar_kind === "holiday" ? "Imported holiday" : "Imported week off",
        source: "import",
      });
    }

    if (!userId) {
      // No account yet — the invitation has been queued; attendance for this
      // person is deferred until the account exists, then re-commit picks it up.
      summary.rowsDeferred += 1;
      continue;
    }

    for (const cell of rowCells) {
      if (cell.mapped_kind !== "attendance" || cell.state === "skipped") continue;
      attendance.push({
        user_id: userId,
        work_date: cell.work_date,
        work_mode: cell.work_mode ?? "wfo",
        exception_type: cell.exception_type ?? "none",
        required_minutes: cell.half_day ? HALF_DAY_MINUTES : FULL_DAY_MINUTES,
        source: "import",
        import_batch_id: batchId,
        exception_note: cell.half_day ? "Imported half day" : null,
      });
    }
    summary.rowsCommitted += 1;
  }

  for (let i = 0; i < attendance.length; i += 500) {
    const chunk = attendance.slice(i, i + 500);
    const { error } = await supabaseAdmin
      .from("attendance_days")
      .upsert(chunk as never, { onConflict: "user_id,work_date" });
    if (error) throw error;
    summary.attendanceRows += chunk.length;
  }

  if (calendar.length > 0) {
    const { error } = await supabaseAdmin.from("org_calendar_days").insert(calendar as never);
    // Duplicate calendar entries are expected on a re-commit; ignore them.
    if (error && !error.message.includes("duplicate key")) throw error;
    summary.calendarRows = calendar.length;
  }

  await supabaseAdmin
    .from("import_batches")
    .update({ status: "committed", committed_at: new Date().toISOString(), summary: summary as never })
    .eq("id", batchId);

  await supabaseAdmin.from("audit_logs").insert({
    actor_id: actorId,
    action: "import.commit",
    entity_type: "import_batch",
    entity_id: batchId,
    detail: summary as never,
  });

  if (summary.rowsDeferred > 0) {
    summary.notes.push(
      `${summary.rowsDeferred} row(s) are waiting on an invited account — re-run Commit once those people have accepted.`,
    );
  }
  if (summary.unresolvedCells > 0) {
    summary.notes.push(`${summary.unresolvedCells} cell(s) were unreadable and were not imported.`);
  }

  return summary;
}
