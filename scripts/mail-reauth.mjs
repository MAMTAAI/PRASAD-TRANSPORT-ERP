// scripts/mail-reauth.mjs
// ─────────────────────────────────────────────────────────────────────────────
// RE-AUTHORISE BOTH IOCL MAILBOXES AND HAND THE TOKENS TO PRODUCTION.
//
// The OAuth consent screen for project prasad-transport-290213 is in Testing
// mode, so Google revokes every refresh token after 7 days. When that happens
// BOTH mailboxes go dark at once (5-Sep-2026: prasadtransport699@gmail.com and
// jaiswalenterprise2016@gmail.com, tokens dated 28-Aug, both "expired or
// revoked") and the AC4/AC5 sweep, the payment advices and the customer
// reconciliation all stop, quietly. Only a person can grant access again —
// a browser opens, you sign in to each mailbox, you approve.
//
//   npm run mail:reauth                 # both mailboxes, then copy to AWS
//   npm run mail:reauth -- --only prasad
//   npm run mail:reauth -- --only jaiswal
//   npm run mail:reauth -- --no-copy    # authorise here, do not touch AWS
//
// The durable fix is Google Cloud Console → APIs & Services → OAuth consent
// screen → PUBLISH APP (Production). An unverified published app still works
// for your own accounts (click "Advanced → go to app" once) and its tokens do
// not expire every week.
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(REPO, 'tools', 'iocl_recon');
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const ONLY = arg('--only');
const NO_COPY = process.argv.includes('--no-copy');
const AWS = process.env.PRASAD_AWS_SSH ?? 'ubuntu@65.0.27.161';
const KEY = process.env.PRASAD_AWS_KEY ?? path.join(os.homedir(), '.ssh', 'prasad-key.pem');
const REMOTE_TOOLS = '/var/www/prasad-erp/tools/iocl_recon';

const BOXES = [
  { key: 'prasad', token: 'gmail_token.json', label: 'Prasad Transport — prasadtransport699@gmail.com' },
  { key: 'jaiswal', token: 'jaiswal_token.json', label: 'Jaiswal Enterprise — jaiswalenterprise2016@gmail.com' },
].filter((b) => !ONLY || b.key === ONLY);

const PY = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', cwd: REPO, ...opts });

console.log(`\n${'='.repeat(74)}\n IOCL MAILBOX RE-AUTHORISATION\n${'='.repeat(74)}`);
if (!fs.existsSync(path.join(TOOLS, 'gmail_credentials.json'))) {
  console.error(`\n  tools/iocl_recon/gmail_credentials.json is missing — download the OAuth client (Desktop app) from Google Cloud first.`);
  process.exit(2);
}
const done = [];
for (const b of BOXES) {
  console.log(`\n── ${b.label}\n   A browser will open. Sign in to THIS mailbox and approve read-only access.\n`);
  const r = run(PY, [path.join(TOOLS, 'gmail_setup.py'), '--token', b.token, '--force', '--no-survey']);
  if (r.status !== 0) { console.error(`\n  ${b.key}: authorisation did not complete (exit ${r.status}). Fix that and re-run.`); continue; }
  const check = run(PY, [path.join(TOOLS, 'gmail_setup.py'), '--token', b.token, '--check', '--no-survey']);
  if (check.status !== 0) { console.error(`\n  ${b.key}: the new token does not verify.`); continue; }
  done.push(b);
}
if (!done.length) { console.error('\n  Nothing authorised.'); process.exit(1); }

if (NO_COPY) { console.log(`\n  Authorised: ${done.map((b) => b.key).join(', ')}. Not copied to AWS (--no-copy).`); process.exit(0); }

console.log(`\n── Copying ${done.length} token(s) to production (${AWS})`);
if (!fs.existsSync(KEY)) { console.error(`  SSH key not found at ${KEY} — set PRASAD_AWS_KEY. Tokens are authorised locally; copy them by hand to ${REMOTE_TOOLS}/`); process.exit(1); }
let bad = 0;
for (const b of done) {
  const r = run('scp', ['-i', KEY, '-o', 'ConnectTimeout=20', path.join(TOOLS, b.token), `${AWS}:${REMOTE_TOOLS}/${b.token}`]);
  if (r.status !== 0) { bad += 1; console.error(`  ${b.token}: copy failed`); }
}
run('ssh', ['-i', KEY, '-o', 'ConnectTimeout=20', AWS, `chmod 600 ${REMOTE_TOOLS}/*.json; ls -la ${REMOTE_TOOLS}/*token*.json`]);
if (bad) process.exit(1);
console.log(`
  Done. On the box the agents pick this up on their own:
    · KALI / BHUVANESHWARI sweep AC4 / AC5 every 10 minutes (mailboxes_failed should go empty in cron_sync.log)
    · the daily advice run (customer_advice_collect, after 04:00 IST) reads BOTH mailboxes' payment advices;
      run it now from Bill Management → 15-Day Bills → "advice collect" (admin) or wait for the morning.
  Then Google Cloud → OAuth consent screen → Publish app, or this repeats in 7 days.
`);
