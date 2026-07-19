// E2E: MAMTA AI agent mode — ask a question that needs a tool, verify trace+answer.
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
  await page.getByText('CRM PANEL', { exact: false }).first().click();
  await page.waitForTimeout(2000);
  await page.getByText('🤖 MAMTA AI', { exact: true }).click();
  await page.waitForTimeout(1500);

  // Build index (needed for search_erp; counts/analytics use Firestore directly)
  await page.getByRole('button', { name: /Build Index/ }).click();
  for (let i = 0; i < 40; i++) { await page.waitForTimeout(3000); if ((await page.evaluate(() => document.body.innerText)).includes('Index ready')) { console.log('index built'); break; } }

  // Ask a question that should trigger the trip_status_counts tool
  const inp = page.locator('input[placeholder*="sawaal"], input[placeholder*="Build Index"]').last();
  await inp.fill('Abhi kitne trips in transit hain? Aur total kitne trips hain?');
  await page.getByRole('button', { name: /Send/ }).click();
  console.log('asked agent question, waiting…');

  let body = '';
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(3000);
    body = await page.evaluate(() => document.body.innerText);
    if (/trip_status_counts|byStatus|In Transit|transit/i.test(body) && /\d/.test(body.split('in transit hain').pop() || '')) break;
  }
  const tail = (body.split('Aur total kitne trips hain?').pop() || '').replace(/▌/g, '').trim();
  const hasTrace = /🔧.*trip_status_counts|🔧.*Operations/.test(body);
  console.log('\nTOOL TRACE present:', hasTrace);
  console.log('ANSWER:\n' + tail.slice(0, 400));
  console.log('\npage errors:', errs.length);
  errs.slice(0, 3).forEach(e => console.log('  ! ' + e.slice(0, 140)));
  await page.screenshot({ path: path.join(__dirname, '..', 'mobile-shots', 'agent-mode.png') });
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
