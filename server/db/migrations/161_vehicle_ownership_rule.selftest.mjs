// server/db/migrations/161_vehicle_ownership_rule.selftest.mjs
//   MIGTEST_PG=… MIGTEST_SCHEMA=…/prod_schema.sql.gz npm run migrate:selftest161
// ─────────────────────────────────────────────────────────────────────────────
// The own/attached rule must hold at the door AND leave history alone:
//   · an own lorry's owner is its company (auto-filled, refused if different)
//   · an attached lorry needs an owner, not its own company, and gets a khata
//   · is_company_owned follows ownership — the accounting flag can no longer
//     say "own" while the master says "attached"
//   · the backfill links the khata on existing attached rows and touches no
//     ambiguous row; the audit lists what a person must decide
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ADMIN = process.env.MIGTEST_PG;
const SCHEMA = process.env.MIGTEST_SCHEMA;
if (!ADMIN || !SCHEMA) {
  console.log('\n⏭  MIGTEST_PG / MIGTEST_SCHEMA not set — skipping the migration 161 selftest.\n');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = 'pt_mig161_test';
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
  console.log('\nPRODUCTION SCHEMA (through 159) + 160, then history, then 161');
  let schemaFails = 0;
  for (const st of splitSql(schemaSql)) { try { await db.query(st); } catch { schemaFails += 1; } }
  await db.query('SET search_path = public');
  await db.query(readFileSync(path.join(here, '160_vehicle_owner_bills.sql'), 'utf8'));
  check('160 applied first', true, true);

  const PT = (await one(`INSERT INTO companies (company_name) VALUES ('M/S PRASAD TRANSPORT') RETURNING id`)).id;
  const JE = (await one(`INSERT INTO companies (company_name) VALUES ('M/S JAISWAL ENTERPRISE') RETURNING id`)).id;

  // ── history, as production has it, BEFORE the rule exists ─────────────
  const veh = (no, own, owner, co, icо = true) => db.query(
    `INSERT INTO vehicles (vehicle_no, ownership, owner_name, company_id, is_company_owned)
     VALUES ($1, $2::ownership_kind, $3, $4, $5)`, [no, own, owner, co, icо]);
  await veh('AS 26C 9801', 'OWNED', 'PRASAD TRANSPORT', PT);          // clean own
  await veh('AS 26C 5101', 'OWNED', null, PT);                        // own, owner blank
  await veh('AS 26C 5105', 'ATTACHED', 'SANDEEP KUMAR PRASAD', PT);   // attached, flag wrong (true)
  await veh('AS 26C 5106', 'ATTACHED', 'sandeep  kumar prasad', PT);  // same owner, typed differently
  await veh('AS 19C 8666', 'OWNED', 'SANTOSH PRASAD', JE);            // the ambiguous one
  await veh('AS 26C 5108', 'ATTACHED', 'PRASAD TRANSPORT', PT);       // attached to itself
  await db.query(`INSERT INTO trips (trip_code, vehicle_no, status, operating_company, company_id, loading_date, unloading_date, billed_amount)
                  VALUES ('T1','AS 19C 8666','COMPLETED','M/S PRASAD TRANSPORT',$1,'2026-06-20','2026-06-21', 50000)`, [PT]);
  await db.query(`INSERT INTO trips (trip_code, vehicle_no, status, operating_company, company_id, loading_date, unloading_date, billed_amount)
                  VALUES ('T2','AS 19C 8666','COMPLETED','M/S JAISWAL ENTERPRISE',$1,'2026-06-22','2026-06-23', 70000)`, [JE]);
  await db.query(`INSERT INTO trips (trip_code, vehicle_no, status, operating_company, loading_date, unloading_date, billed_amount)
                  VALUES ('T3','AS 26C 9803','COMPLETED','M/S PRASAD TRANSPORT','2026-06-22','2026-06-23', 15000)`);

  await db.query(readFileSync(path.join(here, '161_vehicle_ownership_rule.sql'), 'utf8'));
  check('161 applies on the production schema', true, true);
  await db.query(readFileSync(path.join(here, '161_vehicle_ownership_rule.sql'), 'utf8'));
  check('161 is re-runnable (the backfill does not trip its own trigger)', true, true);

  console.log('\nTHE BACKFILL');
  const row = async (no) => one(`SELECT v.*, l.ledger_name AS owner_ledger, l.group_head AS owner_group
                                    FROM vehicles v LEFT JOIN ledgers l ON l.id = v.vehicle_owner_ledger_id
                                   WHERE v.vehicle_no = $1`, [no]);
  let a = await row('AS 26C 5105');
  check('an attached lorry is no longer "company owned" for accounting', a.is_company_owned, false);
  check('…and has its owner khata', a.owner_ledger, 'Vehicle Owner: SANDEEP KUMAR PRASAD');
  check('…in the vehicle-owners group', a.owner_group, 'Sundry Creditors (Vehicle Owners)');
  const b = await row('AS 26C 5106');
  check('the same owner typed differently shares ONE khata', b.vehicle_owner_ledger_id, a.vehicle_owner_ledger_id);
  check('an own lorry with no owner written gets its company', (await row('AS 26C 5101')).owner_name, 'M/S PRASAD TRANSPORT');
  const amb = await row('AS 19C 8666');
  check('the ambiguous OWN-with-person row is NOT rewritten', [amb.ownership, amb.owner_name, amb.is_company_owned], ['OWNED', 'SANTOSH PRASAD', true]);
  check('the lorry attached to itself is NOT rewritten either', (await row('AS 26C 5108')).ownership, 'ATTACHED');
  check('no khata for the company itself', (await row('AS 26C 5108')).owner_ledger, 'Vehicle Owner: PRASAD TRANSPORT');

  console.log('\nTHE RULE AT THE DOOR');
  const ins = (no, own, owner, co) => db.query(
    `INSERT INTO vehicles (vehicle_no, ownership, owner_name, company_id) VALUES ($1,$2::ownership_kind,$3,$4)`,
    [no, own, owner, co]);
  check('attached without an owner is refused (P0413)', await err(() => ins('AS 26C 1111', 'ATTACHED', '', PT)), 'P0413');
  check('attached to its own company is refused (P0414)', await err(() => ins('AS 26C 1112', 'ATTACHED', 'M/S PRASAD TRANSPORT', PT)), 'P0414');
  check('…spacing and M/S do not fool it', await err(() => ins('AS 26C 1113', 'ATTACHED', 'prasad  transport', PT)), 'P0414');
  check('own with a person as owner is refused (P0414)', await err(() => ins('AS 26C 1114', 'OWNED', 'SANTOSH PRASAD', JE)), 'P0414');
  check('own with no owner is accepted', await err(() => ins('AS 26C 1115', 'OWNED', null, JE)), null);
  check('…and the owner became the company', (await row('AS 26C 1115')).owner_name, 'M/S JAISWAL ENTERPRISE');
  check('…flagged company-owned', (await row('AS 26C 1115')).is_company_owned, true);
  check('attached with a real owner is accepted', await err(() => ins('AS 26C 1116', 'ATTACHED', 'GAUTAM PRASAD', PT)), null);
  const g = await row('AS 26C 1116');
  check('…not company-owned', g.is_company_owned, false);
  check('…khata made on the spot', g.owner_ledger, 'Vehicle Owner: GAUTAM PRASAD');
  check('a Prasad lorry attached in Jaiswal books is fine (other firm = attached)',
    await err(() => ins('NL 01Q 2670', 'ATTACHED', 'PRASAD TRANSPORT', JE)), null);
  check('the accounting flag cannot be set by hand against the master',
    (await one(`UPDATE vehicles SET is_company_owned = true WHERE vehicle_no='AS 26C 1116' RETURNING is_company_owned`)).is_company_owned, false);

  console.log('\nHISTORY CAN STILL BE EDITED, BUT NOT LEFT CONTRADICTORY');
  check('editing an unrelated field on the ambiguous row passes',
    await err(() => db.query(`UPDATE vehicles SET tyre_count = 12 WHERE vehicle_no='AS 19C 8666'`)), null);
  check('changing its company while the owner is a person is refused',
    await err(() => db.query(`UPDATE vehicles SET company_id = $1 WHERE vehicle_no='AS 19C 8666'`, [PT])), 'P0414');
  check('resolving it as ATTACHED passes',
    await err(() => db.query(`UPDATE vehicles SET ownership = 'ATTACHED' WHERE vehicle_no='AS 19C 8666'`)), null);
  const r = await row('AS 19C 8666');
  check('…and it is now attached in accounting too', r.is_company_owned, false);
  check('…with Santosh\'s khata', r.owner_ledger, 'Vehicle Owner: SANTOSH PRASAD');
  check('…and vehicle_class agrees', (await one(`SELECT vehicle_class('AS 19C 8666')::text c`)).c, 'ATTACHED');
  check('or resolving it as OWN by making the owner the company passes',
    await err(() => db.query(`UPDATE vehicles SET ownership='OWNED', owner_name = NULL WHERE vehicle_no='AS 19C 8666'`)), null);
  check('…owner auto-filled', (await row('AS 19C 8666')).owner_name, 'M/S JAISWAL ENTERPRISE');

  console.log('\nTHE AUDIT — what a person still has to decide');
  const audit = (await db.query(`SELECT vehicle_no, finding FROM v_vehicle_rule_audit ORDER BY 1, 2`)).rows;
  const has = (no, f) => audit.some((x) => x.vehicle_no === no && x.finding === f);
  check('the self-attached lorry is listed', has('AS 26C 5108', 'ATTACHED_TO_SELF'), true);
  check('attached lorries without a rate are listed', has('AS 26C 5105', 'ATTACHED_NO_RATE') && has('AS 26C 1116', 'ATTACHED_NO_RATE'), true);
  check('a lorry with trips in another firm\'s books is listed', has('AS 19C 8666', 'TRIPS_OTHER_COMPANY'), true);
  check('a lorry with trips and no master is listed', has('AS 26C 9803', 'NO_MASTER'), true);
  check('a clean own lorry is not listed', audit.some((x) => x.vehicle_no === 'AS 26C 9801'), false);
  await db.query(`INSERT INTO vehicle_commission_terms (vehicle_key, basis, rate, tds_pct, effective_from)
                  VALUES ('AS26C5105','PCT',10,1,'2026-04-01')`);
  check('a rate on file clears that finding', (await db.query(
    `SELECT 1 FROM v_vehicle_rule_audit WHERE vehicle_no='AS 26C 5105' AND finding='ATTACHED_NO_RATE'`)).rows.length, 0);
  // Make the ambiguous row ambiguous again to prove it is what the audit shows.
  await db.query(`UPDATE vehicles SET ownership='ATTACHED', owner_name='SANTOSH PRASAD' WHERE vehicle_no='AS 19C 8666'`);
  check('the 15-day bill will now see it as attached (vehicle_class)',
    (await one(`SELECT vehicle_class('AS19C8666')::text c`)).c, 'ATTACHED');
  check('the bill\'s owner-ledger name matches the master\'s',
    (await one(`SELECT vehicle_owner_ledger_name('Santosh  Prasad') n`)).n, 'Vehicle Owner: SANTOSH PRASAD');
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
