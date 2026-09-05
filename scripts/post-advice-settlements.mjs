// scripts/post-advice-settlements.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Replaces the assumed receipts with what the payment advices actually say.
//
// TWO ERRORS ARE BEING CORRECTED, both mine:
//
//   1. The whole net of every bill was debited to SBI (8490). In reality IOCL
//      keeps back ~20% before remitting — HSD drawn on its CCMS fuel card, toll
//      it paid on our behalf, misc recoveries. The bank was overstated and fuel
//      and toll were never booked at all.
//
//   2. Receipts were posted for EVERY matched bill, including 34 bills that
//      have not been paid yet. Money was booked as received that never arrived.
//
// So the old receipts are reversed in full and the settlement is rebuilt from
// the advices — 23 documents that each tie to the rupee against the amount
// remitted. Nothing is posted for a bill with no advice; an unpaid bill simply
// keeps its receivable, which is the point.
//
// ledger_entries is append-only, so "reversing" means posting the mirror image.
// The original voucher stays visible forever, which is what an audit trail is
// for — a correction should be legible as a correction, not a rewrite.
//
// Per advice, one balanced journal:
//
//     Dr  SBI (8490)                     amount actually remitted
//     Dr  IOCL XTRAPOWER Card Wallet     CCMS recovery = IOCL loading our card (asset, not expense)
//     Dr  Direct Expenses - Toll & FASTag toll paid by IOCL
//     Dr  Shortage & Penalty             misc recoveries
//     Dr  TDS Receivable 194C            tax withheld
//         Cr  <customer>                     freight gross
//         Cr  Previous FY Pending Dues       prior-year loading settled here
//         Cr  IOCL Other Billed Income       non-freight billing
//         Cr  IOCL Unclassified Receipts     residual, named so it is visible
//
// It balances by construction: the advice's own arithmetic is
// remitted = gross − tds − recoveries + other income, rearranged.
//
//   node scripts/post-advice-settlements.mjs            # dry run
//   node scripts/post-advice-settlements.mjs --live
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config();

const LIVE = process.argv.includes('--live');
// The one-time reversal of the pre-advice "assumed" receipts (Aug-2026) is
// NOT part of the daily run: a scheduled job must never reverse a receipt on
// its own. Pass --reverse-legacy by hand to attempt the ones still standing.
const REVERSE_LEGACY = process.argv.includes('--reverse-legacy');
const { query, closePool, initDb } = await import('../server/db/pool.js');
const { postVoucher } = await import('../server/agents/tara.js');

const BANK = 'SBI (8490)';
// 5-Sep-2026 (migration 163): the receipt must land on the SAME ledger the
// revenue was raised on — 'Debtors: <customer>' — or the debtor never clears.
// Until today receipts went to the plain-named master ledger while BILL_RAISED
// debited 'Debtors: …'; the two never met (Rs2.02 cr sitting on each side).
const PARTY = 'Debtors: INDIAN OIL CORPORATION LTD';
const L = {
  // Owner's rule (5-Sep-2026): "oil company ka payment me HSD ka 35–40% direct
  // fleet account me jata hai, baaki bank me." The CCMS recovery is IOCL
  // loading OUR XtraPower card, not diesel burnt — the card's own sales book
  // the diesel when it is drawn. So it is an asset movement: Dr card wallet.
  // Resolved from fleet_card_accounts after the pool is up (see below).
  fuel: 'IOCL XTRAPOWER Card Wallet',
  toll: 'Direct Expenses - Toll & FASTag',
  misc: 'Shortage & Penalty',
  tds: 'TDS Receivable 194C',
  // Owner's classification (2026-08-12): these lines print as "RENTAL FOR
  // Lumding VMUS-TANK Terminal TRUCKS" on the advice but are settlement of
  // March-2026 loading, i.e. a prior financial year receivable — not current
  // income. Booked against the opening receivable so this year's P&L is not
  // inflated by last year's work.
  prevfy: 'Previous FY Pending Dues (IOCL)',
  otherinc: 'IOCL Other Billed Income',
  unclass: 'IOCL Unclassified Receipts',
};
const G = {
  fuel: 'Prepaid Cards & Wallets (Asset)',
  toll: 'Direct Expenses - Toll & FASTag',
  misc: 'Shortage & Penalty',
  tds: 'Loans & Advances (Asset)',
  prevfy: 'Sundry Debtors (Customers)',
  otherinc: 'Other Income',
  unclass: 'Suspense A/c',
  party: 'Sundry Debtors (Customers)',
  bank: 'Bank Accounts',
};

const money = (v) => Math.round(Number(v ?? 0) * 100) / 100;
const inr = (v) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

