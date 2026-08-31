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
import { notifyWhatsApp } from '../lib/notify.js';
import { openSettlementInTx } from './bazaarSettlement.routes.js';

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

    // Set inside the transaction, fired only after it commits — a bid the
    // customer heard about must exist.
    let bidAlert = null;

    const result = await withTransaction(async (t) => {
      const { rows: load } = await t.query(
        `SELECT l.load_id, l.status, l.origin, l.destination, l.bid_close_at,
                (l.bid_close_at IS NOT NULL AND l.bid_close_at <= now()) AS bidding_closed,
                c.mobile_no AS customer_mobile
           FROM bazaar_loads l LEFT JOIN customers c ON c.id = l.customer_id
          WHERE l.load_id = $1 FOR UPDATE OF l`, [req.params.loadId]);
      if (!load[0]) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'no such load' });
      if (load[0].status !== 'OPEN') {
        return reply.code(409).send({
          error: 'LOAD_CLOSED',
          detail: `this load is ${load[0].status.toLowerCase()} and is no longer taking bids`,
        });
      }
      // The auction clock is enforced where the bid is written, not in a screen.
      if (load[0].bidding_closed) {
        return reply.code(409).send({
          error: 'BIDDING_CLOSED',
          detail: 'bidding on this load has closed — the customer is choosing between the offers received',
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

      if (load[0].customer_mobile) {
        // The COUNT of interest is public knowledge on this board; the amount
        // is the customer's to see — it is their load.
        bidAlert = {
          mobile: load[0].customer_mobile,
          text: `📦 Load Bazaar: aapke load ${load[0].load_id} (${load[0].origin} → ${load[0].destination}) `
              + `par nayi bid aayi hai. Portal par "Live Bids" mein dekhein aur accept karein.`,
        };
      }

      return reply.code(201).send({
        ...rows[0],
        revised: withdrawn > 0,
        // Said plainly so the app can show the right thing: this is not an
        // award, and nothing has been agreed.
        detail: 'Bid submitted to the Prasad Transport office. It is pending review — '
              + 'you will see the result here once the office decides.',
      });
    });

    if (bidAlert) notifyWhatsApp(bidAlert.mobile, bidAlert.text);
    return result;
  });

  // ═══ BOOK NOW — take the load instantly at the customer's public price ═══
  // The same transaction shape as an award: winner accepted, the rest
  // rejected, load AWARDED, settlement opened. The public book_now_rate is
  // the ONLY rate involved — nobody's blind bid is revealed by booking.
  app.post('/portal/vendor/loads/:loadId/book-now', { preHandler: needsModule('vend.bazaar') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    let award = null;
    const result = await withTransaction(async (t) => {
      const { rows: load } = await t.query(
        `SELECT l.*, c.mobile_no AS customer_mobile
           FROM bazaar_loads l LEFT JOIN customers c ON c.id = l.customer_id
          WHERE l.load_id = $1 FOR UPDATE OF l`, [req.params.loadId]);
      if (!load[0]) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'no such load' });
      if (load[0].status !== 'OPEN') {
        return reply.code(409).send({
          error: 'LOAD_CLOSED',
          detail: `this load is ${load[0].status.toLowerCase()} — somebody may have booked it first`,
        });
      }
      const rate = Number(load[0].book_now_rate);
      if (!(rate > 0)) {
        return reply.code(409).send({ error: 'NO_BOOK_NOW', detail: 'this load has no Book-Now price — place a bid instead' });
      }

      const { rows: vend } = await t.query(
        `SELECT vendor_name FROM vendors WHERE id = $1::uuid`, [req.party.vendorId]);

      // The booking replaces every open offer, the booker's own included.
      await t.query(
        `UPDATE bazaar_bids SET status='WITHDRAWN', updated_at=now()
          WHERE load_id=$1 AND vendor_id=$2::uuid AND status='PENDING'`,
        [req.params.loadId, req.party.vendorId]);
      await t.query(
        `UPDATE bazaar_bids SET status='REJECTED', updated_at=now()
          WHERE load_id=$1 AND status='PENDING'`, [req.params.loadId]);

      const { rows: W } = await t.query(`
        INSERT INTO bazaar_bids (load_id, vendor_name, vendor_id, bid_amount, remarks, status)
        VALUES ($1, $2, $3::uuid, $4, 'Book-Now', 'ACCEPTED')
        RETURNING *`,
        [req.params.loadId, vend[0]?.vendor_name ?? 'partner', req.party.vendorId, rate]);
      const { rows: U } = await t.query(
        `UPDATE bazaar_loads SET status='AWARDED', updated_at=now() WHERE load_id=$1 RETURNING *`,
        [req.params.loadId]);
      const settlement = await openSettlementInTx(t, U[0], W[0]);

      award = { customerMobile: load[0].customer_mobile, rate, origin: load[0].origin, destination: load[0].destination };
      return reply.code(201).send({
        load: U[0], bid: W[0], settlement,
        detail: 'Load booked at the Book-Now rate. Confirm it under "My Trips" — '
              + 'the office will then take the next steps (deposit, vehicle, advance).',
      });
    });
    if (award?.customerMobile) {
      notifyWhatsApp(award.customerMobile,
        `⚡ Load Bazaar: aapka load ${req.params.loadId} (${award.origin} → ${award.destination}) `
        + `Book-Now rate ₹${award.rate.toLocaleString('en-IN')} par turant book ho gaya hai.`);
    }
    return result;
  });

  // ONLY the caller's own bids. There is no parameter that widens this.
  // l_rank: your standing among the LIVE offers on that load — L1 means
  // lowest. The rank leaks no amounts; it is exactly the Truckstop-style
  // signal the blueprint calls for.
  app.get('/portal/vendor/bids', { preHandler: needsModule('vend.bazaar') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`
      SELECT b.id, b.load_id, b.bid_amount, b.status, b.remarks, b.created_at,
             l.origin, l.destination, l.material, l.weight, l.loading_date, l.status AS load_status,
             l.bid_close_at,
             CASE WHEN b.status = 'PENDING' THEN
               (SELECT count(*) + 1 FROM bazaar_bids x
                 WHERE x.load_id = b.load_id AND x.status = 'PENDING'
                   AND (x.bid_amount < b.bid_amount
                        OR (x.bid_amount = b.bid_amount AND x.created_at < b.created_at)))::int
             END AS l_rank
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
  // 1b. MY TRIPS — the settlement lifecycle of loads this partner has won.
  // The vendor moves the workflow (confirm, name the truck, upload the POD);
  // every rupee stays office-side, posted by the admin settlement routes
  // through TARA. Nothing here can move money.
  // ═══════════════════════════════════════════════════════════════════════

  app.get('/portal/vendor/settlements', { preHandler: needsModule('vend.bazaar') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`
      SELECT s.id, s.load_id, s.status, s.awarded_amount, s.advance_pct,
             s.confirm_deadline, s.vendor_confirmed_at,
             s.deposit_amount, s.advance_amount, s.balance_amount,
             s.pod_file, s.pod_submitted_at, s.pod_verified_at, s.cancel_reason,
             s.market_vehicle_id, s.market_driver_id, s.created_at,
             l.origin, l.destination, l.material, l.weight, l.loading_date,
             mv.registration_no AS vehicle_reg, md.name AS driver_name
        FROM bazaar_settlements s
        JOIN bazaar_loads l ON l.load_id = s.load_id
        LEFT JOIN market_vehicles mv ON mv.id = s.market_vehicle_id
        LEFT JOIN market_drivers md ON md.id = s.market_driver_id
       WHERE s.vendor_id = $1::uuid
       ORDER BY s.created_at DESC LIMIT 100`, [req.party.vendorId]);
    return { count: rows.length, settlements: rows };
  });

  app.post('/portal/vendor/settlements/:id/confirm', { preHandler: needsModule('vend.bazaar') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `UPDATE bazaar_settlements
          SET status = 'CONFIRMED', vendor_confirmed_at = now(), updated_at = now()
        WHERE id = $1::uuid AND vendor_id = $2::uuid AND status = 'AWAITING_CONFIRM'
        RETURNING id, load_id, status, vendor_confirmed_at`,
      [req.params.id, req.party.vendorId]);
    if (!rows.length) {
      return reply.code(409).send({
        error: 'NOT_CONFIRMABLE',
        detail: 'that trip is not yours, or it is past the confirm stage',
      });
    }
    return { ...rows[0], detail: 'Trip confirmed. Now assign an approved truck (and driver) to it.' };
  });

  // Only THIS partner's own, office-approved truck and driver can be named.
  // A pending or blocked vehicle cannot carry a bazaar load — same rule as
  // the dispatch board.
  app.post('/portal/vendor/settlements/:id/assign', { preHandler: needsModule('vend.bazaar') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const vehicleId = String(req.body?.market_vehicle_id ?? '');
    const driverId = req.body?.market_driver_id ? String(req.body.market_driver_id) : null;
    if (!vehicleId) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'market_vehicle_id is required' });

    const { rows: V } = await query(
      `SELECT id, registration_no, system_status FROM market_vehicles
        WHERE id = $1::uuid AND vendor_id = $2::uuid`, [vehicleId, req.party.vendorId]);
    if (!V.length) return reply.code(404).send({ error: 'NO_SUCH_VEHICLE', detail: 'that truck is not on your approved fleet' });
    if (V[0].system_status !== 'System Active') {
      return reply.code(409).send({
        error: 'VEHICLE_NOT_APPROVED',
        detail: `${V[0].registration_no} is ${V[0].system_status} — only an approved truck can take a bazaar load`,
      });
    }
    if (driverId) {
      const { rows: D } = await query(
        `SELECT id, system_status FROM market_drivers
          WHERE id = $1::uuid AND vendor_id = $2::uuid`, [driverId, req.party.vendorId]);
      if (!D.length) return reply.code(404).send({ error: 'NO_SUCH_DRIVER', detail: 'that driver is not on your list' });
      if (D[0].system_status !== 'System Active') {
        return reply.code(409).send({ error: 'DRIVER_NOT_APPROVED', detail: `driver is ${D[0].system_status}` });
      }
    }

    const { rows } = await query(
      `UPDATE bazaar_settlements
          SET status = 'VEHICLE_ASSIGNED', market_vehicle_id = $3::uuid,
              market_driver_id = $4::uuid, updated_at = now()
        WHERE id = $1::uuid AND vendor_id = $2::uuid
          AND status IN ('CONFIRMED','VEHICLE_ASSIGNED')
        RETURNING id, load_id, status`,
      [req.params.id, req.party.vendorId, vehicleId, driverId]);
    if (!rows.length) {
      return reply.code(409).send({
        error: 'NOT_ASSIGNABLE',
        detail: 'confirm the trip first — a truck is named after the confirmation, before the advance',
      });
    }
    return {
      ...rows[0], vehicle_reg: V[0].registration_no,
      detail: 'Truck assigned. The office can now release the advance.',
    };
  });

  // The POD comes from the partner's phone camera; the office verifies it.
  // The file itself goes up through POST /files first (bazaar-pods/...), and
  // the storage key lands here. The balance stays locked until the office
  // marks the POD verified — that gate lives in the admin settlement route.
  app.post('/portal/vendor/settlements/:id/pod', { preHandler: needsModule('vend.bazaar') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const podFile = String(req.body?.pod_file ?? '').trim();
    if (!podFile) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'pod_file (the uploaded file key) is required' });

    const { rows: vend } = await query(
      `SELECT vendor_name FROM vendors WHERE id = $1::uuid`, [req.party.vendorId]);
    const { rows } = await query(
      `UPDATE bazaar_settlements
          SET status = 'POD_SUBMITTED', pod_file = $3, pod_submitted_at = now(),
              pod_submitted_by = $4, updated_at = now()
        WHERE id = $1::uuid AND vendor_id = $2::uuid
          AND status IN ('VEHICLE_ASSIGNED','ADVANCE_PAID','POD_SUBMITTED')
        RETURNING id, load_id, status, pod_submitted_at`,
      [req.params.id, req.party.vendorId, podFile, `portal:${vend[0]?.vendor_name ?? ''}`]);
    if (!rows.length) {
      return reply.code(409).send({
        error: 'NOT_READY',
        detail: 'a POD lands after the truck is assigned, and not on a settled or cancelled trip',
      });
    }

    // The customer hears their goods arrived — the blueprint's auto-forward.
    const { rows: C } = await query(
      `SELECT c.mobile_no, l.origin, l.destination FROM bazaar_settlements s
         JOIN bazaar_loads l ON l.load_id = s.load_id
         LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.id = $1::uuid`, [req.params.id]);
    if (C[0]?.mobile_no) {
      notifyWhatsApp(C[0].mobile_no,
        `📄 Load Bazaar: aapke load ${rows[0].load_id} (${C[0].origin} → ${C[0].destination}) `
        + `ki delivery ka POD (proof of delivery) upload ho gaya hai. Office verify karke aapko update karega.`);
    }
    return {
      ...rows[0],
      detail: 'POD submitted. The office will verify it; the balance releases after verification.',
    };
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
  // 2b. MY BILLS & DOCUMENTS — uploaded from the phone, staged for review.
  // A partner's HSD/tyre/maintenance bill lands PENDING in partner_documents;
  // the office opens the photo, checks it, and only an approval files it into
  // the money queue (expense_approvals → TARA). Nothing here writes a khata.
  // ═══════════════════════════════════════════════════════════════════════
  const DOC_TYPES = new Set(['LOADING_INVOICE', 'CHALLAN', 'POD',
    'TYRE_BILL', 'MAINTENANCE_BILL', 'HSD_BILL', 'TOLL_BILL', 'OTHER_BILL', 'KYC', 'OTHER_DOC']);
  const normalizeKey = (v) => String(v ?? '').replace(/^\/?api\/v1\/files\//, '').replace(/^\/+/, '');

  app.get('/portal/vendor/documents', { preHandler: needsModule('vend.submit_bill') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT id, doc_type, file_key, amount, bill_no, bill_date, remarks,
              status, reject_reason, created_at, reviewed_at
         FROM partner_documents
        WHERE vendor_id = $1::uuid
        ORDER BY created_at DESC LIMIT 100`, [req.party.vendorId]);
    return { count: rows.length, documents: rows };
  });

  app.post('/portal/vendor/documents', { preHandler: needsModule('vend.submit_bill') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const docType = String(b.doc_type ?? '').toUpperCase();
    if (!DOC_TYPES.has(docType)) {
      return reply.code(400).send({ error: 'BAD_TYPE', detail: `doc_type must be one of ${[...DOC_TYPES].join(', ')}` });
    }
    const fileKey = normalizeKey(b.file_key);
    // Must be in this session's own vault tree (the upload POST puts it there).
    if (!fileKey.startsWith(`up/vendor/${String(req.user.sub)}/`)) {
      return reply.code(400).send({ error: 'NOT_YOUR_FILE', detail: 'upload the photo through the app first, then submit it' });
    }
    const amount = b.amount == null || b.amount === '' ? null : Number(b.amount);
    if (amount !== null && !(Number.isFinite(amount) && amount >= 0)) {
      return reply.code(400).send({ error: 'BAD_AMOUNT' });
    }
    const { rows: vend } = await query(
      `SELECT vendor_name FROM vendors WHERE id = $1::uuid`, [req.party.vendorId]);
    const { rows } = await query(
      `INSERT INTO partner_documents
         (uploader_role, vendor_id, uploader_name, doc_type, file_key,
          vehicle_no, amount, bill_no, bill_date, remarks)
       VALUES ('VENDOR', $1::uuid, $2, $3, $4, $5, $6, $7, $8::date, $9)
       RETURNING id, doc_type, status, created_at`,
      [req.party.vendorId, vend[0]?.vendor_name ?? 'partner', docType, fileKey,
       b.vehicle_no ?? null, amount, b.bill_no ?? null, b.bill_date || null, b.remarks ?? null]);
    return reply.code(201).send({
      ...rows[0],
      detail: 'Bill submitted to the Prasad Transport office. It reaches your account '
            + 'only after the office verifies and approves it.',
    });
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
