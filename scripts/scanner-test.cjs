// E2E: Loading module → Mamta AI Scanner (local Gemma) → form auto-fill.
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.addInitScript(() => localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA', name: 'QA', role: 'Super Admin', email: 'qa@local' })));
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4000);

  await page.getByText('Loading Details', { exact: true }).first().click();
  await page.waitForTimeout(1500);

  // Start a fresh direct entry to reveal the scanner
  const startSelect = page.locator('select').first();
  await startSelect.selectOption('NEW');
  await page.waitForTimeout(1000);

  // Upload the sample slip into the scanner's file input
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(path.join(__dirname, '..', 'mobile-shots', 'sample-slip.png'));
  console.log('uploaded sample slip — waiting for LOCAL Gemma extraction…');

  // Wait for fields to populate (poll up to 90s)
  let filled = '';
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(3000);
    filled = await page.evaluate(() => Array.from(document.querySelectorAll('input')).map(i => i.value).join(' | '));
    if (filled.includes('AS01CC4567') || filled.includes('1900456789')) break;
  }

  const body = await page.evaluate(() => document.body.innerText);
  const check = (label, needle) => console.log(`  ${needle && (filled.includes(needle) || body.includes(needle)) ? '✅' : '❌'} ${label}: ${needle}`);
  console.log('\nAUTO-FILL RESULTS:');
  check('Vehicle', 'AS01CC4567');
  check('Challan/Invoice', '1900456789');
  check('Consignee', 'AGARTALA');
  check('Loading Point', 'Bongaigaon');
  check('Quantity', '20000');
  console.log('\npage errors:', errs.length);
  errs.slice(0, 4).forEach(e => console.log('  ! ' + e.slice(0, 140)));

  await page.screenshot({ path: path.join(__dirname, '..', 'mobile-shots', 'scanner-result.png'), fullPage: true });
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
