// Applies migration 177 to a throwaway database on the local cluster and
// exercises every guard it adds. Stub tables only — this proves 177's own SQL
// and trigger logic, not the 176-migration chain.
import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import pg from 'pg';
dotenv.config({ path: 'F:/Prasad_Transport_System/PRASAD-TRANSPORT-ERP/.env' });

// A scratch SCHEMA, not a scratch database: the application role has no
// CREATEDB, and the 174 selftest already established MIGTEST_SCHEMA as the way
// to isolate a migration test on a cluster you do not own.
const base = { host: process.env.PGHOST, port: process.env.PGPORT, user: process.env.PGUSER, password: process.env.PGPASSWORD };
const SCHEMA = process.env.MIGTEST_SCHEMA || 'mig177_test';
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `   (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const throws = async (name, fn, wantRe) => {
  try { await fn(); fail++; console.log(`  FAIL ${name}  (expected a refusal, got success)`); }
  catch (e) {
    const ok = wantRe.test(e.message);
    if (!ok) fail++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `   (got "${e.message}")`}`);
  }
};

const c = new pg.Client({ ...base, database: process.env.PGDATABASE });
await c.connect();
await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
await c.query(`CREATE SCHEMA ${SCHEMA}`);
// Stubs and every object 177 creates land in the scratch schema; extensions
// stay wherever the database already has them.
await c.query(`SET search_path = ${SCHEMA}, public`);

// Minimal stubs matching the real shapes 177 depends on.
await c.query(`
  CREATE TYPE ${SCHEMA}.record_status AS ENUM ('ACTIVE','INACTIVE');
  CREATE TABLE companies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_name text NOT NULL,
    gstin citext, status record_status NOT NULL DEFAULT 'ACTIVE',
    updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email citext,
    password_hash text NOT NULL DEFAULT 'x', password_salt text);
  CREATE TABLE bank_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_no text UNIQUE,
    account_tail text NOT NULL, bank_name text NOT NULL DEFAULT 'SBI',
    ledger_name text NOT NULL, company_id uuid REFERENCES companies(id),
    account_kind text NOT NULL DEFAULT 'CURRENT', active boolean NOT NULL DEFAULT true);
  INSERT INTO companies (company_name) VALUES
    ('M/S PRASAD TRANSPORT'), ('M/S JAISWAL ENTERPRISE'), ('M/S GAUTAM PRASAD');
  INSERT INTO bank_accounts (account_no, account_tail, ledger_name, company_id, account_kind)
  SELECT '30178368490','8490','SBI (8490)', id,'CURRENT' FROM companies WHERE company_name LIKE '%PRASAD TRANSPORT%';
  INSERT INTO bank_accounts (account_no, account_tail, ledger_name, company_id, account_kind)
  SELECT '30297031934','1934','SBI (1934)', id,'SAVINGS' FROM companies WHERE company_name LIKE '%GAUTAM%';
`);

const sql = readFileSync('F:/Prasad_Transport_System/PRASAD-TRANSPORT-ERP/server/db/migrations/177_payout_engine.sql', 'utf8');
console.log('\napplying 177…');
await c.query(sql);
console.log('applying 177 a SECOND time (must be idempotent)…');
await c.query(sql);

const one = async (q, p) => (await c.query(q, p)).rows[0];
const prasad = await one(`SELECT id, upi_vpa FROM companies WHERE company_name LIKE '%PRASAD TRANSPORT%'`);
const jaiswal = await one(`SELECT id FROM companies WHERE company_name LIKE '%JAISWAL%'`);
const gautam = await one(`SELECT id, upi_vpa FROM companies WHERE company_name LIKE '%GAUTAM%'`);
const acct8490 = await one(`SELECT id, allowed_beneficiary_kinds a FROM bank_accounts WHERE account_tail='8490'`);
const acct1934 = await one(`SELECT id, allowed_beneficiary_kinds a FROM bank_accounts WHERE account_tail='1934'`);

console.log('\nVPA seeding');
check('Prasad VPA seeded', prasad.upi_vpa, 'prasadtransport@sbi');
check('Gautam VPA seeded', gautam.upi_vpa, 'gautamprasad@sbi');
await throws('malformed VPA refused', () => c.query(`UPDATE companies SET upi_vpa='not-a-vpa' WHERE id=$1`, [prasad.id]), /companies_upi_vpa_format/);

