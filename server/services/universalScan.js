// ═══════════════════════════════════════════════════════════════════════════
// universalScan.js — one scan pipeline, two engines, never a dead end.
//
// A phone in Bongaigaon photographs whatever is on the desk: a fitness
// certificate, a driver's Aadhaar, an IOCL invoice, a loading challan, a bilty.
// It must get an answer at 2am with the office PC switched off, and the answer
// must be the one the office would recognise in the morning.
//
// THE PIPELINE
//   bytes ─▶ Tesseract (WASM, no GPU, no API) ─▶ raw text
//         ─▶ docPatterns.parseAnyDocument()    ─▶ STRUCTURE        ← always runs
//         ─▶ local LLM, only if it is up       ─▶ enrichment       ← best effort
//
// WHY THE REGEX PASS IS THE FLOOR AND NOT THE FALLBACK
// The obvious design is "LLM first, regex if the LLM is down". That gives the
// phone two different answer qualities depending on whether a PC in another
// building is powered on, and nobody can tell afterwards which one they got.
// Here the deterministic pass ALWAYS produces the record; the LLM only fills
// blanks it left and can never overwrite a field the patterns matched. Local
// down therefore costs completeness, never correctness — and `engine` on the
// response says exactly which path ran.
//
// DEPLOYING THE "LIGHTWEIGHT AWS MODEL"
// There is no model to deploy. tesseract.js is a WASM package already in
// package.json and docPatterns.js is pure string matching, so the fallback runs
// inside the same Node process on a t3 box with no GPU, no Ollama and no
// per-page cost. Set AI_LOCAL_ENRICH=0 on the AWS box and it never even tries
// to reach the local engine.
// ═══════════════════════════════════════════════════════════════════════════
import { createHash } from 'node:crypto';
import { query, isDegraded } from '../db/pool.js';
import { extractText } from './textOcr.js';
import { parseAnyDocument, normReg } from '../lib/docPatterns.js';
import * as aiRouter from '../ai/router.js';
import { raise } from '../lib/zeroGap.js';

const ENRICH = process.env.AI_LOCAL_ENRICH !== '0';
// A phone is holding this request open. localEngineUp() only proves the port
// answers — the model may still be paging in, and a 20s budget turned a 5s scan
// into a 33s one for an enrichment that then timed out anyway. Eight seconds is
// long enough for a warm model and short enough that a cold one costs the user
// almost nothing, because the record is already complete without it.
// Two seconds, and not a millisecond of grace. This budget only applies to a
// caller that chose to wait; it is the hard ceiling on how long a model may
// delay an answer the deterministic parser has already produced. Exceeded, the
// enrichment is abandoned mid-flight and the patterns result stands.
const ENRICH_TIMEOUT_MS = Number.parseInt(process.env.AI_ENRICH_TIMEOUT_MS ?? '2000', 10);
// Nobody holds the line for the background pass, so it can afford to wait for a
// cold model to page in rather than giving up on the phone budget.
const BACKGROUND_TIMEOUT_MS = Number.parseInt(process.env.AI_ENRICH_BG_TIMEOUT_MS ?? '90000', 10);
// Set AI_ENRICH_BG=1 to let the model keep working after the response. Worth it
// only on a box where the model does not share cores with the OCR worker.
const BG_ENRICH = process.env.AI_ENRICH_BG === '1';

const ENRICH_PROMPT = `You are reading an Indian petroleum-transport document that has already been OCR'd.
Return ONLY a JSON object. Use "" for anything you cannot see. Do not guess.
{"document_number":"","document_date":"DD-MM-YYYY","expiry_date":"DD-MM-YYYY","vehicle_no":"","party_name":"","product":"","quantity_ltr":"","total_amount":""}
Rules:
- vehicle_no: Indian plate, uppercase, no spaces.
- quantity_ltr: litres as a plain integer (20.000 KL => 20000).
- total_amount: plain number, no currency symbol or commas.`;

/** Vehicle master, as a lookup the pattern matcher can test registrations against. */
async function knownVehicles() {
  if (isDegraded()) return new Map();
  const { rows } = await query('SELECT id, vehicle_no FROM vehicles');
  return new Map(rows.map((v) => [normReg(v.vehicle_no), v]));
}

