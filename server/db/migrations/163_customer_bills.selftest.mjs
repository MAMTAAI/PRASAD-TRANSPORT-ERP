// server/db/migrations/163_customer_bills.selftest.mjs
//   MIGTEST_PG=… MIGTEST_SCHEMA=…/prod_schema.sql.gz npm run migrate:selftest163
// ─────────────────────────────────────────────────────────────────────────────
// What must hold before this ships:
//   · every spelling of a customer resolves to one master; an unknown one to NULL
//   · branches are learned from trips with the oil company's own code
//   · one bill per customer × books × cycle; fortnight for oil companies,
//     month for a contract customer; trips under their branch
//   · each trip carries one flag from what the pipeline wrote on it —
//     PAID / SHORT / PENDING / MISSING / UNPRICED — and the bill's counts follow
//   · revenue a legacy bill already posted is never counted again
//   · a raised bill freezes its numbers, keeps taking receipts, refuses an
//     unpriced raise (P0416) and a blind edit (P0415)
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ADMIN = process.env.MIGTEST_PG;
const SCHEMA = process.env.MIGTEST_SCHEMA;
if (!ADMIN || !SCHEMA) {
  console.log('\n⏭  MIGTEST_PG / MIGTEST_SCHEMA not set — skipping the migration 163 selftest.\n');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = 'pt_mig163_test';
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
  console.log('\nPRODUCTION SCHEMA (through 159) + 160–163');
  for (const st of splitSql(schemaSql)) { try { await db.query(st); } catch { /* PostGIS */ } }
  await db.query('SET search_path = public');
  const PT = (await one(`INSERT INTO companies (company_name) VALUES ('M/S PRASAD TRANSPORT') RETURNING id`)).id;
  const JE = (await one(`INSERT INTO companies (company_name) VALUES ('M/S JAISWAL ENTERPRISE') RETURNING id`)).id;
  // history as production has it: the master and the trips' spellings
  const IOCL = (await one(`INSERT INTO customers (customer_name, customer_code, gst_no) VALUES ('INDIAN OIL CORPORATION LTD', '11024699', '18AAACI1681G1ZO') RETURNING id`)).id;
  const HPCL = (await one(`INSERT INTO customers (customer_name, customer_code) VALUES ('HINDUSTAN PETROLEUM CORPORATION LIMITED', '27050901') RETURNING id`)).id;
  const AGI  = (await one(`INSERT INTO customers (customer_name) VALUES ('AADHAR GREEN  INDUSTRIES LLP') RETURNING id`)).id;
  const trip = async (o) => (await db.query(`
    INSERT INTO trips (trip_code, vehicle_no, status, operating_company, customer_name, unloading_location,
                       loading_date, unloading_date, loaded_qty, rtkm, billed_amount, shortage_penalty, tds_amount,
                       received_amount, iocl_bill_no, total_expense)
    VALUES ($1,$2,'COMPLETED',$3,$4,$5,$6::date,$7::date,$8,$9,$10,$11,$12,$13,$14,0) RETURNING id`,
    [o.code, o.veh ?? 'AS 26C 9814', o.co ?? 'M/S PRASAD TRANSPORT', o.cust, o.loc, o.ld, o.ud ?? o.ld,
     o.qty ?? 40, o.rtkm ?? 618.3, o.billed ?? 0, o.penalty ?? 0, o.tds ?? 0, o.received ?? 0, o.iocl ?? null])).rows[0].id;

  // IOCL, Jun H2, Prasad books: paid, short, pending, missing, unpriced
  const T_PAID   = await trip({ code: 'PT00433', cust: 'INDIAN OIL CORPORATION LTD', loc: 'ZC7A01 -Agartala AFS 7A01', ld: '2026-06-10', ud: '2026-06-16', billed: 70961.11, tds: 1448.18, received: 70961.12, iocl: '11024699AS26045' });
  const T_SHORT  = await trip({ code: 'PT00541', cust: 'iocl', loc: 'NISIKA ROAD LINE', ld: '2026-06-27', billed: 150136.56, penalty: 1515, tds: 2972.43, received: 145649.13, iocl: '11024699AS26074', veh: 'AS 26C 0407' });
  const T_PEND   = await trip({ code: 'PT00552', cust: 'Indian oil corporation', loc: 'ZC7A04 - Chabua AFS', ld: '2026-06-30', billed: 97497.66, iocl: '11024699AS26079', veh: 'AS 26C 9803' });
  const T_MISS   = await trip({ code: 'PT00538', cust: 'INDIAN OIL CORPORATION LTD', loc: 'LPG  BP  NORTH  GUWAHATI  (7B03)', ld: '2026-06-25', ud: '2026-06-28', billed: 82899.50, veh: 'AS 26C 5106' });
  const T_UNPR   = await trip({ code: 'PT00560', cust: 'INDIAN OIL CORPORATION LTD', loc: 'ZC7A01 -Agartala AFS 7A01', ld: '2026-06-29', billed: 0, veh: 'AS 26C 9807' });
  // a trip already on a legacy company bill: revenue posted before
  const T_LEGACY = await trip({ code: 'PT00482', cust: 'INDIAN OIL CORPORATION LTD', loc: 'ZC7A01 -Agartala AFS 7A01', ld: '2026-06-17', ud: '2026-06-27', billed: 71619.05, tds: 1461.61, received: 71619.05, iocl: '11024699AS26058', veh: 'AS 26C 9806' });
  // IOCL in Gautam's books, same fortnight → its own bill
  await trip({ code: 'GP00010', cust: 'IOCL', co: 'M/S GAUTAM PRASAD', loc: '347559 NENGSKIM FUEL STATION', ld: '2026-06-20', billed: 12000, received: 12000, veh: 'AS 26C 5103' });
  // HPCL variants, Jaiswal books, next fortnight
  await trip({ code: 'JE00050', cust: 'hpcl', co: 'M/S JAISWAL ENTERPRISE', loc: 'Guwahati AFS', ld: '2026-07-02', billed: 0, veh: 'NL 01Q 4461' });
  await trip({ code: 'JE00051', cust: 'HINDUATAN PETROLEUM CORPORATION LTD', co: 'M/S JAISWAL ENTERPRISE', loc: 'Guwahati AFS', ld: '2026-07-03', billed: 50000, veh: 'NL 01Q 4461' });
  // contract customer, monthly
  await trip({ code: 'PT00600', cust: 'AADHAR GREEN  INDUSTRIES LLP', loc: 'NRL Numaligarh', ld: '2026-06-05', qty: 20, billed: 30000, veh: 'AS 26C 9801' });
  await trip({ code: 'PT00601', cust: 'AADHAR GREEN  INDUSTRIES LLP', loc: 'NRL Numaligarh', ld: '2026-06-22', qty: 20, billed: 30000, veh: 'AS 26C 9801' });
  // a trip with no customer at all
  await trip({ code: 'PT00700', cust: null, loc: 'IMPHAL DEPOT', ld: '2026-06-18', billed: 40000 });
  // the legacy bill that already posted PT00482
  const LB = (await one(`INSERT INTO company_bills (bill_no, customer_name, total_net) VALUES ('INV-IND-ZC7A01-0007', 'INDIAN OIL CORPORATION LTD', 71619.05) RETURNING id`)).id;
  await db.query(`UPDATE trips SET linked_bill_id = $1, billing_status = 'BILLED' WHERE id = $2`, [LB, T_LEGACY]);
  // IOCL issued bills for Jun H2 (a line in the period) → a trip in none of them is MISSING
  await db.query(`INSERT INTO iocl_bill_runs (run_id, pdf_path, pdf_name, pdf_sha256, tool_version, window_from, window_to) VALUES ('11111111-1111-1111-1111-111111111111', '/x/x.pdf', 'x.pdf', repeat('a', 64), 'test', '2026-06-16', '2026-06-30')`);
  await db.query(`INSERT INTO iocl_bill_lines (line_uid, run_id, group_uid, bill_no, bill_date, reverse_charge, s_no, invoice_no, line_date, vehicle_no_raw, vehicle_norm, ship_to_raw, gross_amt, penalty_amt, igst_amt, cgst_amt, sgst_amt, page_no, source_line)
                  VALUES ('L1', '11111111-1111-1111-1111-111111111111', 'G1', '0011024699', '2026-07-05', true, 1, '11024699AS26045', '2026-06-16', 'AS26C9814', 'AS26C9814', 'ZC7A01 - Agartala AFS', 70961.11, 0, 0, 0, 0, 1, 'x')`);

  for (const f of ['160_vehicle_owner_bills.sql', '161_vehicle_ownership_rule.sql', '162_market_partner_bills.sql', '163_customer_bills.sql']) {
    await db.query(readFileSync(path.join(here, f), 'utf8'));
  }
  check('160 → 163 apply on the production schema', true, true);
  await db.query(readFileSync(path.join(here, '163_customer_bills.sql'), 'utf8'));
  check('163 is re-runnable', true, true);

  console.log('\nONE NAME, HOWEVER TYPED');
  const cof = async (n) => (await one('SELECT customer_of($1) c', [n])).c;
  check('the master name resolves', await cof('INDIAN OIL CORPORATION LTD'), IOCL);
  check('"iocl" resolves (backfilled alias)', await cof('iocl'), IOCL);
  check('"Indian oil corporation" resolves', await cof('Indian oil corporation'), IOCL);
  check('the misspelt HPCL resolves', await cof('HINDUATAN PETROLEUM CORPORATION LTD'), HPCL);
  check('"hpcl" resolves', await cof('hpcl'), HPCL);
  check('a name nobody mapped is NULL, not a guess', await cof('SOME NEW COMPANY'), null);
  check('the master got its type from what it is', (await one('SELECT customer_type, bill_cycle FROM customers WHERE id=$1', [IOCL])), { customer_type: 'OIL_COMPANY', bill_cycle: 'FORTNIGHT' });
  check('…the contract customer monthly', (await one('SELECT customer_type, bill_cycle, tds_pct_deducted FROM customers WHERE id=$1', [AGI])), { customer_type: 'CONTRACT', bill_cycle: 'MONTH', tds_pct_deducted: '0.000' });

  console.log('\nBRANCHES, LEARNED FROM THE TRIPS');
  const br = (await db.query(`SELECT branch_code, branch_name, source FROM customer_branches WHERE customer_id=$1 ORDER BY branch_name`, [IOCL])).rows;
  check('IOCL branches learned', br.length, 5);
  check('the AFS code is read', br.find((b) => /Agartala/.test(b.branch_name)).branch_code, 'ZC7A01');
  check('the LPG plant code in brackets is read', br.find((b) => /GUWAHATI/.test(b.branch_name)).branch_code, '7B03');
  check('the retail outlet number is read', br.find((b) => /NENGSKIM/.test(b.branch_name)).branch_code, '347559');
  check('…all unconfirmed until a person says', br.every((b) => b.source === 'LEARNED'), true);

  console.log('\nEVERY TRIP, ONE FLAG');
  const flag = async (id) => (await one('SELECT flag FROM v_customer_trip_recon WHERE trip_id=$1', [id])).flag;
  check('received in full → PAID', await flag(T_PAID), 'PAID');
  check('penalty deducted → SHORT', await flag(T_SHORT), 'SHORT');
  check('in their bill, no money yet → PENDING', await flag(T_PEND), 'PENDING');
  check('IOCL billed the fortnight, this trip in none → MISSING', await flag(T_MISS), 'MISSING');
  check('no amount → UNPRICED', await flag(T_UNPR), 'UNPRICED');
  check('a trip with no customer has no customer', (await one('SELECT customer_id FROM v_customer_trip_recon WHERE trip_code=$1', ['PT00700'])).customer_id, null);

  console.log('\nBUILD — one bill per customer × books × cycle');
  const b1 = await one(`SELECT * FROM customer_bills_build('2026-06-20'::date, 'test')`);
  check('three bills for the fortnight/month containing 20 Jun', b1.created, 3);
  const bills = (await db.query(`SELECT * FROM v_customer_bill ORDER BY bill_no`)).rows;
  check('bill numbers', bills.map((b) => b.bill_no), ['CB-AGIL-JUN-2026', 'CB-IOCL-JUN-H2-2026', 'CB-IOCL-JUN-H2-2026-PT']);
  const ioc = bills.find((b) => b.bill_no === 'CB-IOCL-JUN-H2-2026-PT');   // books sort JE < PT: Prasad carries the tail
  check('IOCL Prasad: six trips', ioc.trips, 6);
  check('…in four branches', ioc.branches, 4);
  check('…gross summed', ioc.gross, '473113.88');
  check('…penalty', ioc.shortage_penalty, '1515.00');
  check('…TDS as IOCL actually deducted', ioc.tds, '5882.22');
  check('…received as the pipeline recorded', ioc.received, '288229.30');
  check('…flags counted', [ioc.paid_count, ioc.short_count, ioc.pending_count, ioc.missing_count, ioc.unpriced_count], [2, 1, 1, 1, 1]);
  check('…missing rupees named', ioc.missing_amount, '82899.50');
  check('…legacy revenue not counted again', [ioc.revenue_posted_legacy, ioc.revenue_to_post], ['71619.05', '401494.83']);
  check('…GST memo 5% RCM', ioc.gst_memo, '23655.69');
  check('…branch blocks with the trips under them', ioc.lines.map((l) => l.branch_code ?? l.branch_name), ['ZC7A01', 'NISIKA ROAD LINE', '7B03', 'ZC7A04']   /* first trip date, then name */);
  check('…each trip carries its flag', ioc.lines[0].trips.map((t) => t.flag), ['PAID', 'PAID', 'UNPRICED']);
  const gp = bills.find((b) => b.bill_no === 'CB-IOCL-JUN-H2-2026');
  check('IOCL in Jaiswal books is its own bill', [gp.trips, gp.gross], [1, '12000.00']);
  const agi = bills.find((b) => b.bill_no === 'CB-AGIL-JUN-2026');
  check('the contract customer got the whole month', [agi.cycle_kind, agi.trips, agi.gross], ['MONTH', 2, '60000.00']);
  check('…with no TDS', agi.tds, '0.00');
  check('trips point at their bill', (await one('SELECT count(*)::int n FROM trips WHERE customer_bill_id=$1', [ioc.id])).n, 6);
  check('the no-customer trip is on no bill', (await one(`SELECT customer_bill_id FROM trips WHERE trip_code='PT00700'`)).customer_bill_id, null);
  check('…and the mapping desk lists it', (await one(`SELECT trips FROM v_customer_mapping_audit WHERE finding='NO_CUSTOMER'`)).trips, 1);
  check('…and the unpriced', (await one(`SELECT trips FROM v_customer_mapping_audit WHERE finding='UNPRICED' AND subject LIKE 'INDIAN%'`)).trips, 1);

  console.log('\nHPCL, JAISWAL BOOKS, NEXT FORTNIGHT');
  await db.query(`SELECT customer_bills_build('2026-07-02'::date, 'test')`);
  const hp = await one(`SELECT * FROM v_customer_bill WHERE bill_no LIKE 'CB-HPCL-JUL-H1-2026%'`);
  check('two spellings → one HPCL bill', hp.trips, 2);
  check('…books = Jaiswal', hp.company_name, 'M/S JAISWAL ENTERPRISE');

  console.log('\nRAISE, LOCK, RECEIPTS STILL MOVE');
  check('raising with an unpriced trip is refused (P0416)',
    await err(() => db.query(`UPDATE customer_bills SET status='RAISED', locked_at=now(), raised_by='owner' WHERE id=$1`, [ioc.id])), 'P0416');
  await db.query(`UPDATE trips SET billed_amount = 70961.11 WHERE id=$1`, [T_UNPR]);
  await db.query(`SELECT customer_bill_refresh($1)`, [ioc.id]);
  check('priced → unpriced count clears', (await one('SELECT unpriced_count FROM customer_bills WHERE id=$1', [ioc.id])).unpriced_count, 0);
  check('now it raises', await err(() => db.query(`UPDATE customer_bills SET status='RAISED', locked_at=now(), raised_by='owner', locked_by='owner' WHERE id=$1`, [ioc.id])), null);
  check('a raised bill refuses a number change (P0415)',
    await err(() => db.query(`UPDATE customer_bills SET gross = 1 WHERE id=$1`, [ioc.id])), 'P0415');
  // money arrives on the pending trip → the raised bill follows
  await db.query(`UPDATE trips SET received_amount = 97497.66 WHERE id=$1`, [T_PEND]);
  await db.query(`SELECT customer_bill_refresh($1)`, [ioc.id]);
  const ioc2 = await one('SELECT * FROM v_customer_bill WHERE id=$1', [ioc.id]);
  check('…received moves on the locked bill', ioc2.received, '385726.96');
  check('…status follows the money', ioc2.status, 'PART_PAID');
  check('…gross stays what was signed', ioc2.gross, '544074.99');
  check('a rebuild steps around it', (await one(`SELECT skipped FROM customer_bills_build('2026-06-20'::date, 'test')`)).skipped, 1);
  check('a reopen needs a reason',
    await err(() => db.query(`UPDATE customer_bills SET locked_at=NULL, status='STAFF_REVIEWED' WHERE id=$1`, [ioc.id])), 'P0415');
  check('…and passes with one',
    await err(() => db.query(`UPDATE customer_bills SET locked_at=NULL, locked_by=NULL, status='STAFF_REVIEWED', reopen_reason='rate galat tha', reopened_by='owner', reopened_at=now() WHERE id=$1`, [ioc.id])), null);
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
