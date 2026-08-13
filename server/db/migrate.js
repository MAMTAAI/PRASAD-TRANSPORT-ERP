// server/db/migrate.js
// ─────────────────────────────────────────────────────────────────────────────
// Forward-only SQL migration runner.
//
//   node server/db/migrate.js            apply every pending migration
//   node server/db/migrate.js --status   list applied / pending, apply nothing
//
// Each .sql file in migrations/ runs exactly once, in filename order, inside a
// transaction. A checksum is recorded so an already-applied file that has been
// edited afterwards is caught rather than silently ignored — the failure mode
// that makes two environments drift apart without anyone noticing.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { initDb, getPool, query, closePool, DB_TARGET } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const sha256 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function ensureLedgerTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer
    )
  `);
}

function discover() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      return { filename, sql, checksum: sha256(sql) };
    });
}

async function main() {
  const statusOnly = process.argv.includes('--status');

  // Resolve a target first (local → RDS) so a stopped local postgres falls
  // through to AWS instead of aborting the migration run.
  const conn = await initDb();
  if (conn.degraded) {
    console.error('[migrate] no database reachable — nothing applied');
    process.exitCode = 1;
    return;
  }
  await ensureLedgerTable();

  const { rows } = await query('SELECT filename, checksum FROM schema_migrations');
  const applied = new Map(rows.map((r) => [r.filename, r.checksum]));
  const all = discover();

  // Drift check first: an edited-after-apply file means this database no
  // longer matches the repo, and applying more on top would compound it.
  const drifted = all.filter((m) => applied.has(m.filename) && applied.get(m.filename) !== m.checksum);
  if (drifted.length) {
    console.error('\n[migrate] ✖ applied migrations were edited after the fact:');
    for (const m of drifted) console.error(`           ${m.filename}`);
    console.error('           Write a NEW migration instead of editing an applied one.\n');
    process.exitCode = 1;
    return;
  }

  const pending = all.filter((m) => !applied.has(m.filename));

  if (statusOnly) {
    console.log(`\n[migrate] target=${DB_TARGET}`);
    for (const m of all) console.log(`  ${applied.has(m.filename) ? '✔ applied' : '· pending'}  ${m.filename}`);
    console.log(`\n  ${applied.size} applied, ${pending.length} pending\n`);
    return;
  }

  if (!pending.length) {
    console.log(`[migrate] up to date (${applied.size} applied) — nothing to do`);
    return;
  }

  console.log(`[migrate] target=${DB_TARGET} · applying ${pending.length} migration(s)`);
  for (const m of pending) {
    const client = await getPool().connect();
    const startedAt = Date.now();
    try {
      // The .sql files carry their own BEGIN/COMMIT. Postgres treats a nested
      // BEGIN as a no-op warning, so the file's own transaction governs; the
      // INSERT below is committed separately once the file has succeeded.
      await client.query(m.sql);
      const ms = Date.now() - startedAt;
      await client.query(
        'INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)',
        [m.filename, m.checksum, ms]
      );
      console.log(`  ✔ ${m.filename} (${ms}ms)`);
    } catch (err) {
      console.error(`  ✖ ${m.filename} failed — database left unchanged by this file`);
      console.error(`    ${err.message}`);
      if (err.position) console.error(`    at character ${err.position}`);
      process.exitCode = 1;
      return; // stop at the first failure; do not run later migrations
    } finally {
      client.release();
    }
  }
  console.log('[migrate] done');
}

main()
  .catch((err) => {
    console.error('[migrate] fatal:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
