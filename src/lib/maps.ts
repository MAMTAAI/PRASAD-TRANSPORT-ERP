// 🗺️ Google Maps loader + driving-distance helper.
// Google Maps is the ONLY external API allowed in this app. The key is the
// public client key (VITE_GOOGLE_MAPS_API_KEY). DirectionsService runs in the
// browser (CORS-safe, unlike the REST Directions web service).

const API_KEY = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY || '';

let loadPromise: Promise<any> | null = null;

/**
 * Lazy-load the Maps JS SDK exactly once, and RESOLVE WITH THE `google`
 * NAMESPACE.
 *
 * IT USED TO RESOLVE WITH NOTHING, and that broke click-to-zoom on the
 * dispatch board (owner, 3-Sep-2026: "click karne par zoom nahi hoti, balki
 * world ka map show ho rahi hai"). Every other caller happens to write
 *
 *     await loadGoogleMaps(); const g = (window as any).google;
 *
 * and so never noticed. LiveFleetMap's trip-focus effect — the one that draws
 * the loading→unloading route and then calls fitBounds — wrote the natural
 * thing instead:
 *
 *     const g = await loadGoogleMaps();   // undefined
 *     g.maps.geometry...                  // TypeError: reading 'maps'
 *
 * It threw on the first line that touched `g`, so it never reached fitBounds,
 * and the camera stayed on the world view it was built with. The board still
 * LOOKED fine — tiles, markers and truck rows all come from code paths that
 * read window.google directly — so the failure was visible only as a small
 * "Route nahi bana" note under the trip list.
 *
 * Returning the namespace makes `const g = await loadGoogleMaps()` correct,
 * costs the existing `.then(() => …)` callers nothing, and removes the trap
 * for the next person who writes the obvious thing.
 */
export function loadGoogleMaps(): Promise<any> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  const ready = () => (window as any).google;
  if ((window as any).google?.maps?.DirectionsService) return Promise.resolve(ready());
  if (loadPromise) return loadPromise;
  if (!API_KEY) return Promise.reject(new Error('Google Maps API key missing (VITE_GOOGLE_MAPS_API_KEY)'));

  loadPromise = new Promise<any>((resolve, reject) => {
    const existing = document.getElementById('gmaps-sdk') as HTMLScriptElement | null;
    if (existing) { existing.addEventListener('load', () => resolve(ready())); return; }
    const s = document.createElement('script');
    s.id = 'gmaps-sdk';
    // `geometry` is required for encoding.decodePath — the dispatch map draws
    // route polylines from cached encoded strings, and without this library
    // decodePath is simply undefined and every lane silently fails to render.
    //
    // `places` is required by PlaceInput. Without it AutocompleteService is
    // undefined, the component degrades to a plain text box, and it does so
    // SILENTLY — the autocomplete simply never appears and nothing says why.
    // Verified absent in the browser before this line was fixed.
    //
    // Loading a library costs nothing extra: Maps JS is billed per map load.
    //
    // NO loading=async, deliberately. Google's console nags for it, but with
    // loading=async the SDK defers the libraries and `google.maps.Map` does NOT
    // exist when the script's onload fires — every caller here constructs a Map
    // synchronously on that event, so the whole dispatch board died with
    // "g.maps.Map is not a constructor". Adopting it means moving every consumer
    // to `await google.maps.importLibrary(...)`, which is a real change and not
    // a one-line perf tweak. The warning is the cheaper thing to live with.
    s.src = `https://maps.googleapis.com/maps/api/js?key=${API_KEY}&libraries=geometry,places`;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve(ready());
    s.onerror = () => reject(new Error('Failed to load Google Maps SDK'));
    document.head.appendChild(s);
  });
  return loadPromise;
}

export interface RouteResult {
  oneWayKm: number;
  roundTripKm: number; // RTKM = round-trip kilometers
  durationText: string;
}

/**
 * One driving route between two place strings. Returns one-way + round-trip km.
 * Throws a friendly Error if the route can't be resolved.
 */
export async function getDrivingDistance(origin: string, destination: string): Promise<RouteResult> {
  if (!origin?.trim() || !destination?.trim()) throw new Error('Loading Point and Consignee are both required');
  await loadGoogleMaps();
  const google = (window as any).google;
  const svc = new google.maps.DirectionsService();

  const res: any = await new Promise((resolve, reject) => {
    svc.route(
      {
        origin,
        destination,
        travelMode: google.maps.TravelMode.DRIVING,
        region: 'in',
      },
      (result: any, status: string) => {
        if (status === 'OK' && result) resolve(result);
        else reject(new Error(`Route not found (${status}). Check the place names.`));
      }
    );
  });

  const leg = res.routes?.[0]?.legs?.[0];
  if (!leg) throw new Error('No route legs returned');
  const oneWayKm = (leg.distance?.value || 0) / 1000;
  return {
    oneWayKm: Math.round(oneWayKm * 10) / 10,
    roundTripKm: Math.round(oneWayKm * 2 * 10) / 10,
    durationText: leg.duration?.text || '',
  };
}
