// Repro: crash when opening UNLOADING tab inside Master Trip Settlement.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
  page.on('pageerror', e => console.log('PAGEERROR:', e.message.slice(0, 400)));
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0, 300)); });
  await page.addInitScript(() => {
    localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA Admin', name: 'QA Admin', role: 'Super Admin', email: 'qa@local' }));
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4000);
  await page.getByText('Master Trip Settlement', { exact: true }).first().click();
  await page.waitForTimeout(2500);
  console.log('--- clicking UNLOADING tab ---');
  await page.getByText('UNLOADING / CLOSE TRIP').click();
  await page.waitForTimeout(2500);
  const body = await page.evaluate(() => document.body.innerText.slice(0, 200));
  console.log('body text after click:', JSON.stringify(body));
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
