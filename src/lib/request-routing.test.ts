import { describe, expect, it } from "vitest";
import { NO_REPORTING_LEAD_MESSAGE, needsReportingLead, routeRequest } from "./request-routing";

describe("routeRequest", () => {
  it("sends staff requests to both the reporting lead and HR", () => {
    const route = routeRequest({ submitterRoles: ["employee"], reportingLeadId: "lead-1" });
    expect(route.blocked).toBe(false);
    expect(route.tiers).toEqual(["lead", "hr"]);
    expect(route.leadApproverId).toBe("lead-1");
  });

  it("sends lead requests to HR only, never to another lead", () => {
    const route = routeRequest({ submitterRoles: ["lead"], reportingLeadId: "lead-2" });
    expect(route.tiers).toEqual(["hr"]);
    expect(route.leadApproverId).toBeNull();
    expect(route.blocked).toBe(false);
  });

  it("sends admin-tier requests to HR only", () => {
    for (const role of ["admin", "founder", "super_admin"] as const) {
      const route = routeRequest({ submitterRoles: [role], reportingLeadId: null });
      expect(route.tiers).toEqual(["hr"]);
      expect(route.blocked).toBe(false);
    }
  });

  it("BLOCKS staff with no reporting lead instead of downgrading to HR-only", () => {
    const route = routeRequest({ submitterRoles: ["employee"], reportingLeadId: null });
    expect(route.blocked).toBe(true);
    expect(route.tiers).toEqual([]);
    expect(route.blockedReason).toBe(NO_REPORTING_LEAD_MESSAGE);
  });

  it("blocks every non-lead category with no reporting lead", () => {
    for (const roles of [[], ["employee"]] as string[][]) {
      expect(
        routeRequest({ submitterRoles: roles as never, reportingLeadId: null }).blocked,
      ).toBe(true);
    }
  });
});

describe("needsReportingLead", () => {
  it("flags active staff with no lead", () => {
    expect(
      needsReportingLead({
        roles: ["employee"],
        employmentStatus: "active",
        reportingLeadId: null,
      }),
    ).toBe(true);
  });

  it("does not flag leads or admin tier", () => {
    expect(needsReportingLead({ roles: ["lead"], reportingLeadId: null })).toBe(false);
    expect(needsReportingLead({ roles: ["hr"], reportingLeadId: null })).toBe(false);
  });

  it("does not flag staff who already have a lead", () => {
    expect(needsReportingLead({ roles: ["employee"], reportingLeadId: "lead-1" })).toBe(false);
  });

  it("does not flag exited people", () => {
    expect(
      needsReportingLead({
        roles: ["employee"],
        employmentStatus: "exited",
        reportingLeadId: null,
      }),
    ).toBe(false);
  });
});
