// scripts/post-missing-gl-legs.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Posts the general-ledger legs the reconciler could not, because until now
// TARA had no JOURNAL voucher and the chart had no income head.
//
// Three journals, all through postVoucher so every guard and the deferred
// balance constraint still apply. Nothing writes to ledger_entries directly.
//
//   1. FREIGHT INCOME   per bill:  Dr <customer> / Cr Freight Income   (gross)
//   2. SHORTAGE PENALTY per bill:  Dr Shortage & Penalty / Cr <customer>
//   3. DRIVER RECOVERY  per txn:   Dr <driver ledger> / Cr Shortage & Penalty
//
// Why these three land the customer exactly where it should be:
//
//     Dr income  14,254,037.90        gross billed
//     Cr penalty     68,740.69        IOCL's deduction, never becomes cash
//     Cr receipts 14,191,267.73       already posted by the reconciler
//     ────────────────────────────
//     balance        −5,970.52  CR  = the open item on bill AS26075
//
// The customer ledger arriving at precisely the known open item is the check
// that the model is coherent — it is not forced anywhere.
//
// Recovering a penalty from the driver credits the same expense head it was
// debited to, so a fully recovered shortage nets to zero cost, and an
// unrecovered one stays visible as expense. That is the whole point of routing
// it through an expense account rather than straight against the customer.
//
//   node scripts/post-missing-gl-legs.mjs            # dry run
//   node scripts/post-missing-gl-legs.mjs --live
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config();

const LIVE = process.argv.includes('--live');
const { query, closePool, initDb } = await import('../server/db/pool.js');
const { postVoucher } = await import('../server/agents/tara.js');

const INCOME_LEDGER = 'Freight Income';
const PENALTY_LEDGER = 'Shortage & Penalty';
const inr = (n) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

await initDb({ attempts: 1, quiet: true });
console.log(`\n${'='.repeat(74)}\n POST MISSING GL LEGS   [${LIVE ? 'LIVE' : 'DRY RUN'}]\n${'='.repeat(74)}`);

const stats = { income: 0, penalty: 0, recovery: 0, skipped: 0, failed: 0, amount: 0 };

async function post(label, body) {
  try {
    const out = await postVoucher({ ...body, dry_run: !LIVE });
    if (out.posted || out.dry_run) return out;
    return null;
  } catch (err) {
    if (err.code === 'DUPLICATE_REF') { stats.skipped++; return null; }
    stats.failed++;
    console.log(`  ✖ ${label}: ${err.code ?? ''} ${err.message.slice(0, 110)}`);
    return null;
  }
}

// ── 1 + 2. Freight income and penalty, per bill ─────────────────────────────
const { rows: bills } = await query(`
  SELECT m.bill_no,
         MAX(m.bill_date)                              AS bill_date,
         SUM(m.gross_amt)::numeric(14,2)               AS gross,
         SUM(m.penalty_amt)::numeric(14,2)             AS penalty,
         COALESCE(MAX(t.customer_name), 'INDIAN OIL CORPORATION LTD') AS customer,
         count(*)                                      AS loads
    FROM iocl_recon_matches m
    LEFT JOIN trips t ON t.id = m.trip_id
   WHERE m.match_status = 'MATCHED'
   GROUP BY m.bill_no
   ORDER BY MAX(m.bill_date), m.bill_no`);

