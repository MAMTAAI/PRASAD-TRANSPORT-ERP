#!/usr/bin/env node
/**
 * scripts/provision-team.mjs — the nine core-team accounts, and their onboarding.
 *
 * WHY A SCRIPT AND NOT NINE CLICKS: the roster is fixed, the ordering is not
 * obvious, and getting the order wrong fails SILENTLY. See the warning below.
 *
 * WHAT IT REFUSES TO DO. It never sets a password and never prints one. Every
 * account is created with the MIGRATION_PLACEHOLDER hash and
 * must_change_password = true, exactly as POST /users does, so each person sets
 * their own through the OTP cascade. A static passkey handed out over chat is a
 * credential living in somebody's message history forever; this never mints one.
 *
 * IT NEVER OVERWRITES. The eight new rows are INSERT ... ON CONFLICT DO NOTHING,
 * so re-running is safe and an existing colleague is never clobbered. The one
 * exception is deliberate, explicit and owner-approved (2026-09-01):
 *
 *   SUBHAS PRASAD is an UPDATE, not an insert. mamta.ai@jaiswalcapital.com is
 *   an existing live login and `email` is UNIQUE, so there is no second row to
 *   be had. It is renamed and promoted to SUPER_ADMIN in place. Its PASSWORD IS
 *   LEFT ALONE — whoever signs in today still can, and that account therefore
 *   needs no onboarding code at all.
 *
 * THE ORDERING THAT BITES. Migration 050 gives account_status a DEFAULT of
 * 'PENDING', and POST /users never sets the column. A PENDING account makes
 * /password-reset/request answer 403 ACCOUNT_PENDING_APPROVAL and send NOTHING.
 * Provisioning and then notifying, without approving in between, delivers zero
 * messages to nine people and reads as success. So --apply sets account_status
 * ACTIVE and approved_at explicitly, and --notify re-checks per row and refuses
 * to count a send it cannot stand behind.
 *
 *   node -r dotenv/config scripts/provision-team.mjs             # dry run (default)
 *   node -r dotenv/config scripts/provision-team.mjs --apply     # write the rows
 *   node -r dotenv/config scripts/provision-team.mjs --notify    # send onboarding codes
 *
 * RUN THIS ON THE BOX — the accounts must exist in the AWS database.
 */
import { initDb, query, isDegraded, DB_TARGET } from '../server/db/pool.js';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (argv[i + 1] ?? d); };

const APPLY = has('apply');
const NOTIFY = has('notify');
const API = val('api', 'http://127.0.0.1:3300/api/v1/auth');
// One WhatsApp session serves the whole firm on a 2 GB box. Nine sends fired
// back to back is the shape that has tripped WhatsApp's own rate limit before,
// and losing the session costs a re-pair on a machine with no screen.
const GAP_MS = Number(val('gap', '8000'));

const PLACEHOLDER = 'MIGRATION-RESET-REQUIRED';   // must match auth.routes.js:48
const last10 = (p) => String(p ?? '').replace(/\D/g, '').slice(-10);

