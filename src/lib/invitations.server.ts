// Invitation dispatch worker.
//
// Why a queue instead of "send N emails in a loop":
//   Auth providers rate-limit invite emails aggressively. A 150-person legacy
//   import that fires 150 sends in one request will partially succeed and
//   silently drop the rest. Here every invite is a durable row; a worker
//   claims a bounded batch, sends with a pacing delay, and any rate-limited
//   or failed row goes back to `queued` with exponential backoff instead of
//   disappearing. Nothing is ever lost, and re-running is safe.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { writeAudit } from "./audit.server";
import { describeUnknownError } from "./describe-error";

/** Rows claimed per worker tick. Sized under the auth provider's burst limit. */
export const DISPATCH_BATCH_SIZE = 10;
/** Pause between individual sends inside a batch, in ms. */
export const DISPATCH_PACING_MS = 350;
/** Give up (status = failed) after this many delivery attempts. */
export const MAX_ATTEMPTS = 5;
/** Lease length so overlapping ticks cannot double-dispatch. */
export const LEASE_SECONDS = 120;
export const LEASE_NAME = "invitations:dispatch";

export type DispatchResult = {
  claimed: number;
  sent: number;
  requeued: number;
  failed: number;
  skipped: boolean;
  reason?: string;
};

function backoffSeconds(attempts: number): number {
  // 1m, 4m, 9m, 16m, 25m — quadratic, gentle on the provider.
  return Math.min(60 * attempts * attempts, 60 * 30);
}

function isRateLimit(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("rate limit") || m.includes("too many requests") || m.includes("429");
}

