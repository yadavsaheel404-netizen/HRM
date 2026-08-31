import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "./actor.server";
import { writeAudit } from "./audit.server";
import { inspectSheet, transformSheet, type Grid } from "./legacy-import/sheet";

export type SheetPayload = { name: string; grid: Grid; projectId?: string | null };

/**
 * Parses and stages an uploaded workbook. Nothing touches attendance here —
 * the batch is inspected, transformed wide-to-long, auto-matched where the
 * identifier is unambiguous, and everything else is parked for manual mapping.
 */
export const stageImportBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { fileName: string; sheets: SheetPayload[] }) => {
    if (!input?.fileName) throw new Error("A file name is required.");
    if (!Array.isArray(input.sheets) || input.sheets.length === 0) {
      throw new Error("The workbook has no readable sheets.");
    }
    const cells = input.sheets.reduce(
      (sum, s) => sum + s.grid.reduce((n, row) => n + (row?.length ?? 0), 0),
      0,
    );
    if (cells > 400_000) throw new Error("That workbook is too large to import in one batch.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "import:manage:all");

    const inspections = data.sheets.map((sheet) => ({
      sheet,
      inspection: inspectSheet(sheet.name, sheet.grid),
    }));

    const allDates = inspections
      .flatMap(({ inspection }) => [inspection.dateFrom, inspection.dateTo])
      .filter((d): d is string => Boolean(d))
      .sort();

    const { data: batch, error: batchError } = await supabase
      .from("import_batches")
      .insert({
        file_name: data.fileName,
        status: "preview",
        sheet_names: data.sheets.map((s) => s.name),
        date_from: allDates[0] ?? null,
        date_to: allDates[allDates.length - 1] ?? null,
        created_by: userId,
        summary: {
          sheets: inspections.map(({ inspection }) => ({
            name: inspection.sheetName,
            people: inspection.rowCount,
            dateColumns: inspection.dateColumns.length,
            unparsedDateHeaders: inspection.unparsedDateHeaders,
            detectedColumns: inspection.columns,
          })),
        } as never,
      })
      .select("id")
      .single();
    if (batchError) throw batchError;
    const batchId = batch.id;

    // Auto-match only on a real, unambiguous organisation email.
    const people = inspections.flatMap(({ sheet, inspection }) =>
      transformSheet(sheet.grid, inspection).map((p) => ({ ...p, projectId: sheet.projectId ?? null })),
    );
    const emails = [...new Set(people.map((p) => p.identity.email).filter((e): e is string => !!e))];
    const byEmail = new Map<string, string>();
    if (emails.length > 0) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, work_email, personal_email")
        .or(`work_email.in.(${emails.join(",")}),personal_email.in.(${emails.join(",")})`);
      for (const p of profiles ?? []) {
        if (p.work_email) byEmail.set(p.work_email.toLowerCase(), p.id);
        if (p.personal_email) byEmail.set(p.personal_email.toLowerCase(), p.id);
      }
    }

    let matched = 0;
    let needsMapping = 0;

    for (const person of people) {
      const email = person.identity.email;
      const existing = email ? byEmail.get(email) ?? null : null;
      // An exact email hit on a real account is unambiguous, so it auto-matches.
      // Everything else — bare numeric IDs, placeholders, name-only rows — is
      // parked for a human. A name is NEVER matched to an account.
      const autoMatch = existing;
      if (autoMatch) matched += 1;
      else needsMapping += 1;

      const { data: row, error: rowError } = await supabase
        .from("import_rows")
        .insert({
          batch_id: batchId,
          sheet_name: person.sheetName,
          row_index: person.rowIndex,
          project_id: person.projectId,
          raw_name: person.rawName,
          raw_identifier: person.rawIdentifier,
          raw_doj: person.rawDoj,
          raw_lwd: person.rawLwd,
          parsed_doj: person.parsedDoj,
          parsed_lwd: person.parsedLwd,
          date_issues: person.dateIssues as never,
          match_state: autoMatch ? "matched" : "needs_mapping",
          match_reason: autoMatch
            ? `${person.identity.kind.replace("_", " ")} matched an existing account`
            : person.identity.note,
          matched_user_id: autoMatch,
          resolution: autoMatch ? "mapped" : "pending",
          metadata: {
            ...person.metadata,
            email,
            identifierKind: person.identity.kind,
            suggestedUserId: existing,
          } as never,
        })
        .select("id")
        .single();
      if (rowError) throw rowError;

      const cellPayload = person.cells
        .filter((c) => c.mapping.kind !== "blank")
        .map((c) => ({
          batch_id: batchId,
          row_id: row.id,
          work_date: c.workDate,
          raw_value: c.raw,
          mapped_kind: c.mapping.kind,
          work_mode: c.mapping.kind === "attendance" ? c.mapping.workMode : null,
          exception_type: c.mapping.kind === "attendance" ? c.mapping.exceptionType : null,
          half_day: c.mapping.kind === "attendance" ? c.mapping.halfDay : false,
          calendar_kind: c.mapping.kind === "calendar" ? c.mapping.calendarKind : null,
          signal_type: c.mapping.kind === "signal" ? c.mapping.signalType : null,
          state: c.mapping.kind === "invalid" ? "needs_review" : "valid",
          note: c.mapping.kind === "invalid" ? c.mapping.issue : null,
        }));
      for (let i = 0; i < cellPayload.length; i += 500) {
        const { error } = await supabase.from("import_cells").insert(cellPayload.slice(i, i + 500) as never);
        if (error) throw error;
      }

      if (person.signals.length > 0) {
        await supabase.from("import_signals").insert(
          person.signals.map((s) => ({
            batch_id: batchId,
            row_id: row.id,
            signal_type: s.signalType,
            effective_date: s.effectiveDate,
            raw_value: s.raw,
          })) as never,
        );
      }
    }

    await writeAudit(supabase, {
      actorId: userId,
      action: "import.stage",
      entityType: "import_batch",
      entityId: batchId,
      detail: { fileName: data.fileName, people: people.length, matched, needsMapping },
    });

    return { batchId, people: people.length, matched, needsMapping };
  });

