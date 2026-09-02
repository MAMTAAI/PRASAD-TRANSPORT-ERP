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
const VIEW_AS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveParty(req, reply) {
  const done = await requireAuth(req, reply);
  if (done !== undefined) return done;                 // requireAuth already replied

  // ── STAFF "VIEW AS" (2026-09-02) ────────────────────────────────────────
  // The office previews the REAL customer / vendor app scoped to one party by
  // naming it in a header — X-View-As-Customer or X-View-As-Vendor — instead
  // of the hardcoded legacy portal. Three rules keep it a preview and not an
  // impersonation: only ADMIN / SUPER_ADMIN may; the party must exist; and it
  // is READ-ONLY — any non-GET is refused before a route runs, so nothing can
  // be posted, accepted, booked or uploaded on a party's behalf. The 31-Aug
  // portal-approval gate does not apply: staff may look at an unapproved
  // party's empty app, which is exactly what they need to see before approving.
  const viewCustomer = String(req.headers['x-view-as-customer'] ?? '').trim();
  const viewVendor = String(req.headers['x-view-as-vendor'] ?? '').trim();
  if (viewCustomer || viewVendor) {
    const staffRole = String(req.user?.role ?? '').toUpperCase();
    if (!['ADMIN', 'SUPER_ADMIN'].includes(staffRole)) {
      return reply.code(403).send({ error: 'FORBIDDEN', detail: 'view-as is for office staff' });
    }
    if (!['GET', 'HEAD'].includes(String(req.method).toUpperCase())) {
      return reply.code(405).send({
        error: 'VIEW_AS_READ_ONLY',
        detail: 'Preview is read-only — nothing is posted, accepted, booked or uploaded on a party\'s behalf.',
      });
    }
    const isCustomer = !!viewCustomer;
    const id = isCustomer ? viewCustomer : viewVendor;
    if (!VIEW_AS_UUID.test(id)) return reply.code(400).send({ error: 'BAD_PARTY_ID' });
    const { rows } = await query(
      isCustomer
        ? `SELECT id, customer_name AS name, COALESCE(portal_features, '{}'::jsonb) AS features FROM customers WHERE id = $1::uuid`
        : `SELECT id, vendor_name AS name, COALESCE(portal_features, '{}'::jsonb) AS features FROM vendors WHERE id = $1::uuid`,
      [id]);
    if (!rows.length) return reply.code(404).send({ error: 'NO_SUCH_PARTY' });
    req.party = {
      role: isCustomer ? 'CUSTOMER' : 'VENDOR',
      customerId: isCustomer ? id : null, vendorId: isCustomer ? null : id,
      features: rows[0].features ?? {},
      viewAs: true, viewAsName: rows[0].name, viewAsBy: req.user?.sub ?? null,
    };
    return;
  }

  // One query answers the role, the scope AND the gate. Fetching the party
  // separately would leave a window where a route could read data for an
  // account whose approval had just been withdrawn.
  const { rows } = await query(
    `SELECT u.role::text AS role, u.customer_id, u.vendor_id, u.status,
            COALESCE(c.is_approved_for_portal, v.is_approved_for_portal, false) AS approved,
            COALESCE(c.portal_features, v.portal_features, '{}'::jsonb)         AS features
       FROM users u
       LEFT JOIN customers c ON c.id = u.customer_id
       LEFT JOIN vendors   v ON v.id = u.vendor_id
      WHERE u.id = $1::uuid`, [req.user.sub]);
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

  // THE GATE. Default-deny: a party is dark until an admin says otherwise, and
  // this is checked on EVERY request rather than at login, so withdrawing
  // approval takes effect on the next call instead of whenever the session
  // happens to expire. A distinct code, because the SPA shows a different
  // screen for "waiting on the office" than for "you are not allowed".
  if (!u.approved) {
    return reply.code(403).send({
      error: 'PORTAL_NOT_APPROVED',
      detail: 'This account is not yet approved for portal access. '
            + 'Prasad Transport office must enable it before any data is shown.',
    });
  }

  req.party = {
    role: u.role, customerId: u.customer_id, vendorId: u.vendor_id,
    features: u.features ?? {},
  };
}

/** What this caller may actually see.
 *
 *  Three layers ANDed: the gate (already passed to get here), the admin's
 *  role-wide matrix, and the party's own feature map. ANDed, never ORed — a
 *  stale per-party flag must not be able to re-open what the role matrix closed,
 *  or "no VENDOR sees ledgers" becomes a suggestion. */
export async function visibleModules(party) {
  const { rows } = await query(
    `SELECT module_key, parent_key, label, is_visible, sensitive
       FROM v_portal_role_matrix WHERE role = $1`, [party.role]);
  const out = {};
  for (const m of rows) {
    const roleAllows = m.is_visible;
    const short = m.module_key.split('.').slice(1).join('.');
    const partyOverride = party.features?.[short] ?? party.features?.[m.module_key];
    out[m.module_key] = roleAllows && partyOverride !== false;
  }
  // A field cannot be visible when its page is not.
  for (const m of rows) {
    if (m.parent_key && out[m.parent_key] === false) out[m.module_key] = false;
  }
  return out;
}

