// QA (render-only): Accounts & Admin → Rate Master screen renders — form fields,
// calc-type dropdown switches RTKM field visibility, effective dates present. No saves.
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

  // ACCOUNTS module → Rate Master sidebar item
  await page.getByText('ACCOUNTS & ADMIN', { exact: false }).first().click({ timeout: 8000 });
  await page.waitForTimeout(1500);
  await page.getByText('Rate Master (Freight Rules)', { exact: false }).first().click({ timeout: 8000 });
  await page.waitForTimeout(3000);

  const header = await page.getByText('Dynamic Rate Master', { exact: false }).count();
  const calcSelect = await page.locator('select').filter({ hasText: 'RTKM Based (KL)' }).count();
  const effFrom = await page.getByText('Effective From', { exact: false }).count();

  // Default calc type = PER_UNIT → RTKM field hidden
  const rtkmHidden = await page.getByText('RTKM Distance (km)', { exact: false }).count();
  // Switch to RTKM Based (KL) → RTKM field appears
  await page.locator('select').filter({ hasText: 'RTKM Based (KL)' }).first().selectOption('RTKM_KL');
  await page.waitForTimeout(500);
  const rtkmShown = await page.getByText('RTKM Distance (km)', { exact: false }).count();

  await page.screenshot({ path: path.join(OUT, 'rate-master.png'), fullPage: true });
  console.log(`header: ${header > 0 ? 'OK' : 'MISSING'}`);
  console.log(`calc-type-dropdown: ${calcSelect > 0 ? 'OK' : 'MISSING'}`);
  console.log(`effective-from field: ${effFrom > 0 ? 'OK' : 'MISSING'}`);
  console.log(`rtkm field: hidden-when-PER_UNIT=${rtkmHidden === 0 ? 'OK' : 'FAIL'} | shown-when-RTKM_KL=${rtkmShown > 0 ? 'OK' : 'FAIL'}`);
  console.log(`page-errors: ${errors.length}`);
  if (errors.length) errors.slice(0, 3).forEach(e => console.log('   ! ' + e.slice(0, 140)));
  await browser.close();
  process.exit(header && calcSelect && effFrom && rtkmHidden === 0 && rtkmShown > 0 && !errors.length ? 0 : 1);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
