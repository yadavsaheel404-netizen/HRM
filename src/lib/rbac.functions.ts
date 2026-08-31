import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "./actor.server";

export const getPermissionMatrix = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePermission(context.supabase, context.userId, "rbac:manage:all");
    const [{ data: permissions, error }, { data: rolePermissions }] = await Promise.all([
      context.supabase
        .from("permissions")
        .select("key, resource, action, scope, description")
        .order("resource")
        .order("action"),
      context.supabase.from("role_permissions").select("role, permission_key"),
    ]);
    if (error) throw error;
    return { permissions: permissions ?? [], rolePermissions: rolePermissions ?? [] };
  });

export const setRolePermission = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { role: string; permissionKey: string; enabled: boolean }) => {
    if (!input?.role || !input?.permissionKey) throw new Error("Role and permission are required.");
    if (input.role === "super_admin") {
      throw new Error("Super Admin permissions are fixed and cannot be edited.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "rbac:manage:all");

    if (data.enabled) {
      const { error } = await supabase
        .from("role_permissions")
        .upsert(
          { role: data.role as never, permission_key: data.permissionKey },
          { onConflict: "role,permission_key" },
        );
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("role_permissions")
        .delete()
        .eq("role", data.role as never)
        .eq("permission_key", data.permissionKey);
      if (error) throw error;
    }

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: data.enabled ? "rbac.permission_granted" : "rbac.permission_revoked",
      entityType: "role",
      entityId: data.role,
      detail: { permission: data.permissionKey },
    });
    return { ok: true };
  });

export const setUserRoles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string; roles: string[] }) => {
    if (!input?.userId) throw new Error("A person id is required.");
    if (!Array.isArray(input.roles) || input.roles.length === 0) {
      throw new Error("Every person needs at least one role.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "rbac:assign:all");

    if (data.roles.includes("super_admin")) {
      const { data: isSuper } = await supabase.rpc("has_role", {
        _user_id: userId,
        _role: "super_admin",
      });
      if (isSuper !== true) throw new Error("Only a Super Admin can grant the Super Admin role.");
    }

    if (data.userId === userId) {
      throw new Error("You cannot change your own roles. Ask another admin.");
    }

    await supabase.from("user_roles").delete().eq("user_id", data.userId);
    const { error } = await supabase
      .from("user_roles")
      .insert(data.roles.map((role) => ({ user_id: data.userId, role: role as never })));
    if (error) throw error;

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabase, {
      actorId: userId,
      action: "rbac.roles_assigned",
      entityType: "profile",
      entityId: data.userId,
      detail: { roles: data.roles },
    });
    return { ok: true };
  });

export const listAuditLogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePermission(context.supabase, context.userId, "audit:read:all");
    const { data, error } = await context.supabase
      .from("audit_logs")
      .select("id, actor_id, actor_email, action, entity_type, entity_id, detail, created_at")
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) throw error;
    return data ?? [];
  });
