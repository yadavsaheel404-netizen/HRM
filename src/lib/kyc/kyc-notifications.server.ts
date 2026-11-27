// Server-only KYC notification outbox worker.
//
// Flow: HR decision → DB trigger writes the event in the SAME transaction
// (kyc_notification_outbox) → this worker claims due events, re-reads the
// CURRENT verification state, renders the email from validated templates and
// sends it through the existing Hostinger SMTP transport.
//
// Guarantees:
//   * Never sends a success email unless the live state is still "verified".
//   * Never sends a correction email when nothing is rejected anymore.
//   * One email per outbox row; outbox rows are deduplicated in SQL
//     (completion: once per KYC cycle; corrections: grouped per window).
//   * SMTP failure → retry with backoff; the KYC decision itself is untouched.
//   * Email history rows contain no files, paths, signed URLs or ID numbers.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { writeAudit } from "../audit.server";
import { isMissingSchemaResourceError } from "../schema-compat.server";
import {
  createHostingerSmtpTransport,
  resolveEmailPortalUrl,
} from "../recruitment/email-transport.server";
import {
  KYC_MAX_DELIVERY_ATTEMPTS,
  KYC_NOTIFICATIONS,
  KYC_TEMPLATE_SLUGS,
  correctionItemsFromState,
  deriveKycState,
  kycRetryDelayMinutes,
  renderKycCorrectionEmail,
  renderKycVerifiedEmail,
  type KycEmailKind,
  type KycEventType,
  type KycState,
  type RenderedEmail,
} from "./kyc-notifications";

// New tables are not in the generated Database types yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as unknown as SupabaseClient<any>;

export type KycOutboxRow = {
  id: string;
  user_id: string;
  event_type: KycEventType;
  dedupe_key: string;
  kyc_cycle: number;
  source: "automatic" | "manual";
  status: "pending" | "processing" | "sent" | "failed" | "skipped";
  attempts: number;
  available_at: string;
  last_error: string | null;
  skip_reason: string | null;
  email_message_id: string | null;
  created_by: string | null;
  created_at: string;
  processed_at: string | null;
};

export type KycDispatchOutcome = {
  id: string;
  eventType: KycEventType;
  outcome: "sent" | "skipped" | "retry_scheduled" | "failed";
  reason: string;
  emailMessageId: string | null;
};

export async function loadKycContext(userId: string): Promise<{
  profile: { id: string; full_name: string | null; work_email: string | null } | null;
  state: KycState;
}> {
  const [{ data: profile }, { data: docs }] = await Promise.all([
    supabaseAdmin.from("profiles").select("id, full_name, work_email").eq("id", userId).maybeSingle(),
    db
      .from("documents")
      .select("doc_type, status, revision, review_note, created_at")
      .eq("user_id", userId),
  ]);
  let rows = (docs ?? []) as { doc_type: string; status: string; revision?: number; review_note: string | null; created_at: string }[];
  if (!docs) {
    // Pre-migration fallback (no `revision` column yet).
    const { data: legacy } = await supabaseAdmin
      .from("documents")
      .select("doc_type, status, review_note, created_at")
      .eq("user_id", userId);
    rows = (legacy ?? []) as typeof rows;
  }
  return { profile: profile ?? null, state: deriveKycState(rows) };
}

/** Renders the email for a kind from live state. Returns null + reason when not eligible. */
export function renderKycEmailForState(
  kind: KycEmailKind,
  employeeName: string,
  state: KycState,
  portalUrl: string,
): { email: RenderedEmail } | { skip: string } {
  if (kind === "verified") {
    if (state.status !== "verified") return { skip: "KYC is no longer fully verified." };
    return { email: renderKycVerifiedEmail({ employeeName, portalUrl }) };
  }
  const rejected = correctionItemsFromState(state);
  if (rejected.length === 0) return { skip: "No documents currently require correction." };
  return {
    email: renderKycCorrectionEmail({
      employeeName,
      portalUrl,
      rejected,
      verifiedCount: state.verified,
    }),
  };
}

