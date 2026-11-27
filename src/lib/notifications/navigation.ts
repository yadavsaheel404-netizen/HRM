import {
  actorCan,
  isExecutiveGovernanceOnly,
  resolvePrimaryRole,
  type Actor,
} from "../permissions";

export type NotificationIconKind =
  | "kyc"
  | "profile"
  | "request"
  | "break"
  | "attendance"
  | "project"
  | "task"
  | "eod"
  | "blocker"
  | "interview"
  | "candidate"
  | "relieving"
  | "records"
  | "general";

export type NotificationRow = {
  id: string;
  user_id: string;
  actor_id?: string | null | undefined;
  type: string;
  title: string;
  body?: string | null | undefined;
  entity_type?: string | null | undefined;
  entity_id?: string | null | undefined;
  action_url?: string | null | undefined;
  section?: string | null | undefined;
  action_label?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
  read_at?: string | null | undefined;
  created_at: string;
};

export type ResolvedNotificationLink = {
  to: string;
  search: Record<string, string>;
  label: string;
  icon: NotificationIconKind;
  unavailable?: boolean;
  unavailableMessage?: string;
  fallbackTo?: string;
  isHistoricalFallback?: boolean;
};

export const UNAVAILABLE_TARGET_MESSAGE =
  "This item is no longer available or you don't have permission to view it.";

const FORBIDDEN_METADATA_KEYS = new Set([
  "pan",
  "pan_number",
  "aadhaar",
  "aadhaar_number",
  "bank_account",
  "account_number",
  "ifsc",
  "password",
  "temp_password",
  "signed_url",
  "file_path",
  "token",
  "secret",
  "address",
  "current_address",
  "permanent_address",
  "date_of_birth",
  "personal_email",
]);

/** Validates that a persisted action_url is strictly a relative internal route path. */
export function isSafeInternalActionUrl(url: string | null | undefined): url is string {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed.startsWith("/")) return false;
  if (trimmed.startsWith("//") || trimmed.startsWith("/\\")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.includes("://")) return false;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return false;
  return true;
}

/** Strips sensitive keys before saving structured metadata into public.notifications. */
export function sanitizeNotificationMetadata(
  meta: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean | null> {
  if (!meta || typeof meta !== "object") return {};
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(meta)) {
    const keyLower = k.trim().toLowerCase();
    if (!keyLower || FORBIDDEN_METADATA_KEYS.has(keyLower)) continue;
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      v === null
    ) {
      clean[k] = typeof v === "string" ? v.slice(0, 200) : v;
    }
  }
  return clean;
}

/** Parses `/path?k=v` safely into route pathname and search record. */
export function parseInternalActionUrl(
  url: string | null | undefined,
): { to: string; search: Record<string, string> } | null {
  if (!isSafeInternalActionUrl(url)) return null;
  const qIdx = url.indexOf("?");
  const hashIdx = url.indexOf("#");
  const endPathIdx =
    qIdx !== -1 && hashIdx !== -1
      ? Math.min(qIdx, hashIdx)
      : qIdx !== -1
        ? qIdx
        : hashIdx !== -1
          ? hashIdx
          : url.length;
  const rawPath = url.slice(0, endPathIdx) || "/";
  const to = rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  const search: Record<string, string> = {};
  if (qIdx !== -1) {
    const querySlice = hashIdx > qIdx ? url.slice(qIdx + 1, hashIdx) : url.slice(qIdx + 1);
    const params = new URLSearchParams(querySlice);
    for (const [k, v] of params.entries()) {
      if (k && v) search[k] = v;
    }
  }
  return { to, search };
}

function metaString(meta: Record<string, unknown> | null | undefined, key: string): string | null {
  const val = meta?.[key];
  return typeof val === "string" && val.trim() ? val.trim() : null;
}

function defaultModuleForActor(actor: Pick<Actor, "roles" | "permissions" | "accountStatus">): string {
  return "/dashboard";
}

