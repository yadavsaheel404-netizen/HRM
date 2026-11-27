import { createFileRoute, redirect } from "@tanstack/react-router";
import { isRecoveryAuthLocation } from "@/lib/app-url";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "The AI School HRM Portal" },
      {
        name: "description",
        content:
          "Internal HRM portal for The AI School: onboarding, attendance, daily reporting and workforce management.",
      },
      { property: "og:title", content: "The AI School HRM Portal" },
      {
        property: "og:description",
        content: "Onboarding, attendance and workforce management for The AI School.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  beforeLoad: () => {
    if (typeof window !== "undefined" && isRecoveryAuthLocation(window.location)) {
      window.location.replace(`/auth/reset-password${window.location.search}${window.location.hash}`);
      return;
    }
    throw redirect({ to: "/dashboard" });
  },
  pendingComponent: () => (
    <div
      role="status"
      aria-label="Loading portal"
      className="flex min-h-screen items-center justify-center bg-background"
    >
      <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  ),
});