function kindForEvent(eventType: KycEventType): KycEmailKind | null {
  if (eventType === "kyc.all_required_documents_verified") return "verified";
  if (eventType === "kyc.correction_requested" || eventType === "kyc.document_rejected") return "correction";
  return null; // kyc.correction_resubmitted → in-app only
}

async function notifyInApp(userId: string, kind: keyof typeof KYC_NOTIFICATIONS, outboxId: string) {
  const n = KYC_NOTIFICATIONS[kind];
  const isCorrection = kind === "correction";
  const actionUrl = isCorrection
    ? "/onboarding?section=documents&filter=rejected"
    : "/onboarding?section=documents";
  const actionLabel = isCorrection
    ? "Fix Documents"
    : kind === "verified"
      ? "View KYC Status"
      : "View Documents";

  const { error } = await db.from("notifications").insert({
    user_id: userId,
    type: n.type,
    title: n.title,
    entity_type: "kyc",
    entity_id: outboxId,
    section: "documents",
    action_label: actionLabel,
    action_url: actionUrl,
    metadata: { kycKind: kind, filter: isCorrection ? "rejected" : "all" },
  });

  if (error && isMissingSchemaResourceError(error)) {
    await supabaseAdmin.from("notifications").insert({
      user_id: userId,
      type: n.type,
      title: n.title,
      entity_type: "kyc",
      entity_id: outboxId,
    });
  }
}

async function finish(id: string, patch: Record<string, unknown>) {
  await db
    .from("kyc_notification_outbox")
    .update({ ...patch, locked_until: null, updated_at: new Date().toISOString() })
    .eq("id", id);
}

async function dispatchRow(row: KycOutboxRow): Promise<KycDispatchOutcome> {
  const base = { id: row.id, eventType: row.event_type, emailMessageId: null as string | null };
  const nowIso = new Date().toISOString();
  const { profile, state } = await loadKycContext(row.user_id);

  if (!profile?.work_email) {
    await finish(row.id, { status: "skipped", skip_reason: "Employee has no work email.", processed_at: nowIso });
    return { ...base, outcome: "skipped", reason: "Employee has no work email." };
  }

  const kind = kindForEvent(row.event_type);
  if (!kind) {
    // Resubmission: let the employee know their documents are back under review.
    await notifyInApp(row.user_id, "under_review", row.id);
    await finish(row.id, { status: "sent", processed_at: nowIso });
    return { ...base, outcome: "sent", reason: "In-app notification recorded." };
  }

  let portalUrl: string;
  try {
    portalUrl = resolveEmailPortalUrl();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Portal URL misconfigured.";
    await finish(row.id, { status: "failed", last_error: reason.slice(0, 500), processed_at: nowIso });
    return { ...base, outcome: "failed", reason };
  }

  const name = profile.full_name?.trim() || profile.work_email;
  const rendered = renderKycEmailForState(kind, name, state, portalUrl);
  if ("skip" in rendered) {
    await finish(row.id, { status: "skipped", skip_reason: rendered.skip, processed_at: nowIso });
    return { ...base, outcome: "skipped", reason: rendered.skip };
  }

  const slug = KYC_TEMPLATE_SLUGS[kind];
  const idempotencyKey = `${slug}:${row.id}:attempt:${row.attempts}`;
  const { data: msg } = await supabaseAdmin
    .from("email_messages")
    .insert({
      idempotency_key: idempotencyKey,
      template_slug: slug,
      recipient_email: profile.work_email,
      recipient_name: profile.full_name,
      subject: rendered.email.subject,
      body_html: rendered.email.html,
      body_text: rendered.email.text,
      variables_payload: {
        user_id: row.user_id,
        outbox_id: row.id,
        event_type: row.event_type,
        source: row.source,
        verified: state.verified,
        required: state.required,
        rejected: state.rejected,
      } as never,
      is_test: false,
      status: "sending",
      provider: "hostinger_smtp",
      attempts: 0,
      sent_by: row.created_by,
    } as never)
    .select("id")
    .single();

  const result = await createHostingerSmtpTransport().send({
    to: profile.work_email,
    subject: rendered.email.subject,
    html: rendered.email.html,
    text: rendered.email.text,
    idempotencyKey,
  });

  if (msg?.id) {
    await supabaseAdmin
      .from("email_messages")
      .update({
        status: result.status,
        provider_message_id: result.ok ? result.providerMessageId : null,
        smtp_response: result.ok ? result.smtpResponse : null,
        attempts: Math.max(1, result.attemptsUsed),
        error_message: result.ok ? null : result.errorMessage,
        sent_at: result.ok ? new Date().toISOString() : null,
      } as never)
      .eq("id", msg.id);
  }

  await writeAudit(supabaseAdmin, {
    actorId: row.created_by,
    action: result.ok ? "kyc.notification_accepted" : "kyc.notification_failed",
    entityType: "profile",
    entityId: row.user_id,
    detail: {
      outbox_id: row.id,
      event_type: row.event_type,
      source: row.source,
      email_message_id: msg?.id ?? null,
      status: result.status,
      attempt: row.attempts,
      ...(result.ok ? {} : { error: result.errorMessage }),
    },
  });

  if (result.ok) {
    await notifyInApp(row.user_id, kind === "verified" ? "verified" : "correction", row.id);
    await finish(row.id, { status: "sent", email_message_id: msg?.id ?? null, last_error: null, processed_at: nowIso });
    return {
      ...base,
      emailMessageId: msg?.id ?? null,
      outcome: "sent",
      reason: "Accepted by Hostinger SMTP (not proof of inbox delivery).",
    };
  }

  const error = (result.errorMessage ?? "SMTP send failed").slice(0, 500);
  if (row.attempts >= KYC_MAX_DELIVERY_ATTEMPTS) {
    await finish(row.id, { status: "failed", last_error: error, email_message_id: msg?.id ?? null, processed_at: nowIso });
    return { ...base, emailMessageId: msg?.id ?? null, outcome: "failed", reason: error };
  }
  const retryAt = new Date(Date.now() + kycRetryDelayMinutes(row.attempts) * 60_000).toISOString();
  await finish(row.id, { status: "pending", available_at: retryAt, last_error: error, email_message_id: msg?.id ?? null });
  return { ...base, emailMessageId: msg?.id ?? null, outcome: "retry_scheduled", reason: error };
}

