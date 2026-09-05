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
import { createHash } from 'node:crypto';
import { query, withTransaction, isDegraded } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';
import { drain } from '../agents/bus.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });
const money = (v) => Number(v ?? 0);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Columns typed jsonb. node-postgres encodes a JS array as a Postgres ARRAY
// literal, which jsonb refuses, so these are stringified on the way in.
const JSONB_COLS = new Set(['additional_docs', 'consignees', 'locations', 'portal_features',
  'extra_expenses', 'rate_history']);
const enc = (col, v) => (JSONB_COLS.has(col) && v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

// A generic writable-column helper. Each master declares its own allow-list so a
// client can never patch a column the screen has no business setting (balances,
// audit stamps, foreign keys it does not own).
const buildUpdate = (table, allowed, body) => {
  const cols = allowed.filter((c) => body[c] !== undefined);
  if (!cols.length) return null;
  const sets = cols.map((c, i) => `${c} = $${i + 2}`);
  return {
    sql: `UPDATE ${table} SET ${sets.join(', ')}, updated_at = now() WHERE id = $1::uuid RETURNING *`,
    args: [null, ...cols.map((c) => enc(c, body[c]))],
  };
};

// A uuid, or the Firestore document id the row was migrated from. Screens that
// have not moved yet still hold the latter; `legacy_id` is that exact string.
// Resolving by name instead would be ambiguous — `vendors` genuinely contains
// three rows called NIRMALA PETROLUM.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const findVendor = async (id, cols = '*') => {
  const { rows } = UUID_RE.test(String(id ?? ''))
    ? await query(`SELECT ${cols} FROM vendors WHERE id = $1::uuid`, [id])
    : await query(`SELECT ${cols} FROM vendors WHERE legacy_id = $1`, [id]);
  return rows[0] ?? null;
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
    'permit_doc_url', 'fastag_id', 'gps_imei', 'status', 'remarks', 'company_id',
    // migration 028 — commercial detail the fleet master maintains
    'branch', 'vehicle_category', 'plant_attached', 'contract_ref', 'contract_validity',
    'fuel_type', 'gross_weight', 'unladen_weight', 'hypothecated_to', 'vehicle_value',
    'mfg_date', 'approval_status', 'tyre_config'];

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
                -- the rule's three facts, resolved (migration 161)
                co.company_name, ol.ledger_name AS owner_ledger,
                LEAST(v.insurance_expiry, v.fitness_expiry, v.permit_expiry,
                      v.puc_expiry, v.tax_expiry, v.national_permit_expiry) AS next_expiry,
                COALESCE(t.trips, 0)::int          AS trip_count,
                COALESCE(t.last_trip, NULL)        AS last_trip_date,
                COALESCE(dc.docs, 0)::int          AS doc_count,
                COALESCE(dc.files, 0)::int         AS doc_file_count,
                a.driver_name                      AS linked_driver,
                a.driver_id                        AS linked_driver_id
           FROM vehicles v
           LEFT JOIN LATERAL (
             SELECT count(*) trips, max(loading_date) last_trip
               FROM trips WHERE vehicle_id = v.id) t ON true
           LEFT JOIN LATERAL (
             SELECT count(*) docs, count(document_url) files
               FROM vehicle_documents WHERE vehicle_id = v.id) dc ON true
           LEFT JOIN LATERAL (
             SELECT d.name AS driver_name, d.id AS driver_id
               FROM vehicle_assignments va JOIN drivers d ON d.id = va.driver_id
              WHERE va.vehicle_id = v.id AND va.released_at IS NULL
              ORDER BY va.assigned_at DESC LIMIT 1) a ON true
           LEFT JOIN companies co ON co.id = v.company_id
           LEFT JOIN ledgers ol ON ol.id = v.vehicle_owner_ledger_id
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

  // ═══ THE OWN / ATTACHED RULE CHECK (owner, 5-Sep-2026; migration 161) ════
  //
  // Every lorry whose master disagrees with itself or with its trips: OWN with
  // a person as owner, ATTACHED to its own company, attached without a rate,
  // no company, trips in another firm's books, trips with no master. Read
  // only — each row is a decision for the desk, taken on the vehicle form.
  app.get('/vehicles/rule-audit', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`
      SELECT * FROM v_vehicle_rule_audit
       ORDER BY CASE severity WHEN 'HIGH' THEN 0 ELSE 1 END, freight DESC NULLS LAST, vehicle_no, finding`);
    const by = {};
    for (const r of rows) by[r.finding] = (by[r.finding] ?? 0) + 1;
    return {
      count: rows.length,
      by_finding: by,
      rows,
      rule: {
        operating_company: 'whose BOOKS the lorry runs in',
        own: 'the operating company owns it — owner IS the company; freight and running cost are the company\'s',
        attached: 'someone else owns it — owner required and not the company; company books the running cost, keeps commission, withholds TDS, pays the owner on the 15-day bill; khata auto-linked',
        derived: 'is_company_owned follows ownership by trigger; nobody writes it',
      },
    };
  });

  // The two refusals migration 161 raises, said in the desk's words.
  const ownershipErr = (reply, err) => {
    if (err.code === 'P0413' || err.code === 'P0414') {
      return reply.code(400).send({ error: 'OWNERSHIP_RULE', detail: err.message });
    }
    return pgErr(reply, err);
  };

  app.post('/vehicles', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.vehicle_no) return reply.code(400).send({ error: 'NO_VEHICLE_NO' });
    const cols = VEHICLE_COLS.filter((c) => b[c] !== undefined);
    try {
      const { rows } = await query(
        `INSERT INTO vehicles (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *, status::text AS status`,
        cols.map((c) => enc(c, b[c])));
      reply.code(201);
      return { created: true, vehicle: rows[0] };
    } catch (err) { return ownershipErr(reply, err); }
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
    } catch (err) { return ownershipErr(reply, err); }
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

  // ═══ VEHICLE COMPLIANCE DOCUMENTS ═════════════════════════════════════════
  // Eleven statutory documents per vehicle plus custom ones. next_due_date here
  // is the source of truth; the six expiry columns on `vehicles` are a
  // denormalised cache written by this same endpoint (migration 028).
  //
  // doc_type -> the vehicles column it mirrors. Types with no column (explosive,
  // calibration, rule18, rule43, cii, home_permit) live only in this table,
  // which is fine: v_vehicle_compliance reads every type uniformly.
  const DOC_EXPIRY_COL = Object.freeze({
    fitness: 'fitness_expiry',
    insurance: 'insurance_expiry',
    pollution: 'puc_expiry',
    national_permit: 'national_permit_expiry',
    home_permit: 'permit_expiry',
    mv_tax: 'tax_expiry',
  });

  // The expense ledger a compliance fee is debited to. One head for all document
  // types, matching the account_groups entry that already exists.
  const COMPLIANCE_LEDGER = 'Vehicle Compliance & Docs';
  const COMPLIANCE_GROUP = 'Direct Expenses (Vehicle Compliance & Docs)';
  // Where an attached vehicle's costs go instead — the same head the fuel and
  // toll importers debit, so one owner's diesel, toll and paperwork all land in
  // one khata rather than three.
  const OWNER_GROUP = 'Sundry Creditors (Vehicle Owners)';

  app.get(
    '/vehicle-documents',
    { schema: { querystring: { type: 'object', properties: {
      vehicle_id: { type: ['string', 'null'], format: 'uuid' },
      state: { type: ['string', 'null'], enum: ['EXPIRED', 'EXPIRING', 'VALID', 'UNKNOWN', null] },
      due_within_days: { type: ['integer', 'null'], minimum: 1, maximum: 365 },
      limit: { type: 'integer', minimum: 1, maximum: 2000, default: 1000 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows } = await query(
        `SELECT * FROM v_vehicle_compliance
          WHERE ($1::uuid IS NULL OR vehicle_id = $1::uuid)
            AND ($2::text IS NULL OR compliance_state = $2::text)
            AND ($3::int  IS NULL OR (next_due_date IS NOT NULL
                                      AND next_due_date <= CURRENT_DATE + ($3::int || ' days')::interval))
          ORDER BY next_due_date NULLS LAST, vehicle_no, doc_type
          LIMIT $4`,
        [req.query.vehicle_id || null, req.query.state || null,
         req.query.due_within_days ?? null, req.query.limit ?? 1000]);
      return { count: rows.length, documents: rows };
    }
  );

  // Save one document. If a fee is supplied, an account MUST be named: this
  // moves real money and the screen asks the operator which bank or cash account
  // it left. Nothing is defaulted.
  //
  // The Firestore version wrote a ONE-SIDED debit straight into LEDGER_ENTRIES.
  // In PostgreSQL that table is TARA's, append-only by trigger, with a deferred
  // Dr = Cr constraint per voucher — a one-sided entry cannot exist. So the fee
  // posts as a PAYMENT voucher: Dr the compliance expense, Cr the account.
  app.post(
    '/vehicle-documents',
    { schema: { body: {
      type: 'object', required: ['vehicle_id', 'doc_type'], additionalProperties: false,
      properties: {
        vehicle_id: { type: 'string', format: 'uuid' },
        doc_type: { type: 'string', minLength: 1, maxLength: 60 },
        doc_name: { type: ['string', 'null'], maxLength: 120 },
        application_no: { type: ['string', 'null'], maxLength: 80 },
        receipt_no: { type: ['string', 'null'], maxLength: 80 },
        inspected_on: { type: ['string', 'null'], format: 'date' },
        next_due_date: { type: ['string', 'null'], format: 'date' },
        amount: { type: ['number', 'null'], minimum: 0 },
        payment_mode: { type: ['string', 'null'], maxLength: 40 },
        document_url: { type: ['string', 'null'], maxLength: 800 },
        remarks: { type: ['string', 'null'], maxLength: 300 },
        // The bank/cash ledger the fee was paid from. Required whenever amount > 0
        // and post_to_ledger is not explicitly false.
        account: { type: ['string', 'null'], maxLength: 120 },
        post_to_ledger: { type: 'boolean', default: true },
        created_by: { type: ['string', 'null'], maxLength: 100 },
      },
    } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const { rows: [v] } = await query(
        `SELECT v.id, v.vehicle_no, v.branch, v.is_company_owned,
                v.vehicle_owner_ledger_id, v.branch_id,
                l.ledger_name AS owner_ledger
           FROM vehicles v
           LEFT JOIN ledgers l ON l.id = v.vehicle_owner_ledger_id
          WHERE v.id = $1::uuid`, [b.vehicle_id]);
      if (!v) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'no such vehicle' });

      const amount = Number(b.amount ?? 0);
      const wantsPosting = amount > 0 && b.post_to_ledger !== false;
      if (wantsPosting && !b.account) {
        return reply.code(400).send({
          error: 'NO_ACCOUNT',
          detail: `a fee of ₹${amount.toFixed(2)} moves real money — name the bank or cash account it was paid from, or send post_to_ledger=false to record the document without an accounting entry`,
        });
      }

      // Deterministic reference: re-saving the same tab with the same fee and
      // receipt is refused by TARA's duplicate guard instead of double-posting.
      // This replaces the Firestore `expense_posted_key` self-check.
      const ref = `VEHDOC-${b.vehicle_id}-${b.doc_type}-${amount.toFixed(2)}-${b.receipt_no ?? b.application_no ?? 'noref'}`;

      // ── WHOSE COST IS THIS? ─────────────────────────────────────────────
      // A fitness fee on a company lorry is a company expense. The same fee on
      // an attached lorry is money spent on somebody else's asset and is
      // recoverable from him — it belongs in his khata, and putting it in the
      // P&L would inflate company costs by the whole of another operator's
      // compliance bill. TARA's assertAttachedCostIsolation is the backstop, so
      // getting this wrong now fails loudly instead of quietly.
      const attached = !v.is_company_owned;
      if (wantsPosting && attached && !v.owner_ledger) {
        return reply.code(422).send({
          error: 'ATTACHED_WITHOUT_OWNER_LEDGER',
          detail: `${v.vehicle_no} is an attached vehicle with no owner ledger, so this fee has `
                + `nowhere to go but company P&L, where it does not belong. Link the owner first, `
                + `or send post_to_ledger=false to file the document without an accounting entry`,
        });
      }
      const debit = attached
        ? { ledger: v.owner_ledger, group: OWNER_GROUP }
        : { ledger: COMPLIANCE_LEDGER, group: COMPLIANCE_GROUP };

      // ── THE FEE NO LONGER POSTS ITSELF ──────────────────────────────────
      // This route used to call postVoucher right here, so a renewal typed on
      // the vault screen hit the cashbook the instant Save was pressed — one
      // person, no second pair of eyes, on money leaving a real bank account.
      //
      // It now raises a PENDING_APPROVAL expense. Nothing reaches
      // ledger_entries until an admin approves it, and the approve action is
      // what posts the voucher (governance.routes.js). The cashbook and the P&L
      // both read ledger_entries, so an unapproved fee is invisible to both —
      // enforced by there being no entry at all, rather than by every report
      // remembering to filter one out.
      //
      // expense_approvals carries it, not owner_expenses: owner_ledger_id is NOT
      // NULL there, so a company-owned lorry's fee could not be represented at
      // all. Whose cost it is stays a DERIVED fact — the approver re-reads the
      // vehicle and applies the same attached/company rule below, so the two
      // cannot drift apart between queueing and posting.
      let voucher = null;
      let ledgerNote = null;
      let pendingExpense = null;
      if (wantsPosting) {
        // Same deterministic reference as the old TARA guard used, so re-saving
        // the same tab with the same fee converges on ONE queued expense instead
        // of handing the approver a second copy to notice and reject.
        const { rows: exp } = await query(
          `INSERT INTO expense_approvals
             (legacy_id, vehicle_no, vehicle_id, pay_account, expense_type, bill_no,
              bill_date, amount, description, source, status, entered_by,
              approval_status, submitted_by, submitted_at)
           VALUES ($1, $2, $3::uuid, $4, 'VEHICLE_COMPLIANCE', $5, $6::date, $7, $8,
                   'VEHICLE_DOC_RENEWAL', 'PENDING', $9::text,
                   'PENDING_APPROVAL', $10::uuid, now())
           ON CONFLICT (legacy_id) DO UPDATE
             SET amount = EXCLUDED.amount, description = EXCLUDED.description,
                 pay_account = EXCLUDED.pay_account, updated_at = now()
           RETURNING id, approval_status, amount, voucher_id`,
          [ref, v.vehicle_no, v.id, b.account,
           b.receipt_no ?? b.application_no ?? null,
           b.inspected_on ?? new Date().toISOString().slice(0, 10), amount,
           `${b.doc_name ?? b.doc_type} for ${v.vehicle_no}`
             + `${b.receipt_no ? ` — receipt ${b.receipt_no}` : ''}`
             + `${attached ? ' (attached — owner khata)' : ''}`,
           b.created_by ?? null, b.created_by ?? null]);
        pendingExpense = exp[0];
        ledgerNote = pendingExpense.voucher_id
          ? 'this fee is already approved and posted — the document was saved without posting it again'
          : `₹${amount.toFixed(2)} is queued for approval. It will not appear in the cashbook `
            + 'or the P&L until an admin approves it.';
      }

      const saved = await withTransaction(async (t) => {
        const { rows } = await t.query(
          `INSERT INTO vehicle_documents
             (vehicle_id, doc_type, doc_name, application_no, receipt_no, inspected_on,
              next_due_date, amount, payment_mode, document_url, remarks, voucher_id)
           VALUES ($1::uuid,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,$11,$12::uuid)
           ON CONFLICT (vehicle_id, doc_type) DO UPDATE SET
             doc_name = EXCLUDED.doc_name, application_no = EXCLUDED.application_no,
             receipt_no = EXCLUDED.receipt_no, inspected_on = EXCLUDED.inspected_on,
             next_due_date = EXCLUDED.next_due_date, amount = EXCLUDED.amount,
             payment_mode = EXCLUDED.payment_mode,
             document_url = COALESCE(EXCLUDED.document_url, vehicle_documents.document_url),
             remarks = EXCLUDED.remarks,
             voucher_id = COALESCE(EXCLUDED.voucher_id, vehicle_documents.voucher_id),
             updated_at = now()
           RETURNING *`,
          [b.vehicle_id, b.doc_type, b.doc_name ?? null, b.application_no ?? null,
           b.receipt_no ?? null, b.inspected_on ?? null, b.next_due_date ?? null,
           b.amount ?? null, b.payment_mode ?? null, b.document_url ?? null,
           b.remarks ?? null, voucher?.voucher_id ?? null]);

        // Keep the denormalised expiry column in step, in the same transaction,
        // so the cache cannot disagree with the row it is derived from.
        const col = DOC_EXPIRY_COL[b.doc_type];
        if (col && b.next_due_date) {
          await t.query(
            `UPDATE vehicles SET ${col} = $2::date, updated_at = now() WHERE id = $1::uuid`,
            [b.vehicle_id, b.next_due_date]);
        }
        return rows[0];
      });

      reply.code(201);
      return {
        saved: true, document: saved,
        voucher_id: voucher?.voucher_id ?? null,
        // The fee's fate, said plainly, so the screen can show "queued" rather
        // than implying the money moved.
        pending_expense_id: pendingExpense?.id ?? null,
        approval_status: pendingExpense?.approval_status ?? null,
        posts_to_cashbook_on_approval: !!pendingExpense && !pendingExpense.voucher_id,
        ledger_note: ledgerNote,
      };
    }
  );

  app.delete('/vehicle-documents/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows: [d] } = await query(
      'SELECT doc_type, voucher_id FROM vehicle_documents WHERE id = $1::uuid', [req.params.id]);
    if (!d) return reply.code(404).send({ error: 'NOT_FOUND' });
    // A document whose fee was posted keeps its record: deleting it would leave
    // a voucher in the ledger with nothing explaining what it paid for.
    if (d.voucher_id) {
      return reply.code(409).send({
        error: 'FEE_POSTED',
        detail: `this document's fee is posted under voucher ${d.voucher_id} — reverse that voucher in Cash & Bank Book first`,
        voucher_id: d.voucher_id,
      });
    }
    await query('DELETE FROM vehicle_documents WHERE id = $1::uuid', [req.params.id]);
    return { deleted: true, doc_type: d.doc_type };
  });

  // ═══ DRIVERS ══════════════════════════════════════════════════════════════
  const DRIVER_COLS = ['name', 'mobile', 'alt_mobile', 'address', 'profile_pic_url', 'license_no',
    'license_expiry', 'dl_photo_url', 'hzd_cert_no', 'hzd_expiry', 'hzd_photo_url', 'aadhar_no',
    'aadhar_hash', 'aadhar_last4',
    // pan_photo_url was missing from this list while the other five *_photo_url
    // columns were present, and buildUpdate drops anything not named here — so
    // a PAN card uploaded through Driver Master went into the vault, showed in
    // the open form, and was silently discarded on save. It came back as
    // "Upload PAN File" on the next load with no error anywhere, which is why
    // PAN is the document most often missing (27 of 54 drivers on 2026-09-01).
    'aadhar_photo_url', 'pan_no', 'pan_photo_url', 'bank_name', 'account_no', 'ifsc_code', 'bank_photo_url',
    'guarantor_name', 'guarantor_mobile', 'join_date', 'approval_status', 'status', 'remarks',
    'company_id', 'additional_docs'];

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
                    -- running account: cash given, shortage charged and pay handed over are debits; earnings credit (174)
                    SUM(CASE WHEN txn_type = 'SALARY_CREDIT' THEN -amount ELSE amount END) AS balance,
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

  // ── AADHAAR NEVER LANDS IN PLAINTEXT ──────────────────────────────────────
  // The KYC screens still send the full twelve digits — that is what the person
  // typing has in front of them, and asking the UI to hash it would put the one
  // security-relevant step in the least trustworthy place. It is converted here,
  // on the way in: hash for matching, last four for recognition, and a masked
  // display value. Migration 067 removed the 29 that were already stored and
  // added a CHECK that refuses twelve consecutive digits, so this is the path
  // that keeps working rather than an optional nicety.
  const maskAadhaar = (b) => {
    if (b.aadhar_no === undefined) return b;
    const digits = String(b.aadhar_no ?? '').replace(/[^0-9]/g, '');
    if (!/^[0-9]{12}$/.test(digits)) return b;   // already masked, or not a number
    return {
      ...b,
      aadhar_no: `XXXX XXXX ${digits.slice(-4)}`,
      aadhar_hash: createHash('sha256').update(digits).digest('hex'),
      aadhar_last4: digits.slice(-4),
    };
  };

  app.post('/drivers', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = maskAadhaar(req.body ?? {});
    if (!b.name) return reply.code(400).send({ error: 'NO_NAME' });
    const cols = DRIVER_COLS.filter((c) => b[c] !== undefined);
    try {
      const { rows } = await query(
        `INSERT INTO drivers (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *, status::text AS status, approval_status::text AS approval_status`,
        cols.map((c) => enc(c, b[c])));
      reply.code(201);
      return { created: true, driver: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.patch('/drivers/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const u = buildUpdate('drivers', DRIVER_COLS, maskAadhaar(req.body ?? {}));
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

  // Every driver transaction, across all drivers — the "All Transactions" register.
  // Source-tagged like the per-driver khata so an operator can see at a glance
  // which entries came from a trip and which were typed here.
  app.get(
    '/driver-transactions',
    { schema: { querystring: { type: 'object', properties: {
      driver_name: { type: ['string', 'null'], maxLength: 120 },
      txn_type: { type: ['string', 'null'], maxLength: 30 },
      from: { type: ['string', 'null'], format: 'date' },
      to: { type: ['string', 'null'], format: 'date' },
      limit: { type: 'integer', minimum: 1, maximum: 2000, default: 500 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows } = await query(
        `SELECT dt.id, dt.driver_id, dt.driver_name, dt.txn_date, dt.txn_type, dt.amount,
                dt.mode, dt.remarks, dt.trip_id, t.trip_code, dt.created_at,
                CASE WHEN dt.legacy_id LIKE 'BILLREC-%'   THEN 'bill settlement'
                     WHEN dt.legacy_id LIKE 'UNLOADREC-%' THEN 'unloading shortage'
                     WHEN dt.trip_id IS NOT NULL          THEN 'trip'
                     ELSE 'manual' END AS source
           FROM driver_transactions dt
           LEFT JOIN trips t ON t.id = dt.trip_id
          WHERE ($1::text IS NULL OR dt.driver_name = $1::text)
            AND ($2::text IS NULL OR dt.txn_type = $2::text)
            AND ($3::date IS NULL OR dt.txn_date >= $3::date)
            AND ($4::date IS NULL OR dt.txn_date <= $4::date)
          ORDER BY dt.txn_date DESC NULLS LAST, dt.created_at DESC
          LIMIT $5`,
        [req.query.driver_name || null, req.query.txn_type || null,
         req.query.from || null, req.query.to || null, req.query.limit ?? 500]);
      return { count: rows.length, transactions: rows };
    }
  );

  // ── Driver app request queue ───────────────────────────────────────────────
  app.get(
    '/driver-requests',
    { schema: { querystring: { type: 'object', properties: {
      status: { type: ['string', 'null'], enum: ['PENDING', 'APPROVED', 'PAID', 'REJECTED', 'OPEN', null] },
      driver_name: { type: ['string', 'null'], maxLength: 120 },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows } = await query(
        `SELECT r.*, t.trip_code
           FROM driver_requests r LEFT JOIN trips t ON t.id = r.trip_id
          -- 'OPEN' is the queue the screen actually wants: approved-but-unpaid
          -- is still outstanding work, so it lists with the pending ones.
          WHERE ($1::text IS NULL
                 OR ($1::text = 'OPEN' AND r.status IN ('PENDING','APPROVED'))
                 OR r.status = $1::text)
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
      // Payable from PENDING (pay directly) or APPROVED (someone signed it off
      // first). Already PAID or REJECTED is refused — that is the double-pay guard.
      if (r.status !== 'PENDING' && r.status !== 'APPROVED') {
        return reply.code(409).send({ error: 'NOT_PAYABLE', detail: `this request is already ${r.status}` });
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
            WHERE id = $1::uuid AND status IN ('PENDING','APPROVED') RETURNING *`,
          [req.params.id, b.payment_mode ?? 'Office Cash', txn.id, b.settled_by ?? null]);
        return { request: req2, transaction: txn };
      });
      return { paid: true, ...out };
    }
  );

  app.patch(
    '/driver-requests/:id',
    { schema: { body: { type: 'object', required: ['status'], additionalProperties: false, properties: {
      status: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
      remarks: { type: ['string', 'null'], maxLength: 300 },
      by: { type: ['string', 'null'], maxLength: 100 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      // Approve or reject only. Paying goes through /pay, which is the sole path
      // that may create a khata entry — keeping the money-writing route separate
      // is what makes the approval a real separation of duties rather than a flag.
      const b = req.body;
      const sql = b.status === 'APPROVED'
        ? `UPDATE driver_requests SET status = 'APPROVED', remarks = COALESCE($2, remarks),
                  approved_at = now(), approved_by = $3
            WHERE id = $1::uuid AND status = 'PENDING' RETURNING *`
        : `UPDATE driver_requests SET status = 'REJECTED', remarks = COALESCE($2, remarks),
                  settled_at = now(), settled_by = $3
            WHERE id = $1::uuid AND status IN ('PENDING','APPROVED') RETURNING *`;
      const { rows } = await query(sql, [req.params.id, b.remarks ?? null, b.by ?? null]);
      if (!rows.length) {
        return reply.code(409).send({
          error: 'NOT_OPEN',
          detail: b.status === 'APPROVED' ? 'no PENDING request with that id' : 'no open request with that id',
        });
      }
      return { [b.status === 'APPROVED' ? 'approved' : 'rejected']: true, request: rows[0] };
    }
  );

  // ═══ VEHICLE ↔ DRIVER ASSIGNMENTS ═════════════════════════════════════════
  app.get('/assignments', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT a.id, a.vehicle_id, a.driver_id, a.assigned_at, a.released_at, a.state::text AS state, a.remarks,
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
            `UPDATE vehicle_assignments SET released_at = now(), state = 'ENDED', updated_at = now()
              WHERE released_at IS NULL AND (vehicle_id = $1::uuid OR driver_id = $2::uuid)`,
            [b.vehicle_id, b.driver_id]);
          const { rows } = await t.query(
            `INSERT INTO vehicle_assignments (vehicle_id, driver_id, assigned_at, state, remarks)
             VALUES ($1::uuid, $2::uuid, now(), 'ACTIVE', $3) RETURNING *, state::text AS state`,
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
      `UPDATE vehicle_assignments SET released_at = now(), state = 'ENDED', updated_at = now()
        WHERE id = $1::uuid AND released_at IS NULL RETURNING *, state::text AS state`, [req.params.id]);
    if (!rows.length) return reply.code(409).send({ error: 'NOT_LINKED', detail: 'no live assignment with that id' });
    return { released: true, assignment: rows[0] };
  });

  // ═══ CUSTOMERS ════════════════════════════════════════════════════════════
  const CUSTOMER_COLS = ['customer_code', 'customer_name', 'address', 'state', 'pincode', 'gst_no',
    'pan_no', 'contact_person', 'mobile_no', 'email', 'payment_terms', 'opening_balance',
    'consignees', 'locations', 'portal_features', 'status', 'customer_source', 'approval_status',
    'portal_enabled', 'portal_email',
    // migration 029 — contract terms the CRM screen collects
    'credit_limit', 'account_manager', 'billing_cycle', 'detention_applicable', 'city',
    // migration 134 — the bank account the KYC application carried. Staff-only:
    // a CUSTOMER session cannot reach /masters at all (apiGuard confines
    // external roles to /portal/*), and from the app a change to these three is
    // a bank_change_requests row the office approves, never an edit.
    'bank_name', 'account_no', 'ifsc_code'];

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
        cols.map((c) => enc(c, b[c])));
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

  // ── The customer khata ─────────────────────────────────────────────────────────────
  // Same defect the driver khata had, one party over. CustomerLedger.tsx read
  // MONTHLY_INVOICES and CUSTOMER_PAYMENTS from Firestore while COMPANY_BILLS
  // and BANK_TRANSACTIONS had already moved to PostgreSQL, so a bill raised in
  // Bill Management and the receipt that settled it were invisible to the
  // statement the customer actually gets shown.
  //
  // Two sources, deliberately kept distinct rather than merged in SQL:
  //
  //   company_bills      what we invoiced. Raising a bill posts NO voucher, so
  //                      these are not in the ledger and cannot double-count.
  //   ledger_entries     every posting against `Debtors: <name>` - the receipts
  //                      that settled those bills, direct trip settlements, and
  //                      reversals. Read straight from the GL, so a correction
  //                      shows up here the moment it is posted.
  //
  // NOTE ON SIGN. This screen's columns are the owner's, not an accountant's:
  // its CREDIT column means "billed / lena baki" and its DEBIT column means
  // "paisa aaya". That is the exact inverse of the debtor account's own Dr/Cr,
  // so a GL row is flipped on the way out and the flip is done HERE, once,
  // instead of in the component. `gl_dr_cr` carries the unflipped truth.
  app.get(
    '/customers/:id/ledger',
    { schema: { querystring: { type: 'object', properties: {
      from: { type: ['string', 'null'], format: 'date' },
      to: { type: ['string', 'null'], format: 'date' },
      company: { type: ['string', 'null'], maxLength: 120 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows: [c] } = await query(
        `SELECT id, customer_name, opening_balance, billing_cycle, credit_limit
           FROM customers WHERE id = $1::uuid`, [req.params.id]);
      if (!c) return reply.code(404).send({ error: 'NOT_FOUND' });

      const company = req.query.company && req.query.company !== 'ALL' ? req.query.company : null;
      const [bills, gl, allCompanies] = await Promise.all([
        query(
          `SELECT id, bill_no, bill_date, company, branch, location, period_from, period_to,
                  total_gross, total_shortage, total_tds, total_net, received_amount, status,
                  (SELECT count(*) FROM company_bill_trips t WHERE t.bill_id = company_bills.id)::int AS trip_count
             FROM company_bills
            WHERE (customer_id = $1::uuid OR lower(customer_name) = lower($2))
              AND status <> 'CANCELLED'
              -- ⚠️ UNPOSTED BILLS ONLY (migration 034). A bill that carries a
              -- SALES journal is already in the ledger rows below as a Dr on
              -- the debtor; counting the bill row as well would show every
              -- billed rupee twice. An unposted bill is not in the ledger at
              -- all, so it still has to come from here.
              AND voucher_id IS NULL
              AND ($3::text IS NULL OR company = $3)
            ORDER BY bill_date, bill_no`,
          [c.id, c.customer_name, company]),
        query(
          `SELECT id, entry_date, dr_cr, amount, particulars, source_type, source_ref,
                  company, branch, voucher_id
             FROM ledger_entries
            WHERE lower(ledger_name) = lower($1)
              AND ($2::text IS NULL OR company = $2)
            ORDER BY entry_date, id`,
          [`Debtors: ${c.customer_name}`, company]),
        query(
          `SELECT DISTINCT company FROM (
             SELECT company FROM company_bills
              WHERE (customer_id = $1::uuid OR lower(customer_name) = lower($2)) AND status <> 'CANCELLED'
              UNION ALL
             SELECT company FROM ledger_entries WHERE lower(ledger_name) = lower($3)
           ) x WHERE company IS NOT NULL ORDER BY company`,
          [c.id, c.customer_name, `Debtors: ${c.customer_name}`]),
      ]);

      const rows = [];
      for (const b of bills.rows) {
        rows.push({
          kind: 'BILL', ref_id: b.id, date: b.bill_date, company: b.company,
          particulars: `Bill ${b.bill_no} (${b.trip_count} trip(s)${b.location ? ` \u00b7 ${b.location}` : ''})`
            + (b.status === 'SETTLED' ? ' settled' : b.status === 'PARTIALLY_PAID' ? ' \u00b7 partial' : ''),
          dr: 0, cr: money(b.total_net), status: b.status, gl_dr_cr: null,
        });
      }
      for (const e of gl.rows) {
        // Cr on a debtor = money in, which is this screen's DEBIT column.
        const received = e.dr_cr === 'CR';
        // A Dr on the debtor is a CHARGE, not a receipt. Since 034 the most
        // common one is a raised bill's revenue journal — labelling that
        // 'RECEIPT' put a money-in icon on an invoice line.
        const kind = e.source_type === 'REVERSAL' ? 'REVERSAL'
          : e.source_type === 'BILL_RAISED' ? 'BILL'
          : received ? 'RECEIPT' : 'CHARGE';
        rows.push({
          kind,
          ref_id: String(e.id), date: e.entry_date, company: e.company,
          particulars: e.particulars ?? (received ? 'Receipt' : 'Charge'),
          dr: received ? money(e.amount) : 0,
          cr: received ? 0 : money(e.amount),
          status: null, gl_dr_cr: e.dr_cr,
        });
      }
      rows.sort((a, x) => String(a.date).localeCompare(String(x.date)) || (x.cr - a.cr));

      // Anything before `from` collapses into the opening figure rather than
      // being dropped - a statement that silently omits history is worse than
      // no statement. The customer's own opening_balance seeds it.
      const from = req.query.from || null;
      const to = req.query.to || null;
      let opening = money(c.opening_balance);
      const inRange = rows.filter((r) => {
        const d = String(r.date ?? '');
        if (from && d && d < from) { opening = round2(opening + r.cr - r.dr); return false; }
        if (to && d && d > to) return false;
        return true;
      });
      let bal = opening;
      const withBal = inRange.map((r) => { bal = round2(bal + r.cr - r.dr); return { ...r, balance: bal }; });

      return {
        customer: c,
        opening: round2(opening),
        rows: withBal,
        billed: round2(inRange.reduce((a, r) => a + r.cr, 0)),
        received: round2(inRange.reduce((a, r) => a + r.dr, 0)),
        outstanding: round2(bal),
        // Computed unfiltered on purpose: the dropdown has to keep offering the
        // other companies after one is picked, or the filter becomes one-way.
        companies: allCompanies.rows.map((r) => r.company),
      };
    }
  );

  // ── A customer receipt is a RECEIPT voucher, full stop ──────────────────────────
  // Migration 026 refused a CUSTOMER_PAYMENTS table and 029 refused it again:
  // the Firestore screen wrote its own payment document AND a journal, which is
  // two records of one rupee and exactly how BANK_TRANSACTIONS came to disagree
  // with the ledger. Here the voucher IS the record. There is nothing else to
  // keep in step, so nothing can fall out of step.
  app.post(
    '/customers/:id/receipt',
    { schema: { body: { type: 'object', required: ['account', 'amount'], additionalProperties: false, properties: {
      account: { type: 'string', minLength: 1, maxLength: 120 },
      amount: { type: 'number', exclusiveMinimum: 0 },
      entry_date: { type: ['string', 'null'], format: 'date' },
      ref_no: { type: ['string', 'null'], maxLength: 60 },
      company: { type: ['string', 'null'], maxLength: 120 },
      branch: { type: ['string', 'null'], maxLength: 120 },
      company_id: { type: ['string', 'null'], format: 'uuid' },
      branch_id: { type: ['string', 'null'], format: 'uuid' },
      remarks: { type: ['string', 'null'], maxLength: 300 },
      created_by: { type: ['string', 'null'], maxLength: 100 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const { rows: [c] } = await query(
        'SELECT id, customer_name FROM customers WHERE id = $1::uuid', [req.params.id]);
      if (!c) return reply.code(404).send({ error: 'NOT_FOUND' });
      try {
        const voucher = await postVoucher({
          type: 'RECEIPT',
          account: b.account,
          party_ledger: `Debtors: ${c.customer_name}`,
          party_group: 'Sundry Debtors (Customers)',
          amount: b.amount,
          ref_no: b.ref_no || null,
          entry_date: b.entry_date ?? new Date().toISOString().slice(0, 10),
          narration: `Receipt from ${c.customer_name}${b.remarks ? ` - ${b.remarks}` : ''}`,
          source_type: 'CUSTOMER_RECEIPT',
          company: b.company ?? null,
          branch: b.branch ?? null,
          company_id: b.company_id ?? null,
          branch_id: b.branch_id ?? null,
          created_by: b.created_by ?? null,
        });
        await drain().catch(() => {});
        reply.code(201);
        return { posted: true, voucher_id: voucher.voucher_id, customer_name: c.customer_name };
      } catch (err) {
        const map = { DUPLICATE_REF: 409, OVERDRAFT: 422, NO_ACCOUNT: 400, NO_PARTY: 400, BAD_AMOUNT: 400 };
        if (map[err.code]) return reply.code(map[err.code]).send({ error: err.code, detail: err.message, balance: err.balance });
        throw err;
      }
    }
  );

  // ═══ VENDORS ══════════════════════════════════════════════════════════════
  // The fleet-partner columns (migration 044) are writable here too: Market
  // Vehicles edits agencies through this same endpoint rather than keeping the
  // second vendor store it used to have in Firestore.
  const VENDOR_COLS = ['vendor_name', 'vendor_type', 'contact_person', 'mobile_no', 'address',
    'gst_no', 'bank_account', 'ifsc_code', 'opening_balance', 'status',
    'owner_name', 'email', 'pan_no', 'payment_terms', 'portal_access',
    'subscription_plan', 'max_vehicle_limit', 'portal_features',
    // migration 162 — who the fleet partner is for TDS 194C
    'entity_type', 'tds_declaration_194c'];

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
                -- opening_balance IS the carry-forward (029): for migrated
                -- vendors it was lifted from the frozen current_balance, so this
                -- sum is the whole history, not just the PostgreSQL-era part.
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
    // The balance shown on the Vendor Master is derived — opening_balance plus
    // the vendor_txns since. Migration 029 made opening_balance the carry-forward
    // anchor for every migrated vendor; a vendor created here has to satisfy the
    // same invariant, so current_balance starts equal to it rather than at 0.
    const seeded = cols.includes('opening_balance') ? [...cols, 'current_balance'] : cols;
    const vals = seeded.map((c) => enc(c, c === 'current_balance' ? b.opening_balance : b[c]));
    try {
      const { rows } = await query(
        `INSERT INTO vendors (${seeded.join(', ')}) VALUES (${seeded.map((_, i) => `$${i + 1}`).join(', ')})
         RETURNING *, gst_no::text AS gst_no`, vals);
      reply.code(201);
      return { created: true, vendor: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.patch('/vendors/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const u = buildUpdate('vendors', VENDOR_COLS, req.body ?? {});
    if (!u) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    const existing = await findVendor(req.params.id, 'id');
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' });
    u.args[0] = existing.id;
    try {
      const { rows } = await query(u.sql, u.args);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { updated: true, vendor: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.get('/vendors/:id/ledger', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const v = await findVendor(req.params.id, 'id, vendor_name, opening_balance');
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
      company_id: { type: ['string', 'null'], format: 'uuid' },
      branch_id: { type: ['string', 'null'], format: 'uuid' },
      remarks: { type: ['string', 'null'], maxLength: 300 },
      created_by: { type: ['string', 'null'], maxLength: 100 },
      post_to_ledger: { type: 'boolean', default: true },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const v = await findVendor(req.params.id, 'id, vendor_name, vendor_type');
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
            company_id: b.company_id ?? null,
            branch_id: b.branch_id ?? null,
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
    'fixed_cash_amt', 'toll_amt', 'status',
    // migration 029 — the billing formula and its quarterly rate windows
    'billing_type', 'rate_history'];

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
        cols.map((c) => enc(c, b[c])));
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
  const RATE_COLS = ['customer_name', 'route', 'rate_type', 'rate', 'unit', 'valid_from', 'valid_to', 'status',
    // migration 029 — a rule is keyed on customer + source + destination, which
    // is what freightEngine.resolveTripBilling() matches on. `route` stays for
    // the derived IOCL card rows, which name a ship-to rather than a lane.
    'source', 'destination', 'calc_type', 'rtkm_distance'];

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
        cols.map((c) => enc(c, b[c])));
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
