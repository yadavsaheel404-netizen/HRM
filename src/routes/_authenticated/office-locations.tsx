import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { MapPin } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import { errorToAccessScreen } from "@/components/access-denied";
import { listOfficeLocations, saveOfficeLocation } from "@/lib/locations.functions";
import { readBrowserPosition } from "@/lib/geo";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_authenticated/office-locations")({
  head: () => ({
    meta: [
      { title: "Office locations | The AI School HRM" },
      {
        name: "description",
        content:
          "Configure the office sites and geofence radius used to verify work-from-office check-ins.",
      },
      { property: "og:title", content: "Office locations | The AI School HRM" },
      {
        property: "og:description",
        content: "Manage office coordinates and the check-in radius for WFO verification.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: OfficeLocationsPage,
  errorComponent: ({ error }) => errorToAccessScreen(error),
});

const BLANK = {
  id: "",
  name: "",
  address: "",
  latitude: "",
  longitude: "",
  radiusMeters: "70",
  isActive: true,
};

function OfficeLocationsPage() {
  const actor = useActor();
  const queryClient = useQueryClient();
  const canManage = actor.can("org:manage:all");
  const { data } = useSuspenseQuery({
    queryKey: ["office-locations"],
    queryFn: () => listOfficeLocations(),
  });
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await saveOfficeLocation({
        data: {
          ...(form.id ? { id: form.id } : {}),
          name: form.name,
          address: form.address || null,
          latitude: Number(form.latitude),
          longitude: Number(form.longitude),
          radiusMeters: Number(form.radiusMeters),
          isActive: form.isActive,
        },
      });
      toast.success(form.id ? "Office updated." : "Office added.");
      setForm(BLANK);
      await queryClient.invalidateQueries({ queryKey: ["office-locations"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the office.");
    } finally {
      setBusy(false);
    }
  }

  async function useMyPosition() {
    try {
      const pos = await readBrowserPosition();
      setForm((f) => ({
        ...f,
        latitude: String(pos.latitude),
        longitude: String(pos.longitude),
      }));
      toast.success("Coordinates filled from your current position.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Location unavailable.");
    }
  }

  return (
    <AppShell
      title="Office locations"
      description="Work-from-office check-ins are only accepted inside one of these radii."
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Configured offices</CardTitle>
            <CardDescription>
              Only active offices are used to verify a work-from-office check-in.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.offices.length === 0 && (
              <p className="text-sm text-muted-foreground">No offices configured yet.</p>
            )}
            {data.offices.map((office) => (
              <div
                key={office.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3 text-sm"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2 font-medium">
                    <MapPin className="size-4 text-muted-foreground" />
                    {office.name}
                    <Badge variant={office.is_active ? "default" : "secondary"}>
                      {office.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  {office.address && (
                    <p className="text-muted-foreground">{office.address}</p>
                  )}
                  <p className="tabular-nums text-muted-foreground">
                    {Number(office.latitude).toFixed(6)}, {Number(office.longitude).toFixed(6)} ·
                    radius {office.radius_meters}m
                  </p>
                </div>
                {canManage && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      setForm({
                        id: office.id,
                        name: office.name,
                        address: office.address ?? "",
                        latitude: String(office.latitude),
                        longitude: String(office.longitude),
                        radiusMeters: String(office.radius_meters),
                        isActive: office.is_active,
                      })
                    }
                  >
                    Edit
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        {canManage && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{form.id ? "Edit office" : "Add office"}</CardTitle>
              <CardDescription>
                A tighter radius is stricter; GPS accuracy on phones is typically 10–50m.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="office-name">Name</Label>
                <Input
                  id="office-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="AV HUB"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="office-address">Address (optional)</Label>
                <Input
                  id="office-address"
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="office-lat">Latitude</Label>
                  <Input
                    id="office-lat"
                    value={form.latitude}
                    onChange={(e) => setForm({ ...form, latitude: e.target.value })}
                    placeholder="17.440396"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="office-lng">Longitude</Label>
                  <Input
                    id="office-lng"
                    value={form.longitude}
                    onChange={(e) => setForm({ ...form, longitude: e.target.value })}
                    placeholder="78.386981"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="office-radius">Radius (metres)</Label>
                <Input
                  id="office-radius"
                  type="number"
                  min={20}
                  max={5000}
                  value={form.radiusMeters}
                  onChange={(e) => setForm({ ...form, radiusMeters: e.target.value })}
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                />
                Active
              </label>
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} onClick={save}>
                  {form.id ? "Save changes" : "Add office"}
                </Button>
                <Button variant="secondary" onClick={useMyPosition}>
                  Use my position
                </Button>
                {form.id && (
                  <Button variant="ghost" onClick={() => setForm(BLANK)}>
                    Cancel
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
