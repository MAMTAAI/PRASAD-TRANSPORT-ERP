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
import { resolveParty, needsModule } from './portal.routes.js';
import { notifyWhatsApp } from '../lib/notify.js';
import { openSettlementInTx } from './bazaarSettlement.routes.js';

const dbGate = (reply) =>
  reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const customerOnly = async (req, reply) => {
  const done = await resolveParty(req, reply);
  if (done !== undefined) return done;
  if (req.party.role !== 'CUSTOMER') {
    return reply.code(403).send({ error: 'FORBIDDEN', detail: 'customer portal only' });
  }
};

export function registerCustomerPortalRoutes(app) {
  // ═══ MY LOADS ═════════════════════════════════════════════════════════════

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
            status, posted_by, book_now_rate, bid_close_at)
          VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8,COALESCE($9,0),$10,$11,$12,'PENDING_REVIEW','CUSTOMER_PORTAL',
                  $13, CASE WHEN $14::numeric IS NULL THEN NULL
                            ELSE now() + ($14::numeric * interval '1 hour') END)
          RETURNING *`,
          [loadId, me[0]?.customer_name ?? 'CUSTOMER', req.party.customerId,
           b.origin, b.destination, b.distance_km ?? null, b.material ?? null, b.weight ?? null,
           b.target_rate ?? null, b.loading_date || null, b.vehicle_type ?? null, b.rate_type ?? null,
           bookNow, closeHours]);
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

  // ═══ SHIPMENT TRACKING (scoped) ═══════════════════════════════════════════
  // The generic /api/v1/tracking/:tripId would let any holder of a trip id read
  // any truck's position, so CUSTOMER stays outside that prefix. This is the
  // scoped version: the trip must be THE CALLER'S, checked by customer_id.
  app.get('/portal/customer/trips/:tripCode/tracking', { preHandler: needsModule('cust.shipments') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows: T } = await query(
      `SELECT id, trip_code, status, vehicle_no FROM trips
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
    return {
      trip_code: T[0].trip_code,
      status: T[0].status,
      vehicle_no: T[0].vehicle_no,
      // null when no ping exists — the app shows "position not reported yet",
      // never an invented truck (same honesty rule as TripTrackingMap).
      position: fix[0] ?? null,
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
             s.pod_file, s.pod_submitted_at, s.pod_verified_at, s.cancel_reason,
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
}
