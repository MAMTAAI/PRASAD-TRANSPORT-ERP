// server/lib/ocrQueue.js
// ─────────────────────────────────────────────────────────────────────────────
// The 24/7 OCR fail-safe (migration 176).
//
// THE ONE RULE: the document is saved before anything is read. `enqueue()`
// stores the bytes and writes the row; every attempt after that is retryable
// and none of them can lose the file. A phone therefore never sees a scan
// failure — at worst it sees "queued".
//
// The ladder, per job:
//   1. HEAVY_LOCAL_PC  the 32 GB PC claims it (ocr.routes /claim) and returns
//                      fields. Pull only — the PC opens no inbound port and
//                      holds no Postgres connection.
//   2. CLOUD           after a grace window, this box reads the text (tesseract
//                      / pdfjs, memory-gated) and asks DeepSeek or Anthropic
//                      for the fields. If the box has no memory for OCR but a
//                      cloud VISION key exists, the image itself goes up.
//   3. AWS_PATTERNS    text + the deterministic pattern tables. No model at all.
//   4. (none)          the job waits. It does not fail; the file is already safe.
// ─────────────────────────────────────────────────────────────────────────────
import os from 'node:os';
import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { put, openStream, publicUrl, safeKey } from './storage.js';
import { extractText } from '../services/textOcr.js';
import { extractKyc } from './kycExtract.js';
import * as aiRouter from '../ai/router.js';

