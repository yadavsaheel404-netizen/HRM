import fs from "node:fs";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  buildApprovedLettersZip,
  buildRecipientPlaceholderVariables,
  deduplicateRecipientDispatches,
  evaluateCustomTemplateRecipientReadiness,
  evaluateRelievingRecipientReadiness,
  extractDocxPlaceholders,
  inspectPdfTemplate,
  personalizeDocxBuffer,
  personalizeFillablePdf,
  renderCustomEmailContent,
  resolveEmailCenterAccessPolicy,
  resolveRecipientEmailSelection,
  validateUploadedTemplateFile,
} from "../email-center/custom-templates";
import {
  CUSTOM_TEMPLATE_MAX_BYTES,
  CUSTOM_TEMPLATE_PLACEHOLDERS,
  DISPATCH_CHUNK_SIZE,
  OFFICIAL_SENDER_DISPLAY,
  STATIC_PDF_WARNING_MESSAGE,
  type CustomEmailTemplateRecord,
  type EmailCenterRecipientItem,
} from "../email-center/types";
import { DEFAULT_EMAIL_TEMPLATES } from "../recruitment/email-templates";
import {
  inspectEmailProviderConfig,
  SMTP_BULK_PACING_MS,
} from "../recruitment/email-transport.server";
import { generateRelievingLetterPdf } from "../relieving/pdf-generator.server";

