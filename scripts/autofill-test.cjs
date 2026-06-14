// Test Trip New-form auto-fills: vehicle->operating company, customer->rate hint.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA', name: 'QA', role: 'Super Admin', email: 'qa@local' })));
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4000);
  await page.getByText('Trip Management', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await page.getByText('START NEW TRIP', { exact: false }).first().click();
  await page.waitForTimeout(1000);

  // Select the first real vehicle option
  const vehSelect = page.locator('div:has(> label:text-is("Vehicle No *")) select').first();
  const opts = await vehSelect.locator('option').allTextContents();
  const firstVeh = opts.find(o => o && !o.includes('Choose'));
  if (firstVeh) await vehSelect.selectOption({ label: firstVeh });
  await page.waitForTimeout(800);
  const opCo = await page.locator('div:has(> label:text-is("Operating Company (Auto)")) input').first().inputValue().catch(() => '');
  const driver = await page.locator('div:has(> label:text-is("Driver Name")) input, div:has(> label) input').first().inputValue().catch(() => '');

  console.log('Selected vehicle :', firstVeh);
  console.log('Operating Company:', opCo || '(empty)');

  // Customer rate hint: type a customer that exists in trips
  const custInput = page.getByPlaceholder('Enter Customer');
  await custInput.fill('IOCL');
  await page.waitForTimeout(800);
  const body = await page.evaluate(() => document.body.innerText);
  const hint = body.split('\n').find(l => l.includes('Last freight')) || '';
  console.log('Customer hint    :', hint.slice(0, 80) || '(none for "IOCL")');

  await page.screenshot({ path: require('path').join(__dirname, '..', 'mobile-shots', 'autofill.png') });
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