/**
 * Claims and delivers due outbox events. Safe to call concurrently (SKIP LOCKED)
 * and repeatedly. Returns `schemaReady:false` if the migration is not applied.
 */
export async function processKycNotifications(options?: {
  userId?: string;
  ids?: string[];
  limit?: number;
}): Promise<{ schemaReady: boolean; results: KycDispatchOutcome[] }> {
  const { data, error } = await db.rpc("claim_kyc_notifications", {
    _limit: options?.limit ?? 20,
    _user_id: options?.userId ?? null,
    _ids: options?.ids ?? null,
  });
  if (error) {
    if (isMissingSchemaResourceError(error)) return { schemaReady: false, results: [] };
    throw error;
  }
  const results: KycDispatchOutcome[] = [];
  for (const row of (data ?? []) as KycOutboxRow[]) {
    try {
      results.push(await dispatchRow(row));
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Unexpected dispatch error.";
      await finish(row.id, {
        status: row.attempts >= KYC_MAX_DELIVERY_ATTEMPTS ? "failed" : "pending",
        available_at: new Date(Date.now() + kycRetryDelayMinutes(row.attempts) * 60_000).toISOString(),
        last_error: reason.slice(0, 500),
      });
      results.push({ id: row.id, eventType: row.event_type, outcome: "retry_scheduled", reason, emailMessageId: null });
    }
  }
  return { schemaReady: true, results };
}

/** Best-effort drain used after HR actions; never throws into the caller. */
export async function drainKycNotificationsSafely(userId?: string): Promise<void> {
  try {
    await processKycNotifications(userId ? { userId, limit: 10 } : { limit: 25 });
  } catch (error) {
    console.error("[kyc-notifications] drain failed", error instanceof Error ? error.message : error);
  }
}
