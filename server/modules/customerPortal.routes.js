// ═══════════════════════════════════════════════════════════════════════════
// customerPortal.routes.js — the Customer app's marketplace back end
//
// The half that never existed: `cust.place_order` has been a seeded module key
// since 068 with no route behind it, and the old CustomerPortal.tsx posted
// loads at admin-only /bazaar routes that 403'd every time. These are the
// customer-scoped equivalents of vendorPortal.routes.js, built on the same
// three rules:
//
//   · SCOPE COMES FROM THE SESSION'S PARTY, NEVER FROM A PARAMETER. Every
//     query is WHERE customer_id = me; there is no way to widen it.
//   · THE CUSTOMER SEES BIDS ON THEIR OWN LOADS — vendor name and amount
//     included, because choosing between offers is the whole point. What they
//     never see is another customer's loads or bids.
//   · ACCEPTING A BID IS THE SAME TRANSACTION THE ADMIN AWARD USES: reject
//     the rest, accept the winner, mark the load AWARDED, all under FOR
//     UPDATE with uq_bazaar_bid_winner backstopping a concurrent double-award.
// ═══════════════════════════════════════════════════════════════════════════
import { query, withTransaction, isDegraded } from '../db/pool.js';
import { resolveParty, needsModule, visibleModules } from './portal.routes.js';
import { getRoute, geocode, getDistanceMatrix } from '../lib/googleMaps.js';
import { notifyWhatsApp } from '../lib/notify.js';
import { openSettlementInTx } from './bazaarSettlement.routes.js';
import { checkParty } from '../lib/partyFormats.js';
import { laneEconomics } from '../lib/laneEconomics.js';

const dbGate = (reply) =>
  reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A coordinate or a place id that came off a form: empty string, "undefined"
// and NaN all have to become NULL, or a numeric column takes them as 0,0 —
// a pin in the Gulf of Guinea.
// null and undefined must stay null. Number(null) is 0, and a toll stored as
// ₹0.00 reads as "this lane is toll-free" — a lie the desk would price against.
const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const trim = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, 200));

const customerOnly = async (req, reply) => {
  const done = await resolveParty(req, reply);
  if (done !== undefined) return done;
  if (req.party.role !== 'CUSTOMER') {
    return reply.code(403).send({ error: 'FORBIDDEN', detail: 'customer portal only' });
  }
};

