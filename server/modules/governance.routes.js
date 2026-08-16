// ═══════════════════════════════════════════════════════════════════════════
// governance.routes.js — MDM, maker-checker and provisional accrual
//
// THE APPROVE ACTION IS THE ONLY PLACE MONEY MOVES. Everything else here reads,
// queues or estimates. That is deliberate: a maker-checker workflow whose
// approve step is one of several ways to post is not a control, it is a
// suggestion. Approval does three things in ONE transaction — flip the status,
// lock the row, and write the audit line — so a crash cannot leave a row
// approved but unlocked, or locked with no record of who did it.
//
// POSTING TO THE LEDGER STILL GOES THROUGH TARA. Nothing in this file INSERTs
// into ledger_entries. Where an approval implies a posting, the route calls
// tara.postVoucher, which is the single writer and the only thing that keeps
// SigmaDr = SigmaCr enforceable. See CLAUDE.md: "TARA owns money."
// ═══════════════════════════════════════════════════════════════════════════
import { query, withTransaction, isDegraded } from '../db/pool.js';
import { requireAdminRole } from './auth.routes.js';
import { postVoucher } from '../agents/tara.js';

// The compliance ledgers, spelled exactly as masters.routes.js spells them.
// A compliance fee on a COMPANY lorry is a company expense; the same fee on an
// ATTACHED lorry is money spent on somebody else's asset and belongs in his
// khata — putting it in the P&L would inflate company costs by the whole of
// another operator's compliance bill.
const COMPLIANCE_LEDGER = 'Vehicle Compliance & Docs';
const COMPLIANCE_GROUP = 'Direct Expenses (Vehicle Compliance & Docs)';
const OWNER_GROUP = 'Sundry Creditors (Vehicle Owners)';

/** Post the money an approval implies, if it implies any.
 *
 *  Runs AFTER the reviewer's edits and BEFORE the lock, so the voucher carries
 *  the values that were actually approved. Returns the voucher id to be written
 *  in the same UPDATE that locks the row — a locked row cannot be updated
 *  afterwards, so the voucher reference has to travel with the lock or it can
 *  never be recorded at all.
 *
 *  TARA is the only writer. This function calls postVoucher and never touches
 *  ledger_entries itself. */
async function postOnApproval(table, row) {
  if (table !== 'expense_approvals') return { voucher_id: null, note: null };
  if (row.voucher_id) return { voucher_id: row.voucher_id, note: 'already posted' };
  if (!(Number(row.amount) > 0)) return { voucher_id: null, note: 'nil amount — nothing to post' };
  if (!row.pay_account) {
    const e = new Error('this expense has no pay_account recorded, so there is no account to pay it from');
    e.statusCode = 422; e.code = 'NO_ACCOUNT';
    throw e;
  }

  // Re-derive whose cost it is rather than trusting what was stored at queue
  // time: ownership can change between raising a fee and approving it, and the
  // posting must follow the vehicle as it is NOW.
  let debit = { ledger: COMPLIANCE_LEDGER, group: COMPLIANCE_GROUP };
  let vehicleId = row.vehicle_id ?? null;
  let branch = null;
  if (vehicleId || row.vehicle_no) {
    const { rows: v } = await query(
      `SELECT v.id, v.vehicle_no, v.branch, v.is_company_owned, l.ledger_name AS owner_ledger
         FROM vehicles v LEFT JOIN ledgers l ON l.id = v.vehicle_owner_ledger_id
        WHERE ($1::uuid IS NOT NULL AND v.id = $1::uuid) OR v.vehicle_no = $2
        LIMIT 1`, [vehicleId, row.vehicle_no ?? '']);
    if (v[0]) {
      vehicleId = v[0].id; branch = v[0].branch;
      if (!v[0].is_company_owned) {
        if (!v[0].owner_ledger) {
          const e = new Error(
            `${v[0].vehicle_no} is attached but has no owner ledger, so this fee has nowhere `
            + 'to go but company P&L, where it does not belong. Link the owner first.');
          e.statusCode = 422; e.code = 'ATTACHED_WITHOUT_OWNER_LEDGER';
          throw e;
        }
        debit = { ledger: v[0].owner_ledger, group: OWNER_GROUP };
      }
    }
  }

  try {
    const j = await postVoucher({
      type: 'PAYMENT',
      account: row.pay_account,
      party_ledger: debit.ledger,
      party_group: debit.group,
      amount: Number(row.amount),
      ref_no: row.legacy_id ?? `EXPAPP-${row.id}`,
      entry_date: (row.bill_date ?? new Date()).toString().slice(0, 10),
      narration: row.description ?? `${row.expense_type} — approved expense`,
      source_type: 'VEHICLE_COMPLIANCE',
      vehicle_id: vehicleId,
      branch,
    });
    return { voucher_id: j.voucher_id, note: null };
  } catch (err) {
    // A replay is convergence, not a failure: the money is already in the books.
    if (err.code === 'DUPLICATE_REF') {
      return { voucher_id: null, note: 'this exact fee was already posted; approved without posting again' };
    }
    throw err;
  }
}

