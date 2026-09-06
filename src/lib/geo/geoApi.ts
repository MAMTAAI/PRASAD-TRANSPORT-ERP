// ============================================================================
// geoApi — the small surface between the GeoPicker and the server.
//
// REVERSE GEOCODING GOES THROUGH OUR SERVER, NOT THROUGH THE BROWSER SDK.
// The browser could call google.maps.Geocoder directly and it would work, which
// is exactly the trap: every pin drop by every user on every screen would be a
// fresh billed request, and dragging a pin bills once per release of the mouse.
// The server route caches on the coordinate rounded to about a metre, so one
// gate is one charge for the whole company forever, and a party re-opened a
// hundred times costs nothing after the first.
//
// EVERYTHING FAILS SOFT. A picker that cannot name the spot must still save the
// coordinate — the coordinate is the part that matters and the address is a
// caption. Nothing here throws.
// ============================================================================
import { API_BASE } from '../apiBase';

// NOTE: no authFetch import. installAuthFetch() PATCHES THE GLOBAL fetch to
// attach the bearer token — it is not a wrapper you call. Importing it here
// and calling it would run the installer, not make a request. Plain fetch is
// already authenticated; the trap on the other side of this is uploadMedia,
// which used XHR, was never wrapped, and 401'd every file upload.

export type GeoSource = 'SEARCH' | 'PIN' | 'GPS' | 'IMPORT';

/** What a pinnable party carries. Every field is optional because a party is
 *  real long before anyone has been to it. */
export interface GeoValue {
  lat: number | null;
  lng: number | null;
  geofence_radius: number;
  geo_source?: GeoSource | null;
  /** Not persisted — the caption the picker last resolved, kept for display. */
  address?: string | null;
}

export const EMPTY_GEO: GeoValue = { lat: null, lng: null, geofence_radius: 2000, geo_source: null };

/** The owner's default, and the migration's DEFAULT too. Named rather than
 *  written as `2000` in six places so changing it is one edit. */
export const DEFAULT_RADIUS = 2000;

/** Is there actually a coordinate here?
 *
 *  THE NULL CHECK IS THE WHOLE FUNCTION, and leaving it out is a bug this
 *  codebase has shipped before. `Number(null)` is 0, and `Number('')` is 0, and
 *  0 is perfectly finite — so the obvious
 *
 *      Number.isFinite(Number(g.lat)) && Number.isFinite(Number(g.lng))
 *
 *  reports every UNPINNED party as pinned at 0°N 0°E, a spot in the Gulf of
 *  Guinea about 6,000 km from Assam. Caught in the browser: the form row read
 *  "PINNED · 0.00000, 0.00000" for a party nobody had been near.
 *
 *  It matters beyond the label. A 0,0 pin passes the database's range check,
 *  puts a marker in the ocean on every map, and makes geo_within() answer
 *  "outside" — a confident wrong answer — where NULL would have said "we do
 *  not know". */
export const hasPin = (g?: Partial<GeoValue> | null): boolean => {
  const la = g?.lat;
  const ln = g?.lng;
  if (la === null || la === undefined || la === ('' as unknown)) return false;
  if (ln === null || ln === undefined || ln === ('' as unknown)) return false;
  return Number.isFinite(Number(la)) && Number.isFinite(Number(ln));
};

/** Read the geo fields off any master row, whatever prefix they carry.
 *  `rtkm_master` rows have depot_lat / consignee_lat; everything else is bare. */
export function readGeo(row: any, prefix = ''): GeoValue {
  const p = prefix ? `${prefix}_` : '';
  const lat = row?.[`${p}lat`];
  const lng = row?.[`${p}lng`];
  return {
    lat: lat == null || lat === '' ? null : Number(lat),
    lng: lng == null || lng === '' ? null : Number(lng),
    // A row saved before migration 181 has no radius at all; the owner's 2 km
    // is the answer there, not NaN.
    geofence_radius: Number(row?.[`${p}geofence_radius`]) || DEFAULT_RADIUS,
    geo_source: (row?.[`${p}geo_source`] ?? null) as GeoSource | null,
  };
}

/** Turn a GeoValue back into the columns a PATCH body wants.
 *
 *  geo_updated_at is NOT sent — a trigger owns it (migration 181). A timestamp
 *  from a browser clock is not evidence of when a gate was surveyed. */
export function writeGeo(g: GeoValue, prefix = ''): Record<string, unknown> {
  const p = prefix ? `${prefix}_` : '';
  return {
    [`${p}lat`]: g.lat,
    [`${p}lng`]: g.lng,
    [`${p}geofence_radius`]: g.geofence_radius || DEFAULT_RADIUS,
    // Clearing a pin clears its provenance too; leaving 'PIN' on a null
    // coordinate would describe a pin that is not there.
    [`${p}geo_source`]: hasPin(g) ? (g.geo_source ?? 'PIN') : null,
  };
}

export interface ReverseResult {
  formatted: string | null;
  place_id: string | null;
  cached: boolean;
}

/** What is at this point? Returns null rather than throwing — over water, in
 *  forest, or with the server key unset, the pin still stands. */
export async function reverseGeocode(lat: number, lng: number): Promise<ReverseResult | null> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/maps/reverse-geocode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lng }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return { formatted: j.formatted ?? null, place_id: j.place_id ?? null, cached: !!j.cached };
  } catch { return null; }
}

/** Forward geocode a typed address through the server's cache. Used by the
 *  "use the address I already typed" shortcut, so a party with a written
 *  address does not have to be searched for by hand.
 *
 *  The server REFUSES an answer that only resolves to a whole region
 *  (TOO_COARSE, see googleMaps.js). That refusal is the useful part: it means
 *  this shortcut can never silently drop a pin on the centre of Assam. */
export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number; formatted: string | null } | null> {
  if (!address?.trim()) return null;
  try {
    const res = await fetch(`${API_BASE}/api/v1/maps/geocode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!Number.isFinite(Number(j.lat)) || !Number.isFinite(Number(j.lng))) return null;
    return { lat: Number(j.lat), lng: Number(j.lng), formatted: j.formatted ?? null };
  } catch { return null; }
}

/** How much to trust a pin, in the words the screen uses. */
export function sourceLabel(src?: GeoSource | null): { text: string; exact: boolean } {
  switch (src) {
    case 'GPS':    return { text: 'GPS capture', exact: true };
    case 'PIN':    return { text: 'Exact pinpoint', exact: true };
    case 'IMPORT': return { text: 'Imported · unconfirmed', exact: false };
    case 'SEARCH': return { text: 'Approx · search only', exact: false };
    default:       return { text: 'Pinned', exact: true };
  }
}
