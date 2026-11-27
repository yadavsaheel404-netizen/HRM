import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { EmailOtpType } from "@supabase/supabase-js";
import { Check, CheckCircle2, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { buildSanitizedAuthPath, parseAuthRecoveryLocation } from "@/lib/app-url";
import { finalizePasswordRecovery } from "@/lib/auth-recovery.functions";
import { evaluatePasswordPolicy } from "@/lib/password-policy";
import { completeAccountSetup } from "@/lib/onboarding.functions";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/auth_/reset-password")({
  ssr: false,
  head: () => ({
    meta: [{ title: "Set new password | The AI School HRM" }],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const [ready, setReady] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Account-setup links (from HR) wait for an explicit click so mail scanners cannot consume them. */
  const [isSetupLink, setIsSetupLink] = useState(false);
  const [awaitingContinue, setAwaitingContinue] = useState(false);
  const [continueAttempt, setContinueAttempt] = useState(0);
  const verificationKeyRef = useRef<string | null>(null);

  const policy = evaluatePasswordPolicy(password, confirmPassword);

  useEffect(() => {
    let cancelled = false;

    async function verifyRecoverySession() {
      const url = new URL(window.location.href);
      const parsed = parseAuthRecoveryLocation(window.location);

      const scrubSensitiveUrl = () => {
        if (parsed.hasSensitiveParams) {
          window.history.replaceState(
            null,
            "",
            buildSanitizedAuthPath(url.pathname, url.search),
          );
        }
      };

      try {
        if (parsed.errorDescription) {
          scrubSensitiveUrl();
          throw new Error(parsed.errorDescription);
        }

        if (parsed.isSetupLink) setIsSetupLink(true);
        if (parsed.isSetupLink && parsed.tokenHash && continueAttempt === 0) {
          if (!cancelled) setAwaitingContinue(true);
          return;
        }

        // Single-flight guard prevents duplicate verification under React StrictMode or re-renders.
        const attemptKey = `${continueAttempt}:${parsed.code ?? ""}:${parsed.tokenHash ?? ""}:${parsed.accessToken ? "hash" : ""}`;
        if (verificationKeyRef.current === attemptKey) {
          return;
        }
        verificationKeyRef.current = attemptKey;

        if (parsed.code) {
          const { error } = await supabase.auth.exchangeCodeForSession(parsed.code);
          scrubSensitiveUrl();
          if (error) throw error;
        } else if (parsed.tokenHash && parsed.queryType) {
          const { error } = await supabase.auth.verifyOtp({
            token_hash: parsed.tokenHash,
            type: parsed.queryType as EmailOtpType,
          });
          scrubSensitiveUrl();
          if (error) throw error;
        } else if (parsed.accessToken && parsed.refreshToken) {
          const { error } = await supabase.auth.setSession({
            access_token: parsed.accessToken,
            refresh_token: parsed.refreshToken,
          });
          scrubSensitiveUrl();
          if (error) throw error;
        } else {
          scrubSensitiveUrl();
        }

        let { data, error } = await supabase.auth.getSession();
        if (error) throw error;

        if (!data.session) {
          await new Promise<void>((resolve) => {
            const timeout = window.setTimeout(() => {
              sub.subscription.unsubscribe();
              resolve();
            }, 1500);
            const { data: sub } = supabase.auth.onAuthStateChange((event) => {
              if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
                window.clearTimeout(timeout);
                sub.subscription.unsubscribe();
                resolve();
              }
            });
          });
          ({ data, error } = await supabase.auth.getSession());
          if (error) throw error;
        }

        if (!data.session) {
          throw new Error(
            "Your password reset session is missing or expired. Request a new password reset link.",
          );
        }

        if (!cancelled) {
          setAwaitingContinue(false);
          setReady(true);
        }
      } catch (err) {
        scrubSensitiveUrl();
        if (!cancelled) {
          setAwaitingContinue(false);
          setSessionError(
            err instanceof Error
              ? `${err.message} This link may have expired or already been used — ask HR for a new setup email or request a new reset link.`
              : "Could not validate password reset link.",
          );
        }
      }
    }

    void verifyRecoverySession();
    return () => {
      cancelled = true;
    };
  }, [continueAttempt]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    if (!policy.isValid) {
      const msg = policy.errorMessage ?? "Enter a valid password.";
      setFormError(msg);
      toast.error(msg);
      return;
    }

    setBusy(true);
    try {
      if (isSetupLink) {
        // Sets the password and records "account setup confirmed" atomically on the server.
        await completeAccountSetup({ data: { newPassword: password } });
      } else {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        try {
          await finalizePasswordRecovery();
        } catch (auditErr) {
          console.error("[auth] finalizePasswordRecovery failed", auditErr);
        }
        // End local recovery session cleanly so Sign In opens instead of auto-bouncing.
        await supabase.auth.signOut({ scope: "local" });
      }

      setPassword("");
      setConfirmPassword("");
      setCompleted(true);
      toast.success(isSetupLink ? "Your account is set up." : "Your password has been updated.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not update password.";
      setFormError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      id="main-content"
      className="flex min-h-screen items-center justify-center bg-background px-4 py-8 sm:py-12"
    >
      <Card className="w-full max-w-sm border-border/80">
        <CardHeader className="space-y-3">
          <Logo className="h-8" />
          <div>
            <CardTitle className="font-display text-xl">
              {completed
                ? isSetupLink
                  ? "Account setup complete"
                  : "Password updated"
                : isSetupLink
                  ? "Set up your HRM account"
                  : "Set a new password"}
            </CardTitle>
            <CardDescription>
              {completed
                ? "Your new password has been saved securely."
                : "Choose a strong password for your work account before continuing."}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {completed ? (
            <div className="space-y-4">
              <div
                role="status"
                aria-live="polite"
                className="flex items-start gap-2.5 rounded-md border border-emerald-500/35 bg-emerald-500/10 p-3 text-xs text-emerald-800 dark:text-emerald-300"
              >
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  {isSetupLink
                    ? "Your HRM password is set and your account is active."
                    : "Your password has been changed. Sign in to The AI School HRM using your new password."}
                </span>
              </div>
              <Button asChild className="w-full">
                <Link to={isSetupLink ? "/dashboard" : "/auth"}>
                  {isSetupLink ? "Continue to workspace" : "Sign in to HRM"}
                </Link>
              </Button>
              {isSetupLink ? (
                <Button asChild variant="outline" className="w-full">
                  <Link to="/auth">Go to sign in</Link>
                </Button>
              ) : null}
            </div>
          ) : sessionError ? (
            <div className="space-y-4">
              <p
                role="alert"
                className="break-words rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
              >
                {sessionError}
              </p>
              <Button asChild className="w-full">
                <Link to="/auth">Back to sign in</Link>
              </Button>
            </div>
          ) : awaitingContinue ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Welcome to The AI School. Continue to verify your secure, single-use setup link
                and choose your password.
              </p>
              <Button
                type="button"
                className="w-full"
                onClick={() => setContinueAttempt((n) => n + 1)}
              >
                Continue to set my password
              </Button>
            </div>
          ) : !ready ? (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center gap-2.5 text-sm text-muted-foreground"
            >
              <span
                aria-hidden="true"
                className="size-4 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent"
              />
              <span>Verifying reset token…</span>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3.5">
              {formError ? (
                <p
                  role="alert"
                  className="break-words rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                >
                  {formError}
                </p>
              ) : null}

              <div className="space-y-1.5">
                <Label htmlFor="new-password">New password</Label>
                <div className="relative">
                  <Input
                    id="new-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    required
                    minLength={8}
                    disabled={busy}
                    className="pr-10"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    {showPassword ? (
                      <EyeOff className="size-4" aria-hidden="true" />
                    ) : (
                      <Eye className="size-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <Input
                  id="confirm-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  required
                  minLength={8}
                  disabled={busy}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>

              <ul
                aria-label="Password requirements"
                className="space-y-1 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
              >
                <li className="flex items-center gap-1.5">
                  <Check
                    aria-hidden="true"
                    className={`size-3.5 shrink-0 ${policy.minLengthMet ? "text-emerald-600 dark:text-emerald-400" : "opacity-35"}`}
                  />
                  <span className={policy.minLengthMet ? "text-foreground" : undefined}>
                    At least 8 characters
                  </span>
                </li>
                <li className="flex items-center gap-1.5">
                  <Check
                    aria-hidden="true"
                    className={`size-3.5 shrink-0 ${policy.hasLetter ? "text-emerald-600 dark:text-emerald-400" : "opacity-35"}`}
                  />
                  <span className={policy.hasLetter ? "text-foreground" : undefined}>
                    Includes at least one letter
                  </span>
                </li>
                <li className="flex items-center gap-1.5">
                  <Check
                    aria-hidden="true"
                    className={`size-3.5 shrink-0 ${policy.hasNumberOrSymbol ? "text-emerald-600 dark:text-emerald-400" : "opacity-35"}`}
                  />
                  <span className={policy.hasNumberOrSymbol ? "text-foreground" : undefined}>
                    Includes at least one number or symbol
                  </span>
                </li>
              </ul>

              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Updating…" : "Save new password"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
