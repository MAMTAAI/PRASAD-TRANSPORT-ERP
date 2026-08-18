// server/modules/exceptions.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/exceptions — the things the system found and will not decide.
//
//   GET  /                    the queue
//   GET  /summary             counts and money at risk, by kind
//   GET  /:id                 one exception with its evidence
//   POST /scan                run the detectors, raise what is new
//   POST /:id/resolve         apply a chosen resolution   [guarded]
//   POST /:id/dismiss         "this is fine", with a reason [guarded]
//
// WHY THE RESOLVER LIVES HERE AND NOT IN THE BROWSER
//
// Resolving a duplicate bill moves money: it deletes a billed line, changes an
// invoice a customer has been sent, and reverses a posting in the general
// ledger. Three writes that must agree. The browser can no more be trusted to
// sequence those than it could be trusted to move the loan counters -- and for
// the same reason 035 gives: two people clicking at once would each read the
// bill, each subtract, and one correction would vanish.
//
// SO THE BUTTON SENDS AN INTENT, NOT A PLAN. The page says "keep line 692,
// remove the rest"; everything about how that becomes a bill total, a voucher
// and a deleted trip is decided here, in one transaction, against preconditions
// re-checked at the moment of the write.
//
// THE PRECONDITIONS ARE RE-CHECKED, NOT TRUSTED. An exception is raised when a
// detector runs and resolved when a person gets to it, and those can be days
// apart. In between the bill may have been paid, locked or approved. Acting on
// the state that was true at detection is how a paid invoice silently loses a
// line. Every resolver re-reads and refuses.
import { query, withTransaction, isDegraded } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';
import { requireAdminOrService } from './auth.routes.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });
const money = (v) => Number(v ?? 0);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const DEBTOR_PREFIX = 'Debtors: ';
const FREIGHT_INCOME = 'Freight Income';

/**
 * Raise an exception, or refresh the one already raised for the same thing.
 *
 * Detectors run on a schedule. Without the dedupe key the fifteen-minute cron
 * would file the same duplicate bill ninety-six times a day, and the queue that
 * exists to be read would become the log it replaced. A second sighting bumps
 * last_seen_at and the evidence; it never reopens something a person has
 * already resolved or dismissed.
 */
export async function raiseException(e, exec = query) {
  const { rows } = await exec(
    `INSERT INTO exceptions (kind, severity, title, detail, subject_type, subject_id,
            company, evidence, options, amount_at_risk, dedupe_key, detected_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
     ON CONFLICT (dedupe_key) DO UPDATE SET
            last_seen_at = now(),
            seen_count   = exceptions.seen_count + 1,
            -- Refresh only what is still open. A resolved exception keeps the
            -- evidence it was resolved on; overwriting it would rewrite history
            -- every time the detector ran again.
            evidence       = CASE WHEN exceptions.status IN ('OPEN','IN_REVIEW')
                                  THEN EXCLUDED.evidence ELSE exceptions.evidence END,
            options        = CASE WHEN exceptions.status IN ('OPEN','IN_REVIEW')
                                  THEN EXCLUDED.options ELSE exceptions.options END,
            amount_at_risk = CASE WHEN exceptions.status IN ('OPEN','IN_REVIEW')
                                  THEN EXCLUDED.amount_at_risk ELSE exceptions.amount_at_risk END,
            detail         = CASE WHEN exceptions.status IN ('OPEN','IN_REVIEW')
                                  THEN EXCLUDED.detail ELSE exceptions.detail END,
            updated_at = now()
     RETURNING id, status, seen_count, (xmax = 0) AS was_new`,
    [e.kind, e.severity ?? 'MEDIUM', e.title, e.detail ?? null,
     e.subject_type ?? null, e.subject_id ?? null, e.company ?? null,
     JSON.stringify(e.evidence ?? {}), JSON.stringify(e.options ?? []),
     e.amount_at_risk ?? null, e.dedupe_key, e.detected_by ?? 'system']);
  return rows[0];
}

/**
 * Detector: one consignment on more than one line of the same bill.
 *
 * The LR number is the consignment. Two lines carrying it is the customer being
 * charged twice for one load. It does NOT decide which line is real — the lines
 * frequently disagree about the driver, and only the physical LR settles that.
 * It states the money and hands over the choice.
 */
