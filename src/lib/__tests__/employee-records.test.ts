import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { neutralizeFormula } from "../csv";
import { buildRoleNavigation } from "../navigation";
import {
  canExportEmployeeRecords,
  canManageEmployeeRecords,
  canViewRecordConfidentialFields,
  isReadOnlySafePermission,
  normalizeEffectivePermissions,
  type Actor,
  type AppRole,
} from "../permissions";
import { decodeExcelSerialDate, parseExcelRecordDate } from "../records/date-parser";
import {
  CONSOLIDATED_EXCEL_HEADERS,
  classifyEmploymentStatus,
  detectSourceColumnMapping,
  filterAndSortUnifiedRecords,
  matchDriveFolderLinks,
  matchImportRowsAgainstDirectory,
  mergeWorkforceAndRecords,
  type DirectoryRecordEntry,
  type DirectoryWorkforceEntry,
  type UnifiedWorkforceProfileInput,
} from "../records/matcher";
import {
  computeDocumentAvailability,
  computeDocumentSource,
  computeRecordCompleteness,
  redactRecordForViewer,
  validateGoogleDriveFolderUrl,
  type EmployeeRecordItem,
} from "../records/types";
import { excludeProtectedAccounts } from "../work-type";

const repoRoot = resolve(__dirname, "../../..");
const migrationSql = readFileSync(
  resolve(repoRoot, "supabase/migrations/20261125120000_employee_records_master_register.sql"),
  "utf8",
);
const hardeningMigrationSql = readFileSync(
  resolve(repoRoot, "supabase/migrations/20261125150000_employee_records_unique_guards_and_backfill.sql"),
  "utf8",
);

function makeActor(roles: AppRole[]): Actor {
  return {
    userId: `user-${roles.join("-")}`,
    fullName: "Test User",
    workEmail: "test@theaischool.co",
    accountStatus: "active",
    category: "full_time",
    roles,
    permissions: normalizeEffectivePermissions(roles, []),
  };
}

describe("Employee Records — Excel Date Normalization & Ambiguity Detection", () => {
  it("decodes 1900 and 1904 Excel serial dates accurately", () => {
    expect(decodeExcelSerialDate(45292, false)).toBe("2024-01-01");
    expect(decodeExcelSerialDate(45658, false)).toBe("2025-01-01");
    const serial1904 = parseExcelRecordDate(44197, { date1904: true });
    expect(serial1904.status).toBe("parsed");
    expect(serial1904.iso).toBe("2025-01-02");
  });

  it("parses weekday-prefixed, ISO, and named-month dates cleanly", () => {
    expect(parseExcelRecordDate("Mon, 15 Jan 2024").iso).toBe("2024-01-15");
    expect(parseExcelRecordDate("Monday, January 15, 2024").iso).toBe("2024-01-15");
    expect(parseExcelRecordDate("Fri Jan 10 2025 00:00:00 GMT+0530 (India Standard Time)").iso).toBe("2025-01-10");
    expect(parseExcelRecordDate("2026-07-02").iso).toBe("2026-07-02");
    expect(parseExcelRecordDate("30 Oct 2026").iso).toBe("2026-10-30");
  });

  it("handles unambiguous MM-DD-YYYY and DD-MM-YYYY and flags ambiguous dates as Needs Review", () => {
    // 07/22/2026 -> unambiguous MM-DD-YYYY
    const mdy = parseExcelRecordDate("07/22/2026");
    expect(mdy.status).toBe("parsed");
    expect(mdy.iso).toBe("2026-07-22");

    // 22/07/2026 -> unambiguous DD-MM-YYYY
    const dmy = parseExcelRecordDate("22/07/2026");
    expect(dmy.status).toBe("parsed");
    expect(dmy.iso).toBe("2026-07-22");

    // 05/08/2025 -> ambiguous in auto mode; never guessed silently
    const amb = parseExcelRecordDate("05/08/2025", { numericPreference: "auto" });
    expect(amb.status).toBe("needs_review");
    expect(amb.iso).toBeNull();
    expect(amb.suggestedIso).toBe("2025-05-08");
    expect(amb.alternateIso).toBe("2025-08-05");

    // Explicit preference resolves it when chosen by HR
    expect(parseExcelRecordDate("05/08/2025", { numericPreference: "mdy" }).iso).toBe("2025-05-08");
    expect(parseExcelRecordDate("05/08/2025", { numericPreference: "dmy" }).iso).toBe("2025-08-05");
  });

  it("never invents blank dates or LWD sentinels", () => {
    for (const emptyVal of ["", null, undefined, "-", "N/A", "Still working", "Active"]) {
      const res = parseExcelRecordDate(emptyVal);
      expect(res.status).toBe("empty");
      expect(res.iso).toBeNull();
    }
  });
});

