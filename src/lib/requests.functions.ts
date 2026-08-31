import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "./actor.server";
import { writeAudit } from "./audit.server";
import { notify } from "./daily-queries.server";
import { isRequestType, type RequestTypeValue } from "./enums";
import {
  NO_REPORTING_LEAD_MESSAGE,
  resolveRequestStatus,
  routeRequest,
} from "./request-routing";
import { loadProfileNames, nameOf } from "./profile-names.server";
import type { AppRole } from "./permissions";

/**
 * The reporting lead who must approve this person's requests, resolved with the
 * same precedence the daily cycle uses: the active acknowledged allocation's
 * lead, then that project's lead, then the org reporting lead on the profile.
 */
async function resolveRequestLead(
  supabase: SupabaseClient<Database>,
  userId: string,
  profileLeadId: string | null,
): Promise<string | null> {
  const { data: allocations } = await supabase
    .from("project_allocations")
    .select("reporting_lead_id, projects(project_lead_id)")
    .eq("user_id", userId)
    .eq("status", "active")
    .not("acknowledged_at", "is", null);

  for (const allocation of allocations ?? []) {
    if (allocation.reporting_lead_id) return allocation.reporting_lead_id;
  }
  for (const allocation of allocations ?? []) {
    const projectLead = (allocation.projects as { project_lead_id?: string | null } | null)
      ?.project_lead_id;
    if (projectLead) return projectLead;
  }
  return profileLeadId;
}


const REQUEST_SELECT =
  "id, user_id, request_type, start_date, end_date, reason, day_id, requested_check_in, requested_check_out, status, routing_reason, submitted_at, decided_at, created_at";

const APPROVAL_SELECT =
  "id, request_id, tier, approver_id, decision, decided_by, decided_at, note, created_at";

export type SubmitRequestInput = {
  requestType: string;
  startDate: string;
  endDate: string;
  reason: string;
  requestedCheckIn?: string | null;
  requestedCheckOut?: string | null;
};

/**
 * Tells the UI, before anything is typed, whether this person's requests can be
 * routed at all. Staff with no resolvable reporting lead are blocked, so we warn
 * up front instead of failing on submit.
 */
export const previewRequestRouting = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [{ data: profile }, { data: roleRows }] = await Promise.all([
      supabase.from("profiles").select("reporting_lead_id").eq("id", userId).maybeSingle(),
      supabase.from("user_roles").select("role").eq("user_id", userId),
    ]);
    const leadId = await resolveRequestLead(supabase, userId, profile?.reporting_lead_id ?? null);
    const route = routeRequest({
      submitterRoles: (roleRows ?? []).map((r) => r.role as AppRole),
      reportingLeadId: leadId,
    });
    const names = leadId ? await loadProfileNames(supabase, [leadId]) : null;
    return {
      blocked: route.blocked,
      blockedReason: route.blockedReason ?? null,
      reason: route.reason,
      tiers: route.tiers,
      leadName: leadId && names ? (names.get(leadId)?.fullName ?? null) : null,
    };
  });

