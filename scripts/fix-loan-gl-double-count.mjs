// scripts/fix-loan-gl-double-count.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Put back the loan liability that pre-cut-off EMI vouchers took off it twice.
//
//   node -r dotenv/config scripts/fix-loan-gl-double-count.mjs            dry run
//   node -r dotenv/config scripts/fix-loan-gl-double-count.mjs --commit
//
// ── WHAT WENT WRONG ────────────────────────────────────────────────────────
// The opening liability was struck at 01-04-2026 from the MODELLED principal
// outstanding on that date. By construction that figure already has every
// instalment due before the cut-off inside it — an opening balance is what is
// left after them.
//
// 21 of the 150 EMI payments are for February and March 2026, and each posted a
// three-leg JOURNAL that DEBITED the loan ledger with its principal. So the
// liability was reduced twice by the same 15,64,121.78: once inside the opening
// balance, once again by the voucher. Secured Loans on the balance sheet reads
// 1,71,50,128.29 where the loan module, after 083 fixed the same double-count on
// its own counters, says 1,87,14,397.65.
//
// The remaining 147.58 is the flooring 085 applied: three body loans whose
// modelled opening is 49 rupees short of the instalments that actually repay
// them, held at zero rather than allowed to go negative. Correcting it here
// squares the ledger with the module instead of leaving a debit balance on a
// liability nobody can explain.
//
// ── WHY A VOUCHER AND NOT AN UPDATE ────────────────────────────────────────
// ledger_entries is append-only by trigger and TARA is the only writer. A
// correction is a reversing entry, never an edit — the wrong figure stays on
// the record with the entry that fixes it beside it, which is the only version
// an auditor can follow. The contra is Opening Balance Difference, the same
// account the opening liability was struck against, because that is precisely
// what is being corrected.
//
// ── THE AMOUNT IS DERIVED, NOT TYPED ───────────────────────────────────────
// Per loan ledger: what the loan module says is outstanding, less what the GL
// has. Re-running after a successful pass computes zero and posts nothing, and
// TARA refuses a replayed reference anyway. Nothing here is a magic number.
//
// One wrinkle it has to respect: a GL loan ledger is named per VEHICLE and
// carries BOTH that truck's contracts — the chassis loan and the body loan. So
// the comparison is per ledger, summing the module figures of the loans that
// share it. Sixteen ledgers, twenty-nine loans.
// ─────────────────────────────────────────────────────────────────────────────
import { initDb, query, closePool, DB_TARGET } from '../server/db/pool.js';
import { postVoucher } from '../server/agents/tara.js';

const commit = process.argv.includes('--commit');
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const asOf = argOf('as-of', '2026-04-01');

const OPENING_CONTRA = 'Opening Balance Difference';
const OPENING_GROUP = 'Capital Account';
const LOAN_GROUP = 'Secured Loans';

const inr = (n) => Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });

