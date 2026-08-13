#!/usr/bin/env node
// scripts/render-slides.cjs — render public/slides.html to the executive deck
//   node scripts/render-slides.cjs
// Produces Prasad_Transport_Presentation_2026.pdf in the project root.
// Uses Playwright (already a devDependency for the QA scripts).
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

(async () => {
  const src = path.join(__dirname, '..', 'public', 'slides.html');
  const out = path.join(__dirname, '..', 'Prasad_Transport_Presentation_2026.pdf');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 990 } });

  // file:// + networkidle lets the Google Fonts CSS + woff2 arrive.
  await page.goto('file://' + src.replace(/\\/g, '/'), { waitUntil: 'networkidle' });

  // The zero-tofu guarantee: block until every declared font face —
  // including Noto Sans Devanagari — is actually loaded and ready.
  await page.evaluate(() => document.fonts.ready);
  const devanagariLoaded = await page.evaluate(() =>
    document.fonts.check('12px "Noto Sans Devanagari"', 'प्रसाद'));
  if (!devanagariLoaded) {
    console.error('✖ Noto Sans Devanagari did not load — Hindi text would render as boxes. Aborting (is the internet up?).');
    await browser.close();
    process.exit(1);
  }

  await page.pdf({
    path: out,
    format: 'A4',
    landscape: true,
    printBackground: true,      // glassmorphism lives or dies on this
    margin: { top: 0, bottom: 0, left: 0, right: 0 },
  });
  await browser.close();

  const kb = Math.round(fs.statSync(out).size / 1024);
  console.log(`✔ rendered ${path.basename(out)} (${kb} KB) — Devanagari verified loaded`);
})().catch((err) => { console.error('render failed:', err.message); process.exit(1); });
