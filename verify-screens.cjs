/**
 * Headless render check for the two screens just ported.
 *
 * The browser extension dropped mid-verification and the previous deploy of
 * these screens WHITE-SCREENED on a ReferenceError, so "it builds" is not
 * evidence here — the crash happened at render, not at build. This drives the
 * real page and fails loudly on any console error or empty body.
 */
const { chromium } = require('playwright');

const SCREENS = [
  ['Tyre Management', 'TYRE'],
  ['Battery Management', 'BATTERY'],
  ['Loan & EMI Mgmt', 'LOAN'],
  ['Workshop/Maint.', 'MAINT'],
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });

  await page.goto('https://prasadtransport.com/', { waitUntil: 'domcontentloaded' });
  // The SPA gates on a stored user; same QA bypass the manual checks used.
  await page.evaluate(() => {
    localStorage.setItem('prasad_user', JSON.stringify({ email: 'qa@local', full_name: 'QA', role: 'ADMIN', permissions: [] }));
  });
  // Service worker would serve the previous bundle.
  await page.evaluate(async () => {
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
  });
  await page.reload({ waitUntil: 'networkidle' });

  const clickText = async (label) => page.evaluate((l) => {
    const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === l);
    if (!el) return false;
    let n = el;
    for (let i = 0; i < 5 && n; i++) { n.click(); n = n.parentElement; }
    return true;
  }, label);

  const results = [];
  for (const section of ['🚛 OPERATIONS', '💰 ACCOUNTS & ADMIN']) await clickText(section).catch(() => {});

  for (const [label, tag] of SCREENS) {
    errors.length = 0;
    for (const section of ['🚛 OPERATIONS', '💰 ACCOUNTS & ADMIN']) {
      await clickText(section);
      await page.waitForTimeout(400);
      if (await clickText(label)) break;
    }
    await page.waitForTimeout(4500);
    const text = await page.evaluate(() => document.body.innerText || '');
    results.push({
      screen: label,
      rendered: text.length > 200,
      chars: text.length,
      errors: errors.slice(0, 3),
    });
  }

  await browser.close();
  let bad = 0;
  for (const r of results) {
    const ok = r.rendered && r.errors.length === 0;
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.screen.padEnd(22)} chars=${String(r.chars).padStart(6)}  errors=${r.errors.length}`);
    r.errors.forEach((e) => console.log(`        ${e.slice(0, 160)}`));
  }
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('harness failed:', e.message); process.exit(2); });
