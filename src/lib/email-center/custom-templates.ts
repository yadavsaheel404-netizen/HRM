// Pure isomorphic helpers for Custom Email Templates (DOCX/PDF parsing, placeholder resolution),
// Employee Records recipient email selection, relieving eligibility validation, ZIP bundling, and RBAC.
// ZERO `.server` imports — safe in both Vitest/client UI and server functions.

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { formatLetterDate } from "../relieving/types";
import {
  CUSTOM_TEMPLATE_MAX_BYTES,
  CUSTOM_TEMPLATE_PLACEHOLDERS,
  STATIC_PDF_WARNING_MESSAGE,
  type CustomEmailTemplateRecord,
  type EmailCenterAccessPolicy,
  type EmailCenterRecipientItem,
  type RecipientEmailMode,
  type RecipientEmailResolution,
  type RelievingRecipientValidation,
} from "./types";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_MIME = "application/pdf";

const FORBIDDEN_EXTENSIONS = new Set([
  "exe",
  "msi",
  "bat",
  "cmd",
  "ps1",
  "sh",
  "js",
  "mjs",
  "cjs",
  "ts",
  "vbs",
  "scr",
  "dll",
  "html",
  "htm",
  "svg",
  "docm",
  "xlsm",
  "pptm",
  "zip",
]);

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const EMAIL_VALID_RE =
  /^[^\s@<>(),;:\\"[\]]+@[^\s@<>(),;:\\"[\]]+\.[^\s@<>(),;:\\"[\]]{2,}$/i;
const CONTROL_CHARS_RE = /[\r\n\0]/;

export function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export function sanitizeStorageFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "template";
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "");
  return cleaned || "template.bin";
}

export function isValidSingleEmail(email: string | null | undefined): boolean {
  const cleaned = String(email ?? "").trim();
  if (!cleaned || CONTROL_CHARS_RE.test(cleaned)) return false;
  return EMAIL_VALID_RE.test(cleaned);
}

/**
 * Computes authoritative RBAC policy for Email Center & Custom Email Templates.
 */
export function resolveEmailCenterAccessPolicy(
  rolesOrPrimaryRole: string | string[],
  permissions: string[],
): EmailCenterAccessPolicy {
  const roles = (Array.isArray(rolesOrPrimaryRole) ? rolesOrPrimaryRole : [rolesOrPrimaryRole]).map(
    (r) => String(r).toLowerCase(),
  );
  const permSet = new Set(permissions);
  const isSuperAdmin = roles.includes("super_admin");
  const isHr = roles.includes("hr");
  const isFounder = roles.includes("founder") && !isHr && !isSuperAdmin;
  const isAdmin = roles.includes("admin") && !isHr && !isSuperAdmin;

  if (isSuperAdmin || isHr) {
    const canRead = permSet.has("emails:read:all") || isSuperAdmin;
    const canManage = permSet.has("emails:manage:all") || isSuperAdmin;
    const canSend = permSet.has("emails:send:all") || isSuperAdmin;
    return {
      canReadEmailCenter: canRead,
      canManageCustomTemplates: canManage,
      canSendEmails: canSend,
      canViewPersonalEmails: canRead,
      canAccessPrivateTemplateFiles: canManage,
      isReadOnly: !canManage && !canSend,
      isFounder: false,
    };
  }

  if (isFounder) {
    const canRead = permSet.has("emails:read:all");
    return {
      canReadEmailCenter: canRead,
      canManageCustomTemplates: false,
      canSendEmails: false,
      canViewPersonalEmails: false,
      canAccessPrivateTemplateFiles: false,
      isReadOnly: true,
      isFounder: true,
    };
  }

  if (isAdmin) {
    // Admin has standard operational read visibility if granted `emails:read:all`,
    // but NO default custom template management, personal email exposure, or dispatch.
    const canRead = permSet.has("emails:read:all");
    const explicitManage = permSet.has("emails:manage:all");
    const explicitSend = permSet.has("emails:send:all");
    return {
      canReadEmailCenter: canRead,
      canManageCustomTemplates: explicitManage,
      canSendEmails: explicitSend,
      canViewPersonalEmails: explicitManage,
      canAccessPrivateTemplateFiles: explicitManage,
      isReadOnly: !explicitManage && !explicitSend,
      isFounder: false,
    };
  }

  // Manager / Lead / Employee: strictly denied.
  return {
    canReadEmailCenter: false,
    canManageCustomTemplates: false,
    canSendEmails: false,
    canViewPersonalEmails: false,
    canAccessPrivateTemplateFiles: false,
    isReadOnly: true,
    isFounder: false,
  };
}

