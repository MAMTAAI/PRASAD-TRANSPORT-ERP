// QA (read-only): open Tyre Management → Fit Tyre modal → type vehicle + NEW
// serial → verify position dropdown + procurement panel render. No saves.
const { chromium } = require('playwright');
const path = require('path');
const OUT = path.join('E:', 'PRASAD-TRANSPORT-ERP', 'mobile-shots');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA Admin', name: 'QA Admin', role: 'Super Admin', email: 'qa@local' }));
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4000);
  await page.getByText('Tyre Management', { exact: true }).first().click({ timeout: 8000 });
  await page.waitForTimeout(3000);

  // Open the fitment modal
  await page.getByText('Fit Tyre to Vehicle', { exact: false }).first().click({ timeout: 5000 });
  await page.waitForTimeout(1000);

  // Type an unknown vehicle number (tests default 10+1 fallback) + new serial
  await page.getByPlaceholder('Type Vehicle No (e.g. 9805)...').fill('QA-TEST-9999');
  await page.waitForTimeout(800);
  await page.getByPlaceholder('Type New or Select from Stock...').fill('QA-NEW-SERIAL-001');
  await page.waitForTimeout(800);

  const dropdown = await page.locator('select').filter({ hasText: 'Select Tyre Position' }).count();
  const procPanel = await page.getByText('NEW TYRE DETECTED', { exact: false }).count();
  const costField = await page.getByPlaceholder('e.g. 18500').count();
  const truckMap = await page.locator('.truck-chassis-container').count();

  await page.screenshot({ path: path.join(OUT, 'tyre-fitment-new.png'), fullPage: false });
  console.log(`position-dropdown: ${dropdown > 0 ? 'OK' : 'MISSING'}`);
  console.log(`truck-map (fallback 10+1): ${truckMap > 0 ? 'OK' : 'MISSING'}`);
  console.log(`procurement-panel: ${procPanel > 0 ? 'OK' : 'MISSING'}`);
  console.log(`cost-field: ${costField > 0 ? 'OK' : 'MISSING'}`);
  console.log(`console-errors: ${errors.length}`);
  if (errors.length) errors.slice(0, 5).forEach(e => console.log('   ! ' + e.slice(0, 160)));
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
