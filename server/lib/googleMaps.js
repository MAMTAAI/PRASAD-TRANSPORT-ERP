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
export async function geocode(address) {
  if (!norm(address)) return { ok: false, reason: 'BAD_INPUT' };
  const hit = await readCache('GEOCODE', address, '');
  if (hit) return { ok: true, cached: true, ...hit.payload };

  const res = await call('/geocode/json', { address, region: 'in' });
  if (!res.ok) return res;
  const g = res.data.results?.[0];
  if (!g) return { ok: false, reason: 'ZERO_RESULTS' };
  const payload = {
    lat: g.geometry?.location?.lat ?? null,
    lng: g.geometry?.location?.lng ?? null,
    formatted: g.formatted_address ?? null,
  };
  await writeCache('GEOCODE', address, '', payload, null, null);
  return { ok: true, cached: false, ...payload };
}
