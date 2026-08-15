// server/agents/tara.js
// AGENT 02 — TARA · Financial Auditor & Double-Entry Ledger Guard
import { defineAgent, ok, skipped, blocked, failed } from './base.js';
import { query, queryOne } from '../db/pool.js';
import { withAggregateLock, LOCK_NS } from './kamala.js';
import { assertAttachedCostIsolation } from '../lib/fleetAccounting.js';

/**
 * Posting rules, ported from `src/lib/accounting/posting.ts`, which already
 * encodes the firm's chart of accounts. Ledger names follow the convention
 * already in the live data: 'Debtors: <customer>', 'Creditors: <vendor>'.
 *
 * The difference from the browser-side original is where correctness lives.
 * There, `validateEntry()` checked ΣDr === ΣCr in JavaScript floats and a caller
 * could simply not call it. Here the balance is a database constraint, so an
 * unbalanced voucher cannot exist even if every line of application code is
 * wrong. That single change is the strongest argument for the PostgreSQL move.
 */
export const POSTING_RULES = Object.freeze({
  'trip.freight.earned':   { dr: (t) => `Debtors: ${t.customer_name}`, cr: () => 'Freight Income' },
  'trip.shortage.detected':{ dr: () => 'Shortage Recovery',            cr: (t) => `Debtors: ${t.customer_name}` },
  'fuel.slip.recorded':    { dr: () => 'Fuel & HSD',                   cr: (f) => `Creditors: ${f.vendor_name}` },
  'toll.charge.recorded':  { dr: () => 'Toll & FASTag',                cr: (t) => `Creditors: ${t.vendor_name}` },
  'driver.advance.paid':   { dr: (d) => `Driver Advance: ${d.driver_name}`, cr: (d) => d.mode === 'BANK' ? 'Bank' : 'Cash' },
  'customer.payment.received': { dr: (p) => p.mode === 'BANK' ? 'Bank' : 'Cash', cr: (p) => `Debtors: ${p.customer_name}` },
  'vendor.payment.made':   { dr: (v) => `Creditors: ${v.vendor_name}`, cr: (v) => v.mode === 'BANK' ? 'Bank' : 'Cash' },
  'loan.emi.due':          { dr: () => 'Loan Interest',                cr: (l) => `Loan: ${l.bank_name}` },
});

