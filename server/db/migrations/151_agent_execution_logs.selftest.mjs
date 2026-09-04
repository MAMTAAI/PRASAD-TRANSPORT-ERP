// server/db/migrations/151_agent_execution_logs.selftest.mjs
// ─────────────────────────────────────────────────────────────────────────────
//   MIGTEST_PG=postgres://testu@127.0.0.1:5433/postgres npm run migrate:selftest151
//
// The one thing worth testing here is the restart guard. Everything else in the
// nightly chain is recoverable — a failed import is re-read tomorrow, a missed
// event can be re-emitted. A double run is not: it is a second import of the
// same fortnight, running while the first is still writing.
//
// The guard is a partial unique index, so it is tested the way it will actually
// be attacked: two runs racing in two concurrent transactions, which is exactly
// what a pm2 restart at 02:00 produces. A guard held in a JavaScript variable
// would pass a single-process test and fail that.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ADMIN = process.env.MIGTEST_PG;
if (!ADMIN) {
  console.log('\n⏭  MIGTEST_PG not set — skipping the migration 151 selftest.\n');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const sql149 = readFileSync(path.join(here, '149_trip_expense_truth.sql'), 'utf8');
const sql150 = readFileSync(path.join(here, '150_fleet_card_statements.sql'), 'utf8');
const sql151 = readFileSync(path.join(here, '151_agent_execution_logs.sql'), 'utf8');
const DB = 'pt_mig151_test';

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
const url = ADMIN.replace(/\/[^/]*$/, `/${DB}`);
const db = new pg.Client({ connectionString: url });
await db.connect();

try {
  // Only what 149–151 touch.
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

  console.log('\nTHE MIGRATIONS');
  await db.query(sql149);
  await db.query(sql150);
  await db.query(sql151);
  check('149–151 apply together', true, true);
  // Re-running a migration is normal here: the deploy applies the whole folder.
  await db.query(sql151);
  check('151 is re-runnable', true, true);

  // ── the restart guard ────────────────────────────────────────────────────
  console.log('\nONE SCHEDULED RUN PER DAY');
  const startRun = (client, trigger, day = '2026-09-05') => client.query(`
    INSERT INTO agent_execution_logs (run_id, job, agent_id, agent_code, detail, run_date)
    VALUES (gen_random_uuid(), 'nightly_fuel_sync', 'AGENT_00', 'KAMALA',
            jsonb_build_object('trigger', $1::text), $2::date)
    ON CONFLICT DO NOTHING RETURNING run_id`, [trigger, day]);

  const first = await startRun(db, 'SCHEDULE');
  check('the first 02:00 run claims the day', first.rows.length, 1);

  const second = await startRun(db, 'SCHEDULE');
  check('a second 02:00 run is refused', second.rows.length, 0);

  // THE ONE THAT NEARLY SHIPPED WRONG. The catch-up tick is a different
  // trigger word from the cron, and an index keyed on 'SCHEDULE' would let it
  // through — re-importing the fortnight fifteen minutes after the real run.
  const catchup = await startRun(db, 'CATCHUP');
  check('the catch-up tick is refused once the cron has run', catchup.rows.length, 0);

  const manual = await startRun(db, 'MANUAL');
  check('a person may still force a run by hand', manual.rows.length, 1);

  const tomorrow = await startRun(db, 'SCHEDULE', '2026-09-06');
  check('tomorrow is a new day', tomorrow.rows.length, 1);

  // THE RACE THAT ACTUALLY HAPPENS. Two processes, both awake at 02:00:00,
  // both inside a transaction. The second must block on the index and then
  // find the day taken — not insert a duplicate.
  console.log('\nTWO PROCESSES, THE SAME SECOND');
  const a = new pg.Client({ connectionString: url });
  const b = new pg.Client({ connectionString: url });
  await a.connect(); await b.connect();
  await a.query('BEGIN'); await b.query('BEGIN');
  const ra = await startRun(a, 'SCHEDULE', '2026-09-07');
  const rbPromise = startRun(b, 'SCHEDULE', '2026-09-07');   // blocks on the index
  await a.query('COMMIT');
  const rb = await rbPromise;
  await b.query('COMMIT');
  check('process A claimed the night', ra.rows.length, 1);
  check('process B stood down', rb.rows.length, 0);
  const { rows: cnt } = await db.query(`
    SELECT count(*)::int n FROM agent_execution_logs
     WHERE run_date = '2026-09-07' AND step IS NULL
       AND COALESCE(detail->>'trigger','SCHEDULE') <> 'MANUAL'`);
  check('exactly one scheduled run exists for that night', cnt[0].n, 1);
  await a.end(); await b.end();

  // ── the trail ────────────────────────────────────────────────────────────
  console.log('\nTHE NIGHT AS ONE STORY');
  const runId = first.rows[0].run_id;
  for (const [step, agent, code, status] of [
    ['collect',   'AGENT_04', 'BHUVANESHWARI', 'OK'],
    ['import',    'AGENT_06', 'CHHINNAMASTA',  'OK'],
    ['reconcile', 'AGENT_06', 'CHHINNAMASTA',  'OK'],
    ['handoff',   'AGENT_06', 'CHHINNAMASTA',  'SKIPPED'],
  ]) {
    await db.query(`
      INSERT INTO agent_execution_logs
        (run_id, job, step, agent_id, agent_code, status, run_date, finished_at, duration_ms)
      VALUES ($1::uuid,'nightly_fuel_sync',$2,$3,$4,$5,'2026-09-05', now(), 120)`,
      [runId, step, agent, code, status]);
  }
  await db.query(`
    UPDATE agent_execution_logs SET status='OK', finished_at=now(), duration_ms=900,
           counts = '{"files":2,"rows_new":44}'::jsonb
     WHERE run_id = $1::uuid AND step IS NULL`, [runId]);

  const { rows: h } = await db.query(
    `SELECT * FROM v_agent_job_health WHERE run_id = $1::uuid`, [runId]);
  check('the health view shows one row for the run', h.length, 1);
  check('with its four stages', Number(h[0].steps), 4);
  check('none of them failed', Number(h[0].steps_failed), 0);
  check('and the trail reads in order', h[0].trail,
    'collect=OK, import=OK, reconcile=OK, handoff=SKIPPED');
  check('the counts survive', h[0].counts, { files: 2, rows_new: 44 });
  check('the trigger is recorded', h[0].trigger, 'SCHEDULE');

  // A stage row must never be mistaken for a run.
  const { rows: onlyRuns } = await db.query(
    `SELECT count(*)::int n FROM v_agent_job_health WHERE run_id = $1::uuid`, [runId]);
  check('stages do not appear as runs', onlyRuns[0].n, 1);

  // ── the hung run ─────────────────────────────────────────────────────────
  console.log('\nA RUN THE PROCESS DIED INSIDE');
  await db.query(`
    INSERT INTO agent_execution_logs (run_id, job, agent_id, agent_code, status, detail, run_date, started_at)
    VALUES (gen_random_uuid(), 'nightly_fuel_sync', 'AGENT_00', 'KAMALA', 'RUNNING',
            '{"trigger":"SCHEDULE"}'::jsonb, '2026-09-08', now() - interval '6 hours')`);
  const { rowCount: reaped } = await db.query(`
    UPDATE agent_execution_logs
       SET status='FAILED', finished_at=now(),
           error = COALESCE(error, 'process ended before the run finished')
     WHERE job = 'nightly_fuel_sync' AND status = 'RUNNING'
       AND started_at < now() - make_interval(mins => 180)`);
  check('the stale run is closed, not left RUNNING forever', reaped, 1);
  // …and the day it claimed stays claimed, so a reap is not a licence to
  // re-import. Only a MANUAL force re-runs a night that already happened.
  const again = await startRun(db, 'SCHEDULE', '2026-09-08');
  check('reaping does not reopen the night', again.rows.length, 0);
  check('…but a person still can', (await startRun(db, 'MANUAL', '2026-09-08')).rows.length, 1);

  // ── the same file, twice ─────────────────────────────────────────────────
  console.log('\nTHE SAME DOWNLOAD, STILL IN THE FOLDER TOMORROW');
  const { rows: [acc] } = await db.query(`
    INSERT INTO fleet_card_accounts (provider, account_no, account_name, operating_company)
    VALUES ('IOCL','1234567890','TEST','Prasad Transport') RETURNING id`);
  const batch = (sha) => db.query(`
    INSERT INTO fleet_card_import_batches (account_id, provider, source_file, rows_read, content_sha)
    VALUES ($1::uuid,'IOCL','export.csv',10,$2)
    ON CONFLICT DO NOTHING RETURNING id`, [acc.id, sha]);
  check('the file imports once', (await batch('abc123')).rows.length, 1);
  check('and is refused the second night', (await batch('abc123')).rows.length, 0);
  check('a different export still imports', (await batch('def456')).rows.length, 1);
  // A hand upload with no hash must not be blocked by the partial index.
  check('an un-hashed upload is unaffected', (await batch(null)).rows.length, 1);
  check('…and so is a second one', (await batch(null)).rows.length, 1);

  // ── sources ──────────────────────────────────────────────────────────────
  console.log('\nWHERE THE JOB LOOKS');
  await db.query(`
    INSERT INTO fleet_card_sources (account_id, kind, locator, account_no)
    VALUES ($1::uuid, 'FOLDER', 'C:/statements/iocl', '1234567890')`, [acc.id]);
  const { rows: src } = await db.query(`SELECT * FROM fleet_card_sources`);
  check('a folder source is stored', src.length, 1);
  check('with the default glob', src[0].file_glob, '*.csv');
  check('and is active', src[0].active, true);
  let rejected = null;
  try {
    await db.query(`INSERT INTO fleet_card_sources (kind, locator) VALUES ('PORTAL','x')`);
  } catch (e) { rejected = e.code; }
  // 23514 = check_violation. There is no PORTAL kind, deliberately: this job
  // does not log into anything.
  check('there is no PORTAL source kind', rejected, '23514');

  console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
} finally {
  await db.end();
  const a2 = new pg.Client({ connectionString: ADMIN });
  await a2.connect();
  await a2.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
  await a2.end();
}
process.exit(failures ? 1 : 0);
