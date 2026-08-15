#!/usr/bin/env node
/**
 * scripts/provision-portal-user.mjs — give a customer or vendor a portal login.
 *
 * WHY A SCRIPT AND NOT A SEEDER. The obvious way to "unblock the portals" is to
 * insert a couple of demo accounts with a known password. That would put default
 * credentials in a database holding the company's books, 54 drivers' personal
 * details and every customer's freight rates — and default credentials are not
 * a placeholder, they are a way in. Every account made here gets a random
 * one-time password, shown once, with must_change_password set.
 *
 *   node -r dotenv/config scripts/provision-portal-user.mjs --list
 *   node -r dotenv/config scripts/provision-portal-user.mjs --customer "ACME LOGISTICS"
 *   node -r dotenv/config scripts/provision-portal-user.mjs --vendor 3f2b... --email ops@v.com
 *   node -r dotenv/config scripts/provision-portal-user.mjs --customer "ACME" --reset
 *
 * The party is matched by id, or by a unique case-insensitive name fragment.
 * An ambiguous fragment refuses rather than guessing which customer to expose.
 */
import { randomBytes } from 'node:crypto';
import { initDb, query, isDegraded } from '../server/db/pool.js';
import { hashPassword, ALGO } from '../server/lib/auth.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1]?.startsWith('--') ? true : argv[i + 1] ?? true);
};
const die = (msg) => { console.error(`\n  ${msg}\n`); process.exit(1); };

await initDb({ attempts: 2 });
if (isDegraded()) die('no database reachable');

// ── --list ──────────────────────────────────────────────────────────────────
if (flag('list') || argv.length === 0) {
  const { rows: cust } = await query(`
    SELECT c.id, c.customer_name AS name, c.email, c.mobile_no,
           u.email::text AS portal_email, u.status AS portal_status
      FROM customers c LEFT JOIN users u ON u.customer_id = c.id
     ORDER BY c.customer_name`);
  const { rows: vend } = await query(`
    SELECT v.id, v.vendor_name AS name, v.email, v.mobile_no,
           u.email::text AS portal_email, u.status AS portal_status
      FROM vendors v LEFT JOIN users u ON u.vendor_id = v.id
     ORDER BY v.vendor_name`);

  const show = (title, rows) => {
    console.log(`\n  ${title}`);
    console.log('  ' + '-'.repeat(78));
    for (const r of rows) {
      const state = r.portal_email ? `login: ${r.portal_email} (${r.portal_status})` : 'no portal login';
      console.log(`  ${String(r.name).slice(0, 38).padEnd(40)} ${state}`);
    }
    if (!rows.length) console.log('  (none)');
  };
  show(`CUSTOMERS (${cust.length})`, cust);
  show(`VENDORS (${vend.length})`, vend);
  console.log(`\n  usage: --customer <id|name>  |  --vendor <id|name>  [--email <addr>] [--reset]\n`);
  process.exit(0);
}

// ── resolve the party ───────────────────────────────────────────────────────
const isCustomer = !!flag('customer');
const isVendor = !!flag('vendor');
if (isCustomer === isVendor) die('pass exactly one of --customer or --vendor');

const needle = String(flag(isCustomer ? 'customer' : 'vendor') ?? '').trim();
if (!needle || needle === 'true') die(`--${isCustomer ? 'customer' : 'vendor'} needs an id or a name`);

const table = isCustomer ? 'customers' : 'vendors';
const nameCol = isCustomer ? 'customer_name' : 'vendor_name';
const linkCol = isCustomer ? 'customer_id' : 'vendor_id';
const role = isCustomer ? 'CUSTOMER' : 'VENDOR';

const uuidish = /^[0-9a-f-]{36}$/i.test(needle);
const { rows: parties } = uuidish
  ? await query(`SELECT id, ${nameCol} AS name, email, mobile_no FROM ${table} WHERE id = $1::uuid`, [needle])
  : await query(
      `SELECT id, ${nameCol} AS name, email, mobile_no FROM ${table} WHERE ${nameCol} ILIKE '%' || $1 || '%'`,
      [needle]);

if (!parties.length) die(`no ${role.toLowerCase()} matching "${needle}"`);
if (parties.length > 1) {
  console.error(`\n  "${needle}" matches ${parties.length} ${table} — be more specific:`);
  for (const p of parties) console.error(`    ${p.id}  ${p.name}`);
  console.error();
  process.exit(1);
}
const party = parties[0];

// ── existing login? ─────────────────────────────────────────────────────────
const { rows: existing } = await query(
  `SELECT id, email::text AS email, full_name FROM users WHERE ${linkCol} = $1::uuid`, [party.id]);

if (existing.length && !flag('reset')) {
  die(`${party.name} already has a portal login (${existing[0].email}). Pass --reset to issue a new password.`);
}

// A login needs an address. Prefer the one given, then the party's own.
const email = String(flag('email') ?? party.email ?? '').trim().toLowerCase();
if (!email || !email.includes('@')) {
  die(`no email on record for ${party.name} — pass --email <addr>`);
}

const password = randomBytes(14).toString('base64url');
const { saltHex, hashHex } = hashPassword(password);

if (existing.length) {
  await query(
    `UPDATE users SET password_hash=$2, password_salt=$3, password_algo=$4,
                      must_change_password=true, failed_logins=0, locked_until=NULL,
                      status='ACTIVE', updated_at=now()
      WHERE id=$1::uuid`, [existing[0].id, hashHex, saltHex, ALGO]);
  // The old credential's sessions die with it.
  await query('DELETE FROM auth_sessions WHERE user_id = $1::uuid', [existing[0].id]);
  console.log(`\n  password reset for ${party.name}`);
} else {
  // permissions stays an empty grant set: a portal account's reach comes from
  // its party link and the /portal routes, never from ERP module grants.
  await query(
    `INSERT INTO users (full_name, email, mobile, password_hash, password_salt, password_algo,
                        role, permissions, status, must_change_password, ${linkCol})
     VALUES ($1, $2::citext, $3, $4, $5, $6, $7::user_role, '{"grants":[]}'::jsonb, 'ACTIVE', true, $8::uuid)`,
    [party.name, email, party.mobile_no ?? null, hashHex, saltHex, ALGO, role, party.id]);
  console.log(`\n  portal login created for ${party.name}`);
}

console.log(`  role     : ${role}`);
console.log(`  email    : ${email}`);
console.log(`  password : ${password}`);
console.log(`  (shown once — stored only as a PBKDF2 hash; the user must change it at first login)\n`);
process.exit(0);