export default defineAgent({
  id: 'AGENT_02',
  codename: 'TARA',
  title: 'Financial Auditor & Double-Entry Ledger Guard',
  domain: 'finance',
  mandate:
    'Sole authority over money. Every rupee that enters the ERP is posted by Tara as a ' +
    'balanced double-entry voucher, and no other agent may write to a ledger table. ' +
    'Tara also owns freight settlement, P&L verification, and the zero-divergence rule: ' +
    'total debits must equal total credits at every instant, with no tolerance.',

  subscribes: [
    'trip.settlement.authorised',
    'trip.completed',
    'trip.shortage.detected',
    'fuel.slip.recorded',
    'toll.charge.recorded',
    'driver.advance.paid',
    'customer.payment.received',
    'vendor.payment.made',
    'loan.emi.due',
    'ledger.audit.requested',
  ],
  emits: [
    'ledger.posted',
    'ledger.imbalance.detected',
    'trip.settled',
    'invoice.generation.requested',
    'agent.halt.requested',
  ],

  owns: {
    tables: ['ledgers', 'ledger_entries', 'journal', 'invoices', 'payments', 'trip_settlements'],
    modules: ['LedgerMgmt.tsx', 'CashBankBook.tsx', 'FinancialReports.tsx',
              'MasterTripSettlement.tsx', 'MonthlyBilling.tsx', 'BillManagement.tsx',
              'LoanEmiMgmt.tsx'],
  },
  reads: ['trips', 'fuel_entries', 'toll_transactions', 'customers', 'vendors', 'drivers', 'loan_master'],

  mustNot: [
    'post an unbalanced voucher — the DB constraint makes this impossible, and Tara must never be given a code path that tries',
    'edit or delete a posted entry; a correction is always a new reversing entry',
    'let any other agent write to ledgers/ledger_entries/journal',
    'settle a trip that KALI has not marked COMPLETED',
    'round a rupee amount in JavaScript floats — NUMERIC arithmetic stays in SQL',
  ],

  guards: [
    { name: 'zero_divergence',
      description: 'SUM(dr) - SUM(cr) = 0 across the whole ledger, verified after every posting batch.' },
    { name: 'balanced_voucher',
      description: 'Each voucher balances independently; enforced by a deferred DB constraint, not by the caller.' },
    { name: 'append_only_ledger',
      description: 'ledger_entries has no UPDATE or DELETE path. Reversals only.' },
    { name: 'settlement_requires_completion',
      description: 'A trip must be COMPLETED and shortage-resolved before settlement posts.' },
    { name: 'halt_on_imbalance',
      description: 'A detected imbalance raises agent.halt.requested immediately — the swarm stops rather than compounding a broken book.' },
  ],

  // Ledger tables land in migration 003.
  requires: ['ledgers', 'ledger_entries', 'trips'],

  async handle(event, ctx) {
    switch (event.event_type) {
      case 'trip.settlement.authorised': {
        const tripId = event.aggregate_id;
        if (!tripId) return failed('settlement authorisation carried no trip id');

        // Kamala already holds the lock when it authorises, but this handler can
        // also be reached by replay, so it re-takes it. Advisory locks are
        // re-entrant within a transaction, making this safe either way.
        return withAggregateLock(LOCK_NS.TRIP, tripId, async (tx) => {
          const trip = await tx.query(
            `SELECT id, status, customer_name, freight_amount, shortage_qty
               FROM trips WHERE id = $1 FOR UPDATE`,
            [tripId]
          ).then((r) => r.rows[0]);

          if (!trip) return failed(`trip ${tripId} not found`);
          if (trip.status === 'SETTLED') return skipped('already settled — replay ignored');
          if (trip.status !== 'COMPLETED') return blocked(`trip is ${trip.status}, not COMPLETED`);

          if (trip.freight_amount === null) return blocked('trip has no freight_amount — settle manually');

          // Amounts stay strings out of pg (NUMERIC) and go straight back into
          // SQL. No JS float ever touches a rupee value. The voucher_id puts
          // this posting in the VOUCHER era: the deferred DB constraint
          // verifies DR = CR at COMMIT — an unbalanced settlement cannot land.
          const { rows: [{ voucher_id: voucherId }] } =
            await tx.query('SELECT gen_random_uuid() AS voucher_id');
          await tx.query(
            `INSERT INTO ledger_entries (ledger_name, voucher_id, dr_cr, amount, particulars, source_type, source_ref, entry_date)
             VALUES ($1, $6, 'DR', $3, $4, 'TRIP_SETTLEMENT', $2, CURRENT_DATE),
                    ($5, $6, 'CR', $3, $4, 'TRIP_SETTLEMENT', $2, CURRENT_DATE)`,
            [`Debtors: ${trip.customer_name}`, tripId, trip.freight_amount,
             `Freight settlement trip ${tripId}`, 'Freight Income', voucherId]
          );
          // One settlement per trip — enforced by the unique index, so a
          // replayed authorisation dies here instead of double-posting.
          await tx.query(
            `INSERT INTO trip_settlements (trip_id, voucher_id, freight_amount, settled_by)
             VALUES ($1, $2, $3, $4)`,
            [tripId, voucherId, trip.freight_amount, event.payload?.requested_by ?? 'AGENT_02']
          );
          await tx.query(`UPDATE trips SET status = 'SETTLED' WHERE id = $1`, [tripId]);

          await ctx.emit('trip.settled', {
            aggregate: 'trip', aggregateId: tripId,
            payload: { freight_amount: trip.freight_amount },
            correlationId: event.correlation_id, tx,
          });
          await ctx.emit('invoice.generation.requested', {
            aggregate: 'trip', aggregateId: tripId,
            correlationId: event.correlation_id, tx,
          });
          return ok(`settled trip ${tripId}`);
        });
      }

      case 'ledger.audit.requested': {
        // The zero-divergence check — VOUCHER era only. The legacy Firestore
        // book was single-entry (219 Dr vs 1 Cr in the snapshot); judging it by
        // double-entry rules would halt the swarm on contact with history.
        // Every post-migration rupee lives in a voucher and is fully in scope.
        // Deliberately SQL-side: SUM over NUMERIC is exact, whereas summing
        // entries in JS floats accumulates error.
        const row = await queryOne(`
          SELECT COALESCE(SUM(amount) FILTER (WHERE dr_cr = 'DR'), 0) AS total_dr,
                 COALESCE(SUM(amount) FILTER (WHERE dr_cr = 'CR'), 0) AS total_cr,
                 COALESCE(SUM(amount) FILTER (WHERE dr_cr = 'DR'), 0)
               - COALESCE(SUM(amount) FILTER (WHERE dr_cr = 'CR'), 0) AS divergence,
                 count(*) AS entries
            FROM ledger_entries
           WHERE voucher_id IS NOT NULL`);

        if (row && row.divergence !== '0' && Number(row.divergence) !== 0) {
          // An imbalanced book is an emergency: stop the swarm rather than let
          // further postings pile on top of a broken ledger.
          await ctx.emit('ledger.imbalance.detected', {
            aggregate: 'ledger',
            payload: row,
            correlationId: event.correlation_id,
          });
          await ctx.emit('agent.halt.requested', {
            aggregate: 'ledger',
            payload: { scope: null, reason: `ledger divergence Rs.${row.divergence}` },
            correlationId: event.correlation_id,
          });
          return blocked(`ledger divergence Rs.${row.divergence} over ${row.entries} entries`);
        }
        return ok(`ledger balanced (${row?.entries ?? 0} entries, divergence 0)`);
      }

      default: {
        // Everything else is a straightforward voucher via POSTING_RULES.
        const rule = POSTING_RULES[event.event_type];
        if (!rule) return skipped(`no posting rule for ${event.event_type}`);
        // Posting the generic voucher requires the source row, which lives in
        // tables from migration 003. Declared now, wired when they exist.
        return skipped(`posting rule '${event.event_type}' awaits migration 003`);
      }
    }
  },
});

