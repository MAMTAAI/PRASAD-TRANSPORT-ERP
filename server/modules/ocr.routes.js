// server/modules/ocr.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/ocr — the 24/7 fail-safe intake and the pull queue (migration 176).
//
//   POST /intake          multipart: the file is STORED and a job row written
//                         before anything is read. 200 with fields when the
//                         box could read it at once, 202 QUEUED otherwise.
//                         It does not return 5xx once the file is saved.
//   GET  /jobs/:id        poll a job (the phone polls this after a 202)
//   GET  /jobs            desk view / backlog
//   GET  /health          queue depth + which engines are actually up
//   POST /claim           the 32 GB PC leases jobs (worker token)
//   POST /jobs/:id/result the PC returns fields
//   POST /jobs/:id/fail   the PC reports a failure → retry with backoff
//   POST /dispatch        run the AWS-side fallback pass now (admin)
//
// The worker endpoints are the ONLY thing the Local PC may call, and they are
// HTTPS. The PC never opens a Postgres connection — BAGALAMUKHI's
// db_stays_loopback_or_vpc invariant forbids it.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import multipart from '@fastify/multipart';
import { query } from '../db/pool.js';
import { requireAuth, requireAdminRole } from './auth.routes.js';
import { enqueue, runHere, dispatchOnce, health, canOcrHere, freeMb } from '../lib/ocrQueue.js';

