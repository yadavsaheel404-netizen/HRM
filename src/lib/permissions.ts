// Client-safe permission catalogue. The database is the source of truth for
// which role holds which permission — this file only names them and gives
// them human labels so the UI can render the matrix and reason about routes.

export const PERMISSION_KEYS = [
  "workforce:read:self",
  "workforce:read:team",
  "workforce:read:all",
  "workforce:create:all",
  "workforce:update:all",
  "workforce:deactivate:all",
  "documents:read:self",
  "documents:read:team",
  "documents:read:all",
  "documents:upload:self",
  "documents:verify:all",
  "invitations:read:all",
  "invitations:create:all",
  "rbac:manage:all",
  "rbac:assign:all",
  "org:manage:all",
  "audit:read:all",
  "projects:read:all",
  "projects:read:team",
  "projects:manage:all",
  "allocations:read:all",
  "allocations:read:team",
  "allocations:manage:all",
  "allocations:acknowledge:self",
  "attendance:log:self",
  "attendance:read:self",
  "attendance:read:team",
  "attendance:read:all",
  "tasks:log:self",
  "tasks:read:team",
  "tasks:read:all",
  "tasks:review:team",
  "blockers:raise:self",
  "blockers:manage:team",
  "eod:submit:self",
  "eod:read:team",
  "eod:read:all",
  "eod:review:team",
  "requests:submit:self",
  "requests:read:self",
  "requests:read:team",
  "requests:read:all",
  "requests:approve:lead",
  "requests:approve:hr",
  "announcements:read:all",
  "announcements:manage:all",
  "analytics:read:team",
  "analytics:read:all",
  "automation:run:all",
  "import:manage:all",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const APP_ROLES = ["super_admin", "founder", "hr", "admin", "lead", "employee"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const ROLE_LABELS: Record<AppRole, string> = {
  super_admin: "Super Admin",
  founder: "Founder",
  hr: "HR",
  admin: "Admin",
  lead: "Project / Team Lead",
  employee: "Employee",
};

export const USER_CATEGORIES = ["full_time", "intern", "freelancer", "trainer"] as const;
export type UserCategory = (typeof USER_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<UserCategory, string> = {
  full_time: "Full-Time Employee",
  intern: "Intern",
  freelancer: "Freelancer",
  trainer: "Trainer",
};

export const ACCOUNT_STATUSES = [
  "invited",
  "activated",
  "profile_pending",
  "under_verification",
  "active",
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  invited: "Invited",
  activated: "Activated",
  profile_pending: "Profile Pending",
  under_verification: "Under Verification",
  active: "Active",
};

export const EMPLOYMENT_STATUSES = ["active", "inactive", "on_hold", "exited"] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

export const DOCUMENT_TYPES = [
  "resume",
  "identity_proof",
  "pan",
  "bank_details",
  "education",
  "offer_letter",
  "nda",
  "other",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  resume: "Resume",
  identity_proof: "Identity Proof",
  pan: "PAN",
  bank_details: "Bank Details",
  education: "Educational Documents",
  offer_letter: "Offer Letter / Contract",
  nda: "NDA",
  other: "Other",
};

/** Documents every person must upload before HR can verify the profile. */
export const REQUIRED_DOCUMENT_TYPES: DocumentType[] = [
  "resume",
  "identity_proof",
  "pan",
  "bank_details",
  "education",
];

export type Actor = {
  userId: string;
  fullName: string;
  workEmail: string;
  accountStatus: AccountStatus;
  category: UserCategory;
  roles: AppRole[];
  permissions: PermissionKey[];
  mustChangePassword?: boolean;
};

export function actorCan(actor: Actor | null | undefined, permission: PermissionKey): boolean {
  return actor?.permissions.includes(permission) ?? false;
}
