// server/db/migrations/149_trip_expense_truth.selftest.mjs
// ─────────────────────────────────────────────────────────────────────────────
//   MIGTEST_PG=postgres://testu@127.0.0.1:5433/postgres npm run migrate:selftest149
//
// This migration decides what a trip EARNED. Every mistake in it is silent and
// expensive: a toll left out makes a loss-making lane look profitable, an
// advance counted as an expense makes a good one look bad, and a bill filed on
// the wrong lorry moves money between two trips that will both be believed.
//
// So the fixtures below are the exact shapes the audit found in the real
// system: a pump bill with no trip, a tyre bill on the wrong lorry, a fuel slip
// carrying pump cash, a toll crossing, a driver advance, and a trips.total_expense
// that has drifted away from all of them.
//
// Skips with exit 0 when MIGTEST_PG is unset. See [[testing-migrations-locally]].
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ADMIN = process.env.MIGTEST_PG;
if (!ADMIN) {
  console.log('\n⏭  MIGTEST_PG not set — skipping the migration 149 selftest.\n');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(path.join(here, '149_trip_expense_truth.sql'), 'utf8');
const DB = 'pt_mig149_test';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const admin = new pg.Client({ connectionString: ADMIN });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
await admin.query(`CREATE DATABASE ${DB}`);
await admin.end();

const db = new pg.Client({ connectionString: ADMIN.replace(/\/[^/]*$/, `/${DB}`) });
await db.connect();

try {
  // Only the columns migration 149 actually reads. Building the whole ERP here
  // would hide an undeclared dependency instead of exposing it.
  await db.query(`
    CREATE TABLE trips (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trip_code text, vehicle_no text, driver_name text, customer_name text,
      operating_company text, status text,
      loading_date date, unloading_date date,
      freight_amount numeric(14,2), shortage_penalty numeric(14,2),
      total_expense numeric(14,2));

    CREATE TABLE fuel_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entry_date date, trip_id uuid REFERENCES trips(id), vehicle_no text,
      vendor_name text, memo_no text, liters numeric(10,3),
      amount numeric(14,2), cash_given_to_pump numeric(14,2));

    CREATE TABLE toll_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trip_id uuid REFERENCES trips(id), vehicle_no text, plaza_name text,
      amount numeric(12,2), txn_date date, txn_datetime timestamptz);

    CREATE TABLE driver_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trip_id uuid REFERENCES trips(id), driver_name text, txn_date date,
      txn_type text, amount numeric(12,2), mode text);

    CREATE TABLE expense_approvals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trip_id uuid REFERENCES trips(id), trip_ref text, vehicle_no text,
      vendor_name text, expense_type text, bill_no text, bill_date date,
      amount numeric(14,2), status text DEFAULT 'PENDING',
      created_at timestamptz NOT NULL DEFAULT now());
  `);

  // ── The fixture: one honest trip and one messy one ───────────────────────
  const { rows: [A] } = await db.query(`
    INSERT INTO trips (trip_code, vehicle_no, driver_name, status, loading_date,
                       unloading_date, freight_amount, shortage_penalty, total_expense)
    VALUES ('PT001', 'AS 26C 9804', 'IBRAHIM ALI', 'COMPLETED', '2026-08-01',
            '2026-08-04', 100000, 500, 999999) RETURNING id`);
  const { rows: [B] } = await db.query(`
    INSERT INTO trips (trip_code, vehicle_no, driver_name, status, loading_date, freight_amount)
    VALUES ('PT002', 'AS 26C 9816', 'JONAB ALI', 'IN_TRANSIT', '2026-08-02', 60000) RETURNING id`);

  await db.query(`
    INSERT INTO fuel_entries (entry_date, trip_id, vehicle_no, vendor_name, memo_no, amount, cash_given_to_pump)
    VALUES ('2026-08-01', $1, 'AS 26C 9804', 'Bharat Pump', 'M1', 40000, 5000)`, [A.id]);
  await db.query(`
    INSERT INTO toll_transactions (trip_id, vehicle_no, plaza_name, amount, txn_date)
    VALUES ($1, 'AS 26C 9804', 'Sonapur', 165, '2026-08-02'),
           ($1, 'AS 26C 9804', 'Churaibari', 210, '2026-08-03')`, [A.id]);
  await db.query(`
    INSERT INTO driver_transactions (trip_id, driver_name, txn_date, txn_type, amount, mode)
    VALUES ($1, 'IBRAHIM ALI', '2026-08-01', 'ADVANCE_GIVEN', 8000, 'Cash'),
           ($1, 'IBRAHIM ALI', '2026-08-05', 'SHORTAGE_RECOVERY', 500, 'Cash')`, [A.id]);
  await db.query(`
    INSERT INTO expense_approvals (trip_id, vehicle_no, expense_type, amount, status, bill_date, vendor_name)
    VALUES ($1, 'AS 26C 9804', 'TYRE', 12000, 'APPROVED', '2026-08-03', 'Tyre House'),
           ($1, 'AS 26C 9804', 'MAINTENANCE', 3000, 'PENDING',  '2026-08-03', 'Garage')`, [A.id]);

  console.log('\nTHE MIGRATION ITSELF');
  await db.query(SQL);
  check('applies without error', true, true);

  console.log('\nTYPE-WISE, AND NOTHING MISSING');
  const { rows: [p] } = await db.query(
    `SELECT hsd::float8, toll::float8, tyre::float8, maintenance::float8, other::float8,
            expense_total::float8, advances::float8, profit::float8, freight::float8
       FROM v_trip_pnl WHERE trip_id = $1`, [A.id]);
  check('HSD is the diesel value only', p.hsd, 40000);
  check('TOLL is both crossings — the old P&L dropped these', p.toll, 375);
  check('TYRE comes from the approved bill', p.tyre, 12000);
  check('a PENDING bill is not an expense yet', p.maintenance, 0);
  check('expense total = 40000 + 375 + 12000', p.expense_total, 52375);

  console.log('\nAN ADVANCE IS NOT AN EXPENSE');
  // 8000 driver cash + 5000 pump cash − 500 recovered = 12,500 owed back.
  check('advances are counted separately', p.advances, 12500);
  check('and are NOT inside the expense total', p.expense_total, 52375);
  check('profit = freight − expense + penalty', p.profit, 100000 - 52375 + 500);

  console.log('\nTHE STORED COLUMN IS A CACHE, AND IT HAS DRIFTED');
  const { rows: [d] } = await db.query(
    `SELECT stored_total_expense::float8 AS s, drift::float8 AS d FROM v_trip_pnl WHERE trip_id = $1`, [A.id]);
  check('the cache is reported, not trusted', [d.s, d.d], [999999, 999999 - 52375]);
  const { rows: drift } = await db.query(
    `SELECT amount::float8 FROM v_trip_expense_audit WHERE finding = 'STORED_DRIFT' AND trip_id = $1`, [A.id]);
  check('and the audit raises it', drift.length, 1);

  console.log('\nA TRIP WITH NOTHING ON IT IS ZERO, NOT NULL');
  const { rows: [z] } = await db.query(
    `SELECT expense_total::float8 AS e, advances::float8 AS a, profit::float8 AS pr, expense_lines
       FROM v_trip_pnl WHERE trip_id = $1`, [B.id]);
  check('empty trip totals are 0', [z.e, z.a, z.expense_lines], [0, 0, 0]);
  check('and its profit is the whole freight', z.pr, 60000);

  console.log('\nORPHANS — IN THE BOOKS, IN NO TRIP');
  await db.query(`
    INSERT INTO expense_approvals (vehicle_no, expense_type, amount, status, bill_date, vendor_name)
    VALUES ('AS 26C 9804', 'MAINTENANCE', 7000, 'APPROVED', '2026-08-06', 'Garage')`);
  await db.query(`
    INSERT INTO fuel_entries (entry_date, vehicle_no, vendor_name, amount) VALUES ('2026-08-07','AS 26C 9816','Pump',9000)`);
  await db.query(`
    INSERT INTO toll_transactions (vehicle_no, plaza_name, amount, txn_date) VALUES ('AS 26C 9816','Jorhat',140,'2026-08-07')`);
  const { rows: orph } = await db.query(
    `SELECT finding, amount::float8 FROM v_trip_expense_audit
      WHERE finding LIKE 'ORPHAN%' ORDER BY finding`);
  check('every orphan is found', orph.map((r) => [r.finding, r.amount]),
        [['ORPHAN_BILL', 7000], ['ORPHAN_FUEL', 9000], ['ORPHAN_TOLL', 140]]);

  console.log('\nTHE GUARD — ONE TRIP’S EXPENSE CANNOT GO ONTO ANOTHER');
  // The owner's sentence, as a database rule. PT002 ran AS 26C 9816.
  let refused = null;
  try {
    await db.query(`
      INSERT INTO expense_approvals (trip_id, vehicle_no, expense_type, amount, status, bill_date)
      VALUES ($1, 'AS 26C 9804', 'TYRE', 5000, 'APPROVED', '2026-08-03')`, [B.id]);
  } catch (e) { refused = e.code; }
  check('a bill for another lorry is refused', refused, 'P0405');

  let refusedFuel = null;
  try {
    await db.query(`INSERT INTO fuel_entries (entry_date, trip_id, vehicle_no, amount)
                    VALUES ('2026-08-03', $1, 'AS 26C 9804', 1000)`, [B.id]);
  } catch (e) { refusedFuel = e.code; }
  check('so is a fuel slip', refusedFuel, 'P0405');

  let refusedToll = null;
  try {
    await db.query(`INSERT INTO toll_transactions (trip_id, vehicle_no, plaza_name, amount, txn_date)
                    VALUES ($1, 'AS 26C 9804', 'X', 100, '2026-08-03')`, [B.id]);
  } catch (e) { refusedToll = e.code; }
  check('and a toll crossing', refusedToll, 'P0405');

  // Spacing and case are not a mismatch. Refusing on those would block the desk
  // over a typing habit rather than protect anything.
  let spacing = null;
  try {
    await db.query(`INSERT INTO expense_approvals (trip_id, vehicle_no, expense_type, amount, status, bill_date)
                    VALUES ($1, 'as26c9816', 'OTHER', 300, 'APPROVED', '2026-08-03')`, [B.id]);
  } catch (e) { spacing = e.message; }
  check('the same lorry spelled differently is allowed', spacing, null);

  // A bill with no vehicle on the paper still has to be fileable — the desk may
  // know what the paper does not say. It lands in the audit, not in a refusal.
  let noVeh = null;
  try {
    await db.query(`INSERT INTO expense_approvals (trip_id, expense_type, amount, status, bill_date)
                    VALUES ($1, 'OTHER', 400, 'APPROVED', '2026-08-03')`, [B.id]);
  } catch (e) { noVeh = e.message; }
  check('a bill with no vehicle is not blocked', noVeh, null);

  console.log('\nWHAT ALREADY WENT WRONG IS STILL REPORTED');
  // The guard stops new mistakes; rows that predate it must still be findable.
  await db.query('ALTER TABLE expense_approvals DISABLE TRIGGER expense_approvals_vehicle_guard');
  await db.query(`INSERT INTO expense_approvals (trip_id, vehicle_no, expense_type, amount, status, bill_date)
                  VALUES ($1, 'AS 26C 9804', 'TYRE', 5000, 'APPROVED', '2026-08-03')`, [B.id]);
  await db.query('ALTER TABLE expense_approvals ENABLE TRIGGER expense_approvals_vehicle_guard');
  const { rows: wrong } = await db.query(
    `SELECT amount::float8, detail FROM v_trip_expense_audit WHERE finding = 'WRONG_VEHICLE'`);
  check('a historical wrong-lorry expense is raised', wrong.length, 1);
  check('with the amount that moved', wrong[0]?.amount, 5000);

  console.log('\nA BILL DATED OUTSIDE ITS TRIP');
  await db.query(`INSERT INTO expense_approvals (trip_id, vehicle_no, expense_type, amount, status, bill_date)
                  VALUES ($1, 'AS 26C 9804', 'OTHER', 2000, 'APPROVED', '2026-09-30')`, [A.id]);
  const { rows: late } = await db.query(
    `SELECT amount::float8 FROM v_trip_expense_audit WHERE finding = 'DATE_OUTSIDE_TRIP'`);
  check('a bill six weeks after unloading is raised', late.map((r) => r.amount), [2000]);

  console.log('\nTHE SAME DIESEL TWICE');
  await db.query(`INSERT INTO expense_approvals (trip_id, vehicle_no, expense_type, amount, status, bill_date)
                  VALUES ($1, 'AS 26C 9804', 'FUEL', 40000, 'APPROVED', '2026-08-01')`, [A.id]);
  const { rows: dup } = await db.query(
    `SELECT amount::float8 FROM v_trip_expense_audit WHERE finding = 'FUEL_TWICE'`);
  check('a fuel bill on a trip that has fuel slips is raised', dup.map((r) => r.amount), [40000]);

  console.log('\nRE-RUNNABLE');
  const before = (await db.query('SELECT count(*)::int n FROM v_trip_expense_audit')).rows[0].n;
  await db.query(SQL);
  const after = (await db.query('SELECT count(*)::int n FROM v_trip_expense_audit')).rows[0].n;
  check('applying it twice changes nothing', after, before);
} catch (err) {
  failures += 1;
  console.log(`\n  FAIL  threw: ${err.message}`);
  if (err.position) console.log(`        at character ${err.position}`);
} finally {
  await db.end();
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${DB}`);
  await c.end();
}

console.log(failures ? `\n❌ ${failures} failed\n` : '\n✅ all passed\n');
process.exit(failures ? 1 : 0);
