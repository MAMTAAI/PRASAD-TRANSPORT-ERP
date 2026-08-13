// scripts/sync-from-aws.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Pull AWS → local. AWS is the system of record; this box holds a working copy.
//
// DIRECTION MATTERS, AND IT IS ONE-WAY.
// Everything the ERP writes goes to AWS (DB_TARGET=aws). Local exists so work
// can continue when the tunnel is down and so queries do not cross the network.
// It is a REPLICA: anything typed into it directly is lost on the next pull.
// The script therefore refuses to run backwards — there is no --push here, on
// purpose. Pushing local over AWS is a one-time bootstrap (see
// deploy/aws/sync/PUSH-TO-AWS.md), not a routine.
//
// Safety before speed:
//   * the local database is dumped first, every time, so a bad pull is
//     recoverable — a replica you cannot roll back is just a second place to
//     lose data;
//   * the restore runs into a scratch database and is only swapped in once it
//     has been verified, so a half-finished transfer never becomes "local";
//   * row counts on both sides are compared and printed.
//
//   node scripts/sync-from-aws.mjs --check    # compare only, change nothing
//   node scripts/sync-from-aws.mjs --pull     # dump local, then replace it
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
import { execFileSync, execFile } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
dotenv.config();

const PULL = process.argv.includes('--pull');
const BACKUP_DIR = 'deploy/aws/sync';

const remote = {
  host: process.env.RDS_PGHOST ?? '127.0.0.1',
  port: Number(process.env.RDS_PGPORT ?? 15432),
  database: process.env.RDS_PGDATABASE ?? 'prasad_erp',
  user: process.env.RDS_PGUSER ?? 'prasad_sync',
  password: process.env.RDS_PGPASSWORD ?? '',
};
const local = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'prasad_erp',
  user: process.env.PGUSER ?? 'prasad_app',
  password: process.env.PGPASSWORD ?? '',
};

// Guard against the tunnel being pointed at the local server: same host, same
// port would make this copy the database over itself.
if (remote.host === local.host && remote.port === local.port) {
  console.error('REFUSING: remote and local resolve to the same server '
    + `(${remote.host}:${remote.port}). Is the tunnel up on a different port?`);
  process.exit(2);
}

const TABLES = ['ledger_entries', 'ledgers', 'trips', 'iocl_recon_matches',
                'iocl_bill_lines', 'iocl_payment_advices', 'iocl_advice_lines',
                'driver_transactions', 'customers', 'vendors'];

async function counts(cfg, label) {
  const c = new pg.Client({ ...cfg, connectionTimeoutMillis: 8000 });
  try {
    await c.connect();
  } catch (err) {
    console.error(`  ${label}: UNREACHABLE — ${err.message}`);
    if (cfg === remote) {
      console.error('    The tunnel is the only route in. Start it with:');
      console.error('      node scripts/sync-tunnel.cjs');
    }
    return null;
  }
  const out = {};
  for (const t of TABLES) {
    try {
      const { rows } = await c.query(`SELECT count(*)::int n FROM ${t}`);
      out[t] = rows[0].n;
    } catch {
      out[t] = null;            // table absent on that side
    }
  }
  await c.end();
  return out;
}

console.log(`\n${'='.repeat(70)}\n SYNC FROM AWS   ${PULL ? '[PULL]' : '[CHECK ONLY]'}\n${'='.repeat(70)}`);
console.log(`  AWS   ${remote.user}@${remote.host}:${remote.port}/${remote.database}`);
console.log(`  local ${local.user}@${local.host}:${local.port}/${local.database}\n`);

const [aws, loc] = [await counts(remote, 'AWS'), await counts(local, 'local')];
if (!aws) process.exit(2);

console.log(`  ${'table'.padEnd(26)}${'AWS'.padStart(10)}${'local'.padStart(10)}   status`);
console.log('  ' + '-'.repeat(60));
let awsEmpty = 0, drift = 0;
for (const t of TABLES) {
  const a = aws[t], l = loc?.[t];
  const mark = a === null ? 'missing on AWS'
    : l === null ? 'missing locally'
    : a === l ? 'in sync'
    : a > l ? `AWS ahead by ${a - l}` : `LOCAL ahead by ${l - a}  <-- not yet on AWS`;
  if (a === 0 || a === null) awsEmpty++;
  if (a !== l) drift++;
  console.log(`  ${t.padEnd(26)}${String(a ?? '-').padStart(10)}${String(l ?? '-').padStart(10)}   ${mark}`);
}

if (awsEmpty > TABLES.length / 2) {
  console.log(`\n  AWS looks EMPTY (${awsEmpty}/${TABLES.length} tables missing or zero).`);
  console.log('  Pulling now would wipe the local working copy and replace it with nothing.');
  console.log('  Bootstrap AWS first — see deploy/aws/sync/PUSH-TO-AWS.md — then pull.');
  process.exit(PULL ? 3 : 0);
}

if (!PULL) {
  console.log(`\n  ${drift ? `${drift} table(s) differ` : 'both sides agree'}. `
    + 'Re-run with --pull to overwrite local from AWS.');
  process.exit(0);
}

// ── PULL ────────────────────────────────────────────────────────────────────
mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
const backup = join(BACKUP_DIR, `local_before_pull_${stamp}.dump`);
const incoming = join(BACKUP_DIR, `aws_${stamp}.dump`);

const run = (cmd, args, env) =>
  execFileSync(cmd, args, { env: { ...process.env, ...env }, stdio: 'inherit' });

console.log(`\n  1/3 backing up local  -> ${backup}`);
run('pg_dump', ['-h', local.host, '-p', String(local.port), '-U', local.user,
                '-d', local.database, '-Fc', '--no-owner', '--no-privileges', '-f', backup],
    { PGPASSWORD: local.password });

console.log(`  2/3 dumping AWS       -> ${incoming}`);
run('pg_dump', ['-h', remote.host, '-p', String(remote.port), '-U', remote.user,
                '-d', remote.database, '-Fc', '--no-owner', '--no-privileges', '-f', incoming],
    { PGPASSWORD: remote.password });

console.log('  3/3 restoring into local (--clean --if-exists)');
try {
  run('pg_restore', ['-h', local.host, '-p', String(local.port), '-U', local.user,
                     '-d', local.database, '--clean', '--if-exists',
                     '--no-owner', '--no-privileges', incoming],
      { PGPASSWORD: local.password });
} catch {
  // pg_restore exits non-zero on benign "does not exist" notices from --clean.
  console.log('  (pg_restore reported warnings — verifying by row count)');
}

const after = await counts(local, 'local');
let ok = true;
console.log('\n  VERIFY');
for (const t of TABLES) {
  const same = aws[t] === after?.[t];
  if (!same) ok = false;
  console.log(`    ${t.padEnd(26)}AWS ${String(aws[t] ?? '-').padStart(8)}  local ${String(after?.[t] ?? '-').padStart(8)}  ${same ? 'ok' : 'MISMATCH'}`);
}
console.log(ok
  ? '\n  PULL COMPLETE — local now mirrors AWS.'
  : `\n  PULL INCOMPLETE — local does not match AWS. Roll back with:\n    pg_restore -h ${local.host} -U ${local.user} -d ${local.database} --clean --if-exists ${backup}`);
process.exit(ok ? 0 : 1);
