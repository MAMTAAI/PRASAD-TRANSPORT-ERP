// server/services/ocrAutoFiler.js
// ─────────────────────────────────────────────────────────────────────────────
// AI Document OCR Scanner & Auto-Filing Engine.
//
// Jointly operated: BHUVANESHWARI (04) owns classification, extraction and the
// document vault; CHHINNAMASTA (06) is the consumer for fuel slips, whose
// arithmetic guard runs on whatever this engine files.
//
// Pipeline:  upload → hash/dedupe → store artefact → classify+extract (vision
//            LLM) → validate entities against PostgreSQL → score confidence →
//              ≥ AUTOFILE_MIN (default 0.90)  auto-file via the agent outbox
//              <                            flag for HITL review
//
// Auto-filing NEVER writes a domain table directly. It emits the same events a
// clerk's API call would (fuel.slip.submitted, document.uploaded, ...), so the
// owning agent's guards run on machine input exactly as they do on human input.
// A 92%-confident misread must still get past CHHINNAMASTA's slip arithmetic
// and BHAIRAVI's registration checks — confidence is a routing decision, not a
// bypass of the swarm's boundaries.
//
// Vision engines, in order: local Ollama (gemma4, the same model the browser
// billScanner uses) → Anthropic (only if ANTHROPIC_API_KEY is set — the
// existing opt-in cloud engine). No key, no cloud call.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { query, queryOne, isDegraded } from '../db/pool.js';
import { emit } from '../agents/bus.js';
import { stmPush, ltmRemember } from '../memory/okf.js';
import * as aiRouter from '../ai/router.js';
import { extractText } from './textOcr.js';

const OLLAMA = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '');
const VISION_MODEL = process.env.OCR_VISION_MODEL ?? 'gemma4:12b';
const AUTOFILE_MIN = Number.parseFloat(process.env.OCR_AUTOFILE_MIN ?? '0.90');
const UPLOAD_DIR = process.env.OCR_UPLOAD_DIR ?? join(process.cwd(), 'uploads', 'scans');

// ── Extraction contract ─────────────────────────────────────────────────────
// The directive's field list, aligned with the shapes the browser billScanner
// already proves out against real IOCL/pump documents.
const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    doc_type: {
      type: 'string',
      enum: ['EWAY_BILL', 'BILTY_POD', 'FUEL_SLIP', 'DRIVING_LICENSE', 'VEHICLE_RC',
             'FASTAG_STATEMENT', 'SPARES_BILL', 'FREIGHT_INVOICE', 'UNKNOWN'],
    },
    invoice_no: { type: 'string' },
    gstin: { type: 'string' },
    vehicle_no: { type: 'string' },
    driver_name: { type: 'string' },
    freight_amount: { type: 'number' },
    hsd_litres: { type: 'number' },
    rate: { type: 'number' },
    date: { type: 'string' },          // YYYY-MM-DD
    consignee: { type: 'string' },
    signature_present: { type: 'boolean' },
    confidence: { type: 'number' },    // model's own 0..1 estimate
  },
  required: ['doc_type', 'confidence'],
};

const EXTRACT_PROMPT = `You are the document scanner for PRASAD TRANSPORT ERP (Indian petroleum logistics, Assam).
Classify this document and extract the fields you can actually read. Documents are one of:
E-Way Bill, Bilty/POD (proof of delivery), petrol-pump HSD fuel slip, Driving License, Vehicle RC,
FASTag/toll statement, spares or mechanic bill, freight invoice.

Rules:
- Extract ONLY what is printed. Never invent, never calculate a missing value.
- vehicle_no: Indian plate as printed (spaces/dashes OK, e.g. "AS 19C 8666").
- gstin: the 15-character GSTIN if printed, else omit.
- date: convert to YYYY-MM-DD. Indian documents print DD-MM-YYYY or DD/MM/YY.
- hsd_litres: only for fuel slips — the litre quantity.
- freight_amount: the principal money amount of the document.
- signature_present: true only if a handwritten signature or stamp is visible.
- confidence: your honest 0..1 estimate that ALL extracted values are correct.
  A blurry or partial document must lower this. Overclaiming here corrupts a
  real transport company's ledger.
Return JSON only.`;

