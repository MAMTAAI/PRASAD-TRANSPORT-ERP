// QA: Fixed Expenses panel in Master Trip Settlement detail dropdown.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, '..', 'mobile-shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1700, height: 950 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA Admin', name: 'QA Admin', role: 'Super Admin', email: 'qa@local' }));
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4500);
  await page.getByText('Master Trip Settlement', { exact: true }).first().click();
  await page.waitForTimeout(3500);

  const vehSel = page.locator('select').first();
  const opts = await vehSel.locator('option').allTextContents();
  let best = null;
  for (let i = 1; i < Math.min(opts.length, 15); i++) {
    await vehSel.selectOption({ index: i });
    await page.waitForTimeout(800);
    const details = await page.getByText('▼ Detail').count();
    if (details > 0) {
      // open each detail until one shows a fixed target (not the empty message)
      for (let d = 0; d < Math.min(details, 6); d++) {
        await page.getByText('▼ Detail').first().click();
        await page.waitForTimeout(500);
        const hasPanel = await page.getByText('FIXED EXPENSES (TRIP TARGET)').count();
        const hasTargets = await page.getByText(/Fixed HSD|Fixed Cash/).count();
        if (hasPanel && hasTargets) { best = { vehicle: opts[i], targets: true }; break; }
        if (hasPanel && !best) best = { vehicle: opts[i], targets: false };
        await page.getByText('▲').first().click().catch(() => {});
        await page.waitForTimeout(300);
      }
      if (best && best.targets) break;
    }
  }
  console.log('result:', JSON.stringify(best), '| page errors:', errors.length);
  errors.slice(0, 4).forEach(e => console.log('  ! ' + e.slice(0, 140)));
  await page.screenshot({ path: path.join(OUT, 'fixed-expense-panel.png') });
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
