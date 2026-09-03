// ═══════════════════════════════════════════════════════════════════════════
// googleMaps.js — Directions and Distance Matrix, called from the SERVER
//
// WHY THESE TWO MOVED OFF THE BROWSER. Maps JS is billed per map LOAD, which a
// browser key handles fine. Directions and Distance Matrix are billed per
// REQUEST, and the key that makes them is in the bundle where anyone can read
// it. HTTP-referrer restrictions do not help: they are a header, and a header
// is whatever a non-browser caller says it is. So the key for these lives here,
// never ships, and is IP-restricted to the box.
//
// CACHE FIRST, ALWAYS. The road from Bongaigaon Refinery to Guwahati does not
// change between page loads. maps_cache (migration 052) already holds the
// answers keyed by normalised lane; this asks Google only on a miss, and one
// lane is then billed once for the whole company rather than once per viewer
// per reload.
//
// FAILS SOFT. Every function returns a result object with `ok:false` and a
// reason rather than throwing. A missing key or a quota stop must degrade the
// map to "distance unavailable" — it must not take down the screen that also
// shows the trip, the driver and the money.
// ═══════════════════════════════════════════════════════════════════════════
import { createHash } from 'node:crypto';
import { query } from '../db/pool.js';

const BASE = 'https://maps.googleapis.com/maps/api';

/** Read at call time, not module load: the key can be added to .env and the
 *  process restarted without editing code, and tests can set it per-case. */
const serverKey = () => (process.env.GOOGLE_MAPS_SERVER_KEY || '').trim();

export const mapsConfigured = () => serverKey().length > 20;

/** Same normalisation the browser cache uses, so a lane cached by either side
 *  is found by the other. Two spellings of one lane paying twice is the whole
 *  thing this table exists to stop. */
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const cacheKey = (kind, origin, destination) =>
  createHash('sha256').update(`${kind}|${norm(origin)}|${norm(destination)}`).digest('hex');

async function readCache(kind, origin, destination) {
  const key = cacheKey(kind, origin, destination);
  const { rows } = await query(
    `UPDATE maps_cache SET hits = hits + 1, last_used = now()
      WHERE cache_key = $1 RETURNING payload, distance_m, duration_s, fetched_at`, [key]);
  return rows[0] ?? null;
}

async function writeCache(kind, origin, destination, payload, distance_m, duration_s) {
  await query(`
    INSERT INTO maps_cache (cache_key, kind, origin, destination, payload, distance_m, duration_s)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
    ON CONFLICT (cache_key) DO UPDATE
      SET payload = EXCLUDED.payload, distance_m = EXCLUDED.distance_m,
          duration_s = EXCLUDED.duration_s, fetched_at = now(), last_used = now()`,
    [cacheKey(kind, origin, destination), kind, origin, destination,
     JSON.stringify(payload), distance_m, duration_s]);
}

async function call(path, params) {
  const key = serverKey();
  if (!key) {
    return { ok: false, reason: 'NO_SERVER_KEY',
      detail: 'GOOGLE_MAPS_SERVER_KEY is not set — Directions and Distance Matrix are unavailable' };
  }
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries({ ...params, key })) url.searchParams.set(k, v);

  // A hung Google call must not hold a request open indefinitely; dispatch
  // would rather have "unavailable" in 8 seconds than a spinner forever.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) return { ok: false, reason: 'HTTP_ERROR', detail: `Google returned ${r.status}` };
    // Google answers 200 with a status field; REQUEST_DENIED here almost always
    // means the key is restricted to referrers rather than to this box's IP.
    if (j.status !== 'OK' && j.status !== 'ZERO_RESULTS') {
      return { ok: false, reason: j.status,
        detail: j.error_message
          || (j.status === 'REQUEST_DENIED'
            ? 'Google refused the key. A server key must be IP-restricted, not HTTP-referrer restricted.'
            : `Google returned ${j.status}`) };
    }
    return { ok: true, data: j };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', detail: e.message };
  } finally { clearTimeout(timer); }
}

// ── Directions ─────────────────────────────────────────────────────────────
export async function getRoute(origin, destination, { refresh = false } = {}) {
  if (!norm(origin) || !norm(destination)) {
    return { ok: false, reason: 'BAD_INPUT', detail: 'origin and destination are both required' };
  }
  if (!refresh) {
    const hit = await readCache('DIRECTIONS', origin, destination);
    if (hit) {
      return { ok: true, cached: true, polyline: hit.payload?.polyline ?? '',
        distance_m: hit.distance_m, duration_s: hit.duration_s,
        summary: hit.payload?.summary ?? null, fetched_at: hit.fetched_at };
    }
  }

  const res = await call('/directions/json', {
    origin, destination, mode: 'driving', region: 'in', units: 'metric',
  });
  if (!res.ok) return res;
  const route = res.data.routes?.[0];
  if (!route) return { ok: false, reason: 'ZERO_RESULTS', detail: 'Google found no road route for that pair' };

  const leg = route.legs?.[0] ?? {};
  const payload = {
    polyline: route.overview_polyline?.points ?? '',
    summary: route.summary ?? null,
    start_address: leg.start_address ?? null,
    end_address: leg.end_address ?? null,
    // The bounds let a client fit the map without decoding the polyline first.
    bounds: route.bounds ?? null,
  };
  const distance_m = leg.distance?.value ?? null;
  const duration_s = leg.duration?.value ?? null;
  await writeCache('DIRECTIONS', origin, destination, payload, distance_m, duration_s);
  return { ok: true, cached: false, ...payload, distance_m, duration_s };
}