export type UploadedTemplateValidationResult =
  | {
      valid: true;
      format: "docx" | "pdf";
      normalizedMime: string;
      safeFileName: string;
    }
  | {
      valid: false;
      error: string;
    };

/**
 * Validates custom uploaded DOCX / PDF files using extension, MIME type, size limit,
 * magic bytes, and structural checks (macro/VBA rejection inside DOCX).
 */
export function validateUploadedTemplateFile(input: {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}): UploadedTemplateValidationResult {
  const safeFileName = sanitizeStorageFileName(input.fileName);
  const ext = safeFileName.includes(".")
    ? (safeFileName.split(".").pop()?.toLowerCase() ?? "")
    : "";

  if (!ext || FORBIDDEN_EXTENSIONS.has(ext) || (ext !== "docx" && ext !== "pdf")) {
    return {
      valid: false,
      error: "Only .docx (Word) and .pdf files are supported for custom email templates.",
    };
  }

  if (!input.bytes || input.bytes.byteLength === 0) {
    return { valid: false, error: "Uploaded template file is empty." };
  }

  if (input.bytes.byteLength > CUSTOM_TEMPLATE_MAX_BYTES) {
    return {
      valid: false,
      error: "Template file exceeds the maximum allowed size of 10 MB.",
    };
  }

  const mime = String(input.mimeType ?? "").trim().toLowerCase();

  if (ext === "pdf") {
    if (mime && mime !== PDF_MIME && mime !== "application/octet-stream") {
      return { valid: false, error: `Invalid MIME type "${mime}" for PDF file.` };
    }
    const header = strFromU8(input.bytes.subarray(0, 5));
    if (header !== "%PDF-") {
      return {
        valid: false,
        error: "File content failed PDF magic-byte verification (%PDF- header missing).",
      };
    }
    return {
      valid: true,
      format: "pdf",
      normalizedMime: PDF_MIME,
      safeFileName,
    };
  }

  // .docx checks
  if (
    mime &&
    mime !== DOCX_MIME &&
    mime !== "application/octet-stream" &&
    mime !== "application/x-zip-compressed"
  ) {
    return { valid: false, error: `Invalid MIME type "${mime}" for DOCX file.` };
  }

  if (
    input.bytes.byteLength < 4 ||
    input.bytes[0] !== 0x50 ||
    input.bytes[1] !== 0x4b ||
    input.bytes[2] !== 0x03 ||
    input.bytes[3] !== 0x04
  ) {
    return {
      valid: false,
      error: "File content failed DOCX magic-byte verification (ZIP signature missing).",
    };
  }

  try {
    const entries = unzipSync(input.bytes);
    if (!entries["word/document.xml"]) {
      return {
        valid: false,
        error: "Uploaded DOCX archive is missing word/document.xml.",
      };
    }
    const hasMacro = Object.keys(entries).some((k) =>
      k.toLowerCase().includes("vbaproject.bin"),
    );
    if (hasMacro) {
      return {
        valid: false,
        error: "Macro-enabled Word documents (vbaProject.bin) are blocked for security.",
      };
    }
  } catch {
    return {
      valid: false,
      error: "Uploaded DOCX file could not be unpacked as a valid Word OpenXML package.",
    };
  }

  return {
    valid: true,
    format: "docx",
    normalizedMime: DOCX_MIME,
    safeFileName,
  };
}

/**
 * Extracts coalesced paragraph text and applies optional placeholder replacements inside a single
 * WordprocessingML XML file while preserving split `<w:t>` runs and surrounding `<w:rPr>` formatting.
 */
