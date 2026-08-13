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

/**
 * Extract raw text from an image buffer.
 * Returns { text, confidence (0..1, tesseract's own word-confidence mean), ms }.
 */
export async function extractText(buffer) {
  const t0 = Date.now();
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(buffer);
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
    // Caller decides the fallback (vision); this layer just reports honestly.
    const e = new Error(`tesseract failed: ${err.message}`);
    e.code = 'TEXT_OCR_FAILED';
    throw e;
  }
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