async function main() {
  await initDb();
  console.log(`[loan-gl] ${DB_TARGET} · correcting the loan liability as at ${asOf}`
            + `${commit ? '' : ' · DRY RUN'}`);

  const { rows } = await query(`
    SELECT lm.financier_ledger AS ledger,
           lm.bank_name        AS financier,
           count(*)::int       AS loans,
           SUM(lm.remaining_principal)::numeric(14,2) AS module_total,
           COALESCE(gl.bal, 0)::numeric(14,2)         AS gl_total,
           (SUM(lm.remaining_principal) - COALESCE(gl.bal, 0))::numeric(14,2) AS correction
      FROM loan_master lm
      LEFT JOIN LATERAL (
        SELECT SUM(CASE WHEN e.dr_cr = 'CR' THEN e.amount ELSE -e.amount END) AS bal
          FROM ledger_entries e WHERE e.ledger_name = lm.financier_ledger) gl ON true
     WHERE lm.financier_ledger IS NOT NULL
     GROUP BY lm.financier_ledger, lm.bank_name, gl.bal
     ORDER BY lm.financier_ledger`);

  const needed = rows.filter((r) => Math.abs(Number(r.correction)) > 0.05);

  console.log(`\n${'LEDGER'.padEnd(44)}${'LOANS'.padStart(6)}${'MODULE'.padStart(16)}`
            + `${'GL'.padStart(16)}${'CORRECTION'.padStart(15)}`);
  console.log('-'.repeat(97));
  for (const r of rows) {
    console.log(r.ledger.padEnd(44) + String(r.loans).padStart(6)
      + inr(r.module_total).padStart(16) + inr(r.gl_total).padStart(16)
      + (Math.abs(Number(r.correction)) > 0.05 ? inr(r.correction) : '—').padStart(15));
  }

  const total = needed.reduce((a, r) => a + Number(r.correction), 0);
  console.log(`\n  ledgers            : ${rows.length}`);
  console.log(`  needing correction : ${needed.length}`);
  console.log(`  total correction   : ${inr(total)}`);

  if (!needed.length) {
    console.log('\n  Nothing to do — the ledger already agrees with the loan module.');
    await closePool();
    return;
  }
  if (!commit) {
    console.log('\n  DRY RUN — nothing posted. Re-run with --commit.');
    await closePool();
    return;
  }

  let posted = 0, skipped = 0;
  const problems = [];
  for (const r of needed) {
    const amount = Number(Number(r.correction).toFixed(2));
    const understated = amount > 0;
    try {
      const voucher = await postVoucher({
        type: 'JOURNAL',
        source_type: 'LOAN_OPENING_CORRECTION',
        // Deterministic, so a second run is refused rather than doubled.
        ref_no: `LOANFIX-${r.ledger}-${asOf}`,
        entry_date: asOf,
        narration: `Correction to opening loan liability ${asOf} — ${r.ledger}: `
                 + `instalments due before the cut-off were charged to the loan a second `
                 + `time by their EMI vouchers. GL ${r.gl_total} -> ${r.module_total}.`,
        created_by: 'loan-gl-fix',
        lines: understated
          ? [{ ledger: OPENING_CONTRA, dr_cr: 'DR', amount, group: OPENING_GROUP },
             { ledger: r.ledger, dr_cr: 'CR', amount, group: LOAN_GROUP }]
          : [{ ledger: r.ledger, dr_cr: 'DR', amount: -amount, group: LOAN_GROUP },
             { ledger: OPENING_CONTRA, dr_cr: 'CR', amount: -amount, group: OPENING_GROUP }],
      });
      posted++;
      console.log(`  ✔ ${r.ledger} ${inr(amount)}  voucher ${voucher?.voucher_id ?? '-'}`);
    } catch (e) {
      if (e.code === 'DUPLICATE_REF') { skipped++; console.log(`  · ${r.ledger} already corrected`); continue; }
      problems.push({ ledger: r.ledger, why: e.message });
      console.log(`  ✖ ${r.ledger}: ${e.message}`);
    }
  }

  // The check that matters: after posting, does the balance sheet agree with
  // the loan module? Printed rather than assumed.
  const { rows: [after] } = await query(`
    SELECT (SELECT SUM(CASE WHEN dr_cr = 'CR' THEN amount ELSE -amount END)
              FROM ledger_entries WHERE ledger_name ILIKE 'Loan:%')::numeric(14,2) AS gl,
           (SELECT SUM(remaining_principal) FROM loan_master)::numeric(14,2)       AS module`);
  console.log(`\n  posted ${posted}, already done ${skipped}, problems ${problems.length}`);
  console.log(`  GL loan liability  : ${inr(after.gl)}`);
  console.log(`  loan module says   : ${inr(after.module)}`);
  console.log(`  difference         : ${inr(Number(after.gl) - Number(after.module))}`);

  await closePool();
  process.exit(problems.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error('[loan-gl] failed:', e.message);
  await closePool().catch(() => {});
  process.exit(1);
});
