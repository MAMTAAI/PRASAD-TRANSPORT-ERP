// QA: WhatsApp CRM — live status badge (local engine), QR connect tab, footprint wiring.
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
    localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'Sandeep Kumar Prasad', name: 'Sandeep Kumar Prasad', role: 'Super Admin', email: 'sandeep@prasadtransport.com' }));
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4500);

  // CRM module → WhatsApp CRM
  await page.getByText('CRM (MAMTA AI)', { exact: false }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  await page.getByText('WhatsApp CRM', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(5000); // allow status poll (local probe)

  const badge = await page.locator('text=/● (Online|Scan QR|Offline|Reconnecting)/').first().textContent().catch(() => 'NOT FOUND');
  const user = await page.locator('input').first().inputValue().catch(() => '?');
  console.log(`status badge: "${badge}" | current user field: "${user}"`);

  // Click badge → CONNECT tab with QR
  if (badge.includes('Scan QR') || badge.includes('Offline')) {
    await page.locator('text=/● (Scan QR|Offline)/').first().click();
    await page.waitForTimeout(2500);
    const qrSvg = await page.locator('svg[height="250"], svg[width="250"]').count();
    const connectHdr = await page.getByText('Personal WhatsApp Link').count();
    console.log(`connect tab open: ${connectHdr >= 1} | QR rendered: ${qrSvg >= 1}`);
  }
  await page.screenshot({ path: path.join(OUT, 'whatsapp-qr-connect.png') });
  console.log('page errors:', errors.length);
  errors.slice(0, 4).forEach(e => console.log('  ! ' + e.slice(0, 140)));
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
