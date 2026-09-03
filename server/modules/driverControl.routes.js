// ═════════════════════════════════════════════════════════════════════════════
// driverControl.routes.js — the Driver Control Dashboard's back end
//
// Owner, 2026-09-03: "Clicking any driver MUST open a comprehensive Driver
// Control Dashboard as a slide-out on the same screen" with status toggle,
// profile edit / delete, live tracking, the document locker with approve /
// reject-resend, and HSD / cash issuance that syncs to the driver's phone.
//
// Most of that already had routes and this module does not duplicate them:
//   suspend / re-activate / archive  → /access/DRIVER/:id/block|activate|archive
//   profile edit                     → PATCH /masters/drivers/:id
//   document approve / reject        → /queues/partner-documents/:id/approve|reject
//   login link                       → POST /auth/driver/link
//   the map                          → GET /maps/trip/:tripId/route
// What was missing, and lives here:
//   GET  /:driverId/summary   one read for the whole drawer (profile, access,
//                             ledger, papers, last fix, activity)
//   POST /:driverId/issue-hsd litres against a trip → trip_hsd_issues +
//                             trips.hsd_issued (what the settlement reads)
//   POST /:driverId/pay-cash  rupees against a trip → driver_transactions
//                             (the khata) + the trip's paid column by mode
//   POST /:driverId/notice    an in-app banner, optionally with a WhatsApp
//
// Staff only: apiGuard already closes this prefix to external sessions; the
// writes additionally require an admin role.
// ═════════════════════════════════════════════════════════════════════════════
import { query, isDegraded, withTransaction } from '../db/pool.js';
import { requireAuth, requireAdminRole } from './auth.routes.js';
import { notifyWhatsApp } from '../lib/notify.js';
import { driverLedger } from '../lib/driverLedger.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });
const OPEN = `status NOT IN ('COMPLETED','SETTLED','CANCELLED')`;
const CASH_MODES = { 'Office Cash': 'office_cash_paid', 'UPI': 'bank_paid', 'Bank': 'bank_paid', 'Pump Cash': 'pump_cash_advance', 'Fleet card': 'bank_paid' };

const actorName = (req) => req.user?.name ?? req.user?.full_name ?? req.user?.email ?? null;