console.log('\nowner rule: SBI 1934 is personal');
check('8490 allows all six', acct8490.a.length, 6);
check('1934 allows DRIVER+OWNER only', acct1934.a, ['DRIVER', 'OWNER']);

const mk = async (over = {}) => {
  const v = {
    key: crypto.randomUUID(), paying: prasad.id, owing: prasad.id, acct: acct8490.id,
    rail: 'IMPS', kind: 'DRIVER', name: 'Ranjit Das', amount: 18400, ...over,
  };
  return one(
    `INSERT INTO payout_instructions (idempotency_key,paying_company_id,owing_company_id,bank_account_id,rail,beneficiary_kind,beneficiary_name,amount,intercompany)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$2::uuid IS DISTINCT FROM $3::uuid) RETURNING id,status`,
    [v.key, v.paying, v.owing, v.acct, v.rail, v.kind, v.name, v.amount]);
};

console.log('\nLOCK 3 — account policy');
const okPay = await mk();
check('driver paid from 8490 is allowed', okPay.status, 'DRAFT');
await throws('VENDOR from personal 1934 refused',
  () => mk({ paying: gautam.id, owing: gautam.id, acct: acct1934.id, kind: 'VENDOR' }), /may not pay a VENDOR/);
const advOk = await mk({ paying: gautam.id, owing: gautam.id, acct: acct1934.id, kind: 'DRIVER' });
check('driver advance from 1934 allowed', advOk.status, 'DRAFT');
await throws('account of another entity refused',
  () => mk({ paying: jaiswal.id, owing: jaiswal.id, acct: acct8490.id }), /does not belong to the paying entity/);

console.log('\nLOCK 1 — idempotency');
const k = crypto.randomUUID();
await mk({ key: k });
await throws('same key twice refused', () => mk({ key: k }), /payout_instructions_idem_uk|duplicate key/);

console.log('\nLOCK 4 — forward only');
await c.query(`UPDATE payout_instructions SET status='AUTHORIZED' WHERE id=$1`, [okPay.id]);
await throws('AUTHORIZED -> DRAFT refused',
  () => c.query(`UPDATE payout_instructions SET status='DRAFT' WHERE id=$1`, [okPay.id]), /cannot move/);
await c.query(`UPDATE payout_instructions SET status='POSTED' WHERE id=$1`, [okPay.id]);
await c.query(`UPDATE payout_instructions SET status='PENDING_BANK' WHERE id=$1`, [okPay.id]);
await c.query(`UPDATE payout_instructions SET status='SETTLED', utr='SBIN9912345' WHERE id=$1`, [okPay.id]);
await throws('SETTLED is terminal',
  () => c.query(`UPDATE payout_instructions SET status='FAILED' WHERE id=$1`, [okPay.id]), /is SETTLED and is final/);
const failable = await mk();
await c.query(`UPDATE payout_instructions SET status='FAILED', failure_reason='rail refused' WHERE id=$1`, [failable.id]);
check('DRAFT -> FAILED allowed', (await one(`SELECT status FROM payout_instructions WHERE id=$1`, [failable.id])).status, 'FAILED');

console.log('\nLOCK 2 — the 24-hour OTP window');
const drv = crypto.randomUUID();
check('no change -> no OTP', (await one(`SELECT payout_needs_otp('DRIVER',$1::uuid) n`, [drv])).n, false);
await c.query(`INSERT INTO beneficiary_changes (party_kind,party_id,field) VALUES ('DRIVER',$1::uuid,'BANK')`, [drv]);
check('bank changed now -> OTP', (await one(`SELECT payout_needs_otp('DRIVER',$1::uuid) n`, [drv])).n, true);
await c.query(`UPDATE beneficiary_changes SET changed_at = now() - interval '25 hours' WHERE party_id=$1::uuid`, [drv]);
check('changed 25h ago -> no OTP', (await one(`SELECT payout_needs_otp('DRIVER',$1::uuid) n`, [drv])).n, false);

console.log('\ndesk view');
check('v_payout_desk resolves', (await one(`SELECT count(*)::int n FROM v_payout_desk`)).n > 0, true);
check('desk exposes paying_vpa', Object.keys(await one(`SELECT * FROM v_payout_desk LIMIT 1`)).includes('paying_vpa'), true);

await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
await c.end();
console.log(fail ? `\n${fail} FAILURE(S)` : '\nALL 177 CHECKS PASSED');
process.exit(fail ? 1 : 0);
