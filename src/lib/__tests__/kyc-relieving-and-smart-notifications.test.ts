import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatRelativeNotificationTime,
  isSafeInternalActionUrl,
  parseInternalActionUrl,
  resolveNotificationLink,
  sanitizeNotificationMetadata,
  UNAVAILABLE_TARGET_MESSAGE,
  type NotificationRow,
} from "../notifications/navigation";
import {
  canAccessEmployeeDocuments,
  isValidOwnedDocumentPath,
  normalizeEffectivePermissions,
  PERMISSION_KEYS,
  type Actor,
  type AppRole,
} from "../permissions";

const ROLE_DEFAULT_PERMS: Record<AppRole, readonly string[]> = {
  super_admin: [...PERMISSION_KEYS],
  hr: [
    "workforce:read:all",
    "documents:read:all",
    "documents:verify:all",
    "requests:read:all",
    "requests:approve:hr",
    "attendance:read:all",
    "recruitment:read:all",
    "interviews:read:all",
    "relieving:read:all",
    "records:read:all",
    "attendance:log:self",
    "allocations:acknowledge:self",
  ],
  founder: [
    "workforce:read:all",
    "records:read:all",
    "reports:export:scoped",
    "attendance:read:all",
    "requests:read:all",
    "projects:read:all",
  ],
  admin: ["workforce:read:all", "relieving:read:all", "attendance:read:all", "requests:read:all"],
  manager: [
    "workforce:read:team",
    "projects:read:team",
    "attendance:read:team",
    "requests:read:team",
    "attendance:log:self",
    "allocations:acknowledge:self",
  ],
  lead: [
    "attendance:log:self",
    "allocations:acknowledge:self",
    "attendance:read:team",
    "tasks:read:team",
    "tasks:review:team",
    "requests:read:team",
    "interviews:feedback:assigned",
  ],
  employee: [
    "attendance:log:self",
    "allocations:acknowledge:self",
    "requests:read:self",
    "requests:submit:self",
    "workforce:update:self",
    "documents:upload:self",
    "relieving:read:self",
  ],
};

const repoRoot = resolve(__dirname, "../../..");

const relievingFixSql = readFileSync(
  resolve(repoRoot, "supabase/migrations/20261127120000_fix_relieving_cases_grants_and_storage_rls.sql"),
  "utf8",
);
const notificationsSql = readFileSync(
  resolve(repoRoot, "supabase/migrations/20261127130000_smart_notifications_deep_links.sql"),
  "utf8",
);

function makeActor(roles: AppRole[], userId = `user-${roles.join("-")}`): Actor {
  const basePerms = Array.from(new Set(roles.flatMap((r) => ROLE_DEFAULT_PERMS[r] ?? [])));
  return {
    userId,
    fullName: "Test User",
    workEmail: "test@theaischool.co",
    accountStatus: "active",
    category: "full_time",
    roles,
    permissions: normalizeEffectivePermissions(roles, basePerms),
  };
}

function makeNotif(overrides: Partial<NotificationRow>): NotificationRow {
  return {
    id: "notif-1",
    user_id: "recipient-1",
    actor_id: "actor-1",
    type: "general",
    title: "Notification",
    body: null,
    entity_type: null,
    entity_id: null,
    read_at: null,
    created_at: "2026-11-27T06:30:00.000Z",
    ...overrides,
  };
}

