// 📱 Phase 2 verification — screenshot the app at phone/tablet/desktop widths
// and objectively detect horizontal page overflow. Injects a temporary local
// admin session (no Firestore writes) so authenticated modules render.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:5173/';
const OUT = path.join(__dirname, '..', 'mobile-shots');
fs.mkdirSync(OUT, { recursive: true });

const WIDTHS = [
  { name: 'phone-390', w: 390, h: 844 },
  { name: 'tablet-768', w: 768, h: 1024 },
  { name: 'desktop-1280', w: 1280, h: 800 },
];

(async () => {
  const browser = await chromium.launch();
  const results = [];
  for (const vp of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    // Inject admin session BEFORE app scripts run.
    await page.addInitScript(() => {
      localStorage.setItem('prasad_user', JSON.stringify({
        full_name: 'Mobile Test Admin', name: 'Mobile Test Admin', role: 'Super Admin', email: 'test@local',
      }));
    });
    await page.goto(BASE, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(4000); // splash (2.5s) + first data paint

    const overflow = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      innerW: window.innerWidth,
    }));
    const horiz = overflow.scrollW - overflow.clientW;
    const file = path.join(OUT, `${vp.name}-DASHBOARD.png`);
    await page.screenshot({ path: file, fullPage: true }).catch(() => {});
    results.push({ vp: vp.name, view: 'DASHBOARD', ...overflow, horizOverflowPx: horiz, overflow: horiz > 1 });
    await ctx.close();
  }
  await browser.close();
  console.log(JSON.stringify(results, null, 2));
  const bad = results.filter(r => r.overflow);
  console.log('\n=== HORIZONTAL OVERFLOW SUMMARY ===');
  if (!bad.length) console.log('✅ No horizontal page overflow at any width/view tested.');
  else bad.forEach(b => console.log(`❌ ${b.vp} / ${b.view}: +${b.horizOverflowPx}px`));
})().catch(e => { console.error('SHOT FAILED:', e.message); process.exit(1); });
