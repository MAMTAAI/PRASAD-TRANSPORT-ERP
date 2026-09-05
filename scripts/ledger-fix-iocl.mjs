// scripts/ledger-fix-iocl.mjs
// ─────────────────────────────────────────────────────────────────────────────
// THE IOCL DEBTOR, MADE ONE LEDGER — the corrections the 5-Sep audit found.
//
// What production held for INDIAN OIL CORPORATION LTD (Prasad Transport's books):
//   · revenue was raised on 'Debtors: INDIAN OIL CORPORATION LTD' (BILL_RAISED)
//   · receipts were credited to the plain-named 'INDIAN OIL CORPORATION LTD'
//     (ADVICE_SETTLEMENT), so neither ledger could ever clear
//   · 25 "assumed" receipts (VOUCHER IOCL-…, booked from the bill before any
//     advice existed) were never reversed — the route guard refused the
//     reversal because it named no firm
//   · IOCL's CCMS diesel recovery (₹62.6 L) was debited to fuel EXPENSE; by the
//     owner's rule it is IOCL loading OUR XtraPower card — an asset movement
//
// Three journals, each deterministic (a re-run is a DUPLICATE_REF no-op), each
// in Prasad Transport's books, each append-only with a narration that says why:
//   1. REV-IOCL-…      the 25 assumed receipts, reversed (post-advice-settlements --reverse-legacy)
//   2. CBFIX_DEBTOR_…  the plain ledger's remaining balance moved onto 'Debtors: …'
//   3. CBFIX_CCMS_…    CCMS recovery moved from fuel expense to the IOCL card wallet
//
// NOT touched, on purpose: 58 FREIGHT_INCOME journals (₹1.43 cr, Apr–Jul) that
// debit the plain ledger with references matching no trip and no AC5 bill.
// They may be the old per-bill revenue posting and therefore a second posting
// of revenue the INV bills also raised — but that is a judgement for a person
// with the old script in front of them. The dry run prints the figures.
//
//   node scripts/ledger-fix-iocl.mjs            # dry run: evidence + what would post
//   node scripts/ledger-fix-iocl.mjs --live
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
dotenv.config();

const LIVE = process.argv.includes('--live');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { query, closePool, initDb } = await import('../server/db/pool.js');
const { postVoucher } = await import('../server/agents/tara.js');
await initDb({ attempts: 1, quiet: true });

const CUSTOMER = 'INDIAN OIL CORPORATION LTD';
const DEBTOR = `Debtors: ${CUSTOMER}`;
const DEBTOR_GROUP = 'Sundry Debtors (Customers)';
const FUEL_EXPENSE = 'Direct Expenses - Fuel & HSD';
const money = (v) => Math.round(Number(v ?? 0) * 100) / 100;
const inr = (v) => '₹' + Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bal = async (ledger) => money((await query(`SELECT COALESCE(sum(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END),0) AS b FROM ledger_entries WHERE ledger_name = $1`, [ledger])).rows[0].b);

const { rows: [firm] } = await query(`SELECT id, company_name FROM companies WHERE company_name ILIKE '%PRASAD TRANSPORT%' LIMIT 1`);
const { rows: [acct] } = await query(`SELECT wallet_ledger FROM fleet_card_accounts WHERE provider='IOCL' AND active AND wallet_ledger IS NOT NULL AND operating_company ILIKE '%PRASAD%' LIMIT 1`);
const WALLET = acct?.wallet_ledger ?? 'IOCL XTRAPOWER Card Wallet';
console.log(`\n${'='.repeat(76)}\n IOCL DEBTOR LEDGER — CORRECTIONS   [${LIVE ? 'LIVE' : 'DRY RUN'}]\n${'='.repeat(76)}`);
console.log(` firm: ${firm?.company_name}   debtor: ${DEBTOR}   card wallet: ${WALLET}`);

const { rows: bySource } = await query(`
  SELECT source_type, count(*)::int AS n, sum(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END)::numeric(14,2) AS net_dr
    FROM ledger_entries WHERE ledger_name = $1 GROUP BY 1 ORDER BY 1`, [CUSTOMER]);
console.log(`\n plain ledger '${CUSTOMER}' by source:`);
for (const r of bySource) console.log(`   ${r.source_type.padEnd(20)} ${String(r.n).padStart(4)}  ${inr(r.net_dr).padStart(18)}`);
console.log(`   balance (Dr+) ${inr(await bal(CUSTOMER))}   ·   '${DEBTOR}' ${inr(await bal(DEBTOR))}`);

const post = async (label, body) => {
  try { const r = await postVoucher({ ...body, company_id: firm?.id ?? null, created_by: 'ledger-fix-iocl', dry_run: !LIVE }); console.log(`  ✓ ${label}${LIVE ? '' : ' (validated, rolled back)'}`); return r; }
  catch (e) { if (e.code === 'DUPLICATE_REF') { console.log(`  · ${label}: already posted`); return { skipped: true }; } console.log(`  x ${label}: ${e.code ?? ''} ${e.message.slice(0, 160)}`); return null; }
};

