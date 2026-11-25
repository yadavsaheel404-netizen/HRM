// Server-only direct employee provisioning (single + bulk share this path).
//
// Order of operations per row (each step rolls back the previous on failure):
//   1. Idempotency: a previous successful run with the same key returns its result.
//   2. Supabase Auth admin createUser (no password, no email sent).
//   3. claim_next_employee_id() — atomic row-locked sequence, never MAX()+1.
//   4. profiles insert (date of birth stored only in the existing column).
//   5. user_roles insert (role already authorised server-side).
//   6. Audit row WITHOUT date of birth or any secret.
// A consumed employee ID is never reused, even when a later step fails.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { writeAudit } from "../audit.server";
import { assignableRolesFor, type AppRole } from "../permissions";
import { syncProfileToEmployeeRecordSafe } from "../records/sync.server";
import { todayIso } from "../timezone";
import {
  type DuplicateSource,
  type OnboardingLookups,
  type ValidatedOnboardingRow,
} from "./employee-onboarding";

export const PROVISION_AUDIT_ACTION = "employee.provisioned";

const BATCH_KEY_RE = /^[a-zA-Z0-9-]{8,64}$/;

export function assertBatchKey(batchKey: unknown): string {
  const key = String(batchKey ?? "");
  if (!BATCH_KEY_RE.test(key)) throw new Error("A valid batch key is required.");
  return key;
}

export function idempotencyKeyFor(batchKey: string, email: string): string {
  return `onboard:${batchKey}:${email.toLowerCase()}`;
}

/** Roles grantable through onboarding by this actor (never super_admin). */
export function onboardingAssignableRoles(actorRoles: readonly string[]): AppRole[] {
  return assignableRolesFor(actorRoles).filter((r) => r !== "super_admin");
}

