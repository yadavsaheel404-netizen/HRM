// Server-only helpers that resolve "who is asking" and enforce permissions.
// Every mutating server function goes through requirePermission() — route
// guards are UX only, this is the security boundary.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { Actor, AppRole, PermissionKey } from "./permissions";
import { describeUnknownError } from "./describe-error";

/**
 * Server functions serialize thrown values, so a raw Postgres error object
 * reaches the browser as a plain `{ message, code, hint }` object and any
 * `String(error)` renders "[object Object]". Re-throw as a real Error whose
 * message survives the RPC boundary, and log the original for Server Logs.
 */
export function rethrowDbError(context: string, error: unknown): never {
  console.error(`[${context}]`, error);
  throw new Error(`${context}: ${describeUnknownError(error)}`);
}

type Client = SupabaseClient<Database>;

export class ForbiddenError extends Error {
  constructor(permission: PermissionKey) {
    super(`Forbidden: missing permission "${permission}"`);
    this.name = "ForbiddenError";
  }
}

export async function loadActor(supabase: Client, userId: string): Promise<Actor> {
  const [
    { data: profile, error: profileError },
    { data: roleRows, error: roleError },
    { data: permissionRows, error: permissionError },
  ] =
    await Promise.all([
      supabase
        .from("profiles")
        .select("id, full_name, work_email, account_status, category")
        .eq("id", userId)
        .maybeSingle(),
      supabase.from("user_roles").select("role").eq("user_id", userId),
      supabase.rpc("my_permissions"),
    ]);

  if (profileError) rethrowDbError("Loading your profile failed", profileError);
  // A failed role/permission read must surface as an error: silently returning
  // an actor with no roles renders a false "you don't have access" screen.
  if (roleError) rethrowDbError("Loading your roles failed", roleError);
  if (permissionError) rethrowDbError("Loading your permissions failed", permissionError);

  return {
    userId,
    fullName: profile?.full_name ?? "",
    workEmail: profile?.work_email ?? "",
    accountStatus: profile?.account_status ?? "invited",
    category: profile?.category ?? "full_time",
    roles: (roleRows ?? []).map((r) => r.role as AppRole),
    permissions: ((permissionRows ?? []) as { permission_key: string }[]).map(
      (p) => p.permission_key as PermissionKey,
    ),
  };
}

export async function hasPermission(
  supabase: Client,
  userId: string,
  permission: PermissionKey,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("has_permission", {
    _user_id: userId,
    _permission: permission,
  });
  if (error) throw error;
  return data === true;
}

export async function requirePermission(
  supabase: Client,
  userId: string,
  permission: PermissionKey,
): Promise<void> {
  if (!(await hasPermission(supabase, userId, permission))) {
    throw new ForbiddenError(permission);
  }
}

/** Passes when the caller holds the permission OR is acting on their own record. */
export async function requireSelfOrPermission(
  supabase: Client,
  userId: string,
  targetUserId: string,
  permission: PermissionKey,
): Promise<void> {
  if (userId === targetUserId) return;
  await requirePermission(supabase, userId, permission);
}
