import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
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

  it("embeds header, footer, and signature PNGs even when process.cwd() is outside workspace (serverless parity)", async () => {
    const sample: RelievingLetterData = {
      employeeName: "B.Yaswanth",
      designation: "AI Data Annotation Analyst – Intern",
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

    const originalCwd = process.cwd();
    let pdfBytes: Uint8Array;
    try {
      process.chdir(os.tmpdir());
      pdfBytes = await generateRelievingLetterPdf(sample);
    } finally {
      process.chdir(originalCwd);
    }

    // Header (RGB+SMask=2) + Footer (RGB+SMask=2) + Stamp (RGB=1) = 5 Image XObjects
    expect(pdfBytes.length).toBeGreaterThan(100_000);
    const loaded = await PDFDocument.load(pdfBytes);
    expect(loaded.getPageCount()).toBe(1);
    const rawPdfStr = Buffer.from(pdfBytes).toString("latin1");
    const imageMatches = rawPdfStr.match(/\/Subtype\s*\/Image/g) ?? [];
    expect(imageMatches.length).toBe(5);
    expect(rawPdfStr).toContain("/Width 1024");
    expect(rawPdfStr).toContain("/Height 306");
    expect(rawPdfStr).toContain("/Height 119");
    expect(rawPdfStr).toContain("/Width 192");
    expect(rawPdfStr).toContain("/Height 219");
  });

  it("supports withholding signature with an explicit placeholder and keeps signature PNG out of public/", async () => {
    const unsignedBytes = await generateRelievingLetterPdf({
      employeeName: "Test Pending",
      designation: "Intern",
      legalEmployer: "Learning Paths Technologies LLP",
      joiningDate: "2026-07-02",
      lastWorkingDay: "2026-10-30",
      relievingEffectiveDate: "2026-10-30",
      letterIssueDate: "2026-10-30",
      contributedProjects: "AI Projects",
      performanceStatement: "satisfactory",
      signatoryName: "K. Spandana",
      signatoryTitle: "HR - Director",
      signatoryDesignation: "Director",
      includeSignature: false,
    });
    const rawPdfStr = Buffer.from(unsignedBytes).toString("latin1");
    const imageMatches = rawPdfStr.match(/\/Subtype\s*\/Image/g) ?? [];
    // Only header (2) + footer (2) embedded = 4 Image XObjects; signature (192x219) omitted
    expect(imageMatches.length).toBe(4);
    expect(rawPdfStr).not.toContain("/Width 192");

    // Private signature/stamp asset must NEVER exist in public/
    const publicFiles = fs.readdirSync(path.resolve("public"), { recursive: true }) as string[];
    expect(publicFiles.some((f) => f.toLowerCase().includes("signature"))).toBe(false);
    expect(publicFiles.some((f) => f.toLowerCase().includes("stamp"))).toBe(false);
  });
});
