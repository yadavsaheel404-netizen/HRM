import { describe, expect, it } from "vitest";
import { buildRoleNavigation, isNavItemActive } from "../navigation";
import {
  canAccessEmployeeDocuments,
  canExportReports,
  canViewEmployeeSensitivePii,
  isExecutiveGovernanceOnly,
  normalizeEffectivePermissions,
  PERMISSION_KEYS,
  resolvePrimaryRole,
  type Actor,
  type AppRole,
} from "../permissions";
import { isMissingSchemaResourceError } from "../schema-compat.server";

function makeActor(roles: AppRole[], rawPerms: string[] = []): Actor {
  return {
    userId: `user-${roles.join("-")}`,
    fullName: "Test User",
    workEmail: "test@theaischool.co",
    accountStatus: "active",
    category: "full_time",
    roles,
    permissions: normalizeEffectivePermissions(roles, rawPerms),
  };
}

describe("Phase P1 — Primary Role Resolution & Executive Governance Exemption", () => {
  it("resolves the highest-ranking role across single and multi-role assignments", () => {
    expect(resolvePrimaryRole(["employee"])).toBe("employee");
    expect(resolvePrimaryRole(["employee", "lead"])).toBe("lead");
    expect(resolvePrimaryRole(["lead", "manager"])).toBe("manager");
    expect(resolvePrimaryRole(["employee", "admin"])).toBe("admin");
    expect(resolvePrimaryRole(["admin", "hr"])).toBe("hr");
    expect(resolvePrimaryRole(["founder"])).toBe("founder");
    expect(resolvePrimaryRole(["hr", "super_admin"])).toBe("super_admin");
  });

  it("identifies pure executive governance accounts vs operational accounts", () => {
    expect(isExecutiveGovernanceOnly(["super_admin"])).toBe(true);
    expect(isExecutiveGovernanceOnly(["founder"])).toBe(true);
    expect(isExecutiveGovernanceOnly(["super_admin", "founder"])).toBe(true);

    expect(isExecutiveGovernanceOnly(["hr"])).toBe(false);
    expect(isExecutiveGovernanceOnly(["admin"])).toBe(false);
    expect(isExecutiveGovernanceOnly(["manager"])).toBe(false);
    expect(isExecutiveGovernanceOnly(["lead"])).toBe(false);
    expect(isExecutiveGovernanceOnly(["employee"])).toBe(false);
    expect(isExecutiveGovernanceOnly(["founder", "hr"])).toBe(false);
  });
});

