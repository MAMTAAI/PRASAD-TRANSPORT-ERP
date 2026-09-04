// server/db/migrations/158_vehicle_fortnight_settlement.selftest.mjs
//   MIGTEST_PG=… MIGTEST_SCHEMA=…/prod_schema.sql.gz npm run migrate:selftest158
// ─────────────────────────────────────────────────────────────────────────────
// A maker-checker table is only worth having if the checker's signature cannot
// be walked around, so most of what follows is about what must NOT happen:
// a rebuild overwriting a reviewer's corrections, an unlock-and-edit in one
// statement, and two spellings of one lorry opening two settlements.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ADMIN = process.env.MIGTEST_PG;
const SCHEMA = process.env.MIGTEST_SCHEMA;
if (!ADMIN || !SCHEMA) {
  console.log('\n⏭  MIGTEST_PG / MIGTEST_SCHEMA not set — skipping the migration 158 selftest.\n');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = 'pt_mig158_test';
let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

function splitSql(sql) {
  const out = []; let buf = ''; let tag = null;
  let inLine = false, inBlock = false, inStr = false;
  const NL = String.fromCharCode(10);
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (inLine) { buf += c; if (c === NL) inLine = false; continue; }
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
  return out.filter((s) => s.replace(/--[^\n]*\n?/g, '').trim());
}

const admin = new pg.Client({ connectionString: ADMIN });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
await admin.query(`CREATE DATABASE ${DB}`);
await admin.end();
const url = ADMIN.replace(/\/[^/]*$/, `/${DB}`);
const raw = execFileSync('gzip', ['-dc', SCHEMA], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
const schemaSql = raw.split('\n').filter((l) => !/^\\/.test(l) && !/^SET [a-z_]+ =/i.test(l)).join('\n');

const db = new pg.Client({ connectionString: url });
await db.connect();
const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.code; } };

