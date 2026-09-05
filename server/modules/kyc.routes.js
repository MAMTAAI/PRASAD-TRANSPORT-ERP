// server/modules/kyc.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/kyc/scan — one KYC paper in, the fields the driver form needs
// out (licence number + expiry, Aadhaar, PAN, account + IFSC + bank, HZD
// certificate + expiry, holder name), each with a confidence.
//
// Engine: the server's own OCR (tesseract WASM, PDF text layer first) and the
// pattern + checksum tables in lib/kycExtract.js. No model has to be running
// on anyone's PC; the cloud engine, when the box has a key, only ADDS a holder
// name / address it read better — it never overrides a checksum-valid number.
// Memory-gated like every other OCR on this 2 GB box: under the floor it says
// so instead of swapping the API to death.
// ─────────────────────────────────────────────────────────────────────────────
import os from 'node:os';
import multipart from '@fastify/multipart';
import { extractText } from '../services/textOcr.js';
import { extractKyc } from '../lib/kycExtract.js';
import { requireAuth } from './auth.routes.js';

const MAX_BYTES = Number.parseInt(process.env.SCAN_MAX_BYTES ?? String(20 * 1024 * 1024), 10);
const MIN_FREE_MB = Number(process.env.OCR_MIN_FREE_MB ?? '220');
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const KINDS = new Set(['DL', 'AADHAAR', 'PAN', 'BANK', 'HZD', 'AUTO']);
let busy = false;

export async function registerKycRoutes(app) {
  await app.register(multipart, { limits: { fileSize: MAX_BYTES, files: 1 } });

  app.get('/health', { preHandler: requireAuth }, async () => ({ ok: true, free_mb: Math.round(os.freemem() / 1048576), min_free_mb: MIN_FREE_MB, busy }));

  app.post('/scan', { preHandler: requireAuth }, async (req, reply) => {
    let part; try { part = await req.file(); } catch (e) { return reply.code(400).send({ error: 'BAD_MULTIPART', detail: e.message }); }
    if (!part) return reply.code(400).send({ error: 'NO_FILE' });
    const fields = Object.fromEntries(Object.entries(part.fields ?? {}).map(([k, v]) => [k, v?.value]));
    const kind = String(fields.doc_type ?? 'AUTO').toUpperCase();
    if (!KINDS.has(kind)) return reply.code(400).send({ error: 'BAD_DOC_TYPE', detail: 'doc_type must be DL, AADHAAR, PAN, BANK, HZD or AUTO' });
    if (part.mimetype && !ALLOWED.has(part.mimetype)) return reply.code(415).send({ error: 'UNSUPPORTED_TYPE', detail: `${part.mimetype} — send a JPEG, PNG, WEBP or PDF` });
    const freeMb = Math.round(os.freemem() / 1048576);
    if (freeMb < MIN_FREE_MB) return reply.code(503).send({ error: 'OCR_LOW_MEMORY', detail: `the box has ${freeMb} MB free (floor ${MIN_FREE_MB}) — the document is saved; scan again in a minute or type the fields` });
    if (busy) return reply.code(429).send({ error: 'OCR_BUSY', detail: 'another document is being read — try again in a few seconds' });
    busy = true;
    const started = Date.now();
    try {
      const buf = await part.toBuffer();
      const out = await extractText(buf);
      const text = out?.text ?? '';
      const r = extractKyc(text, kind);
      return { ok: true, doc_type: r.doc_type, fields: r.fields, confidence: r.confidence, notes: r.notes, engine: out?.source ?? 'ocr', text_chars: text.length, ms: Date.now() - started,
        filled: Object.keys(r.fields).length, low: Object.entries(r.confidence).filter(([, c]) => c < 0.7).map(([k]) => k) };
    } catch (e) {
      return reply.code(502).send({ error: 'OCR_FAILED', detail: e.message });
    } finally { busy = false; }
  });
}
