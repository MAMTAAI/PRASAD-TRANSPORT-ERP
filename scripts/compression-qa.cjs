// QA: strict client-side compression pipeline (uploadMedia.ts).
// Synthesizes a heavy photo + heavy image-PDF in the browser, runs the real
// compressImage/compressPdf, then uploads the compressed image through
// uploadMedia to Firebase Storage (anonymous lane, drivers/ prefix).
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0, 160)); });
  await page.addInitScript(() => {
    localStorage.setItem('prasad_user', JSON.stringify({ full_name: 'QA Admin', name: 'QA Admin', role: 'Super Admin', email: 'qa@local' }));
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(5000); // let splash/auth/sw settle so evaluate survives

  const result = await page.evaluate(async () => {
    const out = {};
    const mod = await import('/src/lib/uploadMedia.ts');

    // 1) Heavy photo: 2800x1800 noise (worst case for compression)
    const cv = document.createElement('canvas'); cv.width = 2800; cv.height = 1800;
    const ctx = cv.getContext('2d');
    const im = ctx.createImageData(cv.width, cv.height);
    for (let i = 0; i < im.data.length; i += 4) {
      const v = (i * 2654435761) % 255;
      im.data[i] = v; im.data[i + 1] = (v * 7) % 255; im.data[i + 2] = (v * 13) % 255; im.data[i + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    ctx.fillStyle = '#000'; ctx.font = 'bold 90px Arial';
    ctx.fillText('DL NO: AS-2026-1234567', 100, 900); // readability marker
    const bigJpeg = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.97));
    const imgFile = new File([bigJpeg], 'big.jpg', { type: 'image/jpeg' });
    const cImg = await mod.compressImage(imgFile);
    out.image = { inKB: Math.round(bigJpeg.size / 1024), outKB: Math.round(cImg.blob.size / 1024), mime: cImg.mime, ext: cImg.ext };

    // 2) Heavy PDF: 2 pages, each embedding that huge JPEG
    const PDFLib = await import('/node_modules/pdf-lib/dist/pdf-lib.esm.js');
    const doc = await PDFLib.PDFDocument.create();
    const jpgBytes = await bigJpeg.arrayBuffer();
    for (let p = 0; p < 2; p++) {
      const img = await doc.embedJpg(jpgBytes);
      const pg = doc.addPage([595, 842]);
      pg.drawImage(img, { x: 0, y: 200, width: 595, height: 380 });
      pg.drawText('PRASAD KYC PAGE ' + (p + 1), { x: 50, y: 700, size: 24 });
    }
    const pdfBytes = await doc.save();
    const pdfFile = new File([pdfBytes], 'heavy.pdf', { type: 'application/pdf' });
    const cPdf = await mod.compressPdf(pdfFile);
    out.pdf = { inKB: Math.round(pdfBytes.byteLength / 1024), outKB: Math.round(cPdf.blob.size / 1024), mime: cPdf.mime };

    // 3) Real end-to-end upload of the compressed image
    try {
      const fb = await import('/src/firebase.ts');
      await fb.authReady;
      const res = await mod.uploadMedia(imgFile, 'drivers/upload-probe/e2e-compress.jpg');
      out.upload = { url: res.url.slice(0, 90) + '…', path: res.path, KB: Math.round(res.bytes / 1024) };
    } catch (e) { out.upload = { error: String(e && e.message || e).slice(0, 200) }; }
    return out;
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