async function listAllAuthEmails(): Promise<Set<string>> {
  const emails = new Set<string>();
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Could not verify existing accounts: ${error.message}`);
    for (const u of data.users) if (u.email) emails.add(u.email.toLowerCase());
    if (data.users.length < 1000) break;
  }
  return emails;
}

/**
 * Builds validation lookups with the service role so duplicates against
 * protected accounts are still detected (without revealing which account).
 */
export async function buildOnboardingLookups(actorRoles: readonly string[]): Promise<OnboardingLookups> {
  const [authEmails, profilesRes, invitesRes, deptRes, rolesRes] = await Promise.all([
    listAllAuthEmails(),
    supabaseAdmin.from("profiles").select("id, work_email, account_status, employment_status"),
    supabaseAdmin.from("invitations").select("email, status").in("status", ["queued", "sending", "sent"]),
    supabaseAdmin.from("departments").select("id, name, code"),
    supabaseAdmin.from("user_roles").select("user_id, role"),
  ]);
  if (profilesRes.error) throw new Error(`Could not load profiles: ${profilesRes.error.message}`);

  const existingEmails = new Map<string, Exclude<DuplicateSource, "file">>();
  for (const email of authEmails) existingEmails.set(email, "auth");
  for (const p of profilesRes.data ?? []) {
    if (p.work_email) existingEmails.set(p.work_email.toLowerCase(), "profile");
  }
  for (const i of invitesRes.data ?? []) {
    const e = i.email.toLowerCase();
    if (!existingEmails.has(e)) existingEmails.set(e, "invitation");
  }

  const departments = new Map<string, { id: string; name: string; code: string | null }>();
  for (const d of deptRes.data ?? []) {
    const entry = { id: d.id, name: d.name, code: (d as { code?: string | null }).code ?? null };
    departments.set(d.name.toLowerCase(), entry);
    if (entry.code) departments.set(entry.code.toLowerCase(), entry);
  }

  const rolesByUser = new Map<string, Set<string>>();
  for (const r of rolesRes.data ?? []) {
    const set = rolesByUser.get(r.user_id) ?? new Set<string>();
    set.add(r.role);
    rolesByUser.set(r.user_id, set);
  }
  const leadsByEmail = new Map<string, string>();
  for (const p of profilesRes.data ?? []) {
    const roles = rolesByUser.get(p.id);
    if (!roles || roles.has("super_admin")) continue; // protected account never selectable
    if (!(roles.has("lead") || roles.has("manager"))) continue;
    if (p.employment_status && p.employment_status !== "active") continue;
    if (p.work_email) leadsByEmail.set(p.work_email.toLowerCase(), p.id);
  }

  return {
    existingEmails,
    departments,
    leadsByEmail,
    assignableRoles: onboardingAssignableRoles(actorRoles),
    todayIso: todayIso(),
  };
}

export type ProvisionOutcome =
  | { outcome: "created"; userId: string; employeeCode: string; replayed: boolean }
  | { outcome: "duplicate"; reason: string }
  | { outcome: "failed"; reason: string };

/** Returns a previous successful provisioning for this idempotency key, if any. */
export async function findPreviousProvision(
  idempotencyKey: string,
): Promise<{ userId: string; employeeCode: string } | null> {
  const { data } = await supabaseAdmin
    .from("audit_logs")
    .select("entity_id, detail")
    .eq("action", PROVISION_AUDIT_ACTION)
    .contains("detail", { idempotency_key: idempotencyKey } as never)
    .limit(1)
    .maybeSingle();
  if (!data?.entity_id) return null;
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("id, employee_code")
    .eq("id", data.entity_id)
    .maybeSingle();
  if (!profile?.employee_code) return null;
  return { userId: profile.id, employeeCode: profile.employee_code };
}

function safeAuthError(message: string): string {
  return message.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[token]").slice(0, 240);
}

async function rollbackAuthUser(userId: string) {
  // profiles / user_roles cascade from auth.users.
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) console.error("[onboarding] rollback deleteUser failed", userId, error.message);
}

export async function provisionEmployee(params: {
  row: ValidatedOnboardingRow;
  actorId: string;
  idempotencyKey: string;
  source: "single" | "bulk";
}): Promise<ProvisionOutcome> {
  const { row, actorId, idempotencyKey, source } = params;
  if (!row.role || !row.category || !row.workType || !row.dateOfBirth) {
    return { outcome: "failed", reason: "Row is not fully validated." };
  }

  const previous = await findPreviousProvision(idempotencyKey);
  if (previous) return { outcome: "created", ...previous, replayed: true };

  // 1. Auth user — no password, no Supabase-sent email.
  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email: row.workEmail,
    email_confirm: true,
    user_metadata: { full_name: row.fullName },
  });
  if (createError || !created?.user) {
    const msg = createError?.message ?? "Auth user was not created.";
    if (/already (been )?registered|already exists|duplicate/i.test(msg)) {
      return { outcome: "duplicate", reason: "An account already exists for this email." };
    }
    return { outcome: "failed", reason: `Account creation failed: ${safeAuthError(msg)}` };
  }
  const userId = created.user.id;

  // 2. Atomic employee ID.
  const { data: claimed, error: claimError } = await supabaseAdmin.rpc("claim_next_employee_id");
  const employeeCode = typeof claimed === "string" ? claimed : null;
  if (claimError || !employeeCode) {
    await rollbackAuthUser(userId);
    return { outcome: "failed", reason: "Could not allocate an employee ID. Nothing was created." };
  }

  // 3. Profile.
  const nowIso = new Date().toISOString();
  const { error: profileError } = await supabaseAdmin.from("profiles").insert({
    id: userId,
    full_name: row.fullName,
    work_email: row.workEmail,
    date_of_birth: row.dateOfBirth,
    category: row.category,
    designation: row.designation,
    department_id: row.departmentId,
    reporting_lead_id: row.reportingLeadId,
    needs_assignment: !row.reportingLeadId,
    joining_date: row.joiningDate,
    internship_start: row.internshipStart,
    internship_end: row.internshipEnd,
    account_status: "invited",
    employee_code: employeeCode,
    work_type: row.workType,
    work_type_assigned_by: actorId,
    work_type_assigned_at: nowIso,
    // Forces a personal password before any normal use; cleared only when the
    // employee sets their own password (that event is what "Confirmed" means).
    must_change_password: true,
  } as never);
  if (profileError) {
    await rollbackAuthUser(userId);
    return {
      outcome: /duplicate|unique/i.test(profileError.message) ? "duplicate" : "failed",
      reason: /duplicate|unique/i.test(profileError.message)
        ? "An account already exists for this email."
        : `Profile creation failed (employee ID ${employeeCode} retired, not reused).`,
    };
  }

  // 4. Role.
  const { error: roleError } = await supabaseAdmin
    .from("user_roles")
    .insert({ user_id: userId, role: row.role as never });
  if (roleError) {
    await rollbackAuthUser(userId);
    return {
      outcome: "failed",
      reason: `Role assignment failed (employee ID ${employeeCode} retired, not reused).`,
    };
  }

  // 5. Audit — no DOB, no secrets.
  await writeAudit(supabaseAdmin, {
    actorId,
    action: PROVISION_AUDIT_ACTION,
    entityType: "profile",
    entityId: userId,
    detail: {
      idempotency_key: idempotencyKey,
      employee_code: employeeCode,
      work_email: row.workEmail,
      role: row.role,
      category: row.category,
      work_type: row.workType,
      source,
      setup_email_sent: false,
    },
  });

  // 6. Auto-sync newly onboarded employee into Employee Records master register.
  await syncProfileToEmployeeRecordSafe(userId, actorId);

  return { outcome: "created", userId, employeeCode, replayed: false };
}
