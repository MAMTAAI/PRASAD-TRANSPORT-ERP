// QA (render-only): open "Our Vehicle Fleet" with the qa@local bypass.
// Expect: (a) session guard does NOT kick out the QA user, (b) if VEHICLES
// read is permission-blocked the RED diagnostic banner shows (never a silent
// empty grid), (c) if it loads, vehicle cards render.
const { chromium } = require('playwright');
const path = require('path');
const OUT = path.join(__dirname, '..', 'mobile-shots');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { console.log('DIALOG:', d.message().slice(0, 120)); await d.dismiss().catch(() => {}); });
  await page.addInitScript(() => {
    localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA Admin', name: 'QA Admin', role: 'Super Admin', email: 'qa@local' }));
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4500);

  const kicked = await page.getByText('Login', { exact: false }).count() > 2; // crude: login screen visible
  await page.getByText('Our Vehicle Fleet', { exact: true }).first().click({ timeout: 8000 }).catch(e => console.log('nav fail:', e.message.slice(0, 60)));
  await page.waitForTimeout(4000);

  const banner = await page.getByText('PERMISSION BLOCKED', { exact: false }).count();
  const emptyMsg = await page.getByText('koi vehicle nahi mili', { exact: false }).count();
  const cards = await page.locator('.glass-card').count();
  await page.screenshot({ path: path.join(OUT, 'fleet-visibility.png'), fullPage: false });
  console.log(`qa-user kicked to login: ${kicked ? 'YES (BAD)' : 'no (good)'}`);
  console.log(`permission-banner: ${banner} | empty-msg: ${emptyMsg} | vehicle-cards: ${cards}`);
  console.log(`silent-empty (all zero = BAD): ${banner + emptyMsg + cards === 0 ? 'YES — BAD' : 'no — diagnostics visible'}`);
  console.log(`page-errors: ${errors.length}`);
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
