import { createFileRoute, useParams } from "@tanstack/react-router";
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { getWorkforceMember, reviewProfile } from "@/lib/workforce.functions";
import { getDocumentDownloadUrl, reviewDocument } from "@/lib/documents.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ACCOUNT_STATUS_LABELS,
  CATEGORY_LABELS,
  DOCUMENT_TYPE_LABELS,
  ROLE_LABELS,
  type AccountStatus,
  type AppRole,
  type DocumentType,
  type UserCategory,
} from "@/lib/permissions";

export const Route = createFileRoute("/_authenticated/workforce/$personId")({
  head: () => ({
    meta: [
      { title: "Employee record | The AI School HRM" },
      {
        name: "description",
        content: "Employee profile, documents and HR verification actions.",
      },
      { property: "og:title", content: "Employee record | The AI School HRM" },
      { property: "og:description", content: "Profile details and document verification." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: PersonPage,
});

function PersonPage() {
  const { personId } = useParams({ from: "/_authenticated/workforce/$personId" });
  const actor = useActor();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const { data } = useSuspenseQuery({
    queryKey: ["workforce-member", personId],
    queryFn: () => getWorkforceMember({ data: { id: personId } }),
  });

  const canVerify = actor.can("documents:verify:all");
  const profile = data.profile;

  async function decide(approve: boolean) {
    setBusy(true);
    try {
      await reviewProfile({ data: note ? { userId: personId, approve, note } : { userId: personId, approve } });
      toast.success(approve ? "Profile verified." : "Sent back for changes.");
      setNote("");
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save that decision.");
    } finally {
      setBusy(false);
    }
  }

  async function openDocument(documentId: string) {
    try {
      const { url } = await getDocumentDownloadUrl({ data: { documentId } });
      window.open(url, "_blank", "noopener");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open that document.");
    }
  }

  async function decideDocument(documentId: string, approve: boolean) {
    try {
      await reviewDocument({ data: { documentId, approve } });
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not review that document.");
    }
  }

  return (
    <AppShell
      title={profile.full_name}
      description={profile.work_email}
      actions={
        <Badge variant="outline">
          {ACCOUNT_STATUS_LABELS[profile.account_status as AccountStatus]}
        </Badge>
      }
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Profile</CardTitle>
            <CardDescription>
              {data.roles.map((r) => ROLE_LABELS[r as AppRole] ?? r).join(", ") || "No role"} ·{" "}
              {CATEGORY_LABELS[profile.category as UserCategory] ?? "—"}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Detail label="Designation" value={profile.designation} />
            <Detail label="Personal email" value={profile.personal_email} />
            <Detail label="Mobile" value={profile.mobile} />
            <Detail label="Date of birth" value={profile.date_of_birth} />
            <Detail label="Institution" value={profile.institution} />
            <Detail
              label="Experience"
              value={profile.experience_years ? `${profile.experience_years} yrs` : null}
            />
            <Detail
              label="Available hours / day"
              value={profile.available_hours_per_day?.toString() ?? null}
            />
            <Detail label="Emergency contact" value={profile.emergency_contact_name} />
            <Detail label="Emergency phone" value={profile.emergency_contact_phone} />
            <Detail
              label="Skills"
              value={(profile.skills ?? []).join(", ") || null}
              className="sm:col-span-2"
            />
            <Detail
              label="Current address"
              value={profile.current_address}
              className="sm:col-span-2"
            />
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Documents</CardTitle>
              <CardDescription>{data.documents.length} uploaded</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.documents.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing uploaded yet.</p>
              ) : null}
              {data.documents.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {DOCUMENT_TYPE_LABELS[doc.doc_type as DocumentType] ?? doc.doc_type}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{doc.status}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openDocument(doc.id)}>
                      Open
                    </Button>
                    {canVerify ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => decideDocument(doc.id, true)}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => decideDocument(doc.id, false)}
                        >
                          Reject
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {canVerify ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Verification decision</CardTitle>
                <CardDescription>
                  Approving activates the account for project allocation.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional note shown to the employee"
                />
                <div className="flex gap-2">
                  <Button disabled={busy} onClick={() => decide(true)}>
                    Verify &amp; activate
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => decide(false)}>
                    Send back
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}

function Detail({
  label,
  value,
  className,
}: {
  label: string;
  value?: string | null;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value || "—"}</p>
    </div>
  );
}
