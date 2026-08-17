// Rasterise the PWA icon set from the REAL BRAND MARK.
//
// It used to draw a 🚛 emoji on a blue gradient — a placeholder from before the
// logo existed in the repo. That is what an iPhone showed on its home screen
// after "Add to Home Screen", and since the iPhone route is now the PWA (there
// is no iOS build), a generic emoji was the company's whole app identity on
// those devices. Android users meanwhile saw the proper logo, because the
// launcher icon comes from res/mipmap and never went through this script.
//
// SOURCE: android/.../mipmap-xxxhdpi/ic_launcher_foreground.webp — the
// adaptive-icon foreground, 432px, the logo on its own. That is what modern
// Android actually composites over the white background layer, so generating
// from it makes the home-screen icon identical on both platforms. It is also
// the largest copy of the mark in the repo: 432 -> 192 and 432 -> 180 are
// downscales (crisp), 432 -> 512 is a 1.19x upscale (fine). Generating from the
// 192px legacy badge instead would mean a 2.7x upscale.
//
// The mark already sits inside the adaptive-icon safe zone, so the maskable
// variant needs no extra inset — Android's circle crop cannot reach it.
//
// Chromium is already a dependency via Playwright, so this needs no new package.
//
// Usage: node scripts/gen-pwa-icons.cjs public/icons
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const OUT = process.argv[2];
if (!OUT) { console.error('usage: gen-pwa-icons.cjs <outdir>'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const MARK = path.join(
  __dirname, '..', 'android', 'app', 'src', 'main', 'res',
  'mipmap-xxxhdpi', 'ic_launcher_foreground.webp');
if (!fs.existsSync(MARK)) {
  console.error(`brand mark not found at ${MARK}`);
  process.exit(1);
}
const markUri = 'data:image/webp;base64,' + fs.readFileSync(MARK).toString('base64');

// The adaptive icon's background layer is @color/ic_launcher_background.
// Opaque on purpose: iOS does not support transparency in a home-screen icon
// and renders it black, and some Android launchers do the same.
const BG = '#FFFFFF';

const page = (size) => `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:${BG};}
  .m{width:${size}px;height:${size}px;
     background:url('${markUri}') center/contain no-repeat;}
</style>
<div class="m"></div>`;

(async () => {
  const browser = await chromium.launch();
  const targets = [
    { file: 'icon-192.png', size: 192 },
    { file: 'icon-512.png', size: 512 },
    { file: 'icon-maskable-512.png', size: 512 },
    { file: 'apple-touch-icon.png', size: 180 }, // iOS masks its own corners
  ];
  for (const t of targets) {
    const p = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
    await p.setContent(page(t.size));
    await p.waitForTimeout(150);
    await p.screenshot({ path: path.join(OUT, t.file), omitBackground: false });
    await p.close();
    console.log('wrote', t.file, t.size + 'px');
  }
  await browser.close();
})();