// ── Vision extraction via the hybrid AI router ──────────────────────────────
// Business documents are PRIVACY tasks: lane 'local', strict 1-at-a-time queue
// on the PC's engine. If that engine is off, the router parks the task durably
// (ai_tasks) instead of failing — the offline-fallback guarantee. Cloud
// fallback happens only with OCR_LANE=either AND AI_ALLOW_CLOUD_FALLBACK=1.
const OCR_LANE = process.env.OCR_LANE ?? 'local';
// Zero-cost pipeline: 'text' = Tesseract -> DeepSeek (fast, GPU-light);
// 'vision' = gemma4 reads the image directly; 'auto' = text first, vision when
// Tesseract can't get a usable read (blurry phone photos).
const OCR_PIPELINE = process.env.OCR_PIPELINE ?? 'auto';
const OCR_TEXT_MODEL = process.env.OCR_TEXT_MODEL ?? 'deepseek-r1:8b';
const MIN_OCR_TEXT = Number.parseInt(process.env.OCR_MIN_TEXT_CHARS ?? '40', 10);

const parseJson = (text) => {
  // deepseek-r1 may wrap output in <think> reasoning — strip it, then take the
  // outermost JSON object.
  const clean = String(text ?? '{}').replace(/<think>[\s\S]*?<\/think>/g, '');
  return JSON.parse(clean.slice(clean.indexOf('{'), clean.lastIndexOf('}') + 1));
};

async function runVision(imageBase64, mimeType) {
  const out = await aiRouter.run(
    'ocr_extract',
    {
      prompt: `${EXTRACT_PROMPT}

Respond with a single JSON object matching this schema: ${JSON.stringify(EXTRACT_SCHEMA.properties)}`,
      images: [imageBase64],
      format: EXTRACT_SCHEMA,
      mimeType,
      timeoutMs: Number.parseInt(process.env.OCR_TIMEOUT_MS ?? '120000', 10),
    },
    { lane: OCR_LANE, parkable: true }
  );
  if (out.parked) return { parked: out };
  return { engine: out.engine, fields: parseJson(out.text) };
}

async function runTextParse(rawText, ocrConfidence) {
  const out = await aiRouter.run(
    'ocr_text_parse',
    {
      prompt: `${EXTRACT_PROMPT}

Below is RAW OCR TEXT from the document (Tesseract, word-confidence ${(ocrConfidence * 100).toFixed(0)}%). OCR text is messy: characters may be misread (0/O, 1/I/l, 5/S, 8/B), columns may interleave. Reconstruct the true values conservatively; omit anything you cannot read with confidence.

--- RAW OCR TEXT START ---
${rawText.slice(0, 12000)}
--- RAW OCR TEXT END ---

Respond with a single JSON object matching this schema: ${JSON.stringify(EXTRACT_SCHEMA.properties)}`,
      format: EXTRACT_SCHEMA,
      model: OCR_TEXT_MODEL,
      timeoutMs: Number.parseInt(process.env.OCR_TIMEOUT_MS ?? '120000', 10),
    },
    { lane: OCR_LANE, parkable: true }
  );
  if (out.parked) return { parked: out };
  return { engine: `tesseract+${out.engine}`, fields: parseJson(out.text) };
}

async function runExtraction(imageBase64, mimeType, buffer) {
  // PDFs skip Tesseract (it wants raster images) — the PWA rasterises pages
  // client-side, so a PDF arriving here is an API upload going to vision.
  const isPdf = mimeType === 'application/pdf';

  if (!isPdf && OCR_PIPELINE !== 'vision') {
    try {
      const ocr = await extractText(buffer);
      const printable = ocr.text.replace(/\s+/g, ' ').trim();
      if (printable.length >= MIN_OCR_TEXT) {
        const parsed = await runTextParse(ocr.text, ocr.confidence);
        if (parsed.parked) return parsed;
        // Tesseract's own read quality co-signs the model's confidence: a
        // clean 95% OCR read should not be dragged down, a 40% read must be.
        const f = parsed.fields;
        f.confidence = Math.min(Number(f.confidence ?? 0), Math.max(ocr.confidence, 0.3) + 0.25);
        return { ...parsed, raw_text: ocr.text, ocr_confidence: ocr.confidence, ocr_ms: ocr.ms };
      }
      if (OCR_PIPELINE === 'text') {
        return { engine: 'tesseract-only', fields: { doc_type: 'UNKNOWN', confidence: 0 }, raw_text: ocr.text };
      }
      // auto: not enough text — fall through to vision.
    } catch (err) {
      if (OCR_PIPELINE === 'text') throw err;
      console.warn(`[ocr] text pipeline failed (${err.message}) — falling back to vision`);
    }
  }
  return runVision(imageBase64, mimeType);
}

