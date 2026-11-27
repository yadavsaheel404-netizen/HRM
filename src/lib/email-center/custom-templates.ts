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
  type CustomDocumentMode,
  type CustomEmailTemplateRecord,
  type CustomRecipientValidationStatus,
  type DocxFieldMappingRule,
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

function sanitizeAttachmentLabelPart(value: string, fallback: string): string {
  const noTraversal = value.replace(/\.\./g, " ").replace(/[\\/]/g, " ");
  const cleaned = noTraversal
    .replace(/[\x00-\x1f<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  return cleaned || fallback;
}

/**
 * Generates clean personalized attachment filenames matching:
 * `Employee Full Name - Template Display Name.docx` (or `.pdf`)
 * Falls back to sanitized static filename only when `documentMode === "static"`.
 */
export function buildPersonalizedAttachmentFilename(input: {
  employeeFullName: string;
  templateDisplayName: string;
  format: "docx" | "pdf";
  documentMode?: CustomDocumentMode | undefined;
  staticOriginalFilename?: string | null | undefined;
}): string {
  const ext = input.format === "pdf" ? "pdf" : "docx";
  if (input.documentMode === "static" && input.staticOriginalFilename) {
    const baseRaw = input.staticOriginalFilename.split(/[\\/]/).pop() ?? "";
    const noExt = baseRaw.replace(/\.[^.]+$/, "");
    const safeStatic = sanitizeAttachmentLabelPart(noExt, "Attachment");
    return `${safeStatic}.${ext}`;
  }

  const empPart = sanitizeAttachmentLabelPart(input.employeeFullName, "Employee");
  const rawTplNoExt = input.templateDisplayName.replace(/\.(docx|pdf)$/i, "");
  const tplPart = sanitizeAttachmentLabelPart(rawTplNoExt, "HR Document");
  return `${empPart} - ${tplPart}.${ext}`;
}

export function isRelievingStyleCustomTemplate(input: {
  templateName?: string | null | undefined;
  attachmentFilename?: string | null | undefined;
  purposeCategory?: string | null | undefined;
  previewText?: string | null | undefined;
  requiresRelievingApproval?: boolean | undefined;
}): boolean {
  if (input.requiresRelievingApproval) return true;
  const hay = [
    input.templateName ?? "",
    input.attachmentFilename ?? "",
    input.purposeCategory ?? "",
    input.previewText ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return /reliev|experience\s+letter|effective\s+close\s+of\s+business/.test(hay);
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

interface TextSplice {
  start: number;
  end: number;
  replacement: string;
}

function computeParagraphMappingSplices(
  concatText: string,
  paragraphIndex: number,
  rules: DocxFieldMappingRule[],
): TextSplice[] {
  const splices: TextSplice[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.paragraphIndex !== paragraphIndex) continue;
    if (
      rule.anchorSnippet &&
      !concatText.toLowerCase().includes(rule.anchorSnippet.toLowerCase())
    ) {
      continue;
    }

    const token = `{{${rule.placeholder}}}`;
    if (concatText.includes(token)) continue;

    if (rule.strategy === "date_line") {
      const m = /^(Date\s*:)([\s_.\-\[\]]*)$/i.exec(concatText.trimEnd());
      if (m) {
        const labelEnd = m[1]!.length;
        splices.push({ start: labelEnd, end: concatText.length, replacement: ` ${token}` });
      }
    } else if (rule.strategy === "dear_line") {
      const m = /^(Dear\b)([\s_.\-\[\],]*)$/i.exec(concatText);
      if (m) {
        const dearEnd = m[1]!.length;
        const hasComma = (m[2] ?? "").includes(",");
        splices.push({
          start: dearEnd,
          end: concatText.length,
          replacement: hasComma ? ` ${token},` : ` ${token},`,
        });
      }
    } else if (rule.strategy === "legal_employer_in_cert") {
      const m = /(\bassociated\s+with\s+)([A-Za-z0-9 &.,'()_.\-\[\]]+?)(\s+\bas\b)/i.exec(
        concatText,
      );
      if (m && m.index !== undefined) {
        const slotStart = m.index + m[1]!.length;
        const slotEnd = slotStart + m[2]!.length;
        splices.push({ start: slotStart, end: slotEnd, replacement: token });
      }
    } else if (rule.strategy === "designation_in_cert") {
      const m = /(\bas\s+an?\s+)(.*?)(\s+\bfrom\b)/i.exec(concatText);
      if (m && m.index !== undefined) {
        const slotStart = m.index + m[1]!.length;
        const slotEnd = slotStart + m[2]!.length;
        splices.push({ start: slotStart, end: slotEnd, replacement: token });
      }
    } else if (rule.strategy === "joining_date_in_cert") {
      const m = /(\bfrom\s)([_.\-\[\]\sA-Za-z0-9/]*?)(\s*\bto\b)/i.exec(concatText);
      if (m && m.index !== undefined) {
        const slotStart = m.index + m[1]!.length;
        const slotEnd = slotStart + m[2]!.length;
        const rep = m[3]!.startsWith(" ") ? token : `${token} `;
        splices.push({ start: slotStart, end: slotEnd, replacement: rep });
      }
    } else if (rule.strategy === "last_working_date_in_cert") {
      const m = /(\bfrom\b[^\n]*?\bto\s)([_.\-\[\]\sA-Za-z0-9/]*?)([.,]?)\s*$/i.exec(
        concatText,
      );
      if (m && m.index !== undefined) {
        const slotStart = m.index + m[1]!.length;
        const trailingPunct = m[3] ?? "";
        const slotEnd = concatText.length - trailingPunct.length;
        splices.push({ start: slotStart, end: Math.max(slotStart, slotEnd), replacement: token });
      }
    } else if (rule.strategy === "relieving_effective_line") {
      const m = /(effective\s+close\s+of\s+business\s+on\b)([\s_.\-\[\]A-Za-z0-9/]*?)([.,]?)\s*$/i.exec(
        concatText,
      );
      if (m && m.index !== undefined) {
        const slotStart = m.index + m[1]!.length;
        const slotEnd = slotStart + m[2]!.length;
        const trailingPunct = m[3] ?? ".";
        splices.push({
          start: slotStart,
          end: concatText.length,
          replacement: ` ${token}${trailingPunct || "."}`,
        });
      }
    }
  }

  // Sort non-overlapping splices from left to right and drop overlaps cleanly
  splices.sort((a, b) => a.start - b.start || a.end - b.end);
  const clean: TextSplice[] = [];
  let lastEnd = -1;
  for (const s of splices) {
    if (s.start >= lastEnd) {
      clean.push(s);
      lastEnd = s.end;
    }
  }
  return clean;
}

/**
 * Extracts coalesced paragraph text and applies optional field-mapping + placeholder replacements
 * inside a WordprocessingML XML file while preserving split `<w:t>` runs and `<w:rPr>` formatting.
 */
function transformWordXmlParagraphs(
  xmlText: string,
  variables?: Record<string, string>,
  fieldMappings?: DocxFieldMappingRule[],
): {
  updatedXml: string;
  paragraphs: string[];
  detectedPlaceholders: string[];
  replacedPlaceholders: string[];
  missingPlaceholders: string[];
  unresolvedPlaceholders: string[];
} {
  const paragraphs: string[] = [];
  const detectedSet = new Set<string>();
  const replacedSet = new Set<string>();
  const missingSet = new Set<string>();
  const unresolvedSet = new Set<string>();

  const pRegex = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  let paragraphIndex = -1;

  const updatedXml = xmlText.replace(pRegex, (pBlock) => {
    paragraphIndex++;
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

    if (spans.length === 0) {
      return pBlock;
    }

    // Apply controlled field mappings ONLY on matching paragraphIndex slots
    let updatedTexts = spans.map((s) => s.decoded);
    const activeMappings = (fieldMappings ?? []).filter((r) => r.enabled);
    const mappingSplices =
      activeMappings.length > 0
        ? computeParagraphMappingSplices(concatText, paragraphIndex, activeMappings)
        : [];

    if (mappingSplices.length > 0) {
      for (let mi = mappingSplices.length - 1; mi >= 0; mi--) {
        const splice = mappingSplices[mi]!;
        if (splice.start === splice.end && splice.start >= concatText.length) {
          const lastIdx = spans.length - 1;
          updatedTexts[lastIdx] = `${updatedTexts[lastIdx] ?? ""}${splice.replacement}`;
          continue;
        }

        let inserted = false;
        for (let si = 0; si < spans.length; si++) {
          const span = spans[si]!;
          const overlapsRange =
            splice.start < splice.end
              ? span.concatEnd > splice.start && span.concatStart < splice.end
              : splice.start >= span.concatStart && splice.start <= span.concatEnd;
          if (!overlapsRange) continue;

          const localStart = Math.max(0, splice.start - span.concatStart);
          const localEnd = Math.min(updatedTexts[si]!.length, splice.end - span.concatStart);
          const cur = updatedTexts[si]!;
          const prefix = cur.slice(0, localStart);
          const suffix = cur.slice(localEnd);
          if (!inserted) {
            updatedTexts[si] = `${prefix}${splice.replacement}${suffix}`;
            inserted = true;
          } else {
            updatedTexts[si] = `${prefix}${suffix}`;
          }
        }
      }
    }

    // Recompute span offsets after mapping splice so {{...}} resolution sees mapped tokens accurately
    let mappedConcatText = "";
    const mappedSpans: WtSpan[] = [];
    for (let si = 0; si < spans.length; si++) {
      const span = spans[si]!;
      const txt = updatedTexts[si] ?? "";
      const concatStart = mappedConcatText.length;
      mappedConcatText += txt;
      const concatEnd = mappedConcatText.length;
      mappedSpans.push({
        ...span,
        decoded: txt,
        concatStart,
        concatEnd,
      });
    }

    // Detect & resolve all {{placeholders}} in coalesced paragraph text (handles split Word runs!)
    const matches: {
      start: number;
      end: number;
      key: string;
      replacement: string | null;
    }[] = [];

    let pm: RegExpExecArray | null;
    const localRe = new RegExp(PLACEHOLDER_RE.source, "g");
    while ((pm = localRe.exec(mappedConcatText)) !== null) {
      const key = pm[1] ?? "";
      detectedSet.add(key);

      if (variables) {
        const val = String(variables[key] ?? "").trim();
        if (!val) {
          missingSet.add(key);
          unresolvedSet.add(key);
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

    if (variables && matches.length > 0) {
      updatedTexts = mappedSpans.map((s) => s.decoded);
      for (let mi = matches.length - 1; mi >= 0; mi--) {
        const match = matches[mi]!;
        const replacement = match.replacement;
        if (replacement === null) continue;

        let inserted = false;
        for (let si = 0; si < mappedSpans.length; si++) {
          const span = mappedSpans[si]!;
          if (span.concatEnd <= match.start || span.concatStart >= match.end) {
            continue;
          }
          const localStart = Math.max(0, match.start - span.concatStart);
          const localEnd = Math.min(updatedTexts[si]!.length, match.end - span.concatStart);
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
    }

    const finalConcat = updatedTexts.join("").trim();
    if (finalConcat) {
      paragraphs.push(finalConcat);
    }

    // Check final paragraph for any remaining {{...}} tokens
    if (variables) {
      const verifyRe = new RegExp(PLACEHOLDER_RE.source, "g");
      let vm: RegExpExecArray | null;
      while ((vm = verifyRe.exec(updatedTexts.join(""))) !== null) {
        if (vm[1]) unresolvedSet.add(vm[1]);
      }
    }

    if (mappingSplices.length === 0 && (!variables || matches.length === 0)) {
      return pBlock;
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
    unresolvedPlaceholders: [...unresolvedSet],
  };
}

function readRawWordParagraphs(xmlText: string): string[] {
  const list: string[] = [];
  const pRegex = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  let pm: RegExpExecArray | null;
  while ((pm = pRegex.exec(xmlText)) !== null) {
    const wtRegex = /<w:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let concat = "";
    let wm: RegExpExecArray | null;
    while ((wm = wtRegex.exec(pm[0])) !== null) {
      concat += decodeXmlEntities(wm[1] ?? "");
    }
    list.push(concat);
  }
  return list;
}

export interface BlankFieldDetectionResult {
  suggestedMappings: DocxFieldMappingRule[];
  hasUnmappedBlanks: boolean;
  isLikelyRelievingTemplate: boolean;
  blankLabels: string[];
}

/**
 * Inspects word/document.xml paragraph-by-paragraph to identify known blank slots
 * (such as "Date:", "Dear", "from  to", "effective close of business on")
 * WITHOUT touching unrelated occurrences of "Date" or "Dear" elsewhere.
 */
export function detectUnmappedBlankFieldsInDocx(bytes: Uint8Array): BlankFieldDetectionResult {
  const entries = unzipSync(bytes);
  const docEntry = entries["word/document.xml"];
  if (!docEntry) {
    return {
      suggestedMappings: [],
      hasUnmappedBlanks: false,
      isLikelyRelievingTemplate: false,
      blankLabels: [],
    };
  }

  const rawParagraphs = readRawWordParagraphs(strFromU8(docEntry));
  const fullTextLower = rawParagraphs.join("\n").toLowerCase();
  const isLikelyRelievingTemplate =
    fullTextLower.includes("experience letter") ||
    fullTextLower.includes("effective close of business on") ||
    fullTextLower.includes("hereby relieve you");

  const suggestedMappings: DocxFieldMappingRule[] = [];
  const blankLabels: string[] = [];

  for (let idx = 0; idx < rawParagraphs.length; idx++) {
    const raw = rawParagraphs[idx] ?? "";
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (/^Date\s*:\s*[_.\-\[\]]*$/i.test(trimmed) && !trimmed.includes("{{issue_date}}")) {
      suggestedMappings.push({
        id: `map-issue_date-${idx}`,
        placeholder: "issue_date",
        label: "Issue Date (Date: line)",
        paragraphIndex: idx,
        anchorSnippet: "Date:",
        strategy: "date_line",
        enabled: true,
      });
      blankLabels.push('Blank "Date:" field');
    }

    if (/^Dear\b[\s_.\-\[\],]*$/i.test(trimmed) && !trimmed.includes("{{employee_name}}")) {
      suggestedMappings.push({
        id: `map-employee_name-${idx}`,
        placeholder: "employee_name",
        label: "Employee Name (Dear ...)",
        paragraphIndex: idx,
        anchorSnippet: "Dear",
        strategy: "dear_line",
        enabled: true,
      });
      blankLabels.push('Blank "Dear" salutation');
    }

    if (/associated\s+with/i.test(trimmed) && /\bas\s+an?\b/i.test(trimmed)) {
      const hasBlankEmployer = /\bassociated\s+with\s+[_.\-\[\]]*\s*\bas\b/i.test(trimmed);
      if (!trimmed.includes("{{legal_employer}}")) {
        suggestedMappings.push({
          id: `map-legal_employer-${idx}`,
          placeholder: "legal_employer",
          label: "Legal Employer (certifying sentence)",
          paragraphIndex: idx,
          anchorSnippet: "associated with",
          strategy: "legal_employer_in_cert",
          enabled: hasBlankEmployer,
        });
        if (hasBlankEmployer) blankLabels.push("Blank Legal Employer");
      }

      const roleMatch = /\bas\s+an?\s+([^]*?)\s+\bfrom\b/i.exec(trimmed);
      const roleVal = roleMatch?.[1]?.trim() ?? "";
      const roleIsBlankOrDefault =
        !trimmed.includes("{{designation}}") &&
        (roleVal === "" ||
          /^[_.\-\[\]]+$/.test(roleVal) ||
          /AI Data Annotation Analyst|Designation|Role/i.test(roleVal));
      if (!trimmed.includes("{{designation}}")) {
        suggestedMappings.push({
          id: `map-designation-${idx}`,
          placeholder: "designation",
          label: "Designation (as a/an ... from)",
          paragraphIndex: idx,
          anchorSnippet: "associated with",
          strategy: "designation_in_cert",
          enabled: roleIsBlankOrDefault,
        });
        if (!roleVal || /^[_.\-\[\]]+$/.test(roleVal)) {
          blankLabels.push('Blank Designation ("as a/an ... from")');
        }
      }

      const fromToMatch = /\bfrom\b\s*([_.\-\[\]\s]*)\s*\bto\b\s*([_.\-\[\]\s]*)[.,]?$/i.exec(
        trimmed,
      );
      if (!trimmed.includes("{{joining_date}}") && fromToMatch) {
        suggestedMappings.push({
          id: `map-joining_date-${idx}`,
          placeholder: "joining_date",
          label: "Joining Date (from ...)",
          paragraphIndex: idx,
          anchorSnippet: "associated with",
          strategy: "joining_date_in_cert",
          enabled: true,
        });
        blankLabels.push('Blank "from" Joining Date');
      }

      if (!trimmed.includes("{{last_working_date}}") && fromToMatch) {
        suggestedMappings.push({
          id: `map-last_working_date-${idx}`,
          placeholder: "last_working_date",
          label: "Last Working Date (... to ...)",
          paragraphIndex: idx,
          anchorSnippet: "associated with",
          strategy: "last_working_date_in_cert",
          enabled: true,
        });
        blankLabels.push('Blank "to" Last Working Date');
      }
    }

    if (
      /effective\s+close\s+of\s+business\s+on\b[\s_.\-\[\]]*[.,]?$/i.test(trimmed) &&
      !trimmed.includes("{{relieving_date}}")
    ) {
      suggestedMappings.push({
        id: `map-relieving_date-${idx}`,
        placeholder: "relieving_date",
        label: "Relieving Date (effective close of business on ...)",
        paragraphIndex: idx,
        anchorSnippet: "effective close of business on",
        strategy: "relieving_effective_line",
        enabled: true,
      });
      blankLabels.push('Blank "effective close of business on" Relieving Date');
    }
  }

  return {
    suggestedMappings,
    hasUnmappedBlanks: blankLabels.length > 0,
    isLikelyRelievingTemplate,
    blankLabels,
  };
}

export function detectRemainingBlankFieldsInParagraphs(paragraphs: string[]): string[] {
  const remaining: string[] = [];
  for (const raw of paragraphs) {
    const t = raw.trim();
    if (!t) continue;
    if (/^Date\s*:\s*[_.\-\[\]]*$/i.test(t)) remaining.push("Date:");
    if (/^Dear\b[\s_.\-\[\],]*$/i.test(t)) remaining.push("Dear");
    if (/\bfrom\b\s*[_.\-\[\]]*\s*\bto\b\s*[_.\-\[\]]*[.,]?$/i.test(t)) {
      remaining.push("from ... to ...");
    }
    if (/effective\s+close\s+of\s+business\s+on\b[\s_.\-\[\]]*[.,]?$/i.test(t)) {
      remaining.push("effective close of business on");
    }
  }
  return remaining;
}

export interface DocxInspectionResult {
  detectedPlaceholders: string[];
  supportedPlaceholders: string[];
  unsupportedPlaceholders: string[];
  previewParagraphs: string[];
  hasHeaderOrFooter: boolean;
  hasImages: boolean;
  hasTables: boolean;
  blankDetection: BlankFieldDetectionResult;
}

export function extractDocxPlaceholders(
  bytes: Uint8Array,
  fieldMappings?: DocxFieldMappingRule[],
): DocxInspectionResult {
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
    const activeMappings = name === "word/document.xml" ? fieldMappings : undefined;
    const res = transformWordXmlParagraphs(xml, undefined, activeMappings);
    for (const ph of res.detectedPlaceholders) {
      detectedSet.add(ph);
    }
    if (name === "word/document.xml") {
      previewParagraphs.push(...res.paragraphs);
    }
  }

  for (const rule of fieldMappings ?? []) {
    if (rule.enabled) {
      detectedSet.add(rule.placeholder);
    }
  }

  const blankDetection = detectUnmappedBlankFieldsInDocx(bytes);
  const detectedPlaceholders = [...detectedSet];
  return {
    detectedPlaceholders,
    supportedPlaceholders: detectedPlaceholders.filter((p) => supportedSet.has(p)),
    unsupportedPlaceholders: detectedPlaceholders.filter((p) => !supportedSet.has(p)),
    previewParagraphs,
    hasHeaderOrFooter,
    hasImages,
    hasTables,
    blankDetection,
  };
}

export function personalizeDocxBuffer(
  bytes: Uint8Array,
  variables: Record<string, string>,
  options?: { fieldMappings?: DocxFieldMappingRule[] | undefined },
): {
  buffer: Uint8Array;
  replacedPlaceholders: string[];
  missingPlaceholders: string[];
  unresolvedPlaceholders: string[];
  remainingBlankFields: string[];
  previewParagraphs: string[];
  isVerifiedClean: boolean;
} {
  // Always unzip fresh from immutable byte copy to guarantee zero cross-recipient mutation
  const freshBytes = new Uint8Array(bytes);
  const entries = unzipSync(freshBytes);
  const outEntries: Record<string, Uint8Array> = {};
  const replacedSet = new Set<string>();
  const missingSet = new Set<string>();
  const unresolvedSet = new Set<string>();
  const previewParagraphs: string[] = [];

  for (const [name, content] of Object.entries(entries)) {
    if (/^word\/(document|header\d*|footer\d*)\.xml$/i.test(name)) {
      const xml = strFromU8(content);
      const activeMappings =
        name === "word/document.xml" ? options?.fieldMappings : undefined;
      const res = transformWordXmlParagraphs(xml, variables, activeMappings);
      for (const p of res.replacedPlaceholders) replacedSet.add(p);
      for (const p of res.missingPlaceholders) missingSet.add(p);
      for (const p of res.unresolvedPlaceholders) unresolvedSet.add(p);
      if (name === "word/document.xml") {
        previewParagraphs.push(...res.paragraphs);
      }
      outEntries[name] = strToU8(res.updatedXml);
    } else {
      outEntries[name] = content;
    }
  }

  const finalDocXml = outEntries["word/document.xml"];
  const renderedParagraphs = finalDocXml
    ? readRawWordParagraphs(strFromU8(finalDocXml)).filter((p) => p.trim().length > 0)
    : previewParagraphs;
  const remainingBlankFields = detectRemainingBlankFieldsInParagraphs(renderedParagraphs);

  return {
    buffer: zipSync(outEntries, { level: 6 }),
    replacedPlaceholders: [...replacedSet],
    missingPlaceholders: [...missingSet],
    unresolvedPlaceholders: [...unresolvedSet],
    remainingBlankFields,
    previewParagraphs: renderedParagraphs,
    isVerifiedClean:
      missingSet.size === 0 &&
      unresolvedSet.size === 0 &&
      remainingBlankFields.length === 0,
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
 * Maps verified Employee Records / Workforce / Relieving fields to custom template placeholders.
 * Never invents missing employment dates — leaves missing fields empty so pre-send validation blocks them.
 */
export function buildRecipientPlaceholderVariables(
  recipient: EmailCenterRecipientItem,
  overrides?: {
    companyName?: string | undefined;
    issueDate?: string | undefined;
    isRelievingTemplate?: boolean | undefined;
  },
): Record<string, string> {
  const todayFormatted = formatLetterDate(new Date().toISOString().slice(0, 10));
  const rc = recipient.relievingCase;
  const rawJoining = rc?.joiningDate ?? recipient.joiningDate;
  const rawLastWorking = rc?.lastWorkingDay ?? recipient.lastWorkingDate;
  const rawRelieving =
    rc?.relievingEffectiveDate ??
    recipient.relievingEffectiveDate ??
    rc?.lastWorkingDay ??
    recipient.lastWorkingDate;
  const rawIssue = overrides?.issueDate ?? rc?.letterIssueDate;

  const legalEmployer = String(
    overrides?.companyName ?? rc?.legalEmployer ?? recipient.legalEmployer ?? "",
  ).trim();
  const companyName = legalEmployer || "The AI School";

  return {
    employee_name: recipient.fullName.trim(),
    employee_id: (recipient.employeeCode || recipient.historicalRecordId || "").trim(),
    designation: (rc?.designation || recipient.designation || "").trim(),
    joining_date: rawJoining ? formatLetterDate(rawJoining) : "",
    last_working_date: rawLastWorking ? formatLetterDate(rawLastWorking) : "",
    relieving_date: rawRelieving ? formatLetterDate(rawRelieving) : "",
    work_type: recipient.workType && recipient.workType !== "unknown" ? recipient.workType : "",
    employment_category:
      recipient.employmentCategory && recipient.employmentCategory !== "unknown"
        ? recipient.employmentCategory
        : "",
    legal_employer: legalEmployer,
    company_name: companyName,
    signatory_name: (rc?.signatoryName || "").trim(),
    signatory_title: (rc?.signatoryTitle || "").trim(),
    issue_date: rawIssue
      ? formatLetterDate(rawIssue)
      : overrides?.isRelievingTemplate
        ? ""
        : todayFormatted,
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

const VALIDATION_STATUS_LABELS: Record<CustomRecipientValidationStatus, string> = {
  ready: "Ready",
  missing_information: "Missing Information",
  approval_pending: "Approval Pending",
  invalid_template: "Invalid Template",
  already_sent: "Already Sent",
  blocked: "Blocked",
};

/**
 * Evaluates whether a recipient can receive a custom email template cleanly
 * without inventing missing dates, sending blank DOCX slots, or bypassing relieving approval.
 */
export function evaluateCustomTemplateRecipientReadiness(input: {
  template: CustomEmailTemplateRecord;
  recipient: EmailCenterRecipientItem;
  defaultEmailMode: RecipientEmailMode;
  overrideMode?: RecipientEmailMode | undefined;
  attachmentPlaceholders?: string[] | undefined;
  attachmentHasUnmappedBlanks?: boolean | undefined;
}): {
  validationStatus: CustomRecipientValidationStatus;
  statusLabel: string;
  emailResolution: RecipientEmailResolution;
  missingPlaceholders: string[];
  ready: boolean;
  reason: string | null;
  reasons: string[];
  resolvedVariables: Record<string, string>;
  resolvedFilename: string | null;
  isRelievingTemplate: boolean;
} {
  const isRelievingTemplate = isRelievingStyleCustomTemplate({
    templateName: input.template.name,
    attachmentFilename: input.template.attachmentFilename,
    purposeCategory: input.template.purposeCategory,
    requiresRelievingApproval: input.template.requiresRelievingApproval,
  });

  const emailResolution = resolveRecipientEmailSelection(
    input.recipient,
    input.defaultEmailMode,
    input.overrideMode,
    { isRelievingWorkflow: isRelievingTemplate },
  );

  const vars = buildRecipientPlaceholderVariables(input.recipient, {
    isRelievingTemplate,
  });

  const renderedEmail = renderCustomEmailContent({
    subjectTemplate: input.template.subjectTemplate,
    bodyHtmlTemplate: input.template.bodyHtmlTemplate,
    bodyTextTemplate: input.template.bodyTextTemplate,
    variables: vars,
  });

  const effectiveDocMode: CustomDocumentMode = isRelievingTemplate
    ? "personalized"
    : input.template.documentMode;

  const resolvedFilename =
    input.template.attachmentFormat !== "none"
      ? buildPersonalizedAttachmentFilename({
          employeeFullName: input.recipient.fullName,
          templateDisplayName: input.template.name,
          format: input.template.attachmentFormat,
          documentMode: effectiveDocMode,
          staticOriginalFilename: input.template.attachmentFilename,
        })
      : null;

  const enabledMappings = (input.template.fieldMappings ?? []).filter((m) => m.enabled);
  const allMissing = new Set<string>(renderedEmail.missingPlaceholders);

  if (
    (input.template.attachmentFormat === "docx" && effectiveDocMode === "personalized") ||
    (input.template.attachmentFormat === "pdf" && input.template.pdfMode === "fillable")
  ) {
    const docPlaceholders = new Set<string>([
      ...(input.attachmentPlaceholders ?? input.template.detectedPlaceholders ?? []),
      ...enabledMappings.map((m) => m.placeholder),
    ]);
    for (const key of docPlaceholders) {
      const val = String(vars[key] ?? "").trim();
      if (!val) {
        allMissing.add(key);
      }
    }
  }

  const missingPlaceholders = [...allMissing];
  const reasons: string[] = [];

  if (isRelievingTemplate && input.template.documentMode === "static") {
    reasons.push(
      "Relieving templates require PERSONALIZED DOCUMENT mode and cannot be sent as a static unfilled file.",
    );
    return {
      validationStatus: "invalid_template",
      statusLabel: VALIDATION_STATUS_LABELS["invalid_template"],
      emailResolution,
      missingPlaceholders,
      ready: false,
      reason: reasons[0]!,
      reasons,
      resolvedVariables: vars,
      resolvedFilename,
      isRelievingTemplate,
    };
  }

  if (
    input.template.attachmentFormat === "docx" &&
    effectiveDocMode === "personalized" &&
    input.attachmentHasUnmappedBlanks &&
    enabledMappings.length === 0
  ) {
    reasons.push(
      "Uploaded Word template contains unmapped blank fields. Inspect & enable field mappings before sending.",
    );
    return {
      validationStatus: "invalid_template",
      statusLabel: VALIDATION_STATUS_LABELS["invalid_template"],
      emailResolution,
      missingPlaceholders,
      ready: false,
      reason: reasons[0]!,
      reasons,
      resolvedVariables: vars,
      resolvedFilename,
      isRelievingTemplate,
    };
  }

  if (isRelievingTemplate) {
    const rc = input.recipient.relievingCase;
    const rcStatus = rc?.status.toLowerCase() ?? "";
    if (rcStatus === "rejected" || rcStatus === "cancelled") {
      const msg = `Relieving case status is "${rc?.status}".`;
      return {
        validationStatus: "blocked",
        statusLabel: VALIDATION_STATUS_LABELS["blocked"],
        emailResolution,
        missingPlaceholders,
        ready: false,
        reason: msg,
        reasons: [msg],
        resolvedVariables: vars,
        resolvedFilename,
        isRelievingTemplate,
      };
    }
    if (!rc || (rcStatus !== "approved" && rcStatus !== "relieved")) {
      const msg = rc
        ? `Relieving case is "${rc.status}". Formal HR approval is required before sending official relieving documents.`
        : "No approved relieving case found for this employee.";
      return {
        validationStatus: "approval_pending",
        statusLabel: VALIDATION_STATUS_LABELS["approval_pending"],
        emailResolution,
        missingPlaceholders,
        ready: false,
        reason: msg,
        reasons: [msg],
        resolvedVariables: vars,
        resolvedFilename,
        isRelievingTemplate,
      };
    }
    if (rc.emailStatus === "accepted_by_smtp" || rc.emailStatus === "delivered") {
      const msg = `Relieving letter already sent (${rc.emailStatus}).`;
      return {
        validationStatus: "already_sent",
        statusLabel: VALIDATION_STATUS_LABELS["already_sent"],
        emailResolution,
        missingPlaceholders,
        ready: false,
        reason: msg,
        reasons: [msg],
        resolvedVariables: vars,
        resolvedFilename,
        isRelievingTemplate,
      };
    }
  }

  if (emailResolution.status !== "ready") {
    reasons.push(emailResolution.statusLabel);
  }
  if (missingPlaceholders.length > 0) {
    reasons.push(
      `Missing required fields: ${missingPlaceholders.map((p) => `{{${p}}}`).join(", ")}`,
    );
  }

  if (reasons.length > 0) {
    return {
      validationStatus: "missing_information",
      statusLabel: VALIDATION_STATUS_LABELS["missing_information"],
      emailResolution,
      missingPlaceholders,
      ready: false,
      reason: reasons.join(" • "),
      reasons,
      resolvedVariables: vars,
      resolvedFilename,
      isRelievingTemplate,
    };
  }

  return {
    validationStatus: "ready",
    statusLabel: VALIDATION_STATUS_LABELS["ready"],
    emailResolution,
    missingPlaceholders: [],
    ready: true,
    reason: null,
    reasons: [],
    resolvedVariables: vars,
    resolvedFilename,
    isRelievingTemplate,
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
