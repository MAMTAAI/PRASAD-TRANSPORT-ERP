// server/db/seed/post-missing-history.js
// ---------------------------------------------------------------------------
// Posts the accounting history that reached PostgreSQL as RECORDS but never as
// LEDGER ENTRIES. Every voucher goes through TARA — nothing here writes
// ledger_entries directly, because nothing is allowed to.
//
//   node server/db/seed/post-missing-history.js            DRY RUN
//   node server/db/seed/post-missing-history.js --live     commit
//
// Vouchers carry their ORIGINAL transaction date, so the monthly P&L becomes
// true rather than everything landing on the migration day. ref_no is
// deterministic (HIST-<kind>-<legacy_id>), so a replay returns 409 DUPLICATE_REF
// from TARA instead of posting twice — re-running this is safe.
//
// WHAT IT REFUSES TO POST, and why. The ledger is append-only; a wrong voucher
// costs a reversal. So anything that cannot be justified from the source is
// quarantined into the report instead of guessed at:
//
//   * the 17 Firestore JOURNAL 'EMI' documents (Rs 5.58 CRORE). Blank dates,
//     blank loan names ('Loan: '), interest 0, amounts that are round sanction
//     principals rather than instalments, posted_by 'system_backfill', and 0 of
//     17 reference a real EMI_PAYMENTS record. That is a broken backfill, not
//     history. Posting it would have inflated the books by 5.58 crore.
//   * vendor rows dated in the FUTURE (Dec 2026 against a run date of Aug 2026).
//   * exact duplicate vendor rows — same vendor, date, type, amount and invoice
//     ref. One invoice is one bill; the surplus copies are UI double-submits.
//   * the toll statements. Rs 6.23L of the toll transactions are booked to
//     JAISWAL ENTERPRISE rather than PRASAD TRANSPORT, and FASTag recharges
//     (Rs 11.49L) do not cover the spend (Rs 14.56L), so the wallet's credit
//     side cannot be stated honestly yet. That is an entity-allocation decision
//     for the owner, not something a migration should decide.
// ---------------------------------------------------------------------------
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';
import { initDb, query, closePool, DB_TARGET } from '../pool.js';
import { postVoucher } from '../../agents/tara.js';

const LIVE = process.argv.includes('--live');
const TODAY = new Date().toISOString().slice(0, 10);
const BANK = 'SBI (8490)';                      // the account every source names
const SPARES = 'Vehicle Spares & Repairs';      // see the note where it is used

const report = { target: null, mode: LIVE ? 'LIVE' : 'DRY-RUN', posted: [], quarantined: [], totals: {} };
const hold = (kind, id, why, amount) => report.quarantined.push({ kind, id, why, amount });

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const inr = (n) => 'Rs ' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 });

await initDb();
report.target = DB_TARGET;
console.log(`[post-history] ${report.mode} - target ${DB_TARGET}`);

const q = async (s, p = []) => (await query(s, p)).rows;
let posted = 0, skipped409 = 0;

async function post(v, kind, amount) {
  if (!LIVE) { report.posted.push({ kind, ref: v.ref_no, date: v.entry_date, amount }); posted++; return; }
  try {
    const out = await postVoucher(v);
    report.posted.push({ kind, ref: v.ref_no, date: v.entry_date, amount, voucher_id: out.voucher_id });
    posted++;
  } catch (e) {
    if (e.code === 'DUPLICATE_REF' || /duplicate/i.test(e.message || '')) { skipped409++; return; }
    throw Object.assign(new Error(`${kind} ${v.ref_no}: ${e.message}`), { cause: e });
  }
}

// ── 1. EMI: the three-leg journal the loan screen posts today ──────────────
// Dr the loan (principal repaid) + Dr interest (the real expense) / Cr bank.
// The old Firestore screen wrote ONE bank row for the total, so interest never
// appeared as an expense at all. The financier ledger name matches
// assets.routes.js exactly, so history and future postings share one account.
const emis = await q(
  `SELECT e.legacy_id, e.payment_date::text AS d, e.total_paid, e.principal_part, e.interest_part,
          e.ref_no, e.emi_month, l.bank_name, l.vehicle_no, l.financier_ledger
     FROM emi_payments e JOIN loan_master l ON l.id = e.loan_id
    WHERE e.legacy_id IS NOT NULL ORDER BY e.payment_date`);