// full_name, email, mobile, role, mode
const ROSTER = [
  ['SUBHAS PRASAD',        'mamta.ai@jaiswalcapital.com',      '9864001130', 'SUPER_ADMIN', 'rename'],
  ['LAXMAN PRASAD',        'lp1495378@gmail.com',              '9435021201', 'ADMIN',       'create'],
  ['SANDEEP KUMAR PRASAD', 'sandeepkumarprasad1985@gmail.com', '9435022586', 'ADMIN',       'create'],
  ['VISHAL PRASAD',        'vishaljaiswal8333@gmail.com',      '6000949655', 'ADMIN',       'create'],
  ['KUNAL PRASAD',         'jaiswalkunal349@gmail.com',        '8099156668', 'ADMIN',       'create'],
  ['GAUTAM PRASAD',        'prasadgautam329@gmail.com',        '7002775847', 'ADMIN',       'create'],
  ['SANTOSH PRASAD',       'santoshprasad576@gmail.com',       '9435021200', 'ADMIN',       'create'],
  ['RITIKA PRASAD',        'ritikaprasad099@gmail.com',        '9395672010', 'ADMIN',       'create'],
  ['MAMTA PRASAD',         'mamtaprasad00001@gmail.com',       '7002048621', 'ADMIN',       'create'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (s, n) => String(s).padEnd(n);

await initDb({ attempts: 2 });
if (isDegraded()) { console.error('\n  no database reachable\n'); process.exit(1); }
console.log(`\n  database: ${DB_TARGET}\n`);

const look = async (email) => (await query(
  `SELECT id, full_name, role::text AS role, account_status::text AS account_status,
          (password_hash = $2 OR password_salt IS NULL) AS needs_password
     FROM users WHERE lower(email::text) = $1`, [email.toLowerCase(), PLACEHOLDER])).rows[0] ?? null;

// ── notify: the onboarding cascade ─────────────────────────────────────────
if (NOTIFY) {
  console.log(`  onboarding codes via ${API}, ${GAP_MS}ms apart\n`);
  let sent = 0;
  let skipped = 0;
  for (const [name, email] of ROSTER) {
    const row = await look(email);
    if (!row) {
      console.log(`  SKIP  ${pad(name, 22)} no account — run --apply first`);
      skipped++; continue;
    }
    if (row.account_status !== 'ACTIVE') {
      console.log(`  SKIP  ${pad(name, 22)} account_status=${row.account_status} — a code would NOT be delivered`);
      skipped++; continue;
    }
    if (!row.needs_password) {
      console.log(`  SKIP  ${pad(name, 22)} already has a password — no onboarding needed`);
      skipped++; continue;
    }
    try {
      const res = await fetch(`${API}/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.log(`  FAIL  ${pad(name, 22)} ${res.status} ${j.error ?? ''} ${j.detail ?? ''}`);
        skipped++;
      } else {
        // The route reports the wires it actually delivered on. An empty list
        // with a 200 means neutrality, not delivery — do not call that sent.
        const via = (j.delivered ?? []).map((d) => d.channel).join('+');
        console.log(via
          ? `  SENT  ${pad(name, 22)} ${via}`
          : `  ????  ${pad(name, 22)} 200 but no channel reported — verify by hand`);
        if (via) sent++; else skipped++;
      }
    } catch (e) {
      console.log(`  FAIL  ${pad(name, 22)} ${e.message}`);
      skipped++;
    }
    if (GAP_MS) await sleep(GAP_MS);
  }
  console.log(`\n  ${sent} sent, ${skipped} skipped.\n`);
  process.exit(0);
}

// ── plan / apply ───────────────────────────────────────────────────────────
const plan = [];
for (const [name, email, mobile, role, mode] of ROSTER) {
  const row = await look(email);
  if (mode === 'rename') {
    plan.push(row
      ? { name, email, mobile, role, act: 'UPDATE', why: `rename "${row.full_name}" (${row.role}) -> ${name} (${role}); password untouched` }
      : { name, email, mobile, role, act: 'INSERT', why: 'expected an existing row, found none — will create instead' });
  } else if (row) {
    plan.push({ name, email, mobile, role, act: 'SKIP', why: `already exists as ${row.full_name} (${row.role}/${row.account_status})` });
  } else {
    plan.push({ name, email, mobile, role, act: 'INSERT', why: 'new account, ACTIVE, no password, must_change_password' });
  }
}

console.log(`  ${APPLY ? 'APPLYING' : 'DRY RUN — nothing is written; pass --apply to commit'}\n`);
for (const p of plan) console.log(`  ${pad(p.act, 7)} ${pad(p.name, 22)} ${pad(p.email, 34)} ${p.why}`);

if (!APPLY) {
  console.log('\n  re-run with --apply to write, then --notify to send the codes.\n');
  process.exit(0);
}

await query('BEGIN');
try {
  for (const p of plan) {
    if (p.act === 'SKIP') continue;
    if (p.act === 'UPDATE') {
      await query(
        `UPDATE users SET full_name = $2, role = $3::user_role, mobile = $4,
                account_status = 'ACTIVE'::account_status,
                approved_at = COALESCE(approved_at, now()), updated_at = now()
          WHERE lower(email::text) = $1`,
        [p.email.toLowerCase(), p.name, p.role, last10(p.mobile)]);
    } else {
      // users_email_active_uniq (migration 001) is a PARTIAL unique index:
      //   ON users (email) WHERE status = 'ACTIVE' AND email IS NOT NULL
      // — two retired rows may share an address, two live ones may not. A bare
      // ON CONFLICT (email) infers no constraint and Postgres rejects the whole
      // statement ("no unique or exclusion constraint matching"), so the index
      // predicate has to be repeated here for the inference to match.
      //
      // Note this clause only guards a RACE. The real duplicate check is look()
      // above, which ignores status and so also catches an INACTIVE row holding
      // the address — something this partial index deliberately does not.
      await query(
        `INSERT INTO users (full_name, email, mobile, role, status, account_status, approved_at,
                            password_hash, password_salt, must_change_password)
         VALUES ($1,$2,$3,$4::user_role,'ACTIVE','ACTIVE'::account_status, now(), $5, NULL, true)
         ON CONFLICT (email) WHERE status = 'ACTIVE' AND email IS NOT NULL DO NOTHING`,
        [p.name, p.email.toLowerCase(), last10(p.mobile), p.role, PLACEHOLDER]);
    }
  }
  await query('COMMIT');
} catch (e) {
  await query('ROLLBACK');
  console.error(`\n  ROLLED BACK — nothing was written: ${e.message}\n`);
  process.exit(1);
}

console.log('\n  committed. verifying:\n');
for (const [name, email] of ROSTER) {
  const r = await look(email);
  console.log(`  ${pad(name, 22)} ${r
    ? `${pad(r.role, 12)} ${pad(r.account_status, 9)} ${r.needs_password ? 'needs password' : 'has password'}`
    : 'MISSING'}`);
}
console.log('\n  now: node -r dotenv/config scripts/provision-team.mjs --notify\n');
process.exit(0);
