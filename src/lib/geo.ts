/** Client-safe geo helpers shared by the check-in UI and the server-side gate. */

export type Coords = { latitude: number; longitude: number; accuracy?: number | null };

export type OfficeLocation = {
  id: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  radius_meters: number;
  is_active: boolean;
};

/** Great-circle distance in metres (haversine). */
export function distanceMeters(a: Coords, b: { latitude: number; longitude: number }): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Nearest configured office and whether the reading falls inside its radius. */
export function nearestOffice(coords: Coords, offices: OfficeLocation[]) {
  const active = offices.filter((o) => o.is_active);
  const first = active[0];
  if (!first) return null;
  let best: { office: OfficeLocation; distance: number } = {
    office: first,
    distance: distanceMeters(coords, first),
  };
  for (const office of active.slice(1)) {
    const distance = distanceMeters(coords, office);
    if (distance < best.distance) best = { office, distance };
  }
  return { ...best, withinRadius: best.distance <= Number(best.office.radius_meters) };
}

export const LOCATION_STATUS_LABELS: Record<string, string> = {
  verified: "Location verified",
  not_required: "Not required for this work mode",
  not_provided: "Not provided",
  failed: "Outside office radius",
};

/** Work modes that must be proven on-site. */
export const LOCATION_REQUIRED_MODES = ["wfo"] as const;
export const requiresLocation = (mode: string) =>
  (LOCATION_REQUIRED_MODES as readonly string[]).includes(mode);

/** Reads the device position once, with a sane timeout for indoor GPS. */
export function readBrowserPosition(): Promise<Coords> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("This device cannot share a location, so office check-in is unavailable."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      (err) =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? "Location access is required to check in as Work from office. Allow location, or pick a different work mode."
              : "We could not read your location. Move near a window or try again, or pick a different work mode.",
          ),
        ),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  });
}
