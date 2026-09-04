// server/db/migrations/148_toll_plaza_master.selftest.mjs
// ─────────────────────────────────────────────────────────────────────────────
//   node server/db/migrations/148_toll_plaza_master.selftest.mjs
//
// Runs migration 148 against a THROWAWAY database and checks what it actually
// does — not that the file parses, but that a plaza learns the right rate, that
// a rate a person typed survives the next FASTag sync, and that a bulk import
// does not relearn one gate four hundred times.
//
// WHY THIS EXISTS. A migration is the one kind of change that cannot be rolled
// back by reverting a commit, and this one carries an AFTER trigger on
// toll_transactions — a table the provider sync and the statement import both
// write to in batches of thousands. A mistake here does not show up as a bad
// screen; it shows up as a wrong rupee figure, or an import that takes twenty
// minutes, weeks later.
//
// CONNECTION: set MIGTEST_PG to a superuser-ish URL on a database you do not
// mind losing. It CREATEs and DROPs a database named pt_mig148_test.
//
//   MIGTEST_PG=postgres://testu@127.0.0.1:5433/postgres node server/db/migrations/148_toll_plaza_master.selftest.mjs
//
// Without MIGTEST_PG it skips with exit 0, so it never breaks a machine that
// has no spare PostgreSQL.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ADMIN = process.env.MIGTEST_PG;
if (!ADMIN) {
  console.log('\n⏭  MIGTEST_PG not set — skipping the migration 148 selftest.');
  console.log('   MIGTEST_PG=postgres://user@host:port/postgres node server/db/migrations/148_toll_plaza_master.selftest.mjs\n');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(path.join(here, '148_toll_plaza_master.sql'), 'utf8');
const DB = 'pt_mig148_test';

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
  // ── Just enough schema for 148 to have something to bite on ──────────────
  // Deliberately NOT the whole ERP: the migration must depend only on what it
  // says it depends on, and importing 147 other files would hide it if it
  // quietly needed something else.
  await db.query(`
    CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

    CREATE TABLE toll_transactions (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      vehicle_no text NOT NULL DEFAULT 'AS 26C 9804',
      amount     numeric(12,2) NOT NULL DEFAULT 0,
      plaza_name text,
      lat        numeric(10,7),
      lng        numeric(10,7),
      txn_date   date
    );

    CREATE TABLE trips (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trip_code text
    );
  `);

  // Real-shaped history: one gate crossed many times at 165, spelled three
  // ways, plus a second gate and one row with no coordinates.
  await db.query(`
    INSERT INTO toll_transactions (amount, plaza_name, lat, lng, txn_date) VALUES
      (165, 'Barapani Toll Plaza',  25.7500000, 91.8800000, '2026-06-01'),
      (165, 'BARAPANI TOLLPLAZA',   25.7500100, 91.8800100, '2026-06-08'),
      (165, 'barapani  toll plaza', 25.7500000, 91.8800000, '2026-06-15'),
      (180, 'Barapani Toll Plaza',  25.7500000, 91.8800000, '2026-07-01'),
      (210, 'Jorhat Toll Plaza',    26.7400000, 94.2100000, '2026-06-20'),
      (210, 'Jorhat Toll Plaza',    26.7400000, 94.2100000, '2026-07-20'),
      (95,  'No Coords Plaza',      NULL,       NULL,       '2026-07-02')
  `);

  console.log('\nTHE MIGRATION ITSELF');
  await db.query(SQL);
  check('applies without error', true, true);

  console.log('\nTHREE SPELLINGS ARE ONE GATE');
  const { rows: keys } = await db.query(
    `SELECT plaza_name, observations, rate::float8 AS rate, lat::float8 AS lat
       FROM toll_plazas ORDER BY plaza_name`);
  check('one row per gate, not per spelling', keys.length, 3);
  const barapani = keys.find((r) => /barapani/i.test(r.plaza_name));
  check('all four Barapani crossings counted together', barapani.observations, 4);
  check('the display name is the commonest spelling', barapani.plaza_name, 'Barapani Toll Plaza');

  console.log('\nTHE RATE IS A REAL AMOUNT, NOT AN AVERAGE');
  // 165,165,165,180 — the median must be 165, an amount actually charged.
  // percentile_cont would answer 165 here too, but on 65/70 it would answer
  // 67.5, which no gate has ever taken. This asserts the discrete choice.
  check('median of 165,165,165,180 is 165', barapani.rate, 165);
  const { rows: [odd] } = await db.query(
    `SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY x)::float8 AS d,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY x)::float8 AS c
       FROM (VALUES (65::numeric), (70::numeric)) v(x)`);
  check('and disc never invents a price cont would', [odd.d, odd.c], [65, 67.5]);

  console.log('\nA PLAZA WITH NO COORDINATES IS KEPT, BUT NOT PLACED');
  const nocoord = keys.find((r) => /no coords/i.test(r.plaza_name));
  check('it is in the master', !!nocoord, true);
  check('with no point to draw', nocoord.lat, null);
  const { rows: [located] } = await db.query(
    `SELECT count(*)::int AS n FROM toll_plazas WHERE lat IS NOT NULL AND lng IS NOT NULL`);
  check('so the map only ever sees the placeable ones', located.n, 2);

  console.log('\nAUTO-ADD: A NEW CROSSING TEACHES A NEW GATE');
  await db.query(`INSERT INTO toll_transactions (amount, plaza_name, lat, lng, txn_date)
                  VALUES (140, 'Sonapur Toll Plaza', 26.1200000, 91.9700000, '2026-08-01')`);
  const { rows: [sonapur] } = await db.query(
    `SELECT rate::float8 AS rate, observations, rate_source FROM toll_plazas WHERE name_key = 'SONAPURTOLLPLAZA'`);
  check('the gate appeared on its own', [sonapur.rate, sonapur.observations], [140, 1]);
  check('and is marked as learned, not typed', sonapur.rate_source, 'FASTAG_HISTORY');

  console.log('\nA HUMAN OUTRANKS THE MEDIAN');
  await db.query(`UPDATE toll_plazas SET rate = 250, rate_source = 'MANUAL', verified_by = 'office'
                   WHERE name_key = 'SONAPURTOLLPLAZA'`);
  await db.query(`INSERT INTO toll_transactions (amount, plaza_name, lat, lng, txn_date)
                  VALUES (140, 'Sonapur Toll Plaza', 26.1200000, 91.9700000, '2026-08-09')`);
  const { rows: [afterSync] } = await db.query(
    `SELECT rate::float8 AS rate, rate_source, observations FROM toll_plazas WHERE name_key = 'SONAPURTOLLPLAZA'`);
  check('a later sync does NOT overwrite the typed rate', [afterSync.rate, afterSync.rate_source], [250, 'MANUAL']);
  check('but the evidence count still moves', afterSync.observations, 2);

  console.log('\nCOORDINATES ARE NEVER BLANKED BY A ROW THAT LACKS THEM');
  await db.query(`INSERT INTO toll_transactions (amount, plaza_name, lat, lng, txn_date)
                  VALUES (210, 'Jorhat Toll Plaza', NULL, NULL, '2026-08-15')`);
  const { rows: [jorhat] } = await db.query(
    `SELECT lat::float8 AS lat, lng::float8 AS lng FROM toll_plazas WHERE name_key = 'JORHATTOLLPLAZA'`);
  check('the gate keeps the point it already had', [jorhat.lat, jorhat.lng], [26.74, 94.21]);

  console.log('\nA CORRECTED SPELLING MOVES THE CROSSING BETWEEN GATES');
  await db.query(`UPDATE toll_transactions SET plaza_name = 'Barapani Toll Plaza'
                   WHERE plaza_name = 'No Coords Plaza'`);
  const { rows: [moved] } = await db.query(
    `SELECT observations FROM toll_plazas WHERE name_key = 'NOCOORDSPLAZA'`);
  check('the gate it left drops the crossing', moved.observations, 0);
  const { rows: [gained] } = await db.query(
    `SELECT observations FROM toll_plazas WHERE name_key = 'BARAPANITOLLPLAZA'`);
  check('and the gate it joined gains it', gained.observations, 5);

  console.log('\nA BULK IMPORT IS ONE PASS, NOT ONE PER ROW');
  // The statement import accepts 20,000 rows. A per-row trigger would recompute
  // a plaza's median once per row. This inserts 2,000 crossings over 4 gates in
  // ONE statement and insists it stays fast — if this ever fails, somebody has
  // turned the statement trigger back into a row trigger.
  const t0 = Date.now();
  await db.query(`
    INSERT INTO toll_transactions (amount, plaza_name, lat, lng, txn_date)
    SELECT 100 + (i % 4) * 10,
           'Bulk Gate ' || (i % 4),
           26.0 + (i % 4) * 0.01,
           92.0 + (i % 4) * 0.01,
           '2026-08-20'
      FROM generate_series(1, 2000) i`);
  const ms = Date.now() - t0;
  console.log(`       (2,000 rows across 4 gates in ${ms} ms)`);
  check('2,000 rows import in under 10s', ms < 10_000, true);
  const { rows: [bulk] } = await db.query(
    `SELECT count(*)::int AS n FROM toll_plazas WHERE plaza_name LIKE 'Bulk Gate%'`);
  check('and produce exactly four gates', bulk.n, 4);

  console.log('\nROUND TRIP OR ONE SIDE, ON THE TRIP');
  await db.query(`INSERT INTO trips (trip_code) VALUES ('PT00743')`);
  const { rows: [dflt] } = await db.query(`SELECT trip_leg_kind FROM trips WHERE trip_code = 'PT00743'`);
  check('existing trips are untouched — NULL means derive', dflt.trip_leg_kind, null);
  await db.query(`UPDATE trips SET trip_leg_kind = 'ONE_WAY' WHERE trip_code = 'PT00743'`);
  const { rows: [set] } = await db.query(`SELECT trip_leg_kind FROM trips WHERE trip_code = 'PT00743'`);
  check('and it accepts the two real values', set.trip_leg_kind, 'ONE_WAY');
  let refused = false;
  try { await db.query(`UPDATE trips SET trip_leg_kind = 'SOMETIMES' WHERE trip_code = 'PT00743'`); }
  catch { refused = true; }
  check('anything else is refused by the database', refused, true);

  console.log('\nRE-RUNNABLE');
  // Migrations get re-applied by hand more often than anyone admits, and this
  // one both creates objects and seeds rows. Counted rather than hardcoded, so
  // adding a case above does not make this fail for the wrong reason.
  const { rows: [before] } = await db.query(
    `SELECT count(*)::int AS n, COALESCE(sum(observations), 0)::int AS obs FROM toll_plazas`);
  await db.query(SQL);
  const { rows: [after] } = await db.query(
    `SELECT count(*)::int AS n, COALESCE(sum(observations), 0)::int AS obs FROM toll_plazas`);
  check('applying it twice changes nothing', [after.n, after.obs], [before.n, before.obs]);
  const { rows: [manualKept] } = await db.query(
    `SELECT rate::float8 AS rate, rate_source FROM toll_plazas WHERE name_key = 'SONAPURTOLLPLAZA'`);
  check('and the hand-typed rate survives a re-run', [manualKept.rate, manualKept.rate_source], [250, 'MANUAL']);
} catch (err) {
  failures += 1;
  console.log(`\n  FAIL  migration threw: ${err.message}`);
  if (err.position) console.log(`        at character ${err.position}`);
} finally {
  await db.end();
  const cleanup = new pg.Client({ connectionString: ADMIN });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE IF EXISTS ${DB}`);
  await cleanup.end();
}

console.log(failures ? `\n❌ ${failures} failed\n` : '\n✅ all passed\n');
process.exit(failures ? 1 : 0);
