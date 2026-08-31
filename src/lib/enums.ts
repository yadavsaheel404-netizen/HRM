/** Single source of truth for every user-facing picker.
 *
 *  Each option map is typed as Record<Database enum union, string>, so if the
 *  database enum gains, loses or renames a value the TypeScript build fails
 *  here instead of failing at runtime with a 22P02 invalid-input error (the
 *  exact drift that hit the blocker category picker).
 */
import type { Database } from "@/integrations/supabase/types";

type Enums = Database["public"]["Enums"];

export type WorkModeValue = Enums["attendance_work_mode"];
export type BreakCategoryValue = Enums["break_category"];
export type BlockerCategoryValue = Enums["blocker_category"];
export type BlockerSeverityValue = Enums["blocker_severity"];
export type TaskSlotTypeValue = Enums["task_slot_type"];
export type AttendanceStatusValue = Enums["attendance_status"];
export type ProjectShiftValue = Enums["project_shift"];
export type ProjectWorkModeValue = Enums["work_mode"];
export type ProjectStatusValue = Enums["project_status"];
export type RequestTypeValue = Enums["request_type"];
export type RequestStatusValue = Enums["request_status"];
export type ReviewActionValue = Enums["review_action"];
export type EodStatusValue = Enums["eod_status"];

export const ATTENDANCE_WORK_MODE_LABELS: Record<WorkModeValue, string> = {
  wfo: "Work from office",
  wfh: "Work from home",
  hybrid: "Hybrid",
  client_location: "Client location",
  field_work: "Field work",
};

export const BREAK_CATEGORY_LABELS: Record<BreakCategoryValue, string> = {
  lunch: "Lunch",
  short_break: "Short break",
  meeting: "Meeting",
  training: "Training",
  personal: "Personal",
  other: "Other",
};

export const BLOCKER_CATEGORY_LABELS: Record<BlockerCategoryValue, string> = {
  data_quality: "Data quality",
  tooling: "Tooling",
  access: "Access / permissions",
  dependency: "Dependency on someone",
  guidance: "Needs guidance",
  client: "Client-side",
  personal: "Personal",
  other: "Other",
};

export const BLOCKER_SEVERITY_LABELS: Record<BlockerSeverityValue, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export const TASK_SLOT_TYPE_LABELS: Record<TaskSlotTypeValue, string> = {
  fixed: "Fixed hourly slot",
  flexible: "Flexible range",
};

export const PROJECT_SHIFT_LABELS: Record<ProjectShiftValue, string> = {
  general: "General (day)",
  morning: "Morning",
  evening: "Evening",
  night: "Night",
  rotational: "Rotational",
  flexible: "Flexible",
};

export const PROJECT_WORK_MODE_LABELS: Record<ProjectWorkModeValue, string> = {
  onsite: "Onsite",
  remote: "Remote",
  hybrid: "Hybrid",
};

export const PROJECT_STATUS_LABELS: Record<ProjectStatusValue, string> = {
  draft: "Draft",
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
  archived: "Archived",
};

export const REQUEST_TYPE_LABELS: Record<RequestTypeValue, string> = {
  leave: "Leave",
  wfh: "Work from home",
  attendance_correction: "Attendance correction",
};

export const REQUEST_STATUS_LABELS: Record<RequestStatusValue, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export const REVIEW_ACTION_LABELS: Record<ReviewActionValue, string> = {
  approved: "Approve",
  approved_with_comment: "Approve with comment",
  revision_requested: "Request revision",
  escalated: "Escalate",
  performance_concern: "Mark as performance concern",
};

export const EOD_STATUS_LABELS: Record<EodStatusValue, string> = {
  draft: "Draft",
  submitted: "Submitted",
  reviewed: "Reviewed",
  approved: "Approved",
  revision_required: "Revision required",
  escalated: "Escalated",
  performance_concern: "Performance concern",
};

/** task_unit is a CHECK-constrained text column, not an enum: the list below
 *  must stay in sync with projects_task_unit_known. */
export const TASK_UNITS = [
  "task",
  "clip",
  "image",
  "video",
  "audio_minute",
  "document",
  "record",
  "annotation",
  "row",
  "other",
] as const;
export type TaskUnitValue = (typeof TASK_UNITS)[number];

export const TASK_UNIT_LABELS: Record<TaskUnitValue, string> = {
  task: "Task",
  clip: "Clip",
  image: "Image",
  video: "Video",
  audio_minute: "Audio minute",
  document: "Document",
  record: "Record",
  annotation: "Annotation",
  row: "Row",
  other: "Other",
};

/** Turns a label map into [{ value, label }] for <select> rendering. */
export const optionsOf = <T extends string>(labels: Record<T, string>) =>
  (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));

const keyGuard =
  <T extends string>(labels: Record<T, string>) =>
  (value: unknown): value is T =>
    typeof value === "string" && Object.prototype.hasOwnProperty.call(labels, value);

export const isBlockerCategory = keyGuard(BLOCKER_CATEGORY_LABELS);
export const isBlockerSeverity = keyGuard(BLOCKER_SEVERITY_LABELS);
export const isBreakCategory = keyGuard(BREAK_CATEGORY_LABELS);
export const isAttendanceWorkMode = keyGuard(ATTENDANCE_WORK_MODE_LABELS);
export const isTaskSlotType = keyGuard(TASK_SLOT_TYPE_LABELS);
export const isProjectShift = keyGuard(PROJECT_SHIFT_LABELS);
export const isProjectWorkMode = keyGuard(PROJECT_WORK_MODE_LABELS);
export const isProjectStatus = keyGuard(PROJECT_STATUS_LABELS);
export const isTaskUnit = keyGuard(TASK_UNIT_LABELS);
export const isRequestType = keyGuard(REQUEST_TYPE_LABELS);
export const isRequestStatus = keyGuard(REQUEST_STATUS_LABELS);
export const isReviewAction = keyGuard(REVIEW_ACTION_LABELS);
