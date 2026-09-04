// server/db/migrations/157_fuel_settlement_sync.selftest.mjs
//   MIGTEST_PG=… MIGTEST_SCHEMA=…/prod_schema.sql.gz npm run migrate:selftest157
// ─────────────────────────────────────────────────────────────────────────────
// This migration flips a money status on rows the desk will never re-check, so
// what is tested is mostly what it must NOT touch. The dangerous version of
// this sweep joins pump + date range and marks ₹75 lakh of unpaid diesel paid;
// the test below builds exactly that trap — an unbilled memo sitting inside a
// settled bill's period, at the same pump, that the bill does not name — and
// fails if the sweep takes it.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ADMIN = process.env.MIGTEST_PG;
const SCHEMA = process.env.MIGTEST_SCHEMA;
if (!ADMIN || !SCHEMA) {
  console.log('\n⏭  MIGTEST_PG / MIGTEST_SCHEMA not set — skipping the migration 157 selftest.\n');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = 'pt_mig157_test';
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

try {
  console.log('\nPRODUCTION SCHEMA + 152→156');
  for (const st of splitSql(schemaSql)) { try { await db.query(st); } catch { /* PostGIS */ } }
  await db.query('SET search_path = public');
  for (const f of ['152_fleet_card_allocation.sql', '153_pump_bill_settlement.sql',
                   '154_fuel_settlement_trail.sql', '155_fortnight_bill_lock.sql',
                   '156_pump_bill_scan_queue.sql']) {
    await db.query(readFileSync(path.join(here, f), 'utf8'));
  }
  check('152–156 apply together', true, true);

  // ── the world before the sweep ─────────────────────────────────────────
  const vendor = async (name) => (await db.query(
    `INSERT INTO vendors (vendor_name, vendor_type) VALUES ($1,'Fuel Pump') RETURNING id`,
    [name])).rows[0].id;
  const BN = await vendor('B N FILLING STATION');
  const PAWAN = await vendor('PAWAN SERVICE STATION');

  const slip = async (o) => (await db.query(`
    INSERT INTO fuel_entries (entry_date, vehicle_no, memo_no, vendor_id, vendor_name,
                              liters, rate, amount, bill_status)
    VALUES ($1::date,$2,$3,$4::uuid,$5,$6,$7,$8,$9) RETURNING id`,
    [o.date, o.vehicle ?? 'AS 26C 5102', o.memo, o.vendor_id ?? null, o.vendor_name,
     o.liters ?? 100, o.rate ?? 95, o.amount ?? 9500, o.status ?? 'BILLED'])).rows[0].id;

  // Paid by the bill, and the bill says so.
  const paid1 = await slip({ date: '2026-07-03', memo: 'M-1', vendor_id: BN, vendor_name: 'B N FILLING STATION' });
  const paid2 = await slip({ date: '2026-07-09', memo: 'M-2', vendor_id: BN, vendor_name: 'B N FILLING STATION' });
  // THE TRAP: same pump, inside the same fortnight, NOT on the bill.
  const trap = await slip({ date: '2026-07-11', memo: 'M-TRAP', vendor_id: BN, vendor_name: 'B N FILLING STATION' });
  // A draft bill that never posted a voucher must not settle anything.
  const draftOnly = await slip({ date: '2026-07-05', memo: 'M-DRAFT', vendor_id: PAWAN, vendor_name: 'PAWAN SERVICE STATION' });
  // Stranded: a nickname the master does not hold.
  const stranded = await slip({ date: '2026-07-07', memo: 'M-NICK', vendor_name: 'B N filling', amount: 12345.67 });
  const strandedAmbig = await slip({ date: '2026-07-08', memo: 'M-AMB', vendor_name: 'Nirmala', amount: 500 });
  const strandedNone = await slip({ date: '2026-07-08', memo: 'M-NONE', vendor_name: 'Hatsingimari', amount: 700 });

  let refSeq = 0;
  const bill = async (o) => (await db.query(`
    INSERT INTO pump_bill_drafts (vendor_id, vendor_name, ref_no, period_from, period_to, half,
                                  status, slip_count, system_amount, physical_amount,
                                  voucher_id, lines, approved_at)
    VALUES ($1::uuid,$2,$3,$4::date,$5::date,'FIRST',$6,$7,$8,$8,$9::uuid,$10::jsonb,$11::timestamptz)
    RETURNING id`,
    [o.vendor_id, o.vendor_name, `REF-${refSeq += 1}`, o.from, o.to, o.status,
     o.slips ?? 0, o.amount ?? 0,
     o.voucher ?? null, JSON.stringify(o.lines ?? []), o.approved ?? null])).rows[0].id;

  const VOUCHER = '11111111-2222-3333-4444-555555555555';
  const settled = await bill({
    vendor_id: BN, vendor_name: 'B N FILLING STATION', from: '2026-07-01', to: '2026-07-15',
    status: 'APPROVED', slips: 2, amount: 19000, voucher: VOUCHER,
    approved: '2026-07-16T04:30:00Z',
    lines: [{ id: paid1, liters: 100, system_amount: 9500 },
            { id: paid2, liters: 100, system_amount: 9500 }],
  });
  await bill({
    vendor_id: PAWAN, vendor_name: 'PAWAN SERVICE STATION', from: '2026-07-01', to: '2026-07-15',
    status: 'DRAFT', slips: 1, amount: 9500, voucher: null,
    lines: [{ id: draftOnly, liters: 100, system_amount: 9500 }],
  });

  console.log('\nTHE SWEEP');
  await db.query(readFileSync(path.join(here, '157_fuel_settlement_sync.sql'), 'utf8'));
  check('157 applies', true, true);

  const st = async (id) => (await db.query(
    `SELECT bill_status, slip_status, settled_bill_id, settled_voucher_id, settled_at,
            status_label FROM v_fuel_slip_status WHERE id = $1::uuid`, [id])).rows[0];

  const a = await st(paid1);
  check('a memo the bill names is settled', a.slip_status, 'SETTLED');
  check('…and says which bill', a.settled_bill_id, settled);
  check('…and which voucher', a.settled_voucher_id, VOUCHER);
  check('…and when — the bill\'s own approval, not today', a.settled_at.toISOString(), '2026-07-16T04:30:00.000Z');
  check('…and reads as the pump and period', a.status_label, 'B N FILLING STATION · 01 Jul–15 Jul 2026');

  // The whole point of the migration.
  const t = await st(trap);
  check('a memo the bill does NOT name is untouched', [t.bill_status, t.settled_bill_id], ['BILLED', null]);
  check('…and still shows as pending', t.slip_status, 'PENDING');

  const d = await st(draftOnly);
  check('a bill with no voucher settles nothing', [d.bill_status, d.settled_bill_id], ['BILLED', null]);

  console.log('\nSTRANDED IS NOT PENDING');
  const s = await st(stranded);
  check('a memo with no pump gets its own status', s.slip_status, 'NO_PUMP');
  check('…and says why', s.status_label, 'pump master se juda nahi — bill nahi ban sakta');

  const { rows: un } = await db.query(
    `SELECT vendor_name, slips, amount, candidates, suggested_vendor_name, advice
       FROM v_fuel_slip_unlinked ORDER BY amount DESC`);
  check('every stranded name is listed once', un.map((r) => r.vendor_name).sort(),
    ['B N filling', 'Hatsingimari', 'Nirmala']);
  const bn = un.find((r) => r.vendor_name === 'B N filling');
  check('a nickname with one match is suggested', bn.suggested_vendor_name, 'B N FILLING STATION');
  check('…with its money', bn.amount, '12345.67');
  const none = un.find((r) => r.vendor_name === 'Hatsingimari');
  check('a nickname with no match gets no suggestion', none.suggested_vendor_name, null);
  check('…and says a pump must be created', none.advice, 'is naam ka koi pump master me nahi — naya banana hoga');

  // The master really does hold NIRMALA PETROLUM three times. A suggestion here
  // would be a coin flip written into the books.
  await db.query(`INSERT INTO vendors (vendor_name, vendor_type) VALUES ('NIRMALA PETROLUM','Fuel Pump')`);
  await db.query(`INSERT INTO vendors (vendor_name, vendor_type) VALUES ('NIRMALA PETROLEUM AGENCY','Fuel Pump')`);
  const { rows: [amb] } = await db.query(
    `SELECT candidates, suggested_vendor_id, advice FROM v_fuel_slip_unlinked WHERE vendor_name = 'Nirmala'`);
  check('an ambiguous nickname gets NO suggestion', amb.suggested_vendor_id, null);
  check('…and says to clean the master first', amb.advice,
    'master me 2 pump is naam se hain — pehle wo saaf kijiye');

  console.log('\nRUNNING IT TWICE CHANGES NOTHING');
  const before = (await db.query(
    `SELECT id, bill_status, settled_bill_id, settled_at FROM fuel_entries ORDER BY memo_no`)).rows;
  await db.query(readFileSync(path.join(here, '157_fuel_settlement_sync.sql'), 'utf8'));
  const after = (await db.query(
    `SELECT id, bill_status, settled_bill_id, settled_at FROM fuel_entries ORDER BY memo_no`)).rows;
  check('the sweep is idempotent', JSON.stringify(after), JSON.stringify(before));

  console.log('\nA MEMO ON TWO BILLS IS LEFT FOR A PERSON');
  const twice = await slip({ date: '2026-06-04', memo: 'M-TWICE', vendor_id: BN, vendor_name: 'B N FILLING STATION' });
  const halves = [['2026-06-01', '2026-06-15'], ['2026-06-16', '2026-06-30']];
  for (let i = 0; i < halves.length; i += 1) {
    await bill({ vendor_id: BN, vendor_name: 'B N FILLING STATION',
                 from: halves[i][0], to: halves[i][1],
                 status: 'APPROVED', slips: 1, amount: 9500,
                 voucher: `99999999-2222-3333-4444-00000000000${i + 1}`,
                 approved: '2026-07-01T00:00:00Z', lines: [{ id: twice, liters: 100 }] });
  }
  await db.query(readFileSync(path.join(here, '157_fuel_settlement_sync.sql'), 'utf8'));
  const tw = await st(twice);
  check('a memo two bills claim is NOT settled by either',
    [tw.bill_status, tw.settled_bill_id], ['BILLED', null]);

  // /queues/fuel-entries now serves this view where it used to serve
  // `SELECT * FROM fuel_entries`, and four screens read that response. A column
  // added to the table and forgotten here would vanish from all of them
  // silently — no error, just a field that is suddenly undefined.
  console.log('\nTHE VIEW STILL CARRIES THE WHOLE ROW');
  const cols = async (rel) => (await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`, [rel])).rows.map((r) => r.column_name);
  const viewCols = await cols('v_fuel_slip_status');
  const missing = (await cols('fuel_entries')).filter((c) => !viewCols.includes(c)).sort();
  check('no column of fuel_entries is dropped by the view', missing, []);

  console.log('\nTHE COUNTS THE SCREEN SHOWS');
  const { rows: [n] } = await db.query(`
    SELECT count(*) FILTER (WHERE slip_status = 'SETTLED')::int settled,
           count(*) FILTER (WHERE slip_status = 'PENDING')::int pending,
           count(*) FILTER (WHERE slip_status = 'NO_PUMP')::int no_pump
      FROM v_fuel_slip_status`);
  check('settled / pending / stranded add up', [n.settled, n.pending, n.no_pump], [2, 3, 3]);
} catch (e) {
  // Without this the throw is swallowed by the finally below and the run
  // reports "all good" having checked almost nothing.
  failures += 1;
  console.log(`\n  FAIL  the test threw: ${e?.message ?? e}`);
  if (e?.detail) console.log('        detail: ' + e.detail);
  if (e?.where) console.log('        where:  ' + e.where);
} finally {
  await db.end();
  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall good\n');
  process.exit(failures ? 1 : 0);
}