// ═════════════════════════════════════════════════════════════════════════
// TARA's voucher API — the ONLY code path that posts an operator voucher.
// Called synchronously by /api/v1/finance/vouchers so the clerk gets an
// instant verdict, but the discipline is identical to event-driven postings:
// advisory lock, FOR-UPDATE-free balance reads inside one transaction, the
// deferred DB balance constraint, and an audit event emitted in the same tx.
// ═════════════════════════════════════════════════════════════════════════
import { withTransaction } from '../db/pool.js';
import { emit as busEmit } from './bus.js';

const VOUCHER_TYPES = Object.freeze(['RECEIPT', 'PAYMENT', 'CONTRA', 'JOURNAL']);

async function getOrCreateLedger(tx, name, groupHead) {
  const found = await tx.query(
    `SELECT id, ledger_name FROM ledgers WHERE lower(ledger_name) = lower($1) LIMIT 1`, [name]);
  if (found.rows.length) return found.rows[0];
  // The id is DERIVED FROM THE NAME, not generated. Two databases posting the
  // same voucher used to mint two different uuids for one account, and autoSync
  // upserts by id — so the account arrived on the replica twice and its balance
  // split across the copies. That defect has now cost migrations 037, 038 and
  // 039. md5 returns 32 hex characters, which casts straight to uuid, so the
  // same ledger name is the same primary key on every database and the upsert
  // converges instead of duplicating.
  //
  // ON CONFLICT covers the other half of the race: if autoSync inserted this
  // very row between the SELECT above and this INSERT, the no-op UPDATE still
  // returns it rather than raising.
  const made = await tx.query(
    `INSERT INTO ledgers (id, ledger_name, group_head, creation_type)
     VALUES (md5('prasad-erp/ledger/' || lower(btrim($1)))::uuid, $1, $2, 'AUTO_VOUCHER')
     ON CONFLICT (id) DO UPDATE SET ledger_name = ledgers.ledger_name
     RETURNING id, ledger_name`, [name, groupHead]);
  return made.rows[0];
}