function transformWordXmlParagraphs(
  xmlText: string,
  variables?: Record<string, string>,
): {
  updatedXml: string;
  paragraphs: string[];
  detectedPlaceholders: string[];
  replacedPlaceholders: string[];
  missingPlaceholders: string[];
} {
  const paragraphs: string[] = [];
  const detectedSet = new Set<string>();
  const replacedSet = new Set<string>();
  const missingSet = new Set<string>();

  const pRegex = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  const updatedXml = xmlText.replace(pRegex, (pBlock) => {
    interface WtSpan {
      fullStart: number;
      fullEnd: number;
      openTag: string;
      rawInner: string;
      decoded: string;
      concatStart: number;
      concatEnd: number;
    }

    const spans: WtSpan[] = [];
    const wtRegex = /<w:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let concatText = "";
    let m: RegExpExecArray | null;

    while ((m = wtRegex.exec(pBlock)) !== null) {
      const fullMatch = m[0];
      const rawInner = m[1] ?? "";
      const closeIdx = fullMatch.lastIndexOf("</w:t>");
      const openEnd = fullMatch.indexOf(">") + 1;
      const openTag = fullMatch.slice(0, openEnd);
      const decoded = decodeXmlEntities(rawInner);
      const concatStart = concatText.length;
      concatText += decoded;
      const concatEnd = concatText.length;

      if (closeIdx > 0) {
        spans.push({
          fullStart: m.index,
          fullEnd: m.index + fullMatch.length,
          openTag,
          rawInner,
          decoded,
          concatStart,
          concatEnd,
        });
      }
    }

    const trimmedParagraph = concatText.trim();
    if (trimmedParagraph) {
      paragraphs.push(trimmedParagraph);
    }

    // Detect all placeholders in coalesced paragraph text (handles split Word runs!)
    const matches: {
      start: number;
      end: number;
      key: string;
      replacement: string | null;
    }[] = [];

    let pm: RegExpExecArray | null;
    const localRe = new RegExp(PLACEHOLDER_RE.source, "g");
    while ((pm = localRe.exec(concatText)) !== null) {
      const key = pm[1] ?? "";
      detectedSet.add(key);

      if (variables) {
        const val = String(variables[key] ?? "").trim();
        if (!val) {
          missingSet.add(key);
        } else {
          replacedSet.add(key);
          matches.push({
            start: pm.index,
            end: pm.index + pm[0].length,
            key,
            replacement: val,
          });
        }
      }
    }

    if (!variables || matches.length === 0 || spans.length === 0) {
      return pBlock;
    }

    // Rewrite each <w:t> segment cleanly
    const updatedTexts = spans.map((s) => s.decoded);

    // Process from right to left so positions within earlier segments stay aligned
    for (let mi = matches.length - 1; mi >= 0; mi--) {
      const match = matches[mi]!;
      const replacement = match.replacement;
      if (replacement === null) continue;

      let inserted = false;
      for (let si = 0; si < spans.length; si++) {
        const span = spans[si]!;
        if (span.concatEnd <= match.start || span.concatStart >= match.end) {
          continue;
        }
        const localStart = Math.max(0, match.start - span.concatStart);
        const localEnd = Math.min(
          updatedTexts[si]!.length,
          match.end - span.concatStart,
        );
        const cur = updatedTexts[si]!;
        const prefix = cur.slice(0, localStart);
        const suffix = cur.slice(localEnd);
        if (!inserted) {
          updatedTexts[si] = `${prefix}${replacement}${suffix}`;
          inserted = true;
        } else {
          updatedTexts[si] = `${prefix}${suffix}`;
        }
      }
    }

    // Reconstruct paragraph XML with preserved xml:space="preserve" when leading/trailing spaces exist
    let out = "";
    let cursor = 0;
    for (let si = 0; si < spans.length; si++) {
      const span = spans[si]!;
      out += pBlock.slice(cursor, span.fullStart);
      const nextText = updatedTexts[si] ?? "";
      const needsPreserve = /^\s|\s$/.test(nextText);
      let openTag = span.openTag;
      if (needsPreserve && !openTag.includes("xml:space")) {
        openTag = openTag.replace("<w:t", '<w:t xml:space="preserve"');
      }
      out += `${openTag}${escapeXmlText(nextText)}</w:t>`;
      cursor = span.fullEnd;
    }
    out += pBlock.slice(cursor);
    return out;
  });

  return {
    updatedXml,
    paragraphs,
    detectedPlaceholders: [...detectedSet],
    replacedPlaceholders: [...replacedSet],
    missingPlaceholders: [...missingSet],
  };
}