export const listImportBatches = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePermission(context.supabase, context.userId, "import:manage:all");
    const { data, error } = await context.supabase
      .from("import_batches")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    return data ?? [];
  });

export const getImportBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { batchId: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "import:manage:all");

    const [batch, rows, cells, signals] = await Promise.all([
      supabase.from("import_batches").select("*").eq("id", data.batchId).maybeSingle(),
      supabase
        .from("import_rows")
        .select("*")
        .eq("batch_id", data.batchId)
        .order("sheet_name")
        .order("row_index"),
      supabase
        .from("import_cells")
        .select("row_id, work_date, raw_value, mapped_kind, work_mode, exception_type, half_day, calendar_kind, state, note")
        .eq("batch_id", data.batchId)
        .order("work_date")
        .limit(20000),
      supabase.from("import_signals").select("*").eq("batch_id", data.batchId),
    ]);

    const counts: Record<string, number> = {};
    for (const c of cells.data ?? []) counts[c.mapped_kind] = (counts[c.mapped_kind] ?? 0) + 1;

    return {
      batch: batch.data,
      rows: rows.data ?? [],
      cells: cells.data ?? [],
      signals: signals.data ?? [],
      cellCounts: counts,
    };
  });

/** Manual mapping: attach an unmatched row to a real account, or skip it. */
export const resolveImportRow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      rowId: string;
      resolution: "mapped" | "create_new" | "skipped" | "pending";
      matchedUserId?: string | null;
      projectId?: string | null;
      parsedDoj?: string | null;
      parsedLwd?: string | null;
    }) => {
      if (input.resolution === "mapped" && !input.matchedUserId) {
        throw new Error("Pick the account this row belongs to.");
      }
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "import:manage:all");
    const patch: Record<string, unknown> = {
      resolution: data.resolution,
      matched_user_id: data.resolution === "mapped" ? data.matchedUserId : null,
      match_state:
        data.resolution === "mapped"
          ? "matched"
          : data.resolution === "create_new"
            ? "new_account"
            : "needs_mapping",
      match_reason: data.resolution === "mapped" ? "manually mapped by an admin" : null,
    };
    if (data.projectId !== undefined) patch["project_id"] = data.projectId;
    if (data.parsedDoj !== undefined) patch["parsed_doj"] = data.parsedDoj;
    if (data.parsedLwd !== undefined) patch["parsed_lwd"] = data.parsedLwd;

    const { error } = await supabase.from("import_rows").update(patch as never).eq("id", data.rowId);
    if (error) throw error;
    await writeAudit(supabase, {
      actorId: userId,
      action: "import.row.resolve",
      entityType: "import_row",
      entityId: data.rowId,
      detail: patch,
    });
    return { ok: true };
  });

/**
 * Queues invitations for every `create_new` row. Reuses the throttled
 * invitation queue, so an import of 150 people behaves exactly like one
 * invite, and the new accounts surface in the unassigned-reporting-lead list.
 */
export const inviteImportedPeople = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { batchId: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "import:manage:all");
    await requirePermission(supabase, userId, "invitations:create:all");

    const { data: rows, error } = await supabase
      .from("import_rows")
      .select("id, raw_name, raw_identifier, metadata, invitation_id")
      .eq("batch_id", data.batchId)
      .eq("resolution", "create_new");
    if (error) throw error;

    let queued = 0;
    const skipped: string[] = [];
    for (const row of rows ?? []) {
      if (row.invitation_id) continue;
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const email = typeof meta["email"] === "string" ? (meta["email"] as string) : null;
      if (!email) {
        skipped.push(row.raw_name ?? row.id);
        continue;
      }
      const { data: invitation, error: inviteError } = await supabase
        .from("invitations")
        .insert({
          email,
          full_name: row.raw_name ?? email.split("@")[0]!,
          purpose: "onboarding",
          role: "employee",
          category: "full_time",
          source: "legacy_import",
          created_by: userId,
          expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
        })
        .select("id")
        .single();
      if (inviteError) throw inviteError;
      await supabase.from("import_rows").update({ invitation_id: invitation.id }).eq("id", row.id);
      queued += 1;
    }

    await writeAudit(supabase, {
      actorId: userId,
      action: "import.invite",
      entityType: "import_batch",
      entityId: data.batchId,
      detail: { queued, skipped },
    });
    return { queued, skipped };
  });

export const commitImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { batchId: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "import:manage:all");
    const { commitImportBatch } = await import("./import.server");
    return commitImportBatch(data.batchId, userId);
  });
