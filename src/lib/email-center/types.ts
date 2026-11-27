export const CUSTOM_TEMPLATE_PLACEHOLDERS = [
  "employee_name",
  "employee_id",
  "designation",
  "joining_date",
  "last_working_date",
  "work_type",
  "employment_category",
  "company_name",
  "issue_date",
] as const;

export type CustomTemplatePlaceholderKey = (typeof CUSTOM_TEMPLATE_PLACEHOLDERS)[number];

export const STATIC_PDF_WARNING_MESSAGE =
  "This PDF is a static attachment. Employee-specific placeholders are not available.";

export const CUSTOM_TEMPLATE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const DISPATCH_CHUNK_SIZE = 15;
export const OFFICIAL_SENDER_DISPLAY = "The AI School HR <hr@theaischool.co>";
export const CUSTOM_TEMPLATES_BUCKET = "custom-email-templates";

export type RecipientEmailMode = "personal" | "work";

export type EmailResolutionStatus =
  | "ready"
  | "missing_personal_email"
  | "missing_work_email"
  | "invalid_email";

export type RelievingValidationStatus =
  | "ready"
  | "missing_details"
  | "approval_pending"
  | "already_issued"
  | "already_sent"
  | "blocked";

export type CustomTemplateFormat = "none" | "docx" | "pdf";
export type CustomPdfMode = "static" | "fillable" | null;
export type CustomTemplateStatus = "draft" | "approved" | "archived";
export type CustomTemplateRecipientType =
  | "all_records"
  | "active_employees"
  | "former_employees"
  | "interns_trainers"
  | "custom";

export interface EmailCenterAccessPolicy {
  canReadEmailCenter: boolean;
  canManageCustomTemplates: boolean;
  canSendEmails: boolean;
  canViewPersonalEmails: boolean;
  canAccessPrivateTemplateFiles: boolean;
  isReadOnly: boolean;
  isFounder: boolean;
}

export interface RelievingCaseSnapshot {
  id: string;
  status: string;
  designation: string | null;
  legalEmployer: string | null;
  joiningDate: string | null;
  lastWorkingDay: string | null;
  relievingEffectiveDate: string | null;
  letterIssueDate: string | null;
  contributedProjects: string | null;
  performanceStatement: string | null;
  signatoryName: string | null;
  signatoryTitle: string | null;
  signatoryDesignation: string | null;
  companyContact: string | null;
  companyAddress: string | null;
  projectClearance: boolean;
  assetClearance: boolean;
  checklistHandover: boolean;
  letterPdfPath: string | null;
  emailStatus: string;
  emailSentAt: string | null;
}

export interface EmailCenterRecipientItem {
  recordId: string;
  profileId: string | null;
  employeeCode: string | null;
  historicalRecordId: string;
  fullName: string;
  designation: string | null;
  departmentId: string | null;
  departmentName: string | null;
  employmentCategory: string;
  workType: string;
  employmentStatus: string;
  isFormer: boolean;
  isHistoricalOnly: boolean;
  joiningDate: string | null;
  lastWorkingDate: string | null;
  relievingEffectiveDate: string | null;
  legalEmployer: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  workEmailAvailable: boolean;
  personalEmailAvailable: boolean;
  relievingCase: RelievingCaseSnapshot | null;
}

export interface RecipientSearchFilters {
  query?: string;
  status?: "all" | "active" | "inactive_relieved";
  department?: string;
  workType?: string;
  employmentCategory?: string;
  hasApprovedRelievingCase?: boolean;
  missingRequiredDetails?: boolean;
  emailAvailable?: "all" | "any" | "personal" | "work";
  emailMode?: RecipientEmailMode;
  page?: number;
  pageSize?: number;
  includeAllMatchingIds?: boolean;
  context?: "relieving" | "custom";
}

export interface RecipientSearchResponse {
  items: EmailCenterRecipientItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  departments: string[];
  workTypes: string[];
  allMatchingIds?: string[] | undefined;
  access: EmailCenterAccessPolicy;
}

export interface RecipientEmailResolution {
  emailMode: RecipientEmailMode;
  resolvedEmail: string | null;
  status: EmailResolutionStatus;
  statusLabel: string;
  warning: string | null;
}

export interface RelievingRecipientValidation {
  recordId: string;
  status: RelievingValidationStatus;
  statusLabel: string;
  reasons: string[];
  canPreviewDraft: boolean;
  canOfficialIssue: boolean;
  canSendOfficial: boolean;
  emailResolution: RecipientEmailResolution;
}

export interface CustomEmailTemplateRecord {
  id: string;
  name: string;
  description: string;
  purposeCategory: string;
  subjectTemplate: string;
  bodyHtmlTemplate: string;
  bodyTextTemplate: string | null;
  attachmentPath: string | null;
  attachmentFilename: string | null;
  attachmentFormat: CustomTemplateFormat;
  attachmentMime: string | null;
  attachmentSizeBytes: number | null;
  attachmentSha256: string | null;
  pdfMode: CustomPdfMode;
  detectedPlaceholders: string[];
  recipientType: CustomTemplateRecipientType;
  defaultEmailMode: RecipientEmailMode;
  senderDisplay: string;
  status: CustomTemplateStatus;
  requiresElevatedApproval: boolean;
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomEmailTemplateVersionRecord {
  id: string;
  templateId: string;
  version: number;
  name: string;
  subjectTemplate: string;
  attachmentFilename: string | null;
  attachmentFormat: CustomTemplateFormat;
  detectedPlaceholders: string[];
  status: string;
  changedBy: string | null;
  createdAt: string;
}

export interface EmailDispatchBatchRecord {
  id: string;
  idempotencyKey: string;
  dispatchKind: "relieving_bulk" | "custom_template_bulk";
  templateSlug: string | null;
  customTemplateId: string | null;
  templateName: string;
  templateVersion: number | null;
  subjectTemplate: string;
  defaultEmailMode: RecipientEmailMode;
  attachmentFilename: string | null;
  attachmentFormat: string | null;
  status: "queued" | "processing" | "completed" | "partial_failure" | "failed" | "canceled";
  totalCount: number;
  queuedCount: number;
  acceptedCount: number;
  failedCount: number;
  canceledCount: number;
  skippedCount: number;
  personalEmailCount: number;
  workEmailCount: number;
  createdBy: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailDispatchItemRecord {
  id: string;
  batchId: string;
  idempotencyKey: string;
  recipientRecordId: string;
  profileId: string | null;
  relievingCaseId: string | null;
  employeeCode: string | null;
  recipientName: string;
  emailMode: RecipientEmailMode;
  recipientEmail: string;
  resolvedSubject: string;
  attachmentName: string | null;
  status:
    | "queued"
    | "sending"
    | "accepted_by_smtp"
    | "delivered"
    | "failed"
    | "canceled"
    | "skipped";
  attempts: number;
  provider: string;
  providerMessageId: string | null;
  smtpResponse: string | null;
  errorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
}
