// scripts/staging-selftest.mjs — exercises server/lib/staging.js without a database.
//   node scripts/staging-selftest.mjs
import assert from 'node:assert/strict';
import { writeTargets, assertExternalWrite, runAs, asSystem, requestContext, STAGING_TABLES } from '../server/lib/staging.js';

const cases = [
  ['INSERT INTO trips (a) VALUES (1)', ['trips']],
  ['insert into public.ledger_entries select 1', ['ledger_entries']],
  ['UPDATE trips SET x = 1 WHERE id = $1', ['trips']],
  ['DELETE FROM auth_sessions WHERE user_id = $1', ['auth_sessions']],
  ['WITH ins AS (INSERT INTO partner_documents (a) VALUES (1) RETURNING id) SELECT * FROM ins', ['partner_documents']],
  ['SELECT * FROM bazaar_loads WHERE load_id = $1 FOR UPDATE', []],
  ['SELECT * FROM bazaar_loads WHERE load_id = $1 FOR UPDATE SKIP LOCKED', []],
  ['SELECT * FROM x FOR NO KEY UPDATE NOWAIT', []],
  ['INSERT INTO maps_cache (k) VALUES ($1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', ['maps_cache']],
  ["SELECT 'please UPDATE trips now' AS note FROM customers", []],
  ['-- UPDATE trips in a comment\nSELECT 1', []],
  ['/* DELETE FROM trips */ SELECT 1', []],
  ['UPDATE "vendors" SET a = 1', ['vendors']],
  ['UPDATE ONLY trips SET a = 1', ['trips']],
  ['TRUNCATE TABLE ledger_entries', ['ledger_entries']],
  ['ALTER TABLE trips ADD COLUMN x int', ['trips']],
  ['LOCK TABLE bazaar_loads IN SHARE ROW EXCLUSIVE MODE', []],
  ['SELECT gen_random_uuid() AS jti', []],
];
for (const [sql, want] of cases) assert.deepEqual(writeTargets(sql), want, `writeTargets(${JSON.stringify(sql)})`);

// Outside any request: never blocks.
assert.equal(requestContext.getStore(), undefined);
assertExternalWrite('UPDATE trips SET a = 1');

// A staff request: never blocks.
requestContext.run({ external: false, role: 'ADMIN', method: 'POST', path: '/x' }, () => {
  assertExternalWrite('UPDATE ledger_entries SET a = 1');
});

// An external request: staging tables pass, core tables are refused with 403 STAGING_ONLY.
runAs({ role: 'DRIVER' }, () => {
  for (const t of STAGING_TABLES) assertExternalWrite(`INSERT INTO ${t} (a) VALUES (1)`);
  assertExternalWrite('SELECT t.* FROM trips t WHERE t.driver_id = $1');
  for (const sql of ['UPDATE trips SET status = 1', 'INSERT INTO ledger_entries (a) VALUES (1)', 'DELETE FROM vendors WHERE id = $1',
                     'UPDATE users SET role = 1', 'WITH w AS (UPDATE drivers SET a = 1 RETURNING id) SELECT 1']) {
    assert.throws(() => assertExternalWrite(sql), (e) => e.code === 'STAGING_ONLY' && e.statusCode === 403, sql);
  }
});
// A public (no session) request is external too.
runAs({ role: 'PUBLIC' }, () => {
  assertExternalWrite('INSERT INTO onboarding_applications (a) VALUES (1)');
  assert.throws(() => assertExternalWrite('INSERT INTO customers (a) VALUES (1)'), (e) => e.code === 'STAGING_ONLY');
});
// Context survives awaits (the pool acquires a client before it runs the statement).
await runAs({ role: 'VENDOR' }, async () => {
  await new Promise((r) => setTimeout(r, 5));
  assert.throws(() => assertExternalWrite('UPDATE trips SET a = 1'), (e) => e.code === 'STAGING_ONLY');
});
// The audit logger's own rows inside an external request run as SYSTEM and pass;
// the surrounding external context is untouched afterwards.
await runAs({ role: 'DRIVER' }, async () => {
  await asSystem(() => assertExternalWrite('INSERT INTO audit_logs (a) VALUES (1)'));
  await asSystem(() => assertExternalWrite('UPDATE auth_sessions SET last_seen_at = now()'));
  assert.throws(() => assertExternalWrite('UPDATE auth_sessions SET last_seen_at = now()'), (e) => e.code === 'STAGING_ONLY');
});
// report mode logs and lets it through
process.env.STAGING_GUARD_MODE = 'report';
runAs({ role: 'CUSTOMER' }, () => assertExternalWrite('UPDATE trips SET a = 1'));
process.env.STAGING_GUARD_MODE = 'enforce';

console.log(`staging-selftest: ${cases.length} parser cases + guard branches OK · ${STAGING_TABLES.size} staging tables`);
