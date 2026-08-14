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
import { query, withTransaction, isDegraded } from '../db/pool.js';

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

  app.get('/loads', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { status } = req.query ?? {};
    const { rows } = status
      ? await query(`${LOAD_SELECT} WHERE l.status = $1 ORDER BY l.created_at DESC`, [String(status).toUpperCase()])
      : await query(`${LOAD_SELECT} ORDER BY l.created_at DESC`);
    return { loads: rows };
  });

  app.post('/loads', async (req, reply) => {
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

  app.patch('/loads/:id', async (req, reply) => {
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

  app.delete('/loads/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const row = await byId('bazaar_loads')(req.params.id);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    try { await query('DELETE FROM bazaar_loads WHERE id = $1::uuid', [row.id]); return { deleted: true }; }
    catch (e) { return pgErr(reply, e); }   // 23503 → a bid still references it
  });

  // ═══ BIDS ═════════════════════════════════════════════════════════════════
  app.get('/bids', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { load_id, vendor_name } = req.query ?? {};
    const where = [], args = [];
    if (load_id) { args.push(load_id); where.push(`load_id = $${args.length}`); }
    if (vendor_name) { args.push(vendor_name); where.push(`vendor_name = $${args.length}`); }
    const { rows } = await query(
      `SELECT * FROM bazaar_bids ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`, args);
    return { bids: rows };
  });

  app.post('/bids', async (req, reply) => {
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

  // ── Award ────────────────────────────────────────────────────────────────
  app.post('/loads/:loadId/award', async (req, reply) => {
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
        if (L[0].status !== 'OPEN') return { code: 409, body: { error: 'LOAD_NOT_OPEN', detail: `load is ${L[0].status}` } };

        const { rows: B } = await c.query(
          'SELECT * FROM bazaar_bids WHERE id = $1::uuid AND load_id = $2 FOR UPDATE', [bid_id, req.params.loadId]);
        if (!B.length) return { code: 404, body: { error: 'NO_SUCH_BID' } };

        await c.query(`UPDATE bazaar_bids SET status = 'REJECTED', updated_at = now()
                        WHERE load_id = $1 AND id <> $2::uuid AND status = 'PENDING'`, [req.params.loadId, bid_id]);
        const { rows: W } = await c.query(`UPDATE bazaar_bids SET status = 'ACCEPTED', updated_at = now()
                                            WHERE id = $1::uuid RETURNING *`, [bid_id]);
        const { rows: U } = await c.query(`UPDATE bazaar_loads SET status = 'AWARDED', updated_at = now()
                                            WHERE load_id = $1 RETURNING *`, [req.params.loadId]);
        return { code: 200, body: { load: U[0], bid: W[0] } };
      });
      return reply.code(out.code).send(out.body);
    } catch (e) { return pgErr(reply, e); }
  });

  // ═══ MARKET VEHICLES ══════════════════════════════════════════════════════
  app.get('/market-vehicles', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query('SELECT * FROM market_vehicles ORDER BY created_at DESC');
    return { vehicles: rows };
  });

  app.post('/market-vehicles', async (req, reply) => {
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

  app.patch('/market-vehicles/:id', async (req, reply) => {
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
  app.post('/market-vehicles/:id/approve', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const row = await byId('market_vehicles')(req.params.id);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    const { rows } = await query(
      `UPDATE market_vehicles SET system_status = 'System Active', updated_at = now()
        WHERE id = $1::uuid RETURNING *`, [row.id]);
    return { vehicle: rows[0] };
  });

  app.delete('/market-vehicles/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const row = await byId('market_vehicles')(req.params.id);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    await query('DELETE FROM market_vehicles WHERE id = $1::uuid', [row.id]);
    return { deleted: true };
  });

  // ═══ ONBOARDING ═══════════════════════════════════════════════════════════
  // The response carries `agency_name` / `owner_name` aliases so the portal and
  // the approvals screen keep reading the names they already know, while the
  // table stores one canonical pair (see migration 041).
  const withAliases = (r) => ({ ...r, agency_name: r.corporate_name, owner_name: r.contact_person });

  app.get('/onboarding', async (req, reply) => {
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
  app.post('/onboarding/:id/approve', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const row = await byId('onboarding_applications')(req.params.id);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (row.status !== 'SUBMITTED') return reply.code(409).send({ error: 'ALREADY_DECIDED', detail: `application is ${row.status}` });
    const { master_id, approved_by } = req.body ?? {};
    const { rows } = await query(`
      UPDATE onboarding_applications
         SET status = 'APPROVED', approved_at = now(), approved_by = $2,
             master_id = COALESCE($3::uuid, master_id)
       WHERE id = $1::uuid RETURNING *`,
      [row.id, approved_by ?? null, UUID_RE.test(String(master_id ?? '')) ? master_id : null]);
    return { application: withAliases(rows[0]) };
  });

  app.post('/onboarding/:id/reject', async (req, reply) => {
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
    return { application: withAliases(rows[0]) };
  });
}