const MIN_FREE_MB = Number(process.env.OCR_MIN_FREE_MB ?? '220');
// How long the 32 GB PC gets to claim a job before this box starts doing it.
const HEAVY_GRACE_SEC = Number(process.env.OCR_HEAVY_GRACE_SEC ?? '120');
const DISPATCH_BATCH = Number(process.env.OCR_DISPATCH_BATCH ?? '2');
const slug = (s) => String(s ?? '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'doc';

export const freeMb = () => Math.round(os.freemem() / 1048576);
export const canOcrHere = () => freeMb() >= MIN_FREE_MB;

/** Read a stored object back into a Buffer.
 *  Both storage drivers answer `{ stream, bytes }`, and `null` when the object
 *  is not there — a missing file must say so plainly rather than surfacing as
 *  "stream is not async iterable" three frames deeper. */
async function readKey(key) {
  const out = await openStream(safeKey(key));
  if (!out?.stream) throw new Error(`stored document not found: ${key}`);
  const chunks = [];
  for await (const c of out.stream) chunks.push(c);
  return Buffer.concat(chunks);
}

/**
 * Save the document and queue the reading of it. This is the only entry point.
 * Never throws for OCR reasons — only if the STORE itself fails, which the
 * caller must surface (there is no point pretending a file was saved).
 */
export async function enqueue({ buffer, filename, mime, docType = 'AUTO', source = 'MOBILE_SCAN',
  subjectKind = null, subjectId = null, companyId = null, requestedBy = null, sourceRef = null, keyHint = null }) {
  const ext = (String(filename ?? '').match(/\.([A-Za-z0-9]+)$/)?.[1]
    || (mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg')).toLowerCase();
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const key = safeKey(keyHint || `ocr/${new Date().toISOString().slice(0, 7)}/${slug(docType)}-${sha.slice(0, 12)}.${ext}`);
  const stored = await put(key, buffer, mime || 'application/octet-stream');
  const { rows: [job] } = await query(
    `INSERT INTO ocr_jobs (source, doc_type, file_key, file_url, filename, mime, bytes, sha256,
                           source_ref, subject_kind, subject_id, company_id, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid, $13) RETURNING *`,
    [source, docType, stored.key ?? key, publicUrl(stored.key ?? key), filename ?? null, mime ?? null,
     buffer.length, sha, sourceRef, subjectKind, subjectId, companyId, requestedBy]);
  return job;
}

/** Fields from text, deterministically — no model, no network, ~1 ms. */
export function fieldsFromText(text, docType) {
  const r = extractKyc(text ?? '', docType && docType !== 'AUTO' ? docType : 'AUTO');
  return { fields: r.fields, confidence: r.confidence, notes: r.notes, detected: r.doc_type };
}

const sparse = (fields) => Object.keys(fields ?? {}).filter((k) => k !== 'holder_name').length === 0;

/**
 * Work one job on THIS box (tier 2 / 3). Used by the dispatcher and by the
 * synchronous intake when there is memory to spare.
 */
export async function runHere(job) {
  let text = '';
  let tier = 'AWS_PATTERNS';
  let engine = 'patterns';
  let fields = {}; let confidence = {}; let notes = [];

  if (canOcrHere()) {
    try {
      const buf = await readKey(job.file_key);
      const out = await extractText(buf);
      text = out?.text ?? '';
      engine = `ocr:${out?.source ?? 'tesseract'}`;
    } catch (e) {
      notes.push(`text extraction failed: ${e.message}`);
    }
  } else {
    notes.push(`box below the ${MIN_FREE_MB} MB OCR floor (${freeMb()} MB free) — no local text pass`);
  }

  if (text) {
    const d = fieldsFromText(text, job.doc_type);
    fields = d.fields; confidence = d.confidence; notes = notes.concat(d.notes ?? []);
  }

  // A model only earns its round trip when the deterministic pass came up
  // short. It proposes; it never overwrites a checksum-validated field.
  if (sparse(fields) && (text || !canOcrHere())) {
    try {
      const prompt = text
        ? `Extract KYC fields from this Indian transport document text. Reply with ONLY JSON:
{"license_no":"","license_expiry":"YYYY-MM-DD","aadhar_no":"","pan_no":"","account_no":"","ifsc_code":"","bank_name":"","hzd_cert_no":"","hzd_expiry":"YYYY-MM-DD","holder_name":""}
Empty string when absent. DOCUMENT TEXT:\n${text.slice(0, 12000)}`
        : null;
      if (prompt) {
        const out = await aiRouter.run('ocr_extract', { prompt, format: 'json', timeoutMs: 90_000 }, { lane: 'either', parkable: false });
        const m = String(out?.text ?? '').match(/\{[\s\S]*\}/);
        if (m) {
          const parsed = JSON.parse(m[0]);
          for (const [k, v] of Object.entries(parsed)) {
            if (v && !fields[k]) { fields[k] = String(v); confidence[k] = 0.6; }
          }
          tier = out.tier ?? (String(out.engine).startsWith('heavy') ? 'HEAVY_LOCAL_PC' : 'CLOUD');
          engine = out.engine ?? engine;
        }
      }
    } catch (e) {
      notes.push(`model pass skipped: ${e.message}`);
    }
  }

  return { tier, engine, fields, confidence, text, notes };
}

/**
 * The AWS-side fallback worker. Runs on the scheduler tick. It deliberately
 * leaves recent jobs alone for HEAVY_GRACE_SEC so the 32 GB PC gets first
 * refusal on everything.
 */
export async function dispatchOnce(limit = DISPATCH_BATCH) {
  const reclaimed = (await query('SELECT ocr_reclaim_stale() AS n')).rows[0]?.n ?? 0;
  // If the PC is up, leave the queue to it entirely — it is the better engine.
  const heavyUp = await aiRouter.heavyEngineUp().catch(() => false);
  const grace = heavyUp ? HEAVY_GRACE_SEC : 0;
  const { rows: jobs } = await query('SELECT * FROM ocr_claim($1, $2, $3, $4)',
    ['aws-dispatcher', limit, 300, grace]);
  let done = 0; let failed = 0;
  for (const job of jobs) {
    try {
      const r = await runHere(job);
      await query('SELECT ocr_complete($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6, $7)',
        [job.id, r.tier, r.engine, JSON.stringify(r.fields ?? {}), JSON.stringify(r.confidence ?? {}), r.text ?? '', (r.notes ?? []).join(' · ') || null]);
      done++;
    } catch (e) {
      await query('SELECT ocr_fail($1::uuid, $2)', [job.id, e.message]);
      failed++;
    }
  }
  return { reclaimed, claimed: jobs.length, done, failed, heavy_up: heavyUp, free_mb: freeMb() };
}

export async function health() {
  const { rows: [h] } = await query('SELECT * FROM v_ocr_health');
  const ai = await aiRouter.aiStats().catch(() => null);
  return {
    queue: h,
    free_mb: freeMb(),
    ocr_floor_mb: MIN_FREE_MB,
    can_ocr_here: canOcrHere(),
    heavy_grace_seconds: HEAVY_GRACE_SEC,
    engines: ai ? { heavy: ai.heavy_engine, local: ai.local_engine, cloud: ai.cloud } : null,
  };
}
