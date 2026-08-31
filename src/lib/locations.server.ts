// Server-only helpers for office-location lookups used by check-in.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { OfficeLocation } from "./geo";

type Client = SupabaseClient<Database>;

export const OFFICE_SELECT = "id, name, address, latitude, longitude, radius_meters, is_active";

export async function loadActiveOffices(supabase: Client): Promise<OfficeLocation[]> {
  const { data, error } = await supabase
    .from("office_locations")
    .select(OFFICE_SELECT)
    .eq("is_active", true);
  if (error) throw error;
  return (data ?? []).map((o) => ({
    id: o.id,
    name: o.name,
    address: o.address,
    latitude: Number(o.latitude),
    longitude: Number(o.longitude),
    radius_meters: Number(o.radius_meters),
    is_active: o.is_active,
  }));
}
