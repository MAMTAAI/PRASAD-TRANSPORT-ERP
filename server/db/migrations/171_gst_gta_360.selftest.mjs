// server/db/migrations/171_gst_gta_360.selftest.mjs
// Proves on the production schema: 160 → 171 apply and 171 re-runs; GSTIN
// check digit; due dates; the RCM / forward / exempt split; the firm GSTIN
// taken from the IOCL bills; customers classified; bills as invoices with
// serials; AC5 documents as the output register; the ITC register under RCM
// and under the 12% option; set-off; filings; overview; the deep audit.
//   MIGTEST_PG=… MIGTEST_SCHEMA=… node server/db/migrations/171_gst_gta_360.selftest.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = process.env.MIGTEST_PG; const SCHEMA = process.env.MIGTEST_SCHEMA;
if (!ADMIN || !SCHEMA) { console.error('set MIGTEST_PG and MIGTEST_SCHEMA'); process.exit(2); }
const DB = 'pt_mig171_test';
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
  await db.query(`INSERT INTO vendors (vendor_name, vendor_kind, vendor_type) VALUES ('ALAM FUEL STATION', 'SERVICE', 'Fuel Pump'), ('HALDIA RETREADING CO', 'SERVICE', 'Spare Parts'), ('RAMU BODY WORKS', 'SERVICE', 'Body builder')`).catch((e) => console.log('  (vendors fixture: ' + e.message.slice(0, 80) + ')'));
  await db.query(`INSERT INTO vehicles (vehicle_no, ownership, owner_name, company_id) SELECT v.n, 'ATTACHED', v.o, c.id FROM (VALUES ('AS 26C 9801','SANDEEP KUMAR PRASAD'), ('AS 26C 9802','GAUTAM PRASAD'), ('AS 26C 9803','PRASAD TRANSPORT')) v(n,o), companies c WHERE c.company_name='M/S PRASAD TRANSPORT'`).catch(async (e) => { console.log('  (vehicles fixture needs more columns: ' + e.message.slice(0, 80) + ')'); });


  console.log('\nPRODUCTION SCHEMA (through 159) + 160–171');
  for (const f of ['160_vehicle_owner_bills.sql', '161_vehicle_ownership_rule.sql', '162_market_partner_bills.sql', '163_customer_bills.sql', '164_customer_contract_rate.sql', '165_advice_truth.sql', '166_fortnight_by_unloading.sql', '167_bank_reconciliation.sql', '168_reattach_open_drafts.sql', '169_tds_management.sql', '170_tds_fuel_exempt_and_own_vehicle.sql']) {
    await db.query(readFileSync(path.join(here, f), 'utf8'));
  }
  // what IOCL prints on every AC5 bill for Prasad's vendor code
  await db.query(`INSERT INTO iocl_bill_runs (run_id, pdf_path, pdf_name, pdf_sha256, tool_version, vendor_code, vendor_gstin, window_from, window_to, pages, lines_parsed, lines_in_window, lines_out_window, checksum_ok, parsed_at)
    VALUES ('11111111-1111-1111-1111-111111111111', '/x/a.pdf', 'a.pdf', 'sha-a', 't1', '11024699', '18AAKFP2339R2ZG', '2026-08-01', '2026-08-31', 1, 2, 2, 0, true, now())`)
    .catch((e) => console.log('  (iocl_bill_runs fixture: ' + e.message.slice(0, 100) + ')'));
  await db.query(`UPDATE customers SET gst_no = '18AAACI1681G1ZO' WHERE customer_name = 'INDIAN OIL CORPORATION LTD'`);
  await db.query(`INSERT INTO customers (customer_name, gst_mode) VALUES ('RAMU PRASAD', 'RCM'), ('AADHAR GREEN INDUSTRIES LLP', 'RCM')`);
  await db.query(`INSERT INTO customers (customer_name, gst_mode, gst_pct) VALUES ('HALDIA STONE CRUSHER', 'FORWARD', 12)`);
  await db.query(`UPDATE customers SET gst_mode_locked = true WHERE customer_name = 'HALDIA STONE CRUSHER'`).catch(() => {});
  await db.query(readFileSync(path.join(here, '171_gst_gta_360.sql'), 'utf8'));
  await db.query(readFileSync(path.join(here, '172_gst_invoice_dates_and_itc_scope.sql'), 'utf8'));
  await db.query(readFileSync(path.join(here, '173_gst_itc_expense_groups_only.sql'), 'utf8'));
  check('160 → 173 apply on the production schema', true, true);
  await db.query(readFileSync(path.join(here, '173_gst_itc_expense_groups_only.sql'), 'utf8'));
  check('173 is re-runnable', true, true);

  console.log('\nTHE RULES');
  check('GSTIN check digit: the firm’s and IOCL’s pass', await one(`SELECT gstin_valid('18AAKFP2339R2ZG') AS a, gstin_valid('18AAACI1681G1ZO') AS b, gstin_valid('18ABUFA6737D1Z3') AS c`), { a: true, b: true, c: true });
  check('…a mistyped one and rubbish fail', await one(`SELECT gstin_valid('18AEPC6036L1Z9') AS a, gstin_valid('FOO') AS b, gstin_valid(NULL) AS c`), { a: false, b: false, c: false });
  check('state and PAN inside the GSTIN', await one(`SELECT gstin_state('18AAKFP2339R2ZG') AS s, gstin_pan('18AAKFP2339R2ZG') AS p`), { s: '18', p: 'AAKFP2339R' });
  check('GSTR-1 for Aug 2026 due 11 Sep, GSTR-3B due 20 Sep', await one(`SELECT gst_due('GSTR1','082026','MONTHLY')::text AS a, gst_due('GSTR3B','082026','MONTHLY')::text AS b`), { a: '2026-09-11', b: '2026-09-20' });
  check('QRMP: GSTR-1 13 Oct, GSTR-3B 24 Oct for Assam', await one(`SELECT gst_due('GSTR1','082026','QRMP','18')::text AS a, gst_due('GSTR3B','082026','QRMP','18')::text AS b`), { a: '2026-10-13', b: '2026-10-24' });
  check('firm code and short FY', await one(`SELECT gst_firm_code('M/S PRASAD TRANSPORT') AS c, gst_fy_short('2026-08-31'::date) AS fy, gst_fy_short('2027-02-01'::date) AS fy2`), { c: 'PT', fy: '2627', fy2: '2627' });
  check('intra-state RCM 5% on ₹1,00,000 → CGST 2,500 + SGST 2,500, recipient pays', await one(`SELECT supply_type, cgst::text AS cgst, sgst::text AS sgst, igst::text AS igst, payable_by FROM gst_split(100000, 'RCM', 5, '18', '18')`), { supply_type: 'INTRA', cgst: '2500.00', sgst: '2500.00', igst: '0', payable_by: 'RECIPIENT' });
  check('inter-state forward 12% → IGST 12,000, we pay', await one(`SELECT supply_type, igst::text AS igst, payable_by FROM gst_split(100000, 'FORWARD', 12, '18', '19')`), { supply_type: 'INTER', igst: '12000.00', payable_by: 'SUPPLIER' });
  check('exempt → nothing', await one(`SELECT gst_amount::text AS g, payable_by FROM gst_split(100000, 'EXEMPT', 5, '18', '18')`), { g: '0', payable_by: 'NONE' });
  check('set-off: IGST credit against CGST first, then CGST credit', await one(`SELECT pay_igst::text AS i, pay_cgst::text AS c, pay_sgst::text AS s FROM gst_setoff(0, 1000, 1000, 500, 300, 0)`), { i: '0', c: '200', s: '1000' });

  console.log('\nTHE FIRM');
  check('Prasad’s GSTIN taken from the IOCL bills, PAN matched', await one(`SELECT gstin::text AS g, gst_state_code AS s, gst_invoice_prefix AS p, gst_scheme AS sc FROM companies WHERE company_name = 'M/S PRASAD TRANSPORT'`), { g: '18AAKFP2339R2ZG', s: '18', p: 'PT', sc: 'RCM' });
  check('Jaiswal has none yet', (await one(`SELECT coalesce(gstin::text, '') AS g FROM companies WHERE company_name = 'M/S JAISWAL ENTERPRISE'`)).g, '');
  check('IOCL vendor code mapped to Prasad by the GSTIN', (await one(`SELECT c.company_name AS f FROM gst_ac5_vendor_map m JOIN companies c ON c.id = m.company_id WHERE m.vendor_code = '11024699'`))?.f, 'M/S PRASAD TRANSPORT');

  console.log('\nTHE CUSTOMERS');
  const cust = (await db.query(`SELECT customer_name, gst_mode, gst_registered, is_body_corporate, gst_state_code FROM customers ORDER BY customer_name`)).rows;
  check('IOCL: registered → RCM, state 18', cust.find((c) => c.customer_name.startsWith('INDIAN OIL')), { customer_name: 'INDIAN OIL CORPORATION LTD', gst_mode: 'RCM', gst_registered: true, is_body_corporate: true, gst_state_code: '18' });
  check('BPCL: no GSTIN but a corporation → RCM', cust.find((c) => c.customer_name.startsWith('BHARAT'))?.gst_mode, 'RCM');
  check('an LLP without GSTIN → RCM', cust.find((c) => c.customer_name.startsWith('AADHAR'))?.gst_mode, 'RCM');
  check('an individual → EXEMPT (entry 21A)', cust.find((c) => c.customer_name === 'RAMU PRASAD')?.gst_mode, 'EXEMPT');
  check('a person’s FORWARD choice is kept', cust.find((c) => c.customer_name === 'HALDIA STONE CRUSHER')?.gst_mode, 'FORWARD');

  console.log('\nTHE BILLS AS INVOICES');
  const { rows: [pt] } = await db.query(`SELECT id FROM companies WHERE company_name = 'M/S PRASAD TRANSPORT'`);
  const { rows: [ag] } = await db.query(`SELECT id FROM customers WHERE customer_name = 'AADHAR GREEN INDUSTRIES LLP'`);
  const { rows: [hs] } = await db.query(`SELECT id FROM customers WHERE customer_name = 'HALDIA STONE CRUSHER'`);
  await db.query(`INSERT INTO customer_bills (bill_no, customer_id, customer_name, company_id, operating_company, books_key, cycle_kind, period_from, period_to, cycle, status, gross, tds, net_receivable, gst_mode, gst_pct, locked_at, raised_at, raised_by)
    VALUES ('CB-AGIL-AUG-2026-PT', $1, 'AADHAR GREEN INDUSTRIES LLP', $2, 'M/S PRASAD TRANSPORT', 'PT', 'MONTH', '2026-08-01', '2026-08-31', '2026-08', 'RAISED', 390000, 0, 390000, 'RCM', 5, now(), '2026-09-01', 'owner'),
           ('CB-AGIL-JUL-2026-PT', $1, 'AADHAR GREEN INDUSTRIES LLP', $2, 'M/S PRASAD TRANSPORT', 'PT', 'MONTH', '2026-07-01', '2026-07-31', '2026-07', 'RAISED', 200000, 0, 200000, 'RCM', 5, now(), '2026-08-01', 'owner'),
           ('CB-AGIL-APR-2026-PT', $1, 'AADHAR GREEN INDUSTRIES LLP', $2, 'M/S PRASAD TRANSPORT', 'PT', 'MONTH', '2026-04-01', '2026-04-30', '2026-04', 'RAISED', 100000, 0, 100000, 'RCM', 5, now(), '2026-09-05', 'tara'),
           ('CB-HSC-AUG-2026-PT', $3, 'HALDIA STONE CRUSHER', $2, 'M/S PRASAD TRANSPORT', 'PT', 'MONTH', '2026-08-01', '2026-08-31', '2026-08', 'AI_DRAFT', 0, 0, 0, 'FORWARD', 12, NULL, NULL, NULL)`, [ag.id, pt.id, hs.id]);
  await db.query(`SELECT gst_bills_backfill()`);
  const inv = (await db.query(`SELECT bill_no, gst_invoice_no, gst_period, gst_treatment, supply_type, cgst::text AS cgst, sgst::text AS sgst, gst_amount::text AS gst, gst_payable_by, invoice_value::text AS val, net_receivable::text AS net, gst_doc_source FROM customer_bills ORDER BY bill_no`)).rows;
  check('serials run by invoice date: the April backlog bill first, then Jul, then Aug', inv.filter((b) => b.gst_invoice_no).map((b) => [b.bill_no, b.gst_invoice_no]), [['CB-AGIL-APR-2026-PT', 'PT/2627/00001'], ['CB-AGIL-AUG-2026-PT', 'PT/2627/00003'], ['CB-AGIL-JUL-2026-PT', 'PT/2627/00002']]);
  check('a bill raised months late is dated in its own period (172)', await one(`SELECT invoice_date::text AS d, gst_period AS p FROM customer_bills WHERE bill_no = 'CB-AGIL-APR-2026-PT'`), { d: '2026-04-30', p: '042026' });
  check('RCM: GST shown, recipient pays, net untouched', inv.find((b) => b.bill_no === 'CB-AGIL-AUG-2026-PT'), { bill_no: 'CB-AGIL-AUG-2026-PT', gst_invoice_no: 'PT/2627/00003', gst_period: '092026', gst_treatment: 'RCM', supply_type: 'INTRA', cgst: '9750.00', sgst: '9750.00', gst: '19500.00', gst_payable_by: 'RECIPIENT', val: '390000.00', net: '390000.00', gst_doc_source: 'BILL' });
  check('a draft gets no serial', inv.find((b) => b.bill_no === 'CB-HSC-AUG-2026-PT')?.gst_invoice_no ?? null, null);
  await db.query(`SELECT customer_bill_refresh(id) FROM customer_bills WHERE bill_no = 'CB-HSC-AUG-2026-PT'`);
  check('refresh runs on a FORWARD draft (supplier pays)', await one(`SELECT gst_treatment, gst_payable_by, gst_period FROM customer_bills WHERE bill_no = 'CB-HSC-AUG-2026-PT'`), { gst_treatment: 'FORWARD', gst_payable_by: 'SUPPLIER', gst_period: '082026' });
  await db.query(`UPDATE customer_bills SET gross = 50000, taxable_value = 50000, status = 'RAISED', locked_at = now(), raised_at = '2026-09-02', raised_by = 'owner' WHERE bill_no = 'CB-HSC-AUG-2026-PT'`);
  check('raising it hands out the next serial', (await one(`SELECT gst_invoice_no AS n FROM customer_bills WHERE bill_no = 'CB-HSC-AUG-2026-PT'`)).n, 'PT/2627/00004');

  console.log('\nTHE OUTPUT REGISTER');
  await db.query(`INSERT INTO iocl_bill_lines (line_uid, run_id, group_uid, bill_no, bill_date, reverse_charge, s_no, invoice_no, item_code, line_date, vehicle_no_raw, vehicle_norm, ship_to_raw, ship_to_code, ship_to_name, material, quantity_kl, shortage, gross_amt, penalty_amt, igst_amt, cgst_amt, sgst_amt, page_no, source_line, rtd, rate) VALUES
    ('l1', '11111111-1111-1111-1111-111111111111', 'g1', '11024699AS26099', '2026-08-31', true, 1, '193600001', '1', '2026-08-20', 'AS26C5109', 'AS26C5109', 'ZC7B03-LPG BP-North Guwahati', 'ZC7B03', 'LPG BP-NORTH GUWAHATI', '89000', 17.49, 0, 100000.00, 0, 0, 2500.00, 2500.00, 1, 'x', 1900, 3.26),
    ('l2', '11111111-1111-1111-1111-111111111111', 'g1', '11024699AS26099', '2026-08-31', true, 2, '193600002', '1', '2026-08-22', 'AS26C5109', 'AS26C5109', 'ZC7B03-LPG BP-North Guwahati', 'ZC7B03', 'LPG BP-NORTH GUWAHATI', '89000', 17.49, 0, 60000.00, 0, 0, 1500.00, 1500.00, 1, 'x', 1900, 3.26),
    ('l3', '11111111-1111-1111-1111-111111111111', 'g2', 'MNP26000999', '2026-08-31', true, 1, '193600003', '1', '2026-08-25', 'AS26C5106', 'AS26C5106', 'Imphal', 'ZC9', 'IMPHAL', '89000', 17.5, 0, 40000.00, 0, 2000.00, 0, 0, 1, 'x', 2864, 3.31)`)
    .catch((e) => console.log('  (iocl_bill_lines fixture: ' + e.message.slice(0, 120) + ')'));
  const docs = (await db.query(`SELECT doc_kind, doc_no, period, supply_type, treatment, taxable::text AS taxable, gst_amount::text AS gst, recipient_gstin, place_of_supply, needs, doc_status FROM v_gst_output_docs ORDER BY doc_kind, doc_no`)).rows;
  check('the intra-state AC5 bill is one RCM document under IOCL’s GSTIN', docs.find((d) => d.doc_no === '11024699AS26099'), { doc_kind: 'AC5', doc_no: '11024699AS26099', period: '082026', supply_type: 'INTRA', treatment: 'RCM', taxable: '160000.00', gst: '8000.00', recipient_gstin: '18AAACI1681G1ZO', place_of_supply: '18', needs: null, doc_status: 'ISSUED' });
  check('the IGST bill asks for the recipient’s state GSTIN', docs.find((d) => d.doc_no === 'MNP26000999')?.needs, 'inter-state: recipient state GSTIN + place of supply needed');
  await db.query(`INSERT INTO gst_doc_overrides (doc_kind, doc_no, recipient_gstin, place_of_supply, updated_by) VALUES ('AC5', 'MNP26000999', '14AAACI1681G1ZX', '14', 'test')`);
  check('…and is satisfied once a person supplies it', await one(`SELECT recipient_gstin AS g, place_of_supply AS p, needs FROM v_gst_output_docs WHERE doc_no = 'MNP26000999'`), { g: '14AAACI1681G1ZX', p: '14', needs: null });
  check('our own bills appear as BILL documents, drafts marked', docs.filter((d) => d.doc_kind === 'BILL').map((d) => [d.doc_no, d.doc_status]), [['PT/2627/00001', 'ISSUED'], ['PT/2627/00002', 'ISSUED'], ['PT/2627/00003', 'ISSUED'], ['PT/2627/00004', 'ISSUED']]);
  check('Aug 2026 for Prasad: 2 AC5 docs + the July bill raised on 1 Aug (invoice date rules the period)', await one(`SELECT docs, rcm_taxable::text AS t, rcm_tax::text AS x FROM v_gst_output_month WHERE company_id = $1 AND period = '082026'`, [pt.id]), { docs: 3, t: '400000.00', x: '20000.00' });
  check('the bill raised on 2 Sep is a September invoice', (await one(`SELECT gst_period AS p FROM customer_bills WHERE bill_no = 'CB-HSC-AUG-2026-PT'`)).p, '092026');

  console.log('\nINPUT TAX CREDIT');
  await db.query(`INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system) VALUES ('Direct Expenses - Toll & FASTag','EXPENSE','PROFIT_AND_LOSS','DR',410,true), ('Direct Expenses (Vehicle Compliance & Docs)','EXPENSE','PROFIT_AND_LOSS','DR',411,true) ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system) VALUES ('Sundry Creditors (Fuel Pumps)','LIABILITY','BALANCE_SHEET','CR',300,true) ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO ledgers (ledger_name, group_head, company, dr_cr, branch, status) VALUES ('Direct Expenses - Toll & FASTag','Direct Expenses - Toll & FASTag','M/S PRASAD TRANSPORT','DR','ALL','ACTIVE'), ('Vehicle Insurance Expenses','Direct Expenses (Vehicle Compliance & Docs)','M/S PRASAD TRANSPORT','DR','ALL','ACTIVE'), ('Creditors: ALAM FUEL STATION','Sundry Creditors (Fuel Pumps)','M/S PRASAD TRANSPORT','CR','ALL','ACTIVE')`);
  await db.query(`INSERT INTO ledger_entries (ledger_name, entry_date, particulars, dr_cr, amount, source_type, source_ref, company, company_id) VALUES
    ('Direct Expenses - Toll & FASTag', '2026-08-03', 'toll AS26C5109', 'DR', 1200, 'FASTAG', 'T1', 'M/S PRASAD TRANSPORT', $1),
    ('Direct Expenses - Toll & FASTag', '2026-08-09', 'toll AS26C5106', 'DR', 800, 'FASTAG', 'T2', 'M/S PRASAD TRANSPORT', $1),
    ('Vehicle Insurance Expenses', '2026-08-15', 'ICICI Lombard AS26C5109', 'DR', 45000, 'VOUCHER', 'INS-1', 'M/S PRASAD TRANSPORT', $1),
    ('Creditors: ALAM FUEL STATION', '2026-08-16', 'pump bill Aug H1', 'CR', 250000, 'VOUCHER', 'PB-1', 'M/S PRASAD TRANSPORT', $1)`, [pt.id]).catch((e) => console.log('  (ledger fixture: ' + e.message.slice(0, 120) + ')'));
  await db.query(`INSERT INTO tyres (serial_no, brand, size, purchase_date, purchase_cost, base_cost, gst_amount, gst_percent, vendor_name, invoice_no, status) VALUES ('TY-1', 'MRF', '10.00-20', '2026-08-10', 23600, 20000, 3600, 18, 'S P AUTOMOBILE', 'SPA/221', 'IN_STOCK')`).catch((e) => console.log('  (tyres fixture: ' + e.message.slice(0, 120) + ')'));
  await db.query(`INSERT INTO tyre_fitments (tyre_serial, tyre_id, vehicle_id, vehicle_no, fitment_date) SELECT 'TY-1', t.id, v.id, v.vehicle_no, '2026-08-12' FROM tyres t, vehicles v WHERE t.serial_no = 'TY-1' AND v.vehicle_no = 'AS 26C 9801'`).catch((e) => console.log('  (fitment fixture: ' + e.message.slice(0, 120) + ')'));
  await db.query(`SELECT gst_itc_capture()`);
  const itc = (await db.query(`SELECT source_kind, category, amount_total::text AS amt, gst_amount::text AS gst, gst_known, eligibility FROM gst_itc_register ORDER BY source_kind, category`)).rows;
  check('toll is one monthly exempt-inward row', itc.find((r) => r.category === 'TOLL'), { source_kind: 'LEDGER_MONTH', category: 'TOLL', amt: '2000.00', gst: '0.00', gst_known: false, eligibility: 'EXEMPT_SUPPLY' });
  check('a pump creditor ledger never becomes a diesel purchase row (173)', itc.filter((r) => r.category === 'FUEL').length, 0);
  check('the tyre bill knows its GST but the firm is under RCM → blocked, kept', itc.find((r) => r.category === 'TYRES'), { source_kind: 'TYRE', category: 'TYRES', amt: '23600.00', gst: '3600.00', gst_known: true, eligibility: 'BLOCKED_SCHEME' });
  check('insurance from the ledger: GST unknown, blocked under RCM', itc.find((r) => r.category === 'INSURANCE')?.eligibility, 'BLOCKED_SCHEME');
  await db.query(`UPDATE companies SET gst_scheme = 'FCM_12' WHERE id = $1`, [pt.id]);
  await db.query(`SELECT gst_itc_capture()`);
  check('under the 12% option the tyre needs the supplier GSTIN, insurance needs its invoice', await one(`SELECT (SELECT eligibility FROM gst_itc_register WHERE category = 'TYRES') AS t, (SELECT eligibility FROM gst_itc_register WHERE category = 'INSURANCE') AS i`), { t: 'NO_GSTIN', i: 'NEEDS_INVOICE' });
  await db.query(`UPDATE gst_itc_register SET supplier_gstin = '18AXTPD0252D1ZP', edited_by = 'test' WHERE category = 'TYRES'`);
  await db.query(`SELECT gst_itc_capture()`);
  check('…and is ELIGIBLE with a valid one', (await one(`SELECT eligibility AS e FROM gst_itc_register WHERE category = 'TYRES'`)).e, 'ELIGIBLE');
  check('Aug ITC month for Prasad: ₹3,600 eligible (1,800 + 1,800), toll exempt inward ₹2,000', await one(`SELECT itc_cgst::text AS c, itc_sgst::text AS s, itc_eligible::text AS e, exempt_inward::text AS x, needs_invoice FROM v_gst_itc_month WHERE company_id = $1 AND period = '082026'`, [pt.id]), { c: '1800.00', s: '1800.00', e: '3600.00', x: '2000.00', needs_invoice: 1 });
  const net = await one(`SELECT output_tax::text AS o, itc_eligible::text AS i, net_payable::text AS n, carry_cgst::text AS cc FROM v_gst_net_month WHERE company_id = $1 AND period = '082026'`, [pt.id]);
  check('net month view: no forward output yet, so ITC carries forward', net, { o: '0.00', i: '3600.00', n: '0.00', cc: '1800.00' });

  console.log('\nFILINGS, OVERVIEW, AUDIT');
  await db.query(`SELECT gst_filings_sync()`);
  check('GSTR-1 and GSTR-3B drafts for Prasad Aug 2026 with their due dates', (await db.query(`SELECT form, due_date::text AS due, status FROM gst_filings WHERE company_id = $1 AND period = '082026' ORDER BY form`, [pt.id])).rows, [{ form: 'GSTR1', due: '2026-09-11', status: 'DRAFT' }, { form: 'GSTR3B', due: '2026-09-20', status: 'DRAFT' }]);
  const ov = await one(`SELECT gstin, gstin_valid, gst_scheme, fy_docs, docs_needing_attention, customers_without_gstin FROM v_gst_overview WHERE company_id = $1`, [pt.id]);
  check('the overview reads it all (4 own bills to customers without a GSTIN need attention)', ov, { gstin: '18AAKFP2339R2ZG', gstin_valid: true, gst_scheme: 'FCM_12', fy_docs: 6, docs_needing_attention: 4, customers_without_gstin: 2 });
  const audit = (await one(`SELECT gst_deep_audit('test') AS a`)).a;
  check('the deep audit reports firms, customers, documents and books mismatches', [Array.isArray(audit.firms), Array.isArray(audit.customers), typeof audit.documents, Array.isArray(audit.gstin_vs_books), Array.isArray(audit.invalid_vendor_gstins)], [true, true, 'object', true, true]);
  check('…and is remembered', Number((await one(`SELECT count(*)::int AS n FROM gst_audit_runs`)).n) >= 2, true);
} catch (e) {
  console.log(`  FAIL  the test threw: ${e.message}`); failures += 1;
} finally {
  await db.end();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