const MAX_BYTES = Number.parseInt(process.env.SCAN_MAX_BYTES ?? String(20 * 1024 * 1024), 10);
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const KINDS = new Set(['DL', 'AADHAAR', 'PAN', 'BANK', 'HZD', 'AC5', 'PUMP_BILL', 'AUTO']);
const SOURCES = new Set(['MOBILE_SCAN', 'KYC', 'PARTNER_DOC', 'BILL', 'MANUAL']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The worker token is separate from a staff session: a compromised worker can
// read queued documents and nothing else. Read per request, not at import, so
// the token can be rotated (or first set) without restarting the API.
const workerToken = () => process.env.OCR_WORKER_TOKEN ?? '';

export async function registerOcrRoutes(app) {
  try { await app.register(multipart, { limits: { fileSize: MAX_BYTES, files: 1 } }); } catch { /* already registered on this scope */ }
  const staff = { preHandler: requireAuth };
  const admin = { preHandler: requireAdminRole };
  const actor = (req) => req.user?.name ?? req.user?.sub ?? 'desk';
  const worker = {
    preHandler: async (req, reply) => {
      const expected = workerToken();
      const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!expected) return reply.code(503).send({ error: 'WORKER_DISABLED', detail: 'OCR_WORKER_TOKEN is not set on this server — the pull queue is closed' });
      if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
        return reply.code(401).send({ error: 'BAD_WORKER_TOKEN' });
      }
    },
  };

  // ── INTAKE — the endpoint that must never fail ────────────────────────
  app.post('/intake', staff, async (req, reply) => {
    let part;
    try { part = await req.file(); } catch (e) { return reply.code(400).send({ error: 'BAD_MULTIPART', detail: e.message }); }
    if (!part) return reply.code(400).send({ error: 'NO_FILE', detail: 'multipart field "file" is required' });
    const mime = String(part.mimetype || '').split(';')[0].trim();
    if (mime && !ALLOWED.has(mime)) return reply.code(415).send({ error: 'BAD_TYPE', detail: `send ${[...ALLOWED].join(', ')}` });
    const buffer = await part.toBuffer();
    if (part.file?.truncated) return reply.code(413).send({ error: 'TOO_LARGE', detail: `over ${Math.round(MAX_BYTES / 1048576)} MB` });
    const f = Object.fromEntries(Object.entries(part.fields ?? {}).map(([k, v]) => [k, v?.value]));
    const docType = KINDS.has(String(f.doc_type ?? '').toUpperCase()) ? String(f.doc_type).toUpperCase() : 'AUTO';
    const source = SOURCES.has(String(f.source ?? '').toUpperCase()) ? String(f.source).toUpperCase() : 'MOBILE_SCAN';

    // ① STORE + RECORD. If this throws the caller must know: nothing was saved.
    let job;
    try {
      job = await enqueue({
        buffer, filename: part.filename, mime, docType, source,
        subjectKind: f.subject_kind ?? null, subjectId: f.subject_id ?? null,
        companyId: UUID_RE.test(f.company_id ?? '') ? f.company_id : null,
        requestedBy: actor(req), sourceRef: f.source_ref ?? null, keyHint: f.key ?? null,
      });
    } catch (e) {
      return reply.code(507).send({ error: 'STORE_FAILED', detail: `the document was NOT saved: ${e.message}` });
    }

    // ② Try to read it right now — only if this box has the memory to spare.
    //    Anything that goes wrong from here leaves a QUEUED job, never an error.
    if (f.defer !== '1' && canOcrHere()) {
      try {
        const r = await runHere(job);
        const { rows: [done] } = await query('SELECT * FROM ocr_complete($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6, $7)',
          [job.id, r.tier, r.engine, JSON.stringify(r.fields ?? {}), JSON.stringify(r.confidence ?? {}), r.text ?? '', (r.notes ?? []).join(' · ') || null]);
        return reply.code(200).send({ ok: true, status: 'DONE', job_id: job.id, file_url: job.file_url,
          doc_type: done.doc_type, fields: done.fields, confidence: done.confidence, tier: done.tier, engine: done.engine, notes: done.notes });
      } catch (e) {
        req.log?.warn?.({ err: e, job: job.id }, 'inline OCR failed — job stays queued');
      }
    }

    // ③ Queued. The file is safe; the phone can carry on.
    return reply.code(202).send({ ok: true, status: 'PENDING_OCR', job_id: job.id, file_url: job.file_url,
      queued_because: canOcrHere() ? 'deferred by request or the inline read did not finish' : `box below the OCR memory floor (${freeMb()} MB free)`,
      poll: `/api/v1/ocr/jobs/${job.id}` });
  });

  app.get('/jobs/:id', staff, async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.code(400).send({ error: 'BAD_ID' });
    const { rows: [j] } = await query('SELECT * FROM ocr_jobs WHERE id = $1::uuid', [req.params.id]);
    if (!j) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { job: j };
  });

  app.get('/jobs', staff, async (req) => {
    const status = ['QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED'].includes(req.query.status) ? req.query.status : null;
    const { rows } = await query(
      `SELECT id, source, doc_type, filename, file_url, status, tier, engine, attempts, error,
              subject_kind, subject_id, requested_by, created_at, done_at,
              (fields IS NOT NULL AND fields <> '{}'::jsonb) AS has_fields
         FROM ocr_jobs WHERE ($1::text IS NULL OR status = $1)
        ORDER BY created_at DESC LIMIT $2`,
      [status, Math.min(Number(req.query.limit) || 200, 500)]);
    return { rows };
  });

  app.get('/health', staff, async () => health());

  // ── The pull queue: the Local 32 GB PC ────────────────────────────────
  app.post('/claim', worker, async (req) => {
    const b = req.body ?? {};
    const { rows } = await query('SELECT * FROM ocr_claim($1, $2, $3, 0)',
      [String(b.worker ?? 'local-pc').slice(0, 60), Math.min(Number(b.limit) || 1, 5), Math.min(Number(b.lease_seconds) || 180, 900)]);
    // The PC downloads each file from file_url with the same worker token.
    return { jobs: rows.map((j) => ({ id: j.id, doc_type: j.doc_type, file_url: j.file_url, file_key: j.file_key, mime: j.mime, bytes: j.bytes, filename: j.filename, source: j.source, attempts: j.attempts, lease_until: j.lease_until })) };
  });

  app.post('/jobs/:id/result', worker, async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.code(400).send({ error: 'BAD_ID' });
    const b = req.body ?? {};
    const { rows: [j] } = await query('SELECT * FROM ocr_complete($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6, $7)',
      [req.params.id, 'HEAVY_LOCAL_PC', String(b.engine ?? 'local-pc').slice(0, 120),
       JSON.stringify(b.fields ?? {}), JSON.stringify(b.confidence ?? {}), String(b.text ?? ''), b.notes ?? null]);
    if (!j) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { job: j };
  });

  app.post('/jobs/:id/fail', worker, async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.code(400).send({ error: 'BAD_ID' });
    const { rows: [j] } = await query('SELECT * FROM ocr_fail($1::uuid, $2)', [req.params.id, String(req.body?.error ?? 'worker reported a failure')]);
    if (!j) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { job: j };
  });

  app.post('/dispatch', admin, async (req) => dispatchOnce(Number(req.body?.limit) || undefined));
}