export async function detectDuplicateBilling(exec = query) {
  const { rows } = await exec(`SELECT * FROM v_duplicate_billing_candidates
                                WHERE overcharge > 0 ORDER BY overcharge DESC`);
  const raised = [];
  for (const c of rows) {
    const lines = c.lines_detail ?? [];
    const drivers = [...new Set(lines.map((l) => l.driver_name).filter(Boolean))];
    const orphans = lines.filter((l) => !l.trip_id).length;

    const detail =
      `LR ${c.lr_no} appears on ${c.lines} lines of bill ${c.bill_no}. `
      + `One consignment, billed ${c.lines} times: ${c.customer_name} has been charged `
      + `Rs ${money(c.billed_net).toFixed(2)} where Rs ${r2(money(c.billed_net) - money(c.overcharge)).toFixed(2)} was due.`
      + (drivers.length > 1
        ? ` The lines disagree about the driver (${drivers.join(' / ')}), so the physical LR has to settle which trip is real.`
        : '')
      + (orphans ? ` ${orphans} of the lines are not linked to a trip at all.` : '')
      + (money(c.received_amount) > 0
        ? ` NOTE: this bill has received Rs ${money(c.received_amount).toFixed(2)} — a correction now also affects money already banked.`
        : ' Nothing has been received against this bill yet.');

    const r = await raiseException({
      kind: 'DUPLICATE_BILLING',
      severity: money(c.overcharge) >= 100000 ? 'CRITICAL'
        : money(c.overcharge) >= 10000 ? 'HIGH' : 'MEDIUM',
      title: `${c.customer_name} billed ${c.lines}x for LR ${c.lr_no} (${c.bill_no})`,
      detail,
      subject_type: 'company_bill',
      subject_id: String(c.bill_id),
      company: c.company,
      amount_at_risk: c.overcharge,
      // Stable across runs: the same bill and LR is the same problem, however
      // many times the detector sees it.
      dedupe_key: `DUPLICATE_BILLING:${c.bill_id}:${c.lr_no}`,
      evidence: {
        bill_no: c.bill_no, bill_date: c.bill_date, customer_name: c.customer_name,
        bill_status: c.bill_status, approval_status: c.approval_status,
        is_locked: c.is_locked, received_amount: c.received_amount,
        lr_no: c.lr_no, lines: c.lines, billed_net: c.billed_net,
        overcharge: c.overcharge, drivers, orphan_lines: orphans,
        lines_detail: lines,
      },
      options: [{
        action: 'KEEP_ONE_LINE',
        label: 'Keep one line, remove the rest and reverse the overcharge',
        destructive: true,
        // The reviewer must say WHICH. There is no safe default when the lines
        // name different drivers.
        params_required: ['keep_bill_line_id'],
        params_optional: ['delete_orphan_trips'],
      }],
      detected_by: 'detector:duplicate_billing',
    }, exec);
    raised.push({ ...r, bill_no: c.bill_no, lr_no: c.lr_no, overcharge: c.overcharge });
  }
  return raised;
}

/**
 * Resolve a duplicate bill: keep one line, remove the rest, reverse the money.
 *
 * ORDER MATTERS AND IT IS DELIBERATE. The ledger reversal is posted FIRST, with
 * a reference derived from the exception id. If the database step then fails,
 * the voucher exists and the bill is untouched — visible, and a retry is
 * refused as DUPLICATE_REF rather than posting the reversal twice. The opposite
 * order would leave a corrected bill and a general ledger that still carries
 * the overcharge, which is the failure nobody notices.
 */