describe("Urgent KYC Fix — Migration Security & Ownership Access", () => {
  it("grants authenticated privileges on relieving_cases while locking down anon/PUBLIC and storage helper", () => {
    expect(relievingFixSql).toContain("CREATE OR REPLACE FUNCTION public.can_read_own_relieving_letter");
    expect(relievingFixSql).toContain("SECURITY DEFINER");
    expect(relievingFixSql).toContain("SET search_path = public");
    expect(relievingFixSql).toContain("REVOKE ALL ON FUNCTION public.can_read_own_relieving_letter(text, uuid) FROM PUBLIC, anon;");
    expect(relievingFixSql).toContain("GRANT EXECUTE ON FUNCTION public.can_read_own_relieving_letter(text, uuid) TO authenticated, service_role;");
    expect(relievingFixSql).toContain("REVOKE ALL ON public.relieving_cases FROM PUBLIC, anon;");
    expect(relievingFixSql).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON public.relieving_cases TO authenticated;");
    expect(relievingFixSql).toContain("ALTER TABLE public.relieving_cases ENABLE ROW LEVEL SECURITY;");
    expect(relievingFixSql).toContain("bucket_id = 'relieving-documents'");
    expect(relievingFixSql).toContain("public.can_read_own_relieving_letter(name, auth.uid())");
  });

  it("enforces strict KYC document access & path ownership without path traversal", () => {
    const ownerId = "emp-101";
    const hr = makeActor(["hr"], "hr-1");
    const superAdmin = makeActor(["super_admin"], "sa-1");
    const manager = makeActor(["manager"], "mgr-1");
    const lead = makeActor(["lead"], "lead-1");
    const founder = makeActor(["founder"], "founder-1");
    const admin = makeActor(["admin"], "admin-1");
    const otherEmp = makeActor(["employee"], "emp-999");
    const selfEmp = makeActor(["employee"], ownerId);

    expect(canAccessEmployeeDocuments(hr.userId, ownerId, hr.roles, hr.permissions)).toBe(true);
    expect(canAccessEmployeeDocuments(superAdmin.userId, ownerId, superAdmin.roles, superAdmin.permissions)).toBe(true);
    expect(canAccessEmployeeDocuments(selfEmp.userId, ownerId, selfEmp.roles, selfEmp.permissions)).toBe(true);

    expect(canAccessEmployeeDocuments(manager.userId, ownerId, manager.roles, manager.permissions)).toBe(false);
    expect(canAccessEmployeeDocuments(lead.userId, ownerId, lead.roles, lead.permissions)).toBe(false);
    expect(canAccessEmployeeDocuments(founder.userId, ownerId, founder.roles, founder.permissions)).toBe(false);
    expect(canAccessEmployeeDocuments(admin.userId, ownerId, admin.roles, admin.permissions)).toBe(false);
    expect(canAccessEmployeeDocuments(otherEmp.userId, ownerId, otherEmp.roles, otherEmp.permissions)).toBe(false);

    expect(isValidOwnedDocumentPath(ownerId, `${ownerId}/pan/170000_pan.pdf`)).toBe(true);
    expect(isValidOwnedDocumentPath(ownerId, `${ownerId}/../other/pan.pdf`)).toBe(false);
    expect(isValidOwnedDocumentPath(ownerId, `other-user/pan/pan.pdf`)).toBe(false);
    expect(isValidOwnedDocumentPath(ownerId, `/etc/passwd`)).toBe(false);
    expect(isValidOwnedDocumentPath(ownerId, `emp-101\\pan\\doc.pdf`)).toBe(false);
  });
});

