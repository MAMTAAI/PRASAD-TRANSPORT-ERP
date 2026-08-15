// server/modules/portal.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// The customer and vendor portals — the two of the five roles that had no way
// in. CUSTOMER could at least be spelled in the role enum; VENDOR could not be
// stored at all, and /api/v1/vendor/bills (which VendorPortal.tsx has always
// called) was never implemented. Both are external parties: everything here is
// written on the assumption that the caller is outside the company.
//
// SCOPE IS DERIVED, NEVER ACCEPTED. Every query is filtered by a party id read
// from the *database* using the authenticated user id, on each request. The
// client never sends a customer_id and the token never carries one:
//
//   - a token is a bearer credential that outlives changes; a party link read
//     fresh cannot go stale against a revoked or re-pointed account, and
//   - the id never crosses the wire inbound, so there is no parameter to tamper
//     with. The classic failure here is `WHERE customer_id = $1` fed from the
//     query string, which turns one customer's login into every customer's
//     freight rates.
//
// There is no write surface. These roles read their own history; anything that
// changes ERP state goes through staff routes with their own guards.
// ─────────────────────────────────────────────────────────────────────────────
import { query, isDegraded } from '../db/pool.js';
import { requireAuth } from './auth.routes.js';

const dbGate = (reply) =>
  reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });

/** Resolve the caller's party link from the database.
 *
 *  Returns { role, customerId, vendorId } or replies 403. A CUSTOMER/VENDOR row
 *  cannot exist unscoped (migration 048's users_portal_scope CHECK), so a null
 *  link here means the account was tampered with or the role was changed out
 *  from under it — either way it is not a session that should read anything. */
async function resolveParty(req, reply) {
  const done = await requireAuth(req, reply);
  if (done !== undefined) return done;                 // requireAuth already replied

  const { rows } = await query(
    `SELECT role::text AS role, customer_id, vendor_id, status
       FROM users WHERE id = $1::uuid`, [req.user.sub]);
  const u = rows[0];
  if (!u || u.status !== 'ACTIVE') {
    return reply.code(403).send({ error: 'FORBIDDEN', detail: 'account is not active' });
  }
  if (u.role !== 'CUSTOMER' && u.role !== 'VENDOR') {
    return reply.code(403).send({ error: 'FORBIDDEN', detail: 'portal roles only' });
  }
  if ((u.role === 'CUSTOMER' && !u.customer_id) || (u.role === 'VENDOR' && !u.vendor_id)) {
    return reply.code(403).send({ error: 'UNSCOPED_PORTAL_ACCOUNT' });
  }
  req.party = { role: u.role, customerId: u.customer_id, vendorId: u.vendor_id };
}

/** Narrow a portal guard to one role. */
const only = (role) => async (req, reply) => {
  const done = await resolveParty(req, reply);
  if (done !== undefined) return done;
  if (req.party.role !== role) {
    return reply.code(403).send({ error: 'FORBIDDEN', detail: `${role} portal only` });
  }
};

// Page size is capped server-side. An external caller asking for limit=1000000
// is either careless or probing; either way it should not become a table scan
// the whole ERP waits behind.
const pageSize = (v, def = 50, max = 200) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
};

export function registerPortalRoutes(app) {
  // ── Who am I ──────────────────────────────────────────────────────────────
  app.get('/portal/me', { preHandler: resolveParty }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { role, customerId, vendorId } = req.party;

    if (role === 'CUSTOMER') {
      const { rows } = await query(
        `SELECT id, customer_name AS name, customer_code AS code, email, mobile_no,
                address, city, state, gst_no, payment_terms, credit_limit,
                current_outstanding, portal_features
           FROM customers WHERE id = $1::uuid`, [customerId]);
      return { role, party: rows[0] ?? null };
    }
    const { rows } = await query(
      `SELECT id, vendor_name AS name, vendor_type, email, mobile_no, address,
              gst_no, payment_terms, current_balance, max_vehicle_limit, portal_features
         FROM vendors WHERE id = $1::uuid`, [vendorId]);
    return { role, party: rows[0] ?? null };
  });

  // ── Customer: my loads ────────────────────────────────────────────────────
  // Deliberately NOT `SELECT *`. A trip row carries what we pay the driver,
  // what the trip cost us and what margin it left — none of which is the
  // customer's business even though the row is "theirs".
  app.get('/portal/customer/trips', { preHandler: only('CUSTOMER') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const limit = pageSize(req.query?.limit);
    const { rows } = await query(
      `SELECT trip_code, status, vehicle_no, product_type,
              loading_date, loading_point, loaded_qty,
              unloading_date, unloading_location, unloaded_qty, shortage_qty,
              challan_no, advice_no, billing_status
         FROM trips
        WHERE customer_id = $1::uuid
        ORDER BY loading_date DESC NULLS LAST
        LIMIT $2`, [req.party.customerId, limit]);
    return { count: rows.length, trips: rows };
  });

  // ── Customer: my bills ────────────────────────────────────────────────────
  app.get('/portal/customer/bills', { preHandler: only('CUSTOMER') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const limit = pageSize(req.query?.limit);
    const { rows } = await query(
      `SELECT bill_no, bill_date, period_from, period_to, location,
              total_gross, total_shortage, total_tds,
              total_cgst, total_sgst, total_igst, total_net,
              received_amount, status
         FROM company_bills
        WHERE customer_id = $1::uuid
        ORDER BY bill_date DESC NULLS LAST
        LIMIT $2`, [req.party.customerId, limit]);
    return { count: rows.length, bills: rows };
  });

  // ── Vendor: my vehicles ───────────────────────────────────────────────────
  app.get('/portal/vendor/vehicles', { preHandler: only('VENDOR') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT registration_no, vehicle_class, capacity, driver_name, driver_mobile,
              rc_expiry, ins_expiry, puc_expiry, fit_expiry, np_expiry, system_status
         FROM market_vehicles
        WHERE vendor_id = $1::uuid
        ORDER BY registration_no`, [req.party.vendorId]);
    return { count: rows.length, vehicles: rows };
  });

  // ── Vendor: my account ────────────────────────────────────────────────────
  // The route VendorPortal.tsx has been calling since it was written. It has
  // never existed until now, which is the other half of why that portal was
  // unreachable.
  app.get('/portal/vendor/bills', { preHandler: only('VENDOR') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const limit = pageSize(req.query?.limit);
    const { rows } = await query(
      `SELECT txn_date, txn_type, amount, payment_mode, remarks
         FROM vendor_txns
        WHERE vendor_id = $1::uuid
        ORDER BY txn_date DESC NULLS LAST
        LIMIT $2`, [req.party.vendorId, limit]);
    const { rows: bal } = await query(
      'SELECT current_balance FROM vendors WHERE id = $1::uuid', [req.party.vendorId]);
    return { count: rows.length, current_balance: bal[0]?.current_balance ?? null, transactions: rows };
  });
}