await initDb({ attempts: 1, quiet: true });
// The IOCL card wallet is whatever the fleet-card module calls it for the firm
// that runs IOCL's trucks (Prasad Transport). Never guess a ledger name twice.
{
  const { rows: [acct] } = await query(`
    SELECT wallet_ledger FROM fleet_card_accounts
     WHERE provider = 'IOCL' AND active AND wallet_ledger IS NOT NULL
     ORDER BY (operating_company ILIKE '%PRASAD%') DESC LIMIT 1`);
  if (acct?.wallet_ledger) L.fuel = acct.wallet_ledger;
}
// Whose books: IOCL's vendor code and SBI (8490) are Prasad Transport's. The
// ledger route guard (migration 147) refuses a voucher that names no firm and
// cannot derive one — 'Debtors: …' and the bank name nothing, so say it.
const { rows: [firm] } = await query(`SELECT id FROM companies WHERE company_name ILIKE '%PRASAD TRANSPORT%' ORDER BY company_name LIMIT 1`);
const COMPANY_ID = firm?.id ?? null;
console.log(`\n${'='.repeat(76)}\n ADVICE-LEVEL SETTLEMENT   [${LIVE ? 'LIVE' : 'DRY RUN'}]\n${'='.repeat(76)}`);
console.log(` party ledger: ${PARTY}   CCMS → ${L.fuel}`);

const stats = { reversed: 0, reverseSkipped: 0, settled: 0, settleSkipped: 0, failed: 0,
                bank: 0, fuel: 0, toll: 0, misc: 0, tds: 0 };

async function post(label, body) {
  try {
    return await postVoucher({ ...body, dry_run: !LIVE });
  } catch (err) {
    if (err.code === 'DUPLICATE_REF') { return { skipped: true }; }
    stats.failed++;
    console.log(`  x ${label}: ${err.code ?? ''} ${err.message.slice(0, 120)}`);
    return null;
  }
}

// ── 1. Reverse the assumed receipts ─────────────────────────────────────────
const { rows: originals } = await query(`
  SELECT voucher_id::text AS voucher_id, MIN(source_ref) AS ref, MIN(entry_date) AS entry_date,
         json_agg(json_build_object('ledger', ledger_name, 'dr_cr', dr_cr, 'amount', amount)) AS lines
    FROM ledger_entries
   WHERE source_type = 'VOUCHER' AND source_ref LIKE 'IOCL-%' AND $1::boolean
   GROUP BY voucher_id`, [REVERSE_LEGACY]);

console.log(`\n REVERSING ${originals.length} assumed receipt voucher(s)${REVERSE_LEGACY ? '' : ' (skipped — pass --reverse-legacy)'}`);
for (const o of originals) {
  const flipped = o.lines.map((l) => ({
    ledger: l.ledger,
    dr_cr: l.dr_cr === 'DR' ? 'CR' : 'DR',
    amount: money(l.amount),
    group: l.ledger === BANK ? G.bank : l.ledger === L.tds ? G.tds : G.party,
  }));
  const r = await post(`reverse ${o.ref}`, {
    type: 'JOURNAL',
    source_type: 'RECEIPT_REVERSAL',
    company_id: COMPANY_ID,
    ref_no: `REV-${o.ref}`,
    entry_date: o.entry_date,
    narration: `Reversal of ${o.ref} — receipt was assumed from the bill; actual settlement comes from the payment advice`,
    created_by: 'post-advice-settlements',
    lines: flipped,
  });
  if (r?.skipped) stats.reverseSkipped++; else if (r) stats.reversed++;
}

// ── 2. Post the real settlement, one journal per advice ─────────────────────
const { rows: advices } = await query(`
  SELECT a.advice_id::text AS advice_id, a.odn, a.advice_date, a.bank_ref, a.remitted,
         COALESCE(SUM(l.gross) FILTER (WHERE l.kind='FREIGHT_BILL'),0)::numeric(14,2)  AS freight,
         COALESCE(-SUM(l.tds),0)::numeric(14,2)                                        AS tds,
         COALESCE(-SUM(l.net) FILTER (WHERE l.kind='FUEL_CCMS_RECOVERY'),0)::numeric(14,2) AS fuel,
         COALESCE(-SUM(l.net) FILTER (WHERE l.kind='TOLL_RECOVERY'),0)::numeric(14,2)  AS toll,
         COALESCE(-SUM(l.net) FILTER (WHERE l.kind='MISC_RECOVERY'),0)::numeric(14,2)  AS misc,
         COALESCE(SUM(l.net) FILTER (WHERE l.kind='RENTAL_INCOME'),0)::numeric(14,2)   AS prevfy,
         COALESCE(SUM(l.net) FILTER (WHERE l.kind='OTHER_BILLED_INCOME'),0)::numeric(14,2) AS otherinc,
         COALESCE(SUM(l.net) FILTER (WHERE l.kind='OTHER'),0)::numeric(14,2)           AS unclass
    FROM iocl_payment_advices a
    JOIN iocl_advice_lines l USING (advice_id)
   GROUP BY a.advice_id, a.odn, a.advice_date, a.bank_ref, a.remitted
   ORDER BY a.advice_date`);

