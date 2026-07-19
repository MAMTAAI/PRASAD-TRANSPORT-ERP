// QA (render-only, NO typing => no Firestore writes): open Bill Management →
// Pending Billing table → verify inline qty/rate inputs render per trip row.
const { chromium } = require('playwright');
const path = require('path');
const OUT = path.join(__dirname, '..', 'mobile-shots');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA Admin', name: 'QA Admin', role: 'Super Admin', email: 'qa@local' }));
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4000);
  try { await page.getByText('ACCOUNTS & ADMIN', { exact: false }).first().click({ timeout: 4000 }); await page.waitForTimeout(800); } catch {}
  await page.getByText('Bill Management', { exact: false }).first().click({ timeout: 8000 });
  await page.waitForTimeout(4000);

  const qtyInputs = await page.locator('input[title="Billed Qty (KL) — challan se"]').count();
  const rateInputs = await page.locator('input[title^="Freight Rate"]').count();
  await page.screenshot({ path: path.join(OUT, 'billing-inline-qty-rate.png'), fullPage: false });
  console.log(`pending-rows qty-inputs: ${qtyInputs}, rate-inputs: ${rateInputs} ${qtyInputs > 0 && qtyInputs === rateInputs ? '=> OK' : '=> CHECK (0 rows? filter?)'}`);
  console.log(`console-errors: ${errors.length}`);
  if (errors.length) errors.slice(0, 5).forEach(e => console.log('   ! ' + e.slice(0, 160)));
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