/**
 * Best-effort enrichment. Returns {} on any failure — a dead local engine, a
 * timeout, unparseable output. The caller has a complete record already.
 */
async function enrich(text, budgetMs = ENRICH_TIMEOUT_MS) {
  if (!ENRICH) return { skipped: 'AI_LOCAL_ENRICH=0' };

  // OWN THE DEADLINE HERE. Passing timeoutMs to the router bounds the model
  // call but not the wait in front of it: the local lane runs one generation at
  // a time, so a scan arriving behind another task queues for as long as that
  // one takes. A 4s OCR turned into a 50s response that way. The phone's budget
  // is a property of the phone, not of whatever else the GPU is doing, so it is
  // enforced by the caller and the loser is simply dropped.
  const deadline = new Promise((resolve) =>
    setTimeout(() => resolve({ skipped: `enrichment budget ${budgetMs}ms exceeded` }), budgetMs));

  const attempt = (async () => {
    try {
      if (!(await aiRouter.localEngineUp())) return { skipped: 'local engine down' };
      const out = await aiRouter.run('document.enrich', {
        prompt: `${ENRICH_PROMPT}\n\nDOCUMENT TEXT:\n${text.slice(0, 12000)}`,
        format: 'json',
        timeoutMs: budgetMs,
      }, { lane: 'local', parkable: false });   // never park: the phone is waiting
      const raw = typeof out === 'string' ? out : (out?.response ?? out?.text ?? '');
      const m = String(raw).match(/\{[\s\S]*\}/);
      return m ? { fields: JSON.parse(m[0]) } : { skipped: 'no JSON in reply' };
    } catch (e) {
      return { skipped: e.message };
    }
  })();

  return Promise.race([attempt, deadline]);
}

/**
 * Scan a document end to end.
 * @param {Buffer} buffer  the image or PDF page bytes
 * @param {object} opts    { filename, source, uploadedBy }
 */