/** Guard a route behind a module key. */
export const needsModule = (moduleKey) => async (req, reply) => {
  const done = await resolveParty(req, reply);
  if (done !== undefined) return done;
  const vis = await visibleModules(req.party);
  if (!vis[moduleKey]) {
    return reply.code(403).send({
      error: 'MODULE_NOT_ENABLED',
      detail: `${moduleKey} is switched off for the ${req.party.role} role.`,
      module: moduleKey,
    });
  }
  req.visible = vis;
};

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
      // vendor_kind decides WHICH app a VENDOR login opens — FLEET_PARTNER → the
    // Fleet Partner app (trucks, bids, settlements); SERVICE → the Service
    // Vendor portal (expense bills). Two businesses, one login role.
    return { role, party: rows[0] ?? null, vendor_kind: rows[0]?.vendor_kind ?? null, view_as: !!req.party.viewAs };
    }
    const { rows } = await query(
      `SELECT id, vendor_name AS name, vendor_type, vendor_kind, email, mobile_no, address,
              gst_no, payment_terms, current_balance, max_vehicle_limit, portal_features
         FROM vendors WHERE id = $1::uuid`, [vendorId]);
    // vendor_kind decides WHICH app a VENDOR login opens — FLEET_PARTNER → the
    // Fleet Partner app (trucks, bids, settlements); SERVICE → the Service
    // Vendor portal (expense bills). Two businesses, one login role.
    return { role, party: rows[0] ?? null, vendor_kind: rows[0]?.vendor_kind ?? null, view_as: !!req.party.viewAs };
  });

  // ── What may this account see ─────────────────────────────────────────────
  // The portal asks once on load and hides what it must. Hiding in the client
  // is presentation only — every route below is guarded independently, because
  // a hidden button is not a permission.
  app.get('/portal/capabilities', { preHandler: resolveParty }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const vis = await visibleModules(req.party);
    const { rows } = await query(
      `SELECT module_key, label, description, parent_key, sensitive, sort_order
         FROM v_portal_role_matrix WHERE role = $1 ORDER BY sort_order`, [req.party.role]);
    return {
      role: req.party.role,
      vendor_kind: req.party.role === 'VENDOR'
        ? (await query('SELECT vendor_kind FROM vendors WHERE id = $1::uuid', [req.party.vendorId])).rows[0]?.vendor_kind ?? null
        : null,
      view_as: !!req.party.viewAs,
      modules: rows.map((m) => ({ ...m, visible: !!vis[m.module_key] })),
      visible: vis,
    };
  });

  // ── Customer: my loads ────────────────────────────────────────────────────
  // Deliberately NOT `SELECT *`. A trip row carries what we pay the driver,
  // what the trip cost us and what margin it left — none of which is the
  // customer's business even though the row is "theirs".
  app.get('/portal/customer/trips', { preHandler: needsModule('cust.shipments') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const limit = pageSize(req.query?.limit);
    // FIELD-LEVEL GATING IS DONE IN THE SELECT, not by deleting keys afterwards.
    // A route that fetches the freight and then strips it has already put the
    // number in the process, in the query log and in any error report that
    // dumps the row. Not selecting it is the only version that is actually
    // withheld.
    const showFreight = !!req.visible['cust.shipments.freight'];
    const showDriver  = !!req.visible['cust.shipments.driver'];
    const { rows } = await query(
      `SELECT trip_code, status, vehicle_no, product_type,
              loading_date, loading_point, loaded_qty,
              unloading_date, unloading_location, unloaded_qty, shortage_qty,
              challan_no, advice_no, billing_status
              ${showFreight ? ', COALESCE(NULLIF(billed_amount,0), freight_amount) AS freight_amount' : ''}
              ${showDriver ? ', driver_name, driver_mobile' : ''}
         FROM trips
        WHERE customer_id = $1::uuid
        ORDER BY loading_date DESC NULLS LAST
        LIMIT $2`, [req.party.customerId, limit]);
    return {
      count: rows.length,
      trips: rows,
      // Say which fields were withheld rather than letting the client guess
      // whether a missing key means "hidden" or "not recorded".
      withheld: [
        ...(showFreight ? [] : ['freight_amount']),
        ...(showDriver ? [] : ['driver_name', 'driver_mobile']),
      ],
    };
  });

  // ── Customer: my bills ────────────────────────────────────────────────────
  app.get('/portal/customer/bills', { preHandler: needsModule('cust.ledger') }, async (req, reply) => {
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
  app.get('/portal/vendor/vehicles', { preHandler: needsModule('vend.vehicles') }, async (req, reply) => {
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
  app.get('/portal/vendor/bills', { preHandler: needsModule('vend.bills') }, async (req, reply) => {
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