describe("Smart Notifications — Schema, Security Sanitization & Deep Links", () => {
  it("keeps smart notifications migration strictly additive with internal-path CHECK constraint", () => {
    expect(notificationsSql).toContain("ADD COLUMN IF NOT EXISTS action_url text");
    expect(notificationsSql).toContain("ADD COLUMN IF NOT EXISTS section text");
    expect(notificationsSql).toContain("ADD COLUMN IF NOT EXISTS action_label text");
    expect(notificationsSql).toContain("ADD COLUMN IF NOT EXISTS metadata jsonb");
    expect(notificationsSql).toContain("notifications_action_url_internal_check");
    expect(notificationsSql).not.toMatch(/DELETE\s+FROM\s+public\.notifications/i);
    expect(notificationsSql).not.toMatch(/TRUNCATE/i);
  });

  it("blocks external, protocol-relative, and script URLs while accepting safe internal deep links", () => {
    expect(isSafeInternalActionUrl("/workforce/emp-1?section=documents&docId=doc-1")).toBe(true);
    expect(isSafeInternalActionUrl("/requests?section=approvals&requestId=req-1")).toBe(true);

    expect(isSafeInternalActionUrl("https://evil.example/phish")).toBe(false);
    expect(isSafeInternalActionUrl("//evil.example/phish")).toBe(false);
    expect(isSafeInternalActionUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeInternalActionUrl("relative/path")).toBe(false);
    expect(isSafeInternalActionUrl("/\njavascript:alert(1)")).toBe(false);

    expect(parseInternalActionUrl("https://evil.example/abc")).toBeNull();
    expect(parseInternalActionUrl("/my-day?section=breaks&breakRequestId=br-1")).toEqual({
      to: "/my-day",
      search: { section: "breaks", breakRequestId: "br-1" },
    });

    const sanitized = sanitizeNotificationMetadata({
      employeeId: "emp-1",
      pan: "ABCDE1234F",
      bank_account: "1234567890",
      signed_url: "https://secret",
      workDate: "2026-11-27",
    });
    expect(sanitized).toEqual({ employeeId: "emp-1", workDate: "2026-11-27" });
  });

  it("routes all notification types to the exact page, section, and record", () => {
    const hr = makeActor(["hr"], "hr-1");
    const emp = makeActor(["employee"], "emp-1");
    const lead = makeActor(["lead"], "lead-1");
    const manager = makeActor(["manager"], "mgr-1");

    expect(
      resolveNotificationLink(
        makeNotif({ user_id: "hr-1", actor_id: "emp-1", type: "kyc.submitted", entity_type: "document", entity_id: "doc-123" }),
        hr,
      ),
    ).toMatchObject({
      to: "/workforce/emp-1",
      search: { section: "documents", docId: "doc-123" },
      icon: "kyc",
    });

    expect(
      resolveNotificationLink(
        makeNotif({ user_id: "emp-1", type: "kyc.correction_required", entity_type: "kyc", entity_id: "outbox-1" }),
        emp,
      ),
    ).toMatchObject({
      to: "/onboarding",
      search: { section: "documents", filter: "rejected" },
      icon: "kyc",
    });

    expect(
      resolveNotificationLink(
        makeNotif({ user_id: "emp-1", type: "kyc.verified", entity_type: "kyc", entity_id: "outbox-2" }),
        emp,
      ),
    ).toMatchObject({ to: "/onboarding", search: { section: "documents" } });

    expect(
      resolveNotificationLink(
        makeNotif({ user_id: "hr-1", actor_id: "emp-1", type: "profile.submitted", entity_type: "profile", entity_id: "emp-1" }),
        hr,
      ),
    ).toMatchObject({ to: "/workforce/emp-1", search: { section: "verification" } });

    expect(
      resolveNotificationLink(
        makeNotif({ user_id: "hr-1", type: "request.submitted", entity_type: "request", entity_id: "req-44" }),
        hr,
      ),
    ).toMatchObject({ to: "/requests", search: { section: "approvals", requestId: "req-44" } });

    expect(
      resolveNotificationLink(
        makeNotif({ user_id: "emp-1", type: "request.hr.approved", entity_type: "request", entity_id: "req-44" }),
        emp,
      ),
    ).toMatchObject({ to: "/requests", search: { section: "mine", requestId: "req-44" } });

    expect(
      resolveNotificationLink(
        makeNotif({ user_id: "hr-1", type: "break_request", entity_type: "break_request", entity_id: "br-9" }),
        hr,
      ),
    ).toMatchObject({ to: "/requests", search: { section: "breaks", breakRequestId: "br-9" } });

    expect(
      resolveNotificationLink(
        makeNotif({ user_id: "emp-1", type: "break_decision", entity_type: "break_request", entity_id: "br-9" }),
        emp,
      ),
    ).toMatchObject({ to: "/my-day", search: { section: "breaks", breakRequestId: "br-9" } });

    expect(
      resolveNotificationLink(
        makeNotif({
          user_id: "lead-1",
          actor_id: "emp-1",
          type: "automation:no_check_in",
          entity_type: "automation_flag",
          metadata: { employeeId: "emp-1", workDate: "2026-11-27", rule: "no_check_in" },
        }),
        lead,
      ),
    ).toMatchObject({ to: "/team", search: { employeeId: "emp-1", date: "2026-11-27", section: "attendance" } });

    expect(
      resolveNotificationLink(
        makeNotif({ user_id: "emp-1", type: "allocation.assigned", entity_type: "project_allocation", entity_id: "alloc-7" }),
        emp,
      ),
    ).toMatchObject({ to: "/my-projects", search: { allocationId: "alloc-7" } });

    expect(
      resolveNotificationLink(
        makeNotif({
          user_id: "mgr-1",
          type: "allocation.acknowledged",
          entity_type: "project_allocation",
          entity_id: "alloc-7",
          metadata: { projectId: "proj-3" },
        }),
        manager,
      ),
    ).toMatchObject({ to: "/projects/proj-3", search: { section: "allocations", allocationId: "alloc-7" } });

    expect(
      resolveNotificationLink(
        makeNotif({ user_id: "lead-1", actor_id: "emp-1", type: "task_entry.submitted", entity_type: "task_entry", entity_id: "te-55" }),
        lead,
      ),
    ).toMatchObject({ to: "/reviews", search: { entryId: "te-55", employeeId: "emp-1" } });

    expect(
      resolveNotificationLink(
        makeNotif({ user_id: "emp-1", type: "task_entry.revision_required", entity_type: "task_entry", entity_id: "te-55" }),
        emp,
      ),
    ).toMatchObject({ to: "/my-day", search: { section: "tasks", entryId: "te-55" } });

    expect(
      resolveNotificationLink(
        makeNotif({ user_id: "lead-1", actor_id: "emp-1", type: "eod.submitted", entity_type: "eod_report", entity_id: "eod-88" }),
        lead,
      ),
    ).toMatchObject({ to: "/team", search: { employeeId: "emp-1", eodId: "eod-88", section: "eod" } });

    expect(
      resolveNotificationLink(
        makeNotif({ user_id: "emp-1", type: "eod.request_revision", entity_type: "eod_report", entity_id: "eod-88" }),
        emp,
      ),
    ).toMatchObject({ to: "/my-day", search: { section: "eod", eodId: "eod-88" } });

    expect(
      resolveNotificationLink(
        makeNotif({ user_id: "lead-1", type: "interview.assigned", entity_type: "interview", entity_id: "iv-12" }),
        lead,
      ),
    ).toMatchObject({ to: "/interviews", search: { interviewId: "iv-12" } });

    expect(
      resolveNotificationLink(
        makeNotif({ user_id: "hr-1", type: "interview.feedback_submitted", entity_type: "candidate", entity_id: "cand-9" }),
        hr,
      ),
    ).toMatchObject({ to: "/candidates/cand-9", search: { section: "interviews" } });

    expect(
      resolveNotificationLink(
        makeNotif({ user_id: "hr-1", type: "relieving.pending_approval", entity_type: "relieving_case", entity_id: "rel-3" }),
        hr,
      ),
    ).toMatchObject({ to: "/employee-relieving", search: { caseId: "rel-3", tab: "pending_approval" } });

    expect(
      resolveNotificationLink(
        makeNotif({ user_id: "hr-1", type: "employee_record.updated", entity_type: "employee_record", entity_id: "rec-77" }),
        hr,
      ),
    ).toMatchObject({ to: "/records", search: { recordId: "rec-77" } });
  });

  it("enforces RBAC, Founder read-only safety, protected Super Admin isolation, and legacy fallbacks", () => {
    const emp = makeActor(["employee"], "emp-1");
    const founder = makeActor(["founder"], "founder-1");
    const hr = makeActor(["hr"], "hr-1");
    const superAdmin = makeActor(["super_admin"], "sa-1");

    // Employee without recruitment permissions cannot navigate via unsafe/admin link
    const blockedCand = resolveNotificationLink(
      makeNotif({ user_id: "emp-1", type: "candidate.status_changed", entity_type: "candidate", entity_id: "cand-1" }),
      emp,
    );
    expect(blockedCand.unavailable).toBe(true);
    expect(blockedCand.unavailableMessage).toBe(UNAVAILABLE_TARGET_MESSAGE);

    // Malicious external action_url stored in row is completely ignored
    const badUrlFallback = resolveNotificationLink(
      makeNotif({
        user_id: "emp-1",
        type: "request.hr.approved",
        entity_type: "request",
        entity_id: "req-1",
        action_url: "https://attacker.invalid/steal",
      }),
      emp,
    );
    expect(badUrlFallback.to).toBe("/requests");

    // Founder does NOT route to /my-day (executive governance only)
    const founderBreak = resolveNotificationLink(
      makeNotif({ user_id: "founder-1", type: "break_decision", entity_type: "break_request", entity_id: "br-1" }),
      founder,
    );
    expect(founderBreak.unavailable).toBe(true);
    expect(founderBreak.to).toBe("/dashboard");

    // Protected Super Admin privacy: HR/Lead/Founder cannot deep-link into protected Super Admin subject
    const protectedSet = new Set(["sa-1"]);
    const protectedCheck = resolveNotificationLink(
      makeNotif({ user_id: "hr-1", actor_id: "sa-1", type: "profile.submitted", entity_type: "profile", entity_id: "sa-1" }),
      hr,
      { protectedIds: protectedSet },
    );
    expect(protectedCheck.unavailable).toBe(true);
    expect(protectedCheck.to).toBe("/dashboard");

    // Super Admin themselves can resolve normally
    const saCheck = resolveNotificationLink(
      makeNotif({ user_id: "sa-1", actor_id: "sa-1", type: "profile.submitted", entity_type: "profile", entity_id: "sa-1" }),
      superAdmin,
      { protectedIds: protectedSet },
    );
    expect(saCheck.unavailable).toBeUndefined();
    expect(saCheck.to).toBe("/workforce/sa-1");

    // Relative time formatter
    const now = Date.parse("2026-11-27T12:00:00Z");
    expect(formatRelativeNotificationTime("2026-11-27T11:55:00Z", now)).toBe("5m ago");
    expect(formatRelativeNotificationTime("2026-11-27T09:00:00Z", now)).toBe("3h ago");
  });
});