/** Checks RBAC permission for a target internal route path without bypassing RLS. */
export function canAccessRouteForActor(
  to: string,
  actor: Pick<Actor, "roles" | "permissions" | "accountStatus" | "userId" | "fullName" | "workEmail" | "category">,
): boolean {
  const fullActor = actor as Actor;
  const execOnly = isExecutiveGovernanceOnly(actor.roles);
  const primaryRole = resolvePrimaryRole(actor.roles);

  if (to === "/" || to === "/dashboard" || to === "/onboarding") return true;
  if (to === "/workforce" || to.startsWith("/workforce/")) {
    return actorCan(fullActor, "workforce:read:all") || actorCan(fullActor, "workforce:read:team");
  }
  if (to === "/requests") {
    return (
      actorCan(fullActor, "requests:read:self") ||
      actorCan(fullActor, "requests:read:team") ||
      actorCan(fullActor, "requests:read:all")
    );
  }
  if (to === "/my-day") {
    return !execOnly && actorCan(fullActor, "attendance:log:self");
  }
  if (to === "/my-projects") {
    return !execOnly && actorCan(fullActor, "allocations:acknowledge:self");
  }
  if (to === "/projects" || to.startsWith("/projects/")) {
    return actorCan(fullActor, "projects:read:all") || actorCan(fullActor, "projects:read:team");
  }
  if (to === "/reviews") {
    return (
      (!execOnly || primaryRole === "founder") &&
      (actorCan(fullActor, "tasks:read:team") || actorCan(fullActor, "tasks:review:team"))
    );
  }
  if (to === "/team") {
    return actorCan(fullActor, "attendance:read:all") || actorCan(fullActor, "attendance:read:team");
  }
  if (to === "/interviews") {
    return (
      actorCan(fullActor, "interviews:read:all") ||
      actorCan(fullActor, "interviews:feedback:assigned")
    );
  }
  if (to === "/candidates" || to.startsWith("/candidates/")) {
    return actorCan(fullActor, "recruitment:read:all");
  }
  if (to === "/employee-relieving") {
    return (
      actorCan(fullActor, "relieving:read:all") ||
      actorCan(fullActor, "relieving:read:self")
    );
  }
  if (to === "/records") {
    return actorCan(fullActor, "records:read:all");
  }
  return false;
}

function buildGuardedResult(
  candidate: {
    to: string;
    search?: Record<string, string | null | undefined>;
    label: string;
    icon: NotificationIconKind;
    fallbackTo?: string;
    isHistoricalFallback?: boolean;
  },
  actor: Pick<Actor, "roles" | "permissions" | "accountStatus" | "userId" | "fullName" | "workEmail" | "category">,
  protectedSubject = false,
): ResolvedNotificationLink {
  const cleanSearch: Record<string, string> = {};
  for (const [k, v] of Object.entries(candidate.search ?? {})) {
    if (typeof v === "string" && v.trim()) cleanSearch[k] = v.trim();
  }

  const viewerIsSuperAdmin = actor.roles.includes("super_admin");
  if (protectedSubject && !viewerIsSuperAdmin) {
    return {
      to: "/dashboard",
      search: {},
      label: "View Dashboard",
      icon: candidate.icon,
      unavailable: true,
      unavailableMessage: UNAVAILABLE_TARGET_MESSAGE,
      fallbackTo: "/dashboard",
    };
  }

  if (!canAccessRouteForActor(candidate.to, actor)) {
    const fallback =
      candidate.fallbackTo && canAccessRouteForActor(candidate.fallbackTo, actor)
        ? candidate.fallbackTo
        : defaultModuleForActor(actor);
    return {
      to: fallback,
      search: {},
      label: "Open Module",
      icon: candidate.icon,
      unavailable: true,
      unavailableMessage: UNAVAILABLE_TARGET_MESSAGE,
      fallbackTo: fallback,
    };
  }

  return {
    to: candidate.to,
    search: cleanSearch,
    label: candidate.label,
    icon: candidate.icon,
    ...(candidate.fallbackTo ? { fallbackTo: candidate.fallbackTo } : {}),
    ...(candidate.isHistoricalFallback ? { isHistoricalFallback: true } : {}),
  };
}

