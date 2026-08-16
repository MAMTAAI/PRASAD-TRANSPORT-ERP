// ═══════════════════════════════════════════════════════════════════════════
// vendorPortal.routes.js — the Fleet Partner app's back end
//
// BLIND BIDDING IS A SERVER PROPERTY, NOT A UI ONE. Every route here is written
// so that a vendor holding a valid token and a terminal cannot learn another
// vendor's rate. That means:
//   · the load feed reads v_bazaar_load_feed, which has no target_rate and no
//     bid amounts — not "selects them and hides them"
//   · /bids returns WHERE vendor_id = me, always, with no override parameter
//   · one live bid per vendor per load (unique index), so nobody can probe by
//     submitting five and watching which are rejected
//   · the bid count IS public. Knowing a load is contested is fair and useful;
//     knowing BY HOW MUCH is the thing being protected.
//
// EVERYTHING A PARTNER CREATES IS PENDING. Trucks, drivers and bids all land in
// an approval state and none of them reach the live fleet, the dispatch board
// or a ledger until an admin says so. That is not politeness — a market vehicle
// that appeared in `vehicles` would enter compliance alerts, the tyre register
// and the FASTag wallet for a truck the firm does not own.
// ═══════════════════════════════════════════════════════════════════════════
import { createHash } from 'node:crypto';
import { query, withTransaction, isDegraded } from '../db/pool.js';
import { resolveParty, visibleModules, needsModule } from './portal.routes.js';

const dbGate = (reply) =>
  reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });

const vendorOnly = async (req, reply) => {
  const done = await resolveParty(req, reply);
  if (done !== undefined) return done;
  if (req.party.role !== 'VENDOR') {
    return reply.code(403).send({ error: 'FORBIDDEN', detail: 'fleet partner portal only' });
  }
};

/** Same masking rule as drivers (067): a third party's national ID is no less
 *  sensitive for belonging to somebody else's employee. */
const aadhaarBits = (raw) => {
  const digits = String(raw ?? '').replace(/[^0-9]/g, '');
  if (!/^[0-9]{12}$/.test(digits)) return { hash: null, last4: null };
  return { hash: createHash('sha256').update(digits).digest('hex'), last4: digits.slice(-4) };
};

