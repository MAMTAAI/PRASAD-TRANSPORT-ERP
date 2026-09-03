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
import { emit } from '../agents/bus.js';

// Route params arrive as text; anything not shaped like a uuid is refused
// before it reaches a ::uuid cast, which would otherwise be a 500 rather than
// a 400. (Added 3-Sep with the vehicle-management routes.)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

      // THE DESK DECIDES THE AWARD (owner's rule, 2026-09-02). Book-Now used to
      // reject every other offer, accept its own and open the settlement in
      // this request. Now it is a REQUEST at the Book-Now rate: the booker's
      // earlier offer is withdrawn (one live offer per vendor per load — the
      // partial unique index), the new one is a PENDING bid the load names as
      // its requested award, the load leaves OPEN so nobody else can bid, and
      // the other offers stay on the table until the office decides.
      await t.query(
        `UPDATE bazaar_bids SET status='WITHDRAWN', updated_at=now()
          WHERE load_id=$1 AND vendor_id=$2::uuid AND status='PENDING'`,
        [req.params.loadId, req.party.vendorId]);

      const { rows: W } = await t.query(`
        INSERT INTO bazaar_bids (load_id, vendor_name, vendor_id, bid_amount, remarks, status)
        VALUES ($1, $2, $3::uuid, $4, 'Book-Now', 'PENDING')
        RETURNING *`,
        [req.params.loadId, vend[0]?.vendor_name ?? 'partner', req.party.vendorId, rate]);
      const { rows: U } = await t.query(
        `UPDATE bazaar_loads
            SET status='AWARD_REQUESTED',
                award_requested_bid_id=$2::uuid, award_requested_by='VENDOR', award_requested_at=now(),
                award_reviewed_by=NULL, award_reviewed_at=NULL, award_reject_reason=NULL,
                updated_at=now()
          WHERE load_id=$1 RETURNING *`,
        [req.params.loadId, W[0].id]);

      award = { customerMobile: load[0].customer_mobile, rate, origin: load[0].origin, destination: load[0].destination };
      return reply.code(202).send({
        load: U[0], bid: W[0], award_requested: true,
        detail: 'Book-Now request sent. The Prasad Transport office confirms the award — you will get a '
              + 'WhatsApp, and the load then appears under "My Trips" to confirm.',
      });
    });
    if (award?.customerMobile) {
      notifyWhatsApp(award.customerMobile,
        `⚡ Load Bazaar: aapka load ${req.params.loadId} (${award.origin} → ${award.destination}) `
        + `Book-Now rate ₹${award.rate.toLocaleString('en-IN')} par book karne ki request aayi hai — `
        + `Prasad Transport office confirm karega, uske baad award hoga.`);
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

  // ═══ ONE TRUCK: DETAILS AND ITS PAPERS ════════════════════════════════════
  // Owner, 2026-09-03: "fleet partner ko vehicle management ke liye subidha ho
  // — doc renewal and vehicle details management."
  //
  // Two kinds of change, kept apart on purpose:
  //   · DETAILS the partner knows better than we do — the truck's class, its
  //     capacity, engine and chassis numbers. Edited directly: market_vehicles
  //     is a quarantine table so the fence already allows it, and none of those
  //     fields decides whether the truck may take a load.
  //   · EXPIRY DATES are NOT editable here, and that is the point. A date typed
  //     into a box proves nothing, which is exactly what the five expiry columns
  //     have been until today. A renewal now arrives as a DOCUMENT carrying the
  //     new date, waits in partner_documents, and the office's APPROVE is what
  //     moves the date onto the truck (queues.routes applyToCore). After this,
  //     every live date on this fleet has a paper behind it.
  const VEHICLE_DOCS = {
    RC: 'rc_expiry', INSURANCE: 'ins_expiry', FITNESS: 'fit_expiry',
    PERMIT: 'np_expiry', PUC: 'puc_expiry',
  };

  const myVehicle = async (req, id) => {
    const { rows } = await query(
      `SELECT * FROM market_vehicles WHERE id = $1::uuid AND vendor_id = $2::uuid`,
      [id, req.party.vendorId]);
    return rows[0] ?? null;
  };

  app.get('/portal/vendor/fleet/vehicle/:id', { preHandler: needsModule('vend.vehicles') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    if (!UUID_RE.test(String(req.params.id))) return reply.code(400).send({ error: 'BAD_ID' });
    const v = await myVehicle(req, req.params.id);
    if (!v) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'that truck is not on your fleet' });

    // Every renewal ever sent for this truck, newest first, so the partner can
    // see what is with the office and what came back rejected, with the reason.
    const { rows: docs } = await query(`
      SELECT id, doc_type, doc_no, expiry_date, file_key, status, reject_reason,
             created_at, reviewed_at, ocr_status
        FROM partner_documents
       WHERE market_vehicle_id = $1::uuid AND vendor_id = $2::uuid
       ORDER BY created_at DESC LIMIT 60`, [v.id, req.party.vendorId]);

    // The five papers, each with the live date and whatever is in flight for it.
    const papers = Object.entries(VEHICLE_DOCS).map(([doc_type, col]) => {
      const pending = docs.find((d) => d.doc_type === doc_type && d.status === 'PENDING');
      const lastReject = docs.find((d) => d.doc_type === doc_type
        && (d.status === 'REJECTED' || d.status === 'NEEDS_CORRECTION'));
      return {
        doc_type,
        expiry: v[col],
        pending: pending ?? null,
        last_reject: pending ? null : (lastReject ?? null),
      };
    });
    return { vehicle: v, papers, documents: docs };
  });

  app.patch('/portal/vendor/fleet/vehicle/:id', { preHandler: needsModule('vend.vehicles') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    if (!UUID_RE.test(String(req.params.id))) return reply.code(400).send({ error: 'BAD_ID' });
    const v = await myVehicle(req, req.params.id);
    if (!v) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'that truck is not on your fleet' });
    if (v.system_status === 'BLOCKED' || v.system_status === 'REJECTED') {
      // Owner's rule, 3-Sep: a blocked truck gets the reason and a phone number,
      // not a form. An edit here would be the re-submit loop by another name —
      // the partner tidying fields instead of ringing the office.
      return reply.code(409).send({
        error: 'VEHICLE_BLOCKED',
        detail: v.reject_reason
          ? `This truck is ${String(v.system_status).toLowerCase()}: ${v.reject_reason}. Please call the office.`
          : `This truck is ${String(v.system_status).toLowerCase()}. Please call the office.`,
      });
    }
    // registration_no is absent from this list on purpose: changing the plate
    // makes it a different truck, and the office approved THIS one.
    const ALLOWED = ['vehicle_class', 'capacity', 'engine_no', 'chassis_no', 'market_driver_id'];
    const cols = ALLOWED.filter((c) => req.body?.[c] !== undefined);
    if (!cols.length) return { vehicle: v, changed: [] };
    if (req.body.market_driver_id) {
      const { rows: d } = await query(
        `SELECT id FROM market_drivers WHERE id = $1::uuid AND vendor_id = $2::uuid`,
        [req.body.market_driver_id, req.party.vendorId]);
      if (!d.length) return reply.code(404).send({ error: 'NO_SUCH_DRIVER', detail: 'that driver is not on your fleet' });
    }
    const sets = cols.map((c, i) => `${c} = $${i + 2}${c === 'market_driver_id' ? '::uuid' : ''}`).join(', ');
    const { rows } = await query(
      `UPDATE market_vehicles SET ${sets}, updated_at = now()
        WHERE id = $1::uuid RETURNING *`,
      [v.id, ...cols.map((c) => (req.body[c] === '' ? null : req.body[c]))]);
    return { vehicle: rows[0], changed: cols };
  });

  app.post('/portal/vendor/fleet/vehicle/:id/document', { preHandler: needsModule('vend.vehicles') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    if (!UUID_RE.test(String(req.params.id))) return reply.code(400).send({ error: 'BAD_ID' });
    const v = await myVehicle(req, req.params.id);
    if (!v) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'that truck is not on your fleet' });

    const docType = String(req.body?.doc_type ?? '').toUpperCase();
    if (!VEHICLE_DOCS[docType]) {
      return reply.code(400).send({
        error: 'BAD_DOC_TYPE',
        detail: `doc_type must be one of ${Object.keys(VEHICLE_DOCS).join(', ')}`,
      });
    }
    const fileKey = String(req.body?.file_key ?? '').trim();
    // The same prefix rule the file vault enforces (31-Aug): a party may only
    // point at something it uploaded into its own folder.
    if (!fileKey || !fileKey.startsWith(`up/vendor/${req.user.sub}/`)) {
      return reply.code(400).send({ error: 'BAD_FILE_KEY', detail: 'upload the document first; the file must be your own upload' });
    }
    const expiry = String(req.body?.expiry_date ?? '').trim() || null;
    if (!expiry) return reply.code(400).send({ error: 'NO_EXPIRY', detail: 'the new expiry date on the document is required' });

    const { rows: vend } = await query(`SELECT vendor_name FROM vendors WHERE id = $1::uuid`, [req.party.vendorId]);
    const { rows } = await query(`
      INSERT INTO partner_documents
        (doc_type, file_key, vendor_id, uploader_role, uploader_name,
         vehicle_no, market_vehicle_id, expiry_date, doc_no, remarks, status)
      VALUES ($1,$2,$3::uuid,'VENDOR',$4,$5,$6::uuid,$7::date,$8,$9,'PENDING')
      RETURNING id, doc_type, status, expiry_date, created_at`,
      [docType, fileKey, req.party.vendorId, `portal:${vend[0]?.vendor_name ?? ''}`,
       v.registration_no, v.id, expiry, req.body?.doc_no ?? null,
       `fleet partner app · ${docType} renewal for ${v.registration_no}`]);

    return reply.code(201).send({
      ...rows[0],
      detail: 'Sent to the office. The new date goes on the truck once they verify the document.',
    });
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
    // The vendor app (v1, 3-Sep-2026) draws each slip with the truck, the
    // litres and — once BHUVANESHWARI has read the photo — what OCR saw next to
    // what the vendor typed. Only the proposal and the score travel; the raw
    // text stays on the desk.
    const { rows } = await query(
      `SELECT id, doc_type, file_key, amount, qty, vehicle_no, bill_no, bill_date, remarks,
              status, reject_reason, created_at, reviewed_at, expense_approval_id,
              ocr_status,
              CASE WHEN ocr_status = 'DONE' THEN jsonb_build_object(
                     'amount',     ocr_data->'suggest'->'amount',
                     'qty',        ocr_data->'suggest'->'qty',
                     'vehicle_no', ocr_data->'suggest'->'vehicle_no',
                     'bill_no',    ocr_data->'suggest'->'bill_no',
                     'bill_date',  ocr_data->'suggest'->'bill_date',
                     'score',      ocr_data->'match'->'score')
                   END AS ocr
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
    // qty = litres on a pump slip (the owner's "loading slip", 3-Sep-2026);
    // optional everywhere else. Milan compares it with what OCR reads.
    const qty = b.qty == null || b.qty === '' ? null : Number(b.qty);
    if (qty !== null && !(Number.isFinite(qty) && qty >= 0)) {
      return reply.code(400).send({ error: 'BAD_QTY', detail: 'litres must be a number' });
    }
    const vehicleNo = b.vehicle_no ? String(b.vehicle_no).toUpperCase().replace(/\s+/g, ' ').trim().slice(0, 20) : null;
    const { rows: vend } = await query(
      `SELECT vendor_name FROM vendors WHERE id = $1::uuid`, [req.party.vendorId]);
    const { rows } = await query(
      `INSERT INTO partner_documents
         (uploader_role, vendor_id, uploader_name, doc_type, file_key,
          vehicle_no, amount, qty, bill_no, bill_date, remarks)
       VALUES ('VENDOR', $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::date, $10)
       RETURNING id, doc_type, status, created_at`,
      [req.party.vendorId, vend[0]?.vendor_name ?? 'partner', docType, fileKey,
       vehicleNo, amount, qty, b.bill_no ?? null, b.bill_date || null, b.remarks ?? null]);
    // BHUVANESHWARI reads the paper off the request path (migration 132).
    try {
      await emit('partner.document.submitted', {
        aggregate: 'partner_document', aggregateId: rows[0].id,
        payload: { id: rows[0].id, doc_type: docType, file_key: fileKey, uploader_role: 'VENDOR', vendor_id: req.party.vendorId },
        emittedBy: 'vendorPortal',
      });
    } catch (e) { req.log?.warn({ err: e.message }, 'partner.document.submitted not emitted'); }
    return reply.code(201).send({
      ...rows[0],
      detail: 'Bill submitted to the Prasad Transport office. It reaches your account '
            + 'only after the office verifies and approves it.',
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. EARNINGS & WALLET
  // ═══════════════════════════════════════════════════════════════════════

  // ═══ SERVICE VENDOR BILLS — pumps, tyre shops, spares (2-Sep-2026) ═════════
  // A SERVICE vendor (vendor_kind = 'SERVICE', migration 130) supplies the
  // OWN fleet: HSD, tyres, spares, repairs, toll. Its bill is an operational
  // expense, not a market-fleet payable, and it lands STRAIGHT in the
  // Expenses queue (expense_approvals, source VENDOR_PORTAL) with its PDF —
  // no "App Uploads" step in between. The office approves there; TARA posts
  // the voucher to `Creditors: <vendor>` under the own fleet, as it always
  // has for a pump bill typed by staff. Nothing here touches the bazaar.
  //
  // PATH: /portal/vendor/expense-bills — NOT /portal/vendor/bills, which
  // portal.routes.js already serves (the vendor's company bills, vend.bills).
  // Declaring it twice took the API down for four minutes on 2-Sep-2026
  // (FST_ERR_DUPLICATED_ROUTE, a crash loop); Fastify refuses to boot.
  const EXPENSE_TYPES = new Set(['FUEL', 'TYRE', 'MAINTENANCE', 'TOLL', 'OTHER']);

  /** The operating companies a bill can be raised against (owner, 3-Sep).
   *
   *  Name and id only. A vendor is an outside party, so this answers with the
   *  minimum the dropdown needs and nothing about the firms themselves — no
   *  GSTIN, no bank, no addresses. Only ACTIVE ones: a closed entity must not
   *  collect new payables. */
  app.get('/portal/vendor/companies', { preHandler: needsModule('vend.submit_bill') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT id, company_name FROM companies WHERE status = 'ACTIVE' ORDER BY company_name`);
    return { companies: rows };
  });

  app.get('/portal/vendor/expense-bills', { preHandler: needsModule('vend.submit_bill') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT id, expense_type, amount, bill_no, bill_date, vehicle_no, description, status,
              approval_status, created_at, approved_at, approved_by,
              COALESCE(reject_reason, rejection_reason) AS reject_reason, file_key,
              (voucher_id IS NOT NULL) AS posted
         FROM expense_approvals
        WHERE vendor_id = $1::uuid
        ORDER BY created_at DESC LIMIT 100`, [req.party.vendorId]);
    return { count: rows.length, bills: rows };
  });

  app.post('/portal/vendor/expense-bills', { preHandler: needsModule('vend.submit_bill') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const type = String(b.expense_type ?? '').toUpperCase();
    if (!EXPENSE_TYPES.has(type)) {
      return reply.code(400).send({ error: 'BAD_TYPE', detail: `expense_type must be one of ${[...EXPENSE_TYPES].join(', ')}` });
    }
    const amount = Number(b.amount);
    if (!(Number.isFinite(amount) && amount > 0)) {
      return reply.code(400).send({ error: 'BAD_AMOUNT', detail: 'the bill amount in rupees is required' });
    }
    const fileKey = normalizeKey(b.file_key);
    if (!fileKey.startsWith(`up/vendor/${String(req.user.sub)}/`)) {
      return reply.code(400).send({ error: 'NOT_YOUR_FILE', detail: 'upload the bill (PDF or photo) through the app first, then submit it' });
    }
    const { rows: vend } = await query(
      `SELECT vendor_name, vendor_kind FROM vendors WHERE id = $1::uuid`, [req.party.vendorId]);
    if (vend[0]?.vendor_kind === 'FLEET_PARTNER') {
      return reply.code(409).send({
        error: 'FLEET_PARTNER',
        detail: 'a fleet partner is paid through its load settlements, not through expense bills — use "My Trips"',
      });
    }
    // WHICH COMPANY IS THIS BILL AGAINST (owner, 3-Sep). The three operating
    // firms keep separate books, so a bill with no company posts into none of
    // them. The vendor picks it — they know whose truck they filled — and if
    // they name a vehicle we already know the answer, so the plate wins over an
    // empty box and the office can still change it at approval.
    let companyId = UUID_RE.test(String(b.company_id ?? '')) ? b.company_id : null;
    const plate = b.vehicle_no ? String(b.vehicle_no).toUpperCase().replace(/\s+/g, ' ').trim() : null;
    if (!companyId && plate) {
      const { rows: veh } = await query(
        `SELECT company_id FROM vehicles WHERE upper(replace(vehicle_no, ' ', '')) = $1 LIMIT 1`,
        [plate.replace(/\s+/g, '')]);
      companyId = veh[0]?.company_id ?? null;
    }
    if (companyId) {
      const { rows: co } = await query(`SELECT id FROM companies WHERE id = $1::uuid AND status = 'ACTIVE'`, [companyId]);
      if (!co.length) return reply.code(400).send({ error: 'BAD_COMPANY', detail: 'that operating company does not exist' });
    }

    const { rows } = await query(
      `INSERT INTO expense_approvals
         (vendor_id, vendor_name, expense_type, bill_no, bill_date, amount, description,
          vehicle_no, source, entered_by, file_key, company_id)
       VALUES ($1::uuid, $2, $3, $4, $5::date, $6, $7, $8, 'VENDOR_PORTAL', $9, $10, $11::uuid)
       RETURNING id, expense_type, amount, bill_no, bill_date, status, created_at, company_id`,
      [req.party.vendorId, vend[0]?.vendor_name ?? 'vendor', type,
       b.bill_no ?? null, b.bill_date || null, amount,
       `[${type} bill via vendor portal] ${String(b.remarks ?? '').trim()}`.trim(),
       plate,
       vend[0]?.vendor_name ?? 'vendor portal', fileKey, companyId]);
    return reply.code(201).send({
      ...rows[0],
      detail: 'Bill sent to the Prasad Transport office — it is in the Expenses queue now. '
            + 'You will be told when it is approved and when it is paid.',
    });
  });

  // ═══ SERVICE VENDOR HOME (vendor app v1, approved 3-Sep-2026) ═══════════
  // One call paints the home screen: this month's slip and bill counts, the
  // financial-year money card (bills raised → approved → posted), and — ONLY
  // when vend.bills is on for this vendor — the payments received and the
  // running balance. The balance is a per-vendor switch by the owner's rule:
  // the role matrix is the ceiling and portal_features.bills the per-party
  // restrictor; a vendor whose switch is off gets ledger = null, not zeros.
  // Recent trucks feed the chips on the slip form; recent rejections feed the
  // home banner so a pump owner learns why a slip bounced without a call.
  app.get('/portal/vendor/summary', { preHandler: needsModule('vend.dashboard') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const vid = req.party.vendorId;
    const vis = req.visible ?? await visibleModules(req.party);
    const showLedger = !!vis['vend.bills'];

    const { rows: v } = await query(
      `SELECT vendor_name, vendor_type, vendor_kind, payment_terms, gst_no, mobile_no, address,
              is_approved_for_portal, current_balance
         FROM vendors WHERE id = $1::uuid`, [vid]);

    // Indian financial year: 1 April → 31 March.
    const FY = `(CASE WHEN extract(month FROM now()) >= 4
                     THEN make_date(extract(year FROM now())::int, 4, 1)
                     ELSE make_date(extract(year FROM now())::int - 1, 4, 1) END)`;

    const { rows: [slips] } = await query(`
      SELECT count(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS month,
             count(*) FILTER (WHERE status = 'PENDING')::int                       AS pending,
             count(*) FILTER (WHERE status = 'REJECTED')::int                      AS rejected,
             count(*) FILTER (WHERE status = 'APPROVED')::int                      AS approved
        FROM partner_documents WHERE vendor_id = $1::uuid AND uploader_role = 'VENDOR'`, [vid]);

    const { rows: [bills] } = await query(`
      SELECT count(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS month,
             count(*) FILTER (WHERE status = 'PENDING')::int                       AS pending,
             count(*) FILTER (WHERE status = 'REJECTED')::int                      AS rejected,
             count(*) FILTER (WHERE status <> 'REJECTED' AND created_at >= ${FY})::int AS fy_count,
             COALESCE(sum(amount) FILTER (WHERE status <> 'REJECTED' AND created_at >= ${FY}), 0)::numeric(14,2) AS fy_raised,
             COALESCE(sum(amount) FILTER (WHERE status = 'APPROVED' AND created_at >= ${FY}), 0)::numeric(14,2)  AS fy_approved,
             COALESCE(sum(amount) FILTER (WHERE voucher_id IS NOT NULL AND created_at >= ${FY}), 0)::numeric(14,2) AS fy_posted
        FROM expense_approvals WHERE vendor_id = $1::uuid`, [vid]);

    let ledger = null;
    if (showLedger) {
      const { rows: [t] } = await query(`
        SELECT COALESCE(sum(amount) FILTER (WHERE txn_type = 'PAYMENT_GIVEN' AND approval_status = 'APPROVED' AND txn_date >= ${FY}), 0)::numeric(14,2) AS fy_paid,
               COALESCE(sum(amount) FILTER (WHERE txn_type = 'BILL_RECEIVED' AND approval_status = 'APPROVED' AND txn_date >= ${FY}), 0)::numeric(14,2) AS fy_billed,
               count(*) FILTER (WHERE txn_type = 'PAYMENT_GIVEN' AND approval_status = 'APPROVED' AND txn_date >= ${FY})::int AS fy_payments
          FROM vendor_txns WHERE vendor_id = $1::uuid`, [vid]);
      const { rows: last } = await query(`
        SELECT txn_date, amount, payment_mode, remarks
          FROM vendor_txns
         WHERE vendor_id = $1::uuid AND txn_type = 'PAYMENT_GIVEN' AND approval_status = 'APPROVED'
         ORDER BY txn_date DESC NULLS LAST, created_at DESC LIMIT 1`, [vid]);
      ledger = { ...t, last_payment: last[0] ?? null, current_balance: v[0]?.current_balance ?? '0.00' };
    }

    const { rows: trucks } = await query(`
      SELECT vehicle_no FROM (
        SELECT vehicle_no, max(created_at) AS at FROM partner_documents
         WHERE vendor_id = $1::uuid AND vehicle_no IS NOT NULL AND vehicle_no <> '' GROUP BY 1
        UNION ALL
        SELECT vehicle_no, max(created_at) FROM expense_approvals
         WHERE vendor_id = $1::uuid AND vehicle_no IS NOT NULL AND vehicle_no <> '' GROUP BY 1) x
       GROUP BY vehicle_no ORDER BY max(at) DESC LIMIT 6`, [vid]);

    const { rows: notices } = await query(`
      SELECT * FROM (
        SELECT 'SLIP' AS kind, doc_type AS what, reject_reason AS reason, reviewed_at AS at, amount
          FROM partner_documents WHERE vendor_id = $1::uuid AND status = 'REJECTED' AND reviewed_at > now() - interval '30 days'
        UNION ALL
        SELECT 'BILL', expense_type, COALESCE(reject_reason, rejection_reason), approved_at, amount
          FROM expense_approvals WHERE vendor_id = $1::uuid AND status = 'REJECTED' AND approved_at > now() - interval '30 days') n
       ORDER BY at DESC NULLS LAST LIMIT 3`, [vid]);

    const d = new Date(); const fyY = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    return {
      vendor: v[0] ? {
        name: v[0].vendor_name, vendor_type: v[0].vendor_type, vendor_kind: v[0].vendor_kind,
        payment_terms: v[0].payment_terms, gst_no: v[0].gst_no, mobile_no: v[0].mobile_no, address: v[0].address,
      } : null,
      slips, bills, ledger, ledger_visible: showLedger,
      recent_vehicles: trucks.map((r) => r.vehicle_no),
      notices,
      fy_label: `FY ${String(fyY).slice(2)}-${String(fyY + 1).slice(2)}`,
    };
  });

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
