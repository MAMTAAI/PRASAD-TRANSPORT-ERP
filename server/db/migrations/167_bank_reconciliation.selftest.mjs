// server/db/migrations/167_bank_reconciliation.selftest.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Proves, on a throwaway cluster carrying the production schema:
//   · 160 → 167 apply and 167 re-runs
//   · the four accounts are registered, SBI (5913) got its ledger (decision 1)
//   · lines dedupe by uid; the summary reads statement vs book
//   · TARA's tally: an IOCL credit with the advice UTR links to the advice
//     journal; a transfer to Jaiswal posts as capital (decision 2); a bank
//     charge posts; a Gautam line no rule claims is NOT_OURS (decision 3); a
//     schedule-posted EMI with no bank line is flagged, not touched (4); a
//     UPI to a stranger waits for the desk; a desk decision posts and learns
//
//   MIGTEST_PG=postgres://testu@127.0.0.1:5433/postgres MIGTEST_SCHEMA=<dump.sql.gz> node server/db/migrations/167_bank_reconciliation.selftest.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = process.env.MIGTEST_PG; const SCHEMA = process.env.MIGTEST_SCHEMA;
if (!ADMIN || !SCHEMA) { console.error('set MIGTEST_PG and MIGTEST_SCHEMA'); process.exit(2); }
const DB = 'pt_mig167_test';
let failures = 0;
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); failures += ok ? 0 : 1; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`); };
const splitSql = (sql) => { const out = []; let cur = '', inDollar = false; for (const line of sql.split('\n')) { if (/^\s*--/.test(line) && !inDollar) continue; if ((line.match(/\$\$/g) || []).length % 2 === 1) inDollar = !inDollar; cur += line + '\n'; if (!inDollar && /;\s*$/.test(line)) { out.push(cur); cur = ''; } } if (cur.trim()) out.push(cur); return out; };

const admin = new pg.Client({ connectionString: ADMIN }); await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB}`); await admin.query(`CREATE DATABASE ${DB}`); await admin.end();
const url = ADMIN.replace(/\/[^/]*$/, `/${DB}`);
process.env.DATABASE_URL = url; process.env.DB_TARGET = 'local'; process.env.PGSSLMODE = 'disable';
const db = new pg.Client({ connectionString: url }); await db.connect();
await db.query('SET check_function_bodies = false');
const one = async (sql, args) => (await db.query(sql, args)).rows[0];