/** Live balance of a ledger: opening + Dr − Cr (positive = Dr balance). */
async function ledgerBalance(tx, name) {
  const { rows: [r] } = await tx.query(
    `SELECT COALESCE((SELECT opening_balance FROM ledgers WHERE lower(ledger_name)=lower($1) LIMIT 1),0)
          + COALESCE(SUM(amount) FILTER (WHERE dr_cr='DR'),0)
          - COALESCE(SUM(amount) FILTER (WHERE dr_cr='CR'),0) AS bal
       FROM ledger_entries WHERE lower(ledger_name)=lower($1)`, [name]);
  return Number(r.bal ?? 0);
}

/**
 * Post an operator voucher.
 * @param {object} v
 *   type          RECEIPT | PAYMENT | CONTRA
 *   party_ledger  counter-party ledger name (ignored for CONTRA)
 *   party_group   group head if the ledger must be created
 *   account       Bank/Cash ledger the money moves through (source for PAYMENT/CONTRA, destination for RECEIPT)
 *   to_account    CONTRA only — destination Bank/Cash ledger
 *   amount        ₹ (gross)
 *   ref_no        cheque/UTR/memo — duplicate-checked
 *   narration     text; entry_date; company; branch; created_by
 *   tds           optional {ledger, amount} from the tax engine. Which side it
 *                 lands on is INFERRED from the voucher type, because the
 *                 direction of the deduction follows the direction of the money:
 *
 *                   PAYMENT  we pay a vendor and withhold TDS on their behalf.
 *                            The tax is a LIABILITY we owe the government.
 *                              Dr party (gross) / Cr bank (net) / Cr TDS Payable
 *
 *                   RECEIPT  a customer pays us and withholds TDS from us. The
 *                            tax is an ASSET — already credited to our PAN, to
 *                            be claimed against the year's liability.
 *                              Dr bank (net) / Dr TDS Receivable / Cr party (gross)
 *
 *                 `amount` is the GROSS in both cases; cash moved is amount−tds.
 *                 Passing tds on a CONTRA is refused — moving money between two
 *                 of your own accounts deducts nothing.
 *   dry_run       run every guard + insert, then ROLL BACK (zero rows land)
 */
