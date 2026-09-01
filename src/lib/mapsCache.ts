// 🗺️ Cache-first Directions.
//
// The billed call is the one that matters. A dispatch board with 12 moving
// trucks asks Google for 12 routes; five people watching it asks 60 times; a
// reload asks again. The routes are identical every time — the road from
// Bongaigaon Refinery to Guwahati does not change between page loads.
//
// So: ask our server first. On a miss, ask Google through the Maps JS SDK
// (browser key, CORS-safe, no server key anywhere), then post the answer back
// so the next caller — any user, any reload — gets it free.
//
// An in-flight map deduplicates concurrent requests for the same route within a
// single page, which is the other way this gets billed twice: twelve markers
// mounting at once, all asking for the same lane.
import { API_BASE } from './apiBase';
import { loadGoogleMaps } from './maps';

export interface RouteResult {
  polyline: string;          // encoded overview polyline
  distance_m: number | null;
  duration_s: number | null;
  cached: boolean;
}

/**
 * Turn a depot label into something a map can find.
 *
 * The register stores operational names, not addresses: "ZC7A04 - Chabua AFS",
 * "Rail fed POL Storage Depot (7D18)", "Lumding Terminal (7T04)". The codes are
 * meaningful inside IOCL and meaningless to Google, and they actively hurt —
 * a geocoder handed "ZC7A04" looks for somewhere called ZC7A04 and takes the
 * rest as a weak hint, which is how a Tinsukia depot became a route through
 * the Altai republic.
 *
 * So: drop the codes, drop the leading plant prefix, and say which country.
 * The cache key is the ORIGINAL string, so cleaning does not orphan anything
 * already stored.
 */
function mapQuery(raw: string): string {
  let s = String(raw ?? '').trim();
  s = s.replace(/\(\s*\d[A-Z0-9]*\s*\)/gi, ' ');   // "(7T04)", "(7D18)"
  s = s.replace(/^\s*[A-Z]{1,3}\d[A-Z0-9]*\s*[-–]\s*/i, ''); // "ZC7A04 - "
  s = s.replace(/\b\d{4,}\b/g, ' ');               // bare plant numbers
  s = s.replace(/\s{2,}/g, ' ').replace(/[\s,–-]+$/, '').trim();
  if (!s) return String(raw ?? '').trim();
  return /india/i.test(s) ? s : `${s}, India`;
}

const inFlight = new Map<string, Promise<RouteResult | null>>();
const localKey = (o: string, d: string) => `${o}→${d}`.toLowerCase().replace(/\s+/g, ' ').trim();

async function readCache(origin: string, destination: string): Promise<RouteResult | null> {
  try {
    const q = new URLSearchParams({ kind: 'DIRECTIONS', origin, destination });
    const res = await fetch(`${API_BASE}/api/v1/maps/cache?${q}`);
    if (!res.ok) return null;
    const j = await res.json();
    if (!j.hit) return null;
    return {
      polyline: j.payload?.polyline ?? '',
      distance_m: j.distance_m ?? null,
      duration_s: j.duration_s ?? null,
      cached: true,
    };
  } catch { return null; }
}

async function writeCache(origin: string, destination: string, r: RouteResult) {
  try {
    await fetch(`${API_BASE}/api/v1/maps/cache`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'DIRECTIONS', origin, destination,
        payload: { polyline: r.polyline },
        distance_m: r.distance_m, duration_s: r.duration_s,
      }),
    });
  } catch { /* a cache write failing costs one future lookup, nothing else */ }
}

/** Resolve a driving route, preferring the shared cache. Returns null when the
 *  route cannot be resolved (unknown place name, no key, quota exhausted) —
 *  callers draw nothing rather than a guessed straight line. */
export async function getRoute(origin?: string | null, destination?: string | null): Promise<RouteResult | null> {
  if (!origin || !destination) return null;
  const k = localKey(origin, destination);
  const existing = inFlight.get(k);
  if (existing) return existing;

  const job = (async (): Promise<RouteResult | null> => {
    const hit = await readCache(origin, destination);
    if (hit) return hit;

    try {
      await loadGoogleMaps();
      const g = (window as any).google;
      const svc = new g.maps.DirectionsService();
      const result: any = await new Promise((resolve, reject) => {
        svc.route(
          {
            // Cleaned for the map; the CACHE KEY stays the ORIGINAL string,
            // so tidying the query does not orphan anything already stored.
            origin: mapQuery(origin),
            destination: mapQuery(destination),
            travelMode: g.maps.TravelMode.DRIVING,
            // WITHOUT THIS THE MAP LANDS IN SIBERIA. Verified: asking for
            // "Lumding Terminal (7T04)" → "ZC7A04 - Chabua AFS" with no bias
            // returned a route through the Altai republic, and the camera
            // dutifully flew to Gorno-Altaysk. Depot names here are short,
            // abbreviated and locally unique — "Lumding", "NRL", "Chabua" —
            // which is exactly the shape that matches something unrelated on
            // the other side of the planet. `region` biases the search to the
            // Indian ccTLD, which is where every one of these trucks is.
            region: 'in',
            // Freight reality: trucks are not routed onto ferries here.
            avoidFerries: true,
          },
          (res: any, statusText: string) => (statusText === 'OK' ? resolve(res) : reject(new Error(statusText))),
        );
      });

      const leg = result.routes?.[0]?.legs?.[0];
      const out: RouteResult = {
        polyline: result.routes?.[0]?.overview_polyline ?? result.routes?.[0]?.overview_path
          ? (result.routes[0].overview_polyline?.points
             ?? g.maps.geometry?.encoding?.encodePath?.(result.routes[0].overview_path)
             ?? '')
          : '',
        distance_m: leg?.distance?.value ?? null,
        duration_s: leg?.duration?.value ?? null,
        cached: false,
      };
      if (out.polyline) writeCache(origin, destination, out);
      return out;
    } catch {
      // ZERO_RESULTS / NOT_FOUND / OVER_QUERY_LIMIT all land here. Returning
      // null means "no route drawn", which is honest; drawing origin→
      // destination as a straight line would imply a road that isn't there.
      return null;
    } finally {
      inFlight.delete(k);
    }
  })();

  inFlight.set(k, job);
  return job;
}
