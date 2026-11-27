import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Initiates a password-reset email from the unauthenticated Sign-In / Forgot Password
 * form using the server-validated canonical `PUBLIC_APP_URL` redirect destination so
 * production recovery links never fall back to `localhost`.
 */
export const requestPasswordReset = createServerFn({ method: "POST" })
  .validator((input: { email: string }) => {
    const normalized = String(input?.email ?? "").trim().toLowerCase();
    if (!normalized || !EMAIL_FORMAT_RE.test(normalized) || normalized.length > 254) {
      throw new Error("Enter a valid work email address.");
    }
    return { email: normalized };
  })
  .handler(async ({ data }) => {
    const { resolvePasswordResetRedirectUrl } = await import(
      "./recruitment/email-transport.server"
    );
    const redirectTo = resolvePasswordResetRedirectUrl();

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.resetPasswordForEmail(data.email, {
      redirectTo,
    });

    if (error) {
      const msg = error.message ?? "";
      if (error.status === 429 || /rate.?limit/i.test(msg)) {
        throw new Error(
          "Too many password reset requests. Please wait a few minutes and try again.",
        );
      }
      console.error("[auth] requestPasswordReset failed:", msg || "unknown error");
      throw new Error(
        "Unable to send password reset email right now. Please try again or contact HR.",
      );
    }

    return { ok: true };
  });

/**
 * Completes a Forgot-Password recovery session after the employee updates their password:
 * clears `must_change_password` if it was set and records an audit entry without logging passwords.
 */
export const finalizePasswordRecovery = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("id, must_change_password, employee_code")
      .eq("id", userId)
      .maybeSingle();

    const wasMustChange = profile?.must_change_password === true;
    if (wasMustChange) {
      await supabaseAdmin
        .from("profiles")
        .update({ must_change_password: false } as never)
        .eq("id", userId)
        .eq("must_change_password", true);
    }

    const { writeAudit } = await import("./audit.server");
    await writeAudit(supabaseAdmin, {
      actorId: userId,
      action: "password.reset_completed",
      entityType: "profile",
      entityId: userId,
      detail: {
        employee_code: profile?.employee_code ?? null,
        method: "forgot_password_recovery_link",
        must_change_password_cleared: wasMustChange,
      },
    });

    return { ok: true };
  });