let emiTotal = 0;
for (const e of emis) {
  const total = r2(e.total_paid), principal = r2(e.principal_part), interest = r2(e.interest_part);
  if (!e.d) { hold('EMI', e.legacy_id, 'no payment_date', total); continue; }
  if (e.d > TODAY) { hold('EMI', e.legacy_id, `dated in the future (${e.d})`, total); continue; }
  if (r2(principal + interest) !== total) { hold('EMI', e.legacy_id, `principal + interest != total (${principal}+${interest} vs ${total})`, total); continue; }
  const financier = e.financier_ledger || `Loan: ${e.bank_name || 'Financier'}${e.vehicle_no ? ` (${e.vehicle_no})` : ''}`;
  const legs = [{ ledger: financier, dr_cr: 'DR', amount: principal, group: 'Secured Loans' }];
  if (interest > 0) legs.push({ ledger: 'Interest on Vehicle Loans', dr_cr: 'DR', amount: interest, group: 'Finance Costs' });
  legs.push({ ledger: BANK, dr_cr: 'CR', amount: total, group: 'Bank Accounts' });
  await post({
    type: 'JOURNAL', entry_date: e.d, source_type: 'LOAN_EMI', ref_no: `HIST-EMI-${e.legacy_id}`,
    narration: `EMI ${e.emi_month ?? ''} ${e.vehicle_no ?? ''} (P ${principal} + I ${interest}) ref ${e.ref_no ?? ''}`.trim(),
    created_by: 'history-migration', lines: legs,
  }, 'EMI', total);
  emiTotal += total;
}
report.totals.EMI = emiTotal;
console.log(`  EMI              posted ${emis.length - report.quarantined.filter((x) => x.kind === 'EMI').length}/${emis.length}  ${inr(emiTotal)}`);

// ── 2. VENDOR ──────────────────────────────────────────────────────────────
// BILL_RECEIVED raises a liability; PAYMENT_GIVEN settles it. The Firestore
// JOURNAL posted all 18 as Dr Creditors / Cr Bank, which is simply wrong for
// the 13 bills — it would have paid off debts that were never recorded.
//
// The source carries no line detail for the bills, so the debit is booked to a
// clearly-named account rather than a guessed classification. It sits in the
// Repairs & Tyres group because this vendor is a tyre and spares trader; the
// name says plainly that the detail is not known.
const vts = await q(
  `SELECT legacy_id, txn_date::text AS d, txn_type, amount, remarks, vendor_name
     FROM vendor_txns WHERE legacy_id IS NOT NULL ORDER BY txn_date, legacy_id`);
const seen = new Map();
let vendorTotal = 0, vendorPosted = 0;
for (const v of vts) {
  const amt = r2(v.amount);
  if (!v.d) { hold('VENDOR', v.legacy_id, 'no txn_date', amt); continue; }
  if (v.d > TODAY) { hold('VENDOR', v.legacy_id, `dated in the future (${v.d}) — ${v.txn_type} ${v.remarks}`, amt); continue; }
  const key = `${v.vendor_name}|${v.d}|${v.txn_type}|${amt}|${String(v.remarks ?? '').slice(0, 40)}`;
  if (seen.has(key)) { hold('VENDOR', v.legacy_id, `exact duplicate of ${seen.get(key)} (same vendor, date, type, amount and ref)`, amt); continue; }
  seen.set(key, v.legacy_id);

  const creditor = `Creditors: ${v.vendor_name}`;
  const isCreditNote = /credit note/i.test(String(v.remarks ?? ''));
  let lines;
  if (v.txn_type === 'PAYMENT_GIVEN' && isCreditNote) {
    // A credit note is not cash leaving the bank. It reduces what we owe and
    // reverses the original charge; treating it as a payment would overstate
    // both the outflow and the expense.
    lines = [{ ledger: creditor, dr_cr: 'DR', amount: amt, group: 'Sundry Creditors (Vendors)' },
             { ledger: SPARES, dr_cr: 'CR', amount: amt, group: 'Direct Expenses - Repairs & Tyres' }];
  } else if (v.txn_type === 'PAYMENT_GIVEN') {
    lines = [{ ledger: creditor, dr_cr: 'DR', amount: amt, group: 'Sundry Creditors (Vendors)' },
             { ledger: BANK, dr_cr: 'CR', amount: amt, group: 'Bank Accounts' }];
  } else {
    lines = [{ ledger: SPARES, dr_cr: 'DR', amount: amt, group: 'Direct Expenses - Repairs & Tyres' },
             { ledger: creditor, dr_cr: 'CR', amount: amt, group: 'Sundry Creditors (Vendors)' }];
  }
  await post({
    type: 'JOURNAL', entry_date: v.d, source_type: 'VENDOR_PAYMENT', ref_no: `HIST-VEN-${v.legacy_id}`,
    narration: `${v.txn_type} ${v.vendor_name} ${v.remarks ?? ''}`.trim(),
    created_by: 'history-migration', lines,
  }, 'VENDOR', amt);
  vendorTotal += amt; vendorPosted++;
}
report.totals.VENDOR = vendorTotal;
console.log(`  VENDOR           posted ${vendorPosted}/${vts.length}  ${inr(vendorTotal)}`);

