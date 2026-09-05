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
            -- Title and severity refresh too, for the same reason and under the
            -- same guard. They did not, and a detector that had narrowed its
            -- finding still announced the old one: after the company-master
            -- conflict test stopped counting "State Bank of India" vs "State
            -- Bank Of India", the evidence correctly held one conflict while the
            -- headline still read "2 conflicts". The headline is the only part
            -- most readers see.
            title          = CASE WHEN exceptions.status IN ('OPEN','IN_REVIEW')
                                  THEN EXCLUDED.title ELSE exceptions.title END,
            severity       = CASE WHEN exceptions.status IN ('OPEN','IN_REVIEW')
                                  THEN EXCLUDED.severity ELSE exceptions.severity END,
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


// ═══════════════════════════════════════════════════════════════════════════
// STAFF PENDING TASKS — three faults the 20-08-2026 loading import surfaced.
//
// The owner's instruction was that none of these may be auto-fixed. Each needs
// somebody who knows the business to state the right value, so each detector
// states the problem and offers an EDIT action, and the resolver re-reads the
// world before it writes. Migration 104 carries the reasoning in full.
// ═══════════════════════════════════════════════════════════════════════════

/** Fields a tax invoice cannot practically go out without. */
const INVOICE_CRITICAL_FIELDS = [
  ['gstin', 'GSTIN'],
  ['pan_no', 'PAN'],
  ['account_no', 'Bank A/c No.'],
  ['ifsc_code', 'IFSC'],
  ['bank_name', 'Bank Name'],
  ['address', 'Address'],
];

// Values READ OFF THE OWNER'S SIGNED INVOICES on 20-08-2026. This is document
// evidence, not something the database can derive, so it is written down here
// where it is visible rather than buried in a detector's logic. It is only ever
// used to ASK a staff member to check — nothing is ever written from it.
const OBSERVED_ON_SIGNED_DOCS = {
  'M/S PRASAD TRANSPORT': {
    source: 'Aadhar Green Tax Invoice PT/26-27/0002 dated 30-Apr-26',
    gstin: '18AAKFP2339R2ZG',
    account_no: '41365145913',
    ifsc_code: 'SBIN0007171',
    bank_name: 'State Bank Of India',
    pan_no: 'AAKFP2339R',
  },
};

