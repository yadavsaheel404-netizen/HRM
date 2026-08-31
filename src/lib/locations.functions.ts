import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "./actor.server";
import { writeAudit } from "./audit.server";
import { OFFICE_SELECT } from "./locations.server";

export const listOfficeLocations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("office_locations")
      .select(OFFICE_SELECT)
      .order("name");
    if (error) throw error;
    return { offices: data ?? [] };
  });

export type OfficeLocationInput = {
  id?: string;
  name: string;
  address?: string | null;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  isActive: boolean;
};

export const saveOfficeLocation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: OfficeLocationInput) => {
    if (!input?.name?.trim()) throw new Error("Give the office a name.");
    if (!Number.isFinite(input.latitude) || Math.abs(input.latitude) > 90)
      throw new Error("Latitude must be between -90 and 90.");
    if (!Number.isFinite(input.longitude) || Math.abs(input.longitude) > 180)
      throw new Error("Longitude must be between -180 and 180.");
    if (!Number.isFinite(input.radiusMeters) || input.radiusMeters < 20 || input.radiusMeters > 5000)
      throw new Error("The radius must be between 20 and 5000 metres.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "org:manage:all");

    const payload = {
      name: data.name.trim(),
      address: data.address?.trim() || null,
      latitude: data.latitude,
      longitude: data.longitude,
      radius_meters: Math.round(data.radiusMeters),
      is_active: data.isActive,
    };

    const { data: row, error } = data.id
      ? await supabase
          .from("office_locations")
          .update(payload)
          .eq("id", data.id)
          .select(OFFICE_SELECT)
          .single()
      : await supabase
          .from("office_locations")
          .insert({ ...payload, created_by: userId })
          .select(OFFICE_SELECT)
          .single();
    if (error) throw error;

    await writeAudit(supabase, {
      actorId: userId,
      action: data.id ? "office_location.updated" : "office_location.created",
      entityType: "office_location",
      entityId: row.id,
      detail: payload,
    });

    return { office: row };
  });
