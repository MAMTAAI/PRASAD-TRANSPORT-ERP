// server/modules/queues.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/queues — the review queues staff work through, and the mailboxes that
// feed one of them.
//
//   GET/POST/PATCH  /expenses            retroactive expense approvals
//   POST /expenses/:id/approve  /:id/reject
//   GET/POST/PATCH/DELETE  /email-accounts       IMAP mailboxes (SECRETS)
//   GET/PATCH              /parsed-bills         what the parser extracted
//   GET  /badges                                 sidebar pending counts
//
// APPROVAL IS A DECISION, NOT A POSTING. Approving an expense does not touch
// the ledger: TARA posts the voucher and `voucher_id` records which one. If
// this route inserted the GL leg itself, `ledger_entries` would have a second
// writer, which is the one thing the accounting rules forbid outright.
//
// THE MASK IS THE POINT (same rule as toll.routes' provider credentials).
// `app_password` is a live Gmail app password. Every read replaces it with a
// sentinel; a write that sends the sentinel back is ignored rather than stored,
// so the settings screen can round-trip an account without ever holding — or
// erasing — a secret it was never given.
// ─────────────────────────────────────────────────────────────────────────────
import { query, withTransaction, isDegraded } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';
import { notifyWhatsApp } from '../lib/notify.js';
// Decisions are admin work. The UI hid the buttons from other roles; since
// 2026-09-02 the server refuses them too (docs/ACCESS-CONTROL-MATRIX.md §5).
import { requireAdminRole } from './auth.routes.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clamp = (v, d, max) => Math.min(Number.parseInt(v ?? d, 10) || d, max);

const pgErr = (reply, err) => {
  if (err.code === '23505') return reply.code(409).send({ error: 'DUPLICATE', detail: err.detail ?? err.message });
  if (err.code === '23514') return reply.code(400).send({ error: 'CONSTRAINT', detail: err.message });
  throw err;
};

const MASK = '••••••••';

