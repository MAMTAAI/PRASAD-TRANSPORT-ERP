// Test the off-master Google Maps RTKM auto-calc in Trip Management.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => { if (m.type() === 'error') logs.push('ERR ' + m.text().slice(0, 160)); });
  await page.addInitScript(() => localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA', name: 'QA', role: 'Super Admin', email: 'qa@local' })));
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4000);

  // Navigate to Trip Management
  await page.getByText('Trip Management', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  // Open START NEW TRIP tab
  await page.getByText('START NEW TRIP', { exact: false }).first().click();
  await page.waitForTimeout(1000);

  // Fill an off-master route (real places, unlikely in master)
  const consignee = page.getByPlaceholder('Select Route to Auto-Fill...');
  await consignee.fill('Guwahati Railway Station, Assam');
  const loadingInput = page.locator('div:has(> label:text-is("Loading Point (Auto)")) input').first();
  await loadingInput.fill('Dibrugarh, Assam');
  await page.waitForTimeout(400);

  // Click the Maps calc button
  await page.getByText('Calculate RTKM via Google Maps', { exact: false }).click();
  // Wait for either info or error to appear
  await page.waitForTimeout(6000);

  const rtkmVal = await page.locator('div:has(> label:text-is("RTKM (Auto)")) input').first().inputValue().catch(() => '');
  const hsdVal = await page.locator('div:has(> label:text-is("Fix HSD (Auto)")) input').first().inputValue().catch(() => '');
  const cashVal = await page.locator('div:has(> label:text-is("Fix Cash (Auto)")) input').first().inputValue().catch(() => '');
  const bodyText = await page.evaluate(() => document.body.innerText);
  const infoLine = bodyText.split('\n').find(l => l.includes('RTKM') && l.includes('km')) || '';
  const errLine = bodyText.split('\n').find(l => l.includes('⚠️')) || '';

  console.log('RTKM field   :', rtkmVal);
  console.log('Fix HSD field:', hsdVal);
  console.log('Fix Cash field:', cashVal);
  console.log('Info line    :', infoLine.slice(0, 160));
  console.log('Error line   :', errLine.slice(0, 160));
  console.log('Console errs :', logs.length);
  logs.slice(0, 5).forEach(l => console.log('  ' + l));
  await page.screenshot({ path: require('path').join(__dirname, '..', 'mobile-shots', 'maps-calc.png') });
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
