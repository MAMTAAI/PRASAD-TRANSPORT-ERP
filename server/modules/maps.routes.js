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
