// ============================================================================
//  make-play-assets.mjs - the two graphics Play blocks the listing on
//
//  Usage:  node scripts/make-play-assets.mjs
//  Writes: play-store/icon-512.png            (app icon slot)
//          play-store/feature-graphic.png     (1024x500 header slot)
//
//  Rendered through Chromium rather than an image library because this repo has
//  no `sharp` and adding a native dependency for two files is not a trade worth
//  making - Playwright is already here for the QA scripts.
//
//  The icon is exported via canvas.toDataURL, NOT via a page screenshot. A
//  screenshot of an opaque page comes back as a 24-bit PNG; canvas always
//  encodes RGBA, which is the 32-bit PNG Play's icon slot has historically
//  insisted on. It is drawn onto an opaque background first, because a
//  transparent app icon renders as a black hole on some launcher themes.
// ============================================================================
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'play-store');
mkdirSync(OUT, { recursive: true });

// SOURCE: the ANDROID LAUNCHER ICON, not public/icons/icon-512.png.
// Those two are different artwork - the launcher is the branded PRASAD
// TRANSPORT badge, the PWA icon is a generic blue truck - and the store page
// has to match what the user sees on their home screen, or the listing looks
// like a different product. 192px is the largest launcher raster in the repo;
// it is displayed at 188px in the graphic below, so there is no upscaling.
const SOURCE_ICON = path.join(ROOT, 'android', 'app', 'src', 'main', 'res', 'mipmap-xxxhdpi', 'ic_launcher.webp');
const iconDataUri = 'data:image/webp;base64,' + readFileSync(SOURCE_ICON).toString('base64');

// The app's own palette, so the store page and the app do not look like two
// different products. These are the values in index.html and vite.config.ts.
const INK = '#020617';
const CYAN = '#22d3ee';

const FEATURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:1024px; height:500px; overflow:hidden; }
  body {
    background:
      radial-gradient(900px 420px at 78% 18%, rgba(34,211,238,.16), transparent 62%),
      radial-gradient(700px 380px at 12% 88%, rgba(59,130,246,.14), transparent 60%),
      linear-gradient(140deg, ${INK} 0%, #060d1c 52%, #0a1424 100%);
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    color:#e2e8f0;
    display:flex; align-items:center; gap:52px;
    /* Play crops and overlays the edges of this slot on some surfaces, so
       nothing that has to be readable sits within 64px of a border. */
    padding:0 72px;
    position:relative;
  }
  /* Faint route line - a transport cue that survives being cropped. */
  .route { position:absolute; inset:0; opacity:.20; }
  .icon {
    width:188px; height:188px; flex:none; border-radius:42px;
    background:url('${iconDataUri}') center/cover no-repeat;
    box-shadow: 0 24px 60px rgba(0,0,0,.6), 0 0 0 1px rgba(148,163,184,.22);
  }
  .name { font-size:62px; font-weight:800; letter-spacing:-1.2px; line-height:1.04; color:#f8fafc; }
  .name span { color:${CYAN}; }
  .tag { margin-top:18px; font-size:25px; font-weight:600; color:#94a3b8; letter-spacing:.2px; }
  .chips { margin-top:26px; display:flex; gap:10px; }
  .chip {
    font-size:16px; font-weight:700; letter-spacing:.6px;
    padding:9px 16px; border-radius:999px;
    color:#cbd5e1; background:rgba(148,163,184,.10);
    border:1px solid rgba(148,163,184,.24);
  }
</style></head><body>
  <svg class="route" viewBox="0 0 1024 500" preserveAspectRatio="none">
    <path d="M-40 392 C 210 330, 300 452, 540 372 S 900 250, 1070 300"
          fill="none" stroke="${CYAN}" stroke-width="2.5" stroke-dasharray="14 12"/>
  </svg>
  <div class="icon"></div>
  <div>
    <div class="name">PRASAD TRANSPORT<br><span>ERP</span></div>
    <div class="tag">Fleet, trips, fuel and the books &mdash; one system.</div>
    <div class="chips">
      <div class="chip">TRIPS</div>
      <div class="chip">LIVE GPS</div>
      <div class="chip">FUEL</div>
      <div class="chip">BILLING</div>
      <div class="chip">LEDGERS</div>
    </div>
  </div>
</body></html>`;

const ICON_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:${INK};}
</style></head><body>
<canvas id="c" width="512" height="512"></canvas>
<script>
  window.__icon = new Promise((resolve) => {
    const c = document.getElementById('c');
    const ctx = c.getContext('2d');
    const img = new Image();
    img.onload = () => {
      // Opaque ground first: a transparent icon shows as a black square on
      // some launchers and Play rejects nothing, so the defect ships.
      ctx.fillStyle = '${INK}';
      ctx.fillRect(0, 0, 512, 512);
      // 192 -> 512 is a 2.7x upscale and it shows. This file is a fallback for
      // the Play icon slot, not an improvement on it: if the original logo
      // artwork still exists at 512px or as a vector, use that instead.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, 512, 512);
      resolve(c.toDataURL('image/png'));
    };
    img.src = '${iconDataUri}';
  });
</script>
</body></html>`;

function pngInfo(buf) {
  return {
    w: buf.readUInt32BE(16),
    h: buf.readUInt32BE(20),
    bits: buf[24],
    // colorType 6 = RGBA (32-bit), 2 = RGB (24-bit)
    type: buf[25] === 6 ? 'RGBA/32-bit' : buf[25] === 2 ? 'RGB/24-bit' : `colorType=${buf[25]}`,
    kb: (buf.length / 1024).toFixed(0) + 'KB',
  };
}

const browser = await chromium.launch();
try {
  // ---- feature graphic ----------------------------------------------------
  const fg = await browser.newContext({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 1 });
  const fgPage = await fg.newPage();
  await fgPage.setContent(FEATURE_HTML, { waitUntil: 'load' });
  await fgPage.waitForTimeout(300);
  const fgFile = path.join(OUT, 'feature-graphic.png');
  await fgPage.screenshot({ path: fgFile });
  await fg.close();

  // ---- icon ---------------------------------------------------------------
  const ic = await browser.newContext({ viewport: { width: 512, height: 512 } });
  const icPage = await ic.newPage();
  await icPage.setContent(ICON_HTML, { waitUntil: 'load' });
  const dataUrl = await icPage.evaluate(() => window.__icon);
  const iconFile = path.join(OUT, 'icon-512.png');
  writeFileSync(iconFile, Buffer.from(dataUrl.split(',')[1], 'base64'));
  await ic.close();

  for (const f of [iconFile, fgFile]) {
    const i = pngInfo(readFileSync(f));
    console.log(`${path.relative(ROOT, f).padEnd(32)} ${i.w}x${i.h}  ${i.type}  ${i.kb}`);
  }
} finally {
  await browser.close();
}