export async function scanDocument(buffer, {
  filename = null, source = 'api', uploadedBy = null,
  // THE PHONE DOES NOT WAIT FOR THE MODEL.
  //
  // With the pool fixed, the deterministic pipeline answers in 11ms for a PDF
  // with a text layer and ~4s for a photo that needs OCR. The remaining seconds
  // were all the enrichment budget — a phone holding the line while a 12B model
  // paged in on a GPU in another building.
  //
  // Since the patterns pass IS the record and enrichment may only fill blanks
  // it left, there is nothing to wait for: return, then let the model finish in
  // the background and update the row it improves. The scan is complete and
  // correct either way; enrichment makes it more complete a few seconds later.
  waitForEnrichment = false,
} = {}) {
  const started = Date.now();
  const hash = createHash('sha256').update(buffer).digest('hex');

  let text = '';
  let ocrError = null;
  let ocrSource = null;
  try {
    // extractText returns { text, confidence, ms, source } — not a bare string.
    const out = await extractText(buffer);
    text = out?.text ?? '';
    ocrSource = out?.source ?? null;
  } catch (e) {
    ocrError = e.message;
    // A page the reader could not open is exactly the thing that used to vanish:
    // the scan returned, the record was thin, and nobody knew why.
    await raise({
      kind: 'SCAN_FAILURE', severity: 'MEDIUM',
      title: `Could not read ${filename ?? 'a scanned document'}`,
      why: e.message,
      context: { process: 'scan.ocr', source, filename, bytes: buffer.length },
      action: 'Open the file and check it is a readable page, then scan it again from the Vault screen.',
      subjectType: 'document', subjectId: hash.slice(0, 16),
      options: [{ action: 'ACKNOWLEDGE', label: 'Acknowledged' }],
      detectedBy: 'scan', process: 'scan.ocr',
    });
  }

  const known = await knownVehicles();
  // The deterministic pass. This is the record.
  const parsed = parseAnyDocument(text, known);
  const matches = parsed.vehicle_regs.map((r) => known.get(r)).filter(Boolean);
  const vehicle = matches.length === 1 ? matches[0] : null;

  // Best effort on top, and only where it can help: a page the patterns already
  // read cleanly has no blanks left to fill.
  const worthEnriching = Boolean(text.trim()) && (!parsed.confident || !vehicle);
  const ai = !text.trim() ? { skipped: 'no text to enrich' }
           : !worthEnriching ? { skipped: 'patterns already confident' }
           : waitForEnrichment ? await enrich(text)
           : { skipped: 'enriching in background' };
  const filled = [];
  if (ai.fields) {
    for (const [k, v] of Object.entries(ai.fields)) {
      if (v === '' || v == null) continue;
      if (parsed[k] === null || parsed[k] === undefined) { parsed[k] = v; filled.push(k); }
    }
  }

  const engine = ai.fields ? 'local+patterns' : 'patterns-only';
  const result = {
    ok: true,
    engine,
    engine_note: ai.skipped ?? null,
    ocr_error: ocrError,
    ocr_source: ocrSource,
    text_chars: text.length,
    hash,
    filename,
    ...parsed,
    matched_vehicle: vehicle ? { id: vehicle.id, vehicle_no: vehicle.vehicle_no } : null,
    vehicle_candidates: matches.map((v) => ({ id: v.id, vehicle_no: v.vehicle_no })),
    ai_filled_fields: filled,
    // The phone shows this. `confident` is the patterns' own verdict — it is
    // never raised because an LLM agreed.
    needs_human: !parsed.confident,
    took_ms: Date.now() - started,
  };

  // A scan that reached no conclusion is still a scan that happened. Recording
  // it is what makes "the phone scanned it" and "nobody ever scanned it"
  // distinguishable the next morning.
  if (!isDegraded()) {
    await query(
      `INSERT INTO scan_log (file_hash, filename, source, uploaded_by, kind, engine,
                             text_chars, vehicle_id, confident, result, took_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
       ON CONFLICT (file_hash) DO UPDATE
         SET engine = EXCLUDED.engine, result = EXCLUDED.result,
             confident = EXCLUDED.confident, took_ms = EXCLUDED.took_ms, scanned_at = now()`,
      [hash, filename, source, uploadedBy, parsed.kind, engine, text.length,
       vehicle?.id ?? null, Boolean(parsed.confident), JSON.stringify(result), result.took_ms]
    ).catch(() => {});
  }

  // The background pass. Nobody is waiting, so it gets a real budget rather
  // than the phone's — and it writes back only into fields the patterns left
  // empty, exactly as the synchronous path would have.
  // OFF BY DEFAULT, AND THAT IS THE MEASUREMENT TALKING.
  //
  // Firing a 12B generation straight after responding looked free — nobody is
  // waiting for it. It is not free: it runs in THIS process, and the Tesseract
  // WASM worker that serves the next scan competes with it for the same cores.
  // The same photo that OCR'd in 4.7s standalone took 23.5s inside the API with
  // background enrichment on. Paying five seconds of the next user's scan to
  // fill a blank field on the last one is a bad trade, so it takes an opt-in.
  if (BG_ENRICH && worthEnriching && !waitForEnrichment) {
    void (async () => {
      try {
        const late = await enrich(text, BACKGROUND_TIMEOUT_MS);
        if (!late.fields) return;
        const merged = { ...result };
        const lateFilled = [];
        for (const [k, v] of Object.entries(late.fields)) {
          if (v === '' || v == null) continue;
          if (merged[k] === null || merged[k] === undefined) { merged[k] = v; lateFilled.push(k); }
        }
        if (!lateFilled.length) return;
        merged.engine = 'local+patterns';
        merged.engine_note = 'enriched after the response';
        merged.ai_filled_fields = lateFilled;
        await query(
          `UPDATE scan_log SET engine = $2, result = $3::jsonb, scanned_at = scanned_at
            WHERE file_hash = $1`,
          [hash, merged.engine, JSON.stringify(merged)]);
      } catch { /* the record is already complete; enrichment is a bonus */ }
    })();
  }

  return result;
}

export default { scanDocument };