async function provisionInvitedUser(params: {
  userId: string;
  email: string;
  fullName: string | null;
  role: string;
  category: string;
  designation: string | null;
  departmentId: string | null;
  reportingLeadId: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  // Roster imports carry joining details on the invitation until acceptance.
  const meta = (params.metadata ?? {}) as {
    mobile?: string | null;
    joiningDate?: string | null;
    lastWorkingDay?: string | null;
    employeeCode?: string | null;
  };

  // Check if profile already exists to preserve existing employee code if already claimed
  const { data: existingProfile } = await supabaseAdmin
    .from("profiles")
    .select("employee_code")
    .eq("id", params.userId)
    .maybeSingle();

  let employeeCode = existingProfile?.employee_code;
  if (!employeeCode) {
    // Atomically claim the next system-assigned sequential ID (e.g. TAS-001)
    const { data: claimedId, error: claimError } =
      await supabaseAdmin.rpc("claim_next_employee_id");
    if (claimError) {
      console.error("[invitations] Failed to claim next employee ID:", claimError);
    }
    employeeCode = (claimedId as unknown as string) ?? null;
  }

  const fullName = params.fullName ?? params.email.split("@")[0]!;

  await supabaseAdmin.from("profiles").upsert(
    {
      id: params.userId,
      full_name: fullName,
      work_email: params.email,
      category: params.category as never,
      designation: params.designation,
      department_id: params.departmentId,
      reporting_lead_id: params.reportingLeadId,
      // Without a lead, requests cannot route — surface the account immediately
      // in the unassigned-reporting-lead list instead of waiting for verification.
      needs_assignment: !params.reportingLeadId,
      account_status: "invited",
      mobile: meta.mobile ?? null,
      joining_date: meta.joiningDate ?? null,
      last_working_day: meta.lastWorkingDay ?? null,
      employee_code: employeeCode,
    },
    { onConflict: "id" },
  );

  await supabaseAdmin
    .from("user_roles")
    .upsert({ user_id: params.userId, role: params.role as never }, { onConflict: "user_id,role" });

  // Dispatch Welcome Email (idempotent, records welcome_email_sent_at)
  if (employeeCode) {
    const { sendWelcomeEmailForProvisionedUser } = await import("./emails/send-welcome.server");
    void sendWelcomeEmailForProvisionedUser({
      userId: params.userId,
      fullName,
      workEmail: params.email,
      employeeCode,
      category: params.category,
      role: params.role,
    });
  }
}

/**
 * Claim and send one bounded batch. Safe to call concurrently and repeatedly.
 */
export async function dispatchInvitationBatch(options?: {
  limit?: number;
  redirectTo?: string;
}): Promise<DispatchResult> {
  const limit = options?.limit ?? DISPATCH_BATCH_SIZE;

  const { data: leased, error: leaseError } = await supabaseAdmin.rpc("acquire_job_lease", {
    _job_name: LEASE_NAME,
    _seconds: LEASE_SECONDS,
  });
  if (leaseError) throw leaseError;
  if (leased !== true) {
    return { claimed: 0, sent: 0, requeued: 0, failed: 0, skipped: true, reason: "lease-held" };
  }

  const result: DispatchResult = { claimed: 0, sent: 0, requeued: 0, failed: 0, skipped: false };

  try {
    const { data: claimed, error: claimError } = await supabaseAdmin.rpc("claim_invitations", {
      _limit: limit,
    });
    if (claimError) throw claimError;

    const rows = claimed ?? [];
    result.claimed = rows.length;

    for (const row of rows) {
      const attempts = (row.attempts ?? 0) + 1;
      try {
        const { data: created, error: inviteError } =
          await supabaseAdmin.auth.admin.inviteUserByEmail(row.email, {
            ...(options?.redirectTo ? { redirectTo: options.redirectTo } : {}),
            data: { full_name: row.full_name, invitation_id: row.id },
          });


        let userId = created?.user?.id ?? null;

        if (inviteError) {
          const message = inviteError.message ?? "unknown error";
          // Already registered is not a failure: link the existing account.
          if (message.toLowerCase().includes("already been registered")) {
            const { data: list } = await supabaseAdmin.auth.admin.listUsers({
              page: 1,
              perPage: 200,
            });
            userId =
              list?.users.find((u) => u.email?.toLowerCase() === row.email.toLowerCase())?.id ??
              null;
            if (!userId) throw new Error(message);
          } else {
            throw new Error(message);
          }
        }

        if (userId) {
          await provisionInvitedUser({
            userId,
            email: row.email,
            fullName: row.full_name,
            role: row.role,
            category: row.category,
            designation: row.designation,
            departmentId: row.department_id,
            reportingLeadId: row.reporting_lead_id,
            metadata: (row.metadata ?? null) as Record<string, unknown> | null,
          });
        }

        await supabaseAdmin
          .from("invitations")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            attempts,
            last_error: null,
            invited_user_id: userId,
          })
          .eq("id", row.id);

        result.sent += 1;
        await writeAudit(supabaseAdmin, {
          actorId: row.created_by,
          action: "invitation.sent",
          entityType: "invitation",
          entityId: row.id,
          detail: { email: row.email, attempts },
        });
      } catch (error) {
        const message = describeUnknownError(error);
        const giveUp = attempts >= MAX_ATTEMPTS && !isRateLimit(message);

        await supabaseAdmin
          .from("invitations")
          .update({
            status: giveUp ? "failed" : "queued",
            attempts,
            last_error: message.slice(0, 500),
            next_attempt_at: new Date(Date.now() + backoffSeconds(attempts) * 1000).toISOString(),
          })
          .eq("id", row.id);

        if (giveUp) result.failed += 1;
        else result.requeued += 1;

        console.error("[invitations] send failed", row.email, message);

        // A rate limit applies to the whole batch — stop early and let the
        // next tick drain the rest rather than burning through retries.
        if (isRateLimit(message)) {
          result.reason = "rate-limited";
          break;
        }
      }

      if (DISPATCH_PACING_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, DISPATCH_PACING_MS));
      }
    }
  } finally {
    await supabaseAdmin.rpc("release_job_lease", { _job_name: LEASE_NAME });
  }

  return result;
}
