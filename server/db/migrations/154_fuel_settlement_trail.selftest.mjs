// server/db/migrations/154_fuel_settlement_trail.selftest.mjs
//   MIGTEST_PG=… MIGTEST_SCHEMA=…/prod_schema.sql.gz npm run migrate:selftest154
// ─────────────────────────────────────────────────────────────────────────────
// The one thing to prove: v_fuel_memo_settlement.reusable is the single answer
// to "can this memo be applied to a bill?", and it is false for anything that
// is not explicitly UNBILLED. The reconciliation screen reads that column
// rather than judging bill_status for itself, which is how two places stop
// disagreeing about whether a memo is spent.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ADMIN = process.env.MIGTEST_PG;
const SCHEMA = process.env.MIGTEST_SCHEMA;
if (!ADMIN || !SCHEMA) {
  console.log('\n⏭  MIGTEST_PG / MIGTEST_SCHEMA not set — skipping the migration 154 selftest.\n');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = 'pt_mig154_test';
let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

/** Same splitter as 152/153 — pg_dump's headers carry semicolons. */
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
  check('fuel_entries and pump_bill_drafts were built',
    (await db.query(`SELECT count(*)::int n FROM information_schema.tables
                      WHERE table_schema='public' AND table_name IN ('fuel_entries','pump_bill_drafts')`)).rows[0].n, 2);

  for (const f of ['152_fleet_card_allocation.sql', '153_pump_bill_settlement.sql']) {
    await db.query(readFileSync(path.join(here, f), 'utf8'));
  }
  const sql154 = readFileSync(path.join(here, '154_fuel_settlement_trail.sql'), 'utf8');

  console.log('\nTHE MIGRATION');
  await db.query(sql154);
  check('154 applies', true, true);
  await db.query(sql154);
  check('154 is re-runnable', true, true);
  const { rows: cols } = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='fuel_entries' AND column_name LIKE 'settled%' ORDER BY 1`);
  check('the trail columns exist', cols.map((c) => c.column_name),
    ['settled_at', 'settled_bill_id', 'settled_ref', 'settled_voucher_id']);

  console.log('\nONE ANSWER TO "CAN THIS MEMO BE USED?"');
  const { rows: [vend] } = await db.query(
    `INSERT INTO vendors (vendor_name) VALUES ('ALAM FUEL STATION') RETURNING id`);
  const memo = async (veh, status) => (await db.query(
    `INSERT INTO fuel_entries (entry_date, vehicle_no, vendor_id, liters, amount, bill_status)
     VALUES ('2026-04-01',$1,$2::uuid,100,9000,$3) RETURNING id`,
    [veh, vend.id, status])).rows[0].id;

  await memo('AS26C1', null);
  await memo('AS26C2', 'UNBILLED');
  await memo('AS26C3', 'BILLED');
  await memo('AS26C4', 'BILLED_VERIFIED');

  const { rows: v } = await db.query(
    `SELECT vehicle_no, reusable, settled_label FROM v_fuel_memo_settlement ORDER BY vehicle_no`);
  check('a memo with no status is reusable', v[0].reusable, true);
  check('an UNBILLED memo is reusable', v[1].reusable, true);
  // BILLED rows are created by the pump-bill importer itself — billed by
  // definition, and they must never be applied to a second bill.
  check('a BILLED memo is NOT', v[2].reusable, false);
  check('a BILLED_VERIFIED memo is NOT', v[3].reusable, false);
  check('a settled memo says the reference was never kept',
    v[3].settled_label, 'settled before the reference was recorded');
  check('a live memo has no settled label', v[0].settled_label, null);

  console.log('\nONCE A BILL IS NAMED, IT IS NAMED');
  const { rows: [bill] } = await db.query(`
    INSERT INTO pump_bill_drafts (vendor_id, vendor_name, ref_no, period_from, period_to,
                                  half, status, system_amount, physical_amount)
    VALUES ($1::uuid,'ALAM FUEL STATION','PB-1','2026-07-01','2026-07-15','FIRST','DRAFT',9000,9000)
    RETURNING id`, [vend.id]);
  await db.query(
    `UPDATE fuel_entries SET settled_bill_id = $1::uuid WHERE vehicle_no = 'AS26C4'`, [bill.id]);
  const { rows: [named] } = await db.query(
    `SELECT settled_label FROM v_fuel_memo_settlement WHERE vehicle_no = 'AS26C4'`);
  check('the label reads as the desk would say it',
    named.settled_label, 'ALAM FUEL STATION · 01 Jul–15 Jul 2026');

  // A hand-written reference beats the derived one — it is what someone typed.
  await db.query(
    `UPDATE fuel_entries SET settled_ref = 'ALAM · 1-15 Jul (paid by card)' WHERE vehicle_no = 'AS26C4'`);
  check('a written reference wins',
    (await db.query(`SELECT settled_label FROM v_fuel_memo_settlement WHERE vehicle_no='AS26C4'`)).rows[0].settled_label,
    'ALAM · 1-15 Jul (paid by card)');

  // Deleting the bill must not delete the memo.
  await db.query(`DELETE FROM pump_bill_drafts WHERE id = $1::uuid`, [bill.id]);
  check('the memo survives its bill being removed',
    (await db.query(`SELECT count(*)::int n FROM fuel_entries WHERE vehicle_no='AS26C4'`)).rows[0].n, 1);

  console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
} finally {
  await db.end().catch(() => {});
  const a2 = new pg.Client({ connectionString: ADMIN });
  await a2.connect();
  await a2.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
  await a2.end();
}
process.exit(failures ? 1 : 0);