export const submitRequest = createServerFn({ method: "POST" })

  .middleware([requireSupabaseAuth])
  .inputValidator((input: SubmitRequestInput) => {
    if (!isRequestType(input?.requestType)) throw new Error("Pick a valid request type.");
    if (!input?.startDate || !input?.endDate) throw new Error("Pick the dates for this request.");
    if (input.endDate < input.startDate) throw new Error("The end date is before the start date.");
    if (!input?.reason?.trim()) throw new Error("Add a reason for this request.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "requests:submit:self");

    const [{ data: profile }, { data: roleRows }] = await Promise.all([
      supabase.from("profiles").select("full_name, reporting_lead_id").eq("id", userId).maybeSingle(),
      supabase.from("user_roles").select("role").eq("user_id", userId),
    ]);

    const route = routeRequest({
      submitterRoles: (roleRows ?? []).map((r) => r.role as AppRole),
      reportingLeadId: await resolveRequestLead(supabase, userId, profile?.reporting_lead_id ?? null),
    });

    if (route.blocked) {
      throw new Error(route.blockedReason ?? NO_REPORTING_LEAD_MESSAGE);
    }


    const { data: request, error } = await supabase
      .from("requests")
      .insert({
        user_id: userId,
        request_type: data.requestType as RequestTypeValue,
        start_date: data.startDate,
        end_date: data.endDate,
        reason: data.reason.trim(),
        requested_check_in: data.requestedCheckIn || null,
        requested_check_out: data.requestedCheckOut || null,
        routing_reason: route.reason,
      })
      .select(REQUEST_SELECT)
      .single();
    if (error) throw error;

    const { error: approvalError } = await supabase.from("request_approvals").insert(
      route.tiers.map((tier) => ({
        request_id: request.id,
        tier,
        approver_id: tier === "lead" ? route.leadApproverId : null,
      })),
    );
    if (approvalError) throw approvalError;

    // Notify every decision-maker who is required for this request.
    const recipients = new Set<string>();
    if (route.tiers.includes("lead") && route.leadApproverId) recipients.add(route.leadApproverId);
    if (route.tiers.includes("hr")) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: hrRows } = await supabaseAdmin
        .from("user_roles")
        .select("user_id")
        .in("role", ["hr", "admin", "super_admin"]);
      for (const row of hrRows ?? []) recipients.add(row.user_id);
    }
    recipients.delete(userId);

    let notified = 0;
    for (const recipient of recipients) {
      const ok = await notify(supabase, {
        userId: recipient,
        actorId: userId,
        type: "request.submitted",
        title: `${profile?.full_name ?? "A team member"} submitted a ${data.requestType.replace("_", " ")} request`,
        body: `${data.startDate} → ${data.endDate}: ${data.reason.trim()}`,
        entityType: "request",
        entityId: request.id,
      });
      if (ok) notified += 1;
    }

    await writeAudit(supabase, {
      actorId: userId,
      action: "request.submitted",
      entityType: "request",
      entityId: request.id,
      detail: { tiers: route.tiers, routing: route.reason, notified },
    });

    return { request, tiers: route.tiers, routingReason: route.reason, notified };
  });

async function loadRequestBundle(
  supabase: SupabaseClient<Database>,
  requestIds: string[],
) {
  if (requestIds.length === 0) return {};
  const { data } = await supabase
    .from("request_approvals")
    .select(APPROVAL_SELECT)
    .in("request_id", requestIds);

  // Names come from profile_names() so an approver's name never renders blank
  // just because the viewer lacks direct access to that profile row.
  const names = await loadProfileNames(
    supabase,
    (data ?? []).flatMap((row) => [row.approver_id, row.decided_by]),
  );

  const grouped: Record<
    string,
    (NonNullable<typeof data>[number] & {
      approver: { full_name: string } | null;
      decider: { full_name: string } | null;
    })[]
  > = {};
  for (const row of data ?? []) {
    (grouped[row.request_id] ??= []).push({
      ...row,
      approver: row.approver_id ? { full_name: nameOf(names, row.approver_id) } : null,
      decider: row.decided_by ? { full_name: nameOf(names, row.decided_by) } : null,
    });
  }
  return grouped;
}


export const listMyRequests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: requests, error } = await supabase
      .from("requests")
      .select(REQUEST_SELECT)
      .eq("user_id", userId)
      .order("submitted_at", { ascending: false });
    if (error) throw error;
    const approvals = await loadRequestBundle(supabase, (requests ?? []).map((r) => r.id));
    return (requests ?? []).map((r) => ({ ...r, approvals: approvals[r.id] ?? [] }));
  });

/** Everything the caller can act on or oversee. */
export const listRequestQueue = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [{ data: canLead }, { data: canHr }] = await Promise.all([
      supabase.rpc("has_permission", { _user_id: userId, _permission: "requests:approve:lead" }),
      supabase.rpc("has_permission", { _user_id: userId, _permission: "requests:approve:hr" }),
    ]);

    const { data: requests, error } = await supabase
      .from("requests")
      .select(REQUEST_SELECT)
      .neq("user_id", userId)
      .order("submitted_at", { ascending: false })
      .limit(200);
    if (error) throw error;

    const [approvals, names] = await Promise.all([
      loadRequestBundle(supabase, (requests ?? []).map((r) => r.id)),
      loadProfileNames(supabase, (requests ?? []).map((r) => r.user_id)),
    ]);
    return {
      canLead: canLead === true,
      canHr: canHr === true,
      requests: (requests ?? []).map((r) => ({
        ...r,
        profiles: {
          full_name: nameOf(names, r.user_id),
          designation: names.get(r.user_id)?.designation ?? null,
        },
        approvals: approvals[r.id] ?? [],
      })),
    };

  });

