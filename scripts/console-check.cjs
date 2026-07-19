// 🐞 Phase 3 — capture runtime console errors / uncaught exceptions / failed
// requests on the live app at desktop + mobile. Injects a temp admin session.
const { chromium } = require('playwright');

const BASE = 'http://localhost:5173/';
// Heavy data modules to sweep on desktop (clicked by sidebar label text).
const MODULES = [
  'Trip Management', 'Loading Details', 'Unloading Details', 'Our Vehicle Fleet',
  'Driver Master', 'Route & RTKM', 'Fuel (HSD) Mgmt', 'Vehicle Documents',
];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  let bucket = 'DASHBOARD';
  const byModule = {};
  const record = (kind, text) => {
    byModule[bucket] = byModule[bucket] || { errors: [], warnings: 0, warnTexts: [] };
    if (kind === 'error') byModule[bucket].errors.push(text);
    else { byModule[bucket].warnings++; if (byModule[bucket].warnTexts.length < 3) byModule[bucket].warnTexts.push(text); }
  };
  page.on('console', msg => { if (msg.type() === 'error') record('error', msg.text()); else if (msg.type() === 'warning') record('warning', msg.text()); });
  page.on('pageerror', err => record('error', 'UNCAUGHT: ' + err.message));

  await page.addInitScript(() => {
    localStorage.setItem('prasad_user', JSON.stringify({
      full_name: 'QA Admin', name: 'QA Admin', role: 'Super Admin', email: 'qa@local',
    }));
  });
  await page.goto(BASE, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(5000); // splash + dashboard load

  for (const label of MODULES) {
    bucket = label;
    try {
      const el = page.getByText(label, { exact: true }).first();
      await el.click({ timeout: 5000 });
      await page.waitForTimeout(2500); // module mount + Firestore load
    } catch (e) {
      record('error', `NAV-FAILED: could not open "${label}" — ${e.message.slice(0, 120)}`);
    }
  }
  await browser.close();

  console.log('===== RUNTIME CONSOLE SWEEP (desktop, real data) =====');
  let totalErr = 0;
  for (const [name, r] of Object.entries(byModule)) {
    totalErr += r.errors.length;
    console.log(`\n• ${name}: ${r.errors.length} errors, ${r.warnings} warnings`);
    r.errors.slice(0, 10).forEach((e, i) => console.log(`  E ${i + 1}. ${e.slice(0, 280)}`));
    (r.warnTexts || []).forEach((w, i) => console.log(`  W ${i + 1}. ${w.slice(0, 200)}`));
  }
  console.log(`\n===== TOTAL console errors across ${Object.keys(byModule).length} views: ${totalErr} =====`);
  console.log(totalErr === 0 ? '✅ Zero runtime errors.' : '❌ Errors found (see above).');
})().catch(e => { console.error('CHECK FAILED:', e.message); process.exit(1); });
