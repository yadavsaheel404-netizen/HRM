import fs from "node:fs";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  buildPersonalizedAttachmentFilename,
  buildRecipientPlaceholderVariables,
  detectRemainingBlankFieldsInParagraphs,
  detectUnmappedBlankFieldsInDocx,
  evaluateCustomTemplateRecipientReadiness,
  extractDocxPlaceholders,
  isRelievingStyleCustomTemplate,
  personalizeDocxBuffer,
} from "../email-center/custom-templates";
import type {
  CustomEmailTemplateRecord,
  EmailCenterRecipientItem,
} from "../email-center/types";
import { DEFAULT_EMAIL_TEMPLATES } from "../recruitment/email-templates";
import { createHostingerSmtpTransport } from "../recruitment/email-transport.server";

/**
 * Realistic A4 WordprocessingML DOCX reproducing `TEMPLATE RELIEVING LETTER.docx`:
 * - Embedded header PNG, footer PNG, and authorized signature/stamp PNG
 * - A4 page geometry (<w:pgSz w:w="11906" w:h="16838"/>) & preserved margins
 * - Plain-text blank Date:, blank Dear salutation, association paragraph with role/dates,
 *   and blank "effective close of business on" relieving date
 * - Includes an extra paragraph containing words "Date" and "Dear" to verify no blind global replacement.
 */
function buildTemplateRelievingLetterDocx(options?: {
  withExplicitTokens?: boolean;
}): Uint8Array {
  const docXml = options?.withExplicitTokens
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Private &amp; Confidential</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Date: {{issue_date}}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/><w:u w:val="single"/></w:rPr><w:t>Subject: Experience Letter.</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Dear {{employee_name}},</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">This is to certify that you were associated with </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">{{legal_employer}}</w:t></w:r><w:r><w:t xml:space="preserve"> as an </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>{{designation}}</w:t></w:r><w:r><w:t xml:space="preserve"> from </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">{{joining_date}} to {{last_working_date}}</w:t></w:r><w:r><w:t>.</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">As you have completed your tenure with us and duly handed over all assigned responsibilities, we hereby relieve you from your duties effective close of business on </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>{{relieving_date}}</w:t></w:r><w:r><w:t>.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Note: Keep your Dear colleagues informed of any Future Date adjustments separately.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Yours truly,</w:t></w:r></w:p>
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Private &amp; Confidential</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Date: </w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/><w:u w:val="single"/></w:rPr><w:t>Subject: Experience Letter.</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Dear </w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">This is to certify that you were associated with </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Learning Paths Technologies LLP</w:t></w:r><w:r><w:t xml:space="preserve"> as an </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>AI Data Annotation Analyst</w:t></w:r><w:r><w:t xml:space="preserve"> from  to .</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">As you have completed your tenure with us and duly handed over all assigned responsibilities, we hereby relieve you from your duties effective close of business on </w:t></w:r></w:p>
    <w:p><w:r><w:t>Note: Keep your Dear colleagues informed of any Future Date adjustments separately.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Yours truly,</w:t></w:r></w:p>
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;

  const entries: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
    ),
    "word/document.xml": strToU8(docXml),
    "word/header1.xml": strToU8(
      '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:drawing>HeaderBanner</w:drawing></w:r></w:p></w:hdr>',
    ),
    "word/footer1.xml": strToU8(
      '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:drawing>FooterBanner</w:drawing></w:r></w:p></w:ftr>',
    ),
    "word/media/header_banner.png": new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
    "word/media/footer_banner.png": new Uint8Array([137, 80, 78, 71, 4, 5, 6]),
    "word/media/signature_stamp.png": new Uint8Array([137, 80, 78, 71, 7, 8, 9]),
  };
  return zipSync(entries);
}

