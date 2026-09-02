// scripts/staging-live-check.mjs — proves the quarantine fence against the REAL
// pool on a box: a DRIVER context is refused a core write before it reaches
// PostgreSQL, a staging write passes, and a staff/system write is untouched.
// Every statement is a WHERE false no-op; nothing changes.
//   cd /var/www/prasad-erp && DOTENV_CONFIG_PATH=.env.api node scripts/staging-live-check.mjs
import 'dotenv/config';
import { query, closePool } from '../server/db/pool.js';
import { runAs, STAGING_TABLES, guardMode } from '../server/lib/staging.js';

const out = { mode: guardMode(), staging_tables: STAGING_TABLES.size };
try {
  await runAs({ role: 'DRIVER', path: '/live-check' }, () => query('UPDATE trips SET updated_at = now() WHERE false'));
  out.core_write_as_driver = 'ALLOWED — FENCE DOWN';
} catch (e) {
  out.core_write_as_driver = e.code === 'STAGING_ONLY' ? 'refused (403 STAGING_ONLY)' : `other error: ${e.message}`;
}
try {
  await runAs({ role: 'DRIVER', path: '/live-check' }, () => query('UPDATE partner_documents SET updated_at = updated_at WHERE false'));
  out.staging_write_as_driver = 'ok';
} catch (e) { out.staging_write_as_driver = `FAILED: ${e.message}`; }
try {
  await runAs({ role: 'DRIVER', path: '/live-check' }, () => query('SELECT count(*)::int AS n FROM trips'));
  out.core_read_as_driver = 'ok (reads are scoped by the routes, not the fence)';
} catch (e) { out.core_read_as_driver = `FAILED: ${e.message}`; }
try {
  await query('UPDATE trips SET updated_at = updated_at WHERE false');
  out.staff_write = 'ok';
} catch (e) { out.staff_write = `FAILED: ${e.message}`; }
console.log(JSON.stringify(out, null, 2));
await closePool();
process.exit(out.core_write_as_driver.startsWith('refused') && out.staging_write_as_driver === 'ok' && out.staff_write === 'ok' ? 0 : 1);