export function registerDriverControlRoutes(app) {
  const loadDriver = async (id) => {
    const { rows } = await query(
      `SELECT id, name, mobile, alt_mobile, address, status::text AS status, approval_status::text AS approval_status,
              COALESCE(is_approved_for_portal, false) AS portal_approved, portal_approved_at,
              employed_by_owner_id, join_date, profile_pic_url, remarks,
              license_no, license_expiry, dl_photo_url,
              aadhar_last4, aadhar_photo_url,
              pan_no, pan_photo_url,
              bank_name, account_no, ifsc_code, bank_photo_url,
              hzd_cert_no, hzd_expiry, hzd_photo_url,
              guarantor_name, guarantor_mobile, created_at
         FROM drivers WHERE id = $1::uuid`, [id]);
    return rows[0] ?? null;
  };

  app.get('/:driverId/summary', { preHandler: requireAuth }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const id = req.params.driverId;
    const d = await loadDriver(id);
    if (!d) return reply.code(404).send({ error: 'NOT_FOUND' });

    const [{ rows: audit }, { rows: sess }, { rows: docs }, { rows: pos }, { rows: notices }, ledger, { rows: activity }] = await Promise.all([
      query(`SELECT action, reason, actor_name, created_at FROM access_hub_audit
              WHERE kind = 'DRIVER' AND party_id = $1::uuid ORDER BY created_at DESC LIMIT 1`, [id]),
      query(`SELECT count(*)::int AS live, max(issued_at) AS last_login FROM auth_sessions
              WHERE driver_id = $1::uuid AND expires_at > now()`, [id]),
      query(`SELECT p.id, p.doc_type, p.file_key, p.status, p.reject_reason, p.created_at, p.reviewed_at, p.reviewed_by,
                    p.ocr_status, p.ocr_data, p.amount, p.qty, p.bill_no, p.bill_date, p.remarks, p.vehicle_no, t.trip_code
               FROM partner_documents p LEFT JOIN trips t ON t.id = p.trip_id
              WHERE p.driver_id = $1::uuid ORDER BY p.created_at DESC LIMIT 60`, [id]),
      query(`SELECT t.id AS trip_id, t.trip_code, t.vehicle_no, t.status, t.loading_point,
                    COALESCE(t.unloading_location, t.consignee_name) AS destination,
                    p.lat, p.lng, p.speed_kmh, p.source, p.recorded_at
               FROM trips t
               LEFT JOIN LATERAL (SELECT lat, lng, speed_kmh, source, recorded_at FROM trip_gps_pings
                                   WHERE trip_id = t.id ORDER BY recorded_at DESC LIMIT 1) p ON true
              WHERE t.driver_id = $1::uuid AND t.${OPEN}
              ORDER BY t.loading_date DESC NULLS LAST, t.created_at DESC LIMIT 1`, [id]),
      query(`SELECT id, kind, title, body, created_by, created_at, seen_at FROM driver_notices
              WHERE driver_id = $1::uuid ORDER BY created_at DESC LIMIT 20`, [id]),
      driverLedger(id),
      query(`SELECT * FROM (
               SELECT 'ACCESS' AS kind, created_at AS at, action::text AS title, COALESCE(reason,'') AS detail, actor_name AS who
                 FROM access_hub_audit WHERE kind = 'DRIVER' AND party_id = $1::uuid
               UNION ALL
               SELECT 'DOC', created_at, doc_type || ' uploaded', status::text, uploader_name
                 FROM partner_documents WHERE driver_id = $1::uuid
               UNION ALL
               SELECT 'DOC_DECISION', reviewed_at, doc_type || ' ' || status::text, COALESCE(reject_reason,''), reviewed_by
                 FROM partner_documents WHERE driver_id = $1::uuid AND reviewed_at IS NOT NULL
               UNION ALL
               SELECT 'CASH', COALESCE(created_at, txn_date::timestamptz), txn_type::text || ' Rs ' || amount::text, COALESCE(remarks,''), mode
                 FROM driver_transactions WHERE driver_id = $1::uuid
               UNION ALL
               SELECT 'HSD', issued_at, 'HSD ' || litres::text || ' L', COALESCE(pump_name,'') || ' ' || COALESCE(slip_no,''), issued_by
                 FROM trip_hsd_issues WHERE driver_id = $1::uuid
               UNION ALL
               SELECT 'LOGIN', issued_at, 'Logged in', COALESCE(user_agent,''), NULL
                 FROM auth_sessions WHERE driver_id = $1::uuid
               UNION ALL
               SELECT 'NOTICE', created_at, title, COALESCE(body,''), created_by
                 FROM driver_notices WHERE driver_id = $1::uuid
             ) a ORDER BY at DESC NULLS LAST LIMIT 60`, [id]),
    ]);

    const accessState = d.status === 'ARCHIVED' ? 'ARCHIVED'
      : (audit[0]?.action === 'BLOCK' || ['BLACKLISTED', 'INACTIVE'].includes(d.status)) ? 'BLOCKED'
        : d.portal_approved ? 'ACTIVE' : 'PENDING';

    const papers = ['DL', 'AADHAAR', 'BANK_BOOK', 'PAN', 'HZD'].map((kind) => {
      const col = { DL: 'dl_photo_url', AADHAAR: 'aadhar_photo_url', BANK_BOOK: 'bank_photo_url', PAN: 'pan_photo_url', HZD: 'hzd_photo_url' }[kind];
      const expiry = kind === 'DL' ? d.license_expiry : kind === 'HZD' ? d.hzd_expiry : null;
      const days = expiry ? Math.round((new Date(expiry) - new Date()) / 86400000) : null;
      const staged = docs.find((x) => x.doc_type === kind) ?? null;
      let state = 'MISSING';
      if (staged?.status === 'PENDING') state = 'PENDING';
      else if (staged?.status === 'NEEDS_CORRECTION') state = 'NEEDS_CORRECTION';
      else if (d[col]) state = days != null && days < 0 ? 'EXPIRED' : 'APPROVED';
      return { kind, state, approved_file: d[col] ?? null, expiry, days_left: days, staged };
    });

    return {
      driver: { ...d, aadhar_last4: d.aadhar_last4 ?? null, account_no: d.account_no ? '····' + String(d.account_no).slice(-4) : null,
                market_driver: !!d.employed_by_owner_id },
      access: { state: accessState, portal_approved: d.portal_approved, record_status: d.status,
                live_sessions: sess[0]?.live ?? 0, last_login: sess[0]?.last_login ?? null,
                last_action: audit[0] ?? null },
      position: pos[0] ?? null,
      ledger,
      papers,
      documents: docs,
      notices,
      activity,
      as_of: new Date().toISOString(),
    };
  });

  app.post('/:driverId/issue-hsd', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const id = req.params.driverId;
    const b = req.body ?? {};
    const litres = Number(b.litres);
    if (!(litres > 0)) return reply.code(400).send({ error: 'BAD_LITRES', detail: 'litres must be above zero' });
    const rate = b.rate == null || b.rate === '' ? null : Number(b.rate);
    if (rate != null && !(rate >= 0)) return reply.code(400).send({ error: 'BAD_RATE' });
    const { rows: T } = await query(
      `SELECT id, vehicle_no, fixed_hsd, hsd_issued FROM trips WHERE id = $1::uuid AND driver_id = $2::uuid AND ${OPEN}`,
      [b.trip_id, id]);
    if (!T.length) return reply.code(404).send({ error: 'NO_SUCH_TRIP', detail: 'that open trip is not this driver\'s' });
    const trip = T[0];
    const out = await withTransaction(async (t) => {
      const { rows: [line] } = await t.query(
        `INSERT INTO trip_hsd_issues (trip_id, driver_id, vehicle_no, litres, rate, amount, pump_name, vendor_id, slip_no, remarks, issued_by)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid, $9, $10, $11) RETURNING *`,
        [trip.id, id, trip.vehicle_no, litres, rate, rate == null ? null : +(litres * rate).toFixed(2),
         b.pump_name ?? null, b.vendor_id ?? null, b.slip_no ?? null, b.remarks ?? null, actorName(req)]);
      const { rows: [tr] } = await t.query(
        `UPDATE trips SET hsd_issued = COALESCE(hsd_issued, 0) + $2 WHERE id = $1::uuid RETURNING hsd_issued, fixed_hsd`,
        [trip.id, litres]);
      return { line, hsd_issued: Number(tr.hsd_issued), fixed_hsd: tr.fixed_hsd == null ? null : Number(tr.fixed_hsd) };
    });
    const over = out.fixed_hsd != null && out.hsd_issued > out.fixed_hsd;
    return { issued: true, over, ...out, ledger: await driverLedger(id) };
  });

  app.post('/:driverId/pay-cash', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const id = req.params.driverId;
    const b = req.body ?? {};
    const amount = Number(b.amount);
    if (!(amount > 0)) return reply.code(400).send({ error: 'BAD_AMOUNT', detail: 'amount must be above zero' });
    const mode = String(b.mode ?? 'Office Cash');
    const col = CASH_MODES[mode];
    if (!col) return reply.code(400).send({ error: 'BAD_MODE', detail: `mode must be one of ${Object.keys(CASH_MODES).join(', ')}` });
    const { rows: T } = await query(
      `SELECT t.id, t.trip_code, d.name AS driver_name FROM trips t JOIN drivers d ON d.id = t.driver_id
        WHERE t.id = $1::uuid AND t.driver_id = $2::uuid AND t.${OPEN}`, [b.trip_id, id]);
    if (!T.length) return reply.code(404).send({ error: 'NO_SUCH_TRIP', detail: 'that open trip is not this driver\'s' });
    const trip = T[0];
    const out = await withTransaction(async (t) => {
      const { rows: [txn] } = await t.query(
        `INSERT INTO driver_transactions (driver_id, driver_name, trip_id, txn_date, txn_type, amount, mode, remarks)
         VALUES ($1::uuid, $2, $3::uuid, CURRENT_DATE, 'ADVANCE_GIVEN', $4, $5, $6) RETURNING *`,
        [id, trip.driver_name, trip.id, amount, mode,
         `[Driver Control · ${actorName(req) ?? 'staff'}] ${b.ref ?? ''}`.trim()]);
      const { rows: [tr] } = await t.query(
        `UPDATE trips SET ${col} = COALESCE(${col}, 0) + $2 WHERE id = $1::uuid
         RETURNING fixed_cash, COALESCE(pump_cash_advance,0) + COALESCE(office_cash_paid,0) + COALESCE(bank_paid,0) AS paid`,
        [trip.id, amount]);
      return { transaction: txn, paid: Number(tr.paid), fixed_cash: tr.fixed_cash == null ? null : Number(tr.fixed_cash) };
    });
    const over = out.fixed_cash != null && out.paid > out.fixed_cash;
    return { paid: true, over, ...out, ledger: await driverLedger(id) };
  });

  app.post('/:driverId/notice', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const id = req.params.driverId;
    const b = req.body ?? {};
    const title = String(b.title ?? '').trim();
    if (!title) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'title is required' });
    const kind = ['INFO', 'DOC_REJECTED', 'DOC_REQUEST', 'LEDGER', 'ACCESS'].includes(b.kind) ? b.kind : 'INFO';
    const d = await loadDriver(id);
    if (!d) return reply.code(404).send({ error: 'NOT_FOUND' });
    const { rows: [n] } = await query(
      `INSERT INTO driver_notices (driver_id, kind, title, body, ref_table, ref_id, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7) RETURNING *`,
      [id, kind, title, b.body ?? null, b.ref_table ?? null, b.ref_id ?? null, actorName(req)]);
    let whatsapp = false;
    if (b.whatsapp !== false && d.mobile) {
      whatsapp = true;
      notifyWhatsApp(d.mobile, `📢 Prasad Transport: ${title}${b.body ? ' — ' + b.body : ''}`).catch(() => {});
    }
    return { sent: true, whatsapp, notice: n };
  });
}
