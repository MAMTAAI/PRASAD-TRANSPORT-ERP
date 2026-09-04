// server/db/migrations/153_pump_bill_settlement.selftest.mjs
// ─────────────────────────────────────────────────────────────────────────────
//   MIGTEST_PG=postgres://testu@127.0.0.1:5434/postgres \
//   MIGTEST_SCHEMA=/path/to/prod_schema.sql.gz npm run migrate:selftest153
//
// fleet_card_settle_cycle() applies many swipes to one pump's fortnightly bill
// in a loop. Two things about it have to be true or money goes wrong:
//
//   1. it stops AT the outstanding, not past it — the last swipe is applied in
//      part, and the remainder stays in clearing;
//   2. a dry run writes nothing at all.
//
// Both are tested against the real production schema, and so is pump_key on the
// actual pairs of names this firm has: "BN FILLING STATION BHARAT PETROLEUM
// DEALERS" on the card, "B N FILLING STATION" on the bill.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ADMIN = process.env.MIGTEST_PG;
const SCHEMA = process.env.MIGTEST_SCHEMA;
if (!ADMIN || !SCHEMA) {
  console.log('\n⏭  MIGTEST_PG / MIGTEST_SCHEMA not set — skipping the migration 153 selftest.\n');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const sql152 = readFileSync(path.join(here, '152_fleet_card_allocation.sql'), 'utf8');
const sql153 = readFileSync(path.join(here, '153_pump_bill_settlement.sql'), 'utf8');
const DB = 'pt_mig153_test';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

/** Same splitter as 152 — pg_dump's own headers carry semicolons. */
function splitSql(sql) {
  const out = []; let buf = ''; let tag = null;
  let inLine = false, inBlock = false, inStr = false;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (inLine) { buf += c; if (c === '\n') inLine = false; continue; }
    if (inBlock) { buf += c; if (c === '*' && sql[i + 1] === '/') { buf += '/'; i += 1; inBlock = false; } continue; }
    if (inStr) { buf += c; if (c === "'") { if (sql[i + 1] === "'") { buf += "'"; i += 1; } else inStr = false; } continue; }
    if (tag) { if (sql.startsWith(tag, i)) { buf += tag; i += tag.length - 1; tag = null; } else buf += c; continue; }
    if (c === '-' && sql[i + 1] === '-') { inLine = true; buf += '--'; i += 1; continue; }
    if (c === '/' && sql[i + 1] === '*') { inBlock = true; buf += '/*'; i += 1; continue; }
    if (c === "'") { inStr = true; buf += c; continue; }
    const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 40));
    if (m) { tag = m[0]; buf += tag; i += tag.length - 1; continue; }
    if (c === ';') { const s = buf.trim(); if (s) out.push(s); buf = ''; continue; }
    buf += c;
  }
  const last = buf.trim(); if (last) out.push(last);
  return out.filter((s) => s.replace(/--[^\n]*\n?/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim());
}

const admin = new pg.Client({ connectionString: ADMIN });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
await admin.query(`CREATE DATABASE ${DB}`);
await admin.end();
const url = ADMIN.replace(/\/[^/]*$/, `/${DB}`);

