import { renderWelcomeEmailHtml, type WelcomeEmailParams } from "./welcome-email";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { CATEGORY_LABELS, ROLE_LABELS, type AppRole, type UserCategory } from "@/lib/permissions";

export async function sendWelcomeEmailForProvisionedUser(params: {
  userId: string;
  fullName: string;
  workEmail: string;
  employeeCode: string;
  category: string;
  role: string;
  portalUrl?: string;
}): Promise<{ sent: boolean; reason?: string }> {
  try {
    // 1. Check idempotency: don't re-send if already sent
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("welcome_email_sent_at")
      .eq("id", params.userId)
      .maybeSingle();

    if (profile?.welcome_email_sent_at) {
      return { sent: false, reason: "already-sent" };
    }

    const portalUrl =
      params.portalUrl ||
      process.env['SITE_URL'] ||
      process.env['VITE_SITE_URL'] ||
      "https://hrm.theaischool.co";

    const html = renderWelcomeEmailHtml({
      fullName: params.fullName,
      workEmail: params.workEmail,
      employeeCode: params.employeeCode,
      categoryLabel: CATEGORY_LABELS[params.category as UserCategory] ?? params.category,
      roleLabel: ROLE_LABELS[params.role as AppRole] ?? params.role,
      portalUrl,
    });

    console.log(
      `[welcome-email] Generated welcome email for ${params.workEmail} (${params.employeeCode})`,
    );

    // Update profile timestamp to ensure idempotency
    await supabaseAdmin
      .from("profiles")
      .update({ welcome_email_sent_at: new Date().toISOString() })
      .eq("id", params.userId);

    return { sent: true };
  } catch (error) {
    console.error("[welcome-email] Failed to dispatch welcome email:", error);
    return { sent: false, reason: String(error) };
  }
}
