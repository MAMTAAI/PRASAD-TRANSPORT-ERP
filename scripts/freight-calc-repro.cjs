// REPRO: Auto Billing (Monthly) — fetch trips, type qty+rate in row 1, verify
// the Freight cell updates live. Read-only until blur (blur persists qty/rate
// to that trip — acceptable: real values from the client's own workflow).
const { chromium } = require('playwright');
const path = require('path');
const OUT = path.join(__dirname, '..', 'mobile-shots');

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { console.log('DIALOG:', d.message().slice(0, 100).replace(/\n/g, ' | ')); await d.accept().catch(() => {}); });
  await page.addInitScript(() => {
    localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA Admin', name: 'QA Admin', role: 'Super Admin', email: 'qa@local' }));
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4000);
  try { await page.getByText('ACCOUNTS & ADMIN', { exact: false }).first().click({ timeout: 4000 }); await page.waitForTimeout(800); } catch {}
  await page.getByText('Auto Billing (Monthly)', { exact: false }).first().click({ timeout: 8000 });
  await page.waitForTimeout(2500);

  // Customer + month + fetch
  await page.getByPlaceholder('e.g. Aadhar Green Industries LLP').fill('INDIAN OIL CORPORATION LTD');
  await page.locator('input[type="month"]').fill('2026-07');
  await page.getByText('⚡ Fetch Trips', { exact: false }).click();
  await page.waitForTimeout(3500);

  const rows = await page.locator('table tbody tr').count();
  console.log('freight rows:', rows);
  if (!rows) { console.log('NO ROWS — cannot repro'); await browser.close(); return; }

  // Row 1: qty and rate inputs are the number inputs in that row
  const row1 = page.locator('table tbody tr').first();
  const numInputs = row1.locator('input[type="number"]');
  console.log('number inputs in row1:', await numInputs.count());
  await numInputs.nth(0).fill('12');      // qty
  await numInputs.nth(1).fill('254.5');   // rate (no blur yet)
  await page.waitForTimeout(600);
  const rowText = await row1.innerText();
  const freightMatch = rowText.match(/₹[\d,.]+/g);
  console.log('row1 freight cells:', JSON.stringify(freightMatch));
  const expected = 12 * 254.5; // 3054
  const ok = (freightMatch || []).some(x => x.replace(/[₹,]/g, '').startsWith('3054') || x.replace(/[₹,]/g, '').startsWith('3,054'));
  console.log(`live calc 12 × 254.5 = 3054 => ${ok ? 'PASS ✓' : 'FAIL ✗'}`);

  // footer totals
  const footer = await page.locator('text=NET PAYABLE AMOUNT').locator('..').innerText().catch(() => '');
  console.log('footer:', footer.replace(/\n/g, ' '));
  await page.screenshot({ path: path.join(OUT, 'freight-calc-repro.png'), fullPage: false });
  console.log('page-errors:', errors.length, errors.slice(0, 3));
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