export const decideRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { requestId: string; tier: "lead" | "hr"; decision: "approved" | "rejected"; note?: string | null }) => {
      if (!input?.requestId) throw new Error("A request is required.");
      if (input?.tier !== "lead" && input?.tier !== "hr") throw new Error("Unknown approval tier.");
      if (input?.decision !== "approved" && input?.decision !== "rejected")
        throw new Error("A decision is required.");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(
      supabase,
      userId,
      data.tier === "lead" ? "requests:approve:lead" : "requests:approve:hr",
    );

    const { data: existing, error: loadError } = await supabase
      .from("request_approvals")
      .select(APPROVAL_SELECT)
      .eq("request_id", data.requestId)
      .eq("tier", data.tier)
      .maybeSingle();
    if (loadError) throw loadError;
    if (!existing) throw new Error("This request does not need a decision from your tier.");
    if (existing.decision !== "pending")
      throw new Error("That decision has already been recorded and cannot be changed.");
    // A lead may only decide requests routed to them, not another team's.
    if (data.tier === "lead" && existing.approver_id && existing.approver_id !== userId)
      throw new Error("This request is waiting on a different reporting lead.");

    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("request_approvals")
      .update({
        decision: data.decision,
        decided_by: userId,
        decided_at: now,
        note: data.note?.trim() || null,
        approver_id: existing.approver_id ?? userId,
      })
      .eq("id", existing.id);
    if (updateError) throw updateError;

    const { data: all, error: allError } = await supabase
      .from("request_approvals")
      .select("tier, decision")
      .eq("request_id", data.requestId);
    if (allError) throw allError;

    const overall = resolveRequestStatus(
      (all ?? []).map((a) => ({ decision: a.decision as "pending" | "approved" | "rejected" })),
    );

    const { data: request, error: reqError } = await supabase
      .from("requests")
      .update({ status: overall, decided_at: overall === "pending" ? null : now })
      .eq("id", data.requestId)
      .select(`${REQUEST_SELECT}`)
      .single();
    if (reqError) throw reqError;

    await supabase.from("review_events").insert({
      entity_type: "request",
      entity_id: data.requestId,
      subject_user_id: request.user_id,
      action: data.decision === "approved" ? "approved" : "revision_requested",
      note: data.note?.trim() || `${data.tier.toUpperCase()} ${data.decision}`,
      reviewer_id: userId,
    });

    const { data: me } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", userId)
      .maybeSingle();

    const notified = await notify(supabase, {
      userId: request.user_id,
      actorId: userId,
      type: `request.${data.tier}.${data.decision}`,
      title:
        overall === "pending"
          ? `${me?.full_name ?? "An approver"} ${data.decision} your request (${data.tier.toUpperCase()} step)`
          : `Your ${request.request_type.replace("_", " ")} request was ${overall}`,
      body: data.note?.trim() || null,
      entityType: "request",
      entityId: request.id,
    });

    await writeAudit(supabase, {
      actorId: userId,
      action: `request.${data.tier}.${data.decision}`,
      entityType: "request",
      entityId: request.id,
      detail: { overall, note: data.note ?? null, notified },
    });

    return { request, approvals: all ?? [], overall, notified };
  });

export const cancelRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { requestId: string }) => {
    if (!input?.requestId) throw new Error("A request is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("requests")
      .update({ status: "cancelled", decided_at: new Date().toISOString() })
      .eq("id", data.requestId)
      .eq("user_id", userId)
      .eq("status", "pending")
      .select(REQUEST_SELECT)
      .maybeSingle();
    if (error) throw error;
    if (!row) throw new Error("Only your own pending request can be cancelled.");
    await writeAudit(supabase, {
      actorId: userId,
      action: "request.cancelled",
      entityType: "request",
      entityId: row.id,
    });
    return { request: row };
  });
