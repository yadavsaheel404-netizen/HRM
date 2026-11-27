import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { loadActor, requirePermission } from "./actor.server";
import { loadDay, notify } from "./daily-queries.server";
import { writeAudit } from "./audit.server";
import { todayIso } from "./timezone";
import {
  evaluateBreakWindow,
  calculateExpectedReturn,
  calculateBreakCompletion,
  evaluateScheduledBreakEligibility,
  getIstWallClock,
  SHORT_BREAK_WINDOW,
  type ValidBreakCategory,
} from "./breaks/break-management";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const admin = supabaseAdmin as any;

export type BreakRequestRow = {
  id: string;
  userId: string;
  fullName?: string;
  workEmail?: string;
  workDate: string;
  requestedMinutes: number;
  reason: string;
  status: "pending" | "approved" | "rejected" | "consumed" | "cancelled";
  approvedMinutes: number | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  consumedBreakId: string | null;
  createdAt: string;
};

/**
 * Submit a request for a personalized break requiring HR approval.
 */
export const requestPersonalizedBreak = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { hours: number; minutes: number; reason: string }) => {
    const hours = Math.max(0, Math.floor(Number(input?.hours || 0)));
    const minutes = Math.max(0, Math.min(59, Math.floor(Number(input?.minutes || 0))));
    const totalMinutes = hours * 60 + minutes;
    const reason = String(input?.reason || "").trim();

    if (totalMinutes <= 0) {
      throw new Error("Requested break duration must be greater than zero.");
    }
    if (totalMinutes > 240) {
      throw new Error("Personalized breaks cannot exceed 4 hours (240 minutes) per request.");
    }
    if (!reason) {
      throw new Error("A reason is required for personalized break requests.");
    }
    return { totalMinutes, reason };
  })
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const workDate = todayIso();

    // Check if there is already a pending request for today
    const { data: existingPending } = await admin
      .from("break_requests")
      .select("id")
      .eq("user_id", userId)
      .eq("work_date", workDate)
      .eq("status", "pending")
      .maybeSingle();

    if (existingPending) {
      throw new Error("You already have a pending personalized break request for today. Await HR decision.");
    }

    const { data: reqRow, error } = await admin
      .from("break_requests")
      .insert({
        user_id: userId,
        work_date: workDate,
        requested_minutes: data.totalMinutes,
        reason: data.reason,
        status: "pending",
      })
      .select("*")
      .single();

    if (error || !reqRow) {
      throw new Error(error?.message || "Failed to submit personalized break request.");
    }

    // Notify HR users
    const { data: hrRoles } = await admin
      .from("user_roles")
      .select("user_id")
      .in("role", ["hr", "admin"]);

    const hrUserIds: string[] = Array.from(
      new Set<string>(
        (hrRoles || [])
          .map((r: any) => String(r.user_id))
          .filter((id: string) => Boolean(id) && id !== userId),
      ),
    );
    for (const hrId of hrUserIds) {
      await notify(supabaseAdmin, {
        userId: hrId,
        actorId: userId,
        type: "break_request",
        title: "Personalized Break Request",
        body: `An employee has requested a personalized break (${data.totalMinutes} mins). HR approval required.`,
        entityType: "break_request",
        entityId: reqRow.id,
        section: "breaks",
        actionLabel: "Review Break",
        actionUrl: `/requests?section=breaks&breakRequestId=${reqRow.id}`,
        metadata: { workDate, employeeId: userId },
      });
    }

    return { request: reqRow };
  });

/**
 * Cancel a pending personalized break request.
 */
export const cancelPersonalizedBreak = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { requestId: string }) => {
    if (!input?.requestId) throw new Error("Request ID is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const { data: updated, error } = await admin
      .from("break_requests")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", data.requestId)
      .eq("user_id", userId)
      .eq("status", "pending")
      .select("*")
      .single();

    if (error || !updated) {
      throw new Error("Unable to cancel request. It may have already been decided.");
    }
    return { ok: true };
  });

/**
 * HR decides (approve or reject) a personalized break request.
 * Strictly prevents self-approval.
 */
