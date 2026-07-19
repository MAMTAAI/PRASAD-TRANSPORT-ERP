// QA (render-only): Pending Billing pipeline — customer → LOCATION nested
// grouping renders; qty auto-filled from loading details (non-zero values).
const { chromium } = require('playwright');
const path = require('path');
const OUT = path.join(__dirname, '..', 'mobile-shots');

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA Admin', name: 'QA Admin', role: 'Super Admin', email: 'qa@local' }));
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4000);
  try { await page.getByText('ACCOUNTS & ADMIN', { exact: false }).first().click({ timeout: 4000 }); await page.waitForTimeout(800); } catch {}
  await page.getByText('Bill Management', { exact: false }).first().click({ timeout: 8000 });
  await page.waitForTimeout(5000);

  const locHeaders = await page.locator('tr', { hasText: '🏭' }).count();
  const qtyInputs = page.locator('input[title="Billed Qty (KL) — challan se"]');
  const qtyCount = await qtyInputs.count();
  let nonZero = 0;
  for (let i = 0; i < Math.min(qtyCount, 25); i++) {
    const v = await qtyInputs.nth(i).inputValue();
    if (parseFloat(v) > 0) nonZero++;
  }
  await page.screenshot({ path: path.join(OUT, 'location-billing.png'), fullPage: false });
  console.log(`location-subheaders: ${locHeaders} (want >0)`);
  console.log(`qty auto-filled (first 25 rows): ${nonZero}/25 non-zero`);
  console.log(`page-errors: ${errors.length}`);
  if (errors.length) errors.slice(0, 3).forEach(e => console.log('   ! ' + e.slice(0, 140)));
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