/** dd-mm-yyyy for prose, tolerant of a Date or an ISO string. */
function dmyish(d) {
  if (!d) return '?';
  const s = (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
  const [y, m, dd] = s.split('-');
  return y && m && dd ? `${dd}-${m}-${y}` : s;
}

/**
 * Detector: trips with no customer.
 *
 * customer_name is a grouping key for every invoice this ERP raises, so a trip
 * without one is not "missing a label" — it is a load no bill will ever pick
 * up. Grouped by operating company and by whether an IOCL invoice number is
 * present, because those two facts are what narrow the answer, and a staff
 * member fixing 44 IOCL loads should do it as one act rather than 44.
 *
 * It does NOT fill in IOCL for the ones carrying an IOCL invoice number. That
 * is a very good guess, and a guess is exactly what must not be written into
 * the field that decides who gets billed.
 */
// ── The customer bill's reconciliation, on the board (migration 163) ─────────
//
// Owner, 5-Sep-2026: "error / missing trip ko dashboard par show karega." A
// trip IOCL did not bill, a bill somebody disputed, and a line of THEIRS with
// no trip of ours — each is money and each is a task for a person. Idempotent
// by bill: the row updates as the counts move and closes itself when they hit
// zero (the board's dedupe handles the update; a zero count is skipped, so an
// existing row simply stops being seen).
export async function detectCustomerRecon(exec = query) {
  const { rows } = await exec(`
    SELECT b.id, b.bill_no, b.customer_name, b.company_name, b.cycle_label, b.status,
           b.missing_count, b.missing_amount, b.pending_count, b.pending_amount,
           b.short_count, b.short_amount, b.unpriced_count,
           b.their_unmatched, b.their_unmatched_amount, b.disputes
      FROM v_customer_bill b
     WHERE b.status <> 'CANCELLED'
       AND (b.missing_count > 0 OR b.their_unmatched > 0 OR b.status = 'DISPUTED')`).catch(() => ({ rows: [] }));
  const raised = [];
  for (const b of rows) {
    if (Number(b.missing_count) > 0) {
      raised.push(await raiseException({
        kind: 'MISSING_FREIGHT',
        severity: Number(b.missing_amount) >= 100000 ? 'HIGH' : 'MEDIUM',
        title: `${b.missing_count} trip IOCL ke bill me nahi — ${b.customer_name}, ${b.cycle_label}`,
        detail: `${b.customer_name} ne is pakhwade ke bill bheje hain par hamare ${b.missing_count} trip (${Number(b.missing_amount).toLocaleString('en-IN')} rupaye) kisi bill me nahi hain. `
              + `Bill ${b.bill_no} kholiye → milaan → dispute uthaiye ya trip ka invoice number bhariye.`,
        subject_type: 'customer_bill', subject_id: b.id, company: b.company_name ?? null,
        amount_at_risk: Number(b.missing_amount) || null,
        dedupe_key: `MISSING_FREIGHT:${b.id}`,
        evidence: { bill_no: b.bill_no, missing_count: b.missing_count, missing_amount: b.missing_amount, status: b.status },
      }));
    }
    if (Number(b.their_unmatched) > 0) {
      raised.push(await raiseException({
        kind: 'UNMATCHED_CUSTOMER_LINE',
        severity: 'MEDIUM',
        title: `${b.their_unmatched} line IOCL ke bill me, hamara trip nahi — ${b.cycle_label}`,
        detail: `IOCL ke transportation bill me ${b.their_unmatched} line (${Number(b.their_unmatched_amount).toLocaleString('en-IN')} rupaye) hain jinka hamare register me trip nahi mila. `
              + `Ya trip register me nahi bana, ya lorry/tareekh alag likhi hai. Bill ${b.bill_no} → milaan → "Trip jodo".`,
        subject_type: 'customer_bill', subject_id: b.id, company: b.company_name ?? null,
        amount_at_risk: Number(b.their_unmatched_amount) || null,
        dedupe_key: `UNMATCHED_CUSTOMER_LINE:${b.id}`,
        evidence: { bill_no: b.bill_no, lines: b.their_unmatched, amount: b.their_unmatched_amount },
      }));
    }
    if (b.status === 'DISPUTED') {
      const d = Array.isArray(b.disputes) ? b.disputes : [];
      raised.push(await raiseException({
        kind: 'CUSTOMER_DISPUTE',
        severity: 'HIGH',
        title: `Dispute khula — ${b.customer_name}, ${b.cycle_label} (${d.length} baat)`,
        detail: d.map((x) => `${x.trip_code || ''} ${x.kind}: ${Number(x.amount || 0).toLocaleString('en-IN')} — ${x.note || ''}`).join(' · ').slice(0, 900)
              || 'Bill par dispute darj hai.',
        subject_type: 'customer_bill', subject_id: b.id, company: b.company_name ?? null,
        amount_at_risk: d.reduce((n, x) => n + (Number(x.amount) || 0), 0) || null,
        dedupe_key: `CUSTOMER_DISPUTE:${b.id}`,
        evidence: { bill_no: b.bill_no, disputes: d },
      }));
    }
  }
  return raised;
}

export async function detectBlankCustomer(exec = query) {
  const { rows } = await exec(`
    SELECT COALESCE(btrim(t.operating_company), '(no company)')   AS company,
           (t.iocl_invoice_no IS NOT NULL)                        AS has_iocl_invoice,
           count(*)::int                                          AS trips,
           min(t.loading_date)                                    AS first_load,
           max(t.loading_date)                                    AS last_load,
           count(*) FILTER (WHERE bt.trip_id IS NOT NULL)::int    AS already_billed,
           array_agg(t.id::text ORDER BY t.loading_date)          AS trip_ids,
           (array_agg(COALESCE(NULLIF(btrim(t.trip_code), ''), t.challan_no, t.id::text)
                      ORDER BY t.loading_date))[1:25]             AS sample_trip_codes
      FROM trips t
      LEFT JOIN company_bill_trips bt ON bt.trip_id = t.id
     WHERE t.customer_name IS NULL OR btrim(t.customer_name) = ''
     GROUP BY 1, 2
     ORDER BY 3 DESC`);

  const raised = [];
  for (const g of rows) {
    const hint = g.has_iocl_invoice
      ? 'Every trip in this group carries an IOCL invoice number, so the customer is almost certainly INDIAN OIL CORPORATION LTD — confirm and apply.'
      : 'None of these carry an IOCL invoice number, so the customer has to come from the loading paperwork.';
    const detail =
      `${g.trips} trips under ${g.company} have no customer name `
      + `(${dmyish(g.first_load)} to ${dmyish(g.last_load)}). Customer is the grouping key for every `
      + `invoice, so these loads are invisible to fortnightly and monthly billing alike — they will never `
      + `appear on a bill until this is filled in. ${hint}`
      + (g.already_billed ? ` ${g.already_billed} of them are already attached to a raised bill and will be skipped.` : '');

    const r = await raiseException({
      kind: 'BLANK_CUSTOMER',
      severity: g.trips >= 40 ? 'HIGH' : g.trips >= 10 ? 'MEDIUM' : 'LOW',
      title: `${g.trips} trips with no customer — ${g.company}${g.has_iocl_invoice ? ' (carry IOCL invoice no.)' : ''}`,
      detail,
      subject_type: 'trips',
      subject_id: null,
      company: g.company,
      dedupe_key: `BLANK_CUSTOMER:${g.company}:${g.has_iocl_invoice ? 'iocl' : 'no-iocl'}`,
      evidence: {
        company: g.company,
        has_iocl_invoice: g.has_iocl_invoice,
        trips: g.trips,
        already_billed: g.already_billed,
        first_load: g.first_load,
        last_load: g.last_load,
        trip_ids: g.trip_ids,
        sample_trip_codes: g.sample_trip_codes,
        suggested_customer: g.has_iocl_invoice ? 'INDIAN OIL CORPORATION LTD' : null,
      },
      options: [{
        action: 'SET_CUSTOMER',
        label: 'Set the customer on these trips',
        destructive: false,
        params_required: ['customer_name'],
        params_optional: ['trip_ids'],
      }],
      detected_by: 'detector:blank_customer',
    }, exec);
    raised.push({ ...r, company: g.company, trips: g.trips });
  }
  return raised;
}

/**
 * Detector: company master fields an invoice cannot go out without.
 *
 * The bill templates print the seller block straight from `companies`. GSTIN is
 * blank on all three firms while the owner's own signed invoice prints one, so
 * every auto-generated invoice would carry no GSTIN at all — a document the
 * customer's GST return cannot accept and will send back.
 */
export async function detectCompanyMasterGaps(exec = query) {
  const { rows } = await exec(`
    SELECT c.id, btrim(c.company_name) AS company_name,
           c.gstin, c.pan_no, c.account_no, c.ifsc_code, c.bank_name, c.address,
           (SELECT count(*)::int FROM trips t
             WHERE btrim(COALESCE(t.operating_company, '')) = btrim(c.company_name)) AS trips
      FROM companies c
     WHERE COALESCE(c.status, 'ACTIVE') <> 'INACTIVE'
     ORDER BY 2`);

  const raised = [];
  for (const c of rows) {
    const missing = INVOICE_CRITICAL_FIELDS
      .filter(([col]) => !String(c[col] ?? '').trim())
      .map(([col, label]) => ({ field: col, label }));

    const seen = OBSERVED_ON_SIGNED_DOCS[c.company_name] ?? null;
    // A field the master HAS but the signed document contradicts. Reported, not
    // corrected: only the firm knows which account is the live one today.
    // Compared case- and spacing-insensitively. "State Bank of India" versus
    // "State Bank Of India" is not a conflict, and showing it as one trains the
    // reader to skim past the line that IS one -- the account number.
    const same = (a, b) => String(a ?? '').trim().replace(/\s+/g, ' ').toUpperCase()
                        === String(b ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
    const conflicts = seen
      ? Object.entries(seen)
        .filter(([k]) => k !== 'source')
        .filter(([k, v]) => String(c[k] ?? '').trim() && !same(c[k], v))
        .map(([field, on_document]) => ({ field, in_master: String(c[field]).trim(), on_document }))
      : [];

    if (!missing.length && !conflicts.length) continue;

    const bits = [];
    if (missing.length) {
      bits.push(`${missing.map((m) => m.label).join(', ')} ${missing.length === 1 ? 'is' : 'are'} blank`);
    }
    if (conflicts.length) {
      bits.push(conflicts.map((x) =>
        `${x.field} is "${x.in_master}" here but "${x.on_document}" on ${seen.source}`).join('; '));
    }
    const detail =
      `The bill template prints the seller block from the company master, so whatever is missing or wrong `
      + `here goes out on every invoice raised under ${c.company_name}. ${bits.join('. ')}. `
      + `${c.trips} trips are booked to this firm.`
      + (conflicts.length
        ? ' A conflicting bank account is the one that costs money: the customer pays where the invoice tells them to.'
        : '');

    const r = await raiseException({
      kind: 'MASTER_DATA_GAP',
      severity: conflicts.some((x) => x.field === 'account_no') ? 'CRITICAL'
        : missing.some((m) => m.field === 'gstin') ? 'HIGH' : 'MEDIUM',
      title: `${c.company_name}: ${[
        missing.length ? `${missing.length} invoice field${missing.length === 1 ? '' : 's'} blank` : null,
        conflicts.length ? `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} with the signed invoice` : null,
      ].filter(Boolean).join(', ')}`,
      detail,
      subject_type: 'company',
      subject_id: String(c.id),
      company: c.company_name,
      // Keyed on the company, not the field list: as fields get filled the same
      // exception narrows, rather than a new one appearing on every run.
      dedupe_key: `MASTER_DATA_GAP:${c.id}`,
      evidence: {
        company_id: c.id,
        company_name: c.company_name,
        trips: c.trips,
        missing,
        conflicts,
        observed_source: seen ? seen.source : null,
        current: {
          gstin: c.gstin, pan_no: c.pan_no, account_no: c.account_no,
          ifsc_code: c.ifsc_code, bank_name: c.bank_name, address: c.address,
        },
      },
      options: [{
        action: 'UPDATE_COMPANY',
        label: 'Fill in / correct the company master',
        destructive: false,
        params_required: ['fields'],
        params_optional: [],
      }],
      detected_by: 'detector:company_master_gaps',
    }, exec);
    raised.push({ ...r, company: c.company_name, missing: missing.length, conflicts: conflicts.length });
  }
  return raised;
}

/**
 * Detector: trips booked to a firm that does not bill that customer.
 *
 * operating_company decides GSTIN, letterhead, bank account and invoice series.
 * A trip under the wrong one is the wrong legal entity invoicing the customer,
 * which is a tax position rather than a typo. The expected firm comes from
 * customer_billing_entity — a table staff can edit — so this detector holds no
 * opinion of its own and stops being right the moment a contract moves.
 */
export async function detectEntityMismatch(exec = query) {
  const { rows } = await exec(`
    SELECT r.customer_label, r.expected_company, r.vendor_code, r.source,
           COALESCE(btrim(t.operating_company), '(no company)')  AS actual_company,
           count(*)::int                                         AS trips,
           min(t.loading_date)                                   AS first_load,
           max(t.loading_date)                                   AS last_load,
           count(*) FILTER (WHERE bt.trip_id IS NOT NULL)::int   AS already_billed,
           array_agg(t.id::text ORDER BY t.loading_date)         AS trip_ids,
           (array_agg(COALESCE(NULLIF(btrim(t.trip_code), ''), t.challan_no, t.id::text)
                      ORDER BY t.loading_date))[1:25]            AS sample_trip_codes
      FROM customer_billing_entity r
      JOIN trips t ON t.customer_name ~* r.customer_pattern
      LEFT JOIN company_bill_trips bt ON bt.trip_id = t.id
     WHERE r.active
       AND btrim(COALESCE(t.operating_company, '')) IS DISTINCT FROM r.expected_company
     GROUP BY 1, 2, 3, 4, 5
     ORDER BY 6 DESC`);

  const raised = [];
  for (const g of rows) {
    const detail =
      `${g.trips} ${g.customer_label} trips are booked to ${g.actual_company}, but ${g.customer_label} is `
      + `billed by ${g.expected_company}${g.vendor_code ? ` (vendor ${g.vendor_code})` : ''}. `
      + `Loads ran ${dmyish(g.first_load)} to ${dmyish(g.last_load)}. The operating company decides the GSTIN, `
      + `letterhead, bank account and invoice series on the bill, so this is the wrong legal entity invoicing `
      + `the customer — not a label. Basis: ${g.source}`
      + (g.already_billed
        ? ` WARNING: ${g.already_billed} of these are already on a raised bill. Moving a billed trip changes an `
          + `invoice the customer has been sent, so those are refused here and need the bill cancelled first.`
        : ' None are on a raised bill yet, so moving them changes nothing a customer has already seen.');

    const r = await raiseException({
      kind: 'ENTITY_MISMATCH',
      severity: g.already_billed > 0 ? 'CRITICAL' : g.trips >= 20 ? 'HIGH' : 'MEDIUM',
      title: `${g.trips} ${g.customer_label} trips under ${g.actual_company}, should be ${g.expected_company}`,
      detail,
      subject_type: 'trips',
      subject_id: null,
      company: g.actual_company,
      dedupe_key: `ENTITY_MISMATCH:${g.customer_label}:${g.actual_company}`,
      evidence: {
        customer_label: g.customer_label,
        expected_company: g.expected_company,
        actual_company: g.actual_company,
        vendor_code: g.vendor_code,
        rule_source: g.source,
        trips: g.trips,
        already_billed: g.already_billed,
        first_load: g.first_load,
        last_load: g.last_load,
        trip_ids: g.trip_ids,
        sample_trip_codes: g.sample_trip_codes,
      },
      options: [{
        action: 'SET_OPERATING_COMPANY',
        label: `Move these trips to ${g.expected_company}`,
        destructive: false,
        params_required: ['company'],
        params_optional: ['trip_ids'],
      }],
      detected_by: 'detector:entity_mismatch',
    }, exec);
    raised.push({ ...r, customer: g.customer_label, trips: g.trips });
  }
  return raised;
}

/** The set of trips an action applies to: the caller's subset, or all of them. */
function scopeTripIds(exc, params) {
  const all = ((exc.evidence && exc.evidence.trip_ids) || []).map(String);
  const asked = Array.isArray(params && params.trip_ids) ? params.trip_ids.map(String) : null;
  if (!asked) return all;
  const allowed = new Set(all);
  const bad = asked.filter((id) => !allowed.has(id));
  if (bad.length) {
    const e = new Error(`${bad.length} of the trip ids are not part of this exception`);
    e.code = 'BAD_CHOICE'; throw e;
  }
  return asked;
}

/** Staff fills in the customer. Refuses a customer that is not in the master. */
async function resolveBlankCustomer(exc, params, actor) {
  const name = String((params && params.customer_name) ?? '').trim();
  if (!name) {
    const e = new Error('customer_name is required — the ERP will not guess who to bill');
    e.code = 'CHOICE_REQUIRED'; throw e;
  }
  const ids = scopeTripIds(exc, params);
  if (!ids.length) { const e = new Error('no trips left in this exception'); e.code = 'GONE'; throw e; }

  // Master check. Free text here is how one customer becomes three spellings and
  // three invoices — the mistake operating_company already made in this database.
  const { rows: [cust] } = await query(
    `SELECT id, customer_name FROM customers
      WHERE lower(regexp_replace(customer_name, '[^a-zA-Z0-9]+', ' ', 'g'))
          = lower(regexp_replace($1,            '[^a-zA-Z0-9]+', ' ', 'g'))
      LIMIT 1`, [name]);
  if (!cust) {
    const e = new Error(`"${name}" is not in the customer master — add it there first so every bill spells it the same way`);
    e.code = 'BAD_CHOICE'; throw e;
  }

  return withTransaction(async (tx) => {
    // Re-read: only trips STILL blank and NOT already billed.
    const { rows: upd } = await tx(
      `UPDATE trips t
          SET customer_id = $2::uuid, customer_name = $3, updated_at = now()
        WHERE t.id = ANY($1::uuid[])
          AND (t.customer_name IS NULL OR btrim(t.customer_name) = '')
          AND NOT EXISTS (SELECT 1 FROM company_bill_trips bt WHERE bt.trip_id = t.id)
        RETURNING t.id, t.trip_code`,
      [ids, cust.id, cust.customer_name]);
    const skipped = ids.length - upd.length;
    return {
      customer_id: cust.id,
      customer_name: cust.customer_name,
      requested: ids.length,
      updated: upd.length,
      skipped,
      skipped_reason: skipped ? 'already had a customer, or are attached to a raised bill' : null,
      actor,
    };
  });
}

/** Staff corrects the company master. Only the invoice-critical fields. */
async function resolveCompanyMasterGap(exc, params, actor) {
  const EDITABLE = new Set(
    INVOICE_CRITICAL_FIELDS.map(([c]) => c).concat(['email', 'phone', 'city', 'state', 'pincode']),
  );
  const fields = params && params.fields && typeof params.fields === 'object' ? params.fields : null;
  if (!fields || !Object.keys(fields).length) {
    const e = new Error('fields is required — send the values to write, e.g. { "gstin": "18AAKFP2339R2ZG" }');
    e.code = 'CHOICE_REQUIRED'; throw e;
  }
  const bad = Object.keys(fields).filter((k) => !EDITABLE.has(k));
  if (bad.length) {
    const e = new Error(`not editable here: ${bad.join(', ')}`);
    e.code = 'BAD_CHOICE'; throw e;
  }
  // A GSTIN that is not a GSTIN prints on every invoice until somebody notices.
  const gstin = String(fields.gstin ?? '').trim().toUpperCase();
  if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(gstin)) {
    const e = new Error(`"${gstin}" is not a valid GSTIN (15 chars: 2 state digits, PAN, entity code, Z, check digit)`);
    e.code = 'BAD_CHOICE'; throw e;
  }
  const pan = String(fields.pan_no ?? '').trim().toUpperCase();
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) {
    const e = new Error(`"${pan}" is not a valid PAN`);
    e.code = 'BAD_CHOICE'; throw e;
  }

  const companyId = (exc.evidence && exc.evidence.company_id) || exc.subject_id;
  const { rows: [before] } = await query('SELECT * FROM companies WHERE id = $1::uuid', [companyId]);
  if (!before) { const e = new Error('company no longer exists'); e.code = 'GONE'; throw e; }

  const cols = Object.keys(fields);
  const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const vals = cols.map((c) => {
    const v = String(fields[c] ?? '').trim();
    return (c === 'gstin' || c === 'pan_no' || c === 'ifsc_code') ? v.toUpperCase() : v;
  });
  const { rows: [after] } = await query(
    `UPDATE companies SET ${sets}, updated_at = now() WHERE id = $1::uuid RETURNING *`,
    [companyId, ...vals]);

  return {
    company_id: companyId,
    company_name: after.company_name,
    changed: cols.map((c) => ({ field: c, from: before[c] ?? null, to: after[c] ?? null })),
    actor,
  };
}

