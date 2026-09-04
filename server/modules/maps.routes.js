// server/modules/maps.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// The shared cache in front of Google's BILLED endpoints.
//
// The browser still calls Google — Directions/Geocoding/DistanceMatrix run
// through the Maps JS SDK, which is CORS-safe and uses the referrer-restricted
// browser key, so no server-side key is needed and none is stored here. What
// the server does is REMEMBER the answer, so the second person to open the
// dispatch board (and the same person after a reload) does not re-bill a route
// that has not changed.
//
// This is where the cost actually is. Map loads and marker movement are not
// billed per request; Directions and Distance Matrix are. Sockets do not save a
// rupee of Google spend — this table does.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { query, isDegraded } from '../db/pool.js';
import { getRoute, getDistanceMatrix, geocode, mapsConfigured } from '../lib/googleMaps.js';
// THE SAME FILE THE BROWSER USES. Not a copy of the rule — the rule. The
// driver's phone gets its map from this endpoint and has no access to the app's
// own code, so if the two ever drifted the office would see a route and the
// driver would see two pins and empty space. It is plain ESM for exactly this
// reason; see the header in that file.
import { placeOf } from '../../src/lib/tripPlaces.core.mjs';

const dbGate = (reply) =>
  reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });

const KINDS = new Set(['DIRECTIONS', 'GEOCODE', 'DISTANCE_MATRIX']);

// Location names are typed by humans and arrive with erratic spacing, case and
// punctuation ("IOC  CELL  PETRONAS , KASBERIA"). Without this every spelling
// variant is a cache miss and a fresh charge.
const norm = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const keyOf = (kind, origin, destination) =>
  createHash('sha256').update(`${kind}|${norm(origin)}|${norm(destination)}`).digest('hex').slice(0, 40);

// How long a cached route stays trusted. Road geometry changes, but not hourly;
// 30 days keeps the hit rate high while guaranteeing everything is re-resolved
// eventually.
const MAX_AGE_DAYS = 30;

