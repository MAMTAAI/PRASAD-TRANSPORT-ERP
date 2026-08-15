#!/usr/bin/env node
/**
 * scripts/create-review-account.mjs — the login Google Play reviewers use.
 *
 * WHY THIS ONE ACCOUNT IS ALLOWED A SHARED PASSWORD, when
 * provision-portal-user.mjs deliberately refuses to create default credentials:
 * a Play reviewer is an anonymous third party who must be able to sign in from
 * the credentials typed into the "App access" form. A one-time password they
 * cannot rotate is unusable, and an app behind a login with no reviewer account
 * is rejected outright.
 *
 * What makes it safe is not secrecy, it is scope:
 *   - role VIEWER — the lowest role in the system, read-only
 *   - account_status ACTIVE — so it passes the approval gate (migration 050)
 *   - must_change_password false — a reviewer cannot complete a forced rotation
 *   - a marker in full_name so it is obvious in the approvals panel
 *
 * Suspend it the moment review finishes: Master Control v5.0 -> User Approvals
 * & Access -> toggle OFF. That kills the account and every open session at once.
 *
 *   node -r dotenv/config scripts/create-review-account.mjs --password '<pw>'
 *   node -r dotenv/config scripts/create-review-account.mjs --generate
 *   node -r dotenv/config scripts/create-review-account.mjs --suspend
 *
 * RUN THIS ON THE BOX. Reviewers hit www.prasadtransport.com, so the account
 * has to exist in the AWS database, not a local one.
 */
import { randomBytes } from 'node:crypto';
import { initDb, query, isDegraded, DB_TARGET } from '../server/db/pool.js';
import { hashPassword, ALGO } from '../server/lib/auth.js';

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? null : (argv[i + 1]?.startsWith('--') ? true : argv[i + 1] ?? true);
};

const EMAIL = 'play.review@prasadtransport.com';

await initDb({ attempts: 2 });
if (isDegraded()) { console.error('\n  no database reachable\n'); process.exit(1); }

if (flag('suspend')) {
  const { rowCount } = await query(
    `UPDATE users SET account_status = 'SUSPENDED' WHERE email::text = $1`, [EMAIL]);
  await query(
    `DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE email::text = $1)`, [EMAIL]);
  console.log(rowCount
    ? `\n  review account SUSPENDED on ${DB_TARGET} — sessions ended.\n`
    : `\n  no review account found on ${DB_TARGET}.\n`);
  process.exit(0);
}

const password = flag('generate')
  ? randomBytes(9).toString('base64url')
  : String(flag('password') ?? '');
if (!password || password.length < 10) {
  console.error('\n  pass --password \'<at least 10 chars>\' or --generate\n');
  process.exit(1);
}

const { saltHex, hashHex } = hashPassword(password);
const { rows: existing } = await query('SELECT id FROM users WHERE email::text = $1', [EMAIL]);

if (existing.length) {
  await query(
    `UPDATE users SET password_hash=$2, password_salt=$3, password_algo=$4,
                      must_change_password=false, failed_logins=0, locked_until=NULL,
                      account_status='ACTIVE', role='VIEWER', updated_at=now()
      WHERE id=$1::uuid`, [existing[0].id, hashHex, saltHex, ALGO]);
  await query('DELETE FROM auth_sessions WHERE user_id = $1::uuid', [existing[0].id]);
} else {
  await query(
    `INSERT INTO users (full_name, email, password_hash, password_salt, password_algo,
                        role, permissions, account_status, must_change_password)
     VALUES ('Play Store Review (temporary)', $1::citext, $2, $3, $4,
             'VIEWER', '{"grants":[]}'::jsonb, 'ACTIVE', false)`,
    [EMAIL, hashHex, saltHex, ALGO]);
}

console.log(`
  Play review account ready on ${DB_TARGET}

    Username : ${EMAIL}
    Password : ${password}

  Paste both into Play Console -> App content -> App access
  -> "All or some functionality is restricted".

  Turn it OFF after review:
    node -r dotenv/config scripts/create-review-account.mjs --suspend
`);
process.exit(0);
