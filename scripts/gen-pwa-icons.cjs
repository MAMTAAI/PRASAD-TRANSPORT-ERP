// Rasterise the PWA icon set from the same mark the splash screen uses
// (blue gradient rounded square + truck). Chromium is already a dependency
// via Playwright, so this needs no new package.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const OUT = process.argv[2];
if (!OUT) { console.error('usage: gen-icons.cjs <outdir>'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

// `pad` = safe-zone inset. Maskable icons get cropped to a circle by Android,
// so the mark has to sit inside the middle ~80% or the truck loses its wheels.
const page = (size, maskable) => `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;width:${size}px;height:${size}px;}
  .bg{width:100%;height:100%;display:flex;align-items:center;justify-content:center;
      background:linear-gradient(135deg,#3b82f6,#38bdf8);
      border-radius:${maskable ? 0 : Math.round(size * 0.22)}px;}
  .m{font-size:${Math.round(size * (maskable ? 0.5 : 0.62))}px;line-height:1;
     font-family:"Segoe UI Emoji","Noto Color Emoji",sans-serif;}
</style>
<div class="bg"><div class="m">🚛</div></div>`;

(async () => {
  const browser = await chromium.launch();
  const targets = [
    { file: 'icon-192.png', size: 192, maskable: false },
    { file: 'icon-512.png', size: 512, maskable: false },
    { file: 'icon-maskable-512.png', size: 512, maskable: true },
    { file: 'apple-touch-icon.png', size: 180, maskable: true }, // iOS masks its own corners
  ];
  for (const t of targets) {
    const p = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
    await p.setContent(page(t.size, t.maskable));
    await p.waitForTimeout(150);
    await p.screenshot({ path: path.join(OUT, t.file), omitBackground: false });
    await p.close();
    console.log('wrote', t.file, t.size + 'px');
  }
  await browser.close();
})();
