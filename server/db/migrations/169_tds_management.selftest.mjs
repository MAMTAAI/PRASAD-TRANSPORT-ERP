// server/db/migrations/169_tds_management.selftest.mjs
// Proves on the production schema: 160 → 169 apply and 169 re-runs; the rate
// rule; FY/quarter/due-date helpers; deductees seeded from the vehicle master
// (the firm itself excluded); liabilities rebuilt from an approved attached
// bill; credits rebuilt from an advice and from a BPCL bank credit (estimate);
// a 26AS line matches the advice credit; the overview reads it all.
//   MIGTEST_PG=… MIGTEST_SCHEMA=… node server/db/migrations/169_tds_management.selftest.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = process.env.MIGTEST_PG; const SCHEMA = process.env.MIGTEST_SCHEMA;
if (!ADMIN || !SCHEMA) { console.error('set MIGTEST_PG and MIGTEST_SCHEMA'); process.exit(2); }
const DB = 'pt_mig169_test';
let failures = 0;
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); failures += ok ? 0 : 1; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`); };
const splitSql = (sql) => { const out = []; let cur = '', inDollar = false; for (const line of sql.split('\n')) { if (/^\s*--/.test(line) && !inDollar) continue; if ((line.match(/\$\$/g) || []).length % 2 === 1) inDollar = !inDollar; cur += line + '\n'; if (!inDollar && /;\s*$/.test(line)) { out.push(cur); cur = ''; } } if (cur.trim()) out.push(cur); return out; };

const admin = new pg.Client({ connectionString: ADMIN }); await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB}`); await admin.query(`CREATE DATABASE ${DB}`); await admin.end();
const db = new pg.Client({ connectionString: ADMIN.replace(/\/[^/]*$/, `/${DB}`) }); await db.connect();
await db.query('SET check_function_bodies = false');
const one = async (sql, args) => (await db.query(sql, args)).rows[0];

