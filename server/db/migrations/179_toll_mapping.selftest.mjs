// server/db/migrations/179_toll_mapping.selftest.mjs
// Proves on a scratch schema: the unspaced registration links, the matcher uses
// the exact timestamp, two overlapping trips are refused as AMBIGUOUS rather
// than guessed, a CLOSED trip is never mapped into, and the duplicate lock
// still refuses a repeated ext_txn_id.
//
//   node server/db/migrations/179_toll_mapping.selftest.mjs
import dotenv from 'dotenv';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../..', '.env') });

const S = process.env.MIGTEST_SCHEMA || 'mig179_test';
const c = new pg.Client({
  host: process.env.PGHOST, port: process.env.PGPORT,
  user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE,
});
await c.connect();
await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S}; SET search_path=${S}, public`);

// reg_key lives in migration 149 on the real database; the scratch schema needs
// its own copy so the resolution order finds it.
await c.query(`CREATE FUNCTION ${S}.reg_key(t text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $f$ SELECT NULLIF(regexp_replace(upper(coalesce(t,'')), '[^A-Z0-9]', '', 'g'), '') $f$;`);

await c.query(`
  CREATE TABLE vehicles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), vehicle_no text);
  CREATE TABLE trips (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), vehicle_id uuid, trip_code text,
    loading_date date, unloading_date date, status text);
  CREATE TABLE toll_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ext_txn_id text,
    vehicle_id uuid, vehicle_no text, trip_id uuid,
    txn_datetime timestamptz, txn_date date, amount numeric(12,2), plaza_name text,
    provider text);
  CREATE UNIQUE INDEX toll_txn_ext_uniq ON toll_transactions (ext_txn_id) WHERE ext_txn_id IS NOT NULL;
  CREATE UNIQUE INDEX uq_toll_ext_txn  ON toll_transactions (ext_txn_id) WHERE ext_txn_id IS NOT NULL;`);

await c.query(`INSERT INTO vehicles (vehicle_no) VALUES ('AS 26C 5107'), ('AS 26C 9803')`);
const veh = (n) => c.query(`SELECT id FROM vehicles WHERE vehicle_no=$1`, [n]).then((r) => r.rows[0].id);
const V1 = await veh('AS 26C 5107');
const V2 = await veh('AS 26C 9803');

await c.query(`INSERT INTO trips (vehicle_id, trip_code, loading_date, unloading_date, status) VALUES
  ($1,'OPEN-1','2026-09-01', NULL,        'IN_TRANSIT'),
  ($1,'OVERLAP','2026-09-02', NULL,       'IN_TRANSIT'),
  ($2,'CLOSED-1','2026-08-01','2026-08-05','COMPLETED')`, [V1, V2]);

// unspaced registration — the production defect
await c.query(`INSERT INTO toll_transactions (ext_txn_id, vehicle_no, txn_datetime, amount, plaza_name) VALUES
  ('T-AMBIG','AS26C5107','2026-09-03 10:00+05:30', 385, 'Plaza A'),
  ('T-CLOSED','AS26C9803','2026-08-03 10:00+05:30', 430, 'Plaza B'),
  ('T-ORPHAN','AS26C9803','2026-07-01 10:00+05:30', 275, 'Plaza C')`);

const sql = readFileSync(path.join(here, '179_toll_mapping.sql'), 'utf8');
console.log('applying 179…');
await c.query(sql);
console.log('applying 179 again (must be idempotent)…');
await c.query(sql);

let fail = 0;
const ck = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const one = async (s, p) => (await c.query(s, p)).rows[0] ?? null;

console.log('\nlinking the lorry (the 2,870-row defect)');
ck('unspaced AS26C5107 links to AS 26C 5107',
  (await one(`SELECT vehicle_id FROM toll_transactions WHERE ext_txn_id='T-AMBIG'`)).vehicle_id, V1);
ck('every row is now linked',
  (await one(`SELECT count(*)::int n FROM toll_transactions WHERE vehicle_id IS NULL`)).n, 0);

console.log('\nthe matcher refuses to guess');
const amb = await one(`SELECT trip_id, map_status, map_candidates FROM toll_transactions WHERE ext_txn_id='T-AMBIG'`);
ck('two overlapping trips -> AMBIGUOUS', amb.map_status, 'AMBIGUOUS');
ck('  and NOT mapped to either', amb.trip_id, null);
ck('  and the desk is told how many', amb.map_candidates, 2);

console.log("\nowner's rule: never map into a closed trip");
const closed = await one(`SELECT trip_id, map_status, map_candidates FROM toll_transactions WHERE ext_txn_id='T-CLOSED'`);
ck('exactly one trip covers it', closed.map_candidates, 1);
ck('  but it is COMPLETED -> left unmapped', closed.trip_id, null);
ck('  labelled, not silently missed', closed.map_status, 'ORPHAN');

console.log('\nidle movement');
const orph = await one(`SELECT trip_id, map_status, map_candidates FROM toll_transactions WHERE ext_txn_id='T-ORPHAN'`);
ck('no trip covers it -> ORPHAN', orph.map_status, 'ORPHAN');
ck('  zero candidates', orph.map_candidates, 0);

console.log('\nexact-timestamp window');
ck('a moment INSIDE an open trip resolves to it',
  (await one(`SELECT trip_id FROM toll_match_trip($1,'2026-09-01 12:00+05:30')`, [V2 === V1 ? V1 : V1])).trip_id !== null, true);
ck('a moment BEFORE any trip resolves to nothing',
  (await one(`SELECT trip_id, candidates FROM toll_match_trip($1,'2026-01-01 12:00+05:30')`, [V1])).trip_id, null);
ck('a closed trip stops at unloading_date + 1 day, not +15',
  (await one(`SELECT candidates FROM toll_match_trip($1,'2026-08-20 12:00+05:30')`, [V2])).candidates, 0);

console.log('\nthe duplicate lock');
ck('the redundant twin index is gone',
  (await one(`SELECT count(*)::int n FROM pg_indexes WHERE schemaname=$1 AND indexname='uq_toll_ext_txn'`, [S])).n, 0);
let dup = false;
try { await c.query(`INSERT INTO toll_transactions (ext_txn_id, vehicle_no, amount) VALUES ('T-AMBIG','X',1)`); }
catch { dup = true; }
ck('a repeated ext_txn_id is still refused', dup, true);

console.log('\nthe desk view');
ck('v_toll_unmapped lists all three unmapped rows',
  (await one(`SELECT count(*)::int n FROM v_toll_unmapped`)).n, 3);

await c.query(`DROP SCHEMA ${S} CASCADE`);
await c.end();
console.log(fail ? `\n${fail} FAILURE(S)` : '\nALL 179 CHECKS PASSED');
process.exit(fail ? 1 : 0);