try {
  const schemaSql = zlib.gunzipSync(readFileSync(SCHEMA)).toString('utf8');
  for (const st of splitSql(schemaSql)) { try { await db.query(st); } catch { /* PostGIS */ } }
  await db.query('SET search_path = public');
  await db.query(`INSERT INTO companies (company_name) VALUES ('M/S PRASAD TRANSPORT'), ('M/S JAISWAL ENTERPRISE'), ('M/S GAUTAM PRASAD')`);
  await db.query(`INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system) VALUES ('Bank Accounts','ASSET','BALANCE_SHEET','DR',100,true), ('Indirect Expenses','EXPENSE','PROFIT_AND_LOSS','DR',400,true), ('Sundry Debtors (Customers)','ASSET','BALANCE_SHEET','DR',130,true), ('Secured Loans','LIABILITY','BALANCE_SHEET','CR',200,true), ('Loans & Advances (Asset)','ASSET','BALANCE_SHEET','DR',140,true), ('Current Assets - Driver Advances','ASSET','BALANCE_SHEET','DR',141,true) ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO ledgers (ledger_name, group_head, company, dr_cr, branch, status) VALUES ('SBI (8490)','Bank Accounts','M/S PRASAD TRANSPORT','DR','ALL','ACTIVE'), ('SBI (8548)','Bank Accounts','M/S JAISWAL ENTERPRISE','DR','ALL','ACTIVE'), ('SBI (1934)','Bank Accounts','M/S GAUTAM PRASAD','DR','ALL','ACTIVE')`);
  await db.query(`INSERT INTO customers (customer_name, customer_code) VALUES ('INDIAN OIL CORPORATION LTD', '11024699')`);
  await db.query(`INSERT INTO drivers (name, mobile) VALUES ('SHAHIDUL ISLAM', '9435000001')`).catch(() => {});

  console.log('\nPRODUCTION SCHEMA (through 159) + 160–167');
  for (const f of ['160_vehicle_owner_bills.sql', '161_vehicle_ownership_rule.sql', '162_market_partner_bills.sql', '163_customer_bills.sql', '164_customer_contract_rate.sql', '165_advice_truth.sql', '166_fortnight_by_unloading.sql', '167_bank_reconciliation.sql']) {
    await db.query(readFileSync(path.join(here, f), 'utf8'));
  }
  check('160 → 167 apply on the production schema', true, true);
  await db.query(readFileSync(path.join(here, '167_bank_reconciliation.sql'), 'utf8'));
  check('167 is re-runnable', true, true);

  console.log('\nTHE ACCOUNTS');
  check('four accounts registered', (await one('SELECT count(*)::int AS n FROM bank_accounts')).n, 4);
  check('SBI (5913) got its ledger in Prasad books (decision 1)', await one(`SELECT group_head, btrim(company) AS company FROM ledgers WHERE ledger_name='SBI (5913)'`), { group_head: 'Bank Accounts', company: 'M/S PRASAD TRANSPORT' });
  check('each account knows its firm', (await one(`SELECT count(*)::int AS n FROM bank_accounts WHERE company_id IS NOT NULL`)).n, 4);
  check("Gautam's savings defaults to not-ours (decision 3)", (await one(`SELECT personal_default_not_ours AS p FROM bank_accounts WHERE account_tail='1934'`)).p, true);
  check('inter-firm capital ledger is made on demand (decision 2)', await one(`SELECT interfirm_capital_ledger('M/S PRASAD TRANSPORT', 'M/S JAISWAL ENTERPRISE') AS l`), { l: 'Capital: Inter-firm — JAISWAL ENTERPRISE' });
  check('…under Capital Account', (await one(`SELECT group_head FROM ledgers WHERE ledger_name = 'Capital: Inter-firm — JAISWAL ENTERPRISE'`)).group_head, 'Capital Account');

  // the ERP already knows: an IOCL advice + its journal; a schedule-posted EMI
  const { rows: [adv] } = await db.query(`INSERT INTO iocl_payment_advices (odn, bank_ref, advice_date, remitted, computed_net, ties, pdf_name, pdf_sha256, operating_company) VALUES ('AS8327025063','CT0AHXZWK9','2026-08-07',874173.87,874173.87,true,'a.pdf',repeat('c',64),'M/S PRASAD TRANSPORT') RETURNING advice_id`);
  const { rows: [pt] } = await db.query(`SELECT id FROM companies WHERE company_name='M/S PRASAD TRANSPORT'`);
  const vid = '11111111-2222-3333-4444-555555555555';
  await db.query(`INSERT INTO ledger_entries (ledger_name, voucher_id, entry_date, particulars, dr_cr, amount, source_type, source_ref, company_id) VALUES
     ('SBI (8490)', $1::uuid, '2026-08-07', 'IOCL advice', 'DR', 874173.87, 'ADVICE_SETTLEMENT', 'ADV-AS8327025063', $2::uuid),
     ('Debtors: INDIAN OIL CORPORATION LTD', $1::uuid, '2026-08-07', 'IOCL advice', 'CR', 874173.87, 'ADVICE_SETTLEMENT', 'ADV-AS8327025063', $2::uuid),
     ('SBI (8490)', '22222222-2222-3333-4444-555555555555'::uuid, '2026-08-05', 'EMI from the schedule', 'CR', 112987.00, 'LOAN_EMI', 'LOANEMI-TEST', $2::uuid),
     ('Loan: TATA CAPITAL LIMITED (AS 26C 9802)', '22222222-2222-3333-4444-555555555555'::uuid, '2026-08-05', 'EMI from the schedule', 'DR', 112987.00, 'LOAN_EMI', 'LOANEMI-TEST', $2::uuid)`, [vid, pt.id]);
  void adv;

  console.log('\nTHE TALLY');
  const { importParsed, tallyAccount, linkLine, bankSummary } = await import('../../lib/bankTally.js');
  const { initDb } = await import('../../db/pool.js');
  await initDb({ attempts: 1, quiet: true });
  const L = (d, desc, ref, debit, credit, bal, cp, utr) => ({ txn_date: d, value_date: d, description: desc, ref_no: ref, debit, credit, balance: bal, counterparty: cp, utr: utr ?? null, channel: 'INB' });
  const imp = await importParsed({ accountNo: '30178368490', meta: { file: 'Aug 2026 Prasad SBI 30178368490.pdf', period_from: '2026-08-01', period_to: '2026-08-31' }, lines: [
    L('2026-08-09', 'BY TRANSFER- INB Others-', 'CT0AHXZWK9 TRANSFER FROM 11024699 INDIAN OIL CORPORATION /', 0, 874173.87, 900000, 'INDIAN OIL CORPORATION', 'CT0AHXZWK9'),
    L('2026-08-10', 'TO TRANSFER- INB-', 'CT0AHYAAA1 TRANSFER TO 36242108548 JAISWAL ENTERPRISE /', 200000, 0, 700000, 'JAISWAL ENTERPRISE', 'CT0AHYAAA1'),
    L('2026-08-11', 'SMS CHARGES GST', 'SMS CHRG', 17.70, 0, 699982.30, null, null),
    L('2026-08-12', 'TO TRANSFER- UPI/DR/8990170685 69/SHAHIDUL/SBIN /lam46803@o/Payme-', 'TRANSFER TO 4897692162094 /', 2500, 0, 697482.30, 'SHAHIDUL', null),
    L('2026-08-13', 'TO TRANSFER- UPI/DR/1234 55/RAMU KAKA/SBIN /x@ok/Payme-', 'TRANSFER TO 4897692162094 /', 3000, 0, 694482.30, 'RAMU KAKA', null),
  ], sourceFile: 'test', format: 'JSON', by: 'test' });
  check('five lines imported', [imp.rows_new, imp.rows_seen], [5, 0]);
  const again = await importParsed({ accountNo: '30178368490', meta: {}, lines: [L('2026-08-11', 'SMS CHARGES GST', 'SMS CHRG', 17.70, 0, 699982.30, null, null)], by: 'test' });
  check('a re-uploaded line is seen, not duplicated', [again.rows_new, again.rows_seen], [0, 1]);
  const t = await tallyAccount({ statuses: ['NEW'], by: 'agent:TARA', post: true });
  check('tally ran over the five', t.lines, 5);
  const st = async (utrOrCp) => one(`SELECT status, category, target_label FROM bank_statement_lines WHERE utr = $1 OR counterparty = $1 OR description = $1`, [utrOrCp]);
  { const x = await st('CT0AHXZWK9'); check('IOCL credit by UTR links to the advice journal already in the book', [x.status, x.category], ['LINKED', 'CUSTOMER_RECEIPT']); }
  check('transfer to Jaiswal posts as capital (decision 2)', await st('JAISWAL ENTERPRISE'), { status: 'AUTO_POSTED', category: 'INTER_FIRM', target_label: 'M/S JAISWAL ENTERPRISE' });
  check('…with a voucher on the capital ledger', (await one(`SELECT count(*)::int AS n FROM ledger_entries WHERE ledger_name = 'Capital: Inter-firm — JAISWAL ENTERPRISE' AND dr_cr = 'DR' AND amount = 200000`)).n, 1);
  check('bank charge posts itself', (await st('SMS CHARGES GST')).status, 'AUTO_POSTED');
  check('a UPI to a driver-like name waits for the desk', (await st('SHAHIDUL')).status, 'REVIEW');
  check('a UPI to a stranger waits for the desk', await st('RAMU KAKA'), { status: 'REVIEW', category: 'OTHER_PAYMENT', target_label: null });
  check('the schedule-posted EMI with no bank line is flagged, untouched (decision 4)', await one(`SELECT source_type, amount FROM v_bank_book_unmatched WHERE ledger_name='SBI (8490)'`), { source_type: 'LOAN_EMI', amount: '112987.00' });
  check('…and the advice journal is not flagged (it is linked)', (await one(`SELECT count(*)::int AS n FROM v_bank_book_unmatched WHERE source_type='ADVICE_SETTLEMENT'`)).n, 0);
  const s1 = await bankSummary();
  check('summary reads statement vs book', s1.accounts.find((a) => a.account_tail === '8490').lines, 5);

  console.log('\nTHE DESK');
  const { rows: [ramu] } = await db.query(`SELECT id FROM bank_statement_lines WHERE counterparty = 'RAMU KAKA'`);
  const r = await linkLine({ lineId: ramu.id, decision: { category: 'LEDGER', ledger_name: 'Bank Charges', remember: true, auto_next_time: true, note: 'test' }, by: 'tester' });
  check('a person links a line to a ledger and it posts', [r.line.status, !!r.line.voucher_id], ['LINKED', true]);
  check('…and TARA learned the rule', [r.rule?.match_text, r.rule?.category, r.rule?.auto], ['RAMU KAKA', 'LEDGER', true]);
  const imp2 = await importParsed({ accountNo: '30178368490', meta: {}, lines: [L('2026-08-20', 'TO TRANSFER- UPI/DR/9999 55/RAMU KAKA/SBIN /x@ok/Payme-', 'TRANSFER TO 4897692162094 /', 3100, 0, 690000, 'RAMU KAKA', null)], by: 'test' });
  await tallyAccount({ statuses: ['NEW'], by: 'agent:TARA', post: true });
  check('next month the same counterparty posts by rule', (await one(`SELECT status, why FROM bank_statement_lines WHERE debit = 3100`)).status, 'AUTO_POSTED');
  void imp2;

  console.log('\nGAUTAM (decision 3)');
  await importParsed({ accountNo: '30297031934', meta: {}, lines: [L('2026-08-03', 'WDL TFR UPI/DR/1954 56/Airtel/YESB/airtel-bil/Airtel', '-', 2282.54, 0, 5251.68, 'Airtel', null)], by: 'test' });
  await tallyAccount({ statuses: ['NEW'], by: 'agent:TARA', post: true });
  check('a personal spend nobody claims is not ours', (await st('Airtel')).status, 'NOT_OURS');
} catch (e) {
  failures += 1;
  console.log(`\n  FAIL  the test threw: ${e?.message ?? e}`);
  if (e?.detail) console.log(`        detail: ${e.detail}`);
} finally {
  await db.end().catch(() => {});
  try { const { closePool } = await import('../../db/pool.js'); await closePool(); } catch { /* not opened */ }
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
