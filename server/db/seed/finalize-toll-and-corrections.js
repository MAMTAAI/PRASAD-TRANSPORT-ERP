// server/db/seed/finalize-toll-and-corrections.js
// ---------------------------------------------------------------------------
// The three items the owner ruled on, applied.
//
//   node server/db/seed/finalize-toll-and-corrections.js            DRY RUN
//   node server/db/seed/finalize-toll-and-corrections.js --live     commit
//
// 1. TOLL IS A RECEIVABLE, NOT AN EXPENSE.
//    The oil company runs two arrangements. Under the first it issues the toll
//    card itself, so that toll never touches our books at all — which is why no
//    such row exists in this data. Under the second we pay the toll on the trip
//    and the oil company reimburses it later. Every one of the 2,870 rows is
//    marked 'Reimbursable (Bill to Co.)' with is_billable = true, so all of them
//    are the second kind.
//
//    That makes the toll a claim on the oil company, not a cost of running the
//    truck. Booking it as an expense would have overstated direct costs by
//    Rs 14.56L and understated assets by the same amount, and the profit on
//    every reimbursable trip would have read low.
//
//        toll paid      Dr Toll Reimbursement Receivable / Cr the FASTag wallet
//        wallet top-up  Dr the FASTag wallet             / Cr bank
//        (later)        Dr bank                          / Cr the receivable
//
//    PRASAD TRANSPORT and JAISWAL ENTERPRISE each run their own FASTag wallet
//    with its own recharges, so each gets its own wallet account and every
//    voucher carries its company. The split is the arrangement working as
//    intended, not contamination.
//
// 2. FOUR VENDOR BILLS CARRY A YEAR TYPO. Dated Dec 2026 against a run date of
//    Aug 2026. Corrected to 2025 on the owner's instruction, which CR/908
//    independently confirms: CR/907 and CR/909 are both 22 Dec 2025, and
//    CR/908 sits between them. The record's own date is corrected too, so the
//    khata and the ledger cannot disagree, and the change is stamped in remarks.
//
// 3. THE UNIDENTIFIED FUEL BILL STAYS IN SUSPENSE. Rs 1,34,241 is already
//    carried in 'MIGRATION: unresolved ledger' under Suspense A/c, which is
//    exactly where the owner wants it until it can be tallied against the
//    pump's physical statement. Nothing to post — the balance is already there
//    and correctly grouped. This script only verifies and reports it.
// ---------------------------------------------------------------------------
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';
import { initDb, query, closePool, DB_TARGET } from '../pool.js';
import { postVoucher } from '../../agents/tara.js';

const LIVE = process.argv.includes('--live');
const BANK = 'SBI (8490)';
const RECEIVABLE = 'Toll Reimbursement Receivable';
const RECEIVABLE_GROUP = 'Loans & Advances (Asset)';
const WALLET_GROUP = 'Prepaid Cards & Wallets (Asset)';
const walletFor = (company) => `FASTag Wallet: ${company === 'JAISWAL ENTERPRISE' ? 'Jaiswal Enterprise' : 'Prasad Transport'}`;
const slug = (s) => String(s).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toUpperCase();
const inr = (n) => 'Rs ' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 });

const report = { target: null, mode: LIVE ? 'LIVE' : 'DRY-RUN', steps: {}, notes: [] };
let posted = 0, dup = 0;

await initDb();
report.target = DB_TARGET;
console.log(`[finalize] ${report.mode} - target ${DB_TARGET}`);
const q = async (s, p = []) => (await query(s, p)).rows;

async function post(v) {
  if (!LIVE) { posted++; return; }
  try { await postVoucher(v); posted++; }
  catch (e) {
    if (e.code === 'DUPLICATE_REF' || /duplicate/i.test(e.message || '')) { dup++; return; }
    throw Object.assign(new Error(`${v.ref_no}: ${e.message}`), { cause: e });
  }
}

// ── 1. year typo on the four vendor bills ─────────────────────────────────
const future = await q(
  `SELECT legacy_id, txn_date::text AS d, txn_type, amount, remarks, vendor_name
     FROM vendor_txns WHERE txn_date > current_date ORDER BY txn_date`);
