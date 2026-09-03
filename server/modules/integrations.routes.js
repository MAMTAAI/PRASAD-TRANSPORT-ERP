// server/modules/integrations.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/tally     Tally Prime XML connector surface
// /api/v1/tracking  triangulated GPS telemetry (KALI's domain)
// ─────────────────────────────────────────────────────────────────────────────
import { query, queryOne, isDegraded } from '../db/pool.js';
import { pushVoucher, pushTripInvoice, tallyAlive, masterCheck } from '../lib/tallyAdapter.js';
import { emit } from '../agents/bus.js';
import { broadcastFix } from '../lib/realtime.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });

export async function registerIntegrationRoutes(app) {
  // ═══ TALLY ════════════════════════════════════════════════════════════════
  app.get('/tally/health', async () => ({ ...(await tallyAlive()), url: process.env.TALLY_URL ?? 'http://localhost:9000' }));

  // Sync state for a set of sources — drives the UI badges in one round trip.
  app.get(
    '/tally/status',
    { schema: { querystring: { type: 'object', properties: { sources: { type: 'string', maxLength: 2000 } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const list = (req.query.sources ?? '').split(',').filter(Boolean).slice(0, 50);
      const { rows } = list.length
        ? await query(`SELECT source, status, tally_guid, tally_synced_at, last_error FROM tally_sync WHERE source = ANY($1)`, [list])
        : await query(`SELECT source, status, tally_guid, tally_synced_at, last_error FROM tally_sync ORDER BY updated_at DESC LIMIT 50`);
      const counts = await query(`SELECT status, count(*)::int n FROM tally_sync GROUP BY status`);
      return { rows, counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])) };
    }
  );

  app.post(
    '/tally/push/voucher/:voucherId',
    { schema: { params: { type: 'object', required: ['voucherId'], properties: { voucherId: { type: 'string', format: 'uuid' } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      try {
        return await pushVoucher(req.params.voucherId);
      } catch (err) {
        if (err.code === 'ALREADY_SYNCED') return reply.code(409).send({ error: err.code, detail: err.message });
        if (err.code === 'NOT_FOUND') return reply.code(404).send({ error: err.code });
        // Tally offline / rejected → the row stays FAILED (retryable), tell the UI plainly.
        return reply.code(502).send({ error: err.code ?? 'TALLY_PUSH_FAILED', detail: err.message, retryable: true });
      }
    }
  );

  app.post(
    '/tally/push/trip/:tripId',
    { schema: { params: { type: 'object', required: ['tripId'], properties: { tripId: { type: 'string', format: 'uuid' } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      try {
        return await pushTripInvoice(req.params.tripId);
      } catch (err) {
        const map = { ALREADY_SYNCED: 409, NOT_FOUND: 404, NOT_SETTLED: 422, NO_AMOUNT: 422 };
        if (map[err.code]) return reply.code(map[err.code]).send({ error: err.code, detail: err.message });
        return reply.code(502).send({ error: err.code ?? 'TALLY_PUSH_FAILED', detail: err.message, retryable: true });
      }
    }
  );

  app.get('/tally/master-check', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    try {
      return await masterCheck();
    } catch (err) {
      return reply.code(502).send({ error: 'TALLY_OFFLINE', detail: `open Tally Prime with its HTTP server on ${process.env.TALLY_URL ?? ':9000'} (${err.message})` });
    }
  });

  // ═══ TRACKING ═════════════════════════════════════════════════════════════
  // Ping ingestion — driver PWA posts DRIVER_APP; GPRS/FASTag adapters post
  // their own source. Also emits trip.gps.ping so KALI's audit trail sees it.
  app.post(
    '/tracking/ping',
    {
      schema: {
        body: {
          type: 'object', required: ['trip_id', 'source', 'lat', 'lng'], additionalProperties: false,
          properties: {
            trip_id: { type: 'string', format: 'uuid' },
            source: { type: 'string', enum: ['DRIVER_APP', 'GPRS', 'FASTAG'] },
            lat: { type: 'number', minimum: -90, maximum: 90 },
            lng: { type: 'number', minimum: -180, maximum: 180 },
            speed_kmh: { type: ['number', 'null'], minimum: 0, maximum: 200 },
            accuracy_m: { type: ['number', 'null'], minimum: 0 },
            checkpoint: { type: ['string', 'null'], maxLength: 120 },
            recorded_at: { type: ['string', 'null'], format: 'date-time' },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const trip = await queryOne(`SELECT id, status FROM trips WHERE id = $1::uuid`, [b.trip_id]);
      if (!trip) return reply.code(404).send({ error: 'TRIP_NOT_FOUND' });
      // Pings only make sense for moving trips; a ping against a SETTLED trip
      // is a stale device — logged nowhere, refused loudly.
      if (!['LOADED', 'IN_TRANSIT', 'UNLOADING'].includes(trip.status)) {
        return reply.code(422).send({ error: 'TRIP_NOT_MOVING', detail: `trip is ${trip.status}` });
      }
      const { rows: [row] } = await query(
        `INSERT INTO trip_gps_pings (trip_id, source, lat, lng, speed_kmh, accuracy_m, checkpoint, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now())) RETURNING id`,
        [b.trip_id, b.source, b.lat, b.lng, b.speed_kmh ?? null, b.accuracy_m ?? null, b.checkpoint ?? null, b.recorded_at ?? null]);
      await emit('trip.gps.ping', {
        aggregate: 'trip', aggregateId: b.trip_id,
        payload: { source: b.source, lat: b.lat, lng: b.lng, ping_id: row.id },
      }).catch(() => { /* telemetry must not fail on outbox hiccups */ });

      // Push to every open dispatch board. This is what makes the map move
      // without a reload and without each board polling on a timer — the fix
      // travels once, at the moment it lands, instead of being discovered up
      // to 15 seconds later by everyone independently.
      broadcastFix({
        trip_id: b.trip_id,
        lat: b.lat,
        lng: b.lng,
        speed_kmh: b.speed_kmh ?? null,
        source: b.source,
        recorded_at: b.recorded_at ?? new Date().toISOString(),
      });

      reply.code(201);
      return { ok: true, ping_id: row.id };
    }
  );

  // Triangulated position: per-source latest + the elected best fix.
  // Election: freshest wins, with a source-quality tiebreak inside a 5-minute
  // window (GPRS hardware > driver phone > FASTag plaza, by precision).
  app.get(
    '/tracking/:tripId',
    { schema: { params: { type: 'object', required: ['tripId'], properties: { tripId: { type: 'string', format: 'uuid' } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const trip = await queryOne(
        `SELECT id, trip_code, vehicle_no, driver_name, status, loading_point, consignee_name, unloading_location
           FROM trips WHERE id = $1::uuid`, [req.params.tripId]);
      if (!trip) return reply.code(404).send({ error: 'NOT_FOUND' });

      const { rows: latest } = await query(
        `SELECT DISTINCT ON (source) source, lat, lng, speed_kmh, accuracy_m, checkpoint, recorded_at
           FROM trip_gps_pings WHERE trip_id = $1::uuid
          ORDER BY source, recorded_at DESC`, [req.params.tripId]);

      const QUALITY = { GPRS: 3, DRIVER_APP: 2, FASTAG: 1 };
      const now = Date.now();
      let best = null;
      for (const p of latest) {
        if (!best) { best = p; continue; }
        const dt = Math.abs(new Date(p.recorded_at).getTime() - new Date(best.recorded_at).getTime());
        if (dt <= 5 * 60_000) {
          if (QUALITY[p.source] > QUALITY[best.source]) best = p;         // same window → precision wins
        } else if (new Date(p.recorded_at).getTime() > new Date(best.recorded_at).getTime()) {
          best = p;                                                        // otherwise freshest wins
        }
      }

      const { rows: trail } = await query(
        `SELECT source, lat, lng, recorded_at FROM trip_gps_pings
          WHERE trip_id = $1::uuid ORDER BY recorded_at DESC LIMIT 200`, [req.params.tripId]);

      return {
        trip: { id: trip.id, code: trip.trip_code, vehicle_no: trip.vehicle_no, driver: trip.driver_name, status: trip.status },
        route: { origin: trip.loading_point, destination: trip.unloading_location ?? trip.consignee_name },
        sources: latest,
        best: best ? {
          ...best,
          age_s: Math.round((now - new Date(best.recorded_at).getTime()) / 1000),
          badge: best.source === 'DRIVER_APP' ? 'Tracking via: Driver App'
               : best.source === 'GPRS' ? 'Tracking via: GPRS'
               : 'Tracking via: FASTag',
        } : null,
        trail: trail.reverse(),
      };
    }
  );

  // Live board: every moving trip with its best fix (map overview page).
  app.get('/tracking', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    // ONE ROW PER LORRY — ITS CURRENT LOAD, NOT ITS WHOLE HISTORY.
    //
    // 146 trips are open across 40 vehicles, because a trip that is never
    // marked unloaded stays IN_TRANSIT for ever: NL 01Q 2670 has fourteen of
    // them, the oldest loaded in April. Listing every open trip meant one lorry
    // appeared fourteen times and the row you happened to click was almost
    // always a load it finished months ago — the board was showing the past and
    // calling it live.
    //
    // DISTINCT ON keeps the newest load per vehicle. The stale rows are still
    // in the database and still wrong; this stops them being mistaken for
    // today's work, and the Unloading Queue is where they get closed.
    const { rows } = await query(
      `SELECT * FROM (
         SELECT DISTINCT ON (t.vehicle_no)
                t.id, t.trip_code, t.vehicle_no, t.driver_name, t.driver_id, t.status,
                t.loading_date, t.loading_point,
                COALESCE(t.unloading_location, t.consignee_name) AS destination,
                p.source, p.lat, p.lng, p.recorded_at,
                (SELECT count(*)::int FROM trips o
                  WHERE o.vehicle_no = t.vehicle_no
                    AND o.status IN ('LOADED','IN_TRANSIT','UNLOADING')) AS open_trips
           FROM trips t
           LEFT JOIN LATERAL (
             SELECT source, lat, lng, recorded_at FROM trip_gps_pings
              WHERE trip_id = t.id ORDER BY recorded_at DESC LIMIT 1
           ) p ON true
          WHERE t.status IN ('LOADED','IN_TRANSIT','UNLOADING')
          ORDER BY t.vehicle_no, t.loading_date DESC NULLS LAST, t.created_at DESC
       ) latest
       ORDER BY loading_date DESC NULLS LAST
       LIMIT 100`);
    return { count: rows.length, trips: rows };
  });
}
