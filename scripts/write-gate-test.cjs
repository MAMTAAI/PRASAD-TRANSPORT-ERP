// Verify write-with-confirmation GATE: agent proposes create_trip but it is
// NOT saved until the user confirms. We assert the preview appears and do NOT
// click Confirm (so nothing is written to the real Firestore).
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

  const inp = page.locator('input[placeholder*="sawaal"], input[placeholder*="Build Index"]').last();
  await inp.fill('Ek naya trip banao: vehicle AS01CC4567, consignee AGARTALA AFS, product HSD, qty 20000.');
  await page.getByRole('button', { name: /Send/ }).click();
  console.log('asked agent to create a trip, waiting for confirmation preview…');

  let ok = false;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(3000);
    const body = await page.evaluate(() => document.body.innerText);
    if (/Confirm & Save/.test(body)) { ok = true; break; }
  }
  const body = await page.evaluate(() => document.body.innerText);
  const hasPreview = /create_trip/.test(body);
  const hasConfirmBtn = await page.getByRole('button', { name: /Confirm & Save/ }).count();
  const hasCancelBtn = await page.getByRole('button', { name: /Cancel/ }).count();
  const saysSaved = /Save ho gaya|created with id/.test(body); // must be FALSE (not yet confirmed)

  console.log('\n✋ WRITE GATE CHECK:');
  console.log('  preview shows create_trip   :', hasPreview ? '✅' : '❌');
  console.log('  Confirm & Save button present:', hasConfirmBtn > 0 ? '✅' : '❌');
  console.log('  Cancel button present        :', hasCancelBtn > 0 ? '✅' : '❌');
  console.log('  NOT yet saved (no auto-write):', !saysSaved ? '✅' : '❌ DANGER');
  console.log('  (Confirm intentionally NOT clicked — no write to real data)');
  console.log('page errors:', errs.length);
  await page.screenshot({ path: path.join(__dirname, '..', 'mobile-shots', 'write-gate.png') });
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
