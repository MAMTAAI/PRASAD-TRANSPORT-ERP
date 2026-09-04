// server/db/migrations/159_vehicle_class_and_commission.selftest.mjs
//   MIGTEST_PG=… MIGTEST_SCHEMA=…/prod_schema.sql.gz npm run migrate:selftest159
// ─────────────────────────────────────────────────────────────────────────────
// The dangerous mistake here is a MISSING commission rate silently becoming
// zero: the attached lorry then reports that we earned nothing on Rs18 lakh of
// freight, and the figure posts. So most of what follows checks that an absent
// rate stays absent, is visible, and is refused at the gate.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ADMIN = process.env.MIGTEST_PG;
const SCHEMA = process.env.MIGTEST_SCHEMA;
if (!ADMIN || !SCHEMA) {
  console.log('\n⏭  MIGTEST_PG / MIGTEST_SCHEMA not set — skipping the migration 159 selftest.\n');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = 'pt_mig159_test';
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
  console.log('\nPRODUCTION SCHEMA + 152→159');
  for (const st of splitSql(schemaSql)) { try { await db.query(st); } catch { /* PostGIS */ } }
  await db.query('SET search_path = public');
  for (const f of ['152_fleet_card_allocation.sql', '153_pump_bill_settlement.sql',
                   '154_fuel_settlement_trail.sql', '155_fortnight_bill_lock.sql',
                   '156_pump_bill_scan_queue.sql', '157_fuel_settlement_sync.sql',
                   '158_vehicle_fortnight_settlement.sql',
                   '159_vehicle_class_and_commission.sql']) {
    await db.query(readFileSync(path.join(here, f), 'utf8'));
  }
  check('152–159 apply together', true, true);
  await db.query(readFileSync(path.join(here, '159_vehicle_class_and_commission.sql'), 'utf8'));
  check('159 is re-runnable', true, true);

  // ── a fleet with one of each ───────────────────────────────────────────
  // vehicle_no_norm is a GENERATED column — the database does the
  // normalisation, which is why vehicle_class() can rely on it.
  const veh = async (no, own, owner) => db.query(
    `INSERT INTO vehicles (vehicle_no, ownership, owner_name)
     VALUES ($1,$2::ownership_kind,$3)`, [no, own, owner]);
  await veh('AS 26C 1111', 'OWNED', 'PRASAD TRANSPORT');
  await veh('AS 26C 2222', 'ATTACHED', 'SANDEEP KUMAR PRASAD');
  await veh('AS 26C 3333', 'ATTACHED', 'GAUTAM PRASAD');
  await db.query(
    `INSERT INTO market_vehicles (registration_no, vendor_agency) VALUES ('NL 01Q 4444','SOME FLEET')`);

  console.log('\nWHICH LORRY IS WHICH');
  const cls = async (no) => (await db.query('SELECT vehicle_class($1) c', [no])).rows[0].c;
  check('an owned lorry is OWN', await cls('AS 26C 1111'), 'OWN');
  check('an attached one is ATTACHED', await cls('AS 26C 2222'), 'ATTACHED');
  check('a market one is MARKET', await cls('NL 01Q 4444'), 'MARKET');
  // Spelling must not decide the answer — the register holds both forms.
  check('spacing does not change the answer', await cls('AS26C2222'), 'ATTACHED');
  check('a lorry in no master is NULL, not a guess', await cls('XX 99Z 0000'), null);

  const trip = async (o) => db.query(`
    INSERT INTO trips (trip_code, vehicle_no, status, operating_company, customer_name,
                       loading_date, unloading_date, loaded_qty, rtkm, billed_amount, total_expense)
    VALUES ($1,$2,'COMPLETED','M/S PRASAD TRANSPORT','INDIAN OIL CORPORATION LTD',
            $3::date,$3::date,$4,$5,$6,0)`,
    [o.code, o.vehicle, o.date, o.qty ?? 12, o.rtkm ?? 200, o.billed]);

  await trip({ code: 'T1', vehicle: 'AS 26C 1111', date: '2026-07-03', billed: 100000 });
  await trip({ code: 'T2', vehicle: 'AS 26C 2222', date: '2026-07-04', billed: 200000, qty: 12 });
  await trip({ code: 'T3', vehicle: 'AS 26C 2222', date: '2026-07-09', billed: 100000, qty: 12 });
  await trip({ code: 'T4', vehicle: 'AS 26C 3333', date: '2026-07-05', billed: 150000, qty: 10 });
  await trip({ code: 'T5', vehicle: 'NL 01Q 4444', date: '2026-07-06', billed:  80000, qty: 20 });

  const row = async (key) => (await db.query(
    `SELECT * FROM v_vehicle_fortnight_class WHERE vehicle_key=$1 AND period_from='2026-07-01'`,
    [key])).rows[0];

  console.log('\nNO RATE ON FILE IS NOT A RATE OF ZERO');
  let a = await row('AS26C2222');
  check('the attached lorry has no commission', a.commission_amount, null);
  check('…and is flagged', a.needs_rate, true);
  check('…so nothing reaches our profit yet', a.our_earning, null);
  check('the owned lorry is unaffected', (await row('AS26C1111')).our_earning, '100000.00');
  check('…and is never flagged for a rate', (await row('AS26C1111')).needs_rate, false);

  const missing = (await db.query('SELECT vehicle_no, freight_ever FROM v_commission_rate_missing')).rows;
  check('both attached lorries are listed as missing a rate', missing.length, 2);
  check('…heaviest earner first', missing[0].vehicle_no, 'AS 26C 2222');

  console.log('\nA RATE ONLY APPLIES FROM WHEN IT STARTS');
  // effective_from defaults to TODAY, so a rate keyed in this afternoon does
  // NOT reach back over a fortnight that ran in July. That is correct, and it
  // is also the trap: the desk enters a rate, nothing changes on screen, and
  // the system looks broken. The route and the screen therefore default the
  // date to the START OF THE FORTNIGHT being settled, and this check is what
  // says why they must.
  await db.query(`
    INSERT INTO vehicle_commission_terms (vehicle_key, vehicle_no, basis, rate, tds_pct, owner_name)
    VALUES ('AS26C2222','AS 26C 2222','PCT', 8, 1, 'SANDEEP KUMAR PRASAD')`);
  check('a rate starting today does not price a July fortnight',
    (await row('AS26C2222')).commission_amount, null);
  await db.query(`DELETE FROM vehicle_commission_terms WHERE vehicle_key='AS26C2222'`);

  console.log('\nA PERCENTAGE TERM');
  await db.query(`
    INSERT INTO vehicle_commission_terms (vehicle_key, vehicle_no, basis, rate, tds_pct, owner_name,
                                          effective_from)
    VALUES ('AS26C2222','AS 26C 2222','PCT', 8, 1, 'SANDEEP KUMAR PRASAD', '2026-04-01')`);
  a = await row('AS26C2222');
  check('commission is 8% of Rs3,00,000', a.commission_amount, '24000.00');
  // TDS is withheld on what the OWNER gets, not on the whole freight.
  check('TDS is 1% of freight less commission', a.tds_amount, '2760.00');
  check('the owner is paid the rest', a.payable_to_owner, '273240.00');
  check('OUR profit is the commission alone', a.our_earning, '24000.00');
  check('…not the whole margin', a.our_earning !== a.net, true);

  console.log('\nA PER-KL TERM, FOR A MARKET HIRE');
  await db.query(`
    INSERT INTO vehicle_commission_terms (vehicle_key, vehicle_no, basis, rate, tds_pct,
                                          recover_expenses, effective_from)
    VALUES ('NL01Q4444','NL 01Q 4444','PER_KL', 150, 2, false, '2026-04-01')`);
  const m = await row('NL01Q4444');
  check('commission is 20 KL x Rs150', m.commission_amount, '3000.00');
  check('TDS at 2% of the balance', m.tds_amount, '1540.00');
  check('expenses are NOT recovered on this one', m.expenses_recovered, '0.00');
  check('payable = freight - commission - tds', m.payable_to_owner, '75460.00');

  console.log('\nA FLAT PER-TRIP TERM');
  await db.query(`
    INSERT INTO vehicle_commission_terms (vehicle_key, vehicle_no, basis, rate, tds_pct,
                                          effective_from)
    VALUES ('AS26C3333','AS 26C 3333','FLAT_TRIP', 2500, 0, '2026-04-01')`);
  check('one trip x Rs2,500', (await row('AS26C3333')).commission_amount, '2500.00');

  console.log('\nTHE RATE THAT APPLIED WHEN IT RAN');
  // Close the 8% term at the end of July and open 10% from August. July must
  // keep 8% — a renegotiation cannot rewrite a fortnight already worked.
  await db.query(`UPDATE vehicle_commission_terms SET effective_to = '2026-07-31'
                   WHERE vehicle_key='AS26C2222'`);
  await db.query(`
    INSERT INTO vehicle_commission_terms (vehicle_key, vehicle_no, basis, rate, tds_pct, effective_from)
    VALUES ('AS26C2222','AS 26C 2222','PCT', 10, 1, '2026-08-01')`);
  check('July still settles at 8%', (await row('AS26C2222')).commission_amount, '24000.00');
  check('a second open term is refused',
    await err(() => db.query(`
      INSERT INTO vehicle_commission_terms (vehicle_key, basis, rate, effective_from)
      VALUES ('AS26C2222','PCT', 12, '2026-04-01')`)), '23505');

  console.log('\nBUILD, AND THE POSTING GATE');
  const b = (await db.query(`SELECT * FROM vehicle_fortnight_build('2026-07-05'::date,'test')`)).rows[0];
  check('one settlement per lorry', b.created, 4);
  const s = async (key) => (await db.query(
    `SELECT * FROM v_vehicle_settlement WHERE vehicle_key=$1 AND period_from='2026-07-01'`,
    [key])).rows[0];
  const att = await s('AS26C2222');
  check('the stored row carries its class', att.fleet_class, 'ATTACHED');
  check('…its owner', att.owner_name, 'SANDEEP KUMAR PRASAD');
  check('…and only the commission as our earning', att.our_earning, '24000.00');

  // The lorry that still has no rate must not be approvable.
  // Close its term the day before the fortnight, so July is uncovered again.
  await db.query(`UPDATE vehicle_commission_terms SET effective_to='2026-06-30'
                   WHERE vehicle_key='AS26C3333'`);
  await db.query(`SELECT vehicle_fortnight_build('2026-07-05'::date,'test')`);
  check('losing its rate empties the commission',
    (await s('AS26C3333')).commission_amount, null);
  check('…and approving it is refused',
    await err(() => db.query(`
      UPDATE vehicle_fortnight_settlements
         SET status='APPROVED', locked_at=now(), approved_by='owner'
       WHERE vehicle_key='AS26C3333' AND period_from='2026-07-01'`)), 'P0410');
  check('an OWN lorry approves with no commission at all',
    await err(() => db.query(`
      UPDATE vehicle_fortnight_settlements
         SET status='APPROVED', locked_at=now(), approved_by='owner'
       WHERE vehicle_key='AS26C1111' AND period_from='2026-07-01'`)), null);

  console.log('\nONE OWNER, EVERY LORRY THEY RUN');
  const { rows: own } = await db.query(
    `SELECT * FROM v_owner_fortnight_statement WHERE period_from='2026-07-01' ORDER BY freight DESC`);
  check('owners are listed, not lorries', own.length, 3);
  const sandeep = own.find((o) => o.owner_name === 'SANDEEP KUMAR PRASAD');
  check('their freight is summed', sandeep.freight, '300000.00');
  check('…their commission', sandeep.commission, '24000.00');
  check('…their TDS', sandeep.tds, '2760.00');
  check('…and what they are owed', sandeep.payable, '273240.00');
  check('an OWN lorry never appears on an owner statement',
    own.some((o) => o.owner_name === 'PRASAD TRANSPORT'), false);
} catch (e) {
  failures += 1;
  console.log(`\n  FAIL  the test threw: ${e?.message ?? e}`);
  if (e?.detail) console.log(`        detail: ${e.detail}`);
} finally {
  await db.end();
  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall good\n');
  process.exit(failures ? 1 : 0);
}