console.log(` SETTLING ${advices.length} advice(s)`);
for (const a of advices) {
  const lines = [];
  const dr = (ledger, amount, group) => { if (money(amount) > 0) lines.push({ ledger, dr_cr: 'DR', amount: money(amount), group }); };
  const cr = (ledger, amount, group) => { if (money(amount) > 0) lines.push({ ledger, dr_cr: 'CR', amount: money(amount), group }); };

  dr(BANK, a.remitted, G.bank);
  dr(L.fuel, a.fuel, G.fuel);
  dr(L.toll, a.toll, G.toll);
  dr(L.misc, a.misc, G.misc);
  dr(L.tds, a.tds, G.tds);
  cr(PARTY, a.freight, G.party);
  cr(L.prevfy, a.prevfy, G.prevfy);
  cr(L.otherinc, a.otherinc, G.otherinc);
  cr(L.unclass, a.unclass, G.unclass);

  // Negative-net buckets flip sides; keep the journal balanced either way.
  const bal = lines.reduce((s, l) => s + (l.dr_cr === 'DR' ? l.amount : -l.amount), 0);
  if (Math.abs(bal) > 0.005) {
    // A residual here means a bucket was negative. Park it rather than fudge a
    // line — it must be visible in Suspense, not silently absorbed.
    lines.push({ ledger: L.unclass, dr_cr: bal > 0 ? 'CR' : 'DR', amount: money(Math.abs(bal)), group: G.unclass });
  }

  const r = await post(`settle ${a.odn}`, {
    type: 'JOURNAL',
    source_type: 'ADVICE_SETTLEMENT',
    company_id: COMPANY_ID,
    ref_no: `ADV-${a.odn}`,
    entry_date: a.advice_date,
    narration: `IOCL payment advice ${a.odn} (UTR ${a.bank_ref ?? '-'}) — remitted ${inr(a.remitted)}, fuel ${inr(a.fuel)}, toll ${inr(a.toll)}, TDS ${inr(a.tds)}`,
    created_by: 'post-advice-settlements',
    lines,
  });
  if (r?.skipped) { stats.settleSkipped++; continue; }
  if (r) {
    stats.settled++;
    stats.bank += Number(a.remitted); stats.fuel += Number(a.fuel);
    stats.toll += Number(a.toll); stats.misc += Number(a.misc); stats.tds += Number(a.tds);
  }
}

console.log(`\n${'-'.repeat(76)}`);
console.log(`  receipts reversed : ${stats.reversed} (${stats.reverseSkipped} already)`);
console.log(`  advices settled   : ${stats.settled} (${stats.settleSkipped} already)`);
console.log(`  failed            : ${stats.failed}`);
console.log(`  bank remitted     : ${inr(stats.bank)}`);
console.log(`  fuel (CCMS)       : ${inr(stats.fuel)}`);
console.log(`  toll              : ${inr(stats.toll)}`);
console.log(`  misc recovery     : ${inr(stats.misc)}`);
console.log(`  TDS 194C          : ${inr(stats.tds)}`);

if (LIVE) {
  const { rows: [h] } = await query('SELECT * FROM v_accounting_health');
  const bad = Object.entries(h).filter(([k, v]) => k !== 'merged_aliases' && Number(v) !== 0);
  console.log(`\n  HEALTH: ${bad.length ? bad.map(([k, v]) => `${k}=${v}`).join(' ') : 'all zero'}`);
  const { rows } = await query(`
    SELECT ledger_name, balance_dr FROM v_ledger_balances
     WHERE ledger_name IN ($1,$2,$3,$4,$5,$6) ORDER BY ledger_name`,
    [BANK, PARTY, L.fuel, L.toll, L.tds, L.prevfy]);
  console.log('\n  BALANCES');
  for (const r of rows) console.log(`    ${r.ledger_name.padEnd(34)}${inr(r.balance_dr).padStart(16)}`);
} else {
  console.log('\n  DRY RUN — all validated and rolled back. Re-run with --live.');
}

await closePool();
