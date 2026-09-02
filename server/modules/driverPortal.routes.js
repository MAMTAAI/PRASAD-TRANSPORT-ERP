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
// Every staged paper announces itself; BHUVANESHWARI reads it off the request
// path and writes her proposal beside the photo (migration 132).
import { emit } from '../agents/bus.js';

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

  // ── My documents — every paper from the cab, photographed and staged ──────
  // Loading invoice, challan, tyre/maintenance/HSD bills, KYC. The photo goes
  // to the driver's own vault tree first (POST /files); the key lands here as
  // a PENDING row the office reviews. Nothing reaches a trip, a khata or a
  // ledger from this route.
  const DOC_TYPES = new Set(['LOADING_INVOICE', 'CHALLAN', 'POD',
    'TYRE_BILL', 'MAINTENANCE_BILL', 'HSD_BILL', 'TOLL_BILL', 'OTHER_BILL', 'KYC', 'OTHER_DOC',
    // 2026-09-02: the driver's own KYC papers and quantity reports — staged
    // like every other paper; approve is what touches drivers / trips.
    'DL', 'AADHAAR', 'BANK_BOOK', 'LOADING_QTY', 'UNLOADING_QTY']);
  const normalizeKey = (v) => String(v ?? '').replace(/^\/?api\/v1\/files\//, '').replace(/^\/+/, '');

  app.get('/portal/driver/documents', { preHandler: resolveDriver }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT d.id, d.doc_type, d.file_key, d.amount, d.bill_no, d.bill_date, d.remarks,
              d.status, d.reject_reason, d.created_at, d.reviewed_at, t.trip_code
         FROM partner_documents d LEFT JOIN trips t ON t.id = d.trip_id
        WHERE d.driver_id = $1::uuid
        ORDER BY d.created_at DESC LIMIT 100`, [req.driver.id]);
    return { count: rows.length, documents: rows };
  });

  app.post('/portal/driver/documents', { preHandler: resolveDriver }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const docType = String(b.doc_type ?? '').toUpperCase();
    if (!DOC_TYPES.has(docType)) {
      return reply.code(400).send({ error: 'BAD_TYPE', detail: `doc_type must be one of ${[...DOC_TYPES].join(', ')}` });
    }
    const fileKey = normalizeKey(b.file_key);
    // The key must sit in THIS driver's own vault tree — a reference to
    // somebody else's object is refused even though reading it would fail
    // anyway (files.routes), because a review screen must never be pointed
    // at a file its uploader could not see.
    if (!fileKey.startsWith(`up/driver/${req.driver.id}/`)) {
      return reply.code(400).send({ error: 'NOT_YOUR_FILE', detail: 'photo pehle app se upload karein, phir bhejein' });
    }
    let tripId = null;
    if (b.trip_id) {
      const { rows: T } = await query(
        `SELECT id FROM trips WHERE id = $1::uuid AND driver_id = $2::uuid`, [b.trip_id, req.driver.id]);
      if (!T.length) return reply.code(404).send({ error: 'NO_SUCH_TRIP', detail: 'that trip is not yours' });
      tripId = T[0].id;
    }
    const amount = b.amount == null || b.amount === '' ? null : Number(b.amount);
    if (amount !== null && !(Number.isFinite(amount) && amount >= 0)) {
      return reply.code(400).send({ error: 'BAD_AMOUNT' });
    }
    const qty = b.qty == null || b.qty === '' ? null : Number(b.qty);
    if (qty !== null && !(Number.isFinite(qty) && qty >= 0)) {
      return reply.code(400).send({ error: 'BAD_QTY' });
    }
    if (['LOADING_QTY', 'UNLOADING_QTY'].includes(docType) && !tripId) {
      return reply.code(400).send({ error: 'TRIP_REQUIRED', detail: 'a quantity report belongs to a trip' });
    }
    const { rows } = await query(
      `INSERT INTO partner_documents
         (uploader_role, driver_id, uploader_name, doc_type, file_key, trip_id,
          vehicle_no, amount, bill_no, bill_date, remarks, qty)
       VALUES ('DRIVER', $1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8, $9::date, $10, $11)
       RETURNING id, doc_type, status, created_at`,
      [req.driver.id, req.driver.name, docType, fileKey, tripId,
       b.vehicle_no ?? null, amount, b.bill_no ?? null, b.bill_date || null, b.remarks ?? null, qty]);
    // Announce the paper. agent_events is a staging table, so the fence lets
    // the driver's request write it; the OCR itself runs in the agent loop.
    try {
      await emit('partner.document.submitted', {
        aggregate: 'partner_document', aggregateId: rows[0].id,
        payload: { id: rows[0].id, doc_type: docType, file_key: fileKey, uploader_role: 'DRIVER', driver_id: req.driver.id, trip_id: tripId },
        emittedBy: 'driverPortal',
      });
    } catch (e) { req.log?.warn({ err: e.message }, 'partner.document.submitted not emitted'); }
    return reply.code(201).send({
      ...rows[0],
      detail: 'Document office ko pahunch gaya. Staff check karke approve karega — '
            + 'status yahin dikhega.',
    });
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