export const decidePersonalizedBreak = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      requestId: string;
      decision: "approved" | "rejected";
      approvedMinutes?: number | null;
      note?: string | null;
    }) => {
      if (!input?.requestId) throw new Error("Request ID is required.");
      if (input.decision !== "approved" && input.decision !== "rejected") {
        throw new Error("Decision must be either 'approved' or 'rejected'.");
      }
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const actor = await loadActor(supabase, userId);

    if (!actor.roles.some((r) => ["hr", "admin", "super_admin"].includes(r))) {
      throw new Error("Forbidden: Only HR, Admin or Super Admin may decide personalized break requests.");
    }

    // Load request
    const { data: reqRow } = await admin
      .from("break_requests")
      .select("*")
      .eq("id", data.requestId)
      .single();

    if (!reqRow) throw new Error("Break request not found.");
    if (reqRow.status !== "pending") {
      throw new Error(`This request has already been decided (${reqRow.status}).`);
    }

    // STRICT SELF-APPROVAL PREVENTION
    if (reqRow.user_id === userId) {
      throw new Error("HR Self-Approval Prohibited: You cannot approve or reject your own personalized break request. Another HR or Administrator must decide.");
    }

    const nowIso = new Date().toISOString();
    const approvedMins =
      data.decision === "approved"
        ? Math.max(1, Math.min(240, Number(data.approvedMinutes || reqRow.requested_minutes)))
        : null;

    const { data: updated, error } = await admin
      .from("break_requests")
      .update({
        status: data.decision,
        approved_minutes: approvedMins,
        decided_by: userId,
        decided_at: nowIso,
        decision_note: data.note?.trim() || null,
        updated_at: nowIso,
      })
      .eq("id", data.requestId)
      .eq("status", "pending")
      .select("*")
      .single();

    if (error || !updated) {
      throw new Error(error?.message || "Failed to record decision.");
    }

    // Notify the employee
    await notify(supabaseAdmin, {
      userId: reqRow.user_id,
      actorId: userId,
      type: "break_decision",
      title: `Personalized Break ${data.decision === "approved" ? "Approved" : "Rejected"}`,
      body:
        data.decision === "approved"
          ? `Your personalized break request has been approved for ${approvedMins} minutes. You can start it from My Day.`
          : `Your personalized break request was rejected by HR.${data.note ? ` Note: ${data.note}` : ""}`,
      entityType: "break_request",
      entityId: reqRow.id,
      section: "breaks",
      actionLabel: "Open Break",
      actionUrl: `/my-day?section=breaks&breakRequestId=${reqRow.id}`,
      metadata: { workDate: reqRow.work_date, decision: data.decision },
    });

    return { request: updated };
  });

/**
 * List personalized break requests.
 * Employees see only their own; HR/Admin see all for the requested date.
 */
export const listPersonalizedBreakRequests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input?: { workDate?: string }) => {
    return { workDate: input?.workDate || todayIso() };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const actor = await loadActor(supabase, userId);
    const isHrOrAdmin = actor.roles.some((r) => ["hr", "admin", "super_admin"].includes(r));

    let query = admin
      .from("break_requests")
      .select("*, profiles:user_id(full_name, work_email)")
      .eq("work_date", data.workDate)
      .order("created_at", { ascending: false });

    if (!isHrOrAdmin) {
      query = query.eq("user_id", userId);
    }

    const { data: rows, error } = await query;
    if (error) throw error;

    const requests: BreakRequestRow[] = (rows || []).map((r: any) => ({
      id: r.id,
      userId: r.user_id,
      fullName: r.profiles?.full_name || "Unknown",
      workEmail: r.profiles?.work_email || "",
      workDate: r.work_date,
      requestedMinutes: r.requested_minutes,
      reason: r.reason,
      status: r.status,
      approvedMinutes: r.approved_minutes,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
      decisionNote: r.decision_note,
      consumedBreakId: r.consumed_break_id,
      createdAt: r.created_at,
    }));

    return { requests };
  });

/**
 * Start an official break (Lunch, Short Break, or Approved Personalized Break).
 * Enforces server-authoritative windows, single-break-per-day, and concurrency locks.
 */