const dbGate = (reply) =>
  reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });

// Only these may be approved through the generic endpoint. An allow-list, not a
// parameterised table name: `/approvals/:table/...` with the value interpolated
// into SQL would be an injection hole wearing a REST costume.
const APPROVABLE = new Set([
  'fuel_entries', 'company_bills', 'trip_settlements', 'owner_expenses',
  'driver_settlements', 'toll_claims', 'tds_entries', 'vendor_txns',
  'driver_transactions', 'trips', 'expense_approvals', 'emi_payments',
  'toll_transactions', 'fuel_import_review',
]);

/** Columns each table calls its money and its subject, for the audit line. */
const SHAPE = {
  fuel_entries:       { amount: 'amount',        subject: 'vehicle_no' },
  company_bills:      { amount: 'total_gross',   subject: 'bill_no' },
  owner_expenses:     { amount: 'amount',        subject: 'kind' },
  trips:              { amount: 'billed_amount', subject: 'trip_code' },
  toll_claims:        { amount: 'amount',        subject: 'id' },
  tds_entries:        { amount: 'amount',        subject: 'id' },
  vendor_txns:        { amount: 'amount',        subject: 'id' },
  driver_transactions:{ amount: 'amount',        subject: 'driver_name' },
  emi_payments:       { amount: 'amount',        subject: 'id' },
  toll_transactions:  { amount: 'amount',        subject: 'vehicle_no' },
  fuel_import_review: { amount: 'amount',        subject: 'pump' },
  trip_settlements:   { amount: null,            subject: 'id' },
  driver_settlements: { amount: null,            subject: 'id' },
  expense_approvals:  { amount: 'amount',        subject: 'id' },
};

const shapeOf = (t) => SHAPE[t] ?? { amount: null, subject: 'id' };

