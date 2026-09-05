// server/db/migrations/162_market_partner_bills.selftest.mjs
//   MIGTEST_PG=… MIGTEST_SCHEMA=…/prod_schema.sql.gz npm run migrate:selftest162
// ─────────────────────────────────────────────────────────────────────────────
// Production has no market data, so this is the only place the partner bill
// is exercised before it ships. What must hold:
//   · a load joins the fortnight its POD was verified in; a running load waits
//   · one bill per partner, loads under their trucks, MB-<initials>-MON-Hn-YYYY
//   · TDS on the whole partner freight from the master (1% / 2% / 20% / NIL);
//     unknown = NULL and the bill cannot be approved (P0412)
//   · balance = partner freight − advances − TDS ± manual; margin = our earning
//   · the lorry-bill builder never sweeps a market bill away
//   · a locked bill takes the payment columns and nothing else
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ADMIN = process.env.MIGTEST_PG;
const SCHEMA = process.env.MIGTEST_SCHEMA;
if (!ADMIN || !SCHEMA) {
  console.log('\n⏭  MIGTEST_PG / MIGTEST_SCHEMA not set — skipping the migration 162 selftest.\n');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = 'pt_mig162_test';
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
await db.query('SET check_function_bodies = false');
const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.code; } };
const one = async (sql, args) => (await db.query(sql, args)).rows[0];

