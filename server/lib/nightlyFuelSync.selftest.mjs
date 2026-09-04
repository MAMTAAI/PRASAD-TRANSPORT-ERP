// server/lib/nightlyFuelSync.selftest.mjs
// ─────────────────────────────────────────────────────────────────────────────
//   npm run nightly:selftest                        — the clock arithmetic
//   MIGTEST_PG=postgres://testu@127.0.0.1:5433/postgres npm run nightly:selftest
//                                                   — the whole chain, for real
//
// The second form runs the ACTUAL 02:00 job against an actual PostgreSQL, with
// an actual folder holding an actual IOCL export: collect → import → reconcile
// → hand off. Nothing is stubbed, because everything worth getting wrong here
// lives in the seams — a folder that reads but a file that does not parse, a
// second night over the same download, a fortnight computed on the wrong clock.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../db/migrations');

const ADMIN = process.env.MIGTEST_PG;
const DB = 'pt_nightly_test';
const url = ADMIN ? ADMIN.replace(/\/[^/]*$/, `/${DB}`) : null;

// THE POOL LATCHES ON AT IMPORT. pool.js reads DATABASE_URL once, when it is
// first loaded, and every later import hands back that same instance — so the
// env has to be right BEFORE anything pulls it in, however indirectly.
// Importing the clock helpers first and setting the env afterwards left the
// pool pointed at nothing, and the whole chain reported "db unavailable" while
// looking for all the world like a logic failure.
if (url) {
  process.env.DATABASE_URL = url;
  process.env.DB_TARGET = 'LOCAL';
}

// ── 1 · the clock ──────────────────────────────────────────────────────────
const { globToRe, istNow, runNightlyFuelSync } = await import('./nightlyFuelSync.js');
const { periodBounds } = await import('./periods.js');

console.log('\nWHICH FILES THE JOB WILL PICK UP');
const m = (glob, name) => globToRe(glob).test(name);
check('*.csv takes a statement',              m('*.csv', 'CustomerTxnReport.csv'), true);
check('…and is not case-fussy',               m('*.csv', 'REPORT.CSV'), true);
check('…and leaves the PDF beside it',        m('*.csv', 'invoice.pdf'), false);
check('a prefix keeps other exports out',     m('IOCL*.csv', 'BPCL_sales.csv'), false);
check('…and lets its own through',            m('IOCL*.csv', 'IOCL_apr_sep.csv'), true);
// A dot in the glob is a dot, not "any character" — otherwise `report.csv`
// would also match `reportXcsv` and a stray file could be fed to the importer.
check('the dot is a literal dot',             m('report.csv', 'reportXcsv'), false);

console.log('\nTHE FORTNIGHT, ON THE OFFICE CLOCK');
// The trap: periodBounds() reads the date with LOCAL getters, so shifting the
// instant by 5.5h is right only on a UTC box. These three instants are the ones
// that separate a correct implementation from a plausible one.
const cyc = (iso) => periodBounds('FORTNIGHT', 0, istNow(new Date(iso))).short;
check('15 Sep 20:00 IST is still 1–15',       cyc('2026-09-15T14:30:00Z'), 'Sep H1');
check('16 Sep 02:00 IST has turned over',     cyc('2026-09-15T20:30:00Z'), 'Sep H2');
check('1 Sep 02:00 IST is the new month',     cyc('2026-08-31T20:30:00Z'), 'Sep H1');
check('31 Aug 23:00 IST is still August',     cyc('2026-08-31T17:30:00Z'), 'Aug H2');
// 02:00 IST is 20:30 UTC of the day before — the exact case a UTC box gets
// wrong in the other direction if it does no shifting at all.
check('the job runs on the day it wakes',
  periodBounds('FORTNIGHT', 0, istNow(new Date('2026-09-03T20:30:00Z'))).from, '2026-09-01');