export function registerCustomerPortalRoutes(app) {
  // ═══ MY LOADS ═════════════════════════════════════════════════════════════

  /** What a lane costs, before anybody commits to it.
   *
   *  Owner, 3-Sep: the customer must see the distance and the estimated toll
   *  as they choose the two ends. Distance comes from Google (cached per lane);
   *  the toll comes from OUR OWN FASTag history when we have run the lane, and
   *  says so — a measured number and a guess must not read the same.
   *
   *  Also geocodes the two ends so the load carries a pin, not just a name.
   *  Geocoding is best-effort: a depot Google has never heard of still posts,
   *  because the text is what this business actually runs on. */
  app.get('/portal/customer/lane', { preHandler: needsModule('cust.place_order') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const origin = String(req.query?.origin ?? '').trim();
    const destination = String(req.query?.destination ?? '').trim();
    if (!origin || !destination) {
      return reply.code(400).send({ error: 'BAD_INPUT', detail: 'origin and destination are both required' });
    }
    const econ = await laneEconomics(origin, destination).catch(() => null);
    const [o, d] = await Promise.all([
      geocode(origin).catch(() => null),
      geocode(destination).catch(() => null),
    ]);
    return {
      origin, destination,
      km: econ?.km ?? null,
      duration_s: econ?.duration_s ?? null,
      toll: econ?.toll ?? null,
      toll_source: econ?.toll_source ?? null,
      toll_label: econ?.toll_label ?? null,
      // Nulls when Google cannot place the name. The screen shows the lane
      // without a map rather than refusing the booking.
      origin_point: o?.ok ? { lat: o.lat, lng: o.lng } : null,
      dest_point: d?.ok ? { lat: d.lat, lng: d.lng } : null,
    };
  });

  app.get('/portal/customer/loads', { preHandler: needsModule('cust.place_order') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`
      SELECT l.load_id, l.origin, l.destination, l.distance_km, l.material, l.weight,
             l.target_rate, l.loading_date, l.vehicle_type, l.rate_type, l.status,
             l.toll_amount, l.created_at,
             w.vendor_name AS awarded_to, w.bid_amount AS awarded_amount,
             (SELECT count(*) FROM bazaar_bids b
               WHERE b.load_id = l.load_id AND b.status = 'PENDING')::int AS pending_bids
        FROM bazaar_loads l
        LEFT JOIN bazaar_bids w ON w.load_id = l.load_id AND w.status = 'ACCEPTED'
       WHERE l.customer_id = $1::uuid
       ORDER BY l.created_at DESC
       LIMIT 100`, [req.party.customerId]);
    return { count: rows.length, loads: rows };
  });

  app.post('/portal/customer/loads', { preHandler: needsModule('cust.place_order') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.origin || !b.destination) {
      return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'origin and destination are required' });
    }
    // Book-Now is the one PUBLIC rate: any verified partner may take the load
    // instantly at this price. Optional; blind bidding runs either way.
    const bookNow = b.book_now_rate == null || b.book_now_rate === '' ? null : Number(b.book_now_rate);
    if (bookNow !== null && !(Number.isFinite(bookNow) && bookNow > 0)) {
      return reply.code(400).send({ error: 'BAD_AMOUNT', detail: 'book_now_rate must be a positive amount' });
    }
    const closeHours = b.bid_close_hours == null || b.bid_close_hours === '' ? null : Number(b.bid_close_hours);
    if (closeHours !== null && !(Number.isFinite(closeHours) && closeHours > 0 && closeHours <= 24 * 14)) {
      return reply.code(400).send({ error: 'BAD_CLOSE', detail: 'bid_close_hours must be 1–336 (14 days)' });
    }
    try {
      const row = await withTransaction(async (c) => {
        // The customer's own name from THEIR party row, never from the body —
        // a portal account cannot post a load as somebody else.
        const { rows: me } = await c.query(
          'SELECT customer_name FROM customers WHERE id = $1::uuid', [req.party.customerId]);

        // Same LD-code minting discipline as the staff route (bazaar.routes.js).
        await c.query('LOCK TABLE bazaar_loads IN SHARE ROW EXCLUSIVE MODE');
        const { rows: seq } = await c.query(
          `SELECT COALESCE(MAX(NULLIF(regexp_replace(load_id, '\\D', '', 'g'), '')::bigint), 0) + 1 AS n
             FROM bazaar_loads WHERE load_id ~ '^LD[0-9]+$'`);
        const loadId = 'LD' + String(seq[0].n).padStart(5, '0');

        const { rows } = await c.query(`
          INSERT INTO bazaar_loads (load_id, customer_name, customer_id, origin, destination,
            distance_km, material, weight, target_rate, loading_date, vehicle_type, rate_type,
            status, posted_by, book_now_rate, bid_close_at,
            origin_lat, origin_lng, origin_place_id, dest_lat, dest_lng, dest_place_id,
            est_distance_km, est_toll, est_toll_source)
          VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8,COALESCE($9,0),$10,$11,$12,'PENDING_REVIEW','CUSTOMER_PORTAL',
                  $13, CASE WHEN $14::numeric IS NULL THEN NULL
                            ELSE now() + ($14::numeric * interval '1 hour') END,
                  $15,$16,$17,$18,$19,$20,$21,$22,$23)
          RETURNING *`,
          [loadId, me[0]?.customer_name ?? 'CUSTOMER', req.party.customerId,
           b.origin, b.destination, b.distance_km ?? null, b.material ?? null, b.weight ?? null,
           b.target_rate ?? null, b.loading_date || null, b.vehicle_type ?? null, b.rate_type ?? null,
           bookNow, closeHours,
           // The pin, when Google could place the name. A depot it has never
           // heard of posts with nulls here and works exactly as before.
           num(b.origin_lat), num(b.origin_lng), trim(b.origin_place_id),
           num(b.dest_lat), num(b.dest_lng), trim(b.dest_place_id),
           // What the engine said at posting time, and on whose authority — so
           // "why did we quote this?" has an answer a month later. The source is
           // taken from the server's own lookup, never from the client.
           b.est_distance_km == null ? null : Math.round(Number(b.est_distance_km)),
           // A toll with no recognised source is dropped, not stored bare. An
           // unsourced number on a money screen is the exact thing this design
           // exists to prevent — it would read like a measured toll.
           ['OUR_TRIPS', 'GOOGLE', 'MANUAL'].includes(b.est_toll_source) ? num(b.est_toll) : null,
           ['OUR_TRIPS', 'GOOGLE', 'MANUAL'].includes(b.est_toll_source) ? b.est_toll_source : null]);
        return rows[0];
      });
      // Maker-checker (2026-08-31): a customer load opens for bidding only
      // after the office has looked at it. The feed and the bid route serve
      // OPEN loads only, so a pending one simply does not exist to vendors.
      return reply.code(201).send({
        load: row,
        detail: 'Load submitted to the Prasad Transport office for review. '
              + 'The moment it is approved, verified fleet partners are invited to bid.',
      });
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ error: 'DUPLICATE', detail: e.detail ?? e.message });
      throw e;
    }
  });

  // ═══ BIDS ON MY LOAD ══════════════════════════════════════════════════════
  // Vendor name + amount are shown — the customer is choosing between offers.
  // Ownership is enforced in the JOIN, so a foreign load_id simply finds no rows.
  app.get('/portal/customer/loads/:loadId/bids', { preHandler: needsModule('cust.place_order') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows: own } = await query(
      'SELECT load_id, status FROM bazaar_loads WHERE load_id = $1 AND customer_id = $2::uuid',
      [req.params.loadId, req.party.customerId]);
    if (!own.length) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'no such load of yours' });
    const { rows } = await query(`
      SELECT b.id, b.vendor_name, b.bid_amount, b.remarks, b.status, b.created_at
        FROM bazaar_bids b
       WHERE b.load_id = $1 AND b.status IN ('PENDING','ACCEPTED')
       ORDER BY b.bid_amount ASC, b.created_at ASC`, [req.params.loadId]);
    return { load_id: req.params.loadId, load_status: own[0].status, count: rows.length, bids: rows };
  });

  app.post('/portal/customer/loads/:loadId/accept-bid', { preHandler: needsModule('cust.place_order') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const bidId = String(req.body?.bid_id ?? '');
    if (!UUID_RE.test(bidId)) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'bid_id is required' });

    const out = await withTransaction(async (c) => {
      const { rows: L } = await c.query(
        'SELECT * FROM bazaar_loads WHERE load_id = $1 AND customer_id = $2::uuid FOR UPDATE',
        [req.params.loadId, req.party.customerId]);
      if (!L.length) return { code: 404, body: { error: 'NOT_FOUND', detail: 'no such load of yours' } };
      if (L[0].status !== 'OPEN') {
        return { code: 409, body: { error: 'LOAD_NOT_OPEN', detail: `load is ${L[0].status}` } };
      }
      const { rows: B } = await c.query(
        `SELECT b.*, v.mobile_no AS vendor_mobile FROM bazaar_bids b
          LEFT JOIN vendors v ON v.id = b.vendor_id
         WHERE b.id = $1::uuid AND b.load_id = $2 FOR UPDATE OF b`, [bidId, req.params.loadId]);
      if (!B.length) return { code: 404, body: { error: 'NO_SUCH_BID' } };
      if (B[0].status !== 'PENDING') {
        return { code: 409, body: { error: 'BID_NOT_PENDING', detail: `bid is ${B[0].status}` } };
      }

      // THE DESK DECIDES THE AWARD (owner's rule, 2026-09-02). This used to
      // reject the other bids, accept this one and open the settlement in the
      // same request — an external write landing live. Now the customer's
      // choice is a REQUEST: the load leaves OPEN (bidding freezes, the vendor
      // feed no longer lists it), the chosen bid is named on the row, and the
      // office approves or reopens it from Bazaar Admin
      // (POST /bazaar/loads/:id/award-review). The money chain starts there.
      const { rows: U } = await c.query(
        `UPDATE bazaar_loads
            SET status = 'AWARD_REQUESTED',
                award_requested_bid_id = $2::uuid, award_requested_by = 'CUSTOMER', award_requested_at = now(),
                award_reviewed_by = NULL, award_reviewed_at = NULL, award_reject_reason = NULL,
                updated_at = now()
          WHERE load_id = $1 RETURNING *`,
        [req.params.loadId, bidId]);
      const { vendor_mobile: _vm, ...bid } = B[0];
      return {
        code: 202,
        body: {
          load: U[0], bid, award_requested: true,
          detail: 'Award request sent to the Prasad Transport office. The award is confirmed there — '
                + 'you will hear on WhatsApp, and the status here changes to Awarded.',
        },
        vendorMobile: B[0].vendor_mobile,
      };
    });

    if (out.code === 202 && out.vendorMobile) {
      // After commit, never inside it — a slow engine must not hold the request.
      notifyWhatsApp(out.vendorMobile,
        `🔔 Load Bazaar: load ${req.params.loadId} (${out.body.load.origin} → ${out.body.load.destination}) `
        + `ke customer ne aapki bid ₹${out.body.bid.bid_amount} chuni hai. Prasad Transport office confirm karega — `
        + `award uske baad hoga.`);
    }
    return reply.code(out.code).send(out.body);
  });

  // ═══ CUSTOMER APP v1 HOME (approved mock, 3-Sep-2026) ═══════════════════
  // One call paints the home screen: trucks on the road, delivered this month,
  // PODs ready / awaited, the latest dispatches, the customer's usual lanes
  // (chips on the indent form) and whether THIS customer may request an indent.
  // can_request_indent is the owner's corporate/regular split: IOCL-type
  // customers (loads arrive by mail) carry place_orders:false in their feature
  // map and get a read-only Bookings tab; everyone else gets the button.
  app.get('/portal/customer/summary', { preHandler: needsModule('cust.dashboard') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const cid = req.party.customerId;
    const vis = req.visible ?? await visibleModules(req.party);
    const canOrder = !!vis['cust.place_order'];

    const { rows: [c] } = await query(
      `SELECT customer_name, customer_code, city, payment_terms, billing_cycle, gst_no
         FROM customers WHERE id = $1::uuid`, [cid]);

    const { rows: [k] } = await query(`
      SELECT count(*) FILTER (WHERE status = 'IN_TRANSIT')::int AS on_road,
             count(*) FILTER (WHERE status = 'UNLOADING')::int AS unloading,
             count(*) FILTER (WHERE status IN ('COMPLETED','SETTLED')
                              AND COALESCE(unloading_date, loading_date) >= date_trunc('month', now()))::int AS delivered_month,
             count(*) FILTER (WHERE loading_date >= date_trunc('month', now()))::int AS loaded_month,
             count(*) FILTER (WHERE loading_date = current_date)::int AS loaded_today
        FROM trips WHERE customer_id = $1::uuid`, [cid]);

    const { rows: [p] } = await query(`
      SELECT (SELECT count(*) FROM partner_documents d JOIN trips t ON t.id = d.trip_id
               WHERE t.customer_id = $1::uuid AND d.doc_type = 'POD' AND d.status = 'APPROVED')::int
           + (SELECT count(*) FROM bazaar_settlements s
               WHERE s.customer_id = $1::uuid AND s.pod_verified_at IS NOT NULL)::int AS ready,
             (SELECT count(*) FROM trips t
               WHERE t.customer_id = $1::uuid AND t.status IN ('COMPLETED','SETTLED')
                 AND COALESCE(t.unloading_date, t.loading_date) >= current_date - 30
                 AND NOT EXISTS (SELECT 1 FROM partner_documents d
                                  WHERE d.trip_id = t.id AND d.doc_type = 'POD' AND d.status = 'APPROVED'))::int AS awaited`, [cid]);

    const { rows: latest } = await query(`
      SELECT trip_code, status, vehicle_no, product_type, loading_date, loading_point,
             unloading_location, loaded_qty, unloading_date
        FROM trips WHERE customer_id = $1::uuid
       ORDER BY (status = 'IN_TRANSIT') DESC, loading_date DESC NULLS LAST LIMIT 3`, [cid]);

    const { rows: lanes } = await query(`
      SELECT loading_point, unloading_location, count(*)::int AS trips, max(loading_date) AS last
        FROM trips
       WHERE customer_id = $1::uuid AND loading_point IS NOT NULL AND unloading_location IS NOT NULL
       GROUP BY 1, 2 ORDER BY max(loading_date) DESC NULLS LAST LIMIT 5`, [cid]);

    let bookings = null;
    if (canOrder) {
      const { rows: [b] } = await query(`
        SELECT count(*) FILTER (WHERE status = 'PENDING_REVIEW')::int AS review,
               count(*) FILTER (WHERE status IN ('OPEN','AWARD_REQUESTED'))::int AS arranging,
               count(*) FILTER (WHERE status = 'AWARDED')::int AS assigned,
               (SELECT count(*) FROM bazaar_bids b JOIN bazaar_loads l ON l.load_id = b.load_id
                 WHERE l.customer_id = $1::uuid AND l.status = 'OPEN' AND b.status = 'PENDING')::int AS offers
          FROM bazaar_loads WHERE customer_id = $1::uuid`, [cid]);
      bookings = b;
    }

    return {
      customer: c ? { name: c.customer_name, code: c.customer_code, city: c.city, payment_terms: c.payment_terms, billing_cycle: c.billing_cycle, gst_no: c.gst_no } : null,
      trips: k, pods: p, latest, lanes, bookings,
      can_request_indent: canOrder,
      corporate: !canOrder,
      driver_visible: !!vis['cust.shipments.driver'],
      freight_visible: !!vis['cust.shipments.freight'],
      ledger_visible: !!vis['cust.ledger'],
    };
  });

  // ═══ DIGITAL POD (verified only) ══════════════════════════════════════════
  // The owner's rule: a customer sees a delivery proof ONLY after the office
  // verified it. Own-fleet PODs are the driver's photo in partner_documents
  // (status APPROVED = verified); bazaar PODs sit on the settlement
  // (pod_verified_at). Anything unverified is listed as PENDING with no file —
  // the phone shows the truck delivered and the paper still with the office.
  app.get('/portal/customer/pods', { preHandler: needsModule('cust.pods') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const cid = req.party.customerId;
    const { rows: ready } = await query(`
      SELECT 'TRIP' AS kind, t.trip_code AS ref, t.vehicle_no, t.loading_point AS origin,
             t.unloading_location AS destination, t.product_type,
             COALESCE(t.unloading_date, d.reviewed_at) AS delivered_at,
             t.loaded_qty, t.unloaded_qty, t.shortage_qty, t.challan_no,
             d.id AS doc_id, d.file_key, d.reviewed_at AS verified_at, 'READY' AS pod_status
        FROM partner_documents d
        JOIN trips t ON t.id = d.trip_id
       WHERE t.customer_id = $1::uuid AND d.doc_type = 'POD' AND d.status = 'APPROVED'
      UNION ALL
      -- bazaar_loads.weight is TEXT ("25", "25 MT"); trips.loaded_qty is numeric,
      -- and a UNION will not match the two. Digits only, or nothing.
      SELECT 'LOAD', s.load_id, mv.registration_no, l.origin, l.destination, l.material,
             s.pod_verified_at,
             NULLIF(regexp_replace(COALESCE(l.weight, ''), '[^0-9.]', '', 'g'), '')::numeric,
             NULL, NULL, NULL,
             NULL, s.pod_file, s.pod_verified_at, 'READY'
        FROM bazaar_settlements s
        JOIN bazaar_loads l ON l.load_id = s.load_id
        LEFT JOIN market_vehicles mv ON mv.id = s.market_vehicle_id
       WHERE s.customer_id = $1::uuid AND s.pod_verified_at IS NOT NULL
       ORDER BY delivered_at DESC NULLS LAST LIMIT 100`, [cid]);
    const { rows: pending } = await query(`
      SELECT 'TRIP' AS kind, t.trip_code AS ref, t.vehicle_no, t.loading_point AS origin,
             t.unloading_location AS destination, t.product_type,
             COALESCE(t.unloading_date, t.loading_date) AS delivered_at,
             t.loaded_qty, t.unloaded_qty, t.shortage_qty, t.challan_no,
             EXISTS (SELECT 1 FROM partner_documents d WHERE d.trip_id = t.id AND d.doc_type = 'POD' AND d.status = 'PENDING') AS with_office
        FROM trips t
       WHERE t.customer_id = $1::uuid AND t.status IN ('COMPLETED','SETTLED')
         AND COALESCE(t.unloading_date, t.loading_date) >= current_date - 30
         AND NOT EXISTS (SELECT 1 FROM partner_documents d WHERE d.trip_id = t.id AND d.doc_type = 'POD' AND d.status = 'APPROVED')
       ORDER BY delivered_at DESC NULLS LAST LIMIT 50`, [cid]);
    return { ready: ready.length, pending: pending.length, pods: [
      ...ready,
      ...pending.map((r) => ({ ...r, file_key: null, verified_at: null, pod_status: r.with_office ? 'WITH_OFFICE' : 'PENDING' })),
    ] };
  });

  // ═══ LANE GEOMETRY (scoped) ═══════════════════════════════════════════════
  // /maps/trip/:tripId/route takes a trip id, which this app never sees; this
  // is the same answer keyed by the customer's own trip code, ownership checked.
  app.get('/portal/customer/trips/:tripCode/route', { preHandler: needsModule('cust.tracking') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows: t } = await query(`
      SELECT id, trip_code, vehicle_no, status, loading_point,
             COALESCE(unloading_location, consignee_name) AS destination, loading_date, rtkm
        FROM trips WHERE trip_code = $1 AND customer_id = $2::uuid`,
      [req.params.tripCode, req.party.customerId]);
    if (!t[0]) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'no such shipment of yours' });
    const trip = t[0];
    const [route, o, d] = await Promise.all([
      getRoute(trip.loading_point, trip.destination),
      geocode(trip.loading_point ? `${trip.loading_point}, India` : ''),
      geocode(trip.destination ? `${trip.destination}, India` : ''),
    ]);
    return {
      trip: { trip_code: trip.trip_code, vehicle_no: trip.vehicle_no, status: trip.status, loading_point: trip.loading_point, destination: trip.destination, rtkm: trip.rtkm },
      origin: o.ok ? { lat: o.lat, lng: o.lng, label: trip.loading_point } : null,
      destination: d.ok ? { lat: d.lat, lng: d.lng, label: trip.destination } : null,
      route: route.ok
        ? { polyline: route.polyline, distance_km: route.distance_m == null ? null : +(route.distance_m / 1000).toFixed(1),
            duration_min: route.duration_s == null ? null : Math.round(route.duration_s / 60), cached: !!route.cached }
        : { polyline: null, error: route.reason },
    };
  });

  // ═══ SHIPMENT TRACKING (scoped) ═══════════════════════════════════════════
  // The generic /api/v1/tracking/:tripId would let any holder of a trip id read
  // any truck's position, so CUSTOMER stays outside that prefix. This is the
  // scoped version: the trip must be THE CALLER'S, checked by customer_id.
  app.get('/portal/customer/trips/:tripCode/tracking', { preHandler: needsModule('cust.shipments') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows: T } = await query(
      `SELECT id, trip_code, status, vehicle_no,
              COALESCE(unloading_location, consignee_name) AS destination
         FROM trips
        WHERE trip_code = $1 AND customer_id = $2::uuid`,
      [req.params.tripCode, req.party.customerId]);
    if (!T.length) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'no such shipment of yours' });

    const { rows: fix } = await query(`
      SELECT source, lat, lng, speed_kmh, checkpoint, recorded_at
        FROM trip_gps_pings
       WHERE trip_id = $1::uuid
       ORDER BY recorded_at DESC LIMIT 1`, [T[0].id]);
    const { rows: trail } = await query(`
      SELECT lat, lng, recorded_at FROM trip_gps_pings
       WHERE trip_id = $1::uuid ORDER BY recorded_at DESC LIMIT 50`, [T[0].id]);
    // ── ETA, and only a real one ────────────────────────────────────────────
    // The approved mock puts "ETA · km left" on the customer's map. There is no
    // honest way to derive that from the lane length (that is the whole route,
    // not what is left), so it is asked of Google FROM THE TRUCK'S OWN FIX —
    // and therefore only when there IS a fix, it is recent, and the app asked
    // (?eta=1, which the app sends on open and then every 5 minutes, not on
    // every 45-second position poll). Coordinates are rounded to 2 dp so a
    // moving truck reuses one cached pair per ~1 km instead of billing a fresh
    // Distance Matrix element for every metre.
    let eta = null;
    const ageMin = fix[0]?.recorded_at ? (Date.now() - new Date(fix[0].recorded_at).getTime()) / 60000 : null;
    if (req.query?.eta === '1' && fix[0]?.lat != null && T[0].destination && ageMin != null && ageMin <= 90) {
      const from = `${Number(fix[0].lat).toFixed(2)},${Number(fix[0].lng).toFixed(2)}`;
      const dm = await getDistanceMatrix([from], [`${T[0].destination}, India`]);
      const hit = dm.ok ? dm.results.find((r) => r.duration_s != null) : null;
      if (hit) {
        eta = {
          remaining_km: hit.distance_m == null ? null : +(hit.distance_m / 1000).toFixed(0),
          remaining_min: Math.round(hit.duration_s / 60),
          // Counted from when the truck was seen, not from now — a 20-minute-old
          // fix must not quietly move the arrival 20 minutes later.
          arrival_at: new Date(new Date(fix[0].recorded_at).getTime() + hit.duration_s * 1000).toISOString(),
          cached: !!hit.cached,
        };
      }
    }

    return {
      trip_code: T[0].trip_code,
      status: T[0].status,
      vehicle_no: T[0].vehicle_no,
      destination: T[0].destination,
      // null when no ping exists — the app shows "position not reported yet",
      // never an invented truck (same honesty rule as TripTrackingMap).
      position: fix[0] ?? null,
      age_min: ageMin == null ? null : Math.round(ageMin),
      eta,
      trail: trail.reverse(),
    };
  });

  // ═══ SETTLEMENT TIMELINE (scoped, money-free) ═════════════════════════════
  // The customer's stepper for an awarded load: confirmed → truck assigned →
  // in transit → POD → settled. What the vendor is PAID (advance/balance/
  // deposit amounts) is our cost side and stays out of this payload.
  app.get('/portal/customer/loads/:loadId/settlement', { preHandler: needsModule('cust.place_order') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`
      SELECT s.status, s.confirm_deadline, s.vendor_confirmed_at,
             CASE WHEN s.pod_verified_at IS NOT NULL THEN s.pod_file END AS pod_file,
             s.pod_submitted_at, s.pod_verified_at, s.cancel_reason,
             s.created_at, s.updated_at,
             b.vendor_name, b.bid_amount AS awarded_amount,
             mv.registration_no AS vehicle_reg,
             md.name AS driver_name, md.mobile AS driver_mobile
        FROM bazaar_settlements s
        JOIN bazaar_bids b ON b.id = s.bid_id
        LEFT JOIN market_vehicles mv ON mv.id = s.market_vehicle_id
        LEFT JOIN market_drivers md ON md.id = s.market_driver_id
       WHERE s.load_id = $1 AND s.customer_id = $2::uuid`,
      [req.params.loadId, req.party.customerId]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'no settlement on this load of yours' });
    return { load_id: req.params.loadId, settlement: rows[0] };
  });
  // ═══ MY BANK ACCOUNT ══════════════════════════════════════════════════════
  //
  // Owner, 2026-09-03: "Allow active customers to update their Bank Details
  // from within their Customer App profile."
  //
  // A bank account is a master field, and the quarantine fence refuses a
  // CUSTOMER session any write to `customers` (server/lib/staging.js) — which
  // is the right answer for the most attractive three fields in this database
  // to a stranger holding a borrowed handset. So the phone files a REQUEST and
  // the office moves it onto the master. The customer is told exactly that.
  //
  // Not module-gated: a party's own identity is not a feature the office
  // switches off, so this is `customerOnly` — the role, not a module key.
  // Under a staff View-As preview the POST never runs at all: portal.routes
  // refuses every non-GET with 405 VIEW_AS_READ_ONLY.

  /** Their own account, masked the way a bank statement masks it — enough to
   *  recognise, not enough to be worth reading over a shoulder. */
  const maskAccount = (n) => {
    const s = String(n ?? '').replace(/\s/g, '');
    if (!s) return null;
    return s.length <= 4 ? s : '·'.repeat(Math.min(s.length - 4, 12)) + s.slice(-4);
  };

  app.get('/portal/customer/bank', { preHandler: customerOnly }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const [{ rows: cust }, { rows: pend }] = await Promise.all([
      query(`SELECT customer_name, bank_name, account_no, ifsc_code
               FROM customers WHERE id = $1::uuid`, [req.party.customerId]),
      query(`SELECT id, bank_name, account_no, ifsc_code, status, note, created_at,
                    reject_reason, decided_at
               FROM bank_change_requests
              WHERE party_type = 'CUSTOMER' AND party_id = $1::uuid
              ORDER BY created_at DESC LIMIT 1`, [req.party.customerId]),
    ]);
    const c = cust[0] ?? {};
    const p = pend[0] ?? null;
    return {
      on_file: {
        bank_name: c.bank_name ?? null,
        account_no_masked: maskAccount(c.account_no),
        account_no_last4: c.account_no ? String(c.account_no).slice(-4) : null,
        ifsc_code: c.ifsc_code ?? null,
        // Nothing on file is a fact, not an error: most customers were created
        // from the old books, which never held an account number.
        present: !!(c.bank_name || c.account_no || c.ifsc_code),
      },
      // Only a request still waiting blocks a new one; a decided one is shown
      // so the customer learns the outcome without ringing the office.
      request: p && {
        id: p.id, status: p.status, bank_name: p.bank_name,
        account_no_masked: maskAccount(p.account_no), ifsc_code: p.ifsc_code,
        note: p.note, reject_reason: p.reject_reason,
        created_at: p.created_at, decided_at: p.decided_at,
      },
    };
  });

  app.post('/portal/customer/bank', { preHandler: customerOnly }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    // Same checks the public registration form runs, for the same reason: the
    // browser's validators are a courtesy to the typist.
    const bad = checkParty({ ...b, mobile_no: b.mobile_no ?? '9999999999' }, { requireBank: true })
      .filter((x) => ['bank_name', 'account_no', 'ifsc_code'].includes(x.field));
    if (bad.length) return reply.code(400).send({ error: 'BAD_FIELDS', detail: bad[0].message, fields: bad });

    const account = String(b.account_no ?? '').replace(/\s/g, '');
    const ifsc = String(b.ifsc_code ?? '').trim().toUpperCase();
    const bankName = String(b.bank_name ?? '').trim();

    try {
      const out = await withTransaction(async (c) => {
        const { rows: cur } = await c.query(
          `SELECT bank_name, account_no, ifsc_code FROM customers WHERE id = $1::uuid`,
          [req.party.customerId]);
        const now = cur[0] ?? {};
        // Asking for what is already on file is not a request — it is a no-op
        // that would put a pointless card on the desk.
        if (String(now.account_no ?? '') === account && String(now.ifsc_code ?? '') === ifsc
            && String(now.bank_name ?? '') === bankName) {
          return { unchanged: true };
        }
        // One open request per party (uq_bank_change_open): a second submission
        // REPLACES the first, so the desk never holds two accounts for one firm
        // and the customer can correct a typo before anyone looks.
        const { rows: open } = await c.query(
          `SELECT id FROM bank_change_requests
            WHERE party_type = 'CUSTOMER' AND party_id = $1::uuid AND status = 'PENDING'
            FOR UPDATE`, [req.party.customerId]);
        if (open.length) {
          const { rows } = await c.query(`
            UPDATE bank_change_requests
               SET bank_name = $2, account_no = $3, ifsc_code = $4, note = $5,
                   prev_bank_name = $6, prev_account_no = $7, prev_ifsc_code = $8,
                   created_at = now()
             WHERE id = $1::uuid RETURNING *`,
            [open[0].id, bankName, account, ifsc, b.note ?? null,
             now.bank_name ?? null, now.account_no ?? null, now.ifsc_code ?? null]);
          return { replaced: true, row: rows[0] };
        }
        const { rows } = await c.query(`
          INSERT INTO bank_change_requests
            (party_type, party_id, bank_name, account_no, ifsc_code, note,
             prev_bank_name, prev_account_no, prev_ifsc_code, requested_by, requested_name)
          VALUES ('CUSTOMER', $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10)
          RETURNING *`,
          [req.party.customerId, bankName, account, ifsc, b.note ?? null,
           now.bank_name ?? null, now.account_no ?? null, now.ifsc_code ?? null,
           req.user?.sub ?? null, req.user?.name ?? null]);
        return { row: rows[0] };
      });

      if (out.unchanged) {
        return reply.code(200).send({ unchanged: true, message: 'These are the details already on file — nothing to change.' });
      }
      return reply.code(201).send({
        request: { id: out.row.id, status: out.row.status,
                   bank_name: out.row.bank_name, account_no_masked: maskAccount(out.row.account_no),
                   ifsc_code: out.row.ifsc_code, created_at: out.row.created_at },
        replaced: !!out.replaced,
        // Every external write reads as "sent to office", because that is what
        // the fence makes true.
        message: 'Sent to the office. Your account will change once they verify it.',
      });
    } catch (e) {
      req.log?.error?.({ err: e }, 'bank change request failed');
      return reply.code(500).send({ error: 'BANK_REQUEST_FAILED', detail: e.message });
    }
  });
}