try {
  console.log('\nPRODUCTION SCHEMA (through 159) + 160 + 161 + 162');
  for (const st of splitSql(schemaSql)) { try { await db.query(st); } catch { /* PostGIS */ } }
  await db.query('SET search_path = public');
  for (const f of ['160_vehicle_owner_bills.sql', '161_vehicle_ownership_rule.sql', '162_market_partner_bills.sql']) {
    await db.query(readFileSync(path.join(here, f), 'utf8'));
  }
  check('160 → 162 apply on the production schema', true, true);
  await db.query(readFileSync(path.join(here, '162_market_partner_bills.sql'), 'utf8'));
  check('162 is re-runnable', true, true);
  check('the TDS ledger lives inside the market segment',
    (await one(`SELECT group_head FROM ledgers WHERE ledger_name='Market Fleet TDS Payable 194C'`)).group_head,
    'Market Fleet Duties & Taxes');

  // ── a market, in miniature ─────────────────────────────────────────────
  const PT = (await one(`INSERT INTO companies (company_name) VALUES ('M/S PRASAD TRANSPORT') RETURNING id`)).id;
  const V1 = (await one(`INSERT INTO vendors (vendor_name, vendor_type, mobile_no, pan_no, entity_type)
                         VALUES ('ASSAM ROADWAYS', 'FLEET PARTNER', '9800000001', 'AAXPR1234K', 'FIRM') RETURNING id`)).id;
  const V2 = (await one(`INSERT INTO vendors (vendor_name, vendor_type, mobile_no, pan_no)
                         VALUES ('NO TYPE CARRIERS', 'FLEET PARTNER', '9800000002', 'BBXPN5678L') RETURNING id`)).id;
  const T1 = (await one(`INSERT INTO market_vehicles (registration_no, vendor_agency, vendor_id, system_status, driver_name)
                         VALUES ('AS 01 AB 4521', 'ASSAM ROADWAYS', $1, 'System Active', 'RAJU DAS') RETURNING id`, [V1])).id;
  const T2 = (await one(`INSERT INTO market_vehicles (registration_no, vendor_agency, vendor_id, system_status, driver_name)
                         VALUES ('AS 01 CD 7788', 'ASSAM ROADWAYS', $1, 'System Active', 'MOFIZUL HAQUE') RETURNING id`, [V1])).id;

  const deal = async (o) => {
    await db.query(`INSERT INTO bazaar_loads (load_id, customer_name, origin, destination, material, weight, distance_km)
                    VALUES ($1, $2, 'BONGAIGAON', $3, $4, $5, $6)`,
      [o.load, o.customer, o.dest, o.material, o.weight, o.km]);
    const bid = (await one(`INSERT INTO bazaar_bids (load_id, vendor_name, vendor_id, bid_amount, status)
                            VALUES ($1, $2, $3, $4, 'ACCEPTED') RETURNING id`,
      [o.load, o.vendorName, o.vendor, o.partner])).id;
    return (await one(`
      INSERT INTO bazaar_settlements (load_id, bid_id, vendor_id, company_id, awarded_amount, customer_rate, margin_amount,
                                      advance_amount, status, pod_verified_at, market_vehicle_id)
      VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $6::numeric - $5::numeric, $7, $8, $9, $10) RETURNING id`,
      [o.load, bid, o.vendor, PT, o.partner, o.customer_rate, o.advance, o.status, o.pod, o.truck])).id;
  };
  const S1 = await deal({ load: 'LD-30801', customer: 'IOCL', dest: 'SILIGURI', material: 'HSD', weight: '20 KL', km: 428, vendorName: 'ASSAM ROADWAYS', vendor: V1, partner: 56000, customer_rate: 64000, advance: 50400, status: 'POD_VERIFIED', pod: '2026-06-18', truck: T1 });
  const S2 = await deal({ load: 'LD-30811', customer: 'HPCL', dest: 'GUWAHATI', material: 'MS', weight: '16 KL', km: 190, vendorName: 'ASSAM ROADWAYS', vendor: V1, partner: 36000, customer_rate: 40000, advance: 32400, status: 'POD_VERIFIED', pod: '2026-06-27', truck: T1 });
  const S3 = await deal({ load: 'LD-30822', customer: 'BPCL', dest: 'AGARTALA', material: 'ATF', weight: '40 KL', km: 612, vendorName: 'ASSAM ROADWAYS', vendor: V1, partner: 70000, customer_rate: 82000, advance: 63000, status: 'POD_VERIFIED', pod: '2026-06-29', truck: T2 });
  await deal({ load: 'LD-30830', customer: 'IOCL', dest: 'SILIGURI', material: 'HSD', weight: '20 KL', km: 428, vendorName: 'ASSAM ROADWAYS', vendor: V1, partner: 48000, customer_rate: 55000, advance: 0, status: 'ADVANCE_PAID', pod: null, truck: T2 });          // running
  await deal({ load: 'LD-30840', customer: 'IOCL', dest: 'SILIGURI', material: 'HSD', weight: '20 KL', km: 428, vendorName: 'ASSAM ROADWAYS', vendor: V1, partner: 50000, customer_rate: 58000, advance: 45000, status: 'POD_VERIFIED', pod: '2026-07-02', truck: T1 });  // next fortnight
  await deal({ load: 'LD-30850', customer: 'IOCL', dest: 'GUWAHATI', material: 'HSD', weight: '20 KL', km: 190, vendorName: 'NO TYPE CARRIERS', vendor: V2, partner: 30000, customer_rate: 33000, advance: 27000, status: 'POD_VERIFIED', pod: '2026-06-20', truck: null });
  void S1; void S2; void S3;

  console.log('\nBUILD — the same 1st/16th pass drafts the partner bills');
  await db.query(`SELECT vehicle_fortnight_build('2026-06-20'::date, 'test')`);
  const bills = (await db.query(`SELECT * FROM v_vehicle_owner_bill WHERE class_key='MARKET' ORDER BY bill_no`)).rows;
  check('one bill per partner for the fortnight', bills.map((b) => b.bill_no), ['MB-AR-JUN-H2-2026', 'MB-NTC-JUN-H2-2026']);
  const ar = bills[0];
  check('Assam Roadways: three delivered loads', ar.loads, 3);
  check('…the running load waits, the July load is next fortnight', ar.trips, 3);
  check('…on two trucks', ar.trucks, 2);
  check('customer freight (our income)', ar.freight, '186000.00');
  check('partner freight (our cost)', ar.partner_freight, '162000.00');
  check('margin = income − cost', ar.margin, '24000.00');
  check('…and that is our earning, never a third entry', ar.our_earning, '24000.00');
  check('advances already out', ar.advances_paid, '145800.00');
  check('TDS 2% (firm with PAN) on the WHOLE partner freight', [ar.tds_pct, ar.tds], ['2.000', '3240.00']);
  check('balance = partner − advances − TDS', ar.payable, '12960.00');
  check('nothing missing on this partner', ar.needs_rate, 0);
  check('the list\'s "net" for a market bill is the margin', ar.net, '24000.00');
  const lines = ar.lines;
  check('loads print under their truck, in order', lines.map((l) => l.truck), ['AS 01 AB 4521', 'AS 01 AB 4521', 'AS 01 CD 7788']);
  check('…each with both rates and the advance', [lines[0].load_id, lines[0].customer_rate, lines[0].partner_rate, lines[0].advance], ['LD-30801', 64000, 56000, 50400]);
  check('…and the POD date that placed it here', lines[0].pod_date, '2026-06-18');

  console.log('\nTHE RATE COMES FROM THE MASTER, OR IT IS UNKNOWN');
  const ntc = bills[1];
  check('a partner with no entity type has no TDS pct', ntc.tds_pct, null);
  check('…so TDS is NULL, not zero', ntc.tds, null);
  check('…payable unknown', ntc.payable, null);
  check('…flagged', ntc.needs_rate, 1);
  check('…and approving it is refused (P0412)',
    await err(() => db.query(`UPDATE vehicle_owner_bills SET status='APPROVED', locked_at=now() WHERE id=$1`, [ntc.id])), 'P0412');
  await db.query(`UPDATE vendors SET entity_type='INDIVIDUAL' WHERE id=$1`, [V2]);
  await db.query(`SELECT vehicle_owner_bill_refresh($1)`, [ntc.id]);
  let n2 = await one(`SELECT * FROM v_vehicle_owner_bill WHERE id=$1`, [ntc.id]);
  check('individual → 1%', [n2.tds_pct, n2.tds, n2.payable], ['1.000', '300.00', '2700.00']);
  await db.query(`UPDATE vendors SET tds_declaration_194c = true WHERE id=$1`, [V2]);
  await db.query(`SELECT vehicle_owner_bill_refresh($1)`, [ntc.id]);
  n2 = await one(`SELECT * FROM v_vehicle_owner_bill WHERE id=$1`, [ntc.id]);
  check('194C(6) declaration → NIL, as a fact not an absence', [n2.tds_pct, n2.tds, n2.payable], ['0.000', '0.00', '3000.00']);
  await db.query(`UPDATE vendors SET pan_no = NULL, tds_declaration_194c = false WHERE id=$1`, [V2]);
  await db.query(`SELECT vehicle_owner_bill_refresh($1)`, [ntc.id]);
  check('no PAN → 20%', (await one(`SELECT tds_pct FROM vehicle_owner_bills WHERE id=$1`, [ntc.id])).tds_pct, '20.000');

  console.log('\nTHE DESK ADJUSTS, THE BILL FOLLOWS');
  await db.query(`UPDATE vehicle_owner_bills SET adjustments = '[{"side":"EXPENSE","amount":1000,"label":"damage"}]'::jsonb WHERE id=$1`, [ar.id]);
  await db.query(`SELECT vehicle_owner_bill_refresh($1)`, [ar.id]);
  const ar2 = await one(`SELECT * FROM v_vehicle_owner_bill WHERE id=$1`, [ar.id]);
  check('a deduction lowers the balance', ar2.payable, '11960.00');
  check('…and the margin is untouched', ar2.margin, '24000.00');

  console.log('\nREBUILDS ARE SAFE, AND THE LORRY BUILDER LEAVES MARKET BILLS ALONE');
  await db.query(`SELECT vehicle_owner_bills_build('2026-06-20'::date, 'test')`);
  check('the lorry-bill clean-up does not delete market bills',
    (await one(`SELECT count(*)::int n FROM vehicle_owner_bills WHERE class_key='MARKET'`)).n, 2);
  const b2 = await one(`SELECT * FROM market_partner_bills_build('2026-06-20'::date, 'test')`);
  check('rebuild: nothing new, two refreshed', [b2.created, b2.refreshed, b2.skipped], [0, 2, 0]);
  // A POD date corrected out of the fortnight empties the NTC bill — it goes.
  await db.query(`UPDATE bazaar_settlements SET pod_verified_at = '2026-07-03' WHERE load_id='LD-30850'`);
  await db.query(`SELECT market_partner_bills_build('2026-06-20'::date, 'test')`);
  check('an emptied partner draft is dropped', (await one(`SELECT count(*)::int n FROM vehicle_owner_bills WHERE bill_no='MB-NTC-JUN-H2-2026'`)).n, 0);
  await db.query(`SELECT market_partner_bills_build('2026-07-02'::date, 'test')`);
  check('…and appears in the fortnight it moved to', (await one(`SELECT count(*)::int n FROM vehicle_owner_bills WHERE bill_no='MB-NTC-JUL-H1-2026'`)).n, 1);

  console.log('\nAPPROVE, THEN PAY, THEN LOCKED');
  check('approve with a rate on file passes',
    await err(() => db.query(`UPDATE vehicle_owner_bills SET status='APPROVED', approved_by='owner', locked_at=now(), locked_by='owner' WHERE id=$1`, [ar.id])), null);
  check('the payment can be recorded on the locked bill',
    await err(() => db.query(`UPDATE vehicle_owner_bills SET pay_voucher_id = gen_random_uuid(), paid_amount = 11960, paid_at = now(), paid_by='owner' WHERE id=$1`, [ar.id])), null);
  check('…but the numbers cannot move (P0411)',
    await err(() => db.query(`UPDATE vehicle_owner_bills SET partner_freight = 1 WHERE id=$1`, [ar.id])), 'P0411');
  const b3 = await one(`SELECT * FROM market_partner_bills_build('2026-06-20'::date, 'test')`);
  check('a rebuild steps around the locked bill', b3.skipped, 1);
  check('…and its numbers stand', (await one(`SELECT payable FROM vehicle_owner_bills WHERE id=$1`, [ar.id])).payable, '11960.00');

  console.log('\nBILL NUMBERS');
  check('MB prefix, initials, fortnight', (await one(`SELECT market_bill_no('ASSAM ROADWAYS', '2026-06-16') n`)).n, 'MB-AR-JUN-H2-2026');
  check('three-word firm', (await one(`SELECT market_bill_no('M/S NORTH EAST CARRIERS', '2026-04-01') n`)).n, 'MB-NEC-APR-H1-2026');
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
