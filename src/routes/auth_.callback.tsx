import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { EmailOtpType } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { buildSanitizedAuthPath, parseAuthRecoveryLocation } from "@/lib/app-url";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/auth_/callback")({
  ssr: false,
  head: () => ({
    meta: [{ title: "Completing sign-in | The AI School HRM" }],
  }),
  component: AuthCallbackPage,
});

function sanitizeNextPath(raw: string | null): "/dashboard" | "/auth/reset-password" {
  if (raw === "/auth/reset-password") return "/auth/reset-password";
  return "/dashboard";
}

function AuthCallbackPage() {
  const navigate = useNavigate();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;

    async function completeAuth() {
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
        const nextParam = url.searchParams.get("next");

        if (parsed.errorDescription) {
          scrubSensitiveUrl();
          throw new Error(parsed.errorDescription);
        }

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
          const { data, error } = await supabase.auth.getSession();
          if (error) throw error;
          if (!data.session) {
            throw new Error("Sign-in link has expired or was already used. Request a new link.");
          }
        }

        if (cancelled) return;

        if (parsed.isRecoveryFlow) {
          navigate({ to: "/auth/reset-password", replace: true });
          return;
        }

        navigate({ to: sanitizeNextPath(nextParam), replace: true });
      } catch (err) {
        scrubSensitiveUrl();
        if (!cancelled) {
          setErrorMsg(
            err instanceof Error ? err.message : "Could not verify your authentication link.",
          );
        }
      }
    }

    void completeAuth();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

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
              {errorMsg ? "Verification failed" : "Completing sign-in…"}
            </CardTitle>
            <CardDescription>
              {errorMsg
                ? "This link may have expired or already been used."
                : "Please wait while we verify your session."}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {errorMsg ? (
            <>
              <p
                role="alert"
                className="break-words rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
              >
                {errorMsg}
              </p>
              <Button asChild className="w-full">
                <Link to="/auth">Return to sign in</Link>
              </Button>
            </>
          ) : (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center gap-2.5 text-xs text-muted-foreground"
            >
              <span
                aria-hidden="true"
                className="size-4 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent"
              />
              <span>Establishing your secure session…</span>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
