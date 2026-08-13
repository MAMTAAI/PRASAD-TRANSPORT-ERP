// scripts/preflight-history.mjs — READ-ONLY validation of everything the
// history poster intends to write. Runs no INSERT of any kind.
//
// The ledger is append-only: a bad voucher is corrected by a reversal, never an
// edit. So every objection is raised HERE, before anything is posted.
import 'dotenv/config';
const targetArg = process.argv.indexOf('--target');
if (targetArg > -1) process.env.DB_TARGET = process.argv[targetArg + 1];
const { initDb, query, closePool, DB_TARGET } = await import('../server/db/pool.js');

const inr = (n) => 'Rs ' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = '2026-08-13';

await initDb();
console.log(`\nPRE-FLIGHT  target=${DB_TARGET}  today=${today}\n${'='.repeat(88)}`);
const q = async (s, p = []) => (await query(s, p)).rows;

// ── 1. EMI ────────────────────────────────────────────────────────────────
const emi = await q(
  `SELECT e.id, e.legacy_id, e.payment_date::text AS d, e.total_paid, e.principal_part, e.interest_part,
          e.ref_no, e.paid_from_account, l.vehicle_no, l.bank_name, l.financier_ledger
     FROM emi_payments e JOIN loan_master l ON l.id = e.loan_id ORDER BY e.payment_date`);
const emiBad = {
  noDate: emi.filter((r) => !r.d),
  future: emi.filter((r) => r.d && r.d > today),
  split: emi.filter((r) => Math.abs((Number(r.principal_part) || 0) + (Number(r.interest_part) || 0) - (Number(r.total_paid) || 0)) > 0.01),
  noFinancier: emi.filter((r) => !r.financier_ledger),
};
console.log(`\nEMI_PAYMENTS: ${emi.length} rows, ${inr(emi.reduce((a, r) => a + Number(r.total_paid || 0), 0))}`);
console.log(`   principal ${inr(emi.reduce((a, r) => a + Number(r.principal_part || 0), 0))} + interest ${inr(emi.reduce((a, r) => a + Number(r.interest_part || 0), 0))}`);
for (const [k, v] of Object.entries(emiBad)) console.log(`   ${k.padEnd(12)} ${v.length}${v.length ? '  e.g. ' + JSON.stringify({ ref: v[0].ref_no, d: v[0].d, veh: v[0].vehicle_no, fin: v[0].financier_ledger }) : ''}`);
const dupEmi = await q(
  `SELECT ref_no, emi_month, count(*)::int AS n FROM emi_payments
    GROUP BY 1,2 HAVING count(*) > 1 ORDER BY 3 DESC`);
console.log(`   duplicate (ref_no, emi_month): ${dupEmi.length}${dupEmi.length ? ' -> ' + JSON.stringify(dupEmi.slice(0, 4)) : ''}`);
console.log(`   distinct financier ledgers: ${JSON.stringify([...new Set(emi.map((r) => r.financier_ledger || `(none: ${r.bank_name})`))])}`);

// ── 2. VENDOR ─────────────────────────────────────────────────────────────
const vt = await q(`SELECT id, legacy_id, txn_date::text AS d, txn_type, amount, remarks, vendor_name FROM vendor_txns ORDER BY txn_date`);
const vtDup = await q(
  `SELECT vendor_name, txn_date::text AS d, txn_type, amount::text AS amt, remarks, count(*)::int AS n
     FROM vendor_txns GROUP BY 1,2,3,4,5 HAVING count(*) > 1 ORDER BY 6 DESC`);
console.log(`\nVENDOR_TXNS: ${vt.length} rows, ${inr(vt.reduce((a, r) => a + Number(r.amount || 0), 0))}`);
console.log(`   by type: ${JSON.stringify(vt.reduce((m, r) => (m[r.txn_type] = (m[r.txn_type] || 0) + 1, m), {}))}`);
console.log(`   future-dated: ${vt.filter((r) => r.d > today).length}  ${JSON.stringify(vt.filter((r) => r.d > today).map((r) => `${r.d} ${r.remarks} ${r.amount}`))}`);
console.log(`   exact duplicates (vendor+date+type+amount+ref): ${vtDup.length} group(s)`);
vtDup.forEach((g) => console.log(`      ${g.n}x  ${g.d} ${g.txn_type} ${inr(g.amt)} ${g.remarks}`));
const dupExtra = vtDup.reduce((a, g) => a + (g.n - 1) * Number(g.amt), 0);
console.log(`   money in the surplus copies: ${inr(dupExtra)}`);

// ── 3. TYRES ──────────────────────────────────────────────────────────────
const ty = await q(
  `SELECT invoice_no, vendor_name, count(*)::int AS n, sum(purchase_cost)::text AS amt,
          min(purchase_date)::text AS d FROM tyres GROUP BY 1,2 ORDER BY 5`);
console.log(`\nTYRES: ${ty.reduce((a, r) => a + r.n, 0)} tyres in ${ty.length} invoice groups, ${inr(ty.reduce((a, r) => a + Number(r.amt), 0))}`);
ty.forEach((r) => console.log(`   ${r.d}  ${String(r.invoice_no).padEnd(18)} ${String(r.vendor_name).padEnd(22)} n=${r.n}  ${inr(r.amt)}`));
console.log(`   future-dated: ${ty.filter((r) => r.d > today).length}`);

// ── 4. what the target ledgers must be ────────────────────────────────────
const needed = ['Tyre Stock', 'Interest on Vehicle Loans', 'SBI (8490)', 'Cash in Hand (HQ)',
                'Toll & Fastag Expense', 'Creditors: AGARWAL TRADING', 'Creditors: HALDIA RETREADING CO'];
console.log('\nLEDGERS the postings will need:');
for (const n of needed) {
  const [r] = await q(`SELECT ledger_name, group_head FROM ledgers WHERE lower(ledger_name)=lower($1) LIMIT 1`, [n]);
  console.log(`   ${n.padEnd(34)} ${r ? 'EXISTS (' + r.group_head + ')' : '** MISSING — TARA would have to create it **'}`);
}
const [fin] = await q(`SELECT string_agg(DISTINCT financier_ledger, ' | ') AS f FROM loan_master WHERE financier_ledger IS NOT NULL`);
console.log(`   loan financier ledgers: ${fin.f ?? '(none set)'}`);

// ── 5. already posted? ────────────────────────────────────────────────────
console.log('\nALREADY IN THE LEDGER (would be a duplicate post):');
for (const [label, st] of [['EMI', 'LOAN_EMI'], ['vendor', 'VENDOR_PAYMENT'], ['tyre', 'TYRE_PURCHASE'], ['toll', 'TOLL_STATEMENT']]) {
  const [r] = await q(`SELECT count(*)::int AS n, to_char(coalesce(sum(amount),0),'FM99999999990.00') AS amt
                         FROM ledger_entries WHERE source_type = $1`, [st]);
  console.log(`   ${label.padEnd(8)} source_type=${st.padEnd(16)} ${r.n} entries  Rs ${r.amt}`);
}
console.log();
await closePool();
