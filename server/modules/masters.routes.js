// server/modules/masters.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/masters — fleet and party masters: vehicles, drivers, customers,
// vendors, the vehicle↔driver link, and the rate/lane masters.
//
//   GET/POST/PATCH/DELETE  /vehicles  /drivers  /customers  /vendors
//   GET  /drivers/:id/ledger        the driver khata (see the note below)
//   GET/POST/PATCH         /driver-requests        app request queue
//   POST /driver-requests/:id/pay   pay one → writes the khata row
//   GET/POST/DELETE        /assignments            vehicle ↔ driver links
//   GET/POST/PATCH/DELETE  /lanes                  rtkm_master
//   GET/POST/PATCH/DELETE  /rates                  rate_master
//   GET  /vendors/:id/ledger        vendor subsidiary ledger
//
// THE DRIVER KHATA MATTERS MORE THAN IT LOOKS. `driver_transactions` is written
// from three places now: this module (manual entries, request payouts), the ops
// module (trip advances, pump cash, unloading recovery) and the billing module
// (party deductions recovered from a driver). The Firestore Driver Master read
// its own collection, so once the trip screens moved to PostgreSQL the khata
// could no longer see an advance issued from Trip Command Center. That is the
// defect this endpoint closes: one query, every producer, ordered.
// ─────────────────────────────────────────────────────────────────────────────
import { query, withTransaction, isDegraded } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';
import { drain } from '../agents/bus.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });
const money = (v) => Number(v ?? 0);

// A generic writable-column helper. Each master declares its own allow-list so a
// client can never patch a column the screen has no business setting (balances,
// audit stamps, foreign keys it does not own).
const buildUpdate = (table, allowed, body) => {
  const cols = allowed.filter((c) => body[c] !== undefined);
  if (!cols.length) return null;
  const sets = cols.map((c, i) => `${c} = $${i + 2}`);
  return {
    sql: `UPDATE ${table} SET ${sets.join(', ')}, updated_at = now() WHERE id = $1::uuid RETURNING *`,
    args: [null, ...cols.map((c) => body[c])],
  };
};

const pgErr = (reply, err) => {
  if (err.code === '23505') return reply.code(409).send({ error: 'DUPLICATE', detail: err.detail ?? err.message });
  if (err.code === '23514') return reply.code(400).send({ error: 'CONSTRAINT', detail: err.message });
  if (err.code === '23503') return reply.code(409).send({ error: 'IN_USE', detail: err.detail ?? err.message });
  throw err;
};

