// Before/after screenshot of the Tailwind-heavy Login screen (no auth needed).
// Usage: node scripts/login-shot.cjs <label>
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const label = process.argv[2] || 'shot';
const OUT = path.join(__dirname, '..', 'mobile-shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(3500); // splash → login
  const file = path.join(OUT, `login-${label}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