describe("Phase P1 — Effective Permission Normalization (Pre- & Post-Migration Parity)", () => {
  it("enforces strict read-only permissions + scoped CSV export on Founder even if legacy write keys exist", () => {
    const legacyFounderPerms = [
      "workforce:read:all",
      "workforce:update:all",
      "projects:manage:all",
      "requests:approve:hr",
      "documents:read:all",
      "attendance:log:self",
      "tasks:log:self",
    ];
    const normalized = normalizeEffectivePermissions(["founder"], legacyFounderPerms);

    expect(normalized).toContain("workforce:read:all");
    expect(normalized).toContain("projects:read:all");
    expect(normalized).toContain("attendance:read:all");
    expect(normalized).toContain("analytics:read:all");
    expect(normalized).toContain("reports:export:scoped");

    // Zero write, approval, or KYC document keys
    expect(normalized).not.toContain("workforce:update:all");
    expect(normalized).not.toContain("workforce:update:self");
    expect(normalized).not.toContain("projects:manage:all");
    expect(normalized).not.toContain("requests:approve:hr");
    expect(normalized).not.toContain("documents:read:all");
    expect(normalized).not.toContain("attendance:log:self");
    expect(canExportReports(["founder"], normalized)).toBe(true);
  });

  it("strips temporary org-wide :all keys from Manager while preserving :team and export keys", () => {
    const preMigrationManagerPerms = [
      "workforce:read:all",
      "projects:read:all",
      "allocations:read:all",
      "attendance:read:all",
      "tasks:read:all",
      "eod:read:all",
      "requests:read:all",
      "analytics:read:all",
      "documents:read:team",
      "attendance:log:self",
      "allocations:acknowledge:self",
    ];
    const normalized = normalizeEffectivePermissions(["manager"], preMigrationManagerPerms);

    expect(normalized).not.toContain("workforce:read:all");
    expect(normalized).not.toContain("projects:read:all");
    expect(normalized).not.toContain("attendance:read:all");
    expect(normalized).not.toContain("analytics:read:all");
    expect(normalized).not.toContain("documents:read:team");
    expect(normalized).not.toContain("documents:read:all");

    expect(normalized).toContain("workforce:read:team");
    expect(normalized).toContain("projects:read:team");
    expect(normalized).toContain("projects:manage:team");
    expect(normalized).toContain("allocations:manage:team");
    expect(normalized).toContain("attendance:read:team");
    expect(normalized).toContain("tasks:review:team");
    expect(normalized).toContain("eod:review:team");
    expect(normalized).toContain("reports:export:scoped");
    expect(normalized).toContain("workforce:update:self");
  });

  it("restricts raw KYC document permissions strictly to HR and Super Admin", () => {
    const adminPerms = normalizeEffectivePermissions(
      ["admin"],
      ["documents:read:all", "documents:verify:all", "workforce:read:all"],
    );
    expect(adminPerms).not.toContain("documents:read:all");
    expect(adminPerms).not.toContain("documents:verify:all");

    const hrPerms = normalizeEffectivePermissions(
      ["hr"],
      ["documents:read:all", "documents:verify:all", "workforce:read:all"],
    );
    expect(hrPerms).toContain("documents:read:all");
    expect(hrPerms).toContain("documents:verify:all");

    const saPerms = normalizeEffectivePermissions(["super_admin"], []);
    expect(saPerms.length).toBe(PERMISSION_KEYS.length);
    expect(saPerms).toContain("documents:read:all");
  });
});

describe("Phase P1 — Unified Profile PII & Document Privacy", () => {
  it("restricts sensitive PII (personal email, DOB, residential address) to Self, HR, and Super Admin", () => {
    const targetId = "emp-101";
    expect(canViewEmployeeSensitivePii(targetId, targetId, ["employee"])).toBe(true);
    expect(canViewEmployeeSensitivePii("hr-1", targetId, ["hr"])).toBe(true);
    expect(canViewEmployeeSensitivePii("sa-1", targetId, ["super_admin"])).toBe(true);

    expect(canViewEmployeeSensitivePii("founder-1", targetId, ["founder"])).toBe(false);
    expect(canViewEmployeeSensitivePii("admin-1", targetId, ["admin"])).toBe(false);
    expect(canViewEmployeeSensitivePii("mgr-1", targetId, ["manager"])).toBe(false);
    expect(canViewEmployeeSensitivePii("lead-1", targetId, ["lead"])).toBe(false);
    expect(canViewEmployeeSensitivePii("peer-2", targetId, ["employee"])).toBe(false);
  });

  it("restricts KYC document downloads to Owner, HR, and Super Admin", () => {
    const owner = "emp-101";
    const hrActor = makeActor(["hr"], ["documents:read:all"]);
    const adminActor = makeActor(["admin"], ["documents:read:all"]);
    const founderActor = makeActor(["founder"], ["documents:read:all"]);
    const mgrActor = makeActor(["manager"], []);

    expect(canAccessEmployeeDocuments(owner, owner, ["employee"], [])).toBe(true);
    expect(
      canAccessEmployeeDocuments(hrActor.userId, owner, hrActor.roles, hrActor.permissions),
    ).toBe(true);
    expect(canAccessEmployeeDocuments("sa-1", owner, ["super_admin"], [])).toBe(true);

    expect(
      canAccessEmployeeDocuments(
        adminActor.userId,
        owner,
        adminActor.roles,
        adminActor.permissions,
      ),
    ).toBe(false);
    expect(
      canAccessEmployeeDocuments(
        founderActor.userId,
        owner,
        founderActor.roles,
        founderActor.permissions,
      ),
    ).toBe(false);
    expect(
      canAccessEmployeeDocuments(mgrActor.userId, owner, mgrActor.roles, mgrActor.permissions),
    ).toBe(false);
  });
});

