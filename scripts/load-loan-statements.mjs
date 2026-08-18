// scripts/load-loan-statements.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Load parsed lender statements into loan_instalments / loan_receipts /
// loan_charges, straight against the database.
//
//   node -r dotenv/config scripts/load-loan-statements.mjs                 dry run
//   node -r dotenv/config scripts/load-loan-statements.mjs --commit        write
//   node -r dotenv/config scripts/load-loan-statements.mjs --file x.json
//
// WHY A SCRIPT AND NOT JUST THE ROUTE. The statements arrive as a folder of PDFs
// on someone's desktop, are parsed on the command line, and want loading in one
// go — 27 ledgers, 1,239 instalments, 1,100 receipts. That does not need the API
// to be running, and making a bulk load depend on a live server is how a data
// job fails at the wrong moment.
//
// It shares its implementation with POST /api/v1/loans/statement-import: both
// call importLedgers() in server/lib/loanStatementImport.js. Two entry points,
// one behaviour.
//
// Produce the JSON first:
//   python tools/loan_recon/loan_ledger_parser.py --dir <folder> \
//          --json reports/loan_bills/tata_ledgers.json
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { initDb, query, closePool, DB_TARGET } from '../server/db/pool.js';
import { importLedgers } from '../server/lib/loanStatementImport.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? true);
};
const commit = argv.includes('--commit');
const file = flag('file', 'reports/loan_bills/tata_ledgers.json');
const statementAsOf = flag('as-of', null);

const inr = (n) => Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });

async function main() {
  const ledgers = JSON.parse(readFileSync(file, 'utf8'));
  await initDb();
  console.log(`[loans] ${DB_TARGET} · ${ledgers.length} statement(s) from ${file}`
            + `${commit ? '' : ' · DRY RUN'}`);

  const out = await importLedgers(query, ledgers, { commit, statementAsOf });

  console.log(`\n${'LOAN NO'.padEnd(13)}${'INST'.padStart(6)}${'RECEIPTS'.padStart(10)}`
            + `${'DEMANDED'.padStart(16)}${'RECEIVED'.padStart(16)}${'PENAL O/S'.padStart(13)}`);
  console.log('-'.repeat(74));
  for (const r of out.loaded) {
    console.log(`${r.loan_no.padEnd(13)}${String(r.instalments).padStart(6)}`
      + `${String(r.receipts).padStart(10)}${inr(r.demanded).padStart(16)}`
      + `${inr(r.received).padStart(16)}${inr(r.penal_outstanding).padStart(13)}`);
  }
  for (const s of out.skipped)  console.log(`  skipped ${s.loan_no}: ${s.why}`);
  for (const p of out.problems) console.log(`  PROBLEM ${p.loan_no}: ${p.why}`);

  const s = out.summary;
  console.log(`\n  statements     : ${s.statements}`);
  console.log(`  loaded         : ${s.loaded}   skipped ${s.skipped}   problems ${s.problems}`);
  console.log(`  instalments    : ${s.instalments}`);
  console.log(`  receipts       : ${s.receipts}`);
  console.log(`  demanded       : ${inr(s.total_demanded)}`);
  console.log(`  received       : ${inr(s.total_received)}`);
  console.log(`  penal charges outstanding : ${inr(s.penal_outstanding)}`);
  if (!commit) console.log('\n  DRY RUN — nothing written. Re-run with --commit.');

  await closePool();
  process.exit(out.problems.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error('[loans] failed:', e.message);
  await closePool().catch(() => {});
  process.exit(1);
});
