import { describe, expect, it } from "vitest";
import {
  gridToRosterRaw,
  parseRosterDate,
  summariseRoster,
  validateRoster,
} from "../roster-import";

const lookups = {
  departments: new Map([["operations", "dept-ops"]]),
  accountsByEmail: new Map([["lead@example.com", "lead-1"], ["taken@example.com", "user-9"]]),
  invitedEmails: new Set(["pending@example.com"]),
};

describe("parseRosterDate", () => {
  it("reads every supported format", () => {
    expect(parseRosterDate("2026-08-20")).toBe("2026-08-20");
    expect(parseRosterDate("20/08/2026")).toBe("2026-08-20");
    expect(parseRosterDate("20-08-2026")).toBe("2026-08-20");
    expect(parseRosterDate("20th Aug 2026")).toBe("2026-08-20");
    expect(parseRosterDate("Aug 20 2026")).toBe("2026-08-20");
  });
  it("rejects nonsense", () => {
    expect(parseRosterDate("32/13/2026")).toBeNull();
    expect(parseRosterDate("someday")).toBeNull();
    expect(parseRosterDate("")).toBeNull();
  });
});

describe("validateRoster", () => {
  const raw = gridToRosterRaw([
    ["Full Name", "Work Email", "Phone Number", "Employment Type", "Designation", "Department", "Joining Date", "Last Working Date", "Reporting Lead Email"],
    ["Valid Person", "valid@example.com", "9999", "FULL_TIME", "Analyst", "Operations", "2026-09-01", "", "lead@example.com"],
    ["Dup One", "dup@example.com", "", "INTERN", "Intern", "", "01/09/2026", "", "lead@example.com"],
    ["Dup Two", "dup@example.com", "", "INTERN", "Intern", "", "01/09/2026", "", "lead@example.com"],
    ["Bad Type", "bad@example.com", "", "CONTRACT", "Analyst", "", "2026-09-01", "", "lead@example.com"],
    ["", "missing@example.com", "", "FULL_TIME", "Analyst", "", "2026-09-01", "", "lead@example.com"],
    ["Existing", "taken@example.com", "", "FULL_TIME", "Analyst", "", "2026-09-01", "", "lead@example.com"],
    ["Pending", "pending@example.com", "", "FULL_TIME", "Analyst", "", "2026-09-01", "", "lead@example.com"],
    ["Warn Person", "warn@example.com", "", "TRAINER", "Trainer", "Nowhere", "2026-09-01", "", "ghost@example.com"],
  ]);
  const rows = validateRoster(raw, lookups);

  it("keeps a clean row valid and resolves lookups", () => {
    expect(rows[0]!.severity).toBe("valid");
    expect(rows[0]!.departmentId).toBe("dept-ops");
    expect(rows[0]!.reportingLeadId).toBe("lead-1");
    expect(rows[0]!.category).toBe("full_time");
  });

  it("flags both copies of an in-file duplicate", () => {
    expect(rows[1]!.errors.join()).toContain("Duplicate email");
    expect(rows[2]!.errors.join()).toContain("Duplicate email");
  });

  it("flags bad type, missing name, existing account and pending invite", () => {
    expect(rows[3]!.severity).toBe("error");
    expect(rows[4]!.errors.join()).toContain("Full Name");
    expect(rows[5]!.errors.join()).toContain("already exists");
    expect(rows[6]!.errors.join()).toContain("pending invitation");
  });

  it("warns without blocking for unknown department and lead", () => {
    expect(rows[7]!.severity).toBe("warning");
    expect(rows[7]!.warnings.length).toBe(2);
  });

  it("summarises", () => {
    const s = summariseRoster(rows);
    expect(s.total).toBe(8);
    expect(s.error).toBe(6);
    expect(s.importable).toBe(2);
  });
});