// ── 1. the assumed receipts still standing ────────────────────────────────
console.log(`\n 1. assumed receipts (VOUCHER IOCL-…) not yet reversed`);
const r1 = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'post-advice-settlements.mjs'), '--reverse-legacy', ...(LIVE ? ['--live'] : [])], { cwd: REPO, encoding: 'utf8' });
const tail1 = (r1.stdout || '').split('\n').filter((l) => /reversed|failed|x reverse/.test(l)).slice(-4).join('\n');
console.log(tail1 || r1.stderr?.slice(-300));

// ── 2. one debtor ledger ──────────────────────────────────────────────────
console.log(`\n 2. move the plain ledger's balance onto '${DEBTOR}'`);
const plain = await bal(CUSTOMER);
if (Math.abs(plain) > 0.005) {
  const amt = money(Math.abs(plain));
  const stamp = new Date().toISOString().slice(0, 10);
  await post(`CBFIX_DEBTOR ${inr(amt)} (${plain < 0 ? 'credits' : 'debits'} on the plain ledger → Debtors)`, {
    type: 'JOURNAL', source_type: 'CUSTOMER_LEDGER_FIX', ref_no: `CBFIX_DEBTOR_${CUSTOMER.replace(/\s+/g, '_')}_${stamp}`, entry_date: stamp,
    narration: `Correction: balance of the plain-named ledger '${CUSTOMER}' (receipts, reversals, old revenue) moved onto '${DEBTOR}' — one customer, one ledger (audit 5-Sep-2026)`,
    lines: plain < 0
      ? [{ ledger: CUSTOMER, dr_cr: 'DR', amount: amt, group: DEBTOR_GROUP }, { ledger: DEBTOR, dr_cr: 'CR', amount: amt, group: DEBTOR_GROUP }]
      : [{ ledger: DEBTOR, dr_cr: 'DR', amount: amt, group: DEBTOR_GROUP }, { ledger: CUSTOMER, dr_cr: 'CR', amount: amt, group: DEBTOR_GROUP }],
  });
} else console.log('  · nothing on the plain ledger');

// ── 3. CCMS is the card, not diesel ───────────────────────────────────────
console.log(`\n 3. CCMS recovery: fuel expense → ${WALLET}`);
const { rows: [cc] } = await query(`SELECT COALESCE(sum(amount) FILTER (WHERE dr_cr='DR'),0)::numeric(14,2) AS amt FROM ledger_entries WHERE source_type='ADVICE_SETTLEMENT' AND ledger_name=$1`, [FUEL_EXPENSE]);
const { rows: [dn] } = await query(`SELECT COALESCE(sum(amount) FILTER (WHERE dr_cr='CR'),0)::numeric(14,2) AS amt FROM ledger_entries WHERE source_type='CUSTOMER_LEDGER_FIX' AND ledger_name=$1`, [FUEL_EXPENSE]);
const ccms = money(Number(cc.amt) - Number(dn.amt));
if (ccms > 0.005) {
  const stamp = new Date().toISOString().slice(0, 10);
  await post(`CBFIX_CCMS ${inr(ccms)}`, {
    type: 'JOURNAL', source_type: 'CUSTOMER_LEDGER_FIX', ref_no: `CBFIX_CCMS_${stamp}`, entry_date: stamp,
    narration: `Correction: IOCL CCMS diesel recovery is the customer recharging our fleet card, not a second fuel expense — moved from '${FUEL_EXPENSE}' to '${WALLET}' (owner's rule 5-Sep-2026)`,
    lines: [{ ledger: WALLET, dr_cr: 'DR', amount: ccms, group: 'Prepaid Cards & Wallets (Asset)' }, { ledger: FUEL_EXPENSE, dr_cr: 'CR', amount: ccms, group: FUEL_EXPENSE }],
  });
} else console.log('  · already moved');

// ── the open question, stated, not acted on ───────────────────────────────
const { rows: [fi] } = await query(`SELECT count(*)::int AS n, COALESCE(sum(amount),0)::numeric(14,2) AS amt, min(entry_date) AS d1, max(entry_date) AS d2 FROM ledger_entries WHERE source_type='FREIGHT_INCOME' AND dr_cr='DR' AND ledger_name=$1`, [CUSTOMER]);
console.log(`\n OPEN FOR A PERSON: ${fi.n} FREIGHT_INCOME journal(s) ${inr(fi.amt)} (${fi.d1} → ${fi.d2}) debit the IOCL ledger with references matching no trip and no AC5 bill. If they are the old per-bill revenue posting, the INV bills (BILL_RAISED) raised that revenue again — reverse them only after checking the old script.`);
if (LIVE) console.log(`\n after: '${DEBTOR}' ${inr(await bal(DEBTOR))}   plain '${CUSTOMER}' ${inr(await bal(CUSTOMER))}`);
else console.log('\n DRY RUN — nothing posted. Re-run with --live.');
await closePool();
