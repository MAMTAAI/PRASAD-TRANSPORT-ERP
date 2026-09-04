// server/db/migrations/155_fortnight_bill_lock.selftest.mjs
//   MIGTEST_PG=… MIGTEST_SCHEMA=…/prod_schema.sql.gz npm run migrate:selftest155
// ─────────────────────────────────────────────────────────────────────────────
// The lock is the point. A settled fortnight sits under a posted voucher, so
// its figures must not be able to move — not from a screen, not from an
// endpoint, and not from somebody running an UPDATE by hand at eleven at night
// to "just fix one number". That is why it is a trigger and why it is tested
// with raw SQL rather than through the API.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ADMIN = process.env.MIGTEST_PG;
const SCHEMA = process.env.MIGTEST_SCHEMA;
if (!ADMIN || !SCHEMA) {
  console.log('\n⏭  MIGTEST_PG / MIGTEST_SCHEMA not set — skipping the migration 155 selftest.\n');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = 'pt_mig155_test';
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
  console.log('\nPRODUCTION SCHEMA + 152→155');
  for (const st of splitSql(schemaSql)) { try { await db.query(st); } catch { /* PostGIS */ } }
  await db.query('SET search_path = public');
  for (const f of ['152_fleet_card_allocation.sql', '153_pump_bill_settlement.sql',
                   '154_fuel_settlement_trail.sql', '155_fortnight_bill_lock.sql']) {
    await db.query(readFileSync(path.join(here, f), 'utf8'));
  }
  check('152–155 apply together', true, true);
  await db.query(readFileSync(path.join(here, '155_fortnight_bill_lock.sql'), 'utf8'));
  check('155 is re-runnable', true, true);

  console.log('\nTHE INVOICE NUMBER');
  const inv = async (v, d) => (await db.query(`SELECT pump_invoice_no($1, $2::date) n`, [v, d])).rows[0].n;
  check('a pump and a fortnight give one reference',
    await inv('B N FILLING STATION', '2026-04-08'), 'BNFS-APR-H1-2026');
  check('the second half says so',
    await inv('B N FILLING STATION', '2026-04-20'), 'BNFS-APR-H2-2026');
  check('the same fortnight always gives the same number',
    await inv('B N FILLING STATION', '2026-04-01') === await inv('B N FILLING STATION', '2026-04-15'), true);
  check('a different pump is a different reference',
    await inv('ALAM FUEL STATION', '2026-04-08'), 'AFS-APR-H1-2026');

  // ── fixtures ─────────────────────────────────────────────────────────────
  const { rows: [vend] } = await db.query(
    `INSERT INTO vendors (vendor_name, opening_balance) VALUES ('B N FILLING STATION', 0) RETURNING id`);
  // A BILL IS APPROVED IF AND ONLY IF IT CARRIES A VOUCHER — migration 073's
  // pump_draft_approved_has_voucher. That constraint caught a real bug in
  // /pump-bill-settle while this test was being written: a fully disputed
  // fortnight would have been inserted APPROVED with no posting behind it.
  const mkBill = async (from, to, amt, disputed, locked) => (await db.query(`
    INSERT INTO pump_bill_drafts
      (vendor_id, vendor_name, ref_no, invoice_no, period_from, period_to, half, status,
       system_amount, physical_amount, disputed_amount, payable_amount,
       voucher_id, approved_at, locked_at)
    VALUES ($1::uuid,'B N FILLING STATION',$2, pump_invoice_no('B N FILLING STATION',$3::date),
            $3::date,$4::date,'FIRST','APPROVED',$5,$5,$6,$7,
            gen_random_uuid(), now(), CASE WHEN $8 THEN now() END)
    RETURNING id, invoice_no`,
    [vend.id, `R-${from}`, from, to, amt, disputed, amt - disputed, locked])).rows[0];

  console.log('\nTHE LOCK');
  const locked = await mkBill('2026-04-01', '2026-04-15', 100000, 5000, true);
  check('a settled fortnight carries its invoice number', locked.invoice_no, 'BNFS-APR-H1-2026');

  const tryIt = async (sql, params) => {
    try { await db.query(sql, params); return null; } catch (e) { return e.code; }
  };
  check('its amount cannot be changed',
    await tryIt(`UPDATE pump_bill_drafts SET physical_amount = 1 WHERE id = $1::uuid`, [locked.id]),
    'P0408');
  check('nor what is disputed',
    await tryIt(`UPDATE pump_bill_drafts SET disputed_amount = 0 WHERE id = $1::uuid`, [locked.id]),
    'P0408');
  check('nor its period',
    await tryIt(`UPDATE pump_bill_drafts SET period_to = '2026-04-20' WHERE id = $1::uuid`, [locked.id]),
    'P0408');
  // `lines` defaults to [], so setting it to [] is not a change and the trigger
  // is right to allow it. The change has to be a real one to be refused.
  check('nor its lines',
    await tryIt(`UPDATE pump_bill_drafts SET lines = '[{"sno":1}]'::jsonb WHERE id = $1::uuid`, [locked.id]),
    'P0408');
  check('and it cannot be deleted',
    await tryIt(`DELETE FROM pump_bill_drafts WHERE id = $1::uuid`, [locked.id]),
    'P0408');
  // A note is not a figure — the desk must still be able to write on it.
  check('but a note may still be added',
    await tryIt(`UPDATE pump_bill_drafts SET notes = 'paid by card 12 Apr' WHERE id = $1::uuid`, [locked.id]),
    null);

  console.log('\nUNLOCKING IS DELIBERATE');
  // The hole this closes: one statement that unlocks AND edits. The guard tests
  // OLD.locked_at, so the figures are frozen for that statement whatever it
  // does to the lock itself.
  check('unlocking and editing in one statement is refused',
    await tryIt(`UPDATE pump_bill_drafts SET locked_at = NULL, physical_amount = 1
                  WHERE id = $1::uuid`, [locked.id]), 'P0408');
  check('unlocking is allowed',
    await tryIt(`UPDATE pump_bill_drafts SET locked_at = NULL WHERE id = $1::uuid`, [locked.id]), null);
  check('…and then the figures move again',
    await tryIt(`UPDATE pump_bill_drafts SET physical_amount = 99 WHERE id = $1::uuid`, [locked.id]), null);
  await db.query(`UPDATE pump_bill_drafts SET locked_at = now(), physical_amount = 100000 WHERE id = $1::uuid`, [locked.id]);

  console.log('\nONE SETTLED BILL PER PUMP PER FORTNIGHT');
  let dup = null;
  try { await mkBill('2026-04-01', '2026-04-15', 50000, 0, true); } catch (e) { dup = e.code; }
  check('the same fortnight cannot be settled twice', dup, '23505');
  // A different fortnight is fine.
  const second = await mkBill('2026-04-16', '2026-04-30', 80000, 0, true);
  check('the next fortnight settles normally', second.invoice_no, 'BNFS-APR-H2-2026');
  // An UNLOCKED draft for a settled period is still allowed — that is how a
  // restatement is prepared before it replaces the locked one.
  check('an unlocked draft may still be prepared',
    await tryIt(`INSERT INTO pump_bill_drafts
      (vendor_id, vendor_name, ref_no, period_from, period_to, half, status, system_amount, physical_amount)
      VALUES ($1::uuid,'B N FILLING STATION','R-redo','2026-04-01','2026-04-15','FIRST','CANCELLED',1,1)`,
      [vend.id]), null);

  console.log('\nWHAT THE PUMP IS OWED');
  await db.query(`
    INSERT INTO vendor_txns (vendor_id, vendor_name, txn_date, txn_type, amount)
    VALUES ($1::uuid,'B N FILLING STATION','2026-04-16','BILL_RECEIVED',95000),
           ($1::uuid,'B N FILLING STATION','2026-05-02','PAYMENT_GIVEN',60000),
           ($1::uuid,'B N FILLING STATION','2026-05-03','ADJUSTMENT',500)`, [vend.id]);
  const { rows: [o] } = await db.query(
    `SELECT billed::float, paid::float, adjustments::float, adjustment_count,
            outstanding::float, settled_fortnights
       FROM v_pump_outstanding WHERE vendor_id = $1::uuid`, [vend.id]);
  // The type names are the schema's: PAYMENT_GIVEN, not PAYMENT. Reading the
  // wrong name returns 0 rather than an error, so every pump would have looked
  // entirely unpaid.
  check('billed and paid come off the khata', [o.billed, o.paid], [95000, 60000]);
  check('the outstanding is the difference', o.outstanding, 35000);
  // An ADJUSTMENT could go either way, so it is shown rather than assumed into
  // the balance.
  check('an adjustment is reported, not silently added',
    [o.adjustments, o.adjustment_count, o.outstanding], [500, 1, 35000]);
  check('and it counts the settled fortnights', o.settled_fortnights, 2);

  console.log('\nTHE FORTNIGHT AS ONE LINE');
  const { rows: [v] } = await db.query(
    `SELECT invoice_no, bill_amount::float, disputed_amount::float, payable_amount::float, locked
       FROM v_pump_fortnight_bill WHERE id = $1::uuid`, [locked.id]);
  // 1,00,000 billed, 5,000 disputed — the pump is credited 95,000, not the bill.
  check('the payable is the bill less the dispute',
    [v.bill_amount, v.disputed_amount, v.payable_amount], [100000, 5000, 95000]);
  check('and it reports itself as locked', v.locked, true);

  console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
} finally {
  await db.end().catch(() => {});
  const a2 = new pg.Client({ connectionString: ADMIN });
  await a2.connect();
  await a2.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
  await a2.end();
}
process.exit(failures ? 1 : 0);
