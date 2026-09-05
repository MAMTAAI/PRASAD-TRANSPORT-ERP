// server/db/migrations/160_vehicle_owner_bills.selftest.mjs
//   MIGTEST_PG=… MIGTEST_SCHEMA=…/prod_schema.sql.gz npm run migrate:selftest160
// ─────────────────────────────────────────────────────────────────────────────
// What must hold before this ships:
//   · a fooding / fixed / doc entry lands on ONE trip and reaches its P&L
//   · the advance comes off an ATTACHED owner's bill and NOT an own lorry's
//   · every lorry of an owner is one bill, numbered VB-<initials>-MON-Hn-YYYY
//   · a bill with any lorry lacking a rate cannot be approved (P0412)
//   · a locked bill refuses edits (P0411) and reopens only with a reason
//   · rebuilding never touches a locked bill, and drops an emptied draft
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ADMIN = process.env.MIGTEST_PG;
const SCHEMA = process.env.MIGTEST_SCHEMA;
if (!ADMIN || !SCHEMA) {
  console.log('\n⏭  MIGTEST_PG / MIGTEST_SCHEMA not set — skipping the migration 160 selftest.\n');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = 'pt_mig160_test';
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
// pg_dump relies on this and the line filter above drops it: SQL-language
// function bodies must not be checked against tables that come later.
await db.query('SET check_function_bodies = false');
const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.code; } };
const one = async (sql, args) => (await db.query(sql, args)).rows[0];