export async function postVoucher(v) {
  if (!VOUCHER_TYPES.includes(v.type)) throw Object.assign(new Error(`bad voucher type ${v.type}`), { code: 'BAD_TYPE' });

  // ── JOURNAL ───────────────────────────────────────────────────────────────
  // The three cash vouchers all describe money moving through a bank or cash
  // account, and each derives its own lines. A journal does not: it is the
  // general case — an explicit, caller-supplied set of legs with no cash leg at
  // all. Freight income (Dr Debtors / Cr Freight Income), a shortage recovery
  // (Dr Driver / Cr Shortage Recovery), a reversing correction: none of these
  // can be expressed as RECEIPT/PAYMENT/CONTRA, and without them a book has no
  // revenue and no way to correct itself.
  //
  // The caller supplies the legs, so the caller can get them wrong; balance is
  // therefore checked here AND again by the deferred DB constraint at COMMIT.
  if (v.type === 'JOURNAL') return postJournal(v);

  const amount = Number(v.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error('amount must be > 0'), { code: 'BAD_AMOUNT' });
  if (!v.account) throw Object.assign(new Error('account (bank/cash ledger) required'), { code: 'NO_ACCOUNT' });
  if (v.type === 'CONTRA' && (!v.to_account || v.to_account === v.account))
    throw Object.assign(new Error('CONTRA needs a distinct to_account'), { code: 'BAD_CONTRA' });
  if (v.type !== 'CONTRA' && !v.party_ledger)
    throw Object.assign(new Error('party_ledger required'), { code: 'NO_PARTY' });

  // TDS sanity, checked before any lock is taken.
  const tdsIn = Number(v.tds?.amount ?? 0);
  if (tdsIn > 0) {
    if (v.type === 'CONTRA')
      throw Object.assign(new Error('TDS is not applicable to a CONTRA voucher'), { code: 'BAD_TDS' });
    if (!v.tds.ledger)
      throw Object.assign(new Error('tds.ledger required when tds.amount > 0'), { code: 'BAD_TDS' });
    // TDS at or above the gross would invert the cash leg — always a caller bug.
    if (tdsIn >= amount)
      throw Object.assign(
        new Error(`TDS ₹${tdsIn.toFixed(2)} must be less than the gross amount ₹${amount.toFixed(2)}`),
        { code: 'BAD_TDS' });
  }

  return withAggregateLock(LOCK_NS.LEDGER, v.account, async (tx) => {
    // GUARD 1 — duplicate reference. One cheque/UTR posts once, ever.
    if (v.ref_no) {
      const dup = await tx.query(
        `SELECT id FROM ledger_entries WHERE source_type='VOUCHER' AND source_ref=$1 LIMIT 1`, [String(v.ref_no)]);
      if (dup.rows.length) {
        throw Object.assign(new Error(`reference '${v.ref_no}' already posted (entry ${dup.rows[0].id})`), { code: 'DUPLICATE_REF' });
      }
    }

    // GUARD 2 — overdraft. Money can only leave an account that has it.
    const tdsAmt = Number(v.tds?.amount ?? 0);
    const cashOut = v.type === 'PAYMENT' ? amount - tdsAmt : v.type === 'CONTRA' ? amount : 0;
    if (cashOut > 0) {
      const bal = await ledgerBalance(tx, v.account);
      if (bal < cashOut) {
        throw Object.assign(
          new Error(`insufficient balance in '${v.account}': ₹${bal.toFixed(2)} available, ₹${cashOut.toFixed(2)} needed`),
          { code: 'OVERDRAFT', balance: bal.toFixed(2) });
      }
    }

    // Ensure every ledger head exists.
    await getOrCreateLedger(tx, v.account, /cash/i.test(v.account) ? 'Cash-in-Hand' : 'Bank Accounts');
    if (v.type === 'CONTRA') await getOrCreateLedger(tx, v.to_account, /cash/i.test(v.to_account) ? 'Cash-in-Hand' : 'Bank Accounts');
    else await getOrCreateLedger(tx, v.party_ledger, v.party_group ?? 'Suspense A/c');
    // TDS we withheld is a liability; TDS withheld FROM us is an asset. Filing
    // both under 'Duties & Taxes' would net a receivable against a payable in
    // the balance sheet and understate both.
    if (tdsAmt > 0) {
      await getOrCreateLedger(
        tx, v.tds.ledger,
        v.type === 'RECEIPT' ? 'Loans & Advances (Asset)' : 'Duties & Taxes');
    }

    // Build the balanced line set. The deferred DB constraint re-verifies at
    // COMMIT — even a bug here cannot land a lopsided voucher.
    const lines = [];
    const push = (ledger, dr_cr, amt) => lines.push({ ledger, dr_cr, amt: amt.toFixed(2) });
    if (v.type === 'RECEIPT') {          // money in: Dr account (net) [/ Dr TDS] / Cr party (gross)
      // The party is credited the FULL gross so the receivable clears; the
      // shortfall between gross and cash is the tax already paid on our behalf.
      push(v.account, 'DR', amount - tdsAmt);
      if (tdsAmt > 0) push(v.tds.ledger, 'DR', tdsAmt);
      push(v.party_ledger, 'CR', amount);
    } else if (v.type === 'PAYMENT') {   // money out: Dr party / Cr account (net) [/ Cr TDS]
      push(v.party_ledger, 'DR', amount);
      push(v.account, 'CR', amount - tdsAmt);
      if (tdsAmt > 0) push(v.tds.ledger, 'CR', tdsAmt);
    } else {                             // CONTRA: Dr destination / Cr source
      push(v.to_account, 'DR', amount);
      push(v.account, 'CR', amount);
    }

    // ── ATTACHED-FLEET ISOLATION, ON THIS PATH TOO ────────────────────────
    // postJournal has enforced this since it was written; the cash path never
    // did. So a fee paid for an attached lorry — a fitness renewal, an
    // insurance premium, anything entered as a PAYMENT with a vehicle_id —
    // could be debited straight to a company expense head with nothing to stop
    // it, which is the precise mistake the rule exists to prevent. The comment
    // in fleetAccounting.js says the check lives "at the door into
    // ledger_entries because that is the only place it cannot be routed
    // around"; there were two doors, and this one was unlocked.
    await assertAttachedCostIsolation(
      (sql, params) => tx.query(sql, params),
      v.vehicle_id ?? null,
      lines.map((l) => ({ ledger: l.ledger, dr_cr: l.dr_cr, group: null })),
    );

    const { rows: [{ voucher_id: voucherId }] } = await tx.query('SELECT gen_random_uuid() AS voucher_id');
    const entryDate = v.entry_date ?? new Date().toISOString().slice(0, 10);
    const narration = v.narration ?? `${v.type} voucher`;
    for (const l of lines) {
      await tx.query(
        // source_type was hardcoded 'VOUCHER', so a caller's source_type was
        // accepted and silently dropped — vehicle compliance fees, and anything
        // else posted as a cash voucher, landed in the ledger indistinguishable
        // from a hand-typed entry and could not be traced back or reconciled.
        // Defaulted rather than replaced, so every existing caller keeps the
        // 'VOUCHER' it has always written.
        `INSERT INTO ledger_entries (ledger_name, voucher_id, entry_date, particulars, dr_cr, amount, source_type, source_ref, company, branch, vehicle_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid)`,
        [l.ledger, voucherId, entryDate, narration, l.dr_cr, l.amt,
         v.source_type ?? 'VOUCHER', v.ref_no ?? null, v.company ?? null, v.branch ?? null,
         v.vehicle_id ?? null]);
    }

    await busEmit('ledger.posted', {
      aggregate: 'voucher', payload: { voucher_id: voucherId, type: v.type, amount: amount.toFixed(2), by: v.created_by ?? null },
      emittedBy: 'AGENT_02', tx,
    });

    if (v.dry_run) {
      // Everything validated, every line inserted, constraint armed — and none
      // of it survives. The zero-pollution smoke test.
      const err = new Error('DRY_RUN_ROLLBACK');
      err.code = 'DRY_RUN';
      err.result = { would_post: true, voucher_id: voucherId, lines, narration };
      throw err;
    }
    return { posted: true, voucher_id: voucherId, lines, narration };
  }).catch((err) => {
    if (err.code === 'DRY_RUN') return { posted: false, dry_run: true, ...err.result };
    throw err;
  });
}