export function registerVendorPortalRoutes(app) {
  // ═══════════════════════════════════════════════════════════════════════
  // 1. LIVE LOAD BOARD
  // ═══════════════════════════════════════════════════════════════════════

  app.get('/portal/vendor/loads', { preHandler: needsModule('vend.bazaar') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const showTarget = !!req.visible['vend.bazaar.target'];

    // The feed view carries no rates at all. target_rate is added back only if
    // the admin has explicitly opened that field for the VENDOR role — off by
    // default, because a visible target turns a blind auction into "match the
    // number the office already wrote down".
    const { rows } = await query(`
      SELECT f.*, ${showTarget ? 'l.target_rate' : 'NULL::numeric AS target_rate'},
             mine.id            AS my_bid_id,
             mine.bid_amount    AS my_bid_amount,
             mine.status        AS my_bid_status,
             mine.created_at    AS my_bid_at
        FROM v_bazaar_load_feed f
        JOIN bazaar_loads l ON l.load_id = f.load_id
        LEFT JOIN LATERAL (
          SELECT b.id, b.bid_amount, b.status, b.created_at
            FROM bazaar_bids b
           WHERE b.load_id = f.load_id AND b.vendor_id = $1::uuid
           ORDER BY b.created_at DESC LIMIT 1
        ) mine ON true
       WHERE f.status = 'OPEN'
       ORDER BY f.loading_date ASC NULLS LAST, f.created_at DESC
       LIMIT 100`, [req.party.vendorId]);

    return {
      count: rows.length,
      blind: true,
      target_visible: showTarget,
      loads: rows,
    };
  });

  app.post('/portal/vendor/loads/:loadId/bid', { preHandler: needsModule('vend.bazaar') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const amount = Number(req.body?.bid_amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return reply.code(400).send({ error: 'BAD_AMOUNT', detail: 'a bid needs a positive rupee amount' });
    }

    return withTransaction(async (t) => {
      const { rows: load } = await t.query(
        `SELECT load_id, status FROM bazaar_loads WHERE load_id = $1 FOR UPDATE`, [req.params.loadId]);
      if (!load[0]) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'no such load' });
      if (load[0].status !== 'OPEN') {
        return reply.code(409).send({
          error: 'LOAD_CLOSED',
          detail: `this load is ${load[0].status.toLowerCase()} and is no longer taking bids`,
        });
      }

      const { rows: vend } = await t.query(
        `SELECT vendor_name FROM vendors WHERE id = $1::uuid`, [req.party.vendorId]);

      // Re-bidding withdraws the previous offer rather than stacking a second.
      // The unique index enforces this anyway; doing it explicitly means the
      // partner gets "your bid was revised" instead of a constraint error.
      const { rowCount: withdrawn } = await t.query(
        `UPDATE bazaar_bids SET status='WITHDRAWN', updated_at=now()
          WHERE load_id=$1 AND vendor_id=$2::uuid AND status='PENDING'`,
        [req.params.loadId, req.party.vendorId]);

      const { rows } = await t.query(`
        INSERT INTO bazaar_bids (load_id, vendor_name, vendor_id, bid_amount, remarks, status)
        VALUES ($1, $2, $3::uuid, $4, $5, 'PENDING')
        RETURNING id, load_id, bid_amount, status, created_at`,
        [req.params.loadId, vend[0]?.vendor_name ?? 'unknown',
         req.party.vendorId, amount, req.body?.remarks ?? null]);

      return reply.code(201).send({
        ...rows[0],
        revised: withdrawn > 0,
        // Said plainly so the app can show the right thing: this is not an
        // award, and nothing has been agreed.
        detail: 'Bid submitted to the Prasad Transport office. It is pending review — '
              + 'you will see the result here once the office decides.',
      });
    });
  });

  // ONLY the caller's own bids. There is no parameter that widens this.
  app.get('/portal/vendor/bids', { preHandler: needsModule('vend.bazaar') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`
      SELECT b.id, b.load_id, b.bid_amount, b.status, b.remarks, b.created_at,
             l.origin, l.destination, l.material, l.weight, l.loading_date, l.status AS load_status
        FROM bazaar_bids b
        JOIN bazaar_loads l ON l.load_id = b.load_id
       WHERE b.vendor_id = $1::uuid
       ORDER BY b.created_at DESC LIMIT 100`, [req.party.vendorId]);
    return { count: rows.length, bids: rows };
  });

  app.post('/portal/vendor/bids/:id/withdraw', { preHandler: needsModule('vend.bazaar') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `UPDATE bazaar_bids SET status='WITHDRAWN', updated_at=now()
        WHERE id=$1::uuid AND vendor_id=$2::uuid AND status='PENDING'
        RETURNING id, status`, [req.params.id, req.party.vendorId]);
    if (!rows[0]) {
      return reply.code(409).send({
        error: 'NOT_WITHDRAWABLE',
        detail: 'that bid is not yours, or it has already been decided',
      });
    }
    return rows[0];
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. MY FLEET & DRIVERS
  // ═══════════════════════════════════════════════════════════════════════

  app.get('/portal/vendor/fleet', { preHandler: needsModule('vend.vehicles') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows: vehicles } = await query(`
      SELECT v.id, v.registration_no, v.vehicle_class, v.capacity, v.system_status,
             v.rc_expiry, v.ins_expiry, v.puc_expiry, v.fit_expiry, v.np_expiry,
             v.reject_reason, v.created_at,
             d.id AS driver_id, d.name AS driver_name, d.mobile AS driver_mobile
        FROM market_vehicles v
        LEFT JOIN market_drivers d ON d.id = v.market_driver_id
       WHERE v.vendor_id = $1::uuid
       ORDER BY v.created_at DESC`, [req.party.vendorId]);
    const { rows: drivers } = await query(`
      SELECT id, name, mobile, licence_no, licence_expiry, aadhaar_last4,
             system_status, reject_reason, created_at
        FROM market_drivers WHERE vendor_id = $1::uuid
       ORDER BY created_at DESC`, [req.party.vendorId]);
    return {
      vehicles,
      drivers,
      pending: vehicles.filter((v) => v.system_status === 'PENDING APPROVAL').length
             + drivers.filter((d) => d.system_status === 'PENDING APPROVAL').length,
    };
  });

  app.post('/portal/vendor/fleet/vehicle', { preHandler: needsModule('vend.vehicles') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const reg = String(req.body?.registration_no ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
    if (!reg) return reply.code(400).send({ error: 'NO_REGISTRATION', detail: 'registration number is required' });

    const { rows: vend } = await query(
      `SELECT vendor_name FROM vendors WHERE id = $1::uuid`, [req.party.vendorId]);
    try {
      const { rows } = await query(`
        INSERT INTO market_vehicles
          (registration_no, vendor_agency, vendor_id, vehicle_class, capacity,
           market_driver_id, rc_expiry, ins_expiry, puc_expiry, fit_expiry, np_expiry,
           system_status, added_by, submitted_by)
        VALUES ($1,$2,$3::uuid,$4,$5,$6::uuid,$7,$8,$9,$10,$11,'PENDING APPROVAL',$12,$13::uuid)
        RETURNING id, registration_no, system_status, created_at`,
        [reg, vend[0]?.vendor_name ?? 'partner', req.party.vendorId,
         req.body?.vehicle_class ?? null, req.body?.capacity ?? null,
         req.body?.market_driver_id ?? null,
         req.body?.rc_expiry ?? null, req.body?.ins_expiry ?? null,
         req.body?.puc_expiry ?? null, req.body?.fit_expiry ?? null,
         req.body?.np_expiry ?? null,
         `portal:${vend[0]?.vendor_name ?? ''}`, req.user.sub]);
      return reply.code(201).send({
        ...rows[0],
        detail: 'Truck submitted for approval. It will not appear on the load board '
              + 'or take a trip until the office approves it.',
      });
    } catch (e) {
      if (e.code === '23505') {
        return reply.code(409).send({
          error: 'ALREADY_REGISTERED',
          detail: `${reg} is already on the system. If it is yours and you cannot see it, `
                + 'the office may still be reviewing it.',
        });
      }
      throw e;
    }
  });

  app.post('/portal/vendor/fleet/driver', { preHandler: needsModule('vend.vehicles') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const name = String(req.body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'NO_NAME', detail: 'driver name is required' });
    const { hash, last4 } = aadhaarBits(req.body?.aadhaar);
    try {
      const { rows } = await query(`
        INSERT INTO market_drivers
          (vendor_id, name, mobile, licence_no, licence_expiry,
           aadhaar_hash, aadhaar_last4, photo_url, licence_photo_url,
           system_status, submitted_by)
        VALUES ($1::uuid,$2,$3,$4,$5::date,$6,$7,$8,$9,'PENDING APPROVAL',$10::uuid)
        RETURNING id, name, mobile, aadhaar_last4, system_status, created_at`,
        [req.party.vendorId, name, req.body?.mobile ?? null, req.body?.licence_no ?? null,
         req.body?.licence_expiry || null, hash, last4,
         req.body?.photo_url ?? null, req.body?.licence_photo_url ?? null, req.user.sub]);
      return reply.code(201).send({
        ...rows[0],
        detail: 'Driver submitted for approval. Aadhaar is stored as a one-way hash — '
              + 'only the last four digits are kept for recognition.',
      });
    } catch (e) {
      if (e.code === '23505') {
        return reply.code(409).send({
          error: 'DUPLICATE_DRIVER',
          detail: 'a driver with this mobile or Aadhaar is already on your list',
        });
      }
      throw e;
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. EARNINGS & WALLET
  // ═══════════════════════════════════════════════════════════════════════

  app.get('/portal/vendor/earnings', { preHandler: needsModule('vend.dashboard') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const vis = await visibleModules(req.party);
    // The ledger is a separate permission from the dashboard. A partner may be
    // allowed to see how many trips ran without being shown the balance.
    const showLedger = !!vis['vend.bills'];

    const { rows: v } = await query(
      `SELECT vendor_name, current_balance, payment_terms FROM vendors WHERE id = $1::uuid`,
      [req.party.vendorId]);

    const { rows: fleet } = await query(`
      SELECT count(*)::int total,
             count(*) FILTER (WHERE system_status = 'System Active')::int active,
             count(*) FILTER (WHERE system_status = 'PENDING APPROVAL')::int pending
        FROM market_vehicles WHERE vendor_id = $1::uuid`, [req.party.vendorId]);

    const { rows: bids } = await query(`
      SELECT count(*) FILTER (WHERE status='PENDING')::int pending,
             count(*) FILTER (WHERE status='ACCEPTED')::int won,
             count(*) FILTER (WHERE status='REJECTED')::int lost
        FROM bazaar_bids WHERE vendor_id = $1::uuid`, [req.party.vendorId]);

    let ledger = null;
    if (showLedger) {
      // vendor_txns has no 'PAID' flag — what it has is the maker-checker state
      // added in 061. An APPROVED row is one whose voucher reached the ledger;
      // anything else is still waiting on the office and must not be presented
      // to the partner as money owed.
      const { rows: t } = await query(`
        SELECT count(*)::int bills,
               COALESCE(sum(amount),0)::numeric(16,2)                        AS billed,
               COALESCE(sum(amount) FILTER (WHERE approval_status='APPROVED'
                                              AND voucher_id IS NOT NULL),0)::numeric(16,2) AS posted,
               COALESCE(sum(amount) FILTER (WHERE approval_status<>'APPROVED'
                                              OR voucher_id IS NULL),0)::numeric(16,2)      AS awaiting_approval
          FROM vendor_txns WHERE vendor_id = $1::uuid`, [req.party.vendorId]);
      ledger = { ...t[0], current_balance: v[0]?.current_balance ?? '0.00' };
    }

    return {
      vendor: v[0]?.vendor_name ?? null,
      payment_terms: v[0]?.payment_terms ?? null,
      fleet: fleet[0],
      bids: bids[0],
      ledger,                       // null when the role may not see money
      ledger_visible: showLedger,
    };
  });
}
