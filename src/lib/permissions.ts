// Client-safe permission catalogue. The database is the source of truth for
// which role holds which permission — this file only names them and gives
// them human labels so the UI can render the matrix and reason about routes.

export const PERMISSION_KEYS = [
  "workforce:read:self",
  "workforce:read:team",
  "workforce:read:all",
  "workforce:create:all",
  "workforce:update:self",
  "workforce:update:all",
  "workforce:deactivate:all",
  "documents:read:self",
  "documents:read:team",
  "documents:read:all",
  "documents:upload:self",
  "documents:verify:all",
  "invitations:read:all",
  "invitations:create:all",
  "rbac:manage:all",
  "rbac:assign:all",
  "org:manage:all",
  "audit:read:all",
  "projects:read:all",
  "projects:read:team",
  "projects:manage:team",
  "projects:manage:all",
  "allocations:read:all",
  "allocations:read:team",
  "allocations:manage:team",
  "allocations:manage:all",
  "allocations:acknowledge:self",
  "attendance:log:self",
  "attendance:read:self",
  "attendance:read:team",
  "attendance:read:all",
  "attendance:update:all",
  "tasks:log:self",
  "tasks:read:team",
  "tasks:read:all",
  "tasks:review:team",
  "blockers:raise:self",
  "blockers:manage:team",
  "eod:submit:self",
  "eod:read:team",
  "eod:read:all",
  "eod:review:team",
  "requests:submit:self",
  "requests:read:self",
  "requests:read:team",
  "requests:read:all",
  "requests:approve:lead",
  "requests:approve:hr",
  "announcements:read:all",
  "announcements:manage:all",
  "analytics:read:team",
  "analytics:read:all",
  "reports:export:scoped",
  "automation:run:all",
  "import:manage:all",
  "recruitment:read:all",
  "recruitment:manage:all",
  "interviews:read:all",
  "interviews:manage:all",
  "interviews:feedback:assigned",
  "emails:read:all",
  "emails:manage:all",
  "emails:send:all",
  "relieving:read:all",
  "relieving:manage:all",
  "relieving:approve:all",
  "relieving:send:all",
  "relieving:read:self",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const APP_ROLES = [
  "super_admin",
  "founder",
  "hr",
  "admin",
  "manager",
  "lead",
  "employee",
] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const ROLE_LABELS: Record<AppRole, string> = {
  super_admin: "Super Admin",
  founder: "Founder",
  hr: "HR",
  admin: "Admin",
  manager: "Manager",
  lead: "Project / Team Lead",
  employee: "Employee",
};

export const ROLE_RANKS: Record<AppRole, number> = {
  super_admin: 1,
  founder: 2,
  hr: 3,
  admin: 4,
  manager: 5,
  lead: 6,
  employee: 7,
};

/**
 * Returns the exact set of roles an actor is permitted to grant or revoke:
 * - Super Admin: all assignable organizational roles (super_admin is singleton for the system owner only)
 * - HR: Admin, Manager, Lead, Employee (can grant/revoke Admin, cannot touch Super Admin/Founder/HR)
 * - Admin: Manager, Lead, Employee (cannot grant/revoke Admin, HR, Founder, or Super Admin)
 */
export function assignableRolesFor(actorRoles: readonly string[]): AppRole[] {
  if (actorRoles.includes("super_admin")) {
    return ["founder", "hr", "admin", "manager", "lead", "employee"];
  }
  if (actorRoles.includes("hr")) {
    return ["admin", "manager", "lead", "employee"];
  }
  if (actorRoles.includes("admin")) {
    return ["manager", "lead", "employee"];
  }
  return [];
}

export function canAssignRole(actorRoles: readonly string[], targetRole: AppRole): boolean {
  if (targetRole === "super_admin") return false;
  return assignableRolesFor(actorRoles).includes(targetRole);
}

export function canModifyUserRoles(
  actorRoles: readonly string[],
  targetCurrentRoles: readonly string[],
): boolean {
  if (targetCurrentRoles.includes("super_admin")) return false;
  if (actorRoles.includes("super_admin")) return true;
  if (actorRoles.includes("hr")) {
    return !targetCurrentRoles.some(
      (r) => r === "super_admin" || r === "founder" || r === "hr",
    );
  }
  if (actorRoles.includes("admin")) {
    return !targetCurrentRoles.some(
      (r) => r === "super_admin" || r === "founder" || r === "hr" || r === "admin",
    );
  }
  return false;
}

/**
 * Full 1-to-1 mirror of SQL `public.can_actor_assign_role(_actor_id, _target_user_id, _role)`.
 */
export function canActorAssignRole(
  actorId: string | null | undefined,
  actorRoles: readonly string[],
  targetUserId: string | null | undefined,
  targetCurrentRoles: readonly string[],
  roleToChange: AppRole,
): boolean {
  if (!actorId || !targetUserId || actorId === targetUserId) return false;
  if (!canModifyUserRoles(actorRoles, targetCurrentRoles)) return false;
  return canAssignRole(actorRoles, roleToChange);
}

/** Roles permitted to view `/reports` and trigger CSV / Excel exports (within RLS scope). */
export const REPORT_EXPORT_ROLES: readonly AppRole[] = [
  "super_admin",
  "founder",
  "hr",
  "admin",
  "manager",
] as const;

export function canExportReports(
  actorRoles: readonly string[],
  actorPermissions: readonly string[],
): boolean {
  if (!actorRoles.some((r) => REPORT_EXPORT_ROLES.includes(r as AppRole))) {
    return false;
  }
  if (actorRoles.includes("super_admin")) return true;
  return (
    actorPermissions.includes("reports:export:scoped") ||
    actorPermissions.includes("analytics:read:all") ||
    actorPermissions.includes("analytics:read:team")
  );
}

/**
 * Sensitive employee KYC/financial documents may ONLY be opened by the document owner,
 * HR, or Super Admin.
 */
export function canAccessEmployeeDocuments(
  actorUserId: string,
  ownerUserId: string,
  actorRoles: readonly string[],
  actorPermissions: readonly string[],
): boolean {
  if (actorUserId && actorUserId === ownerUserId) return true;
  if (actorRoles.includes("super_admin")) return true;
  return (
    actorRoles.includes("hr") && actorPermissions.includes("documents:read:all")
  );
}

/** Permissions Founder is never allowed to hold (strict read-only oversight). */
export function isReadOnlySafePermission(permissionKey: string): boolean {
  if (permissionKey === "reports:export:scoped") return true;
  if (permissionKey === "documents:read:all" || permissionKey === "documents:read:team") {
    return false;
  }
  const parts = permissionKey.split(":");
  return parts[1] === "read";
}

export type ScopedOrgGraph = {
  /** Map of department_id -> manager user IDs */
  departmentManagers: ReadonlyMap<string, ReadonlySet<string>>;
  /** Profiles indexed by user ID */
  profiles: ReadonlyMap<
    string,
    { id: string; departmentId: string | null; reportingLeadId: string | null }
  >;
  /** Projects indexed by project ID */
  projects: ReadonlyMap<
    string,
    {
      id: string;
      departmentId: string | null;
      projectManagerId: string | null;
      leadUserIds: ReadonlySet<string>;
      createdBy?: string | null;
    }
  >;
  /** Non-ended allocations per user ID */
  activeAllocationsByUser: ReadonlyMap<
    string,
    readonly { projectId: string; reportingLeadId: string | null }[]
  >;
};

export function isDepartmentManagerInGraph(
  graph: ScopedOrgGraph,
  departmentId: string | null | undefined,
  userId: string | null | undefined,
): boolean {
  if (!departmentId || !userId) return false;
  return graph.departmentManagers.get(departmentId)?.has(userId) ?? false;
}

export function isWorkLeadOfInGraph(
  graph: ScopedOrgGraph,
  ownerId: string,
  viewerId: string,
): boolean {
  if (!ownerId || !viewerId || ownerId === viewerId) return false;
  const owner = graph.profiles.get(ownerId);
  if (owner?.reportingLeadId === viewerId) return true;
  const allocs = graph.activeAllocationsByUser.get(ownerId) ?? [];
  for (const alloc of allocs) {
    if (alloc.reportingLeadId === viewerId) return true;
    const proj = graph.projects.get(alloc.projectId);
    if (proj?.leadUserIds.has(viewerId)) return true;
  }
  return false;
}

/**
 * Pure 1-to-1 mirror of SQL `public.is_manager_of(_owner, _viewer)`.
 * Enforces strict isolation to assigned departments, assigned projects, direct reports, and 2-hop Lead trees.
 */
export function isManagerOfInGraph(
  graph: ScopedOrgGraph,
  ownerId: string,
  viewerId: string,
  viewerRoles: readonly string[],
): boolean {
  if (!ownerId || !viewerId || ownerId === viewerId) return false;
  if (!viewerRoles.includes("manager")) return false;

  const owner = graph.profiles.get(ownerId);
  if (owner) {
    if (isDepartmentManagerInGraph(graph, owner.departmentId, viewerId)) return true;
    if (owner.reportingLeadId === viewerId) return true;
    if (owner.reportingLeadId) {
      const lead = graph.profiles.get(owner.reportingLeadId);
      if (lead) {
        if (lead.reportingLeadId === viewerId) return true;
        if (isDepartmentManagerInGraph(graph, lead.departmentId, viewerId)) return true;
      }
    }
  }

  const allocs = graph.activeAllocationsByUser.get(ownerId) ?? [];
  for (const alloc of allocs) {
    const proj = graph.projects.get(alloc.projectId);
    if (!proj) continue;
    if (proj.projectManagerId === viewerId) return true;
    if (proj.createdBy === viewerId) return true;
    if (isDepartmentManagerInGraph(graph, proj.departmentId, viewerId)) return true;
    if (proj.leadUserIds.has(viewerId)) return true;
  }

  return false;
}

export function canManageProjectInGraph(
  graph: ScopedOrgGraph,
  projectId: string,
  actorId: string,
  actorPermissions: readonly string[],
): boolean {
  if (!projectId || !actorId) return false;
  if (actorPermissions.includes("projects:manage:all")) return true;
  if (!actorPermissions.includes("projects:manage:team")) return false;
  const proj = graph.projects.get(projectId);
  if (!proj) return false;
  return (
    proj.projectManagerId === actorId ||
    proj.createdBy === actorId ||
    isDepartmentManagerInGraph(graph, proj.departmentId, actorId)
  );
}

/**
 * Pure 1-to-1 mirror of SQL `public.can_review_subordinate_or_escalate(_subject_user_id, _reviewer_id)`.
 * Prohibits self-review; allows direct Lead, scoped Manager, Admin, or Super Admin.
 */
export function canReviewSubordinateOrEscalateInGraph(
  graph: ScopedOrgGraph,
  subjectUserId: string,
  reviewerId: string,
  reviewerRoles: readonly string[],
): boolean {
  if (!subjectUserId || !reviewerId || subjectUserId === reviewerId) return false;
  if (reviewerRoles.includes("super_admin") || reviewerRoles.includes("admin")) return true;
  return (
    isWorkLeadOfInGraph(graph, subjectUserId, reviewerId) ||
    isManagerOfInGraph(graph, subjectUserId, reviewerId, reviewerRoles)
  );
}

export const USER_CATEGORIES = ["full_time", "intern", "freelancer", "trainer"] as const;
export type UserCategory = (typeof USER_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<UserCategory, string> = {
  full_time: "Full-Time Employee",
  intern: "Intern",
  freelancer: "Freelancer",
  trainer: "Trainer",
};

export const ACCOUNT_STATUSES = [
  "invited",
  "activated",
  "profile_pending",
  "under_verification",
  "active",
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  invited: "Invited",
  activated: "Activated",
  profile_pending: "Profile Pending",
  under_verification: "Under Verification",
  active: "Active",
};

export const EMPLOYMENT_STATUSES = ["active", "inactive", "on_hold", "exited", "relieved"] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

export const DOCUMENT_TYPES = [
  "resume",
  "identity_proof",
  "pan",
  "bank_details",
  "education",
  "offer_letter",
  "nda",
  "other",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  resume: "Resume",
  identity_proof: "Identity Proof",
  pan: "PAN",
  bank_details: "Bank Details",
  education: "Educational Documents",
  offer_letter: "Offer Letter / Contract",
  nda: "NDA",
  other: "Other",
};

/** Documents every person must upload before HR can verify the profile. */
export const REQUIRED_DOCUMENT_TYPES: DocumentType[] = [
  "resume",
  "identity_proof",
  "pan",
  "bank_details",
  "education",
];

export type Actor = {
  userId: string;
  fullName: string;
  workEmail: string;
  accountStatus: AccountStatus;
  category: UserCategory;
  roles: AppRole[];
  permissions: PermissionKey[];
  mustChangePassword?: boolean;
};

export function actorCan(actor: Actor | null | undefined, permission: PermissionKey): boolean {
  return actor?.permissions.includes(permission) ?? false;
}

/** Resolves the highest-ranking authorization role held by an actor. */
export function resolvePrimaryRole(roles: readonly string[]): AppRole {
  let best: AppRole = "employee";
  let bestRank = Number.POSITIVE_INFINITY;
  for (const r of roles) {
    if (r in ROLE_RANKS) {
      const rank = ROLE_RANKS[r as AppRole];
      if (rank < bestRank) {
        bestRank = rank;
        best = r as AppRole;
      }
    }
  }
  return best;
}

/**
 * True when an account holds ONLY executive/root governance roles (`super_admin` or `founder`)
 * without operational employee/lead/manager/hr/admin roles — exempting it from employee KYC nagging.
 */
export function isExecutiveGovernanceOnly(roles: readonly string[]): boolean {
  if (roles.length === 0) return false;
  const hasExec = roles.includes("super_admin") || roles.includes("founder");
  const hasOperational = roles.some(
    (r) => r === "hr" || r === "admin" || r === "manager" || r === "lead" || r === "employee",
  );
  return hasExec && !hasOperational;
}

/**
 * Sensitive employee PII (personal email, home address, date of birth) may only
 * be viewed by the person themselves, HR, or Super Admin.
 */
export function canViewEmployeeSensitivePii(
  actorUserId: string,
  ownerUserId: string,
  actorRoles: readonly string[],
): boolean {
  if (actorUserId && actorUserId === ownerUserId) return true;
  return actorRoles.includes("super_admin") || actorRoles.includes("hr");
}

/**
 * Candidate profile & resume access:
 * - Super Admin, Founder, HR, Admin via `recruitment:read:all`
 * - Assigned Manager / Lead interviewer ONLY for candidates they are scheduled to interview
 */
export function canAccessCandidateRecord(
  actorUserId: string,
  actorPermissions: readonly string[],
  assignedInterviewerIdsForCandidate: readonly string[],
): boolean {
  if (!actorUserId) return false;
  if (actorPermissions.includes("recruitment:read:all")) return true;
  if (
    actorPermissions.includes("interviews:feedback:assigned") &&
    assignedInterviewerIdsForCandidate.includes(actorUserId)
  ) {
    return true;
  }
  return false;
}

/**
 * Interview feedback submission:
 * - HR / Super Admin via `interviews:manage:all`
 * - Assigned interviewer (Manager / Lead / HR) via `interviews:feedback:assigned` + membership in `interviewer_ids`
 */
export function canSubmitInterviewFeedback(
  actorUserId: string,
  actorPermissions: readonly string[],
  interviewInterviewerIds: readonly string[],
): boolean {
  if (!actorUserId) return false;
  if (actorPermissions.includes("interviews:manage:all")) return true;
  return (
    actorPermissions.includes("interviews:feedback:assigned") &&
    interviewInterviewerIds.includes(actorUserId)
  );
}

const MANAGER_FORBIDDEN_ORG_WIDE_KEYS: readonly PermissionKey[] = [
  "workforce:read:all",
  "documents:read:team",
  "documents:read:all",
  "projects:read:all",
  "projects:manage:all",
  "allocations:read:all",
  "allocations:manage:all",
  "attendance:read:all",
  "tasks:read:all",
  "eod:read:all",
  "requests:read:all",
  "analytics:read:all",
  "recruitment:read:all",
  "recruitment:manage:all",
  "interviews:read:all",
  "interviews:manage:all",
  "emails:read:all",
  "emails:manage:all",
  "emails:send:all",
];

const RECRUITMENT_ADMIN_KEYS: readonly PermissionKey[] = [
  "recruitment:read:all",
  "recruitment:manage:all",
  "interviews:read:all",
  "interviews:manage:all",
  "interviews:feedback:assigned",
  "emails:read:all",
  "emails:manage:all",
  "emails:send:all",
];

/**
 * Normalizes effective permissions for an actor's role set so Phase P0/P1/P2 security
 * boundaries (Founder read-only, Manager isolation, KYC privacy, Recruitment & Email Center RBAC)
 * work identically both before and after pending SQL migrations are applied in production.
 */
export function normalizeEffectivePermissions(
  roles: readonly string[],
  rawPermissions: readonly string[],
): PermissionKey[] {
  if (roles.includes("super_admin")) {
    return [...PERMISSION_KEYS];
  }

  const validSet = new Set<string>(PERMISSION_KEYS);
  const next = new Set<PermissionKey>();
  for (const key of rawPermissions) {
    if (validSet.has(key)) next.add(key as PermissionKey);
  }

  const hasNonFounderRole = roles.some((r) => r !== "founder");
  const hasOrgWideRole = roles.some(
    (r) => r === "super_admin" || r === "founder" || r === "hr" || r === "admin",
  );
  const hasSupervisoryOrAdminRole = roles.some(
    (r) =>
      r === "super_admin" ||
      r === "founder" ||
      r === "hr" ||
      r === "admin" ||
      r === "manager" ||
      r === "lead",
  );

  // Synthesize new P0 scoped/self keys for roles that own them
  if (hasNonFounderRole && roles.length > 0) {
    next.add("workforce:update:self");
  }
  if (roles.some((r) => REPORT_EXPORT_ROLES.includes(r as AppRole))) {
    next.add("reports:export:scoped");
  }
  if (roles.includes("hr")) {
    next.add("recruitment:read:all");
    next.add("recruitment:manage:all");
    next.add("interviews:read:all");
    next.add("interviews:manage:all");
    next.add("interviews:feedback:assigned");
    next.add("emails:read:all");
    next.add("emails:manage:all");
    next.add("emails:send:all");
    next.add("relieving:read:all");
    next.add("relieving:manage:all");
    next.add("relieving:approve:all");
    next.add("relieving:send:all");
  }
  if (roles.includes("admin")) {
    next.add("attendance:update:all");
    next.add("recruitment:read:all");
    next.add("interviews:read:all");
    next.add("emails:read:all");
    next.add("relieving:read:all");
  }
  if (roles.some((r) => r === "employee" || r === "lead" || r === "manager" || r === "admin" || r === "hr")) {
    next.add("relieving:read:self");
  }
  if (roles.includes("manager")) {
    next.add("projects:manage:team");
    next.add("allocations:manage:team");
    next.add("workforce:read:team");
    next.add("projects:read:team");
    next.add("allocations:read:team");
    next.add("attendance:read:team");
    next.add("tasks:read:team");
    next.add("tasks:review:team");
    next.add("blockers:manage:team");
    next.add("eod:read:team");
    next.add("eod:review:team");
    next.add("requests:read:team");
    next.add("requests:approve:lead");
    next.add("analytics:read:team");
    next.add("interviews:feedback:assigned");
  }
  if (roles.includes("lead")) {
    next.add("interviews:feedback:assigned");
  }

  // Founder-only accounts are strictly read-only
  if (roles.includes("founder") && !hasNonFounderRole) {
    for (const key of [...next]) {
      if (!isReadOnlySafePermission(key)) {
        next.delete(key);
      }
    }
    next.add("workforce:read:all");
    next.add("projects:read:all");
    next.add("allocations:read:all");
    next.add("attendance:read:all");
    next.add("tasks:read:all");
    next.add("eod:read:all");
    next.add("requests:read:all");
    next.add("analytics:read:all");
    next.add("reports:export:scoped");
    next.add("recruitment:read:all");
    next.add("interviews:read:all");
    next.add("emails:read:all");
  }

  // Pure Manager / Lead accounts never hold org-wide :all permissions
  if ((roles.includes("manager") || roles.includes("lead")) && !hasOrgWideRole) {
    for (const key of MANAGER_FORBIDDEN_ORG_WIDE_KEYS) {
      next.delete(key);
    }
  }

  // Pure Employee accounts have zero recruitment administration or interview access
  if (!hasSupervisoryOrAdminRole) {
    for (const key of RECRUITMENT_ADMIN_KEYS) {
      next.delete(key);
    }
  }

  // HR-only recruitment & email mutations (unless Super Admin, handled above)
  if (!roles.includes("hr")) {
    next.delete("recruitment:manage:all");
    next.delete("interviews:manage:all");
    next.delete("emails:manage:all");
    next.delete("emails:send:all");
    next.delete("relieving:manage:all");
    next.delete("relieving:approve:all");
    next.delete("relieving:send:all");
  }

  // KYC document privacy: raw read/verify restricted to HR (+ Super Admin handled above)
  if (!roles.includes("hr")) {
    next.delete("documents:read:all");
    next.delete("documents:verify:all");
  }
  next.delete("documents:read:team");

  return Array.from(next);
}