describe("Employee Records — 263-Row Consolidated Excel Fidelity, Matching & Outcomes A/B/C", () => {
  const workforceFixture: DirectoryWorkforceEntry[] = [
    {
      profileId: "wf-1",
      employeeCode: "TAS-001",
      fullName: "Vattikonda Sreeja",
      workEmail: "sreeja@theaischool.co",
      personalEmail: "sreeja.p@gmail.com",
      mobile: "+91 9876543210",
      employmentStatus: "active",
      category: "full_time",
      workType: "annotation",
      designation: "AI Data Analyst",
      departmentName: "Annotation",
      joiningDate: "2025-02-01",
      lastWorkingDay: null,
      hasRelievedCase: false,
    },
    {
      profileId: "wf-only-1",
      employeeCode: "TAS-002",
      fullName: "Arjun Nair",
      workEmail: "arjun.nair@theaischool.co",
      personalEmail: null,
      mobile: "9988776655",
      employmentStatus: "active",
      category: "intern",
      workType: "engineering",
      designation: "Engineering Intern",
      departmentName: "Engineering",
      joiningDate: "2026-08-01",
      lastWorkingDay: null,
      hasRelievedCase: false,
    },
    {
      profileId: "wf-ambig-1",
      employeeCode: "TAS-003",
      fullName: "Kiran Kumar",
      workEmail: "kiran.k1@theaischool.co",
      personalEmail: null,
      mobile: "9111111111",
      employmentStatus: "active",
      category: "full_time",
      workType: "operations",
      designation: "Ops Associate",
      departmentName: "Operations",
      joiningDate: "2025-05-01",
      lastWorkingDay: null,
      hasRelievedCase: false,
    },
  ];

  const existingRecordsFixture: DirectoryRecordEntry[] = [];

  it("auto-maps Consolidated IC's DB.xlsx 7 columns and handles all 263 rows matching source completeness", () => {
    const mapping = detectSourceColumnMapping([...CONSOLIDATED_EXCEL_HEADERS]);
    expect(mapping.firstName).toBe("First Name");
    expect(mapping.lastName).toBe("Last Name");
    expect(mapping.phoneNumber).toBe("Phone Number");
    expect(mapping.joiningDate).toBe("DOJ");
    expect(mapping.lastWorkingDate).toBe("LWD");
    expect(mapping.personalEmail).toBe("E-Mail ID");
    expect(mapping.organizationEmail).toBe("TAS Mail");

    // Build exact 263-row synthetic dataset matching completeness counts:
    // First Name: 263, Last Name: 24, Phone: 147, DOJ: 243, LWD: 149, Personal Email: 55, TAS Mail: 187
    const rows: Record<string, string | number | null>[] = [];
    for (let i = 1; i <= 263; i += 1) {
      if (i === 1) {
        // Matches wf-1 via TAS Mail
        rows.push({
          "First Name": "Vattikonda",
          "Last Name": "Sreeja",
          "Phone Number": "9876543210",
          DOJ: "2025-02-01",
          LWD: "",
          "E-Mail ID": "sreeja.p@gmail.com",
          "TAS Mail": "sreeja@theaischool.co",
        });
        continue;
      }
      rows.push({
        "First Name": `HistoricalEmp${i}`,
        "Last Name": i <= 24 ? `Last${i}` : "",
        "Phone Number": i <= 147 ? `90000${String(10000 + i).slice(-5)}` : "",
        DOJ: i <= 243 ? 45292 + (i % 180) : "",
        LWD: i <= 149 ? "2025-11-15" : "",
        "E-Mail ID": i <= 55 ? `hist${i}@gmail.com` : "",
        "TAS Mail": i <= 187 ? `hist${i}@theaischool.co` : "",
      });
    }

    const res = matchImportRowsAgainstDirectory(
      rows,
      { workforce: workforceFixture, records: existingRecordsFixture, todayIso: "2026-11-25" },
      { mapping, dateOptions: { date1904: false, numericPreference: "auto" } },
    );

    expect(res.rows.length).toBe(263);
    // Outcome A: Row 1 matches existing Workforce (rejected as duplicate, never overwritten)
    expect(res.summary.duplicateExistingCount).toBe(1);
    expect(res.summary.duplicateCount).toBe(1);
    expect(res.rows[0]!.category).toBe("duplicate_existing");
    expect(res.rows[0]!.matchedProfileId).toBe("wf-1");
    expect(res.rows[0]!.matchedTasCode).toBe("TAS-001");
    expect(res.rows[0]!.readyToImport).toBe(false);
    // Outcome B: Remaining 262 are genuinely new historical records
    expect(res.summary.newHistoricalCount).toBe(262);
    expect(res.summary.readyToImportCount).toBe(262);
    expect(res.rows[10]!.employmentCategory).toBe("unknown");
    expect(res.rows[10]!.workType).toBe("unknown");
    expect(res.rows[10]!.lastName).toBe("Last11");
    expect(res.rows[199]!.lastName).toBeNull();
    // Rows with blank LWD & no active Workforce link flag statusNeedsReview (never silently Active!)
    const rowWithBlankLwd = res.rows[200]!;
    expect(rowWithBlankLwd.lastWorkingDate).toBeNull();
    expect(rowWithBlankLwd.statusNeedsReview).toBe(true);
    expect(rowWithBlankLwd.employmentStatus).toBe("inactive");
    // Outcome C: Workforce employees absent from Excel (Arjun & Kiran) surfaced for Workforce Sync
    expect(res.summary.missingWorkforceCount).toBe(2);
    expect(res.missingWorkforceProfiles.map((m) => m.profileId)).toEqual(["wf-only-1", "wf-ambig-1"]);
  });

  it("requires manual review on name-only ambiguity and never rejects distinct employees sharing a phone", () => {
    const mapping = detectSourceColumnMapping([...CONSOLIDATED_EXCEL_HEADERS]);
    const res = matchImportRowsAgainstDirectory(
      [
        {
          "First Name": "Kiran",
          "Last Name": "Kumar",
          "Phone Number": "",
          DOJ: "2025-05-01",
          LWD: "",
          "E-Mail ID": "",
          "TAS Mail": "",
        },
        {
          "First Name": "Different",
          "Last Name": "Person",
          "Phone Number": "9111111111",
          DOJ: "2025-05-01",
          LWD: "2025-11-01",
          "E-Mail ID": "",
          "TAS Mail": "different.person@theaischool.co",
        },
      ],
      { workforce: workforceFixture, records: existingRecordsFixture, todayIso: "2026-11-25" },
      { mapping },
    );

    // Row 1 matched by name only -> requires manual review & NOT ready to import
    expect(res.rows[0]!.category).toBe("possible_duplicate");
    expect(res.rows[0]!.matchConfidence).toBe("needs_review");
    expect(res.rows[0]!.matchedProfileId).toBeNull();
    expect(res.rows[0]!.readyToImport).toBe(false);

    // Row 2 has distinct name & unique org email sharing phone only -> NOT falsely rejected as duplicate
    expect(res.rows[1]!.category).toBe("new_historical");
    expect(res.rows[1]!.readyToImport).toBe(true);
    expect(res.rows[1]!.warnings.some((w) => w.includes("not rejected"))).toBe(true);
  });

  it("rejects intra-file duplicates while keeping first valid occurrence, and enforces mixed 20-row counts", () => {
    const mapping = detectSourceColumnMapping([...CONSOLIDATED_EXCEL_HEADERS]);

    // 20 rows: 15 new + 3 existing Workforce + 2 repeated inside file
    const rows: Record<string, string | number | null>[] = [];
    // 3 duplicates against existing Workforce (Sreeja, Arjun, Kiran)
    rows.push(
      { "First Name": "Vattikonda", "Last Name": "Sreeja", "Phone Number": "", DOJ: "2025-02-01", LWD: "", "E-Mail ID": "", "TAS Mail": "sreeja@theaischool.co" },
      { "First Name": "Arjun", "Last Name": "Nair", "Phone Number": "", DOJ: "2026-08-01", LWD: "", "E-Mail ID": "", "TAS Mail": "arjun.nair@theaischool.co" },
      { "First Name": "Kiran", "Last Name": "Kumar", "Phone Number": "9111111111", DOJ: "2025-05-01", LWD: "", "E-Mail ID": "", "TAS Mail": "kiran.k1@theaischool.co" },
    );
    // 15 genuinely new employees
    for (let i = 1; i <= 15; i += 1) {
      rows.push({
        "First Name": `NewEmp${i}`,
        "Last Name": `Surname${i}`,
        "Phone Number": `98220${String(10000 + i).slice(-5)}`,
        DOJ: "2025-01-10",
        LWD: "2025-09-30",
        "E-Mail ID": `newemp${i}@gmail.com`,
        "TAS Mail": `newemp${i}@theaischool.co`,
      });
    }
    // 2 duplicates inside same file (repeating NewEmp1 by org email and NewEmp2 by personal email)
    rows.push(
      { "First Name": "NewEmp1", "Last Name": "Duplicate", "Phone Number": "", DOJ: "2025-01-10", LWD: "2025-09-30", "E-Mail ID": "", "TAS Mail": "NEWEMP1@theaischool.co" },
      { "First Name": "NewEmp2", "Last Name": "Duplicate", "Phone Number": "", DOJ: "2025-01-10", LWD: "2025-09-30", "E-Mail ID": "NewEmp2@gmail.com", "TAS Mail": "" },
    );

    const res = matchImportRowsAgainstDirectory(
      rows,
      { workforce: workforceFixture, records: existingRecordsFixture, todayIso: "2026-11-25" },
      { mapping },
    );

    expect(res.summary.totalRows).toBe(20);
    expect(res.summary.readyToImportCount).toBe(15);
    expect(res.summary.newHistoricalCount).toBe(15);
    expect(res.summary.duplicateExistingCount).toBe(3);
    expect(res.summary.duplicateInFileCount).toBe(2);
    expect(res.summary.duplicateCount).toBe(5);
    expect(res.rows[18]!.category).toBe("duplicate_in_file");
    expect(res.rows[18]!.readyToImport).toBe(false);
    expect(res.rows[19]!.category).toBe("duplicate_in_file");
    expect(res.rows[19]!.readyToImport).toBe(false);
  });

  it("unifies existing Workforce employees with employee_records without duplication and supports search/status filter", () => {
    const workforce: UnifiedWorkforceProfileInput[] = [
      {
        id: "p-active",
        employeeCode: "TAS-002",
        fullName: "Arjun Verma",
        workEmail: "arjun@theaischool.co",
        personalEmail: "arjun@gmail.com",
        mobile: "9876500001",
        address: null,
        joiningDate: "2024-06-01",
        lastWorkingDay: null,
        employmentStatus: "active",
        category: "full_time",
        workType: "engineering",
        departmentId: "dept-1",
        departmentName: "Engineering",
        designation: "Software Engineer",
        reportingLeadId: null,
        reportingLeadName: null,
        hasRelievedCase: false,
        relievingEffectiveDate: null,
        legalEmployer: null,
        createdAt: "2024-06-01T00:00:00Z",
      },
      {
        id: "p-relieved",
        employeeCode: "TAS-003",
        fullName: "Chanti Macharla",
        workEmail: "chanti@theaischool.co",
        personalEmail: null,
        mobile: null,
        address: null,
        joiningDate: "2025-07-02",
        lastWorkingDay: "2025-10-30",
        employmentStatus: "inactive",
        category: "intern",
        workType: "annotation",
        departmentId: "dept-2",
        departmentName: "Annotation",
        designation: "AI Data Intern",
        reportingLeadId: null,
        reportingLeadName: null,
        hasRelievedCase: true,
        relievingEffectiveDate: "2025-10-30",
        legalEmployer: "Learning Paths Technologies LLP",
        createdAt: "2025-07-02T00:00:00Z",
      },
    ];

    const storedRecordForChanti: EmployeeRecordItem = {
      id: "rec-chanti",
      historicalRecordCode: "TAS-REC-0001",
      profileId: "p-relieved",
      tasEmployeeCode: "TAS-003",
      firstName: "Chanti",
      lastName: "Macharla",
      displayName: "Chanti Macharla",
      personalEmail: null,
      organizationEmail: "chanti@theaischool.co",
      phoneNumber: null,
      address: null,
      joiningDate: "2025-07-02",
      lastWorkingDate: "2025-10-30",
      employmentStatus: "inactive",
      statusNeedsReview: false,
      statusSource: "relieving_record",
      employmentCategory: "intern",
      workType: "annotation",
      departmentId: "dept-2",
      departmentName: "Annotation",
      designation: "AI Data Intern",
      reportingManagerId: null,
      reportingManagerName: null,
      legalEmployer: "Learning Paths Technologies LLP",
      driveFolderUrl: null,
      driveFolderName: null,
      driveFolderId: null,
      driveMatchStatus: "unmatched",
      driveMatchedAt: null,
      hasDriveFolder: false,
      kycSummary: null,
      documentSource: "NONE",
      documentAvailabilityStatus: "missing",
      sourceType: "workforce_sync",
      sourceImportBatchId: null,
      lastSyncedAt: "2026-11-25T00:00:00Z",
      lastUpdatedBy: null,
      recordCompleteness: 80,
      missingFields: [],
      matchConfidence: "exact",
      duplicateReviewStatus: "clear",
      needsReview: false,
      reviewReasons: [],
      notes: null,
      createdAt: "2026-11-25T00:00:00Z",
      updatedAt: "2026-11-25T00:00:00Z",
    };

    const merged = mergeWorkforceAndRecords({
      workforce,
      records: [storedRecordForChanti],
      kycSummaries: new Map(),
      todayIso: "2026-11-25",
    });

    // Exactly 2 unified records: Arjun synthesized as wf:p-active, Chanti uses rec-chanti (zero duplication)
    expect(merged.length).toBe(2);
    expect(merged.find((r) => r.profileId === "p-active")?.id).toBe("wf:p-active");
    expect(merged.find((r) => r.profileId === "p-relieved")?.id).toBe("rec-chanti");

    const activeOnly = filterAndSortUnifiedRecords(merged, { employmentStatus: "active" });
    expect(activeOnly.filtered.map((r) => r.displayName)).toEqual(["Arjun Verma"]);

    const searchByDept = filterAndSortUnifiedRecords(merged, { search: "Annotation" });
    expect(searchByDept.filtered.map((r) => r.displayName)).toEqual(["Chanti Macharla"]);
  });

  it("completes 500-row parse, match, and classification well within performance budget", () => {
    const mapping = detectSourceColumnMapping([...CONSOLIDATED_EXCEL_HEADERS]);
    const rows = Array.from({ length: 500 }, (_, idx) => ({
      "First Name": `ScaleUser${idx}`,
      "Last Name": idx % 4 === 0 ? `Surname${idx}` : "",
      "Phone Number": `98100${String(10000 + idx).slice(-5)}`,
      DOJ: "2025-03-15",
      LWD: idx % 2 === 0 ? "2026-01-15" : "",
      "E-Mail ID": `scale${idx}@gmail.com`,
      "TAS Mail": `scale${idx}@theaischool.co`,
    }));

    const start = performance.now();
    const res = matchImportRowsAgainstDirectory(
      rows,
      { workforce: workforceFixture, records: [], todayIso: "2026-11-25" },
      { mapping },
    );
    const elapsedMs = performance.now() - start;

    expect(res.rows.length).toBe(500);
    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe("Employee Records — Status Precedence, Google Drive & HRM KYC Separation", () => {
  it("follows exact status classification precedence without guessing Active on blank LWD", () => {
    expect(
      classifyEmploymentStatus({
        workforceEmploymentStatus: "active",
        hasRelievedCase: true,
        todayIso: "2026-11-25",
      }),
    ).toEqual({
      employmentStatus: "inactive",
      statusNeedsReview: false,
      statusSource: "relieving_record",
    });

    expect(
      classifyEmploymentStatus({
        workforceEmploymentStatus: "active",
        hasRelievedCase: false,
        todayIso: "2026-11-25",
      }),
    ).toEqual({
      employmentStatus: "active",
      statusNeedsReview: false,
      statusSource: "workforce_verified",
    });

    expect(
      classifyEmploymentStatus({
        parsedLastWorkingDate: "2026-05-01",
        todayIso: "2026-11-25",
      }),
    ).toEqual({
      employmentStatus: "inactive",
      statusNeedsReview: false,
      statusSource: "hr_historical",
    });

    expect(classifyEmploymentStatus({ todayIso: "2026-11-25" })).toEqual({
      employmentStatus: "inactive",
      statusNeedsReview: true,
      statusSource: "needs_review",
    });
  });

  it("validates Google Drive folder URLs strictly and flags ambiguous folder names", () => {
    const ok = validateGoogleDriveFolderUrl("https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOpQr");
    expect(ok.valid).toBe(true);
    expect(ok.folderId).toBe("1AbCdEfGhIjKlMnOpQr");
    expect(ok.normalizedUrl).toBe("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQr");

    // Reject single-file links and non-Google-Drive URLs
    const fileLink = validateGoogleDriveFolderUrl("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQr/view");
    expect(fileLink.valid).toBe(false);
    expect(validateGoogleDriveFolderUrl("https://evil.example.com/folders/12345678901").valid).toBe(false);

    const recs: DirectoryRecordEntry[] = [
      {
        id: "r1",
        historicalRecordCode: "TAS-REC-0001",
        profileId: null,
        tasEmployeeCode: null,
        displayName: "Sneha Reddy",
        organizationEmail: "sneha.1@theaischool.co",
        personalEmail: null,
        phoneNumber: null,
        joiningDate: "2025-01-01",
        employmentStatus: "inactive",
        designation: null,
        departmentName: null,
      },
      {
        id: "r2",
        historicalRecordCode: "TAS-REC-0002",
        profileId: null,
        tasEmployeeCode: null,
        displayName: "Sneha Reddy",
        organizationEmail: "sneha.2@theaischool.co",
        personalEmail: null,
        phoneNumber: null,
        joiningDate: "2026-01-01",
        employmentStatus: "active",
        designation: null,
        departmentName: null,
      },
    ];

    const matched = matchDriveFolderLinks(
      [
        {
          rowNumber: 1,
          employeeName: "Sneha Reddy",
          employeeEmail: null,
          historicalRecordCode: null,
          driveFolderUrl: "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQr",
        },
        {
          rowNumber: 2,
          employeeName: "Sneha Reddy",
          employeeEmail: null,
          historicalRecordCode: "TAS-REC-0002",
          driveFolderUrl: "https://drive.google.com/drive/folders/2XyZAbCdEfGhIjKlMnO",
        },
      ],
      recs,
    );

    expect(matched[0]!.matchStatus).toBe("ambiguous");
    expect(matched[0]!.confirmed).toBe(false);
    expect(matched[0]!.candidates.length).toBe(2);

    expect(matched[1]!.matchStatus).toBe("exact");
    expect(matched[1]!.matchedRecordId).toBe("r2");
    expect(matched[1]!.confirmed).toBe(true);
  });

  it("keeps HISTORICAL_GOOGLE_DRIVE and HRM_KYC references separate without auto-verifying Drive docs", () => {
    expect(computeDocumentSource(false, false)).toBe("NONE");
    expect(computeDocumentSource(true, false)).toBe("HISTORICAL_GOOGLE_DRIVE");
    expect(computeDocumentSource(false, true)).toBe("HRM_KYC");
    expect(computeDocumentSource(true, true)).toBe("BOTH");

    expect(computeDocumentAvailability(true, { status: "not_started", verifiedCount: 0, requiredCount: 5 })).toBe(
      "available",
    );
    expect(
      computeDocumentAvailability(false, { status: "incomplete", uploadedCount: 2, verifiedCount: 0, requiredCount: 5 }),
    ).toBe("partial");

    const comp = computeRecordCompleteness({
      lastName: "Sreeja",
      organizationEmail: "sreeja@theaischool.co",
      documentSource: "HISTORICAL_GOOGLE_DRIVE",
    });
    expect(comp.missingFields).toContain("joining_date");
    expect(comp.missingFields).not.toContain("documents");
  });
});

describe("Employee Records — RBAC, Founder Redaction, Navigation & SQL Integrity", () => {
  it("restricts sidebar /records visibility strictly to HR, Founder, and Super Admin", () => {
    for (const role of ["hr", "founder", "super_admin"] as AppRole[]) {
      const paths = buildRoleNavigation(makeActor([role])).flatMap((g) => g.items.map((i) => i.to));
      expect(paths).toContain("/records");
    }
    for (const role of ["admin", "manager", "lead", "employee"] as AppRole[]) {
      const paths = buildRoleNavigation(makeActor([role])).flatMap((g) => g.items.map((i) => i.to));
      expect(paths).not.toContain("/records");
    }
  });

  it("enforces Founder read-only access and strips confidential PII and Drive folder URLs", () => {
    const founder = makeActor(["founder"]);
    const hr = makeActor(["hr"]);
    const sa = makeActor(["super_admin"]);
    const admin = makeActor(["admin"]);

    expect(isReadOnlySafePermission("records:read:all")).toBe(true);
    expect(isReadOnlySafePermission("records:manage:all")).toBe(false);
    expect(isReadOnlySafePermission("records:documents:read")).toBe(false);

    expect(canManageEmployeeRecords(founder.roles, founder.permissions)).toBe(false);
    expect(canViewRecordConfidentialFields(founder.roles, founder.permissions)).toBe(false);
    expect(canExportEmployeeRecords(founder.roles, founder.permissions)).toBe(true);

    expect(canManageEmployeeRecords(hr.roles, hr.permissions)).toBe(true);
    expect(canViewRecordConfidentialFields(hr.roles, hr.permissions)).toBe(true);
    expect(canManageEmployeeRecords(sa.roles, sa.permissions)).toBe(true);
    expect(canViewRecordConfidentialFields(sa.roles, sa.permissions)).toBe(true);
    expect(canManageEmployeeRecords(admin.roles, admin.permissions)).toBe(false);
    expect(canViewRecordConfidentialFields(admin.roles, admin.permissions)).toBe(false);

    const sampleRecord: Partial<EmployeeRecordItem> = {
      id: "rec-1",
      historicalRecordCode: "TAS-REC-0001",
      displayName: "Vattikonda Sreeja",
      organizationEmail: "sreeja@theaischool.co",
      personalEmail: "sreeja.private@gmail.com",
      phoneNumber: "+91 9876543210",
      address: "Hyderabad, TS",
      driveFolderUrl: "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQr",
      driveFolderId: "1AbCdEfGhIjKlMnOpQr",
      hasDriveFolder: true,
      documentSource: "BOTH",
    };

    const founderView = redactRecordForViewer(sampleRecord, false);
    expect(founderView.driveFolderUrl).toBeNull();
    expect(founderView.personalEmail).toBeNull();
    expect(founderView.phoneNumber).toBeNull();
    expect(founderView.address).toBeNull();
    expect(founderView.hasDriveFolder).toBe(true);
    expect(founderView.documentSource).toBe("BOTH");

    const hrView = redactRecordForViewer(sampleRecord, true);
    expect(hrView.driveFolderUrl).toBe("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQr");
    expect(hrView.personalEmail).toBe("sreeja.private@gmail.com");

    // Protected Super Admin accounts excluded & spreadsheet formulas neutralized
    expect(excludeProtectedAccounts([{ id: "sa-1" }, { id: "emp-1" }], new Set(["sa-1"]))).toEqual([
      { id: "emp-1" },
    ]);
    expect(neutralizeFormula("=cmd|'/C calc'!A0")).toBe("'=cmd|'/C calc'!A0");
  });

  it("verifies SQL migration schema, sequence, RLS policies, Founder view, and one-way sync triggers", () => {
    expect(migrationSql).toContain("CREATE SEQUENCE IF NOT EXISTS public.employee_record_id_seq");
    expect(migrationSql).toContain("'TAS-REC-'");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS public.employee_records");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS public.employee_employment_history");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS public.employee_record_import_batches");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS public.employee_record_import_rows");
    expect(migrationSql).toContain("public.employee_records_executive_overview");
    expect(migrationSql).toContain("public.sync_profile_to_employee_record");
    expect(migrationSql).toContain("trg_profiles_sync_employee_records");
    expect(migrationSql).toContain("trg_relieving_cases_sync_employee_records");
    expect(migrationSql).toContain("trg_kyc_state_sync_employee_records");
    expect(migrationSql).toContain("NOT public.is_protected_account(profile_id)");
    expect(migrationSql).toContain("('founder'::public.app_role, 'records:read:all')");
    expect(migrationSql).not.toContain("('founder'::public.app_role, 'records:manage:all')");
    expect(migrationSql).not.toContain("('founder'::public.app_role, 'records:documents:read')");

    // Hardening & backfill migration checks
    expect(hardeningMigrationSql).toContain("uq_employee_records_tas_code");
    expect(hardeningMigrationSql).toContain("uq_employee_records_org_email");
    expect(hardeningMigrationSql).toContain("'duplicate'");
    expect(hardeningMigrationSql).toContain("sync_all_workforce_to_employee_records");
  });
});
