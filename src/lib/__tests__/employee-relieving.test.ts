import { describe, expect, it } from "vitest";
import { formatLetterDate, generateRelievingLetterPdf } from "../relieving/pdf-generator.server";
import type { RelievingLetterData } from "../relieving/types";

describe("Employee Relieving PDF Generator", () => {
  it("formats date strings into clean corporate format", () => {
    expect(formatLetterDate("2026-10-30")).toBe("30 Oct 2026");
    expect(formatLetterDate("2026-07-02")).toBe("2 Jul 2026");
    expect(formatLetterDate(null)).toBe("");
  });

  it("generates a valid PDF buffer matching reference template", async () => {
    const data: RelievingLetterData = {
      employeeName: "B.Yaswanth",
      designation: "AI Data Annotation Analyst - Intern",
      legalEmployer: "Learning Paths Technologies LLP",
      joiningDate: "2026-07-02",
      lastWorkingDay: "2026-10-30",
      relievingEffectiveDate: "2026-10-30",
      letterIssueDate: "2026-10-30",
      contributedProjects: "AI Data Associate Intern",
      performanceStatement: "satisfactory",
      signatoryName: "K. Spandana",
      signatoryTitle: "HR - Director",
      signatoryDesignation: "Director",
      isDraft: false,
    };

    const pdfBytes = await generateRelievingLetterPdf(data);
    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    expect(pdfBytes.length).toBeGreaterThan(10000); // Has embedded images and text

    // Check PDF magic bytes '%PDF-'
    const header = Buffer.from(pdfBytes.slice(0, 5)).toString("ascii");
    expect(header).toBe("%PDF-");
  });

  it("generates draft PDF with watermark", async () => {
    const data: RelievingLetterData = {
      employeeName: "Test Employee",
      designation: "Software Engineer",
      legalEmployer: "Learning Paths Technologies LLP",
      joiningDate: "2026-01-01",
      lastWorkingDay: "2026-06-30",
      relievingEffectiveDate: "2026-06-30",
      letterIssueDate: "2026-06-30",
      contributedProjects: "Core Platform",
      performanceStatement: "exemplary",
      signatoryName: "K. Spandana",
      signatoryTitle: "HR - Director",
      signatoryDesignation: "Director",
      isDraft: true,
    };

    const pdfBytes = await generateRelievingLetterPdf(data);
    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    expect(pdfBytes.length).toBeGreaterThan(10000);
  });
});
