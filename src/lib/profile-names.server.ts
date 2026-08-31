// One way to resolve a person's display name anywhere in the portal.
//
// Embedded `profiles(full_name)` joins silently return NULL when the viewer
// has no direct RLS access to that profile row — a reviewer's dashboard would
// then show a nameless row instead of failing loudly. `profile_names()` is a
// security-definer helper that exposes ONLY name + designation, so every
// dashboard and export resolves names the same way.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Client = SupabaseClient<Database>;

export type PersonName = { id: string; fullName: string; designation: string | null };

export async function loadProfileNames(
  supabase: Client,
  ids: (string | null | undefined)[],
): Promise<Map<string, PersonName>> {
  const unique = Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
  const map = new Map<string, PersonName>();
  if (unique.length === 0) return map;

  const { data, error } = await supabase.rpc("profile_names", { _ids: unique });
  if (error) throw error;

  for (const row of (data ?? []) as { id: string; full_name: string; designation: string | null }[]) {
    map.set(row.id, {
      id: row.id,
      fullName: row.full_name ?? "",
      designation: row.designation ?? null,
    });
  }
  return map;
}

export function nameOf(map: Map<string, PersonName>, id: string | null | undefined): string {
  if (!id) return "";
  return map.get(id)?.fullName ?? "";
}
