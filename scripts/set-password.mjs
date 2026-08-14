#!/usr/bin/env node
/**
 * scripts/set-password.mjs — set a staff password directly against the database.
 *
 * THE CUTOVER NEEDS THIS. POST /auth/users/:id/password requires an admin JWT,
 * and at the moment Firebase Auth is switched off nobody can obtain one: all six
 * accounts carry 'MIGRATION-RESET-REQUIRED' and no password exists to log in
 * with. This breaks that circle once, from the box itself — which is the only
 * place it should be possible to break it.
 *
 *   node -r dotenv/config scripts/set-password.mjs --list
 *   node -r dotenv/config scripts/set-password.mjs --email a@b.com --password '...'
 *   node -r dotenv/config scripts/set-password.mjs --email a@b.com --generate
 *
 * --generate prints a random password once. It is never stored in plaintext and
 * never logged, so if it is lost the only path is to run this again.
 */
import { randomBytes } from 'node:crypto';
import { initDb, query, isDegraded } from '../server/db/pool.js';
import { hashPassword, ALGO } from '../server/lib/auth.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1]?.startsWith('--') ? true : argv[i + 1] ?? true);
};

await initDb({ attempts: 2 });
if (isDegraded()) { console.error('no database reachable'); process.exit(1); }

if (flag('list') || argv.length === 0) {
  const { rows } = await query(
    `SELECT email, full_name, role, status, must_change_password FROM users ORDER BY created_at`);
  console.log('\n  email                              role         status   password');
  console.log('  ' + '-'.repeat(74));
  for (const u of rows) {
    console.log(`  ${String(u.email).padEnd(34)} ${String(u.role).padEnd(12)} ${String(u.status).padEnd(8)} ${u.must_change_password ? 'NOT SET — reset required' : 'set'}`);
  }
  console.log(`\n  usage: node -r dotenv/config scripts/set-password.mjs --email <addr> --password '<pw>'\n`);
  process.exit(0);
}

const email = String(flag('email') ?? '').trim().toLowerCase();
if (!email) { console.error('--email is required'); process.exit(1); }

// A generated password is 18 base64url chars (~107 bits) — long enough that it
// never needs a rotation policy attached to it.
const generate = flag('generate');
const password = generate ? randomBytes(14).toString('base64url') : String(flag('password') ?? '');
if (!password || password.length < 8) {
  console.error('--password must be at least 8 characters (or pass --generate)');
  process.exit(1);
}

const { rows } = await query('SELECT id, full_name FROM users WHERE lower(email::text) = $1', [email]);
if (!rows.length) { console.error(`no user with email ${email}`); process.exit(1); }

const { saltHex, hashHex } = hashPassword(password);
await query(
  `UPDATE users SET password_hash = $2, password_salt = $3, password_algo = $4,
                    must_change_password = false, failed_logins = 0, locked_until = NULL
    WHERE id = $1::uuid`, [rows[0].id, hashHex, saltHex, ALGO]);
// Any session issued under the old credential dies with it.
await query('DELETE FROM auth_sessions WHERE user_id = $1::uuid', [rows[0].id]);

console.log(`\n  password set for ${rows[0].full_name} <${email}>`);
if (generate) console.log(`  password: ${password}\n  (shown once — it is stored only as a PBKDF2 hash)`);
console.log();
process.exit(0);