// ── 3. TYRES: stock in, one voucher per invoice ────────────────────────────
// Dr Tyre Stock / Cr the vendor (or the bank for a cash purchase), exactly as
// migration 036 and /assets/tyres do today. This is also the opening-stock
// entry: it puts the 22 migrated tyres onto the balance sheet at cost, and it
// subsumes the 11 tyre rows in BANK_TRANSACTIONS — which are NOT used, because
// they contain a duplicate (CR/326 twice) that would overstate the purchase.
const groups = await q(
  `SELECT invoice_no, vendor_name, min(purchase_date)::text AS d,
          sum(purchase_cost) AS amt, count(*)::int AS n
     FROM tyres WHERE legacy_id IS NOT NULL
     GROUP BY 1,2 ORDER BY 3`);
let tyreTotal = 0, tyrePosted = 0;
for (const g of groups) {
  const amt = r2(g.amt);
  if (!g.d || g.d > TODAY) { hold('TYRE', g.invoice_no, `bad purchase_date (${g.d})`, amt); continue; }
  const isCash = String(g.vendor_name).toUpperCase() === 'CASH PURCHASE';
  await post({
    type: 'JOURNAL', entry_date: g.d, source_type: 'TYRE_PURCHASE',
    ref_no: `HIST-TYRE-${String(g.invoice_no).replace(/[^A-Za-z0-9]/g, '-')}`,
    narration: `Tyre purchase ${g.invoice_no} — ${g.n} tyre(s) from ${g.vendor_name}`,
    created_by: 'history-migration',
    lines: [
      { ledger: 'Tyre Stock', dr_cr: 'DR', amount: amt, group: 'Stock-in-Hand (Asset)' },
      isCash ? { ledger: BANK, dr_cr: 'CR', amount: amt, group: 'Bank Accounts' }
             : { ledger: `Creditors: ${g.vendor_name}`, dr_cr: 'CR', amount: amt, group: 'Sundry Creditors (Vendors)' },
    ],
  }, 'TYRE', amt);
  tyreTotal += amt; tyrePosted++;
}
report.totals.TYRE = tyreTotal;
console.log(`  TYRE             posted ${tyrePosted}/${groups.length}  ${inr(tyreTotal)}`);

// ── 4. deliberately not posted ─────────────────────────────────────────────
const [toll] = await q(
  `SELECT count(*)::int AS n, to_char(coalesce(sum(amount),0),'FM99999990.00') AS amt,
          to_char(coalesce(sum(amount) FILTER (WHERE company='JAISWAL ENTERPRISE'),0),'FM99999990.00') AS other_entity
     FROM toll_transactions`);
hold('TOLL', 'all', `${toll.n} toll transactions worth Rs ${toll.amt} are loaded as RECORDS but not posted: Rs ${toll.other_entity} of it is booked to JAISWAL ENTERPRISE, and FASTag recharges do not cover the spend, so the credit side cannot be stated honestly yet. Needs an entity-allocation decision.`, Number(toll.amt));
hold('JOURNAL_EMI', '17 docs', 'Firestore JOURNAL EMI backfill: blank dates, blank loan names, interest 0, sanction-sized amounts, 0/17 match a real EMI payment. Corrupt — never post.', 55850000);

report.totals.GRAND = emiTotal + vendorTotal + tyreTotal;
const out = join(process.cwd(), 'backups', `history-post-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
console.log(`\n  TOTAL POSTED     ${inr(report.totals.GRAND)}   vouchers=${posted}${skipped409 ? `  (${skipped409} already present, 409)` : ''}`);
console.log(`  quarantined      ${report.quarantined.length} item(s)`);
for (const h of report.quarantined) console.log(`     ${h.kind.padEnd(12)} ${String(h.id).padEnd(24)} ${h.why.slice(0, 96)}`);
console.log(`  report: ${out}`);
if (!LIVE) console.log('\n  DRY RUN - nothing was posted. Re-run with --live.');
await closePool();