export interface DocxInspectionResult {
  detectedPlaceholders: string[];
  supportedPlaceholders: string[];
  unsupportedPlaceholders: string[];
  previewParagraphs: string[];
  hasHeaderOrFooter: boolean;
  hasImages: boolean;
  hasTables: boolean;
}

export function extractDocxPlaceholders(bytes: Uint8Array): DocxInspectionResult {
  const entries = unzipSync(bytes);
  const supportedSet = new Set<string>(CUSTOM_TEMPLATE_PLACEHOLDERS);
  const detectedSet = new Set<string>();
  const previewParagraphs: string[] = [];
  let hasHeaderOrFooter = false;
  let hasImages = false;
  let hasTables = false;

  const entryNames = Object.keys(entries).sort();
  for (const name of entryNames) {
    if (name.startsWith("word/media/")) {
      hasImages = true;
    }
    if (!/^word\/(document|header\d*|footer\d*)\.xml$/i.test(name)) {
      continue;
    }
    if (/^word\/(header|footer)/i.test(name)) {
      hasHeaderOrFooter = true;
    }
    const xml = strFromU8(entries[name]!);
    if (xml.includes("<w:tbl")) {
      hasTables = true;
    }
    if (xml.includes("<w:drawing") || xml.includes("<v:imagedata")) {
      hasImages = true;
    }
    const res = transformWordXmlParagraphs(xml);
    for (const ph of res.detectedPlaceholders) {
      detectedSet.add(ph);
    }
    if (name === "word/document.xml") {
      previewParagraphs.push(...res.paragraphs);
    }
  }

  const detectedPlaceholders = [...detectedSet];
  return {
    detectedPlaceholders,
    supportedPlaceholders: detectedPlaceholders.filter((p) => supportedSet.has(p)),
    unsupportedPlaceholders: detectedPlaceholders.filter((p) => !supportedSet.has(p)),
    previewParagraphs,
    hasHeaderOrFooter,
    hasImages,
    hasTables,
  };
}

export function personalizeDocxBuffer(
  bytes: Uint8Array,
  variables: Record<string, string>,
): {
  buffer: Uint8Array;
  replacedPlaceholders: string[];
  missingPlaceholders: string[];
  previewParagraphs: string[];
} {
  const entries = unzipSync(bytes);
  const outEntries: Record<string, Uint8Array> = {};
  const replacedSet = new Set<string>();
  const missingSet = new Set<string>();
  const previewParagraphs: string[] = [];

  for (const [name, content] of Object.entries(entries)) {
    if (/^word\/(document|header\d*|footer\d*)\.xml$/i.test(name)) {
      const xml = strFromU8(content);
      const res = transformWordXmlParagraphs(xml, variables);
      for (const p of res.replacedPlaceholders) replacedSet.add(p);
      for (const p of res.missingPlaceholders) missingSet.add(p);
      if (name === "word/document.xml") {
        previewParagraphs.push(...res.paragraphs);
      }
      outEntries[name] = strToU8(res.updatedXml);
    } else {
      outEntries[name] = content;
    }
  }

  // Apply placeholder resolution again on final document paragraphs for preview display
  const finalDocXml = outEntries["word/document.xml"];
  const renderedParagraphs = finalDocXml
    ? transformWordXmlParagraphs(strFromU8(finalDocXml)).paragraphs
    : previewParagraphs;

  return {
    buffer: zipSync(outEntries, { level: 6 }),
    replacedPlaceholders: [...replacedSet],
    missingPlaceholders: [...missingSet],
    previewParagraphs: renderedParagraphs,
  };
}

