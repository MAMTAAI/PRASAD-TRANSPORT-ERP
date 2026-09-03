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
    // WHO IS DRIVING, AND WHICH LORRY IS IT (audit, 3-Sep-2026).
    //
    // This feed drives the Live Fleet Map, the trip tracker and the driver
    // link on every truck row — and it was reading `trips` alone. On the live
    // board that meant, out of 137 open trips:
    //
    //   · 101 carried NO driver at all — neither driver_id nor even a name —
    //     so three trucks in four had a dead "call the driver" affordance,
    //   ·   2 carried a name but no driver_id, so the Driver Control link was
    //     hidden even though the person is in the driver master, and
    //   ·  only 36 carried a mobile number, because the feed never looked at
    //     drivers.mobile — the number was sitting one join away the whole time.
    //
    // The lorry had the same problem in a quieter form: `vehicles` was never
    // joined, so a marker could not open the truck it belongs to. 136 of 137
    // open trips resolve to a vehicle row once the registration is compared
    // without spaces and dashes.
    //
    // So each row now says WHO, WHICH LORRY, and — the part that matters on a
    // money screen — HOW IT KNOWS:
    //   driver_source  LINKED       trips.driver_id → drivers.id
    //                  NAME_MATCH   no id, but the trip's driver_name matches
    //                               exactly one driver master row
    //                  TRIP_TEXT    a name on the trip that matches nobody
    //                  NONE         the trip does not say who is driving
    // NAME_MATCH deliberately requires exactly one candidate. Two drivers of
    // the same name is not a guess this endpoint is allowed to make; those
    // stay TRIP_TEXT and a person decides.
    //
    // NOT DONE, on purpose: nothing here writes trips.driver_id. Backfilling
    // 338 trips from a name match is a correction script, and corrections are
    // the desk's to approve — `unlinked_drivers` in the summary is that queue.
    //
    // ALSO CONSIDERED AND REJECTED: falling back to the last FASTag crossing
    // when a truck has no GPS fix. 73 open trips would have "gained" a
    // position that way, but the newest toll row is 23-Jul — six weeks old.
    // A six-week-old point drawn on a live map is worse than an empty space,
    // because the empty space is honest. Those trucks stay in `noFix`.
    const NORM = (c) => `regexp_replace(upper(${c}), '[^A-Z0-9]', '', 'g')`;
    const { rows } = await query(
      `SELECT * FROM (
         SELECT DISTINCT ON (${NORM('t.vehicle_no')})
                t.id, t.trip_code, t.vehicle_no, t.status,
                t.loading_date, t.loading_point,
                COALESCE(t.unloading_location, t.consignee_name) AS destination,

                -- the lorry, as a real record the map can open
                v.id            AS vehicle_id,
                v.vehicle_type  AS vehicle_type,

                -- who is driving, and how we know
                COALESCE(t.driver_id, nm.id)              AS driver_id,
                COALESCE(NULLIF(btrim(t.driver_name), ''),
                         d.name, nm.name)                 AS driver_name,
                COALESCE(NULLIF(btrim(t.driver_mobile), ''),
                         d.mobile, nm.mobile)             AS driver_mobile,
                CASE
                  WHEN t.driver_id IS NOT NULL THEN 'LINKED'
                  WHEN nm.id IS NOT NULL       THEN 'NAME_MATCH'
                  WHEN NULLIF(btrim(t.driver_name), '') IS NOT NULL THEN 'TRIP_TEXT'
                  ELSE 'NONE'
                END                                       AS driver_source,

                p.source, p.lat, p.lng, p.recorded_at,
                -- Age of the fix in seconds, so the UI can say "4 min ago"
                -- rather than implying every plotted truck is live right now.
                EXTRACT(EPOCH FROM (now() - p.recorded_at))::int AS fix_age_s,

                (SELECT count(*)::int FROM trips o
                  WHERE ${NORM('o.vehicle_no')} = ${NORM('t.vehicle_no')}
                    AND o.status IN ('LOADED','IN_TRANSIT','UNLOADING')) AS open_trips
           FROM trips t
           LEFT JOIN drivers d  ON d.id = t.driver_id
           -- The name fallback. Scalar subqueries rather than a join, so a
           -- duplicated name yields NULL (ambiguous → not guessed) instead of
           -- silently multiplying the row.
           LEFT JOIN LATERAL (
             SELECT dd.id, dd.name, dd.mobile
               FROM drivers dd
              WHERE t.driver_id IS NULL
                AND NULLIF(btrim(t.driver_name), '') IS NOT NULL
                AND lower(btrim(dd.name)) = lower(btrim(t.driver_name))
                -- Exactly one candidate, or none at all. Two drivers sharing a
                -- name is not a guess this endpoint may make: the row stays
                -- TRIP_TEXT and a person decides which one it is.
                AND (SELECT count(*) FROM drivers d2
                      WHERE lower(btrim(d2.name)) = lower(btrim(t.driver_name))) = 1
              LIMIT 1
           ) nm ON true
           LEFT JOIN vehicles v
             ON ${NORM('v.vehicle_no')} = ${NORM('t.vehicle_no')}
           LEFT JOIN LATERAL (
             SELECT source, lat, lng, recorded_at FROM trip_gps_pings
              WHERE trip_id = t.id ORDER BY recorded_at DESC LIMIT 1
           ) p ON true
          WHERE t.status IN ('LOADED','IN_TRANSIT','UNLOADING')
          ORDER BY ${NORM('t.vehicle_no')}, t.loading_date DESC NULLS LAST, t.created_at DESC
       ) latest
       ORDER BY loading_date DESC NULLS LAST
       LIMIT 100`);

    // The desk's data-quality queue, counted from the same rows the map draws
    // so the number on screen and the number in the summary cannot disagree.
    const summary = {
      total: rows.length,
      with_fix: rows.filter((r) => r.lat != null && r.lng != null).length,
      no_fix: rows.filter((r) => r.lat == null || r.lng == null).length,
      driver_linked: rows.filter((r) => r.driver_source === 'LINKED').length,
      driver_name_matched: rows.filter((r) => r.driver_source === 'NAME_MATCH').length,
      driver_unknown: rows.filter((r) => r.driver_source === 'NONE').length,
      // Trips a person could link in one click: the name resolves to exactly
      // one driver, but nobody has written the id onto the trip.
      unlinked_drivers: rows.filter((r) => r.driver_source === 'NAME_MATCH').length,
      no_mobile: rows.filter((r) => !r.driver_mobile).length,
      vehicle_unresolved: rows.filter((r) => !r.vehicle_id).length,
    };
    return { count: rows.length, summary, trips: rows };
  });
}
