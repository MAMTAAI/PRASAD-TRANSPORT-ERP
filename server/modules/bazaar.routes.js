// server/modules/bazaar.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/bazaar — the load bazaar, the hiring pool and the portal intake.
//
//   GET/POST/PATCH/DELETE  /loads              loads offered to market vendors
//   GET/POST               /bids               bids against a load
//   POST /loads/:loadId/award                  award one bid, reject the rest
//   GET/POST/PATCH/DELETE  /market-vehicles    vendor-owned hiring pool
//   POST /market-vehicles/:id/approve
//   GET/POST/PATCH         /onboarding         portal KYC applications
//   POST /onboarding/:id/approve  /:id/reject
//
// WHY AWARD IS A SERVER TRANSACTION. BazaarAdmin used to flip the winning bid
// and the load in two separate Firestore writes. Between them the load could be
// AWARDED with no accepted bid, or two admins could accept two bids on the same
// load. Here it is one statement set inside one transaction, and
// `uq_bazaar_bid_winner` (a partial unique index on status='ACCEPTED') makes the
// second concurrent award fail rather than double-book the load.
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from 'node:crypto';
import { query, withTransaction, isDegraded } from '../db/pool.js';
import { requireAdminRole } from './auth.routes.js';
import { hashPassword, ALGO } from '../lib/auth.js';
import { notifyWhatsApp } from '../lib/notify.js';
import { openSettlementInTx } from './bazaarSettlement.routes.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pgErr = (reply, err) => {
  if (err.code === '23505') return reply.code(409).send({ error: 'DUPLICATE', detail: err.detail ?? err.message });
  if (err.code === '23514') return reply.code(400).send({ error: 'CONSTRAINT', detail: err.message });
  if (err.code === '23503') return reply.code(409).send({ error: 'IN_USE', detail: err.detail ?? err.message });
  throw err;
};

// Same allow-list discipline as masters.routes: a PATCH can only touch columns
// the screen owns, never audit stamps or a status a workflow endpoint controls.
const buildUpdate = (table, allowed, body) => {
  const cols = allowed.filter((c) => body[c] !== undefined);
  if (!cols.length) return null;
  return {
    sql: `UPDATE ${table} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now()
          WHERE id = $1::uuid RETURNING *`,
    args: [null, ...cols.map((c) => body[c])],
  };
};

// Rows migrated from Firestore keep their document id in `legacy_id`; a screen
// that still holds one must keep resolving.
const byId = (table) => async (id) => {
  const { rows } = UUID_RE.test(String(id ?? ''))
    ? await query(`SELECT * FROM ${table} WHERE id = $1::uuid`, [id])
    : await query(`SELECT * FROM ${table} WHERE legacy_id = $1`, [id]);
  return rows[0] ?? null;
};