export function registerMapsRoutes(app) {
  // ── read ──────────────────────────────────────────────────────────────────
  // A miss is a 200 with hit:false, not a 404: "we have not cached this" is a
  // normal answer to a normal question, and a 404 would show up in logs as an
  // error on the happy path.
  app.get('/maps/cache', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const kind = String(req.query?.kind ?? 'DIRECTIONS').toUpperCase();
    if (!KINDS.has(kind)) return reply.code(400).send({ error: 'BAD_KIND' });
    const { origin, destination } = req.query ?? {};
    if (!origin) return reply.code(400).send({ error: 'MISSING_ORIGIN' });

    const cacheKey = keyOf(kind, origin, destination);
    const { rows } = await query(
      `SELECT payload, distance_m, duration_s, fetched_at
         FROM maps_cache
        WHERE cache_key = $1 AND fetched_at > now() - ($2 || ' days')::interval`,
      [cacheKey, String(MAX_AGE_DAYS)]);

    if (!rows.length) return { hit: false, cache_key: cacheKey };

    // Usage stats are what tell you whether the cache is earning its keep.
    // Fire-and-forget: a stats update must never delay the answer.
    query('UPDATE maps_cache SET hits = hits + 1, last_used = now() WHERE cache_key = $1', [cacheKey])
      .catch(() => {});

    return {
      hit: true,
      cache_key: cacheKey,
      payload: rows[0].payload,
      distance_m: rows[0].distance_m,
      duration_s: rows[0].duration_s,
      fetched_at: rows[0].fetched_at,
    };
  });

  // ── write ─────────────────────────────────────────────────────────────────
  // The client posts back what Google returned, so the next caller gets it free.
  app.post('/maps/cache', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const kind = String(b.kind ?? 'DIRECTIONS').toUpperCase();
    if (!KINDS.has(kind)) return reply.code(400).send({ error: 'BAD_KIND' });
    if (!b.origin || !b.payload) return reply.code(400).send({ error: 'MISSING_FIELDS' });

    // A payload big enough to be a whole map tile set is not a route; refuse it
    // rather than let one caller fill the table.
    const encoded = JSON.stringify(b.payload);
    if (encoded.length > 200_000) return reply.code(413).send({ error: 'PAYLOAD_TOO_LARGE' });

    const cacheKey = keyOf(kind, b.origin, b.destination);
    await query(
      `INSERT INTO maps_cache (cache_key, kind, origin, destination, payload, distance_m, duration_s)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       ON CONFLICT (cache_key) DO UPDATE
         SET payload = EXCLUDED.payload,
             distance_m = EXCLUDED.distance_m,
             duration_s = EXCLUDED.duration_s,
             fetched_at = now(),
             last_used = now()`,
      [cacheKey, kind, String(b.origin).slice(0, 300), b.destination ? String(b.destination).slice(0, 300) : null,
       encoded,
       Number.isFinite(b.distance_m) ? Math.round(b.distance_m) : null,
       Number.isFinite(b.duration_s) ? Math.round(b.duration_s) : null]);

    reply.code(201);
    return { ok: true, cache_key: cacheKey };
  });

  // ── how much is this saving ───────────────────────────────────────────────
  // ── SERVER-SIDE DIRECTIONS ────────────────────────────────────────────────
  // The browser can still do this through the Maps JS SDK, and does for the
  // dispatch board. This exists for the callers that must NOT hold a key: the
  // Smart Load Bazaar analysis, and anything running unattended.
  app.post('/maps/route', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { origin, destination, refresh } = req.body ?? {};
    const r = await getRoute(origin, destination, { refresh: !!refresh });
    if (!r.ok) {
      // 502 not 500: this is an upstream refusal, and the distinction is what
      // tells an operator "Google said no" from "our server broke".
      const code = r.reason === 'BAD_INPUT' ? 400 : r.reason === 'NO_SERVER_KEY' ? 503 : 502;
      return reply.code(code).send({ error: r.reason, detail: r.detail });
    }
    return r;
  });

  app.post('/maps/distance-matrix', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const origins = Array.isArray(req.body?.origins) ? req.body.origins.filter(Boolean) : [];
    const destinations = Array.isArray(req.body?.destinations) ? req.body.destinations.filter(Boolean) : [];
    if (!origins.length || !destinations.length) {
      return reply.code(400).send({ error: 'BAD_INPUT', detail: 'origins[] and destinations[] are required' });
    }
    // A 25x25 request is 625 billed pairs from one careless click.
    if (origins.length * destinations.length > 100) {
      return reply.code(400).send({
        error: 'TOO_MANY_PAIRS',
        detail: `${origins.length} x ${destinations.length} is ${origins.length * destinations.length} billed pairs; the cap is 100`,
      });
    }
    return getDistanceMatrix(origins, destinations);
  });

  app.post('/maps/geocode', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const r = await geocode(req.body?.address);
    if (!r.ok) {
      const code = r.reason === 'BAD_INPUT' ? 400 : r.reason === 'NO_SERVER_KEY' ? 503 : 502;
      return reply.code(code).send({ error: r.reason, detail: r.detail });
    }
    return r;
  });

  // ── ONE TRIP, EVERYTHING THE MAP NEEDS ────────────────────────────────────
  //
  // The tracking screen was geocoding origin and destination IN THE BROWSER on
  // every trip selection: uncached, billed each time, and re-billed when the
  // same trip was clicked twice. It also never drew a road at all — only a trail
  // joining GPS pings, so a trip with no telemetry showed two pins and empty
  // space between them.
  //
  // This returns the lane's road geometry and its endpoints in one call, both
  // served from maps_cache after the first fetch, plus the latest real fix if
  // there is one.
  //
  // THE TRUCK POSITION IS NOT INVENTED. `truck` is null unless trip_gps_pings
  // holds an actual row. Interpolating a position from "departed at 9am, 178km
  // to go" would put a marker on the map that looks exactly like a real fix and
  // is a guess — on the screen dispatch uses to decide whether a lorry is off
  // route.
  app.get('/maps/trip/:tripId/route', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows: t } = await query(`
      SELECT id, trip_code, vehicle_no, status, driver_name,
             loading_point, COALESCE(unloading_location, consignee_name) AS destination,
             loading_date
        FROM trips WHERE id = $1::uuid`, [req.params.tripId]);
    if (!t[0]) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'no such trip' });
    const trip = t[0];

    // WHAT THE REGISTER STORES IS NOT WHAT A GEOCODER CAN FIND. On every trip
    // imported from IOCL, loading_point is the literal code "7D18"; this used to
    // ask Google for "7D18, India", get nothing, and return origin:null — which
    // is why the driver app drew a destination pin and empty space where the
    // road belongs. placeOf() resolves the code to the name this company already
    // uses for that depot, and refuses to guess for codes nobody has named.
    const from = placeOf(trip.loading_point);
    const to = placeOf(trip.destination);

    const [route, o, d] = await Promise.all([
      from.query && to.query
        ? getRoute(from.query, to.query)
        : Promise.resolve({ ok: false, reason: 'UNPLACEABLE',
            detail: `cannot place ${[!from.query && from.label, !to.query && to.label].filter(Boolean).join(' and ')}` }),
      geocode(from.query || ''),
      geocode(to.query || ''),
    ]);

    const { rows: ping } = await query(`
      SELECT lat, lng, speed_kmh, source, recorded_at
        FROM trip_gps_pings WHERE trip_id = $1::uuid
       ORDER BY recorded_at DESC LIMIT 1`, [req.params.tripId]);

    const { rows: trail } = await query(`
      SELECT lat, lng, recorded_at FROM trip_gps_pings
       WHERE trip_id = $1::uuid ORDER BY recorded_at ASC LIMIT 500`, [req.params.tripId]);

    return {
      trip: {
        id: trip.id, trip_code: trip.trip_code, vehicle_no: trip.vehicle_no,
        status: trip.status, driver_name: trip.driver_name,
        loading_point: trip.loading_point, destination: trip.destination,
      },
      // `label` stays what the register holds — the office knows these depots by
      // their codes and a screen that silently renames them is a screen nobody
      // trusts. `resolved` is what Google actually pinned, so a wrong pin is
      // visible rather than mysterious.
      origin: o.ok ? { lat: o.lat, lng: o.lng, label: from.label, resolved: o.formatted } : null,
      destination: d.ok ? { lat: d.lat, lng: d.lng, label: to.label, resolved: d.formatted } : null,
      unplaceable: (from.unresolved || to.unresolved || !from.query || !to.query)
        ? { origin: !from.query ? from.label : null, destination: !to.query ? to.label : null }
        : null,
      route: route.ok
        ? { polyline: route.polyline, distance_km: route.distance_m == null ? null : +(route.distance_m / 1000).toFixed(1),
            duration_min: route.duration_s == null ? null : Math.round(route.duration_s / 60),
            summary: route.summary, bounds: route.bounds, cached: !!route.cached }
        : { polyline: null, error: route.reason, detail: route.detail },
      // Real fixes only. Null means nobody knows where the lorry is, and the
      // screen must say that rather than draw a plausible dot.
      truck: ping[0] ? {
        lat: Number(ping[0].lat), lng: Number(ping[0].lng),
        speed_kmh: ping[0].speed_kmh, source: ping[0].source, at: ping[0].recorded_at,
      } : null,
      trail: trail.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), at: p.recorded_at })),
      telemetry: {
        pings: trail.length,
        note: trail.length === 0
          ? 'No device has ever reported a position for this trip. The lane is drawn from the road network; the vehicle is not placed.'
          : null,
      },
    };
  });

  // ── LANE ANALYSIS: distance from Google, tolls from our own history ───────
  //
  // The screen that calls this used to fabricate both. Distance was
  // Math.random() between 150 and 1200 with four hardcoded lanes, and the toll
  // was distance/60 x 145. That number went onto a real load and vendors bid
  // against it.
  //
  // Distance now comes from Directions. Tolls come from what the fleet ACTUALLY
  // paid on that corridor — toll_transactions holds 3,883 real crossings — and
  // when a lane has no history it says so instead of producing a figure. An
  // operator who knows the number is a guess can override it; one who thinks it
  // was computed cannot.
  app.post('/maps/lane-analysis', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { origin, destination } = req.body ?? {};
    if (!origin?.trim() || !destination?.trim()) {
      return reply.code(400).send({ error: 'BAD_INPUT', detail: 'origin and destination are required' });
    }

    const route = await getRoute(origin, destination);

    // Trips that actually ran this lane, and what toll they actually incurred.
    // Matched loosely (ILIKE both ways) because the ERP spells a depot three
    // ways and an exact match would report "no history" for a lane run weekly.
    const { rows: toll } = await query(`
      WITH lane AS (
        SELECT t.id
          FROM trips t
         WHERE (t.loading_point ILIKE '%' || $1 || '%' OR $1 ILIKE '%' || COALESCE(t.loading_point,'~') || '%')
           AND (COALESCE(t.unloading_location, t.consignee_name) ILIKE '%' || $2 || '%'
                OR $2 ILIKE '%' || COALESCE(t.unloading_location, t.consignee_name, '~') || '%')
      ), per_trip AS (
        SELECT l.id, COALESCE(sum(tx.amount), 0) AS toll_amt, count(tx.id)::int AS plazas
          FROM lane l LEFT JOIN toll_transactions tx ON tx.trip_id = l.id
         GROUP BY l.id
      )
      SELECT count(*)::int                                            AS trips_on_lane,
             count(*) FILTER (WHERE toll_amt > 0)::int                AS trips_with_toll,
             COALESCE(round(percentile_cont(0.5) WITHIN GROUP (ORDER BY toll_amt)
                            FILTER (WHERE toll_amt > 0))::int, 0)     AS median_toll,
             COALESCE(round(avg(plazas) FILTER (WHERE toll_amt > 0))::int, 0) AS median_plazas
        FROM per_trip`, [origin.trim(), destination.trim()]);

    const t = toll[0] ?? {};
    return {
      distance: route.ok
        ? { km: route.distance_m == null ? null : +(route.distance_m / 1000).toFixed(1),
            duration_min: route.duration_s == null ? null : Math.round(route.duration_s / 60),
            polyline: route.polyline, summary: route.summary, cached: !!route.cached,
            source: 'google_directions' }
        : { km: null, source: 'unavailable', error: route.reason, detail: route.detail },
      toll: t.trips_with_toll > 0
        ? { amount: t.median_toll, plazas: t.median_plazas,
            source: 'fleet_history',
            basis: `median of ${t.trips_with_toll} trip(s) actually run on this lane` }
        : { amount: null, plazas: null, source: 'no_history',
            basis: t.trips_on_lane > 0
              ? `${t.trips_on_lane} trip(s) match this lane but none carry a toll charge`
              : 'no trip in the ERP has run this lane — enter the toll by hand' },
    };
  });

  // "Are maps going to work?" answered without a map load and without leaking
  // the key. Deploy-time question, deploy-time answer.
  app.get('/maps/health', async () => ({
    server_key_configured: mapsConfigured(),
    browser_key_note: 'The browser key is VITE_GOOGLE_MAPS_API_KEY and is public by design '
      + '(inlined into the bundle). Restrict it by HTTP referrer in Cloud Console.',
  }));

  app.get('/maps/cache/stats', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`
      SELECT kind,
             count(*)::int          AS entries,
             COALESCE(sum(hits),0)::int AS hits_served,
             max(last_used)         AS last_used
        FROM maps_cache GROUP BY kind ORDER BY kind`);
    const total = rows.reduce((n, r) => n + r.hits_served, 0);
    return {
      by_kind: rows,
      // Every hit is one Google call that was not made and not billed.
      billed_calls_avoided: total,
    };
  });
}
