// QA: Driver Master global search — search bar filters by name / mobile / vehicle.
// Usage: node scripts/driver-search-qa.cjs [query]
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const QUERY = process.argv[2] || 'arun';
const OUT = path.join(__dirname, '..', 'mobile-shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA Admin', name: 'QA Admin', role: 'Super Admin', email: 'qa@local' }));
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4000);
  try { await page.getByText('Driver Master', { exact: true }).first().click({ timeout: 8000 }); }
  catch (e) { console.log('nav fail: ' + e.message.slice(0, 100)); }
  await page.waitForTimeout(3500);

  const countRows = () => page.locator('table tbody tr').count();
  const before = await countRows();
  await page.screenshot({ path: path.join(OUT, 'driver-search-before.png') });

  const box = page.getByPlaceholder(/Search Driver Name/i);
  await box.fill(QUERY);
  await page.waitForTimeout(700); // debounce 250ms + render
  const after = await countRows();
  await page.screenshot({ path: path.join(OUT, 'driver-search-after.png') });

  await box.fill('');
  await page.waitForTimeout(700);
  const cleared = await countRows();

  console.log(`rows before search: ${before} | after "${QUERY}": ${after} | after clear: ${cleared} | errors: ${errors.length}`);
  if (errors.length) errors.slice(0, 5).forEach(e => console.log('  ! ' + e.slice(0, 160)));
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
