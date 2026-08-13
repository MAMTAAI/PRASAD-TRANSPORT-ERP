// server/modules/vehicles.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Vehicles — the first module ported off Firestore.
//
// Reference implementation for every module that follows:
//   • parameterised SQL only (never string-concatenated), so injection is
//     structurally impossible rather than something reviewers must catch
//   • JSON schemas on every route, so bad input is rejected before it reaches
//     the database
//   • keyset pagination, so a 50-row fleet and a 50,000-row fleet cost the same
// ─────────────────────────────────────────────────────────────────────────────
import { query, queryOne, withTransaction } from '../db/pool.js';

// Columns the API is willing to expose and accept. An explicit allow-list
// keeps a future `ALTER TABLE ... ADD COLUMN internal_note` from leaking the
// moment it is added.
const WRITABLE = [
  'company_id', 'vehicle_no', 'vehicle_type', 'ownership', 'owner_name',
  'make_model', 'chassis_no', 'engine_no', 'capacity_kl', 'payload_mt',
  'axle_count', 'tyre_count', 'registration_date', 'insurance_expiry',
  'fitness_expiry', 'permit_expiry', 'puc_expiry', 'tax_expiry',
  'national_permit_expiry', 'rc_photo_url', 'insurance_doc_url',
  'fitness_doc_url', 'permit_doc_url', 'fastag_id', 'gps_imei', 'status',
  'remarks',
];

const SELECT_COLS = `
  id, legacy_id, company_id, vehicle_no, vehicle_no_norm, vehicle_type,
  ownership, owner_name, make_model, chassis_no, engine_no, capacity_kl,
  payload_mt, axle_count, tyre_count, registration_date, insurance_expiry,
  fitness_expiry, permit_expiry, puc_expiry, tax_expiry, national_permit_expiry,
  rc_photo_url, insurance_doc_url, fitness_doc_url, permit_doc_url,
  fastag_id, gps_imei, status, remarks, created_at, updated_at`;

const VEHICLE_TYPES = ['TANKER', 'TRUCK', 'TRAILER', 'TIPPER', 'CONTAINER', 'OTHER'];
const OWNERSHIPS = ['OWNED', 'ATTACHED', 'LEASED'];
const STATUSES = ['ACTIVE', 'INACTIVE', 'BLACKLISTED', 'ARCHIVED'];

const vehicleBody = {
  type: 'object',
  required: ['vehicle_no'],
  additionalProperties: false,
  properties: {
    company_id: { type: 'string', format: 'uuid' },
    vehicle_no: { type: 'string', minLength: 4, maxLength: 20 },
    vehicle_type: { type: 'string', enum: VEHICLE_TYPES },
    ownership: { type: 'string', enum: OWNERSHIPS },
    owner_name: { type: ['string', 'null'], maxLength: 120 },
    make_model: { type: ['string', 'null'], maxLength: 120 },
    chassis_no: { type: ['string', 'null'], maxLength: 40 },
    engine_no: { type: ['string', 'null'], maxLength: 40 },
    capacity_kl: { type: ['number', 'null'], exclusiveMinimum: 0, maximum: 100 },
    payload_mt: { type: ['number', 'null'], exclusiveMinimum: 0, maximum: 100 },
    axle_count: { type: ['integer', 'null'], minimum: 2, maximum: 12 },
    tyre_count: { type: ['integer', 'null'], minimum: 4, maximum: 22 },
    registration_date: { type: ['string', 'null'], format: 'date' },
    insurance_expiry: { type: ['string', 'null'], format: 'date' },
    fitness_expiry: { type: ['string', 'null'], format: 'date' },
    permit_expiry: { type: ['string', 'null'], format: 'date' },
    puc_expiry: { type: ['string', 'null'], format: 'date' },
    tax_expiry: { type: ['string', 'null'], format: 'date' },
    national_permit_expiry: { type: ['string', 'null'], format: 'date' },
    rc_photo_url: { type: ['string', 'null'], maxLength: 500 },
    insurance_doc_url: { type: ['string', 'null'], maxLength: 500 },
    fitness_doc_url: { type: ['string', 'null'], maxLength: 500 },
    permit_doc_url: { type: ['string', 'null'], maxLength: 500 },
    fastag_id: { type: ['string', 'null'], maxLength: 40 },
    gps_imei: { type: ['string', 'null'], maxLength: 20 },
    status: { type: 'string', enum: STATUSES },
    remarks: { type: ['string', 'null'], maxLength: 1000 },
  },
};

/** Build a parameterised INSERT/UPDATE from the allow-list. */
function pickWritable(body) {
  const cols = WRITABLE.filter((c) => body[c] !== undefined);
  const values = cols.map((c) => body[c]);
  return { cols, values };
}

