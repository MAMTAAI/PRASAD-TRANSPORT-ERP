// QA: date pickers in Pay-to-Driver + Issue Fuel/Cash Memo modals (TripManagment).
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, '..', 'mobile-shots');
fs.mkdirSync(OUT, { recursive: true });
const TODAY = new Date().toISOString().split('T')[0];

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA Admin', name: 'QA Admin', role: 'Super Admin', email: 'qa@local' }));
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4000);
  await page.getByText('Trip Management', { exact: true }).first().click();
  await page.waitForTimeout(3500);

  // Need the ACTIVE/IN-TRANSIT tab where Pay/Fuel buttons live
  const tabBtn = page.getByText(/IN.TRANSIT|ACTIVE|LIVE/i).first();
  if (await tabBtn.count()) { await tabBtn.click().catch(() => {}); await page.waitForTimeout(1500); }

  // 💸 Pay modal
  const payBtn = page.getByText('💸 Pay', { exact: true }).first();
  if (!await payBtn.count()) { console.log('NO Pay button visible — no in-transit trips?'); }
  else {
    await payBtn.click(); await page.waitForTimeout(1000);
    const dateInp = page.locator('input[type=date]').first();
    const val = await dateInp.inputValue().catch(() => 'MISSING');
    const label = await page.getByText('Payment Date').count();
    console.log(`Pay modal: date label=${label >= 1} | value="${val}" | today=${val === TODAY}`);
    await dateInp.fill('2026-07-01');
    console.log(`backdate set to: "${await dateInp.inputValue()}"`);
    await page.screenshot({ path: path.join(OUT, 'pay-modal-date.png') });
    await page.keyboard.press('Escape');
    await page.getByText('Cancel', { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(800);
  }

  // ⛽ Fuel modal
  const fuelBtn = page.getByText('⛽ Fuel', { exact: true }).first();
  if (!await fuelBtn.count()) { console.log('NO Fuel button visible'); }
  else {
    await fuelBtn.click(); await page.waitForTimeout(1200);
    const label = await page.getByText('Transaction / Issue Date').count();
    const dateInp = page.locator('input[type=date]').last();
    const val = await dateInp.inputValue().catch(() => 'MISSING');
    console.log(`Fuel modal: date label=${label >= 1} | value="${val}" | today=${val === TODAY}`);
    await page.screenshot({ path: path.join(OUT, 'fuel-modal-date.png') });
  }

  console.log(`page errors: ${errors.length}`);
  errors.slice(0, 4).forEach(e => console.log('  ! ' + e.slice(0, 140)));
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