export async function registerMastersRoutes(app) {
  // ═══ VEHICLES ═════════════════════════════════════════════════════════════
  const VEHICLE_COLS = ['vehicle_no', 'vehicle_type', 'ownership', 'owner_name', 'make_model',
    'chassis_no', 'engine_no', 'capacity_kl', 'payload_mt', 'axle_count', 'tyre_count',
    'registration_date', 'insurance_expiry', 'fitness_expiry', 'permit_expiry', 'puc_expiry',
    'tax_expiry', 'national_permit_expiry', 'rc_photo_url', 'insurance_doc_url', 'fitness_doc_url',
    'permit_doc_url', 'fastag_id', 'gps_imei', 'status', 'remarks', 'company_id'];

  app.get(
    '/vehicles',
    { schema: { querystring: { type: 'object', properties: {
      q: { type: ['string', 'null'], maxLength: 60 },
      status: { type: ['string', 'null'], maxLength: 20 },
      expiring_days: { type: ['integer', 'null'], minimum: 1, maximum: 365 },
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 500 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      // Compliance is the point of the vehicle master, so the soonest expiry and
      // the trip rollups come back with the row rather than being recomputed in
      // the browser over every trip in the business.
      const { rows } = await query(
        `SELECT v.*, v.status::text AS status, v.vehicle_type::text AS vehicle_type,
                v.ownership::text AS ownership,
                LEAST(v.insurance_expiry, v.fitness_expiry, v.permit_expiry,
                      v.puc_expiry, v.tax_expiry, v.national_permit_expiry) AS next_expiry,
                COALESCE(t.trips, 0)::int          AS trip_count,
                COALESCE(t.last_trip, NULL)        AS last_trip_date,
                a.driver_name                      AS linked_driver,
                a.driver_id                        AS linked_driver_id
           FROM vehicles v
           LEFT JOIN LATERAL (
             SELECT count(*) trips, max(loading_date) last_trip
               FROM trips WHERE vehicle_id = v.id) t ON true
           LEFT JOIN LATERAL (
             SELECT d.name AS driver_name, d.id AS driver_id
               FROM vehicle_assignments va JOIN drivers d ON d.id = va.driver_id
              WHERE va.vehicle_id = v.id AND va.released_at IS NULL
              ORDER BY va.assigned_at DESC LIMIT 1) a ON true
          WHERE ($1::text IS NULL OR v.vehicle_no ILIKE '%'||$1||'%'
                 OR v.owner_name ILIKE '%'||$1||'%' OR v.make_model ILIKE '%'||$1||'%')
            AND ($2::text IS NULL OR v.status::text = $2::text)
            AND ($3::int  IS NULL OR LEAST(v.insurance_expiry, v.fitness_expiry, v.permit_expiry,
                                           v.puc_expiry, v.tax_expiry, v.national_permit_expiry)
                                     <= CURRENT_DATE + ($3::int || ' days')::interval)
          ORDER BY v.vehicle_no
          LIMIT $4`,
        [req.query.q || null, req.query.status || null, req.query.expiring_days ?? null, req.query.limit ?? 500]);
      return { count: rows.length, vehicles: rows };
    }
  );

  app.post('/vehicles', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.vehicle_no) return reply.code(400).send({ error: 'NO_VEHICLE_NO' });
    const cols = VEHICLE_COLS.filter((c) => b[c] !== undefined);
    try {
      const { rows } = await query(
        `INSERT INTO vehicles (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *, status::text AS status`,
        cols.map((c) => b[c]));
      reply.code(201);
      return { created: true, vehicle: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.patch('/vehicles/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const u = buildUpdate('vehicles', VEHICLE_COLS, req.body ?? {});
    if (!u) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    u.args[0] = req.params.id;
    try {
      const { rows } = await query(u.sql, u.args);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { updated: true, vehicle: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  // A vehicle that has run trips is never deleted — the trips reference it. It
  // is retired, which keeps the history readable and takes it out of dropdowns.
  app.delete('/vehicles/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows: [v] } = await query(
      `SELECT vehicle_no, (SELECT count(*) FROM trips WHERE vehicle_id = vehicles.id)::int AS trips
         FROM vehicles WHERE id = $1::uuid`, [req.params.id]);
    if (!v) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (v.trips > 0) {
      const { rows } = await query(
        `UPDATE vehicles SET status = 'INACTIVE', updated_at = now() WHERE id = $1::uuid RETURNING vehicle_no, status`,
        [req.params.id]);
      return { retired: true, hard_deleted: false, vehicle: rows[0],
        detail: `${v.vehicle_no} has run ${v.trips} trip(s), so it is marked INACTIVE rather than deleted` };
    }
    await query('DELETE FROM vehicle_assignments WHERE vehicle_id = $1::uuid', [req.params.id]);
    await query('DELETE FROM vehicles WHERE id = $1::uuid', [req.params.id]);
    return { retired: true, hard_deleted: true, vehicle_no: v.vehicle_no };
  });

  // ═══ DRIVERS ══════════════════════════════════════════════════════════════
  const DRIVER_COLS = ['name', 'mobile', 'alt_mobile', 'address', 'profile_pic_url', 'license_no',
    'license_expiry', 'dl_photo_url', 'hzd_cert_no', 'hzd_expiry', 'hzd_photo_url', 'aadhar_no',
    'aadhar_photo_url', 'pan_no', 'bank_name', 'account_no', 'ifsc_code', 'bank_photo_url',
    'guarantor_name', 'guarantor_mobile', 'join_date', 'approval_status', 'status', 'remarks', 'company_id'];

  app.get(
    '/drivers',
    { schema: { querystring: { type: 'object', properties: {
      q: { type: ['string', 'null'], maxLength: 60 },
      status: { type: ['string', 'null'], maxLength: 20 },
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 500 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      // The khata balance travels with the driver: advances given less what has
      // been recovered or credited. Computed in SQL over every producer, so it
      // cannot drift from the ledger the way a browser-side sum did.
      const { rows } = await query(
        `SELECT d.*, d.status::text AS status, d.approval_status::text AS approval_status,
                d.pan_no::text AS pan_no,
                COALESCE(k.advances, 0)::numeric(14,2)  AS total_advances,
                COALESCE(k.recovered, 0)::numeric(14,2) AS total_recovered,
                COALESCE(k.balance, 0)::numeric(14,2)   AS khata_balance,
                COALESCE(k.txns, 0)::int                AS txn_count,
                a.vehicle_no                            AS linked_vehicle,
                LEAST(d.license_expiry, d.hzd_expiry)   AS next_expiry
           FROM drivers d
           LEFT JOIN LATERAL (
             SELECT SUM(amount) FILTER (WHERE txn_type IN ('ADVANCE_GIVEN','PAYMENT_GIVEN')) AS advances,
                    SUM(amount) FILTER (WHERE txn_type IN ('SHORTAGE_RECOVERY','FINAL_PAYMENT')) AS recovered,
                    SUM(CASE WHEN txn_type IN ('ADVANCE_GIVEN','PAYMENT_GIVEN') THEN amount
                             WHEN txn_type = 'SALARY_CREDIT' THEN -amount
                             ELSE -amount END) AS balance,
                    count(*) AS txns
               FROM driver_transactions
              WHERE driver_id = d.id OR driver_name = d.name) k ON true
           LEFT JOIN LATERAL (
             SELECT v.vehicle_no FROM vehicle_assignments va JOIN vehicles v ON v.id = va.vehicle_id
              WHERE va.driver_id = d.id AND va.released_at IS NULL
              ORDER BY va.assigned_at DESC LIMIT 1) a ON true
          WHERE ($1::text IS NULL OR d.name ILIKE '%'||$1||'%' OR d.mobile ILIKE '%'||$1||'%'
                 OR d.license_no ILIKE '%'||$1||'%')
            AND ($2::text IS NULL OR d.status::text = $2::text)
          ORDER BY d.name
          LIMIT $3`,
        [req.query.q || null, req.query.status || null, req.query.limit ?? 500]);
      return { count: rows.length, drivers: rows };
    }
  );

  app.post('/drivers', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.name) return reply.code(400).send({ error: 'NO_NAME' });
    const cols = DRIVER_COLS.filter((c) => b[c] !== undefined);
    try {
      const { rows } = await query(
        `INSERT INTO drivers (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *, status::text AS status, approval_status::text AS approval_status`,
        cols.map((c) => b[c]));
      reply.code(201);
      return { created: true, driver: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.patch('/drivers/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const u = buildUpdate('drivers', DRIVER_COLS, req.body ?? {});
    if (!u) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    u.args[0] = req.params.id;
    try {
      const { rows } = await query(u.sql, u.args);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { updated: true, driver: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.delete('/drivers/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows: [d] } = await query(
      `SELECT name,
              (SELECT count(*) FROM trips WHERE driver_id = drivers.id)::int AS trips,
              (SELECT count(*) FROM driver_transactions
                WHERE driver_id = drivers.id OR driver_name = drivers.name)::int AS txns
         FROM drivers WHERE id = $1::uuid`, [req.params.id]);
    if (!d) return reply.code(404).send({ error: 'NOT_FOUND' });
    // A driver with a khata or trip history stays on record. Their money is
    // referenced by name as well as id in the migrated rows, so deleting the
    // row would orphan entries that are still owed or owing.
    if (d.trips > 0 || d.txns > 0) {
      const { rows } = await query(
        `UPDATE drivers SET status = 'INACTIVE', updated_at = now() WHERE id = $1::uuid RETURNING name, status`,
        [req.params.id]);
      return { retired: true, hard_deleted: false, driver: rows[0],
        detail: `${d.name} has ${d.trips} trip(s) and ${d.txns} khata entr${d.txns === 1 ? 'y' : 'ies'}, so the record is marked INACTIVE rather than deleted` };
    }
    await query('DELETE FROM vehicle_assignments WHERE driver_id = $1::uuid', [req.params.id]);
    await query('DELETE FROM drivers WHERE id = $1::uuid', [req.params.id]);
    return { retired: true, hard_deleted: true, name: d.name };
  });

  // ── The driver khata: every producer, one query ────────────────────────────
  app.get(
    '/drivers/:id/ledger',
    { schema: { querystring: { type: 'object', properties: {
      from: { type: ['string', 'null'], format: 'date' },
      to: { type: ['string', 'null'], format: 'date' },
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 300 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows: [d] } = await query('SELECT id, name FROM drivers WHERE id = $1::uuid', [req.params.id]);
      if (!d) return reply.code(404).send({ error: 'NOT_FOUND' });
      // Matched on id OR name: the migrated Firestore rows carry only the name.
      const args = [d.id, d.name, req.query.from || null, req.query.to || null, req.query.limit ?? 300];
      const [txns, totals, settlements] = await Promise.all([
        query(
          `SELECT dt.id, dt.txn_date, dt.txn_type, dt.amount, dt.mode, dt.remarks,
                  dt.trip_id, t.trip_code, dt.legacy_id,
                  CASE WHEN dt.legacy_id LIKE 'BILLREC-%'    THEN 'bill settlement'
                       WHEN dt.legacy_id LIKE 'UNLOADREC-%'  THEN 'unloading shortage'
                       WHEN dt.trip_id IS NOT NULL           THEN 'trip'
                       ELSE 'manual' END AS source
             FROM driver_transactions dt
             LEFT JOIN trips t ON t.id = dt.trip_id
            WHERE (dt.driver_id = $1::uuid OR dt.driver_name = $2)
              AND ($3::date IS NULL OR dt.txn_date >= $3::date)
              AND ($4::date IS NULL OR dt.txn_date <= $4::date)
            ORDER BY dt.txn_date DESC, dt.created_at DESC
            LIMIT $5`, args),
        query(
          `SELECT SUM(amount) FILTER (WHERE txn_type IN ('ADVANCE_GIVEN','PAYMENT_GIVEN'))::numeric(14,2) AS advances,
                  SUM(amount) FILTER (WHERE txn_type = 'SHORTAGE_RECOVERY')::numeric(14,2) AS recovered,
                  SUM(amount) FILTER (WHERE txn_type = 'SALARY_CREDIT')::numeric(14,2)     AS credited,
                  SUM(amount) FILTER (WHERE txn_type = 'FINAL_PAYMENT')::numeric(14,2)     AS final_paid,
                  count(*)::int AS txns
             FROM driver_transactions
            WHERE driver_id = $1::uuid OR driver_name = $2`, [d.id, d.name]),
        query(
          `SELECT settlement_no, mode, status, net_balance, earned_total, from_date, to_date, created_at
             FROM driver_settlements WHERE driver_id = $1::uuid OR driver_name = $2
            ORDER BY created_at DESC LIMIT 20`, [d.id, d.name]),
      ]);
      const t = totals.rows[0];
      const balance = money(t.advances) - money(t.recovered) - money(t.credited) - money(t.final_paid);
      return {
        driver: d,
        transactions: txns.rows,
        settlements: settlements.rows,
        totals: {
          advances: t.advances ?? '0.00',
          recovered: t.recovered ?? '0.00',
          credited: t.credited ?? '0.00',
          final_paid: t.final_paid ?? '0.00',
          txn_count: t.txns,
          // Positive = the driver holds our money. Negative = we owe them.
          balance: balance.toFixed(2),
        },
      };
    }
  );

  // A manual khata entry. Money the trip screens record arrives through
  // /ops/trips/:id/driver-txn instead, so both land in the same table.
  app.post(
    '/drivers/:id/ledger',
    { schema: { body: { type: 'object', required: ['txn_type', 'amount'], additionalProperties: false, properties: {
      txn_type: { type: 'string', enum: ['ADVANCE_GIVEN', 'PAYMENT_GIVEN', 'FINAL_PAYMENT', 'SHORTAGE_RECOVERY', 'FUEL_EXPENSE', 'SALARY_CREDIT'] },
      amount: { type: 'number', exclusiveMinimum: 0 },
      txn_date: { type: ['string', 'null'], format: 'date' },
      mode: { type: ['string', 'null'], maxLength: 40 },
      remarks: { type: ['string', 'null'], maxLength: 300 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const { rows: [d] } = await query('SELECT id, name FROM drivers WHERE id = $1::uuid', [req.params.id]);
      if (!d) return reply.code(404).send({ error: 'NOT_FOUND' });
      const { rows } = await query(
        `INSERT INTO driver_transactions (driver_id, driver_name, txn_date, txn_type, amount, mode, remarks)
         VALUES ($1::uuid, $2, COALESCE($3::date, CURRENT_DATE), $4, $5, $6, $7) RETURNING *`,
        [d.id, d.name, b.txn_date ?? null, b.txn_type, b.amount, b.mode ?? null, b.remarks ?? null]);
      reply.code(201);
      return { created: true, transaction: rows[0] };
    }
  );

  // ── Driver app request queue ───────────────────────────────────────────────
  app.get(
    '/driver-requests',
    { schema: { querystring: { type: 'object', properties: {
      status: { type: ['string', 'null'], enum: ['PENDING', 'PAID', 'REJECTED', null] },
      driver_name: { type: ['string', 'null'], maxLength: 120 },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows } = await query(
        `SELECT r.*, t.trip_code
           FROM driver_requests r LEFT JOIN trips t ON t.id = r.trip_id
          WHERE ($1::text IS NULL OR r.status = $1::text)
            AND ($2::text IS NULL OR r.driver_name = $2::text)
          ORDER BY r.requested_at DESC LIMIT $3`,
        [req.query.status || null, req.query.driver_name || null, req.query.limit ?? 200]);
      return { count: rows.length, requests: rows };
    }
  );

  app.post(
    '/driver-requests',
    { schema: { body: { type: 'object', required: ['driver_name', 'request_type'], additionalProperties: false, properties: {
      driver_id: { type: ['string', 'null'], format: 'uuid' },
      driver_name: { type: 'string', maxLength: 120 },
      trip_id: { type: ['string', 'null'], format: 'uuid' },
      request_type: { type: 'string', enum: ['ADVANCE', 'FUEL', 'EXPENSE', 'LEAVE', 'OTHER'] },
      amount: { type: 'number', minimum: 0, default: 0 },
      remarks: { type: ['string', 'null'], maxLength: 300 },
      photo_url: { type: ['string', 'null'], maxLength: 500 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const { rows } = await query(
        `INSERT INTO driver_requests (driver_id, driver_name, trip_id, request_type, amount, remarks, photo_url)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7) RETURNING *`,
        [b.driver_id ?? null, b.driver_name, b.trip_id ?? null, b.request_type,
         b.amount ?? 0, b.remarks ?? null, b.photo_url ?? null]);
      reply.code(201);
      return { created: true, request: rows[0] };
    }
  );

  // Paying a request writes the khata row and links the two, in one transaction,
  // so a request cannot be paid twice and the entry is always traceable back.
  app.post(
    '/driver-requests/:id/pay',
    { schema: { body: { type: 'object', additionalProperties: false, properties: {
      payment_mode: { type: 'string', maxLength: 40, default: 'Office Cash' },
      amount: { type: ['number', 'null'], exclusiveMinimum: 0 },
      settled_by: { type: ['string', 'null'], maxLength: 100 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body ?? {};
      const { rows: [r] } = await query('SELECT * FROM driver_requests WHERE id = $1::uuid', [req.params.id]);
      if (!r) return reply.code(404).send({ error: 'NOT_FOUND' });
      if (r.status !== 'PENDING') {
        return reply.code(409).send({ error: 'NOT_PENDING', detail: `this request is already ${r.status}` });
      }
      const amount = b.amount != null ? b.amount : money(r.amount);
      if (!(amount > 0)) return reply.code(400).send({ error: 'BAD_AMOUNT', detail: 'the request has no amount to pay' });

      const out = await withTransaction(async (t) => {
        const { rows: [txn] } = await t.query(
          `INSERT INTO driver_transactions
             (driver_id, driver_name, trip_id, txn_date, txn_type, amount, mode, remarks)
           VALUES ($1::uuid, $2, $3::uuid, CURRENT_DATE, $4, $5, $6, $7) RETURNING *`,
          [r.driver_id, r.driver_name, r.trip_id,
           r.request_type === 'FUEL' ? 'FUEL_EXPENSE' : 'ADVANCE_GIVEN',
           amount, b.payment_mode ?? 'Office Cash',
           `[APP ${r.request_type} paid via ${b.payment_mode ?? 'Office Cash'}] ${r.remarks ?? ''}`.trim()]);
        const { rows: [req2] } = await t.query(
          `UPDATE driver_requests SET status = 'PAID', payment_mode = $2, txn_id = $3::uuid,
                                      settled_at = now(), settled_by = $4
            WHERE id = $1::uuid RETURNING *`,
          [req.params.id, b.payment_mode ?? 'Office Cash', txn.id, b.settled_by ?? null]);
        return { request: req2, transaction: txn };
      });
      return { paid: true, ...out };
    }
  );

  app.patch(
    '/driver-requests/:id',
    { schema: { body: { type: 'object', required: ['status'], additionalProperties: false, properties: {
      status: { type: 'string', enum: ['REJECTED'] },
      remarks: { type: ['string', 'null'], maxLength: 300 },
      settled_by: { type: ['string', 'null'], maxLength: 100 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      // Only rejection is a PATCH. Paying goes through /pay, which is the only
      // path that may create a khata entry.
      const { rows } = await query(
        `UPDATE driver_requests SET status = 'REJECTED',
                remarks = COALESCE($2, remarks), settled_at = now(), settled_by = $3
          WHERE id = $1::uuid AND status = 'PENDING' RETURNING *`,
        [req.params.id, req.body.remarks ?? null, req.body.settled_by ?? null]);
      if (!rows.length) return reply.code(409).send({ error: 'NOT_PENDING', detail: 'no pending request with that id' });
      return { rejected: true, request: rows[0] };
    }
  );

  // ═══ VEHICLE ↔ DRIVER ASSIGNMENTS ═════════════════════════════════════════
  app.get('/assignments', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT a.id, a.vehicle_id, a.driver_id, a.assigned_at, a.released_at, a.state, a.remarks,
              v.vehicle_no, d.name AS driver_name, d.mobile AS driver_mobile
         FROM vehicle_assignments a
         JOIN vehicles v ON v.id = a.vehicle_id
         JOIN drivers  d ON d.id = a.driver_id
        ORDER BY a.released_at IS NOT NULL, a.assigned_at DESC`);
    return { count: rows.length, assignments: rows };
  });

  // Linking releases whatever the vehicle and the driver were previously on, in
  // one transaction. A truck with two live drivers (or the reverse) is what made
  // the Firestore version's "latest link wins" sort necessary in the first place.
  app.post(
    '/assignments',
    { schema: { body: { type: 'object', required: ['vehicle_id', 'driver_id'], additionalProperties: false, properties: {
      vehicle_id: { type: 'string', format: 'uuid' },
      driver_id: { type: 'string', format: 'uuid' },
      remarks: { type: ['string', 'null'], maxLength: 300 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      try {
        const out = await withTransaction(async (t) => {
          await t.query(
            `UPDATE vehicle_assignments SET released_at = now(), state = 'RELEASED', updated_at = now()
              WHERE released_at IS NULL AND (vehicle_id = $1::uuid OR driver_id = $2::uuid)`,
            [b.vehicle_id, b.driver_id]);
          const { rows } = await t.query(
            `INSERT INTO vehicle_assignments (vehicle_id, driver_id, assigned_at, state, remarks)
             VALUES ($1::uuid, $2::uuid, now(), 'LINKED', $3) RETURNING *`,
            [b.vehicle_id, b.driver_id, b.remarks ?? null]);
          return rows[0];
        });
        reply.code(201);
        return { linked: true, assignment: out };
      } catch (err) { return pgErr(reply, err); }
    }
  );

  app.delete('/assignments/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    // Unlinking is a release, not a delete: who drove what, when, is history.
    const { rows } = await query(
      `UPDATE vehicle_assignments SET released_at = now(), state = 'RELEASED', updated_at = now()
        WHERE id = $1::uuid AND released_at IS NULL RETURNING *`, [req.params.id]);
    if (!rows.length) return reply.code(409).send({ error: 'NOT_LINKED', detail: 'no live assignment with that id' });
    return { released: true, assignment: rows[0] };
  });

  // ═══ CUSTOMERS ════════════════════════════════════════════════════════════
  const CUSTOMER_COLS = ['customer_code', 'customer_name', 'address', 'state', 'pincode', 'gst_no',
    'pan_no', 'contact_person', 'mobile_no', 'email', 'payment_terms', 'opening_balance',
    'consignees', 'locations', 'portal_features', 'status', 'customer_source', 'approval_status',
    'portal_enabled', 'portal_email'];

  app.get(
    '/customers',
    { schema: { querystring: { type: 'object', properties: {
      q: { type: ['string', 'null'], maxLength: 60 },
      source: { type: ['string', 'null'], enum: ['INTERNAL', 'PORTAL', null] },
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 500 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      // Outstanding comes from the ledger, not from a stored counter: a customer
      // balance and the debtor account must be the same number by construction.
      const { rows } = await query(
        `SELECT c.*, c.status::text AS status, c.gst_no::text AS gst_no, c.pan_no::text AS pan_no, c.email::text AS email,
                c.portal_email::text AS portal_email,
                COALESCE(l.balance, 0)::numeric(14,2) AS ledger_outstanding,
                COALESCE(b.bills, 0)::int             AS bill_count,
                COALESCE(b.billed, 0)::numeric(14,2)  AS total_billed,
                COALESCE(b.received, 0)::numeric(14,2) AS total_received_bills,
                COALESCE(t.trips, 0)::int             AS trip_count
           FROM customers c
           LEFT JOIN LATERAL (
             SELECT SUM(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END) AS balance
               FROM ledger_entries e
              WHERE lower(e.ledger_name) = lower('Debtors: ' || c.customer_name)) l ON true
           LEFT JOIN LATERAL (
             SELECT count(*) bills, SUM(total_net) billed, SUM(received_amount) received
               FROM company_bills WHERE customer_id = c.id AND status <> 'CANCELLED') b ON true
           LEFT JOIN LATERAL (
             SELECT count(*) trips FROM trips WHERE customer_id = c.id) t ON true
          WHERE ($1::text IS NULL OR c.customer_name ILIKE '%'||$1||'%'
                 OR c.contact_person ILIKE '%'||$1||'%' OR c.mobile_no ILIKE '%'||$1||'%')
            AND ($2::text IS NULL OR c.customer_source = $2::text)
          ORDER BY c.customer_name
          LIMIT $3`,
        [req.query.q || null, req.query.source || null, req.query.limit ?? 500]);
      return { count: rows.length, customers: rows };
    }
  );

  app.post('/customers', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.customer_name) return reply.code(400).send({ error: 'NO_NAME' });
    const cols = CUSTOMER_COLS.filter((c) => b[c] !== undefined);
    try {
      const { rows } = await query(
        `INSERT INTO customers (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
         RETURNING *, gst_no::text AS gst_no, pan_no::text AS pan_no`,
        cols.map((c) => b[c]));
      reply.code(201);
      return { created: true, customer: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.patch('/customers/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const u = buildUpdate('customers', CUSTOMER_COLS, req.body ?? {});
    if (!u) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    u.args[0] = req.params.id;
    try {
      const { rows } = await query(u.sql, u.args);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { updated: true, customer: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.delete('/customers/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows: [c] } = await query(
      `SELECT customer_name,
              (SELECT count(*) FROM trips WHERE customer_id = customers.id)::int AS trips,
              (SELECT count(*) FROM company_bills WHERE customer_id = customers.id)::int AS bills
         FROM customers WHERE id = $1::uuid`, [req.params.id]);
    if (!c) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (c.trips > 0 || c.bills > 0) {
      const { rows } = await query(
        `UPDATE customers SET status = 'INACTIVE', updated_at = now() WHERE id = $1::uuid
         RETURNING customer_name, status`, [req.params.id]);
      return { retired: true, hard_deleted: false, customer: rows[0],
        detail: `${c.customer_name} has ${c.trips} trip(s) and ${c.bills} bill(s), so the record is marked INACTIVE rather than deleted` };
    }
    await query('DELETE FROM customers WHERE id = $1::uuid', [req.params.id]);
    return { retired: true, hard_deleted: true, customer_name: c.customer_name };
  });

  // ═══ VENDORS ══════════════════════════════════════════════════════════════
  const VENDOR_COLS = ['vendor_name', 'vendor_type', 'contact_person', 'mobile_no', 'address',
    'gst_no', 'bank_account', 'ifsc_code', 'opening_balance', 'status'];

  app.get(
    '/vendors',
    { schema: { querystring: { type: 'object', properties: {
      q: { type: ['string', 'null'], maxLength: 60 },
      vendor_type: { type: ['string', 'null'], maxLength: 60 },
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 500 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows } = await query(
        `SELECT v.*, v.status::text AS status, v.gst_no::text AS gst_no,
                COALESCE(f.unbilled, 0)::numeric(14,2) AS unbilled_fuel,
                COALESCE(f.slips, 0)::int              AS fuel_slips,
                COALESCE(x.txns, 0)::int               AS txn_count,
                (v.opening_balance + COALESCE(x.net, 0))::numeric(14,2) AS running_balance
           FROM vendors v
           LEFT JOIN LATERAL (
             SELECT SUM(amount) unbilled, count(*) slips FROM fuel_entries
              WHERE vendor_id = v.id AND COALESCE(bill_status,'') NOT IN ('SETTLED','PAID')) f ON true
           LEFT JOIN LATERAL (
             SELECT count(*) txns,
                    SUM(CASE WHEN txn_type = 'PAYMENT_GIVEN' THEN -amount ELSE amount END) net
               FROM vendor_txns WHERE vendor_id = v.id) x ON true
          WHERE ($1::text IS NULL OR v.vendor_name ILIKE '%'||$1||'%' OR v.contact_person ILIKE '%'||$1||'%')
            AND ($2::text IS NULL OR v.vendor_type ILIKE '%'||$2||'%')
          ORDER BY v.vendor_name
          LIMIT $3`,
        [req.query.q || null, req.query.vendor_type || null, req.query.limit ?? 500]);
      return { count: rows.length, vendors: rows };
    }
  );

  app.post('/vendors', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.vendor_name) return reply.code(400).send({ error: 'NO_NAME' });
    const cols = VENDOR_COLS.filter((c) => b[c] !== undefined);
    try {
      const { rows } = await query(
        `INSERT INTO vendors (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
         RETURNING *, gst_no::text AS gst_no`, cols.map((c) => b[c]));
      reply.code(201);
      return { created: true, vendor: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.patch('/vendors/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const u = buildUpdate('vendors', VENDOR_COLS, req.body ?? {});
    if (!u) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    u.args[0] = req.params.id;
    try {
      const { rows } = await query(u.sql, u.args);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { updated: true, vendor: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.get('/vendors/:id/ledger', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows: [v] } = await query(
      'SELECT id, vendor_name, opening_balance FROM vendors WHERE id = $1::uuid', [req.params.id]);
    if (!v) return reply.code(404).send({ error: 'NOT_FOUND' });
    const [txns, fuel] = await Promise.all([
      query(`SELECT * FROM vendor_txns WHERE vendor_id = $1::uuid ORDER BY txn_date DESC, created_at DESC LIMIT 300`, [v.id]),
      query(`SELECT id, entry_date, vehicle_no, memo_no, liters, rate, amount, bill_status
               FROM fuel_entries WHERE vendor_id = $1::uuid ORDER BY entry_date DESC LIMIT 300`, [v.id]),
    ]);
    const net = txns.rows.reduce((a, r) => a + (r.txn_type === 'PAYMENT_GIVEN' ? -money(r.amount) : money(r.amount)), 0);
    return {
      vendor: v,
      transactions: txns.rows,
      fuel_entries: fuel.rows,
      running_balance: (money(v.opening_balance) + net).toFixed(2),
    };
  });

  // A vendor payment moves real money, so it posts a PAYMENT voucher through
  // TARA as well as the subsidiary row. The Firestore version only bumped a
  // stored `current_balance`, which is why vendor balances drifted from the GL.
  app.post(
    '/vendors/:id/ledger',
    { schema: { body: { type: 'object', required: ['txn_type', 'amount'], additionalProperties: false, properties: {
      txn_type: { type: 'string', enum: ['PAYMENT_GIVEN', 'BILL_RECEIVED', 'OPENING', 'ADJUSTMENT', 'CREDIT_NOTE'] },
      amount: { type: 'number', exclusiveMinimum: 0 },
      txn_date: { type: ['string', 'null'], format: 'date' },
      payment_mode: { type: ['string', 'null'], maxLength: 40 },
      account: { type: ['string', 'null'], maxLength: 120 },
      remarks: { type: ['string', 'null'], maxLength: 300 },
      created_by: { type: ['string', 'null'], maxLength: 100 },
      post_to_ledger: { type: 'boolean', default: true },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const { rows: [v] } = await query('SELECT id, vendor_name, vendor_type FROM vendors WHERE id = $1::uuid', [req.params.id]);
      if (!v) return reply.code(404).send({ error: 'NOT_FOUND' });
      const date = b.txn_date ?? new Date().toISOString().slice(0, 10);

      let voucher = null;
      let ledgerNote = null;
      if (b.txn_type === 'PAYMENT_GIVEN' && b.post_to_ledger !== false) {
        if (!b.account) {
          return reply.code(400).send({
            error: 'NO_ACCOUNT',
            detail: 'a vendor payment needs the bank/cash account it left, or post_to_ledger=false to record it in the subsidiary only',
          });
        }
        try {
          voucher = await postVoucher({
            type: 'PAYMENT',
            account: b.account,
            party_ledger: `Creditors: ${v.vendor_name}`,
            party_group: /fuel|pump/i.test(v.vendor_type ?? '') ? 'Sundry Creditors (Fuel Pumps)' : 'Sundry Creditors (Vendors)',
            amount: b.amount,
            entry_date: date,
            narration: `Payment to ${v.vendor_name}${b.remarks ? ` — ${b.remarks}` : ''}`,
            source_type: 'VENDOR_PAYMENT',
            created_by: b.created_by ?? null,
          });
          await drain().catch(() => {});
        } catch (err) {
          const map = { OVERDRAFT: 422, DUPLICATE_REF: 409, NO_ACCOUNT: 400 };
          if (map[err.code]) return reply.code(map[err.code]).send({ error: err.code, detail: err.message, balance: err.balance });
          ledgerNote = err.message;
        }
      }

      const { rows } = await query(
        `INSERT INTO vendor_txns (vendor_id, vendor_name, txn_date, txn_type, amount,
                                  payment_mode, remarks, voucher_id, created_by)
         VALUES ($1::uuid, $2, $3::date, $4, $5, $6, $7, $8::uuid, $9) RETURNING *`,
        [v.id, v.vendor_name, date, b.txn_type, b.amount, b.payment_mode ?? null,
         b.remarks ?? null, voucher?.voucher_id ?? null, b.created_by ?? null]);
      reply.code(201);
      return { created: true, transaction: rows[0], voucher_id: voucher?.voucher_id ?? null, ledger_note: ledgerNote };
    }
  );

  // ═══ LANES (rtkm_master) ══════════════════════════════════════════════════
  const LANE_COLS = ['customer_name', 'registered_assessee', 'depot_link', 'consignee_id',
    'consignee_name', 'vehicle_capacity', 'item_type', 'rtkm_distance', 'fixed_hsd_qty',
    'fixed_cash_amt', 'toll_amt', 'status'];

  app.get('/lanes', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    // The derived rate card is joined on so the screen can show what a lane is
    // actually being paid, next to what the master claims its distance is —
    // migration 016 documented that those two disagree (242.400 vs 262.8).
    const { rows } = await query(
      `SELECT r.*,
              lr.current_rate, lr.current_rtd, lr.loads, lr.last_billed, lr.material,
              CASE WHEN lr.current_rtd IS NOT NULL AND r.rtkm_distance IS NOT NULL
                   THEN (lr.current_rtd - r.rtkm_distance)::numeric(10,3) END AS rtd_variance
         FROM rtkm_master r
         LEFT JOIN LATERAL (
           SELECT * FROM v_iocl_lane_rate l
            WHERE upper(regexp_replace(l.ship_to_name, '[^A-Za-z0-9]', '', 'g'))
                = upper(regexp_replace(r.consignee_name, '[^A-Za-z0-9]', '', 'g'))
            ORDER BY l.loads DESC LIMIT 1) lr ON true
        ORDER BY r.customer_name, r.consignee_name`);
    return { count: rows.length, lanes: rows };
  });

  app.post('/lanes', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.consignee_name) return reply.code(400).send({ error: 'NO_CONSIGNEE' });
    const cols = LANE_COLS.filter((c) => b[c] !== undefined);
    try {
      const { rows } = await query(
        `INSERT INTO rtkm_master (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        cols.map((c) => b[c]));
      reply.code(201);
      return { created: true, lane: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.patch('/lanes/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const u = buildUpdate('rtkm_master', LANE_COLS, req.body ?? {});
    if (!u) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    u.args[0] = req.params.id;
    try {
      const { rows } = await query(u.sql, u.args);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { updated: true, lane: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.delete('/lanes/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `UPDATE rtkm_master SET status = 'INACTIVE', updated_at = now() WHERE id = $1::uuid RETURNING consignee_name`,
      [req.params.id]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    // Lanes are retired, not deleted: historic trips were priced against them.
    return { retired: true, lane: rows[0] };
  });

  // ═══ RATES (rate_master) ══════════════════════════════════════════════════
  const RATE_COLS = ['customer_name', 'route', 'rate_type', 'rate', 'unit', 'valid_from', 'valid_to', 'status'];

  app.get('/rates', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const [manual, derived] = await Promise.all([
      query(`SELECT * FROM rate_master ORDER BY customer_name, route, valid_from DESC`),
      // The evidence-backed rate card, for comparison against anything typed in.
      query(`SELECT ship_to_code, ship_to_name, material, current_rate, current_rtd,
                    rate_as_of, loads, rate_changes, first_billed, last_billed
               FROM v_iocl_lane_rate ORDER BY loads DESC`),
    ]);
    return { count: manual.rows.length, rates: manual.rows, derived_rate_card: derived.rows };
  });

  app.post('/rates', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.rate) return reply.code(400).send({ error: 'NO_RATE' });
    const cols = RATE_COLS.filter((c) => b[c] !== undefined);
    try {
      const { rows } = await query(
        `INSERT INTO rate_master (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        cols.map((c) => b[c]));
      reply.code(201);
      return { created: true, rate: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.patch('/rates/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const u = buildUpdate('rate_master', RATE_COLS, req.body ?? {});
    if (!u) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    u.args[0] = req.params.id;
    try {
      const { rows } = await query(u.sql, u.args);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { updated: true, rate: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.delete('/rates/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query('DELETE FROM rate_master WHERE id = $1::uuid RETURNING id', [req.params.id]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { deleted: true };
  });
}
