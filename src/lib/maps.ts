// 🗺️ Google Maps loader + driving-distance helper.
// Google Maps is the ONLY external API allowed in this app. The key is the
// public client key (VITE_GOOGLE_MAPS_API_KEY). DirectionsService runs in the
// browser (CORS-safe, unlike the REST Directions web service).

const API_KEY = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY || '';

let loadPromise: Promise<void> | null = null;

/** Lazy-load the Maps JS SDK exactly once. */
export function loadGoogleMaps(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if ((window as any).google?.maps?.DirectionsService) return Promise.resolve();
  if (loadPromise) return loadPromise;
  if (!API_KEY) return Promise.reject(new Error('Google Maps API key missing (VITE_GOOGLE_MAPS_API_KEY)'));

  loadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById('gmaps-sdk') as HTMLScriptElement | null;
    if (existing) { existing.addEventListener('load', () => resolve()); return; }
    const s = document.createElement('script');
    s.id = 'gmaps-sdk';
    s.src = `https://maps.googleapis.com/maps/api/js?key=${API_KEY}`;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
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