function makeEmployee(
  overrides: Partial<EmailCenterRecipientItem> = {},
): EmailCenterRecipientItem {
  return {
    recordId: "rec-saheel",
    profileId: "prof-saheel",
    employeeCode: "TAS-0018",
    historicalRecordId: "TAS-REC-0018",
    fullName: "Saheel Yadav",
    designation: "Gen AI Intern",
    departmentId: "dept-eng",
    departmentName: "Engineering",
    employmentCategory: "intern",
    workType: "engineering",
    employmentStatus: "inactive",
    isFormer: true,
    isHistoricalOnly: false,
    joiningDate: "2026-06-29",
    lastWorkingDate: "2026-10-30",
    relievingEffectiveDate: "2026-10-30",
    legalEmployer: "Learning Paths Technologies LLP",
    workEmail: "saheel@theaischool.co",
    personalEmail: "saheel.yadav@gmail.com",
    workEmailAvailable: true,
    personalEmailAvailable: true,
    relievingCase: {
      id: "rc-saheel",
      status: "approved",
      designation: "Gen AI Intern",
      legalEmployer: "Learning Paths Technologies LLP",
      joiningDate: "2026-06-29",
      lastWorkingDay: "2026-10-30",
      relievingEffectiveDate: "2026-10-30",
      letterIssueDate: "2026-11-27",
      contributedProjects: "LLM Platform Engineering",
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

function makeCustomRelievingTemplate(
  overrides: Partial<CustomEmailTemplateRecord> = {},
): CustomEmailTemplateRecord {
  return {
    id: "tpl-rel-1",
    name: "Relieving & Experience Letter",
    description: "Official relieving custom DOCX template",
    purposeCategory: "hr_notice",
    subjectTemplate: "Relieving & Experience Letter — {{employee_name}}",
    bodyHtmlTemplate:
      "<p>Dear {{employee_name}},</p><p>Please find attached your Experience Letter.</p>",
    bodyTextTemplate: "Dear {{employee_name}}, Please find attached your Experience Letter.",
    attachmentPath: "tpl-rel-1/v1/TEMPLATE_RELIEVING_LETTER.docx",
    attachmentFilename: "TEMPLATE_RELIEVING_LETTER.docx",
    attachmentFormat: "docx",
    attachmentMime:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    attachmentSizeBytes: 4096,
    attachmentSha256: "sha-demo",
    pdfMode: null,
    documentMode: "personalized",
    fieldMappings: [],
    requiresRelievingApproval: true,
    detectedPlaceholders: [
      "employee_name",
      "issue_date",
      "designation",
      "joining_date",
      "last_working_date",
      "relieving_date",
    ],
    recipientType: "former_employees",
    defaultEmailMode: "personal",
    senderDisplay: "The AI School HR <hr@theaischool.co>",
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

describe("Custom DOCX Relieving Personalization, Validation, Filename & SMTP MIME", () => {
  it("detects blank Date:, Dear, from/to dates & relieving date slots without modifying unrelated lines", () => {
    const rawDocx = buildTemplateRelievingLetterDocx();
    const snapshotBefore = Buffer.from(rawDocx);

    const detected = detectUnmappedBlankFieldsInDocx(rawDocx);
    expect(detected.isLikelyRelievingTemplate).toBe(true);
    expect(detected.hasUnmappedBlanks).toBe(true);
    expect(detected.blankLabels).toContain('Blank "Date:" field');
    expect(detected.blankLabels).toContain('Blank "Dear" salutation');
    expect(detected.blankLabels).toContain('Blank "from" Joining Date');
    expect(detected.blankLabels).toContain('Blank "to" Last Working Date');
    expect(detected.blankLabels).toContain(
      'Blank "effective close of business on" Relieving Date',
    );

    const emp = makeEmployee();
    const vars = buildRecipientPlaceholderVariables(emp, { isRelievingTemplate: true });
    expect(vars["issue_date"]).toBe("27 Nov 2026");
    expect(vars["joining_date"]).toBe("29 Jun 2026");
    expect(vars["last_working_date"]).toBe("30 Oct 2026");
    expect(vars["relieving_date"]).toBe("30 Oct 2026");

    const res = personalizeDocxBuffer(rawDocx, vars, {
      fieldMappings: detected.suggestedMappings,
    });
    expect(res.isVerifiedClean).toBe(true);
    expect(res.missingPlaceholders).toEqual([]);
    expect(res.unresolvedPlaceholders).toEqual([]);
    expect(res.remainingBlankFields).toEqual([]);

    const outZip = unzipSync(res.buffer);
    const outDocXml = strFromU8(outZip["word/document.xml"]!);

    // Populated fields verified
    expect(outDocXml).toContain("Date: 27 Nov 2026");
    expect(outDocXml).toContain("Dear Saheel Yadav,");
    expect(outDocXml).toContain("Gen AI Intern");
    expect(outDocXml).toContain("29 Jun 2026 to 30 Oct 2026");
    expect(outDocXml).toContain("effective close of business on 30 Oct 2026.");
    expect(outDocXml).toContain("Learning Paths Technologies LLP");

    // Unrelated occurrences of "Dear" and "Date" remained untouched!
    expect(outDocXml).toContain(
      "Note: Keep your Dear colleagues informed of any Future Date adjustments separately.",
    );

    // Media, header, footer, signature PNGs & A4 geometry preserved cleanly
    expect(outZip["word/media/header_banner.png"]).toBeDefined();
    expect(outZip["word/media/footer_banner.png"]).toBeDefined();
    expect(outZip["word/media/signature_stamp.png"]).toBeDefined();
    expect(outDocXml).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
    expect(strFromU8(outZip["word/header1.xml"]!)).toContain("HeaderBanner");
    expect(strFromU8(outZip["word/footer1.xml"]!)).toContain("FooterBanner");

    // Bold run formatting preserved
    expect(outDocXml).toContain("<w:rPr><w:b/></w:rPr>");

    // Original buffer remained 100% immutable
    expect(Buffer.from(rawDocx).equals(snapshotBefore)).toBe(true);
  });

  it("formats dynamic attachment filenames cleanly and blocks path traversal / bad extensions", () => {
    expect(
      buildPersonalizedAttachmentFilename({
        employeeFullName: "Saheel Yadav",
        templateDisplayName: "Relieving & Experience Letter",
        format: "docx",
        documentMode: "personalized",
        staticOriginalFilename: "TEMPLATE_RELIEVING_LETTER.docx",
      }),
    ).toBe("Saheel Yadav - Relieving & Experience Letter.docx");

    expect(
      buildPersonalizedAttachmentFilename({
        employeeFullName: "Nikitha",
        templateDisplayName: "Experience Letter",
        format: "docx",
        documentMode: "personalized",
      }),
    ).toBe("Nikitha - Experience Letter.docx");

    expect(
      buildPersonalizedAttachmentFilename({
        employeeFullName: "../bad/..\\Saheel:Yadav*?",
        templateDisplayName: "Relieving & Experience Letter",
        format: "pdf",
        documentMode: "personalized",
      }),
    ).toBe("bad SaheelYadav - Relieving & Experience Letter.pdf");

    // Static non-relieving template preserves original filename when requested
    expect(
      buildPersonalizedAttachmentFilename({
        employeeFullName: "Saheel Yadav",
        templateDisplayName: "Holiday Calendar",
        format: "pdf",
        documentMode: "static",
        staticOriginalFilename: "2026_Holiday_Calendar.pdf",
      }),
    ).toBe("2026_Holiday_Calendar.pdf");
  });

  it("enforces separate bulk DOCX buffers per recipient with zero cross-recipient data leakage", () => {
    const rawDocx = buildTemplateRelievingLetterDocx();
    const { suggestedMappings } = detectUnmappedBlankFieldsInDocx(rawDocx);

    const empA = makeEmployee({
      recordId: "rec-a",
      fullName: "Saheel Yadav",
      designation: "AI Platform Engineer",
      relievingCase: {
        ...makeEmployee().relievingCase!,
        designation: "AI Platform Engineer",
        joiningDate: "2026-06-29",
        lastWorkingDay: "2026-10-30",
        relievingEffectiveDate: "2026-10-30",
        letterIssueDate: "2026-11-27",
      },
    });
    const empB = makeEmployee({
      recordId: "rec-b",
      fullName: "Nikitha",
      designation: "Gen AI Intern",
      relievingCase: {
        ...makeEmployee().relievingCase!,
        id: "rc-b",
        designation: "Gen AI Intern",
        joiningDate: "2026-01-15",
        lastWorkingDay: "2026-09-30",
        relievingEffectiveDate: "2026-09-30",
        letterIssueDate: "2026-10-05",
      },
    });

    const outA = personalizeDocxBuffer(
      rawDocx,
      buildRecipientPlaceholderVariables(empA, { isRelievingTemplate: true }),
      { fieldMappings: suggestedMappings },
    );
    const outB = personalizeDocxBuffer(
      rawDocx,
      buildRecipientPlaceholderVariables(empB, { isRelievingTemplate: true }),
      { fieldMappings: suggestedMappings },
    );

    const xmlA = strFromU8(unzipSync(outA.buffer)["word/document.xml"]!);
    const xmlB = strFromU8(unzipSync(outB.buffer)["word/document.xml"]!);

    expect(xmlA).toContain("Dear Saheel Yadav,");
    expect(xmlA).toContain("AI Platform Engineer");
    expect(xmlA).toContain("29 Jun 2026 to 30 Oct 2026");
    expect(xmlA).not.toContain("Nikitha");
    expect(xmlA).not.toContain("15 Jan 2026");

    expect(xmlB).toContain("Dear Nikitha,");
    expect(xmlB).toContain("Gen AI Intern");
    expect(xmlB).toContain("15 Jan 2026 to 30 Sep 2026");
    expect(xmlB).not.toContain("Saheel Yadav");
    expect(xmlB).not.toContain("AI Platform Engineer");
  });

  it("blocks relieving sends when dates are missing, case is unapproved, or static mode is chosen", () => {
    const template = makeCustomRelievingTemplate();

    const missingDatesEmp = makeEmployee({
      joiningDate: null,
      lastWorkingDate: null,
      relievingEffectiveDate: null,
      relievingCase: {
        ...makeEmployee().relievingCase!,
        joiningDate: null,
        lastWorkingDay: null,
        relievingEffectiveDate: null,
      },
    });
    const missingRes = evaluateCustomTemplateRecipientReadiness({
      template,
      recipient: missingDatesEmp,
      defaultEmailMode: "personal",
    });
    expect(missingRes.ready).toBe(false);
    expect(missingRes.validationStatus).toBe("missing_information");
    expect(missingRes.missingPlaceholders).toContain("joining_date");
    expect(missingRes.missingPlaceholders).toContain("last_working_date");

    const pendingEmp = makeEmployee({
      relievingCase: { ...makeEmployee().relievingCase!, status: "pending_approval" },
    });
    const pendingRes = evaluateCustomTemplateRecipientReadiness({
      template,
      recipient: pendingEmp,
      defaultEmailMode: "personal",
    });
    expect(pendingRes.ready).toBe(false);
    expect(pendingRes.validationStatus).toBe("approval_pending");

    const staticRelievingTpl = makeCustomRelievingTemplate({ documentMode: "static" });
    const staticRes = evaluateCustomTemplateRecipientReadiness({
      template: staticRelievingTpl,
      recipient: makeEmployee(),
      defaultEmailMode: "personal",
    });
    expect(staticRes.ready).toBe(false);
    expect(staticRes.validationStatus).toBe("invalid_template");

    // Partial batch: valid ready employee still passes while missing/pending ones are blocked
    const readyRes = evaluateCustomTemplateRecipientReadiness({
      template,
      recipient: makeEmployee(),
      defaultEmailMode: "personal",
    });
    expect(readyRes.ready).toBe(true);
    expect(readyRes.validationStatus).toBe("ready");
    expect(readyRes.resolvedFilename).toBe("Saheel Yadav - Relieving & Experience Letter.docx");
  });

  it("blocks blank/unresolved placeholder detection before SMTP dispatch and verifies SMTP MIME payload", async () => {
    const rawWithTokens = buildTemplateRelievingLetterDocx({ withExplicitTokens: true });
    const incompleteDoc = personalizeDocxBuffer(rawWithTokens, {
      issue_date: "",
      employee_name: "Nikitha",
      legal_employer: "Learning Paths Technologies LLP",
      designation: "Gen AI Intern",
      joining_date: "29 Jun 2026",
      last_working_date: "",
      relieving_date: "",
    });
    expect(incompleteDoc.isVerifiedClean).toBe(false);
    expect(incompleteDoc.missingPlaceholders).toEqual([
      "issue_date",
      "last_working_date",
      "relieving_date",
    ]);
    expect(detectRemainingBlankFieldsInParagraphs(incompleteDoc.previewParagraphs)).toEqual([]);

    // Valid MIME attachment verification using mock transporter (no real email sent)
    const rawDocx = buildTemplateRelievingLetterDocx();
    const { suggestedMappings } = detectUnmappedBlankFieldsInDocx(rawDocx);
    const emp = makeEmployee();
    const personalized = personalizeDocxBuffer(
      rawDocx,
      buildRecipientPlaceholderVariables(emp, { isRelievingTemplate: true }),
      { fieldMappings: suggestedMappings },
    );
    expect(personalized.isVerifiedClean).toBe(true);

    const filename = buildPersonalizedAttachmentFilename({
      employeeFullName: emp.fullName,
      templateDisplayName: "Relieving & Experience Letter",
      format: "docx",
      documentMode: "personalized",
    });

    let capturedMailOptions: any = null;
    const transport = createHostingerSmtpTransport({
      allowInTests: true,
      env: {
        SMTP_HOST: "smtp.hostinger.com",
        SMTP_PORT: "465",
        SMTP_SECURE: "true",
        SMTP_USER: "hr@theaischool.co",
        SMTP_PASS: "mock-test-only",
        EMAIL_FROM: "hr@theaischool.co",
      },
      transporterFactory: () => ({
        async sendMail(mailOptions) {
          capturedMailOptions = mailOptions;
          return {
            messageId: "<test-docx-msg@theaischool.co>",
            response: "250 2.0.0 Ok: queued",
            accepted: [String(mailOptions.to)],
            rejected: [],
          };
        },
      }),
    });

    const smtpRes = await transport.send({
      to: emp.personalEmail!,
      subject: `Relieving & Experience Letter — ${emp.fullName}`,
      html: `<p>Dear ${emp.fullName}, please find attached your relieving letter.</p>`,
      text: `Dear ${emp.fullName}, please find attached your relieving letter.`,
      idempotencyKey: "test-rel-mime-1",
      attachments: [
        {
          filename,
          content: Buffer.from(personalized.buffer),
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          contentDisposition: "attachment",
        },
      ],
    });

    expect(smtpRes.ok).toBe(true);
    expect(smtpRes.status).toBe("accepted_by_smtp");
    expect(capturedMailOptions.attachments).toHaveLength(1);
    expect(capturedMailOptions.attachments[0].filename).toBe(
      "Saheel Yadav - Relieving & Experience Letter.docx",
    );
    expect(capturedMailOptions.attachments[0].contentDisposition).toBe("attachment");
    expect(capturedMailOptions.attachments[0].contentType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    const sentZip = unzipSync(new Uint8Array(capturedMailOptions.attachments[0].content));
    const sentXml = strFromU8(sentZip["word/document.xml"]!);
    expect(sentXml).toContain("Dear Saheel Yadav,");
    expect(sentXml).toContain("Date: 27 Nov 2026");
    expect(sentXml).toContain("effective close of business on 30 Oct 2026.");
    expect(sentXml).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it("preserves existing 16 standard HR templates & relieving template detection helper", () => {
    expect(DEFAULT_EMAIL_TEMPLATES.length).toBe(16);
    expect(
      isRelievingStyleCustomTemplate({
        templateName: "Annual Holiday Calendar",
        attachmentFilename: "holidays.pdf",
        purposeCategory: "general",
      }),
    ).toBe(false);
    expect(
      isRelievingStyleCustomTemplate({
        templateName: "relieving letter",
        attachmentFilename: "TEMPLATE_RELIEVING_LETTER.docx",
      }),
    ).toBe(true);
    const migSql = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "supabase/migrations/20261127170000_custom_templates_document_mode_and_field_mappings.sql",
      ),
      "utf8",
    );
    expect(migSql).toContain("document_mode");
    expect(migSql).toContain("field_mappings");
    expect(migSql).toContain("requires_relieving_approval");
  });
});
