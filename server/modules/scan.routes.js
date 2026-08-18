// server/modules/scan.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// The endpoint the phone talks to. One door for every kind of paper.
//
// THE UPTIME CONTRACT
// This route must not fail because a PC in the office is switched off. The scan
// pipeline degrades instead: the deterministic pass always produces a record,
// and the local LLM only enriches it when it happens to be reachable. So the
// mobile app has no offline branch to write and no error state to show — it
// posts an image and gets a document back, at 2am, on a Sunday.
//
// Deploy this same code on the AWS box with AI_LOCAL_ENRICH=0 and it stops
// trying to reach the local engine at all. Nothing else changes: no model to
// install, no GPU, no per-page cost — tesseract.js is WASM and docPatterns.js
// is string matching.
//
// WHAT IT DELIBERATELY DOES NOT DO
// It does not file anything. A scan produces a proposal and a scan_log row; a
// person or an explicit second call commits it. An endpoint that both reads a
// photo and writes to the compliance register would let a blurry Aadhaar put an
// expiry date on a lorry, and nobody would know which scan did it.
// ─────────────────────────────────────────────────────────────────────────────
import multipart from '@fastify/multipart';
import { query, isDegraded, poolStats } from '../db/pool.js';
import { scanDocument } from '../services/universalScan.js';
import { localEngineUp } from '../ai/router.js';

const MAX_BYTES = Number.parseInt(process.env.SCAN_MAX_BYTES ?? String(20 * 1024 * 1024), 10);
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

const dbGate = (reply) =>
  reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });

export async function registerScanRoutes(app) {
  // Own scope, own multipart limits — the same reason files.routes has its own:
  // registering it twice on one scope throws, and the scan ceiling is a photo,
  // not an archive upload.
  await app.register(multipart, { limits: { fileSize: MAX_BYTES, files: 1 } });

  // Health, for the mobile app to show an honest badge rather than guessing.
  app.get('/health', async () => {
    const local = await localEngineUp().catch(() => false);
    return {
      ok: true,
      // Both are true answers; the app can say "full" or "fast" without
      // implying the second one is broken.
      mode: local ? 'local+patterns' : 'patterns-only',
      local_engine: local,
      degraded_db: isDegraded(),
      // Saturation, so a slow scan can be diagnosed from the response itself
      // instead of by reading the server log afterwards.
      db_pool: poolStats(),
      accepts: [...ALLOWED],
      max_bytes: MAX_BYTES,
    };
  });

  app.post('/scan', async (req, reply) => {
    let part;
    try { part = await req.file(); }
    catch (e) { return reply.code(400).send({ error: 'BAD_MULTIPART', detail: e.message }); }
    if (!part) return reply.code(400).send({ error: 'NO_FILE', detail: 'multipart field "file" is required' });

    const contentType = String(part.mimetype || '').split(';')[0].trim();
    if (!ALLOWED.has(contentType)) {
      return reply.code(415).send({
        error: 'BAD_TYPE',
        detail: `cannot read ${contentType || 'unknown type'} — send ${[...ALLOWED].join(', ')}`,
      });
    }

    const buffer = await part.toBuffer();
    // @fastify/multipart truncates at the limit rather than throwing, so an
    // oversized photo would otherwise be OCR'd half-written and quietly wrong.
    if (part.file?.truncated) {
      return reply.code(413).send({ error: 'TOO_LARGE', detail: `over ${Math.round(MAX_BYTES / 1024 / 1024)} MB` });
    }

    const filename = part.filename ?? null;
    const source = part.fields?.source?.value ?? 'mobile';
    const uploadedBy = part.fields?.uploaded_by?.value ?? null;

    try {
      return await scanDocument(buffer, { filename, source, uploadedBy });
    } catch (e) {
      // Even a total failure answers with the shape the app expects, so the
      // phone renders "couldn't read this, try again" instead of a crash.
      req.log?.error?.({ err: e }, 'scan failed');
      return reply.code(200).send({
        ok: false, engine: 'none', kind: 'UNKNOWN', needs_human: true,
        error: 'SCAN_FAILED', detail: e.message, filename,
      });
    }
  });

  // Recent scans and which engine served them — the honest view of whether the
  // hybrid is holding up. A rising patterns-only count means the local engine
  // has been down and records are thinner than the office assumes.
  app.get(
    '/scans',
    { schema: { querystring: { type: 'object', properties: {
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      needs_human: { type: 'boolean', default: false },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { limit = 50, needs_human = false } = req.query ?? {};
      const { rows } = await query(
        `SELECT s.id, s.filename, s.source, s.kind, s.engine, s.confident,
                s.took_ms, s.scanned_at, v.vehicle_no, s.result
           FROM scan_log s LEFT JOIN vehicles v ON v.id = s.vehicle_id
          WHERE ($1::boolean IS NOT TRUE OR s.confident = false)
          ORDER BY s.scanned_at DESC LIMIT $2`, [needs_human, limit]);
      const { rows: health } = await query('SELECT * FROM v_scan_health LIMIT 14');
      return { total: rows.length, health, scans: rows };
    }
  );
}
