// Screenshot an ACCOUNTS-module page (desktop + phone), optional tab click.
const { chromium } = require('playwright');
const path = require('path');
const LABEL = process.argv[2], SLUG = process.argv[3], TAB = process.argv[4] || '';
const OUT = path.join('E:', 'PRASAD-TRANSPORT-ERP', 'mobile-shots');
const VPS = [{ name: 'desktop', w: 1280, h: 900 }, { name: 'phone', w: 390, h: 844 }];
(async () => {
  const browser = await chromium.launch();
  for (const vp of VPS) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA Admin', name: 'QA Admin', role: 'Super Admin', email: 'qa@local' }));
    });
    await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(4000);
    // Switch to ACCOUNTS module (top nav on desktop, bottom nav on phone)
    try { await page.getByText(/ACCOUNTS/i).first().click({ timeout: 5000 }); await page.waitForTimeout(1200); } catch (e) { console.log(`[${vp.name}] module fail`); }
    if (vp.w <= 600) { try { await page.getByText('☰', { exact: false }).first().click({ timeout: 3000 }); await page.waitForTimeout(600); } catch {} }
    try { await page.getByText(LABEL, { exact: true }).first().click({ timeout: 5000 }); } catch (e) { console.log(`[${vp.name}] nav fail`); }
    await page.waitForTimeout(2500);
    if (TAB) { try { await page.getByText(TAB, { exact: false }).first().click({ timeout: 4000 }); await page.waitForTimeout(1200); } catch {} }
    const file = path.join(OUT, `${SLUG}-${vp.name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(`[${vp.name}] saved ${path.basename(file)} | overflow ${overflow}px | errors ${errors.length}`);
    if (errors.length) errors.slice(0, 3).forEach(e => console.log('   ! ' + e.slice(0, 140)));
    await ctx.close();
  }
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
