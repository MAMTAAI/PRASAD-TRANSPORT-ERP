// QA (render-only): open Office Staff Login, type a password, click the eye
// toggle, and verify the field switches password->text and back.
const { chromium } = require('playwright');
const path = require('path');
const OUT = path.join(__dirname, '..', 'mobile-shots');

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4000);
  // Public site → staff login (button text may vary; try common entries)
  for (const label of ['Office Staff Login', 'Staff Login', 'ERP LOGIN', 'Login']) {
    try { await page.getByText(label, { exact: false }).first().click({ timeout: 2500 }); await page.waitForTimeout(1200); } catch {}
    if (await page.locator('input[type="password"]').count()) break;
  }
  const pw = page.locator('input[type="password"]').first();
  await pw.fill('Prasad@2026');
  const eye = page.getByTitle('Password dekhein');
  const hasEye = await eye.count();
  let visibleAfter = 'n/a', hiddenAgain = 'n/a';
  if (hasEye) {
    await eye.click();
    visibleAfter = await page.locator('input[type="text"][value=""], input[type="text"]').evaluateAll(
      els => els.some(el => el.value === 'Prasad@2026')) ? 'text-visible' : 'still-hidden';
    await page.getByTitle('Password chhupayein').click();
    hiddenAgain = (await page.locator('input[type="password"]').count()) ? 'hidden-again' : 'BAD';
  }
  await page.screenshot({ path: path.join(OUT, 'login-eye.png') });
  console.log(`eye-button: ${hasEye ? 'OK' : 'MISSING'} | after-click: ${visibleAfter} | re-hide: ${hiddenAgain}`);
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