export async function registerVehicleRoutes(app) {
  // ── LIST ─────────────────────────────────────────────────────────────────
  // Keyset pagination on (vehicle_no, id). OFFSET would degrade linearly as the
  // fleet grows; a cursor stays flat.
  app.get(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: STATUSES },
            vehicle_type: { type: 'string', enum: VEHICLE_TYPES },
            company_id: { type: 'string', format: 'uuid' },
            search: { type: 'string', maxLength: 40 },
            expiring_within_days: { type: 'integer', minimum: 1, maximum: 365 },
            cursor: { type: 'string', maxLength: 60 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (req) => {
      const { status, vehicle_type, company_id, search, expiring_within_days, cursor, limit } = req.query;
      const where = [];
      const params = [];
      const add = (sql, value) => {
        params.push(value);
        where.push(sql.replace('?', `$${params.length}`));
      };

      // Default to the live fleet; archived vehicles are opt-in.
      if (status) add('status = ?::record_status', status);
      else where.push(`status <> 'ARCHIVED'`);

      if (vehicle_type) add('vehicle_type = ?::vehicle_kind', vehicle_type);
      if (company_id) add('company_id = ?', company_id);
      // Match on the normalised column so "as19c" finds "AS 19C 8666".
      if (search) add('vehicle_no_norm LIKE ?', `%${search.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}%`);
      if (expiring_within_days) {
        add(
          `LEAST(insurance_expiry, fitness_expiry, permit_expiry, puc_expiry)
             <= CURRENT_DATE + make_interval(days => ?)`,
          expiring_within_days
        );
      }
      if (cursor) add('vehicle_no > ?', cursor);

      params.push(limit);
      const { rows } = await query(
        `SELECT ${SELECT_COLS} FROM vehicles
          WHERE ${where.join(' AND ')}
          ORDER BY vehicle_no ASC
          LIMIT $${params.length}`,
        params
      );

      return {
        data: rows,
        // Null means "no more pages" — the client stops when this is null
        // rather than guessing from a row count.
        next_cursor: rows.length === limit ? rows[rows.length - 1].vehicle_no : null,
      };
    }
  );

  // ── READ ─────────────────────────────────────────────────────────────────
  app.get(
    '/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      },
    },
    async (req, reply) => {
      const vehicle = await queryOne(`SELECT ${SELECT_COLS} FROM vehicles WHERE id = $1`, [req.params.id]);
      if (!vehicle) return reply.code(404).send({ error: 'NOT_FOUND' });

      // The current driver comes from the assignment history, not a stale
      // denormalised column — one source of truth for custody.
      const assignment = await queryOne(
        `SELECT a.id, a.assigned_at, d.id AS driver_id, d.name AS driver_name,
                d.mobile AS driver_mobile, d.license_expiry, d.hzd_expiry
           FROM vehicle_assignments a
           JOIN drivers d ON d.id = a.driver_id
          WHERE a.vehicle_id = $1 AND a.state = 'ACTIVE'`,
        [req.params.id]
      );
      return { ...vehicle, current_assignment: assignment };
    }
  );

  // ── CREATE ───────────────────────────────────────────────────────────────
  app.post('/', { schema: { body: vehicleBody } }, async (req, reply) => {
    const { cols, values } = pickWritable(req.body);
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const row = await queryOne(
      `INSERT INTO vehicles (${cols.join(', ')}) VALUES (${placeholders.join(', ')})
       RETURNING ${SELECT_COLS}`,
      values
    );
    reply.code(201);
    return row;
  });

  // ── UPDATE ───────────────────────────────────────────────────────────────
  app.patch(
    '/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: { ...vehicleBody, required: [] },
      },
    },
    async (req, reply) => {
      const { cols, values } = pickWritable(req.body);
      if (!cols.length) return reply.code(400).send({ error: 'NO_FIELDS' });

      const sets = cols.map((c, i) => `${c} = $${i + 1}`);
      const row = await queryOne(
        `UPDATE vehicles SET ${sets.join(', ')} WHERE id = $${cols.length + 1}
         RETURNING ${SELECT_COLS}`,
        [...values, req.params.id]
      );
      if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
      return row;
    }
  );

  // ── ARCHIVE (never a hard DELETE) ────────────────────────────────────────
  // Trips, fuel entries and ledger rows reference vehicles for years. Deleting
  // a vehicle would orphan that history, so retirement is a status change and
  // the FKs are ON DELETE RESTRICT to make the hard delete impossible anyway.
  app.delete(
    '/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      },
    },
    async (req, reply) => {
      return withTransaction(async (tx) => {
        const { rows } = await tx.query(
          `UPDATE vehicles SET status = 'ARCHIVED' WHERE id = $1 RETURNING id, vehicle_no, status`,
          [req.params.id]
        );
        if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });

        // Release the driver in the same transaction — an archived vehicle must
        // never keep holding a driver who is now free to take another truck.
        await tx.query(
          `UPDATE vehicle_assignments
              SET state = 'ENDED', released_at = now()
            WHERE vehicle_id = $1 AND state = 'ACTIVE'`,
          [req.params.id]
        );
        return rows[0];
      });
    }
  );

  // ── COMPLIANCE DASHBOARD ─────────────────────────────────────────────────
  // The query the document store could not answer without reading the whole
  // fleet into the client: what expires next, across the whole fleet, sorted.
  app.get(
    '/reports/compliance-due',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { days: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
        },
      },
    },
    async (req) => {
      const { rows } = await query(
        `SELECT vehicle_no, vehicle_type, insurance_expiry, fitness_expiry,
                permit_expiry, puc_expiry, tax_expiry,
                LEAST(insurance_expiry, fitness_expiry, permit_expiry, puc_expiry) AS next_due,
                LEAST(insurance_expiry, fitness_expiry, permit_expiry, puc_expiry) - CURRENT_DATE AS days_left
           FROM vehicles
          WHERE status = 'ACTIVE'
            AND LEAST(insurance_expiry, fitness_expiry, permit_expiry, puc_expiry)
                <= CURRENT_DATE + make_interval(days => $1)
          ORDER BY next_due ASC NULLS LAST`,
        [req.query.days]
      );
      return { window_days: req.query.days, count: rows.length, data: rows };
    }
  );
}