// CR/1073 is in here TWICE, and it is also one of the exact duplicates the
// first pass quarantined — it was held for being future-dated before the
// duplicate rule ever saw it. Correcting the year without re-applying that rule
// would post Rs 1,43,300 twice for a single invoice. The dedupe key is the
// invoice ref as written, before the migration's own stamp.
const seenBill = new Map();
let fixed = 0, fixedAmt = 0, dropped = 0;
for (const v of future) {
  const corrected = `${Number(v.d.slice(0, 4)) - 1}${v.d.slice(4)}`;
  const bill = String(v.remarks ?? '').split('[')[0].trim();
  const key = `${v.vendor_name}|${corrected}|${v.txn_type}|${Number(v.amount)}|${bill}`;
  if (seenBill.has(key)) {
    dropped++;
    console.log(`  DUPLICATE ${bill} ${inr(v.amount)} — already posted as ${seenBill.get(key)}, not posted again`);
    if (LIVE) {
      await query(
        `UPDATE vendor_txns SET txn_date = $2::date,
                remarks = coalesce(remarks,'') || ' [year corrected ' || $3 || ' -> ' || $2 || '; duplicate of ' || $4 || ', not posted]'
          WHERE legacy_id = $1 AND txn_date > current_date`, [v.legacy_id, corrected, v.d, seenBill.get(key)]);
    }
    continue;
  }
  seenBill.set(key, v.legacy_id);
  if (LIVE) {
    await query(
      `UPDATE vendor_txns SET txn_date = $2::date,
              remarks = coalesce(remarks,'') || ' [year corrected ' || $3 || ' -> ' || $2 || ', owner-confirmed typo]'
        WHERE legacy_id = $1 AND txn_date > current_date`, [v.legacy_id, corrected, v.d]);
  }
  const amt = Number(v.amount);
  const creditor = `Creditors: ${v.vendor_name}`;
  await post({
    type: 'JOURNAL', entry_date: corrected, source_type: 'VENDOR_PAYMENT',
    ref_no: `HIST-VEN-${v.legacy_id}`,
    narration: `${v.txn_type} ${v.vendor_name} ${String(v.remarks ?? '').split('[')[0].trim()} (year corrected from ${v.d})`,
    created_by: 'history-migration',
    lines: v.txn_type === 'PAYMENT_GIVEN'
      ? [{ ledger: creditor, dr_cr: 'DR', amount: amt, group: 'Sundry Creditors (Vendors)' },
         { ledger: BANK, dr_cr: 'CR', amount: amt, group: 'Bank Accounts' }]
      : [{ ledger: 'Vehicle Spares & Repairs', dr_cr: 'DR', amount: amt, group: 'Direct Expenses - Repairs & Tyres' },
         { ledger: creditor, dr_cr: 'CR', amount: amt, group: 'Sundry Creditors (Vendors)' }],
  });
  fixed++; fixedAmt += amt;
  console.log(`  year fix  ${v.d} -> ${corrected}  ${inr(amt)}  ${String(v.remarks ?? '').split('[')[0].trim()}`);
}
report.steps.year_typo = { rows: fixed, amount: fixedAmt, duplicates_dropped: dropped };

// ── 2. FASTag wallet top-ups, then the toll spend ─────────────────────────
// Recharges first: the wallet has to be funded before it is drawn on, and
// posting them the other way round would make the wallet look overdrawn on
// every intermediate date.
const credits = await q(
  `SELECT credit_date::text AS d, provider, count(*)::int AS n, sum(amount) AS amt
     FROM fastag_credits GROUP BY 1,2 ORDER BY 1`);
let recTotal = 0;
for (const c of credits) {
  const company = /jaiswal/i.test(c.provider ?? '') ? 'JAISWAL ENTERPRISE' : 'PRASAD TRANSPORT';
  const amt = Number(c.amt);
  await post({
    type: 'JOURNAL', entry_date: c.d, source_type: 'FASTAG_RECHARGE', company,
    ref_no: `HIST-FTAG-${slug(company)}-${c.d}`,
    narration: `FASTag wallet top-up — ${c.n} credit(s), ${c.provider ?? 'unknown provider'}`,
    created_by: 'history-migration',
    lines: [
      { ledger: walletFor(company), dr_cr: 'DR', amount: amt, group: WALLET_GROUP },
      { ledger: BANK, dr_cr: 'CR', amount: amt, group: 'Bank Accounts' },
    ],
  });
  recTotal += amt;
}
report.steps.recharges = { vouchers: credits.length, amount: recTotal };
console.log(`  recharges ${credits.length} vouchers  ${inr(recTotal)}`);

const tolls = await q(
  `SELECT txn_date::text AS d, company, count(*)::int AS n, sum(amount) AS amt
     FROM toll_transactions GROUP BY 1,2 ORDER BY 1`);
let tollTotal = 0;
const byCompany = {};
for (const t of tolls) {
  const company = t.company ?? 'PRASAD TRANSPORT';
  const amt = Number(t.amt);
  await post({
    type: 'JOURNAL', entry_date: t.d, source_type: 'TOLL_REIMBURSABLE', company,
    ref_no: `HIST-TOLL-${slug(company)}-${t.d}`,
    narration: `Reimbursable toll — ${t.n} crossing(s), claimable from the oil company`,
    created_by: 'history-migration',
    lines: [
      { ledger: RECEIVABLE, dr_cr: 'DR', amount: amt, group: RECEIVABLE_GROUP },
      { ledger: walletFor(company), dr_cr: 'CR', amount: amt, group: WALLET_GROUP },
    ],
  });
  tollTotal += amt;
  byCompany[company] = (byCompany[company] ?? 0) + amt;
}
report.steps.toll = { vouchers: tolls.length, amount: tollTotal, by_company: byCompany };
console.log(`  toll      ${tolls.length} vouchers  ${inr(tollTotal)}`);
for (const [c, a] of Object.entries(byCompany)) console.log(`              ${c.padEnd(20)} ${inr(a)}`);

// ── 3. the suspense item stays put; verify rather than post ───────────────
const [sus] = await q(
  `SELECT to_char(coalesce(sum(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END),0),'FM99999990.00') AS net,
          count(*)::int AS n
     FROM ledger_entries WHERE ledger_name = 'MIGRATION: unresolved ledger'`);
const [grp] = await q(`SELECT group_head FROM ledgers WHERE ledger_name = 'MIGRATION: unresolved ledger'`);
report.steps.suspense = { net: sus.net, entries: sus.n, group: grp?.group_head };
report.notes.push(`Suspense retained by owner decision: net ${sus.net} in '${grp?.group_head}', to be tallied manually against the pump's physical statement.`);
console.log(`  suspense  net ${sus.net} held in ${grp?.group_head} (owner will tally manually)`);

const out = join(process.cwd(), 'backups', `finalize-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
console.log(`\n  vouchers posted ${posted}${dup ? `  (${dup} already present, 409)` : ''}`);
console.log(`  report: ${out}`);
if (!LIVE) console.log('\n  DRY RUN - nothing posted.');
await closePool();
