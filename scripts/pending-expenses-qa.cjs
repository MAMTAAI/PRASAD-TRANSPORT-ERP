// QA (render-only): Pending Expenses now shows the fuel-pending KPI + guidance.
// FUEL_ENTRIES is readable? staff-only per rules — QA bypass may get 0; the
// check is that the KPI card RENDERS (count text present), not the number.
const { chromium } = require('playwright');
const path = require('path');
const OUT = path.join(__dirname, '..', 'mobile-shots');

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  await page.addInitScript(() => {
    localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA Admin', name: 'QA Admin', role: 'Super Admin', email: 'qa@local' }));
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4000);
  try { await page.getByText('ACCOUNTS & ADMIN', { exact: false }).first().click({ timeout: 4000 }); await page.waitForTimeout(800); } catch {}
  await page.getByText('Pending Expenses', { exact: false }).first().click({ timeout: 8000 });
  await page.waitForTimeout(3500);
  const fuelKpi = await page.getByText('Fuel Slips — Bill Pending', { exact: false }).count();
  await page.screenshot({ path: path.join(OUT, 'pending-expenses.png'), fullPage: false });
  console.log(`fuel-pending KPI: ${fuelKpi > 0 ? 'OK' : 'MISSING'}`);
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