/**
 * Post a general journal: caller-supplied legs, no cash leg required.
 *
 * @param {object} v
 *   lines[]   [{ ledger, dr_cr:'DR'|'CR', amount, group? }] — at least two
 *   ref_no    duplicate-checked, exactly as for the cash vouchers
 *   narration/entry_date/company/branch/created_by/source_type
 *   dry_run   validate + insert + roll back
 *
 * Paise are compared as integers: 0.1 + 0.2 in float never equals 0.3, and a
 * voucher rejected for being a hundredth of a rupee out would be absurd.
 */
async function postJournal(v) {
  const lines = Array.isArray(v.lines) ? v.lines : [];
  if (lines.length < 2)
    throw Object.assign(new Error('a journal needs at least two lines'), { code: 'BAD_LINES' });

  let drP = 0, crP = 0;
  const clean = lines.map((l, i) => {
    const amt = Number(l.amount);
    if (!Number.isFinite(amt) || amt <= 0)
      throw Object.assign(new Error(`line ${i + 1}: amount must be > 0`), { code: 'BAD_AMOUNT' });
    if (l.dr_cr !== 'DR' && l.dr_cr !== 'CR')
      throw Object.assign(new Error(`line ${i + 1}: dr_cr must be DR or CR`), { code: 'BAD_LINES' });
    if (!l.ledger)
      throw Object.assign(new Error(`line ${i + 1}: ledger required`), { code: 'BAD_LINES' });
    const p = Math.round(amt * 100);
    if (l.dr_cr === 'DR') drP += p; else crP += p;
    return { ledger: String(l.ledger), dr_cr: l.dr_cr, amt: (p / 100).toFixed(2), group: l.group ?? null,
             vehicle_id: l.vehicle_id ?? null };
  });

  if (drP !== crP) {
    throw Object.assign(
      new Error(`journal does not balance: Dr ₹${(drP / 100).toFixed(2)} vs Cr ₹${(crP / 100).toFixed(2)}`),
      { code: 'UNBALANCED' });
  }

  return withAggregateLock(LOCK_NS.LEDGER, clean[0].ledger, async (tx) => {
    if (v.ref_no) {
      const dup = await tx.query(
        `SELECT id FROM ledger_entries WHERE source_type = $1 AND source_ref = $2 LIMIT 1`,
        [v.source_type ?? 'JOURNAL', String(v.ref_no)]);
      if (dup.rows.length) {
        throw Object.assign(new Error(`reference '${v.ref_no}' already posted (entry ${dup.rows[0].id})`),
          { code: 'DUPLICATE_REF' });
      }
    }

    for (const l of clean) await getOrCreateLedger(tx, l.ledger, l.group ?? 'Suspense A/c');

    // ── ATTACHED-FLEET ISOLATION ──────────────────────────────────────────
    // An attached vehicle's diesel, toll and advances are recoverable from its
    // owner — they are balance-sheet movements in that owner's khata, never
    // company expenses. Booking them to a P&L expense group inflates company
    // costs by the whole value of somebody else's operation.
    //
    // The check lives HERE, after ledgers are resolved and before anything is
    // written, because this is the only door into ledger_entries. Putting it in
    // the trip-posting helper alone would leave every other caller — an ad-hoc
    // voucher, an importer, a future script — free to make the mistake.
    await assertAttachedCostIsolation(
      (sql, params) => tx.query(sql, params),
      v.vehicle_id ?? null,
      clean.map((l) => ({ ledger: l.ledger, dr_cr: l.dr_cr, group: l.group })),
    );

    const { rows: [{ voucher_id: voucherId }] } = await tx.query('SELECT gen_random_uuid() AS voucher_id');
    const entryDate = v.entry_date ?? new Date().toISOString().slice(0, 10);
    const narration = v.narration ?? 'Journal entry';
    for (const l of clean) {
      await tx.query(
        `INSERT INTO ledger_entries (ledger_name, voucher_id, entry_date, particulars, dr_cr, amount,
                                     source_type, source_ref, company, branch,
                                     company_id, branch_id, vehicle_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid,$12::uuid,$13::uuid)`,
        [l.ledger, voucherId, entryDate, narration, l.dr_cr, l.amt,
         v.source_type ?? 'JOURNAL', v.ref_no ?? null, v.company ?? null, v.branch ?? null,
         // The dimensions the 3-tier filter reads. Per-line vehicle wins over
         // the voucher's, so one journal can carry legs for different trucks.
         v.company_id ?? null, v.branch_id ?? null, l.vehicle_id ?? v.vehicle_id ?? null]);
    }

    await busEmit('ledger.posted', {
      aggregate: 'voucher',
      payload: { voucher_id: voucherId, type: 'JOURNAL', amount: (drP / 100).toFixed(2), lines: clean.length, by: v.created_by ?? null },
      emittedBy: 'AGENT_02', tx,
    });

    if (v.dry_run) {
      const err = new Error('DRY_RUN_ROLLBACK');
      err.code = 'DRY_RUN';
      err.result = { would_post: true, voucher_id: voucherId, lines: clean, narration };
      throw err;
    }
    return { posted: true, voucher_id: voucherId, lines: clean, narration };
  }).catch((err) => {
    if (err.code === 'DRY_RUN') return { posted: false, dry_run: true, ...err.result };
    throw err;
  });
}

export { ledgerBalance, getOrCreateLedger, postJournal };