try {
  const schemaSql = zlib.gunzipSync(readFileSync(SCHEMA)).toString('utf8');
  for (const st of splitSql(schemaSql)) { try { await db.query(st); } catch { /* PostGIS */ } }
  await db.query('SET search_path = public');
  await db.query(`INSERT INTO companies (company_name, pan_no) VALUES ('M/S PRASAD TRANSPORT', 'AAKFP2339R'), ('M/S JAISWAL ENTERPRISE', 'AAMFJ3644H'), ('M/S GAUTAM PRASAD', 'BQFPP5877G')`);
  await db.query(`INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system) VALUES ('Bank Accounts','ASSET','BALANCE_SHEET','DR',100,true), ('Loans & Advances (Asset)','ASSET','BALANCE_SHEET','DR',140,true), ('Indirect Expenses','EXPENSE','PROFIT_AND_LOSS','DR',400,true), ('Other Income','INCOME','PROFIT_AND_LOSS','CR',500,true), ('Sundry Debtors (Customers)','ASSET','BALANCE_SHEET','DR',130,true) ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO ledgers (ledger_name, group_head, company, dr_cr, branch, status) VALUES ('SBI (8490)','Bank Accounts','M/S PRASAD TRANSPORT','DR','ALL','ACTIVE'), ('SBI (8548)','Bank Accounts','M/S JAISWAL ENTERPRISE','DR','ALL','ACTIVE'), ('SBI (1934)','Bank Accounts','M/S GAUTAM PRASAD','DR','ALL','ACTIVE')`);
  await db.query(`INSERT INTO customers (customer_name, customer_code) VALUES ('INDIAN OIL CORPORATION LTD', '11024699'), ('BHARAT PETROLEUM CORPORATION LTD', 'VC226709')`);
  await db.query(`INSERT INTO vehicles (vehicle_no, ownership, owner_name, company_id) SELECT v.n, 'ATTACHED', v.o, c.id FROM (VALUES ('AS 26C 9801','SANDEEP KUMAR PRASAD'), ('AS 26C 9802','GAUTAM PRASAD'), ('AS 26C 9803','PRASAD TRANSPORT')) v(n,o), companies c WHERE c.company_name='M/S PRASAD TRANSPORT'`).catch(async (e) => { console.log('  (vehicles fixture needs more columns: ' + e.message.slice(0, 80) + ')'); });

  console.log('\nPRODUCTION SCHEMA (through 159) + 160–169');
  for (const f of ['160_vehicle_owner_bills.sql', '161_vehicle_ownership_rule.sql', '162_market_partner_bills.sql', '163_customer_bills.sql', '164_customer_contract_rate.sql', '165_advice_truth.sql', '166_fortnight_by_unloading.sql', '167_bank_reconciliation.sql', '168_reattach_open_drafts.sql', '169_tds_management.sql']) {
    await db.query(readFileSync(path.join(here, f), 'utf8'));
  }
  check('160 → 169 apply on the production schema', true, true);
  await db.query(readFileSync(path.join(here, '169_tds_management.sql'), 'utf8'));
  check('169 is re-runnable', true, true);

  console.log('\nTHE RULES');
  check('1% for an individual with PAN', (await one(`SELECT tds_rate_for('ABCDE1234F','INDIVIDUAL',false) AS r`)).r, '1');
  check('2% for a firm with PAN', (await one(`SELECT tds_rate_for('ABCDE1234F','FIRM',false) AS r`)).r, '2');
  check('20% without PAN', (await one(`SELECT tds_rate_for(NULL,'INDIVIDUAL',false) AS r`)).r, '20');
  check('nil with a 194C(6) declaration and PAN', (await one(`SELECT tds_rate_for('ABCDE1234F','INDIVIDUAL',true) AS r`)).r, '0');
  check('…but not without PAN', (await one(`SELECT tds_rate_for(NULL,'INDIVIDUAL',true) AS r`)).r, '20');
  check('FY and quarter of 20 Jun 2026', await one(`SELECT fy_of('2026-06-20'::date) AS fy, fq_of('2026-06-20'::date) AS q`), { fy: '2026-27', q: 'Q1' });
  check('FY of 15 Feb 2027', (await one(`SELECT fy_of('2027-02-15'::date) AS fy`)).fy, '2026-27');
  check('deposit for August is due 7 Sep', (await one(`SELECT tds_deposit_due('2026-08-01'::date)::text AS d`)).d, '2026-09-07');
  check('deposit for March is due 30 Apr', (await one(`SELECT tds_deposit_due('2027-03-01'::date)::text AS d`)).d, '2027-04-30');
  check('26Q Q2 due 31 Oct, Q4 due 31 May', await one(`SELECT tds_return_due('2026-27','Q2')::text AS q2, tds_return_due('2026-27','Q4')::text AS q4`), { q2: '2026-10-31', q4: '2027-05-31' });

  console.log('\nDEDUCTEES FROM THE MASTERS');
  const ded = (await db.query(`SELECT name, deductee_kind, pan, entity_type FROM tds_deductees ORDER BY name`)).rows;
  check('attached owners seeded, the firm itself excluded', ded.filter((d) => d.deductee_kind === 'OWNER').map((d) => d.name), ['GAUTAM PRASAD', 'SANDEEP KUMAR PRASAD']);
  check("Gautam's PAN taken from his firm", ded.find((d) => d.name === 'GAUTAM PRASAD')?.pan, 'BQFPP5877G');
  check('TDS Payable (194C) ledger exists under Duties & Taxes', (await one(`SELECT group_head FROM ledgers WHERE ledger_name='TDS Payable (194C)'`)).group_head, 'Duties & Taxes');

  console.log('\nLIABILITIES FROM THE BILLS');
  const { rows: [pt] } = await db.query(`SELECT id FROM companies WHERE company_name='M/S PRASAD TRANSPORT'`);
  await db.query(`INSERT INTO vehicle_owner_bills (bill_no, owner_key, owner_name, fleet_class, class_key, company_id, operating_company, period_from, period_to, cycle, status, lorries, trips, freight, commission, tds_pct, tds, payable, needs_rate, locked_at, approved_by, approved_at)
    VALUES ('VB-SKP-JUN-H2-2026', 'SANDEEPKUMARPRASAD', 'SANDEEP KUMAR PRASAD', 'ATTACHED', 'ATTACHED', $1, 'M/S PRASAD TRANSPORT', '2026-06-16', '2026-06-30', '2026-06-H2', 'APPROVED', 2, 9, 500000, 50000, 20, 10000, 440000, 0, now(), 'owner', '2026-07-02'),
           ('VB-GP-JUN-H2-2026', 'GAUTAMPRASAD', 'GAUTAM PRASAD', 'ATTACHED', 'ATTACHED', $1, 'M/S PRASAD TRANSPORT', '2026-06-16', '2026-06-30', '2026-06-H2', 'AI_DRAFT', 1, 4, 200000, NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL)`, [pt.id]);
  await db.query(`SELECT tds_liabilities_rebuild()`);
  const li = (await db.query(`SELECT deductee_name, status, base_amount, rate_pct, tds_amount, deposit_due::text AS due, block_reason FROM tds_liabilities ORDER BY deductee_name`)).rows;
  check('an approved attached bill becomes a DUE liability on its commission', li.find((l) => l.deductee_name === 'SANDEEP KUMAR PRASAD'), { deductee_name: 'SANDEEP KUMAR PRASAD', status: 'DUE', base_amount: '50000.00', rate_pct: '20.000', tds_amount: '10000.00', due: '2026-08-07', block_reason: 'PAN missing — 20% applies until it is on file' });
  check('a draft with no rate is BLOCKED, and says why', [li.find((l) => l.deductee_name === 'GAUTAM PRASAD')?.status, li.find((l) => l.deductee_name === 'GAUTAM PRASAD')?.block_reason], ['BLOCKED', 'commission rate missing (Commission Master)']);
  check('the month view sees it due', (await one(`SELECT state, tds_due FROM v_tds_payable_month WHERE period_month='2026-07-01'`)), { state: 'OVERDUE', tds_due: '10000.00' });

  console.log('\nCREDITS FROM THE DOCUMENTS');
  const { rows: [adv] } = await db.query(`INSERT INTO iocl_payment_advices (odn, bank_ref, advice_date, remitted, computed_net, ties, pdf_name, pdf_sha256, operating_company) VALUES ('AS8327025063','CT0AHXZWK9','2026-08-07',874173.87,874173.87,true,'a.pdf',repeat('c',64),'M/S PRASAD TRANSPORT') RETURNING advice_id`);
  await db.query(`INSERT INTO iocl_advice_lines (line_uid, advice_id, voucher_no, reference, bill_no, kind, gross, tds, net) VALUES (repeat('1',40), $1, 'V1', 'R1', '11024699AS26045', 'FREIGHT_BILL', 900000, -18000, 882000)`, [adv.advice_id]);
  const { rows: [acct] } = await db.query(`SELECT id, account_no FROM bank_accounts WHERE account_tail='8548'`);
  await db.query(`INSERT INTO bank_statement_lines (account_id, line_uid, txn_date, description, ref_no, credit, balance, counterparty, status) VALUES ($1, 'u1', '2026-04-10', 'BY TRANSFER- INB BHARAT PETROLEUM CORPO', 'X', 700045.40, 1, 'BHARAT PETROLEUM CORPO', 'REVIEW')`, [acct.id]);
  await db.query(`SELECT tds_credits_rebuild('2026-27')`);
  const cr = (await db.query(`SELECT company_name, customer_name, quarter, source, freight_base, tds_amount, matched_state FROM tds_credits ORDER BY customer_name`)).rows;
  check('the IOCL advice becomes a Q2 credit for Prasad', cr.find((c) => c.source === 'ADVICE'), { company_name: 'M/S PRASAD TRANSPORT', customer_name: 'INDIAN OIL CORPORATION LTD', quarter: 'Q2', source: 'ADVICE', freight_base: '900000.00', tds_amount: '18000.00', matched_state: 'AWAITING_26AS' });
  check('a BPCL bank credit into Jaiswal becomes a Q1 estimate (net ÷ 0.98)', cr.find((c) => c.source === 'BANK_ESTIMATE'), { company_name: 'M/S JAISWAL ENTERPRISE', customer_name: 'BHARAT PETROLEUM CORPORATION LTD', quarter: 'Q1', source: 'BANK_ESTIMATE', freight_base: '714332.04', tds_amount: '14286.64', matched_state: 'ESTIMATE' });
  await db.query(`INSERT INTO tds_26as_lines (company_id, import_file, deductor_tan, deductor_name, section, fy, quarter, txn_date, amount_paid, tds_deducted, line_uid) VALUES ($1, '26as.csv', 'SHLI00000A', 'INDIAN OIL CORPORATION LIMITED', '194C', '2026-27', 'Q2', '2026-08-07', 900000, 18000, 'l1')`, [pt.id]);
  await db.query(`SELECT tds_credits_rebuild('2026-27')`);
  check('the 26AS line matches the advice credit', await one(`SELECT amount_26as, matched_state FROM tds_credits WHERE source='ADVICE'`), { amount_26as: '18000.00', matched_state: 'MATCHED' });
  const ov = await one(`SELECT tds_on_us_documented, tds_on_us_26as, tds_by_us_due, blocked, deductees_without_pan FROM v_tds_overview WHERE company_name='M/S PRASAD TRANSPORT'`);
  check('the overview reads it all', ov, { tds_on_us_documented: '18000.00', tds_on_us_26as: '18000.00', tds_by_us_due: '10000.00', blocked: 1, deductees_without_pan: 1 });
} catch (e) {
  failures += 1;
  console.log(`\n  FAIL  the test threw: ${e?.message ?? e}`);
  if (e?.detail) console.log(`        detail: ${e.detail}`);
} finally { await db.end().catch(() => {}); }
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
