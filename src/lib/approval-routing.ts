// Pure approval-routing rules. Kept dependency-free so they can be unit
// tested directly and reused by Phase 2/3 review pipelines.
//
// The organisation-wide rule the whole product hangs on:
//   - A LEAD's own submissions never route to another lead. They escalate
//     straight to the Admin/Founder tier.
//   - Everyone else routes to their reporting lead, and only falls back to
//     the Admin tier when no reporting lead is assigned.

import type { AppRole } from "./permissions";

export type ApprovalTier = "lead" | "admin";

export type ApprovalRoutingInput = {
  /** Roles held by the person submitting the item. */
  submitterRoles: AppRole[];
  /** The submitter's reporting lead, if any. */
  reportingLeadId: string | null;
  /** Fallback approvers holding the admin tier (admin / founder / super admin). */
  adminApproverIds: string[];
};

export type ApprovalRoute = {
  tier: ApprovalTier;
  approverIds: string[];
  reason: string;
};

const ADMIN_TIER_ROLES: AppRole[] = ["admin", "founder", "super_admin"];

export function isLeadSubmitter(roles: AppRole[]): boolean {
  return roles.includes("lead");
}

export function isAdminTier(roles: AppRole[]): boolean {
  return roles.some((role) => ADMIN_TIER_ROLES.includes(role));
}

export function routeApproval(input: ApprovalRoutingInput): ApprovalRoute {
  const { submitterRoles, reportingLeadId, adminApproverIds } = input;

  if (isAdminTier(submitterRoles)) {
    return {
      tier: "admin",
      approverIds: adminApproverIds.filter((id) => id !== reportingLeadId),
      reason: "Admin-tier submitters are reviewed by the Admin/Founder tier.",
    };
  }

  if (isLeadSubmitter(submitterRoles)) {
    return {
      tier: "admin",
      approverIds: adminApproverIds,
      reason: "Lead submissions escalate to the Admin/Founder tier, never to another lead.",
    };
  }

  if (reportingLeadId) {
    return {
      tier: "lead",
      approverIds: [reportingLeadId],
      reason: "Staff submissions route to their reporting lead.",
    };
  }

  return {
    tier: "admin",
    approverIds: adminApproverIds,
    reason: "No reporting lead assigned — falls back to the Admin/Founder tier.",
  };
}
