import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in | The AI School HRM" },
      {
        name: "description",
        content: "Sign in to The AI School HRM portal to manage your profile, team and daily work.",
      },
      { property: "og:title", content: "Sign in | The AI School HRM" },
      {
        property: "og:description",
        content: "Secure sign-in for The AI School workforce portal.",
      },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"password" | "magic">("password");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard" });
    });
  }, [navigate]);

  async function signInWithPassword(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    navigate({ to: "/dashboard" });
  }

  async function sendMagicLink(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        shouldCreateUser: false,
      },
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Check your inbox for a sign-in link.");
  }

  async function signInWithGoogle() {
    setBusy(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/dashboard`,
      },
    });
    if (error) {
      setBusy(false);
      toast.error("Google sign-in failed. Try email instead.");
      return;
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-sidebar p-10 lg:flex">
        <Logo variant="light" className="h-9" />
        <div className="max-w-md">
          <h2 className="font-display text-3xl font-semibold text-sidebar-foreground">
            One portal for the entire employee lifecycle.
          </h2>
          <p className="mt-3 text-sm text-sidebar-foreground/70">
            Invitation, onboarding, documents, allocation, attendance, hourly work logs and EOD
            reporting — with role-aware access enforced on the server, not in the browser.
          </p>
        </div>
        <p className="text-xs text-sidebar-foreground/50">
          Internal system. Access is by invitation only.
        </p>
      </div>

      <div className="flex items-center justify-center px-4 py-12">
        <Card className="w-full max-w-sm border-border/70">
          <CardHeader className="space-y-3">
            <Logo className="h-8 lg:hidden" />
            <div>
              <CardTitle className="font-display text-xl">Sign in</CardTitle>
              <CardDescription>
                Use your work account. New joiners: open the invitation email first.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <form
              onSubmit={mode === "password" ? signInWithPassword : sendMagicLink}
              className="space-y-3"
            >
              <div className="space-y-1.5">
                <Label htmlFor="email">Work email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@theaischool.in"
                />
              </div>
              {mode === "password" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              ) : null}
              <Button type="submit" className="w-full" disabled={busy}>
                {mode === "password" ? "Sign in" : "Email me a sign-in link"}
              </Button>
            </form>

            <button
              type="button"
              className="w-full text-xs text-muted-foreground underline-offset-4 hover:underline"
              onClick={() => setMode(mode === "password" ? "magic" : "password")}
            >
              {mode === "password" ? "Sign in with an email link instead" : "Use a password instead"}
            </button>

            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>

            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={signInWithGoogle}
            >
              Continue with Google
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