const raw = SCHEMA.endsWith('.gz')
  ? execFileSync('gzip', ['-dc', SCHEMA], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
  : readFileSync(SCHEMA, 'utf8');
const schemaSql = raw.split('\n')
  .filter((l) => !/^\\/.test(l) && !/^SET [a-z_]+ =/i.test(l)).join('\n');

const db = new pg.Client({ connectionString: url });
await db.connect();

try {
  console.log('\nPRODUCTION SCHEMA');
  for (const st of splitSql(schemaSql)) { try { await db.query(st); } catch { /* PostGIS */ } }
  await db.query('SET search_path = public');
  const NEEDED = ['pump_bill_drafts', 'fleet_card_statement_txns', 'fleet_card_accounts',
                  'fuel_entries', 'vehicles', 'vendors', 'ledgers', 'account_groups'];
  const { rows: have } = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name = ANY($1)`, [NEEDED]);
  check('every table 153 depends on was built',
    NEEDED.filter((n) => !have.some((h) => h.table_name === n)), []);

  await db.query(sql152);
  await db.query(sql153);
  check('152 + 153 apply together', true, true);
  await db.query(sql153);
  check('153 is re-runnable', true, true);

  // ── pump_key, on the real pairs ──────────────────────────────────────────
  console.log('\nONE PUMP, TWO SPELLINGS');
  const same = async (a, b) => (await db.query(
    `SELECT pump_key($1) = pump_key($2) AS same`, [a, b])).rows[0].same;
  check('BPCL dealer tag is not part of the name',
    await same('BN FILLING STATION BHARAT PETROLEUM DEALERS', 'B N FILLING STATION'), true);
  check('hyphens are not part of the name',
    await same('JOHN-N-WELL SERVICE STATION', 'JOHN N WELL SERVICE STATION'), true);
  check('PAWAN meets its bill',
    await same('PAWAN SERVICE STATION BHARAT PETROLEUM DEALERS', 'PAWAN SERVICE STATION'), true);
  check('STN is STATION',
    await same('SOME SERVICE STN', 'SOME SERVICE STATION'), true);
  // The one it must NOT bridge: a genuine difference in the name.
  check('BHAGWAN is not BHAGAWAN — a person links that',
    await same('HEY KRISHNA BHAGWAN SERVICE STN', 'HEY KRISHNA BHAGAWAN SERVICE STATION'), false);
  check('two different pumps stay different',
    await same('ALAM FUEL STATION', 'HIGHWAY SERVICE CENTRE'), false);

  // ── the fortnight ────────────────────────────────────────────────────────
  console.log('\nTHE 15-DAY CYCLE');
  // DATES COME BACK AS TEXT, deliberately. node-pg turns a `date` column into a
  // JS Date at LOCAL midnight, and .toISOString() then shifts it back to UTC —
  // which on this IST box reports every boundary one day early and made a
  // correct function look broken. Formatting in SQL removes the round trip.
  const cyc = async (d) => (await db.query(
    `SELECT fortnight_code($1::date) c,
            to_char(fortnight_from($1::date), 'YYYY-MM-DD') f,
            to_char(fortnight_to($1::date), 'YYYY-MM-DD') t,
            fortnight_label($1::date) l`, [d])).rows[0];
  let z = await cyc('2026-08-01');
  check('1 Aug is H1', [z.c, z.f, z.t], ['2026-08-H1', '2026-08-01', '2026-08-15']);
  z = await cyc('2026-08-15');
  check('15 Aug is still H1', z.c, '2026-08-H1');
  z = await cyc('2026-08-16');
  check('16 Aug turns over', [z.c, z.f, z.t], ['2026-08-H2', '2026-08-16', '2026-08-31']);
  // The month-end that a hard-coded 31 gets wrong.
  z = await cyc('2026-02-20');
  check('February ends on the 28th, not the 31st', z.t, '2026-02-28');
  z = await cyc('2026-04-30');
  check('April ends on the 30th', z.t, '2026-04-30');
  z = await cyc('2026-09-16');
  check('the label reads like the office says it', z.l, 'Sep 2026 · 16–30');

  // ── fixtures ─────────────────────────────────────────────────────────────
  const { rows: [acc] } = await db.query(`
    INSERT INTO fleet_card_accounts (provider, account_no, account_name, operating_company)
    VALUES ('IOCL','T1','T','M/S PRASAD TRANSPORT') RETURNING id`);
  await db.query(`INSERT INTO vehicles (vehicle_no) VALUES ('AS-26-C-7319'),('AS-26-C-9804')`);
  const { rows: [vend] } = await db.query(
    `INSERT INTO vendors (vendor_name) VALUES ('B N FILLING STATION') RETURNING id`);

  let n = 0;
  const swipe = async (date, amt, merchant = 'BN FILLING STATION BHARAT PETROLEUM DEALERS') =>
    (await db.query(`
      INSERT INTO fleet_card_statement_txns
        (account_id, provider, provider_txn_id, txn_date, kind, direction, vehicle_raw,
         vehicle_no, merchant_name, quantity, rate, amount, unit)
      VALUES ($1::uuid,'IOCL',$2,$3::date,'SALE','DR','AS26C7319','AS-26-C-7319',
              $5, 100, 92.72, $4, 'INR') RETURNING id`,
      [acc.id, `S${++n}`, date, amt, merchant])).rows[0].id;

  const bill = async (from, to, amt) => (await db.query(`
    INSERT INTO pump_bill_drafts (vendor_id, vendor_name, ref_no, period_from, period_to,
                                  half, status, system_amount, physical_amount)
    VALUES ($1::uuid,'B N FILLING STATION',$2,$3::date,$4::date,'FIRST','DRAFT',$5,$5)
    RETURNING id`, [vend.id, `PB${++n}`, from, to, amt])).rows[0].id;

  // ── the exact-match rule ─────────────────────────────────────────────────
  console.log('\nA BILL PAID OFF BY EXACTLY ONE SWIPE');
  const bExact = await bill('2026-05-01', '2026-05-15', 9272.00);
  await swipe('2026-05-20', 9272.00);
  let r = (await db.query(`SELECT * FROM fleet_card_auto_settle_bills()`)).rows[0];
  check('an exact swipe settles the bill', Number(r.settled), 1);
  check('and the bill shows nothing due',
    Number((await db.query(`SELECT due FROM v_pump_bill_outstanding WHERE id=$1::uuid`, [bExact])).rows[0].due), 0);

  // A swipe at a DIFFERENT pump for the same amount must not touch it.
  const bOther = await bill('2026-06-01', '2026-06-15', 5000.00);
  await swipe('2026-06-20', 5000.00, 'HIGHWAY SERVICE CENTRE');
  r = (await db.query(`SELECT * FROM fleet_card_auto_settle_bills()`)).rows[0];
  check('a swipe at another pump does not settle this one', Number(r.settled), 0);
  check('…and that bill is still owed',
    Number((await db.query(`SELECT due FROM v_pump_bill_outstanding WHERE id=$1::uuid`, [bOther])).rows[0].due), 5000);

  // ── the cycle settlement: the one that clears the backlog ────────────────
  console.log('\nSETTLING A WHOLE FORTNIGHT');
  const bCycle = await bill('2026-07-01', '2026-07-15', 25000.00);
  const s1 = await swipe('2026-07-03', 10000.00);
  const s2 = await swipe('2026-07-07', 10000.00);
  const s3 = await swipe('2026-07-11', 10000.00);   // only 5,000 of this fits

  const dry = await db.query(
    `SELECT *, to_char(txn_date, 'YYYY-MM-DD') AS d
       FROM fleet_card_settle_cycle($1::uuid, 'tester', true)`, [bCycle]);
  check('the preview covers three swipes', dry.rows.length, 3);
  check('…oldest first', dry.rows.map((x) => x.d),
    ['2026-07-03', '2026-07-07', '2026-07-11']);
  check('…and the last one is applied in PART', Number(dry.rows[2].applied), 5000);
  check('…closing the bill exactly', Number(dry.rows[2].running), 25000);
  check('A DRY RUN WROTE NOTHING',
    Number((await db.query(
      `SELECT count(*)::int n FROM fleet_card_allocations WHERE target_id=$1::uuid`,
      [bCycle])).rows[0].n), 0);

  const wet = await db.query(
    `SELECT * FROM fleet_card_settle_cycle($1::uuid, 'tester', false)`, [bCycle]);
  check('committing applies the same three', wet.rows.length, 3);
  check('the bill is now settled',
    Number((await db.query(`SELECT due FROM v_pump_bill_outstanding WHERE id=$1::uuid`, [bCycle])).rows[0].due), 0);
  check('the part-used swipe keeps its remainder in clearing',
    Number((await db.query(
      `SELECT unallocated FROM v_fleet_card_unallocated WHERE txn_id=$1::uuid`, [s3])).rows[0].unallocated),
    5000);
  check('the two fully-used swipes have left the queue',
    Number((await db.query(
      `SELECT count(*)::int n FROM v_fleet_card_unallocated WHERE txn_id = ANY($1::uuid[])`,
      [[s1, s2]])).rows[0].n), 0);

  // Running it again must do nothing — the bill has nothing left to settle.
  let again = null;
  try {
    await db.query(`SELECT * FROM fleet_card_settle_cycle($1::uuid, 'tester', false)`, [bCycle]);
  } catch (e) { again = e.code; }
  check('a settled bill refuses a second settlement', again, 'P0407');

  // The over-allocation guard still owns the last word.
  console.log('\nTHE GUARD STILL OWNS THE LAST WORD');
  const bOver = await bill('2026-07-16', '2026-07-31', 99999.00);
  const over = await db.query(
    `SELECT * FROM fleet_card_settle_cycle($1::uuid, 'tester', true)`, [bOver]);
  const sumApplied = over.rows.reduce((s, x) => s + Number(x.applied), 0);
  const { rows: [pool] } = await db.query(`
    SELECT COALESCE(sum(u.unallocated),0)::float t FROM v_fleet_card_unallocated u
     WHERE pump_key(u.merchant_name) = pump_key('B N FILLING STATION')
       AND u.txn_date BETWEEN '2026-07-16' AND date '2026-07-31' + 25`);
  check('it never applies more than the swipes actually hold', sumApplied <= pool.t + 0.005, true);

  // ── the cycle view ───────────────────────────────────────────────────────
  console.log('\nTHE CYCLE LIST');
  const { rows: cycles } = await db.query(
    `SELECT cycle, swipes, unallocated::float, open_bills FROM v_fleet_card_cycles ORDER BY cycle`);
  check('cycles are listed for every month with money waiting', cycles.length > 0, true);
  check('every cycle code is a fortnight', cycles.every((c) => /^\d{4}-\d{2}-H[12]$/.test(c.cycle)), true);

  const { rows: [jul] } = await db.query(
    `SELECT swipes, unallocated::float u FROM v_fleet_card_cycles WHERE cycle='2026-07-H1'`);
  check('July H1 still shows the part-used swipe', [jul.swipes, jul.u], [1, 5000]);

  console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
} finally {
  await db.end().catch(() => {});
  const a2 = new pg.Client({ connectionString: ADMIN });
  await a2.connect();
  await a2.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
  await a2.end();
}
process.exit(failures ? 1 : 0);
