import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CalendarCheck, ClipboardList, Eye, EyeOff, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { isRecoveryAuthLocation } from "@/lib/app-url";
import { requestPasswordReset } from "@/lib/auth-recovery.functions";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Sign in | The AI School HRM" },
      {
        name: "description",
        content: "Sign in to The AI School employee workspace to manage your workday, assignments and growth.",
      },
      { property: "og:title", content: "Sign in | The AI School HRM" },
      {
        property: "og:description",
        content: "Secure sign-in for The AI School employee workspace.",
      },
    ],
  }),
  component: AuthPage,
});

const HIGHLIGHTS = [
  { icon: CalendarCheck, label: "Track your day" },
  { icon: ClipboardList, label: "Manage assignments" },
  { icon: TrendingUp, label: "Grow together" },
] as const;

type AuthMode = "password" | "reset";

function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<AuthMode>("password");
  const [formError, setFormError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isRecoveryAuthLocation(window.location)) {
      window.location.replace(`/auth/reset-password${window.location.search}${window.location.hash}`);
      return;
    }

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        navigate({ to: "/auth/reset-password", replace: true });
      }
    });

    supabase.auth.getSession().then(({ data }) => {
      if (data.session && !isRecoveryAuthLocation(window.location)) {
        navigate({ to: "/dashboard" });
      }
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, [navigate]);

  function switchMode(nextMode: AuthMode) {
    setFormError(null);
    setStatusMessage(null);
    setMode(nextMode);
  }

  async function signInWithPassword(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setStatusMessage(null);
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) {
      setFormError(error.message);
      toast.error(error.message);
      return;
    }
    navigate({ to: "/dashboard" });
  }

  async function sendPasswordReset(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setStatusMessage(null);
    setBusy(true);
    try {
      await requestPasswordReset({ data: { email: email.trim() } });
      const msg = "If that work email is registered, a password reset link has been sent.";
      toast.success(msg);
      setMode("password");
      setStatusMessage(msg);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not send password reset email right now.";
      setFormError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <aside
        aria-label="The AI School employee workspace"
        className="hidden flex-col justify-between bg-neutral-950 p-10 text-white lg:flex xl:p-14"
      >
        <Logo variant="light" className="h-9 self-start" />

        <div className="max-w-lg">
          <p className="flex items-center gap-2.5 text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-400">
            <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
            The AI School · Employee Workspace
          </p>

          <h1 className="mt-5 font-display text-4xl font-semibold leading-[1.1] tracking-tight text-white xl:text-5xl">
            Your Work. Your Growth.
            <br />
            One Place.
          </h1>

          <span className="mt-6 block h-0.5 w-12 rounded-full bg-primary" aria-hidden="true" />

          <p className="mt-6 max-w-md text-[15px] leading-relaxed text-neutral-400">
            Manage your workday, track progress, collaborate with your team, and stay connected —
            all in one workspace.
          </p>

          <ul className="mt-10 grid max-w-md grid-cols-3 gap-4 border-t border-white/10 pt-6">
            {HIGHLIGHTS.map(({ icon: Icon, label }) => (
              <li key={label} className="flex flex-col gap-2">
                <Icon className="size-4 text-primary" strokeWidth={1.75} aria-hidden="true" />
                <span className="text-xs font-medium text-neutral-300">{label}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="text-[11px] uppercase tracking-[0.16em] text-neutral-500">
          The AI School HRM · Internal Workspace
        </p>
      </aside>

      <main
        id="main-content"
        className="flex items-center justify-center bg-background px-4 py-8 sm:px-6 sm:py-12"
      >
        <Card className="w-full max-w-sm border-border/80">
          <CardHeader className="space-y-4">
            <Logo className="h-7 self-start lg:hidden" />
            <div className="space-y-1.5">
              <CardTitle className="font-display text-xl">
                {mode === "reset" ? "Reset password" : "Sign in"}
              </CardTitle>
              <CardDescription>
                {mode === "reset"
                  ? "Enter your work email and we will send a password recovery link."
                  : "Sign in with your AI School work account."}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {formError ? (
              <div
                role="alert"
                className="break-words rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {formError}
              </div>
            ) : null}

            {statusMessage ? (
              <div
                role="status"
                aria-live="polite"
                className="break-words rounded-md border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300"
              >
                {statusMessage}
              </div>
            ) : null}

            <form
              onSubmit={mode === "password" ? signInWithPassword : sendPasswordReset}
              className="space-y-3"
            >
              <div className="space-y-1.5">
                <Label htmlFor="email">Work email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  disabled={busy}
                  className="h-10"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@theaischool.in"
                />
              </div>
              {mode === "password" ? (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="password">Password</Label>
                    <button
                      type="button"
                      disabled={busy}
                      className="rounded-sm py-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      onClick={() => switchMode("reset")}
                    >
                      Forgot password?
                    </button>
                  </div>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      required
                      disabled={busy}
                      className="h-10 pr-10"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      onClick={() => setShowPassword((prev) => !prev)}
                      className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    >
                      {showPassword ? (
                        <EyeOff className="size-4" aria-hidden="true" />
                      ) : (
                        <Eye className="size-4" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>
              ) : null}
              <Button type="submit" className="h-10 w-full" disabled={busy}>
                {mode === "password"
                  ? busy
                    ? "Signing in…"
                    : "Sign in"
                  : busy
                    ? "Sending reset link…"
                    : "Send password reset link"}
              </Button>
            </form>

            {mode === "reset" ? (
              <button
                type="button"
                disabled={busy}
                className="w-full rounded-md py-1.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                onClick={() => switchMode("password")}
              >
                Back to sign in
              </button>
            ) : null}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
