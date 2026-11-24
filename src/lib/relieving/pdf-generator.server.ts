// Server-only PDF Generator for Official Relieving & Experience Letters
// Uses pdf-lib to construct high-fidelity A4 corporate documents matching the authoritative template.

import fs from "node:fs";
import path from "node:path";
import { PDFDocument, rgb, StandardFonts, degrees } from "pdf-lib";
import { formatLetterDate, type RelievingLetterData } from "./types";

export { formatLetterDate };

/**
 * Formatted span for rich mixed bold/regular paragraph rendering.
 */
type FormattedSpan = { text: string; bold: boolean };

/**
 * Renders a paragraph containing both regular and bold spans with automatic word wrapping.
 */
function drawParagraphWithSpans(
  page: any,
  spans: FormattedSpan[],
  startX: number,
  startY: number,
  regularFont: any,
  boldFont: any,
  fontSize: number,
  maxWidth: number,
  lineHeight: number,
  textColor: any
): number {
  type WordToken = { text: string; bold: boolean; width: number; isSpace: boolean };
  const tokens: WordToken[] = [];

  for (const span of spans) {
    const font = span.bold ? boldFont : regularFont;
    const parts = span.text.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      const isSpace = /^\s+$/.test(part);
      tokens.push({
        text: part,
        bold: span.bold,
        width: font.widthOfTextAtSize(part, fontSize),
        isSpace,
      });
    }
  }

  let currentY = startY;
  let currentLine: WordToken[] = [];
  let currentLineWidth = 0;

  for (const token of tokens) {
    if (currentLine.length === 0 && token.isSpace) {
      continue;
    }

    if (currentLineWidth + token.width <= maxWidth || currentLine.length === 0) {
      currentLine.push(token);
      currentLineWidth += token.width;
    } else {
      let lineX = startX;
      for (const t of currentLine) {
        const font = t.bold ? boldFont : regularFont;
        page.drawText(t.text, {
          x: lineX,
          y: currentY,
          size: fontSize,
          font,
          color: textColor,
        });
        lineX += t.width;
      }
      currentY -= lineHeight;

      if (token.isSpace) {
        currentLine = [];
        currentLineWidth = 0;
      } else {
        currentLine = [token];
        currentLineWidth = token.width;
      }
    }
  }

  if (currentLine.length > 0) {
    let lineX = startX;
    for (const t of currentLine) {
      const font = t.bold ? boldFont : regularFont;
      page.drawText(t.text, {
        x: lineX,
        y: currentY,
        size: fontSize,
        font,
        color: textColor,
      });
      lineX += t.width;
    }
    currentY -= lineHeight;
  }

  return currentY;
}

/**
 * Generates an official Relieving & Experience Letter PDF buffer.
 */