/**
 * Resolves any HRM notification (new deep-linked or legacy historical row)
 * into a validated, role-safe TanStack Router destination + section + highlight target.
 * Never infers target IDs from untrusted message text or allows external URLs.
 */
export function resolveNotificationLink(
  notification: NotificationRow,
  actor: Pick<Actor, "roles" | "permissions" | "accountStatus" | "userId" | "fullName" | "workEmail" | "category">,
  options?: { protectedIds?: ReadonlySet<string> },
): ResolvedNotificationLink {
  const meta = notification.metadata ?? {};
  const t = String(notification.type ?? "").trim();
  const entityType = notification.entity_type ?? null;
  const entityId = notification.entity_id ?? null;
  const actorId = notification.actor_id ?? null;
  const employeeFromMeta = metaString(meta, "employeeId");
  const workDate = metaString(meta, "workDate") ?? metaString(meta, "date");
  const isProtectedSubject =
    meta["protectedSubject"] === true ||
    Boolean(
      options?.protectedIds &&
        ((actorId && options.protectedIds.has(actorId)) ||
          (employeeFromMeta && options.protectedIds.has(employeeFromMeta)) ||
          (entityType === "profile" && entityId && options.protectedIds.has(entityId))),
    );

  // 1. Honor verified internal action_url first if present and safe
  const parsedExplicit = parseInternalActionUrl(notification.action_url);
  if (parsedExplicit) {
    const icon = iconForType(t, entityType);
    const label = notification.action_label?.trim() || defaultLabelForType(t);
    return buildGuardedResult(
      {
        to: parsedExplicit.to,
        search: {
          ...(notification.section ? { section: notification.section } : {}),
          ...parsedExplicit.search,
        },
        label,
        icon,
      },
      actor,
      isProtectedSubject,
    );
  }

  // 2. Typed routing + historical structured entity fallback
  // KYC submitted / document uploaded (HR review)
  if (t === "kyc.submitted" || t === "document.uploaded") {
    const targetUserId = employeeFromMeta || actorId;
    if (targetUserId) {
      return buildGuardedResult(
        {
          to: `/workforce/${targetUserId}`,
          search: { section: "documents", docId: entityId },
          label: "Review Documents",
          icon: "kyc",
          fallbackTo: "/workforce",
        },
        actor,
        isProtectedSubject,
      );
    }
    return buildGuardedResult(
      { to: "/workforce", search: {}, label: "Open Workforce", icon: "kyc", isHistoricalFallback: true },
      actor,
      isProtectedSubject,
    );
  }

  // KYC rejection / correction required (self)
  if (t === "kyc.correction_required" || t === "kyc.document_rejected") {
    return buildGuardedResult(
      {
        to: "/onboarding",
        search: { section: "documents", filter: "rejected", docId: metaString(meta, "docId") },
        label: "Fix Documents",
        icon: "kyc",
      },
      actor,
    );
  }

  // KYC verified / under review (self)
  if (t === "kyc.verified" || t === "kyc.under_review" || entityType === "kyc") {
    return buildGuardedResult(
      {
        to: "/onboarding",
        search: { section: "documents" },
        label: "View KYC Status",
        icon: "kyc",
      },
      actor,
    );
  }

  // Profile submitted for verification (HR review)
  if (t === "profile.submitted") {
    const targetUserId = employeeFromMeta || (entityType === "profile" ? entityId : null) || actorId;
    if (targetUserId) {
      return buildGuardedResult(
        {
          to: `/workforce/${targetUserId}`,
          search: { section: "verification" },
          label: "Review Profile",
          icon: "profile",
          fallbackTo: "/workforce",
        },
        actor,
        isProtectedSubject,
      );
    }
    return buildGuardedResult(
      { to: "/workforce", search: {}, label: "Open Workforce", icon: "profile", isHistoricalFallback: true },
      actor,
    );
  }

  // Self onboarding / profile decisions
  if (t === "profile.verified" || t === "profile.returned" || t === "onboarding.reminder") {
    return buildGuardedResult(
      {
        to: "/onboarding",
        search: { section: t === "onboarding.reminder" ? "documents" : "profile" },
        label: "Open Profile",
        icon: "profile",
      },
      actor,
    );
  }

  // Leave / WFH / Attendance correction request submitted -> Approver Queue
  if (t === "request.submitted") {
    return buildGuardedResult(
      {
        to: "/requests",
        search: { section: "approvals", requestId: entityId },
        label: "Review Request",
        icon: "request",
        fallbackTo: "/requests",
      },
      actor,
      isProtectedSubject,
    );
  }

  // Request decision (lead/HR approved/rejected) -> Employee's request
  if (t.startsWith("request.") || entityType === "request") {
    const isApprover =
      actorCan(actor as Actor, "requests:read:all") ||
      actorCan(actor as Actor, "requests:read:team");
    return buildGuardedResult(
      {
        to: "/requests",
        search: {
          section:
            notification.user_id === actor.userId && entityId ? "mine" : isApprover ? "approvals" : "mine",
          requestId: entityId,
        },
        label: "View Request",
        icon: "request",
        fallbackTo: "/requests",
      },
      actor,
    );
  }

  // Personalized break submitted -> HR break approvals
  if (t === "break_request") {
    return buildGuardedResult(
      {
        to: "/requests",
        search: { section: "breaks", breakRequestId: entityId },
        label: "Review Break",
        icon: "break",
        fallbackTo: "/requests",
      },
      actor,
      isProtectedSubject,
    );
  }

  // Personalized break decision -> My Day Break Tracker
  if (t === "break_decision" || (entityType === "break_request" && t.includes("decision"))) {
    return buildGuardedResult(
      {
        to: "/my-day",
        search: { section: "breaks", breakRequestId: entityId },
        label: "Open Break",
        icon: "break",
      },
      actor,
    );
  }

  // Automation attendance / break / task / EOD flags
  if (t.startsWith("automation:") || entityType === "automation_flag" || t === "attendance.late" || t === "break.overtime") {
    const rule = metaString(meta, "rule") || (t.startsWith("automation:") ? t.slice("automation:".length) : t);
    const isLeadAlert = Boolean(actorId && actorId !== notification.user_id);

    if (
      rule === "task_entry_reminder" ||
      rule === "uncovered_time" ||
      rule === "high_rejection" ||
      rule === "low_productivity"
    ) {
      if (isLeadAlert) {
        return buildGuardedResult(
          {
            to: "/reviews",
            search: { date: workDate, employeeId: actorId },
            label: "Open Reviews",
            icon: "task",
            fallbackTo: "/reviews",
          },
          actor,
          isProtectedSubject,
        );
      }
      return buildGuardedResult(
        {
          to: "/my-day",
          search: { section: "tasks", date: workDate },
          label: "Log Tasks",
          icon: "task",
        },
        actor,
      );
    }

    const section =
      rule === "break.overtime" || rule === "break_overtime"
        ? "breaks"
        : rule === "eod_locked"
          ? "eod"
          : "attendance";
    if (isLeadAlert) {
      return buildGuardedResult(
        {
          to: "/team",
          search: { employeeId: actorId, date: workDate, section },
          label: "Inspect Attendance",
          icon: section === "breaks" ? "break" : "attendance",
          fallbackTo: "/team",
        },
        actor,
        isProtectedSubject,
      );
    }
    return buildGuardedResult(
      {
        to: "/my-day",
        search: { section, date: workDate },
        label: "Open My Day",
        icon: section === "breaks" ? "break" : "attendance",
      },
      actor,
    );
  }

  // Project assignment -> My Assignments
  if (t === "allocation.assigned" || t === "project.assigned") {
    return buildGuardedResult(
      {
        to: "/my-projects",
        search: { allocationId: entityId },
        label: "View Assignment",
        icon: "project",
        fallbackTo: "/my-projects",
      },
      actor,
    );
  }

  // Project allocation acknowledged -> Project Detail Allocations tab
  if (t === "allocation.acknowledged") {
    const projectId = metaString(meta, "projectId");
    if (projectId) {
      return buildGuardedResult(
        {
          to: `/projects/${projectId}`,
          search: { section: "allocations", allocationId: entityId },
          label: "View Allocation",
          icon: "project",
          fallbackTo: "/projects",
        },
        actor,
        isProtectedSubject,
      );
    }
    return buildGuardedResult(
      { to: "/projects", search: {}, label: "Open Projects", icon: "project", isHistoricalFallback: true },
      actor,
    );
  }

  // Hourly task submitted -> Task Reviews
  if (t === "task_entry.submitted") {
    return buildGuardedResult(
      {
        to: "/reviews",
        search: { entryId: entityId, date: workDate, employeeId: actorId },
        label: "Review Task",
        icon: "task",
        fallbackTo: "/reviews",
      },
      actor,
      isProtectedSubject,
    );
  }

  // Hourly task decision -> My Day Hourly Logs
  if (t.startsWith("task_entry.") || entityType === "task_entry") {
    return buildGuardedResult(
      {
        to: "/my-day",
        search: { section: "tasks", entryId: entityId },
        label: "View Task Log",
        icon: "task",
      },
      actor,
    );
  }

  // EOD submitted -> Attendance & EOD monitoring drawer
  if (t === "eod.submitted") {
    return buildGuardedResult(
      {
        to: "/team",
        search: { employeeId: actorId, eodId: entityId, section: "eod", date: workDate },
        label: "Review EOD",
        icon: "eod",
        fallbackTo: "/team",
      },
      actor,
      isProtectedSubject,
    );
  }

  // EOD decision -> My Day EOD
  if (t.startsWith("eod.") || entityType === "eod_report") {
    return buildGuardedResult(
      {
        to: "/my-day",
        search: { section: "eod", eodId: entityId },
        label: "Open EOD",
        icon: "eod",
      },
      actor,
    );
  }

  // Blockers
  if (t === "blocker.raised") {
    return buildGuardedResult(
      {
        to: "/team",
        search: { employeeId: actorId, blockerId: entityId, section: "blockers" },
        label: "Review Blocker",
        icon: "blocker",
        fallbackTo: "/team",
      },
      actor,
      isProtectedSubject,
    );
  }
  if (t === "blocker.resolved" || entityType === "blocker") {
    return buildGuardedResult(
      {
        to: "/my-day",
        search: { section: "blockers", blockerId: entityId },
        label: "View Blocker",
        icon: "blocker",
      },
      actor,
    );
  }

  // Interviews
  if (t === "interview.feedback_submitted") {
    const candidateId = metaString(meta, "candidateId") || (entityType === "candidate" ? entityId : null);
    if (candidateId) {
      return buildGuardedResult(
        {
          to: `/candidates/${candidateId}`,
          search: { section: "interviews" },
          label: "View Scorecard",
          icon: "interview",
          fallbackTo: "/interviews",
        },
        actor,
      );
    }
    return buildGuardedResult(
      { to: "/interviews", search: { action: "scorecard" }, label: "Open Scorecard", icon: "interview" },
      actor,
    );
  }
  if (t === "interview.feedback_pending") {
    return buildGuardedResult(
      {
        to: "/interviews",
        search: { interviewId: entityId, action: "scorecard" },
        label: "Submit Scorecard",
        icon: "interview",
        fallbackTo: "/interviews",
      },
      actor,
    );
  }
  if (t.startsWith("interview.") || entityType === "interview") {
    return buildGuardedResult(
      {
        to: "/interviews",
        search: { interviewId: entityId },
        label: "Open Interview",
        icon: "interview",
        fallbackTo: "/interviews",
      },
      actor,
    );
  }

  // Candidate stage updates
  if (t.startsWith("candidate.") || entityType === "candidate") {
    if (entityId) {
      return buildGuardedResult(
        {
          to: `/candidates/${entityId}`,
          search: { section: "timeline" },
          label: "View Candidate",
          icon: "candidate",
          fallbackTo: "/candidates",
        },
        actor,
      );
    }
    return buildGuardedResult(
      { to: "/candidates", search: {}, label: "Open Candidates", icon: "candidate", isHistoricalFallback: true },
      actor,
    );
  }

  // Employee Relieving
  if (t.startsWith("relieving.") || entityType === "relieving_case") {
    const canSeeRelieving =
      actorCan(actor as Actor, "relieving:read:all") ||
      actorCan(actor as Actor, "relieving:read:self");
    if (canSeeRelieving) {
      return buildGuardedResult(
        {
          to: "/employee-relieving",
          search: {
            caseId: entityId,
            tab:
              t === "relieving.pending_approval"
                ? "pending_approval"
                : t === "relieving.approved"
                  ? "ready_to_relieve"
                  : t === "relieving.finalized" || t === "relieving.letter_issued"
                    ? "relieved"
                    : undefined,
          },
          label: t === "relieving.letter_issued" ? "View Letter" : "Open Case",
          icon: "relieving",
          fallbackTo: "/employee-relieving",
        },
        actor,
        isProtectedSubject,
      );
    }
    return buildGuardedResult(
      { to: "/onboarding", search: { section: "documents" }, label: "Open Documents", icon: "relieving" },
      actor,
    );
  }

  // Employee Records
  if (t.startsWith("employee_record.") || entityType === "employee_record") {
    return buildGuardedResult(
      {
        to: "/records",
        search: { recordId: entityId },
        label: "Open Record",
        icon: "records",
        fallbackTo: "/records",
      },
      actor,
      isProtectedSubject,
    );
  }

  // Historical fallback to dashboard if unrecognized
  return buildGuardedResult(
    {
      to: "/dashboard",
      search: {},
      label: "Open Dashboard",
      icon: "general",
      isHistoricalFallback: true,
    },
    actor,
  );
}

