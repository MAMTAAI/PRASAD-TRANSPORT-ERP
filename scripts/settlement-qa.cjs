// QA: Master Trip Settlement module + Loading rate auto-fill.
// node scripts/settlement-qa.cjs
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, '..', 'mobile-shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGE: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA Admin', name: 'QA Admin', role: 'Super Admin', email: 'qa@local' }));
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4000);

  // 1) Sidebar shows renamed item
  const oldItem = await page.getByText('Unloading Details', { exact: true }).count();
  const newItem = await page.getByText('Master Trip Settlement', { exact: true }).count();
  console.log(`sidebar: "Unloading Details"=${oldItem} (want 0) | "Master Trip Settlement"=${newItem} (want >=1)`);

  // 2) Open settlement module
  try { await page.getByText('Master Trip Settlement', { exact: true }).first().click({ timeout: 8000 }); } catch (e) { console.log('nav fail: ' + e.message.slice(0, 90)); }
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, 'settlement-empty.png') });

  // 3) Pick first vehicle with trips
  const vehSel = page.locator('select').first();
  const opts = await vehSel.locator('option').allTextContents();
  if (opts.length > 1) {
    // try a few vehicles until one has unsettled trips
    for (let i = 1; i < Math.min(opts.length, 12); i++) {
      await vehSel.selectOption({ index: i });
      await page.waitForTimeout(900);
      const rows = await page.locator('table tbody tr').count();
      const noTrips = await page.getByText('koi unsettled trip nahi').count();
      if (rows > 0 && noTrips === 0) { console.log(`vehicle "${opts[i]}" → ${rows} unsettled trips`); break; }
    }
  }
  // select all + expand first row + add extra expense
  const selectAll = page.locator('table thead input[type=checkbox]');
  if (await selectAll.count()) { await selectAll.check(); await page.waitForTimeout(500); }
  const detailBtn = page.getByText('▼ Detail').first();
  if (await detailBtn.count()) { await detailBtn.click(); await page.waitForTimeout(500); }
  const nameInp = page.getByPlaceholder(/Tyre Puncture/);
  if (await nameInp.count()) {
    await nameInp.fill('QA Test Expense');
    await page.getByPlaceholder('₹').fill('500');
    await page.getByText('+ Add', { exact: true }).click();
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: path.join(OUT, 'settlement-selected.png'), fullPage: true });

  // 4) Unloading tab intact
  await page.getByText('UNLOADING / CLOSE TRIP').click();
  await page.waitForTimeout(1500);
  const unloadHdr = await page.getByText('Unloading & Shortage Register').count();
  console.log(`unloading tab renders old module: ${unloadHdr >= 1}`);
  await page.screenshot({ path: path.join(OUT, 'settlement-unloading-tab.png') });

  // 5) History tab
  await page.getByText('SETTLEMENT HISTORY').click();
  await page.waitForTimeout(800);

  // 6) Loading Details rate auto-fill (visual only — needs RTKM data)
  await page.getByText('Loading Details', { exact: true }).first().click();
  await page.waitForTimeout(2500);
  const startSel = page.locator('select').filter({ has: page.locator('option[value="NEW"]') }).first();
  if (await startSel.count()) {
    await startSel.selectOption('NEW');
    await page.waitForTimeout(1200);
    const routeInp = page.getByPlaceholder(/Type Depot or Consignee/);
    if (await routeInp.count()) {
      // read datalist options via DOM
      const routeOpts = await page.evaluate(() => Array.from(document.querySelectorAll('#master-route-list option')).slice(0, 5).map(o => o.value));
      console.log('route options sample:', JSON.stringify(routeOpts, null, 1).slice(0, 500));
      if (routeOpts.length) {
        await routeInp.fill(routeOpts.find(v => !/₹0$/.test(v)) || routeOpts[0]);
        await page.waitForTimeout(800);
        const rateVal = await page.evaluate(() => {
          const labels = Array.from(document.querySelectorAll('label'));
          const l = labels.find(x => x.textContent.includes('Rate / Freight'));
          return l ? l.parentElement.querySelector('input').value : 'FIELD NOT FOUND';
        });
        const rtkmVal = await page.evaluate(() => {
          const labels = Array.from(document.querySelectorAll('label'));
          const l = labels.find(x => x.textContent.includes('RTKM'));
          return l ? l.parentElement.querySelector('input').value : 'FIELD NOT FOUND';
        });
        console.log(`after route select → Rate field: "${rateVal}" | RTKM field: "${rtkmVal}"`);
        await page.screenshot({ path: path.join(OUT, 'loading-rate-autofill.png') });
      }
    }
  }

  console.log(`console errors: ${errors.length}`);
  errors.slice(0, 6).forEach(e => console.log('  ! ' + e.slice(0, 150)));
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