async function resolveDuplicateBilling(exc, params, actor) {
  const keepId = Number(params?.keep_bill_line_id);
  if (!Number.isFinite(keepId)) {
    const err = new Error('keep_bill_line_id is required — the lines name different drivers, so there is no safe default');
    err.code = 'CHOICE_REQUIRED';
    throw err;
  }

  const billId = exc.subject_id;
  const lrNo = exc.evidence?.lr_no;

  // ── preconditions, re-read now ──────────────────────────────────────────
  const { rows: [bill] } = await query(
    `SELECT id, bill_no, customer_name, company, status, approval_status, is_locked,
            COALESCE(received_amount,0) AS received_amount, voucher_id
       FROM company_bills WHERE id = $1::uuid`, [billId]);
  if (!bill) { const e = new Error('bill no longer exists'); e.code = 'GONE'; throw e; }
  if (bill.is_locked) { const e = new Error(`bill ${bill.bill_no} is locked`); e.code = 'BILL_LOCKED'; throw e; }
  if (money(bill.received_amount) > 0) {
    const e = new Error(
      `bill ${bill.bill_no} has received ${money(bill.received_amount).toFixed(2)} since this was raised — `
      + 'correcting it now would also change money already banked. Reverse the receipt first.');
    e.code = 'BILL_PAID'; throw e;
  }

  const { rows: lines } = await query(
    `SELECT id, trip_id, trip_code, driver_name, net_payable, gross_freight
       FROM company_bill_trips WHERE bill_id = $1::uuid AND lr_no = $2 ORDER BY id`,
    [billId, lrNo]);
  if (lines.length < 2) {
    const e = new Error('this bill no longer has duplicate lines for that LR — already resolved?');
    e.code = 'ALREADY_RESOLVED'; throw e;
  }
  const keep = lines.find((l) => Number(l.id) === keepId);
  if (!keep) { const e = new Error(`line ${keepId} is not one of this LR's lines`); e.code = 'BAD_CHOICE'; throw e; }

  const drop = lines.filter((l) => Number(l.id) !== keepId);
  const overcharge = r2(drop.reduce((a, l) => a + money(l.net_payable), 0));
  const overGross = r2(drop.reduce((a, l) => a + money(l.gross_freight), 0));
  if (!(overcharge > 0)) {
    const e = new Error('the lines to remove carry no value — nothing to reverse'); e.code = 'NO_AMOUNT'; throw e;
  }

  // ── 1. reverse the money, first, with a reference a retry cannot double ──
  const debtorLedger = DEBTOR_PREFIX + bill.customer_name;
  const refNo = `EXCFIX-${exc.id}`;
  let voucherId = null;
  try {
    const v = await postVoucher({
      type: 'JOURNAL',
      source_type: 'BILL_DUPLICATE_REVERSAL',
      ref_no: refNo,
      entry_date: new Date().toISOString().slice(0, 10),
      narration: `Duplicate billing corrected — ${bill.bill_no}, LR ${lrNo}: `
               + `${drop.length} duplicate line(s) removed, ${overcharge.toFixed(2)} reversed`,
      created_by: actor,
      lines: [
        { ledger: FREIGHT_INCOME, dr_cr: 'DR', amount: overcharge, group: 'Direct Income' },
        { ledger: debtorLedger, dr_cr: 'CR', amount: overcharge, group: 'Sundry Debtors (Customers)' },
      ],
    });
    voucherId = v?.voucher_id ?? null;
  } catch (e) {
    if (e.code !== 'DUPLICATE_REF') throw e;
    // A previous attempt posted it and then failed. Reuse it rather than
    // posting a second reversal.
    const { rows: [prev] } = await query(
      `SELECT voucher_id FROM ledger_entries WHERE source_ref = $1 LIMIT 1`, [refNo]);
    voucherId = prev?.voucher_id ?? null;
  }

  // ── 2. the bill, its lines and (optionally) the orphaned trips ───────────
  const result = await withTransaction(async (t) => {
    const ids = drop.map((l) => l.id);
    await t.query(`DELETE FROM company_bill_trips WHERE id = ANY($1::bigint[])`, [ids]);

    // Totals are RECOMPUTED from the surviving lines, never adjusted by
    // subtraction. A subtracted total is right once; a recomputed one is right
    // every time, including when somebody has edited a line in between.
    const { rows: [sum] } = await t.query(
      `SELECT COALESCE(SUM(gross_freight),0)::numeric(14,2) gross,
              COALESCE(SUM(shortage_amt),0)::numeric(14,2)  shortage,
              COALESCE(SUM(tds_amt),0)::numeric(14,2)       tds,
              COALESCE(SUM(cgst_amt),0)::numeric(14,2)      cgst,
              COALESCE(SUM(sgst_amt),0)::numeric(14,2)      sgst,
              COALESCE(SUM(igst_amt),0)::numeric(14,2)      igst,
              COALESCE(SUM(net_payable),0)::numeric(14,2)   net
         FROM company_bill_trips WHERE bill_id = $1::uuid`, [billId]);
    await t.query(
      `UPDATE company_bills SET total_gross=$2, total_shortage=$3, total_tds=$4,
              total_cgst=$5, total_sgst=$6, total_igst=$7, total_net=$8, updated_at=now()
        WHERE id=$1::uuid`,
      [billId, sum.gross, sum.shortage, sum.tds, sum.cgst, sum.sgst, sum.igst, sum.net]);

    // Trips are only removed when the reviewer asked AND nothing else points at
    // them. A trip that carries fuel, tolls or a settlement is history, not a
    // stray row, and it stays.
    const deletedTrips = [];
    const keptTrips = [];
    if (params?.delete_orphan_trips) {
      for (const l of drop) {
        if (!l.trip_id) continue;
        const { rows: [refs] } = await t.query(
          `SELECT (SELECT count(*) FROM company_bill_trips WHERE trip_id=$1::uuid) bills,
                  (SELECT count(*) FROM trip_settlements  WHERE trip_id=$1::uuid) settlements,
                  (SELECT count(*) FROM driver_transactions WHERE trip_id=$1::uuid) driver_txns,
                  (SELECT count(*) FROM fuel_entries      WHERE trip_id=$1::uuid) fuel,
                  (SELECT count(*) FROM toll_transactions WHERE trip_id=$1::uuid) tolls`,
          [l.trip_id]);
        const busy = Object.entries(refs).filter(([, n]) => Number(n) > 0);
        if (busy.length) { keptTrips.push({ trip_code: l.trip_code, still_referenced_by: Object.fromEntries(busy) }); continue; }
        await t.query(`DELETE FROM trips WHERE id = $1::uuid`, [l.trip_id]);
        deletedTrips.push(l.trip_code ?? l.trip_id);
      }
    }
    return { totals: sum, deletedTrips, keptTrips };
  });

  return {
    action: 'KEEP_ONE_LINE',
    bill_no: bill.bill_no,
    lr_no: lrNo,
    kept_line: { id: keep.id, trip_code: keep.trip_code, driver_name: keep.driver_name },
    removed_lines: drop.map((l) => ({ id: l.id, trip_code: l.trip_code, driver_name: l.driver_name, net_payable: l.net_payable })),
    reversed_amount: overcharge,
    reversed_gross: overGross,
    reversal_voucher_id: voucherId,
    bill_total_net_now: result.totals.net,
    trips_deleted: result.deletedTrips,
    trips_kept_because_referenced: result.keptTrips,
  };
}