function normalizePdfFieldToPlaceholder(fieldName: string): string {
  return fieldName
    .trim()
    .replace(/^\{\{\s*|\s*\}\}$/g, "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export interface PdfInspectionResult {
  mode: "static" | "fillable";
  pageCount: number;
  detectedPlaceholders: string[];
  fieldNames: string[];
  warning: string | null;
}

/**
 * Inspects an uploaded PDF for fillable AcroForm fields.
 * Arbitrary non-fillable PDFs are strictly marked as "static" with the required warning.
 */
export async function inspectPdfTemplate(bytes: Uint8Array): Promise<PdfInspectionResult> {
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pageCount = pdfDoc.getPageCount();
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  const supportedSet = new Set<string>(CUSTOM_TEMPLATE_PLACEHOLDERS);

  const fieldNames: string[] = [];
  const detectedSet = new Set<string>();

  for (const field of fields) {
    const rawName = field.getName();
    fieldNames.push(rawName);
    const normalized = normalizePdfFieldToPlaceholder(rawName);
    if (supportedSet.has(normalized)) {
      detectedSet.add(normalized);
    }
  }

  if (detectedSet.size > 0) {
    return {
      mode: "fillable",
      pageCount,
      detectedPlaceholders: [...detectedSet],
      fieldNames,
      warning: null,
    };
  }

  return {
    mode: "static",
    pageCount,
    detectedPlaceholders: [],
    fieldNames,
    warning: STATIC_PDF_WARNING_MESSAGE,
  };
}

/**
 * Personalizes a PDF ONLY when it contains matching AcroForm fillable fields.
 * Never alters static PDFs.
 */
export async function personalizeFillablePdf(
  bytes: Uint8Array,
  variables: Record<string, string>,
): Promise<{
  buffer: Uint8Array;
  filledFields: string[];
  missingPlaceholders: string[];
}> {
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  const supportedSet = new Set<string>(CUSTOM_TEMPLATE_PLACEHOLDERS);

  const filledFields: string[] = [];
  const missingSet = new Set<string>();

  for (const field of fields) {
    const rawName = field.getName();
    const key = normalizePdfFieldToPlaceholder(rawName);
    if (!supportedSet.has(key)) continue;

    const val = String(variables[key] ?? "").trim();
    if (!val) {
      missingSet.add(key);
      continue;
    }

    try {
      const textField = form.getTextField(rawName);
      textField.setText(val);
      filledFields.push(key);
    } catch {
      // Non-text form field skipped cleanly
    }
  }

  if (filledFields.length > 0) {
    try {
      form.flatten();
    } catch {
      // Ignore flatten if unsupported on specific widgets
    }
  }

  const outBytes = await pdfDoc.save();
  return {
    buffer: outBytes,
    filledFields,
    missingPlaceholders: [...missingSet],
  };
}

/**
 * Maps verified Employee Records / Workforce fields to custom template placeholders.
 * Never invents missing values — leaves missing fields empty so callers can flag & block.
 */
export function buildRecipientPlaceholderVariables(
  recipient: EmailCenterRecipientItem,
  overrides?: { companyName?: string; issueDate?: string },
): Record<string, string> {
  const todayFormatted = formatLetterDate(new Date().toISOString().slice(0, 10));
  const rawJoining = recipient.relievingCase?.joiningDate ?? recipient.joiningDate;
  const rawLastWorking = recipient.relievingCase?.lastWorkingDay ?? recipient.lastWorkingDate;
  const rawIssue = recipient.relievingCase?.letterIssueDate ?? overrides?.issueDate;

  const companyName =
    String(
      overrides?.companyName ??
        recipient.legalEmployer ??
        recipient.relievingCase?.legalEmployer ??
        "The AI School",
    ).trim();

  return {
    employee_name: recipient.fullName.trim(),
    employee_id: (recipient.employeeCode || recipient.historicalRecordId || "").trim(),
    designation: (recipient.designation ?? "").trim(),
    joining_date: rawJoining ? formatLetterDate(rawJoining) : "",
    last_working_date: rawLastWorking ? formatLetterDate(rawLastWorking) : "",
    work_type: recipient.workType && recipient.workType !== "unknown" ? recipient.workType : "",
    employment_category:
      recipient.employmentCategory && recipient.employmentCategory !== "unknown"
        ? recipient.employmentCategory
        : "",
    company_name: companyName,
    issue_date: rawIssue ? formatLetterDate(rawIssue) : todayFormatted,
  };
}

export function extractTemplatePlaceholdersFromStrings(strings: (string | null | undefined)[]): string[] {
  const found = new Set<string>();
  for (const s of strings) {
    if (!s) continue;
    const re = new RegExp(PLACEHOLDER_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      if (m[1]) found.add(m[1]);
    }
  }
  return [...found];
}

export function renderCustomEmailContent(input: {
  subjectTemplate: string;
  bodyHtmlTemplate: string;
  bodyTextTemplate?: string | null;
  variables: Record<string, string>;
}): {
  subject: string;
  bodyHtml: string;
  bodyText: string;
  detectedPlaceholders: string[];
  missingPlaceholders: string[];
} {
  const detected = extractTemplatePlaceholdersFromStrings([
    input.subjectTemplate,
    input.bodyHtmlTemplate,
    input.bodyTextTemplate ?? "",
  ]);

  const missingSet = new Set<string>();

  const replaceInString = (src: string, htmlEscape: boolean): string =>
    src.replace(new RegExp(PLACEHOLDER_RE.source, "g"), (full, key: string) => {
      const val = String(input.variables[key] ?? "").trim();
      if (!val) {
        missingSet.add(key);
        return full;
      }
      return htmlEscape ? escapeHtmlText(val) : val;
    });

  const subject = replaceInString(input.subjectTemplate, false).replace(/[\r\n\0]+/g, " ").trim();
  const bodyHtml = replaceInString(input.bodyHtmlTemplate, true);
  const plainFallback = input.bodyTextTemplate?.trim()
    ? input.bodyTextTemplate
    : input.bodyHtmlTemplate.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const bodyText = replaceInString(plainFallback, false);

  return {
    subject,
    bodyHtml,
    bodyText,
    detectedPlaceholders: detected,
    missingPlaceholders: [...missingSet],
  };
}

/**
 * Resolves recipient email strictly for the selected mode ("personal" | "work").
 * Never silently falls back to the alternate address when the selected one is missing.
 */
export function resolveRecipientEmailSelection(
  recipient: EmailCenterRecipientItem,
  defaultMode: RecipientEmailMode,
  overrideMode?: RecipientEmailMode,
  options?: { isRelievingWorkflow?: boolean },
): RecipientEmailResolution {
  const emailMode = overrideMode ?? defaultMode;
  const rawEmail = emailMode === "personal" ? recipient.personalEmail : recipient.workEmail;
  const trimmed = rawEmail ? rawEmail.trim() : "";

  if (!trimmed) {
    return {
      emailMode,
      resolvedEmail: null,
      status: emailMode === "personal" ? "missing_personal_email" : "missing_work_email",
      statusLabel: emailMode === "personal" ? "Missing Personal Email" : "Missing Work Email",
      warning: null,
    };
  }

  if (!isValidSingleEmail(trimmed)) {
    return {
      emailMode,
      resolvedEmail: trimmed,
      status: "invalid_email",
      statusLabel: "Invalid Email",
      warning: `Address "${trimmed}" failed email validation.`,
    };
  }

  const isFormerOrInactive =
    recipient.isFormer ||
    recipient.employmentStatus === "relieved" ||
    recipient.employmentStatus === "inactive";

  const warning =
    options?.isRelievingWorkflow && emailMode === "work" && isFormerOrInactive
      ? "Work email may already be inaccessible to a former/relieved employee. Consider switching to Personal Email."
      : null;

  return {
    emailMode,
    resolvedEmail: trimmed.toLowerCase(),
    status: "ready",
    statusLabel: "Ready",
    warning,
  };
}

/**
 * Deduplicates recipients by normalized email address so identical personal/work emails
 * or duplicate rows never result in multiple messages to the same inbox.
 */
export function deduplicateRecipientDispatches<
  T extends { recipientRecordId: string; resolvedEmail: string | null },
>(items: T[]): { uniqueItems: T[]; duplicateItems: T[] } {
  const seen = new Set<string>();
  const uniqueItems: T[] = [];
  const duplicateItems: T[] = [];

  for (const item of items) {
    const emailKey = String(item.resolvedEmail ?? "").trim().toLowerCase();
    if (!emailKey) {
      uniqueItems.push(item);
      continue;
    }
    if (seen.has(emailKey)) {
      duplicateItems.push(item);
    } else {
      seen.add(emailKey);
      uniqueItems.push(item);
    }
  }

  return { uniqueItems, duplicateItems };
}

/**
 * Independently validates whether an employee is eligible for official Relieving Letter issuance
 * and email dispatch. Unapproved cases are strictly blocked from official issuance/sending.
 */
export function evaluateRelievingRecipientReadiness(
  recipient: EmailCenterRecipientItem,
  defaultMode: RecipientEmailMode,
  overrideMode?: RecipientEmailMode,
): RelievingRecipientValidation {
  const emailResolution = resolveRecipientEmailSelection(recipient, defaultMode, overrideMode, {
    isRelievingWorkflow: true,
  });

  const reasons: string[] = [];
  const rc = recipient.relievingCase;

  if (!recipient.fullName.trim()) {
    reasons.push("Missing employee full name");
  }

  if (!rc) {
    return {
      recordId: recipient.recordId,
      status: "approval_pending",
      statusLabel: "Approval Pending",
      reasons: ["No relieving case exists yet — HR approval is required before official issuance."],
      canPreviewDraft: true,
      canOfficialIssue: false,
      canSendOfficial: false,
      emailResolution,
    };
  }

  const caseStatus = rc.status.toLowerCase();
  if (caseStatus === "rejected" || caseStatus === "cancelled") {
    return {
      recordId: recipient.recordId,
      status: "blocked",
      statusLabel: "Blocked",
      reasons: [`Relieving case status is "${rc.status}".`],
      canPreviewDraft: false,
      canOfficialIssue: false,
      canSendOfficial: false,
      emailResolution,
    };
  }

  if (caseStatus !== "approved" && caseStatus !== "relieved") {
    return {
      recordId: recipient.recordId,
      status: "approval_pending",
      statusLabel: "Approval Pending",
      reasons: [
        `Relieving case is currently "${rc.status}". Only formally approved or relieved cases can be issued officially.`,
      ],
      canPreviewDraft: true,
      canOfficialIssue: false,
      canSendOfficial: false,
      emailResolution,
    };
  }

  // Required verified fields for approved letters
  if (!(rc.joiningDate || recipient.joiningDate)) {
    reasons.push("Missing verified joining date");
  }
  if (!(rc.lastWorkingDay || recipient.lastWorkingDate)) {
    reasons.push("Missing confirmed last working day");
  }
  if (!(rc.relievingEffectiveDate || rc.lastWorkingDay || recipient.relievingEffectiveDate)) {
    reasons.push("Missing approved relieving effective date");
  }
  if (!(rc.legalEmployer || recipient.legalEmployer)) {
    reasons.push("Missing confirmed legal employer");
  }
  if (!(rc.signatoryName && rc.signatoryName.trim())) {
    reasons.push("Missing authorized signatory");
  }
  if (!(rc.designation || recipient.designation)) {
    reasons.push("Missing verified designation");
  }
  if (!rc.checklistHandover || !rc.projectClearance || !rc.assetClearance) {
    reasons.push("Exit clearance / handover checklist is incomplete");
  }

  if (reasons.length > 0) {
    return {
      recordId: recipient.recordId,
      status: "missing_details",
      statusLabel: "Missing Details",
      reasons,
      canPreviewDraft: true,
      canOfficialIssue: false,
      canSendOfficial: false,
      emailResolution,
    };
  }

  if (emailResolution.status !== "ready") {
    reasons.push(emailResolution.statusLabel);
    return {
      recordId: recipient.recordId,
      status: "missing_details",
      statusLabel: "Missing Details",
      reasons,
      canPreviewDraft: true,
      canOfficialIssue: true,
      canSendOfficial: false,
      emailResolution,
    };
  }

  if (
    rc.emailStatus === "accepted_by_smtp" ||
    rc.emailStatus === "delivered"
  ) {
    return {
      recordId: recipient.recordId,
      status: "already_sent",
      statusLabel: "Already Sent",
      reasons: [
        `Official letter already dispatched (${rc.emailStatus})${rc.emailSentAt ? ` on ${rc.emailSentAt.slice(0, 10)}` : ""}.`,
      ],
      canPreviewDraft: true,
      canOfficialIssue: true,
      canSendOfficial: false,
      emailResolution,
    };
  }

  if (rc.letterPdfPath) {
    return {
      recordId: recipient.recordId,
      status: "already_issued",
      statusLabel: "Already Issued",
      reasons: ["Official PDF already generated and archived; ready for verified dispatch."],
      canPreviewDraft: true,
      canOfficialIssue: true,
      canSendOfficial: true,
      emailResolution,
    };
  }

  return {
    recordId: recipient.recordId,
    status: "ready",
    statusLabel: "Ready",
    reasons: [],
    canPreviewDraft: true,
    canOfficialIssue: true,
    canSendOfficial: true,
    emailResolution,
  };
}

/**
 * Evaluates whether a recipient can receive a given custom email template cleanly
 * without inventing missing placeholders or using missing emails.
 */
export function evaluateCustomTemplateRecipientReadiness(input: {
  template: CustomEmailTemplateRecord;
  recipient: EmailCenterRecipientItem;
  defaultEmailMode: RecipientEmailMode;
  overrideMode?: RecipientEmailMode | undefined;
  attachmentPlaceholders?: string[] | undefined;
}): {
  emailResolution: RecipientEmailResolution;
  missingPlaceholders: string[];
  ready: boolean;
  reason: string | null;
} {
  const emailResolution = resolveRecipientEmailSelection(
    input.recipient,
    input.defaultEmailMode,
    input.overrideMode,
  );

  const vars = buildRecipientPlaceholderVariables(input.recipient);
  const renderedEmail = renderCustomEmailContent({
    subjectTemplate: input.template.subjectTemplate,
    bodyHtmlTemplate: input.template.bodyHtmlTemplate,
    bodyTextTemplate: input.template.bodyTextTemplate,
    variables: vars,
  });

  const allMissing = new Set<string>(renderedEmail.missingPlaceholders);

  // If attachment is DOCX or fillable PDF, check required placeholders in the document too
  if (
    input.template.attachmentFormat === "docx" ||
    (input.template.attachmentFormat === "pdf" && input.template.pdfMode === "fillable")
  ) {
    const docPlaceholders =
      input.attachmentPlaceholders ?? input.template.detectedPlaceholders ?? [];
    for (const key of docPlaceholders) {
      const val = String(vars[key] ?? "").trim();
      if (!val) {
        allMissing.add(key);
      }
    }
  }

  const missingPlaceholders = [...allMissing];

  if (emailResolution.status !== "ready") {
    return {
      emailResolution,
      missingPlaceholders,
      ready: false,
      reason: emailResolution.statusLabel,
    };
  }

  if (missingPlaceholders.length > 0) {
    return {
      emailResolution,
      missingPlaceholders,
      ready: false,
      reason: `Missing placeholder values: ${missingPlaceholders.map((p) => `{{${p}}}`).join(", ")}`,
    };
  }

  return {
    emailResolution,
    missingPlaceholders: [],
    ready: true,
    reason: null,
  };
}

/**
 * Builds an authorized ZIP bundle containing separate individualized PDFs.
 */
export function buildApprovedLettersZip(
  files: { fileName: string; pdfBytes: Uint8Array }[],
): Uint8Array {
  const usedNames = new Set<string>();
  const zipInput: Record<string, Uint8Array> = {};

  for (const file of files) {
    const cleaned = sanitizeStorageFileName(file.fileName).replace(/\.[^.]+$/, "");
    let finalName = `${cleaned || "Experience_Letter"}.pdf`;
    let counter = 2;
    while (usedNames.has(finalName.toLowerCase())) {
      finalName = `${cleaned}_${counter}.pdf`;
      counter++;
    }
    usedNames.add(finalName.toLowerCase());
    zipInput[finalName] = file.pdfBytes;
  }

  return zipSync(zipInput, { level: 6 });
}