export async function registerQueueRoutes(app) {
  // ═══ EXPENSE APPROVALS ════════════════════════════════════════════════════
  const EXPENSE_COLS = ['trip_id', 'trip_ref', 'vehicle_no', 'driver_name', 'vendor_name',
    'expense_type', 'bill_no', 'bill_date', 'amount', 'description', 'source',
    'match_confidence', 'trip_status_at_entry', 'entered_by'];

  app.get('/expenses', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { status, limit } = req.query ?? {};
    const { rows } = status
      ? await query('SELECT * FROM expense_approvals WHERE status = $1 ORDER BY created_at DESC LIMIT $2',
          [String(status).toUpperCase(), clamp(limit, 500, 2000)])
      : await query('SELECT * FROM expense_approvals ORDER BY created_at DESC LIMIT $1', [clamp(limit, 500, 2000)]);
    return { expenses: rows };
  });

  app.post('/expenses', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.expense_type || b.amount === undefined) {
      return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'expense_type and amount are required' });
    }
    const cols = EXPENSE_COLS.filter((c) => b[c] !== undefined);
    // A trip_id that is not a uuid is a Firestore-era trip code; it belongs in
    // trip_ref, where it stays readable instead of failing the cast.
    const vals = cols.map((c) => (c === 'trip_id' && !UUID_RE.test(String(b.trip_id ?? '')) ? null : b[c]));
    if (b.trip_id && !UUID_RE.test(String(b.trip_id)) && !cols.includes('trip_ref')) {
      cols.push('trip_ref'); vals.push(String(b.trip_id));
    }
    try {
      const { rows } = await query(
        `INSERT INTO expense_approvals (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        vals);
      return reply.code(201).send({ expense: rows[0] });
    } catch (e) { return pgErr(reply, e); }
  });

  app.patch('/expenses/:id', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const cols = EXPENSE_COLS.filter((c) => b[c] !== undefined);
    if (!cols.length) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    const idCol = UUID_RE.test(String(req.params.id)) ? 'id = $1::uuid' : 'legacy_id = $1';
    const { rows } = await query(
      `UPDATE expense_approvals SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now()
        WHERE ${idCol} AND status = 'PENDING' RETURNING *`,
      [req.params.id, ...cols.map((c) => b[c])]);
    // Editing a decided expense is refused rather than silently ignored: the
    // amount on an approved row is what a voucher was posted from.
    if (!rows.length) return reply.code(409).send({ error: 'NOT_PENDING_OR_MISSING' });
    return { expense: rows[0] };
  });

  const decide = (verb, sql, extra) => app.post(`/expenses/:id/${verb}`, { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const idCol = UUID_RE.test(String(req.params.id)) ? 'id = $1::uuid' : 'legacy_id = $1';
    const { rows } = await query(sql.replace('$IDCOL', idCol), [req.params.id, ...extra(req.body ?? {})]);
    if (!rows.length) return reply.code(409).send({ error: 'ALREADY_DECIDED_OR_MISSING' });
    return { expense: rows[0] };
  });

  // ── Approve = post the expense, then stamp the row ───────────────────────
  // In Firestore this ran in the browser: postTripEngine.approveRetroExpense()
  // wrote both legs of a double entry from the client. On PostgreSQL that is
  // impossible by design — ledger_entries is TARA's, append-only by trigger,
  // with a deferred Dr=Cr constraint. So the posting moves here and goes
  // through postVoucher as a JOURNAL: an expense bill has no cash leg (the
  // vendor is paid later), which is exactly the case RECEIPT/PAYMENT/CONTRA
  // cannot express.
  //
  //   Dr  <expense ledger>            the cost
  //     Cr  Creditors: <vendor>       what we now owe   (or Cash, if no vendor)
  //
  // TARA returns 409 DUPLICATE_REF if the same expense is approved twice, so a
  // double-click cannot post the cost twice.
  // THE GROUP MUST BE ONE account_groups ACTUALLY HAS. `ledgers.group_head` is a
  // foreign key onto that table, so posting a bill whose expense ledger does not
  // exist yet made TARA open it under 'Direct Expenses' — a group nobody ever
  // created — and the whole approval died with 23503 ledgers_group_fk. It only
  // ever showed up on the FIRST bill of a kind, which is why it survived: the
  // ledgers that already existed were never re-created. Found 3-Sep-2026 the
  // first time a service vendor's fuel bill was approved end to end.
  //
  // Ledger names and groups below are the ones already on the books, so an
  // approval lands in the same account the office has been using, not beside it.
  const EXPENSE_LEDGER = {
    FUEL:        { ledger: 'Diesel / Fuel Expense',    group: 'Direct Expenses - Fuel & HSD' },
    TOLL:        { ledger: 'Toll & Fastag Expense',    group: 'Direct Expenses - Toll & FASTag' },
    TYRE:        { ledger: 'Tyre Consumption Expenses', group: 'Direct Expenses - Repairs & Tyres' },
    MAINTENANCE: { ledger: 'Vehicle Spares & Repairs',  group: 'Direct Expenses - Repairs & Tyres' },
    VENDOR:      { ledger: 'Purchases / Expense',       group: 'Indirect Expenses' },
    OTHER:       { ledger: 'Purchases / Expense',       group: 'Indirect Expenses' },
  };

  app.post('/expenses/:id/approve', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const idCol = UUID_RE.test(String(req.params.id)) ? 'id = $1::uuid' : 'legacy_id = $1';
    const { rows: found } = await query(`SELECT * FROM expense_approvals WHERE ${idCol}`, [req.params.id]);
    const exp = found[0];
    if (!exp) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (exp.status !== 'PENDING') return reply.code(409).send({ error: 'ALREADY_DECIDED', detail: `expense is ${exp.status}` });

    const amount = Number(exp.amount);
    if (!(amount > 0)) return reply.code(400).send({ error: 'BAD_AMOUNT', detail: 'nothing to post' });

    const debit = EXPENSE_LEDGER[exp.expense_type] ?? EXPENSE_LEDGER.OTHER;
    const credit = exp.vendor_name ? `Creditors: ${exp.vendor_name}` : 'Cash';
    const tag = exp.trip_ref ? ` [Trip ${exp.trip_ref}]` : '';

    // ── WHOSE BOOKS (owner, 3-Sep) ───────────────────────────────────────────
    // Three operating firms keep three sets of books. A bill posted with no
    // company lands in none of them, and the diesel of all three ends up in one
    // undivided pile — which is what happened to every expense approved before
    // migration 140. The office may correct the vendor's choice at this moment,
    // because this is the moment somebody actually reads the bill.
    const chosen = req.body?.company_id ?? exp.company_id ?? null;
    if (!chosen) {
      return reply.code(400).send({
        error: 'NO_COMPANY',
        detail: 'choose which operating company this bill belongs to before approving — the ledger posts under that company',
      });
    }
    if (!UUID_RE.test(String(chosen))) return reply.code(400).send({ error: 'BAD_COMPANY' });
    const { rows: co } = await query(
      `SELECT id, company_name FROM companies WHERE id = $1::uuid`, [chosen]);
    if (!co.length) return reply.code(400).send({ error: 'BAD_COMPANY', detail: 'no such operating company' });
    // Remember the decision on the bill, so the queue and any later audit show
    // the company the voucher was actually posted under.
    if (String(exp.company_id ?? '') !== String(chosen)) {
      await query('UPDATE expense_approvals SET company_id = $2::uuid WHERE id = $1::uuid', [exp.id, chosen]);
    }

    let voucher;
    try {
      voucher = await postVoucher({
        type: 'JOURNAL',
        source_type: 'RETRO_EXPENSE',
        ref_no: exp.id,
        entry_date: exp.bill_date ?? new Date().toISOString().slice(0, 10),
        // TARA stamps both legs with these, so the cost and the payable land in
        // the same company's books — ledger isolation is a property of the
        // voucher, not of a filter applied afterwards.
        company: co[0].company_name,
        company_id: co[0].id,
        narration: `Retro ${String(exp.expense_type).toLowerCase()} bill ${exp.bill_no ?? ''} — ${exp.vendor_name || 'cash'}${tag} (${exp.vehicle_no ?? ''})`.trim(),
        lines: [
          { ledger: debit.ledger, dr_cr: 'DR', amount, group: debit.group },
          { ledger: credit, dr_cr: 'CR', amount, group: exp.vendor_name ? 'Sundry Creditors' : 'Cash-in-Hand' },
        ],
      });
    } catch (e) {
      if (e.code === 'DUPLICATE_REF') {
        return reply.code(409).send({ error: 'ALREADY_POSTED', detail: e.message });
      }
      return reply.code(422).send({ error: e.code ?? 'POSTING_FAILED', detail: e.message });
    }

    // The stamp and the trip adjustment go together: a trip whose expense total
    // moved but whose approval never recorded a voucher would be unexplainable.
    const updated = await withTransaction(async (c) => {
      const { rows } = await c.query(`
        UPDATE expense_approvals
           SET status = 'APPROVED', approved_by = $2, approved_at = now(),
               voucher_id = $3::uuid, updated_at = now()
         WHERE id = $1::uuid RETURNING *`,
        [exp.id, req.body?.approved_by ?? null, voucher?.voucher_id ?? null]);

      // Retro-adjust the trip's own P&L. final_balance is only recomputed for a
      // trip already closed — an open trip recomputes it on settlement anyway.
      if (exp.trip_id) {
        await c.query(`
          UPDATE trips
             SET total_expense = COALESCE(total_expense, 0) + $2::numeric,
                 final_balance = CASE WHEN status IN ('COMPLETED','SETTLED')
                                      THEN COALESCE(final_balance, 0) - $2::numeric
                                      ELSE final_balance END,
                 updated_at = now()
           WHERE id = $1::uuid`, [exp.trip_id, amount.toFixed(2)]);
      }
      return rows[0];
    });

    return { expense: updated, voucher_id: voucher?.voucher_id ?? null };
  });

  decide('reject', `
    UPDATE expense_approvals
       SET status = 'REJECTED', rejection_reason = $2, approved_by = $3, approved_at = now(), updated_at = now()
     WHERE $IDCOL AND status = 'PENDING' RETURNING *`,
    (b) => [b.reason ?? null, b.rejected_by ?? null]);

  // ═══ EMAIL ACCOUNTS ═══════════════════════════════════════════════════════
  const SAFE_ACCOUNT = 'id, legacy_id, email, imap_host, imap_port, customer, status, last_result, last_error, last_run_at, created_at, updated_at';
  // The password never appears in a SELECT list; the flag says only whether one
  // is set, which is all the screen needs to render its field.
  const maskAccount = (r) => ({ ...r, app_password: r.has_password ? MASK : '', has_password: undefined });

  app.get('/email-accounts', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT ${SAFE_ACCOUNT}, (app_password IS NOT NULL AND app_password <> '') AS has_password
         FROM email_accounts ORDER BY email`);
    return { accounts: rows.map(maskAccount) };
  });

  app.post('/email-accounts', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.email) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'email is required' });
    const pw = b.app_password === MASK ? null : (b.app_password || null);
    try {
      const { rows } = await query(`
        INSERT INTO email_accounts (email, app_password, imap_host, imap_port, customer, status)
        VALUES ($1,$2,COALESCE($3,'imap.gmail.com'),COALESCE($4,993),$5,COALESCE($6,'Active'))
        RETURNING ${SAFE_ACCOUNT}, (app_password IS NOT NULL) AS has_password`,
        [String(b.email).trim().toLowerCase(), pw, b.imap_host ?? null,
         b.imap_port ? Number.parseInt(b.imap_port, 10) : null, b.customer ?? null, b.status ?? null]);
      return reply.code(201).send({ account: maskAccount(rows[0]) });
    } catch (e) { return pgErr(reply, e); }
  });

  app.patch('/email-accounts/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const cols = ['email', 'imap_host', 'imap_port', 'customer', 'status'].filter((c) => b[c] !== undefined);
    const vals = cols.map((c) => (c === 'imap_port' ? Number.parseInt(b[c], 10) : b[c]));
    // A blank or masked password means "leave the stored one alone" — the same
    // rule the screen already assumed ("edit me khali chhoda => purana rakha").
    if (b.app_password && b.app_password !== MASK) { cols.push('app_password'); vals.push(b.app_password); }
    if (!cols.length) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    const idCol = UUID_RE.test(String(req.params.id)) ? 'id = $1::uuid' : 'legacy_id = $1';
    try {
      const { rows } = await query(
        `UPDATE email_accounts SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now()
          WHERE ${idCol} RETURNING ${SAFE_ACCOUNT}, (app_password IS NOT NULL AND app_password <> '') AS has_password`,
        [req.params.id, ...vals]);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { account: maskAccount(rows[0]) };
    } catch (e) { return pgErr(reply, e); }
  });

  app.delete('/email-accounts/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const idCol = UUID_RE.test(String(req.params.id)) ? 'id = $1::uuid' : 'legacy_id = $1';
    const { rowCount } = await query(`DELETE FROM email_accounts WHERE ${idCol}`, [req.params.id]);
    if (!rowCount) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { deleted: true };
  });

  // ═══ PARSED BILLS ═════════════════════════════════════════════════════════
  app.get('/parsed-bills', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { status, limit } = req.query ?? {};
    const { rows } = status
      ? await query('SELECT * FROM email_parsed_bills WHERE status = $1 ORDER BY created_at DESC LIMIT $2',
          [String(status).toUpperCase(), clamp(limit, 50, 500)])
      : await query('SELECT * FROM email_parsed_bills ORDER BY created_at DESC LIMIT $1', [clamp(limit, 50, 500)]);
    return { bills: rows };
  });

  app.patch('/parsed-bills/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const status = String(req.body?.status ?? '').toUpperCase();
    if (!['PENDING_REVIEW', 'FILED', 'REJECTED'].includes(status)) {
      return reply.code(400).send({ error: 'BAD_STATUS' });
    }
    const idCol = UUID_RE.test(String(req.params.id)) ? 'id = $1::uuid' : 'digest = $1';
    const { rows } = await query(
      `UPDATE email_parsed_bills SET status = $2 WHERE ${idCol} RETURNING *`, [req.params.id, status]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { bill: rows[0] };
  });

  // ═══ UNBILLED FUEL SUMMARY ════════════════════════════════════════════════
  // The real "pending expense" in this business is fuel: a memo records the
  // litres at the pump, but the rupee value only becomes real when the pump's
  // physical bill is reconciled. Pending Expenses shows the count so "sab 0
  // hai, system kharab hai" never happens.
  //
  // Three integers, computed in SQL. The Firestore screen streamed the entire
  // fuel register to the browser and reduced it there.
  app.get('/fuel-pending', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`
      SELECT count(*)::int                          AS count,
             COALESCE(SUM(liters), 0)::numeric(14,2) AS liters,
             COALESCE(SUM(amount), 0)::numeric(14,2) AS value
        FROM fuel_entries
       WHERE COALESCE(bill_status, 'UNBILLED') = 'UNBILLED'`);
    return rows[0];
  });

  // ═══ FUEL REGISTER (read-only) ════════════════════════════════════════════
  // CHHINNAMASTA owns `fuel_entries`; this is a read, so it does not contend
  // with that. Exposed here because two consumers need the register itself and
  // not just the pending summary above: the daily briefing's anomaly check and
  // the fuel screen's history.
  app.get('/fuel-entries', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { vehicle_no, vendor_id, from, to, limit } = req.query ?? {};
    const where = [], args = [];
    if (vehicle_no) { args.push(vehicle_no); where.push(`vehicle_no = $${args.length}`); }
    if (vendor_id && UUID_RE.test(String(vendor_id))) { args.push(vendor_id); where.push(`vendor_id = $${args.length}::uuid`); }
    if (from) { args.push(from); where.push(`entry_date >= $${args.length}::date`); }
    if (to) { args.push(to); where.push(`entry_date <= $${args.length}::date`); }
    args.push(clamp(limit, 1000, 5000));
    const { rows } = await query(
      `SELECT * FROM fuel_entries ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY entry_date DESC NULLS LAST, created_at DESC LIMIT $${args.length}`, args);
    return { entries: rows };
  });

  // A slip can be corrected only while it is still UNBILLED. Once verified, its
  // value is what a voucher was posted from, so an edit would put the books and
  // the register out of step silently — the fix there is a reversal, not a PATCH.
  app.patch('/fuel-entries/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const cols = ['liters', 'rate', 'amount', 'vehicle_no', 'driver_name', 'pump_mobile'].filter((c) => b[c] !== undefined);
    if (!cols.length) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    const idCol = UUID_RE.test(String(req.params.id)) ? 'id = $1::uuid' : 'legacy_id = $1';
    const { rows } = await query(
      `UPDATE fuel_entries SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now()
        WHERE ${idCol} AND COALESCE(bill_status,'UNBILLED') = 'UNBILLED' RETURNING *`,
      [req.params.id, ...cols.map((c) => b[c])]);
    if (!rows.length) {
      return reply.code(409).send({ error: 'NOT_EDITABLE', detail: 'slip not found, or already verified against a pump bill' });
    }
    return { entry: rows[0] };
  });

  // ═══ FUEL BILL RECONCILIATION ═════════════════════════════════════════════
  // Verifying a pump's physical bill is three things at once: the slips get
  // their real rupee value, each linked trip's P&L moves by the DELTA, and the
  // liability to the pump is recognised. The Firestore screen did all three
  // from the browser in a loop — N round trips, no transaction, and the ledger
  // leg was a ONE-SIDED Cr row, which PostgreSQL rejects outright.
  //
  //   Dr  Diesel / Fuel Expense        the verified bill value
  //     Cr  Creditors: <pump>          what we now owe the pump
  //
  // DELTA, not the full share: the memo-time amount is already counted on the
  // trip, so only (new share - old amount) moves. That was the Firestore
  // screen's hard-won rule and it survives here.
  app.post('/fuel-reconcile', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const slipIds = Array.isArray(b.slip_ids) ? b.slip_ids.filter((x) => UUID_RE.test(String(x))) : [];
    const billAmount = Number(b.bill_amount);
    if (!UUID_RE.test(String(b.vendor_id ?? ''))) return reply.code(400).send({ error: 'BAD_VENDOR' });
    if (!slipIds.length) return reply.code(400).send({ error: 'NO_SLIPS' });
    if (!(billAmount > 0)) return reply.code(400).send({ error: 'BAD_AMOUNT' });

    const { rows: vRows } = await query('SELECT id, vendor_name, vendor_type FROM vendors WHERE id = $1::uuid', [b.vendor_id]);
    if (!vRows.length) return reply.code(404).send({ error: 'NO_SUCH_VENDOR' });
    const vendor = vRows[0];

    // Only slips that are still unbilled, and only this vendor's. Re-verifying
    // a slip that already carries a bill value is how a trip gets charged twice.
    const { rows: slips } = await query(
      `SELECT id, liters, amount, trip_id FROM fuel_entries
        WHERE id = ANY($1::uuid[]) AND vendor_id = $2::uuid
          AND COALESCE(bill_status,'UNBILLED') = 'UNBILLED'
        FOR UPDATE`, [slipIds, b.vendor_id]);
    if (!slips.length) return reply.code(409).send({ error: 'NO_UNBILLED_SLIPS', detail: 'these slips are already verified, or belong to another pump' });

    const totalLiters = slips.reduce((t, s) => t + (Number(s.liters) || 0), 0);
    const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    // Which company's diesel is this? Resolve it from the slips' trips (the FK,
    // not the pump). When every slip's trip is the same firm, stamp it so the
    // expense lands in that firm's P&L; when a pump fuelled trucks of more than
    // one firm (or the trips are untagged), leave it NULL — a split pump bill is
    // surfaced by v_voucher_company_conflicts rather than misattributed here.
    const tripIds = slips.map((s) => s.trip_id).filter(Boolean);
    let fuelCompanyId = null;
    if (tripIds.length) {
      const { rows: coRows } = await query(
        `SELECT DISTINCT company_id FROM trips
          WHERE id = ANY($1::uuid[]) AND company_id IS NOT NULL`, [tripIds]);
      if (coRows.length === 1) fuelCompanyId = coRows[0].company_id;
    }

    // The voucher is posted FIRST and outside the transaction, because TARA
    // opens its own. If it fails, nothing below has happened yet.
    const period = b.from && b.to ? ` (Period: ${b.from} to ${b.to})` : '';
    let voucher;
    try {
      voucher = await postVoucher({
        type: 'JOURNAL',
        source_type: 'FUEL_BILL',
        company_id: fuelCompanyId,
        // Deterministic: the same pump and the same slip set cannot post twice.
        ref_no: `FUELBILL_${vendor.id}_${[...slipIds].sort().join('').slice(0, 40)}`,
        entry_date: b.to ?? new Date().toISOString().slice(0, 10),
        narration: `Fuel bill verified — ${vendor.vendor_name}, ${slips.length} slip(s)${period}`,
        lines: [
          // GROUP MUST EXIST IN account_groups -- ledgers.group_head carries a
          // foreign key onto it. This said 'Direct Expenses', which is not a
          // group in this chart of accounts; the real one is
          // 'Direct Expenses - Fuel & HSD'. Every attempt to post a fuel bill
          // through here died on a 23503, so this path had never once reached
          // the ledger.
          { ledger: 'Direct Expenses - Fuel & HSD', dr_cr: 'DR', amount: billAmount,
            group: 'Direct Expenses - Fuel & HSD' },
          { ledger: `Creditors: ${vendor.vendor_name}`, dr_cr: 'CR', amount: billAmount,
            group: /fuel|pump/i.test(vendor.vendor_type ?? '') ? 'Sundry Creditors (Fuel Pumps)' : 'Sundry Creditors (Vendors)' },
        ],
      });
    } catch (e) {
      if (e.code === 'DUPLICATE_REF') return reply.code(409).send({ error: 'ALREADY_POSTED', detail: e.message });
      return reply.code(422).send({ error: e.code ?? 'POSTING_FAILED', detail: e.message });
    }

    const result = await withTransaction(async (c) => {
      const perTrip = new Map();
      for (const s of slips) {
        const liters = Number(s.liters) || 0;
        const share = totalLiters > 0 ? r2(billAmount * liters / totalLiters) : r2(s.amount);
        const oldAmt = Number(s.amount) || 0;
        const rate = liters > 0 ? r2(share / liters) : 0;
        await c.query(
          // No `reconciled_share` column and none needed: `amount` IS the
          // reconciled share once a slip is verified, and a second copy of the
          // same number is one more thing that can disagree.
          `UPDATE fuel_entries SET bill_status = 'BILLED_VERIFIED', amount = $2, rate = $3,
                                   updated_at = now()
            WHERE id = $1::uuid`, [s.id, share.toFixed(2), rate]);
        const delta = r2(share - oldAmt);
        if (s.trip_id && Math.abs(delta) > 0.009) perTrip.set(s.trip_id, r2((perTrip.get(s.trip_id) ?? 0) + delta));
      }
      for (const [tripId, delta] of perTrip) {
        await c.query(
          // Only total_expense: `trips` has no diesel_amount column in
          // PostgreSQL. The Firestore screen bumped both, but the per-fuel
          // breakdown is derivable from fuel_entries.trip_id, which is a
          // better answer than a denormalised counter that can drift from it.
          `UPDATE trips SET total_expense = COALESCE(total_expense,0) + $2::numeric,
                            updated_at = now()
            WHERE id = $1::uuid`, [tripId, delta.toFixed(2)]);
      }
      // The pump's subsidiary ledger. post_to_ledger is false because the
      // JOURNAL above already carries the Cr leg — this row is the khata entry,
      // not a second posting.
      await c.query(
        `INSERT INTO vendor_txns (vendor_id, vendor_name, txn_date, txn_type, amount, remarks, voucher_id, created_by)
         VALUES ($1::uuid,$2,$3::date,'BILL_RECEIVED',$4,$5,$6::uuid,$7)`,
        [vendor.id, vendor.vendor_name, b.to ?? new Date().toISOString().slice(0, 10),
         billAmount, `Fuel bill verified — ${slips.length} slip(s)${period}`,
         voucher?.voucher_id ?? null, b.created_by ?? null]);
      return { slips: slips.length, trips_adjusted: perTrip.size };
    });

    return { ...result, voucher_id: voucher?.voucher_id ?? null, vendor_name: vendor.vendor_name };
  });

  // ═══ SIDEBAR BADGES ═══════════════════════════════════════════════════════
  // One query for the three counts the sidebar used to keep three Firestore
  // listeners open for. Cheap enough to poll; the alternative was a websocket
  // for three integers.
  // ═══ PARTNER DOCUMENTS (116) — photos from the driver & vendor apps ══════
  // The review half of the phone-upload flow. Approving a BILL doc can file it
  // straight into expense_approvals (source PARTNER_APP) — it then waits in
  // THIS screen's money queue like any other bill, and TARA still posts the
  // only voucher. Approving a plain document just marks it verified. Either
  // decision is stamped and told to the uploader on WhatsApp.
  const DOC_EXPENSE_TYPE = {
    HSD_BILL: 'FUEL', TYRE_BILL: 'TYRE', MAINTENANCE_BILL: 'MAINTENANCE',
    TOLL_BILL: 'TOLL', OTHER_BILL: 'OTHER',
  };

  // ── SAFE SQL COMMIT (owner directive, 2026-09-02) ────────────────────────
  // The ONLY moment a driver's paper touches the core. Runs inside the approve
  // transaction with the admin's final values (b) — OCR was a proposal, the
  // desk showed it beside the photo, the admin confirmed or corrected it.
  // Every column written is listed in the returned summary (applied_to).
  const applyToCore = async (t, doc, b) => {
    const applied = { table: null, columns: [], note: null };
    const val = (k) => (b[k] === '' || b[k] === undefined ? null : b[k]);
    if (doc.uploader_role === 'DRIVER' && doc.driver_id && ['DL', 'AADHAAR', 'BANK_BOOK', 'PAN', 'HZD'].includes(doc.doc_type)) {
      applied.table = 'drivers';
      if (doc.doc_type === 'PAN') {
        await t.query(
          `UPDATE drivers SET pan_photo_url = $2, pan_no = COALESCE(NULLIF($3, ''), pan_no)
            WHERE id = $1::uuid`, [doc.driver_id, doc.file_key, val('pan_no')]);
        applied.columns = ['pan_photo_url', ...(val('pan_no') ? ['pan_no'] : [])];
      } else if (doc.doc_type === 'HZD') {
        await t.query(
          `UPDATE drivers SET hzd_photo_url = $2,
                  hzd_cert_no = COALESCE(NULLIF($3, ''), hzd_cert_no),
                  hzd_expiry = COALESCE($4::date, hzd_expiry)
            WHERE id = $1::uuid`, [doc.driver_id, doc.file_key, val('hzd_cert_no'), val('hzd_expiry')]);
        applied.columns = ['hzd_photo_url', ...(val('hzd_cert_no') ? ['hzd_cert_no'] : []), ...(val('hzd_expiry') ? ['hzd_expiry'] : [])];
      } else if (doc.doc_type === 'DL') {
        await t.query(
          `UPDATE drivers SET dl_photo_url = $2,
                  license_no = COALESCE(NULLIF($3, ''), license_no),
                  license_expiry = COALESCE($4::date, license_expiry)
            WHERE id = $1::uuid`, [doc.driver_id, doc.file_key, val('license_no'), val('license_expiry')]);
        applied.columns = ['dl_photo_url', ...(val('license_no') ? ['license_no'] : []), ...(val('license_expiry') ? ['license_expiry'] : [])];
      } else if (doc.doc_type === 'AADHAAR') {
        await t.query(
          `UPDATE drivers SET aadhar_photo_url = $2, aadhar_no = COALESCE(NULLIF($3, ''), aadhar_no)
            WHERE id = $1::uuid`, [doc.driver_id, doc.file_key, val('aadhar_no')]);
        applied.columns = ['aadhar_photo_url', ...(val('aadhar_no') ? ['aadhar_no'] : [])];
      } else {
        await t.query(
          `UPDATE drivers SET bank_photo_url = $2,
                  bank_name = COALESCE(NULLIF($3, ''), bank_name),
                  account_no = COALESCE(NULLIF($4, ''), account_no),
                  ifsc_code = COALESCE(NULLIF($5, ''), ifsc_code)
            WHERE id = $1::uuid`, [doc.driver_id, doc.file_key, val('bank_name'), val('account_no'), val('ifsc_code')]);
        applied.columns = ['bank_photo_url', ...['bank_name', 'account_no', 'ifsc_code'].filter((k) => val(k))];
      }
      return applied;
    }
    if (doc.trip_id && ['POD', 'LOADING_QTY', 'UNLOADING_QTY'].includes(doc.doc_type)) {
      applied.table = 'trips';
      const qty = b.qty === '' || b.qty == null ? (doc.qty == null ? null : Number(doc.qty)) : Number(b.qty);
      if (doc.doc_type === 'LOADING_QTY') {
        if (!(qty >= 0)) throw Object.assign(new Error('a loading quantity needs a number'), { code: 'BAD_QTY' });
        await t.query(`UPDATE trips SET driver_loaded_qty = $2 WHERE id = $1::uuid`, [doc.trip_id, qty]);
        applied.columns = ['driver_loaded_qty'];
      } else if (doc.doc_type === 'UNLOADING_QTY') {
        if (!(qty >= 0)) throw Object.assign(new Error('an unloading quantity needs a number'), { code: 'BAD_QTY' });
        await t.query(
          `UPDATE trips SET driver_unloaded_qty = $2, driver_unloading_photo = $3, office_approved_unloading = true
            WHERE id = $1::uuid`, [doc.trip_id, qty, doc.file_key]);
        applied.columns = ['driver_unloaded_qty', 'driver_unloading_photo', 'office_approved_unloading'];
      } else {
        await t.query(`UPDATE trips SET driver_unloading_photo = $2 WHERE id = $1::uuid`, [doc.trip_id, doc.file_key]);
        applied.columns = ['driver_unloading_photo'];
      }
      return applied;
    }
    // A fleet partner's vehicle paper (migration 136). The date the partner
    // typed has been sitting in partner_documents.expiry_date doing nothing;
    // THIS is where it becomes the truck's expiry, because a human just looked
    // at the document that claims it. The reviewer may correct the date in the
    // approval body — what they saw on the paper wins over what was typed.
    if (doc.uploader_role === 'VENDOR' && doc.market_vehicle_id
        && ['RC', 'INSURANCE', 'FITNESS', 'PERMIT', 'PUC'].includes(doc.doc_type)) {
      const COL = { RC: 'rc_expiry', INSURANCE: 'ins_expiry', FITNESS: 'fit_expiry', PERMIT: 'np_expiry', PUC: 'puc_expiry' }[doc.doc_type];
      const expiry = val('expiry_date') ?? doc.expiry_date ?? null;
      if (!expiry) throw Object.assign(new Error('this renewal has no expiry date to apply'), { code: 'BAD_EXPIRY' });
      await t.query(
        `UPDATE market_vehicles SET ${COL} = $2::date, updated_at = now() WHERE id = $1::uuid`,
        [doc.market_vehicle_id, expiry]);
      applied.table = 'market_vehicles';
      applied.columns = [COL];
      return applied;
    }
    applied.note = 'verified only — this kind of paper writes no core column';
    return applied;
  };

  const docWithUploader = async (id) => {
    const { rows } = await query(
      `SELECT p.*, t.trip_code, t.vehicle_no AS trip_vehicle,
              d.mobile AS driver_mobile, v.mobile_no AS vendor_mobile
         FROM partner_documents p
         LEFT JOIN trips t ON t.id = p.trip_id
         LEFT JOIN drivers d ON d.id = p.driver_id
         LEFT JOIN vendors v ON v.id = p.vendor_id
        WHERE p.id = $1::uuid`, [id]);
    return rows[0] ?? null;
  };

  app.get('/partner-documents', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const status = String(req.query?.status ?? 'PENDING').toUpperCase();
    const { rows } = await query(
      `SELECT p.*, t.trip_code
         FROM partner_documents p LEFT JOIN trips t ON t.id = p.trip_id
        WHERE ($1 = 'ALL' OR p.status = $1)
        ORDER BY p.created_at DESC LIMIT 200`, [status]);
    return { count: rows.length, documents: rows };
  });

  app.post('/partner-documents/:id/approve', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const doc = await docWithUploader(req.params.id);
    if (!doc) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (doc.status !== 'PENDING') return reply.code(409).send({ error: 'DECIDED', detail: `already ${doc.status}` });

    const isBill = Object.hasOwn(DOC_EXPENSE_TYPE, doc.doc_type);
    const fileExpense = b.file_expense !== false && isBill;   // bills auto-file unless told not to
    const amount = Number(b.amount ?? doc.amount);
    if (fileExpense && !(amount > 0)) {
      return reply.code(400).send({
        error: 'BAD_AMOUNT',
        detail: 'a bill needs its rupee amount before it can enter the expense queue — '
              + 'enter it, or approve with file_expense=false',
      });
    }

    const out = await withTransaction(async (t) => {
      let expenseId = null;
      if (fileExpense) {
        const { rows: [exp] } = await t.query(
          `INSERT INTO expense_approvals
             (trip_id, trip_ref, vehicle_no, driver_name, vendor_name, expense_type,
              bill_no, bill_date, amount, description, source, entered_by, vendor_id, file_key)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, 'PARTNER_APP', $11, $12::uuid, $13)
           RETURNING id`,
          [doc.trip_id, doc.trip_code ?? null,
           b.vehicle_no ?? doc.vehicle_no ?? doc.trip_vehicle ?? null,
           doc.uploader_role === 'DRIVER' ? doc.uploader_name : null,
           doc.uploader_role === 'VENDOR' ? doc.uploader_name : null,
           b.expense_type ?? DOC_EXPENSE_TYPE[doc.doc_type],
           b.bill_no ?? doc.bill_no, b.bill_date ?? doc.bill_date, amount,
           `[${doc.doc_type} via ${doc.uploader_role.toLowerCase()} app] ${b.description ?? doc.remarks ?? ''}`.trim(),
           b.reviewed_by ?? null,
           // The paper travels with the money row, so the Smart Approval Desk
           // shows the photo/PDF beside the amount when it decides (130).
           doc.vendor_id ?? null, doc.file_key ?? null]);
        expenseId = exp.id;
      }
      let applied = null;
      try {
        applied = await applyToCore(t, doc, b);
      } catch (e) {
        if (e.code === 'BAD_QTY') throw Object.assign(e, { statusCode: 400 });
        throw e;
      }
      const { rows: [upd] } = await t.query(
        `UPDATE partner_documents
            SET status = 'APPROVED', reviewed_by = $2, reviewed_at = now(),
                expense_approval_id = $3::uuid, applied_to = $4::jsonb,
                qty = COALESCE($5::numeric, qty), updated_at = now()
          WHERE id = $1::uuid AND status = 'PENDING' RETURNING *`,
        [doc.id, b.reviewed_by ?? null, expenseId, JSON.stringify(applied),
         b.qty === '' || b.qty == null ? null : Number(b.qty)]);
      if (!upd) throw Object.assign(new Error('already decided'), { statusCode: 409 });
      return { doc: upd, expenseId, applied };
    });

    const mobile = doc.driver_mobile ?? doc.vendor_mobile;
    if (mobile) {
      notifyWhatsApp(mobile,
        `✅ Prasad Transport: aapka ${doc.doc_type.replaceAll('_', ' ').toLowerCase()} `
        + `${doc.bill_no ? `(${doc.bill_no}) ` : ''}office ne verify kar liya hai.`
        + (out.expenseId ? ' Bill hisaab ki queue mein chala gaya hai.' : ''));
    }
    return { approved: true, ...out };
  });

  app.post('/partner-documents/:id/reject', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'reason is required — the uploader is told why' });
    const doc = await docWithUploader(req.params.id);
    if (!doc) return reply.code(404).send({ error: 'NOT_FOUND' });
    // NEEDS_CORRECTION, not a dead end (owner's Tier 4, 2026-09-02): the
    // paper goes back to the uploader's own portal with the reason, and the
    // corrected photo arrives as a new PENDING row.
    const { rows } = await query(
      `UPDATE partner_documents
          SET status = 'NEEDS_CORRECTION', reviewed_by = $2, reviewed_at = now(),
              reject_reason = $3, updated_at = now()
        WHERE id = $1::uuid AND status = 'PENDING' RETURNING *`,
      [doc.id, req.body?.reviewed_by ?? null, reason]);
    if (!rows.length) return reply.code(409).send({ error: 'DECIDED', detail: `already ${doc.status}` });
    const mobile = doc.driver_mobile ?? doc.vendor_mobile;
    if (mobile) {
      notifyWhatsApp(mobile,
        `❌ Prasad Transport: aapka ${doc.doc_type.replaceAll('_', ' ').toLowerCase()} `
        + `office ne is kaaran se wapas kiya: ${reason}. Sahi photo/detail ke saath dobara bhejein.`);
    }
    // The in-app banner beside the WhatsApp (owner, 2026-09-03: "use both").
    if (doc.uploader_role === 'DRIVER' && doc.driver_id) {
      await query(
        `INSERT INTO driver_notices (driver_id, kind, title, body, ref_table, ref_id, created_by)
         VALUES ($1::uuid, 'DOC_REJECTED', $2, $3, 'partner_documents', $4::uuid, $5)`,
        [doc.driver_id, `${doc.doc_type.replaceAll('_', ' ')} — दोबारा भेजो`, reason, doc.id, req.body?.reviewed_by ?? null])
        .catch((e) => req.log?.warn({ err: e.message }, 'driver notice not written'));
    }
    return { rejected: true, document: rows[0] };
  });

  app.get('/badges', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`
      SELECT (SELECT count(*) FROM onboarding_applications WHERE status = 'PENDING_KYC')::int AS pending_kyc,
             (SELECT count(*) FROM driver_requests        WHERE status = 'PENDING')::int   AS pending_requests,
             (SELECT count(*) FROM expense_approvals      WHERE status = 'PENDING')::int   AS pending_expenses,
             (SELECT count(*) FROM partner_documents      WHERE status = 'PENDING')::int   AS pending_partner_docs,
             -- The rest of the quarantine (2026-09-02), so the embedded Approval
             -- Desk on both dashboards shows every staging queue in one strip.
             (SELECT count(*) FROM market_vehicles   WHERE system_status = 'PENDING APPROVAL')::int AS pending_market_trucks,
             (SELECT count(*) FROM market_drivers    WHERE system_status = 'PENDING APPROVAL')::int AS pending_market_drivers,
             (SELECT count(*) FROM bazaar_loads      WHERE status = 'PENDING_REVIEW')::int          AS pending_loads_review,
             (SELECT count(*) FROM bazaar_loads      WHERE status = 'AWARD_REQUESTED')::int         AS pending_award_requests,
             (SELECT count(*) FROM bazaar_settlements WHERE status = 'POD_SUBMITTED')::int         AS pending_pods,
             (SELECT COALESCE(sum(amount), 0) FROM expense_approvals WHERE status = 'PENDING')::numeric(14,2) AS pending_expenses_amount`);
    return rows[0];
  });
}