// ── Entity validation against PostgreSQL ────────────────────────────────────
// The Auto-Filing Validation Guard: extracted entities must correspond to rows
// this ERP actually knows. Every failed check subtracts from the effective
// confidence, so a perfect-looking scan of someone else's truck cannot clear
// the auto-file bar.
const RX_GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{2}$/;
const normPlate = (v) => String(v ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

async function validateEntities(fields) {
  const checks = {};
  let penalty = 0;

  if (fields.vehicle_no) {
    const hit = await queryOne(
      `SELECT id, vehicle_no FROM vehicles WHERE vehicle_no_norm = $1`,
      [normPlate(fields.vehicle_no)]
    );
    checks.vehicle = hit ? { ok: true, vehicle_id: hit.id, resolved: hit.vehicle_no }
                         : { ok: false, reason: 'no such vehicle in fleet master' };
    if (!hit) penalty += 0.15;
  }

  if (fields.driver_name) {
    // Trigram similarity absorbs the OCR-flavoured spelling drift the live
    // driver data already shows.
    const hit = await queryOne(
      `SELECT id, name, similarity(name, $1) AS sim FROM drivers
        WHERE status = 'ACTIVE' AND similarity(name, $1) > 0.45
        ORDER BY sim DESC LIMIT 1`,
      [String(fields.driver_name).toUpperCase()]
    );
    checks.driver = hit ? { ok: true, driver_id: hit.id, resolved: hit.name, similarity: Number(hit.sim).toFixed(2) }
                        : { ok: false, reason: 'no matching active driver' };
    if (!hit) penalty += 0.10;
  }

  if (fields.gstin) {
    const ok = RX_GSTIN.test(String(fields.gstin).toUpperCase());
    checks.gstin = ok ? { ok: true } : { ok: false, reason: 'malformed GSTIN' };
    if (!ok) penalty += 0.10;
  }

  if (fields.date && !/^\d{4}-\d{2}-\d{2}$/.test(fields.date)) {
    checks.date = { ok: false, reason: 'not YYYY-MM-DD' };
    penalty += 0.05;
  }

  if (fields.hsd_litres !== undefined && fields.rate !== undefined && fields.freight_amount !== undefined) {
    // Same arithmetic CHHINNAMASTA enforces; catching it here just routes the
    // document to review instead of to a rejection event.
    const computed = Number(fields.hsd_litres) * Number(fields.rate);
    const ok = Math.abs(computed - Number(fields.freight_amount)) <= Math.max(1, computed * 0.01);
    checks.arithmetic = ok ? { ok: true } : { ok: false, reason: `litres×rate=${computed.toFixed(2)} ≠ amount ${fields.freight_amount}` };
    if (!ok) penalty += 0.15;
  }

  return { checks, penalty };
}

// ── Auto-file routing ───────────────────────────────────────────────────────
// doc_type → the outbox event the owning agent already handles.
function autoFileEvent(fields, validation) {
  switch (fields.doc_type) {
    case 'FUEL_SLIP':
      return {
        event: 'fuel.slip.submitted',        // → CHHINNAMASTA (arithmetic + duplicate guards)
        aggregate: 'fuel_entry',
        payload: {
          liters: fields.hsd_litres, rate: fields.rate, amount: fields.freight_amount,
          vehicle_no: fields.vehicle_no, memo_no: fields.invoice_no,
          source: 'OCR_AUTO_FILER',
        },
      };
    case 'DRIVING_LICENSE':
      return { event: 'driver.document.updated', aggregate: 'driver',
               payload: { driver_id: validation.checks.driver?.driver_id ?? null, doc: 'DL', fields } };
    case 'VEHICLE_RC':
      return { event: 'vehicle.document.updated', aggregate: 'vehicle',
               payload: { vehicle_id: validation.checks.vehicle?.vehicle_id ?? null, doc: 'RC', fields } };
    case 'EWAY_BILL':
    case 'BILTY_POD':
    case 'FREIGHT_INVOICE':
    case 'FASTAG_STATEMENT':
    case 'SPARES_BILL':
    default:
      // Financial documents without a dedicated intake event yet stay proposals
      // — BHUVANESHWARI's "extraction is always a proposal" rule.
      return null;
  }
}

// ── Main entry ──────────────────────────────────────────────────────────────

/**
 * Scan one uploaded file. Returns extraction + validation + filing decision.
 * Never throws for business-level outcomes; throws only for engine failure.
 */
export async function scanAndFile({ buffer, filename, mimeType, uploadedBy = null }) {
  const startedAt = Date.now();
  if (!buffer?.length) throw Object.assign(new Error('empty upload'), { code: 'EMPTY_FILE' });
  if (!/^image\/(png|jpe?g|webp)$|^application\/pdf$/.test(mimeType ?? '')) {
    throw Object.assign(new Error(`unsupported type ${mimeType}`), { code: 'UNSUPPORTED_TYPE' });
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  stmPush('AGENT_04', 'scan', { filename, sha256: sha256.slice(0, 12), stage: 'received' });

  // 1. Persist the artefact first — evidence before interpretation.
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const storagePath = join(UPLOAD_DIR, `${sha256.slice(0, 16)}-${(filename ?? 'scan').replace(/[^\w.-]/g, '_')}`);
  writeFileSync(storagePath, buffer);

  // 2. Dedupe + register in the vault (when the DB is up).
  let documentId = null;
  let duplicate = false;
  if (!isDegraded()) {
    const existing = await queryOne(`SELECT id, status FROM documents WHERE sha256 = $1`, [sha256]);
    if (existing) {
      duplicate = true;
      documentId = existing.id;
    } else {
      const row = await queryOne(
        `INSERT INTO documents (doc_type, original_name, mime_type, byte_size, sha256, storage_path, uploaded_by)
         VALUES ('UNKNOWN', $1, $2, $3, $4, $5, $6) RETURNING id`,
        [filename ?? null, mimeType ?? null, buffer.length, sha256, storagePath, uploadedBy]
      );
      documentId = row.id;
    }
  }

  // 3. Vision extraction. PDFs go to the engine as-is (Anthropic handles PDF;
  //    Ollama needs images — a rasterise step is a known gap, surfaced in the
  //    response rather than hidden).
  const isPdf = mimeType === 'application/pdf';
  const extraction = await runExtraction(buffer.toString('base64'), mimeType, buffer);
  if (extraction.parked) {
    // Local AI is off: the artefact is safe on disk + in the vault, and the
    // extraction replays automatically when the engine returns. Zero crash.
    if (!isDegraded() && documentId) {
      await query(`UPDATE documents SET status = 'RECEIVED' WHERE id = $1`, [documentId]);
    }
    stmPush('AGENT_04', 'scan', { sha256: sha256.slice(0, 12), stage: 'parked' });
    return {
      document_id: documentId,
      duplicate,
      engine: null,
      doc_type: 'PENDING_EXTRACTION',
      fields: {},
      validation: {},
      confidence: null,
      filing: { auto_filed: false, event: null, reason: extraction.parked.reason },
      agent_action: `AGENT_04 BHUVANESHWARI parked the scan durably (ai_task ${extraction.parked.task_id}) — local AI offline`,
      ms: Date.now() - startedAt,
    };
  }
  const { engine, fields } = extraction;
  const modelConfidence = Math.max(0, Math.min(1, Number(fields.confidence ?? 0)));

  // 4. Validation guard against PostgreSQL.
  let validation = { checks: { skipped: 'database degraded' }, penalty: 0.25 };
  if (!isDegraded()) validation = await validateEntities(fields);

  const effectiveConfidence = Math.max(0, Math.min(1, modelConfidence - validation.penalty));
  const autoFileable = effectiveConfidence >= AUTOFILE_MIN;

  // 5. File or flag.
  let filed = { auto_filed: false, event: null, reason: null };
  if (isDegraded()) {
    filed.reason = 'database degraded — extraction returned, nothing committed';
  } else if (duplicate) {
    filed.reason = 'duplicate of an already-scanned document (sha256 match)';
  } else if (autoFileable) {
    const route = autoFileEvent(fields, validation);
    if (route) {
      const evt = await emit(route.event, {
        aggregate: route.aggregate,
        aggregateId: null,
        payload: { ...route.payload, document_id: documentId, ocr_confidence: effectiveConfidence },
        emittedBy: 'AGENT_04',
      });
      filed = { auto_filed: true, event: { id: evt.id, type: route.event }, reason: `confidence ${(effectiveConfidence * 100).toFixed(1)}% ≥ ${AUTOFILE_MIN * 100}%` };
      await query(`UPDATE documents SET doc_type = $2, status = 'FILED' WHERE id = $1`, [documentId, fields.doc_type]);
    } else {
      filed.reason = `confident (${(effectiveConfidence * 100).toFixed(1)}%) but doc_type ${fields.doc_type} has no auto-file route — proposal kept for review`;
      await query(`UPDATE documents SET doc_type = $2, status = 'REVIEW' WHERE id = $1`, [documentId, fields.doc_type]);
    }
  } else {
    filed.reason = `confidence ${(effectiveConfidence * 100).toFixed(1)}% < ${AUTOFILE_MIN * 100}% — flagged for human review`;
    await query(`UPDATE documents SET doc_type = $2, status = 'REVIEW' WHERE id = $1`, [documentId, fields.doc_type]);
    await emit('document.review.required', {
      aggregate: 'document', aggregateId: documentId,
      payload: { fields, validation: validation.checks, effective_confidence: effectiveConfidence },
      emittedBy: 'AGENT_04',
    });
  }

  // 6. Record the extraction pass + OKF memory.
  if (!isDegraded() && documentId) {
    await query(
      `INSERT INTO document_extractions (document_id, engine, fields, confidence, validation, auto_filed, filed_event_id)
       VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)`,
      [documentId, engine,
       JSON.stringify({ ...fields, _raw_ocr_text: extraction.raw_text?.slice(0, 20000) }),
       effectiveConfidence,
       JSON.stringify(validation.checks), filed.auto_filed, filed.event?.id ?? null]
    );
    await ltmRemember('AGENT_04', 'scan_meta', {
      doc_type: fields.doc_type, engine, confidence: effectiveConfidence,
      auto_filed: filed.auto_filed, sha256: sha256.slice(0, 16), ms: Date.now() - startedAt,
    });
  }
  stmPush('AGENT_04', 'scan', { sha256: sha256.slice(0, 12), stage: filed.auto_filed ? 'filed' : 'review', confidence: effectiveConfidence });

  return {
    document_id: documentId,
    duplicate,
    engine,
    doc_type: fields.doc_type,
    fields,
    validation: validation.checks,
    confidence: { model: modelConfidence, penalty: validation.penalty, effective: effectiveConfidence, autofile_threshold: AUTOFILE_MIN },
    filing: filed,
    agent_action: filed.auto_filed
      ? `AGENT_04 BHUVANESHWARI filed via ${filed.event.type} → owning agent's guards now apply`
      : `AGENT_04 BHUVANESHWARI held for HITL review`,
    pdf_note: isPdf ? 'PDF sent raw; if the local engine mis-read it, upload a page image (rasterise step pending)' : undefined,
    ms: Date.now() - startedAt,
  };
}

/**
 * HITL resolution — the 1-click review from the Admin Dashboard.
 * Corrections are HUMAN-VERIFIED: they win over OCR permanently (the guard in
 * BHUVANESHWARI's charter), and filing goes through the same outbox events as
 * an auto-file, so the owning agent's checks still apply to human input.
 */
export async function resolveReview(documentId, { action, corrections = {}, reviewer }) {
  if (!reviewer) throw Object.assign(new Error('reviewer identity required'), { code: 'NO_REVIEWER' });
  const doc = await queryOne(`SELECT id, doc_type, status FROM documents WHERE id = $1`, [documentId]);
  if (!doc) throw Object.assign(new Error('document not found'), { code: 'NOT_FOUND' });
  if (doc.status !== 'REVIEW') throw Object.assign(new Error(`document is ${doc.status}, not REVIEW`), { code: 'NOT_IN_REVIEW' });

  if (action === 'reject') {
    await query(`UPDATE documents SET status = 'REJECTED' WHERE id = $1`, [documentId]);
    return { document_id: documentId, status: 'REJECTED', by: reviewer };
  }

  const last = await queryOne(
    `SELECT fields FROM document_extractions WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [documentId]
  );
  const fields = { ...(last?.fields ?? {}), ...corrections };
  delete fields._raw_ocr_text;
  const validation = await validateEntities(fields);

  // Human verification IS the confidence — record the pass, then file.
  await query(
    `INSERT INTO document_extractions (document_id, engine, fields, confidence, validation, auto_filed, human_verified)
     VALUES ($1, 'human', $2::jsonb, 1.0, $3::jsonb, true, true)`,
    [documentId, JSON.stringify(fields), JSON.stringify(validation.checks)]
  );

  const route = autoFileEvent(fields, validation);
  let event = null;
  if (route) {
    const evt = await emit(route.event, {
      aggregate: route.aggregate,
      payload: { ...route.payload, document_id: documentId, human_verified: true, reviewed_by: reviewer },
      emittedBy: 'AGENT_04',
    });
    event = { id: evt.id, type: route.event };
  }
  await query(`UPDATE documents SET doc_type = $2, status = 'FILED' WHERE id = $1`, [documentId, fields.doc_type ?? doc.doc_type]);
  return {
    document_id: documentId, status: 'FILED', by: reviewer, event,
    note: route ? `filed via ${route.event} — owning agent's guards apply` : 'archived as verified document (no auto-file route for this doc_type)',
  };
}

export default { scanAndFile, resolveReview };
