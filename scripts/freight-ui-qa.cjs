// QA (render-only): Route & RTKM master → Billing Type dropdown + Add Rate
// Period editor render + row add/remove works. No saves.
const { chromium } = require('playwright');
const path = require('path');
const OUT = path.join(__dirname, '..', 'mobile-shots');

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA Admin', name: 'QA Admin', role: 'Super Admin', email: 'qa@local' }));
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4000);
  await page.getByText('Route & RTKM', { exact: false }).first().click({ timeout: 8000 });
  await page.waitForTimeout(3000);

  const btSelect = await page.locator('select').filter({ hasText: 'RTKM × Qty' }).count();
  await page.getByText('➕ Add Rate Period', { exact: false }).click({ timeout: 5000 });
  await page.waitForTimeout(500);
  await page.getByText('➕ Add Rate Period', { exact: false }).click();
  await page.waitForTimeout(500);
  const rateInputs = await page.getByPlaceholder('e.g. 3.432495').count();
  // remove one row
  await page.locator('button[title="Remove period"]').first().click();
  await page.waitForTimeout(400);
  const afterRemove = await page.getByPlaceholder('e.g. 3.432495').count();

  await page.screenshot({ path: path.join(OUT, 'freight-master.png'), fullPage: false });
  console.log(`billing-type-dropdown: ${btSelect > 0 ? 'OK' : 'MISSING'}`);
  console.log(`rate-rows added: ${rateInputs} (want 2) | after remove: ${afterRemove} (want 1)`);
  console.log(`page-errors: ${errors.length}`);
  if (errors.length) errors.slice(0, 3).forEach(e => console.log('   ! ' + e.slice(0, 140)));
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