/** Staff moves trips to the firm that actually bills the customer. */
async function resolveEntityMismatch(exc, params, actor) {
  const wanted = String((params && params.company) ?? '').trim();
  if (!wanted) {
    const e = new Error('company is required — say which firm these trips belong to');
    e.code = 'CHOICE_REQUIRED'; throw e;
  }
  const { rows: [co] } = await query(
    `SELECT id, btrim(company_name) AS company_name FROM companies
      WHERE lower(regexp_replace(btrim(company_name), '[^a-zA-Z0-9]+', ' ', 'g'))
          = lower(regexp_replace($1,                  '[^a-zA-Z0-9]+', ' ', 'g'))
      LIMIT 1`, [wanted]);
  if (!co) {
    const e = new Error(`"${wanted}" is not one of the transport companies in the master`);
    e.code = 'BAD_CHOICE'; throw e;
  }
  const ids = scopeTripIds(exc, params);
  if (!ids.length) { const e = new Error('no trips left in this exception'); e.code = 'GONE'; throw e; }

  return withTransaction(async (tx) => {
    // A trip on a raised bill is refused, not moved: the invoice the customer
    // holds names a different company, and changing the trip under it would make
    // the bill and the ledger disagree about who earned the money.
    const { rows: billed } = await tx(
      `SELECT DISTINCT b.bill_no
         FROM company_bill_trips bt JOIN company_bills b ON b.id = bt.bill_id
        WHERE bt.trip_id = ANY($1::uuid[]) AND b.status <> 'CANCELLED'`, [ids]);

    const { rows: upd } = await tx(
      `UPDATE trips t
          SET operating_company = $2, company_id = $3::uuid, updated_at = now()
        WHERE t.id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM company_bill_trips bt
                            JOIN company_bills b ON b.id = bt.bill_id
                           WHERE bt.trip_id = t.id AND b.status <> 'CANCELLED')
        RETURNING t.id, t.trip_code`,
      [ids, co.company_name, co.id]);

    return {
      moved_to: co.company_name,
      company_id: co.id,
      requested: ids.length,
      updated: upd.length,
      refused_billed: ids.length - upd.length,
      blocking_bills: billed.map((b) => b.bill_no),
      actor,
    };
  });
}

