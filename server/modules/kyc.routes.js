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
import { enqueue } from '../lib/ocrQueue.js';

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
    const buf = await part.toBuffer();

    // FAIL-SAFE (176). When this box cannot read the document right now, the
    // document is still SAVED and QUEUED, and the caller gets 202 rather than
    // an error. A driver's licence is never lost to a busy minute.
    if (freeMb < MIN_FREE_MB || busy) {
      try {
        const job = await enqueue({ buffer: buf, filename: part.filename, mime: part.mimetype, docType: kind, source: 'KYC', requestedBy: req.user?.name ?? req.user?.sub ?? null });
        return reply.code(202).send({ ok: true, status: 'PENDING_OCR', job_id: job.id, file_url: job.file_url,
          detail: busy ? 'another document is being read — this one is saved and queued' : `the box is below the ${MIN_FREE_MB} MB OCR floor (${freeMb} MB free) — this one is saved and queued`,
          poll: `/api/v1/ocr/jobs/${job.id}` });
      } catch (e) {
        return reply.code(507).send({ error: 'STORE_FAILED', detail: `the document was NOT saved: ${e.message}` });
      }
    }

    busy = true;
    const started = Date.now();
    try {
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