export const startBreakStrict = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { category: ValidBreakCategory; requestId?: string | null }) => {
    if (!["lunch", "short_break", "personal"].includes(input?.category)) {
      throw new Error("Invalid break type. Choose Lunch Break, Short Break, or Personalized Break.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const now = new Date();
    const workDate = todayIso();

    // 1. Verify Check-in status
    const day = await loadDay(supabase, userId, workDate);
    if (!day?.check_in_at) {
      throw new Error("You must check in before taking a break.");
    }
    if (day.check_out_at) {
      throw new Error("Cannot start a break after checking out for the day.");
    }

    // 2. Concurrency check: no active open break
    const { data: openBreak } = await admin
      .from("break_logs")
      .select("id, category, started_at")
      .eq("day_id", day.id)
      .is("ended_at", null)
      .maybeSingle();

    if (openBreak) {
      throw new Error("You already have an active break running. End your current break before starting another.");
    }

    let expectedEndAt: Date;
    let allowedMinutes: number;
    let breakRequestId: string | null = null;
    let breakNote: string | null = null;

    if (data.category === "lunch") {
      // 3A. Lunch Break Window & 1-per-day enforcement
      const { data: existingLunch } = await admin
        .from("break_logs")
        .select("id")
        .eq("day_id", day.id)
        .eq("category", "lunch")
        .eq("is_legacy", false)
        .maybeSingle();

      if (existingLunch) {
        throw new Error("You have already completed your lunch break for today.");
      }

      const windowEval = evaluateBreakWindow("lunch", now, workDate);
      if (!windowEval.canStart) {
        throw new Error(windowEval.reason);
      }

      expectedEndAt = calculateExpectedReturn("lunch", workDate, now);
      allowedMinutes = 60;
    } else if (data.category === "short_break") {
      // 3B. Short Break Window & 1-per-day enforcement
      const { data: existingShort } = await admin
        .from("break_logs")
        .select("id")
        .eq("day_id", day.id)
        .eq("category", "short_break")
        .eq("is_legacy", false)
        .maybeSingle();

      if (existingShort) {
        throw new Error("You have already completed your short break for today.");
      }

      const windowEval = evaluateBreakWindow("short_break", now, workDate);
      if (!windowEval.canStart) {
        throw new Error(windowEval.reason);
      }

      expectedEndAt = calculateExpectedReturn("short_break", workDate, now);
      allowedMinutes = 15;
    } else {
      // 3C. Personalized Break: requires approved, unconsumed request
      if (!data.requestId) {
        throw new Error("A valid approved personalized break request is required.");
      }

      const { data: reqRow } = await admin
        .from("break_requests")
        .select("*")
        .eq("id", data.requestId)
        .eq("user_id", userId)
        .single();

      if (!reqRow) {
        throw new Error("Personalized break request not found.");
      }
      if (reqRow.status === "pending") {
        throw new Error("This personalized break request is awaiting HR approval.");
      }
      if (reqRow.status === "rejected") {
        throw new Error("This personalized break request was rejected by HR.");
      }
      if (reqRow.status === "consumed" || reqRow.consumed_break_id) {
        throw new Error("This personalized break request has already been used.");
      }
      if (reqRow.status !== "approved") {
        throw new Error("This personalized break request is not approved.");
      }
      if (reqRow.work_date !== workDate) {
        throw new Error("This personalized break was approved for another date.");
      }

      allowedMinutes = reqRow.approved_minutes || reqRow.requested_minutes;
      expectedEndAt = calculateExpectedReturn("personal", workDate, now, allowedMinutes);
      breakRequestId = reqRow.id;
      breakNote = reqRow.reason;
    }

    // 4. Determine authoritative started_at timestamp
    const startedAt =
      data.category === "lunch"
        ? new Date(`${workDate}T13:30:00+05:30`)
        : data.category === "short_break"
          ? new Date(`${workDate}T16:45:00+05:30`)
          : now;

    // 5. Insert into break_logs
    const { data: newBreak, error: insertError } = await admin
      .from("break_logs")
      .insert({
        day_id: day.id,
        user_id: userId,
        category: data.category,
        started_at: startedAt.toISOString(),
        expected_end_at: expectedEndAt.toISOString(),
        allowed_minutes: allowedMinutes,
        return_status: "on_time",
        overtime_seconds: 0,
        break_request_id: breakRequestId,
        note: breakNote,
        is_legacy: false,
      })
      .select("*")
      .single();

    if (insertError || !newBreak) {
      if (insertError?.code === "23505") {
        // Unique violation
        throw new Error("Another break is already active or this break has already been started.");
      }
      throw new Error(insertError?.message || "Failed to start break.");
    }

    // 5. If personalized, mark request as consumed atomically
    if (breakRequestId) {
      await admin
        .from("break_requests")
        .update({
          status: "consumed",
          consumed_break_id: newBreak.id,
          updated_at: now.toISOString(),
        })
        .eq("id", breakRequestId);
    }

    await writeAudit(supabaseAdmin, {
      actorId: userId,
      action: "break.started",
      entityType: "break_logs",
      entityId: newBreak.id,
      detail: {
        category: data.category,
        started_at: newBreak.started_at,
        expected_end_at: newBreak.expected_end_at,
        allowed_minutes: allowedMinutes,
      },
    });

    return { break: newBreak };
  });

/**
 * End an active break manually.
 * Server-authoritative: records exact completion time, computes overtime,
 * and sets return status (on_time vs late_return).
 * Idempotent: repeated calls do not overwrite the first ended_at timestamp.
 */
export const endBreakStrict = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { id: string }) => {
    if (!input?.id) throw new Error("Break ID is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const now = new Date();

    // 1. Fetch break
    const { data: breakRow } = await admin
      .from("break_logs")
      .select("*")
      .eq("id", data.id)
      .eq("user_id", userId)
      .single();

    if (!breakRow) {
      throw new Error("Break record not found.");
    }

    // Idempotent: if already ended, return existing record
    if (breakRow.ended_at) {
      return { break: breakRow };
    }

    // 2. Compute duration, overtime, and return status
    const expectedEnd = breakRow.expected_end_at
      ? breakRow.expected_end_at
      : new Date(new Date(breakRow.started_at).getTime() + (breakRow.allowed_minutes || 15) * 60_000).toISOString();

    const completion = calculateBreakCompletion(breakRow.started_at, now, expectedEnd);

    // 3. Atomically update only if still open
    const { data: updatedBreak, error } = await admin
      .from("break_logs")
      .update({
        ended_at: now.toISOString(),
        overtime_seconds: completion.overtimeSeconds,
        return_status: completion.returnStatus,
      })
      .eq("id", data.id)
      .eq("user_id", userId)
      .is("ended_at", null)
      .select("*")
      .single();

    if (error || !updatedBreak) {
      // If another concurrent request ended it, return the current state
      const { data: current } = await admin
        .from("break_logs")
        .select("*")
        .eq("id", data.id)
        .single();
      return { break: current || breakRow };
    }

    await writeAudit(supabaseAdmin, {
      actorId: userId,
      action: "break.ended",
      entityType: "break_logs",
      entityId: updatedBreak.id,
      detail: {
        category: updatedBreak.category,
        started_at: updatedBreak.started_at,
        ended_at: updatedBreak.ended_at,
        actual_duration_seconds: completion.actualDurationSeconds,
        overtime_seconds: completion.overtimeSeconds,
        return_status: completion.returnStatus,
      },
    });

    return { break: updatedBreak };
  });

