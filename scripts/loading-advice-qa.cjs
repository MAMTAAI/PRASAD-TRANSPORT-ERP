// QA: Loading Advice tab + both loading pathways (advice-attach & direct).
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

  // 1) Trip Management → LOADING ADVICE tab
  await page.getByText('Trip Management', { exact: true }).first().click();
  await page.waitForTimeout(3000);
  const tab = page.getByText('LOADING ADVICE');
  console.log('advice tab visible:', (await tab.count()) >= 1);
  await tab.first().click();
  await page.waitForTimeout(1200);
  const formOk = await page.getByText('New Loading Advice (Pre-Trip)').count();
  const adviseNo = await page.getByPlaceholder(/Advise No from document/).count();
  const emptyMsg = await page.getByText('Koi open Loading Advice nahi').count();
  console.log(`advice form: ${formOk >= 1} | advise-no input: ${adviseNo >= 1} | empty-list msg: ${emptyMsg >= 1}`);
  await page.screenshot({ path: path.join(OUT, 'loading-advice-tab.png') });

  // 2) Direct Loading Entry path must be untouched (no advice → no prompt)
  page.on('dialog', async d => { console.log('UNEXPECTED DIALOG:', d.message().slice(0, 80)); await d.dismiss(); });
  await page.getByText('Loading Details', { exact: true }).first().click();
  await page.waitForTimeout(2500);
  const startSel = page.locator('select').filter({ has: page.locator('option[value="NEW"]') }).first();
  await startSel.selectOption('NEW');
  await page.waitForTimeout(1200);
  // type a vehicle that has no advice
  const vehInput = page.getByPlaceholder('Type to search...');
  await vehInput.fill('AS26C7319');
  await page.waitForTimeout(300);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(800);
  const lrVal = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label'));
    const l = labels.find(x => x.textContent.includes('LR No / Trip ID'));
    return l ? l.parentElement.querySelector('input').value : 'NOT FOUND';
  });
  console.log(`direct entry works, LR auto-generated: "${lrVal}"`);
  await page.screenshot({ path: path.join(OUT, 'direct-loading-entry.png') });

  console.log('page errors:', errors.length);
  errors.slice(0, 4).forEach(e => console.log('  ! ' + e.slice(0, 140)));
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