console.log(`\n FREIGHT INCOME — ${bills.length} bills`);
for (const b of bills) {
  const gross = Number(b.gross);
  if (gross > 0) {
    const r = await post(`income ${b.bill_no}`, {
      type: 'JOURNAL',
      source_type: 'FREIGHT_INCOME',
      ref_no: `IOCL-INC-${b.bill_no}`,
      entry_date: b.bill_date,
      narration: `Freight earned — IOCL bill ${b.bill_no}, ${b.loads} loads`,
      created_by: 'post-missing-gl-legs',
      lines: [
        { ledger: b.customer, dr_cr: 'DR', amount: gross, group: 'Sundry Debtors (Customers)' },
        { ledger: INCOME_LEDGER, dr_cr: 'CR', amount: gross, group: 'Freight Income' },
      ],
    });
    if (r) { stats.income++; stats.amount += gross; }
  }

  const pen = Number(b.penalty);
  if (pen > 0) {
    const r = await post(`penalty ${b.bill_no}`, {
      type: 'JOURNAL',
      source_type: 'SHORTAGE_PENALTY',
      ref_no: `IOCL-PEN-${b.bill_no}`,
      entry_date: b.bill_date,
      narration: `Shortage penalty deducted by IOCL — bill ${b.bill_no}`,
      created_by: 'post-missing-gl-legs',
      lines: [
        { ledger: PENALTY_LEDGER, dr_cr: 'DR', amount: pen, group: 'Shortage & Penalty' },
        { ledger: b.customer, dr_cr: 'CR', amount: pen, group: 'Sundry Debtors (Customers)' },
      ],
    });
    if (r) stats.penalty++;
  }
}

// ── 3. Driver shortage recoveries ───────────────────────────────────────────
// Resolved through ledger_aliases so a driver with two ledger spellings is
// credited once, on the canonical one.
const { rows: recoveries } = await query(`
  SELECT dt.legacy_id, dt.driver_name, dt.txn_date, dt.amount, dt.remarks,
         COALESCE(l.ledger_name, 'Driver Advance: ' || dt.driver_name) AS driver_ledger
    FROM driver_transactions dt
    LEFT JOIN ledger_aliases a ON a.alias_name = dt.driver_name
    LEFT JOIN ledgers        l ON l.id = a.canonical_id
   WHERE dt.txn_type = 'SHORTAGE_RECOVERY' AND dt.amount > 0
   ORDER BY dt.txn_date`);

console.log(` DRIVER RECOVERIES — ${recoveries.length} transactions`);
for (const d of recoveries) {
  const amt = Number(d.amount);
  const r = await post(`recovery ${d.driver_name}`, {
    type: 'JOURNAL',
    source_type: 'SHORTAGE_RECOVERY',
    ref_no: `DRV-RECOV-${d.legacy_id}`,
    entry_date: d.txn_date,
    narration: `Shortage recovered from ${d.driver_name} — ${String(d.remarks ?? '').slice(0, 120)}`,
    created_by: 'post-missing-gl-legs',
    lines: [
      { ledger: d.driver_ledger, dr_cr: 'DR', amount: amt, group: 'Current Assets - Driver Advances' },
      { ledger: PENALTY_LEDGER, dr_cr: 'CR', amount: amt, group: 'Shortage & Penalty' },
    ],
  });
  if (r) stats.recovery++;
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(74)}`);
console.log(`  income journals   : ${stats.income}   ₹${inr(stats.amount)}`);
console.log(`  penalty journals  : ${stats.penalty}`);
console.log(`  recovery journals : ${stats.recovery}`);
console.log(`  already posted    : ${stats.skipped}`);
console.log(`  failed            : ${stats.failed}`);

if (LIVE) {
  const { rows: [h] } = await query('SELECT * FROM v_accounting_health');
  console.log(`\n  HEALTH  unbalanced_vouchers=${h.unbalanced_vouchers}  voucher_era_imbalance=${h.voucher_era_imbalance}  legacy_imbalance=${h.legacy_imbalance}  unresolvable=${h.unresolvable_entries}`);
  const { rows: [c] } = await query(`
    SELECT balance_dr FROM v_ledger_balances WHERE ledger_name = 'INDIAN OIL CORPORATION LTD'`);
  console.log(`  IOCL ledger balance : ₹${inr(c?.balance_dr ?? 0)}   (expect −5,970.52 = the open item)`);
} else {
  console.log('\n  DRY RUN — every voucher validated and rolled back. Re-run with --live.');
}

await closePool();
