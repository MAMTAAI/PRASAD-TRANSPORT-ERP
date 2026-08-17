// ============================================================================
//  play-screenshots.mjs - capture Play Store phone screenshots from the REAL app
//
//  Usage:
//      node -r dotenv/config scripts/play-screenshots.mjs
//
//  Requires (the script checks and tells you which one is missing):
//      - the API on 127.0.0.1:3300      (npm run api)
//      - the built app on localhost:4173 (npx vite preview --port 4173)
//
//  WHY NOT MOCK-UPS. Play's Deceptive Behaviour policy treats a screenshot that
//  does not show the actual in-app experience as grounds for rejection, and a
//  designed "hero" image in the phone slots is exactly that. So these are real
//  captures of the real screens against the real database.
//
//  THE SESSION IS TEMPORARY AND CLEANED UP. requireAuth checks auth_sessions on
//  every request, so a hand-minted JWT alone is refused - a row has to exist.
//  This script inserts one that expires in 10 minutes, uses it, and deletes it
//  in a finally block. It writes nothing else: no password is changed, no user
//  is created. Screens are read-only captures.
// ============================================================================
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { query } from '../server/db/pool.js';
import { issueToken } from '../server/lib/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'play-store', 'screenshots');
const APP = 'http://localhost:4173/';
const API = 'http://127.0.0.1:3300';

// Play wants each side between 320 and 3840 px and a 16:9-ish portrait ratio.
// 1080x1920 is the safe, universally accepted phone slot. Captured as a
// 540x960 CSS viewport at 2x so text renders at real phone density rather than
// being upscaled.
const VIEWPORT = { width: 540, height: 960 };
const SCALE = 2;

// Which screens to capture, in listing order. `nav` is the visible label to
// click in the app shell; null means "whatever the app lands on after login".
// The shell is a bottom tab bar (Ops / Accounts / CRM) on a phone, so `nav`
// matches those labels. `scroll` captures further down the same screen, which
// is how the KPI cards get their own slot without faking a second page.
const SHOTS = [
  { file: '01-command-center', nav: null,       scroll: 0,    wait: 4500 },
  { file: '02-fleet-kpis',     nav: null,       scroll: 1400, wait: 1200 },
  { file: '03-accounts',       nav: 'Accounts', scroll: 0,    wait: 3500 },
  { file: '04-crm',            nav: 'CRM',      scroll: 0,    wait: 3500 },
  { file: '05-staff-access',   nav: null,       scroll: 1500, wait: 1200 },
];

async function preflight() {
  const problems = [];
  for (const [name, url] of [['API', `${API}/healthz`], ['preview server', APP]]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) problems.push(`${name} answered ${r.status} at ${url}`);
    } catch {
      problems.push(`${name} is not reachable at ${url}`);
    }
  }
  if (problems.length) {
    console.error('\nCannot capture screenshots:');
    for (const p of problems) console.error('  - ' + p);
    console.error('\n  npm run api');
    console.error('  npx vite preview --port 4173 --strictPort\n');
    process.exit(1);
  }
}

async function main() {
  await preflight();
  mkdirSync(OUT, { recursive: true });

  // ---- pick the account to shoot with -------------------------------------
  const { rows: users } = await query(
    `SELECT id, email, full_name, role, permissions
       FROM users
      WHERE role = 'SUPER_ADMIN' AND account_status = 'ACTIVE'
      ORDER BY created_at
      LIMIT 1`);
  if (!users.length) throw new Error('No ACTIVE SUPER_ADMIN to capture with.');
  const u = users[0];
  console.log(`[shots] capturing as ${u.email} (${u.role})`);

  // ---- temporary session ---------------------------------------------------
  const jti = randomUUID();
  const { token, expiresAt } = issueToken({ sub: u.id, jti, role: u.role, name: u.full_name });
  const shortExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await query(
    `INSERT INTO auth_sessions (jti, user_id, expires_at, user_agent, ip)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
    [jti, u.id, shortExpiry, 'play-screenshots.mjs (temporary, 10 min)', null]);
  console.log(`[shots] temporary session ${jti} valid until ${shortExpiry}`);

  const profile = {
    ...u,
    uid: u.id,
    permissions: u.permissions?.grants ?? (Array.isArray(u.permissions) ? u.permissions : []),
  };

  let browser;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      isMobile: true,
      hasTouch: true,
    });

    // Seed the session BEFORE any app script runs, so the shell never paints
    // the login screen and no frame of the capture shows a logged-out state.
    await ctx.addInitScript(
      ([tok, exp, prof]) => {
        localStorage.setItem('prasad_token', tok);
        localStorage.setItem('prasad_token_expires', exp);
        localStorage.setItem('prasad_user', prof);
      },
      [token, String(expiresAt ?? ''), JSON.stringify(profile)],
    );

    const page = await ctx.newPage();
    const failures = [];
    page.on('response', (r) => {
      if (r.url().includes('/api/v1/') && r.status() >= 400) {
        failures.push(`${r.status()} ${r.url().replace(API, '')}`);
      }
    });

    await page.goto(APP, { waitUntil: 'networkidle' }).catch(() => {});

    for (const shot of SHOTS) {
      if (shot.nav) {
        // Click the first visible control whose text contains the label. The
        // shell is state-driven, not routed, so there is no URL to navigate to.
        const target = page
          .locator(`button:visible, a:visible, [role="button"]:visible`)
          .filter({ hasText: new RegExp(shot.nav, 'i') })
          .first();
        const found = await target.count().then((c) => c > 0).catch(() => false);
        if (!found) {
          console.log(`[shots] SKIP ${shot.file}: no control matching /${shot.nav}/i`);
          continue;
        }
        await target.click({ timeout: 5000 }).catch(() => {});
      }
      await page.waitForTimeout(shot.wait);
      if (shot.scroll) {
        // The shell scrolls an inner container, not the document, so
        // window.scrollTo does nothing here - it produced a byte-identical
        // duplicate of the previous shot. A wheel event goes to whatever is
        // under the pointer, which is the container that actually scrolls.
        await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
        await page.mouse.wheel(0, shot.scroll);
        await page.waitForTimeout(700);
      }
      const file = path.join(OUT, `${shot.file}.png`);
      await page.screenshot({ path: file });
      console.log(`[shots] wrote ${path.relative(process.cwd(), file)}`);
    }

    if (failures.length) {
      console.log('\n[shots] API errors seen while capturing (screens may look empty):');
      for (const f of [...new Set(failures)]) console.log('   ' + f);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    // Always revoke. A forgotten admin session is a real credential.
    const { rowCount } = await query('DELETE FROM auth_sessions WHERE jti = $1::uuid', [jti]);
    console.log(`[shots] temporary session deleted (${rowCount} row)`);
  }
}

main().then(
  () => process.exit(0),
  (e) => { console.error('[shots] FAILED:', e.message); process.exit(1); },
);
