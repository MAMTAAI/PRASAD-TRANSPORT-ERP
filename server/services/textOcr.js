// server/services/textOcr.js
// ─────────────────────────────────────────────────────────────────────────────
// Zero-cost OCR: Tesseract (open-source, WASM build — no native binary, no
// external API, no per-page cost) turns a document image into raw text.
//
// The raw text then goes to the LOCAL LLM (DeepSeek) as a *text* parsing task,
// which on this hardware is 5–10× faster than vision inference and leaves the
// GPU free between documents. Vision (gemma4) remains the fallback for photos
// too degraded for classical OCR.
//
// The worker is a singleton: Tesseract's WASM init + traineddata load costs
// seconds, so one long-lived worker serves all scans sequentially — which also
// matches the local-AI concurrency=1 discipline.
// ─────────────────────────────────────────────────────────────────────────────
import { createWorker } from 'tesseract.js';
import { join } from 'node:path';

const LANGS = process.env.OCR_TESSERACT_LANGS ?? 'eng'; // add '+hin' after pulling hin.traineddata
const CACHE = process.env.OCR_TESSERACT_CACHE ?? join(process.cwd(), 'data', 'tesseract');

let workerPromise = null;
let idleTimer = null;
let stats = { pages: 0, failures: 0, last_ms: null, initialized: false, idle_terminations: 0 };

// The WASM worker holds ~150-300MB once warm. A scanner that sat idle for
// 10 minutes doesn't need it resident — terminate and re-init on next scan
// (init costs ~1-2s, invisible next to a 10s scan). Real RAM back to the OS.
const IDLE_MS = Number.parseInt(process.env.OCR_WORKER_IDLE_MS ?? '600000', 10);
function armIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const w = await workerPromise?.catch(() => null);
    if (w) {
      await w.terminate().catch(() => {});
      workerPromise = null;
      stats.initialized = false;
      stats.idle_terminations++;
      console.log('[textOcr] idle worker terminated — WASM memory released');
      if (global.gc) global.gc();
    }
  }, IDLE_MS);
  idleTimer.unref?.();
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker(LANGS, 1, {
        cachePath: CACHE,          // traineddata persists here after first download
        gzip: true,
      });
      stats.initialized = true;
      console.log(`[textOcr] tesseract worker ready (langs=${LANGS})`);
      return worker;
    })();
    // A failed init must not poison every future call.
    workerPromise.catch((err) => {
      console.error('[textOcr] worker init failed:', err.message);
      workerPromise = null;
    });
  }
  return workerPromise;
}

const isPdf = (b) => b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

/**
 * PDFs, without OCR where possible.
 *
 * TESSERACT CANNOT READ PDFs AT ALL. Handed one it fails inside its worker with
 * "Pdf reading is not supported", and it reports that failure by rethrowing on
 * process.nextTick — outside any await, so no try/catch around recognize() can
 * catch it and the whole API process dies. A PDF must therefore never reach the
 * worker; this function is the gate, not a nicety.
 *
 * Most of this fleet's paperwork is printed to PDF rather than photographed, so
 * it carries a real text layer. Reading that layer is both free and strictly
 * more accurate than OCR of a rendering of it. Rasterising is the fallback for
 * the scanned ones.
 */
async function pdfToText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer), useSystemFonts: true,
    isEvalSupported: false, disableFontFace: true,
  });
  const doc = await task.promise;
  // pdf.js has moved this method between the document proxy and the loading
  // task across majors. Releasing the worker matters more than which object
  // owns it, so try both and never let cleanup fail an otherwise good read.
  const release = async () => {
    try { await (doc.destroy?.() ?? task.destroy?.()); } catch { /* already gone */ }
  };

  let text = '';
  const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(' ') + '\n';
  }
  if (text.replace(/\s/g, '').length >= MIN_PDF_TEXT_CHARS) {
    await release();
    return { text, confidence: 1, source: 'pdf-text-layer' };
  }

  // No usable text layer: a scan. Render page 1 and OCR that instead.
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: PDF_RASTER_SCALE });
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const png = canvas.toBuffer('image/png');
  await release();
  const ocr = await ocrImage(png);
  return { ...ocr, source: 'pdf-rasterised' };
}

const MAX_PDF_PAGES = Number.parseInt(process.env.OCR_PDF_MAX_PAGES ?? '5', 10);
const MIN_PDF_TEXT_CHARS = Number.parseInt(process.env.OCR_PDF_MIN_TEXT ?? '80', 10);
const PDF_RASTER_SCALE = Number.parseFloat(process.env.OCR_PDF_RASTER_SCALE ?? '2.0');

// A phone camera hands over a 4000px photo of an A4 page. Tesseract's cost
// scales with pixels, not with information: at 4000px it spends most of its time
// on paper texture. Document text stays legible to it well below that, so the
// long edge is capped and the seconds come straight off — a 12MP photo drops
// from ~7s to ~2s with no change to what it reads.
//
// Downscale only. An image already under the cap is passed through untouched
// rather than re-encoded, because re-encoding a clean scan can only lose detail.
const OCR_MAX_EDGE = Number.parseInt(process.env.OCR_MAX_EDGE_PX ?? '2000', 10);

async function downscaleForOcr(buffer) {
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(buffer);
    const longEdge = Math.max(img.width, img.height);
    if (longEdge <= OCR_MAX_EDGE) return { buffer, scaled: false };
    const k = OCR_MAX_EDGE / longEdge;
    const w = Math.round(img.width * k);
    const h = Math.round(img.height * k);
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return { buffer: canvas.toBuffer('image/png'), scaled: true, from: longEdge, to: OCR_MAX_EDGE };
  } catch {
    // Unreadable by the canvas decoder is not a reason to skip OCR — Tesseract
    // may still manage. Hand it the original.
    return { buffer, scaled: false };
  }
}

/** Tesseract on raster bytes. Only ever called with an image. */
async function ocrImage(buffer) {
  const t0 = Date.now();
  try {
    const prepped = await downscaleForOcr(buffer);
    const worker = await getWorker();
    const { data } = await worker.recognize(prepped.buffer);
    stats.pages++;
    stats.last_ms = Date.now() - t0;
    armIdleTimer();
    return {
      text: data.text ?? '',
      confidence: Math.max(0, Math.min(1, (data.confidence ?? 0) / 100)),
      ms: stats.last_ms,
    };
  } catch (err) {
    stats.failures++;
    // A worker that failed once may be in a bad state; drop it so the next
    // call re-initialises rather than inheriting the fault.
    try { const w = await workerPromise; await w?.terminate?.(); } catch { /* already gone */ }
    workerPromise = null;
    const e = new Error(`tesseract failed: ${err.message}`);
    e.code = 'TEXT_OCR_FAILED';
    throw e;
  }
}

/**
 * Extract raw text from an image OR PDF buffer.
 * Returns { text, confidence (0..1), ms, source }.
 */
export async function extractText(buffer) {
  const t0 = Date.now();
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (isPdf(buf)) {
    try {
      const out = await pdfToText(buf);
      return { ms: Date.now() - t0, ...out };
    } catch (err) {
      stats.failures++;
      const e = new Error(`pdf read failed: ${err.message}`);
      e.code = 'PDF_READ_FAILED';
      throw e;
    }
  }
  const out = await ocrImage(buf);
  return { source: 'tesseract', ...out };
}

export function ocrStats() {
  return { engine: 'tesseract.js (local, zero-cost)', langs: LANGS, ...stats };
}

export async function closeOcr() {
  if (workerPromise) {
    const w = await workerPromise.catch(() => null);
    await w?.terminate?.().catch(() => {});
    workerPromise = null;
  }
}
