import { Link } from "@tanstack/react-router";
import { Lock, LogIn, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";
import { describeUnknownError } from "@/lib/describe-error";


/**
 * Rendered whenever a page or one of its server functions refuses the caller.
 * Phase 1 shipped a blank white screen for this case — this is the fix.
 */
export function AccessDenied({
  kind,
  detail,
}: {
  kind: "forbidden" | "signed-out" | "error";
  detail?: string | undefined;
}) {
  const copy = {
    forbidden: {
      icon: Lock,
      title: "You don't have access to this page",
      body: "Your role doesn't include this capability. If you think that's wrong, ask an admin to review your access.",
    },
    "signed-out": {
      icon: LogIn,
      title: "Please sign in again",
      body: "Your session has expired or is no longer valid.",
    },
    error: {
      icon: RefreshCw,
      title: "This page didn't load",
      body: "Something went wrong while loading your data.",
    },
  }[kind];
  const Icon = copy.icon;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <Logo className="h-8" />
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <div className="max-w-md space-y-2">
        <h1 className="font-display text-xl font-semibold">{copy.title}</h1>
        <p className="text-sm text-muted-foreground">{copy.body}</p>
        {detail ? (
          <p className="rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
            {detail}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {kind === "signed-out" ? (
          <Button asChild size="sm">
            <Link to="/auth">Sign in</Link>
          </Button>
        ) : (
          <>
            <Button asChild size="sm">
              <Link to="/dashboard">Back to dashboard</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/onboarding">My profile</Link>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

const PERMISSION_PHRASES: Record<string, string> = {
  "invitations:read:all": "viewing the invitation queue",
  "invitations:create:all": "sending invitations",
  "workforce:read:all": "viewing the workforce directory",
  "workforce:read:team": "viewing your team",
  "documents:read:all": "reviewing staff documents",
  "documents:verify:all": "verifying documents",
  "projects:read:all": "viewing all projects",
  "projects:manage:all": "creating or editing projects",
  "allocations:read:all": "viewing all project allocations",
  "allocations:manage:all": "allocating people to projects",
  "rbac:manage:all": "managing roles and access",
  "audit:read:all": "viewing the audit trail",
};

/** Turns a thrown error into the right screen. */
export function errorToAccessScreen(error: unknown) {
  const message = describeUnknownError(error);

  if (/no authorization header|jwt|not authenticated|invalid token/i.test(message)) {
    return <AccessDenied kind="signed-out" />;
  }

  const forbidden = message.match(/missing permission "([^"]+)"/i);
  if (forbidden || /forbidden|permission denied|not visible to you/i.test(message)) {
    const key = forbidden?.[1];
    const phrase = key ? PERMISSION_PHRASES[key] : undefined;
    return (
      <AccessDenied
        kind="forbidden"
        detail={phrase ? `Missing capability: ${phrase}` : key ? `Missing capability: ${key}` : undefined}
      />
    );
  }

  return <AccessDenied kind="error" detail={message} />;
}
