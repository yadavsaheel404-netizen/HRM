import { createFileRoute, redirect } from "@tanstack/react-router";

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
    throw redirect({ to: "/dashboard" });
  },
});
