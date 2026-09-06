// server/db/migrations/178_lane_allowance.selftest.mjs
// Proves the lane resolver on a scratch schema: a unique lane answers, an
// AMBIGUOUS consignee answers NOTHING rather than guessing, the depot
// disambiguates it, and the normaliser survives the master's doubled spaces.
//
//   node server/db/migrations/178_lane_allowance.selftest.mjs
//
// A scratch SCHEMA, not a database: the application role has no CREATEDB.
import dotenv from 'dotenv';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
dotenv.config({ path: path.join(repo, '.env') });

const S = process.env.MIGTEST_SCHEMA || 'mig178_test';
const c = new pg.Client({
  host: process.env.PGHOST, port: process.env.PGPORT,
  user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE,
});
await c.connect();
await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S}; SET search_path=${S}, public`);

// The real shapes 178 touches, and the real ambiguity from production:
// LPG BP NORTH GUWAHATI (7B03) runs six lanes, 30 L to 690 L.
await c.query(`CREATE TABLE rtkm_master (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_name text, depot_link text,
  consignee_name text, vehicle_capacity text, item_type text,
  rtkm_distance numeric, fixed_hsd_qty numeric, fixed_cash_amt numeric, toll_amt numeric,
  status text DEFAULT 'ACTIVE');
  CREATE TABLE fuel_entries (id int, rate numeric, amount numeric);`);
await c.query(`INSERT INTO rtkm_master (customer_name, depot_link, consignee_name, rtkm_distance, fixed_hsd_qty, fixed_cash_amt) VALUES
  ('BHARAT PETROLEUM CORPORATION LTD','Numaligarh DU','Agartala AFS',1568,550,10000),
  ('IOCL','Guwahati RC Office','LPG  BP  NORTH  GUWAHATI  (7B03)',300,30,2000),
  ('IOCL','Bongaigaon','LPG  BP  NORTH  GUWAHATI  (7B03)',900,690,10000)`);

const sql = readFileSync(path.join(here, '178_lane_allowance.sql'), 'utf8');
console.log('applying 178…');
await c.query(sql);
console.log('applying 178 again (must be idempotent)…');
await c.query(sql);

let fail = 0;
const ck = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const one = async (s, p) => (await c.query(s, p)).rows[0] ?? null;

console.log('\nlane resolution');
const a = await one(`SELECT * FROM lane_allowance('BHARAT PETROLEUM CORPORATION LTD','Agartala AFS',NULL,NULL,NULL)`);
ck('unique lane -> HSD 550', Number(a?.fixed_hsd_qty), 550);
ck('unique lane -> cash 10000', Number(a?.fixed_cash_amt), 10000);
ck('unique lane -> rtkm 1568', Number(a?.rtkm_distance), 1568);

ck('AMBIGUOUS consignee returns NOTHING (30 L vs 690 L)',
  await one(`SELECT * FROM lane_allowance(NULL,'LPG BP NORTH GUWAHATI (7B03)',NULL,NULL,NULL)`), null);
ck('depot disambiguates -> 690 L',
  Number((await one(`SELECT * FROM lane_allowance('IOCL','LPG BP NORTH GUWAHATI (7B03)','Bongaigaon',NULL,NULL)`))?.fixed_hsd_qty), 690);
ck('other depot -> 30 L',
  Number((await one(`SELECT * FROM lane_allowance('IOCL','LPG BP NORTH GUWAHATI (7B03)','Guwahati RC Office',NULL,NULL)`))?.fixed_hsd_qty), 30);
ck('unknown lane -> NOTHING',
  await one(`SELECT * FROM lane_allowance('IOCL','NO SUCH PLACE',NULL,NULL,NULL)`), null);

console.log('\nnormaliser');
ck('spacing / case / punctuation ignored',
  (await one(`SELECT lane_norm('LPG  BP  NORTH  guwahati  (7B03)') n`)).n,
  (await one(`SELECT lane_norm('lpg bp north GUWAHATI(7b03)') n`)).n);
ck('empty becomes NULL so it cannot match everything',
  (await one(`SELECT lane_norm('   ') n`)).n, null);

console.log('\ndesk visibility');
ck('ambiguous lanes are listed', (await one(`SELECT count(*)::int n FROM v_ambiguous_lanes`)).n, 1);

await c.query(`DROP SCHEMA ${S} CASCADE`);
await c.end();
console.log(fail ? `\n${fail} FAILURE(S)` : '\nALL 178 CHECKS PASSED');
process.exit(fail ? 1 : 0);
