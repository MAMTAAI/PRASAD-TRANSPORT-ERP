// server/db/migrations/152_fleet_card_allocation.selftest.mjs
// ─────────────────────────────────────────────────────────────────────────────
//   MIGTEST_PG=postgres://testu@127.0.0.1:5434/postgres \
//   MIGTEST_SCHEMA=/path/to/prod_schema.sql.gz npm run migrate:selftest152
//
// Loaded against a SCHEMA DUMP OF PRODUCTION, not hand-written stubs. This
// migration touches seven tables it did not create — ledgers, pump_bill_drafts,
// fuel_import_review, trips, fuel_entries, vehicles, fleet_card_* — and a stub
// set is a set of guesses about columns that already exist. A dump cannot
// guess.
//
// The check that earns its keep is the over-allocation guard. Everything else
// here is recoverable by re-running; letting one swipe discharge more credit
// than it carried is money invented, and it is the one thing a UI check cannot
// be trusted with because two clerks on the same swipe is the ordinary case.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ADMIN = process.env.MIGTEST_PG;
const SCHEMA = process.env.MIGTEST_SCHEMA;
if (!ADMIN || !SCHEMA) {
  console.log('\n⏭  MIGTEST_PG / MIGTEST_SCHEMA not set — skipping the migration 152 selftest.\n');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const sql152 = readFileSync(path.join(here, '152_fleet_card_allocation.sql'), 'utf8');
const DB = 'pt_mig152_test';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

/**
 * Split a dump into statements on semicolons — but only the ones that actually
 * end a statement. Four things in this file contain semicolons that do not:
 *
 *   • pg_dump's own headers: `-- Name: trips; Type: TABLE; Schema: public`
 *     — this one shredded the whole dump into 3,744 fragments on the first
 *     attempt, and every fragment failed with a syntax error that looked like
 *     a PostGIS problem.
 *   • plpgsql bodies, written $fn$ … $fn$ and full of statements.
 *   • string literals, including the ones inside COMMENT ON.
 *   • block comments.
 */
function splitSql(sql) {
  const out = [];
  let buf = '';
  let tag = null;           // open dollar-quote tag
  let inLine = false;       // inside a -- comment
  let inBlock = false;      // inside a /* */ comment
  let inStr = false;        // inside a '...' literal

  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];

    if (inLine) { buf += c; if (c === '\n') inLine = false; continue; }
    if (inBlock) { buf += c; if (c === '*' && sql[i + 1] === '/') { buf += '/'; i += 1; inBlock = false; } continue; }
    if (inStr) {
      buf += c;
      // '' is an escaped quote, not the end of the literal.
      if (c === "'") { if (sql[i + 1] === "'") { buf += "'"; i += 1; } else inStr = false; }
      continue;
    }
    if (tag) {
      if (sql.startsWith(tag, i)) { buf += tag; i += tag.length - 1; tag = null; }
      else buf += c;
      continue;
    }

    if (c === '-' && sql[i + 1] === '-') { inLine = true; buf += '--'; i += 1; continue; }
    if (c === '/' && sql[i + 1] === '*') { inBlock = true; buf += '/*'; i += 1; continue; }
    if (c === "'") { inStr = true; buf += c; continue; }
    const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 40));
    if (m) { tag = m[0]; buf += tag; i += tag.length - 1; continue; }
    if (c === ';') { const s = buf.trim(); if (s) out.push(s); buf = ''; continue; }
    buf += c;
  }
  const last = buf.trim();
  if (last) out.push(last);
  // A chunk that is only comment and whitespace is not a statement.
  return out.filter((s) => s.replace(/--[^\n]*\n?/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim());
}

const admin = new pg.Client({ connectionString: ADMIN });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
await admin.query(`CREATE DATABASE ${DB}`);
await admin.end();
const url = ADMIN.replace(/\/[^/]*$/, `/${DB}`);

