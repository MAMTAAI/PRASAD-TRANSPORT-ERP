// scripts/reclass-previous-fy.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Move prior-financial-year freight off the current receivable.
//
// IOCL's bill numbers carry the financial year: 11024699AS25xxx belongs to
// FY 2025-26, AS26xxx to FY 2026-27. The April advices settled five AS25-series
// bills — March-2026 loading, paid on 08.04.2026 — and the settlement journal
// credited them to the live customer ledger along with everything else.
//
// That is wrong in two directions at once:
//   * the receivable they clear was raised LAST year, in books this system does
//     not hold, so crediting the current ledger drives it artificially negative;
//   * the ERP has no loading detail for them and never will — loading entry
//     began 01-04-2026 — so they can never be matched to a trip and would sit
//     as a permanent unexplained gap.
//
// They are not income of this year. The credit is moved to
// 'Previous FY Pending Dues (IOCL)', the same head already used for the
// March-loading lines the owner identified earlier.
//
//     Dr  INDIAN OIL CORPORATION LTD        (undo the current-year credit)
//         Cr  Previous FY Pending Dues (IOCL)
//
//   node scripts/reclass-previous-fy.mjs            # dry run
//   node scripts/reclass-previous-fy.mjs --live
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config();

const LIVE = process.argv.includes('--live');
const { query, closePool, initDb } = await import('../server/db/pool.js');
const { postVoucher } = await import('../server/agents/tara.js');

const PARTY = 'INDIAN OIL CORPORATION LTD';
const PREV_FY = 'Previous FY Pending Dues (IOCL)';

// A bill number is <vendor><STATE><YY><NNN>: 11024699 AS 26 001.
// The financial year is the YY, and the state letters vary — AS (Assam),
// BH (Bihar), JRK (Jharkhand), UP. Filtering on the literal 'AS26' therefore
// swept BH26001, JRK26001 and UP26001 into "previous FY" when they are
// current-year bills from other states; ₹1.66 L of this year's income would
// have been moved off the P&L. The year digits are what must be compared.
const CURRENT_FY_YY = 26;
const BILL_YEAR_RE = "'^11024699[A-Z]{2,4}([0-9]{2})[0-9]{3}$'";
const inr = (v) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

await initDb({ attempts: 1, quiet: true });
console.log(`\n${'='.repeat(72)}\n RECLASSIFY PREVIOUS-FY FREIGHT   [${LIVE ? 'LIVE' : 'DRY RUN'}]\n${'='.repeat(72)}`);

const { rows } = await query(`
  SELECT l.bill_no,
         MIN(a.odn)                    AS odn,
         MIN(a.advice_date)            AS advice_date,
         SUM(l.gross)::numeric(14,2)   AS gross
    FROM iocl_advice_lines l
    JOIN iocl_payment_advices a USING (advice_id)
   WHERE l.kind = 'FREIGHT_BILL'
     AND l.bill_no IS NOT NULL
     AND (substring(l.bill_no from ${BILL_YEAR_RE}))::int < $1
   GROUP BY l.bill_no
   ORDER BY MIN(a.advice_date), l.bill_no`, [CURRENT_FY_YY]);

if (!rows.length) {
  console.log('\n  Nothing to reclassify — every settled bill is current-FY.');
  await closePool();
  process.exit(0);
}

console.log(`\n  ${rows.length} previous-FY bill(s) found:\n`);
console.log(`  ${'bill'.padEnd(20)}${'advice'.padEnd(16)}${'paid'.padEnd(13)}${'gross'.padStart(14)}`);
let total = 0;
for (const r of rows) {
  console.log(`  ${r.bill_no.padEnd(20)}${(r.odn ?? '').padEnd(16)}${String(r.advice_date).padEnd(13)}${inr(r.gross).padStart(14)}`);
  total += Number(r.gross);
}
console.log(`  ${''.padEnd(49)}${'─'.repeat(14)}`);
console.log(`  ${'TOTAL'.padEnd(49)}${inr(total).padStart(14)}`);

try {
  const out = await postVoucher({
    type: 'JOURNAL',
    source_type: 'PREV_FY_RECLASS',
    ref_no: `PREVFY-FY${CURRENT_FY_YY}-${rows.length}`,
    entry_date: rows[rows.length - 1].advice_date,
    narration: `Reclassify ${rows.length} previous-FY bills (${rows.map((r) => r.bill_no.replace('11024699', '')).join(', ')}) — March-2026 loading settled in April; no ERP loading detail exists for these`,
    created_by: 'reclass-previous-fy',
    lines: [
      { ledger: PARTY, dr_cr: 'DR', amount: Math.round(total * 100) / 100, group: 'Sundry Debtors (Customers)' },
      { ledger: PREV_FY, dr_cr: 'CR', amount: Math.round(total * 100) / 100, group: 'Sundry Debtors (Customers)' },
    ],
    dry_run: !LIVE,
  });
  console.log(`\n  ${LIVE ? 'POSTED' : 'VALIDATED'}: voucher ${out.voucher_id}`);
} catch (err) {
  if (err.code === 'DUPLICATE_REF') {
    console.log('\n  Already reclassified — nothing to do.');
  } else {
    console.log(`\n  FAILED: ${err.code ?? ''} ${err.message}`);
    await closePool();
    process.exit(1);
  }
}

if (LIVE) {
  const { rows: bal } = await query(
    `SELECT ledger_name, balance_dr FROM v_ledger_balances WHERE ledger_name IN ($1,$2) ORDER BY 1`,
    [PARTY, PREV_FY]);
  console.log('\n  BALANCES');
  for (const b of bal) console.log(`    ${b.ledger_name.padEnd(36)}${inr(b.balance_dr).padStart(16)}`);
  const { rows: [h] } = await query('SELECT * FROM v_accounting_health');
  const bad = Object.entries(h).filter(([k, v]) => k !== 'merged_aliases' && Number(v) !== 0);
  console.log(`  HEALTH: ${bad.length ? bad.map(([k, v]) => `${k}=${v}`).join(' ') : 'all zero'}`);
} else {
  console.log('\n  DRY RUN — validated and rolled back. Re-run with --live.');
}

await closePool();