// ── Distance Matrix ────────────────────────────────────────────────────────
// One call, many pairs — which is exactly why it is worth caching per PAIR and
// only asking Google for the ones that missed. Asking for 20 lanes when 18 are
// already known is 18 requests of somebody's money.
export async function getDistanceMatrix(origins, destinations) {
  const pairs = [];
  for (const o of origins) for (const d of destinations) pairs.push({ origin: o, destination: d });

  const out = [];
  const misses = [];
  for (const p of pairs) {
    const hit = await readCache('DISTANCE_MATRIX', p.origin, p.destination);
    if (hit) out.push({ ...p, distance_m: hit.distance_m, duration_s: hit.duration_s, cached: true });
    else misses.push(p);
  }
  if (misses.length === 0) return { ok: true, results: out, billed_pairs: 0 };

  const uo = [...new Set(misses.map((m) => m.origin))];
  const ud = [...new Set(misses.map((m) => m.destination))];
  const res = await call('/distancematrix/json', {
    origins: uo.join('|'), destinations: ud.join('|'),
    mode: 'driving', region: 'in', units: 'metric',
  });
  if (!res.ok) {
    // Return what the cache DID have rather than nothing. Partial data with a
    // stated reason beats an empty table that looks like "no routes exist".
    return { ok: out.length > 0, partial: true, results: out, error: res };
  }

  const rows = res.data.rows ?? [];
  for (let i = 0; i < uo.length; i += 1) {
    for (let j = 0; j < ud.length; j += 1) {
      const el = rows[i]?.elements?.[j];
      if (!el || el.status !== 'OK') continue;
      const rec = { origin: uo[i], destination: ud[j],
        distance_m: el.distance?.value ?? null, duration_s: el.duration?.value ?? null, cached: false };
      await writeCache('DISTANCE_MATRIX', rec.origin, rec.destination,
        { distance_text: el.distance?.text, duration_text: el.duration?.text },
        rec.distance_m, rec.duration_s);
      out.push(rec);
    }
  }
  return { ok: true, results: out, billed_pairs: misses.length };
}

// ── Geocode, for markers on an address the ERP only holds as text ──────────
// A GEOCODE THAT LANDS ON THE WHOLE COUNTRY IS NOT AN ANSWER.
//
// Depot names here are codes — "2377", "P2663 - CHAMPARAN LPG PLANT". Ask
// Google for "2377, India" and it cheerfully returns India: types ['country'],
// centre 20.5937, 78.9629. Taking results[0] blindly then hands the map a real
// pair of coordinates, so nothing downstream can tell it apart from a depot —
// and fitBounds over (centre of India ∪ Guwahati) frames the subcontinent.
// That is the "world ka map show ho rahi hai" the owner reported.
//
// Two guards, because one is not enough:
//   1. TYPES, for fresh lookups: country / state / district level is refused.
//   2. THE CENTROID, for rows already sitting in maps_cache from before this
//      check existed. Anything within ~1 km of 20.5937,78.9629 is that
//      fallback, not a plant, whatever the cache says.
// Refusing is the useful answer: the map then draws nothing for that end and
// says the name was not recognised, instead of planting a pin in Maharashtra.
const INDIA_CENTROID = { lat: 20.5937, lng: 78.9629 };
const TOO_COARSE_TYPES = new Set([
  'country', 'administrative_area_level_1', 'administrative_area_level_2', 'political',
]);

function coarseReason(payload, types) {
  if (payload.lat == null || payload.lng == null) return 'ZERO_RESULTS';
  if (Math.abs(payload.lat - INDIA_CENTROID.lat) < 0.01
   && Math.abs(payload.lng - INDIA_CENTROID.lng) < 0.01) return 'TOO_COARSE';
  // 'political' alone is a country/state marker; it also tags real localities,
  // so it only disqualifies when nothing more specific came back with it.
  if (Array.isArray(types) && types.length
      && types.every((t) => TOO_COARSE_TYPES.has(t))) return 'TOO_COARSE';
  return null;
}

export async function geocode(address) {
  if (!norm(address)) return { ok: false, reason: 'BAD_INPUT' };
  const hit = await readCache('GEOCODE', address, '');
  if (hit) {
    const bad = coarseReason(hit.payload, hit.payload?.types);
    if (bad) {
      return { ok: false, reason: bad, cached: true,
               detail: `"${address}" only resolves to ${hit.payload?.formatted ?? 'a whole region'} — too coarse to put on a map` };
    }
    return { ok: true, cached: true, ...hit.payload };
  }

  const res = await call('/geocode/json', { address, region: 'in' });
  if (!res.ok) return res;
  const g = res.data.results?.[0];
  if (!g) return { ok: false, reason: 'ZERO_RESULTS' };
  const payload = {
    lat: g.geometry?.location?.lat ?? null,
    lng: g.geometry?.location?.lng ?? null,
    formatted: g.formatted_address ?? null,
    // Kept so the guard above can judge a CACHED row on the same evidence as a
    // fresh one, instead of re-asking Google to find out what it already said.
    types: Array.isArray(g.types) ? g.types : null,
  };
  const bad = coarseReason(payload, payload.types);
  // Still cached — a refusal is worth remembering too, or every map click
  // re-asks Google the same unanswerable question and pays for it.
  await writeCache('GEOCODE', address, '', payload, null, null);
  if (bad) {
    return { ok: false, reason: bad,
             detail: `"${address}" only resolves to ${payload.formatted ?? 'a whole region'} — too coarse to put on a map` };
  }
  return { ok: true, cached: false, ...payload };
}
