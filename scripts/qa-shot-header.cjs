// Visual check of the refactored header + Master Control v5.0.
// Uses the '@local' QA bypass in App.tsx (a stored profile whose email ends in
// @local skips the /auth/me session guard), and signs in as SUPER_ADMIN — the
// role whose spelling used to miss the admin check entirely.
const { chromium } = require('playwright');

const BASE = process.argv[2] || 'http://127.0.0.1:4173';
const OUT = process.argv[3] || 'mobile-shots';

const QA_USER = {
  id: 'qa-0000', full_name: 'SUBHAS PRASAD', email: 'qa@local',
  role: 'SUPER_ADMIN', branch: 'BONGAIGAON', permissions: [],
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate((u) => {
    localStorage.setItem('prasad_user', JSON.stringify(u));
    localStorage.setItem('prasad_token', 'qa-local-token');
  }, QA_USER);
  await page.reload({ waitUntil: 'domcontentloaded' });

  // The splash screen holds for 2.5s by design.
  await page.waitForTimeout(4500);
  await page.screenshot({ path: `${OUT}/qa-header.png` });
  console.log('wrote qa-header.png');

  // Open the avatar menu (far right of the header).
  const avatar = page.locator('button[aria-haspopup="menu"]').last();
  if (await avatar.count()) {
    await avatar.click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/qa-profile-menu.png` });
    console.log('wrote qa-profile-menu.png');
    await page.keyboard.press('Escape');
  } else {
    console.log('!! no avatar menu button found');
  }

  // Does the sidebar show Master Admin Setup? That is the isAdmin() fix.
  const body = await page.evaluate(() => document.body.innerText);
  for (const probe of ['Master Control v5.0', 'MASTER ADMIN SETUP', 'User & Role', 'Voucher Entry (TARA)']) {
    console.log(`${body.includes(probe) ? 'FOUND   ' : 'MISSING '} ${probe}`);
  }
  console.log(`legacy "Live Books" link present: ${body.includes('Live Books')}`);

  console.log(`\nconsole errors: ${errors.length}`);
  errors.slice(0, 8).forEach((e) => console.log('  ' + e.slice(0, 160)));

  await browser.close();
})();
