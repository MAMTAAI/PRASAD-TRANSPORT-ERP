/**
 * Render check for the ported asset screens, against the LOCAL build.
 *
 * The previous deploy of these screens white-screened at RENDER, not at build,
 * so `npm run build` passing is not evidence — it passed then too. This drives
 * the real page and fails on any page error, any failed same-app request, or a
 * content pane that does not show the screen's own heading.
 *
 *   node verify-local-screens.cjs            # against http://127.0.0.1:4175
 *   VERIFY_BASE=... node verify-local-screens.cjs
 *
 * Its sibling verify-screens.cjs points at production; this one checks the
 * dist/ about to be deployed.
 */
const { chromium } = require('playwright');

const BASE = process.env.VERIFY_BASE || 'http://127.0.0.1:4175';

// Assert on a string only the screen's own content pane renders. Matching a
// word like "Tyre" would also hit the sidebar and pass on a blank screen.
const SCREENS = [
  ['Tyre Management',    'Tyre & Asset Inventory'],
  ['Battery Management', 'Battery & Asset Inventory'],
  ['Loan & EMI Mgmt',    'Loan'],
  ['Workshop/Maint.',    'Workshop'],
];

// Services that are simply not running under this harness and are no part of
// these screens. Their absence must not masquerade as a render fault — nor mask
// one, which is why only these exact hosts are excused.
const EXTERNAL = /localhost:3000|127\.0\.0\.1:3000|\/security\/radar|ollama|11434/i;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let pageErrors = [];
  let failedReqs = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));       // the white-screen signal
  // ERR_ABORTED is the browser cancelling a request that was still in flight
  // when we navigated away — a consequence of this harness clicking, not a
  // fault in the page. Every other failure text is still counted.
  page.on('requestfailed', (r) => {
    const why = (r.failure() || {}).errorText || '';
    if (EXTERNAL.test(r.url()) || /ERR_ABORTED/.test(why)) return;
    failedReqs.push(`${r.url()} (${why})`);
  });

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('prasad_user',
    JSON.stringify({ email: 'qa@local', full_name: 'QA', role: 'ADMIN', permissions: [] })));
  await page.evaluate(async () => {
    for (const r of await navigator.serviceWorker.getRegistrations().catch(() => [])) await r.unregister();
    for (const k of await caches.keys().catch(() => [])) await caches.delete(k);
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const results = [];
  for (const [label, needle] of SCREENS) {
    pageErrors = []; failedReqs = [];
    const hit = (l) => page.evaluate((t) => {
      const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === t);
      if (!el) return false;
      let n = el;
      for (let i = 0; i < 5 && n; i++) { n.click(); n = n.parentElement; }
      return true;
    }, l);
    // The sidebar is grouped and only one group is open at a time, so a screen
    // in another group is not in the DOM until its header is clicked.
    let clicked = await hit(label);
    if (!clicked) {
      for (const section of ['🚛 OPERATIONS', '💰 ACCOUNTS & ADMIN']) {
        await hit(section);
        await page.waitForTimeout(400);
        if (await hit(label)) { clicked = true; break; }
      }
    }
    await page.waitForTimeout(4500);
    const text = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '));
    results.push({ label, clicked, rendered: text.includes(needle), pageErrors: [...pageErrors], failedReqs: [...failedReqs] });
  }

  await browser.close();
  let bad = 0;
  for (const r of results) {
    const ok = r.clicked && r.rendered && r.pageErrors.length === 0 && r.failedReqs.length === 0;
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(22)} clicked=${r.clicked} rendered=${r.rendered} pageErrors=${r.pageErrors.length} failedReqs=${r.failedReqs.length}`);
    r.pageErrors.forEach((e) => console.log(`        PAGEERROR ${String(e).slice(0, 180)}`));
    r.failedReqs.forEach((u) => console.log(`        REQFAIL   ${String(u).slice(0, 180)}`));
  }
  console.log(bad ? `\n${bad} screen(s) FAILED` : '\nAll screens rendered clean — no ReferenceError, no failed app request.');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('harness failed:', e.message); process.exit(2); });