try {
  console.log('\nPRODUCTION SCHEMA (through 159) + 160');
  let schemaFails = 0; const schemaErrs = [];
  for (const st of splitSql(schemaSql)) { try { await db.query(st); } catch (e) { schemaFails += 1; if (!/geometry|postgis|geography|spatial/i.test(e.message + st)) schemaErrs.push(e.message.slice(0, 120)); } }
  console.log(`      (schema statements that did not apply locally: ${schemaFails}, non-PostGIS: ${schemaErrs.length})`);
  for (const m of schemaErrs.slice(0, 8)) console.log('        · ' + m);
  await db.query('SET search_path = public');
  await db.query(readFileSync(path.join(here, '160_vehicle_owner_bills.sql'), 'utf8'));
  check('160 applies on the production schema', true, true);
  await db.query(readFileSync(path.join(here, '160_vehicle_owner_bills.sql'), 'utf8'));
  check('160 is re-runnable', true, true);

  // ── a small fleet ──────────────────────────────────────────────────────
  const veh = async (no, own, owner) => db.query(
    `INSERT INTO vehicles (vehicle_no, ownership, owner_name) VALUES ($1,$2::ownership_kind,$3)`,
    [no, own, owner]);
  await veh('AS 26C 1111', 'OWNED', 'PRASAD TRANSPORT');
  await veh('AS 26C 2222', 'ATTACHED', 'SANDEEP KUMAR PRASAD');
  await veh('AS 26C 3333', 'ATTACHED', 'SANDEEP KUMAR PRASAD');
  await veh('AS 26C 4444', 'ATTACHED', 'GAUTAM PRASAD');
  for (const k of ['AS26C2222', 'AS26C3333']) {
    await db.query(`
      INSERT INTO vehicle_commission_terms (vehicle_key, basis, rate, tds_pct, effective_from)
      VALUES ($1, 'PCT', 10, 1, '2026-04-01')`, [k]);
  }

  const trip = async (o) => (await db.query(`
    INSERT INTO trips (trip_code, vehicle_no, driver_name, status, operating_company, customer_name,
                       loading_date, unloading_date, loaded_qty, rtkm, billed_amount, total_expense)
    VALUES ($1,$2,$3,'COMPLETED','M/S PRASAD TRANSPORT','INDIAN OIL CORPORATION LTD',
            $4::date,$4::date,$5,$6,$7,0) RETURNING id`,
    [o.code, o.vehicle, o.driver ?? 'SOME DRIVER', o.date, o.qty ?? 17.5, o.rtkm ?? 1900, o.billed])).rows[0].id;

  const T1 = await trip({ code: 'T1', vehicle: 'AS 26C 1111', date: '2026-06-20', billed: 100000 });
  const T2 = await trip({ code: 'T2', vehicle: 'AS 26C 2222', date: '2026-06-21', billed: 200000 });
  const T3 = await trip({ code: 'T3', vehicle: 'AS 26C 3333', date: '2026-06-22', billed: 100000 });
  const T4 = await trip({ code: 'T4', vehicle: 'AS 26C 4444', date: '2026-06-23', billed: 50000 });

  // Advances: one on an attached lorry, one on an own lorry.
  await db.query(`INSERT INTO driver_transactions (driver_name, trip_id, txn_date, txn_type, amount, mode)
                  VALUES ('SOME DRIVER', $1, '2026-06-21', 'ADVANCE_GIVEN', 15000, 'Cash')`, [T2]);
  await db.query(`INSERT INTO driver_transactions (driver_name, trip_id, txn_date, txn_type, amount, mode)
                  VALUES ('SOME DRIVER', $1, '2026-06-20', 'ADVANCE_GIVEN', 5000, 'Cash')`, [T1]);

  console.log('\nTHE NEW REGISTER: ONE TRIP, ITS OWN ENTRY');
  const entry = (tripId, vehicle, kind, amount, label = null) => db.query(`
    INSERT INTO trip_expense_entries (trip_id, vehicle_no, kind, amount, label, dated, entered_by)
    VALUES ($1, $2, $3, $4, $5, '2026-06-21', 'test')`, [tripId, vehicle, kind, amount, label]);
  await entry(T2, 'AS 26C 2222', 'FOODING_ALLOWANCE', 1800);
  await entry(T2, 'AS 26C 2222', 'FIXED_ALLOWANCE', 2500);
  await entry(T1, 'AS 26C 1111', 'DOC_EXPENSE', 300);
  check('OTHER without a name is refused',
    await err(() => entry(T2, 'AS 26C 2222', 'OTHER_EXPENSE', 100)), '23514');
  check('an entry for a different lorry than the trip ran is refused (P0405)',
    await err(() => entry(T2, 'AS 26C 9999', 'DOC_EXPENSE', 100)), 'P0405');
  check('an entry with no trip is impossible',
    await err(() => db.query(`INSERT INTO trip_expense_entries (kind, amount) VALUES ('DOC_EXPENSE', 1)`)), '23502');

  const p2 = await one('SELECT * FROM v_trip_pnl WHERE trip_id = $1', [T2]);
  check('fooding reaches the trip P&L', p2.fooding, '1800.00');
  check('fixed allowance too', p2.fixed_allowance, '2500.00');
  check('…inside the expense total', p2.expense_total, '4300.00');
  check('…and not double-counted under other', p2.other, '0.00');
  check('the advance stays beside the P&L, not inside it', p2.advances, '15000.00');

  console.log('\nBUILD: LORRIES, THEN OWNER BILLS');
  const b = await one(`SELECT * FROM vehicle_fortnight_build('2026-06-20'::date, 'test')`);
  check('four lorry settlements', b.created, 4);
  const bills = (await db.query(
    `SELECT * FROM v_vehicle_owner_bill WHERE period_from = '2026-06-16' ORDER BY bill_no`)).rows;
  check('three bills: two attached owners and one own-fleet statement', bills.length, 3);
  check('bill numbers read like the pump bills',
    bills.map((x) => x.bill_no), ['VB-GP-JUN-H2-2026', 'VB-PT-OWN-JUN-H2-2026', 'VB-SKP-JUN-H2-2026']);

  const skp = bills.find((x) => x.bill_no === 'VB-SKP-JUN-H2-2026');
  check('Sandeep: both his lorries', skp.lorries, 2);
  check('…freight summed', skp.freight, '300000.00');
  check('…fooding on the bill', skp.fooding, '1800.00');
  check('…fixed allowance on the bill', skp.fixed_allowance, '2500.00');
  check('…the advance is a deduction on an attached bill', skp.advances, '15000.00');
  check('…P&L expense excludes the advance', skp.expense_total, '4300.00');
  check('…deductions include it', skp.deductions, '19300.00');
  check('…commission 10% of 3,00,000', skp.commission, '30000.00');
  check('…TDS 1% of (freight − commission), per lorry', skp.tds, '2700.00');
  check('…recovered = expenses + advance', skp.recovered, '19300.00');
  check('…owner is owed the rest', skp.payable, '248000.00');
  check('…our earning is the commission alone', skp.our_earning, '30000.00');
  check('…no lorry without a rate', skp.needs_rate, 0);

  const own = bills.find((x) => x.bill_no === 'VB-PT-OWN-JUN-H2-2026');
  check('own fleet: the doc expense is deducted', own.deductions, '300.00');
  check('…but the driver advance is NOT', own.advances, '5000.00');
  check('…so our earning is freight − expenses', own.our_earning, '99700.00');
  check('…and nobody is "owed" on an own lorry', own.payable, null);

  const gp = bills.find((x) => x.bill_no === 'VB-GP-JUN-H2-2026');
  check('Gautam: no rate on file → flagged', gp.needs_rate, 1);
  check('…commission is NULL, never zero', gp.commission, null);
  check('…approving it is refused at the gate (P0412)',
    await err(() => db.query(
      `UPDATE vehicle_owner_bills SET status='APPROVED', locked_at=now() WHERE id=$1`, [gp.id])), 'P0412');

  console.log('\nTHE DESK KEYS A LINE ON THE BILL — IT LANDS ON THE TRIP');
  const s3 = await one(`SELECT id FROM vehicle_fortnight_settlements WHERE vehicle_key='AS26C3333'`);
  await db.query(`INSERT INTO trip_expense_entries (trip_id, vehicle_no, kind, amount, source, entered_by)
                  VALUES ($1, 'AS 26C 3333', 'FOODING_ALLOWANCE', 1000, 'BILL_DESK', 'desk')`, [T3]);
  await db.query('SELECT vehicle_settlement_refresh($1)', [s3.id]);
  check('the lorry settlement follows the register',
    (await one('SELECT fooding FROM vehicle_fortnight_settlements WHERE id=$1', [s3.id])).fooding, '1000.00');
  const skp2 = await one('SELECT * FROM v_vehicle_owner_bill WHERE id=$1', [skp.id]);
  check('…and the owner bill foot follows the lorry', skp2.fooding, '2800.00');
  check('…payable moves by the same rupees', skp2.payable, '247000.00');

  console.log('\nA REBUILD IS SAFE');
  const b2 = await one(`SELECT * FROM vehicle_fortnight_build('2026-06-20'::date, 'test')`);
  check('nothing new, four refreshed', [b2.created, b2.refreshed], [0, 4]);
  check('still three bills', (await one(
    `SELECT count(*)::int n FROM vehicle_owner_bills WHERE period_from='2026-06-16'`)).n, 3);

  // An owner corrected in the master moves the lorry to the other bill and
  // the emptied draft disappears.
  await db.query(`UPDATE vehicles SET owner_name='SANDEEP KUMAR PRASAD' WHERE vehicle_no='AS 26C 4444'`);
  await db.query(`SELECT vehicle_fortnight_build('2026-06-20'::date, 'test')`);
  check('the emptied Gautam draft is dropped', (await one(
    `SELECT count(*)::int n FROM vehicle_owner_bills WHERE bill_no='VB-GP-JUN-H2-2026'`)).n, 0);
  const skp3 = await one('SELECT * FROM v_vehicle_owner_bill WHERE id=$1', [skp.id]);
  check('…and Sandeep now has three lorries', skp3.lorries, 3);
  check('…one of them without a rate', skp3.needs_rate, 1);
  check('…so his payable is unknown until it is set', skp3.payable, null);
  await db.query(`UPDATE vehicles SET owner_name='GAUTAM PRASAD' WHERE vehicle_no='AS 26C 4444'`);
  await db.query(`SELECT vehicle_fortnight_build('2026-06-20'::date, 'test')`);
  check('moved back: Gautam has his bill again', (await one(
    `SELECT count(*)::int n FROM vehicle_owner_bills WHERE bill_no='VB-GP-JUN-H2-2026'`)).n, 1);
  check('…and Sandeep is back to two', (await one(
    'SELECT lorries FROM vehicle_owner_bills WHERE id=$1', [skp.id])).lorries, 2);

  console.log('\nAPPROVE, LOCK, MODIFY');
  await db.query(`UPDATE vehicle_fortnight_settlements
                     SET status='APPROVED', approved_by='owner', locked_at=now(), locked_by='owner'
                   WHERE owner_bill_id=$1`, [skp.id]);
  check('an attached bill with every rate approves',
    await err(() => db.query(`
      UPDATE vehicle_owner_bills SET status='APPROVED', approved_by='owner', locked_at=now(), locked_by='owner'
       WHERE id=$1`, [skp.id])), null);
  check('a locked bill refuses a number change (P0411)',
    await err(() => db.query(`UPDATE vehicle_owner_bills SET freight = 1 WHERE id=$1`, [skp.id])), 'P0411');
  check('…and refuses a reopen without a reason',
    await err(() => db.query(`
      UPDATE vehicle_owner_bills SET locked_at=NULL, status='STAFF_REVIEWED' WHERE id=$1`, [skp.id])), 'P0411');
  check('…and a sneaky unlock-and-edit in one statement',
    await err(() => db.query(`
      UPDATE vehicle_owner_bills SET locked_at=NULL, status='STAFF_REVIEWED', reopen_reason='x', freight=1
       WHERE id=$1`, [skp.id])), 'P0411');
  const b3 = await one(`SELECT * FROM vehicle_fortnight_build('2026-06-20'::date, 'test')`);
  check('a rebuild steps around the locked lorries', b3.skipped, 2);
  check('…and the locked bill keeps its numbers',
    (await one('SELECT fooding FROM vehicle_owner_bills WHERE id=$1', [skp.id])).fooding, '2800.00');
  check('a reopen WITH a reason is the one edit a locked bill takes',
    await err(() => db.query(`
      UPDATE vehicle_owner_bills
         SET locked_at=NULL, locked_by=NULL, status='STAFF_REVIEWED',
             reopen_reason='detention chhoot gaya', reopened_by='owner', reopened_at=now()
       WHERE id=$1`, [skp.id])), null);
  check('…and its lorries reopen the same way',
    await err(() => db.query(`
      UPDATE vehicle_fortnight_settlements SET locked_at=NULL, locked_by=NULL, status='STAFF_REVIEWED'
       WHERE owner_bill_id=$1`, [skp.id])), null);
  check('after reopening, the desk can edit again',
    await err(() => db.query(`UPDATE vehicle_owner_bills SET notes='ok' WHERE id=$1`, [skp.id])), null);

  console.log('\nBILL NUMBERS');
  const no = async (o, c) => (await one(`SELECT owner_bill_no($1, $2, '2026-04-01') n`, [o, c])).n;
  check('initials of up to three words', await no('SANDEEP KUMAR PRASAD', 'ATTACHED'), 'VB-SKP-APR-H1-2026');
  check('M/S is not a word', await no('M/S PRASAD TRANSPORT', 'OWN'), 'VB-PT-OWN-APR-H1-2026');
  check('an unknown owner is NA', await no('(owner darj nahi)', 'NONE'), 'VB-NA-X-APR-H1-2026');
  check('second half of the month', (await one(`SELECT owner_bill_no('GAUTAM PRASAD','ATTACHED','2026-06-16') n`)).n,
    'VB-GP-JUN-H2-2026');
} catch (e) {
  failures += 1;
  console.log(`\n  FAIL  the test threw: ${e?.message ?? e}`);
  if (e?.detail) console.log(`        detail: ${e.detail}`);
  if (e?.where) console.log(`        where: ${e.where}`);
} finally {
  await db.end();
  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall good\n');
  process.exit(failures ? 1 : 0);
}