function iconForType(t: string, entityType: string | null): NotificationIconKind {
  if (t.startsWith("kyc.") || entityType === "kyc" || t === "document.uploaded") return "kyc";
  if (t.startsWith("profile.") || t === "onboarding.reminder") return "profile";
  if (t.startsWith("break") || entityType === "break_request") return "break";
  if (t.startsWith("request.") || entityType === "request") return "request";
  if (t.startsWith("allocation.") || t.startsWith("project.")) return "project";
  if (t.startsWith("task_entry.") || entityType === "task_entry") return "task";
  if (t.startsWith("eod.") || entityType === "eod_report") return "eod";
  if (t.startsWith("blocker.") || entityType === "blocker") return "blocker";
  if (t.startsWith("interview.") || entityType === "interview") return "interview";
  if (t.startsWith("candidate.") || entityType === "candidate") return "candidate";
  if (t.startsWith("relieving.") || entityType === "relieving_case") return "relieving";
  if (t.startsWith("employee_record.") || entityType === "employee_record") return "records";
  if (t.startsWith("automation:") || t.startsWith("attendance.")) return "attendance";
  return "general";
}

function defaultLabelForType(t: string): string {
  if (t === "kyc.submitted") return "Review Documents";
  if (t === "kyc.correction_required" || t === "kyc.document_rejected") return "Fix Documents";
  if (t === "kyc.verified") return "View KYC Status";
  if (t === "profile.submitted") return "Review Profile";
  if (t === "request.submitted") return "Review Request";
  if (t === "break_request") return "Review Break";
  if (t.startsWith("interview.")) return "Open Interview";
  if (t.startsWith("relieving.")) return "View Relieving";
  if (t.startsWith("employee_record.")) return "Open Record";
  return "View Details";
}

/** Human-friendly relative timestamp for bell items. */
export function formatRelativeNotificationTime(iso: string, nowMs = Date.now()): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffSec < 60) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(ts).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
  });
}
