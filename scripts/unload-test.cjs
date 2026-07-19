// Test Unloading shortage/penalty auto-calc in the Trip unload modal.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.addInitScript(() => localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA', name: 'QA', role: 'Super Admin', email: 'qa@local' })));
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4000);
  await page.getByText('Trip Management', { exact: true }).first().click();
  await page.waitForTimeout(2500);

  // Click the first "✅ Unload" action button in Live Tracking
  const unloadBtn = page.getByRole('button', { name: /Unload/ }).first();
  const cnt = await page.getByRole('button', { name: /Unload/ }).count();
  console.log('unload buttons found:', cnt);
  await unloadBtn.click();
  await page.waitForTimeout(1200);
  const modalOpen = await page.evaluate(() => document.body.innerText.includes('Final Unloading'));
  console.log('modal "Final Unloading" open:', modalOpen);
  await page.screenshot({ path: 'mobile-shots/unload-modal.png' });

  // Set Loaded=20000 (override), Unloaded=19850, rate=50 -> shortage 150, penalty 7500
  const setField = async (labelText, val) => {
    const inp = page.locator(`div:has(> label:text-is("${labelText}")) input`).first();
    await inp.fill(String(val));
    await page.waitForTimeout(300);
  };
  await setField('Loaded Qty (Auto)', '20000');
  await setField('Unloaded Qty *', '19850');
  await setField('Penalty Rate (₹/unit)', '50');
  await page.waitForTimeout(500);

  const shortage = await page.locator('div:has(> label:text-is("Shortage (Auto)")) input').first().inputValue();
  const penalty = await page.locator('div:has(> label:text-is("Penalty ₹ (Auto, editable)")) input').first().inputValue();
  console.log('Loaded 20000, Unloaded 19850, Rate 50');
  console.log('  Shortage (expect 150):', shortage, shortage === '150' ? '✅' : '❌');
  console.log('  Penalty  (expect 7500):', penalty, penalty === '7500' ? '✅' : '❌');
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