const RESOLVERS = {
  DUPLICATE_BILLING: { KEEP_ONE_LINE: resolveDuplicateBilling },
};

export async function registerExceptionRoutes(app, opts = {}) {
  // Reading the queue is not guarded: an operator should be able to see what is
  // wrong. Acting on it moves money, and is.
  const guard = opts.requireAdmin || requireAdminOrService;

  app.get('/', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { status = null, kind = null, limit = 200 } = req.query ?? {};
    const { rows } = await query(
      `SELECT * FROM v_exception_queue
        WHERE ($1::text IS NULL OR status = $1)
          AND ($2::text IS NULL OR kind = $2)
        ORDER BY severity_rank, amount_at_risk DESC NULLS LAST, detected_at
        LIMIT $3`,
      [status, kind, Math.min(Number(limit) || 200, 500)]);
    const { rows: [tot] } = await query(
      `SELECT count(*)::int open, COALESCE(SUM(amount_at_risk),0)::numeric(14,2) amount_at_risk
         FROM v_exception_queue`);
    return { count: rows.length, totals: tot, exceptions: rows };
  });

  app.get('/summary', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`SELECT * FROM v_exception_summary ORDER BY kind, status`);
    return { summary: rows };
  });

  app.get('/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows: [e] } = await query(`SELECT * FROM exceptions WHERE id = $1::uuid`, [req.params.id]);
    if (!e) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { exception: e };
  });

  // Runs every detector and raises what is new. Safe to call repeatedly — the
  // dedupe key is what makes that true.
  app.post('/scan', { preHandler: guard }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const dup = await detectDuplicateBilling();
    return {
      ok: true,
      detectors: [{ kind: 'DUPLICATE_BILLING', found: dup.length,
                    new: dup.filter((d) => d.was_new).length,
                    amount_at_risk: r2(dup.reduce((a, d) => a + money(d.overcharge), 0)) }],
      raised: dup,
    };
  });

  app.post('/:id/resolve', { preHandler: guard }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { action, params = {}, note = null } = req.body ?? {};
    const actor = req.user?.name || req.user?.sub || 'staff';

    const { rows: [exc] } = await query(`SELECT * FROM exceptions WHERE id = $1::uuid`, [req.params.id]);
    if (!exc) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (exc.status === 'RESOLVED' || exc.status === 'DISMISSED') {
      return reply.code(409).send({ error: 'ALREADY_CLOSED', detail: `already ${exc.status}` });
    }
    const fn = RESOLVERS[exc.kind]?.[action];
    if (!fn) return reply.code(400).send({ error: 'NO_SUCH_ACTION', detail: `${exc.kind} has no action '${action}'` });

    try {
      const result = await fn(exc, params, actor);
      await query(
        `UPDATE exceptions SET status='RESOLVED', resolution=$2, resolution_note=$3,
                resolved_by=$4, resolved_at=now(), resolution_result=$5::jsonb
          WHERE id=$1::uuid`,
        [exc.id, action, note, actor, JSON.stringify(result)]);
      return { ok: true, resolved: true, result };
    } catch (e) {
      // A refusal is information, not a crash: it tells the reviewer what
      // changed since the exception was raised.
      const known = ['CHOICE_REQUIRED', 'BILL_LOCKED', 'BILL_PAID', 'ALREADY_RESOLVED',
                     'BAD_CHOICE', 'GONE', 'NO_AMOUNT'];
      if (known.includes(e.code)) {
        return reply.code(409).send({ error: e.code, detail: e.message });
      }
      req.log?.error({ err: e.message, exception: exc.id }, 'exception resolve failed');
      return reply.code(500).send({ error: 'RESOLVE_FAILED', detail: String(e.message).slice(0, 400) });
    }
  });

  // ── the department inbox ─────────────────────────────────────────────────
  // Zero-Gap: every failure the system could not resolve, routed to the desk
  // that can act on it, carrying the three things a person needs — why it
  // stopped, how it got here, and what to do about it.
  app.get(
    '/departments',
    { schema: { querystring: { type: 'object', properties: {
      department: { type: ['string', 'null'], enum: ['OPERATIONS', 'ACCOUNTING', 'CRM', 'COMPLIANCE', 'IT', null] },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { department = null, limit = 100 } = req.query ?? {};
      const { rows: summary } = await query('SELECT * FROM v_department_queue_summary ORDER BY open_items DESC');
      const { rows: items } = await query(
        `SELECT * FROM v_department_queue
          WHERE ($1::text IS NULL OR department = $1)
          ORDER BY CASE severity WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 3
                                 WHEN 'MEDIUM' THEN 2 ELSE 1 END DESC,
                   COALESCE(amount_at_risk, 0) DESC, detected_at DESC
          LIMIT $2`, [department, limit]);
      return { total: items.length, summary, items };
    }
  );

  app.post('/:id/dismiss', { preHandler: guard }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const note = req.body?.note;
    // A dismissal without a reason is indistinguishable from someone clearing
    // their inbox, and the next person cannot tell which it was.
    if (!note || String(note).trim().length < 5) {
      return reply.code(400).send({ error: 'REASON_REQUIRED',
        detail: 'say why this is not a problem — a dismissal with no reason cannot be reviewed later' });
    }
    const actor = req.user?.name || req.user?.sub || 'staff';
    const { rows } = await query(
      `UPDATE exceptions SET status='DISMISSED', resolution='DISMISSED', resolution_note=$2,
              resolved_by=$3, resolved_at=now()
        WHERE id=$1::uuid AND status IN ('OPEN','IN_REVIEW') RETURNING id`,
      [req.params.id, String(note).trim(), actor]);
    if (!rows.length) return reply.code(409).send({ error: 'ALREADY_CLOSED' });
    return { ok: true, dismissed: true };
  });
}
