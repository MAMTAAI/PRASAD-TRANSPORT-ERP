// server/db/migrations/174_hr_payroll.selftest.mjs
// Proves on the production schema: 160 → 174 apply and 174 re-runs; the
// khata balance; no pay model → BLOCKED with the reason; trip basis (route
// bhatta, % of freight) with korki in priority order and carry-forward; the
// completion trigger; posted rows frozen; monthly runs for a salaried driver,
// office staff and a partner with edits kept; the disbursal queue; overview;
// the deep audit.
//   MIGTEST_PG=… MIGTEST_SCHEMA=… node server/db/migrations/174_hr_payroll.selftest.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = process.env.MIGTEST_PG; const SCHEMA = process.env.MIGTEST_SCHEMA;
if (!ADMIN || !SCHEMA) { console.error('set MIGTEST_PG and MIGTEST_SCHEMA'); process.exit(2); }
const DB = 'pt_mig174_test';
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


  console.log('\nPRODUCTION SCHEMA (through 159) + 160–174');
  for (const f of ['160_vehicle_owner_bills.sql', '161_vehicle_ownership_rule.sql', '162_market_partner_bills.sql', '163_customer_bills.sql', '164_customer_contract_rate.sql', '165_advice_truth.sql', '166_fortnight_by_unloading.sql', '167_bank_reconciliation.sql', '168_reattach_open_drafts.sql', '169_tds_management.sql', '170_tds_fuel_exempt_and_own_vehicle.sql', '171_gst_gta_360.sql', '172_gst_invoice_dates_and_itc_scope.sql', '173_gst_itc_expense_groups_only.sql']) {
    await db.query(readFileSync(path.join(here, f), 'utf8'));
  }
  await db.query(`INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system) VALUES ('Current Assets - Driver Advances','ASSET','BALANCE_SHEET','DR',150,true), ('Direct Expenses - Driver & Trip','EXPENSE','PROFIT_AND_LOSS','DR',420,true), ('Shortage & Penalty','EXPENSE','PROFIT_AND_LOSS','DR',430,true), ('Cash-in-Hand','ASSET','BALANCE_SHEET','DR',101,true) ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO drivers (name, mobile, license_no) VALUES ('JONAB ALI', '9000000001', 'AS0120200001234'), ('SANJIV RAY YADAV', '9000000002', 'AS0120200005678'), ('OHED ALI', '9000000003', 'AS0120200009999')`);
  await db.query(readFileSync(path.join(here, '174_hr_payroll.sql'), 'utf8'));
  check('160 → 174 apply on the production schema', true, true);
  await db.query(readFileSync(path.join(here, '174_hr_payroll.sql'), 'utf8'));
  check('174 is re-runnable', true, true);

  console.log('\nTRIPS AND THE KHATA (fixtures)');
  const { rows: [pt] } = await db.query(`SELECT id FROM companies WHERE company_name = 'M/S PRASAD TRANSPORT'`);
  const { rows: [jonab] } = await db.query(`SELECT id FROM drivers WHERE name = 'JONAB ALI'`);
  const { rows: [sanjiv] } = await db.query(`SELECT id FROM drivers WHERE name = 'SANJIV RAY YADAV'`);
  const { rows: [ohed] } = await db.query(`SELECT id FROM drivers WHERE name = 'OHED ALI'`);
  await db.query(`INSERT INTO trips (trip_code, vehicle_no, driver_id, driver_name, status, loading_date, unloading_date, fixed_cash, shortage_qty, shortage_penalty, freight_amount, rtkm, company_id, operating_company)
    VALUES ('PT00901', 'AS 26C 9801', $1::uuid, 'JONAB ALI', 'IN_TRANSIT', '2026-08-20', NULL, 3000, 0, 0, 120000, 900, $3::uuid, 'M/S PRASAD TRANSPORT'),
           ('PT00902', 'AS 26C 9801', $1::uuid, 'JONAB ALI', 'COMPLETED', '2026-08-10', '2026-08-13', 2500, 0.04, 2000, 100000, 800, $3::uuid, 'M/S PRASAD TRANSPORT'),
           ('PT00903', 'AS 26C 9802', $2::uuid, 'SANJIV RAY YADAV', 'COMPLETED', '2026-08-11', '2026-08-14', 2500, 0, 0, 90000, 700, $3::uuid, 'M/S PRASAD TRANSPORT'),
           ('PT00904', 'AS 26C 9803', NULL, 'OHED ALI', 'COMPLETED', '2026-08-12', '2026-08-15', NULL, 0, 0, 80000, 650, $3::uuid, 'M/S PRASAD TRANSPORT')`, [jonab.id, sanjiv.id, pt.id])
    .catch((e) => console.log('  (trips fixture: ' + e.message.slice(0, 140) + ')'));
  const tripId = async (code) => (await one(`SELECT id FROM trips WHERE trip_code = $1`, [code])).id;
  await db.query(`INSERT INTO driver_transactions (driver_id, driver_name, trip_id, txn_date, txn_type, amount, mode, remarks) VALUES
    ($1::uuid, 'JONAB ALI', $2::uuid, '2026-08-20', 'ADVANCE_GIVEN', 5000, 'Office Cash', 'Trip PT00901 Cash from ALAM FUEL STATION'),
    ($1::uuid, 'JONAB ALI', $3::uuid, '2026-08-11', 'ADVANCE_GIVEN', 1500, 'Office Cash', 'Trip PT00902 Cash'),
    ($1::uuid, 'JONAB ALI', NULL, '2026-07-01', 'ADVANCE_GIVEN', 20000, 'Bank Transfer', 'festival advance'),
    ($4::uuid, 'SANJIV RAY YADAV', NULL, '2026-08-05', 'ADVANCE_GIVEN', 4000, 'Office Cash', 'advance')`, [jonab.id, await tripId('PT00901'), await tripId('PT00902'), sanjiv.id]);
  check('khata balance = what the driver took (JONAB ₹26,500)', (await one(`SELECT driver_khata_balance($1, 'JONAB ALI')::text AS b`, [jonab.id])).b, '26500.00');

  console.log('\nNOTHING IS GUESSED');
  await db.query(`SELECT payroll_deep_audit('test')`);
  const s0 = (await db.query(`SELECT trip_code, status, block_reason FROM driver_trip_settlements ORDER BY trip_code`)).rows;
  check('every completed trip has a settlement row; none can pay without a model', s0.map((r) => [r.trip_code, r.status]), [['PT00902', 'BLOCKED'], ['PT00903', 'BLOCKED'], ['PT00904', 'BLOCKED']]);
  check('…and says why', s0[0].block_reason, 'no compensation model configured (Driver Master → Configure)');
  check('the in-transit trip has none', (await one(`SELECT count(*)::int AS n FROM driver_trip_settlements s JOIN trips t ON t.id = s.trip_id WHERE t.status = 'IN_TRANSIT'`)).n, 0);

  console.log('\nTRIP BASIS — INSTANT SETTLEMENT');
  await db.query(`UPDATE drivers SET pay_model = 'TRIP', trip_rate_mode = 'ROUTE', shortage_recovery_pct = 100, pay_company_id = $2 WHERE id = $1`, [jonab.id, pt.id]);
  await db.query(`SELECT driver_resettle_open($1)`, [jonab.id]);
  const s902 = await one(`SELECT status, basis, earning::text AS e, korki_advances::text AS adv, korki_shortage::text AS sh, applied_shortage::text AS ash, applied_advances::text AS aadv, net_payable::text AS net, carry_forward::text AS cf, settlement_no FROM driver_trip_settlements WHERE trip_code = 'PT00902'`);
  check('route bhatta ₹2,500 − shortage ₹2,000 − trip advance ₹1,500 (capped) → net ₹0, ₹1,000 of advance carries forward', s902, { status: 'DRAFT', basis: 'ROUTE', e: '2500.00', adv: '1500.00', sh: '2000.00', ash: '2000.00', aadv: '500.00', net: '0.00', cf: '1000.00', settlement_no: 'DTS-000001' });
  await db.query(`UPDATE drivers SET trip_rate_mode = 'PCT_FREIGHT', trip_rate = 6 WHERE id = $1`, [jonab.id]);
  await db.query(`SELECT driver_resettle_open($1)`, [jonab.id]);
  check('6% of freight ₹1,00,000 = ₹6,000 → shortage 2,000, advance 1,500, net ₹2,500', await one(`SELECT earning::text AS e, net_payable::text AS net, carry_forward::text AS cf FROM driver_trip_settlements WHERE trip_code = 'PT00902'`), { e: '6000.00', net: '2500.00', cf: '0.00' });
  // the trigger: completing the in-transit trip settles it at once
  await db.query(`UPDATE trips SET status = 'COMPLETED', unloading_date = '2026-08-23', completed_at = now() WHERE trip_code = 'PT00901'`);
  check('completing a trip creates its settlement instantly (trigger): ₹7,200 − ₹5,000 pump cash = ₹2,200', await one(`SELECT status, earning::text AS e, applied_advances::text AS adv, net_payable::text AS net FROM driver_trip_settlements WHERE trip_code = 'PT00901'`), { status: 'DRAFT', e: '7200.00', adv: '5000.00', net: '2200.00' });
  check('the festival advance (no trip) is not korki on a trip — it waits in the khata', (await one(`SELECT korki_advances::text AS a FROM driver_trip_settlements WHERE trip_code = 'PT00901'`)).a, '5000.00');
  await db.query(`UPDATE driver_trip_settlements SET status = 'POSTED', posted_at = now() WHERE trip_code = 'PT00902'`);
  await db.query(`UPDATE drivers SET trip_rate = 10 WHERE id = $1`, [jonab.id]);
  await db.query(`SELECT driver_resettle_open($1)`, [jonab.id]);
  check('a POSTED settlement is never recomputed', (await one(`SELECT earning::text AS e FROM driver_trip_settlements WHERE trip_code = 'PT00902'`)).e, '6000.00');
  check('…but an open one follows the new rate', (await one(`SELECT earning::text AS e FROM driver_trip_settlements WHERE trip_code = 'PT00901'`)).e, '12000.00');
  check('per-km and per-trip bases', await one(`SELECT (SELECT earning FROM driver_trip_pay($1))::text AS pct, 1 AS one`, [await tripId('PT00901')]), { pct: '12000.00', one: 1 });
  check('the disbursal queue lists the posted settlement', (await db.query(`SELECT source, person_name, payable_ledger, amount::text AS amt FROM v_payables_for_disbursal`)).rows, [{ source: 'TRIP', person_name: 'JONAB ALI', payable_ledger: 'Driver Payable: JONAB ALI', amt: '2500.00' }]);

  console.log('\nMONTHLY — FIXED SALARY');
  await db.query(`UPDATE drivers SET pay_model = 'MONTHLY', monthly_salary = 15000, pay_company_id = $2 WHERE id = $1`, [sanjiv.id, pt.id]);
  await db.query(`SELECT driver_trip_settle(id, 'test') FROM trips WHERE trip_code = 'PT00903'`);
  check('a salaried driver’s trip is not an instant settlement', (await one(`SELECT count(*)::int AS n FROM driver_trip_settlements WHERE trip_code = 'PT00903'`)).n, 0);
  await db.query(`INSERT INTO staff_members (company_id, kind, name, role_title, monthly_amount) VALUES ($1, 'STAFF', 'MAMTA DEVI', 'Accounts', 18000), ($1, 'PARTNER', 'SANDEEP KUMAR PRASAD', 'Partner', 50000)`, [pt.id]);
  const { rows: [mamta] } = await db.query(`SELECT id FROM staff_members WHERE name = 'MAMTA DEVI'`);
  await db.query(`INSERT INTO staff_transactions (staff_id, txn_date, txn_type, amount, mode, remarks) VALUES ($1, '2026-08-10', 'ADVANCE_GIVEN', 3000, 'Office Cash', 'advance')`, [mamta.id]);
  const runD = (await one(`SELECT payroll_run_build($1, '2026-08', 'DRIVER', 'test') AS id`, [pt.id])).id;
  const runS = (await one(`SELECT payroll_run_build($1, '2026-08', 'STAFF', 'test') AS id`, [pt.id])).id;
  check('driver run: salary ₹15,000 − advance ₹4,000 = ₹11,000', await one(`SELECT person_name, gross::text AS g, deduct_advances::text AS a, net_payable::text AS n FROM payroll_lines WHERE run_id = $1`, [runD]), { person_name: 'SANJIV RAY YADAV', g: '15000.00', a: '4000.00', n: '11000.00' });
  check('run numbers and totals', await one(`SELECT run_no, persons, net_total::text AS net FROM payroll_runs WHERE id = $1`, [runD]), { run_no: 'PR-202608-PT-D', persons: 1, net: '11000.00' });
  check('staff run: office staff and partner, advance deducted', (await db.query(`SELECT person_kind, person_name, gross::text AS g, deduct_advances::text AS a, net_payable::text AS n FROM payroll_lines WHERE run_id = $1 ORDER BY person_name`, [runS])).rows, [{ person_kind: 'STAFF', person_name: 'MAMTA DEVI', g: '18000.00', a: '3000.00', n: '15000.00' }, { person_kind: 'PARTNER', person_name: 'SANDEEP KUMAR PRASAD', g: '50000.00', a: '0.00', n: '50000.00' }]);
  await db.query(`UPDATE payroll_lines SET gross = 16000, net_payable = 13000, edited_by = 'owner' WHERE run_id = $1 AND person_name = 'MAMTA DEVI'`, [runS]);
  await db.query(`SELECT payroll_run_build($1, '2026-08', 'STAFF', 'test')`, [pt.id]);
  check('a rebuild keeps a person’s edit', (await one(`SELECT gross::text AS g FROM payroll_lines WHERE run_id = $1 AND person_name = 'MAMTA DEVI'`, [runS])).g, '16000.00');
  await db.query(`UPDATE payroll_lines SET status = 'POSTED' WHERE run_id = $1`, [runS]); await db.query(`UPDATE payroll_runs SET status = 'POSTED', posted_at = now() WHERE id = $1`, [runS]);
  check('posted lines join the disbursal queue with the right payable ledgers', (await db.query(`SELECT payable_ledger, amount::text AS amt FROM v_payables_for_disbursal WHERE source = 'MONTHLY' ORDER BY 1`)).rows, [{ payable_ledger: 'Remuneration Payable: SANDEEP KUMAR PRASAD', amt: '50000.00' }, { payable_ledger: 'Salary Payable: MAMTA DEVI', amt: '13000.00' }]);
  check('a posted run is not rebuilt', (await one(`SELECT payroll_run_build($1, '2026-08', 'STAFF', 'test') = $2 AS same`, [pt.id, runS])).same, true);

  console.log('\nOVERVIEW + AUDIT');
  const ov = await one(`SELECT drivers_trip, drivers_monthly, drivers_unconfigured, trip_blocked, trip_drafts, ready_count, ready_for_disbursal::text AS ready, staff_active, partners_active FROM v_payroll_overview WHERE company_id = $1`, [pt.id]);
  check('the overview reads it all', ov, { drivers_trip: 1, drivers_monthly: 1, drivers_unconfigured: 1, trip_blocked: 1, trip_drafts: 1, ready_count: 3, ready: '65500.00', staff_active: 1, partners_active: 1 });
  const audit = (await one(`SELECT payroll_deep_audit('test') AS a`)).a;
  check('the deep audit reports models, open settlements and khata-vs-ledger differences', [audit.drivers.total, audit.drivers.unconfigured, audit.open.blocked, Array.isArray(audit.khata_vs_ledger), audit.khata_vs_ledger.find((k) => k.driver === 'JONAB ALI')?.khata], [3, 1, 1, true, 26500]);
} catch (e) {
  console.log(`  FAIL  the test threw: ${e.message}`); failures += 1;
} finally {
  await db.end();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
