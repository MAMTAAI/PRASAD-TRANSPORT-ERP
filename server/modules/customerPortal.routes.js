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
            status, posted_by)
          VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8,COALESCE($9,0),$10,$11,$12,'OPEN','CUSTOMER_PORTAL')
          RETURNING *`,
          [loadId, me[0]?.customer_name ?? 'CUSTOMER', req.party.customerId,
           b.origin, b.destination, b.distance_km ?? null, b.material ?? null, b.weight ?? null,
           b.target_rate ?? null, b.loading_date || null, b.vehicle_type ?? null, b.rate_type ?? null]);
        return rows[0];
      });
      return reply.code(201).send({
        load: row,
        detail: 'Load posted. Verified fleet partners can now bid; you will see their offers under this load.',
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

      await c.query(`UPDATE bazaar_bids SET status = 'REJECTED', updated_at = now()
                      WHERE load_id = $1 AND id <> $2::uuid AND status = 'PENDING'`,
        [req.params.loadId, bidId]);
      const { rows: W } = await c.query(
        `UPDATE bazaar_bids SET status = 'ACCEPTED', updated_at = now() WHERE id = $1::uuid RETURNING *`, [bidId]);
      const { rows: U } = await c.query(
        `UPDATE bazaar_loads SET status = 'AWARDED', updated_at = now() WHERE load_id = $1 RETURNING *`,
        [req.params.loadId]);
      return { code: 200, body: { load: U[0], bid: W[0] }, vendorMobile: B[0].vendor_mobile };
    });

    if (out.code === 200 && out.vendorMobile) {
      // After commit, never inside it — a slow engine must not hold the award.
      notifyWhatsApp(out.vendorMobile,
        `🎉 Load Bazaar: aapki bid ₹${out.body.bid.bid_amount} load ${req.params.loadId} `
        + `(${out.body.load.origin} → ${out.body.load.destination}) ke liye ACCEPT ho gayi hai. `
        + `Prasad Transport office se agla step confirm hoga.`);
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
}