// psql is unusable in this environment, so the dump is piped in through node.
// pg_dump writes psql META-COMMANDS into the file — \restrict, \unrestrict,
// \connect — which are instructions to the psql client, not SQL, and node
// hands them to the server verbatim ("syntax error at or near \"). They are
// dropped; every one of them is about the client's session, not the schema.
const rawSchema = SCHEMA.endsWith('.gz')
  ? execFileSync('gzip', ['-dc', SCHEMA], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
  : readFileSync(SCHEMA, 'utf8');
//
// The session SET lines go too. Production runs PostgreSQL 18 and this test
// cluster is 16, so the dump carries settings 16 has never heard of
// (transaction_timeout, an 18 parameter). They configure the restoring
// session, not the schema, so dropping them changes nothing that is tested —
// but the version gap is real and worth stating: this migration deliberately
// uses nothing newer than plain SQL and plpgsql, so 16 is a fair proxy. Do not
// add a 17/18-only construct here without also raising the local cluster.
const schemaSql = rawSchema
  .split('\n')
  .filter((l) => !/^\\/.test(l) && !/^SET [a-z_]+ =/i.test(l))
  .join('\n');

const db = new pg.Client({ connectionString: url });
await db.connect();

try {
  console.log('\nPRODUCTION SCHEMA');
  // Loaded one statement at a time, because this box has no PostGIS and
  // production does. The geometry tables cannot be built here and are not
  // wanted — nothing in 152 touches them. Tolerating those failures is only
  // safe because the seven tables 152 DOES depend on are asserted below by
  // name: if one of them failed to build, the test says so instead of quietly
  // testing a smaller schema than production has.
  const stmts = splitSql(schemaSql);
  const failed = [];
  for (const st of stmts) {
    try { await db.query(st); } catch (e) { failed.push({ sql: st.slice(0, 90), msg: e.message }); }
  }
  const NEEDED = ['ledgers', 'trips', 'fuel_entries', 'vehicles',
                  'pump_bill_drafts', 'fuel_import_review',
                  'fleet_card_accounts', 'fleet_card_statement_txns'];
  const { rows: have } = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name = ANY($1)`, [NEEDED]);
  const missing = NEEDED.filter((n) => !have.some((h) => h.table_name === n));
  check('every table 152 depends on was built', missing, []);
  const { rows: [t] } = await db.query(
    `SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`);
  check('the production schema loads', t.n > 100, true);
  console.log(`       (${stmts.length - failed.length}/${stmts.length} statements; `
            + `${failed.length} need PostGIS or depend on something that does)`);
  if (failed.length > stmts.length * 0.2) {
    console.log('       first failures:');
    for (const f of failed.slice(0, 5)) console.log(`         · ${f.msg}
           ${f.sql.replace(/\s+/g,' ')}`);
  }

  // pg_dump blanks the search_path for the restoring session and qualifies
  // every object as public.x. The application connects with an ordinary
  // search_path, so restore it before running a migration written the way the
  // app's migrations are written.
  await db.query(`SET search_path = public`);

  console.log('\nTHE MIGRATION');
  await db.query(sql152);
  check('152 applies', true, true);
  await db.query(sql152);
  check('152 is re-runnable', true, true);

  console.log('\nTHE CLEARING ACCOUNT');
  const { rows: led } = await db.query(
    `SELECT ledger_name, group_head, dr_cr FROM ledgers
      WHERE ledger_name LIKE 'Unallocated Card Payments%' ORDER BY 1`);
  check('two clearing ledgers, one per firm', led.length, 2);
  check('under an existing group head', led[0].group_head, 'Suspense A/c');
  // Re-running must not open a third.
  await db.query(sql152);
  const { rows: [again] } = await db.query(
    `SELECT count(*)::int n FROM ledgers WHERE ledger_name LIKE 'Unallocated Card Payments%'`);
  check('re-running does not open a second wallet', again.n, 2);

  // ── fixtures ────────────────────────────────────────────────────────────
  const { rows: [acc] } = await db.query(`
    INSERT INTO fleet_card_accounts (provider, account_no, account_name, operating_company)
    VALUES ('IOCL','TEST1','T','M/S PRASAD TRANSPORT') RETURNING id`);
  await db.query(`UPDATE fleet_card_accounts SET clearing_ledger =
      'Unallocated Card Payments: Prasad Transport' WHERE id = $1::uuid`, [acc.id]);
  await db.query(`INSERT INTO vehicles (vehicle_no) VALUES ('AS-26-C-7319')`);

  const swipe = async (id, date, qty, amt, veh = 'AS26C7319') => (await db.query(`
    INSERT INTO fleet_card_statement_txns
      (account_id, provider, provider_txn_id, txn_date, kind, direction, vehicle_raw,
       vehicle_no, merchant_name, quantity, rate, amount, unit)
    VALUES ($1::uuid,'IOCL',$2,$3::date,'SALE','DR',$5,
            (SELECT vehicle_no FROM vehicles WHERE reg_key(vehicle_no)=reg_key($5)),
            'ALAM FUEL STATION',$4,92.72,$6,'INR') RETURNING id`,
    [acc.id, id, date, qty, veh, amt])).rows[0].id;

  const memo = async (date, qty, amt) => (await db.query(`
    INSERT INTO fuel_entries (entry_date, vehicle_no, vendor_name, memo_no, liters, amount)
    VALUES ($1::date,'AS26C7319','ALAM FUEL STATION','M-1',$2,$3) RETURNING id`,
    [date, qty, amt])).rows[0].id;

  // ── the auto rule ───────────────────────────────────────────────────────
  console.log('\nWHAT THE MACHINE MAY DO BY ITSELF');
  const tExact = await swipe('T-EXACT', '2026-09-02', 200.000, 18544.00);
  await memo('2026-09-02', 200.000, 18544.00);
  let r = (await db.query(`SELECT * FROM fleet_card_auto_allocate()`)).rows[0];
  check('an exact match allocates itself', Number(r.allocated), 1);

  // Litres equal, rupees not — a rate change, or a different fill.
  const tRate = await swipe('T-RATE', '2026-09-03', 150.000, 13000.00);
  await memo('2026-09-03', 150.000, 13500.00);
  r = (await db.query(`SELECT * FROM fleet_card_auto_allocate()`)).rows[0];
  check('near is not exact — rupees differ, nothing allocated', Number(r.allocated), 0);

  // Two identical fills on the same lorry and day: a person must choose.
  const tA = await swipe('T-AMB-A', '2026-09-05', 100.000, 9272.00);
  const tB = await swipe('T-AMB-B', '2026-09-05', 100.000, 9272.00);
  await memo('2026-09-05', 100.000, 9272.00);
  r = (await db.query(`SELECT * FROM fleet_card_auto_allocate()`)).rows[0];
  check('one memo, two swipes — machine steps back', Number(r.allocated), 0);
  check('…and says so', Number(r.skipped_ambiguous), 2);

  // Running it twice must not double-allocate the one it already did.
  const { rows: [n1] } = await db.query(
    `SELECT count(*)::int n FROM fleet_card_allocations WHERE txn_id = $1::uuid`, [tExact]);
  check('the settled swipe stays settled, once', n1.n, 1);

  // ── the guard ───────────────────────────────────────────────────────────
  console.log('\nA SWIPE CANNOT PAY OUT MORE THAN IT WAS');
  const tBig = await swipe('T-BULK', '2026-07-16', 500.000, 20000.00);
  const { rows: [vend] } = await db.query(
    `INSERT INTO vendors (vendor_name) VALUES ('ALAM') RETURNING id`);
  // One open draft per vendor per period — the schema says so, and it is right:
  // a pump cannot have two live bills for the same fortnight. So each fixture
  // bill gets its own fortnight, which is also how a real settlement looks when
  // one swipe clears more than one period.
  let billNo = 0;
  const bill = async (amt) => {
    const n = billNo++;
    const from = new Date(Date.UTC(2026, 0, 1 + n * 15)).toISOString().slice(0, 10);
    const to = new Date(Date.UTC(2026, 0, 15 + n * 15)).toISOString().slice(0, 10);
    return (await db.query(`
      INSERT INTO pump_bill_drafts (vendor_id, vendor_name, ref_no, period_from, period_to, half,
                                    status, system_amount, physical_amount)
      VALUES ($2::uuid,'ALAM',$3,$4::date,$5::date,'FIRST','DRAFT',$1,$1) RETURNING id`,
      [amt, vend.id, `PB-${n}`, from, to])).rows[0].id;
  };
  const b1 = await bill(15000), b2 = await bill(15000);

  await db.query(`INSERT INTO fleet_card_allocations (txn_id,target_kind,target_id,amount,allocated_by)
                  VALUES ($1::uuid,'PUMP_BILL',$2::uuid,15000,'desk')`, [tBig, b1]);
  check('part of a swipe may settle one bill', true, true);

  let blocked = null;
  try {
    await db.query(`INSERT INTO fleet_card_allocations (txn_id,target_kind,target_id,amount,allocated_by)
                    VALUES ($1::uuid,'PUMP_BILL',$2::uuid,15000,'desk')`, [tBig, b2]);
  } catch (e) { blocked = e.code; }
  check('but 20,000 cannot settle 30,000', blocked, 'P0406');

  await db.query(`INSERT INTO fleet_card_allocations (txn_id,target_kind,target_id,amount,allocated_by)
                  VALUES ($1::uuid,'PUMP_BILL',$2::uuid,5000,'desk')`, [tBig, b2]);
  const { rows: [sum] } = await db.query(
    `SELECT sum(amount)::float s FROM fleet_card_allocations WHERE txn_id=$1::uuid`, [tBig]);
  check('the remainder does fit', sum.s, 20000);
  check('and the swipe leaves the queue',
    (await db.query(`SELECT count(*)::int n FROM v_fleet_card_unallocated WHERE txn_id=$1::uuid`,
      [tBig])).rows[0].n, 0);

  // THE RACE. Two clerks, same swipe, same second — the case a UI check misses.
  const tRace = await swipe('T-RACE', '2026-07-20', 300.000, 10000.00);
  const b3 = await bill(10000), b4 = await bill(10000);
  const c1 = new pg.Client({ connectionString: url });
  const c2 = new pg.Client({ connectionString: url });
  await c1.connect(); await c2.connect();
  await c1.query('BEGIN'); await c2.query('BEGIN');
  await c1.query(`INSERT INTO fleet_card_allocations (txn_id,target_kind,target_id,amount,allocated_by)
                  VALUES ($1::uuid,'PUMP_BILL',$2::uuid,10000,'clerk A')`, [tRace, b3]);
  await c1.query('COMMIT');
  let raced = null;
  try {
    await c2.query(`INSERT INTO fleet_card_allocations (txn_id,target_kind,target_id,amount,allocated_by)
                    VALUES ($1::uuid,'PUMP_BILL',$2::uuid,10000,'clerk B')`, [tRace, b4]);
    await c2.query('COMMIT');
  } catch (e) { raced = e.code; await c2.query('ROLLBACK'); }
  check('the second clerk is refused, not merged', raced, 'P0406');
  const { rows: [rs] } = await db.query(
    `SELECT sum(amount)::float s FROM fleet_card_allocations WHERE txn_id=$1::uuid`, [tRace]);
  check('exactly one allocation survived', rs.s, 10000);
  await c1.end(); await c2.end();

  // The same swipe against the same bill twice, by two people.
  //
  // Tested on a swipe with room left, deliberately. The over-allocation guard
  // is a BEFORE trigger, so on a swipe that is already fully placed it fires
  // first and the unique index never gets a say — which is correct, but means
  // a test using a full swipe proves the wrong thing.
  const tDup = await swipe('T-DUP', '2026-07-22', 100.000, 9000.00);
  const bDup = await bill(4000);
  await db.query(`INSERT INTO fleet_card_allocations (txn_id,target_kind,target_id,amount,allocated_by)
                  VALUES ($1::uuid,'PUMP_BILL',$2::uuid,4000,'clerk A')`, [tDup, bDup]);
  let dup = null;
  try {
    await db.query(`INSERT INTO fleet_card_allocations (txn_id,target_kind,target_id,amount,allocated_by)
                    VALUES ($1::uuid,'PUMP_BILL',$2::uuid,1000,'clerk B')`, [tDup, bDup]);
  } catch (e) { dup = e.code; }
  check('one swipe cannot be put against one bill twice', dup, '23505');

  // ── the queue ───────────────────────────────────────────────────────────
  console.log('\nTHE PENDING MANUAL MATCH QUEUE');
  const { rows: q } = await db.query(
    `SELECT txn_id, reason, unallocated::float FROM v_fleet_card_unallocated ORDER BY txn_date`);
  check('settled swipes are gone from the queue',
    q.some(r => r.txn_id === tExact), false);
  const { rows: [why] } = await db.query(
    `SELECT reason FROM v_fleet_card_unallocated WHERE txn_id = $1::uuid`, [tRate]);
  check('a near miss says it is a near miss', why.reason, 'MEMO_NEARBY_NOT_EXACT');
  const { rows: [amb] } = await db.query(
    `SELECT reason FROM v_fleet_card_unallocated WHERE txn_id = $1::uuid`, [tA]);
  check('a contested exact match says so', amb.reason, 'EXACT_BUT_CONTESTED');

  const noVeh = await swipe('T-NOVEH', '2026-09-06', 80.000, 7400.00, 'JAISWAL ENTERPRISE');
  const { rows: [nv] } = await db.query(
    `SELECT reason FROM v_fleet_card_unallocated WHERE txn_id = $1::uuid`, [noVeh]);
  check('a pooled firm card says NO_VEHICLE', nv.reason, 'NO_VEHICLE');

  // Partial allocation must keep the remainder visible, not the whole swipe.
  const tPart = await swipe('T-PART', '2026-09-07', 200.000, 10000.00);
  await db.query(`INSERT INTO fleet_card_allocations (txn_id,target_kind,target_id,amount,allocated_by)
                  VALUES ($1::uuid,'PUMP_BILL',$2::uuid,4000,'desk')`, [tPart, b1]);
  const { rows: [pt] } = await db.query(
    `SELECT allocated::float a, unallocated::float u FROM v_fleet_card_unallocated WHERE txn_id=$1::uuid`,
    [tPart]);
  check('a part-placed swipe shows only what is left', [pt.a, pt.u], [4000, 6000]);

  console.log('\nTHE CLEARING BALANCE');
  const { rows: [cl] } = await db.query(
    `SELECT clearing_ledger, swipes_waiting::int w, unallocated_amount::float u
       FROM v_fleet_card_clearing`);
  check('clearing is named per firm', cl.clearing_ledger,
    'Unallocated Card Payments: Prasad Transport');
  check('and carries what is still unplaced', cl.u > 0, true);

  console.log('\nWRITE-OFF');
  const tWo = await swipe('T-WO', '2026-09-08', 50.000, 4600.00);
  await db.query(`INSERT INTO fleet_card_allocations (txn_id,target_kind,target_id,amount,allocated_by,note)
                  VALUES ($1::uuid,'WRITE_OFF',NULL,4600,'desk','not our lorry')`, [tWo]);
  check('a write-off needs no target',
    (await db.query(`SELECT count(*)::int n FROM v_fleet_card_unallocated WHERE txn_id=$1::uuid`,
      [tWo])).rows[0].n, 0);
  let badWo = null;
  try {
    // Again on a swipe with room, so the CHECK is what refuses it.
    await db.query(`INSERT INTO fleet_card_allocations (txn_id,target_kind,target_id,amount)
                    VALUES ($1::uuid,'PUMP_BILL',NULL,100)`, [tDup]);
  } catch (e) { badWo = e.code; }
  check('but everything else must point at something', badWo, '23514');

  console.log('\nWHAT IT WAS PUT AGAINST, IN WORDS');
  const { rows: lbl } = await db.query(
    `SELECT target_kind, target_label FROM v_fleet_card_allocation_detail
      WHERE txn_id = $1::uuid`, [tBig]);
  check('a bill allocation reads as a bill',
    /^ALAM · \d{2} \w{3}–\d{2} \w{3} 2026$/.test(lbl[0].target_label ?? ''), true);

  console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
} finally {
  await db.end().catch(() => {});
  const a2 = new pg.Client({ connectionString: ADMIN });
  await a2.connect();
  await a2.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
  await a2.end();
}
process.exit(failures ? 1 : 0);