try {
  console.log('\nPRODUCTION SCHEMA + 152→158');
  for (const st of splitSql(schemaSql)) { try { await db.query(st); } catch { /* PostGIS */ } }
  await db.query('SET search_path = public');
  for (const f of ['152_fleet_card_allocation.sql', '153_pump_bill_settlement.sql',
                   '154_fuel_settlement_trail.sql', '155_fortnight_bill_lock.sql',
                   '156_pump_bill_scan_queue.sql', '157_fuel_settlement_sync.sql',
                   '158_vehicle_fortnight_settlement.sql']) {
    await db.query(readFileSync(path.join(here, f), 'utf8'));
  }
  check('152–158 apply together', true, true);
  await db.query(readFileSync(path.join(here, '158_vehicle_fortnight_settlement.sql'), 'utf8'));
  check('158 is re-runnable', true, true);

  // ── a fortnight of work for one lorry ──────────────────────────────────
  const trip = async (o) => (await db.query(`
    INSERT INTO trips (trip_code, vehicle_no, status, operating_company, customer_name,
                       loading_date, unloading_date, loaded_qty, rtkm, rate,
                       freight_amount, billed_amount, received_amount, total_expense)
    VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [o.code, o.vehicle, o.status ?? 'COMPLETED', o.company ?? 'M/S PRASAD TRANSPORT',
     o.customer ?? 'INDIAN OIL CORPORATION LTD',
     o.load, o.unload ?? o.load, o.qty ?? 17.5, o.rtkm ?? 2221, o.rate ?? 3.4325,
     o.freight ?? 60.07, o.billed ?? 100000, o.received ?? 0, 0])).rows[0].id;

  const A1 = await trip({ code: 'PT001', vehicle: 'AS 26C 5104', load: '2026-07-02', unload: '2026-07-05', billed: 120000 });
  const A2 = await trip({ code: 'PT002', vehicle: 'AS 26C 5104', load: '2026-07-09', unload: '2026-07-12', billed: 80000 });
  // Second half of July — a different settlement entirely.
  await trip({ code: 'PT003', vehicle: 'AS 26C 5104', load: '2026-07-20', unload: '2026-07-23', billed: 50000 });
  // A different lorry in the same fortnight.
  await trip({ code: 'PT004', vehicle: 'AS 26C 7319', load: '2026-07-03', unload: '2026-07-06', billed: 90000 });
  // Still running: must not be settled.
  await trip({ code: 'PT005', vehicle: 'AS 26C 5104', load: '2026-07-14', unload: null,
               status: 'IN_TRANSIT', billed: 999999 });

  console.log('\nTHE DRAFT THE MACHINE BUILDS');
  const draft = async (key, from) => (await db.query(
    `SELECT * FROM v_vehicle_fortnight_draft WHERE vehicle_key=$1 AND period_from=$2::date`,
    [key, from])).rows[0];

  // node-postgres hands back a Date at local midnight, so toISOString() on an
  // IST box reports the day before. Read the local parts instead — the same
  // trap that put a fortnight boundary a day out in the nightly fuel sync.
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
                   + `-${String(d.getDate()).padStart(2, '0')}`;

  const d1 = await draft('AS26C5104', '2026-07-01');
  check('the fortnight is 1–15 July', [ymd(d1.period_from), ymd(d1.period_to)],
    ['2026-07-01', '2026-07-15']);
  check('…labelled', (await db.query(`SELECT fortnight_code('2026-07-05'::date) c`)).rows[0].c, '2026-07-H1');
  check('two completed trips, not the one in transit', d1.trips_count, 2);
  check('income is billed_amount', d1.billed_amount, '200000.00');
  // The whole reason this migration exists.
  check('…and NOT the broken freight_amount (2 x 60.07)', d1.billed_amount !== '120.14', true);
  check('the 16–31 trip is a different settlement',
    (await draft('AS26C5104', '2026-07-16')).trips_count, 1);

  console.log('\nBUILDING, AND RE-BUILDING SAFELY');
  const build = async () => (await db.query(
    `SELECT * FROM vehicle_fortnight_build('2026-07-05'::date, 'test')`)).rows[0];
  const b1 = await build();
  check('one settlement per lorry', [b1.created, b1.refreshed, b1.skipped], [2, 0, 0]);

  const row = async (key) => (await db.query(
    `SELECT * FROM v_vehicle_settlement WHERE vehicle_key=$1 AND period_from='2026-07-01'`,
    [key])).rows[0];
  let s = await row('AS26C5104');
  check('it starts as an AI draft', s.status, 'AI_DRAFT');
  check('…carrying its trip lines', JSON.parse(JSON.stringify(s.lines)).length, 2);

  // A reviewer corrects it. A rebuild after that must not undo the correction.
  await db.query(`
    UPDATE vehicle_fortnight_settlements
       SET status='STAFF_REVIEWED', reviewed_by='desk', reviewed_at=now(),
           adjustments = '[{"label":"Driver bonus","amount":5000,"side":"EXPENSE"},
                           {"label":"Detention","amount":2000,"side":"INCOME"}]'::jsonb,
           other_expense = 1500
     WHERE vehicle_key='AS26C5104' AND period_from='2026-07-01'`);
  await trip({ code: 'PT006', vehicle: 'AS 26C 5104', load: '2026-07-08', unload: '2026-07-10', billed: 40000 });
  const b2 = await build();
  check('a rebuild leaves a reviewed row alone', b2.skipped, 1);
  s = await row('AS26C5104');
  check('…its status survives', s.status, 'STAFF_REVIEWED');
  check('…its manual expense survives', s.other_expense, '1500.00');
  check('…and the late trip is still visible as live drift', s.live_trips, 3);

  console.log('\nWHAT THE STATEMENT ADDS UP TO');
  check('income = billed + income adjustments', s.gross_income, '202000.00');
  check('expense = buckets + expense adjustments', s.total_expense, '6500.00');
  check('adjustments are split by side', [s.adj_income, s.adj_expense], ['2000.00', '5000.00']);

  console.log('\nTHE CHECKER’S SIGNATURE');
  const VOUCHER = '22222222-3333-4444-5555-666666666666';
  await db.query(`
    UPDATE vehicle_fortnight_settlements
       SET status='APPROVED', approved_by='owner', approved_at=now(),
           voucher_id=$1::uuid, locked_at=now(), locked_by='owner'
     WHERE vehicle_key='AS26C5104' AND period_from='2026-07-01'`, [VOUCHER]);
  s = await row('AS26C5104');
  check('approved and locked', [s.status, s.locked], ['APPROVED', true]);

  check('a locked settlement refuses an edit',
    await err(() => db.query(
      `UPDATE vehicle_fortnight_settlements SET other_expense = 9999
        WHERE vehicle_key='AS26C5104' AND period_from='2026-07-01'`)), 'P0409');

  // The hole a NEW-based guard leaves wide open.
  check('…and refuses unlock-and-edit in one statement',
    await err(() => db.query(
      `UPDATE vehicle_fortnight_settlements SET locked_at=NULL, other_expense = 9999
        WHERE vehicle_key='AS26C5104' AND period_from='2026-07-01'`)), 'P0409');

  check('a deliberate reopen is allowed',
    await err(() => db.query(
      `UPDATE vehicle_fortnight_settlements SET locked_at=NULL
        WHERE vehicle_key='AS26C5104' AND period_from='2026-07-01'`)), null);
  check('…and then it edits again',
    await err(() => db.query(
      `UPDATE vehicle_fortnight_settlements SET other_expense = 1600
        WHERE vehicle_key='AS26C5104' AND period_from='2026-07-01'`)), null);

  console.log('\nAPPROVED MEANS SOMETHING POSTED');
  check('APPROVED with neither voucher nor lock is refused',
    await err(() => db.query(`
      INSERT INTO vehicle_fortnight_settlements
        (vehicle_no, vehicle_key, period_from, period_to, status)
      VALUES ('AS 26C 9999','AS26C9999','2026-06-01','2026-06-15','APPROVED')`)), '23514');

  console.log('\nONE LORRY, ONE SETTLEMENT');
  // 'AS26C5101' and 'AS 26C 5101' are the same lorry. The key is what the
  // unique index sees, so the second one cannot open a rival statement.
  await db.query(`
    INSERT INTO vehicle_fortnight_settlements (vehicle_no, vehicle_key, period_from, period_to)
    VALUES ('AS26C5101','AS26C5101','2026-06-01','2026-06-15')`);
  check('the same lorry spelt differently cannot open a second one',
    await err(() => db.query(`
      INSERT INTO vehicle_fortnight_settlements (vehicle_no, vehicle_key, period_from, period_to)
      VALUES ('AS 26C 5101','AS26C5101','2026-06-01','2026-06-15')`)), '23505');

  console.log('\nTHE CYCLE LIST THE SCREEN OPENS ON');
  const { rows: cycles } = await db.query(`SELECT * FROM v_vehicle_settlement_cycles`);
  check('newest fortnight first', cycles[0].cycle, '2026-07-H2');
  const h1 = cycles.find((c) => c.cycle === '2026-07-H1');
  check('1–15 July holds two lorries', h1.lorries, 2);
  check('…and its approved count is visible', h1.approved, 1);
} catch (e) {
  failures += 1;
  console.log(`\n  FAIL  the test threw: ${e?.message ?? e}`);
  if (e?.detail) console.log(`        detail: ${e.detail}`);
} finally {
  await db.end();
  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall good\n');
  process.exit(failures ? 1 : 0);
}
