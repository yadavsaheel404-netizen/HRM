import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { Suspense } from "react";
import { supabase } from "@/integrations/supabase/client";
import { errorToAccessScreen } from "@/components/access-denied";
import { useActor } from "@/hooks/use-actor";
import { ForcePasswordChangeDialog } from "@/components/auth/force-password-change-dialog";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: AuthenticatedLayout,
  errorComponent: ({ error }) => errorToAccessScreen(error),
});

function AuthenticatedLayout() {
  const actor = useActor();

  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      }
    >
      <ForcePasswordChangeDialog open={actor.mustChangePassword === true} />
      <Outlet />
    </Suspense>
  );
}