// ── 2 · the chain ──────────────────────────────────────────────────────────
if (!ADMIN) {
  console.log('\n⏭  MIGTEST_PG not set — skipping the end-to-end chain.\n');
  console.log(`${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
  process.exit(failures ? 1 : 0);
}

const pg = (await import('pg')).default;
const admin = new pg.Client({ connectionString: ADMIN });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
await admin.query(`CREATE DATABASE ${DB}`);
await admin.end();

const db = new pg.Client({ connectionString: url });
await db.connect();

// The export, as IOCL writes it: one diesel swipe, one recharge, one wallet
// settlement that is NOT diesel, one loyalty award in points.
const IOCL_CSV = `Customer Transaction Details Report
Period:01/09/2026 To 04/09/2026

Customer ID: 1001774381

Transaction Summary (CCMS)
Sale,18544.00




SNo., Terminal ID, Merchant ID, Merchant Name , Merchant PAN, State, Location, Customer ID/Card PAN, Vehicle No. (Card), Txn ID, Txn Date, Settlement Date, Txn Type, Txn Mode, Txn Mode Value, Product, Currency, RSP, Quantity,Deduction, Amount, Balance, Odometer (User Entry), Status, ITPSTxnID, NozzleNumber,Merchant SAPCode, FuelTimeStamp, DUNumber, FCCTransactionId,VehicleNo (User Entry),OfflineFlag,DUReceiptNumber,TagsDescription,Incentive Approved Date, Incentive Award Date
1,4000510558,M1,ALAM FUEL STATION,ABC,Assam,KANKI,7113010439890995,AS26C7319,1390000002,02/09/2026 08:00:00,,Sale,CARD,,DIESEL,CCMS,92.72,200.00,,18544.00,0.00,,PT,,,,,,,,,,,,
2,4000519195,M2,INDANE BOTTLING PLANT,ABC,Assam,GUWAHATI,1001774381,-,1390000003,02/09/2026 10:04:06,02/09/2026 12:00:10,Recharge,,,7500000411,CCMS,0.00,0,,462941.50,493805.37,,PT,,,,,,,,,,,,
3,4000000001,M3,IOCL HO,ABC,Assam,HO,1001774381,-,1390000004,03/09/2026 11:24:14,03/09/2026 12:00:10,CCMS Sale Completion,,,,CCMS,0.00,-,,20000.00,0.00,,PT,-,,,,,0,,,,,,
4,4000000002,M4,IOCL HO - LOYALTY,ABC,Assam,HO,1001774381,-,1390000005,03/09/2026 09:00:00,,Loyalty Award,,,,XTRA,0.00,0,,15000.00,0.00,,PT,,,,,,,,,,,,
`;

let dir;
try {
  await db.query(`
    CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN NEW.updated_at := now(); RETURN NEW; END $fn$;
    CREATE TABLE vehicles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), vehicle_no text);
    CREATE TABLE vendors  (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), vendor_name text);
    CREATE TABLE trips (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trip_code text, vehicle_no text,
      driver_name text, customer_name text, operating_company text, status text,
      loading_date date, unloading_date date, freight_amount numeric(14,2),
      shortage_penalty numeric(14,2), total_expense numeric(14,2));
    CREATE TABLE fuel_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entry_date date,
      trip_id uuid REFERENCES trips(id), vehicle_no text, vendor_name text, memo_no text,
      liters numeric(10,3), amount numeric(14,2), cash_given_to_pump numeric(14,2));
    CREATE TABLE toll_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trip_id uuid REFERENCES trips(id),
      vehicle_no text, plaza_name text, amount numeric(12,2), txn_date date,
      txn_datetime timestamptz);
    CREATE TABLE driver_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trip_id uuid REFERENCES trips(id),
      driver_name text, txn_date date, txn_type text, amount numeric(12,2), mode text);
    CREATE TABLE expense_approvals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trip_id uuid REFERENCES trips(id),
      trip_ref text, vehicle_no text, vendor_name text, expense_type text, bill_no text,
      bill_date date, amount numeric(14,2), status text DEFAULT 'PENDING',
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE fleet_cards (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), legacy_id text UNIQUE, name text NOT NULL,
      provider text NOT NULL, card_no_last4 text, vehicle_id uuid REFERENCES vehicles(id),
      vehicle_no text, opening_balance numeric(14,2) NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'ACTIVE', remarks text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  `);
  for (const f of ['002_agent_events.sql', '149_trip_expense_truth.sql',
                   '150_fleet_card_statements.sql', '151_agent_execution_logs.sql']) {
    await db.query(readFileSync(path.join(migrations, f), 'utf8'));
  }

  // The lorry, the account, and a fuel memo the office already entered for the
  // same fill — so the reconciliation has something true to agree with.
  await db.query(`INSERT INTO vehicles (vehicle_no) VALUES ('AS-26-C-7319')`);
  const { rows: [acc] } = await db.query(`
    INSERT INTO fleet_card_accounts (provider, account_no, account_name, operating_company)
    VALUES ('IOCL','1001774381','PRASAD TRANSPORT','Prasad Transport') RETURNING id`);
  await db.query(`
    INSERT INTO fuel_entries (entry_date, vehicle_no, vendor_name, memo_no, liters, amount)
    VALUES ('2026-09-02','AS26C7319','ALAM FUEL STATION','M-991', 200.00, 18544.00)`);

  // A real folder with a real file in it.
  dir = await mkdtemp(path.join(tmpdir(), 'pt-fleetcard-'));
  await writeFile(path.join(dir, 'CustomerTxnReport.csv'), IOCL_CSV, 'utf8');
  // …and something the job must leave alone.
  await writeFile(path.join(dir, 'notes.txt'), 'not a statement', 'utf8');
  await db.query(`
    INSERT INTO fleet_card_sources (account_id, kind, locator, account_no)
    VALUES ($1::uuid, 'FOLDER', $2, '1001774381')`, [acc.id, dir]);

  // The pool is not "connected because a URL exists" — it is connected because
  // initDb() dialled a candidate and one answered. Until then isDegraded() is
  // true and every job politely refuses to run, which is the correct production
  // behaviour and, here, exactly what a test forgetting this looks like.
  const { initDb, isDegraded } = await import('../db/pool.js');
  await initDb({ attempts: 1, quiet: true });
  check('the test database is live', isDegraded(), false);

  console.log('\nTHE NIGHT, END TO END');
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const r1 = await runNightlyFuelSync({ trigger: 'SCHEDULE', log: quiet });
  if (r1.status !== 'OK') console.log('    ↳ run returned:', JSON.stringify(r1));
  check('the run completed', r1.status, 'OK');
  check('one statement was collected', r1.counts.files, 1);
  check('…and the .txt was ignored', r1.counts.files_failed, 0);
  // Four rows in the export; all four are stored, because what the card did is
  // evidence whether or not it was diesel.
  check('every row landed', r1.counts.rows_new, 4);

  const { rows: kinds } = await db.query(`
    SELECT kind, count(*)::int n FROM fleet_card_statement_txns GROUP BY kind ORDER BY kind`);
  check('the wallet settlement is not diesel',
    kinds, [{ kind: 'LOYALTY_AWARD', n: 1 }, { kind: 'OTHER', n: 1 },
            { kind: 'RECHARGE', n: 1 }, { kind: 'SALE', n: 1 }]);

  const { rows: [money] } = await db.query(`
    SELECT COALESCE(sum(amount) FILTER (WHERE kind='SALE' AND unit='INR'),0)::float diesel
      FROM fleet_card_statement_txns`);
  // 18,544 — not 38,544, which is what counting the Sale Completion as fuel
  // would give, and not 33,544, which is what counting loyalty points as
  // rupees would give.
  check('the diesel total is the diesel total', money.diesel, 18544);

  check('the swipe found its memo', r1.counts.matched, 1);
  check('nothing is unaccounted for', r1.counts.unaccounted_amount, 0);
  check('the fortnight is the one being billed', r1.cycle.from, '2026-09-01');
  check('CHHINNAMASTA handed the night on', r1.counts.events, 1);

  const { rows: ev } = await db.query(
    `SELECT event_type, aggregate, emitted_by FROM agent_events ORDER BY id`);
  // emitted_by is NULL on purpose: this event enters the swarm from outside it
  // (the registry lists it under externalOrigins), and CHHINNAMASTA is its
  // consumer, not its author.
  check('…as an event, not a ledger row',
    ev, [{ event_type: 'pump.statement.received', aggregate: 'fleet_card_account',
           emitted_by: null }]);

  const { rows: [health] } = await db.query(
    `SELECT * FROM v_agent_job_health WHERE run_id = $1::uuid`, [r1.run_id]);
  check('the trail records all four stages', health.trail,
    'collect=OK, import=OK, reconcile=OK, handoff=OK');
  check('the run is logged against KAMALA', health.status, 'OK');

  console.log('\nTHE SAME NIGHT, AGAIN');
  const r2 = await runNightlyFuelSync({ trigger: 'SCHEDULE', log: quiet });
  check('the second attempt stands down', r2.skipped, 'already run today');
  const { rows: [n1] } = await db.query(`SELECT count(*)::int n FROM fleet_card_statement_txns`);
  check('and nothing was imported twice', n1.n, 4);

  console.log('\nTOMORROW, WITH THE SAME FILE STILL SITTING THERE');
  // Forced, because the day is claimed — this is a person pressing the button.
  const r3 = await runNightlyFuelSync({ trigger: 'MANUAL', force: true, log: quiet });
  check('the run happens', r3.status, 'OK');
  check('the file is recognised and not re-read', r3.counts.rows_new, 0);
  const { rows: [n2] } = await db.query(`SELECT count(*)::int n FROM fleet_card_statement_txns`);
  check('the row count is unchanged', n2.n, 4);
  const { rows: [b] } = await db.query(
    `SELECT count(*)::int n FROM fleet_card_import_batches`);
  check('and no empty batch was recorded', b.n, 1);

  console.log('\nA FILE THE PARSER CANNOT READ');
  // HPCL DriveTrack, which has no parser yet — the realistic case, since all
  // three providers' downloads land in the same folder.
  await writeFile(path.join(dir, 'HPCL_export.csv'),
    'HPCL DriveTrack Plus - Transaction Statement\n'
    + 'Account: 8901234567    Period: 01-Sep-2026 to 04-Sep-2026\n\n'
    + 'Sr,Date,Outlet,Vehicle,Product,Qty,Rate,Amount,Balance\n'
    + '1,02-Sep-2026,BHARAT FUELS,AS26C7319,HSD,150.00,93.10,13965.00,220145.00\n', 'utf8');
  const r4 = await runNightlyFuelSync({ trigger: 'MANUAL', force: true, log: quiet });
  // The night is reported FAILED because a file was refused — but the good
  // file was still imported and the reconciliation still ran. A bad export must
  // cost its own row, not the whole night.
  check('the night is marked failed', r4.status, 'FAILED');
  check('one file was refused', r4.counts.files_failed, 1);
  check('…and reconciliation still ran', r4.counts.swipes, 1);
  const { rows: [st] } = await db.query(`
    SELECT status, reason FROM agent_execution_logs
     WHERE run_id = $1::uuid AND step = 'reconcile'`, [r4.run_id]);
  check('the reconcile stage is OK even so', st.status, 'OK');

  console.log('\nA SOURCE FOLDER THAT IS NOT THERE');
  await db.query(`
    INSERT INTO fleet_card_sources (account_id, kind, locator, account_no)
    VALUES ($1::uuid, 'FOLDER', $2, '1001774381')`,
    [acc.id, path.join(dir, 'no-such-folder')]);
  const r5 = await runNightlyFuelSync({ trigger: 'MANUAL', force: true, log: quiet });
  const { rows: [col] } = await db.query(`
    SELECT counts, detail FROM agent_execution_logs
     WHERE run_id = $1::uuid AND step = 'collect'`, [r5.run_id]);
  check('the missing folder is reported', Number(col.counts.skipped), 1);
  check('…and the working one still ran', Number(col.counts.files), 2);

  console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
} finally {
  await db.end().catch(() => {});
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  const a2 = new pg.Client({ connectionString: ADMIN });
  await a2.connect();
  await a2.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
  await a2.end();
}
process.exit(failures ? 1 : 0);
