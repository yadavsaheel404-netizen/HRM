// Types and schemas for the dedicated Employee Relieving & Experience Letter module

export type RelievingStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "relieved"
  | "rejected"
  | "cancelled";

export type HandoverStatus = "pending" | "in_progress" | "completed" | "waived";

export type RelievingEmailStatus =
  | "not_sent"
  | "queued"
  | "accepted_by_smtp"
  | "failed"
  | "delivered";

export interface RelievingCase {
  id: string;
  userId: string;
  createdBy: string;
  status: RelievingStatus;
  employeeName: string;
  employeeCode: string | null;
  workEmail: string;
  designation: string;
  departmentId: string | null;
  departmentName: string | null;
  employmentCategory: string;
  legalEmployer: string;
  joiningDate: string; // YYYY-MM-DD
  lastWorkingDay: string; // YYYY-MM-DD
  relievingEffectiveDate: string; // YYYY-MM-DD
  letterIssueDate: string; // YYYY-MM-DD
  relievingReason: string;
  contributedProjects: string;
  performanceStatement: string;
  handoverStatus: HandoverStatus;
  projectClearance: boolean;
  assetClearance: boolean;
  signatoryName: string;
  signatoryTitle: string;
  signatoryDesignation: string;
  companyContact: string;
  companyAddress: string;
  hrNotes: string | null;
  checklistHandover: boolean;
  checklistAssets: boolean;
  checklistAccessRevocation: boolean;
  checklistDuesCleared: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  relievedBy: string | null;
  relievedAt: string | null;
  letterPdfPath: string | null;
  letterPdfHash: string | null;
  emailStatus: RelievingEmailStatus;
  emailSentAt: string | null;
  emailMessageId: string | null;
  emailError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RelievingLetterData {
  employeeName: string;
  designation: string;
  legalEmployer: string;
  joiningDate: string;
  lastWorkingDay: string;
  relievingEffectiveDate: string;
  letterIssueDate: string;
  contributedProjects: string;
  performanceStatement: string;
  signatoryName: string;
  signatoryTitle: string;
  signatoryDesignation: string;
  companyContact?: string;
  companyAddress?: string;
  isDraft?: boolean;
  includeSignature?: boolean;
}

/**
 * Formats YYYY-MM-DD or ISO date string into standard letter date format: e.g. "30 Oct 2026" or "2 Jul 2026"
 */
export function formatLetterDate(rawDate: string | null | undefined): string {
  if (!rawDate) return "";
  try {
    const d = new Date(rawDate);
    if (isNaN(d.getTime())) return rawDate;
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
    ];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  } catch {
    return rawDate;
  }
}