function buildMinimalDocx(options?: {
  bodyXml?: string;
  headerXml?: string;
  includeMedia?: boolean;
  includeMacro?: boolean;
}): Uint8Array {
  const docXml =
    options?.bodyXml ??
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Dear {{</w:t></w:r><w:r><w:t>employee_name</w:t></w:r><w:r><w:t>}},</w:t></w:r></w:p>
    <w:p><w:r><w:t>Employee ID: {{employee_id}} | Designation: {{designation}}</w:t></w:r></w:p>
    <w:p><w:t>Joining: {{joining_date}} | Last Working Day: {{last_working_date}}</w:t></w:p>
    <w:p><w:t>Type: {{work_type}} / {{employment_category}} | Org: {{company_name}} | Date: {{issue_date}}</w:t></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:t>Table Cell</w:t></w:p></w:tc></w:tr></w:tbl>
  </w:body>
</w:document>`;

  const entries: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
    ),
    "word/document.xml": strToU8(docXml),
  };
  if (options?.headerXml) {
    entries["word/header1.xml"] = strToU8(options.headerXml);
  }
  if (options?.includeMedia) {
    entries["word/media/logo.png"] = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  }
  if (options?.includeMacro) {
    entries["word/vbaProject.bin"] = new Uint8Array([1, 2, 3, 4]);
  }
  return zipSync(entries);
}

async function buildStaticPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  page.drawText("Static HR Policy Handbook - Company Wide", { x: 40, y: 340, size: 12 });
  return doc.save();
}

async function buildFillablePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const form = doc.getForm();
  const nameField = form.createTextField("employee_name");
  nameField.addToPage(page, { x: 40, y: 300, width: 220, height: 24 });
  const idField = form.createTextField("employee_id");
  idField.addToPage(page, { x: 40, y: 260, width: 150, height: 24 });
  return doc.save();
}

function makeRecipient(overrides: Partial<EmailCenterRecipientItem> = {}): EmailCenterRecipientItem {
  return {
    recordId: "rec-1",
    profileId: "prof-1",
    employeeCode: "TAS-0042",
    historicalRecordId: "TAS-REC-0042",
    fullName: "Aarav Sharma",
    designation: "AI Engineer",
    departmentId: "dept-1",
    departmentName: "Engineering",
    employmentCategory: "full_time",
    workType: "full_time",
    employmentStatus: "active",
    isFormer: false,
    isHistoricalOnly: false,
    joiningDate: "2026-01-10",
    lastWorkingDate: "2026-10-31",
    relievingEffectiveDate: "2026-10-31",
    legalEmployer: "Learning Paths Technologies LLP",
    workEmail: "aarav@theaischool.co",
    personalEmail: "aarav.personal@gmail.com",
    workEmailAvailable: true,
    personalEmailAvailable: true,
    relievingCase: {
      id: "rc-1",
      status: "approved",
      designation: "AI Engineer",
      legalEmployer: "Learning Paths Technologies LLP",
      joiningDate: "2026-01-10",
      lastWorkingDay: "2026-10-31",
      relievingEffectiveDate: "2026-10-31",
      letterIssueDate: "2026-10-31",
      contributedProjects: "Core LLM Curriculum & Platform",
      performanceStatement: "commendable",
      signatoryName: "K. Spandana",
      signatoryTitle: "HR - Director",
      signatoryDesignation: "Director",
      companyContact: "+91 92468 18843",
      companyAddress: "T-hub 2.0, Knowledge City, Hyderabad, Telangana",
      projectClearance: true,
      assetClearance: true,
      checklistHandover: true,
      letterPdfPath: null,
      emailStatus: "not_sent",
      emailSentAt: null,
    },
    ...overrides,
  };
}

function makeCustomTemplate(
  overrides: Partial<CustomEmailTemplateRecord> = {},
): CustomEmailTemplateRecord {
  return {
    id: "tpl-custom-1",
    name: "Alumni Verification Letter",
    description: "Custom HR document",
    purposeCategory: "hr_notice",
    subjectTemplate: "Important Update — {{employee_name}}",
    bodyHtmlTemplate: "<p>Hello {{employee_name}} ({{employee_id}})</p>",
    bodyTextTemplate: "Hello {{employee_name}} ({{employee_id}})",
    attachmentPath: "tpl-custom-1/v1/letter.docx",
    attachmentFilename: "letter.docx",
    attachmentFormat: "docx",
    attachmentMime:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    attachmentSizeBytes: 2048,
    attachmentSha256: "abc",
    pdfMode: null,
    detectedPlaceholders: ["employee_name", "employee_id", "designation"],
    recipientType: "all_records",
    defaultEmailMode: "personal",
    senderDisplay: OFFICIAL_SENDER_DISPLAY,
    status: "approved",
    requiresElevatedApproval: false,
    version: 1,
    createdBy: "hr-1",
    updatedBy: "hr-1",
    approvedBy: "hr-1",
    approvedAt: "2026-11-27T08:00:00Z",
    createdAt: "2026-11-27T08:00:00Z",
    updatedAt: "2026-11-27T08:00:00Z",
    ...overrides,
  };
}

describe("Part 1: Relieving Individualization, Validation & Approved ZIP", () => {
  it("generates separate individualized Relieving Letter PDFs and bundles distinct ZIP files", async () => {
    const empA = await generateRelievingLetterPdf({
      employeeName: "Macharla Chanti",
      designation: "AI Data Associate Intern",
      legalEmployer: "Learning Paths Technologies LLP",
      joiningDate: "2026-07-02",
      lastWorkingDay: "2026-10-30",
      relievingEffectiveDate: "2026-10-30",
      letterIssueDate: "2026-10-30",
      contributedProjects: "Annotation Pipeline A",
      performanceStatement: "satisfactory",
      signatoryName: "K. Spandana",
      signatoryTitle: "HR - Director",
      signatoryDesignation: "Director",
      isDraft: false,
      includeSignature: true,
    });

    const empB = await generateRelievingLetterPdf({
      employeeName: "Priya Verma",
      designation: "ML Ops Engineer",
      legalEmployer: "Learning Paths Technologies LLP",
      joiningDate: "2025-03-01",
      lastWorkingDay: "2026-11-15",
      relievingEffectiveDate: "2026-11-15",
      letterIssueDate: "2026-11-15",
      contributedProjects: "Inference Infrastructure",
      performanceStatement: "commendable",
      signatoryName: "K. Spandana",
      signatoryTitle: "HR - Director",
      signatoryDesignation: "Director",
      isDraft: false,
      includeSignature: true,
    });

    expect(empA.byteLength).toBeGreaterThan(5000);
    expect(empB.byteLength).toBeGreaterThan(5000);
    expect(Buffer.from(empA).equals(Buffer.from(empB))).toBe(false);

    const zipBytes = buildApprovedLettersZip([
      { fileName: "Experience_Letter_TAS-001_Macharla_Chanti.pdf", pdfBytes: empA },
      { fileName: "Experience_Letter_TAS-002_Priya_Verma.pdf", pdfBytes: empB },
    ]);
    const unpacked = unzipSync(zipBytes);
    const names = Object.keys(unpacked);
    expect(names).toEqual([
      "Experience_Letter_TAS-001_Macharla_Chanti.pdf",
      "Experience_Letter_TAS-002_Priya_Verma.pdf",
    ]);
    expect(unpacked[names[0]!]!.byteLength).toBe(empA.byteLength);
    expect(unpacked[names[1]!]!.byteLength).toBe(empB.byteLength);
  });

  it("blocks official issuance/send when relieving approval is pending or missing", () => {
    const pendingRecipient = makeRecipient({
      relievingCase: {
        ...makeRecipient().relievingCase!,
        status: "pending_approval",
      },
    });
    const res = evaluateRelievingRecipientReadiness(pendingRecipient, "personal");
    expect(res.status).toBe("approval_pending");
    expect(res.canOfficialIssue).toBe(false);
    expect(res.canSendOfficial).toBe(false);

    const noCaseRecipient = makeRecipient({
      isHistoricalOnly: true,
      profileId: null,
      relievingCase: null,
    });
    const res2 = evaluateRelievingRecipientReadiness(noCaseRecipient, "personal");
    expect(res2.status).toBe("approval_pending");
    expect(res2.canOfficialIssue).toBe(false);
    expect(res2.canSendOfficial).toBe(false);

    const approvedRecipient = makeRecipient({ isFormer: true, employmentStatus: "inactive" });
    const res3 = evaluateRelievingRecipientReadiness(approvedRecipient, "personal");
    expect(res3.status).toBe("ready");
    expect(res3.canOfficialIssue).toBe(true);
    expect(res3.canSendOfficial).toBe(true);
  });

  it("flags already_sent cases so duplicate official letters are prevented", () => {
    const sentRec = makeRecipient({
      relievingCase: {
        ...makeRecipient().relievingCase!,
        status: "relieved",
        emailStatus: "accepted_by_smtp",
        emailSentAt: "2026-11-01T10:00:00Z",
      },
    });
    const res = evaluateRelievingRecipientReadiness(sentRec, "personal");
    expect(res.status).toBe("already_sent");
    expect(res.canSendOfficial).toBe(false);
  });
});

describe("Part 2: Custom Email Templates — Preserves Standard 16, Validates & Personalizes DOCX/PDF", () => {
  it("preserves all 16 existing standard HR templates untouched and places Custom Templates below Relieving", () => {
    expect(DEFAULT_EMAIL_TEMPLATES.length).toBe(16);
    expect(DEFAULT_EMAIL_TEMPLATES.some((t) => t.slug === "employee_relieving_letter")).toBe(true);

    const routeSource = fs.readFileSync(
      path.resolve(process.cwd(), "src/routes/_authenticated/email-center.tsx"),
      "utf8",
    );
    const relievingIdx = routeSource.indexOf("Relieving & Experience Letters");
    const customIdx = routeSource.indexOf("Custom Email Templates (");
    expect(relievingIdx).toBeGreaterThan(-1);
    expect(customIdx).toBeGreaterThan(relievingIdx);
  });

  it("enforces file extension, MIME, size, magic-byte & macro security validation", () => {
    const badExe = validateUploadedTemplateFile({
      fileName: "payload.exe",
      mimeType: "application/x-msdownload",
      bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]),
    });
    expect(badExe.valid).toBe(false);

    const spoofedPdf = validateUploadedTemplateFile({
      fileName: "fake.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([0x4d, 0x5a, 0x00, 0x01]),
    });
    expect(spoofedPdf.valid).toBe(false);

    const macroDocx = validateUploadedTemplateFile({
      fileName: "macro.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: buildMinimalDocx({ includeMacro: true }),
    });
    expect(macroDocx.valid).toBe(false);

    const oversized = validateUploadedTemplateFile({
      fileName: "huge.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array(CUSTOM_TEMPLATE_MAX_BYTES + 1),
    });
    expect(oversized.valid).toBe(false);

    const validDocx = validateUploadedTemplateFile({
      fileName: "../Offer Supplement.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: buildMinimalDocx(),
    });
    expect(validDocx.valid).toBe(true);
    if (validDocx.valid) {
      expect(validDocx.format).toBe("docx");
      expect(validDocx.safeFileName).toBe("Offer_Supplement.docx");
    }
  });

  it("detects split-run DOCX placeholders, preserves media/headers/tables, and personalizes cleanly", () => {
    const rawDocx = buildMinimalDocx({
      includeMedia: true,
      headerXml:
        '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:t>Company: {{company_name}}</w:t></w:p></w:hdr>',
    });
    const inspected = extractDocxPlaceholders(rawDocx);
    expect(inspected.hasImages).toBe(true);
    expect(inspected.hasTables).toBe(true);
    expect(inspected.hasHeaderOrFooter).toBe(true);
    for (const p of CUSTOM_TEMPLATE_PLACEHOLDERS) {
      expect(inspected.supportedPlaceholders).toContain(p);
    }

    const recipient = makeRecipient();
    const vars = buildRecipientPlaceholderVariables(recipient);
    const personalized = personalizeDocxBuffer(rawDocx, vars);
    expect(personalized.missingPlaceholders).toEqual([]);

    const outEntries = unzipSync(personalized.buffer);
    expect(outEntries["word/media/logo.png"]).toBeDefined();
    const docXmlOut = strFromU8(outEntries["word/document.xml"]!);
    expect(docXmlOut).toContain("Aarav Sharma");
    expect(docXmlOut).toContain("TAS-0042");
    expect(docXmlOut).toContain("<w:tbl>");
    const headerOut = strFromU8(outEntries["word/header1.xml"]!);
    expect(headerOut).toContain("Learning Paths Technologies LLP");
  });

  it("never falsifies static PDF personalization and emits exact static notice; supports fillable PDFs", async () => {
    const staticPdf = await buildStaticPdf();
    const staticInfo = await inspectPdfTemplate(staticPdf);
    expect(staticInfo.mode).toBe("static");
    expect(staticInfo.detectedPlaceholders).toEqual([]);
    expect(staticInfo.warning).toBe(STATIC_PDF_WARNING_MESSAGE);

    const fillablePdf = await buildFillablePdf();
    const fillInfo = await inspectPdfTemplate(fillablePdf);
    expect(fillInfo.mode).toBe("fillable");
    expect(fillInfo.detectedPlaceholders).toEqual(["employee_name", "employee_id"]);
    expect(fillInfo.warning).toBeNull();

    const filled = await personalizeFillablePdf(fillablePdf, {
      employee_name: "Neha Kulkarni",
      employee_id: "TAS-0099",
    });
    expect(filled.filledFields).toEqual(["employee_name", "employee_id"]);
    expect(filled.missingPlaceholders).toEqual([]);
    // Re-loading flattened PDF should have no open form fields
    const reloaded = await PDFDocument.load(filled.buffer);
    expect(reloaded.getForm().getFields().length).toBe(0);
  });

  it("blocks custom personalized sends when required placeholder values are missing", () => {
    const tpl = makeCustomTemplate();
    const missingDesignation = makeRecipient({ designation: null, relievingCase: null });
    const evalRes = evaluateCustomTemplateRecipientReadiness({
      template: tpl,
      recipient: missingDesignation,
      defaultEmailMode: "personal",
    });
    expect(evalRes.ready).toBe(false);
    expect(evalRes.missingPlaceholders).toContain("designation");
  });
});

describe("Part 3: Personal vs Work Email, Deduplication, Queue Config & RBAC", () => {
  it("respects Personal vs Work email selection without silent fallback and warns for former staff work email", () => {
    const formerNoPersonal = makeRecipient({
      isFormer: true,
      employmentStatus: "inactive",
      personalEmail: null,
      personalEmailAvailable: false,
      workEmail: "old.staff@theaischool.co",
    });

    const pRes = resolveRecipientEmailSelection(formerNoPersonal, "personal", undefined, {
      isRelievingWorkflow: true,
    });
    expect(pRes.resolvedEmail).toBeNull();
    expect(pRes.status).toBe("missing_personal_email");
    expect(pRes.statusLabel).toBe("Missing Personal Email");

    const wRes = resolveRecipientEmailSelection(formerNoPersonal, "work", undefined, {
      isRelievingWorkflow: true,
    });
    expect(wRes.resolvedEmail).toBe("old.staff@theaischool.co");
    expect(wRes.status).toBe("ready");
    expect(wRes.warning).toContain("former/relieved");

    // Per-recipient override
    const overrideRes = resolveRecipientEmailSelection(makeRecipient(), "personal", "work");
    expect(overrideRes.emailMode).toBe("work");
    expect(overrideRes.resolvedEmail).toBe("aarav@theaischool.co");
  });

  it("deduplicates identical target email addresses cleanly", () => {
    const { uniqueItems, duplicateItems } = deduplicateRecipientDispatches([
      { recipientRecordId: "rec-1", resolvedEmail: "Same.Person@gmail.com" },
      { recipientRecordId: "rec-2", resolvedEmail: "same.person@gmail.com" },
      { recipientRecordId: "rec-3", resolvedEmail: "other@gmail.com" },
    ]);
    expect(uniqueItems.map((i) => i.recipientRecordId)).toEqual(["rec-1", "rec-3"]);
    expect(duplicateItems.map((i) => i.recipientRecordId)).toEqual(["rec-2"]);
  });

  it("uses controlled Hostinger chunk pacing and never leaks SMTP_PASS or Resend/Titan", () => {
    expect(DISPATCH_CHUNK_SIZE).toBe(15);
    expect(SMTP_BULK_PACING_MS).toBeGreaterThanOrEqual(1000);
    expect(OFFICIAL_SENDER_DISPLAY).toBe("The AI School HR <hr@theaischool.co>");

    const check = inspectEmailProviderConfig({
      SMTP_HOST: "smtp.hostinger.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "hr@theaischool.co",
      SMTP_PASS: "real-test-credential-value",
      EMAIL_FROM: "hr@theaischool.co",
    });
    expect(check.configured).toBe(true);
    expect(JSON.stringify(check)).not.toContain("real-test-credential-value");
  });

  it("enforces strict RBAC across HR, Super Admin, Founder, Admin, Manager, Lead & Employee", () => {
    const hr = resolveEmailCenterAccessPolicy("hr", [
      "emails:read:all",
      "emails:manage:all",
      "emails:send:all",
    ]);
    expect(hr.canManageCustomTemplates).toBe(true);
    expect(hr.canSendEmails).toBe(true);
    expect(hr.canViewPersonalEmails).toBe(true);
    expect(hr.canAccessPrivateTemplateFiles).toBe(true);

    const founder = resolveEmailCenterAccessPolicy("founder", ["emails:read:all"]);
    expect(founder.canReadEmailCenter).toBe(true);
    expect(founder.isFounder).toBe(true);
    expect(founder.isReadOnly).toBe(true);
    expect(founder.canManageCustomTemplates).toBe(false);
    expect(founder.canSendEmails).toBe(false);
    expect(founder.canViewPersonalEmails).toBe(false);
    expect(founder.canAccessPrivateTemplateFiles).toBe(false);

    const admin = resolveEmailCenterAccessPolicy("admin", ["emails:read:all"]);
    expect(admin.canManageCustomTemplates).toBe(false);
    expect(admin.canSendEmails).toBe(false);
    expect(admin.canViewPersonalEmails).toBe(false);
    expect(admin.canAccessPrivateTemplateFiles).toBe(false);

    for (const role of ["manager", "lead", "employee"]) {
      const restricted = resolveEmailCenterAccessPolicy(role, []);
      expect(restricted.canReadEmailCenter).toBe(false);
      expect(restricted.canManageCustomTemplates).toBe(false);
      expect(restricted.canSendEmails).toBe(false);
      expect(restricted.canViewPersonalEmails).toBe(false);
    }
  });

  it("renders subject, HTML and text safely with HTML escaping", () => {
    const rendered = renderCustomEmailContent({
      subjectTemplate: "Notice for {{employee_name}}",
      bodyHtmlTemplate: "<p>Hi {{employee_name}}, role: {{designation}}</p>",
      bodyTextTemplate: "Hi {{employee_name}}, role: {{designation}}",
      variables: {
        employee_name: "Aarav <Script>",
        designation: "AI Engineer",
      },
    });
    expect(rendered.subject).toBe("Notice for Aarav <Script>");
    expect(rendered.bodyHtml).toContain("Aarav &lt;Script&gt;");
    expect(rendered.missingPlaceholders).toEqual([]);
  });

  it("migration secures private custom-email-templates bucket and strict RLS policies", () => {
    const sql = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "supabase/migrations/20261127150000_custom_email_templates_and_bulk_dispatch.sql",
      ),
      "utf8",
    );
    expect(sql).toContain("'custom-email-templates'");
    expect(sql).toContain("public = false");
    expect(sql).toContain("REVOKE ALL ON TABLE");
    expect(sql).toContain("FROM PUBLIC, anon");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("public.has_permission(auth.uid(), 'emails:manage:all')");
    expect(sql).toContain("public.has_permission(auth.uid(), 'emails:send:all')");
  });
});