export async function registerBazaarRoutes(app) {
  // ═══ LOADS ════════════════════════════════════════════════════════════════
  // `assigned_to` and `awarded_amount` are DERIVED from the accepted bid, not
  // stored on the load. Firestore kept a denormalised `assigned_to` string that
  // a failed second write could leave disagreeing with the bid rows; here the
  // winning bid is the single source and the two can never diverge.
  const LOAD_SELECT = `
    SELECT l.*, b.vendor_name AS assigned_to, b.bid_amount AS awarded_amount, b.id AS winning_bid_id
      FROM bazaar_loads l
      LEFT JOIN bazaar_bids b ON b.load_id = l.load_id AND b.status = 'ACCEPTED'`;

  app.get('/loads', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { status } = req.query ?? {};
    const { rows } = status
      ? await query(`${LOAD_SELECT} WHERE l.status = $1 ORDER BY l.created_at DESC`, [String(status).toUpperCase()])
      : await query(`${LOAD_SELECT} ORDER BY l.created_at DESC`);
    return { loads: rows };
  });

  app.post('/loads', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.customer_name || !b.origin || !b.destination) {
      return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'customer_name, origin and destination are required' });
    }
    try {
      // load_id is the code the portals quote at each other. Minting it inside
      // the insert transaction under a table lock is how trips.trip_code is
      // done — two admins posting at once must not land on the same number.
      const row = await withTransaction(async (c) => {
        await c.query('LOCK TABLE bazaar_loads IN SHARE ROW EXCLUSIVE MODE');
        const loadId = b.load_id ?? await (async () => {
          const { rows } = await c.query(
            `SELECT COALESCE(MAX(NULLIF(regexp_replace(load_id, '\\D', '', 'g'), '')::bigint), 0) + 1 AS n
               FROM bazaar_loads WHERE load_id ~ '^LD[0-9]+$'`);
          return 'LD' + String(rows[0].n).padStart(5, '0');
        })();
        const { rows } = await c.query(`
          INSERT INTO bazaar_loads (load_id, customer_name, origin, destination, distance_km,
            toll_plazas, toll_amount, material, weight, target_rate, loading_date, vehicle_type,
            rate_type, status, posted_by)
          VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,0),$8,$9,COALESCE($10,0),$11,$12,$13,COALESCE($14,'OPEN'),$15)
          RETURNING *`,
          [loadId, b.customer_name, b.origin, b.destination, b.distance_km ?? null,
           b.toll_plazas ?? null, b.toll_amount ?? null, b.material ?? null, b.weight ?? null,
           b.target_rate ?? null, b.loading_date || null, b.vehicle_type ?? null,
           b.rate_type ?? null, b.status ?? null, b.posted_by ?? null]);
        return rows[0];
      });
      return reply.code(201).send({ load: row });
    } catch (e) { return pgErr(reply, e); }
  });

  app.patch('/loads/:id', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const row = await byId('bazaar_loads')(req.params.id);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    const upd = buildUpdate('bazaar_loads', ['customer_name', 'origin', 'destination', 'distance_km',
      'toll_plazas', 'toll_amount', 'material', 'weight', 'target_rate', 'loading_date',
      'vehicle_type', 'rate_type', 'status'], req.body ?? {});
    if (!upd) return { load: row };
    upd.args[0] = row.id;
    try { const { rows } = await query(upd.sql, upd.args); return { load: rows[0] }; }
    catch (e) { return pgErr(reply, e); }
  });

  app.delete('/loads/:id', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const row = await byId('bazaar_loads')(req.params.id);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    try { await query('DELETE FROM bazaar_loads WHERE id = $1::uuid', [row.id]); return { deleted: true }; }
    catch (e) { return pgErr(reply, e); }   // 23503 → a bid still references it
  });

  // ═══ BIDS ═════════════════════════════════════════════════════════════════
  app.get('/bids', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { load_id, vendor_name } = req.query ?? {};
    const where = [], args = [];
    if (load_id) { args.push(load_id); where.push(`load_id = $${args.length}`); }
    if (vendor_name) { args.push(vendor_name); where.push(`vendor_name = $${args.length}`); }
    const { rows } = await query(
      `SELECT * FROM bazaar_bids ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`, args);
    return { bids: rows };
  });

  app.post('/bids', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.load_id || !b.vendor_name || b.bid_amount === undefined) {
      return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'load_id, vendor_name and bid_amount are required' });
    }
    // Bidding on a load that is already awarded or closed is a race the portal
    // cannot see (its list is a snapshot), so it is refused here.
    const { rows: L } = await query('SELECT status FROM bazaar_loads WHERE load_id = $1', [b.load_id]);
    if (!L.length) return reply.code(404).send({ error: 'NO_SUCH_LOAD' });
    if (L[0].status !== 'OPEN') return reply.code(409).send({ error: 'LOAD_NOT_OPEN', detail: `load is ${L[0].status}` });
    try {
      const { rows } = await query(`
        INSERT INTO bazaar_bids (load_id, vendor_name, vendor_id, bid_amount, remarks)
        VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [b.load_id, b.vendor_name, UUID_RE.test(String(b.vendor_id ?? '')) ? b.vendor_id : null,
         b.bid_amount, b.remarks ?? null]);
      return reply.code(201).send({ bid: rows[0] });
    } catch (e) { return pgErr(reply, e); }
  });

  // ── Award review — the desk's decision on a phone-side award request ─────
  // Owner's rule, 2026-09-02: a customer's accept-bid and a vendor's Book-Now
  // land the load in AWARD_REQUESTED with the chosen bid named on the row
  // (migration 127). Nothing is awarded until a person here APPROVEs — which
  // runs exactly the award the staff button runs: reject the rest, accept the
  // winner, open the settlement in the same transaction. REJECT reopens the
  // load; the requested offer stays on the table as a plain PENDING bid.
  async function awardInTx(c, loadId, bidId, by) {
    const { rows: B } = await c.query(
      'SELECT * FROM bazaar_bids WHERE id = $1::uuid AND load_id = $2 FOR UPDATE', [bidId, loadId]);
    if (!B.length) return { code: 404, body: { error: 'NO_SUCH_BID' } };
    if (B[0].status !== 'PENDING') return { code: 409, body: { error: 'BID_NOT_PENDING', detail: `bid is ${B[0].status}` } };
    await c.query(`UPDATE bazaar_bids SET status = 'REJECTED', updated_at = now()
                    WHERE load_id = $1 AND id <> $2::uuid AND status = 'PENDING'`, [loadId, bidId]);
    const { rows: W } = await c.query(`UPDATE bazaar_bids SET status = 'ACCEPTED', updated_at = now()
                                        WHERE id = $1::uuid RETURNING *`, [bidId]);
    const { rows: U } = await c.query(`UPDATE bazaar_loads
                                          SET status = 'AWARDED', award_reviewed_by = $2::uuid, award_reviewed_at = now(),
                                              award_reject_reason = NULL, updated_at = now()
                                        WHERE load_id = $1 RETURNING *`, [loadId, by]);
    const settlement = await openSettlementInTx(c, U[0], W[0]);
    const { rows: VM } = await c.query('SELECT mobile_no FROM vendors WHERE id = $1::uuid', [W[0].vendor_id]);
    const { rows: CM } = U[0].customer_id
      ? await c.query('SELECT mobile_no FROM customers WHERE id = $1::uuid', [U[0].customer_id])
      : { rows: [] };
    return {
      code: 200, body: { load: U[0], bid: W[0], settlement },
      vendorMobile: VM[0]?.mobile_no ?? null, customerMobile: CM[0]?.mobile_no ?? null,
    };
  }

  app.post('/loads/:loadId/award-review', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const action = String(req.body?.action ?? '').toUpperCase();
    const reason = String(req.body?.reason ?? '').trim();
    if (!['APPROVE', 'REJECT'].includes(action)) {
      return reply.code(400).send({ error: 'BAD_ACTION', detail: 'action must be APPROVE or REJECT' });
    }
    if (action === 'REJECT' && !reason) {
      return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'reason is required — the requester reads it' });
    }
    const by = UUID_RE.test(String(req.user?.sub ?? '')) ? req.user.sub : null;
    try {
      const out = await withTransaction(async (c) => {
        const { rows: L } = await c.query(
          'SELECT * FROM bazaar_loads WHERE load_id = $1 FOR UPDATE', [req.params.loadId]);
        if (!L.length) return { code: 404, body: { error: 'NO_SUCH_LOAD' } };
        if (L[0].status !== 'AWARD_REQUESTED') {
          return { code: 409, body: { error: 'NOT_REQUESTED', detail: `load is ${L[0].status} — nothing is waiting for a decision` } };
        }
        if (!L[0].award_requested_bid_id) {
          return { code: 409, body: { error: 'NO_REQUESTED_BID', detail: 'the request names no bid — reopen the load' } };
        }
        if (action === 'APPROVE') {
          const r = await awardInTx(c, req.params.loadId, L[0].award_requested_bid_id, by);
          return { ...r, requestedBy: L[0].award_requested_by };
        }
        const { rows: U } = await c.query(
          `UPDATE bazaar_loads
              SET status = 'OPEN', award_reviewed_by = $2::uuid, award_reviewed_at = now(),
                  award_reject_reason = $3, updated_at = now()
            WHERE load_id = $1 RETURNING *`, [req.params.loadId, by, reason]);
        const { rows: B } = await c.query(
          `SELECT b.*, v.mobile_no AS vendor_mobile FROM bazaar_bids b
             LEFT JOIN vendors v ON v.id = b.vendor_id WHERE b.id = $1::uuid`, [L[0].award_requested_bid_id]);
        const { rows: CM } = U[0].customer_id
          ? await c.query('SELECT mobile_no FROM customers WHERE id = $1::uuid', [U[0].customer_id])
          : { rows: [] };
        return {
          code: 200, body: { load: U[0], reopened: true, bid: B[0] ?? null },
          requestedBy: L[0].award_requested_by,
          vendorMobile: B[0]?.vendor_mobile ?? null, customerMobile: CM[0]?.mobile_no ?? null,
        };
      });
      if (out.code === 200) {
        const load = out.body.load;
        const route = `${load.origin} → ${load.destination}`;
        if (action === 'APPROVE') {
          if (out.vendorMobile) {
            notifyWhatsApp(out.vendorMobile,
              `🎉 Load Bazaar: aapki bid ₹${out.body.bid.bid_amount} load ${load.load_id} (${route}) ke liye `
              + `AWARD ho gayi hai — office ne confirm kar diya. "My Trips" mein confirm karein.`);
          }
          if (out.customerMobile) {
            notifyWhatsApp(out.customerMobile,
              `✅ Load Bazaar: aapka load ${load.load_id} (${route}) ${out.body.bid.vendor_name} ko `
              + `₹${out.body.bid.bid_amount} par award ho gaya — office ne confirm kiya.`);
          }
        } else {
          const to = out.requestedBy === 'VENDOR' ? out.vendorMobile : out.customerMobile;
          if (to) {
            notifyWhatsApp(to,
              `ℹ️ Load Bazaar: load ${load.load_id} (${route}) ka award request office ne approve nahi kiya. `
              + `Kaaran: ${reason}. Load dobara bidding ke liye khula hai.`);
          }
        }
      }
      return reply.code(out.code).send(out.body);
    } catch (e) { return pgErr(reply, e); }
  });

  // ── Award ────────────────────────────────────────────────────────────────
  app.post('/loads/:loadId/award', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { bid_id } = req.body ?? {};
    if (!bid_id) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'bid_id is required' });
    try {
      const out = await withTransaction(async (c) => {
        // FOR UPDATE so a concurrent award blocks here rather than at the
        // unique index, which gives the loser a clean 409 instead of a
        // half-applied set of bid rows.
        const { rows: L } = await c.query(
          'SELECT * FROM bazaar_loads WHERE load_id = $1 FOR UPDATE', [req.params.loadId]);
        if (!L.length) return { code: 404, body: { error: 'NO_SUCH_LOAD' } };
        // A staff award is itself the desk's decision, so it may also settle a
        // phone-side request directly (any bid, not only the requested one).
        if (!['OPEN', 'AWARD_REQUESTED'].includes(L[0].status)) return { code: 409, body: { error: 'LOAD_NOT_OPEN', detail: `load is ${L[0].status}` } };

        const { rows: B } = await c.query(
          'SELECT * FROM bazaar_bids WHERE id = $1::uuid AND load_id = $2 FOR UPDATE', [bid_id, req.params.loadId]);
        if (!B.length) return { code: 404, body: { error: 'NO_SUCH_BID' } };

        await c.query(`UPDATE bazaar_bids SET status = 'REJECTED', updated_at = now()
                        WHERE load_id = $1 AND id <> $2::uuid AND status = 'PENDING'`, [req.params.loadId, bid_id]);
        const { rows: W } = await c.query(`UPDATE bazaar_bids SET status = 'ACCEPTED', updated_at = now()
                                            WHERE id = $1::uuid RETURNING *`, [bid_id]);
        const { rows: U } = await c.query(`UPDATE bazaar_loads
                                              SET status = 'AWARDED', award_reviewed_by = $2::uuid, award_reviewed_at = now(),
                                                  award_reject_reason = NULL, updated_at = now()
                                            WHERE load_id = $1 RETURNING *`,
          [req.params.loadId, UUID_RE.test(String(req.user?.sub ?? '')) ? req.user.sub : null]);
        // The money lifecycle opens with the award, in the same transaction —
        // an awarded load without a settlement row cannot exist.
        const settlement = await openSettlementInTx(c, U[0], W[0]);
        const { rows: VM } = await c.query(
          'SELECT mobile_no FROM vendors WHERE id = $1::uuid', [W[0].vendor_id]);
        return { code: 200, body: { load: U[0], bid: W[0], settlement }, vendorMobile: VM[0]?.mobile_no ?? null };
      });
      if (out.code === 200 && out.vendorMobile) {
        // After commit — a slow WhatsApp engine must never hold the award.
        notifyWhatsApp(out.vendorMobile,
          `🎉 Load Bazaar: aapki bid ₹${out.body.bid.bid_amount} load ${req.params.loadId} `
          + `(${out.body.load.origin} → ${out.body.load.destination}) ke liye ACCEPT ho gayi hai. `
          + `Prasad Transport office se agla step confirm hoga.`);
      }
      return reply.code(out.code).send(out.body);
    } catch (e) { return pgErr(reply, e); }
  });

  // ── Review a customer-posted load (maker-checker, 2026-08-31) ────────────
  // Customer loads land PENDING_REVIEW; this is the checker's verdict. APPROVE
  // opens bidding and stamps who opened it; REJECT closes it with a reason the
  // customer is told. Either way the decision is on the row, timestamped.
  app.post('/loads/:loadId/review', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const action = String(req.body?.action ?? '').toUpperCase();
    const reason = String(req.body?.reason ?? '').trim();
    if (!['APPROVE', 'REJECT'].includes(action)) {
      return reply.code(400).send({ error: 'BAD_ACTION', detail: 'action must be APPROVE or REJECT' });
    }
    if (action === 'REJECT' && !reason) {
      return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'a rejection must carry a reason for the customer' });
    }
    const { rows } = await query(
      action === 'APPROVE'
        ? `UPDATE bazaar_loads SET status = 'OPEN', approved_by = $2::uuid, approved_at = now(),
                  reject_reason = NULL, updated_at = now()
            WHERE load_id = $1 AND status = 'PENDING_REVIEW' RETURNING *`
        : `UPDATE bazaar_loads SET status = 'CANCELLED', reject_reason = $3,
                  approved_by = $2::uuid, approved_at = now(), updated_at = now()
            WHERE load_id = $1 AND status = 'PENDING_REVIEW' RETURNING *`,
      action === 'APPROVE' ? [req.params.loadId, req.user?.sub ?? null]
                           : [req.params.loadId, req.user?.sub ?? null, reason]);
    if (!rows.length) return reply.code(409).send({ error: 'NOT_REVIEWABLE', detail: 'no such load awaiting review' });

    const L = rows[0];
    if (L.customer_id) {
      const { rows: C } = await query('SELECT mobile_no FROM customers WHERE id = $1::uuid', [L.customer_id]);
      if (C[0]?.mobile_no) {
        notifyWhatsApp(C[0].mobile_no, action === 'APPROVE'
          ? `✅ Load Bazaar: aapka load ${L.load_id} (${L.origin} → ${L.destination}) approve ho gaya — `
            + `ab verified partners ko bids ke liye invite kar diya gaya hai.`
          : `❌ Load Bazaar: aapka load ${L.load_id} (${L.origin} → ${L.destination}) office ne is kaaran se `
            + `wapas kiya: ${reason}. Aap sudhaar ke dobara post kar sakte hain.`);
      }
    }
    return { load: L };
  });

  // ═══ MARKET VEHICLES ══════════════════════════════════════════════════════
  app.get('/market-vehicles', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query('SELECT * FROM market_vehicles ORDER BY created_at DESC');
    return { vehicles: rows };
  });

  app.post('/market-vehicles', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.registration_no || !b.vendor_agency) {
      return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'registration_no and vendor_agency are required' });
    }
    try {
      const { rows } = await query(`
        INSERT INTO market_vehicles (registration_no, vendor_agency, vendor_id, vehicle_class, capacity,
          driver_name, driver_mobile, engine_no, chassis_no, rc_expiry, ins_expiry, puc_expiry,
          fit_expiry, np_expiry, system_status, added_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE($15,'PENDING APPROVAL'),$16)
        RETURNING *`,
        [String(b.registration_no).toUpperCase(), b.vendor_agency,
         UUID_RE.test(String(b.vendor_id ?? '')) ? b.vendor_id : null,
         b.vehicle_class ?? null, b.capacity ?? null, b.driver_name ?? null, b.driver_mobile ?? null,
         b.engine_no ?? null, b.chassis_no ?? null, b.rc_expiry ?? null, b.ins_expiry ?? null,
         b.puc_expiry ?? null, b.fit_expiry ?? null, b.np_expiry ?? null, b.system_status ?? null,
         b.added_by ?? null]);
      return reply.code(201).send({ vehicle: rows[0] });
    } catch (e) { return pgErr(reply, e); }
  });

  app.patch('/market-vehicles/:id', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const row = await byId('market_vehicles')(req.params.id);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    const upd = buildUpdate('market_vehicles', ['vendor_agency', 'vehicle_class', 'capacity', 'driver_name',
      'driver_mobile', 'engine_no', 'chassis_no', 'rc_expiry', 'ins_expiry', 'puc_expiry',
      'fit_expiry', 'np_expiry'], req.body ?? {});
    if (!upd) return { vehicle: row };
    upd.args[0] = row.id;
    try { const { rows } = await query(upd.sql, upd.args); return { vehicle: rows[0] }; }
    catch (e) { return pgErr(reply, e); }
  });

  // Approval is its own endpoint, not a PATCH of system_status: the screen only
  // offers it to a user with the approve permission, and keeping it separate
  // means a plain edit can never quietly activate a truck.
  app.post('/market-vehicles/:id/approve', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const row = await byId('market_vehicles')(req.params.id);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    const { rows } = await query(
      `UPDATE market_vehicles SET system_status = 'System Active',
              approved_by = $2::uuid, approved_at = now(), reject_reason = NULL,
              updated_at = now()
        WHERE id = $1::uuid RETURNING *`, [row.id, req.user?.sub ?? null]);
    return { vehicle: rows[0] };
  });

  // The counterpart the drivers had and the trucks did not: a refusal with a
  // reason the partner reads. REJECTED joins the status CHECK in migration 126
  // (040 allowed only Active / Pending / Blocked, so a truck could be refused
  // in prose but never in the row).
  app.post('/market-vehicles/:id/reject', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'reason is required — the partner sees it' });
    const { rows } = await query(`
      UPDATE market_vehicles
         SET system_status = 'REJECTED', reject_reason = $2, approved_by = NULL, approved_at = NULL,
             updated_at = now()
       WHERE id = $1::uuid RETURNING *`, [req.params.id, reason]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { vehicle: rows[0] };
  });

  app.delete('/market-vehicles/:id', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const row = await byId('market_vehicles')(req.params.id);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    await query('DELETE FROM market_vehicles WHERE id = $1::uuid', [row.id]);
    return { deleted: true };
  });

  // ═══ MARKET OVERVIEW — the Command Deck's one read ════════════════════════
  // The owner's dual-fleet rule (2026-09-02): the Command Deck is the MARKET
  // fleet — fleet partners, market vehicles, Load Bazaar bidding and its
  // settlements — and nothing of the own fleet, which is Master Control's.
  // One round trip, all staff-scoped: counts for the tiles, the queues a
  // person clears, the boards, and the market side of the books from
  // v_fleet_segment_totals (migration 129). Today most of it is zero, which
  // is the truth: no market vehicle exists yet.
  app.get('/overview', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const q = (sql, p = []) => query(sql, p).then((r) => r.rows);
    const [loadsByStatus, awardRequests, openLoads, settleByStatus, settlements, mvByStatus, mvPending,
           mdByStatus, vendorCounts, kycByType, docsPending, marketBooks, monthMoney] = await Promise.all([
      q(`SELECT status, count(*)::int AS n FROM bazaar_loads GROUP BY 1`),
      q(`SELECT l.load_id, l.origin, l.destination, l.customer_name, l.loading_date, l.material,
                l.award_requested_by, l.award_requested_at,
                b.vendor_name, b.bid_amount, b.remarks
           FROM bazaar_loads l LEFT JOIN bazaar_bids b ON b.id = l.award_requested_bid_id
          WHERE l.status = 'AWARD_REQUESTED'
          ORDER BY l.award_requested_at NULLS LAST LIMIT 20`),
      q(`SELECT l.load_id, l.status, l.origin, l.destination, l.customer_name, l.loading_date,
                l.material, l.weight, l.vehicle_type, l.target_rate, l.book_now_rate, l.bid_close_at, l.created_at,
                (SELECT count(*) FROM bazaar_bids b WHERE b.load_id = l.load_id AND b.status = 'PENDING')::int AS bids,
                (SELECT min(b.bid_amount) FROM bazaar_bids b WHERE b.load_id = l.load_id AND b.status = 'PENDING') AS l1_amount
           FROM bazaar_loads l
          WHERE l.status IN ('OPEN', 'PENDING_REVIEW')
          ORDER BY l.created_at DESC LIMIT 12`),
      q(`SELECT status, count(*)::int AS n, COALESCE(sum(awarded_amount), 0)::numeric(14,2) AS amount
           FROM bazaar_settlements GROUP BY 1`),
      q(`SELECT s.id, s.load_id, s.status, s.awarded_amount, s.advance_pct, s.advance_amount, s.balance_amount,
                s.deposit_amount, s.company_id, s.confirm_deadline, s.pod_submitted_at, s.pod_verified_at, s.created_at,
                v.vendor_name, l.origin, l.destination, l.customer_name, mv.registration_no
           FROM bazaar_settlements s
           LEFT JOIN vendors v ON v.id = s.vendor_id
           LEFT JOIN bazaar_loads l ON l.load_id = s.load_id
           LEFT JOIN market_vehicles mv ON mv.id = s.market_vehicle_id
          WHERE s.status NOT IN ('SETTLED', 'CANCELLED')
          ORDER BY s.created_at DESC LIMIT 12`),
      q(`SELECT system_status, count(*)::int AS n FROM market_vehicles GROUP BY 1`),
      q(`SELECT mv.id, mv.registration_no, mv.vendor_agency, mv.vehicle_class, mv.capacity, mv.system_status,
                mv.driver_name, mv.driver_mobile, mv.rc_expiry, mv.ins_expiry, mv.fit_expiry, mv.created_at,
                md.name AS market_driver, v.mobile_no AS vendor_mobile,
                (SELECT count(*) FROM bazaar_settlements s
                  WHERE s.market_vehicle_id = mv.id AND s.status NOT IN ('SETTLED', 'CANCELLED'))::int AS on_load
           FROM market_vehicles mv
           LEFT JOIN market_drivers md ON md.id = mv.market_driver_id
           LEFT JOIN vendors v ON v.id = mv.vendor_id
          ORDER BY (mv.system_status = 'PENDING APPROVAL') DESC, mv.created_at DESC LIMIT 20`),
      q(`SELECT system_status, count(*)::int AS n FROM market_drivers GROUP BY 1`),
      q(`SELECT count(*)::int AS total,
                count(*) FILTER (WHERE is_approved_for_portal)::int AS portal
           FROM vendors`),
      q(`SELECT type, count(*)::int AS n FROM onboarding_applications WHERE status = 'SUBMITTED' GROUP BY 1`),
      q(`SELECT count(*)::int AS n FROM partner_documents WHERE status = 'PENDING' AND uploader_role = 'VENDOR'`),
      q(`SELECT group_head, ledger_name, dr, cr, entries, last_entry
           FROM v_fleet_segment_totals WHERE fleet_segment = 'MARKET' ORDER BY group_head, ledger_name`),
      q(`SELECT source_type, COALESCE(sum(amount), 0)::numeric(14,2) AS amount, count(DISTINCT source_ref)::int AS vouchers
           FROM ledger_entries
          WHERE fleet_segment = 'MARKET' AND dr_cr = 'DR'
            AND entry_date >= date_trunc('month', now())::date
          GROUP BY 1`),
    ]);

    const byKey = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r]));
    const loads = byKey(loadsByStatus, 'status');
    const settle = byKey(settleByStatus, 'status');
    const mv = byKey(mvByStatus, 'system_status');
    const md = byKey(mdByStatus, 'system_status');
    const kyc = byKey(kycByType, 'type');
    const n = (r) => Number(r?.n ?? 0);
    const sumBal = (group) => marketBooks
      .filter((r) => r.group_head === group)
      .reduce((s, r) => s + (Number(r.cr) - Number(r.dr)), 0);
    // What the settlements say is still to be paid, by stage — the market
    // fleet's forward commitment, not yet in the ledger.
    const advanceDue = settlements
      .filter((s) => s.status === 'VEHICLE_ASSIGNED')
      .reduce((s, r) => s + Number(r.awarded_amount) * Number(r.advance_pct) / 100, 0);
    const balanceDue = settlements
      .filter((s) => ['ADVANCE_PAID', 'POD_SUBMITTED', 'POD_VERIFIED'].includes(s.status))
      .reduce((s, r) => s + (Number(r.awarded_amount) - Number(r.advance_amount ?? 0)), 0);

    return {
      generated_at: new Date().toISOString(),
      loads: {
        pending_review: n(loads.PENDING_REVIEW), open: n(loads.OPEN), award_requested: n(loads.AWARD_REQUESTED),
        awarded: n(loads.AWARDED), closed: n(loads.CLOSED), cancelled: n(loads.CANCELLED),
        board: openLoads, award_requests: awardRequests,
      },
      settlements: {
        by_status: Object.fromEntries(settleByStatus.map((r) => [r.status, { n: n(r), amount: Number(r.amount) }])),
        in_progress: settlements,
        committed: settlements.reduce((s, r) => s + Number(r.awarded_amount), 0),
        advance_due: Number(advanceDue.toFixed(2)),
        balance_due: Number(balanceDue.toFixed(2)),
        no_firm: settlements.filter((s) => !s.company_id).length,
      },
      market_fleet: {
        active: n(mv['System Active']), pending: n(mv['PENDING APPROVAL']),
        blocked: n(mv.BLOCKED), rejected: n(mv.REJECTED),
        // Every partner truck, pending first — the deck's "who brings what".
        trucks: mvPending,
        pending_list: mvPending.filter((v) => v.system_status === 'PENDING APPROVAL'),
        drivers_active: n(md['System Active']), drivers_pending: n(md['PENDING APPROVAL']),
      },
      partners: {
        vendors_total: Number(vendorCounts[0]?.total ?? 0),
        vendors_portal: Number(vendorCounts[0]?.portal ?? 0),
        kyc_vendor: n(kyc.VENDOR) + n(kyc.FLEET_PARTNER), kyc_customer: n(kyc.CUSTOMER),
        docs_pending: Number(docsPending[0]?.n ?? 0),
      },
      money: {
        // Liabilities carry a CR balance; positive = we owe / we hold.
        partner_payables: Number(sumBal('Market Fleet Payables (Partners)').toFixed(2)),
        deposits_held: Number(sumBal('Market Fleet Deposits Held').toFixed(2)),
        income: Number((-sumBal('Market Fleet Income')).toFixed(2)) * -1,
        this_month: Object.fromEntries(monthMoney.map((r) => [r.source_type, { amount: Number(r.amount), vouchers: r.vouchers }])),
        ledgers: marketBooks,
        segment_rule: 'Market-fleet vouchers post only to Market Fleet groups or bank/cash; the database refuses a crossover (migration 129).',
      },
    };
  });

  // ═══ ONBOARDING ═══════════════════════════════════════════════════════════
  // The response carries `agency_name` / `owner_name` aliases so the portal and
  // the approvals screen keep reading the names they already know, while the
  // table stores one canonical pair (see migration 041).
  const withAliases = (r) => ({ ...r, agency_name: r.corporate_name, owner_name: r.contact_person });

  app.get('/onboarding', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { status, type } = req.query ?? {};
    const where = [], args = [];
    if (status) { args.push(String(status).toUpperCase()); where.push(`status = $${args.length}`); }
    if (type) { args.push(String(type).toUpperCase()); where.push(`type = $${args.length}`); }
    const { rows } = await query(
      `SELECT * FROM onboarding_applications ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY submitted_at DESC`, args);
    return { applications: rows.map(withAliases) };
  });

  app.post('/onboarding', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const type = String(b.type ?? '').toUpperCase();
    if (!['CUSTOMER', 'VENDOR', 'FLEET_PARTNER'].includes(type)) {
      return reply.code(400).send({ error: 'BAD_TYPE', detail: 'type must be CUSTOMER, VENDOR or FLEET_PARTNER' });
    }
    const name = b.corporate_name ?? b.agency_name;
    if (!name) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'corporate_name (or agency_name) is required' });
    // Only ever the last four digits, whatever the client sent.
    const aadhaar = String(b.aadhaar_last4 ?? '').replace(/\D/g, '').slice(-4) || null;
    try {
      const { rows } = await query(`
        INSERT INTO onboarding_applications (type, corporate_name, gst_no, pan_no, mobile_no,
          address, contact_person, aadhaar_last4, documents, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::jsonb,'{}'::jsonb),'SUBMITTED')
        RETURNING *`,
        [type, String(name).toUpperCase(), b.gst_no ? String(b.gst_no).toUpperCase() : null,
         b.pan_no ? String(b.pan_no).toUpperCase() : null, b.mobile_no ?? null, b.address ?? null,
         b.contact_person ?? b.owner_name ?? null, aadhaar,
         b.documents ? JSON.stringify(b.documents) : null]);
      return reply.code(201).send({ application: withAliases(rows[0]) });
    } catch (e) { return pgErr(reply, e); }
  });

  // master_id is supplied by the caller: KycApprovals creates the customer or
  // vendor through /api/v1/masters first and passes the id it got back, so the
  // master's own validation and ledger behaviour stay in one place.
  // APPROVAL NOW FINISHES THE JOB. Until Phase 1 of the marketplace rebuild,
  // approving here stamped the application and stopped: the party master
  // existed, but no `users` login row was ever created and
  // `is_approved_for_portal` stayed false — so an "approved" applicant still
  // could not sign in, and unblocking them took two more manual steps nobody
  // knew about (provision-portal-user.mjs + the Portal Access screen). One
  // approval now produces: the stamped application, the portal gate open on
  // the party, and an OTP-ready login (matched by mobile at /auth/otp/verify;
  // the random password exists only because the column is NOT NULL, and
  // must_change_password guards the day someone tries it).
  app.post('/onboarding/:id/approve', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const row = await byId('onboarding_applications')(req.params.id);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (row.status !== 'SUBMITTED') return reply.code(409).send({ error: 'ALREADY_DECIDED', detail: `application is ${row.status}` });
    const { master_id, approved_by } = req.body ?? {};
    const masterId = UUID_RE.test(String(master_id ?? '')) ? master_id : null;
    const notes = [];

    const application = await withTransaction(async (c) => {
      const { rows } = await c.query(`
        UPDATE onboarding_applications
           SET status = 'APPROVED', approved_at = now(), approved_by = $2,
               master_id = COALESCE($3::uuid, master_id)
         WHERE id = $1::uuid RETURNING *`, [row.id, approved_by ?? null, masterId]);
      const app0 = rows[0];
      const partyId = app0.master_id;
      if (!partyId) { notes.push('no master_id — portal gate and login skipped'); return app0; }

      const isCustomer = app0.type === 'CUSTOMER';
      const table = isCustomer ? 'customers' : 'vendors';
      const linkCol = isCustomer ? 'customer_id' : 'vendor_id';
      const role = isCustomer ? 'CUSTOMER' : 'VENDOR';

      // 1. Open the gate the API actually enforces (068).
      const { rows: party } = await c.query(`
        UPDATE ${table}
           SET is_approved_for_portal = true, portal_approved_by = NULL, portal_approved_at = now()
         WHERE id = $1::uuid
         RETURNING ${isCustomer ? 'customer_name' : 'vendor_name'} AS name, email, mobile_no`, [partyId]);
      if (!party.length) { notes.push(`master_id ${partyId} not found in ${table}`); return app0; }

      // 2. The login. OTP login matches users by MOBILE, so a mobile is the
      // one thing a portal account cannot do without.
      const mobile = String(app0.mobile_no ?? party[0].mobile_no ?? '').replace(/\D/g, '').slice(-10);
      if (mobile.length < 10) { notes.push('no mobile number — login not created'); return app0; }

      const { rows: existing } = await c.query(
        `SELECT id FROM users WHERE ${linkCol} = $1::uuid`, [partyId]);
      if (existing.length) { notes.push('login already exists'); return app0; }

      const { rows: mobileTaken } = await c.query(
        'SELECT id, role FROM users WHERE mobile = $1 LIMIT 1', [mobile]);
      if (mobileTaken.length) {
        notes.push(`mobile ${mobile} already belongs to another login (${mobileTaken[0].role}) — login not created`);
        return app0;
      }

      // A real address when the party has one; otherwise a non-routable,
      // unique placeholder — the OTP lane never reads it.
      const email = String(party[0].email ?? '').trim().toLowerCase()
        || `portal-${String(partyId).slice(0, 8)}@login.prasadtransport.com`;
      const { saltHex, hashHex } = hashPassword(randomBytes(14).toString('base64url'));
      await c.query(`
        INSERT INTO users (full_name, email, mobile, password_hash, password_salt, password_algo,
                           role, permissions, status, must_change_password, ${linkCol})
        VALUES ($1, $2::citext, $3, $4, $5, $6, $7::user_role, '{"grants":[]}'::jsonb, 'ACTIVE', true, $8::uuid)`,
        [party[0].name, email, mobile, hashHex, saltHex, ALGO, role, partyId]);
      notes.push(`portal login created — OTP login on ${mobile}`);
      return app0;
    });

    // After commit: tell the applicant. Never inside the transaction.
    if (application.status === 'APPROVED' && application.mobile_no) {
      notifyWhatsApp(application.mobile_no,
        `✅ Prasad Transport Load Bazaar: aapka ${application.type === 'CUSTOMER' ? 'customer' : 'fleet partner'} `
        + `KYC APPROVE ho gaya hai. Ab portal par apne registered mobile number se OTP login karein.`);
    }
    return { application: withAliases(application), notes };
  });

  app.post('/onboarding/:id/reject', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const row = await byId('onboarding_applications')(req.params.id);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (row.status !== 'SUBMITTED') return reply.code(409).send({ error: 'ALREADY_DECIDED', detail: `application is ${row.status}` });
    const { reason, rejected_by } = req.body ?? {};
    if (!reason) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'reason is required — the applicant sees it' });
    const { rows } = await query(`
      UPDATE onboarding_applications
         SET status = 'REJECTED', reject_reason = $2, rejected_at = now(), rejected_by = $3
       WHERE id = $1::uuid RETURNING *`, [row.id, reason, rejected_by ?? null]);
    if (rows[0]?.mobile_no) {
      notifyWhatsApp(rows[0].mobile_no,
        `Prasad Transport Load Bazaar: aapka KYC application reject hua — karan: ${reason}. `
        + `Sudhaar karke dobara apply kar sakte hain.`);
    }
    return { application: withAliases(rows[0]) };
  });

  // The applicant's own status check — PUBLIC, but only by the application's
  // unguessable uuid (returned to them at submit time). Returns the decision
  // and nothing else, so the pre-login portal can stop faking its lock screen
  // from local state.
  app.get('/onboarding-status', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const id = String(req.query?.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID', detail: 'id must be the application uuid' });
    const { rows } = await query(
      'SELECT status, reject_reason, type FROM onboarding_applications WHERE id = $1::uuid', [id]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { status: rows[0].status, reject_reason: rows[0].reject_reason, type: rows[0].type };
  });

  // ═══ MARKET DRIVERS — APPROVAL ════════════════════════════════════════════
  // Partners have been able to SUBMIT drivers since 069; nothing could ever
  // approve one, so every submission sat at PENDING APPROVAL forever. Same
  // shape as the vehicle approval above: a dedicated endpoint, never a PATCH.
  app.get('/market-drivers', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { status } = req.query ?? {};
    const args = [];
    let where = '';
    if (status) { args.push(String(status)); where = 'WHERE d.system_status = $1'; }
    const { rows } = await query(`
      SELECT d.id, d.name, d.mobile, d.licence_no, d.licence_expiry, d.aadhaar_last4,
             d.photo_url, d.licence_photo_url, d.system_status, d.reject_reason, d.created_at,
             v.vendor_name
        FROM market_drivers d LEFT JOIN vendors v ON v.id = d.vendor_id
        ${where} ORDER BY d.created_at DESC`, args);
    return { count: rows.length, drivers: rows };
  });

  app.post('/market-drivers/:id/approve', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`
      UPDATE market_drivers
         SET system_status = 'System Active', reject_reason = NULL,
             approved_by = $2, approved_at = now(), updated_at = now()
       WHERE id = $1::uuid RETURNING *`, [req.params.id, req.body?.approved_by ?? null]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { driver: rows[0] };
  });

  app.post('/market-drivers/:id/reject', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'reason is required — the partner sees it' });
    const { rows } = await query(`
      UPDATE market_drivers
         SET system_status = 'REJECTED', reject_reason = $2, updated_at = now()
       WHERE id = $1::uuid RETURNING *`, [req.params.id, reason]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { driver: rows[0] };
  });
}
