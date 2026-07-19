// E2E: open MAMTA AI chat in WhatsappDashboard, build index, ask a question.
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.addInitScript(() => localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA', name: 'QA', role: 'Super Admin', email: 'qa@local' })));
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4000);

  // Open the WhatsApp/CRM panel directly
  await page.getByText('CRM PANEL', { exact: false }).first().click();
  await page.waitForTimeout(2500);
  // Open MAMTA AI tab (the WhatsappDashboard sidebar tab, not App's CRM nav button)
  await page.getByText('🤖 MAMTA AI', { exact: true }).click();
  await page.waitForTimeout(1500);
  console.log('MAMTA tab open:', await page.evaluate(() => document.body.innerText.includes('ERP data par sawaal')));

  // Build index
  await page.getByRole('button', { name: /Build Index/ }).click();
  console.log('building index…');
  let built = false;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(3000);
    const txt = await page.evaluate(() => document.body.innerText);
    const m = txt.match(/Index ready — (\d+) ERP records/);
    if (m) { console.log('  index built:', m[1], 'records'); built = true; break; }
  }
  if (!built) { console.log('  index build did not finish in time'); }

  // Ask a question
  const inp = page.locator('input[placeholder*="sawaal"], input[placeholder*="Build Index"]').last();
  await inp.fill('Agartala jaane wale trips kaunse hain?');
  await page.getByRole('button', { name: /Send/ }).click();
  console.log('question sent, waiting for streamed answer…');
  let tail = '';
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(3000);
    const answer = await page.evaluate(() => document.body.innerText);
    tail = (answer.split('Agartala jaane wale trips kaunse hain?').pop() || '').replace(/▌/g, '').trim();
    if (tail.length > 40 && /PT00|GP00|trip|transit|status|nahi|hai/i.test(tail)) break;
  }
  console.log('\nANSWER:\n' + tail.slice(0, 500));
  console.log('\npage errors:', errs.length);
  errs.slice(0, 4).forEach(e => console.log('  ! ' + e.slice(0, 140)));
  await page.screenshot({ path: path.join(__dirname, '..', 'mobile-shots', 'mamta-chat.png') });
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
