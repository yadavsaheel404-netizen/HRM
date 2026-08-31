// Pure routing rules for leave / WFH / attendance-correction requests.
//
//   Employee (or intern / freelancer / trainer) → reporting LEAD **and** HR.
//     Both decisions are independently required; the request is only approved
//     once both say yes, and a single rejection rejects it.
//   Lead → HR only. A lead's request never routes to another lead.
//   HR / admin tier (admin / founder / super admin) → HR only.
//   Staff with NO reporting lead → BLOCKED. Routing to HR alone would quietly
//     drop the Lead approval the spec requires, so the request is refused.

import { isAdminTier, isLeadSubmitter } from "./approval-routing";

/** HR staff have no lead tier above them, so their own requests go to HR peers. */
function routesToHrOnly(roles: AppRole[]): boolean {
  return isLeadSubmitter(roles) || isAdminTier(roles) || roles.includes("hr");
}
import type { AppRole } from "./permissions";

export type RequestTier = "lead" | "hr";

export type RequestRoute = {
  tiers: RequestTier[];
  leadApproverId: string | null;
  reason: string;
  /**
   * True when the request MUST NOT be created: a staff submitter with no
   * resolvable reporting lead. Routing to HR alone would silently drop the
   * Lead approval the spec requires, so we fail instead of downgrading.
   */
  blocked: boolean;
  blockedReason?: string;
};

export const NO_REPORTING_LEAD_MESSAGE =
  "Your reporting lead isn't set yet, so this request can't be routed for approval. Ask HR or your admin to assign your reporting lead, then submit again.";

export function routeRequest(input: {
  submitterRoles: AppRole[];
  reportingLeadId: string | null;
}): RequestRoute {
  const { submitterRoles, reportingLeadId } = input;

  if (routesToHrOnly(submitterRoles)) {
    return {
      tiers: ["hr"],
      leadApproverId: null,
      reason: "Lead / HR / admin-tier requests route to HR only, never to another lead.",
      blocked: false,
    };
  }

  if (!reportingLeadId) {
    return {
      tiers: [],
      leadApproverId: null,
      reason:
        "Staff requests need a reporting lead. None is assigned, so the request is blocked rather than downgraded to HR-only.",
      blocked: true,
      blockedReason: NO_REPORTING_LEAD_MESSAGE,
    };
  }

  return {
    tiers: ["lead", "hr"],
    leadApproverId: reportingLeadId,
    reason: "Staff requests need the reporting lead AND HR to approve independently.",
    blocked: false,
  };
}


/** Overall request status from the decision rows. Rejection by anyone wins. */
export function resolveRequestStatus(
  decisions: { decision: "pending" | "approved" | "rejected" }[],
): "pending" | "approved" | "rejected" {
  if (decisions.some((d) => d.decision === "rejected")) return "rejected";
  if (decisions.length > 0 && decisions.every((d) => d.decision === "approved")) return "approved";
  return "pending";
}

/**
 * True when this person is staff who WILL be blocked from submitting requests
 * because no reporting lead is assigned. Leads and admin-tier people route to
 * HR by design, so they never need one.
 */
export function needsReportingLead(input: {
  roles: string[];
  employmentStatus?: string | null;
  reportingLeadId?: string | null;
}): boolean {
  const roles = input.roles as AppRole[];
  if (routesToHrOnly(roles)) return false;
  if (input.employmentStatus && input.employmentStatus !== "active") return false;
  return !input.reportingLeadId;
}