export type ActiveBreakState = {
  id: string;
  category: "lunch" | "short_break" | "personal" | string;
  started_at: string;
  expected_end_at?: string | null;
  allowed_minutes?: number | null;
  return_status?: string | null;
  overtime_seconds?: number | null;
  break_request_id?: string | null;
  note?: string | null;
  work_date?: string;
} | null;

/**
 * Server-authoritative scheduled break reconciler.
 * Automatically initiates Lunch Break (1:30 PM - 2:30 PM IST) and Short Break (4:45 PM - 5:00 PM IST)
 * for checked-in employees, without requiring manual button clicks.
 * If an active break is running (including personalized), returns that active break.
 */
export async function reconcileScheduledBreaksInternal(
  userId: string,
  now: Date = new Date(),
): Promise<{ activeBreak: ActiveBreakState }> {
  const workDate = todayIso();

  // 1. Priority 1: Check if there is ALREADY an open active break for this user in break_logs
  // Regardless of date boundary, if a break is running for this user, it must be returned immediately!
  const { data: openBreak } = await admin
    .from("break_logs")
    .select(
      "id, category, started_at, expected_end_at, allowed_minutes, return_status, overtime_seconds, break_request_id, note, day_id",
    )
    .eq("user_id", userId)
    .is("ended_at", null)
    .maybeSingle();

  if (openBreak) {
    return {
      activeBreak: {
        ...openBreak,
        work_date: workDate,
      },
    };
  }

  // 2. Fetch today's attendance day for auto-scheduling checks
  const { data: day } = await admin
    .from("attendance_days")
    .select("id, check_in_at, check_out_at, status")
    .eq("user_id", userId)
    .eq("work_date", workDate)
    .maybeSingle();

  // Absent, on leave, not checked in, or already checked out -> no scheduled breaks
  if (!day || !day.check_in_at || day.check_out_at) {
    return { activeBreak: null };
  }

  // 3. Fetch all completed or existing breaks for today to check if lunch or short break was already taken
  const { data: existingBreaks } = await admin
    .from("break_logs")
    .select("category, is_legacy, ended_at")
    .eq("day_id", day.id);

  const hasLunch = (existingBreaks || []).some((b: any) => b.category === "lunch" && b.is_legacy !== true);
  const hasShortBreak = (existingBreaks || []).some((b: any) => b.category === "short_break" && b.is_legacy !== true);

  const currentIst = getIstWallClock(now);
  const isShortBreakTime =
    currentIst.totalSecondsFromMidnight >= SHORT_BREAK_WINDOW.startHour * 3600 + SHORT_BREAK_WINDOW.startMinute * 60;

  // 4. If in or past short break time (4:45 PM IST), prioritize evaluating Short Break
  if (isShortBreakTime) {
    if (!hasShortBreak) {
      const shortEval = evaluateScheduledBreakEligibility("short_break", {
        checkInAt: day.check_in_at,
        checkOutAt: day.check_out_at,
        currentTime: now,
        workDate,
      });

      if (shortEval.eligible) {
        const { data: newShort, error: shortErr } = await admin
          .from("break_logs")
          .insert({
            day_id: day.id,
            user_id: userId,
            category: "short_break",
            started_at: shortEval.startedAtIso,
            expected_end_at: shortEval.expectedEndIso,
            allowed_minutes: shortEval.allowedMinutes,
            return_status: "on_time",
            overtime_seconds: 0,
            is_legacy: false,
            note: "Auto-started scheduled short break",
          })
          .select(
            "id, category, started_at, expected_end_at, allowed_minutes, return_status, overtime_seconds, break_request_id, note",
          )
          .single();

        if (shortErr?.code === "23505") {
          const { data: existingOpen } = await admin
            .from("break_logs")
            .select("id, category, started_at, expected_end_at, allowed_minutes, return_status, overtime_seconds, break_request_id, note")
            .eq("user_id", userId)
            .is("ended_at", null)
            .maybeSingle();
          if (existingOpen) {
            return { activeBreak: { ...existingOpen, work_date: workDate } };
          }
        }

        if (!shortErr && newShort) {
          await writeAudit(supabaseAdmin, {
            actorId: userId,
            action: "break.auto_started",
            entityType: "break_logs",
            entityId: newShort.id,
            detail: {
              category: "short_break",
              started_at: newShort.started_at,
              expected_end_at: newShort.expected_end_at,
              allowed_minutes: newShort.allowed_minutes,
              schedule: "4:45 PM - 5:00 PM IST",
            },
          });
          return {
            activeBreak: {
              ...newShort,
              work_date: workDate,
            },
          };
        }
      }
    }
  } else {
    // 5. If before short break time, evaluate Lunch Break (1:30 PM - 2:30 PM IST)
    if (!hasLunch) {
      const lunchEval = evaluateScheduledBreakEligibility("lunch", {
        checkInAt: day.check_in_at,
        checkOutAt: day.check_out_at,
        currentTime: now,
        workDate,
      });

      if (lunchEval.eligible) {
        const { data: newLunch, error: lunchErr } = await admin
          .from("break_logs")
          .insert({
            day_id: day.id,
            user_id: userId,
            category: "lunch",
            started_at: lunchEval.startedAtIso,
            expected_end_at: lunchEval.expectedEndIso,
            allowed_minutes: lunchEval.allowedMinutes,
            return_status: "on_time",
            overtime_seconds: 0,
            is_legacy: false,
            note: "Auto-started scheduled lunch break",
          })
          .select(
            "id, category, started_at, expected_end_at, allowed_minutes, return_status, overtime_seconds, break_request_id, note",
          )
          .single();

        if (lunchErr?.code === "23505") {
          const { data: existingOpen } = await admin
            .from("break_logs")
            .select("id, category, started_at, expected_end_at, allowed_minutes, return_status, overtime_seconds, break_request_id, note")
            .eq("user_id", userId)
            .is("ended_at", null)
            .maybeSingle();
          if (existingOpen) {
            return { activeBreak: { ...existingOpen, work_date: workDate } };
          }
        }

        if (!lunchErr && newLunch) {
          await writeAudit(supabaseAdmin, {
            actorId: userId,
            action: "break.auto_started",
            entityType: "break_logs",
            entityId: newLunch.id,
            detail: {
              category: "lunch",
              started_at: newLunch.started_at,
              expected_end_at: newLunch.expected_end_at,
              allowed_minutes: newLunch.allowed_minutes,
              schedule: "1:30 PM - 2:30 PM IST",
            },
          });
          return {
            activeBreak: {
              ...newLunch,
              work_date: workDate,
            },
          };
        }
      }
    }
  }

  return { activeBreak: null };
}

/**
 * Returns current active break, automatically reconciling any due scheduled breaks.
 */
export const getActiveBreak = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context;
    return await reconcileScheduledBreaksInternal(userId);
  });

/**
 * Endpoint to explicitly trigger scheduled break reconciliation.
 */
export const reconcileScheduledBreaks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context;
    return await reconcileScheduledBreaksInternal(userId);
  });