const RESOLVERS = {
  DUPLICATE_BILLING: { KEEP_ONE_LINE: resolveDuplicateBilling },
  BLANK_CUSTOMER:    { SET_CUSTOMER: resolveBlankCustomer },
  MASTER_DATA_GAP:   { UPDATE_COMPANY: resolveCompanyMasterGap },
  ENTITY_MISMATCH:   { SET_OPERATING_COMPANY: resolveEntityMismatch },
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
    // Each detector is independent, so one that throws must not hide the others'
    // findings. A scan that reports three of four queues is useful; a scan that
    // 500s because one query broke leaves the whole board looking empty.
    const run = async (kind, fn) => {
      try {
        const found = await fn();
        return { kind, found: found.length, new: found.filter((d) => d.was_new).length, raised: found };
      } catch (e) {
        req.log?.error({ err: e.message, detector: kind }, 'detector failed');
        return { kind, found: 0, new: 0, raised: [], error: String(e.message).slice(0, 200) };
      }
    };

    const [dup, blank, master, entity] = await Promise.all([
      run('DUPLICATE_BILLING', detectDuplicateBilling),
      run('BLANK_CUSTOMER', detectBlankCustomer),
      run('MASTER_DATA_GAP', detectCompanyMasterGaps),
      run('ENTITY_MISMATCH', detectEntityMismatch),
    ]);
    dup.amount_at_risk = r2(dup.raised.reduce((a, d) => a + money(d.overcharge), 0));

    return {
      ok: true,
      detectors: [dup, blank, master, entity].map(({ raised, ...rest }) => rest),
      raised: [...dup.raised, ...blank.raised, ...master.raised, ...entity.raised],
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

// ── THE MAILBOX THAT STOPPED ANSWERING ───────────────────────────────────────
// Owner, 5-Sep-2026: "IOCL ka bill aur payment advice email me aati hai —
// dono email check karo." Both Gmail tokens had been revoked for weeks and
// nothing said so on the dashboard; the books simply stopped moving. The sync
// runner records which mailbox failed on its last run; this makes it a
// HIGH exception per mailbox, deduped, until a person re-authorises it.
export async function detectMailboxDead(exec = query) {
  const { syncState } = await import('../lib/ioclSyncRunner.js');
  const last = syncState().last_run;
  const failed = Array.isArray(last?.mailboxes_failed) ? last.mailboxes_failed : [];
  const raised = [];
  for (const box of failed) {
    const info = last?.mailboxes?.[box] ?? {};
    const reason = String(info.reason ?? info.error ?? info.status ?? 'the mailbox did not answer').slice(0, 400);
    const token = /jaiswal/i.test(box) ? 'jaiswal_token.json' : 'gmail_token.json';
    raised.push(await raiseException({
      kind: 'MAILBOX_REAUTH',
      severity: 'HIGH',
      title: `${box} mailbox band hai — IOCL ke bill aur payment advice nahi padhe ja rahe`,
      detail: `Gmail token expire/revoke ho gaya (${reason}). Jab tak dobara authorise nahi hota, AC4/AC5 bills, payment advices aur customer milaan is mailbox ke liye ruke rahenge.`,
      subject_type: 'mailbox', subject_id: box, company: box,
      evidence: { mailbox: box, token, last_run_at: last?.at ?? null, trigger: last?.trigger ?? null, reason },
      options: [
        { key: 'REAUTH', label: `Office PC par chalayein: python tools/iocl_recon/gmail_setup.py --token ${token} --force (browser khulega), phir token AWS par copy` },
        { key: 'PUBLISH_APP', label: 'Google Cloud → OAuth consent screen → Publish app, taaki token har 7 din expire na ho' },
      ],
      amount_at_risk: null,
      dedupe_key: `MAILBOX_REAUTH:${box}`,
      detected_by: 'scheduler',
    }, exec));
  }
  return { raised: raised.length, mailboxes_failed: failed };
}
