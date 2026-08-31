// ═══════════════════════════════════════════════════════════════════════════
// driverPortal.routes.js — the driver app's scoped back end (/portal/driver/*)
//
// Born from the 2026-08-31 security audit. The driver app used to lean on two
// surfaces, both wrong: /api/v1/masters/* (which apiGuard rightly 403'd — the
// khata and request calls never worked), and /api/v1/ops/* (which apiGuard
// wrongly allowed — a driver token could read the vendor master's bank
// accounts and PATCH any trip). Both doors are now shut, and this module is
// the replacement: the same three rules as the customer/vendor portals.
//
//   · SCOPE COMES FROM THE SESSION. A driver session's `sub` IS drivers.id
//     (auth.routes mints it that way). Every query filters by it; no parameter
//     can widen it.
//   · READ OWN, SUBMIT STAGED. The khata and trip list are reads of the
//     driver's own rows. The only write is a driver_request, which lands
//     PENDING — cash moves when the office pays it (masters' /pay flow),
//     never here. Uploaded photos ride along as file keys in the driver's own
//     up/driver/<id>/ vault namespace.
//   · THE GATE IS THE SAME. drivers.is_approved_for_portal is checked on every
//     request, so withdrawing approval takes effect immediately.
// ═══════════════════════════════════════════════════════════════════════════
import { query, isDegraded } from '../db/pool.js';
import { requireAuth } from './auth.routes.js';

const dbGate = (reply) =>
  reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });

/** Resolve the calling driver, fresh from the database, or reply 403.
 *  Exported for the statement-PDF route, which serves all three party roles. */
export async function resolveDriver(req, reply) {
  const done = await requireAuth(req, reply);
  if (done !== undefined) return done;
  if (req.user?.role !== 'DRIVER') {
    return reply.code(403).send({ error: 'FORBIDDEN', detail: 'driver portal only' });
  }
  const { rows } = await query(
    `SELECT id, name, mobile, status, COALESCE(is_approved_for_portal, false) AS approved
       FROM drivers WHERE id = $1::uuid`, [req.user.sub]);
  const d = rows[0];
  if (!d || d.status !== 'ACTIVE') {
    return reply.code(403).send({ error: 'FORBIDDEN', detail: 'driver account is not active' });
  }
  if (!d.approved) {
    return reply.code(403).send({
      error: 'PORTAL_NOT_APPROVED',
      detail: 'This driver account is not yet approved for app access. '
            + 'Prasad Transport office must enable it first.',
    });
  }
  req.driver = { id: d.id, name: d.name, mobile: d.mobile };
}

export function registerDriverPortalRoutes(app) {
  // ── My duty: current trips ────────────────────────────────────────────────
  // Deliberately NOT SELECT * — a trip row carries freight, margin and office
  // cash figures that are not the driver's business even on their own trip.
  app.get('/portal/driver/trips', { preHandler: resolveDriver }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT id, trip_code, status, vehicle_no, product_type,
              loading_date, loading_point, loaded_qty,
              unloading_date, unloading_location, unloaded_qty,
              challan_no, advice_no
         FROM trips
        WHERE driver_id = $1::uuid
          AND status NOT IN ('COMPLETED','SETTLED','CANCELLED')
        ORDER BY loading_date DESC NULLS LAST LIMIT 50`, [req.driver.id]);
    return { count: rows.length, trips: rows };
  });

  // ── My khata ──────────────────────────────────────────────────────────────
  app.get('/portal/driver/khata', { preHandler: resolveDriver }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows: entries } = await query(
      `SELECT dt.txn_date, dt.txn_type, dt.amount, dt.mode, dt.remarks, t.trip_code
         FROM driver_transactions dt LEFT JOIN trips t ON t.id = dt.trip_id
        WHERE dt.driver_id = $1::uuid OR dt.driver_name = $2
        ORDER BY dt.txn_date DESC NULLS LAST, dt.created_at DESC LIMIT 200`,
      [req.driver.id, req.driver.name]);
    const { rows: sums } = await query(
      `SELECT COALESCE(sum(amount) FILTER (WHERE txn_type IN ('ADVANCE_GIVEN','FUEL_EXPENSE')),0)::numeric(16,2) AS given,
              COALESCE(sum(amount) FILTER (WHERE txn_type NOT IN ('ADVANCE_GIVEN','FUEL_EXPENSE')),0)::numeric(16,2) AS earned
         FROM driver_transactions
        WHERE driver_id = $1::uuid OR driver_name = $2`, [req.driver.id, req.driver.name]);
    return { driver: req.driver.name, count: entries.length, entries, totals: sums[0] };
  });

  // ── My requests (staged — the office pays or rejects, never this route) ───
  app.get('/portal/driver/requests', { preHandler: resolveDriver }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT r.id, r.request_type, r.amount, r.status, r.remarks, r.photo_url,
              r.requested_at, r.settled_at, r.payment_mode, t.trip_code
         FROM driver_requests r LEFT JOIN trips t ON t.id = r.trip_id
        WHERE r.driver_id = $1::uuid
        ORDER BY r.requested_at DESC LIMIT 100`, [req.driver.id]);
    return { count: rows.length, requests: rows };
  });

  app.post('/portal/driver/requests', { preHandler: resolveDriver }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const type = String(b.request_type ?? '').toUpperCase();
    if (!['ADVANCE', 'FUEL', 'EXPENSE', 'LEAVE', 'OTHER'].includes(type)) {
      return reply.code(400).send({ error: 'BAD_TYPE', detail: 'request_type must be ADVANCE, FUEL, EXPENSE, LEAVE or OTHER' });
    }
    const amount = Number(b.amount ?? 0);
    if (!Number.isFinite(amount) || amount < 0) {
      return reply.code(400).send({ error: 'BAD_AMOUNT' });
    }
    // The trip, if named, must be the driver's own — a request pinned to
    // somebody else's trip would mislead the office desk.
    let tripId = null;
    if (b.trip_id) {
      const { rows: T } = await query(
        `SELECT id FROM trips WHERE id = $1::uuid AND driver_id = $2::uuid`,
        [b.trip_id, req.driver.id]);
      if (!T.length) return reply.code(404).send({ error: 'NO_SUCH_TRIP', detail: 'that trip is not yours' });
      tripId = T[0].id;
    }
    const { rows } = await query(
      `INSERT INTO driver_requests (driver_id, driver_name, trip_id, request_type, amount, remarks, photo_url)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7)
       RETURNING id, request_type, amount, status, requested_at`,
      [req.driver.id, req.driver.name, tripId, type, amount,
       b.remarks ?? null, b.photo_url ?? null]);
    return reply.code(201).send({
      ...rows[0],
      detail: 'Request sent to the office. It is PENDING until the office approves and pays it — '
            + 'nothing lands in your khata before that.',
    });
  });
}