export function registerGovernanceRoutes(app) {
  // ═══════════════════════════════════════════════════════════════════════
  // 1. MASTER DATA MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════

  app.get('/mdm/entities', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { type, q, limit } = req.query ?? {};
    const { rows } = await query(`
      SELECT e.id, e.entity_code, e.entity_type, e.display_name,
             e.mobile, e.pan, e.gstin, e.aadhaar_last4, e.status,
             l.id AS ledger_id, l.ledger_name
        FROM entity_master e
        LEFT JOIN ledgers l ON l.entity_id = e.id
       WHERE ($1::text IS NULL OR e.entity_type = $1::text)
         AND ($2::text IS NULL OR e.display_name ILIKE '%' || $2::text || '%'
                               OR e.entity_code ILIKE '%' || $2::text || '%'
                               OR e.mobile LIKE '%' || $2::text || '%')
       ORDER BY e.entity_code
       LIMIT LEAST(COALESCE($3::int, 200), 500)`,
      [type ?? null, q ?? null, limit ?? null]);
    return { count: rows.length, rows };
  });

  // Creating a party is where duplicate-blocking is felt. The DB raises 23505
  // on a collision; translating it into a message that NAMES the existing
  // holder is the difference between a control and an obstacle.
  app.post('/mdm/entities', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.entity_type || !b.display_name) {
      return reply.code(400).send({ error: 'BAD_REQUEST', detail: 'entity_type and display_name are required' });
    }
    try {
      const { rows } = await query(`
        INSERT INTO entity_master (entity_type, display_name, mobile, pan, gstin,
                                   aadhaar_hash, aadhaar_last4, notes)
        VALUES ($1, btrim($2), mdm_norm_mobile($3), mdm_norm_id($4), mdm_norm_id($5),
                CASE WHEN mdm_norm_id($6) ~ '^[0-9]{12}$'
                     THEN encode(digest(mdm_norm_id($6), 'sha256'), 'hex') END,
                CASE WHEN mdm_norm_id($6) ~ '^[0-9]{12}$'
                     THEN right(mdm_norm_id($6), 4) END,
                $7)
        RETURNING id, entity_code, entity_type, display_name, mobile, pan, gstin, aadhaar_last4`,
        [b.entity_type, b.display_name, b.mobile ?? null, b.pan ?? null,
         b.gstin ?? null, b.aadhaar ?? null, b.notes ?? null]);
      return reply.code(201).send(rows[0]);
    } catch (e) {
      if (e.code === '23505') {
        const field = /mobile/.test(e.constraint ?? '') ? 'mobile'
          : /pan/.test(e.constraint ?? '') ? 'pan'
          : /gstin/.test(e.constraint ?? '') ? 'gstin'
          : /aadhaar/.test(e.constraint ?? '') ? 'aadhaar' : 'identifier';
        const val = { mobile: b.mobile, pan: b.pan, gstin: b.gstin, aadhaar: b.aadhaar }[field];
        const { rows: held } = await query(`
          SELECT entity_code, display_name, entity_type FROM entity_master
           WHERE (CASE $1::text
                    WHEN 'mobile' THEN mdm_norm_mobile(mobile) = mdm_norm_mobile($2)
                    WHEN 'pan'    THEN mdm_norm_id(pan)   = mdm_norm_id($2)
                    WHEN 'gstin'  THEN mdm_norm_id(gstin) = mdm_norm_id($2)
                    WHEN 'aadhaar' THEN aadhaar_hash = encode(digest(mdm_norm_id($2),'sha256'),'hex')
                    ELSE false END)
             AND status <> 'MERGED' LIMIT 1`, [field, val ?? '']);
        return reply.code(409).send({
          error: 'DUPLICATE_IDENTIFIER', field,
          detail: held[0]
            ? `${field} already belongs to ${held[0].entity_code} (${held[0].display_name}, ${held[0].entity_type}). ` +
              'Link to that party or correct the value — do not create a second account for it.'
            : `${field} is already registered to another party.`,
          existing: held[0] ?? null,
        });
      }
      if (e.code === '23514') {
        return reply.code(400).send({
          error: 'INVALID_IDENTIFIER',
          detail: 'A value failed its format check. PAN is AAAAA9999A, GSTIN is 15 characters, ' +
                  'and a PAN supplied alongside a GSTIN must match the PAN inside it.',
        });
      }
      throw e;
    }
  });

  // The worklist the backfill produced instead of guessing.
  app.get('/mdm/conflicts', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`
      SELECT c.id, c.source_table, c.source_id, c.field, c.raw_value, c.reason,
             c.created_at, h.entity_code AS held_by_code, h.display_name AS held_by_name
        FROM entity_identifier_conflicts c
        LEFT JOIN entity_master h ON h.id = c.held_by
       WHERE NOT c.resolved
       ORDER BY c.source_table, c.field, c.created_at`);
    return { count: rows.length, rows };
  });

  // Merging is a human decision recorded, not a heuristic. The survivor keeps
  // the identifiers; the absorbed row is marked MERGED, which drops it out of
  // every unique index so the survivor can hold what it was blocking.
  app.post('/mdm/entities/:id/merge', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const into = req.body?.into_entity_id;
    if (!into) return reply.code(400).send({ error: 'BAD_REQUEST', detail: 'into_entity_id is required' });
    if (into === req.params.id) {
      return reply.code(400).send({ error: 'BAD_REQUEST', detail: 'an entity cannot merge into itself' });
    }
    return withTransaction(async (t) => {
      const { rows: src } = await t.query(
        `SELECT id, entity_code, display_name, status FROM entity_master WHERE id = $1::uuid FOR UPDATE`,
        [req.params.id]);
      if (!src[0]) return reply.code(404).send({ error: 'NOT_FOUND' });
      if (src[0].status === 'MERGED') {
        return reply.code(409).send({ error: 'ALREADY_MERGED', detail: `${src[0].entity_code} is already merged` });
      }
      const { rows: dst } = await t.query(
        `SELECT id, entity_code FROM entity_master WHERE id = $1::uuid`, [into]);
      if (!dst[0]) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'target entity does not exist' });

      await t.query(`UPDATE entity_links SET entity_id = $1::uuid WHERE entity_id = $2::uuid`,
        [into, req.params.id]);
      await t.query(
        `UPDATE entity_master SET status = 'MERGED', merged_into = $1::uuid WHERE id = $2::uuid`,
        [into, req.params.id]);
      await t.query(
        `UPDATE entity_identifier_conflicts SET resolved = true
          WHERE source_id = $1 OR entity_id = $2::uuid`, [req.params.id, req.params.id]);
      await t.query(
        `INSERT INTO approval_audit (source_table, source_id, from_status, to_status, actor_id, actor_name, reason)
         VALUES ('entity_master', $1::uuid, 'ACTIVE', 'MERGED', $2::uuid, $3, $4)`,
        [req.params.id, req.user.sub, req.user.name ?? req.user.email ?? null,
         `merged into ${dst[0].entity_code}`]);
      return { merged: src[0].entity_code, into: dst[0].entity_code };
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. MAKER-CHECKER
  // ═══════════════════════════════════════════════════════════════════════

  app.get('/approvals/pending', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`
      SELECT source_table, source_id, approval_status, amount, subject, detail,
             submitted_at, created_at
        FROM v_approval_queue
       ORDER BY COALESCE(submitted_at, created_at) ASC
       LIMIT 500`);
    const { rows: tot } = await query(
      `SELECT count(*)::int n, COALESCE(sum(amount),0)::numeric(16,2) amount FROM v_approval_queue`);
    return { count: rows.length, total: tot[0], rows };
  });

  app.post('/approvals/:table/:id/submit', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { table, id } = req.params;
    if (!APPROVABLE.has(table)) {
      return reply.code(400).send({ error: 'NOT_APPROVABLE', detail: `${table} is not under maker-checker` });
    }
    const s = shapeOf(table);
    return withTransaction(async (t) => {
      const { rows } = await t.query(
        `UPDATE ${table}
            SET approval_status = 'PENDING_APPROVAL',
                submitted_by = $2::uuid, submitted_at = now()
          WHERE id = $1::uuid AND approval_status IN ('DRAFT','REJECTED')
          RETURNING id, approval_status${s.amount ? `, ${s.amount} AS amt` : ''}`,
        [id, req.user?.sub ?? null]);
      if (!rows[0]) {
        return reply.code(409).send({
          error: 'NOT_SUBMITTABLE',
          detail: 'row is missing, already pending, or already approved and locked',
        });
      }
      await t.query(
        `INSERT INTO approval_audit (source_table, source_id, from_status, to_status, actor_id, actor_name, amount)
         VALUES ($1, $2::uuid, 'DRAFT', 'PENDING_APPROVAL', $3::uuid, $4, $5)`,
        [table, id, req.user?.sub ?? null, req.user?.name ?? req.user?.email ?? null,
         rows[0].amt ?? null]);
      return rows[0];
    });
  });

  // THE APPROVE ACTION. Status, lock and audit in one transaction.
  //
  // `edits` lets the admin correct the row while approving — the requirement is
  // that they review the OCR and fix it if necessary, and forcing a separate
  // edit-then-approve round trip would mean the reviewed values and the
  // approved values are two different writes with a gap between them.
  app.post('/approvals/:table/:id/approve', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { table, id } = req.params;
    if (!APPROVABLE.has(table)) {
      return reply.code(400).send({ error: 'NOT_APPROVABLE', detail: `${table} is not under maker-checker` });
    }
    const edits = req.body?.edits ?? null;
    const s = shapeOf(table);

    return withTransaction(async (t) => {
      const { rows: before } = await t.query(
        `SELECT * FROM ${table} WHERE id = $1::uuid FOR UPDATE`, [id]);
      if (!before[0]) return reply.code(404).send({ error: 'NOT_FOUND' });
      if (before[0].is_locked) {
        return reply.code(409).send({
          error: 'ALREADY_LOCKED',
          detail: `approved and locked at ${before[0].approved_at}. Post a reversing entry to change it.`,
        });
      }

      // Apply the reviewer's corrections first, in the same transaction, so the
      // values that get locked are the values that were actually reviewed.
      let applied = null;
      if (edits && typeof edits === 'object' && Object.keys(edits).length) {
        const { rows: cols } = await t.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema='public' AND table_name=$1`, [table]);
        const allowed = new Set(cols.map((c) => c.column_name));
        // Never editable through this door: the workflow's own bookkeeping.
        for (const k of ['id', 'approval_status', 'is_locked', 'approved_by', 'approved_at',
                         'submitted_by', 'submitted_at', 'rejected_by', 'rejected_at', 'created_at']) {
          allowed.delete(k);
        }
        const keys = Object.keys(edits).filter((k) => allowed.has(k));
        const bad = Object.keys(edits).filter((k) => !allowed.has(k));
        if (bad.length) {
          return reply.code(400).send({
            error: 'UNKNOWN_FIELD',
            detail: `not editable on ${table}: ${bad.join(', ')}`,
          });
        }
        if (keys.length) {
          const sets = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
          await t.query(`UPDATE ${table} SET ${sets} WHERE id = $1::uuid`,
            [id, ...keys.map((k) => edits[k])]);
          applied = Object.fromEntries(keys.map((k) => [k, { from: before[0][k], to: edits[k] }]));
        }
      }

      // Post the money this approval implies, then carry the voucher id into
      // the SAME update that locks the row. A locked row cannot be updated
      // afterwards, so the reference travels with the lock or never lands.
      let posted = { voucher_id: null, note: null };
      try {
        const { rows: fresh } = await t.query(`SELECT * FROM ${table} WHERE id = $1::uuid`, [id]);
        posted = await postOnApproval(table, fresh[0]);
      } catch (err) {
        if (err.statusCode) {
          return reply.code(err.statusCode).send({ error: err.code, detail: err.message });
        }
        throw err;
      }

      const hasVoucherCol = Object.prototype.hasOwnProperty.call(before[0], 'voucher_id');
      const { rows: after } = await t.query(
        `UPDATE ${table}
            SET approval_status = 'APPROVED', is_locked = true,
                approved_by = $2::uuid, approved_at = now()
                ${hasVoucherCol ? ', voucher_id = COALESCE($3::uuid, voucher_id)' : ''}
          WHERE id = $1::uuid
          RETURNING id, approval_status, is_locked, approved_at${hasVoucherCol ? ', voucher_id' : ''}${s.amount ? `, ${s.amount} AS amt` : ''}`,
        hasVoucherCol ? [id, req.user.sub, posted.voucher_id] : [id, req.user.sub]);

      await t.query(
        `INSERT INTO approval_audit
           (source_table, source_id, from_status, to_status, actor_id, actor_name, amount, changes)
         VALUES ($1, $2::uuid, $3, 'APPROVED', $4::uuid, $5, $6, $7::jsonb)`,
        [table, id, before[0].approval_status, req.user.sub,
         req.user.name ?? req.user.email ?? null, after[0].amt ?? null,
         applied ? JSON.stringify(applied) : null]);

      return { ...after[0], edits_applied: applied, ledger_note: posted.note };
    });
  });

  app.post('/approvals/:table/:id/reject', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { table, id } = req.params;
    if (!APPROVABLE.has(table)) {
      return reply.code(400).send({ error: 'NOT_APPROVABLE', detail: `${table} is not under maker-checker` });
    }
    const reason = (req.body?.reason ?? '').trim();
    if (!reason) {
      return reply.code(400).send({
        error: 'REASON_REQUIRED',
        detail: 'a rejection without a reason cannot be acted on by whoever entered the row',
      });
    }
    return withTransaction(async (t) => {
      const { rows } = await t.query(
        `UPDATE ${table}
            SET approval_status = 'REJECTED', rejected_by = $2::uuid,
                rejected_at = now(), reject_reason = $3
          WHERE id = $1::uuid AND NOT is_locked
          RETURNING id, approval_status`,
        [id, req.user.sub, reason]);
      if (!rows[0]) {
        return reply.code(409).send({ error: 'NOT_REJECTABLE', detail: 'row is missing or already locked' });
      }
      await t.query(
        `INSERT INTO approval_audit (source_table, source_id, to_status, actor_id, actor_name, reason)
         VALUES ($1, $2::uuid, 'REJECTED', $3::uuid, $4, $5)`,
        [table, id, req.user.sub, req.user.name ?? req.user.email ?? null, reason]);
      return rows[0];
    });
  });

  app.get('/approvals/:table/:id/history', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT from_status, to_status, actor_name, reason, amount, changes, created_at
         FROM approval_audit WHERE source_table = $1 AND source_id = $2::uuid
        ORDER BY created_at`, [req.params.table, req.params.id]);
    return { count: rows.length, rows };
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2b. PORTAL ACCESS CONTROL
  // ═══════════════════════════════════════════════════════════════════════

  app.get('/portal-access/matrix', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT role, module_key, label, description, parent_key, sensitive,
              sort_order, is_visible, updated_at
         FROM v_portal_role_matrix ORDER BY role, sort_order`);
    const { rows: parties } = await query(`
      SELECT 'CUSTOMER' AS role, id, customer_name AS name,
             is_approved_for_portal, portal_approved_at FROM customers
      UNION ALL
      SELECT 'VENDOR', id, vendor_name, is_approved_for_portal, portal_approved_at FROM vendors
      UNION ALL
      SELECT 'DRIVER', id, name, is_approved_for_portal, portal_approved_at FROM drivers
      ORDER BY role, name`);
    const byRole = {};
    for (const r of rows) (byRole[r.role] ??= []).push(r);
    return {
      matrix: byRole,
      parties,
      gate_summary: ['CUSTOMER', 'VENDOR', 'DRIVER'].map((role) => ({
        role,
        approved: parties.filter((p) => p.role === role && p.is_approved_for_portal).length,
        total: parties.filter((p) => p.role === role).length,
      })),
    };
  });

  // Toggle a module for a role. Every flip is audited — "who opened the vendor
  // ledger to every vendor" is the question this table exists to answer.
  app.patch('/portal-access/:role/:moduleKey', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { role, moduleKey } = req.params;
    const visible = req.body?.is_visible;
    if (typeof visible !== 'boolean') {
      return reply.code(400).send({ error: 'BAD_REQUEST', detail: 'is_visible must be true or false' });
    }
    return withTransaction(async (t) => {
      const { rows: mod } = await t.query(
        `SELECT module_key, parent_key, label FROM portal_modules
          WHERE module_key = $1 AND role = $2`, [moduleKey, role]);
      if (!mod[0]) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'no such module for this role' });

      const { rows: was } = await t.query(
        `SELECT is_visible FROM portal_role_access WHERE role=$1 AND module_key=$2`, [role, moduleKey]);

      const { rows: now } = await t.query(`
        INSERT INTO portal_role_access (role, module_key, is_visible, updated_by, updated_at)
        VALUES ($1, $2, $3, $4::uuid, now())
        ON CONFLICT (role, module_key) DO UPDATE
          SET is_visible = EXCLUDED.is_visible, updated_by = EXCLUDED.updated_by,
              updated_at = now()
        RETURNING is_visible`, [role, moduleKey, visible, req.user.sub]);

      // Closing a page closes its fields. Leaving a field "visible" under a
      // hidden page is a row that reads as permission and grants nothing —
      // until someone reopens the page and is surprised by what comes back.
      let cascaded = 0;
      if (!visible) {
        const { rowCount } = await t.query(
          `UPDATE portal_role_access SET is_visible = false, updated_by = $3::uuid, updated_at = now()
            WHERE role = $1 AND is_visible
              AND module_key IN (SELECT module_key FROM portal_modules WHERE parent_key = $2)`,
          [role, moduleKey, req.user.sub]);
        cascaded = rowCount;
      }

      await t.query(
        `INSERT INTO portal_access_audit (role, module_key, was_visible, now_visible, actor_id, actor_name)
         VALUES ($1,$2,$3,$4,$5::uuid,$6)`,
        [role, moduleKey, was[0]?.is_visible ?? null, visible, req.user.sub,
         req.user.name ?? req.user.email ?? null]);

      return { role, module_key: moduleKey, is_visible: now[0].is_visible, fields_closed: cascaded };
    });
  });

  // THE GATE ITSELF. Nothing loads on a portal until this is true.
  const PARTY_TABLE = { CUSTOMER: 'customers', VENDOR: 'vendors', DRIVER: 'drivers' };
  app.post('/portal-access/party/:role/:id/approval', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const table = PARTY_TABLE[req.params.role];
    if (!table) return reply.code(400).send({ error: 'BAD_ROLE' });
    const approve = req.body?.approved;
    if (typeof approve !== 'boolean') {
      return reply.code(400).send({ error: 'BAD_REQUEST', detail: 'approved must be true or false' });
    }
    const { rows } = await query(
      `UPDATE ${table}
          SET is_approved_for_portal = $2,
              portal_approved_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
              portal_approved_at = CASE WHEN $2 THEN now() ELSE NULL END
        WHERE id = $1::uuid
        RETURNING id, is_approved_for_portal, portal_approved_at`,
      [req.params.id, approve, req.user.sub]);
    if (!rows[0]) return reply.code(404).send({ error: 'NOT_FOUND' });
    await query(
      `INSERT INTO portal_access_audit (role, module_key, was_visible, now_visible, actor_id, actor_name)
       VALUES ($1, $2, $3, $4, $5::uuid, $6)`,
      [req.params.role, `party:${req.params.id}`, !approve, approve, req.user.sub,
       req.user.name ?? req.user.email ?? null]);
    return rows[0];
  });

  app.get('/portal-access/audit', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT role, module_key, was_visible, now_visible, actor_name, created_at
         FROM portal_access_audit ORDER BY created_at DESC LIMIT 100`);
    return { count: rows.length, rows };
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. PROVISIONAL / ACCRUAL
  // ═══════════════════════════════════════════════════════════════════════

  app.get('/provisional/summary', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`SELECT * FROM v_provisional_summary ORDER BY status`);
    const { rows: cyc } = await query(`
      SELECT c.cycle_code, c.period_from, c.period_to, c.status,
             count(p.id)::int accruals,
             COALESCE(sum(p.est_freight),0)::numeric(16,2) est_freight
        FROM billing_cycles c
        LEFT JOIN provisional_trips_ledger p ON p.cycle_id = c.id
       GROUP BY c.id ORDER BY c.period_from DESC LIMIT 12`);
    return { by_status: rows, by_cycle: cyc };
  });

  app.post('/provisional/accrue/:tripId', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT accrue_trip($1::uuid, $2) AS id`,
      [req.params.tripId, req.body?.event ?? 'UNLOAD']);
    const { rows: r } = await query(
      `SELECT * FROM provisional_trips_ledger WHERE id = $1::uuid`, [rows[0].id]);
    return r[0];
  });

  // Cycle close: accrue every unloaded trip in the period that has no open
  // accrual. Idempotent by construction — accrue_trip returns the existing row
  // rather than creating a second, so running this twice on the 15th is safe.
  app.post('/provisional/cycles/:code/close', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows: cyc } = await query(
      `SELECT * FROM billing_cycles WHERE cycle_code = $1`, [req.params.code]);
    if (!cyc[0]) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'unknown cycle' });

    const { rows: made } = await query(`
      SELECT accrue_trip(t.id, 'CYCLE_END') AS id
        FROM trips t
       WHERE COALESCE(t.unloading_date, t.loading_date) BETWEEN $1::date AND $2::date
         AND NOT EXISTS (
           SELECT 1 FROM provisional_trips_ledger p
            WHERE p.trip_id = t.id AND p.status IN ('PROVISIONAL','BUNDLED','RECONCILED'))`,
      [cyc[0].period_from, cyc[0].period_to]);

    if (req.body?.seal !== false) {
      await query(`UPDATE billing_cycles SET status='CLOSED', closed_at=now() WHERE id=$1::uuid`, [cyc[0].id]);
    }
    const { rows: sum } = await query(`
      SELECT count(*)::int accruals,
             COALESCE(sum(est_freight),0)::numeric(16,2) est_freight,
             count(*) FILTER (WHERE basis='NO_BASIS')::int no_basis
        FROM provisional_trips_ledger WHERE cycle_id = $1::uuid`, [cyc[0].id]);
    return { cycle: cyc[0].cycle_code, newly_accrued: made.length, ...sum[0] };
  });

  // ── bundles ──────────────────────────────────────────────────────────────
  app.post('/provisional/bundles', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { cycle_code, entity_id, party_name, vendor_code, trip_ids } = req.body ?? {};
    if (!cycle_code) return reply.code(400).send({ error: 'BAD_REQUEST', detail: 'cycle_code is required' });

    return withTransaction(async (t) => {
      const { rows: cyc } = await t.query(`SELECT id, cycle_code FROM billing_cycles WHERE cycle_code=$1`, [cycle_code]);
      if (!cyc[0]) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'unknown cycle' });

      const code = `BND-${cyc[0].cycle_code}-${(vendor_code || party_name || 'GEN').toString().slice(0, 12)}`;
      const { rows: b } = await t.query(`
        INSERT INTO trip_bundles (bundle_code, cycle_id, entity_id, party_name, vendor_code)
        VALUES ($1, $2::uuid, $3::uuid, $4, $5)
        ON CONFLICT (bundle_code) DO UPDATE SET updated_at = now()
        RETURNING *`,
        [code, cyc[0].id, entity_id ?? null, party_name ?? null, vendor_code ?? null]);

      let mapped = 0;
      for (const tripId of Array.isArray(trip_ids) ? trip_ids : []) {
        // PK on trip_id is what enforces "one trip, one bundle". A trip already
        // in another bundle is reported, not silently re-pointed.
        const { rowCount } = await t.query(
          `INSERT INTO trip_bundle_mapping (trip_id, bundle_id, added_by)
           VALUES ($1::uuid, $2::uuid, $3::uuid) ON CONFLICT (trip_id) DO NOTHING`,
          [tripId, b[0].id, req.user?.sub ?? null]);
        mapped += rowCount;
        await t.query(
          `UPDATE provisional_trips_ledger SET bundle_id = $2::uuid, status = 'BUNDLED'
            WHERE trip_id = $1::uuid AND status = 'PROVISIONAL'`, [tripId, b[0].id]);
      }

      const { rows: agg } = await t.query(`
        UPDATE trip_bundles SET
          trip_count  = (SELECT count(*) FROM trip_bundle_mapping m WHERE m.bundle_id = $1::uuid),
          est_freight = (SELECT COALESCE(sum(p.est_freight),0) FROM provisional_trips_ledger p WHERE p.bundle_id = $1::uuid),
          est_fuel    = (SELECT COALESCE(sum(p.est_fuel),0)    FROM provisional_trips_ledger p WHERE p.bundle_id = $1::uuid),
          est_toll    = (SELECT COALESCE(sum(p.est_toll),0)    FROM provisional_trips_ledger p WHERE p.bundle_id = $1::uuid)
        WHERE id = $1::uuid RETURNING *`, [b[0].id]);

      return reply.code(201).send({ ...agg[0], newly_mapped: mapped,
        skipped: (trip_ids?.length ?? 0) - mapped });
    });
  });

  app.get('/provisional/bundles', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`
      SELECT b.*, c.cycle_code, c.period_from, c.period_to, e.entity_code, e.display_name
        FROM trip_bundles b
        JOIN billing_cycles c ON c.id = b.cycle_id
        LEFT JOIN entity_master e ON e.id = b.entity_id
       ORDER BY c.period_from DESC, b.bundle_code LIMIT 200`);
    return { count: rows.length, rows };
  });

  // ── reconcile a bundle against the invoice that finally arrived ──────────
  //
  // This is the step the OCR pipeline calls once it has a parsed invoice total
  // for a bundle. It computes the variance, clears the provisional rows and
  // records the final figure — it does NOT invent a ledger posting here. The
  // actual voucher is TARA's job and is passed in as final_voucher_id by the
  // caller that posted it, so this file never becomes a second writer of money.
  // NOT admin-guarded, and the reason is consistency rather than convenience:
  // POST /finance/vouchers — which posts real money through TARA — is already
  // unguarded on this API, and the OCR pipeline calls it. Requiring an admin
  // token to record what an invoice SAID, while requiring none to move the cash
  // it implies, would be a control in the wrong place. The real boundary for
  // both is that the API binds to 127.0.0.1 only.
  //
  // (That boundary is worth reviewing on its own merits — an unauthenticated
  // voucher endpoint is only as safe as the host it listens on.)
  app.post('/provisional/bundles/:id/reconcile', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const actual = req.body?.actual_freight;
    if (actual == null || Number.isNaN(Number(actual))) {
      return reply.code(400).send({ error: 'BAD_REQUEST', detail: 'actual_freight is required' });
    }
    return withTransaction(async (t) => {
      const { rows: b } = await t.query(
        `SELECT * FROM trip_bundles WHERE id = $1::uuid FOR UPDATE`, [req.params.id]);
      if (!b[0]) return reply.code(404).send({ error: 'NOT_FOUND' });
      if (b[0].status === 'RECONCILED' || b[0].status === 'CLOSED') {
        return reply.code(409).send({ error: 'ALREADY_RECONCILED',
          detail: `bundle was reconciled at ${b[0].reconciled_at}` });
      }

      // Spread the actual across the bundle's trips in proportion to what each
      // was estimated at. Proportional, not equal: a load estimated at 5 lakh
      // and one at 5 thousand did not contribute equally to the invoice.
      // Arithmetic in SQL — numeric all the way, no JS float touches money.
      await t.query(`
        WITH tot AS (
          SELECT NULLIF(sum(est_freight),0) AS s, count(*) AS n
            FROM provisional_trips_ledger
           WHERE bundle_id = $1::uuid AND status IN ('PROVISIONAL','BUNDLED'))
        UPDATE provisional_trips_ledger p
           SET actual_freight = CASE
                 -- Every leg estimated at nil: nothing to be proportional TO,
                 -- so split evenly rather than divide by zero.
                 WHEN (SELECT s FROM tot) IS NULL
                 THEN round($2::numeric / GREATEST((SELECT n FROM tot), 1), 2)
                 ELSE round($2::numeric * p.est_freight / (SELECT s FROM tot), 2) END,
               status = 'RECONCILED'
         WHERE p.bundle_id = $1::uuid AND p.status IN ('PROVISIONAL','BUNDLED')`,
        [req.params.id, String(actual)]);

      // Rounding each leg independently leaves the legs summing to a few paise
      // either side of the invoice. Give the residual to the largest leg, so
      // the parts add up to the whole exactly — a bundle whose legs do not sum
      // to the invoice is a reconciliation that has not reconciled.
      await t.query(`
        WITH s AS (SELECT COALESCE(sum(actual_freight),0) AS tot
                     FROM provisional_trips_ledger
                    WHERE bundle_id = $1::uuid AND status = 'RECONCILED'),
             biggest AS (SELECT id FROM provisional_trips_ledger
                          WHERE bundle_id = $1::uuid AND status = 'RECONCILED'
                          ORDER BY est_freight DESC, id LIMIT 1)
        UPDATE provisional_trips_ledger p
           SET actual_freight = p.actual_freight + ($2::numeric - (SELECT tot FROM s))
         WHERE p.id = (SELECT id FROM biggest)
           AND (SELECT tot FROM s) <> $2::numeric`,
        [req.params.id, String(actual)]);

      const { rows: legs } = await t.query(
        `SELECT id, trip_id, est_freight, actual_freight, variance
           FROM provisional_trips_ledger
          WHERE bundle_id = $1::uuid AND status = 'RECONCILED'
          ORDER BY est_freight DESC`, [req.params.id]);

      const { rows: upd } = await t.query(`
        UPDATE trip_bundles
           SET actual_freight = $2::numeric,
               variance = $2::numeric - est_freight,
               status = 'RECONCILED',
               invoice_ref = COALESCE($3, invoice_ref),
               reconciled_at = now()
         WHERE id = $1::uuid RETURNING *`,
        [req.params.id, String(actual), req.body?.invoice_ref ?? null]);

      await t.query(
        `INSERT INTO approval_audit (source_table, source_id, to_status, actor_id, actor_name, amount, reason)
         VALUES ('trip_bundles', $1::uuid, 'RECONCILED', $2::uuid, $3, $4, $5)`,
        [req.params.id, req.user?.sub ?? null,
         req.user?.name ?? req.user?.email ?? 'iocl_reconcile pipeline',
         String(actual), req.body?.invoice_ref ? `invoice ${req.body.invoice_ref}` : null]);

      return { bundle: upd[0], legs_reconciled: legs.length, legs };
    });
  });

  // Clearing is separate from reconciling on purpose: reconcile records what the
  // invoice said, clear records that the final figure reached the real ledger.
  // Splitting them means a bundle can sit reconciled-but-unposted and be visible
  // as exactly that, rather than a provisional entry silently pretending to be
  // settled money.
  app.post('/provisional/bundles/:id/clear', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const voucherId = req.body?.final_voucher_id ?? null;
    return withTransaction(async (t) => {
      const { rows: b } = await t.query(
        `SELECT * FROM trip_bundles WHERE id = $1::uuid FOR UPDATE`, [req.params.id]);
      if (!b[0]) return reply.code(404).send({ error: 'NOT_FOUND' });
      if (b[0].status !== 'RECONCILED') {
        return reply.code(409).send({ error: 'NOT_RECONCILED',
          detail: 'reconcile the bundle against its invoice before clearing it' });
      }
      const { rows } = await t.query(`
        UPDATE provisional_trips_ledger
           SET status = 'CLEARED', cleared_at = now(), cleared_by = $2::uuid,
               final_voucher_id = $3::uuid
         WHERE bundle_id = $1::uuid AND status = 'RECONCILED'
        RETURNING id, trip_id, est_freight, actual_freight, variance`,
        [req.params.id, req.user?.sub ?? null, voucherId]);
      await t.query(`UPDATE trip_bundles SET status='CLOSED' WHERE id=$1::uuid`, [req.params.id]);
      return { cleared: rows.length, legs: rows };
    });
  });
}