describe("Phase P1 — Role-Relevant Sidebar Navigation & Hub Consolidation", () => {
  it("builds a clean 5-item workspace for Employee with zero admin/team links", () => {
    const emp = makeActor(
      ["employee"],
      [
        "attendance:log:self",
        "allocations:acknowledge:self",
        "requests:read:self",
        "documents:upload:self",
      ],
    );
    const groups = buildRoleNavigation(emp);
    const paths = groups.flatMap((g) => g.items.map((i) => i.to));

    expect(paths).toEqual([
      "/dashboard",
      "/my-day",
      "/my-projects",
      "/requests",
      "/onboarding",
    ]);
  });

  it("builds a strictly read-only Executive Oversight sidebar for Founder with Reports & zero personal shift tools", () => {
    const founder = makeActor(["founder"], ["requests:read:all"]);
    const groups = buildRoleNavigation(founder);
    const paths = groups.flatMap((g) => g.items.map((i) => i.to));

    expect(paths).toContain("/dashboard");
    expect(paths).toContain("/reports");
    expect(paths).toContain("/team");
    expect(paths).toContain("/projects");
    expect(paths).toContain("/workforce");
    expect(paths).toContain("/records");
    expect(paths).toContain("/onboarding");

    expect(paths).not.toContain("/my-day");
    expect(paths).not.toContain("/my-projects");
    expect(paths).not.toContain("/invitations");
    expect(paths).not.toContain("/automation");
  });

  it("gives Manager scoped delivery, directory & reports without org-wide admin consoles", () => {
    const mgr = makeActor(
      ["manager"],
      ["attendance:log:self", "allocations:acknowledge:self"],
    );
    const groups = buildRoleNavigation(mgr);
    const paths = groups.flatMap((g) => g.items.map((i) => i.to));

    expect(paths).toContain("/dashboard");
    expect(paths).toContain("/projects");
    expect(paths).toContain("/team");
    expect(paths).toContain("/reviews");
    expect(paths).toContain("/workforce");
    expect(paths).toContain("/reports");
    expect(paths).not.toContain("/invitations");
    expect(paths).not.toContain("/org");
    expect(paths).not.toContain("/automation");
  });

  it("consolidates Super Admin & HR admin hubs and highlights parent hub on sibling routes", () => {
    const sa = makeActor(["super_admin"]);
    const groups = buildRoleNavigation(sa);
    const allItems = groups.flatMap((g) => g.items);

    // Consolidated well below the old 16-item flat list (includes /employee-relieving and /records)
    expect(allItems.length).toBeLessThanOrEqual(13);
    expect(allItems.some((i) => i.to === "/employee-relieving")).toBe(true);
    expect(allItems.some((i) => i.to === "/records")).toBe(true);

    const invitesItem = allItems.find((i) => i.to === "/invitations")!;
    expect(isNavItemActive("/invitations", invitesItem)).toBe(true);
    expect(isNavItemActive("/roster-import", invitesItem)).toBe(true);

    const orgItem = allItems.find((i) => i.to === "/org")!;
    expect(isNavItemActive("/org", orgItem)).toBe(true);
    expect(isNavItemActive("/office-locations", orgItem)).toBe(true);

    const autoItem = allItems.find((i) => i.to === "/automation")!;
    expect(isNavItemActive("/automation", autoItem)).toBe(true);
    expect(isNavItemActive("/import", autoItem)).toBe(true);
  });
});

describe("Phase P1 — Schema Compatibility Error Classifier", () => {
  it("detects unapplied migration table/column/RPC errors without masking real errors", () => {
    expect(isMissingSchemaResourceError({ code: "42703", message: "column does not exist" })).toBe(
      true,
    );
    expect(isMissingSchemaResourceError({ code: "PGRST205", message: "Could not find table" })).toBe(
      true,
    );
    expect(isMissingSchemaResourceError({ code: "PGRST202", message: "Could not find function" })).toBe(
      true,
    );

    expect(isMissingSchemaResourceError({ code: "23505", message: "duplicate key value" })).toBe(
      false,
    );
    expect(isMissingSchemaResourceError({ code: "42501", message: "permission denied" })).toBe(
      false,
    );
  });
});