export async function generateRelievingLetterPdf(data: RelievingLetterData): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();

  // A4 dimensions: 595.28 x 841.89 points
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const page = pdfDoc.addPage([pageWidth, pageHeight]);

  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const leftMargin = 48;
  const rightMargin = 48;
  const contentWidth = pageWidth - leftMargin - rightMargin;

  // 1. Embed and draw Header Banner at the very top (edge-to-edge)
  const headerPath = path.resolve(process.cwd(), "public", "branding", "relieving", "header-banner.png");
  if (fs.existsSync(headerPath)) {
    const headerBytes = fs.readFileSync(headerPath);
    const headerImage = await pdfDoc.embedPng(headerBytes);
    // Aspect ratio: 1024 x 306
    const headerHeight = (306 / 1024) * pageWidth; // ~177.89 pt
    page.drawImage(headerImage, {
      x: 0,
      y: pageHeight - headerHeight,
      width: pageWidth,
      height: headerHeight,
    });
  }

  // 2. Embed and draw Footer Banner at the very bottom (edge-to-edge)
  const footerPath = path.resolve(process.cwd(), "public", "branding", "relieving", "footer-banner.png");
  if (fs.existsSync(footerPath)) {
    const footerBytes = fs.readFileSync(footerPath);
    const footerImage = await pdfDoc.embedPng(footerBytes);
    // Aspect ratio: 1024 x 119
    const footerHeight = (119 / 1024) * pageWidth; // ~69.19 pt
    page.drawImage(footerImage, {
      x: 0,
      y: 0,
      width: pageWidth,
      height: footerHeight,
    });
  }

  // 3. Document Content Layout
  // Content starts below the header banner
  let currentY = pageHeight - 195; // ~646 pt

  const textColor = rgb(0.12, 0.12, 0.12);
  const bodyFontSize = 10;
  const lineHeight = 15;
  const paragraphGap = 12;

  // Private & Confidential
  page.drawText("Private & Confidential", {
    x: leftMargin,
    y: currentY,
    size: bodyFontSize,
    font: boldFont,
    color: textColor,
  });
  currentY -= lineHeight + 4;

  // Date
  const formattedIssueDate = formatLetterDate(data.letterIssueDate);
  page.drawText(`Date: ${formattedIssueDate}`, {
    x: leftMargin,
    y: currentY,
    size: bodyFontSize,
    font: boldFont,
    color: textColor,
  });
  currentY -= lineHeight + 6;

  // Subject: Experience Letter. (underlined)
  const subjectText = "Subject: Experience Letter.";
  page.drawText(subjectText, {
    x: leftMargin,
    y: currentY,
    size: bodyFontSize,
    font: boldFont,
    color: textColor,
  });
  const subjectWidth = boldFont.widthOfTextAtSize(subjectText, bodyFontSize);
  page.drawLine({
    start: { x: leftMargin, y: currentY - 2 },
    end: { x: leftMargin + subjectWidth, y: currentY - 2 },
    thickness: 0.8,
    color: textColor,
  });
  currentY -= lineHeight + 6;

  // Dear [Employee Name],
  page.drawText(`Dear ${data.employeeName},`, {
    x: leftMargin,
    y: currentY,
    size: bodyFontSize,
    font: boldFont,
    color: textColor,
  });
  currentY -= lineHeight + paragraphGap;

  // Paragraph 1: Certification (with bold legal entity, designation, and dates matching Word template)
  const startDate = formatLetterDate(data.joiningDate);
  const endDate = formatLetterDate(data.lastWorkingDay);
  currentY = drawParagraphWithSpans(
    page,
    [
      { text: "This is to certify that you were associated with ", bold: false },
      { text: `${data.legalEmployer} `, bold: true },
      { text: "as an ", bold: false },
      { text: `${data.designation} `, bold: true },
      { text: "from ", bold: false },
      { text: `${startDate} to ${endDate}`, bold: true },
    ],
    leftMargin,
    currentY,
    regularFont,
    boldFont,
    bodyFontSize,
    contentWidth,
    lineHeight,
    textColor
  );
  currentY -= paragraphGap;

  // Paragraph 2: Conduct & Contributions
  currentY = drawParagraphWithSpans(
    page,
    [
      {
        text: `During your tenure, you contributed to various ${data.contributedProjects} and related projects. Your conduct and performance during this period were found to be ${data.performanceStatement}.`,
        bold: false,
      },
    ],
    leftMargin,
    currentY,
    regularFont,
    boldFont,
    bodyFontSize,
    contentWidth,
    lineHeight,
    textColor
  );
  currentY -= paragraphGap;

  // Paragraph 3: Handover & Relieving (with bold effective date matching Word template)
  const relievingDate = formatLetterDate(data.relievingEffectiveDate);
  currentY = drawParagraphWithSpans(
    page,
    [
      {
        text: "As you have completed your tenure with us and duly handed over all assigned responsibilities, we hereby relieve you from your duties effective close of business on ",
        bold: false,
      },
      { text: relievingDate, bold: true },
    ],
    leftMargin,
    currentY,
    regularFont,
    boldFont,
    bodyFontSize,
    contentWidth,
    lineHeight,
    textColor
  );
  currentY -= paragraphGap;

  // Paragraph 4: Well wishes
  currentY = drawParagraphWithSpans(
    page,
    [
      {
        text: "We wish you continued success in your future academic and professional endeavors.",
        bold: false,
      },
    ],
    leftMargin,
    currentY,
    regularFont,
    boldFont,
    bodyFontSize,
    contentWidth,
    lineHeight,
    textColor
  );

  // 4. Dedicated Signatory Block Layout
  // Anchored cleanly in the lower portion of the page, with guaranteed separation from paragraph 4
  // and dedicated non-overlapping space for company name, signature/stamp, and signatory details.
  const gapAfterParagraph = 24;
  const preferredSignoffY = 320; // Anchors signoff neatly above the footer (footer is at 0-69pt)
  const signoffY = Math.min(currentY - gapAfterParagraph, preferredSignoffY);

  // "Yours truly,"
  page.drawText("Yours truly,", {
    x: leftMargin,
    y: signoffY,
    size: bodyFontSize,
    font: regularFont,
    color: textColor,
  });

  // Company Name (e.g. Learning Path's Technologies LLP)
  const companyNameY = signoffY - 18;
  page.drawText(data.legalEmployer, {
    x: leftMargin,
    y: companyNameY,
    size: bodyFontSize,
    font: boldFont,
    color: textColor,
  });

  // Stamp and Signature Image (Private server asset)
  // Dedicated footprint: no text above, below, or behind it.
  const stampPath = path.resolve(
    process.cwd(),
    "src",
    "server",
    "assets",
    "relieving",
    "official-signature-stamp.png"
  );

  const stampTopMargin = 14;
  const stampTopY = companyNameY - stampTopMargin;
  // Aspect ratio: 192 w x 219 h
  const stampWidth = 84;
  const stampHeight = (219 / 192) * stampWidth; // ~95.8 pt
  const stampBottomY = stampTopY - stampHeight;

  if (fs.existsSync(stampPath)) {
    const stampBytes = fs.readFileSync(stampPath);
    const stampImage = await pdfDoc.embedPng(stampBytes);
    // Draw image cleanly in its dedicated container box: [leftMargin, stampBottomY] to [leftMargin + stampWidth, stampTopY]
    page.drawImage(stampImage, {
      x: leftMargin,
      y: stampBottomY,
      width: stampWidth,
      height: stampHeight,
    });
  }

  // Signatory Name (e.g. K. Spandana HR -)
  // Placed with clean spacing strictly below the signature/stamp area
  const signatoryNameY = stampBottomY - 14;
  page.drawText(`${data.signatoryName} HR -`, {
    x: leftMargin,
    y: signatoryNameY,
    size: bodyFontSize,
    font: boldFont,
    color: textColor,
  });

  // Designation (e.g. Director)
  const designationY = signatoryNameY - 14;
  page.drawText(data.signatoryDesignation || data.signatoryTitle, {
    x: leftMargin,
    y: designationY,
    size: bodyFontSize,
    font: regularFont,
    color: textColor,
  });

  // 5. If DRAFT mode, draw prominent diagonal watermark
  if (data.isDraft) {
    const watermarkText = "DRAFT — FOR REVIEW ONLY";
    const watermarkSize = 34;
    page.drawText(watermarkText, {
      x: 100,
      y: 350,
      size: watermarkSize,
      font: boldFont,
      color: rgb(0.85, 0.15, 0.15),
      opacity: 0.25,
      rotate: degrees(45),
    });
  }

  return await pdfDoc.save();
}
